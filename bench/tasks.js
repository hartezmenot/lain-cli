'use strict';

/**
 * THE TASK SUITE — seven representative task classes, one deliberately
 * wasteful twin, one retry probe.
 *
 * ------------------------------------------------------------------------
 * WHAT A TASK IS. A task is a PROMPT, an optional deterministic SCENARIO
 * transform applied to a fresh copy of bench/fixture before the run, a MOCK
 * SCRIPT (the scripted agent behaviour mock mode replays), and a VERIFIER
 * with ground truth — the verifier checks BEHAVIOUR, never the transcript,
 * so a run cannot pass by narrating success.
 *
 * WHAT THE MOCK SCRIPT IS NOT. It is not intelligence. It is a known tool
 * sequence replayed against the real tool layer, real filesystem and real
 * turn loop, so the MEASUREMENT machinery can be validated against numbers
 * we planted on purpose: A2 plants waste (it MUST be counted), D plants a
 * ledger reuse (it MUST be recognised), G plants a transport failure (the
 * retry MUST be accounted). If the planted numbers do not come back out,
 * the detector is broken — that is the whole point of mock mode.
 *
 * The fixture is green at rest. Scenarios only ADD state (a failing test
 * file for C); they never mutate the base files, so every task starts from
 * byte-identical ground.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const FIXTURE = path.join(__dirname, 'fixture');

/** Require a fixture module with a defeated cache — verifiers must see the
 *  file as the run LEFT it, not as an earlier verifier cached it. */
function fresh(file) {
  const p = path.resolve(file);
  delete require.cache[require.resolve(p)];
  return require(p);
}

/** Run the fixture's own suite. Ground truth, exit code and all. */
function runFixtureTests(dir) {
  const r = spawnSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, stdout: String(r.stdout || '') };
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** All files under tests/ plus test.js — the goalposts a failing task might
 *  otherwise quietly move. */
function protectedTestFiles(dir) {
  const files = [path.join(dir, 'test.js')];
  const tdir = path.join(dir, 'tests');
  if (fs.existsSync(tdir)) {
    for (const f of fs.readdirSync(tdir).sort()) files.push(path.join(tdir, f));
  }
  return files;
}

// ============================================================================
// TASK A — LOCAL SYMBOL CHANGE (the efficient path)
// ============================================================================
const A_REPLACEMENT = [
  'function applyDiscount(amount, rate) {',
  '  const clamped = Math.min(1, Math.max(0, rate));',
  '  return amount - amount * clamped;',
  '}',
].join('\n');

const A_PROMPT = [
  'In src/cart.js, applyDiscount lets a nonsense rate like 1.5 or -0.3 produce a wrong price.',
  'Change applyDiscount so the rate is clamped to the range [0, 1] before it is applied.',
  'Keep everything else in the project working; run the project\'s tests to make sure nothing broke.',
].join(' ');

// The deliberately WASTEFUL twin: same prompt, same correct result, but the
// scripted agent re-reads what it already has, re-asks a symbol it already
// inspected, and runs the suite twice with nothing in between. Every one of
// those was planted to be COUNTED. If the benchmark reports this run as
// clean, the waste detector does not work.
const A2_SCRIPT = [
  { tool_calls: [{ name: 'understand', input: {} }] },
  { tool_calls: [{ name: 'list_dir', input: { path: 'src' } }] },
  { tool_calls: [{ name: 'read_file', input: { path: 'src/cart.js' } }] },
  { tool_calls: [{ name: 'grep', input: { pattern: 'applyDiscount' } }] },
  { tool_calls: [{ name: 'read_file', input: { path: 'src/cart.js' } }] },               // PLANTED rediscovery (unchanged, still in context)
  { tool_calls: [{ name: 'locate', input: { what: 'applyDiscount' } }] },
  { tool_calls: [{ name: 'read_symbol', input: { path: 'src/cart.js', name: 'applyDiscount' } }] },
  { tool_calls: [{ name: 'read_symbol', input: { path: 'src/cart.js', name: 'applyDiscount' } }] }, // PLANTED rediscovery
  { tool_calls: [{ name: 'replace_symbol', input: { path: 'src/cart.js', name: 'applyDiscount', replacement: A_REPLACEMENT } }] },
  { tool_calls: [{ name: 'run_tests', input: {} }] },
  { tool_calls: [{ name: 'run_tests', input: {} }] },                                     // PLANTED duplicate call
  { text: 'Done — applyDiscount clamps its rate into [0, 1]. I ran the suite twice to be sure; all green.' },
];

