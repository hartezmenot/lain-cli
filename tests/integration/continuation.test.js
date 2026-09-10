'use strict';

/**
 * THE TASK SURVIVES BEING INTERRUPTED — end to end, through the real App.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS FOR, and why it is one integration test rather than twenty unit
 * tests. The reported failure is not in any single module: task.js classifies
 * correctly, plan.js preserves completed steps correctly, and completion.js
 * demands evidence correctly. The suspicion is that they are wired together
 * wrongly — that a turn dying mid-flight, followed by the user saying something
 * else, produces a NEW task, a stale plan, and a summary for work that never
 * happened.
 *
 * So this drives the actual sequence:
 *
 *     task → plan → step done → PROVIDER DIES → user steers → continue
 *
 * and asserts what must be true afterwards. Every module is the real one; only
 * the network is a double (mockprovider.js), because the thing under test is
 * the state machine and not the wire.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

/** A scripted provider for one App, written to a temp file. */
function script(steps) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-cont-')), 'script.json');
  fs.writeFileSync(p, JSON.stringify(steps));
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = p;
  require('../../src/mockprovider')._reset();
  return p;
}

function newApp(cwd, { resume = null } = {}) {
  const { App } = require('../../src/app');
  return new App({
    out: { write() {}, on() {}, columns: 96, isTTY: false },
    interactive: false,
    cwd,
    ...(resume ? { resume } : {}),
  });
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-cont-cwd-'));
  fs.writeFileSync(path.join(dir, 'reconnect.js'), 'module.exports = { reconnect(){} };\n');
  return dir;
}

/**
 * REMOVE THE SANDBOX, TOLERATING THE GIT PREFETCH THAT IS STILL LETTING GO.
 *
 * ---- WHY A PLAIN rmSync IS NOT ENOUGH HERE, AND WHAT THIS IS NOT -----------
 *
 * `submit` fires `gitsnapshot.prefetch` deliberately unawaited — it measures
 * git state while the request is in flight so the section it feeds costs the
 * turn nothing. That spawns `git` with the SANDBOX as its working directory,
 * and on Windows a directory cannot be removed while any process has it as a
 * cwd. So the instant `submit` resolves there is a short window in which this
 * teardown gets EPERM, and it is nobody's bug: the child is short-lived, holds
 * no file open, and exits on its own.
 *
 * Measured rather than assumed: three consecutive runs failed immediately and
 * all three succeeded 600ms later.
 *
 * WHAT IS NOT BEING PAPERED OVER: a leak. If the directory is still held after
 * the budget below, this throws exactly as it always did.
 */
function removeSandbox(dir, budgetMs = 4000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
      if (Date.now() >= deadline) throw e;
      // A busy-wait, deliberately: this runs inside a `finally` that cannot
      // await, and the window being covered is tens of milliseconds.
      const until = Date.now() + 50;
      while (Date.now() < until) { /* let the child exit */ }
    }
  }
}

const PLAN = [
  { text: 'Planning the work.', tool_calls: [{ name: 'plan_write', input: { objective: 'fix the reconnect', steps: ['inspect provider', 'fix reconnect', 'test', 'summary'] } }] },
  { text: 'Provider inspected.', tool_calls: [{ name: 'plan_step_done', input: { n: 1, note: 'read the provider' } }] },
];

