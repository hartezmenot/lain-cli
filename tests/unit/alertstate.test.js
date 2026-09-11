'use strict';

/**
 * A STALE ALERT MUST NOT OUTLIVE THE ATTEMPT IT DESCRIBED.
 *
 * Every test here was written against a defect that was real on the screen:
 * a rate-limit countdown that kept the live row through the next turn, a clock
 * that went back to zero when a person said `continue`, and a failure taxonomy
 * that existed and was thrown away one function before it was read.
 *
 * THE UI DOUBLE IS THE REAL SHAPE, not a mock of the functions under test.
 * `beginTurn` reaches into `story`, `activity`, `clock` and `app`, so the
 * double provides those and nothing else — if the lifecycle grows a new
 * dependency this fails loudly rather than passing against a stub that
 * absorbed it.
 */

const assert = require('assert');
const { test } = require('../helpers');

const alert = require('../../src/ui/alert');
const turnstate = require('../../src/ui/turnstate');
const workclock = require('../../src/ui/workclock');
const status = require('../../src/ui/status');

/** A UI with exactly the surface the turn lifecycle touches. */
function makeUi() {
  const ui = {
    enabled: true,
    clock: workclock.create(),
    story: { beginTurn() {}, endTurn() {}, newTask() {} },
    activity: { reset() {} },
    app: { session: { actors: [] }, abort: null },
    liveUsage: null,
    liveOutput: null,
    interrupted: false,
    interrupting: false,
    retryCancelled: false,
    failed: false,
    waitingUntil: 0,
    waitingLabel: '',
    refreshes: 0,
    refresh() { this.refreshes++; },
    _syncTicker() {},
  };
  // THE REAL App POINTS BACK AT ITS UI, and `cancelPendingWait` reads
  // `app.ui.waitingUntil` — without this the double silently reports "no wait
  // pending" and the test proves nothing.
  ui.app.ui = ui;
  return ui;
}

const SAME = { sameTask: true, kind: 'CONTINUATION' };
const NEW = { sameTask: false, kind: 'NEW' };

