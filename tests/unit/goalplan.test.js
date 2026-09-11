'use strict';

/**
 * GOAL, PLAN, PLAN_STEP and STEER — four concepts, and the rules that keep them
 * from collapsing into one.
 *
 *   GOAL       what the user is trying to achieve.        Durable. Theirs alone.
 *   PLAN       the current strategy for reaching it.      Revisable.
 *   PLAN_STEP  the execution steps being worked through.  The runtime's.
 *   STEER      a correction to work already in flight.    Momentary.
 *
 * Most of what is asserted here is a NEGATIVE — what each one may NOT do to the
 * others — because that is where the concepts actually blur: a goal quietly
 * rewritten by a turn is a second task objective, and a plan step a plain
 * message can append is a user notebook the runtime has to plan around.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const goal = require('../../src/goal');
const compose = require('../../src/composemode');
const plancompose = require('../../src/plancompose');
const { Plan, STATUS } = require('../../src/plan');
const { Session } = require('../../src/session');

/** A real App, with a fake line editor so the composer prefill is observable. */
function realApp() {
  const { App } = require('../../src/app');
  const app = new App({
    out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false },
    interactive: false,
    cwd: process.cwd(),
  });
  const notices = [];
  app.transient = (level, msg) => notices.push([level, msg]);
  app.notices = notices;
  // The one method composemode uses. Mirrors input.setLine's contract.
  app.input = { line: '', setLine(t) { this.line = String(t == null ? '' : t); return this.line; } };
  return app;
}

