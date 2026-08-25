'use strict';

// The whole suite. Each module's cases live in tests/<module>.test.js and are
// collected here; this file only gathers and runs them.

const TESTS = [];
TESTS.push(...require('./tests/cart.test.js'));
TESTS.push(...require('./tests/pricing.test.js'));
TESTS.push(...require('./tests/inventory.test.js'));
TESTS.push(...require('./tests/auth.test.js'));
TESTS.push(...require('./tests/session.test.js'));
TESTS.push(...require('./tests/orders.test.js'));
TESTS.push(...require('./tests/notify.test.js'));
TESTS.push(...require('./tests/reports.test.js'));

// ---- scenario hook: additional sections are loaded here ---------------------
// (a place for suites that are added to a working copy at run time)
// ---- end scenario hook ------------------------------------------------------

let passed = 0;
const failed = [];
for (const t of TESTS) {
  try {
    t.fn();
    passed += 1;
  } catch (e) {
    failed.push({ name: t.name, error: e });
  }
}

process.stdout.write(`${passed} passed, ${failed.length} failed\n`);
for (const f of failed) {
  process.stdout.write(`  ✗ ${f.name}\n    ${f.error && f.error.message}\n`);
}
process.exit(failed.length ? 1 : 0);
