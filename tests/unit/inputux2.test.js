'use strict';

/**
 * THE INPUT FOUNDATION — word delete, the mouse, and clearing the view.
 *
 * Three things the terminal could not do, each of which made LAIN feel less
 * like an editor than the shell it runs in:
 *
 *   CTRL+BACKSPACE deleted ONE CHARACTER. Terminals send \x7f for Backspace and
 *   \x08 for Ctrl+Backspace, and the reader treated the two as the same key —
 *   so the word-delete every editor has simply did not exist.
 *
 *   THE MOUSE did nothing at all. Clicking into a long prompt to fix a typo in
 *   the middle put the caret nowhere; the only way back was arrow keys.
 *
 *   /clean did not exist, so a long session's screen could not be cleared
 *   without throwing the session away with `/new`.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Input } = require('../../src/input');
const ESC = String.fromCharCode(27);

/** A reader with no real terminal behind it. */
function reader() {
  return new Input({
    stdin: { isTTY: false, setEncoding() {}, on() {}, resume() {}, pause() {}, removeListener() {} },
    stdout: { write() {} },
  });
}

/** Feed bytes and collect what came out. */
function feed(i, bytes) {
  const events = [];
  i.on('key', (k) => events.push({ key: k }));
  i.on('mouse', (m) => events.push({ mouse: m }));
  i._onData(bytes);
  return events;
}

