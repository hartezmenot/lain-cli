'use strict';

/**
 * WHAT THE USER CAN SEE, through the real binary.
 *
 * The unit tier proves the state machine is right. These prove it is WIRED and
 * on screen — which is the distinction that mattered, because `turn.js` computed
 * the phase before every provider call and every tool for the whole life of the
 * project, and nothing ever passed an `onStatus` to receive it. Every liveness
 * function was correct and none of it reached a terminal.
 *
 * So each case spawns bin/lain.js, renders the frames it actually drew, and
 * asserts on the text a person would have read.
 */

const assert = require('assert');
const { test, runCli, tmpdir, assertIncludes, firstTabMark } = require('../helpers');

const ETX = String.fromCharCode(3);          // Ctrl+C
const tui = (cols = 96, rows = 28) => ({ LAIN_FORCE_TUI: '1', COLUMNS: String(cols), LINES: String(rows) });

/**
 * The stream is a sequence of complete frames. `draw()` no longer opens each
 * one with a full-screen clear (that was the flicker fix — see ui/layout.js's
 * `L` helper); it still opens each one with `\x1b[?25l` (hide-cursor), written
 * nowhere else, so that is the per-frame boundary now.
 */
const frames = (out) => String(out).split('\x1b[?25l').slice(1);
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A script whose tool takes real time, so a wait is genuinely observable. */
const slowScript = (secs = 3) => [
  { text: 'Starting the audit.', tool_calls: [{ name: 'grep', input: { pattern: 'SessionStrategist' } }] },
  { text: 'Now the slow part.', tool_calls: [{ name: 'run_bash', input: { command: `sleep ${secs}` } }] },
  { text: 'Done.' },
];

