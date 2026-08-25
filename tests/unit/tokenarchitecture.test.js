'use strict';

/**
 * THE SHAPE OF A REQUEST — pinned as properties, not as numbers.
 *
 * ------------------------------------------------------------------------
 * THE INCIDENT THIS EXISTS FOR, in the reporter's own figures:
 *
 *     815 requests · 59,243,462 input · 202,310 output · 24.5% cached
 *     individual requests: ~66,000 input -> 36 output
 *
 * Measured on this repository, a request was composed of:
 *
 *     tool schemas (45 tools)   ~10,329 tokens   on every request
 *     system prompt              ~3,504 tokens   on every request
 *     project brief                ~945 tokens   on every request
 *     conversation              up to 50,000 tokens
 *     ------------------------------------------------------------
 *     predicted steady state    ~64,778 tokens   (observed 62,716-66,481)
 *
 * ------------------------------------------------------------------------
 * WHY THIS FILE ASSERTS NO TOKEN LIMIT.
 *
 * A test that says "a request must be under N tokens" is a test that will be
 * satisfied one day by making LAIN dumber, and it would have passed happily
 * throughout the incident because every individual request was legitimate. What
 * went wrong was STRUCTURAL, so what is pinned here is structure:
 *
 *   - the cacheable head of a request does not move when volatile state changes
 *   - the volatile block cannot be hoisted into a provider's cached block
 *   - tool schemas are sent once
 *   - runtime telemetry never reaches the model
 *
 * A sweep of the compaction trigger is deliberately NOT encoded as a rule.
 * Measured on a 40-step loop, lowering the 50,000-token budget reduced TOTAL
 * input (1.53M -> 0.88M) and INCREASED billed, uncached input (494K -> 640K),
 * because compacting more often rewrites the prefix a cache was keeping. The
 * budget is close to optimal for the number that is actually paid, and a test
 * demanding a smaller one would have made the bill larger.
 */

const assert = require('assert');
const { test } = require('../helpers');

const prompt = require('../../src/prompt');
const contextfit = require('../../src/contextfit');

/** A session-shaped object with the fields the prompt path actually reads. */
function sessionLike(extra = {}) {
  const { Session } = require('../../src/session');
  const s = new Session({ cwd: process.cwd() });
  Object.assign(s, extra);
  return s;
}

