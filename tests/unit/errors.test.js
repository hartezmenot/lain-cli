'use strict';

const assert = require('assert');
const { test } = require('../helpers');
const errors = require('../../src/errors');

module.exports = async function () {
  await test('ECONNREFUSED is UNAVAILABLE and retriable', () => {
    // V1 used \bECONN\b, which cannot match inside ECONNREFUSED — a dead local
    // bridge was never classified as transient and took the REPL down.
    const e = new Error('connect ECONNREFUSED 127.0.0.1:20128');
    e.code = 'ECONNREFUSED';
    const c = errors.classify(e);
    assert.strictEqual(c.kind, errors.KIND.UNAVAILABLE);
    assert.strictEqual(c.retriable, true);
    assert.strictEqual(errors.isProviderFailure(e), true);
  });

  await test('every transport errno is a retriable provider failure', () => {
    // Asserting the INVARIANT that matters rather than the exact label:
    // ETIMEDOUT legitimately classifies as TIMEOUT and ECONNRESET as
    // UNAVAILABLE. What the turn loop and (phase 6) the availability breaker
    // need from all of them is identical — retriable, and not our bug.
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH']) {
      const e = new Error(`socket error ${code}`);
      e.code = code;
      const c = errors.classify(e);
      assert.strictEqual(errors.isProviderFailure(e), true, `${code} must be a provider failure`);
      assert.strictEqual(c.retriable, true, `${code} must be retriable`);
      assert.notStrictEqual(c.kind, errors.KIND.UNKNOWN, `${code} must be classified`);
    }
  });

  await test('429 is RATE_LIMITED and retriable', () => {
    const e = new Error('too many requests'); e.status = 429;
    const c = errors.classify(e);
    assert.strictEqual(c.kind, errors.KIND.RATE_LIMITED);
    assert.strictEqual(c.retriable, true);
  });

  await test('Retry-After is clamped — an epoch timestamp is not a delta', () => {
    // V1 turned an absolute epoch into a ~26-day wait.
    const sane = new Error('rl'); sane.status = 429; sane.retryAfter = 30;
    assert.strictEqual(errors.classify(sane).retryAfterMs, 30000);
    const epoch = new Error('rl'); epoch.status = 429; epoch.retryAfter = 1786000000;
    assert.strictEqual(errors.classify(epoch).retryAfterMs, 0, 'absurd Retry-After must be discarded');
  });

  await test('401/403 is AUTH, not an outage, and is not retriable', () => {
    const e = new Error('unauthorized'); e.status = 401;
    const c = errors.classify(e);
    assert.strictEqual(c.kind, errors.KIND.AUTH);
    assert.strictEqual(c.retriable, false);
  });

  await test('5xx is UNAVAILABLE and retriable; 400 is BAD_REQUEST and is not', () => {
    const s = new Error('bad gateway'); s.status = 502;
    assert.strictEqual(errors.classify(s).kind, errors.KIND.UNAVAILABLE);
    assert.strictEqual(errors.classify(s).retriable, true);
    const b = new Error('nope'); b.status = 400;
    assert.strictEqual(errors.classify(b).kind, errors.KIND.BAD_REQUEST);
    assert.strictEqual(errors.classify(b).retriable, false);
  });

  await test('a plain programming error is NOT a provider failure (it must keep throwing)', () => {
    assert.strictEqual(errors.isProviderFailure(new TypeError("x is not a function")), false);
  });

  await test('abort is its own kind and is not a provider failure', () => {
    const e = new Error('aborted'); e.name = 'AbortError';
    assert.strictEqual(errors.classify(e).kind, errors.KIND.ABORTED);
    assert.strictEqual(errors.isProviderFailure(e), false);
  });

  await test('QUOTA: the exact 429 that was retried five times in a real session', () => {
    // ---- CAPTURED OFF THE WIRE, not paraphrased ---------------------------
    //
    // This is the body omniroute actually returned, taken from a recorded
    // session. Nothing in the quota pattern matched it, so it fell through to
    // the plain `status === 429` branch and came back RETRIABLE — and the run
    // shows `retry 1/5` through `retry 5/5` against a provider that had just
    // said the account had no requests left. Five more refusals at an exhausted
    // cap, and a wait that could not help.
    //
    // The discriminator is WHICH limit, not the word "limit": a RATE limit
    // clears on its own and is still retried.
    const errors = require('../../src/errors');
    const body = 'omniroute: 429 Too Many Requests — {"error":{"message":"[tokenrouter/z-ai/'
      + 'glm-5.3-free] [429]: {\\"error\\":{\\"code\\":\\"\\",\\"message\\":\\"You have reached the '
      + 'request limit[z-ai/glm-5.3-free]: Maximum';
    const err = new Error(body);
    err.status = 429;
    const c = errors.classify(err);
    assert.strictEqual(c.kind, 'QUOTA', 'an exhausted request cap is not a rate limit');
    assert.strictEqual(c.retriable, false, 'and waiting for it is waiting forever');

    // The other half, which must NOT change: a genuine rate limit still retries.
    const rate = new Error('Rate limit exceeded, please slow down');
    rate.status = 429;
    const r = errors.classify(rate);
    assert.strictEqual(r.kind, 'RATE_LIMITED');
    assert.strictEqual(r.retriable, true, 'a rate limit clears on its own — retrying is correct');
  });
};
