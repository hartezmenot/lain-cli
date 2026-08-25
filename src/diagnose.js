'use strict';

/**
 * WHY ISN'T THIS WORKING — the MACHINE half of that question.
 *
 * `/status` says what LAIN is configured to do; `provider.js` and
 * `availability.js` say whether a route is healthy. Neither answers the
 * question a stuck user actually has, which is about the host: is the Node
 * version new enough, is there a terminal, can the config directory be written,
 * is there a shell for run_bash to use. V1 had this as `/doctor` and V2 had
 * lost it.
 *
 * The checks live here rather than inside the command because they are facts
 * about the environment, not presentation — which makes them testable directly
 * and keeps `commands.js` a registry rather than a place where logic collects.
 *
 * EVERY CHECK IS A LOCAL SYSCALL. Nothing here opens a socket or spends a
 * request: a diagnostic that costs money to run is one nobody runs when they
 * are already worried about spending.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const providerMod = require('./provider');
const sessionMod = require('./session');
const shell = require('./tools/shell');

/** @returns {Array<{ok:boolean, text:string}>} in the order a person reads them. */
function checks(app) {
  const out = [];
  const ok = (text) => out.push({ ok: true, text });
  const warn = (text) => out.push({ ok: false, text });

  const major = Number(process.versions.node.split('.')[0]);
  (major >= 18 ? ok : warn)(`Node ${process.version}${major >= 18 ? '' : ' — 18 or newer is required'}`);

  (process.stdout.isTTY ? ok : warn)(process.stdout.isTTY
    ? 'Interactive terminal'
    : 'No TTY — the framed UI is off and output is linear');

  // Sessions, /undo history and the model catalog all live under the config
  // directory. If it cannot be written, everything appears to work during the
  // session and none of it is there afterwards.
  const dir = config.configDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    ok(`Config directory writable (${dir})`);
  } catch (e) {
    warn(`Config directory is NOT writable (${dir}): ${e.message} — sessions and undo will not persist`);
  }

  const cwd = path.resolve(app.session.cwd);
  try {
    fs.accessSync(cwd, fs.constants.W_OK);
    ok(`Working directory writable (${cwd})`);
  } catch {
    warn(`Working directory is read-only (${cwd}) — edits will fail`);
  }

  // run_bash is the tool most likely to be silently unusable on a given host.
  const bash = shell.findBash();
  if (bash) ok(`Shell for run_bash: ${bash}`);
  else if (process.platform === 'win32') ok('Shell for run_bash: PowerShell / cmd (no bash found, which is normal on Windows)');
  else warn('No shell found for run_bash — shell commands will fail');

  // THE TAB TITLE is a side effect on someone else's window, and when it does
  // not take there is nothing on screen to say why. LAIN writes OSC 0 and 2 on
  // every redraw; a terminal that pins its own tab name simply ignores them, and
  // that is a setting in the terminal rather than a fault here. So this reports
  // what LAIN actually sent, and names the setting to check if the tab differs.
  const title = require('./termtitle');
  if (!title.enabled()) {
    warn('Terminal title not set — no TTY, TERM=dumb, or LAIN_NO_TITLE is set');
  } else {
    ok(`Terminal title set to "${title.compose({ folder: require('./ui/text').projectName(cwd) })}"`
      + ' — if your tab still shows the shell name, the terminal is overriding it'
      + (process.platform === 'win32' ? ' (Windows Terminal: profile → suppressApplicationTitle / tabTitle)' : ''));
  }

  const pc = providerMod.resolve(app.cfg);
  if (!pc.provider) warn('No provider configured — /provider to set one up');
  else if (!pc.apiKey) warn(`Provider ${pc.provider} has no credential — /oauth, or /config apiKey`);
  else ok(`Provider ${pc.provider} · model ${pc.model || 'none selected'} · credential present`);

  const room = sessionMod.budgetChars(pc);
  const used = app.session.contextChars();
  const pct = room > 0 ? Math.round((used / room) * 100) : 0;
  (pct < 80 ? ok : warn)(`Context ${Math.round(used / 1000)}k / ${Math.round(room / 1000)}k chars (${pct}%)`
    + (pct >= 80 ? ' — older tool output is being elided to fit' : ''));

  if (app.availability) {
    const healthy = new Set(['UNKNOWN', 'READY', 'REQUEST_READY']);
    const down = app.availability.all().filter((e) => e.status && !healthy.has(e.status));
    if (down.length) for (const d of down) warn(`Connection ${d.id}: ${d.status}${d.reason ? ` — ${d.reason}` : ''}`);
    else ok('No connection is disabled or in a failure state');
  }

  return out;
}

/**
 * What `/status` reports: the SESSION and its route, as label/value pairs.
 *
 * `checks()` answers "is this machine capable of running LAIN"; this answers
 * "what is LAIN currently pointed at". Both are reports built from state and
 * printed by a command, which is why they live together and neither lives in
 * the command registry.
 *
 * @returns {Array<[string, string]>}
 */
/**
 * A cache-hit-rate suffix for the tokens row, or '' when there is nothing to
 * say — no request has gone out, or the provider never reported cache usage
 * at all (a non-Anthropic route). Folded onto the existing row rather than
 * given one of its own: `/status` is a fixed-height panel windowed to the
 * terminal, and an unconditional extra row pushes whatever was last — here,
 * `config` — past the visible slice on a short terminal. This is the one
 * number that answers "is caching actually working" without re-deriving it
 * from raw provider events by hand: read tokens near zero next to real
 * conversation history is the signature of a broken or invalidated cache.
 */
function cacheSuffix(u) {
  const read = u.cacheReadTokens || 0;
  const cached = read + (u.cacheCreationTokens || 0);
  const total = cached + (u.inputTokens || 0);
  if (!total) return '';
  return ` · cache ${Math.round((read / total) * 100)}%`;
}

function statusRows(app, { dim = (s) => s } = {}) {
  const pc = providerMod.resolve(app.cfg);
  const room = sessionMod.budgetChars(pc);
  const used = app.session.contextChars();
  const u = app.session.usage;
  return [
    ['session', app.session.id + (app.resumedFrom ? ' (resumed)' : '')],
    ['cwd', app.session.cwd],
    ['messages', String(app.session.messages.length)],
    // The window is the resource that silently ends long tasks, so it is a
    // headline number rather than something you have to know to ask for.
    ['context', `${Math.round(used / 1000)}k / ${Math.round(room / 1000)}k chars (${room > 0 ? Math.round((used / room) * 100) : 0}%)`],
    ['turns', String(app.session.turns.length)],
    ['provider', pc.provider || dim('none configured')],
    ['model', pc.model || dim('none')],
    ['credential', pc.apiKey ? 'present' : dim('missing')],
    ['tokens', `↑${u.inputTokens} ↓${u.outputTokens} · ${u.requests} requests${cacheSuffix(u)}`],
    ['tools', String(require('./tools').names().length)],
    ['config', config.configDir()],
  ];
}

module.exports = { checks, statusRows };
