'use strict';

/**
 * ONE INVISIBLE RECTANGLE — every primary surface on the same two rails.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS EXISTS TO CATCH, from a real screenshot.
 *
 * The left edge looked stable and the RIGHT edges did not line up: the header
 * rule appeared to stop early, the grey USER REQUEST block and the grey composer
 * each looked like a slightly different width, and the whole screen read as
 * faintly crooked even though every individual region was usable.
 *
 * `ui/frame.js contentBounds` was already the authority and was already
 * symmetric — the drift was in CONSUMERS doing their own outer arithmetic.
 * Measured through a real `Screen.draw()`, the composer painted 223 columns
 * inside a 224-column frame and then ran `ESC[K`, which erases to the
 * TERMINAL'S physical right edge rather than the frame's. One column short on
 * one side and unbounded on the other, on the one region with a coloured ground.
 *
 * ------------------------------------------------------------------------
 * IT MEASURES THE DRAW, NOT THE INTENTION.
 *
 * Every assertion below reads the bytes a real draw emitted: the cursor address
 * says which column a region STARTED at, and the painted width of what followed
 * says where it ENDED. A test that asked the renderers what width they meant to
 * use would agree with a renderer that was wrong.
 *
 * TRAILING SPACES COUNT. The composer and the USER block are grey GROUNDS made
 * of padded spaces; a measurement that trimmed them would score the exact
 * regions this is about as zero-width.
 */

const assert = require('assert');
const { test } = require('../helpers');

const views = require('../../src/ui/views');
const T = require('../../src/ui/text');
const { Screen } = require('../../src/ui/layout');
const { InteractionPanel } = require('../../src/ui/panel');

const ESC = String.fromCharCode(27);

/** The widths the steer named, plus an odd one to prove the rounding rule. */
const WIDTHS = [80, 100, 120, 160, 180, 200, 232, 141];

function fakeOut(cols, rows) {
  const buf = [];
  return { columns: cols, rows, isTTY: true, write: (s) => buf.push(s), on() {}, removeListener() {}, buf };
}

const LONG = 'Fix the checkout button alignment and make sure mobile works, then run the tests and report back with exactly what changed and why';

function state() {
  return {
    cwd: process.cwd(),
    model: 'glm-5.3-flash',
    provider: 'ai',
    connection: {},
    output: { tokens: 1838, measured: false },
    transcript: [],
    liveActions: [],
    liveNarration: [{ step: 0, text: 'I read checkout.css and changed align-items so the button centres. '.repeat(5) }],
    liveNotes: [],
    liveUser: { text: LONG, from: null },
    extras: [],
    current: null,
    llm: {},
    session: { id: 's1', cwd: process.cwd(), turns: [], messages: [] },
    phase: { phase: 'WAITING_MODEL' },
    clock: { text: '00:00:16', ms: 16000, running: true, paused: false, shown: true },
    usage: { inputTokens: 4200, outputTokens: 1838 },
    recent: [],
  };
}

/** Draw once at `cols` and return every addressed row with its painted extent. */
function painted(cols) {
  const out = fakeOut(cols, 34);
  const s = new Screen({ out, panel: new InteractionPanel() });
  s.enter();
  s.state = state();
  out.buf.length = 0;
  s.draw();
  const raw = out.buf.join('');
  s.leave();

  const re = new RegExp(ESC + '\\[(\\d+);(\\d+)H([^' + ESC + ']*)', 'g');
  const rows = new Map();
  let m;
  while ((m = re.exec(raw))) {
    const row = Number(m[1]);
    const col = Number(m[2]);
    // TRAILING SPACES KEPT — see the header. A grey ground IS ink.
    const text = T.strip(m[3]);
    if (!text.length) continue;
    const end = col + T.width(text) - 1;
    const prev = rows.get(row);
    if (!prev || end > prev.end) rows.set(row, { row, col, end, text: text.trim().slice(0, 40) });
  }
  return { rows: [...rows.values()].sort((a, b) => a.row - b.row), screen: s, raw };
}

