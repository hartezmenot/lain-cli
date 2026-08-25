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

/** A new turn: whatever the last one was doing is no longer the news. */
function beginTurn(ui) {
  ui.story.beginTurn();
  ui.interrupted = false;
  ui.retryCancelled = false;
  // NO REQUEST IS OPEN YET, so there is no live figure to draw. Cleared HERE
  // rather than at the end of the last turn so that a finished request's input
  // count stays on the screen through the pause between turns instead of
  // blinking out the instant the model stops.
  ui.liveUsage = null;
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
  // THE OPEN REQUEST IS CLOSED. Its input tokens are in the session total by
  // now — turnclose.js added them — so continuing to draw them as an open
  // `+18.3K` beside that total would show the same tokens twice.
  ui.liveUsage = null;
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
 */
function setFailed(ui, on) {
  ui.failed = Boolean(on);
  if (ui.failed) { ui.interrupting = false; ui.interrupted = false; }
  ui._syncTicker();
  ui.refresh();
}

module.exports = {
  clearExtras, beginTurn, endTurn,
  setRunning, setPhase, setInterrupting, setInterrupted, setFailed,
};
