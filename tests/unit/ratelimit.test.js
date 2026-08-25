'use strict';

/**
 * A RATE LIMIT MEASURED IN HOURS IS A DECISION, NOT A RETRY.
 *
 * Reported from real use: `retry in 4 hours`. The bounded retry is right for a
 * limit that clears in seconds — wait, try again, get on with it — and wrong
 * for this one. Sitting inside it means a LAIN that looks alive, answers
 * nothing, and spends its whole retry budget long before the limit clears, so
 * the ending is a failure whichever way it goes.
 *
 * Only two answers are useful and both belong to the person: wait for it, or
 * change model. What is checked here is that the choice is offered, that the
 * clock is honest, and that neither answer is ever assumed.
 */

const assert = require('assert');
const { test } = require('../helpers');

const rl = require('../../src/ratelimit');
const { routeHealth } = require('../../src/ui/adapters');

module.exports = async function () {
  await test('RL: a short limit is left to the ordinary retry, unasked', () => {
    // Being asked a question is an interruption. A question about a
    // twenty-second wait costs more attention than the wait does.
    assert.strictEqual(rl.worthAsking({ kind: 'RATE_LIMITED', retryAfterMs: 20_000 }), false);
    assert.strictEqual(rl.worthAsking({ kind: 'RATE_LIMITED', retryAfterMs: 0 }), false);
  });

  await test('RL: a limit measured in hours IS worth asking about', () => {
    assert.strictEqual(rl.worthAsking({ kind: 'RATE_LIMITED', retryAfterMs: 4 * 3600_000 }), true);
    // And only for a rate limit — a 502 is not a thing you wait four hours for.
    assert.strictEqual(rl.worthAsking({ kind: 'UNAVAILABLE', retryAfterMs: 4 * 3600_000 }), false);
  });

  await test('RL: the countdown reads at the scale a person reads it', () => {
    assert.strictEqual(rl.human(4 * 3600_000 + 12 * 60_000), '4h 12m');
    assert.strictEqual(rl.human(90_000), '1m 30s');
    assert.strictEqual(rl.human(45_000), '45s');
    assert.strictEqual(rl.human(0), 'now');
    // NEVER "0s" WHILE TIME REMAINS — a clock that reads zero and keeps
    // counting is one nobody believes.
    assert.strictEqual(rl.human(400), '1s');
  });

  await test('RL: the question offers exactly the two useful answers', () => {
    const a = rl.adapter({ provider: 'omniroute', resumeAt: Date.now() + 3600_000, model: 'claude-opus-5' });
    const values = a.items.filter((i) => i.value).map((i) => i.value);
    assert.deepStrictEqual(values, [rl.CHOICE.WAIT, rl.CHOICE.CHANGE]);
    // IT NAMES WHICH PROVIDER AND WHICH MODEL. "Rate limited" without saying
    // what is rate limited leaves the user to guess which of their routes to
    // avoid.
    const said = a.items.map((i) => i.label).join(' ');
    assert.match(said, /omniroute/);
    assert.match(said, /claude-opus-5/);
    assert.match(said, /1h/, 'and how long it has to run');
  });

  await test('RL: the resume prompt says WHY there is a gap, not just "continue"', () => {
    // A bare "continue" after an unexplained four-hour gap makes a model
    // re-plan or ask what it was doing, which is the whole cost of resuming
    // badly.
    assert.match(rl.RESUME_PROMPT, /rate limit has reset/i);
    assert.match(rl.RESUME_PROMPT, /do not start again/i);
    assert.match(rl.RESUME_PROMPT, /nothing was lost/i);
  });

  // ---- THE COLOURS -------------------------------------------------------
  //
  // The tone says WHAT YOU CAN DO ABOUT IT, which is the only distinction that
  // helps while choosing a route. Yellow against red is the one that matters:
  // both are "it did not work", and only one is worth waiting for.

  await test('COLOUR: rate limited is YELLOW and carries its countdown', () => {
    const h = routeHealth({}, {
      availabilityRaw: () => ({ rateLimited: true, resumeAt: Date.now() + 3600_000 }),
    });
    assert.strictEqual(h.tone, 'warn', 'temporary means yellow, not red');
    assert.match(h.text, /rate limited/);
    assert.match(h.text, /clears in 1h/, 'waiting is only an option if you know how long');
  });

  await test('COLOUR: "too many calls, try again later" is also YELLOW', () => {
    const h = routeHealth({}, { availabilityOf: () => 'RATE_LIMITED' });
    assert.strictEqual(h.tone, 'warn');
  });

  await test('COLOUR: a credential problem is RED — it will not clear on its own', () => {
    const h = routeHealth({}, { readinessOf: () => 'NEEDS_AUTH' });
    assert.strictEqual(h.tone, 'bad', 'something has to be done, so it is red');
  });

  await test('COLOUR: a route that is down is RED', () => {
    const h = routeHealth({}, { availabilityOf: () => 'UNAVAILABLE' });
    assert.strictEqual(h.tone, 'bad');
  });

  await test('COLOUR: a callable route is GREEN', () => {
    const h = routeHealth({}, { availabilityOf: () => 'AVAILABLE' });
    assert.strictEqual(h.tone, 'ok');
    assert.match(h.text, /ready/);
  });

  await test('COLOUR: never tried is DIM — silence is not a claim', () => {
    const h = routeHealth({}, {});
    assert.strictEqual(h.tone, 'meta');
    assert.match(h.text, /not tried yet/);
  });

  await test('COLOUR: a success CLEARS the limit, so the row stops saying it', () => {
    // Leaving the countdown behind would keep the list saying "rate limited ·
    // 2h" for a route that had just answered.
    const { Availability } = require('../../src/availability');
    const a = new Availability({});
    a.noteFailure('r1', { kind: 'RATE_LIMITED', retryAfterMs: 3600_000, message: 'slow down' });
    assert.strictEqual(a.get('r1').rateLimited, true);
    a.noteSuccess('r1');
    assert.strictEqual(a.get('r1').rateLimited, false);
    assert.strictEqual(a.get('r1').resumeAt, 0);
  });
};
