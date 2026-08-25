'use strict';

/**
 * STRUCTURED TEXT MUST NOT COLLAPSE INTO A WALL — asserted on the DRAWN FEED.
 *
 * ------------------------------------------------------------------------
 * WHY THIS TESTS THE FEED AND NOT THE MARKDOWN RENDERER.
 *
 * The renderer was never the thing that failed. A unit test of `md.render`
 * would have been green throughout the entire period the screen looked like
 * this, because the question is not "can it draw a list" — it is "does a list
 * the model wrote still have five rows by the time it reaches the pane". That
 * answer lives in the whole path: an entry per line, a run gathered, `looksMarked`
 * consulted, a width chosen, colour applied after wrapping.
 *
 * So every assertion below goes through `views.activity` — the same function
 * ui/panesource.js calls to fill the ACTIVITY pane — and reads the rows that
 * come out of it. Nothing here mocks the renderer.
 *
 * COLOUR IS STRIPPED BEFORE ASSERTING. The structure has to survive monochrome:
 * a terminal with NO_COLOR, a captured log, a pipe. If a distinction only
 * exists as a colour, it does not exist for everybody.
 */

const assert = require('assert');
const { test } = require('../helpers');

const views = require('../../src/ui/views');
const feedcache = require('../../src/ui/feedcache');

/** A newline, as a value — this file avoids literal escapes in its strings. */
const NL = String.fromCharCode(10);
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

/** The drawn ACTIVITY rows for one model answer, colour removed. */
function rows(text, width = 96) {
  feedcache.reset();
  const session = {
    turns: [{ userInput: 'explain it', text, narration: [{ step: 0, text }], actions: [] }],
  };
  return views.activity({ session, width }).map(strip);
}

/** The row index of the first row whose trimmed text is exactly `s`. */
const at = (list, s) => list.findIndex((r) => r.trim() === s);