module.exports = async function () {
  // ---- THE SPLIT CHANGES ORDER, NOT CONTENT ------------------------------

  await test('TOKENS: splitting the prompt changes not one byte of what the model is told', () => {
    const args = {
      cwd: '/proj', platform: 'win32', model: 'glm-5.3-flash',
      mode: 'IMPLEMENT', session: sessionLike(),
    };
    const whole = prompt.build(args);
    const { stable, live } = prompt.build({ ...args, separate: true });
    const rejoined = live ? `${stable}\n\n${live}` : stable;
    // IDENTICAL. This is an ordering change; if it were ever anything more, the
    // model would be receiving different instructions and this would fail.
    assert.strictEqual(rejoined, whole, 'the halves must rejoin into exactly the original prompt');
    assert.ok(stable.length > 0 && live.length > 0, 'both halves must carry something');
  });

  await test('TOKENS: the cacheable head does not move when volatile state changes', () => {
    // ---- THE PROPERTY THE INCIDENT VIOLATED ------------------------------
    //
    // A prefix cache keeps the longest identical HEAD of a request. Volatile
    // text placed before the conversation means a turn boundary re-prices the
    // whole request — fifty thousand tokens of transcript that did not change,
    // behind one byte that did.
    const base = { cwd: '/proj', platform: 'win32', model: 'glm-5.3-flash', separate: true };
    const quiet = prompt.build({ ...base, mode: 'IMPLEMENT', session: sessionLike() });
    const busy = prompt.build({
      ...base,
      mode: 'DEBUG',
      session: sessionLike({ task: { steers: [{ text: 'skip the migration for now' }] } }),
    });
    assert.strictEqual(busy.stable, quiet.stable, 'the stable half moved when only volatile state changed');
    assert.notStrictEqual(busy.live, quiet.live, 'the volatile half must be where the change lands');
  });

  // ---- WHERE THE VOLATILE BLOCK SITS ON THE WIRE -------------------------

  await test('TOKENS: the volatile block rides at the tail, and never as a system message', () => {
    const session = sessionLike();
    session.messages.push({ role: 'user', content: 'do the thing' });
    session.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] });
    session.messages.push({ role: 'tool', tool_call_id: 'c1', content: 'FILE BODY' });
    const wire = contextfit.buildWire(session, 'STABLE HEAD', 'LIVE STATE');

    assert.strictEqual(wire[0].role, 'system');
    assert.strictEqual(wire[0].content, 'STABLE HEAD');
    const last = wire[wire.length - 1];
    assert.strictEqual(last.content, 'LIVE STATE', 'the volatile block must be last');
    // ---- NOT ROLE `system` -----------------------------------------------
    //
    // provider.js hoists EVERY system message into Anthropic's system block,
    // which carries the cache breakpoint. A volatile system message would put
    // the changing text straight back into the prefix this exists to protect.
    assert.notStrictEqual(last.role, 'system', 'a system role would be hoisted into the cached block');
    assert.strictEqual(last._live, true, 'it must be identifiable to accounting and compaction');
    assert.strictEqual(wire.filter((m) => m.role === 'system').length, 1, 'exactly one system message');
  });

  await test('TOKENS: with no volatile block the wire is exactly what it always was', () => {
    const session = sessionLike();
    session.messages.push({ role: 'user', content: 'hello' });
    const before = contextfit.buildWire(session, 'SYS');
    assert.strictEqual(before.length, 2);
    assert.ok(!before.some((m) => m._live), 'nothing is appended when there is nothing to append');
  });

  await test('TOKENS: two user turns never reach the Anthropic protocol in a row', () => {
    // The volatile block follows a tool result, and this mapping has already
    // turned that into a user turn. Two user messages in a row is a 400.
    const provider = require('../../src/provider');
    const out = provider.toAnthropic([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 't', arguments: '{}' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
      { role: 'user', content: 'LIVE STATE', _live: true },
    ]);
    for (let i = 1; i < out.messages.length; i++) {
      assert.notStrictEqual(
        out.messages[i].role, out.messages[i - 1].role,
        'consecutive same-role turns are refused by this protocol',
      );
    }
    const joined = JSON.stringify(out.messages);
    assert.ok(joined.includes('LIVE STATE'), 'and the block still reaches the model');
  });

  // ---- WHAT MUST NEVER BE IN A REQUEST -----------------------------------

  await test('TOKENS: runtime telemetry never reaches the model', () => {
    // ---- THE FEEDBACK LOOP THIS PREVENTS ---------------------------------
    //
    //     request -> telemetry -> context -> new request -> telemetry changes
    //     -> the cache is invalidated by the act of measuring it
    //
    // Token counts are an instrument reading. They belong on a screen.
    const built = prompt.build({
      cwd: '/proj', platform: 'win32', model: 'glm-5.3-flash',
      mode: 'IMPLEMENT', session: sessionLike(),
    });
    for (const word of [
      'cache_read', 'cacheRead', 'input_tokens', 'inputTokens', 'output_tokens',
      'outputTokens', 'tokens used', 'request #', 'latency',
    ]) {
      assert.ok(!built.includes(word), `the prompt carries telemetry: ${word}`);
    }
  });

  await test('TOKENS: the tool schemas are counted once, and they are the largest fixed cost', () => {
    const tokenaudit = require('../../src/tokenaudit');
    const tools = [
      { name: 'read_file', description: 'x'.repeat(400), parameters: { type: 'object' } },
      { name: 'shell', description: 'y'.repeat(400), parameters: { type: 'object' } },
    ];
    const wire = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }];
    const audit = tokenaudit.measure(wire, { tools, budget: 100000 });
    const once = JSON.stringify(tools).length;
    // ACCOUNTED, AND ACCOUNTED ONCE. A breakdown that left the schemas out
    // understated every request by about ten thousand tokens; one that counted
    // them twice would send somebody hunting for a duplication that is not there.
    assert.strictEqual(audit.chars.toolSchemas, once, 'the schemas must be counted exactly once');
    assert.ok(audit.chars.total >= once, 'and included in the total');
  });

  await test('TOKENS: a request carries the conversation once — no nesting', () => {
    // The failure this guards: context = previousContext + newContext, where
    // every request contains the last one. It shows up as the same body
    // appearing twice in one payload.
    const tokenaudit = require('../../src/tokenaudit');
    const body = 'B'.repeat(4000);
    const clean = tokenaudit.measure(
      [{ role: 'user', content: body }, { role: 'assistant', content: 'ok' }],
      { tools: [], budget: 100000 },
    );
    assert.strictEqual(clean.chars.duplicate, 0, 'a healthy request repeats nothing');
    const nested = tokenaudit.measure(
      [{ role: 'user', content: body }, { role: 'assistant', content: 'ok' }, { role: 'user', content: body }],
      { tools: [], budget: 100000 },
    );
    assert.ok(nested.chars.duplicate >= 4000, 'a repeated body must be visible in the accounting');
  });
};
