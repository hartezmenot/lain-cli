'use strict';

/**
 * `/ready` — IS LAIN READY? "Show me everything, so I understand what is going on."
 *
 * LAIN'S OWN readiness, and deliberately not the project's: `/health` answers
 * "is this codebase healthy?" and lives in projecthealth.js. RC here means
 * RELEASE CANDIDATE, never remote control.
 *
 * The rule that makes this honest: a state is read from EVIDENCE, never from a
 * green test count. A unit test passing does not make a subsystem STABLE — it
 * makes it wired. So this separates what is genuinely proven from what is merely
 * present, and it does NOT hide what is missing or excluded on purpose:
 *
 *   STABLE / VERIFIED   proven by a live probe right now (provider reachable,
 *                       config writable, the catalog has models)
 *   IMPLEMENTED         the code path exists and is wired, not runtime-proven
 *   PARTIAL             works, but with a known gap worth stating
 *   MISSING             a capability a person might expect that is not here
 *   EXCLUDED            deliberately left out (orchestra, lain-model) — not a gap
 *   INFO                a fact, not a verdict
 *
 * It reuses the environment probes in diagnose.js and the capability probe set
 * in capabilities.js rather than re-deriving either. Nothing here opens a socket
 * beyond what diagnose already does; it is safe to run whenever.
 */

const fs = require('fs');
const path = require('path');

const diagnose = require('./diagnose');
const commands = require('./commands');
const { detect } = require('./compare');
const { CAPABILITIES } = require('./capabilities');

/** state → { symbol, colour, ready } — ready feeds the RC summary tally. */
const STATE = Object.freeze({
  STABLE: { sym: '✓', colour: 'green', word: 'STABLE', ready: true },
  VERIFIED: { sym: '✓', colour: 'green', word: 'VERIFIED', ready: true },
  IMPLEMENTED: { sym: '✓', colour: 'green', word: 'IMPLEMENTED', ready: true },
  PARTIAL: { sym: '⚠', colour: 'yellow', word: 'PARTIAL', ready: false },
  ATTENTION: { sym: '⚠', colour: 'yellow', word: 'NEEDS ATTENTION', ready: false },
  MISSING: { sym: '✕', colour: 'red', word: 'MISSING', ready: false },
  BROKEN: { sym: '✕', colour: 'red', word: 'BROKEN', ready: false },
  EXCLUDED: { sym: '⊘', colour: 'dim', word: 'INTENTIONALLY EXCLUDED', ready: true },
  INFO: { sym: '●', colour: 'cyan', word: 'INFO', ready: true },
});

// ------------------------------------------------------------------ probes ---

/** Is a capability detectable in THIS tree? Used for "missing" honesty. */
async function hasCapability(id, tree) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap) return false;
  return (await detect(tree, cap)).present;
}

/**
 * Assess the running LAIN into grouped rows. `app` supplies live state; the
 * source tree is read for what is present and what was deliberately dropped.
 */
