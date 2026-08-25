'use strict';

/**
 * THE ACTIVITY TIMELINE — a presentation-layer playback of what already happened.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS FOR.
 *
 * The feed used to be a LIST: every tool call appeared the instant it finished,
 * in full, and stayed there for ever. Thirty reads produced thirty permanent
 * rows, the screen filled with history, and nothing on it moved — so a session
 * that was working hard looked identical to one that had stopped, and the whole
 * account arrived at once when the turn ended.
 *
 * This makes the same events a TIMELINE. One operation is active at a time; it
 * enters, holds while it runs, settles when it finishes, leaves, and is left
 * behind as a single compact line. The active operation is where the eye goes;
 * everything before it is quiet history.
 *
 * ------------------------------------------------------------------------
 * IT IS ALLOWED TO BE BEHIND REALITY. IT IS NOT ALLOWED TO CHANGE IT.
 *
 * This is the load-bearing rule of the whole file.
 *
 *   THE AGENT NEVER WAITS. Nothing here is awaited by the turn loop, no timer
 *     in this file gates a tool call, and `enqueue` is a synchronous push that
 *     returns immediately. The model can be three operations ahead of what the
 *     screen is showing, and that is the intended behaviour rather than a
 *     tolerated one.
 *   NO TIMERS LIVE HERE. The whole state machine is a PURE FUNCTION of the
 *     events and a clock reading: `at(now)` computes what the screen should
 *     show at that instant. Nothing self-schedules, so playback cannot drift,
 *     cannot fire after teardown, and cannot leak a handle.
 *   TURNING IT OFF CHANGES NOTHING BUT THE PICTURE. `instant` collapses every
 *     duration to zero, so every event is immediately in its final compact
 *     state. That is the path a pipe, a test and a `--no-animation` run take,
 *     and the rendered CONTENT is the same either way.
 *
 * ------------------------------------------------------------------------
 * CATCHING UP, so lag stays bounded.
 *
 * A backlog is the normal case — a model doing real work emits calls far faster
 * than any readable animation. Played at a fixed speed, thirty instant reads
 * would take half a minute to show, and the screen would still be narrating the
 * beginning of a turn that had already finished.
 *
 * So the clock RUNS FASTER WHEN IT IS BEHIND: one queued event plays at full
 * length, and a deep queue plays at up to `MAX_SPEED`. It never skips an event
 * — the order and the count are exactly what happened — it only spends less
 * time on each. The user still sees every operation, and the timeline still
 * ends near where the work did.
 */

/**
 * How long each phase lasts at normal speed, in milliseconds.
 *
 * ------------------------------------------------------------------------
 * WHY THE HOLD IS AS LONG AS IT IS, and it was less than half this.
 *
 * The reported symptom was that a file being read "appears for a split second".
 * Both halves of the cause are here. `HOLD_MS` was 260 — near the floor of what
 * a person can read a path off at all — and `MAX_SPEED` was 6, so with a normal
 * backlog that 260 became 43 milliseconds: under three frames at 60Hz. The
 * quotation was on screen for less time than it takes to look at it.
 *
 * The hold is now long enough to READ the subject, and the catch-up ceiling is
 * low enough that a busy queue cannot take that back. A deep backlog still
 * drains — nothing is skipped, and the arithmetic below still ends the timeline
 * near where the work did — it simply does not do it by making each operation
 * imperceptible, which was catching up at the cost of the only thing the
 * catching up was for.
 */
const ENTER_MS = 140;
const HOLD_MS = 560;      // the floor: an instant tool is still READ, not glimpsed
const SETTLE_MS = 200;    // the finished state, counters landed
const EXIT_MS = 160;

/**
 * How much faster playback may run when it is behind.
 *
 * At 3.5 the floor above still spends about 300ms on an operation with a deep
 * queue behind it, which is a glance. At 6 it spent 43ms, which is a flicker.
 */
const MAX_SPEED = 3.5;
/** How often the unsettled glyphs change while a subject materialises. */
const { SCRAMBLE_MS } = require('./reveal');
/** Backlog at which MAX_SPEED is reached. Kept for callers that measure with it. */
const FULL_SPEED_AT = 12;

