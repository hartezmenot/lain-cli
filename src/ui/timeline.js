'use strict';

/**
 * DRAWING THE TIMELINE — the label, the target under it, the compact history.
 *
 * ui/playback.js decides WHAT state each activity is in; this decides what that
 * looks like. They are split for the reason every other seam in ui/ is split:
 * the state machine is arithmetic over a clock and is tested by moving the
 * clock, while this is words and box characters and is tested by reading rows.
 *
 * ------------------------------------------------------------------------
 * THE UNIT IS THE LABEL PLUS ITS TARGET, and it is TWO ROWS:
 *
 *     reading
 *       python.js
 *
 * The label says what LAIN is DOING; the line under it, indented and subdued,
 * says what it is doing it TO. There is no generic "action" row — the verb IS
 * the label, and it comes from the tool that ran (ui/playback.js VERB).
 *
 * ------------------------------------------------------------------------
 * IT USED TO BE A BOX, AND THE BOX WAS THE DEFECT.
 *
 *     reading
 *
 *     ┌──────────────────────────────┐
 *     │ python.js                    │
 *     └──────────────────────────────┘
 *
 * Five rows and fifty-two columns to say `python.js`. Watched on a real screen
 * that is not a quotation, it is a CARD — a separate object with a border round
 * it, competing with the diff window below it and with the model's prose above
 * it for the same eye. Three reads in a row and the pane is nothing but frames.
 *
 * The relationship being drawn is possessive, not containing: WHAT IS HAPPENING
 * over WHAT IT IS HAPPENING TO. Indentation says that in two rows, and it says
 * it in monochrome, at forty columns, and next to a diff window that genuinely
 * does need a border to be told apart from the terminal.
 *
 * A patch carries its counters on the target row, where they climb while the
 * edit is active and land on the real numbers:
 *
 *     patching
 *       router.js   ▲+72 -40
 *
 * ------------------------------------------------------------------------
 * AND THEN IT GETS OUT OF THE WAY. A finished activity is one quiet line:
 *
 *     read  python.js
 *     edit  python.js   +72 -40
 *
 * That is the whole compactness argument. The live operation is the only thing
 * spending two rows, so a long task does not become a wall — it becomes a short
 * list with one live item at the end of it.
 */

const T = require('./text');
const { P } = require('./paint');
const { PHASE } = require('./playback');

/** How wide the target line may be, however wide the pane. */
const MAX_TARGET = 52;
/** The target sits under its verb, and the indent is what says "of this". */
const TARGET_INDENT = '    ';
/** How many finished activities stay visible. Older ones are still in the record. */
const MAX_HISTORY = 40;

/**
 * `+72 -40`, coloured semantically, or '' when this is not an edit.
 *
 * ------------------------------------------------------------------------
 * THE NUMBER ITSELF MOVES, and in a terminal that is spelled with a MARKER
 * rather than with a tween: there is no sub-cell position to animate a digit
 * through, so `+68` becoming `+69` can only ever be a replacement.
 *
 * What can be shown is the DIRECTION, at the instant it is true. While the
 * editor is writing replacement lines the addition count is climbing, and it is
 * drawn `▲+69`; while it is striking old lines the removal count is climbing,
 * and that one is drawn `▼-37`. The marker is derived from the stage the diff
 * window is actually in (ui/diffreel.js), so it cannot appear when nothing is
 * moving and cannot point the wrong way.
 *
 * `dir` is 'add', 'remove', or `null` for a live card where nothing is moving
 * this instant. OMITTING it entirely is the compact-history form, which
 * reserves no room for a marker at all — a settled row is not going to move,
 * and two spaces held open for a glyph that can never appear is just a gap.
 */
function counts(added, removed, dir) {
  if (!added && !removed) return '';
  const live = dir !== undefined;
  const up = !live ? '' : dir === 'add' ? '▲' : ' ';
  const down = !live ? '' : dir === 'remove' ? '▼' : ' ';
  return P.ok(`${up}+${added}`) + ' ' + P.bad(`${down}-${removed}`);
}

/**
 * The ENTER and EXIT motion, in a terminal.
 *
 * There is no opacity here, so a fade is spelled as a change of WEIGHT: an
 * activity arrives dim, is drawn bright while it is the live one, and goes dim
 * again on its way out. Combined with the target arriving a frame after its
 * verb and the pair collapsing to one compact line afterwards, that reads as
 * something moving through the position rather than a row being overwritten.
 */
