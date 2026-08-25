'use strict';

/**
 * THE DIFF AS AN EDIT BEING PERFORMED — not as a document being scrolled.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS NOT A PANE.
 *
 * A permanent diff panel is a panel that is wrong most of the time: it shows
 * the last edit for ever, it takes rows from the work in progress, and after
 * the third edit nobody looks at it. The DIFF pane still exists for going and
 * reading a change deliberately (Alt+4). This is the other thing — the glance
 * you get for free the moment an edit lands, which then gets out of the way.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS NOT A SCROLLING REVEAL EITHER, which is what it used to be.
 *
 * The first version opened a window, revealed the diff a line at a time from
 * the top, and closed. That reads as a FILE BEING PRINTED. What actually
 * happened was a person operating an editor: they went to the change, stopped,
 * took the old code out, wrote the new code, and moved to the next one — and a
 * presentation that shows a list arriving communicates none of that.
 *
 * So the window is driven by the EDIT SCRIPT (ui/diffscript.js), which knows
 * where the changes are, and it plays each one:
 *
 *     SCROLL to the hunk  →  STOP  →  STRIKE the old lines red  →
 *     WRITE the new lines, character by character, in blue  →
 *     SETTLE them green  →  SCROLL to the next hunk
 *
 * The scroll is not a speed. It is a consequence: the viewport follows the row
 * currently being edited, so it moves when the editing moves and holds still
 * when the editing holds still. The last of one hunk's settling overlaps the
 * beginning of the next hunk's scroll, which is what stops it reading as a
 * sequence of separate animations.
 *
 * ------------------------------------------------------------------------
 * IT HAS NO CLOCK, AND NO QUEUE. THAT IS THE POINT.
 *
 * It used to own both, and that is what produced the defect this file's whole
 * design exists to prevent — seen on a real screen:
 *
 *     reading
 *       python.js
 *
 *     ┌─ router.js ─────────────────────────────────────┐
 *
 * The label naming one file and the window under it travelling down another.
 * The cause was not a drawing bug. There were TWO playheads: a queue here,
 * advancing on its own `startedAt` with its own catch-up multiplier, and the
 * timeline's queue in ui/playback.js advancing on ITS own. Two clocks over two
 * orderings of the same operations come apart the moment either one is behind,
 * and then the two halves of one surface disagree about what is happening.
 *
 * Suppressing the mismatched frame hides the symptom and keeps the cause. So
 * the ownership moved instead: A WINDOW BELONGS TO A TIMELINE EVENT. It is
 * built here, attached to the event that produced it (ui/activity.js), and the
 * playhead that decides which event is on screen is the same playhead that
 * decides how far into its window we are. There is one identity, one order and
 * one catch-up rule, and a card can no longer name a file its window does not.
 *
 * ------------------------------------------------------------------------
 * THE LOAD-BEARING RULE, now literal: `frame(item, t)` is a PURE FUNCTION of
 * the change and the plan-time reached. It reads no clock, holds no state, and
 * schedules nothing; the caller says when. `instant` never calls it at all, and
 * the edit that produced it is unaffected either way — the file on disk, the
 * checkpoint and the compact history line are identical.
 *
 * AND IT NEVER CLAIMS MORE THAN THE SCRIPT SAYS. The counters it reports are
 * the script's own counts reached progressively; they cannot exceed them, and
 * a partial edit animates as the partial edit it is.
 */

const script = require('./diffscript');
const { SCRAMBLE_MS } = require('./reveal');

/** How long the window takes to open, and to close again. */
const OPEN_MS = 180;
const CLOSE_MS = 200;
/** Moving to a change: a floor, a cost per row travelled, and a ceiling. */
const SCROLL_MIN = 90;
const SCROLL_PER_ROW = 14;
const SCROLL_MAX = 380;
/** Marking the old code: per line, with a floor so one line is still seen. */
const STRIKE_PER_LINE = 55;
const STRIKE_MIN = 120;
/** Writing the new code. Characters per second, with a floor per hunk. */
const WRITE_CPS = 340;
const WRITE_MIN = 150;
/** The pause on a finished hunk before the viewport moves on. */
const HUNK_SETTLE = 220;
/** The pause on the finished diff before the window closes. */
const FINAL_SETTLE = 420;
/** Rows the window may occupy. A diff is a glance, not a document. */
const MAX_ROWS = 14;
/**
 * Total editing time is capped, so a 400-line refactor does not play for a
 * minute. Past this every phase is scaled down by one factor — the SHAPE of the
 * performance is preserved (it still stops at each change), it is simply
 * performed faster. Nothing is skipped and no count changes.
 */
