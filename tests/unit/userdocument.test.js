'use strict';

/**
 * A LONG STRUCTURED PROMPT MUST NOT ARRIVE AS A WALL OF TEXT.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, AS IT LOOKED ON THE SCREEN:
 *
 *     ❯ ============================================================ 0.
 *       ABSOLUTE PROJECT BOUNDARY ============================================
 *       DO NOT modify LAIN. DO NOT work inside the LAIN repository. - easy
 *       provider management - Import Models - automatic model discovery 1.
 *       Inspect provider 2. Test connection
 *
 * Two separate causes, and both had to be fixed:
 *
 *   THE USER BRANCH NEVER USED THE RENDERER. `ui/feed.js` sent a model answer
 *     through ui/markdown.js and a user message through `wrap`, the prose
 *     wrapper. Everything structural was reflowed away.
 *   `=` WAS NOT MARKUP TO ANYTHING. Not FENCE, not RULE (`-`/`*`/`_`), not
 *     HEADING — so a separator, the section title under it and the paragraph
 *     after it were three ordinary prose lines and got joined together.
 *
 * ------------------------------------------------------------------------
 * DRIVEN THROUGH `renderFeed`, NOT THROUGH THE PARSER.
 *
 * The brief is explicit: "do not merely unit-test the markdown parser
 * directly". Testing `markdown.render` would have passed the whole time the
 * product was broken, because the parser was never the thing at fault — the
 * user path simply did not call it. So every assertion here goes through the
 * same entry point a submitted prompt does.
 */

const assert = require('assert');
const { test } = require('../helpers');

const feed = require('../../src/ui/feed');
const T = require('../../src/ui/text');

/** A realistic brief: every structure the blueprint names, in one document. */
const PROMPT = [
  '# LAIN ROUTER',
  '',
  '## A transparent multi-provider router',
  '',
  '============================================================',
  '0. ABSOLUTE PROJECT BOUNDARY',
  '============================================================',
  '',
  'DO NOT modify LAIN. Create a completely separate project. This paragraph is',
  'deliberately long enough that it must wrap at any sensible terminal width,',
  'so that wrapping and structure can be told apart in the assertions below.',
  '',
  'SECTION UNDERLINED',
  '==================',
  '',
  '- easy provider management',
  '- Import Models',
  '  - nested discovery',
  '- automatic model discovery',
  '',
  '1. Inspect provider',
  '2. Test connection',
  '3. Import models',
  '',
  '> a quoted constraint',
  '',
  'NOTE',
  '  the router must not own the conversation',
  '',
  '```js',
  '  const x = 1;',
  '      deeply.indented(x);',
  '```',
  '',
  'Trailing prose with `inline code` and **bold** in it.',
].join('\n');

/** Render exactly as a submitted user message, and strip paint for assertions. */
function renderUser(text, width) {
  return feed.renderFeed([{ kind: 'user', text }], width).map((r) => T.strip(r).replace(/\s+$/, ''));
}

