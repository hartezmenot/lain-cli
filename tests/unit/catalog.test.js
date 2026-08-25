'use strict';

const assert = require('assert');
const { test } = require('../helpers');
const catalog = require('../../src/catalog');

const CONNS = [
  {
    id: 'anthropic', provider: 'anthropic', via: 'native', auth: 'api_key',
    models: ['claude-opus-5', 'claude-sonnet-5'],
  },
  {
    id: 'omniroute', provider: 'anthropic', via: 'bridge', auth: 'none',
    models: ['claude-opus-5-low', 'claude-opus-5-medium', 'claude-opus-5-high', 'gemini-3.5-flash', 'kimi-k3'],
  },
  {
    id: 'ninerouter', provider: 'bridge9', via: 'bridge', auth: 'none',
    models: ['claude-opus-5-low', 'claude-opus-5-high', 'gpt-5.5-low', 'gpt-5.5-medium', 'gpt-5.5-extra-high', 'qwen-max'],
  },
];

module.exports = async function () {
  await test('effort variants collapse into ONE model, not four', () => {
    const cat = catalog.build(CONNS);
    const names = cat.models.map((m) => m.id);
    assert.ok(names.includes('claude-opus-5'), 'canonical model present');
    assert.ok(!names.includes('claude-opus-5-low'), 'no effort-suffixed model row');
    assert.ok(!names.includes('claude-opus-5-high'), 'no effort-suffixed model row');
    assert.strictEqual(names.filter((n) => n.startsWith('claude-opus-5')).length, 1);
  });

  await test('one model lists every route that actually serves it', () => {
    const cat = catalog.build(CONNS);
    const m = cat.byId.get('claude-opus-5');
    assert.deepStrictEqual(m.connections.map((c) => c.connectionId).sort(), ['anthropic', 'ninerouter', 'omniroute']);
    // ...and NOT routes that don't.
    const gem = cat.byId.get('gemini-3.5-flash');
    assert.deepStrictEqual(gem.connections.map((c) => c.connectionId), ['omniroute']);
  });

  await test('this is generic, not Claude-specific', () => {
    const cat = catalog.build(CONNS);
    assert.ok(cat.byId.get('kimi-k3'), 'kimi routed by the same code path');
    assert.ok(cat.byId.get('gpt-5.5'), 'gpt effort family collapsed the same way');
    assert.deepStrictEqual(cat.byId.get('gpt-5.5').connections[0].efforts, ['low', 'medium', 'extra-high']);
  });

  await test('gpt-5.5-extra-high splits as gpt-5.5 + extra-high, NOT gpt-5.5-extra + high', () => {
    // The V1 greedy-regex bug: it invented a base "gpt-5.5-extra".
    const sp = catalog.splitEffort('gpt-5.5-extra-high');
    assert.strictEqual(sp.base, 'gpt-5.5');
    assert.strictEqual(sp.effort, 'extra-high');
    const cat = catalog.build(CONNS);
    assert.ok(!cat.byId.get('gpt-5.5-extra'), 'no phantom base was invented');
  });

  await test('-fast/-flash/-pro are identity, never effort', () => {
    assert.strictEqual(catalog.splitEffort('gemini-3.5-flash'), null, 'flash is identity');
    assert.strictEqual(catalog.splitEffort('claude-pro'), null, 'pro is identity');
    // -fast is an ORTHOGONAL axis and forms its own family.
    const sp = catalog.splitEffort('gpt-5.5-high-fast');
    assert.strictEqual(sp.base, 'gpt-5.5-fast');
    assert.strictEqual(sp.effort, 'high');
  });

  await test('-thinking and -agentic ARE effort — reasoning modes, not separate models', () => {
    // Reported live: a bridge listing `claude-opus-5`, `claude-opus-5-agentic`
    // and `claude-opus-5-thinking` side by side produced three unrelated rows
    // ("Claude Opus 5", "Claude Opus 5 Agentic", "Claude Opus 5 Thinking")
    // instead of one model with two extra reasoning settings — there was no
    // effort word for either to split on.
    const sp1 = catalog.splitEffort('claude-opus-5-thinking');
    assert.strictEqual(sp1.base, 'claude-opus-5');
    assert.strictEqual(sp1.effort, 'thinking');
    const sp2 = catalog.splitEffort('claude-opus-5-agentic');
    assert.strictEqual(sp2.base, 'claude-opus-5');
    assert.strictEqual(sp2.effort, 'agentic');

    const conns = [{ id: 'kr', provider: 'kilocode', models: ['claude-opus-5', 'claude-opus-5-agentic', 'claude-opus-5-thinking'] }];
    const cat = catalog.build(conns);
    const names = cat.models.map((m) => m.id);
    assert.strictEqual(names.filter((n) => n.startsWith('claude-opus-5')).length, 1, `expected one row, got ${JSON.stringify(names)}`);
    const m = cat.byId.get('claude-opus-5');
    assert.deepStrictEqual(m.connections[0].efforts.slice().sort(), ['agentic', 'thinking']);

    // -fast is UNAFFECTED: still its own family, still never effort.
    assert.strictEqual(catalog.splitEffort('gpt-5.5-high-fast').base, 'gpt-5.5-fast');
  });

  await test('a route that prefixes its OWN models with its OWN id merges with the unprefixed spelling', () => {
    // Reported live: connection `gh` listing `gh/claude-opus-5` stood as its
    // own model "Claude Opus 5 (gh)" next to every other route's unprefixed
    // `claude-opus-5` — the namespace-stripping heuristic only fires at 3+
    // segments, and a route self-prefixing is exactly 2.
    const conns = [
      { id: 'cc', provider: 'anthropic', models: ['claude-opus-5'] },
      { id: 'gh', provider: 'github', models: ['gh/claude-opus-5'] },
    ];
    const cat = catalog.build(conns);
    const names = cat.models.map((m) => m.id);
    assert.strictEqual(names.filter((n) => n.includes('claude-opus-5')).length, 1, `expected one row, got ${JSON.stringify(names)}`);
    const m = cat.byId.get('claude-opus-5');
    const ids = m.connections.map((c) => c.connectionId).sort();
    assert.deepStrictEqual(ids, ['cc', 'gh'], `connectionId must be the plain "gh", not "gh:gh": ${JSON.stringify(ids)}`);

    // A PREFIX FROM A *DIFFERENT* CONNECTION IS NOT SELF-NAMESPACING, and must
    // still be left alone — this is not a blanket "always strip 2 segments"
    // rule, only a same-id one.
    const foreign = catalog.build([{ id: 'cc', provider: 'anthropic', models: ['anthropic/claude-opus-5'] }]);
    assert.ok(foreign.byId.get('anthropic/claude-opus-5'), 'an unrelated 2-segment prefix must NOT be stripped');
  });

  await test('foldKey normalizes separators and case — and must not eat a literal "s"', () => {
    // `/[-_.s]+/g` instead of `/[-_.\s]+/g` — a dropped backslash turns "fold
    // whitespace" into "delete every lowercase s". It went unnoticed for
    // merges (both spellings of a pair lose their esses identically, so they
    // still match each other) but is exactly backwards for telling two
    // DIFFERENT models apart, which is what this function exists to protect.
    assert.strictEqual(catalog.foldKey('claude-sonnet-5'), 'claude-sonnet-5');
    assert.strictEqual(catalog.foldKey('claude-flash-5'), 'claude-flash-5');
    assert.strictEqual(catalog.foldKey('GPT_5'), catalog.foldKey('gpt-5'), 'case/separator folding must still work');
  });

  await test('a LONE effort-looking suffix is not a variant family', () => {
    // `qwen-max` on its own is a model name, not qwen at max effort.
    const cat = catalog.build(CONNS);
    assert.ok(cat.byId.get('qwen-max'), 'qwen-max stayed a model');
    assert.ok(!cat.byId.get('qwen'), 'no phantom "qwen" base');
  });

  await test('resolve() produces the exact upstream id at send time', () => {
    const cat = catalog.build(CONNS);
    const r = catalog.resolve(cat, { model: 'claude-opus-5', connectionId: 'omniroute', effort: 'high' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.upstreamId, 'claude-opus-5-high');
    assert.strictEqual(r.effort, 'high');
  });

  await test('an effort the route does not offer falls back and SAYS SO', () => {
    const cat = catalog.build(CONNS);
    const r = catalog.resolve(cat, { model: 'claude-opus-5', connectionId: 'ninerouter', effort: 'medium' });
    assert.strictEqual(r.ok, true);
    assert.ok(['low', 'high'].includes(r.effort));
    assert.ok(r.effortFallback, 'the substitution is reported, not silent');
  });

  await test('a route with no effort axis resolves to the plain id', () => {
    const cat = catalog.build(CONNS);
    const r = catalog.resolve(cat, { model: 'claude-opus-5', connectionId: 'anthropic', effort: 'high' });
    assert.strictEqual(r.upstreamId, 'claude-opus-5');
    assert.strictEqual(r.effort, null);
  });

  await test('find() matches display name AND raw upstream id', () => {
    const cat = catalog.build(CONNS);
    assert.strictEqual(catalog.find(cat, 'claude-opus-5').id, 'claude-opus-5');
    assert.strictEqual(catalog.find(cat, 'claude-opus-5-high').id, 'claude-opus-5', 'raw upstream id still finds it');
    assert.strictEqual(catalog.find(cat, 'Kimi K3').id, 'kimi-k3');
  });
};
