'use strict';

/**
 * "WHAT DID I JUST PASTE?"
 *
 * A paste is one input and the input box is one row, so a 1,200-line paste
 * showed one line of itself and a `[1/1200]` counter. That tells you where the
 * caret is, not what arrived — you could not tell a complete paste from a
 * truncated one without arrowing through the whole thing.
 *
 * The rule these tests hold: state the facts about the paste in ONE row, never
 * render the paste itself, and never touch the buffer — the content stays
 * exactly as pasted, editable, and unsent until Enter.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { pasteSummary, inputViewport } = require('../../src/ui/viewport');

module.exports = async function () {
  await test('PASTE: a single line needs no summary', () => {
    assert.strictEqual(pasteSummary('just a normal prompt', 80), null);
    assert.strictEqual(pasteSummary('', 80), null);
  });

  await test('PASTE: a big paste states line count, size and how it starts', () => {
    const body = Array.from({ length: 1234 }, (_, i) => `const line${i} = ${i};`).join('\n');
    const s = pasteSummary(body, 96);
    assert.match(s, /1,234 lines/, 'the line count must be stated, grouped for reading');
    assert.match(s, /KB/, 'the size must be stated');
    assert.match(s, /const line0 = 0;/, 'it must show how the paste begins');
    assert.ok(s.split('\n').length === 1, 'the summary is ONE row, never the paste itself');
  });

  await test('PASTE: the summary fits the width it is given', () => {
    const body = 'x'.repeat(400) + '\n' + 'y'.repeat(400);
    for (const w of [40, 60, 80, 120]) {
      const s = pasteSummary(body, w);
      assert.ok(s.length <= w, `summary is ${s.length} wide at width ${w}`);
    }
  });

  await test('PASTE: a leading blank line does not become the preview', () => {
    const s = pasteSummary('\n\n   \nactual first content\nmore', 80);
    assert.match(s, /actual first content/);
  });

  await test('PASTE: small sizes read in bytes, not "0.0 KB"', () => {
    const s = pasteSummary('a\nb', 80);
    assert.match(s, /\d+ B\b/);
    assert.ok(!/KB/.test(s));
  });

  await test('PASTE: the buffer itself is never altered by summarising it', () => {
    const body = 'line one\nline two\nline three';
    const before = body;
    pasteSummary(body, 80);
    assert.strictEqual(body, before);
    // and the viewport still shows the caret's own line, unchanged
    const vp = inputViewport(body, body.indexOf('line two'), 40);
    assert.strictEqual(vp.lines, 3);
    assert.match(vp.text, /line two|line one/);
  });

  await test('PASTE: a 1,200-line paste is still editable line by line', () => {
    // The summary is a statement ABOUT the buffer; navigation is unaffected.
    const body = Array.from({ length: 1200 }, (_, i) => `row ${i}`).join('\n');
    const atLast = body.length - 1;
    const vp = inputViewport(body, atLast, 60);
    assert.strictEqual(vp.lines, 1200);
    assert.strictEqual(vp.line, 1199, 'the caret must be on the last line, not line 0');
    assert.match(vp.text, /row 1199/);
  });

  await test('PASTE: the box measures the ROWS IT OCCUPIES, not its newlines', () => {
    // ---- SEEN ON SCREEN ---------------------------------------------------
    //
    // A pasted markdown prompt: five newlines, eighty-one rows once wrapped.
    // The summary compared `5 <= 8` and declared it small enough to show whole,
    // so no marker was drawn and the box filled with raw text — precisely the
    // case this row exists for.
    //
    // "How many lines does it contain" and "how much of the box does it need"
    // are different questions, and only the second is about whether it fits.
    const pasted = require('../../src/ui/pasted');
    pasted.reset();
    const long = 'an experimental chess-AI research system whose goal is to discover and evolve '.repeat(18);
    const buf = ['# CrusaderChess', '', long, '', '* Strong performance'].join(String.fromCharCode(10));
    assert.strictEqual(buf.split(String.fromCharCode(10)).length, 5, 'five newlines');
    const rows = require('../../src/ui/viewport').wrapInput(buf, 108).length;
    assert.ok(rows > 8, `but it occupies ${rows} rows, which does not fit a box of 8`);
    assert.ok(pasteSummary(buf, 110, 8), 'so it must be summarised');
  });

  await test('PASTE: the input box calls it what the FEED will call it', () => {
    // The box described the identical bytes in an entirely different
    // vocabulary, so the thing you were about to send and the thing that
    // appeared when you sent it had no name in common — and the marker in the
    // feed referred to something the user had never seen called that.
    const pasted = require('../../src/ui/pasted');
    const feed = require('../../src/ui/feed');
    pasted.reset();
    const buf = Array.from({ length: 40 }, (_, i) => 'line ' + i + ' of a pasted block').join(String.fromCharCode(10));

    const inBox = pasteSummary(buf, 110, 8);
    const out = [];
    feed.pushUser(out, buf);
    const inFeed = String(out[0].text);

    const marker = /\[pasted text #\d+\]/.exec(inBox);
    assert.ok(marker, `the input box must name it: ${inBox}`);
    assert.strictEqual(inFeed, marker[0], 'and the feed must use the very same name');
    // The facts stay too: the box is where you check what you are about to send.
    assert.match(inBox, /40 lines/);
  });

  await test('PASTE: something merely TYPED gets no marker, only the facts', () => {
    // Asking for a marker consumes a number, and a number that appears for text
    // that was never pasted would put a phantom `#2` in the feed's sequence.
    const pasted = require('../../src/ui/pasted');
    pasted.reset();
    const typed = Array.from({ length: 12 }, () => 'x').join(String.fromCharCode(10));
    const row = pasteSummary(typed, 110, 4);
    assert.ok(row, 'it still overflows the box and is still summarised');
    assert.ok(!/pasted text/.test(row), `not a paste, so not named as one: ${row}`);
    assert.strictEqual(pasted.count(), 0, 'and no number was consumed');
  });
};
