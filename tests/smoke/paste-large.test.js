'use strict';

/**
 * A LARGE PASTE, THROUGH THE REAL BINARY.
 *
 * Two things have to be true at once and they pull in opposite directions:
 * the screen must not try to draw a 1,200-line paste, and the BUFFER must still
 * hold every byte of it. A summary that replaced the content would look right
 * and silently truncate the user's prompt.
 *
 * So this pastes a big block into the real process, presses Enter, and checks
 * what actually reached the model: the first line, the last line, and a marker
 * buried in the middle.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** The newest session file written under an isolated config dir. */
function latestSession(configDir) {
  const dir = path.join(configDir, 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  if (!names.length) return null;
  const newest = names
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].f;
  return JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8'));
}

module.exports = async function () {
  const LINES = 1200;
  const body = Array.from({ length: LINES }, (_, i) => `const line${i} = ${i};`).join('\n');

  await test('PASTE LIVE: a 1,200-line paste does not submit itself', async () => {
    const r = await runCli([], {
      cwd: tmpdir('paste-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: [PASTE_START + body + PASTE_END],
      stepDelayMs: 900,
      script: [{ text: 'should never run' }],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    assert.ok(!/should never run/.test(out), 'the paste submitted a turn on its own');
    assertIncludes(out, '1,200 lines', 'the screen must say what was pasted');
  });

  await test('PASTE LIVE: the summary states the paste, and Enter sends every byte of it', async () => {
    const cwd = tmpdir('paste-');
    const configDir = path.join(cwd, '.config');
    const r = await runCli([], {
      cwd,
      configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: [PASTE_START + body + PASTE_END, '\r'],
      stepDelayMs: 1200,
      script: [{ text: 'Received.' }],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    // The screen summarised rather than painted 1,200 rows.
    assertIncludes(out, '1,200 lines');
    assert.ok(!out.includes('const line600 = 600;'), 'the paste itself must not be painted into the frame');

    // …and the model still got the whole thing.
    const session = latestSession(configDir);
    assert.ok(session, 'a session should have been saved');
    const user = (session.messages || []).find((m) => m.role === 'user');
    assert.ok(user, 'the pasted prompt must reach the conversation');
    for (const needle of ['const line0 = 0;', 'const line600 = 600;', `const line${LINES - 1} = ${LINES - 1};`]) {
      assertIncludes(user.content, needle, 'the buffer lost part of the paste');
    }
    assert.strictEqual(user.content.split('\n').length, LINES, 'every pasted line must survive');
  });
};
