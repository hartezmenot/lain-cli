'use strict';

/**
 * THE SCREEN MUST CHANGE WITHOUT BEING TYPED AT.
 *
 * Two defects observed in a real terminal, both of the same shape: a state that
 * had genuinely changed did not reach the screen until the user pressed a key.
 * A status that needs a keystroke to become true is worse than no status — it
 * teaches you that the screen is not live.
 *
 * And one keyboard trap: the completion overlay is returned by `workspaceLines`
 * BEFORE the view switch, so it covers all seven panes at once. Tab still moved
 * `screen.view` and the content never changed, which reads as a pane you cannot
 * leave; it advertised "[R] resume" and did nothing with R.
 *
 * Everything here drives bin/lain.js and asserts on frames it actually drew.
 * LIMITATION: LAIN_FORCE_TUI is the real draw path over a PIPE, not an attached
 * terminal.
 */

const assert = require('assert');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
// Per-frame boundary is `\x1b[?25l` (hide-cursor, once per draw(), nowhere
// else) now that a redraw no longer opens with a full-screen clear.
const frames = (out) => String(out).split('\x1b[?25l').slice(1).map(plain);
const tui = (cols = 100, rows = 30) => ({ LAIN_FORCE_TUI: '1', COLUMNS: String(cols), LINES: String(rows) });

