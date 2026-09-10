'use strict';
// The owner has died. This short-lived helper runs outside the owned group so
// it can remove scratch profiles AFTER terminating that group.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pid = Number(process.argv[2]);
async function main() {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('invalid owner PID');
  for (;;) {
    try { process.kill(pid, 0); }
    catch (e) { if (e.code === 'ESRCH') break; throw e; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const dir of JSON.parse(process.argv[3] || '[]')) {
    // Only the exact mkdtemp browser directories may be handed to this worker.
    const parent = fs.realpathSync(path.dirname(dir));
    if (parent !== fs.realpathSync(os.tmpdir()) || !/^lain-browser-[\w-]+$/.test(path.basename(dir))) throw new Error('invalid browser scratch path');
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch((e) => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; });
