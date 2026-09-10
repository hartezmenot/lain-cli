'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { test } = require('../helpers');
const { WhatsApp, signature } = require('../../src/bot/whatsapp');
module.exports = async () => {
  await test('BOT WHATSAPP: real webhook verification, HMAC, stable identity, reply and text fallback', async () => {
    const vars = ['LAIN_WHATSAPP_TOKEN', 'LAIN_WHATSAPP_APP_SECRET', 'LAIN_WHATSAPP_VERIFY_TOKEN'];
    const prior = Object.fromEntries(vars.map(k => [k, process.env[k]])); for (const k of vars) process.env[k] = 'fixture-' + k;
    const events = [], sent = [];
    const adapter = new WhatsApp({ phoneNumberId: '123456789', apiVersion: 'v25.0', port: 0 }, { http: { request: async (route, opts) => { sent.push({ route, opts }); return { messages: [{ id: 'wamid.sent' }] }; } } });
    try {
      await adapter.start(async e => { events.push(e); return { accepted: true }; });
      const base = `http://127.0.0.1:${adapter.server.address().port}/webhook`;
      const good = await fetch(base + '?hub.mode=subscribe&hub.verify_token=' + process.env.LAIN_WHATSAPP_VERIFY_TOKEN + '&hub.challenge=proof');
      assert.equal(good.status, 200); assert.equal(await good.text(), 'proof');
      assert.equal((await fetch(base + '?hub.mode=subscribe&hub.verify_token=wrong')).status, 403);
      const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '123456789' }, messages: [{ id: 'wamid.inbound', from: '6731234567', type: 'text', timestamp: String(Math.floor(Date.now() / 1000)), text: { body: 'hello' } }] } }] }] };
      const body = JSON.stringify(payload), sig = 'sha256=' + crypto.createHmac('sha256', process.env.LAIN_WHATSAPP_APP_SECRET).update(body).digest('hex');
      assert.ok(signature(Buffer.from(body), sig, process.env.LAIN_WHATSAPP_APP_SECRET));
      assert.equal((await fetch(base, { method: 'POST', body })).status, 403); assert.equal(events.length, 0);
      assert.equal((await fetch(base, { method: 'POST', body, headers: { 'x-hub-signature-256': sig } })).status, 200);
      assert.equal(events[0].senderId, '6731234567'); assert.ok(!JSON.stringify(events).includes(process.env.LAIN_WHATSAPP_TOKEN));
      const receipt = await adapter.action({ type: 'prompt', target: events[0], text: 'Choose /answer <id> 1' });
      assert.equal(receipt.messageId, 'wamid.sent'); assert.equal(sent[0].opts.body.context.message_id, 'wamid.inbound');
      await assert.rejects(() => adapter.action({ type: 'send', target: { ...events[0], chatId: 'other', timestamp: 1 }, text: 'expired' }));
      payload.entry[0].changes[0].value.metadata.phone_number_id = '999';
      const foreign = JSON.stringify(payload), foreignSig = 'sha256=' + crypto.createHmac('sha256', process.env.LAIN_WHATSAPP_APP_SECRET).update(foreign).digest('hex');
      await fetch(base, { method: 'POST', body: foreign, headers: { 'x-hub-signature-256': foreignSig } }); assert.equal(events.length, 1);
    } finally { await adapter.stop(); for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
};
