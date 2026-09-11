'use strict';

/**
 * THE WIRE URL IS THE CONTRACT, NOT THE TABLE ROW.
 *
 * A provider row can look right in /api's picker and still post somewhere
 * else: the row lives in providers.js and the sender's URL is built in
 * provider.js, and nothing compared them. These tests stub `fetch` and read
 * the URL the sender ACTUALLY posts to — the same approach providercache
 * takes with request bodies — so the row and the wire cannot drift apart
 * silently.
 *
 * b.ai and z.ai are both here because both were named by the operator with a
 * full URL. The only honest proof that `/api` offers what was asked for is the
 * request the picker's choice produces on the wire.
 */

const assert = require('assert');
const { test } = require('../helpers');
const provider = require('../../src/provider');
const providers = require('../../src/providers');

/** A minimal OpenAI-chat SSE body: one content chunk, then [DONE]. */
function chatSSE() {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
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

/**
 * Stubs global.fetch to RECORD THE URL. providercache's stub records request
 * bodies; here the URL is the whole point, so the stub keeps it.
 */
function recordingFetch() {
  const urls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, body: chatSSE() };
  };
  return { urls, restore: () => { global.fetch = original; } };
}

async function drain(gen) { const out = []; for await (const ev of gen) out.push(ev); return out; }

/** One request through the real sender, with the endpoint taken from the row /api offers. */
async function wireUrlFor(id) {
  const row = providers.byId(id);
  assert.ok(row, `${id} is in the table /api offers`);
  assert.strictEqual(row.protocol, 'chat', `${id} speaks the OpenAI chat shape`);
  const { urls, restore } = recordingFetch();
  try {
    const pc = { protocol: row.protocol, model: 'wire-test', maxTokens: 64, baseUrl: row.baseUrl, apiKey: 'test-key' };
    await drain(provider.chat(pc, [{ role: 'user', content: 'hi' }], {}));
    return urls;
  } finally { restore(); }
}

module.exports = async function () {
  await test('ENDPOINTS: b.ai posts to https://api.b.ai/v1/chat/completions', async () => {
    assert.deepStrictEqual(await wireUrlFor('bai'), ['https://api.b.ai/v1/chat/completions']);
  });

  await test('ENDPOINTS: z.ai posts to https://api.z.ai/api/paas/v4/chat/completions', async () => {
    assert.deepStrictEqual(await wireUrlFor('zai'), ['https://api.z.ai/api/paas/v4/chat/completions']);
  });

  await test('ENDPOINTS: the picker and the sender read the SAME row — no second table to drift', () => {
    // `choices` builds /api's provider picker; `byId` is what the wire URL is
    // resolved through here. If the picker offered a route the sender could
    // not build, the user would pick b.ai and reach whatever was left in the
    // second table.
    const offered = providers.choices({}).map((p) => p.id);
    for (const id of ['bai', 'zai']) {
      assert.ok(offered.includes(id), `${id} is offered by /api`);
    }
  });
};
