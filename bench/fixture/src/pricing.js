'use strict';

// Totals for a list of items. Prices come from the catalogue (inventory.js);
// the rounding discipline is cents throughout, because a money module that
// floats is a money module that disagrees with itself.

const inventory = require('./inventory');

const cents = (x) => Math.round(x * 100) / 100;

/** The pre-tax subtotal of an item list, at catalogue prices. */
function sumItems(items) {
  let subtotal = 0;
  for (const item of items) {
    const price = inventory.priceFor(item.sku);
    if (!price) throw new Error(`unknown sku: ${item.sku}`);
    subtotal += price * item.qty;
  }
  return cents(subtotal);
}

/** The total: subtotal plus tax at `taxRate` (a fraction, e.g. 0.08). */
function calculateTotal(items, taxRate) {
  const subtotal = sumItems(items);
  const tax = cents(subtotal * taxRate);
  return cents(subtotal + tax);
}

module.exports = { sumItems, calculateTotal, cents };
