'use strict';

/**
 * WIDTH MATHS THAT SURVIVES COLOUR.
 *
 * Every drawn region pads its content out to a frame. With `String.length` that
 * arithmetic is a lie the moment a line carries an escape sequence — nine bytes
 * measured as nine cells for one visible character — and the frame tears open on
 * the right. That is the reason the whole workspace was plain text.
 *
 * These are the properties the rest of the UI now depends on.
 */

const assert = require('assert');
const { test } = require('../helpers');

const T = require('../../src/ui/text');

const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;

module.exports = async function () {
  await test('TEXT: width counts what the terminal shows, not what is in memory', () => {
    assert.strictEqual(T.width('abc'), 3);
    assert.strictEqual(T.width(GREEN('abc')), 3);
    assert.strictEqual(GREEN('abc').length, 12, 'the raw string really is longer');
    assert.strictEqual(T.width(''), 0);
    assert.strictEqual(T.width(null), 0);
  });

  await test('TEXT: clip truncates by VISIBLE characters and keeps the colour', () => {
    assert.strictEqual(T.clip('abcdef', 4), 'abc…');
    const clipped = T.clip(GREEN('abcdef'), 4);
    assert.strictEqual(T.width(clipped), 4, 'a coloured string clips where a plain one would');
    assert.match(clipped, /\x1b\[32m/, 'the colour it started with is still applied');
  });

  await test('TEXT: a truncated string never leaves its colour open', () => {
    // Bleeding a colour past the clip point paints the rest of the drawn row —
    // including the frame — in whatever the content happened to be using.
    const clipped = T.clip(GREEN('abcdef'), 4);
    assert.ok(clipped.endsWith('\x1b[0m'), `colour left open: ${JSON.stringify(clipped)}`);
  });

  await test('TEXT: nothing is clipped that already fits', () => {
    assert.strictEqual(T.clip('abc', 10), 'abc');
    assert.strictEqual(T.clip(GREEN('abc'), 10), GREEN('abc'));
  });

  await test('TEXT: pad and fit measure visibly, so a column stays a column', () => {
    assert.strictEqual(T.width(T.pad(GREEN('ab'), 6)), 6);
    assert.strictEqual(T.width(T.fit(GREEN('abcdefghij'), 6)), 6, 'fit clips as well as pads');
    assert.strictEqual(T.width(T.fit('ab', 6)), 6);
  });

  await test('TEXT: a box is exactly square at every width, coloured or not', () => {
    for (const w of [24, 40, 80]) {
      const lines = T.box(GREEN('TITLE'), ['plain', GREEN('coloured'), 'x'.repeat(200)], w);
      for (const l of lines) assert.strictEqual(T.width(l), w, `a box row was ${T.width(l)} wide at ${w}`);
      assert.ok(lines[0].startsWith('┌'));
      assert.ok(lines[lines.length - 1].startsWith('└'));
    }
  });

  await test('TEXT: shortPath keeps the end — the part that identifies the file', () => {
    const p = 'C:\\Users\\x\\Documents\\proj\\src\\a.js';
    const short = T.shortPath(p, 24);
    assert.ok(short.length <= 24);
    assert.ok(short.endsWith('a.js'), `the filename must survive: ${short}`);
  });

  await test('TEXT: projectName is the folder, whatever the separator', () => {
    assert.strictEqual(T.projectName('C:\\Users\\x\\scalpbot'), 'scalpbot');
    assert.strictEqual(T.projectName('/home/x/scalpbot/'), 'scalpbot');
  });

  /** A literal tab, named so the tests below read as prose. */
  const TAB = '\t';

  await test('DETAB: a tab never reaches a painted region', () => {
    // ---- SEEN ON SCREEN, as black rectangles through the diff surface ------
    //
    // `read_file` emits `  1990<TAB>    def implement(...)`. A terminal handling
    // a tab does not WRITE anything — it moves the cursor to the next stop, and
    // the cells it skips keep the DEFAULT background rather than the one the row
    // had opened. So the surface is simply not painted across the gap.
    const raw = '  1990' + TAB + 'def f():';
    assert.ok(!T.detab(raw).includes(TAB), 'no tab survives');
    assert.strictEqual(T.detab(raw), '  1990  def f():');
  });

  await test('DETAB: it fixes the ARITHMETIC too, which is the quiet half', () => {
    // `width()` counts a tab as one cell; the terminal advances up to eight. A
    // row measured short is padded too far and its right border lands past the
    // frame — the tearing this module exists to prevent, from an input nobody
    // thought to expand.
    const raw = 'a' + TAB + 'b';
    assert.strictEqual(T.width(raw), 3, 'measured as three, which is the lie');
    assert.strictEqual(T.width(T.detab(raw)), 9, 'and nine is what the terminal does');
  });

  await test('DETAB: stops are columns, and an escape occupies none', () => {
    assert.strictEqual(T.detab('ab' + TAB + 'c'), 'ab      c', 'to the next multiple of eight');
    assert.strictEqual(T.detab('12345678' + TAB + 'x'), '12345678        x', 'a full stop when already on one');
    // Colour must not push the stop along: it is not on screen.
    const coloured = '\x1b[2mab\x1b[0m' + TAB + 'c';
    assert.strictEqual(T.strip(T.detab(coloured)), 'ab      c');
  });

  await test('DETAB: text with no tab is returned untouched', () => {
    const plain = 'nothing to expand here';
    assert.strictEqual(T.detab(plain), plain);
  });
};
