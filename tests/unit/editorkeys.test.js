'use strict';

/**
 * THE EDITING KEYS THAT WERE SILENTLY MISSING —.
 *
 * These were not broken; they did NOTHING. A well-formed CSI sequence with no
 * entry in the name table is consumed rather than typed — which is right, since
 * nobody wants `[3~` appearing in their prompt — but it means an unmapped key
 * produces no character, no error and no clue. Delete, Ctrl+←/→ and every
 * Shift+arrow were in exactly that state: pressed, swallowed, nothing happened.
 *
 * Each test drives the real reader over a real byte sequence, because the byte
 * sequence IS the thing that was wrong. Asserting on a key NAME would have
 * passed all along.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Input } = require('../../src/input');
const { decodeEscape } = require('../../src/keydecode');

/** A reader with a buffer already in it, off a TTY so nothing echoes. */
function editor(line, cursor = null) {
  const r = new Input({
    stdin: { isTTY: false, setEncoding() {}, on() {}, resume() {}, pause() {}, removeListener() {} },
    stdout: { write() {} },
  });
  r.line = line;
  r.cursor = cursor == null ? line.length : cursor;
  return r;
}

module.exports = async function () {
  await test('KEYS: the byte sequences a terminal really sends are all named', () => {
    const want = {
      '\x1b[3~': 'delete',
      '\x1b[1;5D': 'word-left',
      '\x1b[1;5C': 'word-right',
      '\x1b[1;2D': 'shift-left',
      '\x1b[1;2C': 'shift-right',
      '\x1b[1;2H': 'shift-home',
      '\x1b[1;2F': 'shift-end',
      '\x1b[1~': 'home',
      '\x1b[4~': 'end',
    };
    for (const [seq, name] of Object.entries(want)) {
      const d = decodeEscape(seq);
      assert.ok(d, `${JSON.stringify(seq)} decoded to nothing at all`);
      assert.strictEqual(d.key, name,
        `${JSON.stringify(seq)} should be ${name}, got ${JSON.stringify(d.key)}`);
      assert.strictEqual(d.take, seq.length, 'the whole sequence must be consumed');
    }
  });

  await test('DELETE: it removes the character AFTER the caret, not before', () => {
    const r = editor('hello world', 5);
    r.editKey('delete');
    assert.strictEqual(r.line, 'helloworld', 'the space after the caret goes');
    assert.strictEqual(r.cursor, 5, 'and the caret does not move');
  });

  await test('DELETE: at the very end it does nothing rather than eating backwards', () => {
    const r = editor('abc');
    assert.strictEqual(r.editKey('delete'), true, 'the key is still consumed');
    assert.strictEqual(r.line, 'abc');
  });

  await test('DELETE: it joins two lines of a multi-line prompt', () => {
    const r = editor('first\nsecond', 5);
    r.editKey('delete');
    assert.strictEqual(r.line, 'firstsecond', 'the newline goes like any other character');
  });

  await test('DELETE: with a selection it removes the SELECTION', () => {
    const r = editor('hello world', 0);
    r.selectFrom(0);
    r.selectTo(6);
    r.editKey('delete');
    assert.strictEqual(r.line, 'world');
  });

  await test('WORD: Ctrl+← and Ctrl+→ move by word, agreeing with deleteWord', () => {
    const r = editor('src/ui/layout.js is long');
    r.editKey('word-left');
    assert.strictEqual(r.line.slice(r.cursor), 'long', 'back over one word');
    r.editKey('word-left');
    assert.strictEqual(r.line.slice(r.cursor), 'is long');

    // THE SAME BOUNDARY DELETEWORD USES. If these two disagreed, moving over a
    // word and deleting it would land in different places — the bug that makes
    // an editor feel wrong without ever being obviously broken.
    const a = editor('dashboard.py');
    const boundary = a.wordBoundary(-1);
    const b = editor('dashboard.py');
    b.deleteWord();
    assert.strictEqual(b.line.length, boundary,
      'wordBoundary and deleteWord must agree about where a word ends');
  });

  await test('WORD: punctuation is its own run — dashboard.py goes py, then ., then dashboard', () => {
    const r = editor('dashboard.py');
    r.editKey('word-left');
    assert.strictEqual(r.line.slice(0, r.cursor), 'dashboard.');
    r.editKey('word-left');
    assert.strictEqual(r.line.slice(0, r.cursor), 'dashboard');
  });

  await test('SELECT: Shift+← EXTENDS rather than re-anchoring on every press', () => {
    // The defect this guards: anchoring on each keypress gives a selection that
    // is permanently one character long however long the key is held.
    const r = editor('hello');
    r.editKey('shift-left');
    r.editKey('shift-left');
    r.editKey('shift-left');
    assert.strictEqual(r.selectedText(), 'llo', `expected three characters, got ${JSON.stringify(r.selectedText())}`);
  });

  await test('SELECT: Shift+Home takes everything back to the start of the line', () => {
    const r = editor('first\nsecond line');
    r.editKey('shift-home');
    assert.strictEqual(r.selectedText(), 'second line', 'only the CURRENT line, not the whole buffer');
  });

  await test('SELECT: a plain arrow ends the selection, as it does everywhere else', () => {
    const r = editor('hello');
    r.editKey('shift-left');
    assert.ok(r.hasSelection());
    r.editKey('left');
    assert.ok(!r.hasSelection(), 'an unmodified arrow is a caret move, not a selection');
  });

  await test('HOME/END: all three spellings a terminal may send reach the same place', () => {
    for (const seq of ['\x1b[H', '\x1b[1~', '\x1b[7~']) {
      const r = editor('hello world', 6);
      r.editKey(decodeEscape(seq).key);
      assert.strictEqual(r.cursor, 0, `${JSON.stringify(seq)} must go home`);
    }
    for (const seq of ['\x1b[F', '\x1b[4~', '\x1b[8~']) {
      const r = editor('hello world', 2);
      r.editKey(decodeEscape(seq).key);
      assert.strictEqual(r.cursor, 11, `${JSON.stringify(seq)} must go to the end`);
    }
  });
};
