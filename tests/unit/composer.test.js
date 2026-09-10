'use strict';

/**
 * THE COMPOSER PROJECTION — and the boundary it must never cross.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS FILE REPLACES.
 *
 * `tests/unit/pasted.test.js` and half of `tests/unit/paste-summary.test.js`
 * asserted the OPPOSITE arrangement: a paste was collapsed to
 * `[pasted text #1]` in the CONVERSATION, and the input box drew the whole
 * payload with a summary row underneath describing it.
 *
 * That put the collapse in the wrong place, and the two halves of the mistake
 * compound. The transcript is the record — what a person reads back, reviews,
 * scrolls, exports and hands over — and the one thing they need after sending
 * ten thousand characters is to see that the right ten thousand characters
 * went. Meanwhile the composer, which is where a wall of text genuinely
 * destroys something, drew the wall.
 *
 * So the collapse moved to the composer and the record shows the record. What
 * carried over from those files is the part that was always right: the
 * THRESHOLD (a URL is not an attachment) and, above everything else, the
 * INVARIANT — the projection must never touch the payload.
 *
 * ------------------------------------------------------------------------
 * THE MUTATION TEST IS THE POINT OF THIS FILE.
 *
 * The obvious way to implement "show a placeholder instead of the paste" is to
 * put the placeholder IN THE BUFFER. It looks identical on screen and it is a
 * data-loss bug: the model receives `<pasted text>`, the transcript records a
 * marker where the content was, and nobody finds out until they read back a
 * session and the evidence is gone.
 *
 * `PASTE: the projection is not destructive` freezes the inputs and asserts
 * them byte-for-byte afterwards, at every level from the pure function up to a
 * real Screen draw.
 */

const assert = require('assert');
const { test } = require('../helpers');

const composer = require('../../src/ui/composer');
const pasted = require('../../src/ui/pasted');

/** A newline, as a value. */
const NL = String.fromCharCode(10);

/** A believable paste: bulky and structured, past both thresholds. */
const bigPaste = (tag = 'A') => Array.from({ length: 40 },
  (_, i) => `${tag} line ${i} of a stack trace that goes on and on and on`).join(NL);

const PH = composer.PLACEHOLDER;