const A_SCRIPT = [
  { text: 'Locating applyDiscount.', tool_calls: [{ name: 'locate', input: { what: 'applyDiscount' } }] },
  { tool_calls: [{ name: 'read_symbol', input: { path: 'src/cart.js', name: 'applyDiscount' } }] },
  { tool_calls: [{ name: 'replace_symbol', input: { path: 'src/cart.js', name: 'applyDiscount', replacement: A_REPLACEMENT } }] },
  { tool_calls: [{ name: 'run_tests', input: {} }] },
  { text: 'applyDiscount now clamps rate into [0, 1] before applying it; the project\'s tests pass.' },
];

function verifyA(dir) {
  const { applyDiscount } = fresh(path.join(dir, 'src', 'cart.js'));
  const t = runFixtureTests(dir);
  return {
    ok: applyDiscount(100, 1.5) === 0
      && applyDiscount(100, -0.5) === 100
      && applyDiscount(100, 0.2) === 80
      && applyDiscount(100, 0) === 100
      && t.code === 0,
    checks: [
      { name: 'applyDiscount(100, 1.5) === 0 (rate clamped at 1)', ok: applyDiscount(100, 1.5) === 0 },
      { name: 'applyDiscount(100, -0.5) === 100 (rate clamped at 0)', ok: applyDiscount(100, -0.5) === 100 },
      { name: 'applyDiscount(100, 0.2) === 80 (normal path unchanged)', ok: applyDiscount(100, 0.2) === 80 },
      { name: 'fixture suite exits 0', ok: t.code === 0, detail: t.stdout.trim().split('\n')[0] },
    ],
  };
}

// ============================================================================
// TASK B — CROSS-FILE API CHANGE
// ============================================================================
const B_PRICING = [
  '/**',
  ' * The total: subtotal minus an optional discount fraction, plus tax at',
  ' * `taxRate` — all in one options object.',
  ' */',
  'function calculateTotal({ items, taxRate, discount = 0 }) {',
  '  const subtotal = sumItems(items);',
  '  const discounted = cents(subtotal * (1 - Math.max(0, discount)));',
  '  const tax = cents(discounted * taxRate);',
  '  return cents(discounted + tax);',
  '}',
].join('\n');

const B_CART_TOTAL = [
  '  total() {',
  '    return pricing.calculateTotal({ items: this.items, taxRate: this.taxRate });',
  '  }',
].join('\n');

const B_ORDER_TOTAL = [
  '/** The order\'s current total at catalogue prices. */',
  'function orderTotal(order) {',
  '  return pricing.calculateTotal({ items: order.items, taxRate: order.taxRate });',
  '}',
].join('\n');

const B_NOTIFY = [
  '/**',
  ' * Build the confirmation email body for an order.',
  ' */',
  'function confirmationEmail(order) {',
  "  const lines = itemsText(order.originalItems);",
  '  const total = pricing.calculateTotal({ items: order.originalItems, taxRate: order.taxRate });',
  '  return [',
  "    'Thank you for your order!',",
  '    \'\',',
  '    `${order.originalItems.length} item(s):`,',
  '    lines,',
  '    \'\',',
  '    `Total: ${money(total)}`,',
  "  ].join('\\n');",
  '}',
].join('\n');

const B_REPORT = [
  'function renderReport(items) {',
  '  const lines = items.map((i) => {',
  "    const p = require('./inventory').bySku(i.sku);",
  '    const name = p ? p.name : i.sku;',
  '    const unit = p ? p.price : 0;',
  '    return `- ${name} × ${i.qty} @ ${unit.toFixed(2)}`;',
  '  });',
  '  const total = pricing.calculateTotal({ items, taxRate: 0.08 });',
  '  lines.push(`Total: ${total.toFixed(2)}`);',
  "  return ['ORDER REPORT', ...lines].join('\\n');",
  '}',
].join('\n');

const B_PROMPT = [
  'Refactor pricing.calculateTotal in src/pricing.js to take a single options object instead of',
  'positional arguments: calculateTotal({ items, taxRate, discount }) where discount is an optional',
  'fraction (default 0) subtracted from the subtotal before tax. Update every caller, including the',
  'tests, to the new signature. The whole suite must pass when you are done.',
].join(' ');