const MAX_REEL_MS = 5200;
/**
 * THERE IS NO QUEUE HERE ANY MORE, and its absence is the fix.
 *
 * A refactor lands as several edits within a second of each other, so the
 * windows have to be ordered and they have to catch up. This file used to do
 * both, with `MAX_QUEUE`, `QUEUE_MAX_SPEED` and a `startedAt` of its own — a
 * second queue over the same operations, running on a second clock.
 *
 * Ordering, bounding and catch-up now happen once, in ui/playback.js, because a
 * window belongs to the timeline event that produced it. `MAX_EVENTS` bounds
 * them, the playhead orders them, and `speed()` — driven by presentation debt —
 * is the one multiplier. Nothing is skipped; each window simply gets less time
 * when the timeline is behind, which is exactly what the old constants bought,
 * from the one place that can also keep the card above in step.
 */

const STAGE = Object.freeze({
  OPENING: 'OPENING',
  SCROLL: 'SCROLL',
  STRIKE: 'STRIKE',
  WRITE: 'WRITE',
  /** A READ: the code is already there and the window moves down it. */
  READING: 'READING',
  SETTLE: 'SETTLE',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
});

/**
 * READING IS NOT EDITING, AND IT MUST NOT LOOK LIKE IT.
 *
 * ------------------------------------------------------------------------
 * The edit performance exists because an edit is something HAPPENING: the old
 * line is going, the new one is being written, and the point of striking it
 * through and typing the replacement is that the file is genuinely changing
 * under the reader.
 *
 * A READ changes nothing. The code was already on disk before LAIN looked at
 * it, and animating it as though it were being written says the opposite of
 * what happened — it is the presentation layer inventing an event. So a read
 * gets the same surface and none of the performance: the content is there from
 * the first frame, in one neutral weight, and the window simply travels down
 * it at a readable pace. What is being animated is the LOOKING, which is the
 * only thing that actually occurred.
 *
 * No strike, no caret, no counters, no green — those all mean "this changed".
 */
/** How long the window dwells on each row it scrolls past. */
const READ_PER_ROW = 55;
/** A short read still gets long enough to register as a read. */
const READ_MIN = 600;
/**
 * However long the file, the look through it is bounded.
 *
 * ------------------------------------------------------------------------
 * A READ IS A GLANCE, AND THIS WAS A TOUR. At 4200 a single read spent four and
 * a quarter seconds travelling sixty rows, and the card above it was held open
 * for all of it (ui/activity.js `_linger`). Watched at the end of a real turn:
 * the model's summary was on screen, the status said READY, and underneath both
 * the timeline was still reading a file from the beginning of the turn — for
 * fifteen seconds, almost all of it these two windows.
 *
 * A read window is not the star of the presentation; the PATCH window is (see
 * the brief's flow: two rows for a read, a window for the change). It is here to
 * say "this file is being looked at", which a couple of seconds says as well as
 * four does — and the difference is the whole of a tail that outlived the answer
 * it belonged to.
 */
const READ_MAX = 2400;
/**
 * Rows of a file the window will travel through.
 *
 * The edit script's own bound is six hundred, which is right for a document you
 * can stop at each change of. A read has no stops — it is one continuous
 * movement inside a fixed time budget — so six hundred rows would be a blur
 * rather than a look. This is a glance through the head of the file, and it
 * says how much it did not show.
 *
 * CUT WITH THE BUDGET ABOVE. Sixty rows inside a shorter budget is the blur
 * this constant exists to prevent; the pace per row is what makes it a look, so
 * the distance travelled comes down with the time available.
 */
