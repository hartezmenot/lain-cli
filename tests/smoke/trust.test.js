'use strict';

/**
 * "TRUST THIS DIRECTORY?" — THROUGH THE REAL BINARY.
 *
 * The rules are unit-tested in trust.test.js and the gate in gate.test.js. This
 * exists for the part neither of those can see, and it caught two bugs that
 * nothing else would have:
 *
 *   ASKED TOO EARLY. In `app.prepare()` the UI does not exist yet, so
 *     `app.ui.enabled` was false, there was nobody to ask, and on a brand-new
 *     directory the question silently never appeared at all.
 *
 *   ASKED BEFORE THERE WAS A KEYBOARD. Moved to just after `ui.enable()` it
 *     appeared and then HUNG: the panel opened and waited for an answer while
 *     the input reader did not yet exist, so nothing could answer it. LAIN
 *     started, drew a question, and froze.
 *
 * A unit test calls `ensureTrusted` with a reader that is already listening, so
 * both bugs are invisible from there. Only starting the program finds them.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const TUI = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' };

/** A project with its own config dir, so runs cannot see each other's answers. */
function project() {
  const cwd = tmpdir('trust-');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"trustme"}');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), '{}');
  return { cwd, configDir };
}

const saved = (configDir) => {
  try { return JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')); } catch { return {}; }
};

module.exports = async function () {
  await test('TRUST LIVE: a new directory is ASKED about, and the question is on screen', async () => {
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir, env: TUI, trust: false, stdinSteps: ['\r', '/exit\n'], stepDelayMs: 1500, script: [], timeoutMs: 40000,
    });
    const out = plain(r.out);
    assert.match(out, /TRUST THIS DIRECTORY\?/, 'the question must appear');
    assert.match(out, /read, write and run/, 'and must say what saying yes means');
  });

  await test('TRUST LIVE: the question can be ANSWERED — it does not hang the start', async () => {
    // THE DEADLOCK. Asked before the keyboard reader existed, the panel waited
    // for an answer nothing could deliver and LAIN froze at startup. That it
    // exits cleanly here is the assertion.
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir, env: TUI, trust: false, stdinSteps: ['\r', '/exit\n'], stepDelayMs: 1500, script: [], timeoutMs: 40000,
    });
    assert.strictEqual(r.code, 0, 'it must answer and carry on, not hang');
    const cfg = saved(configDir);
    assert.ok(Array.isArray(cfg.trustedPaths) && cfg.trustedPaths.length,
      'the answer must be written down, or it will be asked again forever');
  });

  await test('TRUST LIVE: it is asked ONCE — a second launch goes straight to work', async () => {
    // Being asked on every launch is how an answer stops being read.
    const { cwd, configDir } = project();
    await runCli([], { cwd, configDir, env: TUI, trust: false, stdinSteps: ['\r', '/exit\n'], stepDelayMs: 1500, script: [], timeoutMs: 40000 });
    const again = await runCli([], { cwd, configDir, env: TUI, trust: false, stdin: '/exit\n', script: [], timeoutMs: 30000 });
    assert.ok(!/TRUST THIS DIRECTORY\?/.test(plain(again.out)),
      'a decided directory must not ask again');
  });

  await test('TRUST LIVE: off a TTY it asks nothing and still works', async () => {
    // A piped run has nobody to ask. Refusing everything there would be
    // punishing the user for a question the program never put to them — and it
    // would break every non-interactive use of LAIN.
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir, trust: false,
      stdin: 'write a note\n/exit\n',
      script: [
        { text: 'Writing it.', tool_calls: [{ name: 'write_file', input: { path: 'note.txt', content: 'hello' } }] },
        { text: 'Done. FINISHED.' },
      ],
      timeoutMs: 40000,
    });
    assert.ok(!/TRUST THIS DIRECTORY\?/.test(plain(r.out)), 'there is nobody to ask on a pipe');
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'note.txt'), 'utf8'), 'hello',
      'and the work must still happen');
  });
};
