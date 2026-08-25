'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const home = tmpdir('lain-sess-');
  process.env.LAIN_CONFIG_DIR = home;
  // Required AFTER the env var so config resolves to the isolated home.
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/session')];
  const { Session } = require('../../src/session');

  await test('a new session is EMPTY and reads nothing from disk', () => {
    const s = new Session({ cwd: home });
    assert.deepStrictEqual(s.messages, []);
    assert.deepStrictEqual(s.turns, []);
    assert.strictEqual(s.usage.inputTokens, 0);
  });

  await test('two new sessions get different ids and share no state', () => {
    const a = new Session({ cwd: home });
    const b = new Session({ cwd: home });
    assert.notStrictEqual(a.id, b.id);
    a.messages.push({ role: 'user', content: 'only mine' });
    assert.strictEqual(b.messages.length, 0);
  });

  await test('save then resume restores messages, turns and usage', () => {
    const a = new Session({ cwd: home });
    a.messages.push({ role: 'user', content: 'hello' });
    a.turns.push({ turnId: 't1', toolCalls: 3 });
    a.usage.inputTokens = 42;
    a.save();
    const b = Session.resume(a.id);
    assert.ok(b, 'resumed');
    assert.strictEqual(b.id, a.id);
    assert.strictEqual(b.messages.length, 1);
    assert.strictEqual(b.turns[0].toolCalls, 3);
    assert.strictEqual(b.usage.inputTokens, 42);
  });

  await test('resuming an unknown id returns null — never a fallback session', () => {
    assert.strictEqual(Session.resume('does-not-exist'), null);
    assert.strictEqual(Session.resume(''), null);
  });

  await test('a new session does NOT inherit the most recent saved session', () => {
    const old = new Session({ cwd: home });
    old.messages.push({ role: 'user', content: 'previous work' });
    old.save();
    const fresh = new Session({ cwd: home });
    assert.strictEqual(fresh.messages.length, 0, 'fresh session must be empty');
    assert.notStrictEqual(fresh.id, old.id);
  });

  await test('session.js contains no automatic-resume machinery', () => {
    // A structural assertion: the failure mode is a heuristic creeping back in.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'session.js'), 'utf8');
    assert.ok(!/mostRecent|latestSession|findRelated|similar|autoResume/i.test(src),
      'session.js must not contain latest/related/auto-resume logic');
  });

  await test('list() enumerates without resuming', () => {
    const ids = Session.list(50);
    assert.ok(Array.isArray(ids));
    assert.ok(ids.length >= 1);
  });
};
