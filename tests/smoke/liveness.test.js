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
const { test, runCli, tmpdir, assertIncludes, headerMark, isRuleRow } = require('../helpers');

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
  {
    text: 'Starting the audit.',
    tool_calls: [
      { name: 'grep', input: { pattern: 'SessionStrategist' } },
      // AND ONE CALL THAT LEAVES A ROW. A successful search is live state and
      // leaves nothing in the conversation (ui/durable.js), so a script made only
      // of searches has no COMPLETED WORK for the third test below to find on
      // screen while the next step runs.
      { name: 'write_file', input: { path: 'gen/audit.md', content: '# audit' } },
    ],
  },
  { text: 'Now the slow part.', tool_calls: [{ name: 'run_bash', input: { command: `sleep ${secs}` } }] },
  { text: 'Done.' },
];

/**
 * OUTAGE FIXTURES ARE SIZED FROM THE BUDGET, NOT FROM A NUMBER.
 *
 * The retry budget has been 2, then 5, then 10. Every time it moved, a
 * fixture of N hardcoded refusals stopped exhausting it: the script ran out
 * mid-retry, the mock answered SUCCESSFULLY, and a test about a provider
 * that never comes back started passing through to a happy path — which
 * these tests' own comments call the one thing they must not allow.
 *
 * Derived from backoff.js, they follow the policy instead of failing on it.
 */
const { MAX_RETRIES } = require('../../src/backoff');
/** Enough refusals to outlast the budget, with room for the first request. */
const OUTAGE = (make) => Array.from({ length: MAX_RETRIES + 4 }, make);

