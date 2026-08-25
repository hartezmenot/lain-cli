'use strict';

/**
 * AN ANSWER THAT OPENS BY REPEATING THE QUESTION.
 *
 * Measured against a live model through the real binary:
 *
 *     $ lain -p "Reply with exactly: PROVIDER OK"
 *     The user wants a reply containing exactly "PROVIDER OK". PROVIDER OK
 *
 * The first clause carries nothing — the person wrote the request a moment ago
 * and can see it on the same screen — and it costs the answer its first line.
 *
 * THE PROMPT ALONE DID NOT FIX IT. The instruction sits in the opening
 * paragraph of the system prompt; the same model produced the same restatement
 * with it in place. A screen that is only correct when the model cooperates is
 * not correct, so the prompt asks and the renderer makes it true.
 *
 * What is asserted here is mostly the RESTRAINT: this edits a model's words, so
 * the cases it must NOT touch matter more than the ones it must.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { trimRestatement } = require('../../src/ui/phrasing');
const feed = require('../../src/ui/feed');

module.exports = async function () {
  await test('RESTATE: the stock openers are dropped and the answer promoted', () => {
    assert.strictEqual(
      trimRestatement('The user wants a reply containing exactly "PROVIDER OK". PROVIDER OK'),
      'PROVIDER OK');
    assert.strictEqual(
      trimRestatement('What you are asking for is a parser. I will write one.'),
      'I will write one.');
    assert.strictEqual(
      trimRestatement('I understand that you want tests. Running them now.'),
      'Running them now.');
    assert.strictEqual(
      trimRestatement('The user is asking me to fix the loader. Tracing it now.'),
      'Tracing it now.');
  });

  await test('RESTATE: ANALYSIS that starts the same way is untouched', () => {
    // "The user wants X but the code does Y" is the most useful sentence in a
    // bug report. It must survive, and it is why the match stops at a sentence
    // end rather than at a comma.
    for (const keep of [
      'The user wants X but the code does Y, so I fixed Y.',
      'The user wants two behaviours here and they contradict each other.',
      'What you are asking for conflicts with the retry logic in loader.js.',
    ]) {
      assert.strictEqual(trimRestatement(keep), keep, `this is analysis: ${keep}`);
    }
  });

  await test('RESTATE: a restatement with NOTHING after it is kept', () => {
    // Removing it would leave a blank answer, which is worse than a redundant
    // one — the screen would show that the model said nothing at all.
    for (const only of [
      'The user wants a reply.',
      'I understand that you want the tests run.',
    ]) {
      assert.strictEqual(trimRestatement(only), only);
    }
  });

  await test('RESTATE: ordinary prose is never touched', () => {
    for (const keep of [
      'I traced the parser first.',
      'The loader reads the JSON but never saves it.',
      'Done — the suite passes.',
      'user wants and needs are different things in this API.',
      '',
    ]) {
      assert.strictEqual(trimRestatement(keep), keep, JSON.stringify(keep));
    }
  });

  await test('RESTATE: only the OPENING is considered', () => {
    // A restatement in the middle is being used to make a point.
    const mid = 'I read the loader. The user wants a JSON reader, and that is what this is not.';
    assert.strictEqual(trimRestatement(mid), mid);
  });

  await test('RESTATE: it is total — null and undefined do not throw', () => {
    for (const v of [null, undefined, 0, false]) {
      assert.strictEqual(typeof trimRestatement(v), 'string');
    }
  });

  await test('RESTATE: it reaches the FEED, not just the helper', () => {
    // The wire: what the activity pane actually draws for a model message.
    const out = [];
    feed.pushModel(out, 'The user wants the parser traced. Tracing it now.');
    const drawn = out.map((r) => r.text).join('\n');
    assert.strictEqual(drawn, 'Tracing it now.');
    assert.ok(!/The user wants/.test(drawn), 'the restatement reached the screen');
  });

  await test('RESTATE: the model\'s own record is NOT rewritten', () => {
    // Presentation only. The session, the wire and /copy must still carry what
    // the model actually said — this changes what is drawn and nothing else.
    const said = 'The user wants the parser traced. Tracing it now.';
    const out = [];
    feed.pushModel(out, said);
    assert.strictEqual(said, 'The user wants the parser traced. Tracing it now.',
      'trimming must not mutate its input');
  });
};
