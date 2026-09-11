'use strict';

/**
 * THE RETRY SCHEDULE —.
 *
 * The bounded 502/504 retry was already correct in every respect but one: its
 * backoff was a fixed table, so every LAIN pointed at the same gateway computed
 * the same schedule down to the millisecond. A gateway that drops connections
 * at t=0 is then hit again by all of them at t=500, and again at t=2000 — the
 * retries arrive as a burst exactly when the thing being retried is least able
 * to serve one. Jitter breaks that lockstep, and this is what proves it is
 * really there.
 *
 * WHY THIS IS A UNIT TEST AND NOT A SMOKE TEST. The property is statistical:
 * "these delays are not all identical" cannot be observed by driving the binary
 * and timing it, because the wall-clock noise of spawning a process is larger
 * than the spread being measured. The loop that CONSUMES the schedule is
 * covered against the real binary in tests/smoke/connection.test.js; what is
 * checked here is the schedule itself.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { BACKOFF_MS, JITTER, backoffFor } = require('../../src/backoff');

/** Every delay the schedule can produce for one attempt, sampled. */
const sample = (attempt, n = 400) => Array.from({ length: n }, () => backoffFor(attempt));

module.exports = async function () {
  await test('BACKOFF: the waits escalate — a reset and a restart want different patience', () => {
    // NON-DECREASING rather than strictly increasing: the schedule deliberately
    // FLATTENS at five minutes (300, 300) rather than growing without limit,
    // because past that a longer wait is not more patience, it is a hang.
    for (let i = 1; i < BACKOFF_MS.length; i++) {
      assert.ok(BACKOFF_MS[i] >= BACKOFF_MS[i - 1],
        `attempt ${i + 1} must not wait less than attempt ${i}`);
    }
    assert.ok(BACKOFF_MS[BACKOFF_MS.length - 1] > BACKOFF_MS[0], 'and it must escalate overall');
  });

  await test('BACKOFF: the total is bounded and it always ends', () => {
    // THIS USED TO ASSERT `total <= 25_000`, and that ceiling was the defect.
    // Twenty-five seconds across five attempts means answering a 429 half a
    // second after it arrives and four more times inside half a minute — which
    // is asking too often at the one moment a provider has said so. The
    // schedule is now ~19 minutes across ten attempts.
    //
    // WHAT STILL MATTERS IS THAT IT IS FINITE. A retry loop with no end is
    // indistinguishable from a hang and can keep an outage alive by feeding it.
    const total = BACKOFF_MS.reduce((a, b) => a + b, 0);
    assert.ok(Number.isFinite(total) && total > 0);
    assert.ok(total <= 30 * 60 * 1000, `${total}ms is past any useful patience`);
    assert.strictEqual(BACKOFF_MS.length, 10, 'ten attempts, then the failure semantics take over');
  });

  await test('BACKOFF: it is EXACT — an announced resume time is not a guess', () => {
    // THE REVERSAL. This asserted the schedule was jittered, to stop many
    // clients retrying in lockstep. That argument was sound for a 500ms first
    // retry, where the whole schedule fits inside one restart; with delays of
    // tens of seconds to minutes, clients are already spread by when their own
    // request failed, by far more than ±20% of a short wait.
    //
    // The cost was real: the strip promises "retry 3/10 in 30s" and prints an
    // absolute resume time, and a wait that could run to 36s made both a guess.
    assert.strictEqual(JITTER, 0);
    const seen = new Set(sample(1));
    assert.strictEqual(seen.size, 1, 'the schedule must be exactly what it announces');
    assert.strictEqual([...seen][0], 10_000);
  });

  await test('BACKOFF: the spread is BOUNDED, so an announced resume time stays honest', () => {
    // The status strip prints the absolute time work resumes. A wait that could
    // run half again as long as announced would make that number a guess.
    for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt++) {
      const base = BACKOFF_MS[attempt - 1];
      const lo = base * (1 - JITTER);
      const hi = base * (1 + JITTER);
      for (const ms of sample(attempt, 200)) {
        assert.ok(ms >= Math.floor(lo) && ms <= Math.ceil(hi),
          `attempt ${attempt} produced ${ms}ms, outside ±${JITTER * 100}% of ${base}ms`);
      }
    }
  });

  await test('BACKOFF: it is centred on the base delay, not merely near it', () => {
    // A spread that only ever shortened the wait would be a quiet reduction of
    // the backoff rather than a decorrelation of it.
    const n = 3000;
    const base = BACKOFF_MS[0];
    const mean = sample(1, n).reduce((a, b) => a + b, 0) / n;
    // Generous bound: this is a random sample, and a flaky test that fails one
    // run in fifty is worse than no test.
    assert.ok(Math.abs(mean - base) < base * 0.05,
      `mean ${mean.toFixed(1)}ms is not centred on ${base}ms`);
  });

  await test('BACKOFF: a wait is never zero, however the rounding falls', () => {
    for (let attempt = 1; attempt <= BACKOFF_MS.length + 3; attempt++) {
      for (const ms of sample(attempt, 100)) {
        assert.ok(ms >= 1, `attempt ${attempt} produced a ${ms}ms wait, which is no wait at all`);
      }
    }
  });

  await test('BACKOFF: attempts past the end of the table reuse the last delay', () => {
    // `maxConnectionRetries` is configurable up to 10 while the table has five
    // rows. Running off the end must clamp, not read undefined and produce NaN.
    const last = BACKOFF_MS[BACKOFF_MS.length - 1];
    for (const ms of sample(BACKOFF_MS.length + 5, 100)) {
      assert.ok(Number.isFinite(ms), 'a delay past the table must still be a number');
      assert.ok(ms >= Math.floor(last * (1 - JITTER)) && ms <= Math.ceil(last * (1 + JITTER)),
        `${ms}ms is not the clamped last delay`);
    }
  });
};
