'use strict';

// The killer is a sibling of the command tree. On Windows, putting taskkill
// inside its own /T target can terminate it before deeper descendants die.
const { spawn } = require('child_process');
let worker;
let stopping = false;
let reported = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (worker && worker.pid) {
    try {
      if (process.platform === 'win32') {
        await new Promise((resolve, reject) => {
          const killer = spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', reject);
          killer.once('close', resolve);
        });
      } else {
        try { process.kill(-worker.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      }
      const deadline = Date.now() + 3000;
      while (worker.exitCode === null && worker.signalCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (worker.exitCode === null && worker.signalCode === null) throw new Error('owned command tree did not stop');
    } catch (e) {
      process.stderr.write(`process tree cleanup failed: ${e.message}\n`);
      // Keep ownership alive for the caller's bounded fallback and report it.
      if (process.connected) process.send({ cleanupError: e.message });
      stopping = false;
      return;
    }
  }
  process.exit(0);
}
process.on('disconnect', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('message', (spec) => {
  if (spec.stop) { stop(); return; }
  if (worker || stopping || !process.connected) return;
  worker = spawn(process.execPath, [require.resolve('./processworker')], {
    cwd: spec.cwd, env: spec.env, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  worker.on('message', (result) => {
    if (!result.startedPid) reported = true;
    if (process.connected) process.send(result, () => { if (!result.startedPid) stop(); });
    else stop();
  });
  worker.on('error', (e) => {
    if (process.connected) process.send({ error: e.message }, stop); else stop();
  });
  worker.once('exit', (code, signal) => {
    if (!reported && !stopping && process.connected) {
      process.send({ error: `command owner exited without a result (${signal || code})` }, stop);
    } else stop();
  });
  worker.send(spec, (e) => { if (e) stop(); });
});