function tone(phase) {
  if (phase === PHASE.ENTER || phase === PHASE.EXIT) return P.meta;
  return P.plain;
}

/**
 * The active activity, as rows.
 *
 * Returns [] when nothing is active, which is the ordinary state between
 * operations and while the model is thinking.
 */
function activeRows(active, width) {
  if (!active) return [];
  const room = Math.max(12, Math.min(MAX_TARGET, width - TARGET_INDENT.length - 2));
  const paint = tone(active.phase);
  const rows = [];

  // ---- THE ONE THAT IS LEAVING, ABOVE THE ONE THAT IS ARRIVING -----------
  //
  // The live position used to be REPLACED: one operation's rows became the
  // next one's between two frames, with nothing in between. Read at speed that
  // is a flicker — the target appears to vanish rather than to go anywhere,
  // which is the "magician effect" this presentation is meant not to have.
  //
  // So for the length of the ENTER phase the operation that just finished is
  // still drawn, one row up, in the dim compact form it is on its way to. The
  // eye sees it MOVE UP AND FADE while the new one comes in underneath.
  //
  // IT IS TRANSIENT, and that is what keeps it from being a second copy of the
  // history the feed already carries: it exists only during ENTER, and only for
  // the immediately preceding operation.
  if (active.phase === PHASE.ENTER && active.leaving) {
    // Already dim in its own right — `historyRow` paints the compact form, and
    // wrapping it in another dim would only be closed by its first inner reset.
    rows.push(historyRow(active.leaving, width));
  }

  // THE VERB, at the margin. It is what is happening, and it is the loud half.
  rows.push('  ' + paint(active.verb));

  const c = active.isEdit ? counts(active.added, active.removed, active.dir || null) : '';
  // NOT EVERY OPERATION HAS A SUBJECT. `plan_write` and `ask_user` act on the
  // task rather than on a file, and a blank line says less than the tool's own
  // name would. That name is the honest answer to "what is this doing it to".
  const subject = String(active.target || '') || String(active.name || '');
  // ---- THE SUBJECT MATERIALISES; IT DOES NOT APPEAR ---------------------
  //
  // It used to be blank for the whole of ENTER and then simply present on the
  // next frame. That is a teleport — small, but the same shape as the big one
  // the brief forbids, and at the one moment the eye is on the row.
  //
  // Now it resolves across ENTER by the same rule prose does (ui/reveal.js
  // `emerge`), so a new operation is SEEN TO ARRIVE under its verb. It is a
  // short phase and a short string, so the effect is a flicker of texture
  // rather than something to wait through — and the filename is settled and
  // readable for the whole of the phase that matters.
  const fit = T.clip(subject, room - (c ? T.width(c) + 3 : 0));
  const shown = active.phase === PHASE.ENTER
    ? require('./reveal').emerge(fit, active.enter == null ? 1 : active.enter, active.tick || 0)
    : fit;

  // SUBDUED, ALWAYS. The relationship is `WHAT IS HAPPENING` over `WHAT IT IS
  // HAPPENING TO`, and the second one is support: it is read after the verb,
  // not instead of it. `tone` still dims the whole unit on the way in and out,
  // and `P.meta` inside a dim paint is closed by its own reset either way.
  rows.push(TARGET_INDENT + P.meta(shown) + (c && shown ? '   ' + c : ''));
  return rows;
}

/**
 * HOW FAR BACK A FINISHED ROW IS, AS A WEIGHT.
 *
 * ------------------------------------------------------------------------
 * IT WAS ONE WEIGHT FOR EVERYTHING, and the audit measured it: every completed
 * row carried the identical SGR `2`, so a read from thirty seconds ago and one
 * that finished a moment before the current operation looked exactly alike.
 * With the live row that is TWO levels of hierarchy, where the design asks for
 * four — old recedes, older is quiet, recently completed is still warm, current
 * is strongest.
 *
 * THREE TIERS OF HISTORY, and no more, because a terminal has no opacity: each
 * step has to be a real, distinguishable weight rather than a point on a ramp.
 *
 *   SETTLING  the one that just finished. Still readable at full weight, so the
 *             eye can follow the operation it was watching as it leaves.
 *   RECENT    the handful behind it. `dim`, which is what everything used to be.
 *   OLD       past that. `faint` — a second real step down (SGR 244), which
 *             `dim` cannot express because dim is a flag rather than a scale.
 *
 * DEGRADES HONESTLY. A terminal without 256 colours renders `faint` as its
 * nearest grey, so the worst case is two tiers looking alike — which is exactly
 * where this started, and never louder than intended.
 */
