'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { test } = require('../helpers');
const supervisor = require('../../src/supervisor');
const { Gateway } = require('../../src/bot/gateway');
const { Registry } = require('../../src/bot/contract');
const { Telegram, caps } = require('../../src/bot/telegram');
const { setTimeout: delay } = require('timers/promises');
async function until(fn) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return true; await delay(30); } return false; }
module.exports = async () => {
  await test('BOT TELEGRAM: real Rust poller/mailbox, exclusive lease, auth, callback, reply and latch after stop', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-telegram-'));
    const keys = ['LAIN_HOME', 'LAIN_TELEGRAM_API', 'LAIN_BOT_TEST_TOKEN']; const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    const token = '123456789:fixture_telegram_bot_token_1234567890';
    process.env.LAIN_BOT_TEST_TOKEN = token;
    const pending = [], updates = [], sent = [], methods = []; let next = 0;
    const respond = (res, body) => { if (!res.writableEnded) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture'), method = url.pathname.split('/').at(-1); methods.push(method);
      if (!url.pathname.startsWith('/bot' + token + '/')) { res.writeHead(404); res.end(); return; }
      if (method === 'getMe') return respond(res, { ok: true, result: { id: 77, username: 'lain_fixture', first_name: 'LAIN' } });
      if (method === 'getUpdates') {
        const flush = () => { const i = pending.indexOf(flush); if (i >= 0) pending.splice(i, 1); respond(res, { ok: true, result: updates.splice(0) }); };
        if (updates.length) return flush(); pending.push(flush); setTimeout(flush, 300); return;
      }
      if (method === 'sendMessage') sent.push(Object.fromEntries(url.searchParams));
      respond(res, { ok: true, result: { message_id: sent.length || 1 } });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.LAIN_HOME = path.join(root, 'home'); process.env.LAIN_TELEGRAM_API = `http://127.0.0.1:${server.address().port}`;
    const say = (sender, text, extra = {}) => {
      updates.push({ update_id: ++next, message: { message_id: next, from: { id: sender, is_bot: false }, chat: { id: sender, type: 'private' }, date: Math.floor(Date.now() / 1000), text, ...extra } });
      for (const release of [...pending]) release();
    };
    let gateway; const received = [];
    try {
      const registry = new Registry().register(caps, cfg => new Telegram(cfg));
      gateway = new Gateway({ dir: path.join(root, 'bot'), registry,
        cfg: { bot: { platforms: { telegram: { enabled: true, tokenEnv: 'LAIN_BOT_TEST_TOKEN', allowUsers: ['555'] } } } },
        runtimeFactory: opts => ({ id: 'fixture-session', stop() {}, close: async () => {}, steer() {}, async run(e) {
          received.push(e);
          if (e.text === 'ask') return 'Answer: ' + await opts.ask(e, { question: 'Approve?', options: ['Allow', 'Deny'] });
          return 'core answer: ' + e.text;
        } }),
      });
      await gateway.start(); assert.equal(gateway.status().platforms[0].state, 'listening');
      const competitor = new Telegram(); await assert.rejects(() => competitor.start(async () => ({}))); await competitor.stop();
      say(666, 'stranger'); say(555, 'hello'); assert.ok(await until(() => sent.some(s => s.text === 'core answer: hello')));
      assert.equal(received.length, 1); assert.equal(received[0].senderId, '555');
      const answer = sent.find(s => s.text === 'core answer: hello'); assert.equal(JSON.parse(answer.reply_parameters).message_id, 2);
      assert.ok(methods.includes('sendChatAction'));
      say(555, 'ask'); assert.ok(await until(() => sent.some(s => s.reply_markup)));
      const prompt = sent.find(s => s.reply_markup), data = JSON.parse(prompt.reply_markup).inline_keyboard[1][0].callback_data;
      updates.push({ update_id: ++next, callback_query: { id: 'callback1', from: { id: 555 }, data, message: { message_id: 88, date: 1, text: 'prompt', chat: { id: 555, type: 'private' } } } });
      for (const release of [...pending]) release();
      assert.ok(await until(() => sent.some(s => s.text === 'Answer: Deny'))); assert.ok(methods.includes('answerCallbackQuery'));
      await gateway.stop(); const before = sent.length;
      say(555, '/session'); await delay(700); assert.equal(sent.length, before, 'legacy machine-wide routing must remain disabled');
      const cred = fs.readFileSync(path.join(root, 'bot', 'transport.json'), 'utf8'); assert.ok(!cred.includes(token));
    } finally {
      await gateway?.stop(); await supervisor.shutdownIn(process.env.LAIN_HOME).catch(() => {});
      for (const release of [...pending]) release(); server.closeAllConnections(); await new Promise(r => server.close(r));
      for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
};
