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

  // ---- the pinned task banner ---------------------------------------------

  await test('BANNER: no task means no banner (the launch screen owns that)', () => {
    assert.deepStrictEqual(views.taskBanner({ session: { task: null }, width: 80 }), []);
  });

  await test('BANNER: a task with no plan shows the objective but NO invented progress', () => {
    const b = views.taskBanner({ session: sess({ plan: null }), width: 80 });
    // The objective now shares its row with the `TASK` label rather than
    // occupying a row of its own beneath it.
    assert.ok(b.some((l) => l.includes('Fix the authentication flow')), 'the objective is shown');
    assert.ok(!b.some((l) => /%/.test(l)), 'no percentage without a plan to measure');
    assert.ok(!b.some((l) => /STEP/.test(l)), 'no step count without a plan');
  });

  await test('BANNER: 0% — five steps, none done reads STEP 1 / 5 and 0% (not 20%)', () => {
    const b = views.taskBanner({ session: sess({ plan: mkPlan(['active', 'todo', 'todo', 'todo', 'todo']) }), width: 80 });
    const s = b.join('\n');
    assert.ok(/STEP 1\/5/.test(s), s);
    assert.ok(/\b0%/.test(s), s);
    assert.ok(!/20%/.test(s), 'progress is completed work, never the active index');
    assert.ok(b.some((l) => /░/.test(l) && !/█/.test(l)), 'an empty bar');
    // The banner is TWO rows now: the objective on the first, progress on the
    // second. It was nine rows of chrome for three facts, which left five rows
    // for the activity feed on an 80x24 terminal.
    assert.ok(b[0].startsWith('TASK') && b[0].includes('Fix the authentication'), b[0]);
    assert.ok(b.length <= 3, `the banner grew back to ${b.length} rows`);
  });

  await test('BANNER: intermediate — two of five done reads STEP 3 / 5 and 40%', () => {
    const b = views.taskBanner({ session: sess({ plan: mkPlan(['done', 'done', 'active', 'todo', 'todo']) }), width: 80 });
    const s = b.join('\n');
    assert.ok(/STEP 3\/5/.test(s), s);
    assert.ok(/40%/.test(s), s);
    assert.ok(b.some((l) => /█/.test(l) && /░/.test(l)), 'a partially filled bar');
  });

  await test('BANNER: all steps done reads 100% — and never the word DONE', () => {
    const b = views.taskBanner({ session: sess({ plan: mkPlan(['done', 'done', 'done']) }), width: 80 });
    const s = b.join('\n');
    assert.ok(/100%/.test(s), s);
    assert.ok(b.some((l) => /█/.test(l) && !/░/.test(l)), 'a full bar');
    assert.match(s, /STEP 3\/3/, 'the step count says as much and claims nothing');
    // THE PROGRESS BAR IS THE PLAN'S, AND A FINISHED PLAN IS NOT A FINISHED
    // TASK. This asserted the opposite — that a full bar reads "DONE" — and a
    // bar reading DONE beside a task that is still verifying is the progress
    // indicator lying about the one thing it must never lie about.
    assert.ok(!/\bDONE\b/.test(s), `the plan's progress must not claim the task is done:\n${s}`);
  });

  await test('BANNER: compact form keeps step, bar and percent on one short line', () => {
    const b = views.taskBanner({ session: sess({ plan: mkPlan(['done', 'done', 'active', 'todo', 'todo']) }), width: 40, compact: true });
    assert.ok(b.length <= 2, `compact is at most two lines, got ${b.length}`);
    const prog = b[b.length - 1];
    assert.ok(/STEP 3\/5/.test(prog), prog);
    assert.ok(/40%/.test(prog), prog);
    assert.ok(/[█░]/.test(prog), 'still carries a bar');
    for (const l of b) assert.ok(l.length <= 40, `fits 40 cols: ${l.length}`);
  });
};