const SETTLING = 1;
const RECENT = 4;

function toneFor(indexFromEnd) {
  if (indexFromEnd < SETTLING) return { text: P.plain, quiet: P.meta };
  if (indexFromEnd < RECENT) return { text: P.meta, quiet: P.meta };
  return { text: P.faint, quiet: P.faint };
}

/**
 * One finished activity, as the single quiet line it leaves behind.
 *
 * `age` is how many rows back from the newest finished one this is; it decides
 * the weight. Absent, it is drawn at the old flat `dim` — which keeps every
 * existing caller (and the `leaving` transition row) behaving exactly as before.
 */
function historyRow(h, width, age = RECENT) {
  const tone = toneFor(age);
  const mark = h.ok === false ? P.bad('✗') : tone.quiet('·');
  const verb = tone.text(T.pad(h.verb, 8));
  const room = Math.max(10, width - 16);
  const target = tone.quiet(T.clip(String(h.target || ''), room));
  const c = h.isEdit && (h.added || h.removed) ? '   ' + counts(h.added, h.removed) : '';
  return `  ${mark} ${verb} ${target}${c}`;
}

/**
 * The whole timeline: quiet history, then the live operation.
 *
 * `state` is what ui/playback.js `at()` returned. Nothing here reads a clock —
 * the moment has already been decided.
 */
function rows(state, width = 80) {
  if (!state) return [];
  const out = [];
  let hist = (state.history || []).slice(-MAX_HISTORY);
  // ---- ONE ACTIVITY, ONE ROW, ALWAYS ------------------------------------
  //
  // THE DEFECT, captured from real frames. `playback.at()` advances the cursor
  // past an event — so it enters `history` — AND hands the same event back as
  // `active.leaving`, because the drawing layer wants to show it moving out of
  // the live position. Both were drawn:
  //
  //     r0 |  · read     alpha.js
  //     r1 |  · read     beta.js     <- history
  //     r2 |
  //     r3 |  · read     beta.js     <- leaving: THE SAME OPERATION AGAIN
  //     r4 |  reading
  //     r5 |    gamma.js
  //
  // Visible on every single transition, for the length of the ENTER phase.
  //
  // THE TRANSITION IS KEPT — that row is what stops the live position reading
  // as a flicker, and removing it would trade one defect for the one it was
  // written to fix. What goes is the DUPLICATE: while an event is being drawn
  // as `leaving`, it is not also drawn in the history list. It is in exactly
  // one place at a time, which is what a person watching it move expects.
  const leaving = state.active && state.active.leaving;
  if (leaving) {
    const last = hist[hist.length - 1];
    if (last && last.name === leaving.name && last.target === leaving.target) hist = hist.slice(0, -1);
  }
  // Newest finished row is age 0 and carries the most weight; the ones above it
  // recede. See `toneFor`.
  hist.forEach((h, i) => out.push(historyRow(h, width, hist.length - 1 - i)));
  const act = activeRows(state.active, width);
  if (act.length) {
    if (out.length) out.push('');
    for (const r of act) out.push(r);
  }
  return out;
}

/**
 * THE DIFF WINDOW, as rows — see ui/diffreel.js for its lifecycle.
 *
 * Additions and removals are given their semantic colour on a reading surface,
 * so the change is scannable at a glance while it is being revealed. The window
 * is drawn at whatever height the reel currently says, which is what makes it
 * open and close rather than appear.
 */
/** The caret the editor is writing at. Drawn only on the line being written. */
const CARET = '▌';

/**
 * ONE ROW OF THE EDITOR, painted for the state the reel says it is in.
 *
 * Four states, four meanings, and the colour is the whole of the explanation:
 *
 *   plain     code as it stands — neither going nor arriving
 *   struck    RED, with a rule through it. This is being taken out.
 *   writing   LIGHT BLUE, with a caret. This is being typed right now.
 *   added     GREEN. This is the new code, settled.
 *
 * The middle two are the reason this is not an ordinary diff renderer: a static
 * diff has only "was" and "is", and the whole point of the window is the moment
 * in between, where the old line is visibly going and the new one is visibly
 * being written in its place.
 */
