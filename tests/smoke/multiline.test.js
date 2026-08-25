'use strict';

/**
 * MULTILINE INPUT, through the REAL binary —.
 *
 * The unit tier proves the reader inserts a newline. This proves the whole path
 * works: the keystroke reaches the reader, the screen grows and draws the
 * lines, Enter sends ONE prompt containing all of them, and it arrives as one
 * task rather than three.
 *
 * WHICH SPELLING IS TESTED HERE, and why it is not Ctrl+J. `runCli` pipes the
 * child's stdin, so the reader correctly sees a pipe — where a bare LF must go
 * on separating prompts or nothing would ever submit. Alt/Shift+Enter is an
 * ESCAPE SEQUENCE, so a pipe carries it exactly as a terminal would, and it is
 * the same `newline()` either way. Ctrl+J on a real TTY is covered at unit tier
 * and cannot be reached through this harness at all.
 */

const assert = require('assert');
const { test, tmpdir, runCli, frames, rowsOf, assertIncludes, assertNotIncludes } = require('../helpers');

const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '90', LINES: '30' };
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
/** Alt/Shift+Enter, as a terminal reports it. */
const SOFT = ESC + CR;

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');

/** The input box as drawn in the first frame that shows `needle`. */
function boxShowing(out, needle) {
  const f = frames(out).find((x) => needle.test(x));
  if (!f) return null;
  const rows = rowsOf(f);
  const at = rows.findIndex((l) => /^┌─ (INPUT|ANSWER)/.test(l));
  if (at < 0) return null;
  const end = rows.findIndex((l, i) => i > at && /^└/.test(l));
  return rows.slice(at, (end < 0 ? at + 6 : end + 1)).join('\n');
}

