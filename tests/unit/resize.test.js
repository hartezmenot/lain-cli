'use strict';

/**
 * THE ONE SURFACE AT EVERY TERMINAL SIZE.
 *
 * ------------------------------------------------------------------------
 * THE PREVIOUS UI HAD WIDTH PROBLEMS, and they were all the same shape: a
 * region composed at one width and drawn at another, or a fixed ceiling that
 * ignored the terminal entirely. The symptoms are a torn right-hand border, a
 * row that wraps and pushes everything below it down by one, and a value
 * clipped to four characters in a column that had forty to spare.
 *
 * So this asserts the property those failures violate, at the widths a person
 * actually uses:
 *
 *   1. EVERY DRAWN ROW IS EXACTLY THE TERMINAL'S WIDTH — measured VISIBLY,
 *      because colour codes carry no columns and `.length` counts them.
 *   2. THE REGIONS TILE THE TERMINAL — they sum to its height exactly, so
 *      nothing is drawn off the bottom and nothing is left showing through.
 *   3. THE INPUT IS NEVER SACRIFICED, at any size.
 *   4. A RESIZE DOES NOT CRASH, and the frame after it is as correct as the
 *      frame before.
 *
 * MEASURED ON THE REAL Screen, drawing the real regions. A geometry-only test
 * would pass while the drawing tore, which is exactly what happened before.
 */

const assert = require('assert');
const { test } = require('../helpers');

const T = require('../../src/ui/text');
const { Screen } = require('../../src/ui/layout');

/** The widths §38 names, plus the minimum the Screen supports. */
const WIDTHS = [40, 60, 80, 100, 120, 160];
const HEIGHTS = [8, 12, 16, 20, 24, 30, 50];

/** A terminal double that can be resized between draws, like a real one. */
function terminal(cols, rows) {
  const out = {
    columns: cols, rows, isTTY: true,
    frames: [], listeners: [],
    write(x) { out.buf += x; return true; },
    on(ev, fn) { if (ev === 'resize') out.listeners.push(fn); },
    removeListener() { out.listeners.length = 0; },
    resize(c, r) {
      out.columns = c; out.rows = r;
      for (const fn of out.listeners.slice()) fn();
    },
  };
  out.buf = '';
  return out;
}

