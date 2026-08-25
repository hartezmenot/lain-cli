'use strict';

/**
 * `/doctor` — the question a stuck user actually has.
 *
 * `/status` and `/provider` describe LAIN's configuration. This describes the
 * MACHINE, which is where the failures that look like bugs actually come from:
 * an unwritable config directory, no shell for run_bash, a missing credential.
 * V1 had it and V2 had lost it.
 *
 * Every check is a local syscall, so this must cost zero requests — asserted
 * below, because a diagnostic that spends money to run is one nobody runs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

module.exports = async function () {
  await test('DOCTOR: reports the environment, not the configuration', async () => {
    const r = await runCli([], { cwd: tmpdir('doc-'), stdin: '/doctor\n', script: [] });
    const out = plain(r.out);
    assertIncludes(out, 'Doctor');
    assertIncludes(out, 'Node ', 'the runtime version is the first thing that breaks a zero-dep tool');
    assertIncludes(out, 'Config directory', 'sessions and undo live there — unwritable means nothing persists');
    assertIncludes(out, 'Working directory');
    assertIncludes(out, 'run_bash', 'the tool most likely to be silently unusable on this host');
    assertIncludes(out, 'Context ', 'and the resource that ends long tasks');
  });

  await test('DOCTOR: says plainly when there is no provider, instead of looking healthy', async () => {
    const r = await runCli([], { cwd: tmpdir('doc-'), stdin: '/doctor\n' });   // no script => no provider
    assertIncludes(plain(r.out), 'No provider configured');
  });

  await test('DOCTOR: costs no request — a diagnostic that spends money is one nobody runs', async () => {
    const cwd = tmpdir('doc-');
    const r = await runCli([], { cwd, stdin: '/doctor\n/status\n', script: [] });
    const out = plain(r.out);
    // /status prints the request counter; running /doctor must not move it.
    assert.match(out, /0 requests/, `/doctor made a request:\n${out.slice(-600)}`);
  });

  await test('DOCTOR: an unwritable config directory is reported, not hidden', async () => {
    if (process.platform === 'win32') return;   // chmod is not the mechanism here
    const cwd = tmpdir('doc-');
    const configDir = path.join(cwd, 'ro-config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.chmodSync(configDir, 0o500);
    try {
      const r = await runCli([], { cwd, configDir, stdin: '/doctor\n' });
      assertIncludes(plain(r.out), 'NOT writable');
    } finally { fs.chmodSync(configDir, 0o700); }
  });

  await test('DOCTOR: it is safe to run while a turn is in flight', async () => {
    // Reading the environment cannot corrupt a turn, so it must not be blocked —
    // a user diagnosing a stall is exactly who needs it, mid-stall.
    const r = await runCli([], {
      cwd: tmpdir('doc-'), env: { LAIN_FORCE_TUI: '1', COLUMNS: '96', LINES: '28' },
      stdinSteps: ['audit it\n', '/doctor\n'], stepDelayMs: 800,
      script: [
        { text: 'Working.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 4' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'Doctor', '/doctor must answer during a turn');
    assert.ok(!/can't run while a turn is in flight/.test(out), 'a read-only check must not be blocked');
  });
};
