'use strict';

/**
 * SELECTING TEXT IN THE FEED — drag to highlight, release to copy.
 *
 * The feature exists because the workspace is NOT in the terminal's scrollback:
 * it is a region LAIN repaints in place, so the terminal's own selection copies
 * whatever happened to be on the glass, and the conversation somebody wants is
 * usually scrolled out of view entirely.
 *
 * The properties that make it trustworthy, and what each protects:
 *
 *   · offsets index the WHOLE feed, not the visible rows — so a selection
 *     survives scrolling instead of silently reselecting different text
 *   · what reaches the clipboard is PLAIN — colour is a rendering concern
 *   · the highlight survives a colour reset inside the selected span
 *   · a plain click selects nothing, so clicking to dismiss still works
 *
 * NOTHING HERE TOUCHES THE REAL CLIPBOARD. The copy path is exercised with the
 * clipboard stubbed: a test that overwrites the user's clipboard has reached
 * outside the tree, and no assertion would ever notice.
 */

const assert = require('assert');
const { test } = require('../helpers');

const ts = require('../../src/ui/textselect');
const T = require('../../src/ui/text');
const { Screen } = require('../../src/ui/layout');

const LINES = ['alpha beta gamma', 'delta epsilon', 'zeta eta theta'];

/** A Screen with a known feed already "painted" at a known place. */
function screenWith(lines = LINES, { feedStart = 5, feedRows = 3, feedPad = 0, scroll = 0 } = {}) {
  const sc = new Screen({ out: { write() {}, columns: 80, rows: 24 } });
  sc.lastFeedLines = lines;
  sc.rowMap = { feedStart, feedRows, feedPad, inputRow: 20, panelRows: 0, panelStart: 99 };
  sc.workspaceScroll = scroll;
  return sc;
}

/** The minimum `ui` handleMouse reads, with the clipboard captured. */
function uiFor(sc) {
  const copied = [];
  const notices = [];
  return {
    ui: {
      enabled: true,
      screen: sc,
      panel: { visible: false },
      refresh() {},
      app: {
        input: null,
        render: { notice(level, text) { notices.push({ level, text }); } },
      },
    },
    copied,
    notices,
  };
}

