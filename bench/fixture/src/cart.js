'use strict';

// The shopping cart. Items are `{ sku, qty }` pairs; prices come from the
// catalogue, never from the cart — a cart that stored prices would disagree
// with the catalogue the moment one changed.

const pricing = require('./pricing');

class Cart {
  constructor(taxRate = 0.08) {
    this.items = [];
    this.taxRate = taxRate;
  }

  add(sku, qty) {
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('qty must be positive');
    const existing = this.items.find((i) => i.sku === sku);
    if (existing) existing.qty += qty;
    else this.items.push({ sku, qty });
    return this;
  }

  /** Remove every unit of a sku from the cart. */
  remove(sku) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.sku !== sku);
    return before !== this.items.length;
  }

  count() {
    return this.items.reduce((n, i) => n + i.qty, 0);
  }

  total() {
    return pricing.calculateTotal(this.items, this.taxRate);
  }
}

/**
 * Apply a discount rate to an amount. `rate` is a fraction: 0.2 removes 20%.
 */
function applyDiscount(amount, rate) {
  return amount - amount * rate;
}

module.exports = { Cart, applyDiscount };
