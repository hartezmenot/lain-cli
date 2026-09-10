'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const [mode, root] = process.argv.slice(2);
const write = (name, value) => fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(value));

async function main() {
  if (mode === 'leaf') {
    const server = require('net').createServer((s) => s.end());
    server.listen(0, '127.0.0.1', () => write('leaf', { pid: process.pid, port: server.address().port }));
  } else if (['normal', 'failure', 'wait'].includes(mode)) {
    spawn(process.execPath, [__filename, 'leaf', root], { stdio: 'ignore', windowsHide: true });
    write('root', { pid: process.pid });
    if (mode === 'wait') setInterval(() => {}, 1000);
    else setTimeout(() => process.exit(mode === 'normal' ? 0 : 3), 500);
  } else if (mode === 'service-owner') {
    const { ProcessManager } = require('../../src/harness/processes');
    const pm = new ProcessManager();
    const p = pm.start({ taskId: 'fixture', command: process.execPath, args: [__filename, 'wait', root] });
    write('owner', { pid: process.pid, processId: p.pid });
  } else if (mode === 'foreground-owner' || mode === 'process-owner') {
    if (mode === 'foreground-owner') {
      await require('../../src/tools/shell').run(`node "${__filename}" wait "${root}"`, { shell: process.platform === 'win32' ? 'cmd' : 'bash', cwd: root });
    } else {
      await require('../../src/tools/exec').execute(process.execPath, [__filename, 'wait', root], { cwd: root });
    }
  } else if (mode === 'browser-owner') {
    const { Harness } = require('../../src/harness');
    const h = new Harness({ workspace: root, persist: false });
    const t = h.begin({ title: 'browser owner crash' }); h.runtime.start(t.id);
    const got = await h.browser.session({ taskId: t.id });
    if (!got.ok) throw new Error(got.why);
    const launched = h.browser._launches.get(t.id);
    write('browser', { ...launched, pid: h.processes.get(launched.processId).pid, port: h.processes.get(launched.processId).port });
  } else if (mode.startsWith('supervisor')) {
    if (mode === 'supervisor-lease-owner' || mode === 'supervisor-lease-job-owner') {
      const lease = await require('../supervisor-scope').open();
      process.env.LAIN_SUPERVISOR_LEASE_PORT = String(lease.port);
    }
    // Instrument the actual spawn, so timeout tests can check the OS PID even
    // when discovery never becomes ready. Nothing here replaces a process.
    const cp = require('child_process');
    const original = cp.spawn;
    cp.spawn = function (...args) {
      const child = original(...args);
      if (args[1] && args[1][0] === 'serve') write('spawn', { pid: child.pid });
      return child;
    };
    const supervisor = require('../../src/supervisor');
    const controller = new AbortController();
    const pending = supervisor.ensure({ startTimeoutMs: mode === 'supervisor-timeout' ? 0 : 8000, signal: controller.signal });
    if (mode === 'supervisor-cancel') controller.abort();
    const result = await pending;
    if (mode === 'supervisor-lease-job-owner' && result.running) {
      result.job = (await supervisor.submit({
        command: `node "${__filename}" wait "${root}"`,
        shell: process.platform === 'win32' ? 'cmd' : 'sh', cwd: root,
      })).job;
    }
    write('result', result);
    if (mode === 'supervisor-owner' || mode === 'supervisor-lease-owner' || mode === 'supervisor-lease-job-owner') setInterval(() => {}, 1000);
  }
}
main().catch((e) => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; });
