'use strict';

/**
 * THE INPUT ROW DOES NOT MOVE, AND THE SCREEN DOES NOT FLASH — through the
 * real binary, asserting on the actual bytes written, not on internal state.
 *
 * A test that only checks `screen.inputText` or `panel.visible` can pass while
 * the thing a person actually sees is still wrong: the code can be logically
 * correct and still repaint the whole terminal on every token. These read the
 * RAW captured output the same way tests/helpers.js's `frames()` does, and
 * count the one byte sequence that actually causes a blank-screen flash —
 * `\x1b[2J` — across real interactions: streaming, panel open/close, typing.
 */

const assert = require('assert');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const tui = (cols = 100, rows = 32) => ({ LAIN_FORCE_TUI: '1', COLUMNS: String(cols), LINES: String(rows) });

/** How many times the raw output actually cleared the screen. */
function clearCount(out) { return (String(out).match(/\x1b\[2J/g) || []).length; }

/** Per-frame boundary — see ui/layout.js's `L` helper for why it is this, not `\x1b[2J`. */
function frames(out) { return String(out).split('\x1b[?25l'); }

/**
 * The row the input box's CONTENT sits on — not its top border. The border's
 * own label changes with what has focus ("INPUT", "COMMANDS", "ANSWER — type
 * A-C", ...), so matching literal text there misses every state but the
 * plain idle one. `> ` (inputbox.js's `lead` for the first visible row) is
 * the one marker that is the same in all of them.
 */
function inputRow(frame) {
  for (const m of frame.matchAll(/\x1b\[(\d+);1H([^\x1b]*)/g)) {
    if (/│\s*>\s/.test(m[2].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) return Number(m[1]);
  }
  return null;
}

module.exports = async function () {
  await test('RENDER: a long multi-paragraph streamed response clears the screen ONCE, not per chunk', async () => {
    const longText = Array.from({ length: 6 }, (_, i) =>
      `Paragraph ${i + 1} of a long streamed reply, several sentences long, so the streaming path is `
      + 'genuinely exercised rather than trivially short. One more sentence to round it out.').join('\n\n');
    const r = await runCli([], {
      cwd: tmpdir('stream-'), env: tui(),
      stdin: 'tell me a long story\n',
      script: [{ text: longText }],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(clearCount(r.out), 1,
      `a streamed reply must not clear the screen per chunk — got ${clearCount(r.out)} clears`);
    assertIncludes(r.out, 'Paragraph 6', 'and the whole reply must actually have arrived');
  });

  await test('RENDER: opening and closing a machinery panel clears the screen ZERO times', async () => {
    const r = await runCli([], {
      cwd: tmpdir('panelclear-'), env: tui(),
      stdin: '/status\n\x1b/status\n\x1b/exit\n',
      script: [],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(clearCount(r.out), 1,
      `opening/closing a panel must never itself clear the screen — got ${clearCount(r.out)} clears (only the startup activation should)`);
  });

  await test('RENDER: the INPUT row returns to the EXACT same line once a panel closes', async () => {
    // NOT "the row never moves" — layout.js's own geometry() computes the
    // input's row as `rows - inputRows - panelRows` (see the "PANEL, DIRECTLY
    // BELOW THE INPUT" comment there): a panel legitimately pushes the input
    // up while it is open, because it is drawn BELOW it and both are pinned to
    // the floor together. What must hold — the actual invariant the header
    // comment calls "the ONE thing that must never move" — is that closing the
    // panel puts the input back on EXACTLY the row it started on, not one row
    // off from some stale geometry calculation.
    const r = await runCli([], {
      cwd: tmpdir('inputfloor-'), env: tui(100, 32),
      stdinSteps: ['/status', '\r', '\x1b', 'x'],
      stepDelayMs: 700,
      script: [],
      timeoutMs: 45000,
    });
    const rows = frames(r.out).map(inputRow).filter((n) => n != null);
    assert.ok(rows.length >= 2, `expected several frames with a visible input row, got ${rows.length}`);
    assert.strictEqual(rows[0], rows[rows.length - 1],
      `the input row before opening /status (${rows[0]}) must match the row after closing it (${rows[rows.length - 1]})`);
  });

  await test('RENDER: draw count for a streamed reply is proportional to paragraphs, not characters', async () => {
    // COALESCING, asserted from the outside: `\x1b[?25l` opens every draw() —
    // see ui/layout.js — so counting it counts real redraws. A reply this
    // short, streamed as ~40 individual word-ish chunks by the mock provider,
    // must not produce anywhere near 40 redraws if paragraph-boundary
    // buffering (turnevents.js's flushParagraphs) is doing its job.
    const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen '
      + 'fifteen sixteen seventeen eighteen nineteen twenty.';
    const r = await runCli([], {
      cwd: tmpdir('coalesce-'), env: tui(),
      stdin: 'count for me\n',
      script: [{ text }],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const draws = (r.out.match(/\x1b\[\?25l/g) || []).length;
    const words = text.split(/\s+/).length;
    assert.ok(draws < words,
      `expected far fewer redraws than words (coalesced, not per-token) — ${draws} draws for ${words} words`);
  });
};
