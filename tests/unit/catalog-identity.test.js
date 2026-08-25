'use strict';

/**
 * ONE ROW PER MODEL, WHATEVER THE ROUTES CALL IT.
 *
 * The picker showed the same model several times over: routers disagree about
 * punctuation and case for what is otherwise the same identifier, so `GPT_5`
 * and `gpt-5` were two canonical models with one display name between them.
 * Measured on the live 2,994-entry catalog: six such pairs.
 *
 * The rule these hold: fold SPELLING only. No token may be added, dropped or
 * reordered, so two models that merely look alike are never merged — a false
 * merge hides a model, which is worse than showing a duplicate.
 */

const assert = require('assert');
const { test } = require('../helpers');

const catalog = require('../../src/catalog');

/** One bridge connection advertising a list of upstream ids. */
const conn = (id, models, extra = {}) => ({
  id, provider: 'bridge', via: 'bridge', auth: 'none', protocol: 'chat',
  baseUrl: 'http://127.0.0.1:1/v1', models, ...extra,
});

module.exports = async function () {
  await test('IDENTITY: the same model spelled two ways is ONE model, with both routes', () => {
    const cat = catalog.build([conn('a', ['GPT_5']), conn('b', ['gpt-5'])]);
    assert.strictEqual(cat.models.length, 1, 'one model, not two');
    const m = cat.models[0];
    assert.strictEqual(m.id, 'gpt-5', 'the conventional spelling is the canonical one');
    assert.deepStrictEqual(m.connections.map((c) => c.connectionId).sort(), ['a', 'b']);
    assert.deepStrictEqual(m.aliases, ['GPT_5'], 'and the other spelling is remembered');
  });

  await test('IDENTITY: separators fold — underscore, hyphen, dot and case', () => {
    const cat = catalog.build([conn('a', ['claude_sonnet_4', 'claude-sonnet-4', 'Claude.Sonnet.4'])]);
    assert.strictEqual(cat.models.length, 1);
    assert.strictEqual(catalog.foldKey('stepfun/Step-3.5-Flash'), catalog.foldKey('stepfun/step-3.5-flash'));
  });

  await test('IDENTITY: a genuinely different model is NEVER merged', () => {
    // Same prefix, an extra token — a different model, and it stays one.
    const cat = catalog.build([conn('a', ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'])]);
    assert.strictEqual(cat.models.length, 3, `merged distinct models: ${cat.models.map((m) => m.id).join(', ')}`);
    // Different vendors keep their qualifier and stay apart.
    const two = catalog.build([conn('a', ['anthropic/claude-opus-5', 'openai/claude-opus-5'])]);
    assert.strictEqual(two.models.length, 2, 'the same name under two vendors is two models');
  });

  await test('IDENTITY: the old spelling still RESOLVES — a saved config keeps working', () => {
    // Someone who selected GPT_5 last week must not find their model gone.
    const cat = catalog.build([conn('a', ['GPT_5']), conn('b', ['gpt-5'])]);
    assert.ok(cat.byId.get('GPT_5'), 'the alias must resolve');
    assert.strictEqual(cat.byId.get('GPT_5'), cat.byId.get('gpt-5'), 'to the same model');
    const r = catalog.resolve(cat, { model: 'GPT_5' });
    assert.strictEqual(r.ok, true, r.error);
  });

  await test('IDENTITY: the same model on many routes is ONE row that says how many', () => {
    const cat = catalog.build([
      conn('r1', ['claude-sonnet-5']), conn('r2', ['claude-sonnet-5']),
      conn('r3', ['Claude_Sonnet_5']), conn('r4', ['claude-sonnet-5']),
    ]);
    assert.strictEqual(cat.models.length, 1);
    assert.strictEqual(cat.models[0].connections.length, 4, 'every route is kept under the one model');
    const { modelsAdapter } = require('../../src/ui/panel');
    const label = modelsAdapter({ catalog: cat }).items[0].label;
    assert.match(label, /4 providers/, `the row must say there is a choice: ${label}`);
  });

  await test('IDENTITY: search finds a model by either spelling, and returns it once', () => {
    const cat = catalog.build([conn('a', ['GPT_5']), conn('b', ['gpt-5'])]);
    const hits = catalog.search(cat, 'gpt 5');
    assert.strictEqual(hits.length, 1, `search returned duplicates: ${hits.map((h) => h.id).join(', ')}`);
    assert.strictEqual(hits[0].id, 'gpt-5');
  });

  await test('IDENTITY: a refresh does not invent new canonical entries', () => {
    // The NEW marker is computed from the catalog diff, so an unstable identity
    // would mark models as new every single refresh.
    const before = catalog.build([conn('a', ['GPT_5']), conn('b', ['gpt-5'])]);
    const after = catalog.build([conn('a', ['GPT_5']), conn('b', ['gpt-5'])]);
    const d = catalog.diff(before, after, null);
    assert.deepStrictEqual(d.added, [], 'nothing changed, so nothing is new');
    assert.deepStrictEqual(d.removed, []);
    assert.strictEqual(d.changed, false);
  });

  await test('IDENTITY: a genuinely new model IS reported as added, once', () => {
    const before = catalog.build([conn('a', ['gpt-5'])]);
    const after = catalog.build([conn('a', ['gpt-5', 'GPT_5', 'qwen3.8-27b'])]);
    const d = catalog.diff(before, after, null);
    assert.deepStrictEqual(d.added, ['qwen3.8-27b'], 'the respelling is not a new model; the real one is');
  });

  await test('IDENTITY: folding is deterministic — the same input gives the same winner', () => {
    const a = catalog.build([conn('x', ['GPT_5']), conn('y', ['gpt-5'])]);
    const b = catalog.build([conn('y', ['gpt-5']), conn('x', ['GPT_5'])]);
    assert.strictEqual(a.models[0].id, b.models[0].id, 'connection order must not decide the canonical id');
  });
};
