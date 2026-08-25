'use strict';

/**
 * WHEN A TASK MAY BE CALLED FINISHED — the completion policy, on its own.
 *
 * Split out of app.js at the architecture guard, and the seam is a real one:
 * app.js routes input and runs turns, and this answers a different question
 * that changes for different reasons — whether the work is actually over.
 *
 * THE RULE IT ENFORCES, which predates the split and is the reason it exists:
 * a finished PLAN is a question, not an answer. `plan.isFinished` decides only
 * that it is worth ASKING; `lifecycle.complete()` decides, and it only accepts
 * with real evidence — a changed file, a command that ran, a check that passed.
 * What the model said in the same breath outranks the checklist.
 */

/**
 * Show the completion screen only on GENUINE completion.
 *
 * Two conditions, both required, and neither is "the model stopped talking":
 * every plan step is finished, AND `lifecycle.complete()` accepts — which it
 * only does with real evidence (a changed file, a command that ran, a verified
 * check). The safeguard is untouched; this just asks it, and shows nothing if
 * the answer is no.
 */
function maybeComplete(app, record = null) {
  const plan = app.session.plan;
  const life = app.session.lifecycle;
  if (!plan || !plan.steps.length || !plan.isFinished) return false;
  if (!life || life.state === 'DONE') return false;

  // A FINISHED PLAN IS A QUESTION, NOT AN ANSWER.
  //
  // `plan.isFinished` decides only that it is worth ASKING whether the task
  // is done. What the model said in the same breath outranks the checklist:
  // "all steps complete, I still need to run the tests" is a task with work
  // left in it, and ticking the last box is not what finishes it.
  if (record && require('./lifecycle').Lifecycle.saysMoreToDo(record.text)) {
    app.pendingCompletion = 'the model says it still has work to do';
    return false;
  }

  const r = life.complete();
  if (!r.ok) {
    // A refusal here is INFORMATION: every step is ticked off and LAIN is
    // declining to call it done. Silence made that indistinguishable from
    // "nothing happened", which is how a red test suite passes for finished
    // work. The reason is always named, and the status stays ACTIVE so the
    // screen never shows 100% beside a word that implies LAIN stopped.
    app.pendingCompletion = r.why;
    // ANNOUNCED ONCE PER REASON, not on every later turn that never touched
    // the plan. `maybeComplete` runs after EVERY turn once the plan reads
    // 100%, including a steer that has nothing to do with it — "check disk
    // space" got its own answer and then this same sentence anyway, twice,
    // because the plan was still finished-but-not-verified from a turn ago.
    // That reads as the OLD turn's unfinished business being pinned onto a
    // turn that never touched it. Keyed on the PLAN object, not the app or
    // the session, so a genuinely NEW plan — a new task — still gets its own
    // first announcement even where the generic wording happens to match.
    if (plan._lastIncompleteReason !== r.why) {
      plan._lastIncompleteReason = r.why;
      app.render.notice('warn', `Plan finished, but the task is not complete — ${r.why}`);
    }
    return false;
  }
  app.pendingCompletion = null;
  // THE PLAN STOPS BEING LIVE PROGRESS AT EXACTLY THIS MOMENT — the one place
  // in the program where a task is accepted as complete. It is not deleted:
  // the PLAN pane still shows what was done. It simply stops being the answer
  // to "how far along is the work in hand", so the next turn starts with no
  // progress rather than inheriting `100%` from the turn before it.
  plan.retire('task complete');
  if (app.ui.enabled) app.ui.showCompletion();
  else {
    const views = require('./ui/views');
    app.render.nl();
    for (const l of views.completion({
      session: app.session, checkpoints: app.checkpoints, cwd: app.session.cwd, width: 76,
    })) app.render.write('  ' + l + '\n');
  }
  return true;
}

module.exports = { maybeComplete };
