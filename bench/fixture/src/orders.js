'use strict';

// An order is a cart that has been placed: `items` is what is in it NOW and
// can still be edited by the desk before fulfilment, `originalItems` is the
// snapshot of what the customer originally asked for, kept for the record.

const pricing = require('./pricing');

/**
 * Place a cart's contents as an order. The order carries the live item list
 * and the original snapshot; totals are computed, never stored.
 */
function createOrder(cart) {
  return {
    items: cart.items.slice(),
    originalItems: cart.items.slice(),
    taxRate: cart.taxRate,
  };
}

/** Remove every unit of a sku from an order (the desk correcting an order). */
function removeItem(order, sku) {
  const before = order.items.length;
  order.items = order.items.filter((i) => i.sku !== sku);
  return before !== order.items.length;
}

/** Add qty of a sku to an existing order. */
function addItem(order, sku, qty) {
  const existing = order.items.find((i) => i.sku === sku);
  if (existing) existing.qty += qty;
  else order.items.push({ sku, qty });
  return order;
}

/** The order's current total at catalogue prices. */
function orderTotal(order) {
  return pricing.calculateTotal(order.items, order.taxRate);
}

module.exports = { createOrder, removeItem, addItem, orderTotal };
