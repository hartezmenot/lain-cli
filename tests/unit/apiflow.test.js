'use strict';

/**
 * `/api <credential>` — the flow that did not exist.
 *
 * `/api` had `refresh` and `status` and no way to GIVE LAIN a key: it had to be
 * written into config.json by hand, and the model then named by id because
 * nothing had asked the route what it served. Every piece was present and none
 * of them were joined up.
 *
 * WHAT IS ASSERTED HERE is the join and the refusals — which provider was asked
 * for, what got stored, what happens when discovery fails, and the two places
 * the flow must decline rather than guess. The PICKER'S DRAWING is asserted in
 * `picker.test.js`; the real-terminal behaviour in `tests/smoke/frames.test.js`.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const apiMod = require('../../src/apicommand');
const providers = require('../../src/providers');

const C = new Proxy({}, { get: () => (s) => String(s) });

/**
 * An app with a scripted panel, so the flow can be driven without a terminal.
 *
 * `answers` is what the user "picks", in order. A `null` is Esc.
 */
function rig({ answers = [], connections = [], discover = null, cfg = {} } = {}) {
  const written = [];
  const asked = [];
  const saved = [];
  const app = {
    cfg,
    connections: () => connections,
    render: { write: (s) => written.push(String(s)) },
    ui: {
      enabled: true,
      async ask(adapter) {
        asked.push(adapter);
        return answers.length ? answers.shift() : null;
      },
    },
  };
  const config = { save: (c) => { saved.push(JSON.parse(JSON.stringify(c))); } };
  const conns = require('../../src/connections');
  const realDiscover = conns.discover;
  const realWrite = conns.writeCache;
  // ---- THE STUB ANSWERS WHAT THE REAL FUNCTION ANSWERS -------------------
  //
  // THE BUG THIS FILE USED TO HIDE. These stubs returned an ARRAY of model
  // ids. `connections.discover` returns `{ ok, count, models, url }`, and
  // apicommand.js was reading `.length` off it — so on a real provider the
  // check `!models.length` was always true and every successful discovery was
  // reported as "listed no models", one step before the model picker the whole
  // flow exists to open. Every test here passed, because every test here was
  // handing the code a shape the real function never produces.
  //
  // A stub that is not the thing it stands in for proves the stub works. The
  // helper below now builds the real result shape from a list of ids, so a
  // test says WHAT the provider served and the flow sees what it would really
  // see. See tests/smoke/apiflow-fixture.test.js, which removes the stub
  // entirely and talks to an HTTP server.
  const asResult = (models) => (Array.isArray(models)
    ? { ok: models.length > 0, count: models.length, models, url: 'https://example.invalid/v1/models' }
    : models);
  conns.discover = discover ? (async (...a) => asResult(await discover(...a)))
    : (async () => asResult(['a/one', 'a/two']));
  conns.writeCache = () => {};
  const restore = () => { conns.discover = realDiscover; conns.writeCache = realWrite; };
  return { app, config, written, asked, saved, restore, out: () => written.join('') };
}

/** The model picker is the last step; stub it so the flow can be observed. */
async function withStubbedPicker(fn) {
  // AWAITED, or the `finally` restores the real picker before the flow it is
  // stubbing has reached it — and the real one then runs against a stub app.
  // A synchronous try/finally around an async callback restores at the first
  // await, which is a bug that looks exactly like the stub not working.
  const p = require('../../src/modelcommand');
  const real = p.pickCommand;
  const calls = [];
  p.pickCommand = (...a) => { calls.push(a); return undefined; };
  try { return await fn(calls); } finally { p.pickCommand = real; }
}

