'use strict';

/**
 * A RATE LIMIT IS A FACT ABOUT A ROUTE. The tests are about what follows.
 *
 * ------------------------------------------------------------------------
 * THE WRONG SENTENCE, WHICH EVERYTHING HERE EXISTS TO PREVENT:
 *
 *     "claude-opus-5 is rate limited — would you like a different MODEL?"
 *
 * when the same model is configured on two other connections that are up. The
 * model was never the problem. Changing it changes the answers, the tool
 * behaviour, the context size and the cost, in the middle of a task the user
 * chose that model for; changing provider changes none of those.
 *
 * So the three cases are held apart by name:
 *
 *   ONE PROVIDER LIMITED    -> failover. Same model, another road, no question
 *                              about the model at all.
 *   ALL PROVIDERS LIMITED   -> say so, with a clock. Never a silent downgrade
 *                              to a model nobody asked for.
 *   A DEAD ROUTE            -> not attempted again before its stated time,
 *                              which is what stops the retry loop.
 * ------------------------------------------------------------------------
 */

const assert = require('assert');
const { test } = require('../helpers');

const failover = require('../../src/failover');
const { Availability, STATUS } = require('../../src/availability');
const errors = require('../../src/errors');

const HOUR = 3600000;

/**
 * An app double carrying exactly what failover.js reads: a config with a model
 * and a connection, an availability ledger, and connections to build a catalog
 * from. The catalog is the REAL one — a fake would be a second router, which is
 * the thing this module is written not to be.
 */
function fakeApp({ model = 'model-x', connection = 'alpha', providers = ['alpha', 'beta', 'gamma'] } = {}) {
  // `cfg.connections` is an OBJECT KEYED BY ID — the shape connections.js
  // actually reads. Handing it an array gave every route the id "0", "1", "2",
  // which is a fixture that tests nothing and looks like it tests everything.
  const connections = {};
  for (const id of providers) {
    connections[id] = {
      provider: id,
      protocol: 'chat',
      baseUrl: `https://${id}.example/v1`,
      auth: 'api_key',
      apiKey: 'k',
      models: [model, 'other-model'],
    };
  }
  return {
    cfg: { model, connection, connections },
    connectionEvidence: {},
    availability: new Availability({ failureThreshold: 2 }),
  };
}

/** Mark a connection rate limited for `ms`, the way a real refusal would. */
function limit(app, id, ms = 4 * HOUR) {
  app.availability.noteFailure(id, {
    kind: errors.KIND.RATE_LIMITED, retryAfterMs: ms, message: 'rate limited',
  });
}

