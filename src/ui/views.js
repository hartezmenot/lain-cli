'use strict';

/**
 * VIEWS — pure state → lines.
 *
 * Every function here reads EXISTING application state (session, plan,
 * lifecycle, checkpoints, catalog, provider) and returns an array of strings.
 * Nothing here calls a model, touches the network, reads a file, or holds state
 * of its own. That is what makes the UI free: rendering never costs a token,
 * because everything it shows is already known to the program.
 *
 * Being pure also makes the whole UI testable without a terminal.
 */

const STATE = Object.freeze({
  READY: 'READY',
  WORKING: 'WORKING',
  THINKING: 'THINKING',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
  INTERRUPTING: 'INTERRUPTING',
  INTERRUPTED: 'INTERRUPTED',
  ERROR: 'ERROR',
  BLOCKED: 'BLOCKED',
  NEEDS_USER: 'NEEDS USER',
  NEEDS_AUTH: 'NEEDS AUTH',
  FAILED: 'FAILED',
  VERIFYING: 'VERIFYING',
  COMPLETE: 'COMPLETE',
  MAINTENANCE: 'MAINTENANCE',
});

const { P } = require('./paint');

/**
 * Which colour a header state deserves. ONE map, so the dot and the word can
 * never disagree, and so "what does yellow mean here" has a single answer.
 */
const STATUS_COLOUR = Object.freeze({
  READY: 'meta', WORKING: 'info', THINKING: 'info', RUNNING: 'info',
  WAITING: 'warn', INTERRUPTING: 'warn', INTERRUPTED: 'warn', VERIFYING: 'warn',
  'NEEDS USER': 'warn', 'NEEDS AUTH': 'warn', MAINTENANCE: 'warn',
  ERROR: 'bad', BLOCKED: 'bad', FAILED: 'bad',
  COMPLETE: 'ok',
});

function paintStatus(status, text) {
  const fn = P[STATUS_COLOUR[status] || 'plain'];
  return fn ? fn(text) : String(text);
}

/**
 * Map the lifecycle + the LIVE EXECUTION PHASE onto one header state.
 *
 * `phase` comes from the turn loop and outranks everything except a question
 * being asked of the user, because it is the most specific true statement
 * available: "THINKING" and "RUNNING" are both WORKING, and the difference
 * between them is the whole point — one is waiting on a server, the other is
 * waiting on this machine.
 */
function statusOf({ lifecycle, busy = false, awaitingUser = false, providerStatus = null, phase = null, interrupting = false, interrupted = false, failed = false, pendingCompletion = null } = {}) {
  if (interrupting) return STATE.INTERRUPTING;
  if (awaitingUser) return STATE.NEEDS_USER;
  // RESTING STATES, held until the user does something else. Both answer a
  // question asked a second after the fact — "did my Ctrl+C land?", "did that
  // actually work?" — which a status that flashed for one frame cannot.
  //
  // ERROR exists because the header said READY the instant a provider died.
  // The failure was in the feed, but the one word summarising the session
  // contradicted it, which is the same as reporting success.
  if (failed && !phase && !busy) return STATE.ERROR;
  if (interrupted && !phase && !busy) return STATE.INTERRUPTED;
  // THE PLAN IS FINISHED AND THE TASK IS NOT.
  //
  // Every box ticked and something still outstanding — a change nobody checked,
  // a model that said it has more to do. The one word summarising the session
  // must not be READY or COMPLETE here: those both read as "LAIN stopped", and
  // the whole point is that it has not. pendingCompletion carries the reason, set
  // by App.maybeComplete when it declines.
  if (pendingCompletion && !phase && !busy) return STATE.VERIFYING;
  if (providerStatus === 'MAINTENANCE' || providerStatus === 'DISABLED') return STATE.MAINTENANCE;
  if (phase) {
    switch (phase.phase) {
      case 'WAITING_MODEL': return STATE.THINKING;
      case 'RECEIVING': return STATE.WORKING;
      case 'RUNNING_TOOL': return STATE.RUNNING;
      case 'RETRYING': return STATE.WAITING;
      case 'ENDED': break;
      // ANY OTHER LIVE PHASE IS STILL WORK. The switch listed the phases the
      // turn loop had when it was written, so a phase added later — EXTERNAL
      // review, an MCP action — fell through to READY, and the one word
      // summarising the session said LAIN had stopped while a second model was
      // mid-sentence. Only ENDED means nothing is happening.
      default: return STATE.WORKING;
    }
  }
  if (busy) return STATE.WORKING;
  if (!lifecycle) return STATE.READY;
  switch (lifecycle.state) {
    case 'DONE': return STATE.COMPLETE;
    case 'BLOCKED': return STATE.BLOCKED;
    case 'NEEDS_USER': return STATE.NEEDS_USER;
    case 'NEEDS_AUTH': return STATE.NEEDS_AUTH;
    case 'FAILED': return STATE.FAILED;
    default: return STATE.READY;
  }
}

