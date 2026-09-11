'use strict';

/**
 * `/copy` — TAKE WHAT IS ON THE SCREEN SOMEWHERE ELSE.
 *
 * A local utility, and only that. It sends nothing to a model, costs no tokens,
 * starts no turn and changes no state: it reads what LAIN already knows and
 * hands it to the system clipboard.
 *
 * WHAT IT CAN COPY is the same set the workspace can show, because the point is
 * "copy the thing I am looking at" — the task, the activity account, command
 * output, the diff, the audit, the project health, the model's last answer, or
 * what is actually in the model's context.
 *
 * NO DEPENDENCY. The clipboard is reached through the tool every one of these
 * platforms already ships — clip.exe, pbcopy, xclip/xsel/wl-copy — with the
 * text piped in. When none of them answers, the content is written to a file
 * and the path is printed, because "I could not copy it" is a useless answer to
 * "give me this text". ANSI colour is stripped on the way out: what is pasted
 * into a chat window or an editor must be text, not escape sequences.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const T = require('./ui/text');

/** How much of any one section is worth carrying. Bounded, like everything. */
const MAX_CHARS = 200_000;

// ------------------------------------------------------------ sanitising ---

/**
 * WHAT MAY REACH THE CLIPBOARD: only what the user can actually see.
 *
 * THE FAILURE. Text copied out of LAIN and pasted into PowerShell fails, with
 * an error naming a character that is not on the screen.
 *
 * THE CAUSE. This file used `ui/text.strip`, which removes SGR colour and
 * NOTHING else — that is all it was ever written to do, because it exists so
 * `width()` can count columns. Everything else LAIN or a subprocess emits went
 * straight through it:
 *
 *   OSC          `\x1b]0;proj\x07`         termtitle.js writes the window title
 *   CSI          `\x1b[K`, `\x1b[2J`        erase and cursor motion
 *   PASTE MARKS  `\x1b[200~` / `\x1b[201~`  bracketed paste
 *   ZERO WIDTH   U+200B, U+FEFF             invisible, a parse error each
 *   NBSP         U+00A0                     looks like a space, is not one
 *
 * And only three of the ten sections were passed through `strip` at all —
 * `output`, `last`, `diff` and `context` went out entirely raw, and `output` is
 * the one carrying a subprocess's own escapes.
 *
 * THE ONE BOUNDARY. Applied in `toClipboard`, because that is what every path
 * out actually calls: `/copy`, the mouse drag-selection in ui/mouse.js, the
 * relay packet in actors.js and the paste path in repl.js. Fixing it in `/copy`
 * alone would have left the terminal selection — the way people copy a command
 * they are looking at — still broken.
 *
 * IT IS NOT A SECOND EDITOR. Box drawing, punctuation, symbols and non-ASCII
 * prose are things somebody deliberately copied, and none of them are touched.
 * A non-breaking space becomes a REAL space rather than being deleted: it is a
 * word separator that merely looks like one, and removing it would silently
 * join two arguments into a different command.
 */
