'use strict';

/**
 * THE TWO STEER MODES, THROUGH THE REAL BINARY.
 *
 * Typing while LAIN works queues a correction that WAITS for the work in
 * flight. Pressing Enter again promotes it to NOW, and it lands at the next
 * step boundary instead.
 *
 * THIS EXISTS BECAUSE THE UNIT TESTS PASSED AND THE FEATURE DID NOT. The
 * promotion was wired to the `input` event — which an EMPTY line never reaches,
 * because an empty Enter is a KEY and went to `workspaceSelect`. Every unit
 * test of `promoteSteers` passed; pressing Enter twice in the actual program
 * did nothing at all. Only the binary shows which of two handlers a keystroke
 * arrives at.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const TUI = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' };

/** A trusted project, so the gate is not the thing under test here. */
function project() {
  const cwd = tmpdir('steer-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'),
    JSON.stringify({ trustedPaths: [{ path: cwd, level: 'TRUSTED' }] }));
  return { cwd, configDir };
}

/** A turn slow enough to type into. */
const SLOW = [
  { text: 'Working on it.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 8' } }] },
  { text: 'Noted. FINISHED.' },
];

module.exports = async function () {
  await test('STEER LIVE: typing during a turn WAITS, and is delivered after', async () => {
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir, env: TUI,
      stdinSteps: ['run the slow one\n', 'also check the backend\n'],
      stepDelayMs: 2500,
      script: SLOW,
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assert.match(out, /Waiting to send/, 'it must be shown waiting, not silently queued');
    assert.match(out, /also check the backend/, 'and the text must be visible while it waits');
    // DELIVERED AFTER THE WORK, not dropped when the turn ended.
    assert.match(out, /delivering what you typed while it worked/,
      'the waiting steer must reach the model once the work finished');
  });

  await test('STEER LIVE: a SECOND Enter promotes it, and the region says so', async () => {
    // THE BUG THIS PINS. An empty Enter is a KEY, not an `input` event, so the
    // promotion never ran however many times it was pressed.
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir, env: TUI,
      stdinSteps: ['run the slow one\n', 'also check the backend\n', '\r'],
      stepDelayMs: 2200,
      script: SLOW,
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assert.match(out, /Steering now/, 'the region must change its heading when promoted');
    assert.match(out, /USER STEER delivered to the model/,
      'and a promoted steer must actually reach the running turn');
  });

  await test('STEER LIVE: Escape puts the text back on the input line', async () => {
    // Escape means "I have not sent that yet". Losing a correction somebody was
    // halfway through wording is the worst outcome of a stray keypress.
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir, env: TUI,
      stdinSteps: ['run the slow one\n', 'wrong wording here\n', '\x1b'],
      stepDelayMs: 2200,
      script: SLOW,
      timeoutMs: 60000,
    });
    // `\x1b[?25l` (hide-cursor) is the per-frame boundary now — a redraw no
    // longer opens with a full-screen clear (see ui/layout.js's `L` helper).
    const frames = String(r.out).split(/\x1b\[\?25l/).map(plain);
    const after = frames.filter((f) => !f.includes('Waiting to send') && f.includes('wrong wording here'));
    assert.ok(after.length,
      'after Escape the text must be back on the input line, not in the pending region');
  });
};