const B_SCRIPT = [
  { text: 'Finding every caller of calculateTotal before touching it.', tool_calls: [{ name: 'dependents', input: { path: 'src/pricing.js' } }] },
  { tool_calls: [{ name: 'read_file', input: { path: 'src/pricing.js' } }] },
  { tool_calls: [{ name: 'replace_symbol', input: { path: 'src/pricing.js', name: 'calculateTotal', replacement: B_PRICING } }] },
  { tool_calls: [{ name: 'read_symbol', input: { path: 'src/cart.js', name: 'total', container: 'Cart' } }] },
  { tool_calls: [{ name: 'replace_symbol', input: { path: 'src/cart.js', name: 'total', container: 'Cart', replacement: B_CART_TOTAL } }] },
  { tool_calls: [{ name: 'read_symbol', input: { path: 'src/orders.js', name: 'orderTotal' } }] },
  { tool_calls: [{ name: 'replace_symbol', input: { path: 'src/orders.js', name: 'orderTotal', replacement: B_ORDER_TOTAL } }] },
  { tool_calls: [{ name: 'read_symbol', input: { path: 'src/notify.js', name: 'confirmationEmail' } }] },
  { tool_calls: [{ name: 'replace_symbol', input: { path: 'src/notify.js', name: 'confirmationEmail', replacement: B_NOTIFY } }] },
  { tool_calls: [{ name: 'read_symbol', input: { path: 'src/reports.js', name: 'renderReport' } }] },
  { tool_calls: [{ name: 'replace_symbol', input: { path: 'src/reports.js', name: 'renderReport', replacement: B_REPORT } }] },
  { tool_calls: [{ name: 'edit_file', input: {
    path: 'tests/pricing.test.js',
    old: "pricing.calculateTotal([{ sku: 'SKU-1000', qty: 1 }], 0.08)",
    new: "pricing.calculateTotal({ items: [{ sku: 'SKU-1000', qty: 1 }], taxRate: 0.08 })",
  } }] },
  { tool_calls: [{ name: 'run_tests', input: {} }] },
  { text: 'calculateTotal now takes { items, taxRate, discount }; every caller updated; the suite passes.' },
];

function verifyB(dir) {
  const pricing = fresh(path.join(dir, 'src', 'pricing.js'));
  const { Cart } = fresh(path.join(dir, 'src', 'cart.js'));
  const reports = fresh(path.join(dir, 'src', 'reports.js'));
  let positionalThrows = false;
  try { pricing.calculateTotal([{ sku: 'SKU-1000', qty: 1 }], 0.08); } catch { positionalThrows = true; }
  const base = pricing.calculateTotal({ items: [{ sku: 'SKU-1000', qty: 1 }], taxRate: 0.08 });
  const halfOff = pricing.calculateTotal({ items: [{ sku: 'SKU-1000', qty: 1 }], taxRate: 0.08, discount: 0.5 });
  const cart = new Cart(0.1); cart.add('SKU-1000', 1);
  const text = reports.renderReport([{ sku: 'SKU-1000', qty: 1 }]);
  const t = runFixtureTests(dir);
  return {
    ok: positionalThrows && base === 4.32 && halfOff === 2.16
      && cart.total() === 4.4 && /Total: 4\.32/.test(text) && t.code === 0,
    checks: [
      { name: 'new signature computes 4.32 for the base case', ok: base === 4.32, detail: String(base) },
      { name: 'discount 0.5 halves the subtotal before tax (2.16)', ok: halfOff === 2.16, detail: String(halfOff) },
      { name: 'the old positional call now throws', ok: positionalThrows },
      { name: 'Cart.total() through the new signature is 4.40', ok: cart.total() === 4.4, detail: String(cart.total()) },
      { name: 'renderReport still renders 4.32', ok: /Total: 4\.32/.test(text) },
      { name: 'fixture suite exits 0', ok: t.code === 0, detail: t.stdout.trim().split('\n')[0] },
    ],
  };
}

// ============================================================================
// TASK C — BUG FIX AGAINST AN ADDED FAILING TEST
// ============================================================================
// The scenario writes a test file the fixture never had and hooks it into
// test.js at the marker the fixture ships for exactly this purpose. The bug
// is LATENT in the fixture: auth.js's comment says tokens "up to and
// including 32" are valid, but the code rejects length >= 32 — and
// issueToken always returns exactly 32 characters, so no desk-issued token
// ever validates. The base suite never round-trips a token, so the fixture
// is green at rest and red only once the scenario's test exists.
const C_LATENT_TEST = [
  "'use strict';",
  '',
  'const assert = require(\'assert\');',
  'const { validateToken, issueToken } = require(\'../src/auth\');',
  'const { createSession } = require(\'../src/session\');',
  '',
  'module.exports = [',
  "  { name: 'auth-latent: an issued token validates', fn() {",
  '    assert.strictEqual(validateToken(issueToken(\'alice\')), true);',
  '  } },',
  "  { name: 'auth-latent: an operator can open a session', fn() {",
  '    const s = createSession(\'bob\');',
  '    assert.strictEqual(s.ok, true);',
  '  } },',
  '];',
  '',
].join('\n');