/**
 * HOW FAR BEHIND THE PRESENTATION IS ALLOWED TO GET, in milliseconds.
 *
 * ------------------------------------------------------------------------
 * WHY LAG IS MEASURED IN TIME AND NOT IN EVENTS, and it was events.
 *
 * SEEN ON A REAL SCREEN, at the end of a real turn. The work was finished, the
 * status said READY, the model's summary was drawn — and underneath it the
 * timeline was still saying `reading router.js`, with the file's own window
 * open, for FIFTEEN SECONDS. Every invariant this file states was intact: it
 * skipped nothing, it was in order, and it did converge. It simply took so long
 * about it that the last thing on the screen after the answer was a read from
 * the beginning of the turn.
 *
 * The cause was the meaning of "behind". `backlog` counts EVENTS, and two
 * events is a shallow queue by that measure — so the catch-up barely engaged.
 * But those two events carried a `linger` apiece for the windows underneath
 * them, and two shallow events were fourteen seconds of debt. A queue depth
 * cannot see that, because the cost of an event is not one event.
 *
 * So the multiplier is driven by the DEBT: the wall-clock time still owed to
 * everything not yet played. That is the number the convergence promise is
 * actually about, it is the number a viewer experiences, and it counts a long
 * window and a long command for what they really cost.
 *
 * THE CEILING DOES NOT MOVE, and that is the other half of the fix. `MAX_SPEED`
 * exists because §9 of the brief is not negotiable: an operation nobody can
 * read defeats the whole surface. Measuring the lag correctly is what lets the
 * catch-up ENGAGE when it is genuinely needed; it is not licence to make a call
 * imperceptible. Forty instant reads still take forty readable turns to play,
 * exactly as before — what changed is that two reads holding two long windows
 * are now correctly seen as fourteen seconds of debt rather than as a shallow
 * queue.
 *
 * NOTHING IS SKIPPED. The count and the order are exactly what happened; only
 * the time spent on each changes. And none of it touches execution: this is a
 * divisor on a presentation clock.
 */
const TARGET_LAG_MS = 1800;
/** Debt at which `MAX_SPEED` is reached. */
const FULL_LAG_MS = 12000;

/** Bounded, like every other feed in the program. */
const MAX_EVENTS = 400;

/** The phases one activity passes through, in order. */
const PHASE = Object.freeze({
  QUEUED: 'QUEUED',
  ENTER: 'ENTER',
  ACTIVE: 'ACTIVE',
  SETTLE: 'SETTLE',
  EXIT: 'EXIT',
  COMPACT: 'COMPACT',
});

/**
 * THE LABEL ABOVE THE QUOTATION — the verb, and nothing else.
 *
 * There is no "action" row and no generic word: the label says what LAIN is
 * doing and the box below says what it is doing it to. `reading` over
 * `python.js` is the whole unit, and the two are never separated.
 */
const VERB = {
  read_file: 'reading',
  list_dir: 'reading',
  file_info: 'reading',
  read_symbol: 'reading',
  grep: 'searching',
  glob: 'searching',
  symbols: 'searching',
  dependents: 'searching',
  check_symbols: 'checking',
  find_residue: 'checking',
  write_file: 'writing',
  append_file: 'appending',
  insert_at: 'patching',
  edit_file: 'patching',
  apply_patch: 'patching',
  replace_symbol: 'patching',
  insert_near_symbol: 'patching',
  rename_symbol: 'patching',
  delete_range: 'patching',
  remove_symbol: 'removing',
  delete_file: 'removing',
  move_file: 'moving',
  run_bash: 'running',
  run_powershell: 'running',
  run_cmd: 'running',
  python_run: 'running',
  process_run: 'running',
  run_background: 'running',
  review_changes: 'reviewing',
  engineering_brief: 'surveying',
  plan_write: 'planning',
  plan_step_done: 'planning',
};

/** Tools whose completed form is an edit — `edit python.js  +72 -40`. */
const EDITS = new Set(['write_file', 'edit_file', 'apply_patch', 'append_file', 'insert_at',
  'delete_range', 'replace_symbol', 'insert_near_symbol', 'remove_symbol', 'rename_symbol']);

/** A test or build command, so a green run can say so. */
const RUNS = new Set(['run_bash', 'run_powershell', 'run_cmd', 'python_run', 'process_run', 'run_background']);