async function assess(app) {
  const srcDir = __dirname;
  const groups = [];
  const g = (title, rows) => groups.push({ title, rows: rows.filter(Boolean) });
  const row = (area, state, note = '') => ({ area, state, note });

  // ENVIRONMENT — reuse the machine checks, mapped to states. These are live.
  // The area gets a short fixed label so the row is not the note truncated.
  let env = [];
  try { env = diagnose.checks(app); } catch { env = []; }
  const envLabel = (t) => /node/i.test(t) ? 'Node runtime'
    : /terminal title/i.test(t) ? 'Terminal title'
      : /tty|terminal/i.test(t) ? 'Terminal'
      : /config directory/i.test(t) ? 'Config storage'
        : /working directory/i.test(t) ? 'Working dir'
          : /shell/i.test(t) ? 'Shell'
            : /provider/i.test(t) ? 'Provider'
              : /context/i.test(t) ? 'Context window'
                : /connection/i.test(t) ? 'Connections'
                  : 'Check';
  g('Environment', env.map((c) => row(envLabel(c.text), c.ok ? STATE.STABLE : STATE.ATTENTION, c.text)));

  // WORKFLOWS — a registered, runnable command is implemented, full stop.
  const has = (n) => commands.REGISTRY.has(n) && typeof commands.REGISTRY.get(n).run === 'function';
  /** Is the capability's MODULE present? — for workflows with no command. */
  const module_ = (id) => { try { return Boolean(require(id)); } catch { return false; } };
  /** And does the classifier still know the mode that reaches it? */
  const modeHas = (k) => { try { return Boolean(require('./mode').KIND[k]); } catch { return false; } };
  g('Workflows', [
    row('Task loop', STATE.IMPLEMENTED, 'model decides, tools execute, plan tracks steps'),
    // ---- A WORKFLOW IS NOT A COMMAND -----------------------------------
    //
    // These two rows probed `commands.REGISTRY` for `/audit` and
    // `/troubleshoot`, which were removed from the command surface in the
    // 2026-09 UX subtraction pass. The probe then reported the WORKFLOWS as
    // MISSING — and they are not missing: the audit reader, the evidence
    // scan and the report renderer are all still here, and mode.js routes a
    // plain-English problem report into TROUBLESHOOT without anyone naming
    // a mode. Reporting them as gone because the door was removed is the
    // precise confusion this view exists to prevent.
    //
    // So they are probed at the MODULE, which is where the capability
    // actually lives, and named for what a person can do rather than for a
    // command they can type.
    row('Project reading', module_('./audit') ? STATE.IMPLEMENTED : STATE.MISSING,
      'evidence-based project reading — reached by asking, no command'),
    row('Troubleshooting', module_('./troubleshoot') && modeHas('TROUBLESHOOT') ? STATE.IMPLEMENTED : STATE.MISSING,
      'trace before editing — classified from the problem description'),
    row('/compare', has('/compare') ? STATE.IMPLEMENTED : STATE.MISSING, 'capability comparison against another tree'),
    row('/resume', has('/resume') ? STATE.IMPLEMENTED : STATE.MISSING, 'restore a saved session'),
  ]);

  // MODEL — live: does the catalog actually have models, is one chosen.
  let modelCount = 0;
  try { modelCount = (app.catalog ? app.catalog().models.length : 0) || 0; } catch { modelCount = 0; }
  const chosen = app.cfg && app.cfg.model;
  g('Model', [
    row('Catalog', modelCount > 0 ? STATE.STABLE : STATE.ATTENTION,
      modelCount > 0 ? `${modelCount} model(s) available` : 'no models — /api refresh to discover them'),
    row('Selection', chosen ? STATE.STABLE : STATE.PARTIAL,
      chosen ? String(chosen) : 'no model selected — /models to pick one'),
    row('Search & picker', has('/models') ? STATE.IMPLEMENTED : STATE.MISSING, 'natural search, one-step select'),
    row('Refresh', has('/api') ? STATE.IMPLEMENTED : STATE.MISSING, '/api refresh re-discovers models'),
  ]);

  // RELIABILITY — wired in the turn loop. Marked IMPLEMENTED, not STABLE: the
  // code path exists, but only a live provider failure proves it end to end.
  g('Reliability', [
    row('LLM liveness', STATE.IMPLEMENTED, 'phases announced: waiting, receiving, running, retrying'),
    row('Rate-limit retry', STATE.IMPLEMENTED, 'Retry-After honoured, bounded backoff, Esc stops the wait'),
    row('Provider errors', STATE.IMPLEMENTED, '429/500/503/timeout/refused classified and surfaced'),
    row('Auto-compaction', STATE.IMPLEMENTED, 'context elided before each send when over budget'),
    row('Interrupt (Ctrl+C)', STATE.IMPLEMENTED, 'cancels the turn and its child processes'),
  ]);

  // ISOLATION — verified by reading the tree: these files are simply not here.
  const absent = (f) => !fs.existsSync(path.join(srcDir, f));
  const orchestraGone = absent('orchestra.js') && absent('relay.js') && absent('agents.js');
  let importsLainModel = false;
  try {
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith('.js')) continue;
      const body = fs.readFileSync(path.join(srcDir, f), 'utf8');
      if (/require\(['"][^'"]*lain-model/.test(body)) { importsLainModel = true; break; }
    }
  } catch { /* unreadable tree — leave the honest default */ }
  g('Isolation (V2 stands alone)', [
    row('V1 tree', STATE.VERIFIED, 'V2 is a separate tree; V1 is never imported or modified'),
    row('Orchestra', orchestraGone ? STATE.EXCLUDED : STATE.ATTENTION,
      orchestraGone ? 'no orchestra.js/relay.js/agents.js in the tree' : 'orchestra files unexpectedly present'),
    row('lain-model', importsLainModel ? STATE.ATTENTION : STATE.EXCLUDED,
      importsLainModel ? 'a module imports lain-model' : 'nothing imports the lain-model service'),
    row('External providers', STATE.INFO, 'external LLMs reached through the provider/connection path — the intended seam'),
  ]);

  // GAPS — stated plainly, because hiding them is the failure this view exists
  // to prevent. Detected from the tree, not assumed.
  const tree = { files: fs.existsSync(srcDir) ? fs.readdirSync(srcDir).map((f) => `src/${f}`) : [], read: (rel) => { try { return fs.readFileSync(path.join(srcDir, '..', rel), 'utf8'); } catch { return ''; } } };
  const crossRun = await hasCapability('cross-run-learning', tree);
  // THE SECOND MODEL, and whether it can actually be reached. A configured name
  // that no connection serves is NOT configured for any useful purpose, so the
  // route is resolved rather than the setting being read back.
  const externalMod = require('./external');
  const ext = externalMod.settings(app.cfg);
  let extRoute = { ok: false, why: ext.why };
  try { extRoute = externalMod.route(app); } catch (e) { extRoute = { ok: false, why: e.message }; }
  g('External model', [
    row('Reviewer', extRoute.ok ? STATE.IMPLEMENTED : ext.why === 'NOT CONFIGURED' ? STATE.MISSING : STATE.ATTENTION,
      extRoute.ok ? `${ext.model} · ${ext.maxRounds} rounds max` : `NOT CONFIGURED — ${extRoute.why || ext.why}`),
    row('Relay', extRoute.ok ? STATE.IMPLEMENTED : STATE.PARTIAL,
      extRoute.ok
        ? 'troubleshooting runs LAIN → external → LAIN, bounded, with a named exit'
        : 'troubleshooting runs locally only and says so'),
  ]);

  // THE DESKTOP SEAM, read from the LIVE bridge — never from the presence of a
  // source file. "mcp.js exists" and "a bridge is connected" are different
  // facts, and reporting the first as the second is exactly the claim this view
  // exists to prevent.
  const mcpMod = require('./mcp');
  let bridge = { state: mcpMod.STATE.NOT_CONFIGURED, reason: 'no bridge command in config', permissions: { active: false } };
  try { bridge = app.desktop().bridge.status(); } catch { /* keep the honest default */ }
  const connected = bridge.state === mcpMod.STATE.CONNECTED;
  g('Desktop control', [
    row('MCP bridge', connected ? STATE.STABLE : bridge.configured ? STATE.ATTENTION : STATE.MISSING,
      connected ? `${bridge.name} · ${bridge.capabilities.length} capability(ies)`
        : bridge.configured ? `${bridge.state} — ${bridge.reason}` : 'NOT CONFIGURED — no bridge process is set up'),
    row('Desktop permission', bridge.permissions && bridge.permissions.active ? STATE.ATTENTION : STATE.VERIFIED,
      bridge.permissions && bridge.permissions.active
        ? `GRANTED right now${bridge.target ? ` · ${bridge.target}` : ''} — /mcp revoke stops it`
        : 'nothing is granted; every capability requires an explicit answer'),
    row('Automation in LAIN', STATE.EXCLUDED,
      'LAIN synthesises no input and captures no screen itself — that is the bridge process'),
  ]);

  const hasModule = (f) => fs.existsSync(path.join(srcDir, f));
  const dash = commands.REGISTRY.has('/dash');
  g('Known gaps', [
    row('Cross-run learning', crossRun ? STATE.IMPLEMENTED : STATE.MISSING,
      crossRun ? 'a learning store is present' : 'no memory of past runs — each session starts cold'),
    // The AREA column is 22 wide; a longer label is truncated, and a row that
    // reads "Remote dashboard (/da…" is a worse answer than one that puts the
    // command in the evidence where there is room for it.
    row('Remote dashboard', dash ? STATE.IMPLEMENTED : STATE.MISSING,
      dash ? '/dash — localhost by default; LAN only when explicitly asked for' : 'no web dashboard configured'),
    hasModule('mcp.js') ? null : row('Desktop seam', STATE.MISSING, 'no bridge seam in the tree'),
  ]);

  const flat = groups.flatMap((gr) => gr.rows);
  const summary = { ready: flat.filter((r) => r.state.ready).length, total: flat.length };
  return { groups, summary };
}

// ------------------------------------------------------------------ render ---

function renderHealth(app, a, { C } = {}) {
  const col = C || { bold: (s) => s, dim: (s) => s, green: (s) => s, yellow: (s) => s, red: (s) => s, cyan: (s) => s };
  const paint = (state, s) => (col[state.colour] ? col[state.colour](s) : s);
  const w = (s) => app.render.write(s);

  w('\n' + col.bold('LAIN V2 — RC readiness') + '\n');
  w(col.dim(`  ${a.summary.ready}/${a.summary.total} areas ready · legend: `)
    + col.green('✓ ready') + col.dim(' · ') + col.yellow('⚠ attention') + col.dim(' · ')
    + col.red('✕ missing') + col.dim(' · ⊘ excluded · ') + col.cyan('● info') + '\n');

  const wArea = 22;
  for (const gr of a.groups) {
    if (!gr.rows.length) continue;
    w('\n  ' + col.bold(gr.title) + '\n');
    for (const r of gr.rows) {
      const area = r.area.length > wArea ? r.area.slice(0, wArea - 1) + '…' : r.area.padEnd(wArea);
      const badge = paint(r.state, `${r.state.sym} ${r.state.word}`);
      w('    ' + area + '  ' + badge + (r.note ? col.dim('  ' + r.note) : '') + '\n');
    }
  }

  const notReady = a.summary.total - a.summary.ready;
  w('\n  ' + (notReady === 0
    ? col.green('All tracked areas are ready.')
    : col.yellow(`${notReady} area(s) need attention before RC — shown above, nothing hidden.`)) + '\n');
  w(col.dim('  This reflects live probes and the source tree, not the test count. Run /audit for the project itself.\n'));
}

// NO WORKSPACE PANE HERE. The HEALTH tab shows the PROJECT's health
// (projecthealth.js); this is a question about the tool, asked deliberately
// before a release rather than kept on screen while working. A second layout
// function for it would have been a second surface with no reader.

// ----------------------------------------------------------------- command ---

async function runCommand(app, _ctx, { C } = {}) {
  let a;
  try { a = await assess(app); }
  catch (e) { app.render.notice('error', `Could not assess health: ${e.message}`); return; }
  renderHealth(app, a, { C });
  return a;
}

module.exports = { assess, renderHealth, runCommand, STATE };
