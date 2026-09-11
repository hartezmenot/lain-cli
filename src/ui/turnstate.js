'use strict';

/**
 * WHAT THE SCREEN DOES AS A TURN BEGINS, RUNS, IS INTERRUPTED AND ENDS.
 *
 * Split out of ui/index.js when that file reached the architecture guard, and
 * the seam is a real one. Everything left in ui/index.js is the UI's SURFACE —
 * the panels, the menus, the views, the input line, the key and mouse routing.
 * This is the small state machine underneath it that answers one question:
 * given what the turn loop just announced, what is the screen's resting state?
 *
 * They change for different reasons. A new pane or a new shortcut touches the
 * surface and not this; a new way for a turn to END — and there are five, which
 * is exactly why this is worth naming — touches this and not the surface.
 *
 * THE FIVE ENDINGS, AND WHY NONE OF THEM MAY BE SILENT:
 *
 *   it finished          the feed holds the account, the header rests at READY
 *   the user cancelled   `interrupted`, held until they do something else
 *   it failed            `failed`, held for the same reason
 *   it is unwinding      `interrupting`, shown before the unwind completes
 *   a new task began     `clearExtras`, and the previous story is not the news
 *
 * Every one of these is a RESTING state rather than a flash. A status that
 * appeared for a single frame would answer "did that work?" only for somebody
 * already staring at the screen, and returning silently to READY after a
 * failure is indistinguishable from succeeding.
 *
 * Each function takes the `ui` as its first argument and uses no `this`, which
 * is the same shape every other extracted helper here follows.
 */

/** A genuinely new task: the previous task's story is no longer the news. */
function clearExtras(ui) {
  ui.story.newTask();
  // A new task starts an empty timeline — the previous task's operations are
  // not the news, and its diff window is about a change nobody is looking at.
  ui.activity.reset();
  if (Array.isArray(ui.app.session.actors)) ui.app.session.actors.length = 0;
}

/**
 * A new turn: whatever the last one was doing is no longer the news.
 *
 * `verdict` is identify.js's, and it is what decides whether the clock starts
 * again or carries on — see ui/alert.js `attemptFor`. It is OPTIONAL, and its
 * absence means FRESH, because every caller that does not know about tasks
 * (a test double, a headless projection) is starting something unrelated by
 * definition.
 */
function beginTurn(ui, verdict = null) {
  const alert = require('./alert');
  // WHAT TO DO WITH THE CLOCK IS DECIDED BEFORE THE ALERT IS CLEARED, because
  // clearing it is what destroys the evidence the decision is made from. The
  // ordering is load-bearing and reversing it would silently make every
  // continuation FRESH.
  const attempt = alert.attemptFor(ui, verdict);
  // ---- THE STALE ALERT STOPS BEING THE RESTING STATE, HERE -------------
  //
  // A rate-limit wait, an interruption or a previous failure described the
  // attempt BEFORE this submission. `waitingUntil` in particular outranks every
  // other branch of liveState, so leaving it set would cover this turn's phases
  // with the last turn's countdown. See ui/alert.js for the full account.
  alert.clearResting(ui);
  ui.story.beginTurn();
  // NO REQUEST IS OPEN YET, so there is no live figure to draw. Cleared HERE
  // rather than at the end of the last turn so that a finished request's input
  // count stays on the screen through the pause between turns instead of
  // blinking out the instant the model stops.
  ui.liveUsage = null;
  // ---- THE RESPONSE COUNTER GOES BACK TO ZERO --------------------------
  //
  // The header carries ONE number and it is THIS RESPONSE's output. A new turn
  // is a new response, so it starts at nothing and climbs — see
  // ui/index.js `noteOutputChars` for why it climbs from characters and how it
  // says so.
  ui.liveOutput = { chars: 0, tokens: 0, measured: false };
  // ---- AND THE WORK CLOCK STARTS, HERE AND NOWHERE ELSE ----------------
  //
  // "Start it at the moment the user submits the turn" — this function is that
  // moment, and it is the only place the figure goes back to zero. Every phase
  // change, tool call, retry and verification step inside the turn leaves it
  // alone, which is the difference between one clock for the task and six
  // little ones for its steps. See ui/workclock.js.
  //
  // EXCEPT WHEN THE SAME ATTEMPT IS CARRYING ON. `continue` after a rate-limit
  // pause or a refused credential is not a new execution attempt, and zeroing
  // there reports four minutes of real work as none. RESTART still zeroes: the
  // previous attempt is over and stays failed in the record. See ui/alert.js.
  if (attempt === alert.ATTEMPT.CONTINUE) require('./workclock').resume(ui.clock);
  else require('./workclock').start(ui.clock);
  // AND THE LIVE ROW GOES BACK TO THE WORK. A transient operation note —
  // "Recovering interrupted turn", "Copied 3 lines" — shares that row with the
  // turn's phase and must never outlive the moment it described. See
  // ui/operation.js.
  require('./operation').clear(ui);
}

/**
 * The turn is over: hand the feed back to the persisted record.
 *
 * `runTurn` appends the turn to `session.turns` before it yields `done`, so
 * there is no frame in which both are absent — and keeping both would render
 * every call of the turn twice.
 */
