'use strict';

/**
 * COMPLETION — the two failures this file exists to prevent.
 *
 * 1. Completion that can never happen. `App.maybeComplete()` requires a
 *    finished plan, and for the whole of V2 the model had no way to write one.
 *    The completion screen, the progress bar and the plan view were therefore
 *    dead on every real task — found by running one, not by reading the code.
 *
 * 2. Completion that happens when it should not. Evidence answers "did anything
 *    happen", not "did it work", so a task that edited a file and left the test
 *    suite red satisfied it: the changed file counted and the failing run was
 *    never consulted.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Lifecycle } = require('../../src/lifecycle');
const { Plan } = require('../../src/plan');
const registry = require('../../src/tools');

function ctx(session) { return { cwd: process.cwd(), session }; }
function newSession() {
  return { plan: null, lifecycle: new Lifecycle('fix the login bug'), task: { objective: 'fix the login bug' } };
}
const edited = (life, file) => life.observeTool({ name: 'edit_file', input: { path: file }, output: 'ok', mutated: [file] });
const ran = (life, command, exitCode) => life.observeTool({
  name: 'run_bash', input: { command }, output: 'out', isError: exitCode !== 0, exitCode,
});

module.exports = async function () {
  // ---------------------------------------------------------- reachability ---

  await test('COMPLETION: the model can create a plan at all', async () => {
    const s = newSession();
    const r = await registry.execute('plan_write', { steps: ['find the bug', 'fix it', 'run the tests'] }, ctx(s));
    assert.ok(!r.isError, r.output);
    assert.strictEqual(s.plan.steps.length, 3);
    assert.strictEqual(s.plan.current().text, 'find the bug');
  });

  await test('COMPLETION: the model can finish a step, and the next becomes active', async () => {
    const s = newSession();
    await registry.execute('plan_write', { steps: ['a', 'b'] }, ctx(s));
    const r = await registry.execute('plan_step_done', { note: 'found it on line 41' }, ctx(s));
    assert.ok(!r.isError, r.output);
    assert.strictEqual(s.plan.completed.length, 1);
    assert.strictEqual(s.plan.completed[0].note, 'found it on line 41');
    assert.strictEqual(s.plan.current().text, 'b');
  });

  await test('COMPLETION: a plan the model finished reaches isFinished — the gate maybeComplete reads', async () => {
    const s = newSession();
    await registry.execute('plan_write', { steps: ['only step'] }, ctx(s));
    assert.strictEqual(s.plan.isFinished, false);
    await registry.execute('plan_step_done', { note: 'done' }, ctx(s));
    assert.strictEqual(s.plan.isFinished, true, 'this was unreachable before plan tools existed');
  });

  await test('COMPLETION: revising a plan keeps completed steps and replaces only the open ones', async () => {
    const s = newSession();
    await registry.execute('plan_write', { steps: ['a', 'b', 'c'] }, ctx(s));
    await registry.execute('plan_step_done', { note: 'a is done' }, ctx(s));
    await registry.execute('plan_write', { steps: ['different', 'approach'] }, ctx(s));
    const done = s.plan.completed;
    assert.strictEqual(done.length, 1);
    assert.strictEqual(done[0].text, 'a', 'completed work is evidence and is never rewritten');
    assert.strictEqual(done[0].note, 'a is done');
    assert.deepStrictEqual(s.plan.remaining.map((x) => x.text), ['different', 'approach']);
  });

  await test('COMPLETION: repeating the same plan is idempotent', async () => {
    const s = newSession();
    await registry.execute('plan_write', { steps: ['a', 'b', 'c'] }, ctx(s));
    await registry.execute('plan_step_done', { note: 'a is done' }, ctx(s));
    const before = JSON.stringify(s.plan);
    const r = await registry.execute('plan_write', { steps: ['b', 'c'] }, ctx(s));
    assert.ok(!r.isError, r.output);
    assert.match(r.output, /plan unchanged/);
    assert.strictEqual(r.meta.unchanged, true);
    assert.strictEqual(JSON.stringify(s.plan), before, 'an unchanged revision must not accumulate steps');
  });

  await test('COMPLETION: plan tools refuse politely with no plan and no session', async () => {
    const noPlan = await registry.execute('plan_step_done', { note: 'x' }, ctx(newSession()));
    assert.ok(noPlan.isError);
    assert.match(noPlan.output, /no plan/i);
    const noSession = await registry.execute('plan_write', { steps: ['a'] }, { cwd: process.cwd() });
    assert.ok(noSession.isError);
  });

  // ------------------------------------------------- a finished checklist ----

  await test('COMPLETION: a finished plan with NO evidence still does not complete', () => {
    const life = new Lifecycle('do a thing');
    const r = life.complete();
    assert.strictEqual(r.ok, false, 'ticking boxes is not doing work');
    assert.match(r.why, /no completion evidence/i);
  });

  await test('COMPLETION: a change plus a passing check completes', () => {
    const life = new Lifecycle('fix it');
    edited(life, '/p/src/auth.js');
    ran(life, 'npm test', 0);
    const r = life.complete();
    assert.strictEqual(r.ok, true, r.why);
    assert.match(r.why, /last check passed/);
  });

  // ------------------------------------------------ the red-check refusal ----

  await test('COMPLETION: a change whose LAST check FAILED does not complete', () => {
    const life = new Lifecycle('fix it');
    edited(life, '/p/src/auth.js');
    ran(life, 'npm test', 1);
    const r = life.complete();
    assert.strictEqual(r.ok, false, 'a red suite is not finished work, however much changed');
    assert.match(r.why, /last command failed/i);
    assert.match(r.why, /npm test/);
    assert.ok(r.failedCheck, 'the caller needs the failure to report it');
  });

  await test('COMPLETION: failing then FIXING then passing completes — it is the end state that counts', () => {
    const life = new Lifecycle('fix it');
    ran(life, 'npm test', 1);            // reproduce the bug
    edited(life, '/p/src/auth.js');      // fix it
    ran(life, 'npm test', 0);            // prove it
    const r = life.complete();
    assert.strictEqual(r.ok, true, r.why);
  });

  await test('COMPLETION: the user may overrule a failing check, nothing else may', () => {
    const life = new Lifecycle('fix it');
    edited(life, '/p/src/auth.js');
    ran(life, 'npm test', 1);
    assert.strictEqual(life.complete().ok, false);
    assert.strictEqual(life.complete({ userConfirmed: true }).ok, true, 'the user is allowed to say the failure is expected');
  });

  await test('COMPLETION: plan_step_done TELLS THE MODEL when the last check is red', async () => {
    const s = newSession();
    await registry.execute('plan_write', { steps: ['fix it'] }, ctx(s));
    edited(s.lifecycle, '/p/src/auth.js');
    ran(s.lifecycle, 'npm test', 1);
    const r = await registry.execute('plan_step_done', { note: 'fixed' }, ctx(s));
    // The model is the only party that can fix it, so the model must be told.
    assert.match(r.output, /NOT complete/);
    assert.match(r.output, /npm test/);
  });

  await test('COMPLETION: a red check survives /resume — it cannot be forgotten by restarting', () => {
    const life = new Lifecycle('fix it');
    edited(life, '/p/src/auth.js');
    ran(life, 'npm test', 1);
    const restored = Lifecycle.from(JSON.parse(JSON.stringify(life.toJSON())));
    assert.strictEqual(restored.complete().ok, false);
    assert.match(restored.complete().why, /last command failed/i);
  });

  await test('COMPLETION: a passing command with nothing changed is still evidence', () => {
    // A task that legitimately needed no edit — "does the suite pass?" — can
    // still complete. The gate is about a FAILING end state, not about edits.
    const life = new Lifecycle('check the build');
    ran(life, 'npm test', 0);
    assert.strictEqual(life.complete().ok, true);
  });

  await test('COMPLETION: verifiedChecks counts a clean command AFTER a change', () => {
    const life = new Lifecycle('fix it');
    ran(life, 'ls', 0);                       // before any change: not a verification
    assert.strictEqual(life.evidence.verifiedChecks, 0);
    edited(life, '/p/a.js');
    ran(life, 'npm test', 0);
    assert.strictEqual(life.evidence.verifiedChecks, 1);
  });
};
