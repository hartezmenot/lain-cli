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

  // ---- THE FOLD REGIME, PINNED AS A MECHANISM (CONTROL-LOOP §2a) ----------
  //
  // The corpus finding: at the message cap, every append past the cap folds,
  // and _foldOldest replaces messages[1] with fresh summary content — so on a
  // second fold the byte content at index 1 changes again, and every request
  // re-prices from index 1 onward. Cache was bounded at the head (~18k) in
  // the observed run. These cases reproduce the MECHANISM in isolation — the
  // corpus-derived observation becomes UNIT-VERIFIED behavior; the gateway
  // half of the finding stays corpus-derived until the reqtrace-backed live
  // run (CONTROL-LOOP §5).
  //
  // They are written against the CURRENT contract: splice-at-1 is correct
  // conversation management (index 0, the objective, survives; units stay
  // whole). If the §6.1 candidate lands — messages[1] held byte-stable across
  // folds — the second case below is the one to flip, and its comment says so.

  await test('a fold replaces the bytes at messages[1] — the cache-relevant fact', () => {
    const s = new Session({ cwd: home });
    s.messages.push({ role: 'user', content: 'THE OBJECTIVE' });
    for (let i = 0; i < 30; i++) {
      s.messages.push({ role: 'user', content: `exchange ${i}` });
    }
    const before = JSON.stringify(s.messages[1]);
    const folded = s._foldOldest(10);
    assert.ok(folded > 0, 'the fold happened');
    assert.strictEqual(s.messages[0].content, 'THE OBJECTIVE', 'index 0 survives');
    assert.strictEqual(s.messages[1].elided, 'folded', 'the fold summary is the new messages[1]');
    assert.notStrictEqual(JSON.stringify(s.messages[1]), before,
      'messages[1] changed bytes — everything behind it re-prices for cache');
  });

  await test('at the cap, consecutive folds keep changing messages[1] — the regime', () => {
    const s = new Session({ cwd: home });
    s.messages.push({ role: 'user', content: 'THE OBJECTIVE' });
    for (let i = 0; i < 40; i++) {
      s.messages.push({ role: 'user', content: `exchange ${i}` });
    }
    s._foldOldest(10);
    const firstFoldBytes = JSON.stringify(s.messages[1]);
    // Simulate the cap regime: appends push past the target, and every
    // append triggers another fold, same as contextauthority's edge-triggered
    // compaction at the cap.
    s.messages.push({ role: 'user', content: 'new work A' });
    s.messages.push({ role: 'user', content: 'new work B' });
    s._foldOldest(10);
    assert.notStrictEqual(JSON.stringify(s.messages[1]), firstFoldBytes,
      'the second fold rewrites messages[1] again — if this ever becomes STRICTLY equal, '
      + 'the §6.1 candidate (stable fold slot) has landed and this case should be flipped '
      + 'to pin that behavior instead');
    assert.strictEqual(s.messages[0].content, 'THE OBJECTIVE', 'the objective still survives');
  });

  await test('folding never leaves a dangling tool half (the 400 guard)', () => {
    const s = new Session({ cwd: home });
    s.messages.push({ role: 'user', content: 'THE OBJECTIVE' });
    // The pair is planted AT the computed cut, not safely inside the folded
    // run: with 24 messages, target 10, keepRecent 10, floor = 14 and the
    // initial cut = 14 — the tool ANSWER's index. Without the backward
    // snap-to-unit-boundary, the call at 13 folds and the answer at 14 is
    // orphaned — a 400 on the next request. The retreat folds one fewer
    // message and keeps the pair together.
    for (let i = 0; i < 12; i++) {
      s.messages.push({ role: 'user', content: `exchange ${i}` });
    }
    s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_bash', arguments: '{}' } }] });
    s.messages.push({ role: 'tool', tool_call_id: 'c1', content: 'build ok' });
    for (let i = 12; i < 21; i++) {
      s.messages.push({ role: 'user', content: `exchange ${i}` });
    }
    assert.strictEqual(s.messages.length, 24, 'the arithmetic this test is planted on');
    const folded = s._foldOldest(10);
    assert.ok(folded > 0, 'fold happened');
    const calls = s.messages.filter((m) => m.role === 'assistant' && m.tool_calls);
    const answers = s.messages.filter((m) => m.role === 'tool');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(answers.length, 1,
      'every surviving call keeps its answer — a dangling half is a 400');
    assert.strictEqual(s.messages[0].content, 'THE OBJECTIVE');
  });
};
