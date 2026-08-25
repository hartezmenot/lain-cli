'use strict';

/**
 * PROGRESS BELONGS TO THE WORK IN HAND, NEVER TO THE TURN BEFORE IT.
 *
 * THE DEFECT. A plan stops being live when a task is ACCEPTED as complete, and
 * that acceptance happens in exactly one place (completion.js). Every other way
 * a turn can end — interrupted, abandoned, or a completion check that refused —
 * left a plan whose steps were all done still marked live.
 *
 * The task banner reads its percentage off that plan, so the next thing the
 * user typed opened on `STEP 2/2 · 100%` inherited whole from the turn before
 * it. That number was true about work which had already stopped and false about
 * the work being asked for — it reads as "this is nearly done" for a request
 * that has not started.
 *
 * The two halves are tested separately because they have different owners:
 * `plan.js` decides what live progress IS, and `identify.js` decides when a new
 * submission stops inheriting it.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Plan } = require('../../src/plan');
const views = require('../../src/ui/views');

/** A plan with every step finished — the shape that leaked. */
function finishedPlan() {
  const p = new Plan('build the parser');
  p.addSteps(['design the grammar', 'write the tokenizer']);
  for (const s of p.steps) s.status = 'done';
  return p;
}

/** What the banner would show for this session. */
const shown = (plan) => views.progressOf(views.livePlan({ plan }));

module.exports = async function () {
  await test('PROGRESS: a finished, retired plan reports NO live progress', () => {
    const p = finishedPlan();
    p.retire('task complete');
    assert.strictEqual(shown(p).known, false, 'a retired plan is not progress in hand');
    assert.strictEqual(shown(p).percent, null);
  });

  await test('PROGRESS: a plan still being worked reports its real progress', () => {
    // The other direction, so the fix cannot be "never show progress".
    const p = new Plan('build the parser');
    p.addSteps(['design', 'implement', 'test']);
    p.steps[0].status = 'done';
    p.steps[1].status = 'active';
    const g = shown(p);
    assert.strictEqual(g.known, true);
    assert.strictEqual(g.total, 3);
    assert.strictEqual(g.completed, 1);
    assert.strictEqual(g.percent, 33);
  });

  await test('PROGRESS: an UNRETIRED finished plan is what used to leak 100%', () => {
    // Pinned deliberately: this is the state an interrupted turn leaves behind,
    // and it is the input the fix in identify.js has to deal with.
    const p = finishedPlan();
    assert.strictEqual(p.isLive, true, 'nothing retired it — that is the whole problem');
    assert.strictEqual(shown(p).percent, 100);
  });

  await test('TURN B: a new submission on the same task does NOT inherit 100%', async () => {
    // The fix, at its owner. `identify` is the one place that decides whether
    // this input continues the task or starts a new one, and it is where a
    // finished plan stops being the answer to "how far along is this?".
    const { identify } = require('../../src/identify');
    const app = fakeApp(finishedPlan());
    // Turn A left a finished, live plan on screen at 100%.
    assert.strictEqual(shown(app.session.plan).percent, 100, 'precondition: the stale 100% is there');

    await identify(app, 'also make it handle comments', { sameTask: true });

    assert.strictEqual(shown(app.session.plan).known, false,
      'turn B must not open on turn A\'s percentage');
  });

  await test('TURN B: a plan with work LEFT is untouched by a new submission', () => {
    // A steer arriving mid-plan must not throw away real progress — the fix is
    // about FINISHED plans only.
    const p = new Plan('build the parser');
    p.addSteps(['design', 'implement']);
    p.steps[0].status = 'done';
    assert.strictEqual(p.isFinished, false);
    assert.strictEqual(shown(p).percent, 50, 'half done, and it stays half done');
  });

  await test('TURN B: the plan is RETIRED, not deleted — PLAN still shows the work', async () => {
    // Retiring is not forgetting. The pane that lists what was done must keep
    // listing it; only the claim "this is how far along the current work is"
    // goes away. Deleting the plan instead would pass the percentage test and
    // silently destroy the record.
    const { identify } = require('../../src/identify');
    const app = fakeApp(finishedPlan());
    await identify(app, 'also make it handle comments', { sameTask: true });
    const plan = app.session.plan;
    assert.ok(plan, 'the plan itself must survive');
    assert.strictEqual(plan.steps.length, 2, 'with its steps');
    assert.strictEqual(plan.isLive, false, 'but no longer as live progress');
  });

  await test('TURN B: the invariant holds however the submission is classified', async () => {
    // The property, stated once over every route through identify: after ANY
    // submission, a finished plan is never reported as progress in hand. This
    // is the assertion that survives the classifier changing its mind about
    // what counts as a steer, a continuation or a new task.
    const { identify } = require('../../src/identify');
    for (const text of [
      'also make it handle comments',
      'now write a completely different program',
      'why does the parser drop comments?',
      'fix the login bug in src/auth.js',
    ]) {
      const app = fakeApp(finishedPlan());
      await identify(app, text);
      assert.strictEqual(shown(app.session.plan).known, false,
        `a finished plan still read as live progress after: ${text}`);
    }
  });
};

/** The smallest app `identify` reads. */
function fakeApp(plan) {
  const { Task } = require('../../src/task');
  return {
    cfg: {},
    session: {
      cwd: process.cwd(),
      task: new Task('build the parser'),
      plan,
      lifecycle: null,
      mode: null,
      messages: [],
      turns: [],
    },
    ui: { enabled: false, clearExtras() {} },
    render: { write() {}, notice() {} },
    projectIsEmpty: () => false,
  };
}
