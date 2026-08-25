'use strict';

/**
 * THE DASHBOARD PASSWORD —.
 *
 * The token that preceded this was strong and had one practical fault: it
 * changes every session, so reaching the dashboard from a phone meant finding
 * the terminal and transcribing 32 hex characters, every time. A credential you
 * can only transcribe and never know is one you stop using.
 *
 * What must be true of the replacement is narrow and testable: the password is
 * never stored, a wrong one never passes, a malformed record never throws, and
 * proving it once buys a session rather than putting the password on every
 * request.
 */

const assert = require('assert');
const { test } = require('../helpers');

const auth = require('../../src/dashauth');

module.exports = async function () {
  await test('AUTH: the password itself is NEVER in what gets stored', () => {
    const rec = auth.hash('correct horse battery staple');
    const blob = JSON.stringify(rec);
    assert.ok(!blob.includes('correct horse'), 'the password appeared in the stored record');
    assert.ok(!blob.includes('staple'), 'nor may any part of it');
    assert.strictEqual(rec.alg, 'scrypt');
    assert.ok(rec.salt && rec.hash, 'a salt and a hash are what is kept');
  });

  await test('AUTH: the same password hashes DIFFERENTLY every time', () => {
    // A per-record salt is what stops one stolen config from answering
    // questions about another, and what stops a rainbow table from working.
    const a = auth.hash('hunter2');
    const b = auth.hash('hunter2');
    assert.notStrictEqual(a.hash, b.hash, 'two hashes of one password must differ');
    assert.notStrictEqual(a.salt, b.salt);
    assert.ok(auth.verify(a, 'hunter2') && auth.verify(b, 'hunter2'), 'and both must still verify');
  });

  await test('AUTH: the right password verifies and every wrong one does not', () => {
    const rec = auth.hash('opensesame');
    assert.strictEqual(auth.verify(rec, 'opensesame'), true);
    for (const wrong of ['opensesam', 'opensesame ', 'OPENSESAME', '', null, undefined, 'x']) {
      assert.strictEqual(auth.verify(rec, wrong), false, `${JSON.stringify(wrong)} must not pass`);
    }
  });

  await test('AUTH: a malformed record READS AS WRONG, it does not throw', () => {
    // An auth check that can crash out of a request handler is an auth check
    // that can be made to fail open. A truncated or hand-edited config must be
    // a refusal, not a stack trace.
    for (const bad of [null, {}, { alg: 'scrypt' }, { alg: 'md5', salt: 'aa', hash: 'bb' },
      { alg: 'scrypt', salt: 'zz-not-hex', hash: 'bb' }, { alg: 'scrypt', salt: '', hash: '' }]) {
      assert.strictEqual(auth.verify(bad, 'anything'), false, `${JSON.stringify(bad)} must refuse`);
    }
  });

  await test('AUTH: configured() is honest about whether a password exists', () => {
    assert.strictEqual(auth.configured({}), false);
    assert.strictEqual(auth.configured({ dashPassword: null }), false);
    assert.strictEqual(auth.configured({ dashPassword: { alg: 'scrypt' } }), false, 'half a record is not a password');
    assert.strictEqual(auth.configured({ dashPassword: auth.hash('x') }), true);
  });

  await test('SESSIONS: proving the password buys a token, not a standing pass', () => {
    const s = new auth.Sessions();
    const t = s.grant('phone');
    assert.ok(t && t.length >= 32, 'the session token must be long and random');
    assert.strictEqual(s.valid(t), true);
    assert.strictEqual(s.valid('something else'), false);
    assert.strictEqual(s.valid(''), false);
  });

  await test('SESSIONS: they EXPIRE, and an expired one is forgotten', () => {
    const s = new auth.Sessions({ ttlMs: 1 });
    const t = s.grant();
    s.byToken.get(t).at = Date.now() - 10;
    assert.strictEqual(s.valid(t), false, 'past its time it must not pass');
    assert.strictEqual(s.count, 0, 'and it must not be kept around');
  });

  await test('SESSIONS: guessing is BOUNDED, and a success clears the count', () => {
    // A dashboard on a LAN is reachable by everything on that LAN. This is a
    // hard stop cleared by restarting LAIN, not a delay.
    const s = new auth.Sessions({ maxAttempts: 3 });
    assert.strictEqual(s.lockedOut, false);
    s.noteFailure(); s.noteFailure();
    assert.strictEqual(s.lockedOut, false, 'still open at two of three');
    assert.strictEqual(s.noteFailure(), 0, 'the third leaves none remaining');
    assert.strictEqual(s.lockedOut, true);

    const ok = new auth.Sessions({ maxAttempts: 3 });
    ok.noteFailure(); ok.noteFailure();
    ok.grant();
    assert.strictEqual(ok.lockedOut, false, 'a correct password must clear the count');
  });

  await test('SESSIONS: revoking logs every open page out at once', () => {
    const s = new auth.Sessions();
    const a = s.grant(); const b = s.grant();
    assert.strictEqual(s.revokeAll(), 2, 'it reports how many it dropped');
    assert.strictEqual(s.valid(a), false);
    assert.strictEqual(s.valid(b), false);
  });
};
