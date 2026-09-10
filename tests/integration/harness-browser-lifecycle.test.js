'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { test, tmpdir } = require('../helpers');
const { Harness } = require('../../src/harness');
const browser = require('../../src/harness/browser');
const cdp = require('../../src/harness/cdp');
const { alive } = require('../../src/supervisor');
const { portOpen } = require('../../src/harness/processes');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 10000;
  do { const v = await fn(); if (v) return v; await pause(50); } while (Date.now() < end);
  throw new Error('browser resource did not settle');
}

module.exports = async function () {
  if (!browser.findBrowser().ok || !cdp.clientAvailable().ok) {
    await test('BROWSER-LIFETIME: optional real browser is unavailable', () => assert.ok(!browser.findBrowser().ok || !cdp.clientAvailable().ok));
    return;
  }
  for (const mode of ['normal', 'failure', 'timeout', 'cancellation', 'launch-failure']) {
    await test(`BROWSER-LIFETIME: ${mode} removes the process, debug port and scratch profile`, async () => {
      const server = http.createServer((req, res) => res.end('<!doctype html><h1 id="ready">Ready</h1>'));
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const h = new Harness({ workspace: tmpdir('lain-browser-test-'), persist: false });
      const task = h.begin({ title: mode }); h.runtime.start(task.id);
      const controller = new AbortController();
      let owned;
      const start = h.processes.start.bind(h.processes);
      h.processes.start = (spec) => {
        const proc = start(spec);
        owned = { proc, profile: spec.cleanupPaths[0] };
        if (mode === 'cancellation') setTimeout(() => controller.abort(), 300);
        return proc;
      };
      const find = browser.findBrowser;
      if (mode === 'launch-failure') browser.findBrowser = () => ({ ok: true, path: process.execPath });
      try {
        const report = await h.browser.verify({
          url: `http://127.0.0.1:${server.address().port}/`,
          assert: [{ selector: mode === 'failure' ? '#missing' : '#ready', visible: true }],
          actions: mode === 'timeout' ? [{ type: 'wait', ms: 10000 }] : [],
          flow_timeout_ms: mode === 'timeout' ? 1200 : 15000,
          screenshot: false,
        }, { taskId: task.id, signal: controller.signal });
        assert.strictEqual(report.verdict, mode === 'normal' ? 'PASSED' : mode === 'failure' ? 'FAILED' : 'INCONCLUSIVE', report.why);
        assert.ok(owned, 'the regression must actually launch a process');
        await until(() => !alive(owned.proc.pid) && !fs.existsSync(owned.profile));
        if (owned.proc.port) assert.strictEqual(await portOpen(owned.proc.port), false);
        assert.strictEqual(h.browser._launches.size, 0);
      } finally {
        browser.findBrowser = find;
        await h.shutdown();
        await new Promise((r) => server.close(r));
      }
    });
  }
  await test('BROWSER-LIFETIME: hard owner death also removes the scratch profile', async () => {
    const root = tmpdir('lain-browser-crash-');
    const child = spawn(process.execPath, [path.join(__dirname, '../fixtures/harness-owner.js'), 'browser-owner', root], { stdio: 'ignore', windowsHide: true });
    try {
      const owned = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'browser.json'))); } catch { return null; } });
      child.kill('SIGKILL');
      await until(() => !alive(owned.pid) && !fs.existsSync(owned.profile));
      assert.strictEqual(await portOpen(owned.port), false);
    } finally { if (alive(child.pid)) child.kill('SIGKILL'); }
  });
};
