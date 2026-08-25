'use strict';

/**
 * CATALOG DISCOVERY.
 *
 * This is the gap that took the whole product down, and it was invisible from
 * the code: every module was correct, the tests were green, and a real launch
 * against a real, reachable, already-authenticated bridge advertising 2,760
 * models printed "No models" — so no model could be selected, so provider
 * resolution fell through, so LAIN could not make a single request.
 *
 * A real HTTP server is used rather than a stubbed fetch, because the thing
 * being tested IS the conversation with an endpoint: its shapes, its failures
 * and its silences.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const connections = require('../../src/connections');
const catalog = require('../../src/catalog');

/** A server that answers `/models` however the test needs it to. */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const json = (body) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function isolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-disc-'));
  const prev = process.env.LAIN_CONFIG_DIR;
  process.env.LAIN_CONFIG_DIR = dir;
  return { dir, restore: () => { if (prev === undefined) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = prev; } };
}

module.exports = async function () {
  await test('DISCOVERY: a connection with only a baseUrl ends up with a usable catalog', async () => {
    const home = isolatedHome();
    const s = await serve(json({ data: [{ id: 'vendor/thing-low' }, { id: 'vendor/thing-high' }, { id: 'other/solo' }] }));
    try {
      const cfg = { connections: { bridge: { provider: 'b', via: 'bridge', baseUrl: s.baseUrl } } };
      // Before: nothing. This was the whole failure.
      assert.strictEqual(catalog.build(connections.fromConfig(cfg)).models.length, 0);

      const r = await connections.discover(connections.fromConfig(cfg)[0]);
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.count, 3);

      // After: the SAME synchronous path now answers, because the cache is state.
      const cat = catalog.build(connections.fromConfig(cfg));
      assert.ok(cat.models.length > 0, 'a discovered catalog must be visible to the ordinary read path');
      const thing = catalog.find(cat, 'thing');
      assert.ok(thing, 'effort variants should collapse into one model');
      assert.deepStrictEqual(thing.connections[0].efforts, ['low', 'high']);
    } finally { await s.close(); home.restore(); }
  });

  await test('DISCOVERY: a DECLARED model list is never overruled by discovery', async () => {
    const home = isolatedHome();
    const s = await serve(json({ data: [{ id: 'discovered-one' }] }));
    try {
      const conn = { bridge: { provider: 'b', via: 'bridge', baseUrl: s.baseUrl, models: ['declared-one'] } };
      await connections.discover(connections.fromConfig({ connections: conn })[0]);
      const c = connections.fromConfig({ connections: conn })[0];
      assert.deepStrictEqual(c.models, ['declared-one'], 'the user stating a list is a decision, not a default');
      assert.strictEqual(c.declaredModels, true);
    } finally { await s.close(); home.restore(); }
  });

  await test('DISCOVERY: provider equivalence metadata survives — identity is not flattened', async () => {
    const home = isolatedHome();
    const s = await serve(json({
      data: [
        { id: 'gh/claude-opus-5', root: 'claude-opus-5', owned_by: 'github' },
        { id: 'github/claude-opus-5', root: 'claude-opus-5', parent: 'gh/claude-opus-5', owned_by: 'github' },
      ],
    }));
    try {
      const cfg = { connections: { bridge: { provider: 'b', via: 'bridge', baseUrl: s.baseUrl } } };
      const r = await connections.discover(connections.fromConfig(cfg)[0]);
      assert.strictEqual(r.models[0].root, 'claude-opus-5');
      assert.strictEqual(r.models[1].parent, 'gh/claude-opus-5');
      // Discovery that flattened rows to bare ids would destroy the declared
      // equivalence and re-create the duplicate rows catalog.js exists to stop.
      const cat = catalog.build(connections.fromConfig(cfg));
      assert.strictEqual(cat.models.length, 1, 'the provider declared these are one model');
    } finally { await s.close(); home.restore(); }
  });

  await test('DISCOVERY: `root` echoing the id is not treated as an identity claim', () => {
    const same = connections.normalizeCatalogRow({ id: 'a/b', root: 'a/b' });
    assert.strictEqual(same.root, undefined, 'a router filling the field in is not declaring equivalence');
    const real = connections.normalizeCatalogRow({ id: 'a/b', root: 'b' });
    assert.strictEqual(real.root, 'b');
  });

  await test('DISCOVERY: an unreachable route is an ANSWER, never a throw', async () => {
    const home = isolatedHome();
    try {
      // Port 1 is reserved and refuses immediately.
      const r = await connections.discover({ id: 'dead', baseUrl: 'http://127.0.0.1:1/v1' }, { timeoutMs: 2000 });
      assert.strictEqual(r.ok, false);
      assert.ok(r.error, 'the reason must be reportable — a UI has to keep working with a dead route');
    } finally { home.restore(); }
  });

  await test('DISCOVERY: an HTTP error is reported with its status, not swallowed', async () => {
    const home = isolatedHome();
    const s = await serve((req, res) => { res.writeHead(401); res.end('bad key'); });
    try {
      const r = await connections.discover({ id: 'x', baseUrl: s.baseUrl });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /401/);
    } finally { await s.close(); home.restore(); }
  });

  await test('DISCOVERY: an endpoint that answers with no models is a failure, not an empty success', async () => {
    const home = isolatedHome();
    const s = await serve(json({ data: [] }));
    try {
      const r = await connections.discover({ id: 'x', baseUrl: s.baseUrl });
      assert.strictEqual(r.ok, false, 'an empty catalog cached as a success would mask the real problem');
    } finally { await s.close(); home.restore(); }
  });

  await test('DISCOVERY: a silent socket does not hang — it times out and says so', async () => {
    const home = isolatedHome();
    const s = await serve(() => { /* accept and never answer */ });
    try {
      const started = Date.now();
      const r = await connections.discover({ id: 'x', baseUrl: s.baseUrl }, { timeoutMs: 700 });
      assert.strictEqual(r.ok, false);
      assert.ok(Date.now() - started < 5000, 'a wedged bridge must not freeze the launch');
      assert.match(r.error, /no answer within/);
    } finally { await s.close(); home.restore(); }
  });

  await test('DISCOVERY: at most once per connection per launch, unless forced', async () => {
    const home = isolatedHome();
    let hits = 0;
    const s = await serve((req, res) => { hits += 1; json({ data: [{ id: 'm1' }] })(req, res); });
    try {
      const cfg = { connections: { bridge: { provider: 'b', via: 'bridge', baseUrl: s.baseUrl } } };
      const done = new Set();
      await connections.discoverAll(connections.fromConfig(cfg), { done });
      await connections.discoverAll(connections.fromConfig(cfg), { done });
      await connections.discoverAll(connections.fromConfig(cfg), { done });
      assert.strictEqual(hits, 1, 'discovery must not become a background poll');
      await connections.discoverAll(connections.fromConfig(cfg), { done, force: true });
      assert.strictEqual(hits, 2, '/provider refresh must actually re-ask');
    } finally { await s.close(); home.restore(); }
  });

  await test('DISCOVERY: a fresh cache means a relaunch costs no request at all', async () => {
    const home = isolatedHome();
    let hits = 0;
    const s = await serve((req, res) => { hits += 1; json({ data: [{ id: 'm1' }] })(req, res); });
    try {
      const cfg = { connections: { bridge: { provider: 'b', via: 'bridge', baseUrl: s.baseUrl } } };
      await connections.discoverAll(connections.fromConfig(cfg), { done: new Set() });
      assert.strictEqual(hits, 1);
      // A brand-new launch: nothing remembered in memory, everything on disk.
      assert.deepStrictEqual(connections.needsDiscovery(connections.fromConfig(cfg)), []);
      await connections.discoverAll(connections.fromConfig(cfg), { done: new Set() });
      assert.strictEqual(hits, 1, 'a fresh cache answers without touching the network');
    } finally { await s.close(); home.restore(); }
  });

  await test('DISCOVERY: routes that declare their own models are never contacted', async () => {
    const home = isolatedHome();
    let hits = 0;
    const s = await serve((req, res) => { hits += 1; json({ data: [{ id: 'm1' }] })(req, res); });
    try {
      const cfg = { connections: { bridge: { provider: 'b', via: 'bridge', baseUrl: s.baseUrl, models: ['mine'] } } };
      await connections.discoverAll(connections.fromConfig(cfg), { done: new Set(), force: true });
      assert.strictEqual(hits, 0, 'the user already answered this question');
    } finally { await s.close(); home.restore(); }
  });

  // ------------------------------------------------------ default selection --

  await test('DEFAULT: LAIN refuses to guess a model out of a large catalog', () => {
    const cat = catalog.build([{ id: 'c', provider: 'p', models: ['a', 'b', 'c'] }]);
    assert.strictEqual(catalog.chooseDefault(cat, { connections: { c: {} } }), null,
      'picking models[0] once selected an alphabetically-first video detector as the coding model');
  });

  await test('DEFAULT: a connection may DECLARE its default, and it is honoured', () => {
    const cat = catalog.build([{ id: 'c', provider: 'p', models: ['alpha', 'beta', 'gamma'] }]);
    const r = catalog.chooseDefault(cat, { connections: { c: { default: 'beta' } } });
    assert.strictEqual(r.model.id, 'beta');
    assert.strictEqual(r.source, 'declared');
  });

  await test('DEFAULT: a declared default that is not in the catalog is reported, not silently ignored', () => {
    const cat = catalog.build([{ id: 'c', provider: 'p', models: ['alpha'] }]);
    const r = catalog.chooseDefault(cat, { connections: { c: { default: 'nope' } } });
    assert.ok(r.error, 'a typo in config must be visible');
    assert.match(r.error, /nope/);
  });

  await test('DEFAULT: one model is not a choice, so it is selected', () => {
    const cat = catalog.build([{ id: 'c', provider: 'p', models: ['solo'] }]);
    const r = catalog.chooseDefault(cat, { connections: { c: {} } });
    assert.strictEqual(r.model.id, 'solo');
    assert.strictEqual(r.source, 'only');
  });
};
