'use strict';

// Cart tests. Each file exports its cases; test.js runs them all.

const assert = require('assert');
const { Cart, applyDiscount } = require('../src/cart');

module.exports = [
  { name: 'cart: add accumulates qty for the same sku', fn() {
    const c = new Cart();
    c.add('SKU-1000', 1).add('SKU-1000', 2);
    assert.deepStrictEqual(c.items, [{ sku: 'SKU-1000', qty: 3 }]);
  } },
  { name: 'cart: remove takes every unit of a sku', fn() {
    const c = new Cart();
    c.add('SKU-1000', 2).add('SKU-1007', 1);
    assert.strictEqual(c.remove('SKU-1000'), true);
    assert.deepStrictEqual(c.items, [{ sku: 'SKU-1007', qty: 1 }]);
    assert.strictEqual(c.remove('SKU-1000'), false);
  } },
  { name: 'cart: count is units, not lines', fn() {
    const c = new Cart();
    c.add('SKU-1000', 2).add('SKU-1007', 3);
    assert.strictEqual(c.count(), 5);
  } },
  { name: 'cart: total is subtotal plus tax at catalogue prices', fn() {
    const c = new Cart(0.1);
    c.add('SKU-1000', 1); // 4.00 at the catalogue
    assert.strictEqual(c.total(), 4.4);
  } },
  { name: 'discount: a rate of 0.2 removes 20%', fn() {
    assert.strictEqual(applyDiscount(100, 0.2), 80);
  } },
  { name: 'discount: a zero rate changes nothing', fn() {
    assert.strictEqual(applyDiscount(100, 0), 100);
  } },
];
