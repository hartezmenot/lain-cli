'use strict';

const assert = require('assert');
const { validateToken, issueToken } = require('../src/auth');

module.exports = [
  { name: 'auth: issueToken returns 32 lowercase hex characters', fn() {
    const t = issueToken('alice');
    assert.strictEqual(t.length, 32);
    assert.match(t, /^[0-9a-f]{32}$/);
  } },
  { name: 'auth: issueToken is deterministic per operator', fn() {
    assert.strictEqual(issueToken('alice'), issueToken('alice'));
  } },
  { name: 'auth: validateToken refuses a non-string', fn() {
    assert.strictEqual(validateToken(null), false);
    assert.strictEqual(validateToken(1234), false);
  } },
  { name: 'auth: validateToken refuses non-hex characters', fn() {
    assert.strictEqual(validateToken('z'.repeat(32)), false);
  } },
  { name: 'auth: validateToken refuses over-long tokens', fn() {
    assert.strictEqual(validateToken('a'.repeat(33)), false);
  } },
];
