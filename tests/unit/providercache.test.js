'use strict';

/**
 * PROMPT CACHING MUST ACTUALLY COVER THE CONVERSATION, NOT JUST THE SYSTEM PROMPT.
 *
 * Found while tracing a report of LAIN v2 burning tokens 50-80x faster than
 * expected: `anthropicChat` placed its only `cache_control` breakpoint on the
 * system block, gated behind an arbitrary 6000-character threshold, and never
 * marked the messages array at all. The turn loop (turn.js) resends the FULL
 * accumulated message array on every step of a turn, and that array only ever
 * grows within a turn — so with no breakpoint on it, every step retransmitted
 * and paid full uncached price for everything every earlier step had already
 * sent. For an N-step tool-heavy turn the uncached total grows like
 * N(N+1)/2 instead of ~N, which is exactly the shape of the reported blowup.
 *
 * These tests drive `provider.chat` against a stubbed `fetch` and inspect the
 * ACTUAL JSON payload that would go on the wire — not the source code's
 * apparent intent — for consecutive requests shaped like consecutive steps of
 * one turn.
 */

const assert = require('assert');
const { test } = require('../helpers');
const provider = require('../../src/provider');

/** A minimal Anthropic SSE body: one message_start (with usage) + message_delta. */
function sseBody({ inputTokens = 5, outputTokens = 3, cacheRead = 0, cacheCreation = 0 } = {}) {
  const lines = [
    `data: ${JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: inputTokens, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation } },
    })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: outputTokens } })}\n\n`,
    'data: [DONE]\n\n',
  ];
  let i = 0;
  const encoder = new TextEncoder();
  return {
    getReader() {
      return {
        async read() {
          if (i >= lines.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(lines[i++]) };
        },
        async cancel() {},
      };
    },
  };
}

/** Stubs global.fetch to record every request body and answer with a canned SSE stream. */
function stubFetch(usageByCall = []) {
  const requests = [];
  let call = 0;
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    requests.push(JSON.parse(opts.body));
    const usage = usageByCall[call] || {};
    call += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: sseBody(usage),
    };
  };
  return { requests, restore: () => { global.fetch = original; } };
}

const PC = { protocol: 'anthropic', model: 'claude-test', maxTokens: 100, baseUrl: 'https://example.invalid', apiKey: 'k' };
const TOOLS = [
  { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
  { name: 'run_shell', description: 'run', parameters: { type: 'object', properties: {} } },
];

async function drain(gen) { const out = []; for await (const ev of gen) out.push(ev); return out; }

/** One user message plus `n` tool-call/tool-result step pairs — the shape turn.js accumulates. */
function messagesForSteps(n) {
  const msgs = [{ role: 'system', content: 'You are LAIN.' }, { role: 'user', content: 'do the thing' }];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: { path: `f${i}.txt` } }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: `contents of f${i}` });
  }
  return msgs;
}

function lastBlock(msg) {
  return Array.isArray(msg.content) ? msg.content[msg.content.length - 1] : msg.content;
}

module.exports = async function () {
  await test('CACHE: the last message of the wire carries a breakpoint', async () => {
    const { requests, restore } = stubFetch();
    try {
      await drain(provider.chat(PC, messagesForSteps(2), { tools: TOOLS }));
      const body = requests[0].messages;
      assert.ok(body.length > 0, 'a request with messages must actually send some');
      const last = lastBlock(body[body.length - 1]);
      assert.strictEqual(last.cache_control && last.cache_control.type, 'ephemeral',
        'the final message must carry the moving cache breakpoint');
    } finally { restore(); }
  });

  await test('CACHE: the breakpoint MOVES to the new last message on the next step', async () => {
    const { requests, restore } = stubFetch();
    try {
      // Step N: 2 tool rounds. Step N+1: turn.js would call again with the
      // array extended by the new step's tool call + result.
      await drain(provider.chat(PC, messagesForSteps(2), { tools: TOOLS }));
      await drain(provider.chat(PC, messagesForSteps(3), { tools: TOOLS }));
      const first = requests[0].messages;
      const second = requests[1].messages;
      assert.ok(second.length > first.length, 'the second request must be the longer, later step');
      // The first request's whole array must appear, byte-for-byte MINUS the
      // cache_control annotation, as an exact prefix of the second — that is
      // what makes the breakpoint a real cache hit rather than a coincidence.
      for (let i = 0; i < first.length - 1; i++) {
        assert.deepStrictEqual(second[i], first[i], `message ${i} must be unchanged between steps for caching to work`);
      }
      const secondLast = lastBlock(second[second.length - 1]);
      assert.strictEqual(secondLast.cache_control && secondLast.cache_control.type, 'ephemeral',
        'the breakpoint must have moved to the NEW last message, not stayed on the old one');
      // The OLD last message, now interior to the second request, must NOT
      // still be marked — a stray extra breakpoint burns one of Anthropic's
      // 4-per-request slots for nothing and is the kind of one-line regression
      // this guards against.
      const oldLastNowInterior = lastBlock(second[first.length - 1]);
      assert.ok(!oldLastNowInterior || !oldLastNowInterior.cache_control,
        'only ONE breakpoint — the new last message — may be marked; the previous one must not linger');
    } finally { restore(); }
  });

  await test('CACHE: a SHORT system prompt is still cached — no silent size threshold', async () => {
    const { requests, restore } = stubFetch();
    try {
      const msgs = [{ role: 'system', content: 'short' }, { role: 'user', content: 'hi' }];
      await drain(provider.chat(PC, msgs, {}));
      const sys = requests[0].system;
      assert.ok(Array.isArray(sys), 'system must be sent as a block array to carry cache_control');
      assert.strictEqual(sys[0].cache_control && sys[0].cache_control.type, 'ephemeral');
    } finally { restore(); }
  });

  await test('CACHE: the last tool definition carries the breakpoint, covering the whole tools block', async () => {
    const { requests, restore } = stubFetch();
    try {
      await drain(provider.chat(PC, messagesForSteps(1), { tools: TOOLS }));
      const tools = requests[0].tools;
      assert.strictEqual(tools.length, TOOLS.length);
      assert.ok(!tools[0].cache_control, 'only the LAST tool should carry the breakpoint');
      assert.strictEqual(tools[tools.length - 1].cache_control.type, 'ephemeral');
    } finally { restore(); }
  });

  await test('CACHE: marking the wire never mutates the caller\'s message objects', async () => {
    const { restore } = stubFetch();
    try {
      const msgs = messagesForSteps(2);
      const snapshot = JSON.parse(JSON.stringify(msgs));
      await drain(provider.chat(PC, msgs, { tools: TOOLS }));
      assert.deepStrictEqual(msgs, snapshot, 'the session\'s own message array must be untouched by cache annotation');
    } finally { restore(); }
  });

  await test('USAGE: cache_read and cache_creation tokens survive from the SSE event to the yielded usage', async () => {
    const { restore } = stubFetch([{ inputTokens: 12, outputTokens: 4, cacheRead: 900, cacheCreation: 50 }]);
    try {
      const events = await drain(provider.chat(PC, messagesForSteps(1), { tools: TOOLS }));
      const usage = events.find((e) => e.type === 'usage');
      assert.ok(usage, 'a usage event must be yielded');
      assert.strictEqual(usage.inputTokens, 12);
      assert.strictEqual(usage.outputTokens, 4);
      assert.strictEqual(usage.cacheReadTokens, 900);
      assert.strictEqual(usage.cacheCreationTokens, 50);
    } finally { restore(); }
  });
};
