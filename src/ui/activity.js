'use strict';

/**
 * THE ACTIVITY SURFACE — the timeline, the diff window, and the clock they need.
 *
 * Split out of ui/index.js, which reached the god-object guard the moment this
 * arrived. The seam is a real one and it is the same one ui/story.js follows:
 * that file owns the SCREEN — panels, keys, regions, redraws — and this owns
 * one surface within it, complete with the state it animates from.
 *
 * WHAT IT IS MADE OF, and why it is three files rather than one:
 *
 *   ui/playback.js   the state machine. Arithmetic over a clock; tested by
 *                    moving the clock.
 *   ui/diffreel.js   the same, for the temporary diff window.
 *   ui/timeline.js   the DRAWING. Words and box characters; tested by reading
 *                    rows.
 *
 * This is the seam between them and the rest of the program: the UI hands it
 * real events, and asks it for rows.
 *
 * ------------------------------------------------------------------------
 * THE RULE THIS SURFACE IS BUILT AROUND, stated once more because everything
 * here depends on it: IT MAY BE BEHIND REALITY; IT MAY NOT CHANGE IT.
 *
 * Every method here is synchronous and returns immediately. None of them is
 * awaited by the turn loop, none of them holds work back, and `instant` — a
 * pipe, a test, animation turned off — collapses the whole surface to its final
 * state without changing a single fact it reports.
 */

/**
 * Redraw cadence while the timeline is animating.
 *
 * ------------------------------------------------------------------------
 * IT WAS 16, WHICH IS THE ONE NUMBER THAT DOES NOT WORK.
 *
 * 16ms was chosen as "60 frames a second" and it delivered THIRTY-TWO. That is
 * not a rounding error, and it was found by measuring rather than by reading:
 *
 *     setInterval( 4) -> 64.2 Hz  (15.6 ms actual)
 *     setInterval(12) -> 64.7 Hz  (15.4 ms actual)
 *     setInterval(16) -> 35.1 Hz  (28.5 ms actual)   <-- what LAIN was asking for
 *     setInterval(20) -> 32.2 Hz  (31.1 ms actual)
 *
 * The platform timer granularity here is 15.6ms. A request for 16 cannot be
 * served by the tick at 15.6 — it is 0.4ms early — so it waits for the NEXT
 * one at 31.2 and the cadence halves. Every value at or below the granularity
 * lands on the very next tick and gets the full 64Hz.
 *
 * So the request is 12: comfortably inside one tick, which is what actually
 * buys the frame rate the constant was named for. There is no point asking for
 * 4 — the timer cannot go faster than its granularity, and a smaller number
 * only makes the code claim something the platform will not do.
 *
 * THE REAL BUDGET IS STILL ONE TICK, about 15.6ms, and that is what
 * tests/unit/framebudget.test.js measures against. Composing and writing a
 * whole frame costs 0.07ms on a small session and 0.12ms on a four-hundred-turn
 * one — roughly a hundredfold headroom — so the doubled wake-up rate is
 * affordable for the same reasons it always was:
 *
 *   AN IDENTICAL FRAME IS NEVER WRITTEN. ui/layout.js compares the composed
 *     frame with the one on screen and writes nothing when they match, so the
 *     terminal cost of a still screen at 64Hz is a string compare.
 *   THE FEED IS NOT REBUILT PER FRAME. ui/panesource.js memoises the
 *     conversation on the state that produces it, so an animation frame walks
 *     the timeline and the diff window — tens of rows — rather than four
 *     hundred turns.
 *   THE CLOCK ONLY RUNS WHILE SOMETHING MOVES. `syncTicker` drops back to
 *     TICK_MS the moment nothing is animating.
 *
 * ON A PLATFORM WITH FINER TIMERS this simply runs at 1000/12 ≈ 83Hz, and the
 * suppression above means the frames that change nothing cost a compare. On a
 * COARSER one it degrades to whatever that platform's tick is — which is the
 * honest ceiling, and not something a constant here can raise.
 */
const FRAME_MS = 12;

/**
 * The most presentation time a patch card may be held open for its own window.
 *
 * The window itself is already capped (ui/diffreel.js MAX_REEL_MS); this is the
 * belt on top of it, so a pathological plan can never park the timeline.
 */