module.exports = async function () {
  if (process.platform === 'win32') {
    for (const persistent of [false, true]) {
      await test(`TEARDOWN: a ${persistent ? 'persistent cwd lock still fails visibly' : 'temporary cwd lock is retried until removal succeeds'}`, async () => {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lain-cwd-lock-'));
        const { spawnOwned, stopTree } = require('../../src/harness/processes');
        const child = spawnOwned({ command: process.execPath, cwd: dir, args: ['-e', persistent ? 'console.log("ready");setInterval(()=>{},1000)' : 'console.log("ready");setTimeout(()=>process.exit(0),300)'] });
        try {
          await require('events').once(child.stdout, 'data');
          if (persistent) {
            assert.throws(() => removeSandbox(dir, 100), /EPERM|EBUSY|ENOTEMPTY/);
            assert.ok(fs.existsSync(dir));
          } else {
            removeSandbox(dir, 4000);
            assert.ok(!fs.existsSync(dir));
          }
        } finally { await stopTree(child); removeSandbox(dir); }
      });
    }
  }
  await test('CONTINUATION: a provider death mid-task does NOT restart the task', async () => {
    const cwd = sandbox();
    // A QUOTA refusal, which is not retriable — so the turn dies once rather
    // than five times, and the test is about continuation rather than backoff.
    script([...PLAN, { error: { status: 429, message: 'You have reached the request limit' } }]);
    const app = newApp(cwd);
    try {
      await app.prepare();
      const first = await app.submit('fix the reconnect');

      // The turn really did die, and says so — otherwise the rest proves nothing.
      assert.strictEqual(first.stopReason, 'provider', `expected a provider death, got ${first.stopReason}`);
      const objective = app.session.task.objective;
      const plan = app.session.plan;
      assert.ok(plan, 'a plan was written before the failure');
      assert.strictEqual(plan.steps.length, 4);
      assert.strictEqual(plan.completed.length, 1, 'one step was genuinely finished');

      // ---- AND NOW THE USER SAYS SOMETHING ELSE --------------------------
      script([{ text: 'Noted.' }]);
      await app.submit('Also make the reconnect UI show latency.');

      assert.strictEqual(app.session.task.objective, objective,
        'the objective must survive — a steer adjusts the task, it does not replace it');
      assert.strictEqual(app.session.plan, plan, 'the SAME plan object, not a new one');
      assert.strictEqual(app.session.plan.steps.length, 4, 'no step was invented or lost');
      assert.strictEqual(app.session.plan.completed.length, 1, 'finished work stays finished');
      assert.strictEqual(app.session.plan.isLive, true, 'the plan is still the work in hand');
      assert.ok(app.session.task.steers.some((s) => /latency/.test(s.text)),
        'the steer is attached to the ACTIVE task');
    } finally {
      removeSandbox(cwd);
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });

  await test('CONTINUATION: the next request TELLS the model it was cut off, and where', async () => {
    // The handover gap. Compaction elides bodies and folds old exchanges; the
    // objective and the plan survive, and the fact that execution stopped at a
    // known point did not — so the next context read as a fresh start.
    const cwd = sandbox();
    // A QUOTA refusal, which is not retriable — so the turn dies once rather
    // than five times, and the test is about continuation rather than backoff.
    script([...PLAN, { error: { status: 429, message: 'You have reached the request limit' } }]);
    const app = newApp(cwd);
    try {
      await app.prepare();
      await app.submit('fix the reconnect');
      const sys = app.systemPrompt();
      assert.ok(/did NOT finish/.test(sys), `the interruption must reach the model:\n${sys.slice(-900)}`);
      assert.ok(/do not restart it/.test(sys), 'and it must say what to do about it');
      // The plan travels with it, so "continue from there" has a there.
      assert.ok(/inspect provider/.test(sys), 'the plan is in the prompt');
      assert.ok(/✓ 1\./.test(sys), 'including which step is already done');
    } finally {
      removeSandbox(cwd);
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });

  await test('CONTINUATION / T3: a RED CHECK survives the interruption, and no step is invented done', async () => {
    // Verified truth, in the packet's own words. The turn below really runs a
    // check that really fails (exit 1), really completes one plan step, and
    // then dies at the provider. What the next entry is told must come from the
    // runtime's own records — the exit code from lifecycle.lastCommand, the
    // plan position from the steps' `status` — not from anything the dead turn
    // said about itself.
    const cwd = sandbox();
    fs.writeFileSync(path.join(cwd, 'check.js'), 'process.exit(1);\n');
    script([
      { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { objective: 'fix the reconnect', steps: ['make the change', 'verify it'] } }] },
      { text: 'Reading the target first.', tool_calls: [{ name: 'read_file', input: { path: 'reconnect.js' } }] },
      { text: 'Editing.', tool_calls: [{ name: 'write_file', input: { path: 'reconnect.js', content: 'module.exports = { reconnect(){ return 1; } };\n' } }] },
      { text: 'Step 1 done.', tool_calls: [{ name: 'plan_step_done', input: { note: 'edited reconnect.js' } }] },
      { text: 'Verifying.', tool_calls: [{ name: 'run_bash', input: { command: 'node check.js' } }] },
      { error: { status: 429, message: 'You have reached the request limit' } },
    ]);
    const app = newApp(cwd);
    try {
      await app.prepare();
      const rec = await app.submit('make reconnect return 1');
      assert.strictEqual(rec.stopReason, 'provider', `expected the provider death, got ${rec.stopReason}`);

      // THE RECORDS, not the prose. The check is red in lifecycle, the plan is
      // half done by `status`, and nothing completed the task.
      const life = app.session.lifecycle;
      assert.strictEqual(life.lastCommand.ok, false, 'the failing check is the recorded verdict');
      assert.strictEqual(life.lastCommand.exitCode, 1, 'with the exit code the OS reported');
      assert.strictEqual(app.session.plan.completed.length, 1, 'the step that finished stays finished');
      assert.notStrictEqual(app.session.lifecycle.state, 'DONE', 'a red check completes nothing');

      // AND THE NEXT ENTRY IS TOLD, in the packet's own section headers.
      const sys = app.systemPrompt();
      assert.ok(/# Session handover/.test(sys), 'a dead turn makes the next request a handover');
      assert.ok(/Last check actually run: `node check\.js` — FAILED \(exit 1\)\./.test(sys),
        `the red check must reach the next entry as an exit code:\n${sys.slice(-1200)}`);
      assert.ok(/Plan: 1\/2 steps done\./.test(sys),
        'the position must come from the plan\'s own getters, and say which half is done');
      assert.ok(/Still outstanding:[\s\S]*- verify it/.test(sys),
        'the unfinished step, by name — "continue" needs a there');
    } finally {
      removeSandbox(cwd);
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });

  await test('CONTINUATION / T4: the SAME handover crosses a save/resume boundary', async () => {
    // C2: every entry is a re-entry, served by one builder. The turn below
    // dies at the provider and the session is auto-saved (app.js does this as
    // the turn ends); a NEW process resumes it by id, and the first prompt the
    // resumed app builds must carry the same packet lines the in-process one
    // would — same red check, same plan position — because both come from the
    // same records, not from memory of the conversation.
    const cwd = sandbox();
    fs.writeFileSync(path.join(cwd, 'check.js'), 'process.exit(1);\n');
    script([
      { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { objective: 'fix the reconnect', steps: ['make the change', 'verify it'] } }] },
      { text: 'Reading the target first.', tool_calls: [{ name: 'read_file', input: { path: 'reconnect.js' } }] },
      { text: 'Editing.', tool_calls: [{ name: 'write_file', input: { path: 'reconnect.js', content: 'module.exports = { reconnect(){ return 1; } };\n' } }] },
      { text: 'Step 1 done.', tool_calls: [{ name: 'plan_step_done', input: { note: 'edited reconnect.js' } }] },
      { text: 'Verifying.', tool_calls: [{ name: 'run_bash', input: { command: 'node check.js' } }] },
      { error: { status: 429, message: 'You have reached the request limit' } },
    ]);
    const app = newApp(cwd);
    let id = null;
    try {
      await app.prepare();
      const rec = await app.submit('make reconnect return 1');
      assert.strictEqual(rec.stopReason, 'provider');
      // The dead turn's state was persisted by the end-of-turn save; take the
      // id BEFORE the sandbox (and the session directory it names) is cleaned.
      // The objective is captured the same way — the TASK's, not the plan's,
      // and compared rather than hardcoded, because what is asserted is that
      // it SURVIVED, not what task.js happened to phrase it as.
      id = app.session.id;
      const objective = app.session.task.objective;
      assert.ok(require('../../src/session').Session.resume(id),
        'the saved session must be resumable — otherwise nothing below is honest');

      // ---- A NEW PROCESS, RESUMING BY ID ---------------------------------
      const app2 = newApp(cwd, { resume: id });
      await app2.prepare();
      // What survived: the task, the plan's own position, the verdict of the
      // check, and HOW the turn ended — the fact that arms the handover.
      assert.strictEqual(app2.session.task.objective, objective, 'the task survived the boundary');
      assert.strictEqual(app2.session.plan.completed.length, 1, 'and the step that finished');
      assert.strictEqual(app2.session.lifecycle.lastCommand.ok, false, 'and the red check');
      assert.strictEqual(app2.session.lifecycle.lastCommand.exitCode, 1);
      const last = app2.session.turns[app2.session.turns.length - 1];
      assert.strictEqual(last.stopReason, 'provider', 'and how the turn ended, which arms the handover');

      // And the next entry's briefing is the SAME packet, from the same
      // records — not a retelling by the process that happened to survive.
      const sys = app2.systemPrompt();
      assert.ok(/# Session handover/.test(sys), 'a resumed dead turn is a handover entry');
      assert.ok(/Last check actually run: `node check\.js` — FAILED \(exit 1\)\./.test(sys),
        `the red check crosses the boundary as an exit code:\n${sys.slice(-1200)}`);
      assert.ok(/Plan: 1\/2 steps done\./.test(sys), 'as does the plan\'s own position');
      assert.ok(/Still outstanding:[\s\S]*- verify it/.test(sys), 'and the step that is still to do');
      // The in-process prompt and the resumed one come from ONE builder; the
      // packet's facts must not depend on which process rendered them.
      const inproc = app.systemPrompt();
      for (const line of [/did NOT finish/, /FAILED \(exit 1\)/, /Plan: 1\/2 steps done\./]) {
        assert.ok(line.test(sys) && line.test(inproc),
          'the same packet serves both entries — in-process and resumed');
      }
    } finally {
      if (id) {
        try { fs.rmSync(path.join(require('../../src/config').sessionsDir(), `${id}.json`), { force: true }); } catch { /* already gone */ }
      }
      removeSandbox(cwd);
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });

  await test('CONTINUATION: a finished turn says NOTHING about being interrupted', async () => {
    // The counterpart. A handover note that appears on every turn is noise the
    // model learns to ignore, and it would be false besides.
    const cwd = sandbox();
    script([{ text: 'Nothing to do.' }]);
    const app = newApp(cwd);
    try {
      await app.prepare();
      await app.submit('what does reconnect.js export?');
      assert.ok(!/did NOT finish/.test(app.systemPrompt()), 'no interruption note on a clean turn');
    } finally {
      removeSandbox(cwd);
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });

  await test('COMPLETION: "implemented" with every step ticked does NOT finish the task', async () => {
    // The stale-plan symptom, as behaviour: the model ticks the last box and
    // says it is done, having changed a file and run nothing. The checklist is
    // a question; the evidence answers it.
    const cwd = sandbox();
    script([
      { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { objective: 'x', steps: ['edit it'] } }] },
      { text: 'Reading it first.', tool_calls: [{ name: 'read_file', input: { path: 'reconnect.js' } }] },
      { text: 'Editing.', tool_calls: [{ name: 'write_file', input: { path: 'reconnect.js', content: 'module.exports = { reconnect(){ return 1; } };\n' } }] },
      { text: 'Implemented.', tool_calls: [{ name: 'plan_step_done', input: { n: 1, note: 'edited' } }] },
    ]);
    const app = newApp(cwd);
    try {
      await app.prepare();
      await app.submit('make reconnect return 1');
      assert.strictEqual(app.session.plan.isFinished, true, 'every step really is ticked');
      assert.notStrictEqual(app.session.lifecycle.state, 'DONE',
        'a ticked checklist over an unverified change is not a finished task');
      assert.ok(app.pendingCompletion, 'and LAIN says why rather than going quiet');
      assert.ok(/nothing has been run to check/.test(app.pendingCompletion), app.pendingCompletion);
      assert.strictEqual(app.session.plan.isLive, true, 'the plan is not retired on a refusal');
    } finally {
      removeSandbox(cwd);
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });

  await test('QUOTA: an exhausted account is NOT retried, and the task survives intact', async () => {
    // ---- MEASURED OFF A REAL SESSION --------------------------------------
    //
    // The bridge answered 429 "You have reached the request limit". Nothing in
    // the quota pattern matched it, so it classified as a RATE limit and came
    // back retriable — and the loop sent five more requests, twenty seconds
    // apart, to a provider that had just said the account had no requests left.
    // A hundred seconds of waiting and five more refusals against the cap.
    const reqtrace = require('../../src/reqtrace');
    const cwd = sandbox();
    script([
      { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { objective: 'x', steps: ['a', 'b'] } }] },
      { error: { status: 429, message: 'You have reached the request limit' } },
    ]);
    reqtrace.reset();
    const app = newApp(cwd);
    try {
      await app.prepare();
      const started = Date.now();
      const rec = await app.submit('do the thing');
      assert.ok(rec.providerFailure, 'the failure is recorded on the turn');
      assert.strictEqual(rec.providerFailure.kind, 'QUOTA',
        `an exhausted request cap is a QUOTA, not a rate limit: ${rec.providerFailure.kind}`);
      const e = reqtrace.explain(rec.turnId);
      assert.strictEqual(e.retries, 0, `an exhausted quota is never retried: ${e.byReason}`);
      assert.ok(Date.now() - started < 20000, 'and nothing waited out a backoff for it');
      assert.strictEqual(app.session.plan.steps.length, 2, 'the plan is untouched');
      assert.notStrictEqual(app.session.lifecycle.state, 'DONE', 'a refusal completes nothing');
      assert.ok(app.session.task, 'and the task still exists');
    } finally {
      removeSandbox(cwd);
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });

  await test('REQUESTS: one ordinary turn costs one request per model step, and says so', async () => {
    // The provider-request audit, as an assertion. A tool loop of three steps
    // is three requests; anything else is a duplicate trigger and this is what
    // would catch it.
    const reqtrace = require('../../src/reqtrace');
    const cwd = sandbox();
    script([
      { text: 'Looking.', tool_calls: [{ name: 'read_file', input: { path: 'reconnect.js' } }] },
      { text: 'Looking again.', tool_calls: [{ name: 'read_file', input: { path: 'reconnect.js' } }] },
      { text: 'Done looking.' },
    ]);
    reqtrace.reset();
    const app = newApp(cwd);
    try {
      await app.prepare();
      const rec = await app.submit('what does reconnect.js export?');
      const e = reqtrace.explain(rec.turnId);
      assert.ok(e, 'the turn is traceable end to end');
      assert.strictEqual(e.steps, rec.steps, `one request per model step: ${e.requests} for ${rec.steps} steps`);
      assert.strictEqual(e.duplicated, 0, `no step was requested twice: ${e.byReason}`);
      assert.strictEqual(e.requests, rec.usage.requests,
        'the ledger and the turn record agree about how many requests happened');
    } finally {
      removeSandbox(cwd);
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });
};