module.exports = async function () {
  // ------------------------------------------------------------------ goal --

  await test('GOAL: it is set, read back, and is not the task objective', () => {
    const s = new Session({ cwd: tmpdir('goal-') });
    assert.strictEqual(goal.text(s), '');
    goal.set(s, '  Stabilize LAIN CLI and finish Harness  ');
    assert.strictEqual(goal.text(s), 'Stabilize LAIN CLI and finish Harness');
    // A task objective is whatever started the current unit of work. Setting a
    // goal must not touch it, and vice versa.
    s.task = { objective: 'fix the checkout race' };
    assert.strictEqual(goal.text(s), 'Stabilize LAIN CLI and finish Harness');
    assert.strictEqual(s.task.objective, 'fix the checkout race');
  });

  await test('GOAL: rewriting keeps what it replaced', () => {
    // A person who rewrites a goal mid-project made a decision, and a session
    // that cannot say what changed cannot answer the question a resume asks.
    const s = new Session({ cwd: tmpdir('goal-') });
    goal.set(s, 'first direction');
    goal.set(s, 'second direction');
    assert.strictEqual(goal.text(s), 'second direction');
    assert.strictEqual(s.goal.history.length, 1);
    assert.strictEqual(s.goal.history[0].text, 'first direction');
  });

  await test('GOAL: it reaches the model as DIRECTION, never as this turn request', () => {
    const s = new Session({ cwd: tmpdir('goal-') });
    goal.set(s, 'ship the Harness');
    const p = goal.forPrompt(s);
    assert.match(p, /ship the Harness/);
    assert.match(p, /STANDING GOAL/);
    assert.match(p, /not this turn's request/i,
      'a model handed a goal as an instruction starts working on the goal');
    assert.strictEqual(goal.forPrompt(new Session({ cwd: tmpdir('g2-') })), '',
      'and no goal contributes nothing at all');
  });

  await test('GOAL: it survives save and resume', () => {
    const s = new Session({ cwd: tmpdir('goal-') });
    goal.set(s, 'stabilise and ship');
    s.save();
    const back = Session.resume(s.id);
    assert.strictEqual(goal.text(back), 'stabilise and ship');
  });

  await test('GOAL: a session file written before goals existed reads as no goal', () => {
    const fs = require('fs');
    const s = new Session({ cwd: tmpdir('goal-') });
    s.save();
    const data = JSON.parse(fs.readFileSync(s.file(), 'utf8'));
    delete data.goal;
    fs.writeFileSync(s.file(), JSON.stringify(data));
    assert.strictEqual(goal.text(Session.resume(s.id)), '');
  });

  await test('GOAL: only an explicit action changes it — never a turn', () => {
    // THE INVARIANT. Nothing in the turn path writes here, so a goal can be
    // left on screen and carried into a resumed session without being watched.
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'src');
    const allowed = new Set(['goal.js', 'goalcommand.js', 'composemode.js', 'session.js']);
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      if (allowed.has(f)) continue;
      const code = fs.readFileSync(path.join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/goal'\)\.set\(|goal\.set\(|session\.goal\s*=/.test(code)) offenders.push(f);
    }
    assert.deepStrictEqual(offenders, [], `these write the goal outside /goal: ${offenders.join(', ')}`);
  });

  // -------------------------------------------------------- goal composer --

  await test('GOAL COMPOSER: with no goal it opens empty', () => {
    const app = realApp();
    compose.open(app, compose.KIND.GOAL, { prefill: goal.text(app.session) });
    assert.strictEqual(app.input.line, '');
    assert.strictEqual(compose.label(app), 'GOAL');
  });

  await test('GOAL COMPOSER: with a goal it copies it back for EDITING', () => {
    // §15, and the whole reason the mode exists: a read-only panel would make
    // every revision a retype from memory.
    const app = realApp();
    goal.set(app.session, 'Stabilize LAIN CLI and finish Harness');
    compose.open(app, compose.KIND.GOAL, { prefill: goal.text(app.session) });
    assert.strictEqual(app.input.line, 'Stabilize LAIN CLI and finish Harness');
  });

  await test('GOAL COMPOSER: Enter commits the edited line', () => {
    const app = realApp();
    goal.set(app.session, 'old direction');
    compose.open(app, compose.KIND.GOAL, { prefill: 'old direction' });
    assert.strictEqual(compose.take(app, 'old direction, plus Computer MCP'), true);
    assert.strictEqual(goal.text(app.session), 'old direction, plus Computer MCP');
    assert.strictEqual(compose.pending(app), null, 'the composer closes behind it');
  });

  await test('GOAL COMPOSER: an empty line commits NOTHING', () => {
    // The least deliberate keystroke there is must not destroy durable
    // direction. Clearing is `/goal clear`, typed on purpose.
    const app = realApp();
    goal.set(app.session, 'keep me');
    compose.open(app, compose.KIND.GOAL, { prefill: 'keep me' });
    assert.strictEqual(compose.take(app, '   '), true);
    assert.strictEqual(goal.text(app.session), 'keep me');
  });

  await test('GOAL COMPOSER: Escape commits nothing and gives the line back', () => {
    const app = realApp();
    goal.set(app.session, 'keep me');
    compose.open(app, compose.KIND.GOAL, { prefill: 'keep me' });
    compose.cancel(app);
    assert.strictEqual(goal.text(app.session), 'keep me');
    assert.strictEqual(app.input.line, '');
    assert.strictEqual(compose.pending(app), null);
  });

  await test('COMPOSER: a composed line can never reach the model', () => {
    // THE SAFETY PROPERTY, and it is structural: App.handle returns before the
    // classifier. Asserted at the source rather than by driving a turn.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/app'), 'utf8');
    // SCOPED TO `handle`, which is the routing chain. `identify` is also a
    // METHOD DEFINITION earlier in the file, and comparing against that would
    // be comparing against where the function is written rather than where the
    // line is routed.
    const body = src.slice(src.indexOf('async handle(text'));
    assert.ok(body, 'App.handle must exist');
    const takeAt = body.indexOf("composemode').take(this, s)");
    const submitAt = body.indexOf('this.submit(s,');
    assert.ok(takeAt > 0, 'the composer is consumed in handle');
    assert.ok(submitAt > 0, 'and handle is what submits a real turn');
    assert.ok(takeAt < submitAt, 'the composer must be consumed before anything can submit the line');
    assert.match(body.slice(takeAt, takeAt + 60), /return/, 'and it returns rather than falling through');
    // AND BEFORE THE GATEWAY, so a composed line cannot be held, queued or
    // turned into a recovery either.
    const gateAt = body.indexOf("inputgate').admit");
    assert.ok(gateAt > takeAt, 'a composed line never reaches the input gateway');
  });

  // ------------------------------------------------------------------ plan --

  await test('PLAN COMPOSE: a typed line becomes ordered steps', () => {
    assert.deepStrictEqual(
      plancompose.split('inspect router → patch retry → run smoke'),
      ['inspect router', 'patch retry', 'run smoke'],
    );
    assert.deepStrictEqual(plancompose.split('a -> b; c'), ['a', 'b', 'c']);
    assert.deepStrictEqual(plancompose.split('1. first\n2. second'), ['first', 'second']);
    // A FULL STOP IS NOT A SEPARATOR: a step routinely carries a path or a
    // version, and "patch v1.2 handling" is one step and not two.
    assert.deepStrictEqual(plancompose.split('patch v1.2 handling'), ['patch v1.2 handling']);
  });

  await test('PLAN COMPOSE: reopening offers the REMAINING work, not the finished work', () => {
    const p = new Plan('o').addSteps(['done one', 'still to do', 'also to do']);
    p.complete('did it');
    assert.strictEqual(plancompose.asLine(p), 'still to do → also to do',
      'completed steps are evidence and are never offered for rewriting');
  });

  await test('PLAN REPLACE: the future is replaced and the evidence survives', () => {
    const app = realApp();
    app.session.plan = new Plan('o').addSteps(['finished', 'old next', 'old later']);
    app.session.plan.complete('proof');
    plancompose.commit(app, 'replace', 'new first → new second');
    const p = app.session.plan;
    const done = p.steps.filter((s) => s.status === STATUS.DONE);
    assert.strictEqual(done.length, 1);
    assert.strictEqual(done[0].text, 'finished');
    assert.strictEqual(done[0].note, 'proof', 'the evidence is untouched');
    assert.deepStrictEqual(p.remaining.map((s) => s.text), ['new first', 'new second']);
  });

  await test('PLAN ADD: an addition extends rather than replaces', () => {
    const app = realApp();
    app.session.plan = new Plan('o').addSteps(['keep me']);
    plancompose.commit(app, 'add', 'and this');
    assert.deepStrictEqual(app.session.plan.remaining.map((s) => s.text), ['keep me', 'and this']);
  });

  await test('PLAN: cancel mutates nothing', () => {
    const app = realApp();
    app.session.plan = new Plan('o').addSteps(['one', 'two']);
    const before = JSON.stringify(app.session.plan.steps);
    compose.open(app, compose.KIND.PLAN_REPLACE, { prefill: 'one → two' });
    compose.cancel(app);
    assert.strictEqual(JSON.stringify(app.session.plan.steps), before);
  });

  // ------------------------------------------------------------- plan_step --

  await test('PLAN_STEP: every step records WHO put it there', () => {
    const p = new Plan('o');
    p.addSteps(['runtime planned this']);                     // default
    p.addSteps(['the user composed this'], { origin: 'user' });
    p.steer('do not touch auth', { append: ['and this came from a steer'] });
    assert.deepStrictEqual(p.steps.map((s) => s.origin), ['llm', 'user', 'steer']);
  });

  await test('PLAN_STEP: a steer records its rationale even when it changes no step', () => {
    const p = new Plan('o').addSteps(['one']);
    p.steer('only test mobile');
    assert.ok(p.decisions.some((d) => d.text === 'only test mobile' && d.reason === 'user steer'));
  });

  await test('PLAN_STEP: a steer never rewrites finished work', () => {
    const p = new Plan('o').addSteps(['done', 'todo']);
    p.complete('evidence');
    p.steer('drop it', { drop: [1, 2], replace: [{ n: 1, text: 'rewritten' }] });
    assert.strictEqual(p.steps[0].status, STATUS.DONE);
    assert.strictEqual(p.steps[0].text, 'done', 'a completed step is evidence');
    assert.strictEqual(p.steps[1].status, STATUS.DROPPED);
  });

  await test('PLAN_STEP: ticking the last step does NOT retire the plan', () => {
    // ---- THIS PASS TRIED THE OBVIOUS THING AND WAS RIGHT TO BE STOPPED ---
    //
    // §21 asks for active plan_step state to clear when a plan finishes, and the
    // tempting place to do it is `complete()` when the last step ticks. That
    // retires the plan ON THE MODEL'S SAY-SO: a model marks its own steps done,
    // and completion in this program is settled from EVIDENCE, which can refuse.
    // tests/integration/continuation.test.js caught exactly that regression —
    // "implemented with every step ticked does NOT finish the task".
    const p = new Plan('o').addSteps(['one', 'two']);
    p.complete('a');
    p.complete('b');
    assert.strictEqual(p.isFinished, true, 'every step is ticked');
    assert.strictEqual(p.isLive, true, 'and the plan is still the work in hand until evidence says otherwise');
  });

  await test('PLAN_STEP: the ACTIVE projection clears through the EVIDENCE-GATED paths', () => {
    // §21, met by the two triggers that are answerable to evidence rather than
    // to the model: completion.js accepting the task, and identify.js finding a
    // finished plan when a NEW request arrives. Both are asserted at the source
    // because both live outside plan.js, which is the point.
    const fs = require('fs');
    const completion = fs.readFileSync(require.resolve('../../src/completion'), 'utf8');
    assert.match(completion, /plan\.retire\('task complete'\)/,
      'an ACCEPTED completion retires the plan');
    const identify = fs.readFileSync(require.resolve('../../src/identify'), 'utf8');
    assert.match(identify, /isLive && plan\.isFinished\) plan\.retire/,
      'and a finished plan does not survive into the next unrelated task');
    // AND NOTHING ELSE RETIRES ONE. A third trigger is how a plan comes to be
    // retired by something that has not looked at any evidence.
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'src');
    const allowed = new Set(['completion.js', 'identify.js', 'plan.js']);
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      if (allowed.has(f)) continue;
      const code = fs.readFileSync(path.join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/\.retire\(/.test(code)) offenders.push(f);
    }
    assert.deepStrictEqual(offenders, [], `these retire a plan: ${offenders.join(', ')}`);
  });

  await test('PLAN_STEP: a retired plan is history, and continued work reopens it', () => {
    const p = new Plan('o').addSteps(['one']);
    p.complete('done');
    p.retire('task complete');                 // as completion.js does, on evidence
    assert.strictEqual(p.isLive, false);
    // NOTHING IS DELETED — the steps, their notes and their stamps stay readable.
    assert.strictEqual(p.completed.length, 1);
    assert.strictEqual(p.completed[0].note, 'done');
    p.addSteps(['something else turned up']);
    assert.strictEqual(p.isLive, true, 'steps arriving after completion mean it was not complete');
  });

  await test('PLAN_STEP: an ordinary user message cannot append a step', () => {
    // §20. A plan step is EXECUTION state. The doors are the runtime, `/plan`
    // and `/steer` — a plain sentence is a request, and it goes to the model.
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'src');
    const allowed = new Set(['plan.js', 'plancompose.js', 'tools', 'turn.js', 'identify.js']);
    const offenders = [];
    const walk = (d, rel = '') => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { walk(path.join(d, e.name), path.join(rel, e.name)); continue; }
        if (!e.name.endsWith('.js')) continue;
        if (allowed.has(e.name) || allowed.has(rel)) continue;
        const code = fs.readFileSync(path.join(d, e.name), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/\.addSteps\(/.test(code)) offenders.push(path.join(rel, e.name));
      }
    };
    walk(dir);
    assert.deepStrictEqual(offenders, [], `these append plan steps: ${offenders.join(', ')}`);
  });
};