const MAX_LINGER_MS = 7000;

/** The ordinary settle an event gets anyway — see `_attach` for why it is here. */
const { SETTLE_MS } = require('./playback');

/**
 * PAST THIS MUCH PRESENTATION DEBT, AN OPERATION GETS ITS CARD AND NO WINDOW.
 *
 * ------------------------------------------------------------------------
 * THE CEILING THE SECOND QUEUE USED TO PROVIDE, put back on the one playhead.
 *
 * ui/diffreel.js had `MAX_QUEUE = 8` and dropped the oldest unstarted change
 * past it. That went with the queue, and without a replacement every event now
 * carries its window — so a burst of thirty reads was thirty windows, and the
 * presentation ran for thirty-three seconds after the work was over. Measured:
 *
 *      1 read   ->  3.5s     10 reads ->  13.6s
 *      3 reads  ->  6.7s     30 reads ->  33.5s
 *
 * Bounded, and converging, and far too long. The brief allows the presentation
 * to lag and asks in the same breath that it not accumulate unbounded debt.
 *
 * THE WINDOW IS THE PART THAT GOES, and that is the whole of the judgement: a
 * card is what says WHAT IS HAPPENING and costs about a second; a window is a
 * look at the file and costs several. When there is already more owed than a
 * person will sit through, the honest trade is to keep every operation visible
 * and stop performing them.
 *
 * NOTHING IS LOST BUT THE PERFORMANCE. The event still plays, still names its
 * file, still carries its counters; the edit, its compact line in the feed, the
 * checkpoint and the DIFF pane (Alt+4) are all untouched. It is the same trade
 * `MAX_QUEUE` made, made on the debt it is actually about rather than on a
 * count of queued items.
 *
 * ------------------------------------------------------------------------
 * TWELVE SECONDS, AND THE NUMBER WAS MEASURED RATHER THAN PICKED. The two
 * cases pull opposite ways and this is where they both come out right:
 *
 *                        6s          9s         12s         15s
 *     3 edits        1/3  5.5s   2/3  7.8s   3/3  8.4s   3/3  8.4s
 *     30 reads       2/30 14.1s  3/30 14.8s  4/30 15.4s  5/30 16.1s
 *
 * A REFACTOR IS THREE EDITS LANDING TOGETHER and all three have to be
 * performed — showing one and skipping the rest is the exact failure the queue
 * was built for in the first place. 12s is the first value that covers it.
 * Above 12s the edit case stops improving and only the flood gets longer,
 * which is the wrong side to spend on.
 */
const MAX_WINDOW_DEBT_MS = 12000;

class ActivitySurface {
  /**
   * @param {object} o
   *   instant  play everything at once — a pipe, a test, animation off.
   *   now      clock reading, injectable so tests are deterministic.
   */
  constructor({ instant = false, now = () => Date.now() } = {}) {
    const { Playback } = require('./playback');
    this.instant = Boolean(instant);
    this._now = now;
    // ONE PLAYHEAD, and it is this one. The diff window used to be a second
    // queue on a second clock (`this.reel`), which is what let a card and the
    // window under it name two different files. A window is now a property of
    // the event that produced it — see `showDiff` and ui/playback.js `window`.
    this.playback = new Playback({ instant: this.instant, now });
    /** Set by `drain` — the screen is going away, so nothing may still be moving. */
    this.drained = false;
  }

  /** A tool STARTED. Enqueued, never awaited. */
  begin(name, target) {
    if (!name) return null;
    return this.playback.enqueue({ name, target });
  }

  /**
   * A tool FINISHED. The real numbers land here — the counters have been
   * climbing towards them, and this is what they land ON.
   */
  end(action) {
    const a = action || {};
    return this.playback.complete({
      ok: a.ok !== false,
      note: a.note || '',
      name: a.name || '',
      added: Number(a.added) || 0,
      removed: Number(a.removed) || 0,
    });
  }

