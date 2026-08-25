'use strict';

/**
 * CATALOG REFRESH — reporting the DIFFERENCE, not a total.
 *
 * You refresh because you added a model somewhere else, so "1,247 models
 * discovered" does not answer your question. What you need to know is whether
 * the thing you added arrived, and — the consequence that changes what happens
 * next — whether the model you are currently using is still served.
 */

const assert = require('assert');
const { test } = require('../helpers');

const catalog = require('../../src/catalog');

const cat = (...ids) => catalog.build([{ id: 'c1', provider: 'p', via: 'bridge', auth: 'none', models: ids }]);

module.exports = async function () {
  await test('REFRESH: nothing changed is reported as nothing changed', () => {
    const d = catalog.diff(cat('alpha', 'beta'), cat('alpha', 'beta'));
    assert.strictEqual(d.changed, false);
    assert.deepStrictEqual(d.added, []);
    assert.deepStrictEqual(d.removed, []);
  });

  await test('REFRESH: new and removed models are named, not just counted', () => {
    const d = catalog.diff(cat('alpha', 'beta'), cat('alpha', 'gamma'));
    assert.strictEqual(d.changed, true);
    assert.deepStrictEqual(d.added, ['gamma']);
    assert.deepStrictEqual(d.removed, ['beta']);
    assert.strictEqual(d.before, 2);
    assert.strictEqual(d.after, 2, 'a count alone would have shown no change at all here');
  });

  await test('REFRESH: losing the model you are USING is the finding that matters', () => {
    const d = catalog.diff(cat('alpha', 'beta'), cat('alpha'), 'beta');
    assert.strictEqual(d.currentSurvived, false);
    assert.strictEqual(d.currentModel, 'beta');
  });

  await test('REFRESH: a surviving model is confirmed, so silence is never the answer', () => {
    const d = catalog.diff(cat('alpha'), cat('alpha', 'beta'), 'alpha');
    assert.strictEqual(d.currentSurvived, true);
  });

  await test('REFRESH: "you had not chosen one" is not the same as "yours is gone"', () => {
    // null, never false. Reporting no selection as a loss would send the user
    // hunting for a model that was never picked.
    const d = catalog.diff(cat('alpha'), cat('alpha'), null);
    assert.strictEqual(d.currentSurvived, null);
    assert.strictEqual(d.currentModel, null);
  });

  await test('REFRESH: an effort variant does not read as a new model', () => {
    // `alpha-high` is the same identity at a different effort. Counting it as an
    // arrival would make every refresh look like churn.
    const before = cat('alpha');
    const after = cat('alpha', 'alpha-high');
    const d = catalog.diff(before, after);
    assert.deepStrictEqual(d.added, [], `effort variants must fold into their model: ${JSON.stringify(d.added)}`);
    assert.strictEqual(d.changed, false);
  });

  await test('REFRESH: an empty catalog on either side is handled, not thrown at', () => {
    assert.strictEqual(catalog.diff(null, cat('alpha')).added.length, 1);
    assert.strictEqual(catalog.diff(cat('alpha'), null).removed.length, 1);
    assert.strictEqual(catalog.diff(null, null).changed, false);
  });
};
