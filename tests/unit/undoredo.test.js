'use strict';

/**
 * SELECT ALL, UNDO, REDO — and the shortcuts around them that did NOTHING.
 *
 * `Ctrl+A`, `Ctrl+Z` and `Ctrl+Y` arrived at the reader as ordinary named key
 * events (input.js's generic Ctrl+letter path already produced them) and then
 * fell through every layer of routing to nowhere: `grep` for any of the three
 * anywhere in src/ returned zero hits before this. Not broken — absent.
 *
 * Undo/redo itself did not exist at all: no stack, no snapshot, no coalescing
 * rule. See undo.js for the mechanism these tests exercise through the real
 * byte path, the same way editorkeys.test.js and selection.test.js already
 * drive Delete, word movement and the clipboard keys.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { test } = require('../helpers');
const { Input } = require('../../src/input');
const { decodeEscape } = require('../../src/keydecode');

const CTRL_A = String.fromCharCode(1);
const CTRL_Z = String.fromCharCode(26);
const CTRL_Y = String.fromCharCode(25);
const CTRL_C = String.fromCharCode(3);

/**
 * A reader driven by real bytes, exactly as selection.test.js's does — plus
 * the one piece of glue repl.js normally provides: routing a `key` event to
 * `editKey`. Ctrl+C/X/V are handled INSIDE input.js directly and need no such
 * routing (selection.test.js exercises those with no glue at all); Ctrl+A,
 * Ctrl+Z, Ctrl+Y, Ctrl+Home/End and Ctrl+Delete are decoded to a named `key`
 * the same way Delete and word movement are (see editorkeys.test.js), and
 * that name reaches the line editor only via the router this replicates.
 */
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
  for (const name of ['clipboard', 'interrupt']) {
    input.on(name, (ev) => events.push({ [name]: ev === undefined ? true : ev }));
  }
  input.on('key', (k) => { events.push({ key: k }); input.editKey(k); });
  return { input, events, type: (s) => stdin.emit('data', Buffer.from(s, 'utf8')) };
}

/** `events`, with the routing `key` entries this reader() adds filtered out —
 *  selection.test.js's assertions predate that glue and expect clipboard/
 *  interrupt alone. */
function notKey(events) { return events.filter((e) => !('key' in e)); }