function verbOf(name, running) {
  const v = VERB[String(name || '')] || (running ? 'working' : 'did');
  return v;
}

class Playback {
  /**
   * @param {object} o
   *   instant  play everything at once — a pipe, a test, animation turned off.
   *   now      clock reading, injectable so tests are deterministic.
   */
  constructor({ instant = false, now = () => Date.now() } = {}) {
    this.instant = Boolean(instant);
    this._now = now;
    /** Every activity, in the order it really happened. */
    this.events = [];
    /** Where playback has reached: the index of the event currently on screen. */
    this.cursor = 0;
    /** When the event at `cursor` began playing. */
    this.startedAt = 0;
  }

  /**
   * A REAL TOOL EVENT, pushed the moment it happens. Never awaited.
   *
   * `done` false means the tool is still running, so the ACTIVE phase holds
   * until it finishes rather than expiring on a timer — a slow command is
   * watched for as long as it actually takes.
   */
  enqueue(ev) {
    if (this.events.length >= MAX_EVENTS) return null;
    const e = {
      name: String((ev && ev.name) || ''),
      target: String((ev && ev.target) || ''),
      verb: verbOf((ev && ev.name) || '', true),
      ok: ev && ev.ok !== undefined ? Boolean(ev.ok) : true,
      done: Boolean(ev && ev.done),
      added: Number((ev && ev.added) || 0),
      removed: Number((ev && ev.removed) || 0),
      isEdit: EDITS.has(String((ev && ev.name) || '')),
      isRun: RUNS.has(String((ev && ev.name) || '')),
      note: String((ev && ev.note) || ''),
      at: this._now(),
      /** When the real operation FINISHED. What ends the ACTIVE phase. */
      doneAt: 0,
      /**
       * Extra settle time, in milliseconds, for a card whose diff window is
       * still being performed under it. Set by ui/activity.js when an edit's
       * change is queued; zero for everything else.
       */
      linger: 0,
      /** Wall-clock length of the REAL operation, once known. */
      tookMs: Number((ev && ev.tookMs) || 0),
    };
    this.events.push(e);
    return e;
  }

  /**
   * The running operation finished. Fills in what only the result knows and
   * releases the ACTIVE hold.
   */
  complete(patch = {}) {
    // THE OLDEST UNFINISHED EVENT, not the newest.
    //
    // Completing `events[last]` looks right while calls are strictly
    // sequential, and is wrong the moment two of them are enqueued before
    // either result arrives: the FIRST is then never marked done, its hold is
    // Infinity, and the timeline stops on it for the rest of the session —
    // permanently occupying the active position and the rows under it.
    //
    // Results arrive in the order the calls were made, so the oldest unfinished
    // event is the one this result belongs to.
    const e = this.events.find((x) => !x.done) || this.events[this.events.length - 1];
    if (!e) return null;
    if (patch.added !== undefined) e.added = Number(patch.added) || 0;
    if (patch.removed !== undefined) e.removed = Number(patch.removed) || 0;
    if (patch.ok !== undefined) e.ok = Boolean(patch.ok);
    if (patch.note !== undefined) e.note = String(patch.note || '');
    if (patch.name !== undefined && patch.name) { e.name = String(patch.name); e.isEdit = EDITS.has(e.name); e.isRun = RUNS.has(e.name); }
    e.done = true;
    e.tookMs = Math.max(0, this._now() - e.at);
    e.doneAt = this._now();
    return e;
  }

  /** How many events are waiting behind the one on screen. */
  get backlog() { return Math.max(0, this.events.length - 1 - this.cursor); }

