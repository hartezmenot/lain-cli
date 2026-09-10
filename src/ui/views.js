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

// ------------------------------------------------------------------------
// THE TASK BANNER AND `objectiveLine` STOOD HERE, AND ARE GONE.
//
// The banner pinned the objective and a `STEP 3/5 ████░░ 60%` bar above the
// feed on two of the nine panes, permanently, and it was the reason
// ui/conversation.js suppressed the first user message. Against §11's test it
// answers none of the six questions the permanent surface exists to answer:
// the objective IS the first thing the user said, so the conversation says it,
// and the progress bar is what `/plan` is for.
//
// `progressOf`, `livePlan`, `bar` and `progressCompact` are UNTOUCHED and
// still re-exported: `/copy`, `/plan`, ui/briefview.js and ui/projection.js
// all read them, and removing a measurement because one of its four renderings
// went away is how a feature disappears by accident.
// ------------------------------------------------------------------------

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

/**
 * ------------------------------------------------------------------------
 * `dur(ms)` STOOD HERE — `1m04s` / `820ms` — and it is gone.
 *
 * It was the FOURTH copy of duration formatting in this tree and the only one
 * nothing called: not one site in `src/`, not one in `tests/`. It was defined,
 * exported, and dead.
 *
 * The other three were real and are now one. The live row above the caret, `/bg`
 * and the background region all read `HH:MM:SS` from ui/workclock.js `hhmmss`,
 * so a person comparing how long two things have taken does not have to convert
 * between formats to do it. A fourth spelling sitting here exported was an
 * invitation to make that four again.
 * ------------------------------------------------------------------------
 */

// Path shortening and the project name are width maths too — one owner, in
// text.js, so the header, the launch screen and the title all agree.
const shortPath = T.shortPath;
const projectName = T.projectName;
const center = T.center;


// ------------------------------------------------------------------ header --

/**
 * THE HEADER — one row, four facts, low prominence.
 *
 *     LAIN   lain-v2   claude-opus-5                        42k/128k
 *
 * ------------------------------------------------------------------------
 * WHAT IT ANSWERS, AND WHY THERE IS NOTHING ELSE ON IT.
 *
 * §11's test for anything permanently on screen is whether it answers one of
 * six questions. This row answers three of them — where am I, which model is
 * active, how much context is being used — and nothing here answers any of the
 * other three, so nothing else belongs.
 *
 * WHAT WAS REMOVED, AND WHERE IT WENT:
 *
 *   the `┌─ L A I N ─┐` frame   two rows of border round two rows of text.
 *                               Chrome. Gone; the wordmark is now a word.
 *   the ROUTE                   `omniroute → openrouter` sat here permanently.
 *                               Routing is LAIN choosing correctly, not LAIN
 *                               announcing its classifier: `/status` and
 *                               `/harness` still say it, on demand. §26.
 *   the EFFORT                  `effort high` — a setting, not a state.
 *                               `/effort` says it and sets it.
 *   the STATUS WORD and DOT     `○ READY` / `● WORKING`. What LAIN is doing is
 *                               the live row above the input, which says it in
 *                               more detail and one row from the caret. Two
 *                               owners for one fact is how they come to
 *                               disagree — and they did, at opposite ends of
 *                               the screen.
 *   the OBJECTIVE               it is the first thing the user said, so the
 *                               conversation says it.
 *
 * THE PATH RIDES BESIDE THE NAME only when there is genuine room, and it is the
 * first thing dropped. `lain-v2` is what a person calls this project;
 * `~/Documents/lain-v2` is the same fact spelled longer.
 *
 * NOTHING HERE IS BRIGHTER THAN THE CONVERSATION (§30). The model id is the
 * only field with colour, because it is the one a person checks before sending
 * anything; everything else is dim.
 */
