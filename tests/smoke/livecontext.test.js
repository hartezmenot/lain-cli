'use strict';

/**
 * THE CONVERSATION STAYS ON SCREEN WHILE THE MODEL WORKS.
 *
 * Reported from a live session: "LAIN's visible CONTEXT suddenly becomes
 * completely EMPTY / BLANK" while omniroute was still generating.
 *
 * ------------------------------------------------------------------------
 * THE INVARIANT, checked on EVERY DRAWN FRAME rather than at the end:
 *
 *     a frame that shows the task banner must also show the conversation
 *
 * Checking only the final frame is what let this survive: the last frame is
 * drawn after the turn has been recorded, so it is populated even when every
 * frame in the middle was blank. The failure is entirely in the middle.
 *
 * WHY A FRAME CAN GO BLANK. The pane is drawn from two sources — the LIVE story
 * while a turn runs, and `session.turns` once it has ended — and
 * `ui.story.endTurn()` clears the live half unconditionally. Any ending that
 * finishes without writing the persisted half leaves both empty in the same
 * frame. Two endings did exactly that.
 *
 * LIVE CLI VERIFIED: the real binary, the real draw path, real child processes.
 * The network call is the mock.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, frames } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function project(extra = {}) {
  const cwd = tmpdir('live-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    trustedPaths: [{ path: cwd, level: 'TRUSTED' }], ...extra,
  }));
  return { cwd, configDir };
}

/**
 * The invariant, applied to every frame.
 *
 * @returns {{blank:number, checked:number, sample:string}}
 */
function scan(out, objective, marker) {
  const fr = frames(out).map(plain);
  let seen = false;
  let blank = -1;
  let checked = 0;
  fr.forEach((f, i) => {
    // ---- THE FRAME IS IDENTIFIED BY THE OBJECTIVE, not by a banner -------
    //
    // It was `TASK  <objective>` — the pinned task banner, which is gone with
    // the panes. The objective IS the first thing the user said, so the frames
    // this test is about are the ones where the CONVERSATION carries it, which
    // is the same set of frames identified by the same string.
    if (!f.includes(objective)) return;
    checked += 1;
    const populated = marker.test(f);
    if (populated) { seen = true; return; }
    // Only a frame AFTER the conversation has appeared can be said to have
    // lost it; the frames before the first token are legitimately bare.
    if (seen && blank < 0) blank = i;
  });
  return { blank, checked, sample: blank >= 0 ? fr[blank].split('\n').slice(0, 14).join('\n') : '' };
}

module.exports = async function () {
  await test('LIVE CTX: a multi-step turn never blanks the conversation', async () => {
    const { cwd, configDir } = project();
    const script = [];
    for (let i = 0; i < 6; i++) {
      script.push({
        text: `Step ${i}. MARKER_${i}`,
        tool_calls: [{ name: 'run_bash', input: { command: `echo step-${i}` } }],
      });
    }
    script.push({ text: 'ALL_DONE.' });
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdin: 'do the multi step job\n',
      script,
      timeoutMs: 120000,
    });
    const v = scan(r.out, 'do the multi step job', /MARKER_\d|ALL_DONE|Ran echo/);
    assert.ok(v.checked > 3, `only ${v.checked} frames showed the task at all`);
    assert.strictEqual(v.blank, -1,
      `the conversation vanished at frame ${v.blank} while the turn was running:\n${v.sample}`);
  });

  await test('LIVE CTX: it survives the compaction that fits the provider payload', async () => {
    // . A message-count cap this low forces contextfit to fold
    // mid-turn — the operation the user suspected of blanking the screen.
    const { cwd, configDir } = project({ providerLimits: { mock: { messages: 24 } } });
    const script = [];
    for (let i = 0; i < 8; i++) {
      script.push({
        text: `Step ${i}. MARKER_${i}`,
        tool_calls: [{ name: 'run_bash', input: { command: `echo step-${i}` } }],
      });
    }
    script.push({ text: 'COMPACTED_AND_DONE.' });
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30', LAIN_MOCK_WIRELOG: path.join(cwd, 'wire.log') },
      stdin: 'do the long job\n',
      script,
      timeoutMs: 120000,
    });
    // THE FOLD REALLY HAPPENED — otherwise this proves nothing.
    const sent = fs.readFileSync(path.join(cwd, 'wire.log'), 'utf8').split('\n').filter(Boolean)
      .map((l) => Number(l.split('\t')[0]));
    assert.ok(sent.some((n) => n <= 24), `no request was ever folded to the cap: ${sent.join(',')}`);
    const v = scan(r.out, 'do the long job', /MARKER_\d|COMPACTED_AND_DONE|Ran echo/);
    assert.strictEqual(v.blank, -1,
      `compaction blanked the visible conversation at frame ${v.blank}:\n${v.sample}`);
  });

  await test('LIVE CTX: a turn that fails at the provider still leaves the screen readable', async () => {
    // The ending that was measured writing NOTHING to the transcript. With the
    // live story cleared and no persisted turn, the pane went empty — losing
    // the user's own sentence to a provider problem.
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdin: 'DISTINCTIVE_REQUEST please\n',
      script: [{ error: { status: 500, message: 'upstream exploded' } }],
      timeoutMs: 90000,
    });
    const last = plain(frames(r.out).slice(-1)[0] || '');
    assert.match(last, /DISTINCTIVE_REQUEST/,
      `the user's own words were lost when the provider failed:\n${last}`);
  });

  await test('LIVE CTX: interrupting mid-turn keeps what was already said', async () => {
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['DISTINCTIVE_TASK go\n', '\x03', '/exit\n'],
      stepDelayMs: 1800,
      script: [
        { text: 'Starting. MARKER_A', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "setTimeout(()=>{},4000)"' } }] },
        { text: 'More.' },
      ],
      timeoutMs: 90000,
    });
    const last = plain(frames(r.out).slice(-1)[0] || '');
    assert.match(last, /DISTINCTIVE_TASK|MARKER_A/,
      `an interrupt emptied the conversation:\n${last}`);
  });

  await test('LIVE CTX: a second session in the same folder shows its OWN conversation', async () => {
    const { cwd, configDir } = project();
    await runCli(['-p', 'SESSION_A_WORK'], {
      cwd, configDir, script: [{ text: 'A finished.' }], timeoutMs: 60000,
    });
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdin: 'SESSION_B_WORK\n',
      script: [{ text: 'B finished.' }],
      timeoutMs: 60000,
    });
    const last = plain(frames(r.out).slice(-1)[0] || '');
    assert.match(last, /B finished/, 'the second session must show its own turn');
    assert.ok(!/SESSION_A_WORK|A finished/.test(last),
      `the second session inherited the first session's conversation:\n${last}`);
  });
};
