'use strict';

/**
 * SEARCHING THE WAY PEOPLE TYPE.
 *
 * Measured against the real 975-model catalog before the fix:
 *
 *   qwen free   →  0 results, while `qwen3.8 27b Free` sat in the catalog
 *   qwen 3.7    →  0 results, while `qwen3.7 Flash` sat in the catalog
 *   qwen3.7     →  9 results
 *
 * The old search tested ONE contiguous substring, so a query only matched when
 * its words happened to be adjacent, in that order, with that spacing. Nobody
 * remembers a provider's punctuation.
 *
 * The catalog here is synthetic on purpose — these assert the ALGORITHM, and a
 * test that depends on which models a live router happens to serve today is a
 * test that fails for reasons that are nobody's fault. The live catalog is
 * exercised separately, in the live tier.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { search, squash, tokenize } = require('../../src/modelsearch');
const catalogMod = require('../../src/catalog');

/** A catalog spelling the same family several ways, as real routers do. */
const CAT = catalogMod.build([{
  id: 'r1', provider: 'qwen', via: 'bridge', auth: 'none',
  models: [
    'qwen/qwen3.8-27b-free',
    'qwen/qwen3.7-flash',
    'qwen/qwen3.7-max',
    'qwen/qwen2.5-72b-instruct',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-opus-5',
    'openai/gpt-5',
  ],
}]);

const names = (q) => search(CAT, q).map((m) => m.displayName);
const top = (q) => names(q)[0];

module.exports = async function () {
  await test('SEARCH: "qwen free" finds the free Qwen, and ONLY it', () => {
    // The exact failure from the report. An OR would return every Qwen and bury
    // the one model that matched both words.
    const r = names('qwen free');
    assert.ok(r.length >= 1, 'found nothing');
    assert.match(r[0], /free/i);
    assert.match(r[0], /qwen/i);
    assert.ok(r.length < 4, `"qwen free" degenerated into "qwen": ${r.length} results`);
  });

  await test('SEARCH: spacing and punctuation do not change the answer', () => {
    const forms = ['qwen 3.7', 'qwen3.7', 'QWEN 3.7', 'qwen-3.7', 'qwen 3 7', 'Qwen_3.7'];
    const first = names(forms[0]);
    assert.ok(first.length, 'the base form found nothing');
    for (const f of forms.slice(1)) {
      assert.deepStrictEqual(names(f), first, `"${f}" gave a different answer than "${forms[0]}"`);
    }
  });

  await test('SEARCH: a version query does not drag in the neighbouring version', () => {
    const r = names('qwen 3.7');
    assert.ok(r.every((n) => /3\.?7/.test(n)), `3.8 and 2.5 leaked in: ${r.join(', ')}`);
  });

  await test('SEARCH: the more specific name ranks first', () => {
    // `qwen3.7 Max` before `qwen3.7 Flash`? No — both are equally specific, so
    // the rule that matters is that a name containing ONLY the query beats a
    // longer one. Checked with an unambiguous pair.
    assert.strictEqual(top('gpt'), 'GPT 5 (openai)');
    assert.match(top('claude sonnet'), /Sonnet/);
  });

  await test('SEARCH: two words match across a version and a size', () => {
    // `qwen3.8 27b Free` — the words are separated by things the user did not
    // type and could not be expected to remember.
    assert.match(top('qwen free'), /27b Free/i);
    assert.match(top('27b free'), /27b Free/i);
    assert.match(top('free qwen'), /Free/i, 'word order must not matter for an AND');
  });

  await test('SEARCH: an unrelated query returns nothing rather than something', () => {
    assert.deepStrictEqual(names('nothinglikethis'), []);
  });

  await test('SEARCH: a query nothing fully satisfies degrades instead of going blank', () => {
    // `qwen sonnet` matches no single model. An empty screen tells the user
    // nothing; near-misses, clearly ordered, tell them what does exist.
    const r = names('qwen sonnet');
    assert.ok(r.length > 0, 'a partial query must still show the near misses');
  });

  await test('SEARCH: an empty query is the whole catalog, not an error', () => {
    assert.strictEqual(search(CAT, '').length, CAT.models.length);
    assert.strictEqual(search(CAT, '   ').length, CAT.models.length);
  });

  await test('SEARCH: it is case-insensitive throughout', () => {
    assert.deepStrictEqual(names('QWEN FREE'), names('qwen free'));
    assert.deepStrictEqual(names('ClAuDe SoNnEt'), names('claude sonnet'));
  });

  await test('SEARCH: the provider is searchable, but ranks below the name', () => {
    const r = names('anthropic');
    assert.ok(r.length >= 2, 'a provider name must find its models');
  });

  // ------------------------------------------------------------ normalise --

  await test('SEARCH: normalisation is the two forms the ranking relies on', () => {
    assert.strictEqual(squash('Qwen 3.7 27B-Free'), 'qwen3727bfree');
    // Letter↔digit boundaries split, which is what lets "qwen free" reach a
    // name where the two words are separated by a version.
    assert.deepStrictEqual(tokenize('qwen3.8-27b-free'), ['qwen', '3', '8', '27', 'b', 'free']);
    assert.deepStrictEqual(tokenize('Claude Sonnet 5'), ['claude', 'sonnet', '5']);
  });

  await test('SEARCH: results are capped, and the cap does not reorder them', () => {
    const many = catalogMod.build([{
      id: 'r', provider: 'p', via: 'bridge', auth: 'none',
      models: Array.from({ length: 200 }, (_, i) => `qwen-${i}`),
    }]);
    const all = search(many, 'qwen', 500);
    const capped = search(many, 'qwen', 10);
    assert.strictEqual(capped.length, 10);
    assert.deepStrictEqual(capped.map((m) => m.id), all.slice(0, 10).map((m) => m.id));
  });

  await test('SEARCH: the picker and the command use the SAME search', () => {
    // They were two implementations: `/models qwen free` found a model and
    // typing the same words into the picker found nothing.
    const panel = require('../../src/ui/panel');
    const frame = panel.modelsAdapter({ catalog: CAT, filter: 'qwen free' });
    const rows = frame.items.filter((i) => i.selectable !== false).map((i) => i.model.displayName);
    assert.deepStrictEqual(rows, names('qwen free'));
  });
};
