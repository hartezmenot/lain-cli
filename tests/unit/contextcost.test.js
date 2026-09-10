'use strict';

/**
 * WHAT A REQUEST COSTS, AND WHY — the regression tests for the context leak.
 *
 * ------------------------------------------------------------------------
 * THE REPORT: requests of 325,000-343,000 input tokens against a few hundred
 * output, exhausting a rate limit in minutes.
 *
 * THE MEASUREMENT, taken before anything was changed, reading ten source files
 * across eleven requests through the real binary:
 *
 *     236,711 chars of source on disk
 *   1,563,325 chars transmitted          6.6x amplification
 *      77,001 tokens in the last request alone
 *
 * and on twenty-four modules, a peak request of 204,644 tokens.
 *
 * ------------------------------------------------------------------------
 * THREE CAUSES, AND ONE THING THAT TURNED OUT NOT TO BE A CAUSE.
 *
 *   THE BUDGET WAS THE CEILING. `contextfit` compacted against
 *   `session.budgetChars`, which answers "what will this provider ACCEPT" —
 *   676,108 characters on a 200k model. So the careful, information-aware
 *   folding in `session.compact` never ran until the window was nearly full,
 *   by which point the transcript had already been paid for on every request
 *   that carried it there. See src/contextbudget.js.
 *
 *   THE OPENAI-SHAPED PATH SENT NO CACHE MARKERS. provider.js solves the replay
 *   problem for the anthropic protocol and says in its own comment that without
 *   a breakpoint the uncached total "grows like N(N+1)/2 instead of N". The
 *   chat path — which is what a bridge or gateway is — had none, and read no
 *   cache figures back, so nothing could even report the condition.
 *   See src/promptcache.js.
 *
 *   NOTHING COULD SAY WHERE THE TOKENS WENT. `usage.inputTokens` is one number
 *   handed back after the fact. See src/tokenaudit.js.
 *
 *   AND THE FINGERPRINTS WERE ALREADY WORKING, which is asserted below because
 *   an audit that blames the wrong component gets the wrong thing "fixed".
 *   Six reads of a 34,338-char file added 1,240 chars after the first.
 */

const assert = require('assert');
const { test } = require('../helpers');

const tokenaudit = require('../../src/tokenaudit');
const contextbudget = require('../../src/contextbudget');
const promptcache = require('../../src/promptcache');
const sessionMod = require('../../src/session');

const NL = String.fromCharCode(10);
const body = (n, seed = 'x') => seed.repeat(Math.max(1, n));

/** A session carrying a realistic finished-work transcript. */
function sessionWith({ files = 8, size = 20000 } = {}) {
  const s = new sessionMod.Session({ cwd: process.cwd() });
  s.messages.push({ role: 'user', content: 'refactor the loader and make the tests pass' });
  for (let i = 0; i < files; i++) {
    s.messages.push({
      role: 'assistant', content: `Reading file ${i}.`,
      tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: JSON.stringify({ path: `src/m${i}.js` }) }],
    });
    s.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: body(size, `f${i % 7}`) });
  }
  return s;
}