module.exports = async function () {
  await test('SEE: the screen says THINKING while it waits for the model', async () => {
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(1) });
    const out = plain(r.out);
    assert.match(out, /THINKING/i, 'waiting on the provider must be visible in the header');
    assertIncludes(out, 'waiting for the model', 'and said in words on the status strip above the input');
  });

  await test('SEE: the screen names the TOOL while the tool is running', async () => {
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(1) });
    const out = plain(r.out);
    assert.match(out, /RUNNING/i, 'a tool executing is a different state from waiting on a server');
    // ---- THE LIVE ROW'S OWN WORDS, NOT THE FEED'S ---------------------
    //
    // This looked for the phrasing ui/phrasing.js gives a FINISHED call in the
    // conversation. A successful search no longer leaves a row there at all
    // (ui/durable.js): it is live state, which is exactly what this test is
    // about. So it is asserted where it actually lives - on the one row above the
    // caret, in that row's own vocabulary (ui/status.js VERB).
    assert.match(out, /SEARCHING/i, 'the live row names what kind of work is in flight');
    assertIncludes(out, 'SessionStrategist', 'and names its subject');
  });

  await test('SEE: the screen KEEPS UPDATING through a long wait — it cannot look frozen', async () => {
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(3), timeoutMs: 45000 });
    // The whole point: a redraw happens while nothing else does. Count frames
    // drawn during the 3-second tool, and the distinct spinner phases in them.
    const running = frames(r.out).map(plain).filter((f) => /RUNNING\s+sleep 3/i.test(f));
    assert.ok(running.length >= 6, `only ${running.length} frames drawn during a 3s wait — the screen would look dead`);
    // ---- NO ACTOR COLUMN FOR LAIN'S OWN WORK --------------------------
    //
    // It was `◐ TOOL     RUNNING  sleep 3` and the pattern required the actor
    // between the spinner and the word. A tool call IS LAIN running a tool, so the
    // column said nothing the verb did not and is drawn only for an actor that is
    // NOT this program — the network, the bridge, a second model, the user. The
    // row is `◐ Running  sleep 3` now. See ui/status.js.
    const spinners = new Set(running.map((f) => (f.match(/([◐◓◑◒])\s+Running\s+sleep 3/) || [])[1]).filter(Boolean));
    assert.ok(spinners.size >= 3, `the indicator did not move: saw ${[...spinners].join('') || 'nothing'}`);
  });

  await test('SEE: the elapsed time of a real wait is shown', async () => {
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(3), timeoutMs: 45000 });
    // ---- THE FIGURE IS THE TASK'S CLOCK, NOT THE PHASE'S AGE ----------
    //
    // This matched `RUNNING sleep 3   3s` - the age of the CURRENT PHASE, drawn
    // immediately after the detail. That figure restarted at every read, write
    // and retry, so it never answered how long the person had been waiting; it is
    // one `HH:MM:SS` for the whole submission now, in the row's right-hand column
    // (ui/workclock.js). The property is unchanged: a long wait must carry a
    // number, or a working LAIN reads as a dead one.
    assert.match(plain(r.out), /RUNNING\s+sleep 3[^\n]*\d\d:\d\d:\d\d/i,
      'a long wait must say how long, or it reads as a hang');
  });

  await test('SEE: work already done stays on screen WHILE the next step runs', async () => {
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(3), timeoutMs: 45000 });
    // session.turns only gains its entry at turn END; without the in-flight feed
    // this frame showed a status line above an empty region.
    const mid = frames(r.out).map(plain).find((f) => /RUNNING\s+sleep 3/i.test(f) && /audit\.md/.test(f));
    assert.ok(mid, 'the completed call must remain visible while the next one runs');
  });

  // ------------------------------------------------------------- regions ---

  await test('SEE: the screen is READABLE — header, conversation, activity, input', async () => {
    // ------------------------------------------------------------------
    // IT USED TO ASSERT `┌─ L A I N`, and the argument for it was sound at the
    // time: the regions were bare text separated by blank rows, so the screen
    // read as a stack of paragraphs rather than an interface, and a border made
    // the boundaries unmistakable.
    //
    // The boundaries are made by CONTRAST and WHITESPACE now, which costs four
    // fewer rows: one dim header row over a rule, the conversation, one live
    // row, and an input on a grey ground. What has to stay true is that a
    // person can tell the regions apart — and the two that are always drawn are
    // the two asserted below.
    // ------------------------------------------------------------------
    const r = await runCli([], { cwd: tmpdir('live-'), env: tui(), stdin: 'audit it\n', script: slowScript(1) });
    const out = plain(r.out);
    assert.ok(!out.includes('┌─ L A I N'), 'the header is no longer a box');
    // THE TWO LANDMARKS THAT ARE ALWAYS DRAWN. It used to be the tab strip and
    // the input's labelled border; both are gone. The header carries the
    // wordmark and the input carries what it is for, which is the same
    // guarantee with two fewer rows of chrome.
    assertIncludes(out, headerMark(), 'the header names the program and the project');
    assertIncludes(out, 'Ask LAIN', 'and the interaction region is always identifiable');
  });

  await test('SEE: an open picker NAMES itself, in its own panel below the input', async () => {
    // The input's border used to RENAME itself — `┌─ COMMANDS`, `┌─ FILES` —
    // because the picker had no title of its own to carry. It has one, and the
    // input has no border: the panel opens directly under the line you are
    // filtering with, titled for what it is doing. Same guarantee, one label
    // instead of two on two regions.
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: ['audit it\n', '/'], stepDelayMs: 700,
      script: slowScript(3), timeoutMs: 45000,
    });
    const out = plain(r.out);
    assert.match(out, /commands/i, 'the picker says what it is');
    assert.ok(!out.includes('┌─ COMMANDS'),
      'and it is its own panel rather than a label on the input region');
  });

  // ------------------------------------------------- commands during work ---

  await test('SEE: `/` opens the palette WHILE the model is working', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: ['audit it\n', '/', 'sta'], stepDelayMs: 700,
      script: slowScript(4), timeoutMs: 45000,
    });
    const out = plain(r.out);
    assert.match(out, /commands/i, 'the palette must open during an active turn');
    assertIncludes(out, '/status', 'and filter as it is typed');
    // The turn must be untouched by the user looking something up.
    assert.match(out, /RUNNING\s+sleep 4/i, 'and the work carries on underneath');
  });

  await test('SEE: a command chosen during a turn runs NOW, not after it', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: ['audit it\n', '/', 'sta', '\r'], stepDelayMs: 700,
      script: slowScript(5), timeoutMs: 45000,
    });
    // /status printed while `sleep 5` was still running: its output and the
    // live row appear in the SAME frame.
    const both = frames(r.out).map(plain).find((f) => /RUNNING\s+sleep 5/i.test(f) && /config\s+\S/.test(f));
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
    const iAt = seen.findIndex((f) => /INTERRUPTING/i.test(f));
    const dAt = seen.findIndex((f) => /INTERRUPTED/i.test(f));
    assert.ok(iAt >= 0, 'the cancel must be acknowledged immediately, not after the unwind');
    assert.ok(dAt > iAt, 'and it must settle into INTERRUPTED');
    // No frame between them may claim everything is fine.
    // `○ READY` WAS THE HEADER'S STATUS WORD AND DOT, and both are gone: what
    // LAIN is doing has one owner, the live row above the caret. The property
    // is unchanged — READY must never flash between INTERRUPTING and
    // INTERRUPTED — only the place it is read from.
    const between = seen.slice(iAt, dAt).filter((f) => /LAIN\s+READY/.test(f));
    assert.deepStrictEqual(between, [], 'READY must never flash between INTERRUPTING and INTERRUPTED');
  });

  await test('SEE: Ctrl+C is not swallowed by an open panel', async () => {
    const r = await runCli([], {
      cwd: tmpdir('live-'), env: tui(),
      stdinSteps: ['audit it\n', '/', ETX], stepDelayMs: 800,
      script: slowScript(6), timeoutMs: 45000,
    });
    assert.match(plain(r.out), /INTERRUPTED/i, 'Ctrl+C must stay a global interrupt with a menu open');
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
      script: OUTAGE(() => ({ error: { code: 'ECONNRESET', message: 'connection reset' } })),
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
      script: OUTAGE(() => ({ error: { status: 503, message: 'upstream down' } })),
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
      assert.ok(/RUNNING\s+sleep 2|THINKING/i.test(out), `${cols}x${rows}: no live status survived`);
      assertIncludes(out, 'Ask LAIN', `${cols}x${rows}: the input region must always be identifiable`);
    }
  });
};
