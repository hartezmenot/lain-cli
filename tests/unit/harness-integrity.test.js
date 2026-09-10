'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const { TaskRuntime } = require('../../src/harness/runtime');
const verify = require('../../src/harness/verify');
const { ArtifactStore } = require('../../src/harness/artifacts');
const { EventBus, EVENT } = require('../../src/events');
const store = require('../../src/lainstore');

module.exports = async function () {
  await test('INTEGRITY: a missing exit status cannot be coerced into exit zero', () => {
    const { verdictForRun } = require('../../src/harness/checks');
    assert.strictEqual(verdictForRun({ exitCode: null }).verdict, 'INCONCLUSIVE');
    assert.strictEqual(verdictForRun({ exitCode: 0 }).verdict, 'PASSED');
    assert.strictEqual(verdictForRun({ exitCode: 1 }).verdict, 'FAILED');
  });
  await test('INTEGRITY: a claimed pass, direct transition and another task report cannot settle', async () => {
    const r = new TaskRuntime({ persist: false });
    const a = r.create({ title: 'a' }); r.start(a.id); r.verifying(a.id);
    const b = r.create({ title: 'b' }); r.start(b.id); r.verifying(b.id);
    const report = await verify.run([{ checks: [{ kind: 'file', path: __filename }] }], { taskId: a.id });
    assert.strictEqual(r.settle(a.id, { verdict: 'PASSED', passed: 1 }).ok, false);
    assert.strictEqual(a.moveTo('PASSED').ok, false);
    assert.strictEqual(r._move(a.id, 'PASSED').ok, false);
    assert.throws(() => { a.state = 'PASSED'; });
    assert.strictEqual(r.settle(b.id, report).ok, false);
    assert.throws(() => { report.verdict = 'FAILED'; });
    assert.strictEqual(r.settle(a.id, report).ok, true);
    const before = JSON.stringify(a.toJSON());
    assert.strictEqual(r.settle(a.id, report).ok, false);
    assert.strictEqual(JSON.stringify(a.toJSON()), before);
  });
  await test('INTEGRITY: late evidence keeps its owner and does not arm another task', () => {
    const root = tmpdir('lain-integrity-');
    const bus = new EventBus();
    const r = new TaskRuntime({ workspace: root, bus });
    const a = r.create({ title: 'a' }); r.start(a.id);
    const b = r.create({ title: 'b' }); r.start(b.id);
    bus.emit(EVENT.PROCESS_STARTED, { taskId: a.id, name: 'late' });
    r.keep(a.id, { body: 'evidence', name: 'proof.txt' });
    assert.ok(fs.existsSync(store.taskDir(root, a.id)));
    assert.ok(!fs.existsSync(store.taskDir(root, b.id)));
    assert.strictEqual(r.keep('unknown', { body: 'unowned' }), null);
    r.detach();
  });
  await test('INTEGRITY: missing artifacts and outside paths are never advertised or read', () => {
    const root = tmpdir('lain-integrity-');
    const s = new ArtifactStore(root);
    const artifact = s.put('task', { kind: 'log', name: 'proof', body: 'proof' });
    fs.unlinkSync(artifact.path);
    assert.deepStrictEqual(s.index('task'), []);
    fs.writeFileSync(path.join(s.dirFor('task'), 'artifacts.json'), JSON.stringify([{ ...artifact, path: __filename }]));
    assert.deepStrictEqual(s.index('task'), []);
    assert.strictEqual(s.bytes('task', artifact.id), null);
    assert.strictEqual(path.dirname(store.taskDir(root, '..')), store.tasksRoot(root));
  });
  await test('INTEGRITY: pruning preserves an unreadable or unknown task record', () => {
    const root = tmpdir('lain-integrity-');
    const s = new ArtifactStore(root);
    for (const id of ['unknown', 'active', 'new']) s.saveTask({ id, state: id === 'active' ? 'RUNNING' : 'UNKNOWN' });
    fs.writeFileSync(path.join(s.dirFor('unknown'), 'task.json'), '{broken');
    assert.deepStrictEqual(s.prune(1), []);
    assert.ok(fs.existsSync(s.dirFor('unknown')));
    assert.ok(fs.existsSync(s.dirFor('active')));
  });
  await test('INTEGRITY: an oversized event is refused without overwriting earlier evidence', () => {
    const root = tmpdir('lain-integrity-');
    const s = new ArtifactStore(root);
    const { MAX_EVENT_BYTES } = require('../../src/harness/artifacts');
    assert.strictEqual(s.appendEvent('a', { type: 'proof' }), true);
    assert.strictEqual(s.appendEvent('a', { text: 'x'.repeat(MAX_EVENT_BYTES) }), false);
    assert.match(s.lastError, /capacity/);
    assert.deepStrictEqual(s.events('a'), [{ type: 'proof' }]);
  });
  await test('INTEGRITY: an oversized binary is refused rather than advertised as a corrupt screenshot', () => {
    const s = new ArtifactStore(tmpdir('lain-integrity-'));
    const { MAX_BODY } = require('../../src/harness/artifacts');
    assert.strictEqual(s.put('task', { kind: 'screenshot', name: 'page.png', body: Buffer.alloc(MAX_BODY + 1) }), null);
    assert.match(s.lastError, /intact/);
    assert.deepStrictEqual(s.index('task'), []);
  });
  await test('INTEGRITY: failed index publication rolls back the new artifact', () => {
    const s = new ArtifactStore(tmpdir('lain-integrity-'));
    fs.mkdirSync(path.join(s.dirFor('task'), 'artifacts.json'), { recursive: true });
    assert.strictEqual(s.put('task', { kind: 'log', name: 'proof', body: 'proof' }), null);
    assert.ok(s.lastError);
    const files = fs.readdirSync(s.dirFor('task'), { recursive: true });
    assert.ok(!files.some((file) => /proof|\.tmp$/.test(file)));
  });
  await test('INTEGRITY: activity projection is event-derived and excludes model text', () => {
    const { Harness } = require('../../src/harness');
    const h = new Harness({ persist: false });
    const t = h.begin({ title: 'read code' }); h.runtime.start(t.id);
    h.bus.emit(EVENT.TOOL_STARTED, { tool: 'read_file', target: 'file.js' });
    assert.strictEqual(h.snapshot().activity.state, 'READING');
    assert.strictEqual(h.snapshot().activity.target, 'file.js');
    h.bus.emit(EVENT.MODEL_THINKING, { text: 'private reasoning' });
    const activity = h.snapshot().activity;
    assert.strictEqual(activity.state, 'THINKING');
    assert.ok(!JSON.stringify(activity).includes('private reasoning'));
    h.runtime.detach(); h._offCleanup();
  });
};
