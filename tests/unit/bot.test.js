'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const { event, sessionKey, authorized, Registry, eventKey } = require('../../src/bot/contract');
const { Store } = require('../../src/bot/store');
const { Delivery, split } = require('../../src/bot/delivery');
const { Prompts } = require('../../src/bot/prompts');
const { Gateway } = require('../../src/bot/gateway');
const { normalize: discordEvent } = require('../../src/bot/discord');
const { Telegram } = require('../../src/bot/telegram');
const tick = () => new Promise(r => setImmediate(r));
const source = (changes = {}) => ({ platform: 'fixture', accountId: 'default', chatId: 'chat', senderId: 'alice', messageId: '1', text: 'hello', ...changes });
const caps = { version: 1, platform: 'fixture', maxLength: 2000, typing: true, buttons: true };
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-unit-')); }
module.exports = async () => {
  await test('BOT: source identity isolates every platform/account/chat/thread/sender dimension', () => {
    const e = event(source()), keys = new Set([sessionKey(e)]);
    for (const k of ['platform', 'accountId', 'chatId', 'threadId', 'senderId']) keys.add(sessionKey(event(source({ [k]: 'another' }))));
    assert.equal(keys.size, 6); assert.equal(sessionKey(e), sessionKey(event(source({ messageId: '2' }))));
    assert.throws(() => event(source({ senderId: '' }))); assert.throws(() => event(source({ senderId: 9007199254740993 })));
  });
  await test('BOT: normalize drops raw payloads/secrets and bounds quote/attachment metadata', () => {
    const redact = require('../../src/redact'); const token = 'fixture-super-secret-token-12345'; redact.register(token);
    const e = event(source({ text: token, raw_message: { token }, replyText: 'q'.repeat(5000), metadata: { token }, attachments: [{ id: 'a', url: 'https://secret', token, name: token }] }));
    assert.ok(!JSON.stringify(e).includes(token)); assert.equal(e.replyText.length, 1000);
    assert.equal(e.raw_message, undefined); assert.equal(e.attachments[0].url, undefined);
  });
  await test('BOT: deny unknown identities, wildcard names and ambient channels before a turn', () => {
    assert.ok(!authorized(event(source()), {}));
    assert.ok(!authorized(event(source()), { allowUsers: ['*', 'Alice'] }));
    const policy = { allowUsers: ['alice'], allowGuilds: ['g'], allowChannels: ['c'] };
    const e = event(source({ kind: 'group', guildId: 'g', channelId: 'c' }));
    assert.ok(!authorized(e, policy)); assert.ok(authorized({ ...e, addressed: true }, policy));
    assert.ok(!authorized({ ...e, addressed: true, senderId: 'mallory' }, policy));
    assert.ok(!authorized({ ...e, addressed: true, guildId: 'elsewhere' }, policy));
    assert.ok(!authorized({ ...e, addressed: true, bot: true }, policy));
    assert.ok(authorized(event(source({ platform: 'telegram', paired: true })), {}));
    assert.ok(!authorized(event(source({ platform: 'fixture', paired: true })), {}));
  });
  await test('BOT: fenced Unicode chunks fit each adapter limit without dropped content', () => {
    for (const max of [128, 2000, 4096]) {
      const chunks = split('```js\n' + 'const value = "🙂";\n'.repeat(500) + '```', max, true);
      assert.ok(chunks.length > 1); assert.ok(chunks.every(p => p.length <= max));
      assert.ok(chunks.every(p => (p.match(/```/g) || []).length % 2 === 0));
      assert.equal(chunks.join('').split('🙂').length - 1, 500);
    }
  });
  await test('BOT: delivery retries only explicit rate limits and never repeats ambiguous sends', async () => {
    const dir = temp(); try {
      const store = new Store(dir); let attempts = 0; const waits = [];
      const adapter = { caps, action: async () => { if (++attempts === 1) throw { status: 429, definitive: true, retryAfter: 2 }; return { messageId: 'sent' }; } };
      const d = new Delivery(store, () => adapter, { sleep: async n => waits.push(n) });
      let rows = await d.sendMessage(source(), 'hello', { id: 'one' }); assert.equal(rows[0].state, 'delivered'); assert.deepEqual(waits, [2000]);
      await d.sendMessage(source(), 'hello', { id: 'one' }); assert.equal(attempts, 2);
      adapter.action = async () => { attempts++; throw new Error('timeout'); };
      rows = await d.sendMessage(source(), 'hello', { id: 'two' }); assert.equal(rows[0].state, 'uncertain');
      const restart = new Delivery(new Store(dir), () => adapter);
      await restart.sendMessage(source(), 'hello', { id: 'two' }); assert.equal(attempts, 3);
      assert.ok(!Object.values(store.data.deliveries)[0].target.text);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('BOT: prompt responses bind sender, session, request and choice; expiry/cancel deny', async () => {
    let sent; const prompts = new Prompts({ sendMessage: async (_e, _t, opts) => { sent = opts.prompt; return [{ state: 'delivered' }]; } }, 10000);
    const e = event(source()), ask = prompts.ask(e, { question: 'Allow?', options: ['Yes', 'No'] }); await tick();
    assert.ok(!prompts.resolve(event(source({ senderId: 'mallory', promptResponse: { id: sent.id, value: '1' } }))));
    assert.ok(!prompts.resolve(event(source({ threadId: 'other', promptResponse: { id: sent.id, value: '1' } }))));
    assert.ok(!prompts.resolve(event(source({ promptResponse: { id: sent.id, value: '3' } }))));
    assert.ok(prompts.resolve(event(source({ promptResponse: { id: sent.id, value: '2' } })))); assert.equal(await ask, 'No');
    assert.ok(!prompts.resolve(event(source({ promptResponse: { id: sent.id, value: '1' } }))));
    prompts.ttl = 10; assert.equal(await prompts.ask(e, { question: 'Expired?' }), null);
    const controller = new AbortController(); const cancelled = prompts.ask(e, { question: 'Cancel?' }, controller.signal); controller.abort(); assert.equal(await cancelled, null);
  });
  await test('BOT: gateway denies before runtime, serializes one source and admits other chats', async () => {
    const dir = temp(), started = [], released = [], sent = []; let created = 0;
    const registry = new Registry().register(caps, () => ({ state: 'listening', start: async () => {}, stop: async () => {}, action: async a => { sent.push(a); return { messageId: String(sent.length) }; } }));
    const cfg = { bot: { maxConcurrent: 2, platforms: { fixture: { enabled: true, allowUsers: ['alice'] } } } };
    const gateway = new Gateway({ dir, cfg, registry, runtimeFactory: () => ({ id: `s${++created}`, stop() { for (const r of released.splice(0)) r(); }, steer() {}, close: async () => {},
      async run(e) { started.push(e.messageId); await new Promise(r => released.push(r)); return 'result'; } }) });
    try {
      await gateway.start(); assert.ok(!(await gateway.receive(source({ senderId: 'mallory' }))).accepted); assert.equal(created, 0);
      await gateway.receive(source()); await gateway.receive(source({ messageId: '2' })); await gateway.receive(source({ chatId: 'other', messageId: '3' }));
      await tick(); assert.deepEqual(started, ['1', '3']);
      assert.ok((await gateway.receive(source())).duplicate);
      released.shift()(); await tick(); await tick(); assert.deepEqual(started, ['1', '3', '2']);
      await gateway.receive(source({ messageId: '4', text: '/stop' }));
      await Promise.allSettled([...gateway.tasks]); assert.equal(started.length, 3);
      assert.ok(sent.some(a => a.type === 'typingStart')); assert.ok(sent.some(a => a.type === 'typingStop'));
      assert.equal(Object.keys(gateway.store.data.sessions).length, 2);
    } finally { await gateway.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('BOT: restart preserves exact binding and marks interrupted turns without replay', () => {
    const dir = temp(); try {
      const s = new Store(dir), e = event(source()); s.bind(sessionKey(e), () => 'exact-session'); s.admit(eventKey(e), e); s.settle(eventKey(e), 'running');
      const again = new Store(dir); assert.equal(again.bind(sessionKey(e), () => 'WRONG'), 'exact-session');
      assert.equal(again.data.inbox[eventKey(e)].state, 'interrupted'); assert.equal(again.admit(eventKey(e), e), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('BOT: remote filesystem mutations use existing trust and require a real answer', async () => {
    const cwd = process.cwd(), app = { cfg: { trustedPaths: [] }, session: { cwd }, ui: { enabled: false }, interaction: { ask: async () => null } };
    assert.ok(!(await require('../../src/gate').check('shell', { command: 'irrelevant' }, { app, cwd }, { mutates: true })).ok);
    app.interaction.ask = async () => 'Allow just this one';
    assert.ok((await require('../../src/gate').check('shell', {}, { app, cwd }, { mutates: true })).ok);
    assert.deepEqual(app.cfg.trustedPaths, []);
  });
  await test('BOT: Discord normalization scopes threads and excludes interaction credentials', () => {
    const e = event(discordEvent({ id: 'm', channel_id: 't', guild_id: 'g', author: { id: 'alice' }, content: '<@77> hi', mentions: [{ id: '77' }], token: 'never-forward', referenced_message: { content: 'quote', author: { id: '77' } } },
      { accountId: 'default', botId: '77', channel: { type: 11, parent_id: 'c' } }));
    assert.equal(e.chatId, 'c'); assert.equal(e.threadId, 't'); assert.equal(e.channelId, 'c'); assert.equal(e.text, 'hi'); assert.equal(e.replyText, 'quote');
    assert.ok(!JSON.stringify(e).includes('never-forward'));
  });
  await test('BOT: Telegram reuses supervisor mailbox, acknowledges once and stops lease polling', async () => {
    const calls = [], events = []; let yielded = false;
    const adapter = new Telegram({}, { rpc: async req => {
      calls.push(req);
      if (req.op.endsWith('poll') && !yielded) { yielded = true; return { ok: true, events: [source({ platform: 'telegram' })] }; }
      return { ok: true, botId: '77', accepted: true, messageId: '9' };
    } });
    await adapter.start(async e => { events.push(e); return { accepted: true }; }); await tick();
    await adapter.action({ type: 'prompt', target: source({ replyTo: '8', threadId: '4' }), text: 'Allow?', prompt: { id: 'prompt', choices: ['Yes', 'No'] } });
    await adapter.stop();
    assert.equal(events.length, 1); assert.ok(calls.some(c => c.op.endsWith('ack'))); assert.ok(calls.some(c => c.op.endsWith('detach')));
    const send = calls.find(c => c.method === 'sendMessage'); assert.equal(send.params.message_thread_id, 4); assert.equal(send.params.reply_markup.inline_keyboard.length, 2);
    assert.ok(calls.every(c => !JSON.stringify(c).includes('getUpdates')));
  });
};