  /**
   * HOW MUCH PRESENTATION TIME IS STILL OWED, at full speed, in milliseconds.
   *
   * Every event from the playhead onwards, priced at speed 1 — which is what
   * makes this a fixed point rather than a loop: `speed()` reads this, so this
   * must not read `speed()`.
   *
   * ------------------------------------------------------------------------
   * THE EVENT ON SCREEN IS PRICED BY WHAT IS LEFT OF IT, and that distinction
   * is load-bearing rather than an optimisation.
   *
   * A command that really took seven seconds is watched for seven seconds — the
   * ACTIVE phase ends when the operation did, which is the whole of `_hold`.
   * The viewer was level with it the entire time. Counting its full length as
   * DEBT the instant it completes would say the presentation had fallen seven
   * seconds behind at the exact moment it caught up, and the multiplier would
   * then hurry that card's own SETTLE — skipping the frame where the counters
   * land, which is the defect `_hold` was written to fix.
   *
   * So the head contributes only its FUTURE: its full-speed span less the time
   * it has already spent on screen. Everything behind it is owed in full,
   * because none of it has been seen at all.
   *
   * An event that has not finished yet is priced at its floor rather than at
   * `Infinity`. A running command is not debt for the same reason — the screen
   * is showing it happen — and infinite debt would peg the multiplier for the
   * whole of a long build, hurrying every call after it for no reason.
   */
  debtMs(now = this._now()) {
    let owed = 0;
    for (let i = this.cursor; i < this.events.length; i++) {
      const e = this.events[i];
      const hold = e.done
        ? Math.max(HOLD_MS, (e.doneAt || 0) - (e.at || 0) - ENTER_MS)
        : HOLD_MS;
      const full = ENTER_MS + hold + SETTLE_MS + (e.linger || 0) + EXIT_MS;
      // The head has been on screen since `startedAt`; the rest have not been
      // on screen at all.
      owed += i === this.cursor && this.startedAt
        ? Math.max(0, full - Math.max(0, Number(now) - this.startedAt))
        : full;
    }
    return owed;
  }

  /**
   * The clock multiplier for how far behind the presentation currently is.
   *
   * Under `TARGET_LAG_MS` of debt it plays at full length; past that it speeds
   * up towards `MAX_SPEED` and stops there. See TARGET_LAG_MS for why the debt
   * is measured in time rather than in queued events, and for why the ceiling
   * is not lifted when the debt is large.
   *
   * Never skips — the count and the order are exactly what happened.
   */
  speed(now = this._now()) {
    if (this.instant) return Infinity;
    const debt = this.debtMs(now);
    if (debt <= TARGET_LAG_MS) return 1;
    const t = Math.min(1, (debt - TARGET_LAG_MS) / (FULL_LAG_MS - TARGET_LAG_MS));
    return 1 + t * (MAX_SPEED - 1);
  }