function endTurn(ui) {
  ui.story.endTurn();
  // ---- THE ESTIMATE IS REPLACED BY THE RECEIPT -------------------------
  //
  // While the response streamed, the header's number was an ESTIMATE from the
  // characters that had arrived, drawn with a `~` in front of it, because no
  // provider LAIN speaks to states output tokens before the end. The receipt
  // has landed by now, so the same number becomes MEASURED and the `~` goes.
  //
  // The turn that just finished is the last entry in `session.turns` — the
  // same record `/token` reads, so the header and the detail cannot report a
  // different figure for one response.
  try {
    const turns = (ui.app.session && ui.app.session.turns) || [];
    const last = turns[turns.length - 1];
    const measured = last && last.usage && Number(last.usage.outputTokens);
    if (measured > 0) ui.liveOutput = { chars: (ui.liveOutput && ui.liveOutput.chars) || 0, tokens: measured, measured: true };
  } catch { /* the estimate is still true, and still says it is one */ }
  // THE OPEN REQUEST IS CLOSED. Its input tokens are in the session total by
  // now — turnclose.js added them — so continuing to draw them as an open
  // `+18.3K` beside that total would show the same tokens twice.
  ui.liveUsage = null;
  // ---- AND THE WORK CLOCK STOPS, KEEPING ITS VALUE ---------------------
  //
  // THE TURN, NOT A MODEL RESPONSE. `runTurn` has by now finished its whole
  // loop — every model call, every tool call, the checks and the settlement —
  // so this is the task reaching a terminal state rather than one iteration of
  // it ending. A stopped clock holds its figure on purpose: `✓ DONE 00:12:08`
  // is the receipt, and a receipt that blanks itself answers nothing.
  require('./workclock').settle(ui.clock);
  // ---- AND THE TRANSIENT ROW IS HANDED BACK ----------------------------
  //
  // An operation describes something happening NOW. Once the turn is over it is
  // not, and a stale one sits there for its full lifetime saying so: Escape out of
  // a rate-limit wait and the row still read `Rate limited · retry in 30s` over a
  // session that had already stopped waiting. Cleared at both ends of a turn.
  require('./operation').clear(ui);
  ui.refresh();
}

/**
 * The call in flight. This is what keeps the screen from going silent while
 * the model works: the turn already announces each call, so showing it costs
 * nothing beyond a redraw.
 */
function setRunning(ui, name, target) {
  ui.running = name ? { name, target } : null;
  // ENQUEUED, NOT AWAITED. The call is already on its way to the tool; this
  // only puts it in the timeline's queue to be played back, and returns.
  //
  // AND `null` MEANS NOTHING IS IN FLIGHT, which is the turn's own statement
  // that any activity still holding the timeline open is finished — see
  // ui/activity.js `settle` for the dangling call that would otherwise hold it
  // for the rest of the session.
  if (name) ui.activity.begin(name, target);
  else ui.activity.settle();
  ui._syncTicker();
  ui.refresh();
}

/**
 * Adopt the turn loop's phase.
 *
 * Called from `app.submit` with what `turn.js` announces. The phase CHANGING is
 * what restarts the clock, so `Thinking… 45s` measures one real wait rather
 * than the whole turn.
 */
function setPhase(ui, next) {
  const before = ui.phase && ui.phase.phase;
  const after = next && next.phase;
  if (before !== after) ui.phaseSince = Date.now();
  ui.phase = next && next.phase !== 'ENDED' ? next : null;
  if (!ui.phase) ui.interrupting = false;
  ui._syncTicker();
  ui.refresh();
}

/** Ctrl+C during work: shown immediately, before the unwind finishes. */
function setInterrupting(ui, on) {
  ui.interrupting = Boolean(on);
  if (ui.interrupting) ui.interrupted = false;
  ui._syncTicker();
  ui.refresh();
}

/**
 * The turn ENDED because the user cancelled it. A resting state, held until the
 * next thing the user does — see the header for why none of these may flash.
 */
function setInterrupted(ui, on) {
  ui.interrupted = Boolean(on);
  if (ui.interrupted) ui.interrupting = false;
  ui._syncTicker();
  ui.refresh();
}

/**
 * The turn ENDED BADLY — the provider died, timed out, or refused.
 *
 * Also a resting state. Without it the header said `READY` the instant a
 * connection dropped: the failure was in the activity feed, but the single word
 * summarising the session said everything was fine, and the word wins.
 *
 * ------------------------------------------------------------------------
 * THE KIND IS KEPT, AND IT USED TO BE THROWN AWAY HERE.
 *
 * This was `ui.failed = Boolean(on)`. Its one caller that matters passes
 * `record.providerFailure` — an OBJECT carrying `kind`, `status` and
 * `message` — and the coercion reduced all of it to `true`. Downstream,
 * ui/failure.js `failureRow` found no `kind`, fell through to `UNKNOWN`, and
 * every failure in the product rendered as the same generic
 * `ERROR · the provider did not answer`: a refused credential, a full context
 * window and a dead gateway were indistinguishable on the one row a person
 * reads at a glance, despite the vocabulary to tell them apart existing and
 * being correct two files away.
 *
 * It also made BLOCKED unrecognisable from TERMINAL, so a `continue` after a
 * rate limit could not be told from a `retry` after a crash — see ui/alert.js,
 * which needs the kind to decide whether the execution attempt survived.
 *
 * `failureRow` already handles a bare boolean, a string and an object, so
 * passing the object through is strictly more information and breaks no
 * caller: everything downstream tests `failed` for truthiness.
 */
function setFailed(ui, on) {
  // An OBJECT keeps its kind; a STRING keeps its sentence — `failureRow`
  // renders both and only a boolean carries nothing. Anything else coerces, so
  // the truthiness every downstream reader tests is unchanged.
  ui.failed = on && (typeof on === 'object' || typeof on === 'string') ? on : Boolean(on);
  if (ui.failed) { ui.interrupting = false; ui.interrupted = false; }
  ui._syncTicker();
  ui.refresh();
}

module.exports = {
  clearExtras, beginTurn, endTurn,
  setRunning, setPhase, setInterrupting, setInterrupted, setFailed,
};