const C_VALIDATE = [
  '/**',
  ' * Is this an operator token we issued? True for a well-formed 32-hex token.',
  ' */',
  'function validateToken(token) {',
  '  if (typeof token !== \'string\') return false;',
  '  if (token.length > 32) return false;',
  '  return /^[0-9a-f]+$/.test(token);',
  '}',
].join('\n');

const C_PROMPT = [
  'The security desk added regression tests for token handling and now the suite fails (node test.js).',
  'Find the root cause in the source and fix it so every test passes. Do not modify test.js or any file',
  'under tests/ — the fix belongs in src/. Run the tests when done and report the real result.',
].join(' ');

function scenarioC(dir) {
  fs.writeFileSync(path.join(dir, 'tests', 'auth-latent.test.js'), C_LATENT_TEST, 'utf8');
  const tj = path.join(dir, 'test.js');
  const src = fs.readFileSync(tj, 'utf8');
  const marker = '// ---- scenario hook: additional sections are loaded here';
  if (!src.includes(marker)) throw new Error('fixture test.js is missing the scenario hook marker');
  fs.writeFileSync(tj, src.replace(marker,
    "TESTS.push(...require('./tests/auth-latent.test.js'));\n\n" + marker), 'utf8');
  // The desk's tests are the goalposts. They are hashed before the run and
  // byte-compared after it: a run that "fixes" the failure by weakening the
  // test is a failed run, whatever its exit code says.
  return { protect: protectedTestFiles(dir) };
}

const C_SCRIPT = [
  { text: 'Running the suite to see the failure I am being asked about.', tool_calls: [{ name: 'run_tests', input: {} }] },
  { tool_calls: [{ name: 'locate', input: { what: 'validateToken' } }] },
  { tool_calls: [{ name: 'read_symbol', input: { path: 'src/auth.js', name: 'validateToken' } }] },
  { tool_calls: [{ name: 'replace_symbol', input: { path: 'src/auth.js', name: 'validateToken', replacement: C_VALIDATE } }] },
  { tool_calls: [{ name: 'run_tests', input: {} }] },
  { text: 'Root cause: validateToken rejected tokens of exactly 32 characters (>= 32 instead of > 32), and issueToken always issues exactly 32, so every desk-issued token was refused. Fixed in src/auth.js; the whole suite now passes.' },
];

function verifyC(dir) {
  const auth = fresh(path.join(dir, 'src', 'auth.js'));
  const session = fresh(path.join(dir, 'src', 'session.js'));
  const t = runFixtureTests(dir);
  const roundTrip = auth.validateToken(auth.issueToken('alice'));
  const opened = session.createSession('bob');
  const latentRan = t.stdout.includes('auth-latent') || fs.readFileSync(path.join(dir, 'tests', 'auth-latent.test.js'), 'utf8').length > 0;
  return {
    ok: roundTrip === true && opened.ok === true && t.code === 0 && /32 passed/.test(t.stdout),
    checks: [
      { name: 'validateToken(issueToken(x)) round-trips to true', ok: roundTrip === true },
      { name: 'createSession succeeds again', ok: opened.ok === true, detail: JSON.stringify(opened).slice(0, 80) },
      { name: "the desk's 32 tests all pass", ok: t.code === 0 && /32 passed/.test(t.stdout), detail: t.stdout.trim().split('\n')[0] },
      { name: 'the scenario test is still wired in', ok: latentRan },
    ],
  };
}

// ============================================================================
// TASK D — UNKNOWN LOCATION (the evidence-ledger reuse demo)
// ============================================================================
const D_NOTIFY = [
  '/**',
  ' * Build the confirmation email body for an order. The email reports the',
  ' * order AS IT STANDS (order.items), not the original snapshot — a customer',
  ' * who removed an item must not be emailed about it.',
  ' */',
  'function confirmationEmail(order) {',
  '  const lines = itemsText(order.items);',
  '  const total = pricing.calculateTotal(order.items, order.taxRate);',
  '  return [',
  "    'Thank you for your order!',",
  '    \'\',',
  '    `${order.items.length} item(s):`,',
  '    lines,',
  '    \'\',',
  '    `Total: ${money(total)}`,',
  "  ].join('\\n');",
  '}',
].join('\n');