// THE LIVE ROW MOVED. It used to be built here (`liveLine`) and drawn at the top
// of the workspace, by either the pinned banner or the foot of the activity
// feed — two owners, both far from where the user is looking while they wait.
// ui/status.js now owns it in full, in the strip directly above the INPUT, and
// says more than this ever did: an absolute retry time, a countdown, and the
// trail of what the turn just finished. There is exactly one implementation of
// "what is LAIN doing right now" and this is not it.

/**
 * PROGRESS = COMPLETED work, never the current step number.
 *
 * With 5 steps and step 1 merely STARTED, progress is 0% — not 20%. Using
 * `current/total` reports work as finished the moment it begins, which is the
 * one thing a progress indicator must never do.
 *
 * An unknown total yields `known: false` and NO percentage. A made-up number is
 * worse than admitting the total is unknown.
 */
/**
 * HOW FAR ALONG THE WORK IS — moved to ui/progress.js when this file reached
 * the architecture guard. Re-exported below, because the status strip, the
 * task banner and `/copy` have always imported these from here and the seam
 * is about where the code lives, not about who may call it.
 */
const { livePlan, progressOf, bar, progressCompact } = require('./progress');

/**
 * THE TASK BANNER — pinned above the activity feed so it never scrolls away.
 *
 * This is where the answer to "what am I doing, and how far along?" lives. The
 * objective leads; the progress block sits DIRECTLY beneath it — current step,
 * a real bar, and a percentage that comes from COMPLETED work (progressOf), not
 * the active step index. With no plan there is no progress block: an honest
 * "here is the task" rather than a fabricated bar.
 *
 * `compact` collapses the whole thing to two lines (objective + one progress
 * line) for narrow or short terminals, where the design is explicit that the
 * progress indicator is the last thing to sacrifice.
 */
/**
 * THE PINNED OBJECTIVE, when the objective is a four-hundred-line paste.
 *
 * ------------------------------------------------------------------------
 * SEEN ON SCREEN, and it is the pinned half of the wall-of-text failure:
 *
 *     TASK  STEER — RENDERING AUDIT # PHASE 0 — AUDIT BEFORE IMPLEMENTATION
 *           Before modifying code: 1. Inspect the existing activity/motion…
 *
 * Every newline collapsed to a space, headings and a numbered list run into one
 * another, and the row that is supposed to say WHAT IS BEING WORKED ON says
 * nothing recognisable at all. The feed had already solved this — a paste is
 * drawn as `[pasted text #1]` (ui/pasted.js) — and the banner was flattening
 * the identical bytes into prose two rows above it.
 *
 * SAME VOCABULARY AS THE FEED, deliberately. The marker names it, and the first
 * line of the paste follows as a title so the row still identifies WHICH task:
 *
 *     TASK  [pasted text #1]  STEER — RENDERING AUDIT
 *
 * A typed objective is untouched — it is a sentence, and a sentence flattened to
 * one row is exactly what this row is for.
 */
