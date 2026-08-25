'use strict';

/**
 * WHAT THE USER TYPED WHILE IT WAS WORKING.
 *
 * Split out of app.js when that file reached the architecture guard, and the
 * seam is a real one. app.js owns the SESSION LOOP — submitting a turn, running
 * it, ending it, deciding whether the work is complete. This owns one small
 * state machine that sits beside it: a queue of sentences the person typed
 * while a turn was in flight, each with a promise about when it will arrive.
 *
 * ------------------------------------------------------------------------
 * TWO MODES, AND THE DIFFERENCE IS ONLY HOW LONG THEY WAIT.
 *
 *   WAIT  delivered when the work in flight has finished. The default, because
 *         most corrections are "and also…" rather than "stop what you are
 *         doing", and interrupting a healthy tool call to add a sentence costs
 *         the step it was in the middle of.
 *   NOW   delivered at the next STEP BOUNDARY, which is the earliest point a
 *         steer can land safely. Chosen by pressing Enter a second time.
 *
 * Neither can land inside a tool call. That is the safety property, and it is
 * why there are two modes rather than an interrupt.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THAT MADE THIS ITS OWN FILE, because it turned on exactly the
 * distinction above and nothing else in app.js cared about it.
 *
 * The end of a turn delivered the WAITING steers and then cleared the WHOLE
 * queue. A NOW steer promoted after the turn's last step boundary never got a
 * boundary to land on — so the clear DELETED IT WITHOUT DELIVERING IT. Pressing
 * Enter a second time, which is how a person says "this is urgent", was the way
 * to lose the sentence entirely.
 *
 * And with only NOW steers queued, the delivery branch was gated on the WAITING
 * count, so it never ran: they sat in the queue until some later, unrelated
 * turn drained them at its first step boundary — work performed outside the
 * plan that asked for it.
 *
 * `drain` is the repair, and it is one line of behaviour: at the end of a turn
 * every queued steer is delivered, whatever its mode. A NOW steer wanted to
 * arrive SOONER than that, not later. Arriving there is the promise kept late;
 * deleting it is the promise broken.
 *
 * ------------------------------------------------------------------------
 * Each function takes the `app` as its first argument and uses no `this` —
 * the same shape every other extracted helper in this codebase follows.
 */

/** The two promises a steer can carry. */
const MODE = Object.freeze({ WAIT: 'WAIT', NOW: 'NOW' });

/**
 * Queue a correction, and TELL THE TASK AND THE PLAN about it immediately.
 *
 * Recorded on the authoritative state at ENQUEUE time rather than at delivery,
 * because a correction is a decision the session should remember even if the
 * turn it was meant for ends first. See prompt.js `workingContext`, which
 * carries `task.steers` into every later request.
 */
function queue(app, text, mode = MODE.WAIT) {
  const t = String(text || '').trim();
  if (!t) return false;
  app.steerQueue.push({ text: t, mode: mode === MODE.NOW ? MODE.NOW : MODE.WAIT });
  if (app.session.task) app.session.task.steer(t);
  if (app.session.plan) app.session.plan.steer(t);
  if (app.ui.enabled) app.ui.refresh();
  return true;
}

/** Promote everything waiting to NOW — the second Enter. */
function promote(app) {
  let n = 0;
  for (const s of app.steerQueue) if (s.mode !== MODE.NOW) { s.mode = MODE.NOW; n += 1; }
  if (n && app.ui.enabled) app.ui.refresh();
  return n;
}

/**
 * Take the most recent pending steer BACK, for editing.
 *
 * Escape means "I have not sent that yet" — so the text returns to the input
 * box exactly as typed rather than being discarded. A correction you were
 * halfway through rewording is the worst thing to lose to a stray keypress.
 */
function takeBack(app) {
  if (!app.steerQueue.length) return null;
  const last = app.steerQueue.pop();
  // THE TASK'S RECORD OF IT GOES TOO. `queue` told the task and the plan that a
  // correction had been made; un-sending it must un-tell them, or the working
  // context carries an instruction the model was never given.
  if (app.session.task && Array.isArray(app.session.task.steers)) {
    const list = app.session.task.steers;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].text === last.text) { list.splice(i, 1); break; }
    }
  }
  if (app.ui.enabled) app.ui.refresh();
  return last.text;
}

/** Everything still waiting for the work in flight to finish. */
function waiting(app) {
  return app.steerQueue.filter((s) => s.mode !== MODE.NOW).map((s) => s.text);
}

/**
 * The PROMOTED ones, handed to a running turn at a step boundary and removed.
 *
 * A WAIT steer cannot land mid-turn however long the turn runs, which is the
 * whole safety property of the two modes.
 */
function takeNow(app) {
  const out = [];
  for (let i = app.steerQueue.length - 1; i >= 0; i--) {
    if (app.steerQueue[i].mode === MODE.NOW) out.unshift(app.steerQueue.splice(i, 1)[0].text);
  }
  return out;
}

/** Everything queued, whatever its mode, and the queue is emptied once. */
function drain(app) {
  const all = app.steerQueue.map((s) => s.text);
  app.steerQueue.length = 0;
  return all;
}

module.exports = { MODE, queue, promote, takeBack, waiting, takeNow, drain };
