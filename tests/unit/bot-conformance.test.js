'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const { Store } = require('../../src/bot/store');
const { Delivery } = require('../../src/bot/delivery');
const { descriptor } = require('../../src/bot/contract');
const media = require('../../src/bot/media');
module.exports = async () => {
  const telegram = require('../../src/bot/telegram'), discord = require('../../src/bot/discord'), whatsapp = require('../../src/bot/whatsapp');
  for (const [name, mod, make] of [
    ['telegram', telegram, requests => new telegram.Telegram({}, { rpc: async a => { requests.push(a); return { ok: true, accepted: true, messageId: 'receipt' }; } })],
    ['discord', discord, requests => new discord.Discord({}, { http: { request: async (route, opts) => { requests.push({ route, opts }); return { id: 'receipt' }; } } })],
    ['whatsapp', whatsapp, requests => new whatsapp.WhatsApp({}, { http: { request: async (route, opts) => { requests.push({ route, opts }); return { id: 'upload', messages: [{ id: 'receipt' }] }; } } })],
  ]) await test(`BOT CONFORMANCE: ${name} sends, respects capabilities, handles files and rejects invented actions`, async () => {
    const requests = [], adapter = make(requests), caps = descriptor(mod.caps); adapter.caps = caps;
    if (name === 'telegram') adapter.mediaProtocol = 1; // Fixture advertises the current Rust media RPC.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-conformance-'));
    const target = { platform: name, accountId: 'default', chatId: '123456', senderId: '123456', replyTo: '765432', timestamp: Date.now() };
    try {
      const d = new Delivery(new Store(dir), () => adapter);
      const rows = await d.sendMessage(target, 'x'.repeat(caps.maxLength + 100), { id: 'long-response' });
      assert.equal(rows.length, 2); assert.ok(rows.every(r => r.state === 'delivered' && r.messageId === 'receipt'));
      const before = requests.length; await d.sendMessage(target, 'x'.repeat(caps.maxLength + 100), { id: 'long-response' }); assert.equal(requests.length, before);
      await assert.rejects(() => adapter.action({ type: 'invented', target, text: 'no' }));
      await assert.rejects(() => adapter.action({ type: 'send', target, text: 'x'.repeat(caps.maxLength + 1) }));
      if (caps.edit) await adapter.action({ type: 'edit', target, messageId: 'receipt', text: 'updated' });
      else await assert.rejects(() => adapter.action({ type: 'edit', target, messageId: 'receipt', text: 'updated' }));
      if (caps.typing) { await adapter.action({ type: 'typingStart', target }); await adapter.action({ type: 'typingStop', target }); }
      if (caps.mediaOut) {
        const result = await d.sendFile(target, { name: 'evidence.txt', mime: 'text/plain', bytes: Buffer.from('actual file bytes') }, { id: 'file', turnId: 'task', artifactId: 'artifact' });
        assert.equal(result[0].state, 'delivered');
        if (name === 'telegram') {
          const rpc = requests.find(c => c.op === 'remote_gateway_send_media');
          assert.equal(Buffer.from(rpc.data, 'base64').toString(), 'actual file bytes');
          assert.equal(rpc.params.chat_id, target.chatId); assert.equal(rpc.name, 'evidence.txt');
          assert.equal(rpc.path, undefined); assert.equal(rpc.token, undefined); assert.equal(rpc.url, undefined);
        } else {
          const form = requests.find(c => c.opts?.form)?.opts.form; assert.ok(form instanceof FormData);
          const blob = form.get(name === 'discord' ? 'files[0]' : 'file'); assert.equal(await blob.text(), 'actual file bytes');
        }
        assert.ok(!fs.readFileSync(path.join(dir, 'transport.json'), 'utf8').includes('actual file bytes'));
      }
    } finally { await adapter.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('BOT MEDIA: controlled hosts, redirect refusal and byte cap precede artifact staging', async () => {
    await assert.rejects(() => media.download('http://127.0.0.1/private', { hosts: ['cdn.discordapp.com'] }));
    await assert.rejects(() => media.download('https://cdn.discordapp.com.attacker.test/a', { hosts: ['cdn.discordapp.com'] }));
    let options;
    const bytes = await media.download('https://cdn.discordapp.com/fixture', { hosts: ['cdn.discordapp.com'], fetch: async (_url, opts) => {
      options = opts; return new Response(Buffer.from('image bytes')); } });
    assert.equal(options.redirect, 'error'); assert.equal(bytes.toString(), 'image bytes');
    await assert.rejects(() => media.download('https://cdn.discordapp.com/fixture', { hosts: ['cdn.discordapp.com'], fetch: async () => new Response(Buffer.alloc(media.MAX_BYTES + 1)) }));
  });
  await test('BOT DELIVERY: never-started fragments recover, uncertain predecessors prevent recovery', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-recover-'));
    try {
      const s = new Store(dir); let sends = 0;
      const adapter = { caps: descriptor(discord.caps), action: async () => { sends++; return { messageId: 'ack' }; } };
      const d = new Delivery(s, () => adapter); d.stop();
      await d.sendMessage({ platform: 'discord', chatId: 'c', accountId: 'a' }, 'x'.repeat(3000), { id: 'recovery' });
      assert.equal(sends, 0); assert.equal(Object.values(s.data.deliveries).length, 2);
      const recovered = new Delivery(new Store(dir), () => adapter); await recovered.recover(() => true); assert.equal(sends, 2);
      const latest = new Store(dir), pending = new Delivery(latest, () => adapter); pending.stop(); await pending.sendMessage({ platform: 'discord', chatId: 'd', accountId: 'a' }, 'y'.repeat(3000), { id: 'uncertain' });
      const rows = Object.values(latest.data.deliveries).filter(r => r.target.chatId === 'd'); rows[0].state = 'sending'; latest.save();
      await new Delivery(new Store(dir), () => adapter).recover(() => true); assert.equal(sends, 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('BOT DELIVERY: receipt retention preserves acknowledgements needed by pending fragments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-retention-'));
    try {
      const s = new Store(dir);
      s.data.deliveries = {
        acknowledged: { state: 'delivered' },
        pending: { state: 'pending', previous: 'acknowledged' },
        expired: { state: 'delivered' },
      };
      s.trim('deliveries', 3);
      assert.ok(s.data.deliveries.acknowledged);
      assert.ok(s.data.deliveries.pending);
      assert.equal(s.data.deliveries.expired, undefined);
      assert.throws(() => s.trim('deliveries', 2), /capacity/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
};