function objectiveLine(objective) {
  const s = String(objective == null ? '' : objective);
  const pasted = require('./pasted');
  const lines = s.split('\n').filter((l) => l.trim());
  // ---- ONE ROW CANNOT SHOW TWO LINES, WHATEVER THEIR LENGTH -------------
  //
  // This asked `isPaste`, which is the FEED's question and rightly a bar about
  // BULK: two hundred characters before a message counts as an attachment. The
  // banner's question is different and it was borrowing the wrong one. Seen on
  // screen, from a ten-line instruction that came to a hundred and seventy
  // characters — under the bar, so "not a paste", so flattened:
  //
  //     TASK  STEER — ACCEPTANCE 1. one 2. two 3. three - alpha - beta A long…
  //
  // A heading, a numbered list and a bullet list run into one another in the
  // one row on screen that is supposed to say WHAT IS BEING WORKED ON. The
  // structure is short and it is still structure.
  //
  // So the banner asks its OWN question, and the question is NOT "is this more
  // than one line". That was the first attempt and it was too broad: three
  // lines composed with Ctrl+J — "line one / line two / line three" — flatten
  // to a perfectly readable row, and showing only the first would hide two
  // thirds of what was actually sent.
  //
  // What cannot survive flattening is STRUCTURE. A heading, a numbered list and
  // a bullet list run together are gibberish at any length; three sentences run
  // together are a sentence. `looksMarked` is the existing owner of exactly
  // that question — the same one ui/markdown.js uses to decide whether a
  // message needs rendering at all — so this cannot drift away from what the
  // renderer thinks structure is.
  //
  // `isPaste` still decides whether the MARKER is added, because that is
  // genuinely about bulk and has to agree with the feed's numbering.
  const marker = pasted.isPaste(s) ? `${pasted.label(s)}  ` : '';
  const structured = lines.length > 1 && require('./markdown').looksMarked(s);
  if (!structured) return marker + s.replace(/\s+/g, ' ');
  return marker + lines[0].trim().replace(/\s+/g, ' ');
}

function taskBanner({ session, width = 80, compact = false }) {
  const task = session && session.task;
  if (!task) return [];
  const objective = clip(objectiveLine(task.objective), width);
  const p = progressOf(livePlan(session));

  // THREE DIFFERENT QUESTIONS, never collapsed into one indicator:
  //   STEP     where in the plan the work is
  //   PROGRESS how much is FINISHED (0% while step 1 is merely started)
  //   STATUS   what is happening this second
  // A single "40% · working" bar answers none of them reliably.
  if (compact) {
    if (!p.known) return [P.key(objective)];
    // ONE ROW WHEN ONE ROW WILL DO. At 40x9 the whole workspace is three rows,
    // and spending two of them on "what" and "how far" left nothing for either
    // the feed or the live strip. Objective and progress share a row whenever
    // the objective still has room to be recognisable; only when it does not do
    // they separate again.
    // The BAR is the part that can shrink without losing meaning; the step
    // numbers and the percentage cannot. Asking for a narrower progress block
    // buys the objective the room to stay on the same row.
    const prog = progressCompact(p, Math.floor(width * 0.45));
    const room = width - prog.length - 2;
    if (room >= 12) return [P.key(clip(objective, room)) + '  ' + prog];
    return [P.key(objective), prog];
  }

  // TWO ROWS, NOT NINE.
  //
  // This was `TASK` / objective / blank / `STEP 2 / 5` / a 40-cell bar /
  // `20% complete` / blank / `STATUS` / the live row — nine rows of chrome for
  // three facts. Measured on an 80x24 terminal that leaves five rows for the
  // activity feed, so the work itself was pushed off the screen by the report
  // of how the work was going.
  //
  // The three questions are still answered separately — where in the plan
  // (STEP), how much is FINISHED (the bar and the percentage), and what is
  // happening this second (the live row). They are simply laid out across the
  // width the terminal already has instead of down the height it does not.
  const lines = [P.meta('TASK  ') + P.key(clip(objective, width - 6))];
  if (p.known) {
    const head = `STEP ${p.current}/${p.total}`;
    const tail = `${p.percent}%`;
    // The bar takes what is left of the row. It is the part that can shrink
    // without losing its meaning; the numbers cannot.
    const room = width - head.length - tail.length - 4;
    lines.push(clip(room >= 8
      ? `${head}  ${bar(p.percent, Math.min(32, room))}  ${tail}`
      : `${head}  ${tail}`, width));
  }
  // NO LIVE ROW HERE ANY MORE. What is happening this second now lives in the
  // status strip directly above the INPUT (ui/status.js) — at the bottom of the
  // screen where the user is already looking, instead of at the top where it
  // spent the rows the work itself needs.
  return lines;
}

