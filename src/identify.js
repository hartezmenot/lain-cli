'use strict';

/**
 * WHAT DID THE USER JUST MEAN?
 *
 * Split out of app.js, which had grown past the god-object guard. The seam is
 * real: app.js RUNS the turn, and this decides what the input was — a new task,
 * a continuation, a steer — and what kind of work it implies. Both questions
 * are answered locally and for free, by task.js and mode.js; this is the glue
 * that applies their verdict to the session, and the only place that does.
 *
 * Everything downstream consumes the verdict rather than re-reading the raw
 * text, which is what keeps there being exactly one classifier.
 */

const taskId = require('./task');
const modeId = require('./mode');
const { Lifecycle } = require('./lifecycle');

/**
 * @param {App}     app
 * @param {string}  text
 * @param {boolean} isPaste
 * @param {string}  forceMode  a named mode from a command, or null
 * @param {boolean} sameTask   asserted by LAIN's own machinery only
 */
function identify(app, text, isPaste, forceMode = null, sameTask = false) {

  const verdict = taskId.classify(text, { isPaste, activeTask: app.session.task });
  // A CALLER MAY KNOW BETTER THAN THE CLASSIFIER. The troubleshoot relay
  // submits its own instruction — "a second model recommends this next
  // step…" — which reads as a brand new request and replaced the user's
  // actual problem in the task banner, then cleared the story that produced
  // it. Only LAIN's own machinery may assert this; typed input never does.
  if (sameTask && app.session.task) verdict.sameTask = true;
  // WHAT KIND OF WORK IS THIS? A different question from "is this the same
  // task?", answered locally and for free — see mode.js. It selects a
  // paragraph of workflow guidance and nothing else, so it can never block.
  const verdictMode = modeId.classify(text, {
    isPaste,
    taskKind: verdict.kind,
    activeMode: app.session.mode,
    projectEmpty: app.projectIsEmpty(),
  });
  verdict.mode = (forceMode && modeId.KIND[forceMode]) || verdictMode.mode;  // a named mode (/troubleshoot) beats the keyword guess
  verdict.modeReason = forceMode && modeId.KIND[forceMode] ? 'requested by command' : verdictMode.reason;
  app.session.mode = verdict.mode;

  // (The CLI -> PROBE handoff that lived here — flipping the session's
  // execution environment when a PROBE-mode task arrived with a live Probe —
  // was removed with the Probe integration in 2026-09, along with PROBE as a
  // mode: such a request now classifies as whatever its own text says, which
  // is the honest answer for a tool whose workspace is the codebase.)

  if (!verdict.sameTask) {
    // A genuinely new task: fresh lifecycle, fresh liveness. Evidence is
    // SESSION-scoped and deliberately survives — a new task in the same
    // session should not re-read files whose content is already known.
    app.session.task = new taskId.Task(text);
    if (app.ui.enabled) app.ui.clearExtras();   // a new task, a new story
    app.session.lifecycle = new Lifecycle(text);
    app.session.plan = null;
    // FRESH BUDGETS, because both are PER TASK. Carried over, a spent
    // clarification budget would mean the SECOND thing somebody asks for can
    // never be clarified, and a spent visual budget would refuse to show
    // candidates for a picture nobody has looked at yet. Neither is a limit on
    // the user; both are limits on one task talking to itself.
    app._clarify = null;
    // A NEW TASK GETS ITS CONTINUATIONS BACK. The budget is per task, and a
    // task that inherited a spent one could not continue at all.
    app._visual = null;
  } else {
    if (!app.session.lifecycle) app.session.lifecycle = new Lifecycle(app.session.task.objective);
    app.session.lifecycle.noteUserInput();
    // ---- A FINISHED PLAN IS NOT THIS TURN'S PROGRESS ---------------------
    //
    // A plan stops being live when a task is ACCEPTED as complete, and that
    // acceptance happens in exactly one place (completion.js). Every other way
    // a turn can end — interrupted, abandoned, or a completion check that
    // refused — leaves a plan whose steps are all done still marked live.
    //
    // The banner reads progress off that plan, so the next thing the user typed
    // opened on `STEP 2/2 · 100%` inherited whole from the turn before it. The
    // percentage was true about work that had already stopped, and false about
    // the work being asked for, which is the worst combination: it reads as
    // "this is nearly done" for a request that has not started.
    //
    // Retiring it here does not delete it — the PLAN pane still shows what was
    // done. It stops being the answer to "how far along is the work in hand",
    // and a plan that is genuinely still in progress is untouched.
    const plan = app.session.plan;
    if (plan && plan.isLive && plan.isFinished) plan.retire('the plan finished before this request');
    if (verdict.kind === taskId.KIND.STEER) {
      app.session.task.steer(text);
      // A steer adjusts what is LEFT. Completed steps are evidence and are
      // never rewritten or deleted (see plan.js).
      if (app.session.plan) app.session.plan.steer(text);
    }
  }
  app.session.task.turnIds.push(text.slice(0, 60));
  return verdict;
}

module.exports = { identify };
