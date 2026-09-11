'use strict';

/**
 * THE RETRY SCHEDULE, ASSERTED EXACTLY AND WITHOUT WAITING FOR IT.
 *
 * Nineteen minutes of real sleeping would make this untestable, so `sleep`
 * takes an injectable timer pair and the fake one records what it was asked to
 * wait for and fires immediately. What is proved is the SEQUENCE and the
 * ARITHMETIC — the two things that were wrong — not that setTimeout works.
 *
 * Every case here corresponds to a defect the old policy had: a 500ms opening
 * retry, a hardcoded 20s rate-limit branch that lived outside the schedule, and
 * `retryAfterMs ||` letting a provider advertising a two-second reset pull LAIN
 * back to hammering the limiter that had just refused it.
 */

const assert = require('assert');
const { test } = require('../helpers');

const backoff = require('../../src/backoff');
const errors = require('../../src/errors');

/** A timer that never really waits, and remembers every delay it was given. */
function fakeTimers() {
  const waits = [];
  return {
    waits,
    setTimeout: (fn, ms) => { waits.push(ms); return setTimeout(fn, 0); },
    clearTimeout: (t) => clearTimeout(t),
  };
}

module.exports = async function () {
  // ------------------------------------------------------- THE SCHEDULE --

  await test('BACKOFF: the schedule is exactly 10 15 30 45 60 90 120 180 300 300', () => {
    assert.deepStrictEqual(
      backoff.scheduleSeconds(),
      [10, 15, 30, 45, 60, 90, 120, 180, 300, 300],
    );
    // And read attempt by attempt, 1-based, which is how the caller asks.
    const seen = [];
    for (let a = 1; a <= 10; a++) seen.push(backoff.scheduleFor(a) / 1000);
    assert.deepStrictEqual(seen, [10, 15, 30, 45, 60, 90, 120, 180, 300, 300]);
  });

  await test('BACKOFF: it opens at ten seconds, not half a second', () => {
    // The exact regression. 500ms answered a 429 by asking again immediately.
    assert.strictEqual(backoff.scheduleFor(1), 10_000);
    assert.ok(backoff.scheduleFor(1) >= 10_000, 'the first retry must be a real pause');
  });

  await test('BACKOFF: there are ten attempts and then it stops', () => {
    assert.strictEqual(backoff.MAX_RETRIES, 10);
    assert.strictEqual(backoff.BACKOFF_MS.length, 10);
    // AN ELEVENTH IS NOT SCHEDULED. Reading past the end clamps rather than
    // returning undefined — which the arithmetic would have turned into NaN,
    // and a setTimeout of NaN fires immediately: a retry storm dressed as a
    // backoff.
    assert.strictEqual(backoff.scheduleFor(11), 300_000);
    assert.strictEqual(backoff.scheduleFor(999), 300_000);
    assert.ok(Number.isFinite(backoff.scheduleFor(11)));
  });

  await test('BACKOFF: the schedule is exact — a countdown that promises 30s means 30s', () => {
    assert.strictEqual(backoff.JITTER, 0);
    for (let i = 0; i < 50; i++) {
      assert.strictEqual(backoff.backoffFor(3), 30_000, 'a jittered delay would make the resume time a guess');
    }
  });

  // --------------------------------------------------- PROVIDER RETRY-AFTER --

  await test('BACKOFF: a provider can make LAIN wait LONGER, never shorter', () => {
    // configured 30 · provider 2  -> 30
    assert.strictEqual(backoff.effectiveDelay(3, 2_000), 30_000);
    // configured 30 · provider 90 -> 90
    assert.strictEqual(backoff.effectiveDelay(3, 90_000), 90_000);
    // configured 10 · provider 60 -> 60
    assert.strictEqual(backoff.effectiveDelay(1, 60_000), 60_000);
    // configured 10 · provider 2  -> 10   (the hammering case)
    assert.strictEqual(backoff.effectiveDelay(1, 2_000), 10_000);
  });

  await test('BACKOFF: a malformed provider hint is ignored, not trusted', () => {
    for (const bad of [null, undefined, '', 'soon', NaN, -1, 0, Infinity, {}, []]) {
      assert.strictEqual(backoff.effectiveDelay(2, bad), 15_000, `${JSON.stringify(bad)} must fall back to the schedule`);
    }
    // A header claiming a full day is not a wait LAIN will honour.
    assert.strictEqual(backoff.effectiveDelay(2, 25 * 60 * 60 * 1000), 15_000);
    // But a genuinely long, plausible one is.
    assert.strictEqual(backoff.effectiveDelay(2, 20 * 60 * 1000), 20 * 60 * 1000);
  });

  // ------------------------------------------------------- ONE POLICY (§25) --

  await test('BACKOFF: turn.js holds no schedule of its own', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'turn.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The hardcoded rate-limit branch that lived outside backoff.js.
    assert.ok(!/20_000|20000/.test(src), 'turn.js has a retry delay of its own again');
    // And the precedence that let a tiny provider reset win.
    assert.ok(!/failure\.retryAfterMs\s*\|\|/.test(src),
      'turn.js takes the provider hint unconditionally again — it must be MAX(schedule, hint)');
    assert.match(src, /backoffFor\(retries,\s*failure\.retryAfterMs\)/,
      'turn.js must ask the one policy for its delay');
  });

  // ------------------------------------------- CLASSIFICATION (§23) --------

  await test('BACKOFF: a bad credential is never retried for fifteen minutes', () => {
    // The schedule totals ~19 minutes. Spending it on something a retry cannot
    // fix is the failure §23 names, and the guard against it is classification
    // rather than the schedule.
    const nonRecoverable = [
      { status: 401, message: 'unauthorized' },
      { status: 403, message: 'forbidden' },
      { status: 400, message: 'malformed' },
    ];
    for (const e of nonRecoverable) {
      const c = errors.classify(e);
      assert.strictEqual(c.retriable, false, `${e.status} must not be retried: got ${c.kind}`);
    }
  });

  await test('BACKOFF: rate limits and transient outages ARE retried', () => {
    for (const e of [{ status: 429 }, { status: 503 }, { status: 502 }]) {
      assert.strictEqual(errors.classify(e).retriable, true, `${e.status} should be recoverable`);
    }
  });

  // -------------------------------------------------- THE WAIT ITSELF ------

  await test('BACKOFF: sleep waits for what it was told, and never really sleeps here', async () => {
    const timers = fakeTimers();
    for (let a = 1; a <= 10; a++) await backoff.sleep(backoff.scheduleFor(a), null, timers);
    assert.deepStrictEqual(
      timers.waits.map((ms) => ms / 1000),
      [10, 15, 30, 45, 60, 90, 120, 180, 300, 300],
    );
  });

  await test('BACKOFF: an aborted wait resolves rather than throwing', async () => {
    const timers = fakeTimers();
    const ac = new AbortController();
    ac.abort();
    await backoff.sleep(300_000, ac.signal, timers);
    assert.deepStrictEqual(timers.waits, [], 'an already-aborted wait must not even be scheduled');
  });

  await test('BACKOFF: a user cancelling mid-wait ends it immediately', async () => {
    const timers = { setTimeout: (fn, ms) => setTimeout(fn, 60_000) && ms, clearTimeout };
    const ac = new AbortController();
    const started = Date.now();
    const waiting = backoff.sleep(300_000, ac.signal, timers);
    ac.abort();
    await waiting;
    assert.ok(Date.now() - started < 2000, 'aborting must not wait out the schedule');
  });

  // ------------------------------------------------ COUNTER SCOPE (§24) ----

  await test('BACKOFF: the retry counter belongs to one operation, not the session', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'turn.js'), 'utf8');
    const fn = src.indexOf('async function* runTurn(');
    const decl = src.indexOf('let retries = 0;');
    assert.ok(fn > 0 && decl > fn,
      'retries must be declared inside runTurn — a module-level counter would make an unrelated later request start at 8/10');
  });
};
