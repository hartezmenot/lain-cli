'use strict';

/**
 * WHICH PROVIDER FACTS SURVIVE A RESTART, AND WHICH MUST NOT.
 *
 * ------------------------------------------------------------------------
 * THE MEASUREMENT. `availability.js` held everything it knew in a Map on the
 * App, under a comment that said this was by design because "a restart
 * legitimately knows nothing". That is true of a circuit breaker and false of a
 * rate limit, and the two had been sharing a lifetime because they share a
 * record.
 *
 * A provider that answers `retry in 4 hours` has stated a fact whose future
 * outlasts the process that heard it. Restart LAIN five minutes later and the
 * Map is empty: the next turn calls the closed route, is refused, and buys the
 * same fact again — while the model picker, the one screen where "which of
 * these can I use right now" is asked, shows the shut door as untried.
 *
 * So these tests are about the SELECTION, not the storage. Storing provider
 * state durably is easy and mostly harmless; deciding which of it is still true
 * tomorrow is the part that can do damage in either direction:
 *
 *   ADOPT TOO LITTLE  and the store is empty exactly when it would have paid.
 *   ADOPT TOO MUCH    and a stale row wedges a working route shut, with no
 *                     mechanism that could ever discover it had cleared. That
 *                     is a permanent outage manufactured out of a memory.
 *
 * The interesting case, and the one with its own test below, is a rate limit
 * recorded with NO stated reset. Inside the process that saw it, it means "shut
 * until something says otherwise". Across a restart it means nothing usable at
 * all — a limit with no clock could be twenty seconds or three days old and
 * there is no evidence to tell them apart — so it is deliberately dropped.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Availability, STATUS } = require('../../src/availability');

const HOUR = 3600_000;

/** A row shaped exactly as rust/lain-supervisor/src/providers.rs writes it. */
function row(over = {}) {
  const now = Date.now();
  return {
    id: 'omniroute-main',
    provider: 'omniroute',
    model: 'gemini-3.7-flash-high',
    status: 'DEGRADED',
    reason: 'rate limited',
    consecutive_failures: 1,
    rate_limited: false,
    reset_at: null,
    limited_now: false,
    resets_in_ms: null,
    detected_at: now,
    last_success: null,
    last_failure: now,
    ...over,
  };
}

