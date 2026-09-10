'use strict';

/**
 * RHYTHM, AND A PINNED PROMPT — dividers and the turn anchor.
 *
 * ------------------------------------------------------------------------
 * TWO SMALL THINGS THAT MAKE A LONG SESSION READABLE, and both are easy to get
 * wrong in the same direction — by becoming chrome.
 *
 * A DIVIDER marks where one exchange ends and the next begins. Between every
 * paragraph it would be card borders arrived at by another route; at the only
 * boundary that is actually major it is rhythm.
 *
 * THE ANCHOR is a pinned one-line preview of the prompt the running turn came
 * from, once that prompt has scrolled away. It went through two wrong shapes on
 * the way here: `USER DECISION · continue` in bold read as a second header, and
 * `↑ user` was quiet enough to say nothing at all — a person could not tell which
 * turn it went back to, which is the only thing they need from it.
 */

const assert = require('assert');
const { test } = require('../helpers');

const feed = require('../../src/ui/feed');
const anchors = require('../../src/ui/anchors');
const views = require('../../src/ui/views');
const T = require('../../src/ui/text');
const { Screen } = require('../../src/ui/layout');

const LF = String.fromCharCode(10);
const strip = (x) => T.strip(String(x));
const RULE = /^─{8,}\s*$/;

function fakeOut(cols, rows) {
  const buf = [];
  return {
    columns: cols, rows, isTTY: true, on() {}, removeListener() {},
    write(s) { buf.push(s); return true; }, buf,
  };
}

/** A conversation of `n` exchanges, each with prose and a kept call. */
function exchanges(n) {
  const turns = [];
  for (let i = 1; i <= n; i++) {
    turns.push({
      userInput: 'request number ' + i,
      text: 'Answer ' + i + '.',
      narration: [{ step: 0, text: 'Answer ' + i + ', with a sentence of explanation after it.' }],
      actions: [{ step: 0, name: 'edit_file', target: 'f' + i + '.js', ok: true }],
    });
  }
  return { turns };
}

