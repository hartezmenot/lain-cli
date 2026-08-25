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
    const shown = frames(r.out).filter((f) => /RATE LIMITED/.test(f));
    assert.ok(shown.length >= 8,
      `only ${shown.length} frames showed the wait — the screen is not redrawing on its own`);
    // The countdown must actually move. Distinct values prove the redraw is
    // driven by the clock rather than by input.
    const seen = new Set(shown.map((f) => (f.match(/(\d\d:\d\d) remaining/) || [])[1]).filter(Boolean));
    assert.ok(seen.size >= 4, `the countdown did not move: saw ${[...seen].join(' ') || 'nothing'}`);
    const out = plain(r.out);
    assertIncludes(out, 'RATE LIMITED');
    assert.match(out, /retrying at \d\d:\d\d/, 'an absolute reset time');
    assertIncludes(out, 'Esc', 'and a way out of the wait');
    assertIncludes(out, 'the wait is over — resuming the task');
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
    const busy = frames(r.out).filter((f) => /RUNNING\s+sleep 3/.test(f));
    assert.ok(busy.length >= 6, `only ${busy.length} frames during a 3s wait`);
    const spinners = new Set(busy.map((f) => (f.match(/([◐◓◑◒])\s+\S+\s+RUNNING/) || [])[1]).filter(Boolean));
    assert.ok(spinners.size >= 3, `the indicator never moved: ${[...spinners].join('') || 'nothing'}`);
  });

  // ----------------------------------------------------- completion keys ---

  /** A run that genuinely completes: a change AND a check, so the overlay fires. */
  const completed = (steps) => ({
    cwd: tmpdir('ovl-'),
    env: tui(),
    stdinSteps: ['build it\n', ...steps],
    stepDelayMs: 900,
    script: [
      { text: 'Writing.', tool_calls: [{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }] },
      { text: 'Checking.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "1"' } }] },
      { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { steps: ['only step'] } }] },
      { text: 'Ticking.', tool_calls: [{ name: 'plan_step_done', input: { note: 'built and checked' } }] },
      { text: 'All done.' },
    ],
    timeoutMs: 45000,
  });

  await test('LIVE-UI: the completion overlay appears, and TAB leaves it', async () => {
    const r = await runCli([], completed(['\t']));
    const all = frames(r.out);
    assert.ok(all.some((f) => /TASK COMPLETE/.test(f)), 'the overlay must fire on genuine completion');
    // After Tab the overlay is gone AND a different pane is showing. It used to
    // cover every pane, so Tab changed the tab strip and nothing else.
    const after = all[all.length - 1];
    assert.ok(!/TASK COMPLETE/.test(after), `Tab did not leave the overlay:\n${after.slice(0, 400)}`);
    assert.ok(/\[\d [a-z]+\]/.test(after), 'and a real pane is showing');
    assert.strictEqual(r.code, 0);
  });

  await test('LIVE-UI: Enter on the default highlight opens the diff — no letter needed', async () => {
    // "diff" is the FIRST choice, so a bare Enter needs no Down at all — this
    // is the direct replacement for the old dead `[D]` letter.
    const r = await runCli([], completed(['\r']));
    const out = plain(r.out);
    assertIncludes(out, 'diff — see what changed', 'the overlay must only advertise keys that work');
    const after = frames(r.out).pop() || '';
    assert.ok(!/TASK COMPLETE/.test(after), 'Enter must close the overlay');
    // WHICH NUMBER DIFF WEARS comes from ui/tabs.js. Spelled out here it was a
    // private copy of the tab order, and it went stale the moment that order
    // moved — failing about a pane the overlay had opened correctly.
    const tabs = require('../../src/ui/tabs');
    const diffTab = `[${tabs.numberOf('diff')} diff]`;
    assertIncludes(after, diffTab, `Enter on "diff" must open the DIFF pane:\n${after.slice(0, 300)}`);
    assert.strictEqual(r.code, 0);
  });

  await test('LIVE-UI: Down, Enter picks "keep working" — the direct replacement for [R]', async () => {
    const DOWN = '\x1b[B';
    const r = await runCli([], completed([DOWN, '\r']));
    const out = plain(r.out);
    assertIncludes(out, 'keep working', 'the overlay must only advertise keys that work');
    // THE MARKER ITSELF MOVED, not just the outcome — a render that always
    // highlighted "diff" but happened to still resolve "keep working" from
    // internal state would pass an outcome-only check and still be showing
    // the wrong thing on screen the whole time.
    const withOverlay = frames(r.out).filter((f) => f.includes('TASK COMPLETE'));
    assert.ok(withOverlay.some((f) => /❯ keep working/.test(f)),
      'Down must move the highlight marker onto "keep working", not just the outcome');
    // It dismisses and says so, rather than being a key that silently does
    // nothing — which is what the old `[R]` letter was.
    assertIncludes(out, 'Back to the task');
    const after = frames(r.out).pop() || '';
    assert.ok(!/TASK COMPLETE/.test(after), 'Enter must close the overlay');
    assert.strictEqual(r.code, 0);
  });

  await test('LIVE-UI: neither D nor R does anything special any more — both are just typed', async () => {
    // The shortcut path must not swallow ordinary typing. Each dismisses the
    // report (you have started composing) and lands in the input box exactly
    // like any other letter — proof the old single-letter claims are gone,
    // not just replaced with a different pair of letters.
    for (const ch of ['d', 'r', 'x']) {
      const r = await runCli([], completed([ch]));
      const all = frames(r.out);
      // Looked for across every frame, not just the last: stdin closing ends
      // the session, and the teardown frame has already cleared the input row.
      const typed = all.find((f) => f.includes(`│ > ${ch}`));
      assert.ok(typed, `"${ch}" must reach the input line:\n${(all.pop() || '').slice(-300)}`);
      assert.ok(!/TASK COMPLETE/.test(typed), `and typing "${ch}" dismisses the report`);
    }
  });

  await test('LIVE-UI: Esc closes it too, and every pane is reachable afterwards', async () => {
    const r = await runCli([], completed(['\x1b', '\t', '\t', '\t']));
    const all = frames(r.out);
    assert.ok(all.some((f) => /TASK COMPLETE/.test(f)));
    const after = all[all.length - 1];
    assert.ok(!/TASK COMPLETE/.test(after));
    // Three tabs from wherever Esc left it: the panes are navigable again.
    assert.match(after, /\[\d [a-z]+\]/, `no pane selected after the overlay closed:\n${after.slice(0, 300)}`);
    assert.strictEqual(r.code, 0);
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
    const f = frames(r.out).find((x) => /RUNNING\s+sleep 2/.test(x));
    assert.ok(f, 'a frame must show the tool running');
    // The live row carries a BAR between the step count and the percentage now
    // (`STEP 1/4 ███░░░░ 25%`), so the separator is no longer a dot. The
    // guarantee is the same one: both facts are on the row that sits above the
    // caret, and neither is dropped.
    assert.match(f, /STEP \d\/4[^\n]*\d+%/, `the live row must carry progress:\n${f.slice(-300)}`);
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
    const f = frames(r.out).pop() || '';
    assert.match(f, /100%/, 'the plan really is at 100%');
    assert.match(f, /STEP 1\/1/, 'and says so as a step count');
    assertIncludes(plain(r.out), 'VERIFYING', 'the task is not done: nothing was run to check the change');
    assert.ok(!/TASK COMPLETE/.test(plain(r.out)), 'and it must not be reported as finished');
  });
};
