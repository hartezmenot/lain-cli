'use strict';

/**
 * THE CONVERSATION SURFACE — four defects, reported from a real session.
 *
 *   1. `ask_user` rendered every option as `[object Object]`.
 *   2. The conversation was glued to the bottom of its pane.
 *   3. What the user said was indistinguishable from everything else, and
 *      there was no way to get a message back onto the input line.
 *   4. A finished plan's `100%` survived into the next turn.
 *
 * The first is the one that made LAIN unusable rather than merely awkward: a
 * question whose four options all read the same cannot be answered.
 */

const assert = require('assert');
const { test } = require('../helpers');

const A = require('../../src/ui/answer');
const tabs = require('../../src/ui/tabs');
const views = require('../../src/ui/views');
const T = require('../../src/ui/text');
const { Screen } = require('../../src/ui/layout');
const { handleMouse } = require('../../src/ui/mouse');
const { askAdapter, multiAdapter } = require('../../src/ui/askframes');

/** A Screen drawn at a real geometry, with the rows it painted. */
function drawn(view, session, { rows = 26, cols = 90 } = {}) {
  let wrote = '';
  const s = new Screen({
    out: { columns: cols, rows, isTTY: true, write(x) { wrote += x; }, on() {}, removeListener() {} },
  });
  s.active = true;
  s.setView(view);
  s.state = {
    cwd: '/p', session, llm: { phase: null },
    liveActions: [], liveNarration: [], extras: [],
  };
  s.draw();
  const painted = {};
  const re = /\x1b\[(\d+);1H((?:[^\x1b]|\x1b\[(?!\d+;1H)[0-9;]*[A-Za-z])*)/g;
  let m;
  while ((m = re.exec(wrote))) painted[Number(m[1])] = m[2];
  return { screen: s, rows: painted };
}

const oneTurn = (said, answered = 'I found the writer.') => ({
  cwd: '/p',
  task: { objective: 'fix the engine' },
  turns: [{ userInput: said, text: answered, actions: [], errors: [] }],
});

module.exports = async function () {
  // =================================================== 1 — [object Object] ==

  await test('MCQ: an option sent as an OBJECT renders as text, never [object Object]', () => {
    // THE DEFECT, EXACTLY. The ask_user schema declares `items: {type:'string'}`
    // and every surface coerced with `String(o)`. Models send
    // `{ label, description }` anyway — it is the natural way to write a choice
    // with a reason — and `String({})` is `[object Object]`. Four well-explained
    // options became four identical unreadable rows.
    const a = askAdapter({
      question: 'Which frontend?',
      options: [
        { label: 'React + Vite', description: 'fast dev server, big ecosystem' },
        { option: 'Svelte', why: 'smallest bundle' },
        { title: 'Vue' },
      ],
    });
    const rows = a.items.filter((i) => i.value !== undefined).map((i) => T.strip(i.label));
    assert.deepStrictEqual(rows, ['A.  React + Vite', 'B.  Svelte', 'C.  Vue']);
    for (const r of rows) assert.ok(!/object Object/.test(r), r);
  });

  await test('MCQ: the reasoning survives into the details screen rather than being lost', () => {
    // Normalising must not mean discarding. `label — description` is exactly
    // the shape ui/adapters.js `splitOption` takes apart again, so the compact
    // list stays one row per option and the explanation is still one key away.
    const a = askAdapter({
      question: 'Which frontend?',
      options: [{ label: 'React + Vite', description: 'fast dev server, big ecosystem' }],
    });
    assert.ok(a.onEscape, 'an option with an explanation must offer the details screen');
    const body = T.strip(a.onEscape().push.items.map((i) => i.label).join('\n'));
    assert.match(body, /React \+ Vite/);
    assert.match(body, /fast dev server, big ecosystem/);
  });

  await test('MCQ: multi-select and the letter shortcuts see the same normalised text', () => {
    const opts = [{ label: 'Auth', description: 'login' }, { label: 'Billing' }];
    const m = multiAdapter({ question: 'Pick features', options: opts });
    const rows = m.items.filter((i) => /\[[ x]\]/.test(String(i.label))).map((i) => T.strip(i.label));
    assert.deepStrictEqual(rows, ['[ ] 1.  Auth', '[ ] 2.  Billing']);
    // And `match` can still tell them apart — it could not when both were
    // `[object Object]`, which is what made the question unanswerable.
    const hit = A.match('Auth', opts, A.KIND.MULTI_SELECT);
    assert.ok(hit, 'a typed answer must resolve against a normalised option');
  });

  await test('MCQ: the ask_user tool normalises at the boundary, so the model gets clean text back', () => {
    const optionText = A.optionText;
    assert.strictEqual(optionText({ label: 'React', description: 'fast' }), 'React — fast');
    assert.strictEqual(optionText('plain'), 'plain');
    assert.strictEqual(optionText({ value: 42 }), '42');
    assert.strictEqual(optionText({ unknown_key: 'still readable' }), 'still readable');
    // An object with nothing usable in it yields '' — which `filter(Boolean)`
    // drops — rather than a row inviting the user to choose `[object Object]`.
    assert.strictEqual(optionText({}), '');
    assert.strictEqual(optionText(null), '');
  });

  // ============================================== 2 — the feed's anchoring ==

  await test('FEED: the conversation reads from the TOP; only OUTPUT keeps its floor', () => {
    // `growsUpward` (pad above short content) and `followsLive` (scroll new
    // output into view) were one flag, so ACTIVITY could not read from the top
    // without also going deaf to new lines.
    assert.strictEqual(tabs.growsUpward('activity'), false);
    assert.strictEqual(tabs.followsLive('activity'), true);
    assert.strictEqual(tabs.growsUpward('output'), true);
    assert.strictEqual(tabs.followsLive('output'), true);
  });

  await test('FEED: a short conversation is NOT padded down to the input box', () => {
    const { screen, rows } = drawn('activity', oneTurn('fix the stalling engine'));
    assert.strictEqual(screen.rowMap.feedPad, 0, 'padding above is what glued it to the floor');
    const first = screen.rowMap.feedStart;
    const last = first + screen.rowMap.feedRows - 1;
    const filled = [];
    for (let r = first; r <= last; r++) if (T.strip(rows[r] || '').trim()) filled.push(r);
    assert.ok(filled.length, 'the conversation must be drawn somewhere');
    assert.ok(filled[0] <= first + 1,
      `it should start at the top of the feed (first filled ${filled[0]}, feed begins ${first})`);
  });

  // ============================================ 3 — what the user said ======

  await test('SAID: a user message is a BLOCK on its own ground, full width', () => {
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      const { screen, rows } = drawn('activity', oneTurn('fix the stalling engine'));
      const first = screen.rowMap.feedStart;
      const gray = [];
      for (let r = first; r < first + screen.rowMap.feedRows; r++) {
        if (String(rows[r] || '').includes('\x1b[48;5;236m')) gray.push(T.strip(rows[r]));
      }
      assert.strictEqual(gray.length, 1, 'exactly the one message the user sent');
      assert.match(gray[0], /fix the stalling engine/);
      assert.ok(T.width(gray[0]) >= 80, `the block runs the width of the pane: ${T.width(gray[0])}`);
    } finally {
      delete process.env.LAIN_FORCE_COLOR;
    }
  });

  await test('SAID: a multi-line message is ONE block with ONE marker, not one per line', () => {
    const lines = views.activity({ session: oneTurn('first line\nsecond line'), width: 70 });
    const text = T.strip(lines.join('\n'));
    assert.strictEqual((text.match(/❯/g) || []).length, 1,
      'a marker per line reads as several messages:\n' + text);
    assert.match(text, /first line/);
    assert.match(text, /second line/);
  });

  await test('SAID: EVERY row of a message maps back to the WHOLE message', () => {
    const said = 'first line\nsecond line';
    const lines = views.activity({ session: oneTurn(said), width: 70 });
    const idx = Object.keys(lines.userAt || {}).map(Number);
    assert.strictEqual(idx.length, 2, 'both drawn rows carry the mapping');
    for (const i of idx) {
      assert.strictEqual(lines.userAt[i], said,
        'clicking the second line must bring back the message, not its middle line');
    }
  });

  await test('SAID: the mapping is a side-channel, not content', () => {
    // As a plain enumerable property it turned every deepStrictEqual against a
    // rendered feed into a comparison of the map as well.
    const lines = views.activity({ session: oneTurn('hello'), width: 70 });
    assert.ok(!Object.keys(lines).includes('userAt'));
    assert.ok(lines.userAt, 'and it is still reachable by name');
  });

  await test('SAID: clicking a message puts it back on the INPUT line', () => {
    const said = 'fix the stalling engine\nand check the book';
    const { screen } = drawn('activity', oneTurn(said));
    const idx = Object.keys(screen.lastFeedLines.userAt || {}).map(Number);
    assert.ok(idx.length, 'the drawn feed must carry the mapping');

    const input = { line: '', cursor: 0, setLine(t) { this.line = t; this.cursor = t.length; return t; }, emit() {}, selectFrom() {} };
    const ui = {
      enabled: true, screen, panel: { visible: false },
      app: { input, render: { notice() {} } },
      refresh() {}, ensureReport() {},
    };
    // The LAST row of the block — a click there must still recall the whole thing.
    const y = screen.rowMap.feedStart + (idx[idx.length - 1] - (screen.rowMap.feedScroll || 0))
      + (screen.rowMap.feedPad || 0);
    // A CLICK IS A PRESS AND A RELEASE. The recall fires on the release, so a
    // press that turns into a drag stays a selection — see ui/mouse.js.
    handleMouse(ui, { kind: 'press', x: 5, y });
    assert.strictEqual(input.line, '', 'the press alone must not act — a drag may still follow');
    handleMouse(ui, { kind: 'release', x: 5, y });
    assert.strictEqual(input.line, said);
    assert.strictEqual(input.cursor, said.length, 'and the caret lands at the end, ready to edit');
  });

  await test('SAID: DRAGGING across a message selects text and does NOT recall it', () => {
    // The gesture that starts identically. Acting on the press would have cost
    // copying a sentence out of your own message, which is the one thing the
    // feed's selection exists for.
    const said = 'fix the stalling engine' + String.fromCharCode(10) + 'and check the book';
    const { screen } = drawn('activity', oneTurn(said));
    const idx = Object.keys(screen.lastFeedLines.userAt || {}).map(Number);
    const input = { line: '', setLine() { throw new Error('a drag must never recall'); }, emit() {}, selectFrom() {} };
    const notices = [];
    const ui = {
      enabled: true, screen, panel: { visible: false },
      app: { input, render: { notice: (l, m) => notices.push(m) } },
      refresh() {}, ensureReport() {},
    };
    const row = (i) => screen.rowMap.feedStart + (i - (screen.rowMap.feedScroll || 0)) + (screen.rowMap.feedPad || 0);
    handleMouse(ui, { kind: 'press', x: 3, y: row(idx[0]) });
    handleMouse(ui, { kind: 'drag', x: 40, y: row(idx[idx.length - 1]) });
    assert.doesNotThrow(() => handleMouse(ui, { kind: 'release', x: 40, y: row(idx[idx.length - 1]) }));
    assert.strictEqual(input.line, '', 'the message must not have been recalled');
    assert.ok(screen.selectedText(), 'and the drag really did select something');
  });

  await test('SAID: a click on the model\'s own text still begins a selection, not a recall', () => {
    const { screen } = drawn('activity', oneTurn('a question', 'the answer LAIN gave'));
    const userRows = new Set(Object.keys(screen.lastFeedLines.userAt || {}).map(Number));
    let modelRow = -1;
    for (let i = 0; i < screen.lastFeedLines.length; i++) {
      if (!userRows.has(i) && /the answer LAIN gave/.test(T.strip(screen.lastFeedLines[i]))) { modelRow = i; break; }
    }
    assert.ok(modelRow >= 0, 'the model line must be on screen to click');
    const input = { line: '', setLine() { throw new Error('a model line must never be recalled to the input'); }, emit() {}, selectFrom() {} };
    const ui = {
      enabled: true, screen, panel: { visible: false },
      app: { input, render: { notice() {} } },
      refresh() {}, ensureReport() {},
    };
    const y = screen.rowMap.feedStart + (modelRow - (screen.rowMap.feedScroll || 0)) + (screen.rowMap.feedPad || 0);
    assert.doesNotThrow(() => handleMouse(ui, { kind: 'press', x: 5, y }));
    assert.doesNotThrow(() => handleMouse(ui, { kind: 'release', x: 5, y }));
    assert.strictEqual(input.line, '');
  });
};