const D_PROMPT = [
  'A customer who removes the last item from their order still gets a confirmation email listing that',
  'item and saying "1 item(s)". The order itself is correct — only the email is wrong. Find where',
  'confirmation emails are built and fix it so the email reflects the order\'s current items. You are',
  'not told which file this lives in. Run the tests when you are done.',
].join(' ');

// The scripted path: understand -> grep -> read the email module -> read the
// 354-line catalogue (over the ledger threshold, deliberately) -> fix ->
// re-ask for the catalogue. That last read is served by the evidence ledger
// as an [evidence] substitution: nothing touched the catalogue, so the bytes
// the model already has are still the truth. PLANTED REUSE — it must be
// counted as reuse, NOT as waste, and NOT as a rediscovery either.
const D_SCRIPT = [
  { tool_calls: [{ name: 'understand', input: {} }] },
  { tool_calls: [{ name: 'grep', input: { pattern: 'confirmationEmail' } }] },
  { tool_calls: [{ name: 'read_file', input: { path: 'src/notify.js' } }] },
  { text: 'The email is built in src/notify.js from order.originalItems — the snapshot, not the live list. Checking how names and prices resolve before fixing it.', tool_calls: [{ name: 'read_file', input: { path: 'src/inventory.js' } }] },
  { tool_calls: [{ name: 'replace_symbol', input: { path: 'src/notify.js', name: 'confirmationEmail', replacement: D_NOTIFY } }] },
  { text: 'The catalogue is untouched by this fix; the evidence ledger should say so.', tool_calls: [{ name: 'read_file', input: { path: 'src/inventory.js' } }] }, // PLANTED ledger reuse
  { tool_calls: [{ name: 'run_tests', input: {} }] },
  { text: 'confirmationEmail now reads order.items, so the email matches the order as it stands. The suite passes.' },
];

function verifyD(dir) {
  const notify = fresh(path.join(dir, 'src', 'notify.js'));
  const orders = fresh(path.join(dir, 'src', 'orders.js'));
  const { Cart } = fresh(path.join(dir, 'src', 'cart.js'));
  const c = new Cart(0); c.add('SKU-1000', 1);
  const order = orders.createOrder(c);
  orders.removeItem(order, 'SKU-1000');
  const emptied = notify.confirmationEmail(order);
  const c2 = new Cart(0); c2.add('SKU-1000', 1);
  const fresh1 = notify.confirmationEmail(orders.createOrder(c2));
  const t = runFixtureTests(dir);
  return {
    ok: emptied.includes('0 item(s):') && !emptied.includes('Red Anvil')
      && fresh1.includes('1 item(s):') && fresh1.includes('Red Anvil') && fresh1.includes('Total: 4.00')
      && t.code === 0,
    checks: [
      { name: 'emptied order emails "0 item(s):"', ok: emptied.includes('0 item(s):') },
      { name: 'emptied order email names no products', ok: !emptied.includes('Red Anvil') },
      { name: 'a fresh order still emails its item and total', ok: fresh1.includes('1 item(s):') && fresh1.includes('Red Anvil') && fresh1.includes('Total: 4.00') },
      { name: 'fixture suite exits 0', ok: t.code === 0, detail: t.stdout.trim().split('\n')[0] },
    ],
  };
}

// ============================================================================
// TASK E — MULTI-STEP FEATURE (2 files + tests)
// ============================================================================
const E_TOCSV = [
  '/**',
  ' * CSV export: one header row, then one row per item at catalogue prices.',
  ' */',
  'function toCSV(items) {',
  '  const rows = items.map((i) => {',
  "    const p = require('./inventory').bySku(i.sku);",
  '    const unit = p ? p.price : 0;',
  '    return [i.sku, p ? p.name : i.sku, i.qty, unit.toFixed(2), (unit * i.qty).toFixed(2)].join(\',\');',
  '  });',
  "  return ['sku,name,qty,unit_price,line_total', ...rows].join('\\n');",
  '}',
].join('\n');

const E_RENDER = [
  'function renderReport(items, opts = {}) {',
  "  if (opts.format === 'csv') return toCSV(items);",
  '  const lines = items.map((i) => {',
  "    const p = require('./inventory').bySku(i.sku);",
  '    const name = p ? p.name : i.sku;',
  '    const unit = p ? p.price : 0;',
  '    return `- ${name} × ${i.qty} @ ${unit.toFixed(2)}`;',
  '  });',
  '  const total = pricing.calculateTotal(items, 0.08);',
  '  lines.push(`Total: ${total.toFixed(2)}`);',
  "  return ['ORDER REPORT', ...lines].join('\\n');",
  '}',
].join('\n');

