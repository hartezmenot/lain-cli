'use strict';

const assert = require('assert');
const pricing = require('../src/pricing');

module.exports = [
  { name: 'pricing: subtotal is catalogue price × qty', fn() {
    assert.strictEqual(pricing.sumItems([{ sku: 'SKU-1000', qty: 2 }]), 8); // 4.00 × 2
  } },
  { name: 'pricing: subtotal sums across items', fn() {
    const s = pricing.sumItems([{ sku: 'SKU-1000', qty: 1 }, { sku: 'SKU-1007', qty: 1 }]);
    assert.strictEqual(s, 4 + 7.75); // 4.00 + 7.75
  } },
  { name: 'pricing: total applies tax, rounded to cents', fn() {
    assert.strictEqual(pricing.calculateTotal([{ sku: 'SKU-1000', qty: 1 }], 0.08), 4.32);
  } },
  { name: 'pricing: an unknown sku is an error, not a zero', fn() {
    assert.throws(() => pricing.sumItems([{ sku: 'SKU-9999', qty: 1 }]), /unknown sku/);
  } },
];