module.exports = async function () {
  // ============================================== WHAT COUNTS AS A PASTE ====

  await test('PASTE: the threshold is bulk AND structure, or bulk far past typing', () => {
    assert.ok(pasted.isPaste(bigPaste()), 'forty structured lines is an attachment');
    // A LONG SINGLE LINE IS STILL AN ATTACHMENT — the wall of text that arrives
    // through a terminal that did not bracket the paste, or a source that had
    // no newlines. Bulk alone decides only when the bulk is far past anything
    // a person types into a prompt.
    assert.ok(pasted.isPaste('x'.repeat(pasted.MAX_TYPED + 1)));
    assert.ok(!pasted.isPaste('x'.repeat(300)), 'a long sentence is prose');
  });

  await test('PASTE: an ordinary paste is NOT collapsed', () => {
    // §11: the goal is to stop a huge block destroying the composer, not to
    // hide every paste. A command, a URL, a filename, a sentence — all of these
    // behave exactly like typing.
    for (const small of [
      'npm test',
      'https://example.com/a/very/long/path/that/goes/on?query=1&more=2',
      'src/ui/composer.js',
      'the dashboard has been stale since Aug 14',
      `line one${NL}line two${NL}line three`,
    ]) {
      const p = composer.project(`look at ${small}`, [small]);
      assert.strictEqual(p.text, `look at ${small}`, `collapsed something small: ${small}`);
      assert.deepStrictEqual(p.spans, []);
    }
  });

  // ================================================== WHAT IS DRAWN =========

  await test('PASTE: a big paste is drawn as one marker, in position', () => {
    const body = bigPaste();
    const buf = `fix this bug ${body} and focus on the router`;
    const p = composer.project(buf, [body]);
    assert.strictEqual(p.text, `fix this bug ${PH} and focus on the router`);
    assert.strictEqual(p.spans.length, 1);
    // The canonical wording, at the user's instruction — not `[pasted text #1]`,
    // not `Pasted #1`, not `attachment 2`.
    assert.strictEqual(PH, '<pasted text>');
  });

  await test('PASTE: mixed typed and pasted content keeps its exact order', () => {
    const body = bigPaste();
    const buf = `please inspect this:${NL}${NL}${body}${NL}${NL}and focus on the router`;
    const p = composer.project(buf, [body]);
    assert.strictEqual(p.text, `please inspect this:${NL}${NL}${PH}${NL}${NL}and focus on the router`);
    // The paste is where it was put. It is not moved to the bottom, not
    // hoisted to the top, and the words around it are untouched.
    assert.ok(p.text.indexOf('please inspect') < p.text.indexOf(PH));
    assert.ok(p.text.indexOf(PH) < p.text.indexOf('and focus on the router'));
  });

  await test('PASTE: several pastes each get a marker, in submitted order', () => {
    const a = bigPaste('A');
    const b = bigPaste('B');
    const buf = `compare:${NL}${a}${NL}with:${NL}${b}${NL}please`;
    const p = composer.project(buf, [a, b]);
    assert.strictEqual(p.text, `compare:${NL}${PH}${NL}with:${NL}${PH}${NL}please`);
    assert.strictEqual(p.spans.length, 2);
    assert.ok(p.spans[0].from < p.spans[1].from, 'and the spans are in position order');
  });

  await test('PASTE: two IDENTICAL pastes are two markers, not one', () => {
    // Both occurrences must be found: the second search starts after the first
    // claim rather than matching the same bytes twice.
    const body = bigPaste();
    const buf = `${body}${NL}---${NL}${body}`;
    const p = composer.project(buf, [body, body]);
    assert.strictEqual(p.text, `${PH}${NL}---${NL}${PH}`);
    assert.strictEqual(p.spans.length, 2);
  });

  await test('PASTE: editing INSIDE a block un-collapses it, honestly', () => {
    // The spans are found by SEARCHING for the payload, so a block that has
    // been edited no longer matches and renders in full — which is what
    // somebody who has started editing it wants. There is no offset table to
    // fall out of step and no way for a marker to cover the wrong bytes.
    const body = bigPaste();
    const edited = body.replace('line 7', 'line SEVEN');
    const p = composer.project(`fix ${edited}`, [body]);
    assert.strictEqual(p.text, `fix ${edited}`);
    assert.deepStrictEqual(p.spans, []);
  });

  await test('PASTE: the size of what is hidden is stated', () => {
    const body = bigPaste();
    const one = composer.hidden(composer.project(body, [body]).spans, body);
    assert.match(one, /\d/, `the size must be a number: ${one}`);
    const two = composer.project(`${body}${NL}x${NL}${bigPaste('B')}`, [body, bigPaste('B')]);
    assert.match(composer.hidden(two.spans, `${body}${NL}x${NL}${bigPaste('B')}`), /2 blocks/);
    assert.strictEqual(composer.hidden([], 'anything'), '', 'nothing hidden, nothing said');
  });

  // ================================================== THE CARET =============

  await test('PASTE: the caret maps both ways, and round-trips', () => {
    const body = bigPaste();
    const buf = `fix this ${body} now`;
    const p = composer.project(buf, [body]);
    // Before the block: unchanged.
    assert.strictEqual(p.toProjected(4), 4);
    assert.strictEqual(p.toBuffer(4), 4);
    // After it: shifted by exactly what the collapse removed.
    const end = buf.length;
    assert.strictEqual(p.toProjected(end), p.text.length);
    assert.strictEqual(p.toBuffer(p.text.length), end);
    // INSIDE the block, the caret parks at the END of the placeholder: the
    // block is one object to the composer, and pointing at the middle of the
    // word "pasted" would be pointing at a character the user never typed.
    assert.strictEqual(p.toProjected(buf.indexOf('line 7')), p.spans[0].pTo);
    // A CLICK inside the placeholder lands at the START of the real block, so
    // the caret ends up immediately before the pasted content.
    assert.strictEqual(p.toBuffer(p.spans[0].pFrom + 3), p.spans[0].from);
  });

  await test('PASTE: with nothing collapsed the maps are the identity', () => {
    const p = composer.project('just a prompt', []);
    for (let i = 0; i <= 'just a prompt'.length; i++) {
      assert.strictEqual(p.toProjected(i), i);
      assert.strictEqual(p.toBuffer(i), i);
    }
  });

  // ============================== THE INVARIANT — READ THE HEADER ==========

  await test('PASTE: the projection is NOT destructive, at every level', () => {
    // ------------------------------------------------------------------
    // MUTATION TEST. Every input is frozen and compared byte-for-byte after
    // the fact. A destructive implementation — the obvious one — would put the
    // placeholder in the buffer, look identical on screen, and send
    // `<pasted text>` to the model.
    // ------------------------------------------------------------------
    const body = bigPaste();
    const buf = `fix this ${body} now`;
    const pastes = Object.freeze([body]);

    // 1. The pure function.
    const p = composer.project(buf, pastes);
    assert.strictEqual(buf, `fix this ${body} now`, 'the buffer was rewritten');
    assert.strictEqual(pastes[0], body, 'the record was rewritten');
    assert.notStrictEqual(p.text, buf, 'and it did project something, so this is not vacuous');

    // 2. Through a real Screen draw, at a real geometry.
    const { Screen } = require('../../src/ui/layout');
    const screen = new Screen({
      out: { columns: 90, rows: 26, isTTY: true, write() {}, on() {}, removeListener() {} },
    });
    screen.active = true;
    screen.inputText = buf;
    screen.inputPastes = [body];
    screen.inputCursorAt = buf.length;
    screen.state = {
      cwd: process.cwd(), session: { cwd: process.cwd(), task: null, turns: [] },
      transcript: [], liveActions: [], liveNarration: [], extras: [], llm: { phase: null },
    };
    screen.draw();
    assert.strictEqual(screen.inputText, `fix this ${body} now`,
      'DRAWING the input rewrote the buffer — this is the data-loss bug');
    assert.strictEqual(screen.inputPastes[0], body, 'and it rewrote the paste record');

    // 3. The region really did collapse — otherwise 1 and 2 prove nothing.
    const rows = require('../../src/ui/inputbox').wrapped(screen).length;
    assert.ok(rows <= 2, `the composer must be one or two rows, not ${rows}`);
  });

  await test('PASTE: a REAL bracketed paste is recorded, typed text around it is not', () => {
    // ------------------------------------------------------------------
    // THE PATH REAL PASTES TAKE, AND THE ONE THIS ALMOST MISSED.
    //
    // `Input.insertText` records a paste, and that covers a Ctrl+V arriving as
    // a key. A bracketed paste from the terminal does NOT go through it: it
    // lands in src/pastebuffer.js, which writes `line` directly because it also
    // has to own the single undo step and the selection it replaces. A record
    // kept only in `insertText` would therefore have missed every paste that
    // came from actually pasting — which is all of them.
    // ------------------------------------------------------------------
    const { EventEmitter } = require('events');
    const { Input } = require('../../src/input');
    const stdin = new EventEmitter();
    stdin.isTTY = true;
    stdin.setRawMode = () => {}; stdin.resume = () => {}; stdin.pause = () => {}; stdin.setEncoding = () => {};
    const input = new Input({ stdin, stdout: { write() {} } });
    input.echo = false;
    input.start();
    const body = bigPaste();
    const type = (s) => stdin.emit('data', Buffer.from(s, 'utf8'));
    type('please inspect this: ');
    type(`\x1b[200~${body}\x1b[201~`);
    type(' and focus on the router');

    assert.strictEqual(input.pastesInLine.length, 1, 'the payload was recorded, once');
    assert.strictEqual(input.line, `please inspect this: ${body} and focus on the router`,
      'and the buffer holds the whole of what will be sent');
    const p = composer.project(input.line, input.pastesInLine);
    assert.strictEqual(p.text, `please inspect this: ${PH} and focus on the router`,
      'so the composer can collapse it, in position, with the typed words untouched');

    // A NEW LINE FORGETS THE OLD RECORD. Otherwise a payload from a previous
    // prompt could match text in a later one and collapse something nobody
    // pasted.
    input.setLine('');
    assert.strictEqual(input.pastesInLine.length, 0);
  });

  await test('PASTE: the reader never lets the record reach what is submitted', () => {
    // The record lives on the READER, beside the line — and the line is the
    // whole of what `_emitInput` sends. Asserted structurally because it is
    // the boundary a future change is most likely to blur.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'input.js'), 'utf8');
    // The METHOD, not the first mention of its name — the call sites clear
    // the record, which is the opposite of reading it.
    const at = src.indexOf('  _emitInput(text, isPaste) {');
    assert.ok(at > 0, 'the reader must still have one submit path');
    const body = src.slice(at, src.indexOf(NL + '  }', at));
    assert.ok(!/pastesInLine/.test(body),
      '_emitInput must not read the paste record — it sends `this.line`');
    assert.ok(!/composer/.test(body), 'nor reach the projection');
    assert.ok(/text/.test(body), 'and it does send the text it was handed');
  });

  await test('PASTE: the CONVERSATION shows the full payload, never a marker', () => {
    // The other half of the move, and the reason for it: a transcript that
    // cannot be read back is a transcript nobody can trust.
    const feed = require('../../src/ui/feed');
    const body = bigPaste();
    const out = [];
    feed.pushUser(out, body);
    const drawn = out.map((r) => String(r.text)).join(NL);
    assert.ok(!/pasted text/.test(drawn), `the record must not be collapsed: ${drawn.slice(0, 200)}`);
    assert.ok(drawn.includes('A line 0'), 'the first line of the payload');
    assert.ok(drawn.includes('A line 39'), 'and the last');
    // The whole message still travels on every row, as it always did.
    assert.strictEqual(out[0].source, body);
  });

  await test('PASTE: it is total — null, undefined and nonsense do not throw', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      assert.doesNotThrow(() => composer.project(bad, bad));
      assert.doesNotThrow(() => composer.spans(bad, bad));
      assert.doesNotThrow(() => composer.hidden(bad, bad));
    }
    assert.strictEqual(composer.project(null, null).text, '');
  });

  // ============================== NAVIGATION IS UNAFFECTED =================

  await test('PASTE: a 1,200-line paste is still editable line by line', () => {
    // Carried over from paste-summary.test.js: the projection is a statement
    // ABOUT the buffer, and the buffer's own navigation is untouched.
    const { inputViewport } = require('../../src/ui/viewport');
    const body = Array.from({ length: 1200 }, (_, i) => `row ${i}`).join(NL);
    const vp = inputViewport(body, body.length - 1, 60);
    assert.strictEqual(vp.lines, 1200);
    assert.strictEqual(vp.line, 1199, 'the caret must be on the last line, not line 0');
    assert.match(vp.text, /row 1199/);
  });
};