function header({ cwd, model, provider, connection, output = null, width = 80 }) {
  const w = Math.max(20, width);

  // THE MODEL, WITHOUT ITS ROUTE. `routeOf` splits the downstream out of the
  // model id — that split is why the route was ever a separate field — and
  // here only the model half is kept.
  const id = require('./phrasing').routeOf(model, provider, connection);
  const name = projectName(cwd);
  const usage = outputLabel(output);

  // Assembled as PARTS with a drop order, the same way the live row sheds
  // detail: at 60 columns something has to go, and which something is a
  // decision rather than an accident of clipping from the right.
  // ---- FOUR FIELDS, FOUR WEIGHTS ----------------------------------------
  //
  // They were bold-white, dim and cyan, with the count dim — close, and the
  // project was the weakest thing on a row where it is the second most useful.
  //
  //     LAIN      bold cyan    the identity, and the only accent that is a name
  //     project   plain        where you are: the primary foreground, read often
  //     model     cyan         what you are talking to, and what it costs
  //     tokens    dim          the figure that moves, and metadata while it does
  //
  // Nothing here is at equal weight, which is the whole of §12.
  const left = [P.head('LAIN'), P.plain(name), P.info(id.model || 'no model')];
  const plainLeft = ['LAIN', name, id.model || 'no model'];
  let leftText = plainLeft.join('   ');
  let leftPaint = left.join(P.meta('   '));
  if (T.width(leftText) > w - (usage ? usage.length + 3 : 0)) {
    // The project name goes before the model does: you can be in the wrong
    // directory and recover, but sending a paragraph to the wrong model costs
    // money and a turn.
    leftText = [plainLeft[0], plainLeft[2]].join('   ');
    leftPaint = [left[0], left[2]].join(P.meta('   '));
  }
  const gap = Math.max(1, w - T.width(leftText) - (usage ? usage.length : 0));
  return [clip(leftPaint + ' '.repeat(gap) + (usage ? P.meta(usage) : ''), w)];
}

/**
 * `624` — THE OUTPUT TOKENS OF THE RESPONSE IN FRONT OF YOU.
 *
 * ------------------------------------------------------------------------
 * ONE NUMBER, AND IT IS THE ONE THAT MOVES.
 *
 * A context figure (`42k/128k`) stood here first. It is a genuinely useful
 * number and it is the WRONG number for a permanent row: it barely changes
 * within a turn, it is large enough to read as noise, and the question it
 * answers — "am I near a compaction" — is asked occasionally, which is what
 * `/token` is for.
 *
 * What a person watching a response wants is proof it is still coming, and how
 * much of it there has been. That number climbs while the model writes and
 * stops when it stops.
 *
 * ------------------------------------------------------------------------
 * `~` MEANS ESTIMATED, AND IT IS NOT DECORATION.
 *
 * No provider states output tokens until the response ends, so while one is
 * streaming this is characters over `CHARS_PER_TOKEN` — see ui/index.js
 * `noteOutputChars`. When the receipt lands, the same figure becomes the
 * provider's own count and the tilde goes. A screen that showed both the same
 * way would be reporting a guess as a measurement, which is the exact failure
 * ui/tokenview.js exists to prevent.
 *
 * `0` at the start of a session is a fact, not a placeholder: nothing has been
 * produced yet.
 */
/**
 * THE HORIZONTAL FRAME lives in ui/frame.js — see its header for why it is its own
 * module. Re-exported here so every caller keeps one import.
 */
const { contentBounds, proseWidth, GUTTER_MAX, PROSE_SOFT } = require('./frame');

