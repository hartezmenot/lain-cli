'use strict';

/**
 * THE INPUT VIEWPORT.
 *
 * The input row drew `clip('> ' + text, width)` — always the START of the line.
 * Type past the right edge and the caret, and everything after it, was simply
 * not on screen: you were editing blind, and a long prompt could not be
 * reviewed or corrected without deleting it.
 *
 * These are pure geometry, so they need no terminal: given a buffer, a caret
 * and a width, what gets drawn and where does the caret land.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { inputViewport } = require('../../src/ui/viewport');

const LONG = 'the quick brown fox jumps over the lazy dog and keeps running well past the edge of the terminal';

/** The caret must always be somewhere a terminal could actually draw it. */
function visible(v, width) {
  return v.cursorCol >= 0 && v.cursorCol < width && v.text.length <= width;
}

module.exports = async function () {
  await test('VP: a short line is shown whole, with the caret where it belongs', () => {
    const v = inputViewport('hello', 5, 40);
    assert.strictEqual(v.text, 'hello');
    assert.strictEqual(v.cursorCol, 5);
    assert.strictEqual(v.scrolled, false);
  });

  await test('VP: typing past the edge scrolls to follow the caret', () => {
    const end = inputViewport(LONG, LONG.length, 40);
    assert.ok(end.scrolled, 'a line longer than the frame must scroll');
    assert.ok(visible(end, 40), `caret at ${end.cursorCol} in a ${end.text.length}-char slice`);
    // The END of the line is what you are typing, so that is what is shown.
    assert.ok(end.text.endsWith('terminal'), end.text);
    assert.ok(end.text.startsWith('…'), 'and it is marked as continuing to the left');
  });

  await test('VP: moving the caret back brings the earlier text into view', () => {
    const start = inputViewport(LONG, 0, 40);
    assert.ok(start.text.startsWith('the quick'), start.text);
    assert.strictEqual(start.cursorCol, 0);
    assert.ok(start.text.endsWith('…'), 'and marked as continuing to the right');
  });

  await test('VP: the caret stays visible at every position along a long line', () => {
    // The property that actually matters, checked exhaustively rather than at
    // three hand-picked offsets.
    for (let i = 0; i <= LONG.length; i++) {
      const v = inputViewport(LONG, i, 40);
      assert.ok(visible(v, 40), `caret hidden at offset ${i}: col=${v.cursorCol} len=${v.text.length}`);
    }
  });

  await test('VP: the caret stays visible at every width', () => {
    for (const w of [10, 20, 40, 80, 120]) {
      for (const at of [0, 1, Math.floor(LONG.length / 2), LONG.length - 1, LONG.length]) {
        const v = inputViewport(LONG, at, w);
        assert.ok(visible(v, w), `width ${w}, caret ${at}: col=${v.cursorCol} len=${v.text.length}`);
      }
    }
  });

  await test('VP: a multi-line buffer shows the line the caret is ON', () => {
    const buf = 'alpha one\nbeta two\ngamma three';
    const v = inputViewport(buf, buf.indexOf('gamma') + 2, 40);
    assert.strictEqual(v.text, 'gamma three');
    assert.strictEqual(v.line, 2);
    assert.strictEqual(v.lines, 3);
    assert.strictEqual(v.cursorCol, 2);
  });

  await test('VP: moving between lines moves the window with the caret', () => {
    const buf = 'alpha one\nbeta two\ngamma three';
    assert.strictEqual(inputViewport(buf, 0, 40).text, 'alpha one');
    assert.strictEqual(inputViewport(buf, buf.indexOf('beta'), 40).text, 'beta two');
  });

  await test('VP: a long line INSIDE a multi-line buffer still scrolls', () => {
    const buf = `short\n${LONG}\nshort`;
    const v = inputViewport(buf, buf.indexOf(LONG) + LONG.length, 40);
    assert.ok(v.scrolled);
    assert.strictEqual(v.line, 1);
    assert.ok(visible(v, 40));
  });

  await test('VP: an empty buffer is not an error', () => {
    const v = inputViewport('', 0, 40);
    assert.strictEqual(v.text, '');
    assert.strictEqual(v.cursorCol, 0);
    assert.strictEqual(v.lines, 1);
  });

  await test('VP: a caret out of range is clamped rather than trusted', () => {
    assert.ok(visible(inputViewport('abc', 99, 40), 40));
    assert.ok(visible(inputViewport('abc', -5, 40), 40));
  });

  await test('VP: the ellipsis replaces a character, so the caret column stays true', () => {
    // If `…` were prepended rather than substituted, every column to its right
    // would be reported one place off and the caret would draw in the wrong cell.
    for (const at of [30, 50, 70]) {
      const v = inputViewport(LONG, at, 40);
      assert.ok(v.text.length <= 39, `slice is ${v.text.length} wide in a 40-wide box`);
    }
  });
};