const READ_ROWS = 32;

/** Ease-in-out, so the viewport starts and stops rather than jumping. */
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

/**
 * BUILD A CHANGE'S WINDOW — the item a timeline event carries.
 *
 * TWO SHAPES OF CALLER, one meaning. `build(file, before, after)` is the real
 * one and is what ui/activity.js passes, because the edit script has to be
 * computed from the two texts. `build(file, ['+ a', '- b'])` — an array of
 * already-rendered diff rows — is accepted so a caller that only has the
 * rendered form still gets a window; it produces one hunk, which is all that
 * form can honestly support.
 *
 * A SCRIPT WITH NO HUNKS IS NOT A CHANGE, and gets no window. An unchanged file
 * still produces rows — one saying how many lines were skipped — and opening a
 * window to perform nothing on them would be the presentation claiming an edit
 * that did not happen. A tool that reported success while changing nothing gets
 * no window, which is itself worth noticing.
 *
 * @returns {object|null} the item, or null when there is nothing to perform
 */
function build(file, before, after) {
  const s = Array.isArray(before) ? fromRows(before) : script.build(before, after);
  if (!s.rows.length || !s.hunks.length) return null;
  return { file: String(file || ''), reading: false, script: s, plan: planOf(s) };
}

/**
 * LOOK THROUGH A FILE — the code is already there; the window travels down it.
 *
 * The same item shape and the same surface as a change, so a session reads as
 * one sequence rather than two unrelated effects. What it does NOT share is the
 * performance: see READ_PER_ROW above for why a read must not be animated as
 * though the file were being written.
 *
 * `text` is the content that was actually read. Bounded, because a window is a
 * glance and a 4,000-line file is not one.
 */
function buildRead(file, text) {
  const lines = script.lines(text);
  if (!lines || !lines.length) return null;
  // ---- ONE GUTTER, AND IT IS THE FILE'S OWN LINE NUMBERS ----------------
  //
  // `read_file` returns its result already numbered — `  1990	def …` — and
  // the window was adding a second gutter of its own beside it, so a read of
  // lines 1990-1993 drew `1 1990`, `2 1991`, `3 1992`: two numberings, one of
  // them meaningless, side by side.
  //
  // The number in the text is the TRUE one, and it is the one somebody would
  // use to go and look. So it is lifted out of the content into the gutter,
  // and the synthetic index is used only when the content carries none.
  const rows = lines.slice(0, READ_ROWS).map((t, i) => {
    const m = /^\s*(\d+)	(.*)$/.exec(t);
    return m
      ? { kind: 'context', text: m[2], hunk: -1, no: Number(m[1]) }
      : { kind: 'context', text: t, hunk: -1, no: i + 1 };
  });
  if (lines.length > READ_ROWS) {
    rows.push({ kind: 'gap', text: `⋯ ${lines.length - READ_ROWS} more lines`, hunk: -1, no: 0 });
  }
  return {
    file: String(file || ''),
    reading: true,
    script: { rows, hunks: [], added: 0, removed: 0, truncated: lines.length > READ_ROWS },
    plan: { hunks: [], total: clamp(rows.length * READ_PER_ROW, READ_MIN, READ_MAX) },
  };
}

/**
 * THE WHOLE PERFORMANCE, in milliseconds of plan time.
 *
 * This is what ui/activity.js reserves on the owning event, so the card above
 * the window is held open for exactly as long as the window below it takes.
 * Two halves of one surface, one duration, taken from one place.
 */
function planDuration(item) {
  if (!item) return 0;
  return OPEN_MS + item.plan.total + FINAL_SETTLE + CLOSE_MS;
}

/**
 * WHAT THE WINDOW LOOKS LIKE `t` MILLISECONDS INTO ITS OWN PERFORMANCE.
 *
 * PLAN TIME, NOT WALL TIME. The caller has already applied whatever catch-up
 * multiplier the timeline is running at (ui/playback.js), so every duration in
 * this file stays the one it was written as and only the mapping from real time
 * changes. That is also what makes this a pure function: the same `t` always
 * gives the same frame, so drawing a frame twice cannot advance anything.
 *
 * `height` is how far the window is open, in rows — that is the whole of the
 * opening and closing motion, and it is what makes the region grow and shrink
 * rather than blink into place. `rows` is what is currently written inside it,
 * each one carrying the STATE it is in so the drawing layer can colour it
 * without re-deriving anything.
 */