module.exports = async function () {
  // ------------------------------------------------------------- dividers --

  await test('DIVIDER: one between exchanges, and none before the first', () => {
    const rows = views.activity({ session: exchanges(3), width: 90 }).map(strip);
    const at = rows.map((r, i) => (RULE.test(r) ? i : -1)).filter((i) => i >= 0);
    // Three exchanges have two boundaries between them.
    assert.strictEqual(at.length, 2, 'one divider per boundary: ' + JSON.stringify(at));
    assert.ok(at[0] > 0, 'nothing is divided off the top of the screen');
    // AND EACH ONE IS IMMEDIATELY BEFORE A USER TURN, which is the boundary.
    for (const i of at) {
      const next = rows.slice(i + 1).find((r) => r.trim());
      assert.match(next, /^USER/, 'a divider opens an exchange: ' + JSON.stringify(next));
    }
  });

  await test('DIVIDER: not between every paragraph, and not inside an exchange', () => {
    const out = [];
    feed.pushUser(out, 'fix it');
    feed.pushModel(out, ['First paragraph.', '', 'Second paragraph.', '', 'Third.'].join(LF));
    feed.pushAction(out, { name: 'edit_file', target: 'a.js', ok: true });
    feed.pushNote(out, 'a note about it', 'info');
    const rows = feed.renderFeed(out, 90).map(strip);
    assert.strictEqual(rows.filter((r) => RULE.test(r)).length, 0,
      'one exchange carries no dividers at all:' + LF + rows.join(LF));
  });

  await test('DIVIDER: it never lands inside code or a diagram', () => {
    const out = [];
    feed.pushUser(out, 'draw it');
    feed.pushModel(out, ['```', '      A', '      |', '      v', '      B', '```'].join(LF));
    const rows = feed.renderFeed(out, 90).map(strip);
    const at = rows.findIndex((r) => RULE.test(r));
    assert.strictEqual(at, -1, 'a fenced block is never divided');
    // And the figure survived whole.
    for (const row of ['      A', '      |', '      v', '      B']) {
      assert.ok(rows.some((r) => r.includes(row)), 'the figure lost ' + JSON.stringify(row));
    }
  });

  await test('DIVIDER: it is inside the frame, and lighter than the content', () => {
    const saved = process.env.LAIN_NO_COLOR;
    delete process.env.LAIN_NO_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      for (const cols of [60, 80, 120, 200]) {
        const box = views.contentBounds(cols);
        const rows = views.activity({ session: exchanges(2), width: box.width });
        const rule = rows.find((r) => RULE.test(strip(r)));
        assert.ok(rule, 'a divider was drawn at ' + cols);
        // NEVER WIDER THAN THE FRAME IT SITS IN.
        assert.ok(T.width(strip(rule)) <= box.width,
          'the divider crossed the frame at ' + cols);
        // AND SHORTER THAN IT ON A WIDE TERMINAL: a rule spanning two hundred
        // columns is a wall, and this is for rhythm.
        if (cols >= 160) {
          assert.ok(T.width(strip(rule)) < box.width * 0.7,
            'the divider is a wall at ' + cols + ': ' + T.width(strip(rule)));
        }
        // DIM, so it is lighter than anything it separates.
        assert.match(rule, /\x1b\[2m/, 'the divider is dim at ' + cols);
      }
    } finally {
      delete process.env.LAIN_FORCE_COLOR;
      if (saved !== undefined) process.env.LAIN_NO_COLOR = saved;
    }
  });

  // --------------------------------------------------------------- anchor --

  await test('ANCHOR: it previews the REAL prompt, not a label', () => {
    const lines = ['a', 'b', 'c'];
    Object.defineProperty(lines, 'userAt', {
      value: { 2: 'continue with the Toralink smoke test' }, enumerable: false,
    });
    const a = anchors.scrollAnchor(lines, 0, 1);
    assert.ok(a, 'the anchor appears');
    assert.match(a.mark, /^USER · /, 'it names who, then quotes them');
    assert.match(a.mark, /continue with the Toralink smoke test/,
      'and the quotation is the submitted text');
  });

  await test('ANCHOR: exactly one line, truncated with an ellipsis', () => {
    const long = 'investigate the Toralink startup issue and verify the smoke tests pass '
      + 'end to end, then report what the loader was actually doing';
    const lines = ['x'];
    Object.defineProperty(lines, 'userAt', { value: { 0: long }, enumerable: false });
    const a = anchors.scrollAnchor(lines, 1, 1);
    assert.ok(a.mark.indexOf(LF) < 0, 'never two lines');
    assert.ok(T.width(a.mark) < T.width(long), 'it is shortened');
    assert.match(a.mark, /…$/, 'and says so');
    assert.strictEqual(a.text, long, 'while the full message travels with it');
  });

  await test('ANCHOR: a multi-line prompt is normalised to one line', () => {
    const multi = ['fix the loader', '', 'and then the writer', '', 'then report'].join(LF);
    assert.strictEqual(anchors.preview(multi), 'fix the loader and then the writer then report');
  });

  await test('ANCHOR: a pasted prompt keeps the typed line and MARKS the wall', () => {
    const composer = require('../../src/ui/composer');
    const wall = ['fix this issue', ''].concat(new Array(80).fill('traceback line here')).join(LF);
    const p = anchors.preview(wall, 80);
    assert.match(p, /^fix this issue/, 'the typed sentence survives');
    assert.ok(p.includes(composer.PLACEHOLDER), 'and the wall is marked, not quoted');
    assert.ok(!/traceback line here traceback/.test(p), 'the payload is not pasted into the row');
    assert.ok(p.indexOf(LF) < 0, 'one line');
  });

  await test('ANCHOR: terminal control sequences never reach the row', () => {
    const nasty = String.fromCharCode(27) + '[31mred' + String.fromCharCode(27) + '[0m text';
    const p = anchors.preview(nasty);
    assert.ok(!p.includes(String.fromCharCode(27)), 'no escape survives into the anchor');
    assert.match(p, /red text/);
  });

  await test('ANCHOR: it is drawn on its own ground, inside the frame, one row', () => {
    const saved = process.env.LAIN_NO_COLOR;
    delete process.env.LAIN_NO_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      for (const cols of [80, 120, 200]) {
        const out = fakeOut(cols, 24);
        const s = new Screen({ out });
        s.enter();
        try {
          s.state = {
            cwd: process.cwd(), session: exchanges(6), model: 'm', provider: 'p', connection: {},
            transcript: [], liveActions: [], liveNarration: [], liveNotes: [],
            liveUser: null, extras: [], current: null,
          };
          s.draw();
          s.workspaceScroll = 0;
          s.stickToBottom = false;
          out.buf.length = 0;
          s.draw();
          const raw = out.buf.join('');
          const rule = new RegExp(String.fromCharCode(27) + '\\[2;(\\d+)H('
            + '(?:[^' + String.fromCharCode(27) + ']|' + String.fromCharCode(27)
            + '\\[(?!\\d+;\\d+H)[0-9;?]*[A-Za-z])*)').exec(raw);
          assert.ok(rule, 'the header rule was drawn at ' + cols);
          const col = Number(rule[1]);
          const body = rule[2];
          const seen = strip(body).replace(new RegExp(String.fromCharCode(27) + '\\[K'), '');
          assert.match(seen, /USER · request number 6/, 'the anchor previews the newest prompt');
          // ONE ROW, INSIDE THE FRAME, and never to the physical edge.
          assert.strictEqual(col, s.rowMap.contentCol, 'the anchor starts at the frame');
          assert.ok(T.width(seen) <= s.rowMap.contentWidth,
            'the anchor crossed the frame at ' + cols);
          // ITS OWN GROUND, and only the logical row — the rule picks up after it.
          assert.match(body, /\x1b\[48;5;236m/, 'the anchor has a subtle ground');
          assert.ok(/─/.test(seen), 'and the rule continues past it');
        } finally { s.leave(); }
      }
    } finally {
      delete process.env.LAIN_FORCE_COLOR;
      if (saved !== undefined) process.env.LAIN_NO_COLOR = saved;
    }
  });

  await test('ANCHOR: it comes from the submitted message, never from a summary', () => {
    // The feed's own index is the source: drawn-row to the message that produced
    // it. A task name, an objective or a plan step can all drift from what was
    // actually asked, and an anchor that lies about its destination is worse than
    // no anchor at all.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'anchors.js'), 'utf8');
    assert.match(src, /lines\.userAt/, 'the target comes from the drawn feed index');
    for (const wrong of ['task.objective', 'plan.steps', 'session.task']) {
      assert.ok(!src.includes(wrong), 'the anchor must not read ' + wrong);
    }
  });
};
