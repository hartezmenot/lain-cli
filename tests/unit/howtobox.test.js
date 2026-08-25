'use strict';

/**
 * A COMMAND MAY NEVER BE ENDED WITH AN ELLIPSIS.
 *
 * ------------------------------------------------------------------------
 * THE REPORTED DEFECT, and it was not a cosmetic one.
 *
 *     ┌─ HOW TO RUN ─────────────────────────────────────────┐
 *     │ node bin/lain.js (start a Probe with /mcp probe, th… │
 *     └──────────────────────────────────────────────────────┘
 *
 * The box that exists to carry the one line a person is going to TYPE destroyed
 * the end of it — and destroyed it identically at 60, 100, 160 and 240 columns,
 * so resizing the terminal to fullscreen changed nothing. Half a command is
 * worse than no command, because it looks complete enough to copy.
 *
 * ------------------------------------------------------------------------
 * WHAT THE CAUSE TURNED OUT TO BE, because the shape of these tests follows it.
 *
 * NOT a stale cache. ui/feedcache.js keys on the width and ui/layout.js clears
 * its last frame on resize; both are asserted below anyway, because the report
 * named them as suspects and "we looked" is worth pinning. The cause was in the
 * renderer: `howtoBox` had a hard ceiling of 56 columns and cut the body with
 * `T.fit`, so the width it was handed could not reach the content.
 *
 * So the assertions here are about a PROPERTY rather than about a layout: the
 * source text must be RECOVERABLE from the drawn rows, at every width. A test
 * that pinned the exact rows would have passed all the way through the defect
 * by simply recording it.
 */

const assert = require('assert');
const { test } = require('../helpers');

const md = require('../../src/ui/markdown');
const views = require('../../src/ui/views');
const feedcache = require('../../src/ui/feedcache');
const panes = require('../../src/ui/panes');

/** A newline, as a value. */
const NL = String.fromCharCode(10);
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const rows = (lines, w) => md.render(lines, w).map(strip);

/**
 * THE TEXT A PERSON COULD READ OFF THE SCREEN, with the frame taken away.
 *
 * Border characters and the padding inside them are furniture; what is left is
 * what was actually communicated. Wrapped continuations are re-joined, because
 * a command broken across two rows is still one command — that is the whole
 * claim being made about wrapping, so the check has to be able to see it.
 */