function frame(item, t) {
  if (!item || !item.script.rows.length) return closed();
  const elapsed = Math.max(0, Number(t) || 0);
  const total = planDuration(item);
  if (elapsed >= total) return closed();

  const view = Math.min(item.script.rows.length, MAX_ROWS);
  let height = view;
  let stage = STAGE.SETTLE;

  if (elapsed < OPEN_MS) {
    // ---- IT REALLY GROWS, and it was only claiming to -------------------
    //
    // `height` said how far open the window was and `rows` was empty, so the
    // DRAWING — which iterates `rows` — put out a top rule and a bottom rule
    // and nothing between them, for the whole opening, and then six rows of
    // content in one frame. The height was computed and never used. Caught by
    // measuring drawn rows across real captured frames: 0, then 6.
    //
    // ---- AND IT OPENS ONTO THE FILE AS IT STANDS ------------------------
    //
    // Not empty rows: the DOCUMENT, with nothing performed on it yet. `rowAt`
    // with a playhead before the first hunk already produces exactly that —
    // context and about-to-be-removed lines as ordinary code, not-yet-written
    // lines as blanks — so the window opens onto the file the way an editor
    // opens onto a file, and the change then happens to something the reader
    // has already seen. For a READ that is the whole content, in one neutral
    // weight, which is the honest thing to show for an operation that changes
    // nothing.
    const opening = Math.max(1, Math.round(view * (elapsed / OPEN_MS)));
    const pristine = {
      stage: STAGE.OPENING, hunk: -1, added: 0, removed: 0,
      focus: 0, struck: -1, written: -1, writing: 0, hunkRef: null,
    };
    return {
      open: true,
      stage: STAGE.OPENING,
      file: item.file,
      rows: item.script.rows.slice(0, opening).map((_, i) => rowAt(item, i, pristine)),
      height: opening,
      top: 0,
      added: 0,
      removed: 0,
      finalAdded: item.script.added,
      finalRemoved: item.script.removed,
      hunk: -1,
      hunks: item.plan.hunks.length,
      total: item.script.rows.length,
    };
  }

  const at = elapsed - OPEN_MS;
  if (at >= item.plan.total + FINAL_SETTLE) {
    stage = STAGE.CLOSING;
    const p = (at - item.plan.total - FINAL_SETTLE) / CLOSE_MS;
    height = Math.max(0, Math.round(view * (1 - p)));
  }

  const state = perform(item, Math.min(at, item.plan.total));
  if (stage !== STAGE.CLOSING) stage = state.stage;

  // ---- THE VIEWPORT FOLLOWS THE EDIT -----------------------------------
  //
  // Not a scroll speed: the focus row is wherever the editing currently is,
  // and the window is centred on it. It therefore moves while the editing
  // moves between hunks and holds still while a hunk is being performed,
  // which is the difference between "someone is working through this file"
  // and "a list is going past".
  const focus = state.focus;
  const top = clamp(Math.round(focus - (view - 1) / 2), 0,
    Math.max(0, item.script.rows.length - view));
  const rows = [];
  for (let i = top; i < Math.min(item.script.rows.length, top + view); i++) {
    rows.push(rowAt(item, i, state));
  }

  return {
    open: true,
    stage,
    file: item.file,
    rows: height > 0 ? rows.slice(0, Math.max(0, height)) : [],
    height,
    top,
    added: state.added,
    removed: state.removed,
    finalAdded: item.script.added,
    finalRemoved: item.script.removed,
    // Clamped for DISPLAY. `perform` runs the playhead one past the last hunk
    // when everything is done, which is what the row states need; "hunk 4 of 3"
    // is not what a person should read.
    hunk: Math.min(state.hunk, Math.max(0, item.plan.hunks.length - 1)),
    hunks: item.plan.hunks.length,
    total: item.script.rows.length,
    truncated: Boolean(item.script.truncated),
    // WHICH SCRAMBLE FRAME THIS IS, so the character currently being typed can
    // resolve out of an unsettled glyph the same way prose does (ui/reveal.js).
    // Derived from the plan time, so drawing a frame twice cannot advance it.
    tick: Math.floor(elapsed / SCRAMBLE_MS),
  };
}