/** OSC — `ESC ] … BEL` or `ESC ] … ESC \`. The terminal title lives here. */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** DCS/PM/APC — `ESC P|^|_ … ESC \`. */
const DCS = /\x1b[P^_][^\x1b]*\x1b\\/g;
/** CSI — `ESC [ … final`. Covers SGR, erase, cursor motion and paste marks. */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** A bare two-character escape, once the structured forms are gone. */
const ESC1 = /\x1b[@-Z\\-_]/g;
/** Invisible, and a parse error each. Also the bidi overrides. */
const ZERO_WIDTH = /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;
/** Spaces that are not the space character. Replaced, never removed. */
const ODD_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
/** Control characters, keeping the two that are content: tab and newline. */
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Strip everything invisible from text on its way to the clipboard.
 *
 * TOTAL — it sits on the one path out, so it must never be the thing that turns
 * "copy this" into a stack trace.
 */
function sanitize(s) {
  // A CREDENTIAL IS NOT COPIED, EITHER. The clipboard is a display surface that
  // outlives the screen: it survives the session, reaches another application,
  // and is pasted into a chat window by somebody who has forgotten what was on
  // it. It is the ONE path out of LAIN, exactly as `render.write` is the one
  // path to the terminal, so the same filter belongs on it. See src/redact.js.
  let t = require('./redact').text(String(s == null ? '' : s));
  // ORDER MATTERS. The structured escapes go first: `\x1b[200~` is a CSI, and
  // removing the bare `\x1b` ahead of it would leave `[200~` as literal text.
  t = t.replace(OSC, '').replace(DCS, '').replace(CSI, '').replace(ESC1, '');
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(ZERO_WIDTH, '').replace(ODD_SPACE, ' ');
  return t.replace(CTRL, '');
}

// ------------------------------------------------------------- clipboard ---

/**
 * Put text on the system clipboard. Returns { ok, how } or { ok:false, error }.
 *
 * ------------------------------------------------------------------------
 * ON WINDOWS THE BYTES GO TO clip.exe AS UTF-16LE, AND WITHOUT A BOM.
 *
 * THE DEFECT, reported from real use and reproduced on the first try. Somebody
 * copied a command out of LAIN, pasted it into PowerShell, and got
 *
 *     powershell : The term 'powershell' is not recognized as the name of a
 *     cmdlet, function, script file, or operable program.
 *
 * with an invisible character in front of `powershell` in both places. It is
 * U+FEFF, and LAIN PUT IT THERE. `sanitize` above strips U+FEFF out of the
 * CONTENT, and names it in that comment as "invisible, a parse error each" —
 * and then this function prepended a fresh one as an encoding mark. clip.exe
 * does not consume a BOM. It stores those two bytes as the first character of
 * the clipboard.
 *
 * So the filter was right, the transport undid it, and what came out is
 * precisely the failure the filter exists to prevent.
 *
 * WHY NOT SIMPLY UTF-8 — measured on this machine, not assumed:
 *
 *   utf16 + BOM   the reported bug: U+FEFF before the first letter
 *   utf16 no BOM  exact, with arrows, accents and ticks intact
 *   utf8          mangled: one arrow arrives as three console-codepage letters
 *
 * The BOM was added to stop that third case, and it worked; it just brought a
 * character with it. clip.exe reads UTF-16LE without being told, checked on the
 * cases where a byte-pattern heuristic would fail: an all-CJK string, which has
 * none of the 0x00 padding that makes UTF-16 ASCII recognisable, and strings
 * whose FIRST character is non-ASCII. Every one came back byte-identical.
 */
function toClipboard(raw) {
  // THE BOUNDARY. Every path out of LAIN calls this one, so it is the only
  // place that can promise the clipboard holds nothing invisible. See sanitize.
  const text = sanitize(raw);
  const attempts = process.platform === 'win32'
    ? [{ cmd: 'clip', args: [], encode: (t) => Buffer.from(t, 'ucs2') }]
    : process.platform === 'darwin'
      ? [{ cmd: 'pbcopy', args: [] }]
      : [
        { cmd: 'wl-copy', args: [] },
        { cmd: 'xclip', args: ['-selection', 'clipboard'] },
        { cmd: 'xsel', args: ['--clipboard', '--input'] },
      ];
  let lastError = 'no clipboard tool on this system';
  for (const a of attempts) {
    try {
      const r = spawnSync(a.cmd, a.args, {
        input: a.encode ? a.encode(text) : text,
        windowsHide: true,
        timeout: 5000,
      });
      if (r.error) { lastError = r.error.message; continue; }
      if (r.status === 0) return { ok: true, how: a.cmd };
      lastError = `${a.cmd} exited ${r.status}`;
    } catch (e) { lastError = e.message; }
  }
  return { ok: false, error: lastError };
}

/**
 * READ the system clipboard. The other direction, and the same principle:
 * the tool every platform already ships, with no dependency added.
 *
 * Most terminals paste by writing the bytes themselves, so this is only ever
 * needed by the ones that send Ctrl+V as a key instead. Bounded like the
 * write side — a clipboard holding a megabyte is not a prompt.
 *
 * @returns {{ok:true, text:string}|{ok:false, error:string}}
 */
function fromClipboard() {
  const attempts = process.platform === 'win32'
    // ---- AND THE OUTPUT ENCODING, WHICH IS NOT THE DEFAULT --------------
    //
    // `Get-Clipboard -Raw` writes to stdout through the CONSOLE CODE PAGE,
    // which on a Western Windows install is cp437 or cp1252 — so a clipboard
    // holding `npm test -> cafe check` in real Unicode arrived here as
    // `npm test U+001A caf? ?`. The arrow became a SUBSTITUTE control character
    // and the accents became replacement marks, silently, on the path that
    // exists to bring somebody's pasted text into the prompt.
    //
    // Found by the round-trip test in tests/smoke/clipboard-powershell.test.js
    // while it was checking the WRITE side: the write was already correct and
    // the read was destroying the evidence of it.
    ? [{
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'],
    }]
    : process.platform === 'darwin'
      ? [{ cmd: 'pbpaste', args: [] }]
      : [
        { cmd: 'wl-paste', args: ['--no-newline'] },
        { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
        { cmd: 'xsel', args: ['--clipboard', '--output'] },
      ];
  let lastError = 'no clipboard tool on this system';
  for (const a of attempts) {
    try {
      const r = spawnSync(a.cmd, a.args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      if (r.error) { lastError = r.error.message; continue; }
      if (r.status === 0) {
        // PowerShell adds a trailing newline of its own; a paste should not
        // silently gain one. CRLF is normalised on the way in for the same
        // reason bracketed paste does it — the buffer holds LF only.
        const CR = String.fromCharCode(13);
        const LF = String.fromCharCode(10);
        let text = String(r.stdout || '').split(CR + LF).join(LF);
        if (text.endsWith(LF)) text = text.slice(0, -1);
        return { ok: true, text: text.slice(0, MAX_CHARS) };
      }
      lastError = `${a.cmd} exited ${r.status}`;
    } catch (e) { lastError = e.message; }
  }
  return { ok: false, error: lastError };
}

// --------------------------------------------------------------- sections ---

const plain = (lines) => lines.map((l) => T.strip(l)).join('\n');

/**
 * WHAT EACH NAME MEANS. Every one reads existing state; none of them asks a
 * model, and none of them re-runs work that has already been done.
 */
const SECTIONS = {
  /**
   * THE QUESTION LAIN IS ASKING RIGHT NOW, as plain text.
   *
   * A drawn panel is box characters and a cursor marker: copying the terminal
   * selection gives you `│ ❯ 2.  Chat-style … │`, which is not something you
   * can paste into anything. This is the same question and the same options,
   * with none of the drawing — the design's "make the prompt copy/paste
   * friendly", answered by giving the text rather than by changing the box.
   *
   * It is FIRST in the default order while a question is open, because when
   * LAIN is waiting on you the thing you want to take somewhere else is the
   * thing it is waiting about.
   */
  question(app) {
    const panel = app.ui && app.ui.panel;
    if (!panel || !panel.visible || !panel.acceptsTyped) return null;
    const A = require('./ui/answer');
    const frame = panel.frame || {};
    const options = frame.options || [];
    const out = [String(frame.question || '').trim()];
    const marks = A.labels(options);
    options.forEach((o, i) => out.push(`  ${marks[i]}. ${A.optionText(o)}`));
    out.push('', A.hint(options, panel.takes));
    return out.join('\n');
  },

  task(app) {
    const s = app.session;
    if (!s.task) return null;
    const out = [`TASK  ${s.task.objective}`];
    const life = s.lifecycle && s.lifecycle.summary ? s.lifecycle.summary() : null;
    if (life) {
      out.push(`state ${life.state}${life.reason ? ` — ${life.reason}` : ''}`);
      out.push(`${life.turns} turns · ${life.toolCalls} tool calls · ${life.filesChanged} files changed`);
    }
    if (s.plan && s.plan.steps.length) {
      out.push('', 'PLAN');
      for (const st of s.plan.steps) out.push(`  [${st.status}] ${st.text}`);
    }
    if (s.task.steers && s.task.steers.length) {
      out.push('', 'STEERS');
      for (const st of s.task.steers) out.push(`  ⚑ ${st.text}`);
    }
    return out.join('\n');
  },

  activity(app) {
    const views = require('./ui/views');
    return plain(views.activity({
      session: app.session,
      transcript: app.render.transcript,
      liveActions: app.ui.liveActions || [],
      liveNarration: app.ui.liveNarration || [],
      width: 100,
    }));
  },

  output(app) {
    const outs = (app.ui && app.ui.outputs) || [];
    if (!outs.length) return null;
    return outs.map((o) => `$ ${o.command}\n${o.output}\n(exit ${o.exitCode == null ? '?' : o.exitCode})`).join('\n\n');
  },

  diff(app) {
    const panes = require('./ui/panes');
    const files = panes.changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd });
    if (!files.length) return null;
    const g = panes.groupChanges(files);
    const out = [];
    const list = (label, rows) => { if (rows.length) out.push(label, ...rows, ''); };
    list('ADDED', g.added.map((f) => `  ${f.rel}  +${f.added}`));
    list('MODIFIED', g.modified.map((f) => `  ${f.rel}  +${f.added} -${f.removed}`));
    list('REMOVED', g.removed.map((f) => `  ${f.rel}  -${f.removed}`));
    list('RENAMED', g.renamed.map((r) => `  ${r.from} → ${r.to}`));
    for (const f of files) {
      out.push(`--- ${f.rel} (${f.kind})`);
      for (const l of panes.unified(f.before, f.after, 2000)) out.push(l);
      out.push('');
    }
    return out.join('\n');
  },

  async audit(app) {
    const a = await require('./audit').audit(app.session.cwd);
    return plain(require('./audit').auditLines(a, 100, require('./audit').workState(app)));
  },

  async health(app) {
    const ph = require('./projecthealth');
    return plain(ph.projectHealthLines(await ph.assess(app.session.cwd, app), 100));
  },

  async rc(app) {
    const a = await require('./health').assess(app);
    const out = [`LAIN RC READINESS — ${a.summary.ready}/${a.summary.total} areas ready`];
    for (const g of a.groups) {
      out.push('', g.title.toUpperCase());
      for (const r of g.rows) out.push(`  ${r.state.sym} ${r.area.padEnd(24)} ${r.state.word}  ${r.note || ''}`);
    }
    return out.join('\n');
  },

  troubleshoot(app) {
    const t = require('./troubleshoot').lastReport(app);
    return t ? plain(require('./troubleshoot').reportLines(t, 100)) : null;
  },

  /**
   * WHERE EVERYTHING STANDS RIGHT NOW — the thing you paste into a message when
   * you are asking someone else about it. Session, route, context, progress and
   * what is currently outstanding, from state that already exists.
   */
  status(app) {
    const rows = require('./diagnose').statusRows(app, { dim: (x) => x });
    const out = rows.map(([k, v]) => `${String(k).padEnd(14)} ${v}`);
    const views = require('./ui/views');
    const p = views.progressOf(views.livePlan(app.session));
    if (p.known) out.push(`${'progress'.padEnd(14)} step ${p.current}/${p.total} · ${p.percent}%`);
    if (app.pendingCompletion) out.push(`${'outstanding'.padEnd(14)} ${app.pendingCompletion}`);
    const life = app.session.lifecycle;
    if (life) out.push(`${'lifecycle'.padEnd(14)} ${life.state}${life.reason ? ' — ' + life.reason : ''}`);
    return ['STATUS', ...out].join('\n');
  },

  last(app) {
    const turns = app.session.turns || [];
    const last = turns[turns.length - 1];
    return last && last.text ? last.text : null;
  },

  /**
   * THE DIAGNOSTIC EXPORT — what you paste when you go and ask somebody else.
   *
   * ---- IT USED TO BE `session.messages`, AND THAT WAS THE WRONG SOURCE ----
   *
   * `messages` is the PROVIDER WIRE FORMAT, not the conversation: system
   * prompts, tool-call plumbing, and whole file bodies re-sent for cache
   * alignment. Copying it produced tens of thousands of characters that were
   * mostly not the exchange, and it buried the six lines a diagnosis needed.
   *
   * It is built from turn records now — see copysummary.js, which also states
   * exactly what is excluded and why.
   */
  context(app) {
    return require('./copysummary').context(app);
  },

  /** The whole session rather than the current task. `/copy context all`. */
  'context all': (app) => require('./copysummary').context(app, { all: true }),

  /**
   * THE TASK SUMMARY — what bare `/copy` now means.
   *
   * Request, result, what changed on disk, what was proved, what is left, and
   * how to run it. Everything transient is excluded by construction rather
   * than filtered out afterwards.
   */
  summary(app) {
    return require('./copysummary').summary(app);
  },

  /** The raw provider wire format, for when that IS the question. */
  messages(app) {
    const msgs = app.session.messages || [];
    if (!msgs.length) return null;
    return msgs.map((m) => {
      const head = m.role.toUpperCase() + (m.tool_call_id ? ` (${m.tool_call_id})` : '');
      return `--- ${head}\n${String(m.content || '')}`;
    }).join('\n\n');
  },
};

/**
 * WITH NO ARGUMENT: THE TASK SUMMARY.
 *
 * ---- WHAT THIS ORDER USED TO DO ---------------------------------------
 *
 * It was ['question', 'last', 'output', 'diff', 'task', 'status', 'activity']
 * and it took the FIRST non-empty one — which in practice meant `last`, the
 * model's most recent answer on its own, with no record of what was asked,
 * what changed, or whether anything was proved. `activity` sat at the end as a
 * fallback, so a quiet session could put a spinner's worth of frame-by-frame
 * narration on the clipboard.
 *
 * A QUESTION STILL WINS, and only while one is genuinely open: when LAIN is
 * waiting on you, the thing you want to take somewhere else is the thing it is
 * waiting about. Everything else falls through to the summary, and `last`
 * remains as the answer for a session that has not done any work yet.
 */
const DEFAULT_ORDER = ['question', 'summary', 'last'];

async function collect(app, name) {
  const fn = SECTIONS[name];
  if (!fn) return { error: `nothing called "${name}" — try: ${Object.keys(SECTIONS).join(', ')}` };
  let text = null;
  try { text = await fn(app); } catch (e) { return { error: e.message }; }
  if (!text || !String(text).trim()) return { empty: true };
  // SANITISED HERE TOO, not only in `toClipboard`: when no clipboard tool
  // answers, `runCommand` writes this text to a FILE instead, and a file full
  // of escape sequences is the same defect with an extra step.
  return { text: sanitize(text).slice(0, MAX_CHARS) };
}

// ----------------------------------------------------------------- command ---

async function runCommand(app, ctx = {}, { C } = {}) {
  const col = C || { dim: (s) => s, green: (s) => s, yellow: (s) => s };
  const want = String(ctx.rest || '').trim().toLowerCase();
  const w = (s) => app.render.write(s);

  let name = want;
  let got = null;
  if (!name) {
    // Pick the first thing that HAS something in it, and say which was chosen —
    // silently copying "the task" when the user meant the answer is worse than
    // asking, and naming it costs one line.
    for (const candidate of DEFAULT_ORDER) {
      const r = await collect(app, candidate);
      if (r.text) { name = candidate; got = r; break; }
    }
    if (!got) { w(col.dim('  Nothing to copy yet.\n')); return; }
  } else {
    got = await collect(app, name);
  }

  if (got.error) { w(col.yellow(`  ${got.error}\n`)); return; }
  if (got.empty) { w(col.dim(`  ${name}: nothing to copy yet.\n`)); return; }

  const text = got.text;
  const lines = text.split('\n').length;
  const r = toClipboard(text);
  if (r.ok) {
    w(col.green(`  copied ${name}`) + col.dim(` — ${lines} line(s), ${text.length} characters\n`));
    return { name, chars: text.length, copied: true };
  }
  // THE FALLBACK IS A FILE, not an apology. The text still reaches the user.
  const file = path.join(os.tmpdir(), `lain-copy-${name}-${Date.now()}.txt`);
  try {
    fs.writeFileSync(file, text, 'utf8');
    w(col.yellow(`  clipboard unavailable (${r.error})`) + col.dim(` — wrote ${lines} line(s) to\n    ${file}\n`));
    return { name, chars: text.length, copied: false, file };
  } catch (e) {
    w(col.yellow(`  could not copy or save: ${r.error} / ${e.message}\n`));
    return { name, copied: false, error: e.message };
  }
}

module.exports = { runCommand, collect, toClipboard, fromClipboard, sanitize, SECTIONS, DEFAULT_ORDER };