module.exports = async function () {
  // ---------------------------------------------------------------- AMBER --

  await test('ALERT: RUNNING then PAUSED then "continue" keeps the same attempt clock', () => {
    const ui = makeUi();
    const t0 = 1_000_000;
    workclock.start(ui.clock, t0);
    workclock.pause(ui.clock, t0 + 257_000);          // 00:04:17 banked
    assert.strictEqual(workclock.reading(ui.clock, t0 + 900_000).text, '00:04:17',
      'a paused clock must hold its value while it waits');

    ui.waitingUntil = t0 + 999_000;                    // the amber alert rests
    assert.strictEqual(alert.resting(ui, t0 + 300_000).level, 'amber');
    assert.strictEqual(alert.attemptFor(ui, SAME, t0 + 300_000), alert.ATTEMPT.CONTINUE);

    turnstate.beginTurn(ui, SAME);

    assert.strictEqual(alert.resting(ui).level, null, 'the stale alert must be gone after submission');
    assert.strictEqual(ui.waitingUntil, 0, 'the countdown must not outrank the new turn');
    const after = workclock.reading(ui.clock);
    assert.ok(after.running, 'the same attempt is running again');
    assert.ok(after.ms >= 257_000, `the clock restarted at ${after.text} — it must continue from 00:04:17`);
  });

  await test('ALERT: a resting countdown no longer covers the new turn in liveState', () => {
    const ui = makeUi();
    const now = 2_000_000;
    ui.waitingUntil = now + 38_000;
    // BEFORE: waitingUntil outranks every other branch, so even a live phase
    // loses the row to a wait the person has already moved past.
    const stale = status.liveState({ waitingUntil: ui.waitingUntil, waitingLabel: 'x', phase: { phase: 'THINKING' } }, now);
    assert.strictEqual(stale.word, 'WAITING FOR LIMIT RESET', 'precedence is unchanged while the wait is real');
    // AFTER: submission clears it, so the same projection reports the turn.
    turnstate.beginTurn(ui, SAME);
    const fresh = status.liveState({ waitingUntil: ui.waitingUntil, waitingLabel: '', phase: { phase: 'THINKING' } }, now);
    assert.notStrictEqual(fresh.word, 'WAITING FOR LIMIT RESET',
      'a cleared wait must not still own the live row');
  });

  await test('ALERT: an automatic resume clears the wait through the same field', () => {
    // The auto path is ui/waiting.js `done()`, which zeroes the same two
    // fields. Asserting on the FIELDS rather than on the timer keeps this
    // deterministic and still proves the projection goes quiet.
    const ui = makeUi();
    ui.waitingUntil = Date.now() + 6000;
    ui.waitingLabel = 'the provider is rate limited';
    assert.strictEqual(alert.resting(ui).word, 'WAITING FOR LIMIT RESET');
    ui.waitingUntil = 0; ui.waitingLabel = '';
    assert.strictEqual(alert.resting(ui).level, null, 'the amber alert is replaced, not appended');
  });

  // ------------------------------------------------------------------ RED --

  await test('ALERT: BLOCKED is resumable and keeps the attempt clock', () => {
    for (const kind of ['AUTH', 'RATE_LIMITED', 'CONTEXT_LIMIT']) {
      const ui = makeUi();
      const t0 = 3_000_000;
      workclock.start(ui.clock, t0);
      workclock.pause(ui.clock, t0 + 90_000);
      ui.failed = { kind, status: 401, message: 'refused' };

      const r = alert.resting(ui);
      assert.strictEqual(r.level, 'red', `${kind} is red`);
      assert.strictEqual(r.resumable, true, `${kind} must be BLOCKED, not terminal`);
      assert.strictEqual(alert.attemptFor(ui, SAME), alert.ATTEMPT.CONTINUE);

      turnstate.beginTurn(ui, SAME);
      assert.strictEqual(ui.failed, false, 'the stale red must be gone after submission');
      assert.ok(workclock.reading(ui.clock).ms >= 90_000,
        `${kind}: a blocked attempt that resumes must not lose its banked work`);
    }
  });

  await test('ALERT: a TERMINAL failure starts a new attempt at 00:00:00', () => {
    for (const kind of ['UNAVAILABLE', 'TIMEOUT', 'BAD_REQUEST', 'UNKNOWN']) {
      const ui = makeUi();
      const t0 = 4_000_000;
      workclock.start(ui.clock, t0);
      workclock.settle(ui.clock, t0 + 600_000);        // the attempt ended, failed
      ui.failed = { kind, status: 502, message: 'gateway' };

      const r = alert.resting(ui);
      assert.strictEqual(r.terminal, true, `${kind} must be terminal`);
      assert.strictEqual(alert.attemptFor(ui, SAME), alert.ATTEMPT.RESTART);

      turnstate.beginTurn(ui, SAME);
      assert.strictEqual(ui.failed, false, 'the stale red must not rest under the new attempt');
      assert.strictEqual(workclock.reading(ui.clock).text, '00:00:00',
        `${kind}: a retry is a NEW execution attempt and starts from zero`);
    }
  });

  await test('ALERT: a bare boolean failure is terminal, never guessed resumable', () => {
    const ui = makeUi();
    ui.failed = true;                                   // no kind survived
    assert.strictEqual(alert.blocked(true), false);
    assert.strictEqual(alert.resting(ui).terminal, true,
      'an unclassified failure must not fold a previous attempt into a new one');
  });

  // -------------------------------------------------------- STEER / OTHER --

  await test('ALERT: /steer over a resting alert replaces it and keeps the attempt', () => {
    const ui = makeUi();
    const t0 = 5_000_000;
    workclock.start(ui.clock, t0);
    workclock.pause(ui.clock, t0 + 120_000);
    ui.waitingUntil = t0 + 500_000;

    // A steer is `sameTask` from the ONE classifier — see task.js.
    const steer = require('../../src/task').classify('use the clean win11-test VM instead', {
      activeTask: { objective: 'verify the frontend in a VM' },
    });
    assert.strictEqual(steer.sameTask, true, 'a steer adjusts the active task');

    turnstate.beginTurn(ui, steer);
    assert.strictEqual(alert.resting(ui).level, null, 'the previous alert must not stay glued beside the steer');
    assert.ok(workclock.reading(ui.clock).ms >= 120_000, 'a steer does not restart the attempt');
  });

  await test('ALERT: corrective context (not the word "continue") also clears the alert', () => {
    const ui = makeUi();
    ui.failed = { kind: 'UNAVAILABLE' };
    ui.interrupted = true;
    turnstate.beginTurn(ui, { sameTask: true, kind: 'STEER' });
    assert.strictEqual(alert.resting(ui).level, null);
    assert.strictEqual(ui.interrupted, false);
  });

  await test('ALERT: a genuinely NEW task always starts the clock from zero', () => {
    const ui = makeUi();
    const t0 = 6_000_000;
    workclock.start(ui.clock, t0);
    workclock.pause(ui.clock, t0 + 300_000);
    assert.strictEqual(alert.attemptFor(ui, NEW), alert.ATTEMPT.FRESH);
    turnstate.beginTurn(ui, NEW);
    assert.strictEqual(workclock.reading(ui.clock).text, '00:00:00',
      'a different task must never inherit the previous one minutes');
  });

  await test('ALERT: no verdict means FRESH — a caller that knows nothing starts something new', () => {
    const ui = makeUi();
    workclock.start(ui.clock, 7_000_000);
    workclock.pause(ui.clock, 7_000_000 + 45_000);
    assert.strictEqual(alert.attemptFor(ui, null), alert.ATTEMPT.FRESH);
    turnstate.beginTurn(ui);
    assert.strictEqual(workclock.reading(ui.clock).text, '00:00:00');
  });

  // ----------------------------------------------------------- NO STACKING --

  await test('ALERT: only ONE alert can rest at a time, whatever is set', () => {
    const ui = makeUi();
    ui.waitingUntil = Date.now() + 10_000;
    ui.interrupted = true;
    ui.retryCancelled = true;
    ui.failed = { kind: 'UNAVAILABLE' };
    const r = alert.resting(ui);
    assert.strictEqual(typeof r.word, 'string');
    assert.ok(r.word, 'one word');
    // The precedence must match liveState's, or the two surfaces disagree
    // about which of four simultaneous truths is the news.
    assert.strictEqual(r.word, 'WAITING FOR LIMIT RESET');
  });

  await test('ALERT: clearResting reports what it cleared, and clears all four', () => {
    const ui = makeUi();
    ui.waitingUntil = Date.now() + 10_000;
    ui.interrupted = true;
    ui.retryCancelled = true;
    ui.failed = { kind: 'AUTH' };
    const out = alert.clearResting(ui);
    assert.deepStrictEqual(out.cleared, ['WAITING FOR LIMIT RESET']);
    assert.strictEqual(ui.waitingUntil, 0);
    assert.strictEqual(ui.interrupted, false);
    assert.strictEqual(ui.retryCancelled, false);
    assert.strictEqual(ui.failed, false);
    assert.strictEqual(alert.resting(ui).level, null, 'nothing may rest after a submission');
  });

  // ------------------------------------------------------- FAILURE  KINDS --

  await test('ALERT: setFailed keeps the failure kind instead of coercing it to true', () => {
    const ui = makeUi();
    turnstate.setFailed(ui, { kind: 'AUTH', status: 401, message: 'bad key' });
    assert.strictEqual(typeof ui.failed, 'object', 'the object must survive — a boolean loses the kind');
    assert.strictEqual(ui.failed.kind, 'AUTH');
    // AND THE ROW SAYS SOMETHING SPECIFIC. This is what the coercion cost:
    // every failure in the product rendered as the same generic word.
    const row = status.failureRow(ui.failed);
    assert.strictEqual(row.word, 'NOT AUTHENTICATED');
    assert.notStrictEqual(row.word, 'ERROR');
  });

  await test('ALERT: setFailed(false) still clears, and a string still works', () => {
    const ui = makeUi();
    turnstate.setFailed(ui, { kind: 'AUTH' });
    turnstate.setFailed(ui, false);
    assert.strictEqual(ui.failed, false);
    turnstate.setFailed(ui, 'something broke');
    assert.strictEqual(status.failureRow(ui.failed).detail, 'something broke');
  });

  // ------------------------------------------------- TITLE / ONE  SOURCE --

  await test('ALERT: the window title and the live row read the same state', () => {
    const termtitle = require('../../src/termtitle');
    const waiting = status.liveState({ waitingUntil: Date.now() + 30_000, waitingLabel: 'rate limited' });
    assert.strictEqual(termtitle.stateOf(waiting), termtitle.STATE.PAUSED,
      'an amber row must not leave the title claiming work');

    const ui = makeUi();
    ui.waitingUntil = Date.now() + 30_000;
    turnstate.beginTurn(ui, SAME);
    const resumed = status.liveState({
      waitingUntil: ui.waitingUntil, phase: { phase: 'THINKING' }, phaseSince: Date.now(),
    });
    assert.notStrictEqual(termtitle.stateOf(resumed), termtitle.STATE.PAUSED,
      'after a continuation the title must leave the paused glyph too');
  });

  // ------------------------------------------- THE WAIT'S OWN CONTROLLER --

  await test('ALERT: continuing during a wait cancels THAT wait, not the new turn', () => {
    // THE ORDERING BUG, REPRODUCED. `waitForReset` listens on the controller
    // that was current when the wait began. `app.submit` replaces `app.abort`
    // BEFORE it calls `beginTurn`, so an abort fired from `clearResting` landed
    // on the turn that was starting: the wait went on counting down against an
    // orphaned signal, and the fresh turn began already cancelled.
    const ui = makeUi();
    ui.waitingUntil = Date.now() + 90_000;
    const waitController = new AbortController();
    ui.app.abort = waitController;
    let waitEnded = false;
    waitController.signal.addEventListener('abort', () => { waitEnded = true; }, { once: true });

    // submit(), in its real order.
    alert.cancelPendingWait(ui.app);
    ui.app.abort = new AbortController();
    const freshTurn = ui.app.abort.signal;
    turnstate.beginTurn(ui, SAME);

    assert.strictEqual(waitEnded, true, 'the pending wait must actually be cancelled');
    assert.strictEqual(freshTurn.aborted, false,
      'the turn the person just started must not begin already aborted');
    assert.strictEqual(alert.resting(ui).level, null, 'and the amber alert is gone');
  });

  await test('ALERT: clearResting never touches an abort controller', () => {
    // The abort belongs to `cancelPendingWait`, at the one call site where
    // `app.abort` is still the wait's. If this reaches for a controller again
    // the ordering bug comes back silently.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'src', 'ui', 'alert.js'), 'utf8');
    // The BODY only: the slice used to run to the next declaration and so
    // swallowed cancelPendingWait's doc comment, which is entirely about abort.
    const from = src.indexOf('function clearResting(');
    const body = src.slice(from, src.indexOf('\n}', from));
    assert.ok(!/abort/i.test(body), 'clearResting must not fire an abort — see cancelPendingWait');
  });

  await test('ALERT: cancelPendingWait does nothing when no wait is resting', () => {
    const ui = makeUi();
    ui.app.abort = new AbortController();
    const r = alert.cancelPendingWait(ui.app);
    assert.strictEqual(r.cancelled, false);
    assert.strictEqual(ui.app.abort.signal.aborted, false,
      'an ordinary submission must not abort itself');
  });

  // ----------------------------------------------------- NO DURABLE  GLUE --

  await test('ALERT: cancelling a retry writes no notice into the transcript', () => {
    const notices = [];
    const ui = makeUi();
    ui.phase = { phase: 'RETRYING' };
    ui.app.render = { notice: (level, msg) => notices.push([level, msg]) };
    ui.app.abort = new AbortController();
    const done = require('../../src/ui/waiting').cancelRetry(ui);
    assert.strictEqual(done, true, 'the cancel still happens');
    assert.strictEqual(ui.retryCancelled, true, 'and it still rests on the live row');
    assert.deepStrictEqual(notices, [],
      'an alert must not be glued into the conversation as well as the row');
  });
};