module.exports = async function () {
  await test('STRUCTURE: LIVE prose breathes exactly as RECORDED prose does', () => {
    // ---- THE ASYMMETRY, AND WHY IT LOOKED INTERMITTENT -------------------
    //
    // `turnevents.flushParagraphs` splits streamed prose on a blank line and
    // trims both halves, so the separator is consumed by the split itself.
    // both halves, so each paragraph of one answer arrives as a SEPARATE
    // narration entry with the blank line that separated them consumed by the
    // split. ui/feed.js `pushModel` knows that and puts the row back.
    //
    // The LIVE path did not go through `pushModel`. It called `pushLines`
    // directly, which trims its own leading and trailing blanks — so prose was
    // drawn as one slab WHILE IT STREAMED and separated correctly the moment
    // the turn ended and the recorded path drew it instead.
    //
    // Which is to say it was glued together exactly while somebody was reading
    // it, and fixed itself once they had stopped. Every earlier test rendered
    // the recorded path and passed, which is why this asserts on BOTH and
    // compares them.
    const live = [
      { after: 0, at: 1, text: 'The loader is registered twice.' },
      { after: 0, at: 1, text: 'That happens because both call register().' },
    ];
    feedcache.reset();
    const liveRows = views.activity({
      session: { turns: [] }, width: 96, liveNarration: live, liveActions: [],
    }).map(strip).map((r) => r.trim());

    feedcache.reset();
    const recordedRows = views.activity({
      session: {
        turns: [{
          userInput: 'why?',
          text: 'x',
          narration: live.map((n, i) => ({ step: i, text: n.text })),
          actions: [],
        }],
      },
      width: 96,
    }).map(strip).map((r) => r.trim());

    const gapBetween = (rows) => {
      const a = rows.findIndex((r) => r.includes('registered twice'));
      const b = rows.findIndex((r) => r.includes('both call register'));
      assert.ok(a >= 0 && b > a, `both paragraphs must be drawn: ${JSON.stringify(rows)}`);
      return rows.slice(a + 1, b).some((r) => r === '');
    };

    assert.ok(gapBetween(recordedRows), 'recorded prose must breathe');
    assert.ok(gapBetween(liveRows),
      'LIVE prose must breathe too — it is the half a person is actually reading');
  });


  await test('STRUCTURE: a numbered list stays FIVE readable rows, not one sentence', () => {
    // ---- THE REPORTED FAILURE, in its smallest form ----------------------
    //
    //     1. Inspect the implementation. 2. Locate the dependency. 3. Repro…
    //
    // The items are still all there, and the list has stopped being a list.
    const text = [
      'Here is what to do:',
      '',
      '1. Inspect the implementation.',
      '2. Locate the dependency.',
      '3. Reproduce the failure.',
      '4. Patch the implementation.',
      '5. Verify the result.',
    ].join(NL);
    const out = rows(text);
    for (let n = 1; n <= 5; n++) {
      const found = out.filter((r) => r.trim().startsWith(`${n}.`));
      assert.strictEqual(found.length, 1, `item ${n} is on a row of its own:${NL}${out.join(NL)}`);
    }
    // AND THEY ARE CONSECUTIVE ROWS, which is what makes them scannable. A
    // list whose items are correct but scattered is not a list either.
    const first = out.findIndex((r) => r.trim().startsWith('1.'));
    for (let n = 1; n <= 5; n++) {
      assert.ok(out[first + n - 1].trim().startsWith(`${n}.`),
        `the items run in order down the rows:${NL}${out.join(NL)}`);
    }
  });

  await test('STRUCTURE: bullets stay bullets, one per row', () => {
    const text = [
      'The situation:',
      '',
      '- Frontend route exists',
      '- Backend handler exists',
      '- Runtime wiring is missing',
      '- Verification currently fails',
    ].join(NL);
    const out = rows(text);
    const bullets = out.filter((r) => /^\s*[•\-*]\s+\S/.test(r));
    assert.strictEqual(bullets.length, 4, `four bullets, four rows:${NL}${out.join(NL)}`);
    assert.ok(bullets.every((b) => !/exists.*missing/.test(b)),
      'and no row carries two of them run together');
  });

  await test('STRUCTURE: paragraph boundaries survive as blank rows', () => {
    // "COMPACT BUT CALM": one blank row between paragraphs, never two, never
    // none. None is the wall; two is a page of gaps.
    const text = [
      'The implementation exists, but the route is not wired.',
      '',
      'I verified the runtime path and found the missing dispatch.',
      '',
      'The targeted test now passes.',
    ].join(NL);
    const out = rows(text);
    const a = at(out, 'The implementation exists, but the route is not wired.');
    const b = at(out, 'I verified the runtime path and found the missing dispatch.');
    const c = at(out, 'The targeted test now passes.');
    assert.ok(a >= 0 && b >= 0 && c >= 0, `all three paragraphs are drawn:${NL}${out.join(NL)}`);
    assert.strictEqual(b - a, 2, 'exactly one blank row between the first two');
    assert.strictEqual(c - b, 2, 'and between the next two');
  });

  await test('STRUCTURE: a heading is separated from the prose under it', () => {
    const text = ['## What I found', '', 'The route is not wired.'].join(NL);
    const out = rows(text);
    const h = at(out, 'What I found');
    assert.ok(h >= 0, `the heading is drawn without its hashes:${NL}${out.join(NL)}`);
    assert.strictEqual(out[h + 1].trim(), '', 'with a blank row under it');
    assert.strictEqual(out[h + 2].trim(), 'The route is not wired.');
  });

  await test('STRUCTURE: a code block keeps its own shape and its own gutter', () => {
    const text = [
      'The dispatcher:',
      '',
      '```js',
      'function run(argv) {',
      '  return dispatch(argv);',
      '}',
      '```',
    ].join(NL);
    const out = rows(text);
    assert.ok(!out.some((r) => r.includes('```')), 'the fence is a instruction, not content');
    const body = out.filter((r) => r.includes('▏'));
    assert.ok(body.some((r) => r.includes('function run(argv) {')), 'the code is drawn');
    assert.ok(body.some((r) => /▏\s{3}return dispatch/.test(r)),
      `and its indentation is its meaning:${NL}${out.join(NL)}`);
  });

  await test('STRUCTURE: HOW TO RUN and HOW TO TEST are framed, and survive monochrome', () => {
    // ---- IT WAS A COLOURED SURFACE, AND COLOUR IS NOT ALWAYS THERE -------
    //
    // On NO_COLOR, in a pipe, in a captured log, the two most-wanted lines of a
    // summary went back to looking like the eight around them — which is the
    // exact failure the callout exists to prevent. A frame is structural.
    const text = ['Done.', '', 'How to run: npm start', 'How to test: npm test'].join(NL);
    const out = rows(text);
    const joined = out.join(NL);
    assert.match(joined, /┌─ HOW TO RUN ─+┐/, `a labelled frame:${NL}${joined}`);
    assert.match(joined, /┌─ HOW TO TEST ─+┐/);
    assert.ok(out.some((r) => /│ npm start\s*│/.test(r)), 'with the command inside it');
    assert.ok(out.some((r) => /│ npm test\s*│/.test(r)));
  });

  await test('STRUCTURE: the callout never stretches across a wide terminal', () => {
    // A frame drawn 200 columns wide to hold `npm test` is a box with a field
    // of nothing in it.
    const out = rows(['How to run: npm start'].join(NL), 200);
    const top = out.find((r) => r.includes('┌─ HOW TO RUN'));
    assert.ok(top, 'the callout is drawn');
    assert.ok(top.trim().length <= 60, `and it is bounded: ${top.trim().length} columns`);
  });

  await test('STRUCTURE: a plain answer with no markup is not touched by any of this', () => {
    // The common case must pay nothing. One paragraph in, one paragraph out.
    const text = 'The provider rejected the request.';
    const out = rows(text).filter((r) => r.trim());
    assert.ok(out.includes('  ' + text) || out.some((r) => r.trim() === text),
      `plain prose is drawn as itself:${NL}${out.join(NL)}`);
    assert.ok(!out.some((r) => r.includes('┌') || r.includes('▏')),
      'with no decoration invented for it');
  });

  await test('STRUCTURE: it all still holds together in ONE answer', () => {
    // The acceptance case from the brief: a heading, prose, a numbered list,
    // bullets, code and the two commands, in one message, at one width.
    const text = [
      '## What I found',
      '',
      'The implementation exists, but the route is not wired.',
      '',
      'There are three separate problems:',
      '',
      '1. The flag parses but is never read.',
      '2. The handler is registered twice.',
      '3. The dispatch call is missing.',
      '',
      'And the following are true:',
      '',
      '- Frontend route exists',
      '- Backend handler exists',
      '- Runtime wiring is missing',
      '',
      '```js',
      'function run(argv) {',
      '  return dispatch(argv);',
      '}',
      '```',
      '',
      'How to run: npm start',
      'How to test: npm test',
    ].join(NL);
    const out = rows(text);
    const joined = out.join(NL);
    assert.strictEqual(out.filter((r) => /^\s*\d\.\s/.test(r)).length, 3, 'three numbered rows');
    assert.strictEqual(out.filter((r) => /^\s*•\s/.test(r)).length, 3, 'three bullet rows');
    assert.match(joined, /┌─ HOW TO RUN/);
    assert.match(joined, /┌─ HOW TO TEST/);
    // AND NO ROW IS A WALL. The failure being guarded against is one row
    // carrying what should have been several, so the shape of the defect is
    // measurable: a drawn row wider than the pane it was drawn for.
    for (const r of out) {
      assert.ok(strip(r).length <= 96, `no row overflows its pane: ${r.length}`);
    }
  });
};
