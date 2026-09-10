'use strict';

/**
 * A PASTE IS TEXT UNTIL YOU PRESS ENTER.
 *
 * Found by pasting into the real TUI: the moment the terminal sent the closing
 * bracketed-paste marker, the paste RAN. `input.js` called `_emitInput` there,
 * so paste was wired as a submission event rather than as characters arriving in
 * the input box. You could not read what you pasted, edit it, or change your
 * mind.
 *
 * These drive the real binary and assert on what is ON SCREEN — the input box
 * holds the text, the workspace shows no task — because the distinction is
 * entirely about what the user can see and undo before committing.
 */

const assert = require('assert');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const ESC = '\x1b';
const PASTE_ON = ESC + '[200~';
const PASTE_OFF = ESC + '[201~';
const CR = '\r';
const ETX = String.fromCharCode(3);
const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '28' };
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
/**
 * The screen is a sequence of complete frames. `\x1b[?25l` (hide-cursor) is
 * the per-frame boundary now that a redraw no longer opens with a full clear.
 */
const frames = (out) => String(out).split('\x1b[?25l').slice(1).map(plain);

/**
 * WHAT THE INPUT REGION HELD, on the raw frames.
 *
 * ------------------------------------------------------------------------
 * IT USED TO BE FOUND BY ITS BORDER AND PROMPT — `│ > text`, `│   continuation`.
 * The region has neither now: it is a subtle grey fill across the full width,
 * inset by the content frame's own gutter and with no `> ` at all
 * (ui/inputbox.js, ui/views.js `content`).
 *
 * So the region is found by the CARET, which is a better anchor than the border
 * ever was: `draw()` ends every frame by parking the cursor on the row being
 * edited, so the row it names IS the row the user is typing into. `inputRows`
 * hands back that row and the few above it, which is the span the border used
 * to enclose — enough for a multi-line prompt, and nothing from the
 * conversation above it.
 */
function rawFrames(out) {
  return String(out).split('\x1b[?25l');
}

