'use strict';

const assert = require('assert');
const reports = require('../src/reports');

module.exports = [
  { name: 'reports: the text report lists items and a total', fn() {
    const r = reports.renderReport([{ sku: 'SKU-1000', qty: 1 }]);
    assert.match(r, /^ORDER REPORT/);
    assert.match(r, /- Red Anvil × 1 @ 4\.00/);
    assert.match(r, /Total: 4\.32/); // 4.00 + 8% office tax
  } },
];