module.exports = async function () {
  // ------------------------------------------------------- ctrl+backspace --

  await test('WORD: Ctrl+Backspace deletes the previous WORD, not one character', () => {
    const i = reader();
    i.line = 'hello world';
    i.cursor = i.line.length;
    feed(i, '\b');                                  // \x08 — what Ctrl+Backspace sends
    assert.strictEqual(i.line, 'hello ');
    assert.strictEqual(i.cursor, 6);
  });

  await test('WORD: plain Backspace still deletes ONE character', () => {
    // The two keys must not be confused in the other direction either.
    const i = reader();
    i.line = 'hello';
    i.cursor = 5;
    feed(i, '\x7f');
    assert.strictEqual(i.line, 'hell');
  });

  await test('WORD: held down, it walks back a word at a time', () => {
    const i = reader();
    i.line = 'fix the dashboard signal button';
    i.cursor = i.line.length;
    const seen = [];
    for (let n = 0; n < 5; n++) { i.deleteWord(); seen.push(i.line); }
    assert.deepStrictEqual(seen, [
      'fix the dashboard signal ',
      'fix the dashboard ',
      'fix the ',
      'fix ',
      '',
    ]);
  });

  await test('WORD: punctuation is its own run — dashboard.py loses py, then the dot', () => {
    const i = reader();
    i.line = 'dashboard.py';
    i.cursor = i.line.length;
    i.deleteWord(); assert.strictEqual(i.line, 'dashboard.');
    i.deleteWord(); assert.strictEqual(i.line, 'dashboard');
    i.deleteWord(); assert.strictEqual(i.line, '');
  });

  await test('WORD: at the very start of the buffer it does nothing, and says so', () => {
    const i = reader();
    i.line = 'abc';
    i.cursor = 0;
    assert.strictEqual(i.deleteWord(), false);
    assert.strictEqual(i.line, 'abc', 'nothing may be removed from in front of the caret');
  });

  await test('WORD: it walks over the end of a line inside a paste', () => {
    const i = reader();
    i.line = 'line one\nline two';
    i.cursor = i.line.length;
    i.deleteWord(); assert.strictEqual(i.line, 'line one\nline ');
    i.deleteWord(); assert.strictEqual(i.line, 'line one\n');
    i.deleteWord(); assert.strictEqual(i.line, 'line ');
  });

  await test('WORD: it deletes at the CARET, leaving what is after it alone', () => {
    const i = reader();
    i.line = 'alpha beta gamma';
    i.cursor = 10;                                  // just after "beta"
    i.deleteWord();
    assert.strictEqual(i.line, 'alpha  gamma');
    assert.strictEqual(i.cursor, 6);
  });

  await test('WORD: Ctrl+W and Alt+Backspace mean the same thing', () => {
    for (const bytes of ['\x17', ESC + '\x7f']) {
      const i = reader();
      i.line = 'one two';
      i.cursor = 7;
      feed(i, bytes);
      assert.strictEqual(i.line, 'one ', `${JSON.stringify(bytes)} must delete a word`);
    }
  });

  await test('WORD: none of this breaks the ordinary editing keys', () => {
    const i = reader();
    i.line = 'abcdef';
    i.cursor = 6;
    assert.strictEqual(i.editKey('left'), true); assert.strictEqual(i.cursor, 5);
    assert.strictEqual(i.editKey('home'), true); assert.strictEqual(i.cursor, 0);
    assert.strictEqual(i.editKey('end'), true); assert.strictEqual(i.cursor, 6);
    feed(i, '\x7f');
    assert.strictEqual(i.line, 'abcde');
  });

  // ---------------------------------------------------------------- mouse --

  await test('MOUSE: press, drag and release are three distinct kinds', () => {
    // WAS "a release is not an action" — releases were dropped, and with them
    // any possibility of selecting anything with the mouse (). A press
    // anchors a selection, each drag moves its head, and the release ends it.
    //
    // BIT 32 IS THE MOTION FLAG: `32` is button 0 held and moving, which under
    // `?1002h` is exactly a drag.
    const i = reader();
    const got = feed(i, ESC + '[<0;12;30M' + ESC + '[<32;18;30M' + ESC + '[<0;18;30m');
    assert.deepStrictEqual(got.map((g) => g.mouse.kind), ['press', 'drag', 'release']);
    assert.deepStrictEqual(got[1].mouse, { kind: 'drag', button: 0, x: 18, y: 30 },
      'the motion flag is stripped from the button, and the coordinates follow the pointer');
  });

  await test('MOUSE: the wheel is told apart from a click', () => {
    const i = reader();
    const got = feed(i, ESC + '[<64;5;5M' + ESC + '[<65;5;5M');
    assert.deepStrictEqual(got.map((g) => g.mouse.kind), ['wheel-up', 'wheel-down']);
  });

  await test('MOUSE: a report SPLIT ACROSS CHUNKS is not typed as literal digits', () => {
    // The same failure an arrow key has: read the lone ESC too early and the
    // rest of the sequence lands in the input box as text.
    const i = reader();
    const got = [];
    i.on('mouse', (m) => got.push(m));
    i._onData(ESC + '[<0;4');
    i._onData('4;9M');
    assert.deepStrictEqual(got, [{ kind: 'press', button: 0, x: 44, y: 9 }]);
    assert.strictEqual(i.line, '', 'and nothing may reach the line being edited');
  });

  await test('MOUSE: coordinates past column 95 survive — SGR, not the X10 form', () => {
    // The legacy encoding packs coordinates into single bytes and simply cannot
    // address a wide terminal. This is why SGR is requested.
    const i = reader();
    const got = feed(i, ESC + '[<0;180;42M');
    assert.deepStrictEqual(got[0].mouse, { kind: 'press', button: 0, x: 180, y: 42 });
  });

  await test('MOUSE: tracking is OFF until the TUI asks for it', () => {
    const i = reader();
    assert.strictEqual(i.mouse, false,
      'a linear `lain -p` run has nothing to click, and tracking would take text selection away');
  });

  // ------------------------------------------------------------ hit-testing --

  await test('MOUSE: a click on the tab strip picks the tab under the pointer', () => {
    const { tabAt } = require('../../src/ui/mouse');
    const tabs = require('../../src/ui/tabs');
    // `┌─[1 activity] 2 context  3 plan …` — labels start at column 3, and the
    // ACTIVE label wears brackets, which makes it two columns wider.
    //
    // WHICH panes those are comes from ui/tabs.js. Naming them here made this a
    // private copy of the order, and it went stale the moment the order moved.
    const [first, second] = tabs.VIEWS;
    const active = first;
    const firstLabel = `[${tabs.numberOf(first)} ${first}]`;
    assert.strictEqual(tabAt(active, 4), first, 'a click inside the first label picks it');
    assert.strictEqual(tabAt(active, 3 + firstLabel.length + 1), second,
      'and a click just past it picks the next pane');
    assert.strictEqual(tabAt(active, 1), null, 'the frame itself is not a tab');
  });

  /**
   * A REAL SCREEN, DRAWN, then clicked.
   *
   * These used to hand-build a `rowMap` with the fields the old geometry
   * happened to use, so they tested a fixture rather than the mapping — and
   * they kept passing while the real box grew, wrapped, and started drawing
   * several rows. Drawing first means the click is inverted against exactly
   * what was painted, which is the property that actually matters.
   */
  const drawn = (text, cursor = 0) => {
    const { Screen } = require('../../src/ui/layout');
    // RESTORED AFTERWARDS. Leaving LAIN_FORCE_TUI set leaks into every test
    // that runs later in the same process — it broke the terminal-title test,
    // which exists precisely to prove nothing is written to a pipe.
    const had = process.env.LAIN_FORCE_TUI;
    process.env.LAIN_FORCE_TUI = '1';
    try {
      const screen = new Screen({
        out: { columns: 80, rows: 30, write() {}, isTTY: false, on() {}, removeListener() {} },
      });
      screen.enter();
      screen.inputText = text;
      screen.inputCursorAt = cursor;
      screen.draw();
      screen.leave();
      return screen;
    } finally {
      if (had === undefined) delete process.env.LAIN_FORCE_TUI;
      else process.env.LAIN_FORCE_TUI = had;
    }
  };

  await test('MOUSE: a click on the input row becomes the caret INDEX under it', () => {
    const { caretAt } = require('../../src/ui/mouse');
    const text = 'fix the dashboard signal button';
    const screen = drawn(text);
    const [only] = screen.rowMap.inputLines;
    // Column 5 is the first character of the text — see rowMap.inputTextCol.
    assert.strictEqual(caretAt(screen, 5, only.row), 0);
    assert.strictEqual(caretAt(screen, 5 + 17, only.row), 17, 'clicking a character selects that character');
    assert.strictEqual(caretAt(screen, 999, only.row), text.length,
      'past the end of the text the caret stops at the end');
    assert.strictEqual(caretAt(screen, 1, only.row), 0, 'and left of the text it stops at the start');
  });

  await test('MOUSE: a long line WRAPS, and a click on any of its rows is exact', () => {
    // WAS "a click on a SCROLLED line accounts for the window offset". A long
    // line no longer scrolls sideways — it wraps () — so the offset it was
    // about does not exist. The property that replaces it is stronger: every
    // row of a wrapped line is clickable, and the index is exact on each.
    const { caretAt } = require('../../src/ui/mouse');
    const text = 'x'.repeat(200);
    const screen = drawn(text);
    const rows = screen.rowMap.inputLines;
    assert.ok(rows.length > 1, `a 200-character line must wrap, not scroll: ${rows.length} row(s)`);
    for (const r of rows) {
      assert.strictEqual(caretAt(screen, 5, r.row), r.begins,
        `the first column of row ${r.row} is where that row begins`);
      assert.strictEqual(caretAt(screen, 15, r.row), r.begins + 10);
    }
  });

  await test('MOUSE: on a multi-line prompt the caret lands in the RIGHT line', () => {
    const { caretAt } = require('../../src/ui/mouse');
    const NL2 = String.fromCharCode(10);
    const buf = `first line${NL2}second line${NL2}third`;
    const screen = drawn(buf, buf.length);
    const rows = screen.rowMap.inputLines;
    assert.strictEqual(rows.length, 3, 'three lines, three rows');
    assert.strictEqual(caretAt(screen, 5, rows[1].row), 11, 'the start of the second line');
    assert.strictEqual(caretAt(screen, 5 + 6, rows[1].row), 17);
    assert.strictEqual(caretAt(screen, 5, rows[2].row), 23, 'and the third');
  });

  await test('MOUSE: the caret is placed ON the row the click landed on', () => {
    // The regression the growing box introduced: `rowMap.inputRow` is only the
    // CARET's row, so clicking any other line of a three-line prompt silently
    // used the wrong one.
    const { caretAt } = require('../../src/ui/mouse');
    const NL2 = String.fromCharCode(10);
    const screen = drawn(`alpha${NL2}bravo${NL2}charlie`, 0);
    const rows = screen.rowMap.inputLines;
    const got = rows.map((r) => caretAt(screen, 5, r.row));
    assert.deepStrictEqual(got, [0, 6, 12],
      'each row must resolve to its own start, whatever the caret is doing');
  });

  // --------------------------------------------------------------- reports --

  await test('REPORTS: audit and health are tracked SEPARATELY', () => {
    // One shared `_reportPending` flag meant that opening AUDIT and then HEALTH
    // before the first finished refused health's pass — and nothing ever asked
    // again, so the pane read "reading the project…" for the rest of the
    // session. Tabbing through the views is exactly how anyone reaches health.
    const { ensureReport } = require('../../src/ui/reports');
    const ui = {
      screen: { report: {}, draw() {} },
      app: { session: { cwd: process.cwd() } },
    };
    const a = ensureReport(ui, 'audit');
    const h = ensureReport(ui, 'health');
    assert.ok(a && typeof a.then === 'function', 'the audit pass started');
    assert.ok(h && typeof h.then === 'function',
      'and health started too — it must not be blocked by the audit still running');
    return Promise.all([a, h]);
  });

  await test('REPORTS: a second request for the SAME view is still refused', () => {
    const { ensureReport } = require('../../src/ui/reports');
    const ui = { screen: { report: {}, draw() {} }, app: { session: { cwd: process.cwd() } } };
    const first = ensureReport(ui, 'audit');
    assert.strictEqual(ensureReport(ui, 'audit'), null, 'one pass per pane, not one per redraw');
    return first;
  });
};
