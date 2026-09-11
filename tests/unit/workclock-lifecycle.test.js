'use strict';

/**
 * THE EXECUTION CLOCK, THROUGH ITS WHOLE LIFECYCLE.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THESE WERE WRITTEN AGAINST, reproduced from a real screenshot.
 *
 * The live row showed `↑86M ⚡16M ↓3.7M  00:00:00` — a token cluster that was
 * moving beside an elapsed figure that was not. The clock was not slow and it
 * was not mis-formatted: it was STOPPED, at zero, for the entire turn.
 *
 * THE CHAIN, and it is two faults compounding:
 *
 *   1. `projection.clock` advances the clock from `termtitle.stateOf(liveState)`.
 *      `stateOf` returns SUCCESS when `live.tick` is set, and `tick` comes from
 *      the PREVIOUS turn's record. There is a real gap between the user pressing
 *      Enter and the turn loop announcing its first phase — and in that gap the
 *      strip is still describing the turn before. So the first frame of every
 *      turn after a clean one classified as SUCCESS, and `apply` called
 *      `settle()` on a clock that had just been started.
 *
 *   2. `resume()` only revives a PAUSED clock. A STOPPED one stays stopped. So
 *      the mistake in (1) was permanent: every later `apply('working')` was a
 *      no-op and the figure never left `00:00:00`.
 *
 * THE FIX IS THE CONTRACT, NOT THE SYMPTOM. projection.js already states the
 * rule in its own header — "WHAT IS NOT HERE: starting and stopping. Only the
 * turn lifecycle knows that a person pressed Enter" — and then `apply` stopped
 * the clock anyway. One owner of terminal state: ui/turnstate.js.
 */

const assert = require('assert');
const { test } = require('../helpers');

const wc = require('../../src/ui/workclock');


/**
 * A REAL App and its REAL UI. The fault was in how turnstate, projection and
 * workclock COMPOSE, so a hand-built double would have reproduced nothing.
 */
function realUi() {
  const { App } = require('../../src/app');
  const turnstate = require('../../src/ui/turnstate');
  const app = new App({
    out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false },
    interactive: false,
    cwd: process.cwd(),
  });
  app.ui.enabled = true;
  return { app, ui: app.ui, turnstate };
}

