'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { test } = require('../helpers');
const supervisor = require('../../src/supervisor');
const { Telegram, caps } = require('../../src/bot/telegram');
const { Delivery } = require('../../src/bot/delivery');
const { Store } = require('../../src/bot/store');
const { MAX_BYTES } = require('../../src/bot/media');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end = Date.now() + 10000; while (Date.now() < end) { if (await fn()) return true; await delay(20); } return false; }
async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-telegram-media-'));
  const keys = ['LAIN_HOME', 'LAIN_TELEGRAM_API', 'LAIN_BOT_TEST_TOKEN'];
  const prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const token = '123456789:telegram_media_fixture_secret_1234567890';
  const updates = [], events = [], calls = [], uploads = [];
  const state = { auth: 200, filePath: 'photos/file.jpg', fileBytes: Buffer.from([0, 255, 1, 128]), fileSize: 4, mediaReply: null, fetched: 0, next: 0 };
  const respond = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname.startsWith(`/file/bot${token}/`)) {
      state.fetched++; res.writeHead(200); res.end(state.fileBytes); return;
    }
    const method = url.pathname.split('/').at(-1); calls.push(method);
    if (!url.pathname.startsWith(`/bot${token}/`)) { res.writeHead(404); res.end(); return; }
    if (method === 'getMe') return respond(res, state.auth === 200 ? { ok: true, result: { id: 77, username: 'fixture' } } : { ok: false, error_code: state.auth }, state.auth);
    if (method === 'getUpdates') { await delay(50); return respond(res, { ok: true, result: updates.splice(0) }); }
    if (method === 'getFile') return respond(res, { ok: true, result: { file_id: url.searchParams.get('file_id'), file_path: state.filePath, file_size: state.fileSize } });
    if (method === 'sendDocument' || method === 'sendPhoto') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      uploads.push({ method, body: Buffer.concat(chunks), headers: req.headers });
      const response = state.mediaReply; state.mediaReply = null;
      if (response === 'lost-ack') { req.socket.destroy(); return; }
      if (response === '429') return respond(res, { ok: false, parameters: { retry_after: 0 } }, 429);
    }
    return respond(res, { ok: true, result: { message_id: 12 } });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.LAIN_HOME = path.join(root, 'home'); process.env.LAIN_TELEGRAM_API = `http://127.0.0.1:${server.address().port}`; process.env.LAIN_BOT_TEST_TOKEN = token;
  const adapter = new Telegram({ tokenEnv: 'LAIN_BOT_TEST_TOKEN' }); adapter.caps = caps;
  const rpc = (op, args = {}) => supervisor.callIfRunning({ op: `remote_gateway_${op}`, ...args }, { timeoutMs: 25000 });
  const say = (file = {}) => updates.push({ update_id: ++state.next, message: { message_id: state.next, from: { id: 555 }, chat: { id: -100, type: 'supergroup' }, message_thread_id: 9, text: '@fixture file', date: 1,
    document: { file_id: 'opaque-file', file_name: '../evidence.bin', mime_type: 'application/octet-stream', file_size: 4, ...file } } });
  try { await fn({ root, token, adapter, state, calls, uploads, events, rpc, say, start: () => adapter.start(async e => { events.push(e); return {}; }) }); }
  finally {
    await adapter.stop(); await supervisor.shutdownIn(process.env.LAIN_HOME).catch(() => {});
    server.closeAllConnections(); await new Promise(r => server.close(r));
    for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = async () => {
  await test('BOT TELEGRAM MEDIA: observational status/check never attach, drain, latch, save or expose credentials', async () => fixture(async ({ root, token, rpc, start, adapter, state, calls }) => {
    assert.ok((await supervisor.ensure()).running);
    const mailbox = path.join(root, 'home', 'supervisor', 'bot-mailbox.json');
    const before = await rpc('status'); assert.equal(before.gatewayProtocol, 1); assert.equal(before.configured, false); assert.equal(before.gatewayEnabled, false); assert.equal(before.mailboxHealthy, true);
    assert.equal((await rpc('check')).authenticated, false); assert.equal(calls.length, 0); assert.ok(!fs.existsSync(mailbox));
    await start(); const saved = fs.readFileSync(mailbox, 'utf8'), timestamp = fs.statSync(mailbox).mtimeMs;
    const checked = await rpc('check'); assert.equal(checked.authenticated, true); assert.equal(checked.identityMatch, true);
    state.auth = 401; const failed = await rpc('check'); assert.equal(failed.authFailed, true); assert.equal(failed.authenticated, false);
    const status = await rpc('status'); assert.equal(status.gatewayOwned, true); assert.equal(status.mailboxCapacity, 128);
    assert.equal(fs.readFileSync(mailbox, 'utf8'), saved); assert.equal(fs.statSync(mailbox).mtimeMs, timestamp);
    assert.ok(!JSON.stringify([before, checked, failed, status]).includes(token));
    await adapter.stop(); assert.equal((await rpc('status')).gatewayOwned, false); assert.equal((await rpc('status')).gatewayEnabled, true);
  }));
  await test('BOT TELEGRAM MEDIA: source-bound fetch survives ACK, rejects another sender/owner and untrusted paths or excess bytes', async () => fixture(async ({ adapter, state, events, rpc, say, start, token }) => {
    await start(); say(); assert.ok(await until(() => events.length === 1)); assert.ok(await until(async () => (await rpc('status')).mailboxDepth === 0));
    const e = events[0], a = e.attachments[0]; assert.equal(e.threadId, '9'); assert.equal(a.id, 'opaque-file');
    const bytes = await adapter.download(e, a); assert.deepEqual(bytes, state.fileBytes);
    const args = { owner: adapter.owner, messageId: e.messageId, chatId: e.chatId, senderId: e.senderId, threadId: e.threadId, fileId: a.id };
    assert.equal((await rpc('fetch', { ...args, senderId: 'other' })).ok, false);
    assert.equal((await rpc('fetch', { ...args, owner: 'a'.repeat(48) })).ok, false); assert.equal(state.fetched, 1);
    assert.ok(!JSON.stringify(e).includes(token)); assert.ok(!JSON.stringify(e).includes('/file/bot'));
    state.filePath = '../secret'; await assert.rejects(() => adapter.download(e, a)); assert.equal(state.fetched, 1);
    state.filePath = 'photos/file.jpg'; state.fileSize = MAX_BYTES + 1; await assert.rejects(() => adapter.download(e, a)); assert.equal(state.fetched, 1);
    state.fileSize = 0; state.fileBytes = Buffer.alloc(MAX_BYTES + 1); await assert.rejects(() => adapter.download(e, a));
    await adapter.stop(); assert.equal((await rpc('fetch', args)).ok, false);
  }));
  await test('BOT TELEGRAM MEDIA: Rust uploads bytes with topic/reply mapping, bounded 429 retry and lost ACK remains uncertain', async () => fixture(async ({ root, adapter, state, uploads, start, token }) => {
    await start(); const store = new Store(path.join(root, 'delivery')), delivery = new Delivery(store, () => adapter, { sleep: async () => {} });
    const target = { platform: 'telegram', accountId: 'default', chatId: '-100', senderId: '555', threadId: '9', replyTo: '7' };
    const file = { name: '../../private\r\nfile.txt', mime: 'text/plain', bytes: Buffer.from('evidence\0binary') };
    state.mediaReply = '429'; const sent = await delivery.sendFile(target, file, { id: 'safe-file', artifactId: 'a', turnId: 't' }); assert.equal(sent[0].state, 'delivered'); assert.equal(uploads.length, 2);
    const body = uploads[1].body; assert.ok(body.includes(file.bytes)); assert.ok(body.includes(Buffer.from('name="message_thread_id"\r\n\r\n9'))); assert.ok(body.includes(Buffer.from('"message_id":7')));
    assert.ok(!body.includes(Buffer.from(token))); assert.ok(!body.includes(Buffer.from('../../'))); assert.ok(!body.includes(Buffer.from(root)));
    const count = uploads.length; await assert.rejects(() => adapter.action({ type: 'media', target, file: { path: root } }));
    await assert.rejects(() => adapter.action({ type: 'media', target, file: { ...file, bytes: Buffer.alloc(MAX_BYTES + 1) } })); assert.equal(uploads.length, count);
    state.mediaReply = 'lost-ack'; const unknown = await delivery.sendFile(target, file, { id: 'unknown-file', artifactId: 'a', turnId: 't' }); assert.equal(unknown[0].state, 'uncertain');
    await delivery.sendFile(target, file, { id: 'unknown-file', artifactId: 'a', turnId: 't' }); assert.equal(uploads.length, count + 1, 'unknown delivery must never auto-resend');
    assert.ok(!fs.readFileSync(path.join(root, 'delivery', 'transport.json'), 'utf8').includes(file.bytes.toString()));
  }));
};