// The launch surfaces — splash, pipe banner, empty-state pane — live in
// launch.js: they describe the PROGRAM rather than the work, and keeping them
// here pushed this file past the god-object guard. Re-exported below.
const launch = require('./launch');

// WIDTH IS MEASURED VISIBLY, NOT BY `.length`. These were three local
// functions counting characters in memory, which is why nothing drawn in the
// workspace was allowed to carry colour: an escape sequence measured as width
// it does not occupy tears the frame it is drawn inside. text.js counts what
// the terminal actually shows, so the same clipping now works on coloured
// content and the ban is lifted. Same names, same signatures, one owner.
const T = require('./text');
const clip = T.clip;
const pad = T.pad;

/** `1m04s` / `820ms`. Durations are facts the program already has. */
function dur(ms) {
  if (ms == null || !isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// Path shortening and the project name are width maths too — one owner, in
// text.js, so the header, the launch screen and the title all agree.
const shortPath = T.shortPath;
const projectName = T.projectName;
const center = T.center;


// ------------------------------------------------------------------ header --

/**
 * The header answers, at a glance: where am I, what is running, through what,
 * and how far along. Compact by design — a large logo buys nothing and costs
 * the rows the actual work needs.
 */
function header({ cwd, session, model, provider, connection, effort, plan, status, width = 80, compact = false, stats = null, framed = false }) {
  const w = Math.max(28, width);
  const lines = [];

  // Row 1 — identity and place. The project NAME leads, because that is what
  // the user calls it; the full path follows only if there is room for it.
  // Inside a frame the box is already labelled `L A I N`, so repeating the
  // wordmark here would spend a row saying it twice.
  const name = projectName(cwd);
  const brand = framed ? name : `LAIN  ▸ ${name}`;
  const room = w - brand.length - 2;
  const right = room >= 12 ? shortPath(cwd || '', room) : '';
  // The project NAME is the thing to find; the path beside it is context.
  lines.push(P.key(clip(brand, w))
    + (right ? ' '.repeat(Math.max(1, w - brand.length - right.length)) + P.meta(right) : ''));

  // Row 2 — the route, as SEPARATE fields. Collapsing model/provider/connection
  // into one string is what makes "is it down or am I logged out?" unanswerable.
  const dot = status === STATE.WORKING ? '●' : status === STATE.READY ? '○' : '◆';
  const statusText = `${dot} ${status}`;
  // THE ROUTE INCLUDES THE DOWNSTREAM, which was hiding inside the model id
  // as a prefix and reading as part of its name. See ui/phrasing.js routeOf.
  const id = require('./phrasing').routeOf(model, provider, connection);
  const route = id.route;
  const shown = id.model;
  const plainLeft = [shown || 'no model', route, `effort ${effort || 'auto'}`].filter(Boolean).join('   ');
  const room2 = Math.max(10, w - statusText.length - 2);
  // MODEL leads and is the only coloured field: it is the one a person checks
  // before sending anything. The route and the effort are qualifiers.
  const left = plainLeft.length <= room2
    ? P.info(shown || 'no model') + P.meta((route ? '   ' + route : '') + `   effort ${effort || 'auto'}`)
    : P.info(clip(plainLeft, room2));
  lines.push(left + ' '.repeat(Math.max(1, w - Math.min(plainLeft.length, room2) - statusText.length))
    + paintStatus(status, statusText));

  if (compact) return lines;

  // THERE IS NO ROW 3.
  //
  // It carried the objective, or the plan's percentage — and BOTH are already
  // pinned by the TASK banner two rows further down, so a 24-row terminal spent
  // two of its rows printing the same sentence twice:
  //
  //     │ the dashboard status has been stale since Aug 14      ← header row 3
  //     ┌─[1 context] 2 plan  3 diff …
  //     TASK  the dashboard status has been stale since Aug 14  ← the banner
  //
  // Chrome repeating itself above a conversation that has no room left is the
  // whole complaint. The header answers WHERE AM I and WHAT AM I TALKING TO;
  // the banner answers WHAT AM I DOING and HOW FAR; the live strip above the
  // INPUT answers WHAT IS HAPPENING RIGHT NOW. One question, one owner, one
  // row — and this row goes back to the conversation.
  return lines;
}

// --------------------------------------------------------------- workspace --


/**
 * ACTIVITY — a readable transcript of what LAIN did, and is doing now.
 *
 * It used to print the deduplicated TOOL NAMES of the last eight turns:
 * "✓ read_file" told you a file was read but never which one, in what order, or
 * whether it worked. The turn record now carries one bounded entry per call, so
 * this shows the subject and the outcome — the difference between a log and a
 * list of verbs.
 */
/**
 * THE TASK VIEW — what LAIN is doing, as an account rather than a log.
 *
 * One region, read top to bottom: what was asked, how far it has got, the plan
 * if there is one, then what actually happened. Durations, token counts,
 * request counts and turn ids are diagnostics — they live in `/status`, not in
 * the thing you watch while work is in progress.
 */
// THE CONVERSATION lives in ui/conversation.js — the story of the task, replayed.
// This file keeps the chrome around it. Re-exported so callers keep one import.
const { activity, sameText } = require('./conversation');
/** How many completed rows PLAN shows before folding the older ones. */
const PLAN_DONE_ROWS = 8;


/**
 * PLAN — the session-owned plan, with the active step obvious and completed
 * steps kept visible as evidence. Expansion is DISPLAY ONLY: opening a step
 * cannot alter plan state, which is why a huge step can never corrupt the plan.
 */
function planView({ plan, expanded = new Set(), width = 80, cursor = -1, evidence = null }) {
  if (!plan || !plan.steps.length) {
    return [
      '',
      '  No plan yet.',
      '',
      '  Plans are optional — LAIN never requires one.',
      '  /plan step <text>   add a step',
      '  /plan done <note>   finish the open step',
    ];
  }
  const lines = [];
  const p = progressOf(plan);
  lines.push(P.head('PLAN'));
  lines.push('');

  const visible = plan.steps.filter((s) => s.status !== 'dropped');
  const shownDone = visible.filter((s) => s.status === 'done').slice(-PLAN_DONE_ROWS);
  const shown = new Set(shownDone.map((s) => s.n));
  const olderDone = visible.filter((s) => s.status === 'done').length - shownDone.length;
  if (olderDone > 0) {
    lines.push(`  ✓ ${olderDone} earlier completed step(s) — expand a recent step for its note`);
    lines.push('');
  }
  for (const s of visible) {
    if (s.status === 'done' && !shown.has(s.n)) continue;
    if (s.status === 'dropped') continue;
    const open = expanded.has(s.n);
    const sel = s.n === cursor ? '❯' : ' ';
    // Just the mark and the text. Step numbers, carets, statuses and right-hand
    // glyph columns are bookkeeping — the shape of the list already says where
    // you are.
    //
    // THE MARK CARRIES THE STATE IN COLOUR as well as in shape, so a long plan
    // can be read at a glance instead of character by character: done is green,
    // the step in flight is the one bright thing, and what is still to come is
    // quiet. The glyphs are unchanged, so nothing is lost with colour off.
    const paintMark = s.status === 'done' ? P.ok : s.status === 'active' ? P.info : P.meta;
    const text = s.status === 'active' ? P.key(clip(s.text, width - 6)) : clip(s.text, width - 6);
    lines.push(`${sel} ${paintMark(MARK[s.status] || MARK.todo)} ${text}`);

    if (open) {
      lines.push('');
      if (s.note) {
        lines.push('      Why');
        for (const l of wrap(s.note, width - 10)) lines.push(`        ${l}`);
        lines.push('');
      }
      const files = [];
      if (Array.isArray(s.files)) for (const f of s.files) files.push(f);
      if (evidence && typeof evidence.forStep === 'function') {
        for (const e of evidence.forStep(s.n).slice(0, 8)) files.push(e);
      }
      if (files.length) {
        lines.push('      Files');
        for (const f of files.slice(0, 8)) lines.push(`        ${clip(f, width - 10)}`);
        lines.push('');
      }
      lines.push('      Status');
      lines.push(`        ${s.status === 'done' ? 'complete' : s.status === 'active' ? 'working' : 'not started'}`);
      lines.push('');
    }
  }
  // HOW FAR ALONG, under the list it describes.
  //
  // The pane showed the steps and never the total, so "am I nearly there?" had
  // to be answered by counting ticks. The bar is the same `progressOf` every
  // other surface uses — COMPLETED work, never the current step index.
  //
  // AND IT IS NOT A COMPLETION CLAIM. A plan at 100% means every step someone
  // wrote down is ticked; whether the TASK is finished is the lifecycle's
  // decision and nobody else's (see App.maybeComplete), which is why this says
  // `STEP 5/5 · 100%` and never the word DONE.
  if (p.known) {
    lines.push('');
    lines.push(`  ${P.meta(`STEP ${p.current}/${p.total}`)}`);
    lines.push(`  ${bar(p.percent, Math.max(8, Math.min(28, width - 12)))}  ${P.meta(`${p.percent}%`)}`);
  }
  if (plan.decisions && plan.decisions.length) {
    lines.push('');
    lines.push('  Decisions');
    for (const d of plan.decisions.slice(-5)) lines.push(`    · ${clip(d.text, width - 6)}`);
  }
  return lines;
}

// The feed (MODEL vs ACTIONS) and the input viewport are their own concerns,
// in their own modules. Re-exported below so callers keep one import.
const { MARK, phrase, verbOf } = require('./phrasing');
const {
  pushAction, pushModel, pushUser, pushExternal, pushMcp, pushNote, renderFeed, compactRuns, spokenCount,
} = require('./feed');
const { inputViewport, pasteSummary, lineCount, wrapInput, caretRow } = require('./viewport');

/** Soft-wrap a sentence to a width, for the few places prose is shown. */
function wrap(text, width) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

// The change-oriented views (diff, files, output) live in panes.js — same rule,
// same signature, separate module because they read checkpoint bytes rather than
// session state. Re-exported here so callers keep one import.
const panes = require('./panes');
const { wrap: wrapText } = require('./doc');

/**
 * A ROW WHOSE VALUE IS CONTENT, WRAPPED INSTEAD OF CUT.
 *
 * ------------------------------------------------------------------------
 * WHY THIS SCREEN MAY NOT CLIP. Most rows here are LABELS — a path in a column,
 * a plan step, a header field — and cutting one to the column is right: the row
 * has a fixed height by design and the whole thing is one keystroke away in its
 * own pane. Three rows are not labels: the command a verification RAN, and the
 * two under `How to run` and `How to test`. Those are content somebody is about
 * to copy, and half a command is worse than none — it looks complete enough to
 * type. The same defect ui/markdown.js `howtoBox` had, on the other surface
 * answering the same question. `doc.wrap` never drops a character; the
 * continuation is indented under the lead so two rows read as one command.
 */
function wrapUnder(lead, value, width) {
  const parts = wrapText(String(value == null ? '' : value), Math.max(12, width - lead.length - 2));
  return [lead + parts[0], ...parts.slice(1).map((p) => ' '.repeat(lead.length) + '  ' + p)];
}

// ------------------------------------------------------------- completion --

/**
 * Derived entirely from task/evidence/checkpoint state — never narration.
 *
 * `cursor` picks which of the two choices Up/Down has landed on (0 diff,
 * 1 keep working) — see ui/keys.js's `if (this.screen.completion)` branch,
 * which is the only thing that ever changes it. The two used to be `[D]`/`[R]`
 * printable letters that a screen showing plain text could never actually
 * make live (see this module's header) — replaced with the same arrow+Enter
 * navigation the STILL GOING ROUND advisory uses, for the same reason.
 */
function completion({ session, checkpoints, cwd, verification = [], width = 80, cursor = 0 }) {
  const lines = ['✓ TASK COMPLETE', ''];
  const obj = session && session.task ? session.task.objective.replace(/\s+/g, ' ') : '';
  if (obj) { lines.push(clip(obj, width)); lines.push(''); }
  // The SAME change facts the diff and files views read — one source, so the
  // completion screen can never claim a different set of files than the diff.
  const files = panes.changedFiles({ checkpoints, cwd });
  if (files.length) {
    lines.push('Changed');
    for (const f of files) lines.push(`  ${pad(f.kind, 9)} ${pad(clip(f.rel, width - 24), width - 22)}+${f.added} -${f.removed}`);
    lines.push('');
  }
  if (verification.length) {
    lines.push('Verification');
    for (const v of verification) {
      for (const r of wrapUnder(`  ${v.ok ? '✓' : '✗'} `, v.label, width)) lines.push(r);
    }
    lines.push('');
  }
  // ---- HOW TO RUN IT, AND HOW TO TEST IT --------------------------------
  //
  // The one question a completion screen was not answering. "I changed three
  // files and the suite passes" is only half of what somebody needs at the end
  // of a task; the other half is the command that starts the thing, and it is
  // the first thing they go looking for.
  //
  // DISCOVERED, NEVER INVENTED — the same `runCommands` CONTEXT and /brief read,
  // which takes them from package.json scripts, a Makefile, pyproject and so on.
  // A project that declares none gets no block rather than a plausible guess:
  // a wrong run command is worse than an absent one, because it gets typed.
  try {
    const cmds = require('./briefview').runCommands(cwd || process.cwd(), null);
    const tests = cmds.filter((c) => /^(test|check)/i.test(c.label));
    const runs = cmds.filter((c) => !tests.includes(c)).slice(0, 3);
    const howto = (label, list) => {
      lines.push(label);
      for (const c of list) for (const r of wrapUnder(`  ${pad(c.label, 9)} `, c.cmd, width)) lines.push(r);
      lines.push('');
    };
    if (runs.length) howto('How to run', runs);
    if (tests.length) howto('How to test', tests.slice(0, 2));
  } catch { /* the summary is still worth showing without it */ }
  const l = session && session.lifecycle;
  if (l) {
    lines.push(`  ${l.evidence ? l.evidence.toolCalls || 0 : 0} tool calls · ${l.evidence ? (l.evidence.filesChanged || []).length || l.evidence.filesChanged.size || 0 : 0} files changed`);
    lines.push('');
  }
  // Every key named here is handled in ui/index.js. Advertising one that
  // does nothing is worse than not offering it.
  lines.push('');
  lines.push(`${cursor === 0 ? '❯ ' : '  '}diff — see what changed`);
  lines.push(`${cursor === 1 ? '❯ ' : '  '}keep working — type to carry on, or /new to start something else`);
  lines.push('');
  lines.push('↑↓ choose · Enter select · Tab panes · Esc close');
  return lines;
}

/**
 * THE VIEW SELECTOR, drawn as the workspace's own RULE.
 *
 * `┌─ [1 context] 2 plan  3 diff … ─── ↑ more ─┐`. It labels the region and
 * selects within it at the same time, which is what keeps the boundary between
 * "what LAIN is doing" and "where I type" visible without spending a second row
 * on a border.
 *
 * Only the ACTIVE view is named in brackets and coloured; the others go dim.
 * Five equal labelled boxes read as five competing panels, which is exactly the
 * dashboard look the workspace is meant to avoid.
 *
 * Lives here rather than on the Screen because it is a pure function of the
 * active view, a width and a hint — which is this file's whole job — and
 * because layout.js is at the god-object guard.
 */
function tabsLine(view, width, scroll = null) {
  const names = require('./tabs').VIEWS;
  const dots = names.map((n, k) => (n === view
    ? P.key(P.info(`[${k + 1} ${n}]`))
    : P.meta(` ${k + 1} ${n} `))).join('');
  const right = scroll ? P.meta(` ${scroll} `) : '';
  const room = Math.max(0, width - 2 - T.width(right));
  const left = clip('─' + dots, room);
  return '┌' + left + '─'.repeat(Math.max(0, room - T.width(left))) + right + '┐';
}

/**
 * Which of the three viewport states is true.
 *
 *   FOLLOW_LIVE          the newest content stays in view as it arrives
 *   MANUAL_SCROLL        the user is reading history
 *   NEW_ACTIVITY_PENDING reading history WHILE something is being said
 */
function viewportState({ stickToBottom, spoken = 0, anchorSpoken = 0 }) {
  if (stickToBottom) return 'FOLLOW_LIVE';
  return spoken > anchorSpoken ? 'NEW_ACTIVITY_PENDING' : 'MANUAL_SCROLL';
}

/**
 * The right-hand hint on the tab strip.
 *
 * `↓ 3 new · End` takes precedence over every "more" arrow, because it is the
 * only one that is NEWS: the arrows describe the shape of the content, and this
 * describes something that happened while you were not looking. It names the
 * key as well, so the way back is not folklore.
 */
function scrollHint(lines, bodyRows, { stickToBottom, scroll, anchorSpoken }) {
  const total = Array.isArray(lines) ? lines.length : Number(lines) || 0;
  const spoken = (Array.isArray(lines) && Number(lines.spoken)) || 0;
  if (viewportState({ stickToBottom, spoken, anchorSpoken }) === 'NEW_ACTIVITY_PENDING') {
    return `↓ ${spoken - anchorSpoken} new · End`;
  }
  if (total <= bodyRows) return '';
  if (scroll <= 0) return '↓ more';
  if (scroll >= total - bodyRows) return '↑ more';
  return '↕ more';
}

module.exports = {
  tabsLine, viewportState, scrollHint,
  MARK, phrase, verbOf,
  STATE, statusOf, progressOf, livePlan, bar, progressCompact, clip, pad, dur, shortPath, projectName,
  header, activity, taskBanner, planView, completion, phrase, center, paintStatus,
  inputViewport, pasteSummary, lineCount, wrapInput, caretRow, renderFeed, wrap, MARK,
  // owned by launch.js — the surfaces shown before any work exists
  welcome: launch.welcome,
  splashLines: launch.splashLines,
  bannerLines: launch.bannerLines,
  // owned by panes.js, re-exported so the screen has one place to look
  diffView: panes.diffView,
  filesView: panes.filesView,
  outputView: panes.outputView,
  changedFiles: panes.changedFiles,
  scanTree: panes.scanTree,
  unifiedish: panes.unified,
};