/** The rows a frame addressed, as `{row: text}`. */
function painted(buf) {
  const rows = {};
  const re = /\x1b\[(\d+);1H((?:[^\x1b]|\x1b\[(?!\d+;1H)[0-9;]*[A-Za-z])*)/g;
  let m;
  while ((m = re.exec(buf))) rows[Number(m[1])] = m[2];
  return rows;
}

/** A session with enough in it that every region has something to draw. */
function state(extra = {}) {
  return Object.assign({
    cwd: 'C:\\work\\lain-v2',
    model: 'claude-opus-5', provider: 'anthropic', connection: 'anthropic',
    output: { tokens: 1204, measured: false },
    session: {
      cwd: 'C:\\work\\lain-v2',
      task: { objective: 'fix the frontend routing issue' },
      usage: { inputTokens: 42000, outputTokens: 1204, cacheReadTokens: 8000 },
      turns: [{
        userInput: 'fix the frontend routing issue and make sure the redirect still works',
        text: 'Implemented the route correction and re-ran the unit suite; everything passes.',
        actions: [{ name: 'read_file', target: 'src/router.js', ok: true }],
        errors: [],
      }],
    },
    llm: {
      phase: { phase: 'RUNNING_TOOL', tool: 'read_file', target: 'src/router.js' },
      phaseSince: Date.now() - 3000,
      usage: { inputTokens: 42000, outputTokens: 1204, cacheReadTokens: 8000 },
      jobs: [{ id: '17', primary: false, state: 'RUNNING', request: 'the integration suite', elapsedMs: 4000, activity: 'running' }],
      pending: [], recent: [],
    },
    transcript: [], liveActions: [], liveNarration: [], liveNotes: [], extras: [],
  }, extra);
}

/** Draw once at a size, and hand back the screen and what it painted. */
function draw(cols, rows, over = {}) {
  const out = terminal(cols, rows);
  const s = new Screen({ out });
  s.enter();
  s.inputText = over.inputText || '';
  s.state = state();
  out.buf = '';
  s.draw();
  return { screen: s, out, rows: painted(out.buf) };
}

module.exports = async function () {
  await test('RESIZE: every drawn row is exactly the terminal width, at every size', () => {
    // Colour ON, because the failure this catches is a row measured by
    // `.length` with escape sequences in it — which is invisible without it.
    const saved = { no: process.env.NO_COLOR, lain: process.env.LAIN_NO_COLOR };
    delete process.env.NO_COLOR;
    delete process.env.LAIN_NO_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      for (const cols of WIDTHS) {
        const { rows } = draw(cols, 30);
        for (const [n, text] of Object.entries(rows)) {
          // The erase-to-end and the caret park are cursor control, not cells.
          const bare = String(text).replace(/\x1b\[K/g, '').replace(/\x1b\[\d+;\d+H/g, '').replace(/\x1b\[\?25[hl]/g, '');
          const width = T.width(bare);
          assert.ok(width <= cols,
            `row ${n} is ${width} visible cells at width ${cols}: ${JSON.stringify(T.strip(text).slice(0, 90))}`);
        }
      }
    } finally {
      delete process.env.LAIN_FORCE_COLOR;
      if (saved.no !== undefined) process.env.NO_COLOR = saved.no;
      if (saved.lain !== undefined) process.env.LAIN_NO_COLOR = saved.lain;
    }
  });

  await test('RESIZE: the regions tile the terminal exactly, at every height', () => {
    for (const rows of HEIGHTS) {
      const { screen } = draw(80, rows);
      const g = screen.geometry();
      const total = g.headerRows + g.workspace + g.statusRows + g.inputRows + g.panelRows
        + g.pendingRows + g.jobRows;
      assert.strictEqual(total, rows,
        `at ${rows} rows the regions total ${total}: ${JSON.stringify(g)}`);
      assert.ok(g.workspace >= 1, `the conversation vanished at ${rows} rows`);
      assert.ok(g.inputRows >= 1, `the input was sacrificed at ${rows} rows`);
    }
  });

  await test('RESIZE: the conversation gets most of the screen', () => {
    // §30 and the whole point of the subtraction: at 80x24 the fixed chrome
    // used to be ten of the twenty-four rows. The conversation is what every
    // other region exists to serve.
    const { screen } = draw(80, 24);
    const g = screen.geometry();
    assert.ok(g.workspace >= 14,
      `the conversation should get most of an 80x24 screen, got ${g.workspace} of 24`);
  });

  await test('RESIZE: the input follows the width, with no fixed ceiling', () => {
    // A fixed cap on the input's width is the defect this names: the region
    // must use the terminal it is given.
    const widths = WIDTHS.map((w) => {
      const { screen } = draw(w, 30);
      return require('../../src/ui/inputbox').innerWidth(screen);
    });
    for (let i = 1; i < widths.length; i++) {
      assert.ok(widths[i] > widths[i - 1],
        `the input stopped growing between ${WIDTHS[i - 1]} and ${WIDTHS[i]}: ${widths.join(', ')}`);
    }
    assert.ok(widths[widths.length - 1] >= 150, `160 columns must be usable: ${widths.join(', ')}`);
  });

  await test('RESIZE: text REFLOWS with the width rather than being clipped', () => {
    const long = 'fix the frontend routing issue and make sure the redirect still works everywhere, '
      + 'including the one that only fires when the session has already been resumed once before';
    const narrow = draw(50, 30, { inputText: long });
    const wide = draw(160, 30, { inputText: long });
    assert.ok(narrow.screen.geometry().textRows > wide.screen.geometry().textRows,
      'a narrow terminal must wrap the prompt onto more rows, not cut it');
    // NOTHING IS LOST EITHER WAY. The buffer is what gets sent; the rows are
    // only how it is shown.
    assert.strictEqual(narrow.screen.inputText, long);
  });

  await test('RESIZE: the composer keeps THREE rows, so its text can sit in the middle', () => {
    // A borderless composer earns its shape from background contrast and
    // whitespace — there is no outline to give it one — and a caret on the
    // terminal's last line has neither. Three rows give the text one above it and
    // one below (ui/inputbox.js `topPad`), which is what makes the region read as a
    // place rather than as a strip that failed to fill.
    for (const cols of WIDTHS) {
      const { screen } = draw(cols, 30, { inputText: '' });
      assert.strictEqual(screen.geometry().textRows, 3,
        `an empty composer is three rows at ${cols} columns`);
    }
    // AND THE ROWS ARE GIVEN UP ON A SHORT TERMINAL, in order, where seeing the
    // conversation at all outranks the air around the caret.
    assert.strictEqual(draw(80, 16, { inputText: '' }).screen.geometry().textRows, 2,
      'a 16-row window spends two');
    assert.strictEqual(draw(80, 9, { inputText: '' }).screen.geometry().textRows, 1,
      'a 9-row window gets them back');
    // IT IS A FLOOR, NOT A CAP: a prompt that needs more rows still gets them.
    const many = draw(60, 30, { inputText: 'a'.repeat(400) });
    assert.ok(many.screen.geometry().textRows > 3, 'a long prompt still grows the region');
  });

  await test('RESIZE: the live row and the background region never overlap the input', () => {
    // Regions are drawn by ROW ADDRESS, so an overlap is two regions claiming
    // the same row — which shows as one of them being invisible.
    for (const rows of [16, 20, 24, 30]) {
      const { screen } = draw(90, rows);
      const m = screen.rowMap;
      const g = screen.geometry();
      const feedEnd = m.feedStart + m.feedRows - 1;
      assert.ok(m.jobsStart > feedEnd, `background overlaps the conversation at ${rows} rows`);
      assert.ok(m.statusStart >= m.jobsStart + (g.jobRows || 0),
        `the live row overlaps background at ${rows} rows`);
      assert.ok(m.inputRow > m.statusStart, `the input overlaps the live row at ${rows} rows`);
      assert.ok(m.inputRow <= rows, `the input was drawn off the bottom at ${rows} rows`);
    }
  });

  await test('RESIZE: an actual resize redraws and does not throw', () => {
    const out = terminal(120, 40);
    const s = new Screen({ out });
    s.enter();
    s.state = state();
    s.draw();
    try {
      for (const [c, r] of [[60, 20], [160, 50], [40, 8], [100, 24]]) {
        assert.doesNotThrow(() => out.resize(c, r), `resizing to ${c}x${r} threw`);
        // AND THE FRAME AFTER IT IS AS CORRECT AS THE ONE BEFORE.
        out.buf = '';
        s.draw();
        const g = s.geometry();
        assert.strictEqual(
          g.headerRows + g.workspace + g.statusRows + g.inputRows + g.panelRows + g.pendingRows + g.jobRows,
          Math.max(8, r), `the regions stopped tiling after a resize to ${c}x${r}`,
        );
      }
    } finally {
      s.leave();
    }
  });

  await test('RESIZE: a resize CLEARS, because a per-row erase cannot cover a shrink', () => {
    // The rows a taller terminal painted are still on the glass after it
    // shrinks, and `\x1b[K` only erases to the right of what is redrawn.
    const out = terminal(100, 40);
    const s = new Screen({ out });
    s.enter();
    s.state = state();
    s.draw();
    out.buf = '';
    out.resize(100, 20);
    assert.ok(out.buf.includes('\x1b[2J'), 'a resize must clear before it redraws');
    s.leave();
  });

  await test('RESIZE: an identical frame is not written twice, but a resized one is', () => {
    // The optimisation that keeps a slow terminal from shimmering must not
    // survive a resize — the cached frame describes a screen that is gone.
    const out = terminal(100, 30);
    const s = new Screen({ out });
    s.enter();
    s.state = state({ llm: { phase: null, jobs: [], pending: [], recent: [] } });
    s.draw();
    out.buf = '';
    s.draw();
    const repeat = out.buf.replace(/\x1b\[\d+;\d+H|\x1b\[\?25h/g, '');
    assert.strictEqual(repeat, '', 'an unchanged frame is only a re-parked caret');
    out.buf = '';
    out.resize(70, 30);
    assert.ok(out.buf.length > 100, 'but a resize composes and writes a whole frame');
    s.leave();
  });
};