module.exports = async function () {
  // ---------------------------------------------------------- rate limit ---

  await test('LIVE-UI: a rate limit appears and COUNTS DOWN with no keystroke at all', async () => {
    // One line of stdin, then nothing. Every frame after it is drawn by the
    // ticker, not by the user.
    const r = await runCli([], {
      cwd: tmpdir('rl-'), env: tui(),
      stdin: 'do the thing\n',
      script: [
        { error: { status: 429, retryAfter: 6, message: 'rate limited' } },
        { text: 'done at last' },
      ],
      timeoutMs: 60000,
    });
    const shown = frames(r.out).filter((f) => /RATE\s+LIMITED/i.test(f));
    // ---- FEWER FRAMES, AND THAT IS THE IMPROVEMENT --------------------
    //
    // The threshold was 8. Identical frames are not written (ui/layout.js keeps
    // `_lastFrame`), so the only thing that used to change often enough to force a
    // redraw during a six-second wait was the stream of durable retry NOTICES
    // being appended to the feed. Those are gone; what moves now is the countdown
    // and the clock, once a second.
    //
    // So the frame count is a weak proxy and the assertion below is the real test:
    // DISTINCT COUNTDOWN VALUES prove the redraw is driven by the clock and not by
    // input, which is what this is for.
    assert.ok(shown.length >= 5,
      `only ${shown.length} frames showed the wait — the screen is not redrawing on its own`);
    // The countdown must actually move. Distinct values prove the redraw is
    // driven by the clock rather than by input.
    const seen = new Set(shown.map((f) => (f.match(/(\d\d:\d\d) remaining/) || [])[1]).filter(Boolean));
    assert.ok(seen.size >= 4, `the countdown did not move: saw ${[...seen].join(' ') || 'nothing'}`);
    const out = plain(r.out);
    assert.match(out, /RATE\s+LIMITED/i);
    assert.match(out, /retrying at \d\d:\d\d/, 'an absolute reset time');
    assertIncludes(out, 'Esc', 'and a way out of the wait');
    // `Resuming`, on the operation channel — the durable announcement that a
    // transient condition had passed is gone. See turn.js.
    assert.match(out, /Resuming/, 'the end of the wait is visible');
    assertIncludes(out, 'done at last', 'the ORIGINAL task continued; no new one was needed');
    assert.strictEqual(r.code, 0);
  });

  await test('LIVE-UI: the tool in flight is redrawn while nothing is typed', async () => {
    const r = await runCli([], {
      cwd: tmpdir('tick-'), env: tui(),
      stdin: 'audit it\n',
      script: [
        { text: 'Working.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 3' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 45000,
    });
    const busy = frames(r.out).filter((f) => /RUNNING\s+sleep 3/i.test(f));
    assert.ok(busy.length >= 6, `only ${busy.length} frames during a 3s wait`);
    // NO ACTOR COLUMN FOR LAIN'S OWN WORK: the row is `◐ Running  sleep 3`, not
    // `◐ TOOL     RUNNING  sleep 3` — a tool call IS LAIN running a tool, so the
    // column said nothing the verb did not. See ui/status.js.
    const spinners = new Set(busy.map((f) => (f.match(/([◐◓◑◒])\s+Running/) || [])[1]).filter(Boolean));
    assert.ok(spinners.size >= 3, `the indicator never moved: ${[...spinners].join('') || 'nothing'}`);
  });

  // ----------------------------------------------------- completion keys ---

  /** A run that genuinely completes: a change AND a check, so the overlay fires. */
  const completed = (steps) => ({
    cwd: tmpdir('ovl-'),
    env: tui(),
    stdinSteps: ['build it\n', ...steps],
    // ---- LONG ENOUGH THAT THE KEY LANDS AFTER THE OVERLAY ----------------
    //
    // It was 900ms against a FIVE-STEP turn - a write, a shell call, a plan, a
    // tick and an answer - so the keystroke was racing the very work whose report
    // it is meant to dismiss. Measured: about one isolated run in three failed,
    // while full tiers passed, which is the signature of a timing-dependent test
    // rather than a wrong one.
    //
    // The assertions are unchanged; the test simply waits for the thing it is
    // about before pressing a key at it.
    stepDelayMs: 3000,
    script: [
      { text: 'Writing.', tool_calls: [{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }] },
      { text: 'Checking.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "1"' } }] },
      { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { steps: ['only step'] } }] },
      { text: 'Ticking.', tool_calls: [{ name: 'plan_step_done', input: { note: 'built and checked' } }] },
      { text: 'All done.' },
    ],
    timeoutMs: 45000,
  });

  // ---- THE TASK-COMPLETE OVERLAY IS A REPORT, NOT A PLACE -----------------
  //
  // It used to offer a CHOICE — `❯ diff` or `❯ keep working` — navigated with
  // Up/Down and taken with Enter, and the first branch switched to the DIFF
  // pane. Before that the two were `[D]` and `[R]`: printable letters a screen
  // showing plain text could never make live, which is the failure this whole
  // section was written to hold closed.
  //
  // With one surface there is nowhere to switch to, so both branches meant the
  // same thing — put the report away. The choice is gone and the report names
  // `/changes` instead, which is a command that exists rather than a row that
  // has to be disposed of before you can carry on.
  //
  // WHAT MUST STILL HOLD, and is what these three now assert:
  //
  //   1. the overlay fires on GENUINE completion, and only then
  //   2. every key dismisses it — none is swallowed, none is advertised and
  //      dead, and typing lands in the input box like typing
  //   3. it names only things that work

  await test('LIVE-UI: the overlay fires on completion, and any key leaves it', async () => {
    for (const key of ['\t', '\r', '\x1b']) {
      const r = await runCli([], completed([key]));
      const all = frames(r.out);
      assert.ok(all.some((f) => /TASK COMPLETE/.test(f)),
        `the overlay must fire on genuine completion (key ${JSON.stringify(key)})`);
      const after = all[all.length - 1];
      assert.ok(!/TASK COMPLETE/.test(after),
        `${JSON.stringify(key)} did not leave the overlay:\n${after.slice(0, 400)}`);
      // AND THE SURFACE IS UNDERNEATH IT, unchanged — there is no pane to have
      // been left on, so what must be there is the one there always is.
      assertIncludes(after, 'Ask LAIN', 'the surface is back, with its input');
      assert.strictEqual(r.code, 0);
    }
  });

  await test('LIVE-UI: it advertises only what works, and offers no choice to dispose of', async () => {
    const r = await runCli([], completed(['\x1b']));
    const out = plain(r.out);
    assertIncludes(out, 'TASK COMPLETE');
    // THE COMMANDS IT NAMES ARE REAL. `/changes` is where the diff went.
    assertIncludes(out, '/changes', 'it names the command that shows what changed');
    // AND THERE IS NO MENU. A highlighted row is something you have to deal
    // with before you can carry on; a named command is something you type when
    // you want it.
    assert.ok(!/❯ keep working|❯ diff/.test(out), 'the two-row choice is gone');
    assert.ok(!/\[D\]|\[R\]/.test(out), 'and so are the letters that never worked');
    assert.strictEqual(r.code, 0);
  });

  await test('LIVE-UI: typing dismisses it and reaches the input line, like typing', async () => {
    // The shortcut path must not swallow ordinary typing. Each letter dismisses
    // the report (you have started composing) and lands in the input exactly
    // like any other — proof the old single-letter claims are gone, not just
    // replaced with a different pair of letters.
    for (const ch of ['d', 'r', 'x']) {
      const r = await runCli([], completed([ch]));
      const raw = String(r.out).split('\x1b[?25l');
      // FOUND BY THE CARET: the input has no `> ` prompt any more, and a single
      // letter is too small to search for in a whole frame. A frame that parks
      // the cursor one column past the start of the input is a frame with
      // exactly one character on that line.
      //
      // THE COLUMN IS COMPUTED, NOT WRITTEN DOWN. It was the literal 3, which was
      // right while the composer started at column 2. It starts at the content
      // frame's inset plus the composer's own padding now (ui/frame.js, PAD), and a
      // test that knows the number breaks every time the frame changes.
      const at = require('../../src/ui/frame').contentBounds(100).left + 1
        + require('../../src/ui/inputbox').PAD + 1;
      const typed = raw.find((f) => {
        const marks = [...f.matchAll(/\x1b\[(\d+);(\d+)H/g)];
        const park = marks[marks.length - 1];
        return Boolean(park) && Number(park[2]) === at && plain(f).includes(ch);
      });
      assert.ok(typed, `"${ch}" must reach the input line:\n${plain(raw.pop() || '').slice(-300)}`);
      assert.ok(!/TASK COMPLETE/.test(plain(typed)), `and typing "${ch}" dismisses the report`);
    }
  });

  // ------------------------------------------------------------ progress ---

  await test('LIVE-UI: the strip carries the step and the percentage', async () => {
    const r = await runCli([], {
      cwd: tmpdir('prog-'), env: tui(),
      stdin: 'do the work\n',
      script: [
        { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { steps: ['a', 'b', 'c', 'd'] } }] },
        { text: 'One.', tool_calls: [{ name: 'plan_step_done', input: { note: 'a' } }] },
        { text: 'Slow bit.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 2' } }] },
        { text: 'Done for now.' },
      ],
      timeoutMs: 45000,
    });
    // ------------------------------------------------------------------
    // THE PROGRESS BAR WAS DRAWN TWICE, AND NOW IT IS DRAWN ON REQUEST.
    //
    // `STEP 1/4 ███░░░ 25%` appeared in the live row's right-hand column AND in
    // the pinned task banner at the top of the same screen: one measurement,
    // two indicators, competing for the corner where the thing that moves every
    // second needed to be. The banner went with the panes; the live row's copy
    // went earlier, to make room for what a person watching a long turn
    // actually cannot get anywhere else — what it is costing.
    //
    // So the live row's job is WHAT IS HAPPENING NOW, and this asserts exactly
    // that. The measurement is `/plan`, and tests/unit/interrupt.test.js holds
    // it there.
    // ------------------------------------------------------------------
    const f = frames(r.out).find((x) => /RUNNING\s+sleep 2/i.test(x));
    assert.ok(f, 'a frame must show the tool running');
    assert.match(f, /RUNNING\s+sleep 2/i, 'the live row names the operation and its subject');
    assert.ok(!/STEP \d\/4/.test(f.split('\n').filter((l) => /RUNNING\s+sleep 2/i.test(l)).join('')),
      'and does not carry a second copy of the plan\'s progress');
  });

  await test('LIVE-UI: a finished PLAN never prints the word DONE in the progress block', async () => {
    const r = await runCli([], {
      cwd: tmpdir('plan100-'), env: tui(),
      stdin: 'do the work\n',
      script: [
        { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { steps: ['only step'] } }] },
        { text: 'Editing.', tool_calls: [{ name: 'write_file', input: { path: 'a.txt', content: 'x' } }] },
        { text: 'Ticking.', tool_calls: [{ name: 'plan_step_done', input: { note: 'done' } }] },
        { text: 'All planned steps are complete.' },
      ],
      timeoutMs: 45000,
    });
    // ---- THE MEASUREMENT MOVED; THE CLAIM IT MUST NOT MAKE DID NOT --------
    //
    // The progress block was pinned above the feed and is now `/plan`, so the
    // percentage is asked for rather than always drawn. What this test exists
    // for is the other half, and it is unchanged: A FINISHED PLAN IS NOT A
    // FINISHED TASK. The screen must say VERIFYING, because nothing was run to
    // check the change, and must never report the task as complete.
    const out = plain(r.out);
    assert.match(out, /VERIFYING/i, 'the task is not done: nothing was run to check the change');
    assert.ok(!/TASK COMPLETE/.test(out), 'and it must not be reported as finished');
    assert.ok(!/\bDONE\b/.test(out.split('VERIFYING').pop() || ''),
      'nor described as done after it');
  });
};