module.exports = async function () {
  await test('API: a subcommand is never mistaken for a credential', () => {
    for (const s of ['refresh', 'status', 'REFRESH', 'help']) {
      assert.strictEqual(apiMod.looksLikeCredential(s), false, `${s} is a subcommand`);
    }
  });

  await test('API: a credential is anything that is not one — not a key-shaped regex', () => {
    // A shape pattern written today refuses the provider that appears tomorrow,
    // which is the hardcoded-provider-list failure one level down.
    for (const s of ['sk-abc123456789', 'sk-proj-AAAA', 'tr_live_9f2a4b8c', 'ghp_XXXXXXXXXXXX']) {
      assert.strictEqual(apiMod.looksLikeCredential(s), true, `${s} is a credential`);
    }
    // Something with spaces is a mistyped command, not a key.
    assert.strictEqual(apiMod.looksLikeCredential('my key here'), false);
    assert.strictEqual(apiMod.looksLikeCredential('x'), false);
  });

  await test('API: a PROVIDER NAME is never mistaken for a key', () => {
    // `/api openrouter` is somebody asking about a route. It is ten characters
    // with no spaces, so the length test alone stored the WORD as the
    // credential and reported success — after which the route fails to
    // authenticate for a reason nothing on screen explains.
    const cfg = { connections: { 'lain:myrouter': { provider: 'myrouter', baseUrl: 'https://r.example/v1' } } };
    for (const name of ['openrouter', 'anthropic', 'openai', 'ollama', 'myrouter']) {
      assert.strictEqual(apiMod.looksLikeCredential(name, cfg), false,
        `${name} is a route, not a key`);
    }
    // And the exclusion comes from the SAME list the picker is built from, so
    // it cannot drift out of step with what is offered.
    for (const p of providers.choices(cfg)) {
      assert.strictEqual(apiMod.looksLikeCredential(p.id, cfg), false, p.id);
    }
    // A real credential still gets through.
    assert.strictEqual(apiMod.looksLikeCredential('sk-abc123456789', cfg), true);
  });

  await test('API: the credential is never echoed — only its shape', () => {
    const s = apiMod.shapeOf('sk-proj-abcdefghijklmnop9f2a');
    assert.ok(!s.includes('abcdefgh'), `the middle is gone: ${s}`);
    assert.ok(s.startsWith('sk-') && s.endsWith('9f2a'), `recognisable at both ends: ${s}`);
  });

  await test('API: a picked provider is stored under lain:<provider> with ITS endpoint', async () => {
    const r = rig({ answers: ['anthropic'], cfg: {} });
    try {
      await withStubbedPicker(async () => {
        await apiMod.credentialFlow(r.app, 'sk-test-credential', {
          C, config: r.config, refreshCatalog: async () => {},
        });
      });
    } finally { r.restore(); }
    const saved = r.saved[r.saved.length - 1];
    const id = providers.connectionIdFor('anthropic');
    assert.ok(saved && saved.connections && saved.connections[id], `stored under ${id}`);
    const conn = saved.connections[id];
    assert.strictEqual(conn.apiKey, 'sk-test-credential');
    assert.strictEqual(conn.via, 'native', 'LAIN holds this key, so it is a native route');
    assert.strictEqual(conn.auth, 'api_key');
    // THE ENDPOINT IS THE ONE IN THE TABLE, never one typed by this flow.
    assert.strictEqual(conn.baseUrl, providers.byId('anthropic').baseUrl);
    assert.strictEqual(conn.protocol, 'anthropic', 'and its wire protocol comes with it');
  });

  await test('API: Esc at the provider question stores NOTHING', async () => {
    const r = rig({ answers: [null] });
    try {
      await withStubbedPicker(async () => {
        await apiMod.credentialFlow(r.app, 'sk-test-credential', {
          C, config: r.config, refreshCatalog: async () => {},
        });
      });
    } finally { r.restore(); }
    assert.strictEqual(r.saved.length, 0, 'nothing was written to config');
    assert.match(r.out(), /Cancelled/);
  });

  await test('API: an unknown provider is ASKED for its endpoint, never guessed', async () => {
    // The security argument in providers.js: a guessed base URL is a guessed
    // place to send somebody's key.
    const r = rig({ answers: ['__other__', 'https://router.example/v1'] });
    try {
      await withStubbedPicker(async () => {
        await apiMod.credentialFlow(r.app, 'tr_live_9f2a4b8c', {
          C, config: r.config, refreshCatalog: async () => {},
        });
      });
    } finally { r.restore(); }
    assert.strictEqual(r.asked.length, 2, 'it asked twice: which provider, then where');
    const saved = r.saved[r.saved.length - 1];
    const conn = Object.values(saved.connections)[0];
    assert.strictEqual(conn.baseUrl, 'https://router.example/v1');
    assert.strictEqual(conn.provider, 'router.example', 'named after the host, so it is referable');
  });

  await test('API: a base URL that is not one is refused, and nothing is stored', async () => {
    const r = rig({ answers: ['__other__', 'not-a-url'] });
    try {
      await withStubbedPicker(async () => {
        await apiMod.credentialFlow(r.app, 'tr_live_9f2a4b8c', {
          C, config: r.config, refreshCatalog: async () => {},
        });
      });
    } finally { r.restore(); }
    assert.strictEqual(r.saved.length, 0, 'a credential is not stored against a non-URL');
    assert.match(r.out(), /http:\/\/ or https:\/\//);
  });

  await test('API: discovery failure KEEPS the credential and says why', async () => {
    // A transient network failure must not look like a typo — the user would
    // paste the same key again to no better effect.
    const id = providers.connectionIdFor('openai');
    const r = rig({
      answers: ['openai'],
      connections: [{ id, provider: 'openai', baseUrl: 'https://api.openai.com/v1' }],
      discover: async () => { throw new Error('401 Unauthorized'); },
    });
    try {
      await withStubbedPicker(async (picker) => {
        await apiMod.credentialFlow(r.app, 'sk-test-credential', {
          C, config: r.config, refreshCatalog: async () => {},
        });
        assert.strictEqual(picker.length, 0, 'and it does not open an empty model picker');
      });
    } finally { r.restore(); }
    const saved = r.saved[r.saved.length - 1];
    assert.ok(saved.connections[id].apiKey, 'the credential is kept');
    assert.match(r.out(), /401 Unauthorized/, "the provider's own words are shown");
    assert.match(r.out(), /\/api refresh/, 'and the way to try again is named');
  });

  await test('API: an empty model list is a failure, not an empty picker', async () => {
    const id = providers.connectionIdFor('openai');
    const r = rig({
      answers: ['openai'],
      connections: [{ id, provider: 'openai', baseUrl: 'https://api.openai.com/v1' }],
      discover: async () => [],
    });
    try {
      await withStubbedPicker(async (picker) => {
        await apiMod.credentialFlow(r.app, 'sk-test-credential', {
          C, config: r.config, refreshCatalog: async () => {},
        });
        assert.strictEqual(picker.length, 0, 'no picker is opened over nothing');
      });
    } finally { r.restore(); }
    assert.match(r.out(), /listed no models/);
  });

  await test('API: discovery succeeding opens THE model picker, not a copy of it', async () => {
    const id = providers.connectionIdFor('openai');
    const r = rig({
      answers: ['openai'],
      connections: [{ id, provider: 'openai', baseUrl: 'https://api.openai.com/v1' }],
      discover: async () => ['openai/gpt-x', 'openai/gpt-y'],
    });
    try {
      await withStubbedPicker(async (picker) => {
        await apiMod.credentialFlow(r.app, 'sk-test-credential', {
          C, config: r.config, refreshCatalog: async () => {},
        });
        assert.strictEqual(picker.length, 1, 'modelcommand.pickCommand — the same one /models opens');
      });
    } finally { r.restore(); }
    assert.match(r.out(), /2 model\(s\)/);
  });

  await test('API: with no terminal it declines rather than guessing a provider', async () => {
    const r = rig({});
    r.app.ui.enabled = false;
    try {
      await withStubbedPicker(async () => {
        await apiMod.credentialFlow(r.app, 'sk-test-credential', {
          C, config: r.config, refreshCatalog: async () => {},
        });
      });
    } finally { r.restore(); }
    assert.strictEqual(r.saved.length, 0, 'no credential is stored against an unnamed route');
    assert.match(r.out(), /config\.json/, 'and the non-interactive way is named');
  });

  // ------------------------------------------------------------- registry ---

  await test('PROVIDERS: every known endpoint is a real absolute https URL', () => {
    // These are hosts a credential is POSTed to. A typo here is a secret sent
    // to whoever owns the name.
    for (const p of providers.KNOWN) {
      assert.ok(/^https:\/\/[a-z0-9.-]+\//i.test(p.baseUrl), `${p.id}: ${p.baseUrl}`);
      assert.ok(p.protocol === 'chat' || p.protocol === 'anthropic', `${p.id} protocol`);
      assert.ok(p.label && p.envKey, `${p.id} is named and has an env route`);
    }
  });

  await test('PROVIDERS: connections.js and the picker read ONE table', () => {
    // The env routes used to be written out in connections.js and again in
    // provider.js, so "where does an OpenAI key go" had two answers that were
    // equal only by coincidence — and neither was reachable from `/api`.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'connections.js'), 'utf8');
    assert.match(src, /require\('\.\/providers'\)\.envRoutes\(\)/,
      'connections.js takes its endpoints from the table');
    assert.ok(!/api\.openai\.com/.test(src), 'and keeps no private copy of them');
  });

  await test('PROVIDERS: a configured route is offered; a BRIDGE route never is', () => {
    // A bridge authenticates upstream itself, so LAIN has no use for a key —
    // offering it would invite storing a secret for nothing.
    const list = providers.choices({
      connections: {
        'lain:myrouter': { provider: 'myrouter', baseUrl: 'https://r.example/v1' },
        'bridge:omniroute': { provider: 'omniroute', via: 'bridge', baseUrl: 'http://localhost:1/v1' },
      },
    });
    const ids = list.map((p) => p.id);
    assert.ok(ids.includes('myrouter'), 'the user\'s own route is offered');
    assert.ok(!ids.includes('omniroute'), 'the bridge route is not');
    // And it carries the user's OWN endpoint, not one LAIN made up.
    assert.strictEqual(list.find((p) => p.id === 'myrouter').baseUrl, 'https://r.example/v1');
  });

  await test('PROVIDERS: `Other…` is on the FIRST screen, not below the fold', () => {
    // ---- WHY THIS IS PINNED BY POSITION ---------------------------------
    //
    // The panel shows about ten rows. `Other…` — "I know where my key goes,
    // let me type the URL" — is the one row that works for every provider in
    // existence, and it used to be last. That was right at twelve rows and
    // wrong the moment the list reached twenty-one: the escape hatch fell two
    // screens below the fold, behind the rows LAIN can do LEAST with.
    //
    // So the order is by READINESS — pick-and-go, then `Other…`, then the names
    // LAIN cannot place (which are the same action as `Other…` with the name
    // filled in). Nothing is hidden and nothing is guessed; only the order.
    // ASSERTED AS AN ORDER, NOT AS AN INDEX. A machine with twenty working
    // routes configured legitimately pushes `Other…` further down, and those
    // rows are all pick-and-go — nothing is buried by them. What must never
    // happen is a row LAIN CANNOT USE standing in front of the escape hatch.
    const { providerAdapter } = require('../../src/apicommand');
    const list = providers.choices({ connections: {} });
    const items = providerAdapter(list).items;
    const at = items.findIndex((i) => /^Other/.test(i.label));
    assert.ok(at >= 0, '`Other…` must be offered at all');
    assert.strictEqual(at, list.filter((p) => p.baseUrl).length,
      '`Other…` must sit immediately after the rows that can be picked and used');
    for (const i of items.slice(0, at)) {
      assert.ok(!/needs an endpoint/.test(i.label),
        `a row that cannot be used yet sits above \`Other…\`: ${i.label}`);
    }
    // With nothing configured, that puts it inside the panel's first screen —
    // derived from the built-in table rather than from a magic number, so
    // adding a known endpoint cannot silently push it under the fold again.
    assert.ok(providers.KNOWN.length + 1 <= 10,
      'the built-in table has outgrown the first screen — `Other…` needs a new home');
    // And nothing was dropped to achieve any of it.
    assert.strictEqual(items.length, list.length + 1);
  });

  await test('PROVIDERS: the temp home is untouched by any of this', () => {
    // These tests write no config of their own; `config.save` is stubbed. This
    // pins that, because a flow whose whole job is writing credentials is the
    // last one that should be able to reach the real store by accident.
    const home = process.env.LAIN_CONFIG_DIR;
    assert.ok(home && path.resolve(home) !== path.resolve(path.join(os.homedir(), '.lain-v2')));
  });
};