module.exports = async function () {
  await test('MULTILINE LIVE: three typed lines are composed, shown, and sent as ONE prompt', async () => {
    const r = await runCli([], {
      cwd: tmpdir('ml-'),
      env: tui,
      stdinSteps: [`line one${SOFT}line two${SOFT}line three`, '', CR, CR],
      stepDelayMs: 1100,
      script: [{ text: 'Got all three. FINISHED.' }],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);

    // THE BOX GREW AND SHOWED THEM. A three-row box under a three-line prompt
    // is the whole of "the input must represent multiple lines".
    const box = boxShowing(r.out, /line three/);
    assert.ok(box, 'the third line was never drawn');
    assert.match(box, /> line one/, `the first line carries the prompt:\n${box}`);
    // `│ ` is the box edge; the continuation lines are indented by the width of
    // the `> ` prompt so the block reads as one thing.
    assert.match(box, /│ {3}line two/, `continuation lines line up under the prompt:\n${box}`);
    assert.match(box, /│ {3}line three/, 'and the third');
    // NO `[3/3]` MARKER, and that is the change. It existed because the box was
    // one row tall and the marker was the only report of the real size. With
    // all three rows on screen it is a row counter for something the reader can
    // see — so it now appears only when rows are genuinely hidden, which the
    // big-paste test below covers.
    assert.ok(!/\[\d+\/\d+\]/.test(box), `nothing is hidden, so nothing needs counting:\n${box}`);

    // AND IT WAS ONE PROMPT. Three tasks would mean the newline submitted.
    const out = plain(r.out);
    assertIncludes(out, 'line one line two line three', 'the objective is the whole prompt');
    const tasks = new Set((out.match(/^TASK {2}(.+)$/gm) || []).map((s) => s.trim()));
    assert.strictEqual(tasks.size, 1, `it started ${tasks.size} tasks: ${[...tasks]}`);
  });

  await test('MULTILINE LIVE: a soft break does not submit — nothing runs until Enter', async () => {
    // The failure this replaces exactly: pressing the newline key sent the
    // prompt, so a second line could never be typed.
    const r = await runCli([], {
      cwd: tmpdir('ml-'),
      env: tui,
      // Compose, then wait a full step WITHOUT pressing Enter.
      stdinSteps: [`first${SOFT}second`, '', '', CR, CR],
      stepDelayMs: 1000,
      script: [{ text: 'Received. FINISHED.' }],
      timeoutMs: 45000,
    });
    const framesBefore = frames(r.out).filter((f) => /second/.test(f) && !/TASK {2}first/.test(f));
    assert.ok(framesBefore.length > 0,
      'the second line was never on screen before the prompt was sent');
  });

  await test('MULTILINE LIVE: the summary row does not claim a typed prompt was PASTED', async () => {
    const r = await runCli([], {
      cwd: tmpdir('ml-'),
      env: tui,
      stdinSteps: [`alpha${SOFT}beta`, '', CR, CR],
      stepDelayMs: 1000,
      script: [{ text: 'ok. FINISHED.' }],
      timeoutMs: 45000,
    });
    const box = boxShowing(r.out, /beta/);
    assert.ok(box, 'the buffer was never drawn');
    assertNotIncludes(box, '⎘', `two visible lines need no summary describing them:\n${box}`);
  });

  await test('MULTILINE LIVE: a big paste still gets its one summary row', async () => {
    // The case the row was written for: more lines than the box can show.
    const big = new Array(40).fill('padding line').join(LF);
    const r = await runCli([], {
      cwd: tmpdir('ml-'),
      env: tui,
      stdinSteps: [`${ESC}[200~${big}${ESC}[201~`, '', CR, CR],
      stepDelayMs: 1000,
      script: [{ text: 'ok. FINISHED.' }],
      timeoutMs: 45000,
    });
    const box = boxShowing(r.out, /padding line/);
    assert.ok(box, 'the paste was never drawn');
    assertIncludes(box, '⎘', `40 lines cannot all be shown, so they must be summarised:\n${box}`);
    assertIncludes(box, '40 lines');
  });

  await test('WRAP LIVE: a long line WRAPS instead of scrolling its start off screen', async () => {
    //: "it must NOT simply extend horizontally until the beginning of the
    // prompt disappears. Long lines must wrap." It used to scroll sideways, so
    // typing a long sentence pushed its own beginning off the left edge and
    // the prompt could not be read before it was sent.
    const LONG = 'the quick brown fox jumps over the lazy dog and then keeps running well past the right hand edge';
    const r = await runCli([], {
      cwd: tmpdir('wrap-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '70', LINES: '30' },
      stdinSteps: [LONG, '', CR, CR],
      stepDelayMs: 1100,
      script: [{ text: 'Got it. FINISHED.' }],
      timeoutMs: 45000,
    });
    const box = boxShowing(r.out, /│ > the quick/);
    assert.ok(box, 'the long prompt was never drawn');
    assert.match(box, /│ > the quick brown fox/,
      `the START of the line must still be visible:
${box}`);
    assert.ok(box.split(String.fromCharCode(10)).filter((l) => /^│ /.test(l)).length >= 2,
      `a line wider than the box must occupy more than one row:
${box}`);
    assert.ok(!box.includes('…'),
      `an ellipsis means it scrolled rather than wrapped:
${box}`);
  });

  await test('CARET LIVE: the terminal cursor is made visible, after the paint', async () => {
    //. The position was computed correctly and parked correctly — at a
    // cursor that had been hidden on entry and never shown again, so for the
    // whole session there was no indicator of where typing went.
    const r = await runCli([], {
      cwd: tmpdir('caret-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '80', LINES: '28' },
      stdinSteps: ['hello', '', CR, CR],
      stepDelayMs: 1000,
      script: [{ text: 'Hi. FINISHED.' }],
      timeoutMs: 45000,
    });
    const out = String(r.out);
    assert.ok(out.includes(String.fromCharCode(27) + '[?25h'),
      'the cursor was never made visible');
    // AND IT IS SHOWN LAST. Hidden for the paint so it does not flicker down
    // the screen, shown at the end, on the caret.
    assert.ok(out.lastIndexOf(String.fromCharCode(27) + '[?25h')
      > out.lastIndexOf(String.fromCharCode(27) + '[?25l'),
      'the last thing written hides the cursor — it would be invisible while typing');
  });
  await test('MULTILINE LIVE: /copy hands back the prompt with its newlines intact', async () => {
    //. The clipboard may be unavailable in a test environment, in which
    // case `/copy` writes a file and prints the path — either way the TEXT is
    // what matters, and it must still be three lines.
    const fs = require('fs');
    const r = await runCli([], {
      cwd: tmpdir('ml-'),
      env: tui,
      stdinSteps: [`one${SOFT}two${SOFT}three`, '', CR, '/copy last\n', CR],
      stepDelayMs: 1000,
      script: [{ text: `alpha${LF}beta${LF}gamma` }],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    const file = (out.match(/([A-Za-z]:\\[^\s]+lain-copy-[^\s]+\.txt)/) || [])[1];
    if (file && fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, /alpha[\s\S]*beta[\s\S]*gamma/, 'the copied text kept its lines');
      assert.ok(text.includes(LF), 'and its newlines');
    } else {
      assertIncludes(out, 'copied last', 'it reached the clipboard instead');
    }
  });
};