module.exports = async function () {
  // =============================================== ONE PROVIDER, TWO ROADS ==

  await test('FAILOVER: one provider rate limited, the same model available on another', () => {
    const app = fakeApp();
    limit(app, 'alpha');

    const routes = failover.routesFor(app, 'model-x');
    assert.strictEqual(routes.length, 3, 'the model is served by three connections');
    const alpha = routes.find((r) => r.connectionId === 'alpha');
    assert.ok(alpha.rateLimited, 'alpha is the one that was limited');
    assert.ok(!alpha.eligible, 'and must not be attempted');
    assert.ok(routes.filter((r) => r.eligible).length === 2, 'the other two are untouched by it');

    const pick = failover.pick(app, { model: 'model-x', exclude: ['alpha'] });
    assert.ok(pick.ok, `an alternative must be found: ${pick.why}`);
    assert.notStrictEqual(pick.route.connectionId, 'alpha');
    assert.strictEqual(pick.route.model, 'model-x', 'THE MODEL DOES NOT CHANGE — that is the whole operation');
    assert.ok(!pick.exhausted);
  });

  await test('FAILOVER: a limit on one provider does NOT make the model unavailable anywhere', () => {
    // The exact confusion named in the brief, asserted as a property of the
    // availability ledger: state is per connection, and always has been.
    const app = fakeApp();
    limit(app, 'alpha');
    assert.ok(!app.availability.shouldAttempt('alpha').allow, 'alpha is closed');
    assert.ok(app.availability.shouldAttempt('beta').allow, 'beta knows nothing about alpha');
    assert.ok(app.availability.shouldAttempt('gamma').allow, 'and neither does gamma');
    // And the model itself is still reachable, which is the sentence that matters.
    assert.ok(failover.routesFor(app, 'model-x').some((r) => r.eligible),
      'model-x must still be reachable while one of its providers is limited');
  });

  await test('FAILOVER: several providers failing still leaves the survivor, and prefers a proven one', () => {
    const app = fakeApp();
    limit(app, 'alpha');
    limit(app, 'beta');
    // gamma has actually answered before; alpha and beta have not, since a
    // limit is not an answer. A route with a success behind it is the better bet.
    app.availability.noteSuccess('gamma');
    const pick = failover.pick(app, { model: 'model-x', exclude: ['alpha'] });
    assert.ok(pick.ok, pick.why);
    assert.strictEqual(pick.route.connectionId, 'gamma');
    assert.strictEqual(pick.route.status, STATUS.AVAILABLE);
  });

  // ================================================== EVERY ROAD IS CLOSED ==

  await test('FAILOVER: all providers rate limited is reported AS THAT, and changes no model', () => {
    const app = fakeApp();
    limit(app, 'alpha', 2 * HOUR);
    limit(app, 'beta', 3 * HOUR);
    limit(app, 'gamma', 1 * HOUR);

    const pick = failover.pick(app, { model: 'model-x', exclude: ['alpha'] });
    assert.ok(!pick.ok, 'there is nowhere to go');
    assert.ok(pick.exhausted, 'and the reason is that every road is closed, not that none exist');
    assert.ok(/all 3 providers/i.test(pick.why), `the count must be stated: ${pick.why}`);
    assert.ok(pick.resumeAt > Date.now(), 'with the earliest reset, because waiting needs a number');
    // The soonest is gamma's hour, not beta's three.
    assert.ok(pick.resumeAt - Date.now() <= 1 * HOUR + 1000, `the EARLIEST reset: ${pick.resumeAt - Date.now()}ms`);
    // AND NOTHING WAS SILENTLY SWITCHED.
    assert.strictEqual(app.cfg.model, 'model-x');
    assert.strictEqual(app.cfg.connection, 'alpha');
  });

  await test('FAILOVER: a single-route model says so, which is not the same as exhausted', () => {
    const app = fakeApp({ providers: ['alpha'] });
    limit(app, 'alpha');
    const pick = failover.pick(app, { model: 'model-x', exclude: ['alpha'] });
    assert.ok(!pick.ok);
    assert.ok(!pick.exhausted, 'there was never an alternative — that is a different situation');
    assert.ok(/one connection only/.test(pick.why), pick.why);
  });

  // ===================================================== NO RETRY LOOPING ===

  await test('LOOP: a rate-limited connection is not attempted again before its stated time', () => {
    // The gate every request passes. Without this the turn loop retries the
    // same refusal until its budget runs out, which is the loop the brief names.
    const a = new Availability({ failureThreshold: 2 });
    a.noteFailure('alpha', { kind: errors.KIND.RATE_LIMITED, retryAfterMs: 2 * HOUR, message: 'slow down' });

    const gate = a.shouldAttempt('alpha');
    assert.strictEqual(gate.allow, false, 'a known limit must close the door before any socket');
    assert.strictEqual(gate.rateLimited, true, 'and say WHY it is closed');
    assert.ok(gate.retryAfterMs > HOUR, 'carrying the time, so the caller can report it');

    // ONE failure is enough. The breaker needs two; a limit needs none, because
    // the server already told us when to come back.
    assert.strictEqual(a.get('alpha').consecutiveFailures, 1);
  });

  await test('LOOP: the door opens by itself once the stated time has passed', () => {
    const a = new Availability({ failureThreshold: 5 });
    a.noteFailure('alpha', { kind: errors.KIND.RATE_LIMITED, retryAfterMs: 1000, message: 'slow down' });
    assert.ok(!a.shouldAttempt('alpha', Date.now()).allow);
    const later = Date.now() + 5000;
    assert.ok(a.shouldAttempt('alpha', later).allow, 'past the reset it must be attempted again');
    assert.strictEqual(a.get('alpha').rateLimited, false, 'and the flag is dropped, not left to block forever');
  });

  await test('LOOP: /provider retry clears the limit, because the user said to try it', () => {
    // The control has to actually do something. It closed the breaker and left
    // `rateLimited` set with a reset hours away, so the gate would have gone on
    // refusing a route the user had just re-enabled by hand.
    const a = new Availability();
    a.noteFailure('alpha', { kind: errors.KIND.RATE_LIMITED, retryAfterMs: 4 * HOUR, message: 'limited' });
    assert.ok(!a.shouldAttempt('alpha').allow);
    a.retry('alpha');
    assert.ok(a.shouldAttempt('alpha').allow, '/provider retry must make the next request happen');
    assert.strictEqual(a.get('alpha').rateLimited, false);
    a.noteFailure('alpha', { kind: errors.KIND.RATE_LIMITED, retryAfterMs: 4 * HOUR, message: 'limited' });
    a.enable('alpha');
    assert.ok(a.shouldAttempt('alpha').allow, '/provider enable too');
  });

  await test('LOOP: a request that SUCCEEDS proves the limit cleared', () => {
    const a = new Availability();
    a.noteFailure('alpha', { kind: errors.KIND.RATE_LIMITED, retryAfterMs: 4 * HOUR, message: 'limited' });
    a.noteSuccess('alpha');
    assert.strictEqual(a.get('alpha').rateLimited, false);
    assert.ok(a.shouldAttempt('alpha').allow);
  });

  // ================================================== THE THREE STEER CASES ==

  await test('STEER: same model / different provider is a PROVIDER FAILOVER', () => {
    const app = fakeApp();
    const v = failover.classify(app, { connection: 'beta' });
    assert.strictEqual(v.kind, failover.ROUTE.PROVIDER_FAILOVER);
    assert.strictEqual(v.sameModel, true);
  });

  await test('STEER: different model / same provider is a MODEL CHANGE', () => {
    const app = fakeApp();
    const v = failover.classify(app, { model: 'other-model' });
    assert.strictEqual(v.kind, failover.ROUTE.MODEL_CHANGE);
    assert.strictEqual(v.sameConn, true);
  });

  await test('STEER: different model AND provider is named as both', () => {
    const app = fakeApp();
    const v = failover.classify(app, { model: 'other-model', connection: 'beta' });
    assert.strictEqual(v.kind, failover.ROUTE.MODEL_AND_PROVIDER);
  });

  await test('STEER: "/steer to <provider>" moves the provider and PRESERVES the model', () => {
    const app = fakeApp();
    const r = failover.steer(app, 'to beta');
    assert.ok(r.handled && r.ok, JSON.stringify(r));
    assert.strictEqual(r.kind, failover.ROUTE.PROVIDER_FAILOVER);
    assert.strictEqual(app.cfg.connection, 'beta', 'the provider moved');
    assert.strictEqual(app.cfg.model, 'model-x', 'THE MODEL DID NOT');
    assert.ok(/PROVIDER FAILOVER/.test(r.message), `it must be named as a failover: ${r.message}`);
    assert.ok(/stays the model/.test(r.message));
  });

  await test('STEER: steering to a provider that does not serve the model is REFUSED', () => {
    // Otherwise it is a model change wearing a provider's name — the confusion
    // this whole module exists to end, arriving through the front door.
    const app = fakeApp();
    app.cfg.connections.gamma.models = ['other-model'];
    const r = failover.steer(app, 'to gamma');
    assert.ok(r.handled && !r.ok, JSON.stringify(r));
    assert.ok(/would change the model, not the provider/.test(r.message), r.message);
    assert.strictEqual(app.cfg.connection, 'alpha', 'and nothing moved');
  });

  await test('STEER: "/steer to <model>" is a model change and says so', () => {
    const app = fakeApp();
    const r = failover.steer(app, 'to other-model');
    assert.ok(r.handled && r.ok, JSON.stringify(r));
    assert.strictEqual(app.cfg.model, 'other-model');
    assert.ok(/DIFFERENT MODEL/.test(r.message), r.message);
  });

  await test('STEER: an ordinary instruction is NOT captured as a route', () => {
    // `/steer` exists to correct a running task. Any reading of these as a
    // route would silently swallow the instruction.
    const app = fakeApp();
    for (const s of [
      'stop editing files and read the logs first',
      'to be clear, use the existing helper',
      'via the API, not the CLI',
      'the tests are failing, look at them',
    ]) {
      const r = failover.steer(app, s);
      assert.ok(!r.handled, `"${s}" must stay an instruction, got ${JSON.stringify(r)}`);
    }
    assert.strictEqual(app.cfg.connection, 'alpha', 'and nothing was routed anywhere');
  });

  await test('STEER: an explicit "provider <name>" that resolves to nothing is an ERROR, not an instruction', () => {
    const app = fakeApp();
    const r = failover.steer(app, 'provider nonesuch');
    assert.ok(r.handled && !r.ok, JSON.stringify(r));
    assert.ok(/no model or connection called/.test(r.message), r.message);
  });

  await test('STEER: "/steer routes" reports the actual state of every road to this model', () => {
    const app = fakeApp();
    limit(app, 'alpha', 2 * HOUR);
    const r = failover.steer(app, 'routes');
    assert.ok(r.handled && r.ok);
    assert.ok(/3 connection/.test(r.message), r.message);
    assert.ok(/alpha/.test(r.detail) && /RATE LIMITED/.test(r.detail), r.detail);
    assert.ok(/beta/.test(r.detail) && /available/.test(r.detail), r.detail);
    // A COUNTDOWN, not just a flag: "when does this clear" is the question.
    assert.ok(/clears in/.test(r.detail), r.detail);
  });

  await test('STEER: steering to where you already are says so and changes nothing', () => {
    const app = fakeApp();
    const r = failover.steer(app, 'to alpha');
    assert.ok(r.handled && r.ok);
    assert.strictEqual(r.kind, failover.ROUTE.UNCHANGED);
    assert.strictEqual(app.cfg.connection, 'alpha');
  });

  await test('STEER: keeps working AFTER a failover — the new route is the one it steers from', () => {
    const app = fakeApp();
    limit(app, 'alpha');
    // Fail over once...
    const first = failover.steer(app, 'to beta');
    assert.ok(first.ok);
    assert.strictEqual(app.cfg.connection, 'beta');
    // ...then the route report is about where we actually are now.
    const routes = failover.routesFor(app, app.cfg.model);
    assert.ok(routes.find((r) => r.connectionId === 'beta').current, 'beta is now the current route');
    assert.ok(!routes.find((r) => r.connectionId === 'alpha').current);
    // ...and steering again still works, and still preserves the model.
    limit(app, 'beta');
    const second = failover.steer(app, 'to gamma');
    assert.ok(second.handled && second.ok, JSON.stringify(second));
    assert.strictEqual(second.kind, failover.ROUTE.PROVIDER_FAILOVER);
    assert.strictEqual(app.cfg.model, 'model-x', 'two failovers later, the model is still the one that was asked for');
    assert.strictEqual(app.cfg.connection, 'gamma');
  });

  await test('STEER: steering onto a limited route warns rather than pretending it will work', () => {
    const app = fakeApp();
    limit(app, 'beta');
    const r = failover.steer(app, 'to beta');
    assert.ok(r.handled && r.ok, 'the user asked for it, so it is done');
    assert.ok(r.warning, 'but they are told what they have chosen');
    assert.ok(/rate limited/.test(r.detail), r.detail);
  });

  // ================================================ THE OFFER THE USER SEES ==

  await test('OFFER: the rate-limit question leads with the failover when one exists', () => {
    const rl = require('../../src/ratelimit');
    const a = rl.adapter({
      provider: 'alpha', resumeAt: Date.now() + 4 * HOUR, model: 'model-x',
      alternative: { connectionId: 'beta' }, exhausted: false, routes: 3,
    });
    const values = a.items.filter((i) => i.value).map((i) => i.value);
    assert.deepStrictEqual(values, [rl.CHOICE.FAILOVER, rl.CHOICE.WAIT, rl.CHOICE.CHANGE],
      'the cheapest correct answer is offered first');
    assert.strictEqual(a.items[a.cursor].value, rl.CHOICE.FAILOVER, 'and is what Enter selects');
    const failoverRow = a.items.find((i) => i.value === rl.CHOICE.FAILOVER).label;
    assert.ok(/same model/i.test(failoverRow), `it must say the model is preserved: ${failoverRow}`);
    assert.ok(/beta/.test(failoverRow), 'and name where it is going');
  });

  await test('OFFER: with every road closed it says THAT, and never offers a phantom failover', () => {
    const rl = require('../../src/ratelimit');
    const a = rl.adapter({
      provider: 'alpha', resumeAt: Date.now() + HOUR, model: 'model-x',
      alternative: null, exhausted: true, routes: 3,
    });
    const values = a.items.filter((i) => i.value).map((i) => i.value);
    assert.deepStrictEqual(values, [rl.CHOICE.WAIT, rl.CHOICE.CHANGE]);
    const said = a.items.map((i) => i.label).join(' | ');
    assert.ok(/All 3 configured providers/.test(said), `the real state must be reported: ${said}`);
    // AND NOT AS A DEAD MODEL.
    assert.ok(!/unavailable/i.test(said), 'the model is not unavailable — its providers are limited');
  });

  await test('OFFER: a skipped turn on a limited route still reaches the failover question', () => {
    // Once the gate starts refusing the route (which is what stops the retry
    // loop), the turn ends WITHOUT a classified error. Reported as a generic
    // provider failure it would never reach the rate-limit handler, and the
    // fix for the loop would have hidden the way out of it.
    const turnclose = require('../../src/turnclose');
    const gate = { allow: false, status: STATUS.DEGRADED, rateLimited: true, reason: 'rate limited', resumeAt: Date.now() + HOUR, retryAfterMs: HOUR };
    const f = turnclose.skipped({ provider: 'alpha' }, 'alpha', gate, true);
    assert.strictEqual(f.kind, errors.KIND.RATE_LIMITED);
    assert.ok(f.skipped, 'and it is honest that no request was sent');
    assert.ok(f.resumeAt > Date.now());
    // An unreachable route is NOT reported as a rate limit.
    const dead = turnclose.skipped({ provider: 'alpha' }, 'alpha', { allow: false, status: STATUS.UNAVAILABLE, reason: 'unreachable' }, false);
    assert.strictEqual(dead.kind, STATUS.UNAVAILABLE);
  });
};
