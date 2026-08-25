'use strict';

/**
 * CTRL+C LANDS NOW — through the real binary.
 *
 * The unit tier proves the shell tool settles on abort. This proves the whole
 * chain does: keystroke → interrupt handler → abort signal → tool → screen.
 *
 * The measurement that matters is TIME. "INTERRUPTED appears eventually" was
 * already true before the fix — it appeared 24 seconds after the key was
 * pressed, because the interface was waiting for a `sleep 30` nobody wanted any
 * more. So these assert the wall clock, not just the words.
 */

const assert = require('assert');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const ETX = String.fromCharCode(3);
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '96', LINES: '28' };

/** One very long tool call, then a closing message. */
const longToolScript = [
  { text: 'Running the long check.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 40' } }] },
  { text: 'Finished.' },
];

module.exports = async function () {
  await test('INT SMOKE: Ctrl+C during a 40s command settles in seconds, not when it ends', async () => {
    const started = Date.now();
    const r = await runCli([], {
      cwd: tmpdir('int-'), env: tui,
      stdinSteps: ['audit it\n', ETX, ETX], stepDelayMs: 1500,
      script: longToolScript, timeoutMs: 60000,
    });
    const took = (Date.now() - started) / 1000;
    const out = plain(r.out);
    assertIncludes(out, 'INTERRUPTED', 'the cancel must reach a resting state');
    // The command was 40 seconds. Anything near that means the interface waited
    // for work the user had already cancelled.
    assert.ok(took < 30, `the whole run took ${took.toFixed(1)}s — Ctrl+C did not actually stop the command`);
  });

  await test('INT SMOKE: the model is TOLD the call was interrupted, not given empty output', async () => {
    // A tool result of "" reads as "the command produced nothing", which is a
    // different fact and invites the model to draw a conclusion from it.
    const r = await runCli([], {
      cwd: tmpdir('int-'), env: tui,
      stdinSteps: ['audit it\n', ETX, ETX], stepDelayMs: 1500,
      script: longToolScript, timeoutMs: 60000,
    });
    assertIncludes(plain(r.out), 'interrupted', 'the interruption must be visible as the reason');
  });

  await test('INT SMOKE: LAIN is usable immediately afterwards', async () => {
    const r = await runCli([], {
      cwd: tmpdir('int-'), env: tui,
      stdinSteps: ['audit it\n', ETX, '/status\n'], stepDelayMs: 1500,
      script: longToolScript, timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, 'the REPL must survive an interrupt');
    assertIncludes(plain(r.out), 'context', '/status still answers right after a cancel');
  });
};