const E_TESTS = [
  "  { name: 'reports: toCSV returns header and rows', fn() {",
  "    const csv = reports.toCSV([{ sku: 'SKU-1000', qty: 2 }]);",
  "    assert.strictEqual(csv, 'sku,name,qty,unit_price,line_total\\nSKU-1000,Red Anvil,2,4.00,8.00');",
  '  } },',
  "  { name: 'reports: renderReport can return CSV', fn() {",
  "    const csv = reports.renderReport([{ sku: 'SKU-1000', qty: 1 }], { format: 'csv' });",
  "    assert.strictEqual(csv, 'sku,name,qty,unit_price,line_total\\nSKU-1000,Red Anvil,1,4.00,4.00');",
  '  } },',
  '];',
].join('\n');

const E_PROMPT = [
  'Add CSV export to the back office: a new function reports.toCSV(items) that returns CSV text with a',
  'header row "sku,name,qty,unit_price,line_total" and one row per item (names and prices from the',
  'catalogue, line_total = unit_price × qty, all money with two decimals), and extend renderReport to',
  'accept opts.format === \'csv\' returning exactly that CSV (the default text report must stay as it',
  'is). Add tests for toCSV to the suite. Run the tests before you finish.',
].join(' ');

const E_SCRIPT = [
  { text: 'Adding CSV export to reports. Reading the module and the catalogue first.', tool_calls: [{ name: 'read_file', input: { path: 'src/reports.js' } }] },
  { tool_calls: [{ name: 'read_file', input: { path: 'src/inventory.js' } }] },
  { tool_calls: [{ name: 'insert_near_symbol', input: { path: 'src/reports.js', name: 'renderReport', where: 'before', text: E_TOCSV } }] },
  { tool_calls: [{ name: 'replace_symbol', input: { path: 'src/reports.js', name: 'renderReport', replacement: E_RENDER } }] },
  { tool_calls: [{ name: 'edit_file', input: { path: 'tests/reports.test.js', old: '];', new: E_TESTS } }] },
  { tool_calls: [{ name: 'edit_file', input: { path: 'src/reports.js', old: 'module.exports = { renderReport };', new: 'module.exports = { renderReport, toCSV };' } }] },
  { tool_calls: [{ name: 'run_tests', input: {} }] },
  { text: 'reports.toCSV(items) returns the header and one row per item; renderReport(items, { format: \'csv\' }) returns exactly that. The suite passes including the two new tests.' },
];

function verifyE(dir) {
  const reports = fresh(path.join(dir, 'src', 'reports.js'));
  const csv = reports.toCSV([{ sku: 'SKU-1000', qty: 2 }]);
  const csv2 = reports.renderReport([{ sku: 'SKU-1007', qty: 1 }], { format: 'csv' });
  const text = reports.renderReport([{ sku: 'SKU-1000', qty: 1 }]);
  const hasTest = fs.readFileSync(path.join(dir, 'tests', 'reports.test.js'), 'utf8').includes('toCSV');
  const t = runFixtureTests(dir);
  return {
    ok: csv === 'sku,name,qty,unit_price,line_total\nSKU-1000,Red Anvil,2,4.00,8.00'
      && csv2 === 'sku,name,qty,unit_price,line_total\nSKU-1007,Blue Forge,1,7.75,7.75'
      && text.startsWith('ORDER REPORT') && /Total: 4\.32/.test(text)
      && hasTest && t.code === 0,
    checks: [
      { name: 'toCSV header + row exact', ok: csv === 'sku,name,qty,unit_price,line_total\nSKU-1000,Red Anvil,2,4.00,8.00', detail: JSON.stringify(csv) },
      { name: 'renderReport csv format exact (second sku)', ok: csv2 === 'sku,name,qty,unit_price,line_total\nSKU-1007,Blue Forge,1,7.75,7.75', detail: JSON.stringify(csv2) },
      { name: 'the default text report is unchanged', ok: text.startsWith('ORDER REPORT') && /Total: 4\.32/.test(text) },
      { name: 'the suite now covers toCSV', ok: hasTest },
      { name: 'fixture suite exits 0', ok: t.code === 0, detail: t.stdout.trim().split('\n')[0] },
    ],
  };
}