module.exports = async function () {
  // ------------------------------------------------------- the rails --------

  await test('RAILS: every drawn region starts on the frame left rail', () => {
    for (const cols of WIDTHS) {
      const b = views.contentBounds(cols);
      const left = b.left + 1;                         // 1-based screen column
      for (const r of painted(cols).rows) {
        assert.strictEqual(r.col, left,
          `at ${cols} cols row ${r.row} starts at column ${r.col}, not the rail ${left}: "${r.text}"`);
      }
    }
  });

  await test('RAILS: nothing is painted past the frame right rail', () => {
    // THE DEFECT THAT WAS HERE: the composer ran `ESC[K` to the terminal's own
    // right edge, so the one region with a coloured ground was the one region
    // that ignored the right gutter.
    for (const cols of WIDTHS) {
      const b = views.contentBounds(cols);
      const right = b.left + b.width;                  // 1-based, inclusive
      for (const r of painted(cols).rows) {
        assert.ok(r.end <= right,
          `at ${cols} cols row ${r.row} paints to column ${r.end}, past the rail ${right} by ${r.end - right}: "${r.text}"`);
      }
    }
  });

  await test('RAILS: the outer gutters are equal at every width, odd or even', () => {
    for (const cols of WIDTHS) {
      const b = views.contentBounds(cols);
      const leftGutter = b.left;
      const rightGutter = cols - (b.left + b.width);
      assert.ok(Math.abs(leftGutter - rightGutter) <= 1,
        `at ${cols} cols the gutters are ${leftGutter} and ${rightGutter}`);
      // AND THE FRAME TILES THE TERMINAL — no column is unclaimed, which is what
      // would let one side drift without the other noticing.
      assert.strictEqual(b.left + b.width + b.right, Math.max(12, cols),
        `the frame does not tile the terminal at ${cols}`);
    }
  });

  // ------------------------------------------- the surfaces, one by one -----

  await test('RAILS: the FULL-BLEED surfaces paint the frame width exactly', () => {
    // These are the ones a person reads as the edges of the screen: if any of
    // them is a column short, the interface looks crooked even though every
    // region is individually correct. Prose is deliberately NOT in this list —
    // see the next test.
    for (const cols of WIDTHS) {
      const b = views.contentBounds(cols);

      const header = views.header({
        cwd: process.cwd(), model: 'glm-5.3-flash', provider: 'ai',
        connection: {}, output: { tokens: 1838, measured: false }, width: b.width,
      });
      assert.strictEqual(T.width(T.strip(header[0])), b.width,
        `header is ${T.width(T.strip(header[0]))} wide, frame is ${b.width}, at ${cols}`);

      const strip = require('../../src/ui/status').statusStrip({
        phase: { phase: 'WAITING_MODEL' },
        clock: { text: '00:00:16', shown: true, running: true },
        recent: [], usage: {},
      }, b.width, 1);
      assert.strictEqual(T.width(T.strip(strip[0])), b.width,
        `the live row is ${T.width(T.strip(strip[0]))} wide, frame is ${b.width}, at ${cols}`);

      // THE COMPOSER, which is where the measured defect was.
      const out = fakeOut(cols, 34);
      const s = new Screen({ out, panel: new InteractionPanel() });
      s.enter();
      s.rowMap = { inputLines: [] };
      const comp = require('../../src/ui/inputbox').draw(s, { row: 30, cols: b.width, textRows: 2, col: b.left + 1 });
      for (const line of comp) {
        // Drop the leading cursor address; what remains is the painted ground.
        const body = T.strip(String(line)).replace(new RegExp('^' + ESC + '\\[\\d+;\\d+H'), '');
        const plain = body.replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '');
        assert.strictEqual(T.width(plain), b.width,
          `composer row is ${T.width(plain)} wide, frame is ${b.width}, at ${cols}`);
      }
      s.leave();
    }
  });

  await test('RAILS: the composer ERASES beyond the frame but PAINTS only inside it', () => {
    // ---- AN ASSERTION THIS PASS GOT WRONG, KEPT AS THE CORRECTED ONE ----
    //
    // The first version of this banned `ESC[K` outright, on the reasoning that
    // erasing to the terminal's physical right edge is a renderer deciding its
    // own outer geometry. That is wrong, and twelve smoke tests said so within a
    // minute of the change: the erase PAINTS NOTHING, it CLEARS — and without it
    // a frame drawn after a wider one leaves the previous row's glyphs stranded
    // to the right of the composer.
    //
    // The distinction that actually matters is PAINTED versus CLEARED. Ink must
    // stop at the rail; clearing past it is how a redraw stays honest. So this
    // asserts the ink, which is what an eye measures, and deliberately says
    // nothing about the erase.
    const cols = 232;
    const b = views.contentBounds(cols);
    const out = fakeOut(cols, 34);
    const s = new Screen({ out, panel: new InteractionPanel() });
    s.enter();
    s.rowMap = { inputLines: [] };
    const comp = require('../../src/ui/inputbox').draw(s, { row: 30, cols: b.width, textRows: 2, col: b.left + 1 });
    s.leave();
    for (const line of comp) {
      const raw = String(line);
      // The erase is present and is allowed.
      assert.ok(raw.includes(ESC + '[K'), 'the composer must still clear stale glyphs to its right');
      // And the INK — everything that is not an escape sequence — is the frame.
      const plain = T.strip(raw).replace(new RegExp('^' + ESC + '\\[\\d+;\\d+H'), '')
        .replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '');
      assert.strictEqual(T.width(plain), b.width,
        `composer paints ${T.width(plain)} columns into a ${b.width}-column frame`);
    }
  });

  await test('RAILS: prose may be narrower than the frame — that is not drift', () => {
    // The one deliberate exception, and it must stay deliberate: a paragraph
    // stretched across 200 columns is harder to read than the same paragraph at
    // 90. STRUCTURE (header, rule, grounds, the live row) uses the whole frame;
    // PROSE gets a measure inside it. See ui/frame.js `proseWidth`.
    for (const cols of [200, 232]) {
      const b = views.contentBounds(cols);
      assert.ok(views.proseWidth(b.width) <= b.width, 'prose never exceeds the frame');
      assert.ok(views.proseWidth(b.width) < b.width, `prose should narrow at ${cols}`);
    }
    for (const cols of [80, 100]) {
      const b = views.contentBounds(cols);
      assert.strictEqual(views.proseWidth(b.width), b.width,
        `prose is the frame at ${cols} — narrowing here would waste an ordinary terminal`);
    }
  });

  // ------------------------------------------------- no local width math ----

  await test('RAILS: no primary renderer invents its own outer width', () => {
    // The guard that makes the fix stick. A renderer is handed `width` by the
    // layout; deriving a DIFFERENT outer width from `screen.cols` is how the
    // frame gets quietly reintroduced as four separate opinions.
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'src', 'ui');
    // `layout.js` owns the frame and legitimately reads `cols`; `frame.js` IS
    // the authority. Everything else is handed its width.
    const allowed = new Set(['layout.js', 'frame.js', 'geometry.js', 'views.js']);
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      if (allowed.has(f)) continue;
      const code = fs.readFileSync(path.join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // An OUTER width derived from the terminal rather than accepted as a
      // parameter. `screen.cols` as a FALLBACK for a missing width is fine —
      // `cols || screen.cols` — so only a bare subtraction is flagged.
      if (/screen\.cols\s*-\s*\d/.test(code)) offenders.push(`${f}: derives an outer width from screen.cols`);
    }
    assert.deepStrictEqual(offenders, [], offenders.join('\n'));
  });
};