  /**
   * Advance playback to `now` and return what the screen should show.
   *
   * PURE with respect to time: called twice with the same clock it returns the
   * same answer. The only mutation is moving the cursor forward, which is the
   * playhead — it never moves backwards and never skips an event.
   */
  at(now = this._now()) {
    if (!this.events.length) return { active: null, history: [], busy: false, phase: PHASE.COMPACT };

    // INSTANT: everything is already history. This is the path a pipe and a
    // test take, and it must produce the same CONTENT as a full playback.
    if (this.instant) {
      this.cursor = this.events.length;
      return {
        active: null,
        history: this.events.map((e) => compactOf(e)),
        busy: false,
        phase: PHASE.COMPACT,
      };
    }

    // Walk the playhead forward over every event whose time is up.
    //
    // WORKED IN DURATIONS, NOT IN ABSOLUTE POSITIONS, and each event begins
    // exactly where the one before it ended. That is what lets a single call
    // drain a whole backlog: a screen that was not redrawn for ten seconds
    // catches up in one pass instead of advancing one activity per frame and
    // falling further behind every time.
    //
    // The FIRST event starts from when it was enqueued rather than from when
    // playback first happened to be asked, so an idle period before the first
    // redraw is not spent replaying it.
    for (;;) {
      if (this.cursor >= this.events.length) break;
      const e = this.events[this.cursor];
      if (!this.startedAt) this.startedAt = e.at;
      const endsAt = this.startedAt + this._span(e, this.startedAt, now);
      if (now < endsAt) break;
      this.cursor += 1;
      this.startedAt = endsAt;
    }

    const history = this.events.slice(0, this.cursor).map((ev) => compactOf(ev));
    if (this.cursor >= this.events.length) {
      return { active: null, history, busy: false, phase: PHASE.COMPACT };
    }

    const e = this.events[this.cursor];
    const speed = this.speed(now);
    const elapsed = Math.max(0, now - this.startedAt);
    const enterEnd = ENTER_MS / speed;
    const activeEnd = enterEnd + this._hold(e, this.startedAt) / speed;
    const settleEnd = activeEnd + (SETTLE_MS + (e.linger || 0)) / speed;

    let phase = PHASE.ACTIVE;
    if (elapsed < enterEnd) phase = PHASE.ENTER;
    else if (elapsed < activeEnd) phase = PHASE.ACTIVE;
    else if (elapsed < settleEnd) phase = PHASE.SETTLE;
    else phase = PHASE.EXIT;

    // HOW FAR THROUGH THE ACTIVE PHASE, for the counters to interpolate along.
    // Derived from the clock rather than counted up by a timer, so a redraw at
    // any moment shows the value that instant deserves.
    // IS THIS EVENT'S WINDOW STILL PLAYING? `windowTotal` is the plan length
    // ui/activity.js reserved for it; `windowMs` below is how far in we are.
    const windowMs = e.window ? Math.max(0, (elapsed - enterEnd) * speed) : 0;
    const performing = Boolean(e.window) && windowMs < (e.windowTotal || 0);

    // ---- HOW FAR THROUGH ENTER, so the subject MATERIALISES rather than
    // appearing. It used to be blank for the whole phase and then present on
    // the next frame — a teleport, small but the same shape as the big one.
    // See ui/timeline.js `activeRows` and ui/reveal.js `emerge`.
    const enter = enterEnd > 0 ? Math.max(0, Math.min(1, elapsed / enterEnd)) : 1;
    // Which scramble frame this is. Derived from the clock, so drawing a frame
    // twice cannot advance the effect.
    const tick = Math.floor(elapsed / SCRAMBLE_MS);

    const span = Math.max(1, activeEnd - enterEnd);
    const progress = phase === PHASE.ENTER ? 0
      : phase === PHASE.ACTIVE ? Math.max(0, Math.min(1, (elapsed - enterEnd) / span))
        : 1;

    return {
      active: {
        // WHAT IS ON ITS WAY OUT, carried for the length of the ENTER phase.
        //
        // The drawing layer puts it one row above the arriving card so the
        // previous operation is seen to MOVE UP AND FADE rather than to be
        // overwritten between two frames. It is the immediately preceding
        // event and nothing else, and only while something is entering — so it
        // is a transition, not a second copy of the history the feed carries.
        leaving: phase === PHASE.ENTER && this.cursor > 0
          ? compactOf(this.events[this.cursor - 1]) : null,
        // ---- PRESENT TENSE WHILE ITS OWN WINDOW IS STILL PERFORMING -------
        //
        // The verb settles to the past — `patching` becomes `edit` — when the
        // phase does. With a window attached that was a third way for the two
        // halves of the surface to disagree: the card read `edit python.js` in
        // the finished tense while the window underneath it was still striking
        // lines out and typing replacements. The operation is manifestly still
        // being performed; the card must not describe it as over.
        //
        // Measured against the window's own plan length, which `_attach`
        // recorded, so this asks the same question the window answers.
        verb: (phase === PHASE.SETTLE || phase === PHASE.EXIT) && !performing
          ? doneVerb(e) : e.verb,
        target: e.target,
        name: e.name,
        ok: e.ok,
        isEdit: e.isEdit,
        isRun: e.isRun,
        // COUNTERS CLIMB while the edit is active and land on the real numbers.
        // Derived from progress rather than counted up by a timer, so a redraw
        // at any moment shows the value that instant deserves.
        added: e.isEdit ? Math.round(e.added * progress) : 0,
        removed: e.isEdit ? Math.round(e.removed * progress) : 0,
        finalAdded: e.added,
        finalRemoved: e.removed,
        progress,
        phase,
        // ---- THE WINDOW THIS OPERATION CARRIES, AND HOW FAR INTO IT WE ARE --
        //
        // ONE PLAYHEAD. The window used to be a second queue on a second clock
        // (ui/diffreel.js), and two clocks over two orderings of the same
        // operations come apart the moment either is behind — which is how a
        // card reading `python.js` came to sit over a window travelling down
        // `router.js`.
        //
        // The window belongs to the EVENT now, so "which window" is not a
        // question that can be answered wrongly: it is this event's, or there
        // is none. And "how far into it" is read off the same elapsed clock as
        // the phase above, divided by the same catch-up multiplier, so the two
        // halves of the surface cannot drift by construction.
        //
        // IT STARTS WHEN THE CARD SETTLES INTO ITS SUBJECT — after ENTER, where
        // the target has arrived under the verb. `linger` (ui/activity.js) is
        // what reserves the rest of the event for it, so the window has room to
        // finish before EXIT takes the card away.
        window: e.window || null,
        windowMs,
        performing,
        enter,
        tick,
      },
      history,
      busy: true,
      phase,
    };
  }

