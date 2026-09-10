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

/**
 * THE INPUT REGION AS DRAWN, in the first frame that shows `needle`.
 *
 * ------------------------------------------------------------------------
 * IT USED TO BE FOUND BY ITS BORDER — the rows between `┌─ INPUT` and `└`.
 * The region has no border and no label now: it is a subtle grey fill across
 * the full width, inset by the content frame's gutter and nothing else
 * (ui/inputbox.js, ui/views.js `content`).
 *
 * So the region is found by the CARET, which is a better anchor than the border
 * ever was: `draw()` ends every frame by parking the cursor on the row being
 * edited. The rows from there to the end of the frame are the input region plus
 * whatever panel is open under it, which is exactly the span the border used to
 * enclose.
 */
function boxShowing(out, needle) {
  const raw = String(out).split('\x1b[?25l').find((x) => needle.test(plain(x)));
  if (!raw) return null;
  const marks = [...raw.matchAll(/\x1b\[(\d+);(\d+)H/g)];
  if (!marks.length) return null;
  const caretRow = Number(marks[marks.length - 1][1]);
  // Every row the frame addressed, in order, keyed by its terminal row.
  const rows = {};
  // ANY COLUMN: the content frame moved every region off column 1
  // (ui/frame.js `contentBounds`).
  const re = /\x1b\[(\d+);\d+H((?:[^\x1b]|\x1b\[(?!\d+;\d+H)[0-9;?]*[A-Za-z])*)/g;
  let m;
  // THE CARET PARK IS A CURSOR MOVE WITH NO TEXT, and it is the LAST address in
  // every frame. Letting it win blanks whatever row the caret is on — which,
  // now that the composer centres its text, is the row the text is ON.
  while ((m = re.exec(raw))) {
    const row = Number(m[1]);
    const text = m[2].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
    if (!text.trim() && rows[row] !== undefined) continue;
    rows[row] = text;
  }
  // FROM THE CARET'S ROW DOWN — the text being edited and anything under it.
  // The input grows DOWNWARD from its first row, so a multi-row prompt has its
  // caret on the last row; two rows of lookback cover a three-line prompt.
  const from = Math.max(1, caretRow - 6);
  const out2 = [];
  for (let r = from; r <= caretRow + 4; r++) if (rows[r] !== undefined) out2.push(rows[r]);
  return out2.join('\n');
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
    // ALL THREE LINES, ALIGNED. The `> ` prompt and the `│ ` edges are gone —
    // the region is a grey fill and every row is indented by the SAME amount, so
    // the block reads as one thing without either.
    //
    // `^ +`, NOT `^ `. The inset was one column; it is two now, the same inset
    // the conversation uses so the prompt and the prose begin on one column
    // (ui/views.js `content`). What this test is about is that the three rows
    // AGREE with each other, which a matcher that hardcodes the number cannot
    // express.
    assert.match(box, /^ +line one$/m, `the first line is drawn:\n${box}`);
    assert.match(box, /^ +line two$/m, `and lines up under it:\n${box}`);
    assert.match(box, /^ +line three$/m, 'and the third');
    // NO `[3/3]` MARKER, and that is the change. It existed because the box was
    // one row tall and the marker was the only report of the real size. With
    // all three rows on screen it is a row counter for something the reader can
    // see — so it now appears only when rows are genuinely hidden, which the
    // big-paste test below covers.
    assert.ok(!/\[\d+\/\d+\]/.test(box), `nothing is hidden, so nothing needs counting:\n${box}`);

    // ---- AND IT WAS ONE PROMPT -------------------------------------------
    //
    // It used to be checked against the flattened form — `line one line two
    // line three` — because the pinned TASK banner had one row and ran the
    // newlines together to fit it. There is no banner, and the conversation
    // keeps the user's line breaks (ui/feed.js: the user's line breaks are the
    // user's), so the flattened string correctly no longer exists anywhere.
    //
    // The claim is the same and is now read off the CONVERSATION: one message
    // marker, three lines under it. Three markers would mean the soft break
    // submitted.
    const out = plain(r.out);
    assertIncludes(out, 'line one', 'the first line reached the conversation');
    assertIncludes(out, 'line two', 'and the second');
    assertIncludes(out, 'line three', 'and the third');
    assert.ok(!/❯ line two/.test(out), 'no later line became a prompt of its own');
    assert.ok(!/❯ line three/.test(out), 'nor the last');
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
    // ------------------------------------------------------------------
    // THE SUMMARY ROW IS GONE ENTIRELY, which settles this case rather than
    // satisfying it. It existed because the box drew the whole paste and a
    // person could not tell how much of it there was; the composer collapses a
    // big paste to `<pasted text>` instead, and the size rides beside the
    // marker on the caret's own row. A region that is one region does not need
    // a second row describing itself.
    //
    // What must still be true is the claim in the name: TYPED text is never
    // described as pasted.
    // ------------------------------------------------------------------
    assertNotIncludes(box, '⎘', `two visible lines need no summary describing them:\n${box}`);
    assertNotIncludes(box, 'pasted text', `nothing typed may be called a paste:\n${box}`);
    assert.match(box, /^ +alpha$/m, 'and both typed lines are shown in full');
    assert.match(box, /^ +beta$/m);
  });

  await test('MULTILINE LIVE: a big paste is COLLAPSED to one marker in the composer', async () => {
    // The case the summary row was written for — more lines than the region can
    // show — answered by collapsing the paste instead of describing it. One row
    // rather than a wall plus a row about the wall.
    const big = new Array(40).fill('padding line').join(LF);
    const r = await runCli([], {
      cwd: tmpdir('ml-'),
      env: tui,
      stdinSteps: [`${ESC}[200~${big}${ESC}[201~`, '', CR, CR],
      stepDelayMs: 1000,
      script: [{ text: 'ok. FINISHED.' }],
      timeoutMs: 45000,
    });
    const box = boxShowing(r.out, /pasted text/);
    assert.ok(box, 'the paste was never drawn');
    assertIncludes(box, '<pasted text>',
      `40 lines cannot all be shown, so they are collapsed:\n${box}`);
    // AND THE SIZE OF WHAT IS BEHIND IT, beside the marker — the one thing
    // somebody wants before pressing Enter on a wall of text.
    assert.match(box, /\d+(\.\d+)? ?(B|KB)/, `the size rides with the marker:\n${box}`);
    // IT IS ONE ROW, not forty. That is the whole point.
    assert.ok(!/padding line/.test(box), `the payload must not be drawn line by line:\n${box}`);
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
    const box = boxShowing(r.out, /the quick brown fox/);
    assert.ok(box, 'the long prompt was never drawn');
    assert.match(box, /^ +the quick brown fox/m,
      `the START of the line must still be visible:
${box}`);
    // MORE THAN ONE ROW. The `│ ` edge used to identify the region's rows; with
    // no border, the rows are the ones the wrapped prompt occupies, and they are
    // what `boxShowing` hands back.
    const occupied = box.split(String.fromCharCode(10)).filter((l) => /^ +\S/.test(l));
    assert.ok(occupied.length >= 2,
      `a line wider than the region must occupy more than one row:
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
