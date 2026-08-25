'use strict';

/**
 * ONE MODEL IS NOT ONE CHOICE WHEN TWO ROUTES SERVE IT.
 *
 * Reported from real use: `/model <name>` where two providers serve that name
 * picked one without asking. It took `m.connections[0]` — whichever the catalog
 * happened to list first — committed it, and THEN printed "2 routes serve this
 * model" underneath. The one moment the user was making a decision was the
 * moment LAIN made it for them, and the list of alternatives was a report on a
 * choice already taken.
 *
 * The name narrows it to one MODEL. Which provider serves it is a second
 * question with real differences behind it — price, rate limits, effort levels,
 * and which one is answering right now.
 */

const assert = require('assert');
const { test } = require('../helpers');

const mc = require('../../src/modelcommand');

/** A model served by `n` routes. */
function model(n) {
  const conns = [];
  for (let i = 0; i < n; i++) {
    conns.push({
      connectionId: `route${i}`, baseConnectionId: `route${i}`,
      provider: 'anthropic', via: 'bridge', efforts: i === 0 ? ['high'] : [],
    });
  }
  return { id: 'claude-opus-5', displayName: 'Claude Opus 5', connections: conns };
}

/** An app whose panel answers with `answer`, recording what it was asked. */
function harness(m, { enabled = true, answer = null } = {}) {
  const state = { asked: null, wrote: [], saved: 0 };
  const app = {
    cfg: {},
    availability: { get: () => ({ status: 'UNKNOWN' }) },
    connections: () => m.connections.map((c) => ({ id: c.connectionId })),
    ensureCatalog: async () => {},
    catalog: () => ({ models: [m], byId: new Map([[m.id, m]]) }),
    render: { write: (s) => state.wrote.push(s) },
    ui: {
      enabled,
      refresh() {},
      ask: async (adapter) => {
        state.asked = adapter;
        // The picker reports through onPickRoute, exactly as the browser does.
        if (answer) {
          const c = m.connections.find((x) => x.connectionId === answer);
          const item = (adapter.items || []).find((it) => it && it.value);
          if (adapter.onPickRoute) adapter.onPickRoute(m, c);
          else if (item && item.onPick) item.onPick(m, c);
        }
        return answer;
      },
    },
  };
  const C = new Proxy({}, { get: () => (s) => s });
  const api = { C, config: { save: () => { state.saved += 1; } }, refreshCatalog: () => {} };
  return { app, state, api, said: () => state.wrote.join('') };
}

module.exports = async function () {
  await test('ROUTES: with TWO providers, it asks instead of choosing for you', async () => {
    const m = model(2);
    const h = harness(m);
    await mc.pickCommand(h.app, { args: ['claude-opus-5'], rest: 'claude-opus-5' }, h.api);
    assert.ok(h.state.asked, 'a question must be asked');
    assert.match(String(h.state.asked.title), /2 routes/i, 'and it must be the ROUTE question');
  });

  await test('ROUTES: Escape leaves the model UNCHANGED — cancelling is not choosing', async () => {
    const m = model(2);
    const h = harness(m, { answer: null });
    await mc.pickCommand(h.app, { args: ['claude-opus-5'], rest: 'claude-opus-5' }, h.api);
    assert.strictEqual(h.app.cfg.model, undefined, 'nothing may be committed');
    assert.strictEqual(h.state.saved, 0, 'and nothing written to config');
    assert.match(h.said(), /unchanged/);
  });

  await test('ROUTES: with ONE provider there is nothing to ask, and it just selects', async () => {
    // The rule is "ask when something is left to decide" — asking a question
    // with one answer is the other way to waste somebody's time.
    const m = model(1);
    const h = harness(m);
    await mc.pickCommand(h.app, { args: ['claude-opus-5'], rest: 'claude-opus-5' }, h.api);
    assert.strictEqual(h.state.asked, null, 'one route is not a question');
    assert.strictEqual(h.app.cfg.model, 'claude-opus-5');
    assert.strictEqual(h.app.cfg.connection, 'route0');
  });

  await test('ROUTES: naming the connection outright still skips the question', async () => {
    // `/model claude-opus-5 route1` has already answered it.
    const m = model(2);
    const h = harness(m);
    await mc.pickCommand(h.app, { args: ['claude-opus-5', 'route1'], rest: 'claude-opus-5 route1' }, h.api);
    assert.strictEqual(h.state.asked, null, 'the route was named, so nothing is left to decide');
    assert.strictEqual(h.app.cfg.connection, 'route1');
  });

  await test('ROUTES: off a TTY it takes the first route rather than hanging', async () => {
    // A piped `/model x` has nobody to ask. It must still work — and say which
    // route it got, rather than quietly assigning one.
    const m = model(2);
    const h = harness(m, { enabled: false });
    await mc.pickCommand(h.app, { args: ['claude-opus-5'], rest: 'claude-opus-5' }, h.api);
    assert.strictEqual(h.app.cfg.model, 'claude-opus-5');
    assert.strictEqual(h.app.cfg.connection, 'route0');
    assert.match(h.said(), /route0/, 'it must name the route it chose');
    assert.match(h.said(), /2 routes serve this model/, 'and say there were others');
  });
};
