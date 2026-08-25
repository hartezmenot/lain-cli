'use strict';

// The confirmation email a customer receives for an order. Formatting only:
// prices and totals arrive computed, and nothing here reaches the catalogue.

const pricing = require('./pricing');

const money = (n) => n.toFixed(2);

/** One line per item: "2 × Red Anvil — 170.00". */
function itemsText(items) {
  return items.map((i) => {
    const line = pricing.sumItems([i]);
    return `${i.qty} × ${nameFor(i.sku)} — ${money(line)}`;
  }).join('\n');
}

const nameFor = (sku) => {
  const p = require('./inventory').bySku(sku);
  return p ? p.name : sku;
};

/**
 * Build the confirmation email body for an order.
 */
function confirmationEmail(order) {
  const lines = itemsText(order.originalItems);
  const total = pricing.calculateTotal(order.originalItems, order.taxRate);
  return [
    'Thank you for your order!',
    '',
    `${order.originalItems.length} item(s):`,
    lines,
    '',
    `Total: ${money(total)}`,
  ].join('\n');
}

module.exports = { confirmationEmail, itemsText };