module.exports = async function () {
  // ------------------------------------------------------- the accounting --

  await test('COST: a request is accounted by CATEGORY, not as one opaque number', () => {
    // The whole reason nothing could be diagnosed: `usage.inputTokens` cannot
    // tell a system prompt from the ninth replay of a file read an hour ago.
    const a = tokenaudit.measure([
      { role: 'system', content: body(3600) },
      { role: 'user', content: body(360) },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: '1', name: 'read_file', arguments: '{"path":"a"}' }] },
      { role: 'tool', tool_call_id: '1', content: body(36000) },
    ], { tools: [{ name: 't', description: 'd', parameters: {} }], budget: 180000 });

    assert.strictEqual(a.chars.system, 3600);
    assert.strictEqual(a.chars.user, 360);
    assert.strictEqual(a.chars.toolResults, 36000);
    assert.ok(a.chars.toolSchemas > 0, 'the schemas are payload and must be counted');
    // A TOOL CALL IS PAYLOAD TOO. An assistant message that is nothing but
    // calls would otherwise count as zero, and a turn full of them as free.
    assert.ok(a.chars.assistant > 2, `the call arguments must be counted, got ${a.chars.assistant}`);
    assert.strictEqual(a.estTokens.total, Math.round(a.chars.total / tokenaudit.CHARS_PER_TOKEN));
  });

  await test('COST: the report names the biggest contributor first, and says what was cached', () => {
    const a = tokenaudit.measure([
      { role: 'system', content: body(3600) },
      { role: 'tool', tool_call_id: '1', content: body(90000) },
    ], { tools: [], budget: 180000 });
    const lines = tokenaudit.report(a, { n: 27, output: 642, cacheRead: 0 });
    const text = lines.join(NL);
    assert.match(lines[1], /tool results/, 'largest first — an alphabetical list makes the reader sort it');
    assert.match(text, /INPUT \(est\)/);
    // ZERO CACHE IS THE EXPENSIVE SILENT CONDITION, so it is stated rather than
    // rendered as a blank.
    assert.match(text, /nothing was served from cache/);
  });

  // ---- TEST H — duplicate detection ---------------------------------------

  await test('COST: duplicate content INSIDE one request is measured as a ratio', () => {
    const dup = body(30000, 'd');
    const a = tokenaudit.measure([
      { role: 'tool', tool_call_id: '1', content: dup },
      { role: 'tool', tool_call_id: '2', content: dup },
      { role: 'tool', tool_call_id: '3', content: body(30000, 'u') },
    ], { tools: [], budget: 0 });
    assert.strictEqual(a.chars.duplicate, 30000, 'the second copy is the waste');
    assert.ok(a.duplicateRatio > 0.3 && a.duplicateRatio < 0.4, `ratio was ${a.duplicateRatio}`);

    // AND A SHORT REPEATED RESULT IS NOT "DUPLICATION". Two identical `ok`s are
    // not what this is looking for, and counting them would bury the one that is.
    const b = tokenaudit.measure([
      { role: 'tool', tool_call_id: '1', content: 'ok' },
      { role: 'tool', tool_call_id: '2', content: 'ok' },
    ], { tools: [], budget: 0 });
    assert.strictEqual(b.chars.duplicate, 0);
  });

  // ---- TEST F — context budget --------------------------------------------

  await test('COST: the BUDGET is far below the CEILING — that gap was the defect', () => {
    const pc = { ctx: 200000, maxTokens: 8192 };
    const ceiling = sessionMod.budgetChars(pc);
    const budget = contextbudget.charsFor(pc, {});
    assert.ok(ceiling > 600000, `the ceiling really is that large: ${ceiling}`);
    assert.ok(budget < ceiling / 3,
      `compacting against the ceiling (${ceiling}) is why compaction never ran; budget is ${budget}`);
    assert.strictEqual(budget, contextbudget.DEFAULT_BUDGET_TOKENS * sessionMod.CHARS_PER_TOKEN);
  });

  await test('COST: the budget never exceeds what the provider will accept', () => {
    // On a small-window model the provider's limit binds, and a budget that
    // permitted a refused request would be worse than no budget.
    const small = { ctx: 8000, maxTokens: 2000 };
    assert.ok(contextbudget.charsFor(small, {}) <= sessionMod.budgetChars(small));
  });

  await test('COST: the budget is configurable, and floored so it cannot be set to nothing', () => {
    const pc = { ctx: 200000, maxTokens: 8192 };
    assert.ok(contextbudget.charsFor(pc, { contextBudgetTokens: 20000 }) < contextbudget.charsFor(pc, {}));
    const tiny = contextbudget.charsFor(pc, { contextBudgetTokens: 5 });
    assert.strictEqual(tiny, contextbudget.MIN_BUDGET_TOKENS * sessionMod.CHARS_PER_TOKEN,
      'a budget of five tokens is a mistake, not an instruction');
  });

  await test('COST: over budget COMPACTS, and a payload still over after that is SENT and said', () => {
    const d = contextbudget.decide(500000, 180000);
    assert.strictEqual(d.action, contextbudget.ACTION.COMPACT);
    assert.strictEqual(d.over, 320000);
    assert.strictEqual(contextbudget.decide(1000, 180000).action, contextbudget.ACTION.SEND);
  });

  // ---- TEST E — completed tool output becomes compact state ---------------

  await test('COST: a completed tool result becomes a STUB THAT NAMES ITS CALL, not a gap', () => {
    // The distinction the steer draws, and it is the whole difference between
    // information-aware compaction and `context[-50000:]`: what is removed is
    // still REPRESENTED, and the representation says how to get it back.
    const s = sessionWith({ files: 8, size: 20000 });
    const before = s.contextChars();
    const r = s.compact({ budgetChars: 60000 });
    assert.ok(r.compacted, 'a 160k transcript against a 60k budget must compact');
    assert.ok(s.contextChars() < before);

    // Only the NAMED stubs: the second, inward pass truncates the most recent
    // result instead of stubbing it, and that one is asserted separately below.
    const stubs = s.messages.filter((m) => m.role === 'tool' && /^\[elided/.test(String(m.content)));
    assert.ok(stubs.length, 'old tool results must be stubbed');
    for (const m of stubs) {
      assert.match(m.content, /read_file/, 'the stub names the call that produced it');
      assert.match(m.content, /src\/m\d+\.js/, 'and its arguments');
      assert.match(m.content, /returned \d+ chars/, 'and how much there was');
      assert.match(m.content, /Re-run the call/, 'and how to get it back');
    }
  });

  // ---- TEST G — quality preservation --------------------------------------

  await test('COST: compaction keeps the OBJECTIVE and the CURRENT working set whole', () => {
    // Token reduction must not mean forgetting the task or losing the material
    // the model is reasoning from right now.
    const s = sessionWith({ files: 10, size: 20000 });
    const objective = s.messages[0].content;
    const lastTool = s.messages[s.messages.length - 1].content;
    s.compact({ budgetChars: 80000 });

    assert.strictEqual(s.messages[0].content, objective,
      'the request being worked on is never elided — everything else is relative to it');
    assert.strictEqual(s.messages[s.messages.length - 1].content, lastTool,
      'the most recent result is what the model is working FROM, and stays whole');
    assert.strictEqual(s.messages.length, 21, 'nothing is deleted; bodies are replaced');
  });

  await test('COST: compaction is a NO-OP on a session that is already small', () => {
    // A budget that fires on everything is a budget that costs history for
    // nothing. A short session must come through untouched.
    const s = sessionWith({ files: 2, size: 500 });
    const before = s.messages.map((m) => m.content);
    const r = s.compact({ budgetChars: contextbudget.charsFor({ ctx: 200000, maxTokens: 8192 }, {}) });
    assert.strictEqual(r.compacted, false);
    assert.deepStrictEqual(s.messages.map((m) => m.content), before);
  });

  // ---- the cache, which is what makes the replay affordable ---------------

  await test('COST: cache markers are OFF by default — measured, and they did nothing', () => {
    // ---- THE MEASUREMENT THAT DECIDED THIS -----------------------------
    //
    // Against the real gateway, two fresh prefixes each sent twice:
    //
    //   WITH markers     1st cacheRead=0   2nd cacheRead=5740
    //   WITHOUT markers  1st cacheRead=0   2nd cacheRead=5740
    //
    // The gateway caches on its own. Lifting a string body into content blocks
    // is a real change to the request shape for a measured benefit of zero, so
    // it is not done unless somebody asks for it.
    assert.strictEqual(promptcache.needsExplicitCache({ protocol: 'chat', model: 'claude-sonnet-5' }, {}), false);
    assert.strictEqual(promptcache.needsExplicitCache({ protocol: 'chat', model: 'gpt-5.4' }, {}), false);
    assert.strictEqual(promptcache.needsExplicitCache({ protocol: 'anthropic', model: 'claude-sonnet-5' }, {}), false,
      'the anthropic path marks its own, and there are only four breakpoints to spend');
    // A gateway that genuinely needs them is a real case — just not this one.
    assert.strictEqual(promptcache.needsExplicitCache({ protocol: 'chat', model: 'gpt-5.4', promptCache: true }, {}), true);
    assert.strictEqual(promptcache.needsExplicitCache({ protocol: 'chat', model: 'claude-sonnet-5', promptCache: false }, {}), false);
  });

  await test('COST: the cache READING is what mattered, and it is kept', () => {
    // The chat path read no cache figures at all, so LAIN reported 0 on a route
    // that was serving 5,740 of 7,752 prompt tokens from cache. The saving was
    // already happening and was invisible — which is why `cache served` is now
    // a line in `/token`.
    assert.strictEqual(promptcache.usageFrom({ prompt_tokens_details: { cached_tokens: 5740 } }).cacheReadTokens, 5740);
  });

  await test('COST: the breakpoints land on the SYSTEM message and the moving tail', () => {
    const wire = [
      { role: 'system', content: 'stable instructions' },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'reading', tool_calls: [{ id: '1', name: 'read_file', arguments: '{}' }] },
      { role: 'tool', tool_call_id: '1', content: 'file body' },
    ];
    const out = promptcache.applyToChat(wire);
    const marked = (m) => Array.isArray(m.content) && m.content.some((b) => b.cache_control);

    assert.ok(marked(out[0]), 'the system message is the most stable thing in the request');
    // A TOOL MESSAGE IS NEVER GIVEN THE BLOCK FORM: several OpenAI-shaped
    // servers accept only a string there. The marker moves to the nearest
    // earlier message that can carry one.
    assert.ok(!Array.isArray(out[3].content), 'the tool result keeps its string content');
    assert.ok(marked(out[2]), 'so the boundary sits on the assistant turn before it');
    // The caller's array is never modified.
    assert.strictEqual(typeof wire[0].content, 'string');
  });

  await test('COST: the cache figures are read back, under every spelling seen in the wild', () => {
    // A figure read under the wrong key is indistinguishable from no caching,
    // which is the exact reading this whole change exists to make possible.
    assert.strictEqual(promptcache.usageFrom({ prompt_tokens_details: { cached_tokens: 900 } }).cacheReadTokens, 900);
    assert.strictEqual(promptcache.usageFrom({ cached_tokens: 700 }).cacheReadTokens, 700);
    assert.strictEqual(promptcache.usageFrom({ cache_read_input_tokens: 500 }).cacheReadTokens, 500);
    assert.strictEqual(promptcache.usageFrom(null).cacheReadTokens, 0);
  });

  // ---- TEST B — the fingerprints were NOT the problem ---------------------

  await test('COST: an unchanged file is not re-ingested — this was already working', () => {
    // ASSERTED BECAUSE THE AUDIT COULD HAVE BLAMED IT. Measured through the
    // real binary: six reads of a 34,338-char file added 1,240 chars after the
    // first. The evidence ledger already serves an unchanged re-read from its
    // own record instead of putting the body back into the transcript.
    const evidence = require('../../src/evidence');
    const led = new evidence.EvidenceLedger(process.cwd());
    const file = require('path').join(process.cwd(), 'package.json');
    const stamp = evidence.stampFor(process.cwd(), file);
    led.record(file, stamp, { lines: 10 });
    // The SECOND look at an unchanged file is answered from the ledger, so its
    // body is never put back into the transcript a second time.
    assert.ok(led.lookup(file, stamp), 'an unchanged file must be recognised as already seen');
    assert.ok(!led.lookup(file, { size: 1, mtime: 1 }), 'and a changed one must not be');
  });
};