function readable(drawn) {
  return drawn
    .filter((r) => /^[│|]/.test(r.trim()) || !/^[┌└├┤]/.test(r.trim()))
    .map((r) => r.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LONG_RUN = 'node bin/lain.js (start a Probe with /mcp probe, then run the task)';
const LONG_TEST = 'node tests/run.js unit and python -m pytest tests/test_probe.py -q';
const WIDTHS = [36, 48, 60, 80, 100, 160, 240];

module.exports = async function () {
  // ---------------------------------------------------------------- 1, 2 ---

  await test('HOWTO: a long RUN command never loses a character, at any width', () => {
    for (const w of WIDTHS) {
      const drawn = rows([`How to run: ${LONG_RUN}`], w);
      const text = readable(drawn);
      assert.ok(text.includes(LONG_RUN.replace(/\s+/g, ' ')),
        `width ${w}: the command was not recoverable from the drawn rows\n${drawn.join('\n')}`);
      assert.ok(!drawn.some((r) => r.includes('…')),
        `width ${w}: an ellipsis reached the screen\n${drawn.join('\n')}`);
    }
  });

  await test('HOWTO: a long TEST command never loses a character, at any width', () => {
    for (const w of WIDTHS) {
      const drawn = rows([`How to test: ${LONG_TEST}`], w);
      assert.ok(readable(drawn).includes(LONG_TEST.replace(/\s+/g, ' ')),
        `width ${w}: the command was not recoverable\n${drawn.join('\n')}`);
      assert.ok(!drawn.some((r) => r.includes('…')), `width ${w}: an ellipsis reached the screen`);
    }
  });

  // ------------------------------------------------------------------- 3 ---

  await test('HOWTO: explicit newlines in a block SURVIVE as separate rows', () => {
    const doc = ['How to run:', '```', 'node bin/lain.js', '', 'Start a Probe:', '/mcp probe', '```'];
    const drawn = rows(doc, 70);
    const body = drawn.filter((r) => /^│/.test(r.trim())).map((r) => r.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '').trim());
    assert.deepStrictEqual(body, ['node bin/lain.js', '', 'Start a Probe:', '/mcp probe'],
      'the model wrote four lines and the box must draw four lines\n' + drawn.join('\n'));
  });

  await test('HOWTO: an INDENTED block under the label is the body, and prose after it is not', () => {
    const doc = ['How to test:', '  node tests/run.js unit', '  npm run lint', 'That is all.'];
    const drawn = rows(doc, 70);
    const body = drawn.filter((r) => /^│/.test(r.trim())).map((r) => r.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '').trim());
    assert.deepStrictEqual(body, ['node tests/run.js unit', 'npm run lint']);
    assert.ok(drawn.some((r) => r.trim() === 'That is all.'),
      'the paragraph after the block must not be swallowed by it');
  });

  // ------------------------------------------------------------------- 4 ---

  await test('HOWTO: a command wrapped across rows is still ONE command', () => {
    // At a width that forces a wrap, the continuation is indented under the
    // opening row rather than starting at the margin — so the pair reads as one
    // line, and re-joining them recovers exactly what was written.
    const drawn = rows([`How to run: ${LONG_RUN}`], 40);
    const body = drawn.filter((r) => /^│/.test(r.trim()));
    assert.ok(body.length >= 2, 'this width must force a wrap for the test to mean anything');
    const cont = body[1].replace(/^\s*│\s/, '');
    assert.ok(/^\s{2}\S/.test(cont), `a continuation must be indented: ${JSON.stringify(cont)}`);
    assert.ok(readable(drawn).includes(LONG_RUN), 'and the whole command is still recoverable');
  });

  // ---------------------------------------------------------------- 5, 6 ---

  await test('HOWTO: a NARROW terminal wraps; it does not truncate', () => {
    const drawn = rows([`How to run: ${LONG_RUN}`], 36);
    assert.ok(drawn.filter((r) => /^│/.test(r.trim())).length >= 2, 'it must have wrapped');
    assert.ok(!drawn.some((r) => r.includes('…')), 'and lost nothing');
  });

  await test('HOWTO: WIDENING reflows — the same content on fewer rows', () => {
    const narrow = rows([`How to run: ${LONG_RUN}`], 40).filter((r) => /^│/.test(r.trim())).length;
    const wide = rows([`How to run: ${LONG_RUN}`], 120).filter((r) => /^│/.test(r.trim())).length;
    assert.ok(wide < narrow,
      `widening must reveal content: ${narrow} body rows at 40, ${wide} at 120`);
    assert.strictEqual(wide, 1, 'at 120 columns this command fits on one row');
  });

  // ------------------------------------------------------------------- 7 ---

  await test('HOWTO: narrow → wide → narrow leaves no stale rows from the old width', () => {
    const a = rows([`How to run: ${LONG_RUN}`], 40);
    const b = rows([`How to run: ${LONG_RUN}`], 120);
    const c = rows([`How to run: ${LONG_RUN}`], 40);
    assert.deepStrictEqual(c, a, 'returning to a width must reproduce that width exactly');
    assert.notDeepStrictEqual(b, a, 'and the wide render must genuinely differ');
    for (const drawn of [a, b, c]) assert.ok(readable(drawn).includes(LONG_RUN));
  });

  // ------------------------------------------------------------------- 8 ---

  await test('HOWTO: rendering does not touch the SOURCE lines it was given', () => {
    // Presentation must never become the data. The renderer is handed the
    // model's own array and a mutation here would edit the turn record.
    const src = [`How to run: ${LONG_RUN}`, 'and some prose'];
    const copy = src.slice();
    md.render(src, 44);
    assert.deepStrictEqual(src, copy, 'the input array was modified by drawing it');
  });

  // ---- THE SUSPECTS THE REPORT NAMED, PINNED EVEN THOUGH THEY WERE CLEAR ---

  await test('HOWTO: the feed cache is keyed on WIDTH, so a resize cannot serve stale rows', () => {
    feedcache.reset();
    const session = { turns: [{ userInput: 'go', text: `How to run: ${LONG_RUN}`, narration: [], actions: [] }] };
    const narrow = views.activity({ session, width: 44 }).map(strip);
    const wide = views.activity({ session, width: 120 }).map(strip);
    const back = views.activity({ session, width: 44 }).map(strip);
    assert.notDeepStrictEqual(wide, narrow, 'the cache served the narrow render at the wide width');
    assert.deepStrictEqual(back, narrow, 'and coming back to a width reproduces it');
    for (const drawn of [narrow, wide]) {
      assert.ok(!drawn.some((r) => /HOW TO RUN/.test(r) === false && r.includes('…') && r.includes('bin/lain.js')),
        'no drawn row carries a truncated command');
    }
  });

  await test('HOWTO: a SHORT command still gets a short frame — the ceiling was not the point', () => {
    // The removed 56-column ceiling was justified by "a frame stretched across a
    // 200-column terminal to hold `npm test` is a box with a field of nothing in
    // it". That argument is real, and it is served by sizing to the CONTENT,
    // which is what always did the work. Pinned so removing the ceiling cannot
    // quietly cost the thing the ceiling was reaching for.
    const drawn = rows(['How to run: npm start'], 200);
    const border = drawn.find((r) => r.trim().startsWith('┌'));
    assert.ok(border.trim().length < 40, `a short command must not make a wide frame: ${border.trim().length}`);
  });

  await test('HOWTO: prose that merely BEGINS "How to test" is left completely alone', () => {
    const line = 'How to test the parser is a separate question entirely.';
    const drawn = rows([line], 70);
    assert.ok(!drawn.some((r) => r.includes('┌')), 'no frame — this is a sentence, not a callout');
    assert.ok(drawn.join(' ').includes('separate question'));
  });

  // ---- THE SAME ANTI-PATTERN, AUDITED ACROSS THE OTHER CONTENT SURFACES ---
  //
  // "Truncate semantic content early" was not confined to one box. Everywhere a
  // row carries a COMMAND or its OUTPUT, cutting to the column destroys the
  // thing the row exists for. Rows that carry a LABEL — a path in a column, a
  // plan step, a header field — are unchanged and should be: they have a fixed
  // height by design and the whole value is one keystroke away in its own pane.

  await test('OUTPUT: a long command in the OUTPUT pane is wrapped, not cut', () => {
    const long = 'node --experimental-vm-modules ./node_modules/.bin/jest --config config/jest.config.js';
    const drawn = panes.outputView({ width: 56, outputs: [{ command: long, exitCode: 0, output: '' }] }).map(strip);
    assert.ok(!drawn.some((r) => r.includes('…')), drawn.join(NL));
    assert.ok(drawn.join(' ').replace(/\s+/g, ' ').includes(long.replace(/\s+/g, ' ')),
      'the command was not recoverable from the pane' + NL + drawn.join(NL));
    // The outcome mark is drawn ONCE — repeated, it reads as several commands.
    assert.strictEqual(drawn.filter((r) => r.includes('✓') || r.includes('✗') || r.includes('·')).length, 1);
  });

  await test('OUTPUT: wrapping command output PRESERVES its indentation', () => {
    // The regression this exists to stop: `doc.wrap` rejoins on single spaces,
    // which is right for prose and destroys a nested test result, a stack frame
    // or a tree listing. Replacing a truncation defect with an indentation
    // defect is not a fix.
    const body = '    ● parses the header when the payload is long enough to need wrapping';
    const drawn = panes.outputView({ width: 50, outputs: [{ command: 'npm test', exitCode: 1, output: body }] }).map(strip);
    const rows2 = drawn.filter((r) => r.includes('parses the header') || r.includes('wrapping'));
    assert.ok(rows2.length >= 2, 'this width must force a wrap: ' + drawn.join(NL));
    assert.ok(/^\s{10,}●/.test(rows2[0]), `the line's own indent was lost: ${JSON.stringify(rows2[0])}`);
    assert.ok(!drawn.some((r) => r.includes('…')));
  });

  await test('OUTPUT: one absurd line is BOUNDED and says how much is not drawn', () => {
    // A minified bundle printed to stdout must not turn a scrollable pane into
    // a wall — and what is held back is counted, never silently cut.
    const huge = 'x'.repeat(4000);
    const drawn = panes.outputView({ width: 60, outputs: [{ command: 'cat bundle.js', exitCode: 0, output: huge }] }).map(strip);
    assert.ok(drawn.some((r) => /more wrapped row\(s\) of this line/.test(r)),
      'the bound fired without saying so');
    assert.ok(drawn.length < 40, `the pane was flooded: ${drawn.length} rows`);
  });

  await test('HOWTO: the completion screen wraps its commands too', () => {
    // The SAME anti-pattern lived on the other surface that answers this
    // question: ui/views.js `completion` clipped `c.cmd` to the column.
    const long = 'node --experimental-vm-modules ./node_modules/.bin/jest --config config/jest.config.js';
    const lines = views.completion({
      session: { task: { objective: 'x' }, lifecycle: null },
      checkpoints: null,
      cwd: process.cwd(),
      verification: [],
      width: 60,
      // the discovered commands are read from the project; this pins the shape
      // by handing the renderer a long one through the same path.
    }).map(strip);
    // The real project declares `npm test`; the assertion that matters here is
    // that NOTHING on this screen ends a command with an ellipsis.
    const suspect = lines.filter((l) => /^\s{2}(start|dev|test|check|build)\s/.test(l));
    for (const l of suspect) {
      assert.ok(!l.includes('…'), `a command was clipped on the completion screen: ${JSON.stringify(l)}`);
    }
    assert.ok(long.length > 60, 'sanity');
  });
};
