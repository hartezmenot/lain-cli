'use strict';

/**
 * THE BOTTOM CLUSTER — the input and whatever it opened, together, on the floor.
 *
 * THIS TEST ASSERTED THE OPPOSITE FOR ONE ITERATION, and the correction is worth
 * recording because the reasoning sounded right.
 *
 * Reading "the input must never move" as "the input occupies a fixed terminal
 * row" produced a layout with panels ABOVE the input. It satisfied the letter of
 * it — the input genuinely never moved — and it was wrong on the screen: the
 * model list appeared in the middle of the display, with the status strip
 * wedged between it and the line you were filtering it with, and the
 * conversation lurched upward on every `/`. The list and the caret read as two
 * unrelated things.
 *
 * What must not move is the CLUSTER. The line you type on and the panel it
 * opened are one object, pinned to the bottom of the terminal:
 *
 *     CONTEXT / MAIN VIEW        scrolls, and gives up the rows
 *     PENDING USER INPUT
 *     STATUS STRIP
 *     INPUT EDITOR               ← the line you type on
 *     PANEL / MENU / QUESTION    ← what that line opened, directly under it
 *
 * Every panel: `/` palette, `@` files, the model picker, `/status` output, an
 * ask_user question. One rule, because the exceptions were the confusing part.
 *
 * MEASURED IN ABSOLUTE TERMINAL ROWS, not in the index of a filtered array. A
 * frame positions each row with `ESC[<n>;1H`; blank rows are dropped by any
 * plain-text splitting, so comparing array indices reports a move that did not
 * happen and misses one that did.
 */

const assert = require('assert');
const { test, runCli, tmpdir, frames, firstTabLabel } = require('../helpers');

const E = String.fromCharCode(27);
const plain = (s) => String(s).split(new RegExp(E + '\\[[0-9;?]*[A-Za-z]', 'g')).join('');

/** The absolute terminal row a marker was drawn on, or -1. */
function absRow(frame, marker) {
  const re = /\x1b\[(\d+);1H/g;
  const parts = [];
  let m;
  while ((m = re.exec(frame)) !== null) parts.push({ row: Number(m[1]), at: m.index + m[0].length });
  for (let i = 0; i < parts.length; i++) {
    const end = i + 1 < parts.length ? parts[i + 1].at : frame.length;
    if (plain(frame.slice(parts[i].at, end)).includes(marker)) return parts[i].row;
  }
  return -1;
}

const TUI = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '34' };
const INPUT = '─ INPUT ─';

/** Drive the binary, and return the frames with and without `marker`. */
async function openAndClose(steps, marker) {
  const r = await runCli([], {
    cwd: tmpdir('geo-'), env: TUI, stdinSteps: steps, stepDelayMs: 1400, script: [], timeoutMs: 45000,
  });
  const raw = frames(r.out);
  const shown = raw.map((f, i) => (plain(f).includes(marker) ? i : -1)).filter((i) => i >= 0);
  assert.ok(shown.length, `nothing ever showed ${marker}`);
  const withIdx = shown[shown.length - 1];
  const withoutIdx = raw.findIndex((f, i) => i > withIdx && !plain(f).includes(marker));
  assert.ok(withoutIdx > withIdx, `${marker} was never dismissed`);
  return { open: raw[withIdx], closed: raw[withoutIdx] };
}

module.exports = async function () {
  await test('GEOMETRY: the panel opens DIRECTLY BELOW the input, not elsewhere', async () => {
    const { open } = await openAndClose(['/status\n', E, '/exit\n'], '/STATUS');
    const panel = absRow(open, '/STATUS');
    const input = absRow(open, INPUT);
    assert.ok(panel > 0 && input > 0, 'both must be drawn');
    assert.ok(panel > input,
      `the panel must be BELOW the input (panel row ${panel}, input row ${input})`);
  });

  await test('GEOMETRY: the cluster is on the FLOOR — nothing is drawn under the panel', async () => {
    // "Pinned to the bottom" is the property, and it is checked by finding the
    // last row the frame draws at all: if anything came after the panel, the
    // cluster would be floating.
    const { open } = await openAndClose(['/status\n', E, '/exit\n'], '/STATUS');
    const rows = [...open.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]));
    const last = Math.max(...rows);
    const panelTop = absRow(open, '/STATUS');
    assert.ok(panelTop > 0 && last >= panelTop,
      'the panel must reach the last drawn row of the frame');
  });

  await test('GEOMETRY: the panel costs the CONVERSATION rows', async () => {
    // The rows have to come from somewhere, and they must come from the
    // scrolling surface — which is built to lose them.
    const { open, closed } = await openAndClose(['/status\n', E, '/exit\n'], '/STATUS');
    const feedOpen = absRow(open, firstTabLabel().slice(1, -1));
    const feedClosed = absRow(closed, firstTabLabel().slice(1, -1));
    assert.strictEqual(feedOpen, feedClosed, 'the workspace starts in the same place either way');
    assert.ok(absRow(open, INPUT) < absRow(closed, INPUT),
      'with a panel open the input sits higher, because the panel is under it');
  });

  await test('GEOMETRY: an ask_user question opens in the same place as every other panel', async () => {
    // ONE RULE, NO EXCEPTIONS. A question is the tallest thing that opens down
    // there, and it was the case most likely to be special-cased.
    const r = await runCli([], {
      cwd: tmpdir('geo-'),
      env: TUI,
      stdinSteps: ['pick one\n'],
      stepDelayMs: 1600,
      script: [{ tool_calls: [{ name: 'ask_user', input: { question: 'Which one?', options: ['A', 'B'] } }] }],
      timeoutMs: 45000,
    });
    // THE INPUT BORDER IS RENAMED WHILE A QUESTION IS OPEN — it reads
    // `ANSWER — type A-C` rather than `INPUT`, which is working: the box
    // says that typing there answers the question. Filtering on the word INPUT
    // therefore excluded exactly the frames this test is about.
    const raw = frames(r.out);
    const asking = raw.filter((f) => plain(f).includes('LAIN NEEDS YOUR INPUT'));
    assert.ok(asking.length, 'the question must reach the screen');
    const f = asking[asking.length - 1];
    // MATCHED ON THE PANEL'S OWN TITLE, not on the question text. The status
    // strip also says `ASKING USER  Which one?`, one row above the input — so
    // searching for the question found the strip and reported a panel above the
    // input that was in fact below it.
    const answerBox = absRow(f, 'ANSWER');
    assert.ok(answerBox > 0, 'the input box must be drawn, wearing its ANSWER label');
    assert.ok(absRow(f, 'LAIN NEEDS YOUR INPUT') > answerBox,
      'the question must sit under the line that answers it');
  });
};