function perform(item, t) {
  const rows = item.script.rows;

  // ---- A READ: TRAVEL, DO NOT EDIT --------------------------------------
  //
  // One phase and one moving value. The focus row walks the document from top
  // to bottom over the whole budget, eased at both ends so it starts and
  // stops rather than jumping, and every row stays in its one neutral state.
  // There is nothing to strike and nothing to write, because nothing changed.
  if (item.reading) {
    const span = Math.max(1, item.plan.total);
    const p = ease(clamp(t / span, 0, 1));
    return {
      stage: STAGE.READING,
      hunk: -1,
      added: 0,
      removed: 0,
      focus: p * Math.max(0, rows.length - 1),
      struck: -1,
      written: -1,
      writing: 0,
    };
  }

  let clock = 0;
  let added = 0;
  let removed = 0;
  let prevAnchor = 0;

  for (const h of item.plan.hunks) {
    // ---- SCROLL: from wherever we were to this change --------------------
    if (t < clock + h.scroll) {
      const p = h.scroll ? ease((t - clock) / h.scroll) : 1;
      return {
        stage: STAGE.SCROLL, hunk: h.index, added, removed,
        focus: prevAnchor + (h.at - prevAnchor) * p,
        struck: -1, written: -1, writing: 0,
      };
    }
    clock += h.scroll;

    // ---- STRIKE: the old code is crossed out, CHARACTER BY CHARACTER -----
    //
    // It used to advance a whole line at a time — `struck` was a count of
    // lines, and a line was either untouched or fully red. Three removed lines
    // were therefore three steps, and a single removed line was ONE: it went
    // from ordinary code to struck between two frames, which is a state change,
    // not a deletion being performed.
    //
    // The write phase has always been spent across CHARACTERS (below), and the
    // asymmetry was the whole of the defect: the new code was seen to be typed
    // and the old code was seen to blink. Both halves of a replacement now move
    // at the same grain, so a refactor reads as somebody selecting the old text,
    // striking it through, and writing over it.
    if (h.removedRows.length) {
      if (t < clock + h.strike) {
        const p = clamp((t - clock) / h.strike, 0, 1);
        const budget = p * (h.gone || h.removedRows.length);
        let seen = 0;
        let idx = h.removedRows.length - 1;
        let partial = 1;
        for (let k = 0; k < h.removedRows.length; k++) {
          const len = Math.max(1, rows[h.removedRows[k]].text.length);
          if (budget < seen + len) { idx = k; partial = (budget - seen) / len; break; }
          seen += len;
        }
        return {
          // The removal count is the lines FULLY crossed out. A line half
          // struck has not gone yet, and counting it would put the card ahead
          // of the change it is counting.
          stage: STAGE.STRIKE, hunk: h.index, added, removed: removed + idx,
          focus: h.removedRows[idx],
          struck: idx, striking: clamp(partial, 0, 1), written: -1, writing: 0, hunkRef: h,
        };
      }
      clock += h.strike;
    }
    removed += h.removedRows.length;

    // ---- WRITE: the replacement appears, character by character ----------
    if (h.addedRows.length) {
      if (t < clock + h.write) {
        const p = clamp((t - clock) / h.write, 0, 1);
        const chars = p * h.chars;
        let seen = 0;
        let idx = h.addedRows.length - 1;
        let partial = 1;
        for (let k = 0; k < h.addedRows.length; k++) {
          const len = Math.max(1, rows[h.addedRows[k]].text.length);
          if (chars < seen + len) { idx = k; partial = (chars - seen) / len; break; }
          seen += len;
        }
        return {
          stage: STAGE.WRITE, hunk: h.index, added: added + idx, removed,
          focus: h.addedRows[idx],
          struck: h.removedRows.length, written: idx, writing: clamp(partial, 0, 1), hunkRef: h,
        };
      }
      clock += h.write;
    }
    added += h.addedRows.length;

    // ---- SETTLE: the finished hunk, held ---------------------------------
    if (t < clock + h.settle) {
      return {
        stage: STAGE.SETTLE, hunk: h.index, added, removed,
        focus: h.last, struck: h.removedRows.length, written: h.addedRows.length, writing: 1, hunkRef: h,
      };
    }
    clock += h.settle;
    prevAnchor = h.last;
  }

  // EVERY HUNK PERFORMED. The playhead is past the last one — which is what
  // `_rowAt` needs to hear, or the final hunk would still read as pending.
  return {
    stage: STAGE.SETTLE, hunk: item.plan.hunks.length,
    // THE REAL TOTALS, which is only ever different from what was performed
    // when the document was truncated (ui/diffscript.js MAX_ROWS). Reporting
    // the performed count there would leave the card holding a number smaller
    // than the change that is actually on disk.
    added: item.script.added, removed: item.script.removed,
    focus: prevAnchor, struck: Infinity, written: Infinity, writing: 1,
  };
}

