#!/usr/bin/env node
'use strict';

/**
 * EXIT HYGIENE.
 *
 * `process.exit()` immediately after a real `fetch()` trips a libuv assertion on
 * Node 24 / Windows — undici's keep-alive socket handle is still closing when
 * the process is torn down:
 *
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
 *
 * It reproduces in a dozen lines with a bare fetch + process.exit, and it exited
 * the real CLI with code 127 after any live provider request. Setting
 * `process.exitCode` and letting the loop drain avoids it.
 *
 * The unref'd fallback timer is the safety net: if some handle refuses to
 * release, the process still terminates instead of hanging at the shell. Being
 * unref'd, it never keeps the process alive by itself.
 */

const FORCE_EXIT_GRACE_MS = 3000;

function finish(code) {
  process.exitCode = typeof code === 'number' ? code : 0;
  const t = setTimeout(() => process.exit(process.exitCode), FORCE_EXIT_GRACE_MS);
  if (typeof t.unref === 'function') t.unref();
}

require('../src/cli').main(process.argv.slice(2)).then(
  (code) => finish(code),
  (err) => {
    process.stderr.write('lain: fatal: ' + (err && err.stack ? err.stack : err) + '\n');
    finish(1);
  }
);
