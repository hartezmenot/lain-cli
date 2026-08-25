'use strict';

const assert = require('assert');
const { Cart } = require('../src/cart');
const orders = require('../src/orders');

module.exports = [
  { name: 'orders: an order snapshots the cart at placement', fn() {
    const c = new Cart();
    c.add('SKU-1000', 2);
    const o = orders.createOrder(c);
    assert.deepStrictEqual(o.items, [{ sku: 'SKU-1000', qty: 2 }]);
    assert.deepStrictEqual(o.originalItems, [{ sku: 'SKU-1000', qty: 2 }]);
  } },
  { name: 'orders: removing an item changes items, not the original snapshot', fn() {
    const c = new Cart();
    c.add('SKU-1000', 2).add('SKU-1007', 1);
    const o = orders.createOrder(c);
    assert.strictEqual(orders.removeItem(o, 'SKU-1000'), true);
    assert.deepStrictEqual(o.items, [{ sku: 'SKU-1007', qty: 1 }]);
    assert.strictEqual(o.originalItems.length, 2);
    assert.strictEqual(orders.removeItem(o, 'SKU-1000'), false);
  } },
  { name: 'orders: addItem accumulates into an existing line', fn() {
    const o = { items: [{ sku: 'SKU-1000', qty: 1 }], originalItems: [], taxRate: 0 };
    orders.addItem(o, 'SKU-1000', 1);
    orders.addItem(o, 'SKU-1014', 1);
    assert.deepStrictEqual(o.items, [{ sku: 'SKU-1000', qty: 2 }, { sku: 'SKU-1014', qty: 1 }]);
  } },
  { name: 'orders: orderTotal prices the CURRENT items', fn() {
    const c = new Cart(0);
    c.add('SKU-1000', 1).add('SKU-1007', 1);
    const o = orders.createOrder(c);
    orders.removeItem(o, 'SKU-1007');
    assert.strictEqual(orders.orderTotal(o), 4); // only SKU-1000 remains
  } },
];