/** One document row, in the state the performance has it in. */
function rowAt(item, i, state) {
  const r = item.script.rows[i];
  if (r.kind === 'gap') return { text: r.text, kind: 'gap', state: 'gap', no: 0 };
  if (r.kind === 'context') return { text: r.text, kind: 'context', state: 'plain', no: r.no };

  // WHICH SIDE OF THE PLAYHEAD THIS ROW IS ON.
  //
  // `hunkRef` is what says the editor is INSIDE this hunk right now. Without
  // it, a hunk the viewport is still scrolling TOWARDS compares equal to the
  // playhead and would be drawn already edited — the change performed before
  // the window arrives at it, which is the one thing this window must never
  // show.
  const h = state.hunkRef && state.hunkRef.index === r.hunk ? state.hunkRef : null;
  const past = r.hunk < state.hunk;
  const future = !past && !h;

  if (r.kind === 'removed') {
    // Before its turn it is still ordinary code; from the moment the editor
    // reaches it, it is red and struck, and it stays that way — it is gone.
    if (future) return { text: r.text, kind: 'removed', state: 'plain', no: r.no };
    if (past) return { text: r.text, kind: 'removed', state: 'struck', no: r.no };
    const k = h.removedRows.indexOf(i);
    if (k < state.struck) return { text: r.text, kind: 'removed', state: 'struck', no: r.no };
    if (k > state.struck) return { text: r.text, kind: 'removed', state: 'plain', no: r.no };
    // THE LINE THE PEN IS ON. `cut` is how far across it the strike has got, so
    // the drawing can put the rule through the first part and leave the rest as
    // it still stands. See ui/timeline.js `editorRow`.
    const cut = Math.max(0, Math.round(r.text.length * (state.striking == null ? 1 : state.striking)));
    return { text: r.text, kind: 'removed', state: 'striking', cut, no: r.no };
  }

  // ADDED. An empty row until it is written, so the document does not reflow
  // under the reader while the change is being made.
  if (future) return { text: '', kind: 'added', state: 'blank', no: r.no };
  if (past) return { text: r.text, kind: 'added', state: 'added', no: r.no };
  const k = h.addedRows.indexOf(i);
  if (k < state.written) return { text: r.text, kind: 'added', state: 'added', no: r.no };
  if (k > state.written) return { text: '', kind: 'added', state: 'blank', no: r.no };
  const n = Math.max(0, Math.round(r.text.length * state.writing));
  return { text: r.text.slice(0, n), kind: 'added', state: 'writing', no: r.no };
}


/**
 * HOW LONG EACH HUNK TAKES, laid out once so the walk above is arithmetic.
 *
 * Scaled as a whole when the raw plan exceeds MAX_REEL_MS: every phase of every
 * hunk shrinks by one factor, so a large refactor is performed faster rather
 * than partly. The order, the count and the stops are unchanged.
 */
