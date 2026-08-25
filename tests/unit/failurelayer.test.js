'use strict';

/**
 * WHICH LAYER FAILED — and never "LAIN is broken".
 *
 * Three of LAIN's modes reach the same upstream account, so a limit hit in one
 * surfaces in all three at once. Reported without naming the layer, that is
 * indistinguishable from LAIN having a bug, and the user goes and debugs the
 * wrong program.
 *
 * The two distinctions checked hardest here are the two that were missing, and
 * both cost real time when they are absent:
 *
 *   QUOTA vs RATE_LIMITED       one clears by waiting, one never does
 *   MODEL_UNAVAILABLE vs
 *   UNAVAILABLE                 one is fixed by waiting, one by picking a model
 */

const assert = require('assert');
const { test } = require('../helpers');

const E = require('../../src/errors');

module.exports = async function () {
  await test('LAYER: a throttling 429 is RATE_LIMITED and IS worth retrying', () => {
    const c = E.classify({ status: 429, message: 'Rate limit reached — try again in 20s' });
    assert.strictEqual(c.kind, E.KIND.RATE_LIMITED);
    assert.strictEqual(c.retriable, true);
  });

  await test('LAYER: AN EXHAUSTED QUOTA IS NOT A RATE LIMIT, even on the same 429', () => {
    // The expensive version of getting this wrong: LAIN waits, retries, waits
    // longer, retries — against a wall that only a payment moves.
    const c = E.classify({ status: 429, message: 'You exceeded your current quota, check your plan and billing details' });
    assert.strictEqual(c.kind, E.KIND.QUOTA);
    assert.strictEqual(c.retriable, false, 'retrying an exhausted quota is waiting forever');
  });

  await test('LAYER: quota is recognised however the gateway spells it', () => {
    for (const message of [
      'insufficient_quota',
      'insufficient credit for this request',
      'Your account has no credits remaining',
      'billing hard limit reached',
      'add a payment method to continue',
    ]) {
      assert.strictEqual(E.classify({ status: 400, message }).kind, E.KIND.QUOTA, message);
    }
    assert.strictEqual(E.classify({ status: 402, message: 'Payment Required' }).kind, E.KIND.QUOTA);
  });

  await test('LAYER: A MODEL THAT IS NOT SERVED IS NOT AN OUTAGE', () => {
    // "wait for the provider" and "pick another model" are opposite fixes, and
    // the retry schedule runs its whole course before saying anything useful.
    for (const [status, message] of [
      [404, 'The model `gpt-9-turbo` does not exist'],
      [400, 'model_not_found'],
      [400, 'invalid model: sonnet-99'],
      [404, 'deployment not found'],
      [400, 'unknown model'],
    ]) {
      const c = E.classify({ status, message });
      assert.strictEqual(c.kind, E.KIND.MODEL_UNAVAILABLE, `${status} ${message}`);
      assert.strictEqual(c.retriable, false);
    }
  });

  await test('LAYER: a genuine 5xx is still UNAVAILABLE and still retriable', () => {
    const c = E.classify({ status: 503, message: 'Service Unavailable' });
    assert.strictEqual(c.kind, E.KIND.UNAVAILABLE);
    assert.strictEqual(c.retriable, true);
  });

  await test('LAYER: a dead socket is UNAVAILABLE, not a model problem', () => {
    // The model regex must not reach into transport messages.
    assert.strictEqual(E.classify({ message: 'ECONNREFUSED 127.0.0.1:11434' }).kind, E.KIND.UNAVAILABLE);
    assert.strictEqual(E.classify({ message: 'fetch failed' }).kind, E.KIND.UNAVAILABLE);
  });

  await test('LAYER: a missing FILE is never mistaken for a missing model', () => {
    // The narrowest thing the model regex has to not do.
    const c = E.classify({ status: 400, message: 'ENOENT: no such file or directory, open "model.json"' });
    assert.notStrictEqual(c.kind, E.KIND.MODEL_UNAVAILABLE);
  });

  await test('LAYER: a refused credential stays AUTH — not an outage and not a quota', () => {
    assert.strictEqual(E.classify({ status: 401, message: 'Unauthorized' }).kind, E.KIND.AUTH);
    assert.strictEqual(E.classify({ status: 403, message: 'Forbidden' }).kind, E.KIND.AUTH);
  });

  await test('LAYER: an interrupt is the user, and is never a provider failure', () => {
    const c = E.classify({ name: 'AbortError' });
    assert.strictEqual(c.kind, E.KIND.ABORTED);
    assert.strictEqual(E.isProviderFailure({ name: 'AbortError' }), false);
  });

  await test('LAYER: EVERY kind names a layer, and none of them names LAIN', () => {
    // The property the whole file exists for. A screen that shows one of these
    // as a LAIN malfunction sends the user to debug the wrong program.
    for (const kind of Object.values(E.KIND)) {
      const layer = E.LAYER[kind];
      assert.ok(layer, `${kind} has no explanation`);
      assert.ok(!/\blain\b/i.test(layer), `${kind} blames LAIN: ${layer}`);
    }
  });

  await test('LAYER: explain() carries both the kind and the sentence', () => {
    const x = E.explain({ status: 429, message: 'insufficient_quota' });
    assert.strictEqual(x.kind, E.KIND.QUOTA);
    assert.match(x.layer, /waiting will not clear it/);
  });

  await test('LAYER: the new kinds ARE provider failures — they must be reported, not thrown', () => {
    // isProviderFailure is the single predicate that keeps the REPL alive. A
    // kind missing from it takes the whole session down.
    assert.strictEqual(E.isProviderFailure({ status: 429, message: 'insufficient_quota' }), true);
    assert.strictEqual(E.isProviderFailure({ status: 404, message: 'model does not exist' }), true);
  });

  await test('LAYER: a plain bug is NOT a provider failure and keeps throwing', () => {
    assert.strictEqual(E.isProviderFailure(new TypeError('x is not a function')), false);
  });
};
