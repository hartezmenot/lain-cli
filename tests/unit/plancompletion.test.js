'use strict';

/**
 * A FINISHED PLAN IS NOT A FINISHED TASK.
 *
 * The defect these exist to prevent: `plan.isFinished` reaching true was enough
 * to end the task. The completion gate accepted on "did anything happen at all"
 * — one changed file, or one command run at any point — so the moment the last
 * step was ticked off, a task that had written code and verified NOTHING was
 * declared done and LAIN stopped.
 *
 * The rule now: the plan decides when it is worth ASKING. It never decides the
 * answer. Everything below is a case where the plan is at 100% and the task
 * must carry on regardless.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Lifecycle, STATE } = require('../../src/lifecycle');
const { Plan } = require('../../src/plan');
const views = require('../../src/ui/views');
const strip = require('../../src/ui/status');

const edited = (l, f) => l.observeTool({ name: 'write_file', input: { path: f }, output: 'ok', mutated: [f] });
const ran = (l, cmd, code) => l.observeTool({
  name: 'run_bash', input: { command: cmd }, output: '', isError: code !== 0, exitCode: code,
});

/** A plan whose every step is done — 100%, by construction. */
function finishedPlan() {
  const p = new Plan();
  p.addSteps(['implement it', 'check it']);
  p.complete('implemented');
  p.complete('checked');
  return p;
}

/** The app-level decision, without a terminal. */
function appWith(plan, life) {
  const { App } = require('../../src/app');
  const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
  app.session.plan = plan;
  app.session.lifecycle = life;
  app.session.task = new (require('../../src/task').Task)('do the work');
  return app;
}

