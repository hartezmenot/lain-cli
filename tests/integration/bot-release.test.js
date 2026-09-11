'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const { Gateway } = require('../../src/bot/gateway');
const { Runtime } = require('../../src/bot/runtime');
const { Registry, sessionKey, eventKey } = require('../../src/bot/contract');
const { WhatsApp, caps: whatsappCaps } = require('../../src/bot/whatsapp');
const service = require('../../src/bot/service');
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-release-integration-'));
const source = changes => ({ platform: 'discord', accountId: 'default', chatId: 'chat', senderId: 'alice', messageId: 'm', text: 'hello', ...changes });
const drain = async g => { while (g.tasks.size) await Promise.all([...g.tasks]); await tick(); await Promise.all([...g.delivery.chains.values()]); };
function registry(sent, platforms = ['telegram', 'discord', 'whatsapp']) {
  const r = new Registry();
  for (const platform of platforms) r.register({ version: 1, platform, maxLength: 4096, buttons: true }, () => ({
    state: 'listening', identity: `${platform}-fixture`, start: async () => {}, stop: async () => {},
    action: async a => { sent.push(a); return { messageId: String(sent.length) }; },
  }));
  return r;
}
const settings = (maxConcurrent = 2) => ({ bot: { maxConcurrent, platforms: Object.fromEntries(['telegram', 'discord', 'whatsapp'].map(p => [p, { enabled: true, allowUsers: ['alice', 'bob'] }])) } });
module.exports = async () => {
  await test('BOT RELEASE: signed WhatsApp retries dedupe through real listener and persisted gateway restart', async () => {
    const dir = temporary(), sent = [], runs = [];
    const vars = ['LAIN_WHATSAPP_TOKEN', 'LAIN_WHATSAPP_APP_SECRET', 'LAIN_WHATSAPP_VERIFY_TOKEN'];
    const prior = Object.fromEntries(vars.map(k => [k, process.env[k]])); for (const k of vars) process.env[k] = `fixture-release-${k}`;
    let adapter, gateway;
    const r = new Registry().register(whatsappCaps, cfg => (adapter = new WhatsApp(cfg, { http: { request: async (route, opts) => { sent.push({ route, opts }); return { messages: [{ id: `outbound-${sent.length}` }] }; } } })));
    const cfg = { bot: { platforms: { whatsapp: { enabled: true, allowUsers: ['6731234567'], phoneNumberId: '123456', businessAccountId: '987654', apiVersion: 'v25.0', port: 0 } } } };
    const opts = { dir, registry: r, cfg, runtimeFactory: ({ sessionId }) => ({ id: sessionId || 'stable-wa-session', run: async e => { runs.push(e); return 'reply'; }, stop() {}, close: async () => {} }) };
    const payload = (changes = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: changes.account || '987654', changes: [{ field: 'messages', value: { metadata: { phone_number_id: changes.phone || '123456' }, messages: [{ id: changes.id || 'wamid.one', from: '6731234567', type: 'text', timestamp: String(Math.floor(Date.now() / 1000)), text: { body: 'hello' } }] } }] }] });
    const post = async (value, bad = false) => {
      const body = JSON.stringify(value), signature = crypto.createHmac('sha256', process.env.LAIN_WHATSAPP_APP_SECRET).update(body).digest('hex');
      const response = await fetch(`http://127.0.0.1:${adapter.server.address().port}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${bad ? '0'.repeat(64) : signature}` } });
      await response.text(); return response.status;
    };
    try {
      gateway = new Gateway(opts); await gateway.start();
      assert.equal(await post(payload(), true), 403);
      assert.equal(await post(payload({ account: '000000' })), 200); assert.equal(await post(payload({ phone: '000000' })), 200); assert.equal(runs.length, 0);
      assert.ok((await Promise.all(Array.from({ length: 12 }, () => post(payload())))).every(status => status === 200));
      await drain(gateway); assert.equal(runs.length, 1); assert.equal(sent.length, 1);
      const originalId = gateway.store.data.sessions[sessionKey(runs[0])];
      assert.deepEqual(adapter.diagnostics(), { localListener: true, publicWebhookVerified: false });
      // A fresh signed message keeps this sender's response window open for an older job.
      await adapter.action({ type: 'send', target: { ...runs[0], timestamp: 1 }, text: 'older job completed' }); assert.equal(sent.length, 2);
      await gateway.stop(); gateway = new Gateway(opts); await gateway.start();
      assert.equal(await post(payload()), 200); await drain(gateway); assert.equal(runs.length, 1); assert.equal(sent.length, 2);
      await post(payload({ id: 'wamid.two' })); await drain(gateway);
      assert.equal(runs.length, 2); assert.equal(gateway.store.data.sessions[sessionKey(runs[1])], originalId);
      assert.equal(adapter.diagnostics().publicWebhookVerified, false);
    } finally { await gateway?.stop(); for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v; fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('BOT RELEASE: independent platforms and same-platform chats isolate prompts, steer, stop and queued turns', async () => {
    const dir = temporary(), sent = [], started = [], steered = [], stopped = [], release = new Map(), asks = new Map(); let nextId = 0;
    const g = new Gateway({ dir, registry: registry(sent), cfg: settings(4), runtimeFactory: ({ ask }) => {
      const id = `runtime-${++nextId}`; let owner;
      return { id, stop() { if (owner) { stopped.push(sessionKey(owner)); release.get(sessionKey(owner))?.resolve(); } }, close: async () => {},
        steer(text) { steered.push({ owner: sessionKey(owner), text }); },
        async run(e, notify) {
          owner = e; started.push(e); const key = sessionKey(e);
          if (e.text === 'ask') { const answer = await ask(e, { question: 'Guarded action?', options: ['Allow once', 'Deny'] }); asks.set(key, answer); return String(answer); }
          const wait = defer(); release.set(key, wait); await wait.promise;
          await notify(`Background ${key}`, `background-${key}`); return `Finished ${key}`;
        },
      };
    } });
    const events = [source({ platform: 'telegram' }), source(), source({ platform: 'whatsapp' }), source({ chatId: 'other-chat' })];
    try {
      await g.start(); for (const e of events) await g.receive(e); await tick(); assert.equal(started.length, 4);
      await g.receive({ ...events[1], messageId: 'steer', text: '/steer only test API' }); assert.deepEqual(steered, [{ owner: sessionKey(events[1]), text: 'only test API' }]);
      await g.receive({ ...events[1], messageId: 'queued', text: 'discard on stop' });
      await g.receive({ ...events[1], messageId: 'stop', text: 'stop' }); await tick();
      assert.deepEqual(stopped, [sessionKey(events[1])]); assert.equal(g.store.data.inbox[eventKey({ ...events[1], messageId: 'queued' })].state, 'done');
      for (const e of events) release.get(sessionKey(e))?.resolve(); await drain(g);
      for (const e of events) assert.ok(sent.some(a => a.text === `Background ${sessionKey(e)}` && sessionKey(a.target) === sessionKey(e)));
      const askEvents = events.slice(0, 3).map(e => ({ ...e, messageId: 'ask', text: 'ask' }));
      for (const e of askEvents) await g.receive(e); await tick();
      for (const e of askEvents) {
        const prompt = sent.find(a => a.type === 'prompt' && sessionKey(a.target) === sessionKey(e)); assert.ok(prompt);
        await g.receive({ ...e, chatId: 'wrong-chat', messageId: 'wrong-response', text: '', promptResponse: { id: prompt.prompt.id, value: '1' } });
        assert.ok(!asks.has(sessionKey(e)));
        await g.receive({ ...e, messageId: 'response', text: '', promptResponse: { id: prompt.prompt.id, value: e.platform === 'discord' ? '2' : '1' } });
        await g.receive({ ...e, messageId: 'replay', text: '', promptResponse: { id: prompt.prompt.id, value: '1' } });
      }
      await drain(g); assert.equal(asks.get(sessionKey(askEvents[1])), 'Deny'); assert.equal(asks.get(sessionKey(askEvents[0])), 'Allow once'); assert.equal(asks.size, 3);
    } finally { for (const wait of release.values()) wait.resolve(); await g.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('BOT RELEASE: per-chat and total overload stay bounded while stop remains reachable and retry is admitted', async () => {
    const dir = temporary(), sent = [], blocking = defer(); let held = true, id = 0;
    const g = new Gateway({ dir, registry: registry(sent), cfg: settings(1), runtimeFactory: () => ({ id: `capacity-${++id}`, stop() { held = false; blocking.resolve(); }, close: async () => {}, run: async () => { if (held) await blocking.promise; return 'done'; } }) });
    try {
      await g.start(); await g.receive(source());
      for (let n = 0; n < 8; n++) assert.equal((await g.receive(source({ messageId: `queued-${n}` }))).accepted, true);
      const rejected = source({ messageId: 'retry-later' }); assert.equal((await g.receive(rejected)).busy, true); assert.equal(g.store.data.inbox[eventKey(rejected)], undefined);
      for (let n = 0; n < 120; n++) assert.equal((await g.receive(source({ chatId: `chat-${n}`, messageId: 'one' }))).accepted, true);
      assert.equal(g.status().queued, 128); assert.equal((await g.receive(source({ chatId: 'overflow' }))).busy, true);
      assert.equal((await g.receive(source({ messageId: 'control', text: '/stop' }))).accepted, true);
      await drain(g); assert.equal(g.status().queued, 0); assert.equal((await g.receive(rejected)).accepted, true); await drain(g);
      assert.equal(g.store.data.inbox[eventKey(rejected)].state, 'done');
    } finally { blocking.resolve(); held = false; await g.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('BOT RELEASE: repeated service lifecycle owns one socket and preserves dedupe, receipts and stale-prompt rejection', async () => {
    const dir = temporary(), sent = []; let running, creates = 0, stops = 0;
    const r = new Registry().register({ version: 1, platform: 'discord', maxLength: 2000 }, () => ({
      state: 'listening', identity: 'fixture-identity', start: async () => { creates++; }, stop: async () => { stops++; }, action: async a => { sent.push(a); return { messageId: String(sent.length) }; },
    }));
    const opts = { dir, registry: r, cfg: { bot: { platforms: { discord: { enabled: true, allowUsers: ['alice'] } } } }, runtimeFactory: ({ sessionId }) => ({ id: sessionId || 'persisted-session', run: async () => 'one response', stop() {}, close: async () => {} }) };
    try {
      for (let n = 0; n < 5; n++) {
        running = await service.start(opts); assert.equal((await service.control('status', dir)).state, 'running'); await assert.rejects(() => service.start(opts));
        const accepted = await running.gateway.receive(source()); assert.equal(accepted.duplicate, n ? true : undefined); await drain(running.gateway);
        assert.equal(running.gateway.store.data.sessions[sessionKey(source())], 'persisted-session');
        await running.gateway.receive(source({ messageId: `old-callback-${n}`, text: '', promptResponse: { id: '0123456789abcdef01234567', value: '1' } }));
        await service.control('stop', dir); await running.done; assert.equal(fs.existsSync(service.location(dir).file), false);
      }
      assert.equal(sent.length, 1); assert.equal(creates, 5); assert.equal(stops, 5); assert.equal((await service.control('status', dir)).state, 'stopped');
    } finally { await running?.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('BOT RELEASE: real runtime background completion and cancellation preserve origin while remote ps stays session-scoped', async () => {
    const dir = temporary(), sent = [], previous = Object.fromEntries(['LAIN_HOME', 'LAIN_PROVIDER', 'LAIN_MOCK_SCRIPT'].map(k => [k, process.env[k]]));
    process.env.LAIN_HOME = path.join(dir, 'supervisor'); process.env.LAIN_PROVIDER = 'mock'; process.env.LAIN_MOCK_SCRIPT = path.join(dir, 'model.json');
    const script = steps => { fs.writeFileSync(process.env.LAIN_MOCK_SCRIPT, JSON.stringify(steps)); require('../../src/mockprovider')._reset(); };
    let g;
    try {
      script([{ text: 'smoke 534/0', delayMs: 100 }]);
      g = new Gateway({ dir: path.join(dir, 'bot'), cwd: dir, cfg: { ...settings(), model: 'mock-model', trustedPaths: [] }, registry: registry(sent) }); await g.start();
      const origin = source({ text: '/bg run smoke tests' }); await g.receive(origin); await drain(g);
      const runtime = g.runtimes.get(sessionKey(origin)); assert.ok(runtime instanceof Runtime);
      const job = runtime.app.jobs.all()[0]; assert.ok(job);
      await g.receive(source({ chatId: 'other-chat', messageId: 'other-ps', text: '/ps' })); await drain(g);
      await g.receive(source({ messageId: 'list', text: '/bg' })); await drain(g);
      await job.wait(); await tick(); await Promise.all([...g.delivery.chains.values()]);
      const notice = sent.find(a => a.text?.includes('smoke 534/0')); assert.ok(notice); assert.equal(sessionKey(notice.target), sessionKey(origin));
      script([{ text: 'should be cancelled', delayMs: 30000 }]);
      await g.receive(source({ messageId: 'cancel-job', text: '/bg work until cancelled' })); await drain(g);
      const cancellable = runtime.app.jobs.running()[0]; assert.ok(cancellable);
      await g.receive(source({ chatId: 'other-chat', messageId: 'foreign-cancel', text: `/cancel ${cancellable.id}` })); assert.equal(cancellable.done, false);
      await g.receive(source({ messageId: 'cancel', text: `/bg stop ${cancellable.id}` })); await cancellable.wait(); await tick(); await tick(); await Promise.all([...g.delivery.chains.values()]);
      assert.ok(sent.some(a => a.text?.includes('CANCELLED') && sessionKey(a.target) === sessionKey(origin)));
      const foreign = g.runtimes.get(sessionKey(source({ chatId: 'other-chat' }))); assert.equal(foreign.app.jobs.all().length, 0);
      assert.ok(sent.some(a => a.target.chatId === 'other-chat' && a.text === 'This conversation owns no processes.'));
    } finally {
      await g?.stop(); await tick(); await require('../../src/supervisor').cleanupOwned().catch(() => {});
      for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
};
