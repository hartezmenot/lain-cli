'use strict';

/**
 * ONE CONTENT FRAME, AND EVERY REGION IS INSIDE IT.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS FOR. The defect was visible in a screenshot and invisible to every
 * test: the left and right whitespace did not match. Four renderers each worked
 * out their own horizontal margins — the feed carried a two-column indent and was
 * drawn at column 1, the live row had a different one, the composer had a third,
 * and the command menu spanned the whole terminal — so there was no single answer
 * to "where does content start" and no way for them to stay in step.
 *
 * IT IS ASSERTED STRUCTURALLY, not as a coordinate snapshot. These read the
 * ADDRESSES THE DRAW ACTUALLY EMITTED — `ESC[<row>;<col>H` per region — and
 * compare them with the one frame `views.contentBounds` computed. A test that
 * hard-coded "column 4" would pass while every region drifted together; this
 * cannot, because the thing it compares against is the frame itself.
 */

const assert = require('assert');
const { test } = require('../helpers');

const views = require('../../src/ui/views');
const { Screen } = require('../../src/ui/layout');
const T = require('../../src/ui/text');

const ESC = String.fromCharCode(27);
const WIDTHS = [40, 60, 80, 100, 101, 120, 160, 200, 240];

function fakeOut(cols, rows) {
  const buf = [];
  return {
    columns: cols,
    rows,
    isTTY: true,
    write(s) { buf.push(s); return true; },
    on() {},
    removeListener() {},
    buf,
  };
}

/** A session with something in it, so every region has content to draw. */
function state() {
  return {
    cwd: process.cwd(),
    session: {
      turns: [{
        userInput: 'fix the continuation bug',
        text: 'The refresh handler was never reached.',
        narration: [{ step: 0, text: 'The refresh handler was never reached.' }],
        actions: [{ step: 0, name: 'edit_file', target: 'src/router.js', ok: true, added: 4, removed: 1 }],
      }],
      task: null,
      plan: null,
    },
    model: 'claude-opus-5',
    provider: 'anthropic',
    connection: {},
    transcript: [],
    liveActions: [],
    liveNarration: [],
    liveNotes: [],
    liveUser: null,
    extras: [],
    current: null,
    llm: {},
  };
}

/** Draw once and hand back the screen plus the raw bytes. */
function drawn(cols, rows, over = {}) {
  const out = fakeOut(cols, rows);
  // A REAL PANEL, because three of these are about the command menu and a Screen
  // built without one has `panel: null`.
  const { InteractionPanel } = require('../../src/ui/panel');
  const s = new Screen({ out, panel: new InteractionPanel() });
  s.enter();
  Object.assign(s, over);
  s.state = state();
  out.buf.length = 0;
  s.draw();
  return { screen: s, raw: out.buf.join(''), leave: () => s.leave() };
}

/**
 * EVERY COLUMN THE DRAW ADDRESSED, with the text it wrote there.
 *
 * The caret park at the end of a frame is a cursor move with no text; it is not a
 * region and is excluded, or it would read as a region starting wherever the
 * caret happens to be.
 */
function addresses(raw) {
  const re = new RegExp(ESC + '\\[(\\d+);(\\d+)H([^' + ESC + ']*)', 'g');
  const out = [];
  let m;
  while ((m = re.exec(raw))) {
    out.push({ row: Number(m[1]), col: Number(m[2]), text: m[3] });
  }
  return out;
}

