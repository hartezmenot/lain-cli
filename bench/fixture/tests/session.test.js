'use strict';

const assert = require('assert');
const { closeSession } = require('../src/session');

// createSession's behaviour depends on token validation, which is under
// review by the security desk (see the auth module); these tests cover the
// session lifecycle itself and stay out of that question.

module.exports = [
  { name: 'session: closeSession is false for nothing at all', fn() {
    assert.strictEqual(closeSession(null), false);
    assert.strictEqual(closeSession(undefined), false);
  } },
  { name: 'session: closeSession refuses a session that never opened', fn() {
    assert.strictEqual(closeSession({ ok: false }), false);
  } },
  { name: 'session: closeSession marks an open session closed', fn() {
    const s = { ok: true, token: 'x', user: 'u', id: 1 };
    assert.strictEqual(closeSession(s), true);
    assert.strictEqual(s.closed, true);
  } },
];
