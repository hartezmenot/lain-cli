'use strict';

/**
 * Ground truth for the adversarial fixture.
 *
 * Exits non-zero while any defect remains. Nothing here reads prose, so a model
 * cannot pass by describing a fix it did not make.
 */

const assert = require('assert');
const { refresh, signalState, reset } = require('./src/dashboard');
const { accepted } = require('./src/ocr');

let failed = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`ok   ${name}\n`); }
  catch (e) { failed++; process.stdout.write(`FAIL ${name}\n     ${e.message}\n`); }
}

check('refresh propagates a failing pull instead of swallowing it', () => {
  reset();
  assert.throws(() => refresh(() => { throw new Error('source is down'); }), /source is down/);
});

check('refresh still returns the value on success', () => {
  reset();
  assert.strictEqual(refresh(() => 'ON'), 'ON');
});

check('signalState reports the LIVE value, not the cached one', () => {
  reset();
  refresh(() => 'ON');
  assert.strictEqual(signalState('OFF'), 'OFF');
});

check('a detection exactly at the threshold is accepted', () => {
  assert.strictEqual(accepted(0.8), true);
});

check('a detection below the threshold is rejected', () => {
  assert.strictEqual(accepted(0.79), false);
});

process.stdout.write(failed ? `\n${failed} failing\n` : '\nall passing\n');
process.exit(failed ? 1 : 0);
