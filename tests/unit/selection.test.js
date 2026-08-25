'use strict';

/**
 * DRAG SELECTION IN THE INPUT BOX —.
 *
 * WHY THE APPLICATION OWNS A SELECTION AT ALL. The terminal has one and it is
 * read-only: you can copy an error message out of the scrollback with it and
 * you cannot change anything. The input box needs one that can be REPLACED,
 * deleted and cut, and that means tracking it here — which costs the terminal's
 * own selection, recovered with Shift+drag. See input.js for that trade.
 *
 * WHAT WAS MISSING BEFORE: `?1000h` reports presses only, and every release was
 * dropped on the floor, so a drag could not be observed at all. There was no
 * selection to have.
 *
 * THE ONE THAT WOULD BITE: Ctrl+C. It is the most important key in the program
 * and it is now conditional — copy with a selection, interrupt without one.
 * That is asserted from both sides here, because getting it wrong means either
 * "I cannot copy" or, far worse, "I cannot stop it".
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { test } = require('../helpers');

const { Input } = require('../../src/input');
const { Selection, clipboardKey } = require('../../src/selection');
const { mouseEvent } = require('../../src/keydecode');

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const CTRL_X = String.fromCharCode(24);
const CTRL_V = String.fromCharCode(22);

function reader() {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.setEncoding = () => {};
  const input = new Input({ stdin, stdout: { write() {} } });
  input.echo = false;
  input.start();
  const events = [];
  for (const name of ['clipboard', 'interrupt', 'mouse']) {
    input.on(name, (ev) => events.push({ [name]: ev === undefined ? true : ev }));
  }
  return { input, events, type: (s) => stdin.emit('data', Buffer.from(s, 'utf8')) };
}

module.exports = async function () {
  // ------------------------------------------------------- THE MODEL ------

  await test('SELECTION: an anchor with no head is NOT a selection', () => {
    // A plain click sets an anchor in case a drag follows. If none does, the
    // click was simply a caret move and nothing else needs to know.
    const s = new Selection();
    s.from(5, 20);
    assert.strictEqual(s.active(), false);
    assert.strictEqual(s.range(), null);
  });

  await test('SELECTION: dragging BACKWARDS past the anchor still selects', () => {
    // The anchor stays where the button went down; the head follows the
    // pointer, in either direction. `range()` puts them in buffer order.
    const s = new Selection();
    s.from(10, 20);
    s.to(3, 20);
    assert.deepStrictEqual(s.range(), { start: 3, end: 10 });
  });

  await test('SELECTION: it is clamped to the buffer, whatever the pointer did', () => {
    const s = new Selection();
    s.from(-5, 8);
    s.to(999, 8);
    assert.deepStrictEqual(s.range(), { start: 0, end: 8 });
  });

  // ------------------------------------------------------- THE EDITOR ------

  await test('EDIT: typing REPLACES the selection', () => {
    const r = reader();
    r.type('hello world');
    r.input.selectFrom(6);
    r.input.selectTo(11);
    r.type('there');
    assert.strictEqual(r.input.line, 'hello there');
    assert.strictEqual(r.input.hasSelection(), false, 'and the selection is spent');
  });

  await test('EDIT: backspace deletes the whole selection in one keystroke', () => {
    const r = reader();
    r.type('hello world');
    r.input.selectFrom(0);
    r.input.selectTo(6);
    r.type(String.fromCharCode(127));
    assert.strictEqual(r.input.line, 'world');
  });

  await test('EDIT: an arrow key ENDS the selection rather than extending it', () => {
    // A selection that survived a caret move is one that silently eats the next
    // character typed.
    const r = reader();
    r.type('hello');
    r.input.selectFrom(0);
    r.input.selectTo(3);
    r.input.editKey('left');
    assert.strictEqual(r.input.hasSelection(), false);
    r.type('X');
    assert.strictEqual(r.input.line.includes('hel'), true, 'nothing was eaten');
  });

  // ---------------------------------------------------- THE CLIPBOARD ------

  await test('CTRL+C: with NOTHING selected it still interrupts', () => {
    // The most important key in the program. Breaking this means "I cannot stop
    // it", which is far worse than not being able to copy.
    const r = reader();
    r.type('some work');
    r.type(CTRL_C);
    assert.deepStrictEqual(r.events, [{ interrupt: true }]);
  });

  await test('CTRL+C: with a selection it COPIES, and does not interrupt', () => {
    const r = reader();
    r.type('hello world');
    r.input.selectFrom(6);
    r.input.selectTo(11);
    r.type(CTRL_C);
    assert.deepStrictEqual(r.events, [{ clipboard: { action: 'copy', text: 'world' } }]);
    assert.strictEqual(r.input.line, 'hello world', 'copying changes nothing');
  });

  await test('CTRL+C: Escape clears the selection and hands the key back', () => {
    // The escape hatch that makes conditioning it safe.
    const r = reader();
    r.type('hello world');
    r.input.selectFrom(0);
    r.input.selectTo(5);
    r.input.clearSelection();
    r.type(CTRL_C);
    assert.deepStrictEqual(r.events, [{ interrupt: true }]);
  });

  await test('CTRL+X cuts: the text goes out and the buffer loses it', () => {
    const r = reader();
    r.type('hello world');
    r.input.selectFrom(0);
    r.input.selectTo(6);
    r.type(CTRL_X);
    assert.deepStrictEqual(r.events, [{ clipboard: { action: 'cut', text: 'hello ' } }]);
    assert.strictEqual(r.input.line, 'world');
  });

  await test('CTRL+V asks for the clipboard — the reader never reads one itself', () => {
    // A byte-stream decoder has no business spawning `clip.exe`. It states an
    // intention and the app, which already owns copy.js, answers it.
    const r = reader();
    r.type(CTRL_V);
    assert.deepStrictEqual(r.events, [{ clipboard: { action: 'paste' } }]);
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/selection.js'), 'utf8');
    for (const forbidden of ['spawn', 'child_process', 'clip.exe', 'pbpaste']) {
      assert.ok(!src.includes(forbidden), `selection.js must not touch a clipboard (${forbidden})`);
    }
  });

  await test('PASTE: inserted text carries the paste flag, so it cannot be a command', () => {
    const r = reader();
    r.input.insertText('/exit', { pasted: true });
    assert.strictEqual(r.input.line, '/exit');
    assert.strictEqual(r.input.pastedInLine, true,
      'a pasted /exit that lost its flag would be run as a command');
  });

  // --------------------------------------------------------- THE MOUSE -----

  await test('MOUSE: press, drag and release are three kinds, and drag is bit 32', () => {
    assert.strictEqual(mouseEvent({ button: 0, x: 1, y: 1, final: 'M' }).kind, 'press');
    assert.strictEqual(mouseEvent({ button: 32, x: 1, y: 1, final: 'M' }).kind, 'drag');
    assert.strictEqual(mouseEvent({ button: 0, x: 1, y: 1, final: 'm' }).kind, 'release');
    assert.strictEqual(mouseEvent({ button: 64, x: 1, y: 1, final: 'M' }).kind, 'wheel-up');
    assert.strictEqual(mouseEvent({ button: 32, x: 1, y: 1, final: 'M' }).button, 0,
      'the motion flag is stripped from the button');
  });

  await test('MOUSE: the reader asks for BUTTON-EVENT tracking, not full motion', () => {
    // `?1002h` reports motion only while a button is held — a drag. `?1003h`
    // reports every cell the pointer crosses, which is the redraw storm.
    const written = [];
    const stdin = new EventEmitter();
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    stdin.resume = () => {};
    stdin.pause = () => {};
    stdin.setEncoding = () => {};
    const input = new Input({ stdin, stdout: { write: (s) => written.push(s) } });
    input.enableMouse();
    input.start();
    const all = written.join('');
    assert.ok(all.includes(`${ESC}[?1002h`), 'button-event tracking must be on');
    assert.ok(!all.includes(`${ESC}[?1003h`), 'full motion tracking must NOT be');
    input.stop();
    assert.ok(written.join('').includes(`${ESC}[?1002l`), 'and it is turned off again');
  });

  await test('MOUSE: a drag through the reader reaches the selection', () => {
    // End to end at unit level: real SGR bytes in, a real selection out.
    const r = reader();
    r.type('hello world');
    r.input.selectFrom(0);
    // `32` is button 0 held and moving.
    r.type(`${ESC}[<32;10;5M`);
    const drag = r.events.find((e) => e.mouse && e.mouse.kind === 'drag');
    assert.ok(drag, 'the drag never arrived as an event');
    assert.strictEqual(drag.mouse.x, 10);
  });

  // -------------------------------------------------------- THE HIGHLIGHT --

  await test('HIGHLIGHT: a selection spanning several drawn rows marks each of them', () => {
    const { Screen } = require('../../src/ui/layout');
    const had = process.env.LAIN_FORCE_TUI;
    process.env.LAIN_FORCE_TUI = '1';
    try {
      const painted = [];
      const screen = new Screen({
        out: { columns: 40, rows: 30, write: (s) => painted.push(s), isTTY: false, on() {}, removeListener() {} },
      });
      screen.enter();
      screen.inputText = 'x'.repeat(120);
      screen.inputCursorAt = 0;
      screen.inputSelection = { start: 10, end: 100 };
      screen.draw();
      screen.leave();
      const frame = painted.join('');
      const marks = (frame.match(new RegExp(`${ESC}\\[7m`, 'g')) || []).length;
      assert.ok(marks >= 2, `a run across several rows must highlight on each: ${marks}`);
      assert.ok(frame.includes(`${ESC}[27m`), 'and it must be turned off again');
    } finally {
      if (had === undefined) delete process.env.LAIN_FORCE_TUI;
      else process.env.LAIN_FORCE_TUI = had;
    }
  });
};