module.exports = async function () {
  await test('USERDOC: the separator-delimited section becomes a heading with a rule', () => {
    const rows = renderUser(PROMPT, 100);
    const at = rows.findIndex((r) => /0\. ABSOLUTE PROJECT BOUNDARY/.test(r));
    assert.ok(at >= 0, 'the section title is missing entirely');
    // IT IS ALONE ON ITS ROW. The defect was the title sharing a line with the
    // separator before it and the paragraph after it.
    assert.match(rows[at].trim(), /^0\. ABSOLUTE PROJECT BOUNDARY$/);
    assert.match(rows[at + 1] || '', /─{10,}/, 'a section is drawn with a rule under it');
    // And the `=` bars themselves are gone — they were drawing instructions.
    assert.ok(!rows.some((r) => /={5,}/.test(r)), 'raw separator bars reached the screen');
  });

  await test('USERDOC: a line underlined with = is a heading too', () => {
    const rows = renderUser(PROMPT, 100);
    const at = rows.findIndex((r) => /^\s*SECTION UNDERLINED\s*$/.test(r));
    assert.ok(at >= 0, 'the underlined title is missing');
    assert.match(rows[at + 1] || '', /─{10,}/);
  });

  await test('USERDOC: bullets are bullets, one per row, nesting preserved', () => {
    const rows = renderUser(PROMPT, 100);
    const bullets = rows.filter((r) => r.includes('•'));
    assert.strictEqual(bullets.length, 4, `expected 4 bullet rows, got ${bullets.length}`);
    for (const want of ['easy provider management', 'Import Models', 'nested discovery', 'automatic model discovery']) {
      assert.ok(bullets.some((b) => b.includes(want)), `${want} is not on a bullet row`);
    }
    // NOT COLLAPSED INTO PROSE — the defect put all three on one line.
    assert.ok(!rows.some((r) => /easy provider management.*Import Models/.test(r)),
      'the list was reflowed into a sentence');
    // The nested one is indented further than its parent.
    const parent = bullets.find((b) => b.includes('Import Models'));
    const child = bullets.find((b) => b.includes('nested discovery'));
    assert.ok(child.indexOf('•') > parent.indexOf('•'), 'nesting was flattened');
  });

  await test('USERDOC: numbering survives as numbering', () => {
    const rows = renderUser(PROMPT, 100);
    for (const [n, label] of [[1, 'Inspect provider'], [2, 'Test connection'], [3, 'Import models']]) {
      assert.ok(rows.some((r) => new RegExp(`\\b${n}\\.\\s+${label}`).test(r)),
        `"${n}. ${label}" did not survive as an ordered item`);
    }
    assert.ok(!rows.some((r) => /1\. Inspect provider.*2\. Test connection/.test(r)),
      'the ordered list was reflowed into a sentence');
  });

  await test('USERDOC: a numbered SECTION heading is not confused with a list item', () => {
    // `0. ABSOLUTE PROJECT BOUNDARY` between separators is a heading; `1.
    // Inspect provider` in a run is a list item. Both appear in this document.
    const rows = renderUser(PROMPT, 100);
    const headingAt = rows.findIndex((r) => /^0\. ABSOLUTE PROJECT BOUNDARY$/.test(r.trim()));
    assert.match(rows[headingAt + 1] || '', /─{10,}/, 'the section lost its rule');
    const itemAt = rows.findIndex((r) => /1\.\s+Inspect provider/.test(r));
    assert.ok(!/─{10,}/.test(rows[itemAt + 1] || ''), 'an ordinary list item was promoted to a heading');
  });

  await test('USERDOC: paragraphs are separated, and not every line is', () => {
    const rows = renderUser(PROMPT, 100);
    const blanks = rows.filter((r) => !r.trim()).length;
    assert.ok(blanks >= 5, `only ${blanks} blank rows — the document has no breathing room`);
    // BUT NOT DOUBLE-SPACED. The long paragraph wraps across rows with no gap
    // inside it, which is what distinguishes structure from padding.
    const at = rows.findIndex((r) => /DO NOT modify LAIN/.test(r));
    assert.ok(rows[at + 1] && rows[at + 1].trim(), 'a wrapped paragraph was broken up by blank rows');
  });

  await test('USERDOC: code keeps its fence, its gutter and its indentation', () => {
    const rows = renderUser(PROMPT, 100);
    const code = rows.filter((r) => r.includes('▏'));
    assert.ok(code.length >= 2, 'the fenced block did not become a code block');
    const one = code.find((r) => r.includes('const x = 1;'));
    const two = code.find((r) => r.includes('deeply.indented'));
    assert.ok(one && two, 'code lines are missing');
    assert.ok(two.indexOf('deeply') > one.indexOf('const'), 'code indentation was reflowed away');
    // The fence markers themselves are drawing instructions and are consumed.
    assert.ok(!rows.some((r) => /```/.test(r)), 'a raw fence reached the screen');
  });

  await test('USERDOC: a quote stays a quote', () => {
    const rows = renderUser(PROMPT, 100);
    assert.ok(rows.some((r) => /│\s*a quoted constraint/.test(r)), 'the quote lost its marker');
  });

  await test('USERDOC: markdown headings keep their hierarchy', () => {
    const rows = renderUser(PROMPT, 100);
    // THE FIRST ROW CARRIES THE `❯` MARKER — `userBlock` puts it there, and a
    // pattern anchored to the start of the line misses it.
    assert.ok(rows.some((r) => /^(?:❯ |\s*)LAIN ROUTER\s*$/.test(r)), 'the # title is missing');
    assert.ok(rows.some((r) => /A transparent multi-provider router/.test(r)), 'the ## section is missing');
    assert.ok(!rows.some((r) => /^#+\s/.test(r.trim())), 'raw hashes reached the screen');
  });

  await test('USERDOC: nothing is renumbered, rewritten, merged or dropped', () => {
    // §12. The renderer is a PROJECTION. Every sentence that went in comes out.
    const rows = renderUser(PROMPT, 100).join(' ');
    for (const sentence of [
      'DO NOT modify LAIN',
      'easy provider management',
      'automatic model discovery',
      'Inspect provider',
      'the router must not own the conversation',
      'a quoted constraint',
      'const x = 1;',
    ]) {
      assert.ok(rows.includes(sentence), `"${sentence}" was lost in rendering`);
    }
  });

  await test('USERDOC: it holds at every width, and stays inside the frame', () => {
    for (const width of [80, 120, 160, 200]) {
      const rows = renderUser(PROMPT, width);
      // STRUCTURE SURVIVES at every width.
      assert.ok(rows.some((r) => /^0\. ABSOLUTE PROJECT BOUNDARY$/.test(r.trim())), `no section at ${width}`);
      assert.ok(rows.filter((r) => r.includes('•')).length === 4, `bullets lost at ${width}`);
      assert.ok(rows.some((r) => r.includes('▏')), `code lost at ${width}`);
      // AND NOTHING OVERFLOWS THE FRAME — the accepted geometry is unchanged.
      for (const r of rows) {
        assert.ok(T.width(r) <= width + 2, `a row is ${T.width(r)} wide at width ${width}: ${r}`);
      }
    }
  });

  await test('USERDOC: an ordinary short message still takes the cheap path', () => {
    // `looksMarked` keeps the common case out of the renderer entirely, which
    // is what it does for model answers too.
    const rows = renderUser('fix the logger please', 80);
    assert.strictEqual(rows.filter((r) => r.trim()).length, 2, rows.join('|'));
    assert.match(rows[1], /^❯ fix the logger please$/);
  });

  await test('USERDOC: a model answer still renders exactly as it did', () => {
    // §1 — this must not become a change to assistant rendering.
    const rows = feed.renderFeed([
      { kind: 'model', text: '## Heading' },
      { kind: 'model', text: '- one' },
      { kind: 'model', text: '- two' },
    ], 80).map((r) => T.strip(r));
    assert.ok(rows.some((r) => /Heading/.test(r)));
    assert.strictEqual(rows.filter((r) => r.includes('•')).length, 2);
  });
};