  /**
   * THE REAL LINE COUNTS FOR THE EDIT THAT JUST FINISHED.
   *
   * They arrive a moment after the tool result, because they are read from the
   * checkpoint rather than from anything the tool said — see turnevents.js.
   * Patching them onto the event the timeline is already holding is what lets
   * the counters climb towards the true number instead of towards zero.
   */
  counts(added, removed) {
    // THE MOST RECENTLY FINISHED EVENT — the one whose result these numbers
    // were read for. `events[last]` would be the next call when one has already
    // been enqueued behind this result, which is how counters end up on the
    // wrong card. See ui/playback.js `complete` for the same correction.
    const done = this.playback.events.filter((x) => x.done);
    const e = done[done.length - 1] || this.playback.events[this.playback.events.length - 1];
    if (!e) return null;
    e.added = Number(added) || 0;
    e.removed = Number(removed) || 0;
    e.isEdit = e.isEdit || Boolean(e.added || e.removed);
    return e;
  }

  /**
   * NOTHING IS RUNNING ANY MORE — release anything still held open.
   *
   * An enqueued activity holds the active position until its result arrives,
   * which is what lets a slow command be watched for as long as it really takes
   * (ui/playback.js `_hold`). The cost of that is a dangling event: a call that
   * is announced and then never produces a result — an error before dispatch, a
   * tool the turn abandons, an interrupt between the two — would hold the
   * timeline open for the rest of the session.
   *
   * `setRunning(null)` is the turn's own statement that nothing is in flight,
   * so it is the honest place to close them. Not a timeout: nothing here waits
   * a fixed period and then guesses.
   */
  settle() {
    let n = 0;
    for (const e of this.playback.events) {
      if (e.done) continue;
      e.done = true;
      e.tookMs = Math.max(0, this._now() - e.at);
      // WHEN IT FINISHED, which is what ends the ACTIVE phase — see
      // ui/playback.js `_hold`. Without it a released event has a `doneAt` of
      // zero, its hold computes as the floor, and the card it was holding open
      // leaves in one frame instead of settling.
      e.doneAt = this._now();
      n += 1;
    }
    return n;
  }

  /**
   * FINISH PLAYING, NOW — the screen is going away.
   *
   * Playback is deliberately behind reality, which is right while there is a
   * screen to watch it on. At teardown there is not: the last frame anybody
   * sees would otherwise be whatever the timeline happened to be mid-way
   * through, so a session could end on a half-entered card for an operation
   * that finished seconds earlier.
   *
   * Draining settles everything and moves the playhead to the end, leaving the
   * complete account and no live card. It changes only what is drawn — every
   * event is still there, in order.
   */
  drain() {
    this.settle();
    this.playback.cursor = this.playback.events.length;
    // ---- AND THE PROSE, WHICH IS ALSO STILL MOVING ----------------------
    //
    // A paragraph resolves from the moment it was said and keeps resolving
    // across the end of its turn (ui/conversation.js). At teardown there is no
    // next frame to finish it in, so the LAST thing on screen was a line of
    // unsettled glyphs — `░|=*#! +@▓` where the answer should be. A presentation
    // that eats the answer on the way out is worse than no presentation.
    //
    // Set here rather than by clearing a stamp, because the stamps belong to the
    // session and are written to disk: a resumed session must come back with its
    // prose settled and its record intact, and those are the same records.
    this.drained = true;
  }

  /**
   * An edit landed: perform its change once, as a temporary window.
   *
   * `before` and `after` are the two texts from the CHECKPOINT — the same
   * source the DIFF pane reads — because the window is driven by the real edit
   * script (ui/diffscript.js) and a list of rendered rows cannot say where the
   * changes are relative to each other. An array is still accepted, and still
   * produces a window; it can only ever be one hunk.
   */
  showDiff(file, before, after) {
    try {
      return this._attach(file, require('./diffreel').build(file, before, after));
    } catch { return false; }
  }

  /**
   * A READ: look through the file, on the same surface, without editing it.
   *
   * The card holds for as long as the window takes, exactly as an edit's does —
   * so `reading src/parser.js` is still the label above the window travelling
   * down src/parser.js, rather than the timeline moving on to the next call
   * while the file it named is still on screen.
   */
  showRead(file, text) {
    try {
      return this._attach(file, require('./diffreel').buildRead(file, text));
    } catch { return false; }
  }

