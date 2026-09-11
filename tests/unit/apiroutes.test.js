'use strict';

/**
 * WHERE `/api <word>` GOES, AND WHY A WRONG ANSWER IS EXPENSIVE.
 *
 * ------------------------------------------------------------------------
 * THE THREE THINGS ONE WORD CAN MEAN.
 *
 *     /api sk-abc…        a credential being handed over
 *     /api custom         a route being ADDED
 *     /api lain:custom    a route being RE-KEYED
 *
 * They are told apart by what already exists, not by the shape of the word,
 * because every provider spells its keys differently and a shape pattern
 * written today refuses the provider that appears tomorrow.
 *
 * GETTING IT WRONG STORES A SECRET-SHAPED MISTAKE. A word taken for a
 * credential when it was a route name is written into config as that route's
 * key, and the route then fails to authenticate for a reason nothing on screen
 * explains — which is the failure this file exists to prevent, twice over.
 */

const assert = require('assert');
const { test } = require('../helpers');

const apiMod = require('../../src/apicommand');
const providers = require('../../src/providers');

function fakeApp(connections = []) {
  return { cfg: {}, connections: () => connections, render: { write: () => {} }, ui: { enabled: false } };
}

/** The dispatch in routecommands.js `/api`, in its real order. */
function branchFor(app, first) {
  if (!first) return 'add';
  const sub = String(first).toLowerCase();
  if (sub === 'refresh') return 'refresh';
  if (apiMod.connectionByName(app, first)) return 'rekey';
  if (apiMod.looksLikeCredential(first, app.cfg)) return 'store-credential';
  if (apiMod.providerNamed(app, first)) return 'add';
  return 'status';
}

const CUSTOM = [{ id: 'lain:custom', provider: 'custom', protocol: 'chat', baseUrl: 'https://h/v1', via: 'key' }];

module.exports = async function () {
  // ------------------------------------------------- NOT A CREDENTIAL ----

  await test('API: a connection id is never stored as a credential', () => {
    // THE DEFECT. `connectionByName` accepts `custom`, `lain:custom` and the
    // provider name; `looksLikeCredential` excluded only the bare one, because
    // that is the only spelling `providers.choices` lists. So `/api
    // lain:custom` typed before the route existed was eleven characters with
    // no spaces — therefore a credential — and the literal string was written
    // into config as that route's key.
    assert.strictEqual(apiMod.looksLikeCredential('lain:custom', {}), false);
    assert.strictEqual(apiMod.looksLikeCredential('lain:openrouter', {}), false);
    assert.strictEqual(apiMod.looksLikeCredential('LAIN:custom', {}), false);
    // And the bare form it always refused.
    assert.strictEqual(apiMod.looksLikeCredential('openrouter', {}), false);
  });

  await test('API: a real credential is still recognised as one', () => {
    // The fix must not make `/api <key>` stop working, which is the whole
    // reason the command exists.
    assert.strictEqual(apiMod.looksLikeCredential('sk-abcdef1234567890', {}), true);
    assert.strictEqual(apiMod.looksLikeCredential('gsk_0000111122223333', {}), true);
    // Too short, or containing a space, is not a key.
    assert.strictEqual(apiMod.looksLikeCredential('short', {}), false);
    assert.strictEqual(apiMod.looksLikeCredential('two words here', {}), false);
    // And a subcommand is never a key.
    for (const s of ['refresh', 'status', 'list', 'help']) {
      assert.strictEqual(apiMod.looksLikeCredential(s, {}), false, s);
    }
  });

  // ------------------------------------------------------- ADD vs REKEY --

  await test('API: naming a provider with no route yet ADDS it', () => {
    // `/api custom` used to fall through to the status view: somebody adding
    // that route was shown the routes they already had, and the add path (bare
    // `/api`) was not reachable from what they typed.
    // BUILT-IN NAMES ONLY. `custom` in the operator's own tree comes from
    // their V1 configuration, so it does not exist under the isolated config
    // the runner sets — asserting on it here would pass on one machine and
    // fail on another. `openai` and `bai` are in providers.js `KNOWN`.
    const app = fakeApp([]);
    assert.strictEqual(branchFor(app, 'openai'), 'add');
    assert.strictEqual(branchFor(app, 'bai'), 'add');
    assert.strictEqual(branchFor(app, 'zai'), 'add');
    // The prefixed spelling reaches the same place.
    assert.strictEqual(branchFor(app, 'lain:openai'), 'add');
    assert.strictEqual(branchFor(app, 'lain:bai'), 'add');
  });

  await test('API: naming a route that EXISTS re-keys it, never duplicates it', () => {
    // This one CAN use `custom`: the connection is supplied by the fixture, so
    // it exists regardless of what the machine's config happens to hold.
    const app = fakeApp(CUSTOM);
    for (const spelling of ['custom', 'lain:custom', 'CUSTOM']) {
      assert.strictEqual(branchFor(app, spelling), 'rekey', spelling);
      assert.strictEqual(apiMod.connectionByName(app, spelling).id, 'lain:custom');
    }
  });

  await test('API: re-keying targets the SAME connection id', () => {
    // A second route for the same endpoint is the failure mode: the model list
    // doubles, and the stale key is still there being chosen half the time.
    const app = fakeApp(CUSTOM);
    const conn = apiMod.connectionByName(app, 'custom');
    assert.strictEqual(conn.id, 'lain:custom');
    assert.strictEqual(conn.baseUrl, 'https://h/v1', 'the endpoint is reused, not re-asked');
  });

  await test('API: a bridge route holds no credential to replace', () => {
    const app = fakeApp([{ id: 'lain:bridge', provider: 'x', via: 'bridge', baseUrl: 'https://b/v1' }]);
    const conn = apiMod.connectionByName(app, 'lain:bridge');
    assert.ok(conn, 'it is still found');
    assert.strictEqual(conn.via, 'bridge', 'and rekeyFlow refuses it on this');
  });

  await test('API: an unknown key-shaped word is still taken as a credential', () => {
    // AND THAT IS DELIBERATE, not a gap. LAIN cannot know how a provider it
    // has never heard of spells its keys, so anything that is not a
    // subcommand, not a route and not a provider name is the user handing
    // something over. The picker then asks WHERE it goes, and nothing is
    // stored until they say. What the fixes above removed is the case where a
    // word LAIN *could* recognise was swallowed this way.
    const app = fakeApp(CUSTOM);
    assert.strictEqual(branchFor(app, 'notaprovider'), 'store-credential');
    // A short unknown word is not key-shaped, and falls to the status view.
    assert.strictEqual(branchFor(app, 'nope'), 'status');
  });

  await test('API: refresh still wins over everything', () => {
    // It is a subcommand, and it must not become a provider name or a key.
    assert.strictEqual(branchFor(fakeApp([]), 'refresh'), 'refresh');
    assert.strictEqual(branchFor(fakeApp(CUSTOM), 'refresh'), 'refresh');
  });

  // -------------------------------------------------- ONE TABLE, SHARED --

  await test('API: the add path only offers providers the picker actually lists', () => {
    // `providerNamed` reads `providers.choices` — the same list the picker is
    // built from — so `/api <name>` cannot reach a route the menu does not
    // have, and cannot miss one it does.
    const app = fakeApp([]);
    for (const p of providers.choices({})) {
      assert.ok(apiMod.providerNamed(app, p.id), `${p.id} is offered but not addressable`);
    }
    assert.strictEqual(apiMod.providerNamed(app, 'definitely-not-a-provider'), null);
  });
};