module.exports = async function () {
  // ------------------------------------------------------- the frame itself --

  await test('FRAME: the gutters are EQUAL at every width, odd or even', () => {
    for (const cols of WIDTHS) {
      const b = views.contentBounds(cols);
      assert.strictEqual(b.left, b.right, 'asymmetric at ' + cols);
      // AND THEY ACCOUNT FOR THE WHOLE TERMINAL: no column is unclaimed, which is
      // what would let one side drift without the other noticing.
      assert.strictEqual(b.left + b.width + b.right, Math.max(12, cols),
        'the frame does not tile the terminal at ' + cols);
    }
  });

  await test('FRAME: the gutter grows with the terminal, gently and boundedly', () => {
    const g = (c) => views.contentBounds(c).left;
    assert.strictEqual(g(40), 1, 'a narrow terminal spends one column');
    assert.strictEqual(g(80), 2);
    assert.strictEqual(g(120), 3);
    assert.ok(g(200) >= 4, 'a wide one spends more');
    // MONOTONIC, so there is no width at which widening the terminal tightens
    // the margin.
    let prev = 0;
    for (const c of [20, 40, 48, 60, 80, 100, 120, 160, 200, 400]) {
      const cur = g(c);
      assert.ok(cur >= prev, 'the gutter shrank between ' + c + ' and the width before it');
      prev = cur;
    }
    // AND BOUNDED, so a very wide terminal is not mostly margin.
    assert.ok(g(2000) <= views.GUTTER_MAX, 'the gutter is capped');
  });

  await test('FRAME: a terminal too narrow for a gutter gives it up, symmetrically', () => {
    const b = views.contentBounds(13);
    assert.strictEqual(b.left, b.right);
    assert.ok(b.width >= 12, 'content is never eaten by the margin');
  });

  // ------------------------------------------- every region shares the frame --

  await test('FRAME: conversation, activity and composer are drawn at ONE column', () => {
    for (const cols of WIDTHS) {
      const { screen, raw, leave } = drawn(cols, 30);
      try {
        const m = screen.rowMap;
        const box = views.contentBounds(cols);
        // THE FRAME THE SCREEN RECORDED IS THE FRAME THE FUNCTION COMPUTES.
        assert.strictEqual(m.contentCol, box.left + 1, 'the frame moved at ' + cols);
        assert.strictEqual(m.contentWidth, box.width, 'the width moved at ' + cols);

        // EVERY REGION'S ROWS, read off the addresses the draw emitted.
        const rowsOf = {};
        for (const a of addresses(raw)) {
          if (!a.text) continue;                       // the caret park
          if (rowsOf[a.row] === undefined) rowsOf[a.row] = a.col;
        }
        const regions = [
          ['header', 1, 1],
          ['conversation', m.feedStart, m.feedRows],
          ['activity', m.statusStart, m.statusRows],
          ['composer', m.inputRow, 1],
        ];
        for (const [name, start, n] of regions) {
          if (!start || !n) continue;
          for (let r = start; r < start + n; r++) {
            if (rowsOf[r] === undefined) continue;      // a row with nothing on it
            assert.strictEqual(rowsOf[r], m.contentCol,
              name + ' row ' + r + ' starts at ' + rowsOf[r] + ', not ' + m.contentCol + ' (at ' + cols + ' cols)');
          }
        }
      } finally { leave(); }
    }
  });

  await test('FRAME: no drawn row reaches past the frame right-hand edge', () => {
    const saved = { no: process.env.NO_COLOR, lain: process.env.LAIN_NO_COLOR };
    delete process.env.NO_COLOR;
    delete process.env.LAIN_NO_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      for (const cols of WIDTHS) {
        const { screen, raw, leave } = drawn(cols, 30);
        try {
          const m = screen.rowMap;
          for (const a of addresses(raw)) {
            if (!a.text) continue;
            const visible = T.width(String(a.text).replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), ''));
            const ends = a.col - 1 + visible;
            // THE RIGHT GUTTER IS REAL ONLY IF NOTHING CROSSES IT.
            assert.ok(ends <= m.gutter + m.contentWidth,
              'a row ends at ' + ends + ' past the frame edge ' + (m.gutter + m.contentWidth) + ' (at ' + cols + ' cols)');
          }
        } finally { leave(); }
      }
    } finally {
      delete process.env.LAIN_FORCE_COLOR;
      if (saved.no !== undefined) process.env.NO_COLOR = saved.no;
      if (saved.lain !== undefined) process.env.LAIN_NO_COLOR = saved.lain;
    }
  });

  // ----------------------------------------------------------- the composer --

  await test('FRAME: the composer fill spans the frame and its text is inset inside it', () => {
    const inputbox = require('../../src/ui/inputbox');
    for (const cols of WIDTHS) {
      const { screen, leave } = drawn(cols, 30);
      try {
        const m = screen.rowMap;
        assert.strictEqual(m.inputTextCol, m.contentCol + inputbox.PAD,
          'the text is inset by the composer padding, at ' + cols);
        // THE INSET IS PADDING, NOT A MARGIN: small, and the same at every width.
        assert.ok(inputbox.PAD <= 2, 'the inner inset stays padding');
      } finally { leave(); }
    }
  });

  await test('FRAME: the composer text sits in the MIDDLE of the region', () => {
    const { screen, leave } = drawn(100, 30, { inputText: '' });
    try {
      const g = screen.geometry();
      assert.strictEqual(g.textRows, 3, 'three rows, so there is a middle to sit in');
      // The caret's row is the middle one: one row of fill above, one below.
      assert.strictEqual(screen.rowMap.inputRow, screen.rowMap.inputStartRow + 1,
        'the caret is on the second of three rows');
    } finally { leave(); }
  });

  // -------------------------------------------------------- the command menu --

  await test('FRAME: the command menu starts at the frame and is never wider', () => {
    const { KIND, MODE } = require('../../src/ui/panel');
    for (const cols of [80, 120, 200]) {
      const { screen, leave } = drawn(cols, 34);
      try {
        screen.panel.open({
          title: 'COMMANDS',
          kind: KIND.COMPLETION,
          mode: MODE.COMPACT,
          items: [
            { label: '/exit      Save the session and leave' },
            { label: '/status    Session, provider and tool state' },
            { label: '/mcp       MCP configuration' },
          ],
        });
        screen.draw();
        const m = screen.rowMap;
        assert.strictEqual(m.panelCol, m.contentCol, 'the menu starts at the frame at ' + cols);
        const lines = screen.panel.render(m.contentWidth, m.panelRows).map((l) => T.strip(l));
        const widest = Math.max(...lines.map((l) => l.replace(/\s+$/, '').length));
        assert.ok(widest <= m.contentWidth, 'the menu overflowed the frame at ' + cols);
        // AND ON A WIDE TERMINAL IT IS MUCH NARROWER THAN THE SCREEN, which is
        // the whole of §16: a six-command list does not need two hundred columns.
        if (cols >= 160) {
          assert.ok(widest < m.contentWidth * 0.7,
            'the menu is still a wall at ' + cols + ': ' + widest + ' of ' + m.contentWidth);
        }
      } finally { leave(); }
    }
  });

  await test('FRAME: the menu is a LIST — no box, no rules, no full-width bar', () => {
    const { KIND, MODE } = require('../../src/ui/panel');
    const { screen, leave } = drawn(160, 34);
    try {
      screen.panel.open({
        title: 'COMMANDS',
        kind: KIND.COMPLETION,
        mode: MODE.COMPACT,
        items: [{ label: '/exit      Save the session and leave' }, { label: '/status    Session state' }],
      });
      screen.draw();
      const text = screen.panel.render(screen.rowMap.contentWidth, screen.rowMap.panelRows)
        .map((l) => T.strip(l)).join(String.fromCharCode(10));
      for (const glyph of ['┌', '┐', '└', '┘', '│', '├', '┤']) {
        assert.ok(!text.includes(glyph), 'the menu still draws a box: ' + glyph);
      }
      assert.ok(!/─{10}/.test(text), 'the menu still draws a heavy rule');
      assert.ok(!text.includes('COMMANDS'), 'the shouted boxed title is gone');
      assert.match(text, /Commands/, 'and is a quiet one instead');
    } finally { leave(); }
  });

  await test('FRAME: the selected row is CONTAINED, not a bar to the wall', () => {
    const { KIND, MODE } = require('../../src/ui/panel');
    const saved = process.env.LAIN_NO_COLOR;
    delete process.env.LAIN_NO_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      const { screen, leave } = drawn(200, 34);
      try {
        screen.panel.open({
          title: 'COMMANDS',
          kind: KIND.COMPLETION,
          mode: MODE.COMPACT,
          items: [{ label: '/exit   leave' }, { label: '/status   state' }],
        });
        screen.draw();
        const rows = screen.panel.render(screen.rowMap.contentWidth, screen.rowMap.panelRows);
        // The highlighted row is the one carrying the reading surface. Its
        // PAINTED span must be the menu's width, not the frame's.
        const hit = rows.find((l) => l.includes('48;5;'));
        assert.ok(hit, 'a row is highlighted');
        const plain = T.strip(hit).replace(/\s+$/, '');
        assert.ok(plain.length < screen.rowMap.contentWidth,
          'the highlight runs to the frame edge: ' + plain.length + ' of ' + screen.rowMap.contentWidth);
      } finally { leave(); }
    } finally {
      delete process.env.LAIN_FORCE_COLOR;
      if (saved !== undefined) process.env.LAIN_NO_COLOR = saved;
    }
  });

  // ------------------------------------------------------------ prose width --

  await test('FRAME: PROSE narrows on a very wide terminal; STRUCTURE does not', () => {
    const feed = require('../../src/ui/feed');
    const NL = String.fromCharCode(10);
    const long = ('The loader reads the manifest but the writer never sees the field, which is '
      + 'why the dashboard keeps showing the previous value even after a save. ').repeat(3);
    const code = 'const aVeryLongIdentifierWhoseWidthIsPartOfWhatItMeans = compute(first, second, third);';
    const widest = (cols, pick) => {
      const out = [];
      feed.pushModel(out, long + NL + NL + '```' + NL + code + NL + '```');
      const rows = feed.renderFeed(out, cols).map((l) => T.strip(l)).filter(pick);
      return Math.max(...rows.map((r) => r.replace(/\s+$/, '').length));
    };
    const isCode = (r) => /▏/.test(r);
    const isProse = (r) => !isCode(r) && r.trim().length > 0;

    // At ordinary sizes the measure does not bite: prose uses the frame.
    assert.ok(widest(80, isProse) > 60, 'prose uses the frame at 80');
    // On a very wide terminal it does.
    const wide = widest(240, isProse);
    assert.ok(wide < 200, 'prose still spans the wall at 240 columns: ' + wide);
    assert.ok(wide > 100, 'and it is not clamped to a tiny blog measure: ' + wide);
    // AND THE CODE BLOCK IS UNTOUCHED — its width is meaning.
    assert.ok(widest(240, isCode) >= code.length,
      'a code line was squeezed into the prose measure');
  });

  await test('FRAME: the prose measure grows with the terminal, and is never wider than it', () => {
    let prev = 0;
    for (const w of [40, 80, 120, 160, 200, 300, 600]) {
      const m = views.proseWidth(w);
      assert.ok(m <= w, 'the measure exceeded the frame at ' + w);
      assert.ok(m >= prev, 'the measure shrank between ' + w + ' and the width before it');
      prev = m;
    }
    // BELOW THE SOFT LIMIT IT IS THE FRAME, so nothing changes for the sizes most
    // work happens in.
    assert.strictEqual(views.proseWidth(76), 76);
    assert.strictEqual(views.proseWidth(views.PROSE_SOFT), views.PROSE_SOFT);
  });
};