  /**
   * GIVE THE WINDOW TO THE EVENT THAT PRODUCED IT — one operation, one identity.
   *
   * ------------------------------------------------------------------------
   * WHAT THIS REPLACES, and why the replacement is ownership rather than a
   * bigger guard.
   *
   * Watched on a real run: the card read `patching src/parser.js` while the
   * window below it was still striking and rewriting `src/serializer.js`; and
   * later, `reading python.js` over a window travelling down `router.js`. Two
   * halves of one surface naming two different files.
   *
   * The old shape was a queue here and a queue in ui/diffreel.js, each with its
   * own `startedAt` and its own catch-up multiplier. `linger` bought the card
   * the time its window needed, which keeps them together as long as both
   * clocks agree — and two clocks over two orderings of the same operations
   * stop agreeing the moment either one is behind. Widening the guard could
   * only ever hide the frame; it could not make the frame right.
   *
   * So the window becomes a PROPERTY OF THE EVENT. There is no second queue to
   * fall out of step with, the playhead that chooses the card is the playhead
   * that positions the window, and "which file is the window showing" has
   * exactly one answer: this event's.
   *
   * ------------------------------------------------------------------------
   * `linger` STILL EXISTS, and now it is arithmetic rather than a guess: the
   * event reserves exactly the plan time its window needs, so the card cannot
   * EXIT out from under a performance that has not finished. The window plays
   * from the end of ENTER (see ui/playback.js `windowMs`), so SETTLE has to
   * cover what is left of it after the ordinary settle.
   *
   * MATCHED ON THE SUBJECT AND ON NOT-YET-PLAYED. Searching from the end finds
   * the operation this window belongs to even when the same file is touched
   * twice; refusing an event the playhead has already passed means a window is
   * never attached to a card that has been and gone, which would be a window
   * nothing could ever draw.
   *
   * It is PRESENTATION TIME ONLY: the tool has already returned, the file on
   * disk is already changed, and the turn loop is already several calls on.
   */
  _attach(file, item) {
    if (!item) return false;
    // ---- ALREADY TOO FAR BEHIND TO PERFORM ANOTHER ONE -------------------
    //
    // See MAX_WINDOW_DEBT_MS. The operation still gets its card; what it does
    // not get is several more seconds of window on top of a queue that is
    // already longer than anybody will watch.
    if (this.playback.debtMs() > MAX_WINDOW_DEBT_MS) return false;
    const want = String(file || '');
    const events = this.playback.events;
    const reserve = Math.min(MAX_LINGER_MS,
      Math.max(0, require('./diffreel').planDuration(item) - SETTLE_MS));
    let fallback = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (String(e.target || '') !== want) continue;
      if (i < this.playback.cursor) { fallback = fallback || e; continue; }
      e.window = item;
      // The plan length, so ui/playback.js can ask "is the window still
      // performing?" without reaching for the renderer to find out.
      e.windowTotal = require('./diffreel').planDuration(item);
      e.linger = Math.max(e.linger || 0, reserve);
      return true;
    }
    // EVERY MATCHING EVENT HAS ALREADY BEEN PLAYED. That can only happen if the
    // result arrived after its own card left the screen, and there is nowhere
    // coherent to put the window — showing it under someone else's card is the
    // exact defect this method exists to make impossible. The edit itself, its
    // compact line in the feed, the checkpoint and the DIFF pane are untouched.
    return Boolean(fallback) && false;
  }

  /** A new task: an empty timeline and no window. */
  reset() {
    this.playback.reset();
    this.drained = false;
  }

  /**
   * ONE PARAGRAPH, AS IT STANDS THIS INSTANT — see ui/reveal.js.
   *
   * Routed through this object rather than called directly by the view so that
   * `instant` is honoured in ONE place: a pipe, a test and `--no-animation`
   * take the same path here as they do for the timeline and the diff window,
   * and the drawn CONTENT is identical either way.
   */
  reveal(text, at, now = this._now()) {
    if (this.instant || this.drained || !at) return String(text == null ? '' : text);
    try { return require('./reveal').resolve(text, at, now); } catch { return String(text == null ? '' : text); }
  }

  /** Is any prose still resolving? The redraw clock asks this. */
  revealing(entries, now = this._now()) {
    if (this.instant || this.drained) return false;
    try { return require('./reveal').pending(entries, now); } catch { return false; }
  }

  /** Is anything still playing? The redraw clock asks this. */
  busy(now = this._now()) {
    if (this.instant) return false;
    // THE WINDOW IS INSIDE THE EVENT'S SPAN, so one question covers both. It
    // used to need two, which is the same duplication that let them disagree.
    return this.playback.busy(now);
  }

  /**
   * THE WINDOW BELONGING TO THE OPERATION ON SCREEN, at this instant.
   *
   * There is nothing to choose between: the playhead named the event, the event
   * carries its window, and the same clock reading says how far into it we are.
   * A window for anything else cannot be produced here, which is what makes
   * "the card and the window name two different files" unreachable rather than
   * merely guarded against.
   */
  _window(state) {
    const a = state && state.active;
    if (!a || !a.window) return null;
    // ---- NOT UNTIL ITS SUBJECT HAS ARRIVED -------------------------------
    //
    // The window's plan time is zero for the whole of ENTER, and `frame` at
    // zero is an OPENING frame — one row high, with nothing in it. So the
    // window's rules were drawn UNDER A CARD WHOSE FILENAME WAS STILL
    // MATERIALISING: an empty box hanging below half a name, for the length of
    // the phase. Caught by walking real captured frames rather than by reading.
    //
    // The lifecycle the brief asks for is `patching / python.js`, a beat, THEN
    // the viewer. This is that beat.
    const { PHASE } = require('./playback');
    if (a.phase === PHASE.ENTER) return null;
    return require('./diffreel').frame(a.window, a.windowMs);
  }

  /**
   * THE ROWS, at this instant — quiet history, the live operation, and the diff
   * window under it when one is open.
   *
   * Pure with respect to time: called twice with one clock it returns the same
   * rows, so a frame drawn twice cannot advance the timeline.
   */
  rows(width = 80, now = this._now()) {
    const timeline = require('./timeline');
    const state = this.playback.at(now);
    const win = this._window(state);
    track(state, win);
    const out = timeline.rows(state, width);
    const reel = win ? timeline.diffRows(win, width) : [];
    if (reel.length) {
      if (out.length) out.push('');
      for (const r of reel) out.push(r);
    }
    return out;
  }

  /**
   * JUST THE LIVE POSITION — the active card and the diff window under it.
   *
   * WHY THE PANE ASKS FOR THIS AND NOT FOR `rows`. The ACTIVITY feed already
   * draws every finished call as one quiet line, which is the same compact form
   * the timeline's own history would take. Rendering both put each completed
   * operation on screen TWICE and, because the feed is windowed to the rows it
   * has, the duplicates pushed the model's prose off the top — so adding a
   * history nobody needed cost the conversation it was sitting above.
   *
   * The timeline keeps its full account (`rows`, and it is what the state
   * machine is tested through); the pane takes the half the feed cannot draw.
   */
  liveRows(width = 80, now = this._now()) {
    const timeline = require('./timeline');
    const state = this.playback.at(now);
    const win = this._window(state);
    track(state, win);
    const out = timeline.rows({ active: state.active, history: [] }, width);
    const reel = win ? timeline.diffRows(win, width) : [];
    if (reel.length) {
      if (out.length) out.push('');
      for (const r of reel) out.push(r);
    }
    return out;
  }
}

