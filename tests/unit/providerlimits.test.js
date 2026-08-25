'use strict';

/**
 * WHAT A PROVIDER WILL ACCEPT — three different limits, one source.
 *
 *: "Do not hardcode 800 throughout the code… at minimum distinguish
 * message_count_limit, context_token_limit, request_size_limit, because these
 * are not the same thing."
 *
 * The failure these pin down is the reported one: LAIN measured CHARACTERS,
 * omniroute counts MESSAGES, and a thousand short messages passed every check
 * LAIN had before being refused by the provider.
 */

const assert = require('assert');
const { test } = require('../helpers');
const pl = require('../../src/providerlimits');

const wire = (n, content = 'x') => Array.from({ length: n }, () => ({ role: 'user', content }));

module.exports = async function () {
  await test('LIMITS: a known provider carries its message cap without any config', () => {
    const omni = { provider: 'omniroute', connectionId: 'omniroute', ctx: 128000 };
    const l = pl.limitsFor(omni, {});
    assert.strictEqual(l.messages, 800);
    assert.strictEqual(l.tokens, 128000, 'the token window is a DIFFERENT limit and is carried separately');
    assert.match(l.source, /known default/);
  });

  await test('LIMITS: an unknown provider gets NO invented cap', () => {
    // A guess here silently folds history the provider would have accepted.
    // "Unknown" is a real answer and is reported as one.
    const l = pl.limitsFor({ provider: 'acme', connectionId: 'acme' }, {});
    assert.strictEqual(l.messages, 0);
    assert.strictEqual(pl.check(wire(5000), l).ok, true, 'and nothing is refused on LAIN\'s guess');
  });

  await test('LIMITS: config beats the default, and the connection id beats the provider', () => {
    const pc = { provider: 'omniroute', connectionId: 'omniroute:openrouter' };
    assert.strictEqual(pl.limitsFor(pc, { providerLimits: { omniroute: { messages: 400 } } }).messages, 400);
    assert.strictEqual(
      pl.limitsFor(pc, { providerLimits: { omniroute: { messages: 400 }, 'omniroute:openrouter': { messages: 250 } } }).messages,
      250, 'a person with two routes may know they differ');
  });

  await test('LIMITS: a refusal TEACHES the cap, and the lowest one wins', () => {
    pl.forget();
    const pc = { provider: 'acme', connectionId: 'acme' };
    assert.strictEqual(pl.limitsFor(pc, {}).messages, 0);
    pl.learn(pc, { messages: 500 });
    assert.strictEqual(pl.limitsFor(pc, {}).messages, 500);
    assert.match(pl.limitsFor(pc, {}).source, /the provider said so/);
    pl.learn(pc, { messages: 300 });
    assert.strictEqual(pl.limitsFor(pc, {}).messages, 300, 'the smaller number keeps requests getting through');
    pl.learn(pc, { messages: 900 });
    assert.strictEqual(pl.limitsFor(pc, {}).messages, 300, 'and a larger later claim does not raise it');
    pl.forget();
  });

  await test('LIMITS: nonsense from a refusal is ignored rather than stored', () => {
    pl.forget();
    const pc = { provider: 'acme', connectionId: 'acme' };
    pl.learn(pc, { messages: 0 });
    pl.learn(pc, {});
    pl.learn(pc, { messages: -5 });
    assert.strictEqual(pl.limitsFor(pc, {}).messages, 0, 'a cap of zero would refuse every request forever');
    pl.forget();
  });

  await test('MEASURE: tool-call arguments are payload too', () => {
    // An assistant message carrying six tool calls has arguments the provider
    // counts and `content` does not show. Measured by content alone, a turn
    // full of large arguments looked nearly empty.
    const withArgs = [{ role: 'assistant', content: '', tool_calls: [{ name: 'write_file', arguments: 'x'.repeat(500) }] }];
    const m = pl.measure(withArgs);
    assert.strictEqual(m.messages, 1);
    assert.ok(m.chars >= 500, `arguments must be counted (got ${m.chars})`);
  });

  await test('CHECK: the cap has headroom, because the provider counts what it receives', () => {
    const l = { messages: 100 };
    assert.strictEqual(pl.check(wire(90), l).ok, true);
    assert.strictEqual(pl.check(wire(99), l).ok, false, 'sitting on the boundary is a refused request');
    const v = pl.check(wire(120), l);
    assert.strictEqual(v.over, 'messages');
    assert.match(v.why, /120 messages against this provider's 100-message limit/);
  });

  await test('FOLD: a count-driven fold never orphans a tool call from its result', () => {
    // THE 400 THIS PREVENTS. Every OpenAI-shaped API treats an assistant
    // message carrying `tool_calls` and the `tool` messages answering it as ONE
    // unit: a result whose call is missing is a 400, and so is a call whose
    // result is missing. Folding to a MESSAGE COUNT is new, and a fold that cut
    // between a call and its result would turn a context problem into a
    // protocol error — a worse failure than the one being fixed.
    const { Session } = require('../../src/session');
    const s = new Session({ cwd: process.cwd() });
    for (let i = 0; i < 120; i++) {
      s.messages.push({ role: 'user', content: `ask ${i}` });
      s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: '{}' }] });
      s.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `result ${i}` });
    }
    const before = s.messages.length;
    const r = s.compact({ maxMessages: 100, force: true });
    assert.ok(r.folded > 0, 'it must actually have folded something');
    assert.ok(s.messages.length < before, `${before} → ${s.messages.length}`);

    const callIds = new Set();
    for (const m of s.messages) for (const tc of m.tool_calls || []) callIds.add(String(tc.id));
    const orphanResults = s.messages.filter((m) => m.role === 'tool' && !callIds.has(String(m.tool_call_id)));
    assert.deepStrictEqual(orphanResults, [], 'a tool result whose call was folded away is a 400');

    const unanswered = [];
    for (const m of s.messages) {
      for (const tc of m.tool_calls || []) {
        if (!s.messages.some((x) => x.role === 'tool' && String(x.tool_call_id) === String(tc.id))) unanswered.push(tc.id);
      }
    }
    assert.deepStrictEqual(unanswered, [], 'a call whose result was folded away is also a 400');
  });

  await test('TARGET: compaction aims BELOW the cap, so the next turn does not immediately exceed it', () => {
    const target = pl.targetFor({ messages: 800 });
    assert.ok(target < 800 * pl.HEADROOM,
      'landing exactly on the headroom means every following turn pays for a compaction');
    assert.ok(target > 700, 'while still keeping as much history as the provider allows');
    assert.strictEqual(pl.targetFor({ messages: 0 }), 0, 'and no cap means no target');
  });
};
