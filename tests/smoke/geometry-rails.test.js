'use strict';

/**
 * THE RAILS, THROUGH THE REAL BINARY.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE THE UNIT TEST.
 *
 * tests/unit/geometry-rails.test.js measures a `Screen.draw()` inside this
 * process. That is the right place to catch a renderer's arithmetic, and it is
 * NOT proof that a person looking at a terminal sees one rectangle: the unit
 * test builds its own state object, and a defect in how the real app ASSEMBLES
 * that state would be invisible to it.
 *
 * This spawns `bin/lain.js` in a real TUI at a real width, takes the last frame
 * it painted, and measures the columns every primary surface actually landed on.
 * It is the check the steer asked for in as many words: draw imaginary vertical
 * lines down both sides and have every surface touch them.
 *
 * ------------------------------------------------------------------------
 * WHAT IT MEASURES, AND WHY TRAILING SPACES COUNT.
 *
 * The composer and the USER REQUEST block are grey GROUNDS made of padded
 * spaces. A measurement that trimmed them would score exactly the two regions
 * this test is about as empty. So the painted extent is the width of the text
 * written at a cursor address, spaces included.
 */

const assert = require('assert');
const { test, runCli, tmpdir } = require('../helpers');

const ESC = String.fromCharCode(27);
const OSC = new RegExp(ESC + '\\][0-9]+;[^\\u0007]*\\u0007', 'g');

/** The width from the screenshot that prompted this, plus two ordinary ones. */
const WIDTHS = [232, 120, 80];

const tui = (cols) => ({ LAIN_FORCE_TUI: '1', COLUMNS: String(cols), LINES: '30' });

/**
 * The LAST frame the binary painted, as `{row, col, end, text}` per row.
 *
 * Frames are separated by the hide-cursor sequence written once per `draw()`;
 * taking the last one avoids measuring a half-painted startup frame.
 */
function lastFramePainted(raw, T) {
  const clean = String(raw).replace(OSC, '');
  const frames = clean.split(ESC + '[?25l');
  const frame = frames[frames.length - 1] || '';
  const re = new RegExp(ESC + '\\[(\\d+);(\\d+)H([^' + ESC + ']*)', 'g');
  const rows = new Map();
  let m;
  while ((m = re.exec(frame))) {
    const row = Number(m[1]);
    const col = Number(m[2]);
    const text = m[3];
    if (!text.length) continue;
    const end = col + T.width(text) - 1;
    const prev = rows.get(row);
    if (!prev || end > prev.end) rows.set(row, { row, col, end, text: text.trim().slice(0, 40) });
  }
  return [...rows.values()].sort((a, b) => a.row - b.row);
}

module.exports = async function () {
  for (const cols of WIDTHS) {
    await test(`RAILS LIVE: every primary surface lands on the same two rails at ${cols} cols`, async () => {
      const T = require('../../src/ui/text');
      const views = require('../../src/ui/views');
      const r = await runCli([], {
        cwd: tmpdir('rails-'),
        env: tui(cols),
        // A REAL EXCHANGE, so the USER REQUEST block, the divider, the live row
        // and the composer are all on screen at once — which is the only state
        // in which they can be compared.
        stdin: 'fix the checkout button alignment and verify mobile\n',
        script: [{ text: 'I changed align-items in checkout.css and re-checked both viewports.' }],
        timeoutMs: 45000,
      });
      assert.strictEqual(r.code, 0, 'the binary must exit cleanly');

      const b = views.contentBounds(cols);
      const left = b.left + 1;              // 1-based screen column
      const right = b.left + b.width;       // 1-based, inclusive
      const rows = lastFramePainted(r.out, T);
      assert.ok(rows.length >= 3, `the frame drew almost nothing at ${cols}: ${rows.length} row(s)`);

      const strays = [];
      for (const row of rows) {
        if (row.col !== left) strays.push(`row ${row.row} starts at ${row.col} not ${left}: "${row.text}"`);
        if (row.end > right) strays.push(`row ${row.row} paints to ${row.end}, past ${right}: "${row.text}"`);
      }
      assert.deepStrictEqual(strays, [],
        `the real binary drew outside the frame at ${cols} cols:\n  ${strays.join('\n  ')}`);

      // AND THE GUTTERS THE PERSON ACTUALLY SEES ARE EQUAL.
      const rightGutter = cols - right;
      assert.ok(Math.abs(b.left - rightGutter) <= 1,
        `gutters are ${b.left} and ${rightGutter} at ${cols} cols`);
    });
  }

  await test('RAILS LIVE: the composer ground reaches the right rail', async () => {
    // THE DEFECT THIS PASS FIXED, asserted end to end. The composer painted one
    // column short of the frame and then ran `ESC[K` to the terminal's physical
    // edge — short on one side, unbounded on the other, on the one region with a
    // coloured ground. Measured here through the real binary rather than from
    // the renderer's own arithmetic.
    const T = require('../../src/ui/text');
    const views = require('../../src/ui/views');
    const cols = 232;
    const r = await runCli([], {
      cwd: tmpdir('rails-c-'), env: tui(cols), stdin: '\n', script: [], timeoutMs: 45000,
    });
    const b = views.contentBounds(cols);
    const right = b.left + b.width;
    const rows = lastFramePainted(r.out, T);
    assert.ok(rows.length, 'the frame drew nothing');

    // ---- THE COMPOSER IS THE BOTTOM-MOST PAINTED REGION ----------------
    //
    // NAMED BY POSITION, NOT BY SAMPLING. The first version of this assertion
    // took "the bottom few rows" as `row >= rows.length - 6` — comparing a
    // SCREEN ROW NUMBER against a COUNT OF ROWS — and then passed if ANY of
    // them reached the rail. The header always does, so the assertion was
    // vacuous: it passed with the one-column-short composer reintroduced, which
    // is the whole defect it was written for. Caught by deliberately breaking
    // the fix and watching the test stay green.
    //
    // The composer is drawn last and lowest, so the greatest painted row IS it,
    // and it must reach the rail exactly.
    const bottom = rows.reduce((a, x) => (x.row > a.row ? x : a), rows[0]);
    assert.strictEqual(bottom.end, right,
      `the bottom-most region (row ${bottom.row}, "${bottom.text}") ends at column ${bottom.end}, `
      + `not the right rail ${right}`);
    assert.strictEqual(bottom.col, b.left + 1,
      `the bottom-most region starts at column ${bottom.col}, not the left rail ${b.left + 1}`);
  });
};