function outputLabel(output) {
  if (!output) return '0';
  const n = Math.max(0, Math.round(Number(output.tokens) || 0));
  return output.measured ? String(n) : `~${n}`;
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
function planView({ plan, expanded = new Set(), width = 80, cursor = -1, evidence = null, detail = false }) {
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
  // ---- THE COUNT RIDES ON THE HEADING ---------------------------------
  //
  // `1/2 done` is the plainest of the three ways this view states progress —
  // plainer than `STEP 2/2`, which is a POSITION, and plainer than `50%`,
  // which is the same fact needing arithmetic. It was the heading of the old
  // `/plan show` (`Plan  1/2 done`) and the pane never had it; when the
  // command started rendering the pane, it was the one thing that would have
  // been lost in the move.
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const total = plan.steps.filter((s) => s.status !== 'dropped').length;
  lines.push(P.head('PLAN') + P.meta(`  ${done}/${total} done`));
  lines.push('');

  const visible = plan.steps.filter((s) => s.status !== 'dropped');
  const shownDone = visible.filter((s) => s.status === 'done').slice(-PLAN_DONE_ROWS);
  const shown = new Set(shownDone.map((s) => s.n));
  const olderDone = visible.filter((s) => s.status === 'done').length - shownDone.length;
  if (olderDone > 0) {
    lines.push(`  ✓ ${olderDone} earlier completed step(s)`);
    lines.push('');
  }
  for (const s of visible) {
    if (s.status === 'done' && !shown.has(s.n)) continue;
    if (s.status === 'dropped') continue;
    // ---- WHAT `detail` IS FOR, AND WHY `/plan` PASSES IT ----------------
    //
    // Expansion used to be a GESTURE: the PLAN pane had a step picker, Enter
    // opened one, and the Why / Files / Status underneath were reachable that
    // way and only that way. There is no pane and no picker, so `expanded` is
    // always empty from every real caller — which would have made every one of
    // those rows dead code and silently dropped a completed step's NOTE, the
    // evidence of what was actually done.
    //
    // `/plan` is a document you read rather than a list you navigate, so it
    // asks for the detail WHERE THERE IS ANY: a step that carries a note or
    // files is opened, a bare `todo` stays one line. Nothing is hidden behind a
    // keystroke that no longer exists, and a long plan of untouched steps is
    // still a short list.
    const open = expanded.has(s.n)
      || (detail && (Boolean(s.note) || (Array.isArray(s.files) && s.files.length)));
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
const { inputViewport, lineCount, wrapInput, caretRow } = require('./viewport');

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
 * ------------------------------------------------------------------------
 * IT TOOK A `cursor` UNTIL NOW, and the parameter is gone with what it chose.
 *
 * The report offered two rows — `❯ diff` and `❯ keep working` — with Up and Down
 * moving the highlight, and before that they were `[D]` and `[R]`: printable
 * letters a screen showing plain text could never make live, which is the
 * failure the arrow navigation replaced.
 *
 * With ONE surface there is nowhere for `diff` to go, so both rows meant "put
 * this away" and the choice was not a choice. The report names `/changes` now —
 * a command that exists, typed when somebody wants it — and every key dismisses
 * the report (ui/keys.js). A menu row is something you have to deal with before
 * you can carry on; a named command is not.
 */
function completion({ session, checkpoints, cwd, verification = [], width = 80 }) {
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
  // ---- ONE WAY OUT, BECAUSE THERE IS ONE SURFACE ------------------------
  //
  // This offered a CHOICE — `❯ diff` or `❯ keep working` — and the first of
  // them navigated to a pane. With one surface there is nowhere to navigate
  // to, so the choice is not a choice: dismissing the report is all either
  // branch could mean, and what changed is `/changes` away.
  //
  // Named rather than offered as a highlighted row, because a command is
  // something you type when you want it and a menu row is something you have
  // to dispose of before you can carry on.
  lines.push('');
  lines.push(P.meta('/changes — what changed · /verify — prove it · Esc — carry on'));
  return lines;
}

// ------------------------------------------------------------------------
// `tabsLine` STOOD HERE — the numbered strip `[1 activity] 2 context 3 plan…`.
//
// It was the visible half of the pane machinery: nine labels, a bracketed
// active one, and a right-hand slot carrying the scroll hint. The labels went
// with the panes. The scroll hint did not — it is the one thing that strip
// said which no other region could, because it is NEWS about content the user
// has not seen — so it moved to the rule under the header (ui/layout.js
// `separator`), which is the boundary of the region that content is in.
// ------------------------------------------------------------------------

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
  viewportState, scrollHint,
  MARK, phrase, verbOf,
  STATE, statusOf, progressOf, livePlan, bar, progressCompact, clip, pad, shortPath, projectName,
  contentBounds, proseWidth, GUTTER_MAX, PROSE_SOFT,
  header, activity, planView, completion, phrase, center, paintStatus,
  inputViewport, lineCount, wrapInput, caretRow, renderFeed, wrap, MARK,
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
