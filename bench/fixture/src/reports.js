'use strict';

// Back-office reports over item lists. Text today; other formats are added
// here as the office asks for them.

const pricing = require('./pricing');

/**
 * The plain-text report the office prints. One line per item, total at the
 * bottom, tax at the office rate.
 */
function renderReport(items) {
  const lines = items.map((i) => {
    const p = require('./inventory').bySku(i.sku);
    const name = p ? p.name : i.sku;
    const unit = p ? p.price : 0;
    return `- ${name} × ${i.qty} @ ${unit.toFixed(2)}`;
  });
  const total = pricing.calculateTotal(items, 0.08);
  lines.push(`Total: ${total.toFixed(2)}`);
  return ['ORDER REPORT', ...lines].join('\n');
}

module.exports = { renderReport };
