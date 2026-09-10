'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const { Discord } = require('../../src/bot/discord');
const { WhatsApp, normalize } = require('../../src/bot/whatsapp');
const { Http } = require('../../src/bot/http');
const { Prompts } = require('../../src/bot/prompts');
const { event } = require('../../src/bot/contract');
const { Store } = require('../../src/bot/store');
const { Delivery } = require('../../src/bot/delivery');
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const source = changes => event({ platform: 'discord', accountId: 'default', senderId: 'alice', chatId: 'chat', messageId: 'm', text: 'hello', ...changes });
class Socket {
  constructor() { this.readyState = 1; this.listeners = {}; this.sent = []; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close(code = 1000) { this.readyState = 3; this.listeners.close?.({ code }); }
}
async function discord(run, request) {
  const previous = process.env.LAIN_DISCORD_TOKEN; process.env.LAIN_DISCORD_TOKEN = 'fixture-release-discord';
  const adapter = new Discord({}, { WebSocket: Socket, http: { request: async (route, opts) => {
    if (route === '/users/@me') return { id: '77' };
    if (route === '/gateway/bot') return { url: 'wss://gateway.discord.gg', shards: 1 };
    return request ? request(route, opts) : { id: 'sent' };
  } } });
  try { await run(adapter); }
  finally { await adapter.stop(); if (previous === undefined) delete process.env.LAIN_DISCORD_TOKEN; else process.env.LAIN_DISCORD_TOKEN = previous; }
}
const ready = { op: 0, t: 'READY', s: 1, d: { session_id: 'private-session', resume_gateway_url: 'wss://gateway.discord.gg' } };
const message = s => ({ op: 0, t: 'MESSAGE_CREATE', s, d: { id: `m${s}`, channel_id: 'chat', author: { id: 'alice' }, content: 'hello' } });
module.exports = async () => {
  for (const state of ['uncertain', 'failed', 'delivered']) await test(`BOT RELEASE: early callback waits for ${state} prompt delivery and cannot replay consent`, async () => {
    const transport = defer(); let prompt;
    const prompts = new Prompts({ sendMessage: async (_target, _text, options) => { prompt = options.prompt; return transport.promise; } });
    let resolved = false;
    const answer = prompts.ask(source(), { question: 'Allow mutation?', options: ['Allow once', 'Deny'] }).then(value => { resolved = true; return value; });
    const response = source({ promptResponse: { id: prompt.id, value: '1' } });
    assert.ok(!prompts.resolve(source({ chatId: 'wrong-chat', promptResponse: response.promptResponse })));
    assert.ok(!prompts.resolve(source({ senderId: 'wrong-sender', promptResponse: response.promptResponse })));
    assert.ok(prompts.resolve(response)); assert.ok(!prompts.resolve(response)); await tick(); assert.equal(resolved, false);
    transport.resolve([{ state }]); assert.equal(await answer, state === 'delivered' ? 'Allow once' : null);
    assert.ok(!prompts.resolve(response)); assert.equal(prompts.pending.size, 0);
  });
  await test('BOT RELEASE: cancellation or expiry while prompt ACK is outstanding always denies', async () => {
    for (const cancel of [true, false]) {
      const transport = defer(); let prompt; const controller = new AbortController();
      const prompts = new Prompts({ sendMessage: async (_target, _text, opts) => { prompt = opts.prompt; return transport.promise; } }, 10);
      const answer = prompts.ask(source(), { options: ['Allow once', 'Deny'] }, controller.signal);
      prompts.resolve(source({ promptResponse: { id: prompt.id, value: '1' } }));
      if (cancel) controller.abort(); else await new Promise(resolve => setTimeout(resolve, 15));
      transport.resolve([{ state: 'delivered' }]); assert.equal(await answer, null); assert.equal(prompts.pending.size, 0);
    }
  });
  await test('BOT RELEASE: failed Discord ingress cannot commit a later queued dispatch before resume', async () => {
    await discord(async a => {
      const received = []; let fail = true;
      await a.start(async e => { received.push(e.messageId); if (fail) throw new Error('fixture store unavailable'); return { accepted: true }; });
      await a.packet(ready);
      await Promise.allSettled([a.packet(message(2)), a.packet(message(3))]);
      assert.deepEqual(received, ['m2']); assert.equal(a.committedSeq, 1); assert.equal(a.pendingIngress, 0);
      clearTimeout(a.reconnectTimer); a.connect(); await a.packet({ op: 10, d: { heartbeat_interval: 45000 } });
      assert.equal(a.ws.sent.at(-1).op, 6); assert.equal(a.ws.sent.at(-1).d.seq, 1);
      fail = false; await a.packet(message(2)); await a.packet(message(3)); assert.equal(a.committedSeq, 3);
      await a.packet({ op: 9, d: false }); assert.equal(a.committedSeq, null);
    });
  });
  await test('BOT RELEASE: duplicate component dispatch acknowledges once and survives lost callback ACK', async () => {
    for (const lostAck of [false, true]) {
      let acknowledgements = 0, receives = 0;
      await discord(async a => {
        await a.start(async () => { receives++; return { accepted: true, duplicate: receives > 1 }; });
        const packet = { op: 0, t: 'INTERACTION_CREATE', s: 2, d: { type: 3, id: 'callback', token: 'secret-callback-token', channel_id: 'chat', user: { id: 'alice' }, data: { custom_id: 'lain:0123456789abcdef01234567:1' } } };
        await a.packet(packet); await a.packet({ ...packet, s: 3 });
        assert.equal(acknowledgements, 1); assert.equal(receives, 2); assert.equal(a.committedSeq, 3);
      }, async () => { acknowledgements++; if (lostAck) throw { status: 400, code: 40060 }; return {}; });
    }
  });
  await test('BOT RELEASE: Discord health requires a fresh heartbeat ACK and drops after disconnect', async () => {
    await discord(async a => {
      await a.start(async () => ({})); await a.packet(ready);
      await a.packet({ op: 10, d: { heartbeat_interval: 45000 } });
      assert.equal(a.diagnostics().heartbeatHealthy, false); await a.packet({ op: 11 });
      assert.deepEqual(a.diagnostics(), { gatewayReachable: true, activeSession: true, heartbeatHealthy: true, intents: 37377 });
      a.lastAck -= 90001; assert.equal(a.diagnostics().heartbeatHealthy, false);
      a.ws.close(1006); assert.equal(a.diagnostics().activeSession, false); assert.equal(a.diagnostics().gatewayReachable, false);
      assert.ok(!JSON.stringify(a.diagnostics()).includes('private-session'));
    });
  });
  await test('BOT RELEASE: stopping Discord during authentication prevents a late gateway socket', async () => {
    const auth = defer(); const prior = process.env.LAIN_DISCORD_TOKEN; process.env.LAIN_DISCORD_TOKEN = 'fixture-release-discord';
    let connections = 0;
    const a = new Discord({}, { WebSocket: class extends Socket { constructor() { super(); connections++; } }, http: { request: async route => {
      await auth.promise; return route === '/users/@me' ? { id: '77' } : { url: 'wss://gateway.discord.gg', shards: 1 };
    } } });
    try {
      const start = a.start(async () => ({})); await a.stop(); auth.resolve(); await start;
      assert.equal(connections, 0); assert.equal(a.state, 'stopped');
      await a.start(async () => ({})); assert.equal(connections, 1); await a.stop(); assert.equal(a.diagnostics().activeSession, false);
    } finally { auth.resolve(); await a.stop(); if (prior === undefined) delete process.env.LAIN_DISCORD_TOKEN; else process.env.LAIN_DISCORD_TOKEN = prior; }
  });
  await test('BOT RELEASE: platform HTTP bounds errors, classifies auth, and never surfaces response secrets', async () => {
    for (const [status, body, expected] of [[401, {}, true], [403, {}, true], [400, { error: { code: 190, message: 'private-token' } }, true], [400, { code: 40060, message: 'private-token' }, false]]) {
      const h = new Http({ base: 'https://fixture.invalid', fetch: async () => new Response(JSON.stringify(body), { status }) });
      await assert.rejects(() => h.request('/me'), e => { assert.equal(e.authFailed, expected); assert.ok(!String(e).includes('private-token')); return true; });
    }
    const broken = new Http({ base: 'https://fixture.invalid', fetch: async () => ({ ok: true, body: { async *[Symbol.asyncIterator]() { throw new Error('private-url-token'); } } }) });
    await assert.rejects(() => broken.request('/me'), e => e.message === 'platform acknowledgement unavailable');
  });
  await test('BOT RELEASE: API 429 retry is bounded and ambiguous acceptance survives receipt restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-release-rate-')); let requests = 0;
    try {
      const http = new Http({ base: 'https://fixture.invalid', fetch: async () => { requests++; return new Response('{"retry_after":0.001}', { status: 429 }); } });
      const adapter = { caps: require('../../src/bot/discord').caps, action: () => http.request('/messages') };
      const store = new Store(dir), delivery = new Delivery(store, () => adapter);
      let rows = await delivery.sendMessage(source(), 'rate limited', { id: 'limited' });
      assert.equal(requests, 3); assert.equal(rows[0].state, 'failed');
      adapter.action = async () => { requests++; throw new Error('timeout after remote accept'); };
      rows = await delivery.sendMessage(source(), 'maybe accepted', { id: 'uncertain' }); assert.equal(rows[0].state, 'uncertain');
      const restarted = new Delivery(new Store(dir), () => adapter); await restarted.recover(() => true);
      await restarted.sendMessage(source(), 'maybe accepted', { id: 'uncertain' }); assert.equal(requests, 4);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('BOT RELEASE: WhatsApp matches both account identifiers and rejects forged response-window timestamps', async () => {
    const payload = timestamp => ({ object: 'whatsapp_business_account', entry: [{ id: '987654', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '123456' }, messages: [{ id: 'inbound', from: '6731234567', type: 'text', timestamp, text: { body: 'hello' } }] } }] }] });
    const settings = { accountId: 'default', phoneNumberId: '123456', businessAccountId: '987654' };
    assert.equal(normalize(payload(Date.now() / 1000), settings).length, 1);
    assert.equal(normalize(payload(Date.now() / 1000), { ...settings, businessAccountId: 'wrong' }).length, 0);
    assert.equal(normalize(payload(Date.now() / 1000), { ...settings, phoneNumberId: 'wrong' }).length, 0);
    for (const timestamp of ['NaN', null, 'Infinity', (Date.now() + 3600000) / 1000]) assert.equal(normalize(payload(timestamp), settings).length, 0);
    const a = new WhatsApp({}, { http: { request: async () => { throw new Error('must not reach API'); } } });
    await assert.rejects(() => a.action({ type: 'send', text: 'hello', target: { chatId: 'chat', timestamp: Infinity } }), /window expired/);
    assert.deepEqual(a.diagnostics(), { localListener: false, publicWebhookVerified: false });
  });
};
