'use strict';
// The owner has died. This short-lived helper runs outside the owned group so
// it can remove scratch profiles AFTER terminating that group.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pid = Number(process.argv[2]);

/**
 * THE ONLY DIRECTORY NAMES THIS WORKER WILL DELETE.
 *
 * It runs detached, as root of its own process, and removes recursively — so
 * the pattern is a real safety boundary and not a tidiness check.
 *
 * IT IS EXPORTED, AND THAT IS THE POINT. The pattern used to be an inline
 * literal here while the directory was created by an inline `mkdtemp` prefix
 * somewhere else, and the two agreed only by coincidence. Renaming the prefix
 * to `lain-verify-` broke that coincidence: the creator made a directory this
 * worker then refused as an "invalid browser scratch path", so a hard owner
 * death left a whole Chromium profile on disk — silently, because the throw
 * happens in a detached process nobody reads. Found by
 * tests/integration/harness-browser-lifecycle.js.
 *
 * Now env/chromium.js builds its prefix FROM this list, so a name that can be
 * created is a name that can be removed, by construction.
 */
const SCRATCH_PREFIXES = ['lain-browser-', 'lain-verify-'];
// `\\w`, NOT `\w`. A template literal eats an unrecognised escape, so `[\w-]`
// here becomes the literal class `[w-]` — matching the letter w and a hyphen
// and nothing else, which would make this worker refuse every scratch profile
// including the ones it has always removed. The load-time check in
// env/chromium.js caught exactly that.
const SCRATCH_RE = new RegExp(`^(?:${SCRATCH_PREFIXES.join('|')})[\\w-]+$`);
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
    if (parent !== fs.realpathSync(os.tmpdir()) || !SCRATCH_RE.test(path.basename(dir))) throw new Error('invalid browser scratch path');
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
module.exports = { SCRATCH_PREFIXES, SCRATCH_RE };

// Only run when this file IS the process, not when env/chromium.js requires it
// for the prefix. Requiring it used to be impossible; now it is how the creator
// and the remover stay in step.
if (require.main === module) {
  main().catch((e) => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; });
}