  /**
   * HOW LONG THE ACTIVE PHASE HOLDS — until the operation FINISHED.
   *
   * ------------------------------------------------------------------------
   * THE BUG THIS IS THE FIX FOR, found by watching a real run rather than by
   * reading the code.
   *
   * It was `max(HOLD_MS, min(tookMs, HOLD_MS * 4))` — a duration measured from
   * when playback STARTED showing the event. For an operation that took longer
   * than that ceiling (an edit behind a slow model, a build, a test run) the
   * ACTIVE phase had therefore expired long before the result arrived, so the
   * instant the event completed, `elapsed` was already past SETTLE and EXIT
   * too. The card jumped straight to the next operation.
   *
   * What that cost was the whole settled state: the counters land in SETTLE,
   * so a patch card went from `src/serializer.js` with no numbers on it
   * directly to the next file, and `+2 -2` was never on screen for a single
   * frame. In a real session recorded off the terminal, not one patch card
   * ever showed its own counts.
   *
   * So the ACTIVE phase ends WHEN THE OPERATION DID — not on a timer — with
   * HOLD_MS as the floor so an instant tool is still read. That is what the
   * comment always claimed ("a slow command is watched for as long as it
   * really takes") and what the ceiling quietly prevented. SETTLE and EXIT then
   * always play, because they begin from a moment that has not happened yet.
   *
   * `from` is when playback began showing this event, which is not when the
   * event was enqueued: a backlogged timeline reaches an operation after it has
   * already finished, and then the floor is the whole of the hold.
   */
  _hold(e, from) {
    if (!e.done) return Infinity;
    return Math.max(HOLD_MS, (e.doneAt || 0) - from - ENTER_MS);
  }

  /**
   * The whole clock length of one event at the current speed.
   *
   * `linger` is time added to SETTLE for an event whose diff window is still
   * being performed underneath it (see ui/activity.js `showDiff`). Without it
   * the card moves on to the next file while the window below it is still
   * editing the previous one, and the two halves of one surface disagree about
   * which file is being changed.
   */
  _span(e, from, now = this._now()) {
    const hold = this._hold(e, from);
    if (hold === Infinity) return Infinity;
    return (ENTER_MS + hold + SETTLE_MS + (e.linger || 0) + EXIT_MS) / this.speed(now);
  }

  /** Is anything still playing? The ticker asks this to decide whether to run. */
  busy(now = this._now()) {
    if (this.instant) return false;
    return this.at(now).busy;
  }

  /** Forget everything. A new task starts with an empty timeline. */
  reset() {
    this.events = [];
    this.cursor = 0;
    this.startedAt = 0;
  }
}

/** The past-tense label a finished activity settles into. */
function doneVerb(e) {
  if (e.isEdit) return 'edit';
  const v = String(e.verb || '');
  return v === 'reading' ? 'read'
    : v === 'searching' ? 'searched'
      : v === 'writing' ? 'wrote'
        : v === 'patching' ? 'edit'
          : v === 'removing' ? 'removed'
            : v === 'running' ? 'ran'
              : v === 'checking' ? 'checked'
                : v === 'reviewing' ? 'reviewed'
                  : v === 'moving' ? 'moved'
                    : v === 'surveying' ? 'surveyed'
                      : v === 'planning' ? 'planned'
                        : v;
}

/** One finished activity, as the single quiet line it leaves behind. */
function compactOf(e) {
  return {
    verb: doneVerb(e),
    target: e.target,
    name: e.name,
    ok: e.ok,
    isEdit: e.isEdit,
    added: e.added,
    removed: e.removed,
    note: e.note,
  };
}

module.exports = {
  Playback, PHASE, VERB, EDITS, RUNS, verbOf, doneVerb, compactOf,
  ENTER_MS, HOLD_MS, SETTLE_MS, EXIT_MS, MAX_SPEED, FULL_SPEED_AT, MAX_EVENTS,
  TARGET_LAG_MS, FULL_LAG_MS,
};