module.exports = async function () {
  // ------------------------------------------------------------ measuring --

  await test('SELECT: offsets index the whole feed, so scrolling does not move them', () => {
    const m = ts.measure(LINES);
    assert.strictEqual(ts.offsetAt(m, 0, 0), 0);
    // 'alpha beta gamma' is 16 characters, then a newline.
    assert.strictEqual(ts.offsetAt(m, 1, 0), 17);
    assert.strictEqual(ts.offsetAt(m, 2, 0), 17 + 'delta epsilon'.length + 1);
  });

  await test('SELECT: a column past the end of a line clamps to that line', () => {
    // Dragging through a short line should select that line, not spill forward
    // into the next one.
    const m = ts.measure(LINES);
    assert.strictEqual(ts.offsetAt(m, 1, 999), 17 + 'delta epsilon'.length);
  });

  await test('SELECT: ANSI colour does not shift an offset', () => {
    const coloured = ['\x1b[32malpha\x1b[0m beta'];
    const m = ts.measure(coloured);
    assert.strictEqual(m.plain[0], 'alpha beta', 'the document is the text a person sees');
    assert.strictEqual(ts.offsetAt(m, 0, 6), 6);
  });

  // ------------------------------------------------------------ selecting --

  await test('SELECT: a drag across two lines yields exactly the text between', () => {
    const sc = screenWith();
    assert.ok(sc.selectFrom(7, 5), 'press on the first feed row');
    assert.ok(sc.selectTo(6, 6), 'drag to the second');
    assert.strictEqual(sc.selectedText(), 'beta gamma\ndelta');
  });

  await test('SELECT: dragging backwards works — anchor and head have a direction', () => {
    const sc = screenWith();
    sc.selectFrom(6, 6);                     // start on line 1
    sc.selectTo(7, 5);                       // drag back up to line 0
    assert.strictEqual(sc.selectedText(), 'beta gamma\ndelta');
  });

  await test('SELECT: a plain click selects nothing, so clicking to dismiss still works', () => {
    const sc = screenWith();
    sc.selectFrom(7, 5);
    assert.strictEqual(sc.hasSelection(), false, 'an empty selection is no selection');
    assert.strictEqual(sc.selectedText(), '');
  });

  await test('SELECT: a press on a blank padding row selects nothing at all', () => {
    // The feed pads with blank rows ABOVE short content. Selecting on one of
    // them used to be off by exactly the padding, which reads as "the
    // selection is janky" rather than as an off-by-N.
    const sc = screenWith(LINES, { feedPad: 2, feedRows: 5 });
    assert.strictEqual(sc.selectFrom(3, 5), false, 'the first pad row holds no text');
    assert.strictEqual(sc.selectFrom(3, 6), false, 'nor the second');
    assert.ok(sc.selectFrom(3, 7), 'the first row of real text does');
  });

  await test('SELECT: padding is accounted for, so the text picked is the text under the pointer', () => {
    const sc = screenWith(LINES, { feedPad: 2, feedRows: 5 });
    sc.selectFrom(1, 7);                     // first real row => LINES[0]
    sc.selectTo(999, 7);
    assert.strictEqual(sc.selectedText(), 'alpha beta gamma');
  });

  await test('SELECT: a selection made while scrolled refers to the scrolled text', () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const sc = screenWith(many, { feedStart: 5, feedRows: 3, scroll: 10 });
    sc.selectFrom(1, 5);                     // first visible row => many[10]
    sc.selectTo(999, 5);
    assert.strictEqual(sc.selectedText(), 'line 10');
  });

  await test('SELECT: dragging below the feed extends to the end of what is visible', () => {
    const sc = screenWith();
    sc.selectFrom(1, 5);
    sc.selectTo(1, 99);                      // far below the last feed row
    assert.ok(sc.selectedText().startsWith('alpha beta gamma'));
    assert.ok(sc.selectedText().includes('delta epsilon'), 'it kept going past the first line');
  });

  await test('SELECT: trailing padding never reaches the clipboard', () => {
    // Rows are clipped to the terminal width and padded, so a naive selection
    // ends in a run of spaces nobody selected.
    const sc = screenWith(['alpha       ', 'beta        ']);
    sc.rowMap.feedRows = 2;
    sc.selectFrom(1, 5);
    sc.selectTo(999, 6);
    assert.strictEqual(sc.selectedText(), 'alpha\nbeta');
  });

  // ----------------------------------------------------------- displaying --

  await test('HIGHLIGHT: reverse video is applied and the visible text is unchanged', () => {
    const line = '\x1b[32malpha\x1b[0m beta gamma';
    const out = ts.highlight(line, 6, 10, {});
    assert.ok(out.includes('\x1b[7m'), 'the span turns reverse video on');
    assert.ok(out.includes('\x1b[27m'), 'and off again');
    assert.strictEqual(T.strip(out), T.strip(line), 'not one visible character changed');
  });

  await test('HIGHLIGHT: a colour reset inside the span does not end the highlight', () => {
    // A reset is a full SGR reset and switches reverse video off with
    // everything else, which left the back half of a selection looking
    // unselected.
    const line = '\x1b[32malpha\x1b[0m beta';
    const out = ts.highlight(line, 0, 10, {});
    const afterReset = out.slice(out.indexOf('\x1b[0m') + 4);
    assert.ok(afterReset.includes('\x1b[7m'), 'reverse video is reapplied after the reset');
  });

  await test('HIGHLIGHT: nothing is painted when nothing is selected', () => {
    const line = 'alpha beta';
    assert.strictEqual(ts.highlight(line, 4, 4, {}), line);
  });

  await test('HIGHLIGHT: only the rows the selection covers are painted', () => {
    const m = ts.measure(LINES);
    const range = { start: ts.offsetAt(m, 1, 0), end: ts.offsetAt(m, 1, 5) };
    const painted = ts.paintRows(LINES, { lines: LINES, sel: range, feedPad: 0, scroll: 0, cols: 80 });
    assert.strictEqual(painted[0], LINES[0], 'the row above is untouched');
    assert.ok(painted[1].includes('\x1b[7m'), 'the selected row is highlighted');
    assert.strictEqual(painted[2], LINES[2], 'the row below is untouched');
  });

  // --------------------------------------------------------- the gesture ---

  await test('MOUSE: press, drag, release selects and copies in one gesture', () => {
    const sc = screenWith();
    const { ui, copied, notices } = uiFor(sc);
    const mouse = require('../../src/ui/mouse');
    const copy = require('../../src/copy');
    const real = copy.toClipboard;
    copy.toClipboard = (t) => { copied.push(t); return true; };
    try {
      mouse.handleMouse(ui, { kind: 'press', x: 7, y: 5 });
      mouse.handleMouse(ui, { kind: 'drag', x: 6, y: 6 });
      mouse.handleMouse(ui, { kind: 'release', x: 6, y: 6 });
    } finally {
      copy.toClipboard = real;
    }
    assert.deepStrictEqual(copied, ['beta gamma\ndelta'], 'the selection reached the clipboard');
    assert.ok(notices.some((n) => /Copied 2 line/.test(n.text)), `no confirmation: ${JSON.stringify(notices)}`);
  });

  await test('MOUSE: a click with no drag copies nothing and clobbers no clipboard', () => {
    // An accidental click in the feed must not overwrite what somebody has
    // been holding on their clipboard.
    const sc = screenWith();
    const { ui, copied } = uiFor(sc);
    const mouse = require('../../src/ui/mouse');
    const copy = require('../../src/copy');
    const real = copy.toClipboard;
    copy.toClipboard = (t) => { copied.push(t); return true; };
    try {
      mouse.handleMouse(ui, { kind: 'press', x: 7, y: 5 });
      mouse.handleMouse(ui, { kind: 'release', x: 7, y: 5 });
    } finally {
      copy.toClipboard = real;
    }
    assert.deepStrictEqual(copied, []);
  });

  await test('MOUSE: a clipboard that cannot be reached says so and keeps the selection', () => {
    const sc = screenWith();
    const { ui, notices } = uiFor(sc);
    const mouse = require('../../src/ui/mouse');
    const copy = require('../../src/copy');
    const real = copy.toClipboard;
    copy.toClipboard = () => false;
    try {
      mouse.handleMouse(ui, { kind: 'press', x: 7, y: 5 });
      mouse.handleMouse(ui, { kind: 'drag', x: 6, y: 6 });
      mouse.handleMouse(ui, { kind: 'release', x: 6, y: 6 });
    } finally {
      copy.toClipboard = real;
    }
    assert.ok(notices.some((n) => /Could not reach the clipboard/.test(n.text)));
    assert.ok(sc.hasSelection(), 'the text stays selected so it can be tried another way');
  });

  await test('SELECT: one selection model, not two', () => {
    // The input box and the feed both answer "which part is selected". Two
    // implementations of that would be free to disagree about what a backwards
    // drag means.
    const { Selection } = require('../../src/selection');
    const sc = screenWith();
    assert.ok(sc.textSelection instanceof Selection);
  });
};