module.exports = async function () {
  await test('PLAN100: the plan really does reach 100% — the premise of every case below', () => {
    const p = finishedPlan();
    assert.strictEqual(p.isFinished, true);
    assert.strictEqual(views.progressOf(p).percent, 100);
  });

  // TEST 1 — verification pending
  await test('PLAN100 + verification pending → CONTINUE', () => {
    const life = new Lifecycle('do the work');
    edited(life, '/p/src/a.js');
    const app = appWith(finishedPlan(), life);
    assert.strictEqual(app.maybeComplete({ text: 'All steps are complete.' }), false);
    assert.match(app.pendingCompletion, /nothing has been run to check/);
    assert.notStrictEqual(life.state, STATE.DONE);
  });

  // TEST 2 — the model says it has more to do
  await test('PLAN100 + the model says it has more to do → CONTINUE', () => {
    const life = new Lifecycle('do the work');
    edited(life, '/p/src/a.js');
    ran(life, 'npm test', 0);                       // even fully verified…
    const app = appWith(finishedPlan(), life);
    // …the model's own sentence outranks the checklist.
    assert.strictEqual(app.maybeComplete({ text: 'Implementation is complete. I still need to run the integration tests.' }), false);
    assert.match(app.pendingCompletion, /still has work/);
    assert.notStrictEqual(life.state, STATE.DONE);
  });

  // TEST 3 — a tool call is still required
  await test('PLAN100 + a tool call still required → CONTINUE', () => {
    const life = new Lifecycle('do the work');
    edited(life, '/p/src/a.js');
    const app = appWith(finishedPlan(), life);
    assert.strictEqual(app.maybeComplete({ text: 'Let me run the suite now.' }), false);
    assert.notStrictEqual(life.state, STATE.DONE);
  });

  // TEST 4 — verification failed
  await test('PLAN100 + verification FAILED → CONTINUE', () => {
    const life = new Lifecycle('do the work');
    edited(life, '/p/src/a.js');
    ran(life, 'pytest', 1);
    const app = appWith(finishedPlan(), life);
    assert.strictEqual(app.maybeComplete({ text: 'Done.' }), false);
    assert.match(app.pendingCompletion, /last command failed/i);
    assert.notStrictEqual(life.state, STATE.DONE);
  });

  // TEST 5 — a new discovery adds work after 100%
  await test('PLAN100 + a new discovery reopens the plan → CONTINUE', () => {
    const plan = finishedPlan();
    assert.strictEqual(plan.isFinished, true);
    // The existing plan architecture: revising it reopens the plan. No fake
    // percentages, no invented steps — the plan simply has more in it now.
    plan.addSteps(['fix the error found in dashboard.py']);
    assert.strictEqual(plan.isFinished, false, 'a reopened plan is not a finished one');
    const life = new Lifecycle('do the work');
    edited(life, '/p/src/a.js');
    ran(life, 'npm test', 0);
    const app = appWith(plan, life);
    assert.strictEqual(app.maybeComplete({ text: 'Found another error.' }), false, 'an unfinished plan is not even asked about');
  });

  // TEST 5b — a later, unrelated turn must not re-announce the same verdict
  await test('PLAN100: an unrelated later turn does not repeat the same notice', () => {
    // Reproduced against the real binary: after a plan reached 100% with
    // nothing verified, a completely unrelated follow-up ("check disk space
    // now") got its own unrelated answer AND the identical "Plan finished,
    // but the task is not complete" sentence again — the first turn's
    // unfinished business, pinned onto a turn that never touched the plan.
    const life = new Lifecycle('do the work');
    edited(life, '/p/src/a.js');
    const app = appWith(finishedPlan(), life);
    const notices = [];
    app.render.notice = (level, msg) => notices.push(msg);

    app.maybeComplete({ text: 'All steps are complete.' });
    app.maybeComplete({ text: 'ok for the unrelated follow-up.' });
    app.maybeComplete({ text: 'and once more.' });

    const said = notices.filter((m) => /not complete/.test(m));
    assert.strictEqual(said.length, 1, `the identical verdict must be announced once, not repeated: ${JSON.stringify(notices)}`);
  });

  // TEST 5c — a genuinely DIFFERENT reason, or a fresh plan, still gets said
  await test('PLAN100: a CHANGED reason, or a new plan, is announced again', () => {
    const life = new Lifecycle('do the work');
    const app = appWith(finishedPlan(), life);
    const notices = [];
    app.render.notice = (level, msg) => notices.push(msg);

    // First reason: nothing has been run at all.
    app.maybeComplete({ text: 'Done.' });
    // A command then runs and FAILS — a materially different reason.
    ran(life, 'pytest', 1);
    app.maybeComplete({ text: 'Done.' });
    assert.strictEqual(notices.filter((m) => /not complete/.test(m)).length, 2,
      'a genuinely different reason must still be said');

    // A brand new plan (a new task) gets its own first announcement even if
    // the generic wording happens to coincide with the old one.
    app.session.plan = finishedPlan();
    const life2 = new Lifecycle('a different task');
    edited(life2, '/p/src/b.js');
    app.session.lifecycle = life2;
    const notices2 = [];
    app.render.notice = (level, msg) => notices2.push(msg);
    app.maybeComplete({ text: 'Done.' });
    assert.strictEqual(notices2.filter((m) => /not complete/.test(m)).length, 1,
      'a fresh plan must not inherit the previous plan\'s dedup state');
  });

  // TEST 6 — a question is waiting
  await test('PLAN100 + ask_user waiting → WAITING FOR USER, never DONE', () => {
    // A panel open for a question is LAIN waiting on a person. The header word
    // must say so, whatever the plan or the lifecycle says.
    assert.strictEqual(
      views.statusOf({ awaitingUser: true, lifecycle: { state: 'DONE' } }),
      views.STATE.NEEDS_USER,
    );
  });

  // TEST 7 — a rate limit arrives
  await test('PLAN100 + rate limit → the retry state stands', () => {
    assert.strictEqual(
      views.statusOf({ phase: { phase: 'RETRYING' }, pendingCompletion: 'anything' }),
      views.STATE.WAITING,
      'a live phase outranks the completion question',
    );
  });

  // TEST 8 / 9 — external review or an MCP permission is still in flight
  await test('PLAN100 + external review or MCP still active → the live phase wins', () => {
    assert.strictEqual(
      views.statusOf({ phase: { phase: 'EXTERNAL', actor: 'EXTERNAL' }, pendingCompletion: 'x' }),
      views.STATE.WORKING,
      'ENDED is the only phase that falls through; a running one is never DONE',
    );
    const line = strip.statusStrip({ phase: { phase: 'EXTERNAL' }, pendingCompletion: 'x' }, 100, 1, 1000).join('');
    assert.match(line, /EXTERNAL/);
    assert.ok(!/DONE/.test(line), 'nothing may read as finished while a model is still working');
  });

  // TEST 10 — genuinely complete
  await test('PLAN100 + objective satisfied and verified → DONE', () => {
    const life = new Lifecycle('do the work');
    edited(life, '/p/src/a.js');
    ran(life, 'npm test', 0);
    const app = appWith(finishedPlan(), life);
    assert.strictEqual(app.maybeComplete({ text: 'Fixed the handler; the suite passes.' }), true);
    assert.strictEqual(life.state, STATE.DONE);
    assert.strictEqual(app.pendingCompletion, null);
  });

  // ---- what the screen says while the plan is finished and the task is not --

  await test('PLAN100: the STATUS never reads READY or DONE while work is outstanding', () => {
    assert.strictEqual(views.statusOf({ pendingCompletion: 'nothing has been run' }), views.STATE.VERIFYING);
    const line = strip.statusStrip({
      pendingCompletion: '1 file(s) changed but nothing has been run to check them',
      lastTurn: { toolCalls: 3, filesChanged: 1 },
    }, 100, 1, 1000).join('');
    assert.match(line, /Verifying/i);
    assert.match(line, /nothing has been run/);
    assert.ok(!/DONE/.test(line), 'DONE beside outstanding work is the most misleading thing it could say');
  });

  await test('PLAN100: a new turn clears the stale reason rather than carrying it', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'app.js'), 'utf8');
    // THE ORDER IS THE INVARIANT, not the argument list. `beginTurn` now takes
    // the task verdict (ui/alert.js decides from it whether this is a new
    // execution attempt), so matching `beginTurn()` literally asserted an arity
    // this test never cared about and failed on a change that kept the rule.
    assert.match(src, /this\.pendingCompletion = null;[\s\S]{0,200}beginTurn\(/,
      'submit() must reset it, or VERIFYING sticks to the screen for ever');
  });

  await test('PLAN100: the plan is NOT an input to the completion gate at all', () => {
    // The coupling, in one assertion: lifecycle.complete() decides completion
    // and must not be able to see a plan, so a finished plan cannot reach it.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'lifecycle.js'), 'utf8');
    // Comments are stripped: the code may NAME the bug it no longer has.
    const body = src.slice(src.indexOf('  complete({'), src.indexOf('  summary('))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(!/\bplan\b/i.test(body), 'the completion gate must never consult the plan');
  });

  await test('PLAN100: a COMPLETED task, and its progress, cannot leak into the next turn', () => {
    // REPRODUCED EXACTLY AS REPORTED: turn A finishes, and the status strip
    // above the input goes on reading `STEP 2/2 ████ 100%` — through the idle
    // prompt and into the whole of turn B, above a model that had not yet
    // decided whether it needed a plan at all.
    //
    // The cause was not the display. `progressOf` read `session.plan`
    // unconditionally, and a plan is not deleted when its task completes —
    // the PLAN pane is the record of what was done. So the session's last plan
    // was permanently "the current progress". A plan now knows when it stopped
    // being the work in hand (plan.js `retiredAt`), and every surface that
    // draws progress asks `views.livePlan` for it.
    const life = new Lifecycle('do the work');
    edited(life, '/p/src/a.js');
    ran(life, 'npm test', 0);
    const plan = finishedPlan();
    const app = appWith(plan, life);

    assert.strictEqual(views.progressOf(plan).percent, 100, 'before: the plan really is at 100%');
    assert.strictEqual(app.maybeComplete({ text: 'Fixed the handler; the suite passes.' }), true);

    // AFTER: the plan is retired, so it is no longer anybody's live progress…
    assert.ok(plan.retiredAt, 'completing the task retires the plan');
    assert.strictEqual(views.livePlan(app.session), null);
    assert.strictEqual(views.progressOf(views.livePlan(app.session)).known, false);
    const line = strip.statusStrip({
      phase: { phase: 'THINKING' },
      progress: views.progressOf(views.livePlan(app.session)),
    }, 100, 1, 1000).join('');
    assert.ok(!/100%/.test(line), `turn B must start with no progress: ${line}`);
    assert.ok(!/STEP/.test(line), line);

    // …AND THE RECORD IS NOT DESTROYED. The PLAN pane still shows what was done.
    assert.strictEqual(app.session.plan, plan, 'the plan is retired, never deleted');
    assert.strictEqual(views.progressOf(plan).percent, 100, 'and it still reads 100% as history');
  });

  await test('PLAN100: NEW WORK reopens a retired plan — the work outranks the verdict', () => {
    // The other half. A task called done, then found not to be, must show real
    // progress again rather than staying silent because of an earlier verdict.
    const life = new Lifecycle('do the work');
    edited(life, '/p/src/a.js');
    ran(life, 'npm test', 0);
    const plan = finishedPlan();
    const app = appWith(plan, life);
    app.maybeComplete({ text: 'Done; the suite passes.' });
    assert.strictEqual(views.livePlan(app.session), null);

    plan.addSteps(['fix the error found in dashboard.py']);
    assert.strictEqual(plan.retiredAt, null, 'adding work reopens the plan');
    assert.strictEqual(views.livePlan(app.session), plan);
    assert.strictEqual(views.progressOf(views.livePlan(app.session)).percent, 67);
  });

  await test('PLAN100: retirement survives a save/restore round trip', () => {
    // A resumed session must not come back showing the last task's 100%.
    const { Plan } = require('../../src/plan');
    const plan = finishedPlan();
    plan.retire('task complete');
    const back = Plan.from(JSON.parse(JSON.stringify(plan.toJSON())));
    assert.ok(back.retiredAt, 'a retired plan is still retired after a reload');
    assert.strictEqual(back.isLive, false);
    assert.strictEqual(views.livePlan({ plan: back }), null);
  });

  await test('PLAN100: steering still works with the plan at 100%', () => {
    // A task that is still open must still be steerable — the plan being
    // finished is not a reason to refuse a correction.
    const life = new Lifecycle('do the work');
    edited(life, '/p/src/a.js');
    const app = appWith(finishedPlan(), life);
    app.maybeComplete({ text: 'All steps done.' });
    assert.ok(app.pendingCompletion, 'the task is still open');
    assert.strictEqual(app.queueSteer('also check the dashboard process is alive'), true);
    // `{ text, mode }` — a steer waits for the work in flight by default and is
    // promoted to NOW by a second Enter. The property here is unchanged.
    assert.deepStrictEqual(app.steerQueue,
      [{ text: 'also check the dashboard process is alive', mode: 'WAIT' }]);
  });
};