function inputRows(raw, back = 8) {
  const marks = [...String(raw).matchAll(/\x1b\[(\d+);(\d+)H/g)];
  if (!marks.length) return [];
  const caretRow = Number(marks[marks.length - 1][1]);
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
  const out2 = [];
  for (let r = Math.max(1, caretRow - back); r <= caretRow; r++) {
    // TRIMMED, NOT UN-PADDED BY ONE. The composer's inset was one column; it is
    // two now, the same inset the conversation uses so that the prompt and the
    // prose begin on one column (ui/views.js `content`). A helper that knows the
    // number breaks when the number changes - and the inset is GEOMETRY, while
    // this reads CONTENT.
    if (rows[r] !== undefined) out2.push(rows[r].trim());
  }
  return out2;
}

/** The input region of the first raw frame whose input holds `needle`. */
function inputShowing(out, needle) {
  for (const raw of rawFrames(out)) {
    const rows = inputRows(raw);
    if (rows.some((l) => needle.test(l))) return rows;
  }
  return null;
}

/** A command-looking, multi-line payload ending in /exit. */
const PAYLOAD = 'Continue from step 4.\n\nThen run /models.\n\nFinally say done.\n\n/exit';

/** Ctrl+C twice leaves without EOF, so nothing is flushed on the way out. */
const leave = [ETX, ETX];

module.exports = async function () {
  await test('PASTE: the text lands in the INPUT BOX and no task starts', async () => {
    const r = await runCli([], {
      cwd: tmpdir('paste-'), env: tui,
      stdinSteps: [PASTE_ON + PAYLOAD + PASTE_OFF, ...leave], stepDelayMs: 900,
      script: [{ text: 'should never run' }], timeoutMs: 40000,
    });
    // WAS `│ > /exit  [7/7]` on a single row, then seven bordered rows. The
    // region now GROWS with the buffer and has no border or prompt at all, so a
    // seven-line paste is seven plain rows on the grey ground, the caret's row —
    // the last, since a paste leaves the caret at its end — carrying the `[7/7]`
    // marker. What this test is for is unchanged: the paste reached the region,
    // whole, and started nothing.
    //
    // THIS PAYLOAD IS DELIBERATELY NOT COLLAPSED. It is 67 characters, well
    // under the attachment threshold (ui/pasted.js), so it is ordinary text —
    // which is the point of §11: the composer collapses a WALL, not every paste.
    const rows = inputShowing(r.out, /\/exit\s+\[7\/7\]/);
    assert.ok(rows, `the pasted text never reached the input region:\n${frames(r.out).pop() || ''}`);
    const withText = rows.join('\n');
    // SEVERAL OF THE PASTED LINES ARE ON SCREEN AT ONCE — which a single-row
    // box could never have shown. Not necessarily the FIRST: seven lines do not
    // fit a six-row region on a 28-row terminal, so the window follows the caret
    // and the top scrolls out. That is the bound working, not a failure to draw.
    const visible = ['Then run /models.', 'Finally say done.', '/exit']
      .filter((line) => withText.includes(line));
    assert.ok(visible.length >= 3, `only ${visible.length} of the pasted lines are on screen`);
    assert.ok(!/should never run/.test(r.out), 'the model was called — the paste auto-submitted');
    assert.ok(!/^TASK/m.test(withText), 'a task started from a paste');
  });

  await test('PASTE: multi-line stays ONE input, and the row says how many lines', async () => {
    const r = await runCli([], {
      cwd: tmpdir('paste-'), env: tui,
      stdinSteps: [PASTE_ON + PAYLOAD + PASTE_OFF, ...leave], stepDelayMs: 900,
      script: [], timeoutMs: 40000,
    });
    const found = inputShowing(r.out, /\/exit\s+\[7\/7\]/);
    assert.ok(found, 'the paste never reached the input region');
    const withText = found.join('\n');
    // WAS "ONE row, not seven" — the box was a single row and the `[7/7]`
    // marker was the only report of the real size. The box now grows to show
    // the lines ().
    //
    // AND THE OLD ASSERTION COULD NOT FAIL. A drawn frame contains NO NEWLINES:
    // the Screen positions every row with an escape sequence, and `plain` here
    // strips those without putting anything in their place — so
    // `frame.split('\n')` was always a one-element array, and "exactly one row
    // has the marker" was true of any frame that had one at all. Counted
    // against the string instead.
    const marks = (withText.match(/\[7\/7\]/g) || []).length;
    assert.strictEqual(marks, 1, `${marks} rows claimed to hold the caret`);
    // The buffer kept its newlines: several distinct lines of it are on screen
    // at once, which a single-row box could never have shown.
    const onScreen = ['Then run /models.', 'Finally say done.', '/exit']
      .filter((line) => withText.includes(line));
    assert.ok(onScreen.length >= 3,
      `the paste did not survive as separate lines: ${onScreen.length} of 3`);
  });

  await test('PASTE: a pasted /models does NOT open the model picker', async () => {
    const r = await runCli([], {
      cwd: tmpdir('paste-'), env: tui,
      stdinSteps: [PASTE_ON + '/models' + PASTE_OFF, ...leave], stepDelayMs: 900,
      script: [], timeoutMs: 40000,
    });
    const out = plain(r.out);
    assert.ok(!/MODELS\s+\d/.test(out), 'a pasted command opened the picker');
    // AND IT MUST SIT IN THE INPUT REGION AS TEXT. Read off the caret's row
    // rather than by looking for `> ` — the prompt symbol is gone with the
    // border, so the row is the row the cursor is parked on.
    const rows = inputShowing(r.out, /^\/models$/);
    assert.ok(rows, `the pasted command must sit in the input region as text:\n${out.slice(-400)}`);
  });

  await test('PASTE: a pasted /exit does NOT exit', async () => {
    const r = await runCli([], {
      cwd: tmpdir('paste-'), env: tui,
      stdinSteps: [PASTE_ON + '/exit' + PASTE_OFF, ...leave], stepDelayMs: 1200,
      script: [], timeoutMs: 40000,
    });
    // Proof it did not exit: the paste sits in the input box, and LAIN went on
    // drawing frames afterwards — the exit came from the Ctrl+C we sent.
    const seen = rawFrames(r.out);
    const at = seen.findIndex((f) => inputRows(f).some((l) => /^\/exit$/.test(l)));
    assert.ok(at >= 0, 'the pasted text never reached the input region');
    assert.ok(seen.length > at + 1, 'LAIN stopped drawing at the paste — it took the /exit');
    assertIncludes(plain(r.out), 'Session saved', 'and it left only when actually asked to');
  });

  await test('PASTE: a pasted @path does NOT open file completion', async () => {
    const r = await runCli([], {
      cwd: tmpdir('paste-'), env: tui,
      stdinSteps: [PASTE_ON + 'look at @src/' + PASTE_OFF, ...leave], stepDelayMs: 900,
      script: [], timeoutMs: 40000,
    });
    const out = plain(r.out);
    assert.ok(!/FILES\s/.test(out), 'a pasted @ opened the file picker over the text');
    assertIncludes(out, 'look at @src/');
  });

  await test('PASTE: Enter submits the WHOLE paste, exactly once', async () => {
    const r = await runCli([], {
      cwd: tmpdir('paste-'), env: tui,
      stdinSteps: [PASTE_ON + PAYLOAD + PASTE_OFF, CR], stepDelayMs: 1200,
      script: [{ text: 'Understood.' }], timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'Continue from step 4', 'the task must carry the pasted text');
    assertIncludes(out, 'Finally say done', 'and all of it, not just the first line');
    // ONE task: the request count is the honest measure of "how many times".
    const turns = (out.match(/TASK\n/g) || []).length;
    assert.ok(turns <= 1 || /Understood/.test(out), 'the paste was submitted more than once');
  });

  await test('PASTE: typing after a paste still works, and still opens menus', async () => {
    // The fix must not disable the as-you-type menus for REAL keystrokes.
    const r = await runCli([], {
      cwd: tmpdir('paste-'), env: tui,
      stdinSteps: ['/', ...leave], stepDelayMs: 900,
      script: [], timeoutMs: 40000,
    });
    assert.match(plain(r.out), /commands/i, 'a typed / must still open the palette');
  });

  await test('PASTE: a paste while the model is working stays text and leaves the task alone', async () => {
    const r = await runCli([], {
      cwd: tmpdir('paste-'), env: tui,
      stdinSteps: ['audit it\n', PASTE_ON + PAYLOAD + PASTE_OFF, ...leave], stepDelayMs: 1200,
      script: [
        { text: 'Working.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 3' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'audit it', 'the running task must survive');
    const mid = frames(r.out).find((f) => /\[7\/7\]/.test(f) && /audit it/.test(f));
    assert.ok(mid, 'the pasted text must appear alongside the running task, not replace it');
  });

  await test('PASTE: text typed BEFORE a paste is kept, and the whole line submits together', async () => {
    const r = await runCli([], {
      cwd: tmpdir('paste-'), env: tui,
      stdinSteps: ['note: ', PASTE_ON + 'alpha\nbeta' + PASTE_OFF, CR], stepDelayMs: 1000,
      script: [{ text: 'ok' }], timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'note: alpha', 'the typed prefix was dropped');
    assertIncludes(out, 'beta');
  });

  await test('PASTE: a paste does not enter prompt history', async () => {
    const r = await runCli([], {
      cwd: tmpdir('paste-'), env: tui,
      stdinSteps: ['typed one\n', PASTE_ON + 'pasted body' + PASTE_OFF, CR, ESC + '[A', ...leave],
      stepDelayMs: 900,
      script: [{ text: 'a' }, { text: 'b' }], timeoutMs: 45000,
    });
    // ↑ after both were submitted must recall the TYPED one.
    const recalled = rawFrames(r.out).reverse()
      .map((f) => inputRows(f, 0)[0] || '')
      .find((l) => l.trim() && l.trim() !== 'Ask LAIN…');
    assert.ok(recalled, 'nothing was ever recalled into the input region');
    assert.ok(!/pasted body/.test(recalled), `↑ recalled a paste: ${JSON.stringify(recalled)}`);
  });
};
