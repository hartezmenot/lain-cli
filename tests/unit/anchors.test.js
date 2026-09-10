'use strict';

/**
 * WHAT THE USER SAID, AS SOMETHING YOU CAN NAVIGATE BACK TO.
 *
 * The classification has to be conservative in one direction only: calling a
 * message a decision would put a misleading label over somebody's instruction,
 * while calling a decision a message costs nothing but a plainer heading.
 */

const assert = require('assert');
const { test } = require('../helpers');

const anchors = require('../../src/ui/anchors');
const feed = require('../../src/ui/feed');

module.exports = async function () {
  await test('ANCHOR: the NEWEST message is reachable, and a jump that cannot move says so', () => {
    // ---- THE DEFECT, MEASURED ------------------------------------------
    //
    // The last anchor sits near the END of the feed, below the greatest scroll
    // that still leaves a full window of rows on screen. `jumpToAnchor` set the
    // scroll to it, `draw` clamped it straight back, and the function returned
    // `true` anyway — so Alt+Down reported a jump that never happened, on every
    // press, at the bottom of every long conversation. Eight anchors, seven
    // reachable, the eighth claiming success for ever.
    //
    // Asserted on the real Screen because the bug lived in the gap between what
    // this function recorded and what `draw` would allow.
    const { EventEmitter } = require('events');
    const { Screen } = require('../../src/ui/layout');
    const anchors = require('../../src/ui/anchors');

    const out = new EventEmitter();
    out.isTTY = true; out.columns = 90; out.rows = 24;
    out.write = () => true;
    const screen = new Screen({ out });
    screen.enter();
    try {
      const turns = [];
      for (let i = 1; i <= 8; i++) {
        turns.push({
          userInput: `question ${i}`,
          text: 'a',
          narration: [{ step: 0, text: `Answer paragraph ${i} with enough length to push the pane down.` }],
          // AN EDIT, NOT A READ. A successful read is live state and no longer
          // takes a row in the conversation (ui/feed.js `durable`), so building
          // the feed out of reads made it short enough that there was barely
          // anything to scroll — and this test is about SCROLLING to anchors.
          // A change to the project is exactly the kind of row that persists.
          actions: [{ name: 'edit_file', target: `f${i}.js`, ok: true }],
        });
      }
      screen.state = { session: { turns }, transcript: [], liveActions: [], liveNarration: [] };
      screen.draw();

      const rows = anchors.rowsIn(screen.lastFeedLines);
      assert.strictEqual(rows.length, 8, 'one anchor per user message');

      screen.workspaceScroll = 0;
      screen.stickToBottom = false;
      const seen = [];
      for (let i = 0; i < 20; i++) {
        const before = screen.workspaceScroll;
        const moved = screen.jumpToAnchor(1);
        if (!moved) break;
        assert.notStrictEqual(screen.workspaceScroll, before,
          'a jump that reports success must actually move the viewport');
        seen.push(screen.workspaceScroll);
      }
      assert.ok(seen.length >= 6, `too few reachable anchors: ${JSON.stringify(seen)}`);
      // AND THE NEWEST MESSAGE IS ON SCREEN once the jumps run out — the point
      // of the feature is reaching it, not landing on its exact row.
      assert.strictEqual(screen.stickToBottom, true,
        'the end of the conversation must be in view when the jumps are exhausted');
      assert.strictEqual(screen.jumpToAnchor(1), false, 'and it says so rather than lying');
    } finally {
      screen.leave();
    }
  });

  await test('ANCHOR: a one-word answer is a DECISION', () => {
    for (const s of ['proceed', 'yes', 'no', 'go ahead', 'do it', 'continue', 'stop',
      'option B', 'B', '2', 'approved', 'retry', 'please proceed', 'ok']) {
      assert.strictEqual(anchors.kindOf(s), 'DECISION', s);
    }
  });

  await test('ANCHOR: an instruction is a MESSAGE, however short', () => {
    for (const s of [
      'the runner stops after the third file, find out why',
      'proceed with the second option but keep the old loader',
      'fix the parser',
      'why does it stop',
    ]) {
      assert.strictEqual(anchors.kindOf(s), 'MESSAGE', s);
    }
  });

  await test('ANCHOR: a paste is a REQUEST, not a decision and not a speech', () => {
    const payload = Array.from({ length: 40 }, (_, i) => `2026-01-01 12:00:0${i} runner: line ${i}`).join('\n');
    assert.strictEqual(anchors.kindOf(payload), 'REQUEST');
    assert.strictEqual(anchors.label(payload), 'USER REQUEST');
  });

  await test('ANCHOR: the label is what the feed draws over the block', () => {
    const out = [];
    feed.pushUser(out, 'proceed');
    const rows = feed.renderFeed(out, 80).join('\n');
    assert.ok(rows.includes('USER DECISION'), rows);
    assert.ok(rows.includes('proceed'), 'and the decision itself is still there');
  });

  await test('ANCHOR: a paste is LABELLED as a request, and drawn in full', () => {
    // ------------------------------------------------------------------
    // TWO PROPERTIES, AND ONLY ONE OF THEM CHANGED.
    //
    // The LABEL still comes from the bulk: `isPaste` is what tells this row
    // apart from a sentence, so a pasted log is a USER REQUEST and Alt+↑ can
    // jump to it. That is what anchors are for and it is untouched.
    //
    // What changed is the DRAWING. This used to assert that the feed showed
    // `[pasted text #1]` and NOT the payload. The collapse moved to the
    // composer (ui/composer.js) — where a wall of text actually destroys
    // something — and the transcript now shows what was sent, because a
    // transcript that cannot be read back is a transcript nobody can trust.
    // ------------------------------------------------------------------
    const NL = String.fromCharCode(10);
    const payload = Array.from({ length: 40 }, (_, i) => `line ${i} of a long pasted log`).join(NL);
    const out = [];
    feed.pushUser(out, payload);
    const lines = feed.renderFeed(out, 80);
    const text = lines.join(NL);
    assert.ok(text.includes('USER REQUEST'), text.slice(0, 200));
    assert.ok(!/pasted text/.test(text), 'the record is not collapsed');
    assert.ok(text.includes('line 30 of a long pasted log'), 'the payload is drawn');
    // AND IT STILL TRAVELS WITH EVERY ROW, so a click brings back the whole
    // message rather than the one line under the pointer.
    const at = lines.userAt;
    const carried = Object.keys(at).map((k) => at[k]);
    assert.ok(carried.some((v) => String(v).includes('line 30 of a long pasted log')),
      'every drawn row carries the full original');
  });

  await test('ANCHOR: an ordinary message keeps the plain USER label', () => {
    const out = [];
    feed.pushUser(out, 'the runner stops after the third file, find out why');
    const rows = feed.renderFeed(out, 80).join('\n');
    assert.ok(rows.includes('USER'), rows);
    assert.ok(!rows.includes('USER DECISION'), rows);
    assert.ok(!rows.includes('USER REQUEST'), rows);
  });

  await test('ANCHOR: only the FIRST row of a block is an anchor', () => {
    // Jumping to the middle of a three-line prompt is not jumping to the
    // prompt.
    const out = [];
    feed.pushUser(out, 'line one\nline two\nline three');
    const lines = feed.renderFeed(out, 80);
    const rows = anchors.rowsIn(lines);
    assert.strictEqual(rows.length, 1, `one anchor for one message, got ${rows.length}`);
  });

  await test('ANCHOR: several messages give several anchors, in order', () => {
    const out = [];
    feed.pushUser(out, 'first thing');
    feed.pushModel(out, 'Done.');
    feed.pushUser(out, 'proceed');
    feed.pushModel(out, 'Done again.');
    feed.pushUser(out, 'now the other one');
    const rows = anchors.rowsIn(feed.renderFeed(out, 80));
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(rows.slice().sort((a, b) => a - b), rows, 'in order');
  });

  await test('ANCHOR: Alt+↑ and Alt+↓ are decoded rather than swallowed', () => {
    const decode = require('../../src/keydecode');
    assert.strictEqual(decode.decodeEscape('\x1b[1;3A').key, 'alt-up');
    assert.strictEqual(decode.decodeEscape('\x1b[1;3B').key, 'alt-down');
  });

  await test('ANCHOR: jumping moves the feed to a message and stops following', () => {
    const { Screen } = require('../../src/ui/layout');
    const s = new Screen({ out: { columns: 80, rows: 30, isTTY: true, write() {}, on() {}, removeListener() {} } });
    const out = [];
    feed.pushUser(out, 'first thing');
    for (let i = 0; i < 40; i++) feed.pushModel(out, `a line of prose number ${i}`);
    feed.pushUser(out, 'proceed');
    for (let i = 0; i < 40; i++) feed.pushModel(out, `more prose number ${i}`);
    s.lastFeedLines = feed.renderFeed(out, 80);
    s.draw = () => {};
    s.stickToBottom = true;
    s.workspaceScroll = 0;
    assert.strictEqual(s.jumpToAnchor(1), true, 'there is a first message to jump to');
    const first = s.workspaceScroll;
    assert.strictEqual(s.stickToBottom, false, 'reading back means not following the live end');
    assert.strictEqual(s.jumpToAnchor(1), true, 'and a second one after it');
    assert.ok(s.workspaceScroll > first, `it moved forward: ${first} -> ${s.workspaceScroll}`);
    assert.strictEqual(s.jumpToAnchor(-1), true, 'and back again');
    assert.strictEqual(s.workspaceScroll, first);
    assert.strictEqual(s.jumpToAnchor(-1), false, 'nowhere further to go says so');
    assert.strictEqual(s.jumpToAnchor(1), true);
    assert.strictEqual(s.jumpToAnchor(1), false, 'and the same at the other end');
  });

  await test('SUMMARY: How to run and How to test are drawn as commands, not prose', () => {
    // A summary is read once, quickly, and the thing a person wants out of it
    // is the command. Rendered as ordinary prose those two lines are
    // indistinguishable from the eight around them.
    const md = require('../../src/ui/markdown');
    const rows = md.render([
      '## Summary',
      '',
      'Issue: the serializer emitted the 0.2 name.',
      '',
      '**How to run:** npm start',
      '- **How to test:** `npm test`',
    ], 70);
    const text = rows.join('\n');
    assert.ok(/HOW TO RUN/.test(text), text);
    assert.ok(/HOW TO TEST/.test(text), text);
    assert.ok(text.includes('npm start'));
    assert.ok(text.includes('npm test'));
  });

  await test('SUMMARY: a sentence that merely BEGINS "How to test" is left alone', () => {
    const md = require('../../src/ui/markdown');
    const line = 'How to test the parser is a separate question.';
    const rows = md.render(['# H', '', line], 90).join('\n');
    assert.ok(rows.includes(line), rows);
    assert.ok(!/HOW TO TEST/.test(rows), 'no callout for prose');
  });
};