/**
 * THE PATCH CARD'S COUNTERS FOLLOW THE DIFF WINDOW, not a phase timer.
 *
 * The card used to interpolate `+0 → +72` across its own ACTIVE phase, which is
 * a plausible-looking number that corresponds to nothing: it reached +72 while
 * the window below it had performed two of six changes. The counters and the
 * thing they count were two independent animations of one fact.
 *
 * So while the window is open, the card reads ITS numbers — which are the real
 * script's counts reached progressively, hunk by hunk — and the arrow marker
 * says which of them is moving this instant. When no window is open (an edit
 * with nothing to show, animation off) the card keeps its own interpolation,
 * which still lands on the same real total.
 *
 * A MUTATION OF A FRESHLY BUILT OBJECT. `Playback.at` composes its result on
 * every call, so nothing is being written back into the state machine and
 * drawing a frame twice still cannot advance anything.
 */
function track(state, reel) {
  const a = state && state.active;
  if (!a || !a.isEdit || !reel || !reel.open) return state;
  if (!reel.finalAdded && !reel.finalRemoved) return state;
  // NO FILE CHECK, AND THERE CANNOT BE ONE TO MAKE. The window is the event's
  // own (ui/playback.js `window`), so `reel` here is this card's performance or
  // it is null — the mismatch this used to guard against is not reachable any
  // more, and a guard against an impossible state is a claim that it is
  // possible.
  a.added = reel.added;
  a.removed = reel.removed;
  a.dir = reel.stage === 'WRITE' ? 'add' : reel.stage === 'STRIKE' ? 'remove' : null;
  return state;
}

