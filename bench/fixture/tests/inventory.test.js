'use strict';

const assert = require('assert');
const inventory = require('../src/inventory');

module.exports = [
  { name: 'inventory: the catalogue holds 46 products', fn() {
    assert.strictEqual(inventory.CATALOG.length, 46);
  } },
  { name: 'inventory: bySku finds a known product', fn() {
    const p = inventory.bySku('SKU-1000');
    assert.ok(p);
    assert.strictEqual(p.price, 4);
  } },
  { name: 'inventory: bySku returns null for an unknown sku', fn() {
    assert.strictEqual(inventory.bySku('SKU-9999'), null);
  } },
  { name: 'inventory: stockFor reports on-hand units', fn() {
    assert.strictEqual(typeof inventory.stockFor('SKU-1000'), 'number');
    assert.strictEqual(inventory.stockFor('SKU-9999'), 0);
  } },
  { name: 'inventory: inCategory returns only that category', fn() {
    const tools = inventory.inCategory('tools');
    assert.ok(tools.length > 0);
    assert.ok(tools.every((p) => p.category === 'tools'));
  } },
];