function editorRow(r, inner, tick = 0) {
  const no = P.meta(T.padStart(r.no ? String(r.no) : '', 4));
  if (r.state === 'gap') return no + ' ' + P.meta(T.pad(T.clip(r.text, inner - 5), inner - 5));
  const mark = r.kind === 'removed' ? '-' : r.kind === 'added' ? '+' : ' ';
  const room = inner - 7;
  // TABS ARE EXPANDED BEFORE ANYTHING MEASURES OR PAINTS THEM. A raw tab moves
  // the terminal's cursor instead of writing, so the cells it skips keep the
  // DEFAULT background — black holes punched through this window's surface,
  // seen on screen — and `width()` counts it as one cell while the terminal
  // advances up to eight, which tears the right-hand border. See ui/text.js.
  const body = T.clip(T.detab(String(r.text || '')), room);
  let painted;
  if (r.state === 'struck') painted = P.bad(mark + ' ' + P.struck(body));
  else if (r.state === 'striking') {
    // ---- THE PEN IS PART WAY ACROSS THIS LINE ---------------------------
    //
    // The rule runs through what has been crossed out and stops where the
    // strike has reached; the rest of the line still stands, in the red that
    // says it is going. Drawn as two spans rather than one so the boundary is
    // the actual position of the deletion rather than a whole-line switch.
    const cut = Math.max(0, Math.min(body.length, Number(r.cut) || 0));
    painted = P.bad(mark + ' ' + P.struck(body.slice(0, cut)) + body.slice(cut));
  }
  else if (r.state === 'writing') {
    // ---- THE CHARACTER UNDER THE CURSOR IS STILL RESOLVING ---------------
    //
    // A slice of the final text with a caret after it is a typewriter, and a
    // typewriter says "this was typed out for you". What is being shown is code
    // MATERIALISING — the same event prose gets — so the last few characters
    // wear the unsettled front prose wears, and settle behind the cursor.
    //
    // ONLY THE FRONT. Everything further back is the real line, already
    // readable, because the point of the window is to show WHAT the change is
    // and a permanently smudged line shows nothing.
    const edge = require('./reveal').emerge(body, 1 - Math.min(0.35, 6 / Math.max(6, body.length)), tick);
    painted = P.writing(mark + ' ' + edge + CARET);
  }
  else if (r.state === 'added') painted = P.ok(mark + ' ' + body);
  else if (r.state === 'blank') painted = P.meta(mark + ' ');
  else painted = P.plain(mark + ' ' + body);
  const used = 2 + T.width(body) + (r.state === 'writing' ? 1 : 0);
  return no + ' ' + painted + ' '.repeat(Math.max(0, room + 2 - used));
}

/**
 * THE DIFF WINDOW, as rows — see ui/diffreel.js for its lifecycle.
 *
 * ------------------------------------------------------------------------
 * IT IS A SURFACE, NOT A BORDER AROUND MORE TERMINAL.
 *
 * The first version drew box rules around the same black ground as everything
 * else, and the result read as text that happened to have a line near it. Every
 * row here — rules included, padding included — is painted on `P.editor`, a
 * light ground, so the window is a PANEL the change is performed on and the
 * eye finds it by shape before reading a character of it.
 *
 * That is also why `render.js onSurface` re-opens its background after every
 * inner reset: a row with one red word in it would otherwise lose the surface
 * from that word onwards.
 */
function diffRows(reel, width = 80) {
  if (!reel || !reel.open || reel.height <= 0) return [];
  const w = Math.min(Math.max(30, width - 4), 96);
  const inner = w - 4;
  const head = T.clip(String(reel.file || ''), Math.max(8, inner - 20));
  // WHERE IN THE CHANGE THIS IS — the hunk being performed, and the running
  // count. Both come from the reel, which derives them from the real script.
  const where = reel.hunks > 1 ? `${Math.min(reel.hunk + 1, reel.hunks)}/${reel.hunks}` : '';
  const tally = (reel.finalAdded || reel.finalRemoved)
    ? `+${reel.added} -${reel.removed}` : '';
  const right = [where, tally].filter(Boolean).join('  ');
  const fill = Math.max(1, w - 6 - T.width(head) - T.width(right));
  const out = [];
  out.push('  ' + P.editor('┌─ ' + head + ' ' + '─'.repeat(fill) + (right ? ' ' + right : '─') + '┐'));
  for (const r of reel.rows) {
    out.push('  ' + P.editor('│ ' + T.pad(editorRow(r, inner, reel.tick || 0), inner) + ' │'));
  }
  out.push('  ' + P.editor('└' + '─'.repeat(w - 2) + '┘'));
  return out;
}

module.exports = {
  rows, activeRows, historyRow, diffRows, editorRow, counts, tone,
  MAX_TARGET, MAX_HISTORY, CARET, TARGET_INDENT,
};