module.exports = async function () {
  // ---------------------------------------------------------- SELECT ALL ----

  await test('KEYS: the raw Ctrl+A byte reaches the reader as key "ctrl-a"', () => {
    // Ctrl+A is a bare control byte (\x01), decoded by input.js's OWN generic
    // Ctrl+letter path rather than keydecode.js — this confirms that path
    // still names it correctly, before testing what the name does.
    const r = reader();
    r.type(CTRL_A);
    assert.ok(r.events.some((e) => e.key === 'ctrl-a'), `expected a "ctrl-a" key event: ${JSON.stringify(r.events)}`);
  });

  await test('SELECT ALL: Ctrl+A selects the whole line, caret at the end', () => {
    const r = reader();
    r.type('hello');
    r.type(CTRL_A);
    assert.strictEqual(r.input.selectedText(), 'hello', 'Ctrl+A must select the whole line');
    assert.strictEqual(r.input.cursor, 5, 'the caret lands at the end, as every editor does');
  });

  await test('SELECT ALL: Ctrl+A then typing replaces the whole line', () => {
    const r = reader();
    r.type('hello');
    r.type(CTRL_A);
    r.type('world');
    assert.strictEqual(r.input.line, 'world');
  });

  await test('SELECT ALL: Ctrl+A then Backspace/Delete clears the input', () => {
    const r = reader();
    r.type('hello');
    r.type(CTRL_A);
    r.type(String.fromCharCode(127)); // backspace
    assert.strictEqual(r.input.line, '');
  });

  await test('SELECT ALL: Ctrl+A then Ctrl+C copies the ENTIRE input, and does not interrupt', () => {
    const r = reader();
    r.type('hello world');
    r.type(CTRL_A);
    r.type(CTRL_C);
    assert.deepStrictEqual(notKey(r.events), [{ clipboard: { action: 'copy', text: 'hello world' } }]);
  });

  await test('SELECT ALL: on an empty line it is a harmless no-op', () => {
    const r = reader();
    r.type(CTRL_A);
    assert.strictEqual(r.input.hasSelection(), false);
    r.type('x');
    assert.strictEqual(r.input.line, 'x');
  });

  // -------------------------------------------------------- UNDO BASICS -----

  await test('UNDO: a single insert reverts to empty', () => {
    const r = reader();
    r.type('x');
    r.type(CTRL_Z);
    assert.strictEqual(r.input.line, '');
  });

  await test('UNDO: with nothing to undo it is a harmless no-op, not a crash', () => {
    const r = reader();
    assert.strictEqual(r.input.undo(), false);
    r.type(CTRL_Z);
    assert.strictEqual(r.input.line, '');
  });

  await test('REDO: undo then redo restores exactly what was undone', () => {
    const r = reader();
    r.type('hello');
    r.type(CTRL_Z);
    assert.strictEqual(r.input.line, '');
    r.type(CTRL_Y);
    assert.strictEqual(r.input.line, 'hello');
  });

  await test('REDO: a NEW edit after undo cuts off the old redo future', () => {
    const r = reader();
    r.type('hello');
    r.type(CTRL_Z);            // undo -> ''
    r.type('world');           // a genuinely new edit
    assert.strictEqual(r.input.redo(), false, 'redoing "hello" back must not be possible now');
    assert.strictEqual(r.input.line, 'world');
  });

  // --------------------------------------------------- THE SPEC'S OWN CASES -

  await test('UNDO: "hello", Ctrl+A, type "world", Ctrl+Z restores "hello"', () => {
    // The exact example from the assignment. Coalescing must not let the
    // second typing run merge with the first just because both are inserts —
    // Ctrl+A must break the run, or Ctrl+Z would only erase one letter of
    // "world" instead of restoring "hello" whole.
    const r = reader();
    r.type('hello');
    r.type(CTRL_A);
    r.type('world');
    assert.strictEqual(r.input.line, 'world');
    r.type(CTRL_Z);
    assert.strictEqual(r.input.line, 'hello', `expected "hello" restored, got ${JSON.stringify(r.input.line)}`);
  });

  await test('UNDO: "hello world", select last word, Ctrl+X, Ctrl+Z restores the cut text', () => {
    const r = reader();
    r.type('hello world');
    r.input.editKey('shift-word-left'); // selects "world" back from the end
    assert.strictEqual(r.input.selectedText(), 'world');
    r.type(String.fromCharCode(24)); // Ctrl+X
    assert.strictEqual(r.input.line, 'hello ');
    r.type(CTRL_Z);
    assert.strictEqual(r.input.line, 'hello world', 'the cut text must come back');
  });

  // ------------------------------------------------------------ COALESCING --

  await test('COALESCE: five characters typed in a row undo in ONE press', () => {
    const r = reader();
    r.type('hello');
    assert.strictEqual(r.input.undo(), true);
    assert.strictEqual(r.input.line, '', 'one Ctrl+Z must remove the whole run, not one letter');
  });

  await test('COALESCE: moving the caret between two typing runs keeps them SEPARATE', () => {
    const r = reader();
    r.type('hello');
    r.input.editKey('left'); // caret-only move — must break the run
    r.type('X');
    assert.strictEqual(r.input.line, 'hellXo');
    r.input.undo();
    assert.strictEqual(r.input.line, 'hello', 'only the second run undoes first');
    r.input.undo();
    assert.strictEqual(r.input.line, '', 'and the first run is a separate, later undo');
  });

  await test('COALESCE: a paste is its own step, however long, never merged with typing', () => {
    const r = reader();
    r.type('go: ');
    r.input.insertText('a very long pasted sentence', { pasted: true });
    r.type('!');
    r.input.undo();
    assert.strictEqual(r.input.line, 'go: a very long pasted sentence', 'the trailing "!" alone undoes first');
    r.input.undo();
    assert.strictEqual(r.input.line, 'go: ', 'the WHOLE paste undoes in one step, not letter by letter');
  });

  await test('COALESCE: consecutive backspaces undo together; a delete afterward does not join them', () => {
    const r = reader();
    r.type('hello');
    r.type(String.fromCharCode(127));
    r.type(String.fromCharCode(127)); // "hel" — two backspaces, one run
    r.input.moveCursor(-3);
    r.input.editKey('delete'); // forward-delete: a DIFFERENT kind, own step
    assert.strictEqual(r.input.line, 'el');
    r.input.undo();
    assert.strictEqual(r.input.line, 'hel', 'the forward-delete alone undoes first');
    r.input.undo();
    assert.strictEqual(r.input.line, 'hello', 'both backspaces undo together, as one run');
  });

  // --------------------------------------------------------- RESET POINTS ---

  await test('RESET: submitting a line starts the NEXT one with a clean undo stack', () => {
    const r = reader();
    r.type('first line');
    r.type('\r'); // Enter — a bare \n on a TTY reader means Ctrl+J, insert a line break
    assert.strictEqual(r.input.undo(), false, 'undo must not reach back into an already-submitted line');
  });

  await test('RESET: history recall (↑) does not let Ctrl+Z reach into the recalled prompt', () => {
    const r = reader();
    r.type('remembered');
    r.type('\r');
    r.input.recallPrev();
    assert.strictEqual(r.input.line, 'remembered');
    assert.strictEqual(r.input.undo(), false, 'undo must not unpick a line that arrived by recall, not editing');
  });

  // -------------------------------------------------- WHOLE-BUFFER HOME/END -

  await test('CTRL+HOME / CTRL+END: jump the WHOLE multi-line buffer, not just the current line', () => {
    const r = reader();
    r.input.insertText('first\nsecond\nthird', { pasted: true });
    r.input.editKey('ctrl-home');
    assert.strictEqual(r.input.cursor, 0);
    r.input.editKey('ctrl-end');
    assert.strictEqual(r.input.cursor, r.input.line.length);
  });

  await test('KEYS: Ctrl+Home / Ctrl+End byte sequences are named', () => {
    assert.strictEqual(decodeEscape('\x1b[1;5H').key, 'ctrl-home');
    assert.strictEqual(decodeEscape('\x1b[1;5F').key, 'ctrl-end');
  });

  // ---------------------------------------------------------- CTRL+DELETE ---

  await test('CTRL+DELETE: removes the WORD after the caret, mirroring Ctrl+Backspace', () => {
    const r = reader();
    r.type('one two three');
    r.input.moveCursor(-('two three'.length));
    r.input.editKey('ctrl-delete');
    assert.strictEqual(r.input.line, 'one  three', 'only "two" goes, the space before "three" stays');
  });

  await test('CTRL+DELETE: with a selection it deletes the SELECTION, same as plain Delete', () => {
    const r = reader();
    r.type('hello world');
    r.input.selectFrom(0);
    r.input.selectTo(6);
    r.input.editKey('ctrl-delete');
    assert.strictEqual(r.input.line, 'world');
  });

  await test('KEYS: Ctrl+Delete byte sequence is named', () => {
    assert.strictEqual(decodeEscape('\x1b[3;5~').key, 'ctrl-delete');
  });

  // --------------------------------------------------------- OWNERSHIP -----

  await test('OWNERSHIP: Ctrl+C still interrupts when nothing is selected, Ctrl+A or not', () => {
    // Ctrl+A having just run must not leave some residual state that changes
    // what a later, selection-free Ctrl+C means.
    const r = reader();
    r.type('work');
    r.type(CTRL_A);
    r.input.clearSelection(); // e.g. Escape, or any caret move
    r.type(CTRL_C);
    assert.deepStrictEqual(notKey(r.events), [{ interrupt: true }]);
  });
};
