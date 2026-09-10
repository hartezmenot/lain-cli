'use strict';

/**
 * FOCUSED REGRESSION — the two things a recent pass fixed:
 *   1. Ctrl+C is a two-press exit that first CANCELS in-flight work.
 *   2. Progress is pinned beneath the objective, from COMPLETED work.
 *
 * The decision (interrupt.js) and the banner (views.taskBanner) are both pure,
 * so they are tested here without a terminal or a real clock. The end-to-end
 * behaviour through the real binary lives in the smoke tier.
 */

const assert = require('assert');
const { test } = require('../helpers');
const { onInterrupt, EXIT_CONFIRM_MS } = require('../../src/interrupt');
const views = require('../../src/ui/views');

function mkPlan(statuses) {
  return { steps: statuses.map((st, i) => ({ n: i + 1, text: `step ${i + 1}`, status: st, note: '' })), decisions: [] };
}
function sess({ objective = 'Fix the authentication flow', plan = null } = {}) {
  return { task: { objective }, plan };
}

module.exports = async function () {
  // ---- Ctrl+C: the two-press exit decision --------------------------------

  await test('INTERRUPT: while working, Ctrl+C CANCELS and never exits', () => {
    const d = onInterrupt({ working: true, armedAt: 0 }, 1000);
    assert.strictEqual(d.action, 'cancel');
    assert.strictEqual(d.armedAt, 0, 'cancelling does not arm the exit');
  });

  await test('INTERRUPT: an even armed state still cancels while work is in flight', () => {
    // A press that cancels must never be reinterpreted as the confirming press.
    const d = onInterrupt({ working: true, armedAt: 999 }, 1000);
    assert.strictEqual(d.action, 'cancel');
  });

  await test('INTERRUPT: idle, first press ARMS — it does not exit', () => {
    const d = onInterrupt({ working: false, armedAt: 0 }, 5000);
    assert.strictEqual(d.action, 'arm');
    assert.strictEqual(d.armedAt, 5000, 'remembers when it was armed');
  });

  await test('INTERRUPT: second press INSIDE the window exits', () => {
    const armedAt = 5000;
    const d = onInterrupt({ working: false, armedAt }, armedAt + EXIT_CONFIRM_MS - 1);
    assert.strictEqual(d.action, 'exit');
    assert.strictEqual(d.armedAt, 0);
  });

  await test('INTERRUPT: confirmation TIMES OUT — a late press re-arms, never exits', () => {
    const armedAt = 5000;
    const d = onInterrupt({ working: false, armedAt }, armedAt + EXIT_CONFIRM_MS + 1);
    assert.strictEqual(d.action, 'arm', 'past the window it is a fresh first press');
    assert.strictEqual(d.armedAt, armedAt + EXIT_CONFIRM_MS + 1);
  });

  await test('INTERRUPT: the window is a deliberate 1–2 seconds', () => {
    assert.ok(EXIT_CONFIRM_MS >= 1000 && EXIT_CONFIRM_MS <= 2000, `got ${EXIT_CONFIRM_MS}ms`);
  });

  // ---- WHERE THE PINNED TASK BANNER WENT ----------------------------------
  //
  // It drew the objective and a `STEP 3/5 ████░░ 60%` bar above the feed, on
  // two of the nine panes, permanently. Against the six questions a permanent
  // region has to answer it answered none: the objective IS the first thing the
  // user said, so the conversation says it, and the plan's progress is `/plan`.
  //
  // THE MEASUREMENT SURVIVED THE RENDERING, and this is where that is held.
  // `progressOf` is the thing these tests were ever really about — progress is
  // COMPLETED work, never the active step index — and it is still read by
  // `/plan`, `/copy` and ui/briefview.js. A percentage that reports work as
  // finished the moment it begins is the one thing a progress indicator must
  // never do, and it does not stop mattering because the banner is gone.

  await test('PROGRESS: no plan means no percentage — nothing is invented', () => {
    const p = views.progressOf(views.livePlan(sess({ plan: null })));
    assert.ok(!p || !p.known, 'a made-up number is worse than admitting the total is unknown');
  });

  await test('PROGRESS: 0% — five steps, none done is 0%, not 20%', () => {
    const p = views.progressOf(mkPlan(['active', 'todo', 'todo', 'todo', 'todo']));
    assert.strictEqual(p.percent, 0, 'starting step 1 of 5 has completed nothing');
    assert.strictEqual(p.current, 1, 'and it is still STEP 1 of 5');
    assert.strictEqual(p.total, 5);
    assert.ok(/░/.test(views.bar(p.percent)) && !/█/.test(views.bar(p.percent)), 'an empty bar');
  });

  await test('PROGRESS: two of five done is STEP 3 of 5 and 40%', () => {
    const p = views.progressOf(mkPlan(['done', 'done', 'active', 'todo', 'todo']));
    assert.strictEqual(p.percent, 40);
    assert.strictEqual(p.current, 3);
    const b = views.bar(p.percent);
    assert.ok(/█/.test(b) && /░/.test(b), 'a partially filled bar');
  });

  await test('PROGRESS: a finished PLAN is 100% and never says DONE', () => {
    const p = views.progressOf(mkPlan(['done', 'done', 'done']));
    assert.strictEqual(p.percent, 100);
    const b = views.bar(p.percent);
    assert.ok(/█/.test(b) && !/░/.test(b), 'a full bar');
    // A FINISHED PLAN IS NOT A FINISHED TASK. A bar reading DONE beside a task
    // that is still verifying is the progress indicator lying about the one
    // thing it must never lie about.
    assert.ok(!/\bDONE\b/.test(b + views.progressCompact(p, 40)),
      'the plan\'s progress must not claim the task is done');
  });

  await test('PROGRESS: the compact form keeps step, bar and percent on one short line', () => {
    const p = views.progressOf(mkPlan(['done', 'done', 'active', 'todo', 'todo']));
    const row = views.progressCompact(p, 40);
    assert.ok(/STEP 3\/5/.test(row), row);
    assert.ok(/40%/.test(row), row);
    assert.ok(/[█░]/.test(row), 'still carries a bar');
    assert.ok(require('../../src/ui/text').width(row) <= 40, `fits 40 cols: ${row}`);
  });

  await test('PROGRESS: `/plan` is where the bar is drawn now', () => {
    // §12: the pane went, the capability did not. The command that replaced it
    // must actually render the measurement, or this is all unreachable code.
    const lines = views.planView({ plan: mkPlan(['done', 'done', 'active', 'todo', 'todo']), width: 80 });
    const text = require('../../src/ui/text').strip(lines.join(String.fromCharCode(10)));
    assert.ok(/40%/.test(text), `the percentage must be on the plan view:\n${text}`);
    assert.ok(/[█░]/.test(text), 'and the bar with it');
  });
};