module.exports = async function run() {
  // ---- WHAT IS ADOPTED ---------------------------------------------------

  await test('HEALTH: a rate limit with a stated reset in the future survives the restart', async () => {
    const a = new Availability();
    const resetAt = Date.now() + 4 * HOUR;
    const took = a.hydrate([row({ rate_limited: true, reset_at: resetAt, limited_now: true })]);

    assert.strictEqual(took.limited, 1, 'the row was adopted');
    const gate = a.shouldAttempt('omniroute-main');
    assert.strictEqual(gate.allow, false, 'and the door is still shut');
    assert.strictEqual(gate.rateLimited, true);
    assert.strictEqual(gate.resumeAt, resetAt, 'to the millisecond the provider stated');
  });

  await test('HEALTH: an adopted limit reads as DEGRADED, never as UNAVAILABLE', async () => {
    // The renderer paints these differently and the difference is the whole
    // point: yellow means "wait, here is when it clears", red means "something
    // has to be done". Hydrating a limit as unreachable sends a person off to
    // check credentials that were never the problem. See ui/adapters.routeHealth.
    const a = new Availability();
    a.hydrate([row({ rate_limited: true, reset_at: Date.now() + HOUR, limited_now: true })]);
    assert.strictEqual(a.get('omniroute-main').status, STATUS.DEGRADED);
  });

  await test('HEALTH: a state a person set survives, because a decision is not an observation', async () => {
    const a = new Availability();
    const took = a.hydrate([
      row({ id: 'off', status: 'DISABLED', reason: 'disabled by you' }),
      row({ id: 'planned', status: 'MAINTENANCE', reason: 'planned' }),
    ]);
    assert.strictEqual(took.decisions, 2);
    assert.strictEqual(a.shouldAttempt('off').allow, false);
    assert.strictEqual(a.shouldAttempt('planned').allow, false);
  });

  // ---- WHAT IS REFUSED, WHICH IS THE HARDER HALF -------------------------

  await test('HEALTH: a rate limit with NO stated reset is not adopted as a closed door', async () => {
    // Adopting this would shut a route with nothing able to reopen it: there is
    // no clock to expire and no request will be sent to prove it has cleared.
    const a = new Availability();
    const took = a.hydrate([row({ rate_limited: true, reset_at: null, limited_now: true })]);

    assert.strictEqual(took.limited, 0, 'nothing was adopted from a limit with no clock');
    assert.strictEqual(a.shouldAttempt('omniroute-main').allow, true,
      'and the route is still callable, so the next request can settle it');
  });

  await test('HEALTH: a stated reset that has already passed is not adopted', async () => {
    const a = new Availability();
    const took = a.hydrate([row({ rate_limited: true, reset_at: Date.now() - HOUR, limited_now: false })]);
    assert.strictEqual(took.limited, 0, "the provider's own number says it is over");
    assert.strictEqual(a.shouldAttempt('omniroute-main').allow, true);
  });

  await test('HEALTH: a breaker is never adopted — reachability is this process’s guess to make', async () => {
    const a = new Availability();
    const took = a.hydrate([row({ status: 'UNAVAILABLE', consecutive_failures: 9, reason: 'ECONNREFUSED' })]);
    assert.strictEqual(took.adopted, 0);
    assert.strictEqual(a.shouldAttempt('omniroute-main').allow, true,
      'a fresh process is right to re-try a server it never saw fail');
  });

  await test('HEALTH: junk rows are ignored rather than trusted', async () => {
    // §19: these arrive over a socket from a store on disk. A row with no id
    // must not become a route called "".
    const a = new Availability();
    const took = a.hydrate([null, {}, { id: '' }, 'nonsense', 42, { id: 'ok', status: 'DISABLED' }]);
    assert.strictEqual(took.adopted, 1, 'only the one real row');
    assert.strictEqual(a.all().length, 1);
    assert.strictEqual(a.all()[0].id, 'ok');
  });

  await test('HEALTH: hydrate on a non-array is a no-op, not a throw', async () => {
    const a = new Availability();
    for (const bad of [null, undefined, 'rows', 7, {}]) {
      assert.deepStrictEqual(a.hydrate(bad), { adopted: 0, limited: 0, decisions: 0 });
    }
  });

  // ---- WHAT LEAVES THIS PROCESS ------------------------------------------

  await test('HEALTH: a rate limit is pushed out with an ABSOLUTE reset, converted once', async () => {
    // The store keeps an absolute time and the classifier reports a duration.
    // The conversion happens at exactly one place so the two copies cannot
    // disagree by the width of a socket call.
    const seen = [];
    const a = new Availability();
    a.sink = (id, ev) => { seen.push({ id, ev }); };
    const before = Date.now();
    a.noteFailure('r', { kind: 'RATE_LIMITED', message: '429', retryAfterMs: 4 * HOUR });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].id, 'r');
    assert.strictEqual(seen[0].ev.kind, 'RATE_LIMITED');
    assert.strictEqual(seen[0].ev.ok, false);
    assert.ok(seen[0].ev.resetAt >= before + 4 * HOUR, 'an absolute time, not a duration');
    assert.ok(seen[0].ev.resetAt <= Date.now() + 4 * HOUR);
  });

  await test('HEALTH: no stated duration is pushed as 0, which means NOBODY SAID', async () => {
    // Never `Date.now()`, which would be an invented reset of "right now" and
    // would render as a door that has already reopened.
    const seen = [];
    const a = new Availability();
    a.sink = (id, ev) => seen.push(ev);
    a.noteFailure('r', { kind: 'RATE_LIMITED', message: 'slow down' });
    assert.strictEqual(seen[0].resetAt, 0);
  });

  await test('HEALTH: a decision goes out as a decision, never as an observation', async () => {
    // §19 in one assertion: a machine reports what it saw; only a person
    // declares a route's state, and the two take different ops.
    const seen = [];
    const a = new Availability();
    a.sink = (id, ev) => seen.push(ev);

    a.disable('r', 'by you');
    a.maintenance('s');
    a.retry('r');

    assert.deepStrictEqual(seen.map((e) => e.decision), ['SET', 'SET', 'CLEAR']);
    assert.strictEqual(seen[0].status, STATUS.DISABLED);
    assert.strictEqual(seen[1].status, STATUS.MAINTENANCE);
    assert.ok(seen.every((e) => e.ok === undefined), 'a decision carries no ok flag');
  });

  await test('HEALTH: retry drops the hydrated mark, so the limit cannot come back at the next launch', async () => {
    // Otherwise `/provider retry` is a control that works until you restart:
    // the route would rehydrate from a countdown the user already dismissed.
    const a = new Availability();
    a.hydrate([row({ id: 'r', rate_limited: true, reset_at: Date.now() + HOUR, limited_now: true })]);
    assert.ok(a.hydrated.has('r'));
    a.retry('r');
    assert.ok(!a.hydrated.has('r'));
    assert.strictEqual(a.shouldAttempt('r').allow, true);
  });

  await test('HEALTH: a sink that throws cannot take a turn down with it', async () => {
    // noteFailure runs on the failure path of a model request, inside a turn
    // that is already going badly. The mirror is an improvement on this state,
    // never a precondition for it.
    const a = new Availability();
    a.sink = () => { throw new Error('supervisor exploded'); };
    const r = a.noteFailure('r', { kind: 'RATE_LIMITED', retryAfterMs: HOUR });
    assert.strictEqual(r.rateLimited, true, 'the in-memory answer is unaffected');
  });

  await test('HEALTH: a sink that rejects is swallowed, not left unhandled', async () => {
    const a = new Availability();
    a.sink = () => Promise.reject(new Error('unreachable'));
    a.noteSuccess('r');
    // An unhandled rejection would take the process down on Node 18+; getting
    // to the next tick without one is the assertion.
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(a.get('r').status, STATUS.AVAILABLE);
  });

  await test('HEALTH: with no sink installed, nothing about the old behaviour changes', async () => {
    // The hard rule from supervisor.js: LAIN is a zero-dependency Node program
    // and must be identical on a machine with no Rust toolchain.
    const a = new Availability({ failureThreshold: 2 });
    assert.strictEqual(a.sink, null);
    a.noteFailure('r', { kind: 'NETWORK', message: 'ECONNREFUSED' });
    assert.strictEqual(a.get('r').status, STATUS.DEGRADED);
    a.noteFailure('r', { kind: 'NETWORK', message: 'ECONNREFUSED' });
    assert.strictEqual(a.get('r').status, STATUS.UNAVAILABLE);
    a.noteSuccess('r');
    assert.strictEqual(a.get('r').status, STATUS.AVAILABLE);
  });

  // ---- THE HANDOVER SECTION ----------------------------------------------

  await test('HEALTH: a closed route reaches the replacement model, with its clock', async () => {
    const handover = require('../../src/handover');
    const packet = handover.build({
      cwd: process.cwd(),
      task: { objective: 'finish the loader' },
      turns: [{ model: 'model-a', stopReason: 'provider', steps: 3, actions: [] }],
    }, {
      toModel: 'model-b',
      providers: [
        row({ id: 'omniroute-main', rate_limited: true, limited_now: true, resets_in_ms: 4 * HOUR }),
        row({ id: 'fine', status: 'AVAILABLE', limited_now: false }),
      ],
    });

    assert.ok(/Routes that are closed right now/.test(packet), 'the section is there');
    assert.ok(/omniroute-main/.test(packet), 'and names the shut route');
    assert.ok(/clears in 4h/.test(packet), 'with the time it opens');
    assert.ok(!/\bfine\b/.test(packet), 'and says nothing about routes that are fine');
  });

  await test('HEALTH: a limit with no known reset says so rather than inventing a countdown', async () => {
    const handover = require('../../src/handover');
    const packet = handover.build({
      cwd: process.cwd(),
      task: { objective: 'x' },
      turns: [{ model: 'a', stopReason: 'provider', steps: 1, actions: [] }],
    }, {
      toModel: 'b',
      providers: [row({ rate_limited: true, limited_now: true, resets_in_ms: null })],
    });
    assert.ok(/unknown reset/.test(packet));
    assert.ok(!/clears in/.test(packet), 'no number nobody supplied');
  });

  await test('HEALTH: no closed routes means no section at all', async () => {
    const handover = require('../../src/handover');
    const packet = handover.build({
      cwd: process.cwd(),
      task: { objective: 'x' },
      turns: [{ model: 'a', stopReason: 'provider', steps: 1, actions: [] }],
    }, { toModel: 'b', providers: [row({ status: 'AVAILABLE' })] });
    assert.ok(!/Routes that are closed/.test(packet), 'a handover is a briefing, not an inventory');
  });
};
