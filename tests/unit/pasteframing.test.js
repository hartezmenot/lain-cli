'use strict';

/**
 * A PASTE MUST NOT BE ABLE TO KILL THE KEYBOARD.
 *
 * ------------------------------------------------------------------------
 * THE REPORTED DEFECT: "the input cannot paste the text".
 *
 * Bracketed paste closes with a six-byte marker, and a read boundary can fall
 * anywhere inside it. The reader, on failing to find the marker, moved the
 * WHOLE buffer into the paste — swallowing the first half of it. The rest
 * arrived on its own, matched nothing, and was swallowed too. The marker no
 * longer existed anywhere, so `pasting` stayed true FOR THE REST OF THE
 * SESSION: every keystroke after it, Enter included, went into a paste buffer
 * nobody would ever close.
 *
 * The input was not slow or confused. It was gone, and nothing typed could
 * bring it back.
 *
 * IT GETS MORE LIKELY AS THE PASTE GETS BIGGER, which is the opposite of what a
 * person would guess and the reason it read as "large pastes do not work".
 *
 * ------------------------------------------------------------------------
 * WHAT IS ASSERTED: every split point of both markers, driven through the REAL
 * reader with a fake stdin. Splitting a byte stream is the one thing a test can
 * do exhaustively and a terminal cannot be asked to do on demand.
 *
 * AND THE SECOND HALF OF THE REPORT — that a paste should appear as
 * `[pasted text #n]` rather than as a wall of the user's own text — is asserted
 * on the drawn surfaces at the end. That machinery was always right; it was
 * never reached, because the framing above never let the text through as a
 * paste in the first place.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { test } = require('../helpers');

const { Input } = require('../../src/input');
const paste = require('../../src/pastebuffer');
const views = require('../../src/ui/views');
const pasted = require('../../src/ui/pasted');
const feedcache = require('../../src/ui/feedcache');

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

/** The real reader over a stdin we can split however we like. */
function rig() {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setEncoding = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.setRawMode = () => {};
  const stdout = { isTTY: true, columns: 100, rows: 30, write: () => {} };
  const input = new Input({ stdin, stdout });
  input.start();
  const got = [];
  input.on('input', (e) => got.push(e));
  return { input, got, feed: (s) => stdin.emit('data', s) };
}

const BODY = `line one${NL}line two${NL}line three`;

/** Every way a string can be cut in two, including not at all. */
function splits(s) {
  const out = [];
  for (let i = 0; i <= s.length; i++) out.push([s.slice(0, i), s.slice(i)]);
  return out;
}

module.exports = async function () {
  await test('PASTE: the END marker split at EVERY byte still closes the paste', () => {
    // The regression, exhaustively. Six bytes, seven split points, and the old
    // reader survived exactly one of them.
    for (const [a, b] of splits(paste.PASTE_END)) {
      const r = rig();
      r.feed(paste.PASTE_START + BODY + a);
      if (b) r.feed(b);
      r.feed(CR);
      assert.strictEqual(r.got.length, 1,
        `split after ${a.length} byte(s) of the end marker: the input never came back`);
      assert.strictEqual(r.got[0].text, BODY);
      assert.strictEqual(r.got[0].isPaste, true);
    }
  });

  await test('PASTE: the START marker split at EVERY byte still opens the paste', () => {
    for (const [a, b] of splits(paste.PASTE_START)) {
      const r = rig();
      r.feed(a);
      r.feed(b + BODY + paste.PASTE_END);
      r.feed(CR);
      assert.strictEqual(r.got.length, 1, `split after ${a.length} byte(s) of the start marker`);
      assert.strictEqual(r.got[0].text, BODY);
      assert.strictEqual(r.got[0].isPaste, true);
    }
  });

  await test('PASTE: arriving one byte at a time is still ONE paste', () => {
    const r = rig();
    for (const ch of paste.PASTE_START + BODY + paste.PASTE_END) r.feed(ch);
    r.feed(CR);
    assert.strictEqual(r.got.length, 1);
    assert.strictEqual(r.got[0].text, BODY);
    assert.strictEqual(r.got[0].isPaste, true);
  });

  await test('PASTE: the keyboard still works AFTER a paste that split its marker', () => {
    // The part that made this so bad: not that one paste was lost, but that
    // everything typed afterwards was lost too.
    const r = rig();
    r.feed(paste.PASTE_START + BODY + '\x1b[201');
    r.feed('~');
    r.feed(CR);
    r.feed('hello');
    r.feed(CR);
    assert.strictEqual(r.got.length, 2, 'the line typed after the paste never arrived');
    assert.strictEqual(r.got[1].text, 'hello');
    assert.strictEqual(r.got[1].isPaste, false, 'and it is not mistaken for more paste');
  });

  await test('PASTE: text that merely LOOKS like half a marker is content, not a marker', () => {
    // `partialSuffix` holds a tail back only while it could still become the
    // marker. Content that resembles one and then does not must be released.
    const odd = `see \x1b[20 and \x1b[201 in the text`;
    const r = rig();
    r.feed(paste.PASTE_START + odd);
    r.feed(paste.PASTE_END);
    r.feed(CR);
    assert.strictEqual(r.got.length, 1);
    assert.strictEqual(r.got[0].text, odd, 'the lookalike bytes were eaten');
  });

  await test('PASTE: typing before a paste keeps what was typed', () => {
    const r = rig();
    r.feed('abc' + paste.PASTE_START + 'X' + paste.PASTE_END);
    r.feed(CR);
    assert.strictEqual(r.got[0].text, 'abcX');
  });

  await test('PASTE: a paste never submits by itself — only Enter does', () => {
    // Newlines inside a paste are content. This is the one thing a paste must
    // never do, and the split-marker fix must not have reopened it.
    const r = rig();
    r.feed(paste.PASTE_START + `do this${NL}/exit${NL}` + paste.PASTE_END);
    assert.strictEqual(r.got.length, 0, 'a paste containing newlines submitted itself');
    r.feed(CR);
    assert.strictEqual(r.got.length, 1);
    assert.match(r.got[0].text, /\/exit/);
  });

  // ---- WHAT THE SCREEN SHOWS ONCE THE TEXT ACTUALLY GETS THROUGH ---------

  await test('PASTE: the INPUT names it `[pasted text #n]`, with its size', () => {
    pasted.reset();
    const big = Array.from({ length: 40 }, (_, i) => `pasted line ${i + 1} with enough content to wrap`).join(NL);
    const row = strip(String(views.pasteSummary(big, 90, 3)));
    assert.match(row, /\[pasted text #\d+\]/, 'the input must name the paste the way the feed will');
    assert.match(row, /40 lines/);
    assert.ok(!row.includes(NL), 'and it is ONE row — the fix for "I cannot see what I pasted" must not eat the screen');
  });

  await test('PASTE: ACTIVITY shows the MARKER, never the wall of pasted text', () => {
    pasted.reset();
    feedcache.reset();
    const big = Array.from({ length: 40 }, (_, i) => `pasted line ${i + 1} with enough content to wrap`).join(NL);
    const rows = views.activity({
      session: { turns: [{ userInput: big, text: 'Read it.', narration: [{ step: 0, text: 'Read it.' }], actions: [] }] },
      width: 90,
    }).map(strip);
    assert.ok(rows.some((r) => /\[pasted text #\d+\]/.test(r)), 'the marker must be drawn');
    assert.ok(rows.some((r) => /USER REQUEST/.test(r)), 'and named as a request rather than a message');
    assert.strictEqual(rows.filter((r) => /pasted line \d+ with enough content/.test(r)).length, 0,
      'not one row of the raw paste may reach the feed');
  });
};