module.exports = async function () {
  // ------------------------------------------------------------- the unit --

  await test('CLOCK: a new turn starts at zero and ticks with wall time', () => {
    const c = wc.create();
    assert.strictEqual(wc.reading(c).shown, false, 'an unstarted clock shows nothing');
    wc.start(c, 1000);
    assert.strictEqual(wc.elapsed(c, 1000), 0);
    assert.strictEqual(wc.elapsed(c, 6000), 5000);
    assert.strictEqual(wc.reading(c, 6000).text, '00:00:05');
  });

  await test('CLOCK: it cannot be advanced by drawing', () => {
    const c = wc.start(wc.create(), 1000);
    assert.strictEqual(wc.elapsed(c, 4000), wc.elapsed(c, 4000), 'reading twice reads the same');
  });

  await test('CLOCK: a pause banks the value and holds it', () => {
    const c = wc.start(wc.create(), 0);
    wc.pause(c, 5000);
    assert.strictEqual(wc.elapsed(c, 5000), 5000);
    assert.strictEqual(wc.elapsed(c, 99000), 5000, 'a rate limit is not work');
    wc.resume(c, 99000);
    assert.strictEqual(wc.elapsed(c, 100000), 6000, 'it continues from the banked figure');
  });

  await test('CLOCK: settling keeps the value — a receipt does not blank itself', () => {
    const c = wc.start(wc.create(), 0);
    wc.settle(c, 8000);
    assert.strictEqual(wc.elapsed(c, 60000), 8000);
    assert.strictEqual(wc.reading(c, 60000).running, false);
  });

  // ------------------------------------------------- the compounding fault --

  await test('CLOCK: a STOPPED clock can be revived by work, not left dead at zero', () => {
    // FAULT 2. Without this, any mistaken settle is permanent — and fault 1
    // guaranteed a mistaken settle on the first frame of every turn.
    const c = wc.start(wc.create(), 0);
    wc.settle(c, 0);                       // the stale-SUCCESS mis-settle
    assert.strictEqual(wc.elapsed(c, 5000), 0, 'it really was stopped at zero');
    wc.resume(c, 5000);
    assert.strictEqual(wc.reading(c, 5000).running, true, 'work must be able to restart it');
    assert.strictEqual(wc.elapsed(c, 9000), 4000, 'and it counts from the banked figure');
  });

  await test('CLOCK: `apply` never settles — terminal state belongs to the turn lifecycle', () => {
    // FAULT 1, asserted as the CONTRACT rather than as the symptom.
    // projection.js states this rule in its own header; `apply` violated it.
    const c = wc.start(wc.create(), 0);
    wc.apply(c, 'success', 3000);
    assert.strictEqual(wc.reading(c, 3000).running, true,
      'a stale SUCCESS from the previous turn must not stop this turn\'s clock');
    wc.apply(c, 'error', 4000);
    assert.strictEqual(wc.reading(c, 4000).running, true,
      'nor may an error word — only endTurn settles');
    assert.strictEqual(wc.elapsed(c, 9000), 9000);
  });

  await test('CLOCK: `apply` still runs and pauses from the authoritative word', () => {
    const c = wc.start(wc.create(), 0);
    wc.apply(c, 'paused', 2000);
    assert.strictEqual(wc.reading(c, 2000).paused, true);
    assert.strictEqual(wc.elapsed(c, 60000), 2000, 'a paused clock does not count');
    wc.apply(c, 'working', 60000);
    assert.strictEqual(wc.elapsed(c, 61000), 3000);
    wc.apply(c, 'idle', 62000);
    assert.strictEqual(wc.reading(c, 62000).running, true, 'idle is a gap, not an ending');
  });

  // ------------------------------------------------ the real turn lifecycle --

  await test('CLOCK: the real UI ticks across a turn that follows a clean one', () => {
    // THE REGRESSION ITSELF, driven through the real turnstate and projection
    // rather than through the unit above — the fault was in how they compose.
    const { app, ui, turnstate } = realUi();

    // A PREVIOUS TURN THAT ENDED CLEANLY — this is what sets `tick`.
    app.session.turns.push({ turnId: 't1', stopReason: 'end', text: 'done', usage: {}, actions: [], narration: [] });

    turnstate.beginTurn(ui);
    const started = wc.elapsed(ui.clock);
    // Advance the clock the way a frame does: through the projection.
    require('../../src/ui/projection').clock(ui);
    // The clock must still be alive after a frame drawn in the gap before the
    // first phase arrives — the exact moment the stale SUCCESS lands.
    assert.strictEqual(ui.clock.state, 'RUNNING',
      `the clock died on the first frame of the turn (state ${ui.clock.state})`);
    assert.ok(wc.elapsed(ui.clock) >= started, 'and it is still counting');

    turnstate.endTurn(ui);
    assert.strictEqual(ui.clock.state, 'STOPPED', 'the turn lifecycle stops it, and only it');
  });

  await test('CLOCK: a second turn resets to zero rather than inheriting the first', () => {
    const { app, ui, turnstate } = realUi();
    turnstate.beginTurn(ui);
    ui.clock.accumulated = 45_000;          // as if the first turn took 45s
    turnstate.endTurn(ui);
    assert.ok(wc.elapsed(ui.clock) >= 45_000);
    turnstate.beginTurn(ui);
    assert.ok(wc.elapsed(ui.clock) < 1000, 'a second submission is a second task');
  });

  // -------------------------------------------------------- ONE AUTHORITY --

  await test('CLOCK: exactly ONE module computes elapsed work time', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'src', 'ui');
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      if (f === 'workclock.js') continue;
      const code = fs.readFileSync(path.join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // A SECOND SUBTRACTION OFF A START STAMP is the shape of the duplicate
      // this pass removed: `ui.startedAt ? Date.now() - ui.startedAt : 0` sat in
      // projection.js beside the real clock, and nothing said which was true.
      if (/Date\.now\(\)\s*-\s*\w*\.?startedAt/.test(code)) offenders.push(f);
    }
    assert.deepStrictEqual(offenders, [],
      `a second elapsed-time source in: ${offenders.join(', ')} — every surface must read ui/workclock.js`);
  });
};
