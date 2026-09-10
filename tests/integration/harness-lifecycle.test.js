'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { test, tmpdir } = require('../helpers');
const { Harness } = require('../../src/harness');
const { ProcessManager, portOpen } = require('../../src/harness/processes');
const supervisor = require('../../src/supervisor');
const scope = require('../supervisor-scope');
const fixture = path.join(__dirname, '../fixtures/harness-owner.js');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function read(root, name) { try { return JSON.parse(fs.readFileSync(path.join(root, name + '.json'))); } catch { return null; } }
async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  do { const value = await fn(); if (value) return value; await pause(25); } while (Date.now() < end);
  throw new Error('observable lifecycle condition did not arrive');
}
async function gone(...pids) { await until(() => pids.every((pid) => !supervisor.alive(pid))); }
function client(mode, root, env = {}) {
  return spawn(process.execPath, [fixture, mode, root], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
}

module.exports = async function () {
  for (const mode of ['normal', 'failure', 'timeout', 'cancellation']) {
    await test(`OWNERSHIP: service ${mode} removes its shell, descendant and listening port`, async () => {
      const root = tmpdir('lain-owned-service-');
      const h = new Harness({ workspace: root, persist: false });
      const task = h.begin({ title: mode });
      h.runtime.start(task.id);
      const p = h.processes.start({ taskId: task.id, command: process.execPath, args: [fixture, ['normal', 'failure'].includes(mode) ? mode : 'wait', root], health: { ready: 'never ready' } });
      try {
        const leaf = await until(() => read(root, 'leaf'));
        const command = await until(() => read(root, 'root'));
        if (mode === 'timeout') {
          await h.processes.waitUntilHealthy(p.processId, 50);
          await h.processes.cleanup(task.id);
        } else if (mode === 'cancellation') {
          h.runtime.cancel(task.id);
          await h.cleanupTask(task.id);
        }
        await gone(p.pid, leaf.pid, command.pid);
        assert.strictEqual(await portOpen(leaf.port), false);
      } finally { await h.shutdown(); }
    });
  }

  await test('OWNERSHIP: hard owner death closes IPC and removes all service descendants', async () => {
    const root = tmpdir('lain-owned-crash-');
    const child = client('service-owner', root);
    try {
      const owner = await until(() => read(root, 'owner'));
      const leaf = await until(() => read(root, 'leaf'));
      const command = await until(() => read(root, 'root'));
      child.kill('SIGKILL');
      await gone(child.pid, owner.processId, command.pid, leaf.pid);
      assert.strictEqual(await portOpen(leaf.port), false);
    } finally { if (supervisor.alive(child.pid)) child.kill('SIGKILL'); }
  });

  for (const mode of ['normal', 'failure', 'timeout', 'cancellation']) {
    await test(`OWNERSHIP: verification command ${mode} leaves no descendant`, async () => {
      const root = tmpdir('lain-owned-check-');
      const controller = new AbortController();
      const commandMode = ['normal', 'failure'].includes(mode) ? mode : 'wait';
      const command = `"${process.execPath}" "${fixture}" ${commandMode} "${root}"`;
      const result = require('../../src/harness/checks').runCommand(command, { cwd: root, timeoutMs: mode === 'timeout' ? 1000 : 8000, signal: controller.signal });
      const leaf = await until(() => read(root, 'leaf'));
      const shell = await until(() => read(root, 'root'));
      if (mode === 'cancellation') controller.abort();
      const report = await result;
      if (mode === 'timeout') assert.strictEqual(report.timedOut, true);
      if (mode === 'cancellation') assert.strictEqual(report.interrupted, true);
      if (mode === 'normal') assert.strictEqual(report.exitCode, 0);
      if (mode === 'failure') assert.strictEqual(report.exitCode, 3);
      await gone(leaf.pid, shell.pid);
      assert.strictEqual(await portOpen(leaf.port), false);
    });
  }

  for (const mode of ['foreground-owner', 'process-owner']) {
    await test(`OWNERSHIP: ${mode} crash removes foreground tool descendants`, async () => {
      const root = tmpdir('lain-owned-tool-');
      const child = client(mode, root);
      try {
        const leaf = await until(() => read(root, 'leaf'));
        const command = await until(() => read(root, 'root'));
        child.kill('SIGKILL');
        await gone(child.pid, command.pid, leaf.pid);
      } finally { if (supervisor.alive(child.pid)) child.kill('SIGKILL'); }
    });
  }

  if (!supervisor.binary()) {
    await test('OWNERSHIP: supervisor lifecycle unavailable without the Rust binary', () => assert.ok(!supervisor.binary()));
    return;
  }
  for (const mode of ['supervisor-timeout', 'supervisor-cancel']) {
    await test(`OWNERSHIP: ${mode} removes the actual spawned supervisor`, async () => {
      const root = tmpdir('lain-owned-supervisor-');
      const child = client(mode, root, { LAIN_HOME: root });
      try {
        const started = await until(() => read(root, 'spawn'));
        const result = await until(() => read(root, 'result'));
        assert.strictEqual(result.running, false);
        await gone(started.pid, child.pid);
      } finally { if (supervisor.alive(child.pid)) child.kill('SIGKILL'); }
    });
  }

  await test('OWNERSHIP: killing the test owner closes its lease and removes the supervisor', async () => {
    const root = tmpdir('lain-owned-lease-');
    const child = client('supervisor-lease-owner', root, { LAIN_HOME: root });
    try {
      const result = await until(() => read(root, 'result'));
      assert.strictEqual(result.running, true);
      child.kill('SIGKILL');
      await gone(child.pid, result.endpoint.pid);
    } finally { if (supervisor.alive(child.pid)) child.kill('SIGKILL'); }
  });

  await test('OWNERSHIP: a dead test lease also stops a running supervisor job and its descendants', async () => {
    const root = tmpdir('lain-owned-lease-job-');
    const child = client('supervisor-lease-job-owner', root, { LAIN_HOME: root });
    try {
      const result = await until(() => read(root, 'result'));
      assert.ok(result.running && result.job && result.job.pid);
      const leaf = await until(() => read(root, 'leaf'));
      const command = await until(() => read(root, 'root'));
      child.kill('SIGKILL');
      await gone(child.pid, result.endpoint.pid, result.job.pid, command.pid, leaf.pid);
      assert.strictEqual(await portOpen(leaf.port), false);
    } finally { if (supervisor.alive(child.pid)) child.kill('SIGKILL'); }
  });

  await test('OWNERSHIP: simultaneous clients converge and scope exit removes the supervisor', async () => {
    const root = tmpdir('lain-owned-race-');
    const lease = await scope.open();
    const clients = [];
    try {
      const dirs = Array.from({ length: 4 }, () => tmpdir('lain-owned-client-'));
      for (const dir of dirs) clients.push(client('supervisor', dir, { LAIN_HOME: root, LAIN_SUPERVISOR_LEASE_PORT: String(lease.port) }));
      const reports = await Promise.all(dirs.map((dir) => until(() => read(dir, 'result'))));
      assert.ok(reports.every((r) => r.running));
      assert.strictEqual(new Set(reports.map((r) => r.endpoint.pid)).size, 1);
      await gone(...clients.map((c) => c.pid));
      await lease.close();
      await gone(...dirs.map((dir) => read(dir, 'spawn')).filter(Boolean).map((r) => r.pid));
    } finally { await lease.close(); for (const c of clients) if (supervisor.alive(c.pid)) c.kill('SIGKILL'); }
  });
};