function planOf(s) {
  const hunks = [];
  let prev = 0;
  let total = 0;
  for (const h of s.hunks) {
    const removedRows = [];
    const addedRows = [];
    let chars = 0;
    // Characters ON THE WAY OUT. The strike is spent across them the same way
    // the write is spent across the characters arriving, so a long line takes
    // proportionally longer to cross out than a short one.
    let gone = 0;
    for (let i = 0; i < s.rows.length; i++) {
      const r = s.rows[i];
      if (r.hunk !== h.index) continue;
      if (r.kind === 'removed') { removedRows.push(i); gone += Math.max(1, r.text.length); }
      else if (r.kind === 'added') { addedRows.push(i); chars += Math.max(1, r.text.length); }
    }
    const dist = Math.abs(h.at - prev);
    const e = {
      index: h.index,
      at: h.at,
      last: h.last == null ? h.at : h.last,
      removedRows,
      addedRows,
      chars,
      gone,
      scroll: clamp(SCROLL_MIN + dist * SCROLL_PER_ROW, SCROLL_MIN, SCROLL_MAX),
      strike: removedRows.length ? Math.max(STRIKE_MIN, removedRows.length * STRIKE_PER_LINE) : 0,
      write: addedRows.length ? Math.max(WRITE_MIN, (chars / WRITE_CPS) * 1000) : 0,
      settle: HUNK_SETTLE,
    };
    total += e.scroll + e.strike + e.write + e.settle;
    prev = e.last;
    hunks.push(e);
  }
  if (total > MAX_REEL_MS && total > 0) {
    const k = MAX_REEL_MS / total;
    for (const e of hunks) {
      e.scroll *= k; e.strike *= k; e.write *= k; e.settle *= k;
    }
    total = MAX_REEL_MS;
  }
  return { hunks, total };
}

/**
 * A SCRIPT FROM ALREADY-RENDERED DIFF ROWS.
 *
 * The honest floor for a caller that has lost the two texts: the marker at the
 * head of each row still says added, removed or context, so the colours and the
 * counts are real. What it CANNOT recover is where the changes are relative to
 * each other, so it is one hunk — which is exactly what that input contains.
 */
function fromRows(list) {
  const rows = [];
  let added = 0;
  let removed = 0;
  for (const raw of (Array.isArray(list) ? list : []).slice(0, script.MAX_ROWS)) {
    const s = String(raw == null ? '' : raw);
    const m = /^(\s*\d*\s*)([+\- ])\s?(.*)$/.exec(s);
    const mark = m ? m[2] : (s.startsWith('+') ? '+' : s.startsWith('-') ? '-' : ' ');
    const text = m ? m[3] : s.replace(/^[+\- ]/, '');
    if (mark === '+') { rows.push({ kind: 'added', text, hunk: 0, no: rows.length + 1 }); added++; }
    else if (mark === '-') { rows.push({ kind: 'removed', text, hunk: 0, no: rows.length + 1 }); removed++; }
    else rows.push({ kind: 'context', text, hunk: -1, no: rows.length + 1 });
  }
  const first = rows.findIndex((r) => r.hunk === 0);
  const last = rows.reduce((acc, r, k) => (r.hunk === 0 ? k : acc), first);
  return {
    rows,
    hunks: first < 0 ? [] : [{ index: 0, at: first, last, added, removed }],
    added,
    removed,
    truncated: false,
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function closed() {
  return {
    open: false, stage: STAGE.CLOSED, file: '', rows: [], height: 0, top: 0,
    added: 0, removed: 0, finalAdded: 0, finalRemoved: 0, hunk: -1, hunks: 0, total: 0,
  };
}

module.exports = {
  build, buildRead, frame, planDuration, closed,
  STAGE, planOf, fromRows,
  OPEN_MS, CLOSE_MS, SCROLL_MIN, SCROLL_PER_ROW, SCROLL_MAX,
  STRIKE_PER_LINE, STRIKE_MIN, WRITE_CPS, WRITE_MIN,
  HUNK_SETTLE, FINAL_SETTLE, MAX_ROWS, MAX_REEL_MS, READ_ROWS, READ_PER_ROW, READ_MIN, READ_MAX,
};
