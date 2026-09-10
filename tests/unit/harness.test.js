'use strict';

/**
 * THE TASK RUNTIME — states, transitions, the record, the flight log, hooks.
 *
 * The failure paths are the point. A state machine tested only on its happy
 * path is a state machine that will be walked backwards the first time
 * something goes wrong, and the whole reason this one exists is that a task
 * must not be able to reach PASSED by any route except evidence.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const state = require('../../src/harness/state');
const { TaskRecord } = require('../../src/harness/record');
const { TaskRuntime } = require('../../src/harness/runtime');
const { ArtifactStore, KIND } = require('../../src/harness/artifacts');
const { Hooks, POINT } = require('../../src/harness/hooks');
const { EventBus, EVENT } = require('../../src/events');
const { STATE } = state;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lain-harness-')); }

module.exports = async function () {
  // ------------------------------------------------------------- the states --

  await test('STATE: a task cannot reach PASSED without being verified', () => {
    // THE SINGLE MOST IMPORTANT ASSERTION IN THE HARNESS. Every route to PASSED
    // goes through VERIFYING, so no task is ever passed without having been
    // checked.
    assert.strictEqual(state.transition(STATE.PLANNED, STATE.PASSED).ok, false);
    assert.strictEqual(state.transition(STATE.RUNNING, STATE.PASSED).ok, false);
    assert.strictEqual(state.transition(STATE.BLOCKED, STATE.PASSED).ok, false);
    assert.strictEqual(state.transition(STATE.VERIFYING, STATE.PASSED).ok, true);
    // and VERIFYING itself is only reachable from RUNNING
    const reachers = state.NAMES.filter((s) => state.moves(s).includes(STATE.VERIFYING));
    assert.deepStrictEqual(reachers, [STATE.RUNNING]);
  });

  await test('STATE: a terminal state is never rewritten', () => {
    for (const term of [...state.TERMINAL]) {
      for (const next of state.NAMES) {
        if (next === term) continue;
        const v = state.transition(term, next);
        assert.strictEqual(v.ok, false, `${term} -> ${next} must be refused`);
        assert.match(v.why, /terminal state is never rewritten/);
      }
    }
  });

  await test('STATE: a refusal names what CAN reach the state, for a person', () => {
    const v = state.transition(STATE.PLANNED, STATE.PASSED);
    assert.strictEqual(v.ok, false);
    assert.match(v.why, /VERIFYING/, 'the sentence must say where PASSED comes from');
  });

  await test('STATE: INCONCLUSIVE is its own outcome, not a flavour of failure', () => {
    assert.ok(state.TERMINAL.has(STATE.INCONCLUSIVE));
    assert.ok(state.VERDICT.has(STATE.INCONCLUSIVE));
    assert.strictEqual(state.fromVerdict('INCONCLUSIVE'), STATE.INCONCLUSIVE);
    assert.notStrictEqual(state.fromVerdict('INCONCLUSIVE'), state.fromVerdict('FAILED'));
  });

  await test('STATE: lifecycle DONE means VERIFYING, never PASSED', () => {
    // A model that stopped talking has stopped talking. That is a fact about
    // the conversation and not about the work.
    assert.strictEqual(state.fromLifecycle('DONE'), STATE.VERIFYING);
    assert.strictEqual(state.fromLifecycle('BLOCKED'), STATE.BLOCKED);
    assert.strictEqual(state.fromLifecycle('NEEDS_USER'), STATE.BLOCKED);
    assert.strictEqual(state.fromLifecycle('NEEDS_AUTH'), STATE.BLOCKED);
    assert.strictEqual(state.fromLifecycle('FAILED'), STATE.FAILED);
    assert.strictEqual(state.fromLifecycle('ACTIVE'), null, 'ACTIVE says nothing about the task');
  });

  await test('STATE: the transition table has no state without an answer', () => {
    for (const s of state.NAMES) assert.ok(Array.isArray(state.moves(s)), `${s} has no move list`);
    assert.deepStrictEqual(state.moves('NOT_A_STATE'), []);
  });

  // ------------------------------------------------------------- the record --

  await test('RECORD: every state change is kept, in order, with its reason', () => {
    const t = new TaskRecord({ title: 'x', objective: 'x' });
    t.moveTo(STATE.RUNNING, 'started');
    t.moveTo(STATE.VERIFYING, 'the model stopped');
    assert.deepStrictEqual(t.history.map((h) => `${h.from}->${h.to}`), ['PLANNED->RUNNING', 'RUNNING->VERIFYING']);
    assert.strictEqual(t.history[1].why, 'the model stopped');
  });

  await test('RECORD: an illegal move changes nothing at all', () => {
    const t = new TaskRecord({ title: 'x' });
    const before = { state: t.state, history: t.history.length };
    const v = t.moveTo(STATE.PASSED, 'wishful');
    assert.strictEqual(v.ok, false);
    assert.strictEqual(t.state, before.state);
    assert.strictEqual(t.history.length, before.history);
  });

  await test('RECORD: verifications APPEND — a second attempt never erases the first', () => {
    const t = new TaskRecord({ title: 'x' });
    t.noteVerification({ verdict: 'FAILED', failed: 1, why: 'the browser flow failed' });
    t.noteVerification({ verdict: 'PASSED', passed: 3, why: 'all good' });
    assert.strictEqual(t.verifications.length, 2);
    assert.strictEqual(t.verifications[0].verdict, 'FAILED', 'the first verdict survives');
    assert.strictEqual(t.lastVerification.verdict, 'PASSED');
  });

  await test('RECORD: it round-trips through JSON without losing its history', () => {
    const t = new TaskRecord({ title: 'round trip', objective: 'obj', sessionId: 's1' });
    t.moveTo(STATE.RUNNING, 'go');
    t.noteProcess({ processId: 'p1', name: 'frontend', port: 5173, status: 'RUNNING' });
    t.noteVerification({ verdict: 'FAILED', failed: 1, why: 'red' });
    const back = TaskRecord.from(JSON.parse(JSON.stringify(t.toJSON())));
    assert.strictEqual(back.id, t.id);
    assert.strictEqual(back.state, STATE.RUNNING);
    assert.strictEqual(back.processes[0].port, 5173);
    assert.strictEqual(back.verifications[0].verdict, 'FAILED');
    assert.strictEqual(back.history.length, 1);
  });

  await test('RECORD: noteProcess REPLACES a process rather than duplicating it', () => {
    const t = new TaskRecord({ title: 'x' });
    t.noteProcess({ processId: 'p1', name: 'api', status: 'STARTING' });
    t.noteProcess({ processId: 'p1', name: 'api', status: 'RUNNING', health: 'HEALTHY' });
    assert.strictEqual(t.processes.length, 1);
    assert.strictEqual(t.processes[0].status, 'RUNNING');
  });

  // ------------------------------------------------------------ the runtime --

  await test('RUNTIME: there is no method that can mark a task done', () => {
    // Enforced structurally rather than by convention. `settle` takes a
    // verification result and nothing else does.
    const r = new TaskRuntime({ persist: false });
    for (const forbidden of ['complete', 'markDone', 'succeed', 'pass', 'finish']) {
      assert.strictEqual(typeof r[forbidden], 'undefined', `TaskRuntime.${forbidden} must not exist`);
    }
  });

  await test('RUNTIME: settle is the only route to PASSED, and it needs a verdict', async () => {
    const r = new TaskRuntime({ persist: false });
    const t = r.create({ title: 'work' });
    r.start(t.id);
    r.verifying(t.id);
    assert.strictEqual(r.settle(t.id, { verdict: 'NONSENSE' }).ok, false);
    assert.strictEqual(r.get(t.id).state, STATE.VERIFYING, 'a bad verdict changes nothing');
    r.settle(t.id, await require('../../src/harness/verify').run([{ checks: [{ kind: 'file', path: __filename }] }], { taskId: t.id }));
    assert.strictEqual(r.get(t.id).state, STATE.PASSED);
  });

  await test('RUNTIME: a task that FAILED gets a repair task, not a rewind', async () => {
    const r = new TaskRuntime({ persist: false });
    const t = r.create({ title: 'fix login' });
    r.start(t.id);
    r.verifying(t.id);
    r.settle(t.id, await require('../../src/harness/verify').run([{ checks: [{ kind: 'file', path: __filename + '.absent' }] }], { taskId: t.id }));
    assert.strictEqual(r.get(t.id).state, STATE.FAILED);
    const repair = r.repairFor(t.id);
    assert.ok(repair && repair.id !== t.id);
    assert.strictEqual(repair.causedBy, t.id);
    assert.strictEqual(r.get(t.id).state, STATE.FAILED, 'the original verdict still stands');
  });

  await test('RUNTIME: a refused transition is reported and never throws', () => {
    const r = new TaskRuntime({ persist: false });
    const t = r.create({ title: 'x' });
    const v = r.start('no-such-task');
    assert.strictEqual(v.ok, false);
    assert.match(v.why, /no such task/);
    r.cancel(t.id, 'user asked');
    const after = r.start(t.id);
    assert.strictEqual(after.ok, false, 'a cancelled task cannot be restarted');
  });

  await test('RUNTIME: every state change is announced on the SHARED bus', async () => {
    const bus = new EventBus();
    const seen = [];
    bus.on((e) => seen.push(e.type));
    const r = new TaskRuntime({ bus, persist: false });
    const t = r.create({ title: 'x' });
    r.start(t.id);
    r.verifying(t.id);
    r.settle(t.id, await require('../../src/harness/verify').run([{ checks: [{ kind: 'file', path: __filename }] }], { taskId: t.id }));
    assert.ok(seen.includes(EVENT.TASK_CREATED));
    assert.ok(seen.includes(EVENT.TASK_STARTED));
    assert.ok(seen.includes(EVENT.VERIFICATION_STARTED));
    assert.ok(seen.includes(EVENT.VERIFICATION_PASSED));
    assert.ok(seen.includes(EVENT.TASK_COMPLETED));
    assert.strictEqual(seen.filter((x) => x === EVENT.TASK_STATE).length, 3, 'one task.state per real move');
  });

  await test('RUNTIME: a duplicate move emits nothing and stays legal', () => {
    const bus = new EventBus();
    const r = new TaskRuntime({ bus, persist: false });
    const t = r.create({ title: 'x' });
    r.start(t.id);
    const before = bus.recent(200).length;
    const again = r.start(t.id);
    assert.strictEqual(again.ok, true, 'moving to the state you are already in is not an error');
    assert.strictEqual(bus.recent(200).length, before, 'and it announces nothing');
  });

  await test('RUNTIME: the model thinking is NOT written to the flight recorder', () => {
    // It fires per reasoning chunk and would be most of the file. The
    // transcript already has it.
    const dir = tmp();
    const bus = new EventBus();
    const r = new TaskRuntime({ bus, workspace: dir, persist: true });
    const t = r.create({ title: 'x' });
    bus.emit(EVENT.MODEL_THINKING, { chunk: 'hmm' });
    bus.emit(EVENT.TOOL_STARTED, { tool: 'read_file', target: 'a.js' });
    const log = r.store.events(t.id);
    assert.ok(log.some((e) => e.type === EVENT.TOOL_STARTED));
    assert.ok(!log.some((e) => e.type === EVENT.MODEL_THINKING));
  });

  await test('RUNTIME: events emitted by anything at all land in the active task log', () => {
    // The property that makes the timeline complete without every emitter
    // knowing the recorder exists.
    const dir = tmp();
    const bus = new EventBus();
    const r = new TaskRuntime({ bus, workspace: dir, persist: true });
    const t = r.create({ title: 'x' });
    bus.emit(EVENT.JOB_STARTED, { command: 'npm test' });
    bus.emit(EVENT.QUESTION_PRESENTED, { question: 'which one?' });
    const types = r.store.events(t.id).map((e) => e.type);
    assert.ok(types.includes(EVENT.JOB_STARTED));
    assert.ok(types.includes(EVENT.QUESTION_PRESENTED));
    assert.strictEqual(r.get(t.id).eventCount, types.length);
  });

  await test('RUNTIME: events after a task ends are not attributed to it', () => {
    const dir = tmp();
    const bus = new EventBus();
    const r = new TaskRuntime({ bus, workspace: dir, persist: true });
    const t = r.create({ title: 'x' });
    r.start(t.id);
    r.cancel(t.id, 'done with it');
    const before = r.store.events(t.id).length;
    bus.emit(EVENT.TOOL_STARTED, { tool: 'grep' });
    assert.strictEqual(r.store.events(t.id).length, before, 'a finished task stops collecting');
  });

  await test('RUNTIME: attaching twice does not double-log', () => {
    const dir = tmp();
    const bus = new EventBus();
    const r = new TaskRuntime({ bus, workspace: dir, persist: true });
    r.attach(bus);
    const t = r.create({ title: 'x' });
    bus.emit(EVENT.TOOL_STARTED, { tool: 'grep' });
    const hits = r.store.events(t.id).filter((e) => e.type === EVENT.TOOL_STARTED);
    assert.strictEqual(hits.length, 1);
  });

  // ---------------------------------------------------------- the artifacts --

  await test('ARTIFACTS: what is kept is addressable afterwards', () => {
    const dir = tmp();
    const store = new ArtifactStore(dir);
    const rec = store.put('t1', { kind: KIND.TEST, name: 'suite.txt', body: '1745 passed', note: 'the project suite' });
    assert.ok(rec && rec.id);
    assert.ok(fs.existsSync(rec.path));
    assert.strictEqual(store.bytes('t1', rec.id).toString('utf8'), '1745 passed');
    assert.strictEqual(store.index('t1').length, 1);
    assert.strictEqual(store.index('t1')[0].note, 'the project suite');
  });

  await test('ARTIFACTS: a screenshot stays bytes and is not mangled into text', () => {
    const dir = tmp();
    const store = new ArtifactStore(dir);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const rec = store.put('t1', { kind: KIND.SCREENSHOT, name: 'page.png', body: png });
    assert.deepStrictEqual(store.bytes('t1', rec.id), png);
  });

  await test('ARTIFACTS: an unwritable store REPORTS and never throws', () => {
    // A read-only checkout is a state. The work that produced the evidence must
    // not die because the receipts could not be filed.
    //
    // A FILE WHERE A DIRECTORY MUST GO is the portable way to make a write
    // genuinely impossible: `mkdir` under it fails with ENOTDIR on POSIX and
    // ENOENT on Windows, on every machine, with no exotic path bytes. The first
    // version of this test used a NUL in the path and tripped the architecture
    // guard against control bytes in source, which is that guard working.
    const blocker = path.join(tmp(), 'not-a-directory');
    fs.writeFileSync(blocker, 'i am a file');
    const store = new ArtifactStore(path.join(blocker, 'project'));
    const rec = store.put('t1', { kind: KIND.LOG, name: 'x.txt', body: 'hello' });
    assert.strictEqual(rec, null);
    assert.ok(store.lastError, 'and it says why');
  });

  await test('ARTIFACTS: an unknown kind is refused rather than filed somewhere odd', () => {
    const store = new ArtifactStore(tmp());
    assert.strictEqual(store.put('t1', { kind: 'whatever', name: 'x', body: '' }), null);
    assert.match(store.lastError, /unknown artifact kind/);
  });

  await test('ARTIFACTS: a torn last line does not lose the whole flight log', () => {
    const dir = tmp();
    const store = new ArtifactStore(dir);
    store.appendEvent('t1', { type: 'a', at: 1 });
    store.appendEvent('t1', { type: 'b', at: 2 });
    fs.appendFileSync(path.join(store.dirFor('t1'), 'events.jsonl'), '{"type":"c",');
    const events = store.events('t1');
    assert.strictEqual(events.length, 2, 'the intact lines are still readable');
  });

  await test('ARTIFACTS: a task id with a path traversal in it cannot escape .lain', () => {
    const dir = tmp();
    const store = new ArtifactStore(dir);
    const d = store.dirFor('../../../etc');
    assert.ok(path.resolve(d).startsWith(path.resolve(dir)), `${d} escaped the project`);
  });

  await test('ARTIFACTS: a task that has done NOTHING writes nothing to disk', () => {
    // ---- THE REGRESSION A SMOKE TEST CAUGHT ------------------------------
    //
    // "a failure BEFORE any tool leaves the working tree untouched" has been
    // guarding this property for months. A turn that died at the transport —
    // a 502, before a single tool call — was creating `.lain/tasks/<id>/` and
    // leaving it in somebody's project. Persistence is now ARMED by the first
    // MATERIAL event, and creating and starting a task are not material.
    const dir = tmp();
    const bus = new EventBus();
    const r = new TaskRuntime({ bus, workspace: dir, persist: true });
    const t = r.create({ title: 'nothing happens' });
    r.start(t.id);
    assert.strictEqual(fs.existsSync(path.join(dir, '.lain')), false,
      'a task that never did anything must leave no trace');
    assert.strictEqual(r.store.loadTask(t.id), null);
  });

  await test('ARTIFACTS: the first material fact arms it, and NO history is lost', () => {
    const dir = tmp();
    const bus = new EventBus();
    const r = new TaskRuntime({ bus, workspace: dir, persist: true });
    const t = r.create({ title: 'persisted', objective: 'o' });
    r.start(t.id, 'go');
    bus.emit(EVENT.TOOL_STARTED, { tool: 'read_file', target: 'a.js' });
    const back = r.store.loadTask(t.id);
    assert.ok(back, 'a tool call is material — the record must be on disk');
    assert.strictEqual(back.state, STATE.RUNNING);
    assert.strictEqual(back.title, 'persisted');
    // THE LOG STARTS AT THE BEGINNING, not at the first tool call. The events
    // that preceded arming are flushed in order.
    const types = r.store.events(t.id).map((e) => e.type);
    assert.strictEqual(types[0], EVENT.TASK_CREATED, types.join(', '));
    assert.ok(types.includes(EVENT.TOOL_STARTED));
    assert.ok(r.store.listTasks().some((x) => x.id === t.id));
  });

  await test('ARTIFACTS: keeping an artifact is material by definition', () => {
    // It is bytes going to disk; the record they belong to must be saved with
    // them or the receipts reference a task nothing recorded.
    const dir = tmp();
    const r = new TaskRuntime({ workspace: dir, persist: true });
    const t = r.create({ title: 'kept' });
    r.start(t.id);
    assert.ok(r.keep(t.id, { kind: KIND.LOG, name: 'x.txt', body: 'hello' }));
    assert.ok(r.store.loadTask(t.id), 'the task record must be saved beside its artifact');
  });

  await test('ARTIFACTS: each task earns its own directory — arming is per task', () => {
    const dir = tmp();
    const bus = new EventBus();
    const r = new TaskRuntime({ bus, workspace: dir, persist: true });
    const first = r.create({ title: 'does work' });
    r.start(first.id);
    bus.emit(EVENT.TOOL_STARTED, { tool: 'grep' });
    assert.ok(r.store.loadTask(first.id), 'the first task did something');
    const second = r.create({ title: 'does nothing' });
    r.start(second.id);
    assert.strictEqual(r.store.loadTask(second.id), null,
      'a later task that does nothing must not inherit the first one arming');
  });

  await test('ARTIFACTS: the drawer is BOUNDED, oldest first', () => {
    const dir = tmp();
    const store = new ArtifactStore(dir);
    for (let i = 0; i < 6; i++) {
      store.saveTask({ id: `t${i}`, state: 'PASSED', updatedAt: i, toJSON() { return { id: `t${i}`, state: 'PASSED' }; } });
    }
    const removed = store.prune(3);
    assert.strictEqual(removed.length, 3, 'three beyond the cap of three');
    assert.strictEqual(store.listTasks().length, 3);
  });

  await test('ARTIFACTS: pruning NEVER removes a task that is still going', () => {
    // An unfinished task's evidence is the evidence somebody is about to want.
    const dir = tmp();
    const store = new ArtifactStore(dir);
    for (let i = 0; i < 5; i++) {
      const state = i === 0 ? 'RUNNING' : 'PASSED';   // the OLDEST is still live
      store.saveTask({ id: `t${i}`, state, toJSON() { return { id: `t${i}`, state }; } });
    }
    store.prune(1);
    const left = store.listTasks().map((t) => t.id);
    assert.ok(left.includes('t0'), `a RUNNING task was pruned: ${left.join(', ')}`);
  });

  await test('ARTIFACTS: under the cap, nothing is touched at all', () => {
    const store = new ArtifactStore(tmp());
    store.saveTask({ id: 'only', state: 'PASSED', toJSON() { return { id: 'only', state: 'PASSED' }; } });
    assert.deepStrictEqual(store.prune(200), []);
    assert.strictEqual(store.listTasks().length, 1);
  });

  // --------------------------------------------------------------- the hooks --

  await test('HOOKS: an unknown point is refused at registration, not silently dead', () => {
    const h = new Hooks();
    assert.throws(() => h.on('whenever.i.feel.like.it', 'x', () => {}), /unknown hook point/);
  });

  await test('HOOKS: a hook that throws is dropped and the work carries on', () => {
    const h = new Hooks();
    const ran = [];
    h.on(POINT.TASK_STARTED, 'bad', () => { throw new Error('fell over'); });
    h.on(POINT.TASK_STARTED, 'good', () => ran.push('good'));
    const reported = [];
    h.fire(POINT.TASK_STARTED, {}, (r) => reported.push(r));
    assert.deepStrictEqual(ran, ['good']);
    assert.strictEqual(h.failures.length, 1);
    assert.strictEqual(reported.filter((r) => !r.ok).length, 1, 'the failure is reported, not hidden');
  });

  await test('HOOKS: a hook cannot decide anything — its return value is ignored', () => {
    const h = new Hooks();
    h.on(POINT.AFTER_VERIFICATION, 'liar', () => ({ verdict: 'PASSED' }));
    assert.strictEqual(h.fire(POINT.AFTER_VERIFICATION, {}), undefined);
  });

  await test('HOOKS: every run is announced on the timeline, attributed to the task', () => {
    const bus = new EventBus();
    const seen = [];
    bus.on((e) => { if (e.type === EVENT.HOOK_RAN) seen.push(e); });
    const r = new TaskRuntime({ bus, persist: false });
    r.hooks.on(POINT.TASK_STARTED, 'watcher', () => {});
    const t = r.create({ title: 'x' });
    r.start(t.id);
    assert.ok(seen.length >= 1);
    assert.strictEqual(seen[0].hook, 'watcher');
    assert.strictEqual(seen[0].taskId, t.id);
  });

  await test('HOOKS: unregistering actually stops it being called', () => {
    const h = new Hooks();
    let n = 0;
    const off = h.on(POINT.TASK_CREATED, 'counter', () => { n++; });
    h.fire(POINT.TASK_CREATED, {});
    off();
    h.fire(POINT.TASK_CREATED, {});
    assert.strictEqual(n, 1);
  });

  await test('RUNTIME: verifying a BLOCKED task unblocks it rather than doing nothing', async () => {
    // BLOCKED cannot become PASSED, so without this the checks ran, the report
    // printed and the state silently did not move — which reads as the command
    // having done nothing at all.
    const { Harness } = require('../../src/harness');
    const h = new Harness({ workspace: tmp(), persist: false });
    const t = h.begin({ title: 'waiting on something' });
    h.runtime.start(t.id);
    h.runtime.block(t.id, 'waiting for an approval');
    assert.strictEqual(h.runtime.get(t.id).state, STATE.BLOCKED);
    await h.verify({ requirements: [{ description: 'a file', checks: [{ kind: 'file', label: 'pkg', path: 'nope.txt' }] }] }, { taskId: t.id });
    assert.strictEqual(h.runtime.get(t.id).state, STATE.FAILED, 'the evidence settled it');
    await h.shutdown();
  });

  // ------------------------------------------------------------- the snapshot --

  await test('SNAPSHOT: one shape, so no two surfaces can disagree', () => {
    const r = new TaskRuntime({ persist: false });
    const t = r.create({ title: 'shape', objective: 'o' });
    r.start(t.id);
    const s = r.snapshot();
    for (const k of ['id', 'title', 'state', 'tone', 'reason', 'terminal', 'processes', 'verification', 'artifacts', 'events']) {
      assert.ok(Object.prototype.hasOwnProperty.call(s, k), `the snapshot is missing ${k}`);
    }
    assert.strictEqual(s.verification, null, 'nothing proved yet reads as null, not as a pass');
  });

  await test('SNAPSHOT: with no task at all it is null rather than an empty pretence', () => {
    const r = new TaskRuntime({ persist: false });
    assert.strictEqual(r.snapshot(), null);
  });
};