module.exports = async function () {
  await test('SEE: the screen says THINKING while it waits for the model', async () => {
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(1) });
    const out = plain(r.out);
    assertIncludes(out, 'THINKING', 'waiting on the provider must be visible in the header');
    assertIncludes(out, 'waiting for the model', 'and said in words on the status strip above the input');
  });

  await test('SEE: the screen names the TOOL while the tool is running', async () => {
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(1) });
    const out = plain(r.out);
    assertIncludes(out, 'RUNNING', 'a tool executing is a different state from waiting on a server');
    assertIncludes(out, 'Searched for "SessionStrategist"', 'and the subject is said the way a person would');
  });

  await test('SEE: the screen KEEPS UPDATING through a long wait — it cannot look frozen', async () => {
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(3), timeoutMs: 45000 });
    // The whole point: a redraw happens while nothing else does. Count frames
    // drawn during the 3-second tool, and the distinct spinner phases in them.
    const running = frames(r.out).map(plain).filter((f) => /RUNNING\s+sleep 3/.test(f));
    assert.ok(running.length >= 6, `only ${running.length} frames drawn during a 3s wait — the screen would look dead`);
    // The strip now carries the ACTOR between the spinner and the state word —
    // `◐ TOOL     RUNNING  sleep 3` — because with an external model in the loop
    // "who is doing this" is the first thing you need to know.
    const spinners = new Set(running.map((f) => (f.match(/([◐◓◑◒])\s+\S+\s+RUNNING\s+sleep 3/) || [])[1]).filter(Boolean));
    assert.ok(spinners.size >= 3, `the indicator did not move: saw ${[...spinners].join('') || 'nothing'}`);
  });

  await test('SEE: the elapsed time of a real wait is shown', async () => {
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(3), timeoutMs: 45000 });
    assert.match(plain(r.out), /RUNNING\s+sleep 3\s+\ds/, 'a long wait must say how long, or it reads as a hang');
  });

  await test('SEE: work already done stays on screen WHILE the next step runs', async () => {
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(3), timeoutMs: 45000 });
    // session.turns only gains its entry at turn END; without the in-flight feed
    // this frame showed a status line above an empty region.
    const mid = frames(r.out).map(plain).find((f) => /RUNNING\s+sleep 3/.test(f) && /Searched for/.test(f));
    assert.ok(mid, 'the completed call must remain visible while the next one runs');
  });

  // ------------------------------------------------------------- regions ---

  await test('SEE: the screen is FRAMED — header, workspace and interaction', async () => {
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(1) });
    const out = plain(r.out);
    assertIncludes(out, '┌─ L A I N', 'the top region is a box, not floating text');
    assertIncludes(out, firstTabMark(), 'the workspace is enclosed and labelled by its own selector');
    assertIncludes(out, '┌─ INPUT', 'the interaction region is always identifiable');
  });

  await test('SEE: the interaction frame RENAMES itself to what it currently is', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: ['audit it\n', '/'], stepDelayMs: 700,
      script: slowScript(3), timeoutMs: 45000,
    });
    assertIncludes(plain(r.out), '┌─ COMMANDS', 'the palette renames the interaction region');
  });

  // ------------------------------------------------- commands during work ---

  await test('SEE: `/` opens the palette WHILE the model is working', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: ['audit it\n', '/', 'sta'], stepDelayMs: 700,
      script: slowScript(4), timeoutMs: 45000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'COMMANDS', 'the palette must open during an active turn');
    assertIncludes(out, '/status', 'and filter as it is typed');
    // The turn must be untouched by the user looking something up.
    assert.match(out, /RUNNING\s+sleep 4/, 'and the work carries on underneath');
  });

  await test('SEE: a command chosen during a turn runs NOW, not after it', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: ['audit it\n', '/', 'sta', '\r'], stepDelayMs: 700,
      script: slowScript(5), timeoutMs: 45000,
    });
    // /status printed while `sleep 5` was still running: its output and the
    // live row appear in the SAME frame.
    const both = frames(r.out).map(plain).find((f) => /RUNNING\s+sleep 5/.test(f) && /config\s+\S/.test(f));
    assert.ok(both, 'the command output must appear while the turn is still in flight');
  });

  await test('SEE: a command that would rewrite the session says so instead of doing it', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: ['audit it\n', '/new\n'], stepDelayMs: 800,
      script: slowScript(4), timeoutMs: 45000,
    });
    const out = plain(r.out);
    assertIncludes(out, "can't run while a turn is in flight", 'a blocked command must explain, never hang');
    assertIncludes(out, 'audit it', 'and the task must survive');
  });

  // ---------------------------------------------------------------- ctrl+c --

  await test('SEE: Ctrl+C while working shows INTERRUPTING, then INTERRUPTED', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: ['audit it\n', ETX], stepDelayMs: 900,
      script: slowScript(6), timeoutMs: 45000,
    });
    const seen = frames(r.out).map(plain);
    const iAt = seen.findIndex((f) => /INTERRUPTING/.test(f));
    const dAt = seen.findIndex((f) => /INTERRUPTED/.test(f));
    assert.ok(iAt >= 0, 'the cancel must be acknowledged immediately, not after the unwind');
    assert.ok(dAt > iAt, 'and it must settle into INTERRUPTED');
    // No frame between them may claim everything is fine.
    const between = seen.slice(iAt, dAt).filter((f) => /○ READY/.test(f));
    assert.deepStrictEqual(between, [], 'READY must never flash between INTERRUPTING and INTERRUPTED');
  });

  await test('SEE: Ctrl+C is not swallowed by an open panel', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: ['audit it\n', '/', ETX], stepDelayMs: 800,
      script: slowScript(6), timeoutMs: 45000,
    });
    assertIncludes(plain(r.out), 'INTERRUPTED', 'Ctrl+C must stay a global interrupt with a menu open');
  });

  await test('SEE: idle Ctrl+C asks, and a second one leaves cleanly', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: [ETX, ETX], stepDelayMs: 500,
      script: [], timeoutMs: 20000,
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(plain(r.out), 'Press Ctrl+C again to exit', 'the confirmation needs no Escape first');
    assertIncludes(r.out, 'Session saved', 'and the second press exits cleanly');
  });

  // ------------------------------------------------------------- failure ---

  await test('SEE: a dead provider ends on ERROR, not quietly on READY', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(), stdin: 'do the thing\n',
      // AN OUTAGE THAT NEVER LIFTS: a script that runs out mid-retry answers
      // SUCCESSFULLY, which is the one thing this test must not let happen.
      // Three used to be enough when the budget was 2; it is 5 now ().
      script: Array.from({ length: 8 }, () => ({ error: { code: 'ECONNRESET', message: 'connection reset' } })),
    });
    const out = plain(r.out);
    // Both must be true: the header carries the outcome AND the feed explains.
    assertIncludes(out, 'ERROR', 'the header must not report READY after a failure');
    assertIncludes(out, 'not answering', 'and the reason must be on screen');
    assertIncludes(out, 'session is intact', 'with what it means for the user');
  });

  await test('SEE: the session survives a provider failure and still accepts input', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: ['do the thing\n', '/status\n'], stepDelayMs: 700,
      script: Array.from({ length: 8 }, () => ({ error: { status: 503, message: 'upstream down' } })),
      timeoutMs: 30000,
    });
    assert.strictEqual(r.code, 0, 'a provider failure must not kill the REPL');
    assertIncludes(plain(r.out), 'config', '/status still works afterwards');
  });

  // -------------------------------------------------------- small screens ---

  await test('SEE: at every required size the user can still tell it is working', async () => {
    for (const [cols, rows] of [[120, 40], [80, 24], [60, 15], [40, 9]]) {
      const r = await runCli([], {
        cwd: tmpdir('live-'), env: tui(cols, rows),
        stdin: 'audit it\n', script: slowScript(2), timeoutMs: 40000,
      });
      const out = plain(r.out);
      assert.ok(/RUNNING\s+sleep 2|THINKING/.test(out), `${cols}x${rows}: no live status survived`);
      assertIncludes(out, '┌─ INPUT', `${cols}x${rows}: the input region must always be identifiable`);
    }
  });
};
