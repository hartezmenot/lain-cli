'use strict';

/**
 * THE PROCESS MANAGER — services that stay up, and every way one can go wrong.
 *
 * A SERVICE THAT EXITS ON ITS OWN HAS CRASHED, and that is the assertion this
 * file exists for. It is the whole difference from a job, where an exit is the
 * result, and getting it wrong means a dev server that died is reported as a
 * dev server that finished.
 */

const assert = require('assert');
const net = require('net');
const { test } = require('../helpers');

const { ProcessManager, STATUS, HEALTH, portOpen, httpProbe } = require('../../src/harness/processes');
const { TaskRuntime } = require('../../src/harness/runtime');
const { EventBus, EVENT } = require('../../src/events');

const node = process.execPath;

/** Wait for a condition, or give up. Never a bare sleep with a hope attached. */
async function until(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 40));
  }
}

module.exports = async function () {
  await test('PROC: a service that exits on its own is CRASHED, not finished', async () => {
    const bus = new EventBus();
    const failures = [];
    bus.on((e) => { if (e.type === EVENT.PROCESS_FAILED) failures.push(e); });
    const pm = new ProcessManager({ bus });
    const p = pm.start({ taskId: 't1', name: 'flaky', command: node, args: ['-e', 'process.exit(7)'] });
    const gone = await until(() => (p.status !== STATUS.RUNNING && p.status !== STATUS.STARTING ? p.status : null));
    assert.strictEqual(gone, STATUS.CRASHED, 'an unrequested exit is a crash');
    assert.strictEqual(p.exitCode, 7);
    assert.match(p.healthWhy, /exited on its own/);
    assert.strictEqual(failures.length, 1, 'and the task is told');
    await pm.cleanup();
  });

  await test('PROC: a service stopped on request is STOPPED, not crashed', async () => {
    const pm = new ProcessManager();
    const p = pm.start({ taskId: 't1', name: 'server', command: node, args: ['-e', 'setInterval(()=>{},1000)'] });
    await until(() => (p.pid ? true : null));
    await pm.stop(p.processId);
    assert.strictEqual(p.status, STATUS.STOPPED);
    assert.match(p.healthWhy, /on request/);
    await pm.cleanup();
  });

  await test('PROC: a command that cannot start is FAILED with the real reason', async () => {
    const pm = new ProcessManager();
    const p = pm.start({ taskId: 't1', name: 'ghost', command: 'lain-not-a-real-binary-9f3a', args: [] });
    const settled = await until(() => (p.status === STATUS.FAILED ? true : null));
    assert.ok(settled, 'a spawn failure must settle, not hang');
    assert.ok(p.healthWhy.length > 0, 'and it says why');
    await pm.cleanup();
  });

  await test('PROC: with no health check configured, health is UNKNOWN — never HEALTHY', async () => {
    // "Nothing looked" and "it answered" must never render the same.
    const pm = new ProcessManager();
    const p = pm.start({ taskId: 't1', name: 'quiet', command: node, args: ['-e', 'setInterval(()=>{},1000)'] });
    const r = await pm.check(p.processId);
    assert.strictEqual(r.health, HEALTH.UNKNOWN);
    assert.match(r.why, /nothing looked/);
    await pm.cleanup();
  });

  await test('PROC: a real listening port reads HEALTHY and a closed one UNHEALTHY', async () => {
    const server = net.createServer(() => {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const pm = new ProcessManager();
    const p = pm.start({
      taskId: 't1', name: 'api', command: node, args: ['-e', 'setInterval(()=>{},1000)'], port,
    });
    const up = await pm.check(p.processId);
    assert.strictEqual(up.health, HEALTH.HEALTHY);
    await new Promise((r) => server.close(r));
    const down = await pm.check(p.processId);
    assert.strictEqual(down.health, HEALTH.UNHEALTHY);
    assert.match(down.why, /nothing is listening/);
    await pm.cleanup();
  });

  await test('PROC: waitUntilHealthy gives up early when the process is already dead', async () => {
    // Waiting eight seconds for something that has already died is time nobody
    // gets back and evidence nobody needed.
    const pm = new ProcessManager();
    const p = pm.start({ taskId: 't1', name: 'dies', command: node, args: ['-e', 'process.exit(1)'], port: 59999 });
    const began = Date.now();
    const r = await pm.waitUntilHealthy(p.processId, 8000);
    assert.strictEqual(r.health, HEALTH.UNHEALTHY);
    assert.ok(Date.now() - began < 6000, `it waited ${Date.now() - began}ms for a dead process`);
    await pm.cleanup();
  });

  await test('PROC: a readiness LINE in the output can stand in for a port', async () => {
    const pm = new ProcessManager();
    const p = pm.start({
      taskId: 't1', name: 'logger', command: node,
      args: ['-e', 'setTimeout(()=>console.log("ready on 1234"),80); setInterval(()=>{},1000)'],
      health: { ready: 'ready on' },
    });
    const r = await pm.waitUntilHealthy(p.processId, 5000);
    assert.strictEqual(r.health, HEALTH.HEALTHY);
    assert.match(r.why, /readiness line/);
    await pm.cleanup();
  });

  await test('PROC: output is captured and readable as a tail', async () => {
    const pm = new ProcessManager();
    const p = pm.start({ taskId: 't1', name: 'talker', command: node, args: ['-e', 'for(let i=0;i<5;i++) console.log("line "+i);'] });
    await until(() => (p.log.includes('line 4') ? true : null));
    assert.match(p.tail(3), /line 4/);
    await pm.cleanup();
  });

  await test('PROC: a restart keeps the same record and counts', async () => {
    const pm = new ProcessManager();
    const p = pm.start({ taskId: 't1', name: 'svc', command: node, args: ['-e', 'setInterval(()=>{},1000)'] });
    await until(() => (p.pid ? true : null));
    const firstPid = p.pid;
    await pm.restart(p.processId);
    await until(() => (p.pid && p.pid !== firstPid ? true : null));
    assert.strictEqual(p.restarts, 1);
    assert.notStrictEqual(p.pid, firstPid, 'a restart is a new process');
    assert.strictEqual(pm.list('t1').length, 1, 'and not a second record');
    await pm.cleanup();
  });

  await test('PROC: cleanup by task takes down that task\'s services and no others', async () => {
    const pm = new ProcessManager();
    const mine = pm.start({ taskId: 'A', name: 'a', command: node, args: ['-e', 'setInterval(()=>{},1000)'] });
    const theirs = pm.start({ taskId: 'B', name: 'b', command: node, args: ['-e', 'setInterval(()=>{},1000)'] });
    await until(() => (mine.pid && theirs.pid ? true : null));
    await pm.cleanup('A');
    assert.strictEqual(mine.status, STATUS.STOPPED);
    assert.ok(theirs.alive, 'another task\'s service must not be taken down');
    await pm.cleanup();
  });

  await test('PROC: cleanup is safe to call twice', async () => {
    const pm = new ProcessManager();
    pm.start({ taskId: 'A', name: 'a', command: node, args: ['-e', 'setInterval(()=>{},1000)'] });
    await pm.cleanup();
    const second = await pm.cleanup();
    assert.deepStrictEqual(second, [], 'nothing left to stop, and no error');
  });

  await test('PROC: a service mirrors onto its owner task record', async () => {
    const runtime = new TaskRuntime({ persist: false });
    const t = runtime.create({ title: 'frontend work' });
    const pm = new ProcessManager({ runtime });
    const p = pm.start({ taskId: t.id, name: 'frontend', command: node, args: ['-e', 'setInterval(()=>{},1000)'], port: 5173 });
    await until(() => (p.pid ? true : null));
    const row = runtime.get(t.id).processes.find((x) => x.processId === p.processId);
    assert.ok(row, 'the task must know what it owns');
    assert.strictEqual(row.port, 5173);
    await pm.cleanup();
  });

  await test('PROC: stopping something that does not exist is reported, not thrown', async () => {
    const pm = new ProcessManager();
    const r = await pm.stop('proc_nope');
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /no such process/);
  });

  await test('PROBE: portOpen and httpProbe answer honestly about nothing', async () => {
    assert.strictEqual(await portOpen(1, '127.0.0.1', 500), false);
    const r = await httpProbe('http://127.0.0.1:1/', 500);
    assert.strictEqual(r.ok, false);
    assert.ok(r.why);
    const bad = await httpProbe('not a url at all', 500);
    assert.strictEqual(bad.ok, false, 'a malformed url is an answer, not a throw');
  });
};