/** Redraw cadence while only a spinner or an elapsed count is changing. */
const TICK_MS = 250;

/**
 * THE REDRAW CLOCK, and it has two speeds.
 *
 * A spinner and an elapsed count need four frames a second; a timeline being
 * played back needs more than that to move smoothly. So the clock runs at
 * FRAME_MS while anything is animating and drops back to TICK_MS when the only
 * thing changing is a number.
 *
 * IT ALSO RUNS AFTER THE TURN. Playback is deliberately behind reality, so when
 * the work finishes there is usually still a timeline to finish showing and a
 * diff window to close. Stopping the clock the moment the phase cleared would
 * freeze the last few operations mid-animation — which is exactly the
 * "everything appeared at once and then stopped" behaviour this replaces.
 *
 * IT COSTS NOTHING WHEN NOTHING MOVES: an identical frame is never written
 * (ui/layout.js), so a faster clock over a still screen is a string compare.
 *
 * It lives here rather than in ui/index.js because this module is what decides
 * the fast speed and what knows whether anything is animating.
 */
/**
 * The prose of the most recent recorded turn, which may still be resolving.
 *
 * Only the LAST one: everything before it settled long ago, and `revealing`
 * would walk the whole session to be told so on every frame.
 */
function lastNarrationOf(ui) {
  const turns = (ui.app && ui.app.session && ui.app.session.turns) || [];
  const t = turns[turns.length - 1];
  return (t && Array.isArray(t.narration)) ? t.narration : [];
}

function syncTicker(ui) {
  // PROSE RESOLVING COUNTS AS ANIMATION. Without this the clock stops between
  // tool calls, which is exactly when a paragraph is being presented — it would
  // resolve only as far as the redraw that happened to start it and then freeze
  // half-scrambled until something else moved.
  //
  // AND IT DOES NOT STOP WHEN THE TURN DOES. `ui/story.js endTurn` clears the
  // live narration, so asking only about that stopped the clock at the exact
  // moment a closing paragraph was still resolving — the text froze mid-band
  // until the next keystroke. The last turn's own prose carries its stamp now
  // (src/turn.js), so it is asked about too and the presentation runs on
  // through the handover to its natural end.
  const revealing = ui.enabled && ui.activity && ui.story
    && (ui.activity.revealing(ui.story.narration)
      || ui.activity.revealing(lastNarrationOf(ui)));
  const animating = ui.enabled && ui.activity && (ui.activity.busy() || revealing);
  const working = Boolean(ui.phase || ui.interrupting || ui.waitingUntil);
  const wanted = ui.enabled && (working || animating);
  const want = animating ? FRAME_MS : TICK_MS;
  if (wanted && ui._tick && ui._tickMs !== want) {
    clearInterval(ui._tick);
    ui._tick = null;
  }
  if (wanted && !ui._tick) {
    ui._tickMs = want;
    ui._tick = setInterval(() => { syncTicker(ui); ui.refresh(); }, want);
    if (ui._tick.unref) ui._tick.unref();
  } else if (!wanted && ui._tick) {
    clearInterval(ui._tick);
    ui._tick = null;
    ui._tickMs = 0;
  }
}

module.exports = { ActivitySurface, syncTicker, FRAME_MS, TICK_MS, MAX_LINGER_MS };
