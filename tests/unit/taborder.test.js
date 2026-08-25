'use strict';

/**
 * THE TAB ORDER — one list, and the number on screen means what it says.
 *
 * The order was written out four times: the Tab cycle, the strip that draws the
 * numbers, the Alt+N bindings, and the mouse hit-test. Four copies of an
 * ordered list is four chances for `4 output` to be printed while Alt+4 opens
 * FILES and a click on it selects something else again — and every one of those
 * disagreements reads to a user as "the tabs are broken", which is
 * indistinguishable from navigation genuinely not working.
 *
 * These hold the required order, and hold every surface to it.
 */

const assert = require('assert');
const { test } = require('../helpers');

const tabs = require('../../src/ui/tabs');
const T = require('../../src/ui/text');
const { Screen } = require('../../src/ui/layout');

/**
 * ACTIVITY LEADS, AND CONTEXT IS SECOND.
 *
 * They answer two different questions and the pane LAIN lands on has to be the
 * one whose answer cannot wait: ACTIVITY is what LAIN is doing — the model's
 * prose, the tool calls, the failures — and a reply nobody can see is
 * indistinguishable from an agent that did nothing. CONTEXT is what is TRUE,
 * which keeps just as well one keypress away.
 *
 * With CONTEXT leading, keeping the reply on screen meant drawing a second
 * bounded copy of the feed underneath the briefing, which made the landing pane
 * a worse ACTIVITY and a worse CONTEXT at once. One pane, one question.
 *
 * DETAIL WAS ADDED DELIBERATELY, at the end.
 *
 * CONTEXT was rendering the whole project survey — every finding with its
 * explanation, every changed file, the environment, the list of axes nobody
 * measured — which buried the one line that mattered inside a page of true,
 * low-value discovery output. The survey did not shrink; it grew a second
 * rendering. DETAIL is where the evidence went, and it sits last because it is
 * somewhere you go deliberately, not somewhere you pass through.
 *
 * AND TOKENS AFTER IT, for the same reason and from a real incident: a session
 * reached 815 requests and 59.2M input tokens against 202K output, and no
 * screen could have shown that while it happened. It is an instrument you go to
 * when the bill or the request size is the question.
 *
 * IT DID NOT REPLACE MEMORY OR DETAIL. Both were inspected before this list
 * grew: MEMORY is the only view of what `/note` recorded, and DETAIL carries
 * the rows behind CONTEXT's counts, which by construction appear nowhere else.
 * Neither is redundant, so neither was removed.
 */
const REQUIRED = ['activity', 'context', 'plan', 'diff', 'output', 'files', 'memory', 'detail', 'tokens'];

/** Where every walk starts. Written once, from the list above. */
const FIRST = REQUIRED[0];

function screen(view) {
  const s = new Screen({ out: { columns: 110, rows: 30, isTTY: true, write() {}, on() {}, removeListener() {} } });
  s.view = view;
  return s;
}

module.exports = async function () {
  await test('TABS: the order is exactly ACTIVITY CONTEXT PLAN DIFF OUTPUT FILES MEMORY DETAIL TOKENS', () => {
    assert.deepStrictEqual([...tabs.VIEWS], REQUIRED);
  });

  await test('TABS: Tab walks forward through every pane and wraps', () => {
    // Counted from REQUIRED rather than from a literal, so adding a pane
    // changes the list in ONE place — which is the rule this whole file holds.
    let v = FIRST;
    const seen = [v];
    for (let i = 0; i < REQUIRED.length; i++) { v = tabs.step(v, 1); seen.push(v); }
    assert.deepStrictEqual(seen, [...REQUIRED, FIRST]);
  });

  await test('TABS: Shift+Tab walks backward through every pane and wraps', () => {
    let v = FIRST;
    const seen = [v];
    for (let i = 0; i < REQUIRED.length; i++) { v = tabs.step(v, -1); seen.push(v); }
    assert.deepStrictEqual(seen, [FIRST, ...[...REQUIRED].slice(1).reverse(), FIRST]);
  });

  await test('TABS: the NUMBER in the strip is the number Alt+N opens', () => {
    // `4 output` in the strip and Alt+4 opening OUTPUT are the same fact, and
    // they were two hand-written lists.
    for (let n = 1; n <= REQUIRED.length; n++) {
      assert.strictEqual(tabs.byNumber(n), REQUIRED[n - 1], `Alt+${n}`);
      assert.strictEqual(tabs.numberOf(REQUIRED[n - 1]), n);
    }
  });

  await test('TABS: the drawn strip numbers the panes in that same order', () => {
    const line = T.strip(screen(FIRST).tabsLine(110));
    // Every pane, numbered, in order, on the real strip.
    for (let n = 1; n <= REQUIRED.length; n++) {
      assert.ok(line.includes(`${n} ${REQUIRED[n - 1]}`), `strip is missing "${n} ${REQUIRED[n - 1]}": ${line}`);
    }
    // And they appear left to right in that order, not merely present.
    let at = -1;
    for (const name of REQUIRED) {
      const i = line.indexOf(name);
      assert.ok(i > at, `${name} is out of order in the strip: ${line}`);
      at = i;
    }
  });

  await test('TABS: the active pane is bracketed, and only the active one', () => {
    for (const v of REQUIRED) {
      const line = T.strip(screen(v).tabsLine(110));
      assert.ok(line.includes(`[${tabs.numberOf(v)} ${v}]`), `${v} is not marked active: ${line}`);
      assert.strictEqual((line.match(/\[/g) || []).length, 1, `more than one pane looks active: ${line}`);
    }
  });

  await test('TABS: a CLICK selects the same pane the number promises', () => {
    // The hit-test walks the same labels the strip draws, so clicking `4 output`
    // must give OUTPUT — not the fourth entry of some other list.
    const { tabAt } = require('../../src/ui/mouse');
    for (const active of [FIRST, 'output']) {
      let col = 3;                                   // the strip opens with `┌─`
      for (const name of tabs.VIEWS) {
        const label = name === active
          ? `[${tabs.numberOf(name)} ${name}]`
          : ` ${tabs.numberOf(name)} ${name} `;
        // A click anywhere on the label picks that pane.
        for (const x of [col, col + Math.floor(label.length / 2), col + label.length - 1]) {
          assert.strictEqual(tabAt(active, x), name,
            `click at column ${x} while ${active} is active should select ${name}`);
        }
        col += label.length;
      }
    }
  });

  await test('TABS: keyboard and mouse read the SAME list, not two copies', () => {
    const { VIEWS } = require('../../src/ui/mouse');
    assert.strictEqual(VIEWS, tabs.VIEWS, 'the mouse must hold the identical array, not an equal one');
  });

  await test('TABS: no other module spells the order out for itself', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'src');
    const offenders = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js') || p.endsWith(`ui${path.sep}tabs.js`)) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/\[\s*'context',\s*'plan',\s*'diff'/.test(src)) offenders.push(path.relative(dir, p));
      }
    };
    walk(dir);
    assert.deepStrictEqual(offenders, [], 'these keep a private copy of the tab order');
  });
};
