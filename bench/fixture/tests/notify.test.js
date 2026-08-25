'use strict';

const assert = require('assert');
const { Cart } = require('../src/cart');
const orders = require('../src/orders');
const notify = require('../src/notify');

module.exports = [
  { name: 'notify: itemsText renders one line per item with its subtotal', fn() {
    const lines = notify.itemsText([{ sku: 'SKU-1000', qty: 2 }]);
    assert.strictEqual(lines, '2 × Red Anvil — 8.00');
  } },
  { name: 'notify: a fresh order emails its items and total', fn() {
    const c = new Cart(0);
    c.add('SKU-1000', 1);
    const o = orders.createOrder(c);
    const email = notify.confirmationEmail(o);
    assert.match(email, /1 item\(s\):/);
    assert.match(email, /Red Anvil/);
    assert.match(email, /Total: 4\.00/);
  } },
];