// ============================================================================
// TASK F — FOLLOW-UP IN THE SAME SESSION (the reuse-vs-rediscovery probe)
// ============================================================================
const F_TOCSV = [
  'function toCSV(items) {',
  '  const rows = items.map((i) => {',
  "    const p = require('./inventory').bySku(i.sku);",
  '    const unit = p ? p.price : 0;',
  '    return [i.sku, p ? p.name : i.sku, i.qty, unit.toFixed(2), (unit * i.qty).toFixed(2)].join(\',\');',
  '  });',
  '  const total = items.reduce((n, i) => {',
  "    const p = require('./inventory').bySku(i.sku);",
  '    return n + (p ? p.price : 0) * i.qty;',
  '  }, 0);',
  "  return ['sku,name,qty,unit_price,line_total', ...rows, `TOTAL,,,,${total.toFixed(2)}`].join('\\n');",
  '}',
].join('\n');

const F_PROMPT = [
  'Now change toCSV so the CSV ends with a TOTAL row: TOTAL,,,,<sum-of-line-totals> — four commas, the',
  'sum with two decimals, no spaces. Update the existing tests to expect it. Keep the header row as it is.',
].join(' ');

// The scripted path leans on what the session already holds: it re-asks for
// the catalogue (unchanged since E read it, so the ledger serves it — PLANTED
// cross-turn reuse through a --resume), reads the symbol it is about to
// replace (first read_symbol of toCSV: E inserted it, never read it), edits,
// re-checks the two expectations the TOTAL row changes, and runs the suite.
const F_SCRIPT = [
  { text: 'The catalogue prices from earlier in this session are still the truth; asking again to be sure.', tool_calls: [{ name: 'read_file', input: { path: 'src/inventory.js' } }] }, // PLANTED reuse across the resume
  { tool_calls: [{ name: 'read_symbol', input: { path: 'src/reports.js', name: 'toCSV' } }] },
  { tool_calls: [{ name: 'replace_symbol', input: { path: 'src/reports.js', name: 'toCSV', replacement: F_TOCSV } }] },
  { tool_calls: [{ name: 'edit_file', input: { path: 'tests/reports.test.js', old: "SKU-1000,Red Anvil,2,4.00,8.00'", new: "SKU-1000,Red Anvil,2,4.00,8.00\\nTOTAL,,,,8.00'" } }] },
  { tool_calls: [{ name: 'edit_file', input: { path: 'tests/reports.test.js', old: "SKU-1000,Red Anvil,1,4.00,4.00'", new: "SKU-1000,Red Anvil,1,4.00,4.00\\nTOTAL,,,,4.00'" } }] },
  { tool_calls: [{ name: 'run_tests', input: {} }] },
  { text: 'toCSV now ends with TOTAL,,,,<sum>; the two expectations were updated to match. The suite passes.' },
];

function verifyF(dir) {
  const reports = fresh(path.join(dir, 'src', 'reports.js'));
  const one = reports.toCSV([{ sku: 'SKU-1000', qty: 2 }]);
  const two = reports.toCSV([{ sku: 'SKU-1000', qty: 1 }, { sku: 'SKU-1007', qty: 1 }]);
  const t = runFixtureTests(dir);
  return {
    ok: one === 'sku,name,qty,unit_price,line_total\nSKU-1000,Red Anvil,2,4.00,8.00\nTOTAL,,,,8.00'
      && two.endsWith('SKU-1007,Blue Forge,1,7.75,7.75\nTOTAL,,,,11.75')
      && t.code === 0,
    checks: [
      { name: 'single-item TOTAL row exact', ok: one === 'sku,name,qty,unit_price,line_total\nSKU-1000,Red Anvil,2,4.00,8.00\nTOTAL,,,,8.00', detail: JSON.stringify(one) },
      { name: 'multi-item TOTAL sums line totals (11.75)', ok: two.endsWith('SKU-1007,Blue Forge,1,7.75,7.75\nTOTAL,,,,11.75'), detail: JSON.stringify(two) },
      { name: 'fixture suite exits 0', ok: t.code === 0, detail: t.stdout.trim().split('\n')[0] },
    ],
  };
}

// ============================================================================
// TASK G — TRANSPORT RETRY (mock-only; a live provider cannot be made to fail
// on demand, and pretending otherwise would be fabricating a measurement)
// ============================================================================
const G_PROMPT = 'Read src/cart.js and tell me, in one sentence, what applyDiscount does.';

const G_SCRIPT = [
  { error: { code: 'ECONNRESET', message: 'socket hang up' } },  // PLANTED transport failure
  { tool_calls: [{ name: 'read_file', input: { path: 'src/cart.js' } }] },
  { text: 'applyDiscount(amount, rate) subtracts rate × amount from amount — a percentage discount.' },
];

function verifyG(dir) {
  // A read-only question: the only ground truth is that nothing changed.
  const t = runFixtureTests(dir);
  return {
    ok: t.code === 0,
    checks: [
      { name: 'the fixture is untouched (suite still green)', ok: t.code === 0, detail: t.stdout.trim().split('\n')[0] },
    ],
  };
}

// ============================================================================
// THE SUITE
// ============================================================================
// `expect` values are the planted instrumentation targets mock mode must
// reproduce exactly. They are about the MEASUREMENT, never about skill: the
// A2 and A twins both produce a correct result — only their cost differs,
// and the difference is the detector working.
module.exports = {
  FIXTURE,
  TASKS: [
    {
      id: 'A', name: 'LOCAL SYMBOL CHANGE', cls: 'local-symbol-change',
      purpose: 'one function in one known file: the floor for a single-step change',
      prompt: A_PROMPT, mockScript: A_SCRIPT, verify: verifyA, live: true,
      expect: { requests: 5, toolCalls: 4, rediscoveries: 0, duplicates: 0, semanticEdits: 1, fullTests: 1, ledgerReuse: 0, retries: 0 },
    },
    {
      id: 'A2', name: 'LOCAL SYMBOL CHANGE — WASTEFUL TWIN', cls: 'detector-validation',
      purpose: 'the same task done redundantly on purpose: the waste detectors MUST fire',
      prompt: A_PROMPT, mockScript: A2_SCRIPT, verify: verifyA, live: false,
      expect: { requests: 12, toolCalls: 11, rediscoveries: 2, duplicates: 3, semanticEdits: 1, fullTests: 2, ledgerReuse: 0, retries: 0 },
    },
    {
      id: 'B', name: 'CROSS-FILE API CHANGE', cls: 'cross-file-change',
      purpose: 'one signature, five callers, tests included: change propagation',
      prompt: B_PROMPT, mockScript: B_SCRIPT, verify: verifyB, live: true,
      expect: { requests: 14, toolCalls: 13, rediscoveries: 0, duplicates: 0, semanticEdits: 5, textEdits: 1, fullTests: 1, ledgerReuse: 0, retries: 0 },
    },
    {
      id: 'C', name: 'BUG FIX AGAINST AN ADDED FAILING TEST', cls: 'bug-fix',
      purpose: 'a latent bug exposed by a scenario test the run must satisfy but never touch',
      prompt: C_PROMPT, scenario: scenarioC, mockScript: C_SCRIPT, verify: verifyC, live: true,
      expect: { requests: 6, toolCalls: 5, rediscoveries: 0, duplicates: 0, semanticEdits: 1, fullTests: 2, ledgerReuse: 0, retries: 0 },
    },
    {
      id: 'D', name: 'UNKNOWN LOCATION', cls: 'bug-hunt-unlocated',
      purpose: 'a symptom with no file named; includes a planted evidence-ledger reuse',
      prompt: D_PROMPT, mockScript: D_SCRIPT, verify: verifyD, live: true,
      expect: { requests: 8, toolCalls: 7, rediscoveries: 0, duplicates: 0, semanticEdits: 1, fullTests: 1, ledgerReuse: 1, reuseClass: 1, retries: 0 },
    },
    {
      id: 'E', name: 'MULTI-STEP FEATURE', cls: 'multi-step-feature',
      purpose: 'new function + format option + tests: several coordinated edits',
      prompt: E_PROMPT, mockScript: E_SCRIPT, verify: verifyE, live: true,
      expect: { requests: 8, toolCalls: 7, rediscoveries: 0, duplicates: 0, semanticEdits: 2, textEdits: 2, fullTests: 1, ledgerReuse: 0, retries: 0 },
    },
    {
      id: 'F', name: 'FOLLOW-UP CHANGE IN THE SAME SESSION', cls: 'follow-up',
      purpose: 'a second change in E\'s session: does prior evidence carry over or get re-acquired?',
      prompt: F_PROMPT, mockScript: F_SCRIPT, verify: verifyF, live: true, followUpOf: 'E',
      expect: { requests: 7, toolCalls: 6, rediscoveries: 0, duplicates: 0, semanticEdits: 1, textEdits: 2, fullTests: 1, ledgerReuse: 1, reuseClass: 1, retries: 0 },
    },
    {
      id: 'G', name: 'TRANSPORT RETRY', cls: 'failure-retry',
      purpose: 'one planted ECONNRESET then success: retry accounting, mock-only',
      prompt: G_PROMPT, mockScript: G_SCRIPT, verify: verifyG, live: false,
      expect: { requests: 3, toolCalls: 1, rediscoveries: 0, duplicates: 0, retries: 1, ledgerReuse: 0 },
    },
  ],
  helpers: { fresh, runFixtureTests, sha, protectedTestFiles },
};
