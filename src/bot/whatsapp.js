'use strict';
const http = require('http');
const crypto = require('crypto');
const { Http, secret } = require('./http');
const caps = { version: 1, platform: 'whatsapp', maxLength: 4096, format: 'plain', edit: false, typing: false, threads: false, buttons: false, mediaIn: true, mediaOut: true };
function signature(body, header, key) {
  if (!/^sha256=[a-f0-9]{64}$/.test(String(header))) return false;
  const expected = crypto.createHmac('sha256', key).update(body).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'));
}
function normalize(payload, { accountId, phoneNumberId, businessAccountId }) {
  const events = [];
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return events;
  for (const entry of payload.entry) for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
    if (businessAccountId && String(entry.id) !== businessAccountId) continue;
    const value = change.value;
    if (change.field !== 'messages' || String(value?.metadata?.phone_number_id) !== phoneNumberId) continue;
    for (const m of Array.isArray(value.messages) ? value.messages : []) {
      if (!m || !['text', 'image', 'document', 'audio', 'video', 'sticker'].includes(m.type)) continue;
      const timestamp = Number(m.timestamp) * 1000;
      if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 300000) continue;
      const media = m[m.type];
      events.push({ platform: 'whatsapp', accountId, chatId: m.from, senderId: m.from, messageId: m.id,
        kind: 'dm', addressed: true, replyTo: m.id, text: m.text?.body || media?.caption || '',
        timestamp,
        attachments: media?.id ? [{ id: media.id, name: media.filename || m.type, mime: media.mime_type }] : [] });
    }
  }
  return events;
}
class WhatsApp {
  constructor(cfg = {}, deps = {}) {
    this.cfg = cfg; this.accountId = cfg.accountId || 'default'; this.state = 'stopped'; this.http = deps.http;
    this.injectedHttp = Boolean(deps.http); this.windows = new Map(); this.generation = 0;
  }
  async start(receive) {
    if (this.state !== 'stopped') return;
    const generation = ++this.generation;
    if (!/^\d{5,30}$/.test(String(this.cfg.phoneNumberId || '')) || !/^v\d{2}\.0$/.test(this.cfg.apiVersion || '')) throw new Error('configure WhatsApp phoneNumberId and supported API version');
    if (this.cfg.businessAccountId && !/^\d{5,30}$/.test(String(this.cfg.businessAccountId))) throw new Error('invalid WhatsApp business account ID');
    this.identity = this.phoneNumberId = String(this.cfg.phoneNumberId);
    this.businessAccountId = this.cfg.businessAccountId ? String(this.cfg.businessAccountId) : '';
    this.token = secret(this.cfg.tokenEnv || 'LAIN_WHATSAPP_TOKEN');
    this.appSecret = secret(this.cfg.appSecretEnv || 'LAIN_WHATSAPP_APP_SECRET');
    this.verifyToken = secret(this.cfg.verifyTokenEnv || 'LAIN_WHATSAPP_VERIFY_TOKEN');
    if (!this.injectedHttp) this.http = new Http({ base: `https://graph.facebook.com/${this.cfg.apiVersion}`, authorization: `Bearer ${this.token}` });
    this.receive = receive; this.state = 'starting';
    this.server = http.createServer((req, res) => this.webhook(req, res).catch(() => { if (!res.headersSent) res.writeHead(503); res.end(); }));
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
    this.starting = new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.cfg.port ?? 8787, '127.0.0.1', resolve); });
    try { await this.starting; }
    catch (error) { this.state = 'stopped'; throw error; }
    if (generation !== this.generation) return;
    this.server.on('error', () => { this.state = 'degraded'; }); this.state = 'listening';
  }
  diagnostics() { return { localListener: Boolean(this.server?.listening), publicWebhookVerified: false }; }
  async webhook(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/webhook') { res.writeHead(404); res.end(); return; }
    if (req.method === 'GET') {
      if (url.searchParams.get('hub.mode') !== 'subscribe' || url.searchParams.get('hub.verify_token') !== this.verifyToken) { res.writeHead(403); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(String(url.searchParams.get('hub.challenge') || '').slice(0, 200)); return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length; if (size > 256 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (!signature(body, req.headers['x-hub-signature-256'], this.appSecret)) { res.writeHead(403); res.end(); return; }
    let payload; try { payload = JSON.parse(body.toString()); } catch { res.writeHead(400); res.end(); return; }
    let busy = false;
    for (const e of normalize(payload, this)) {
      if (this.windows.size >= 2048 && !this.windows.has(e.chatId)) this.windows.delete(this.windows.keys().next().value);
      this.windows.set(e.chatId, Math.max(this.windows.get(e.chatId) || 0, e.timestamp));
      const result = await this.receive(e); busy ||= result?.busy === true;
    }
    res.writeHead(busy ? 503 : 200); res.end();
  }
  async action(a) {
    require('./contract').assertAction(a, caps);
    if (!['send', 'prompt', 'media'].includes(a.type)) throw Object.assign(new Error('WhatsApp action unsupported'), { definitive: true });
    // Free-form Cloud API messages require an active customer service window.
    // Approved template marketing/proactive messages are a separate capability.
    const timestamp = Math.max(this.windows.get(a.target.chatId) || 0, Number(a.target.timestamp) || 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 300000 || Date.now() - timestamp > 24 * 60 * 60 * 1000) throw Object.assign(new Error('WhatsApp response window expired; template required'), { definitive: true });
    const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: a.target.chatId, type: 'text', text: { preview_url: false, body: a.text } };
    if (a.type === 'media') {
      const form = new FormData(); form.append('messaging_product', 'whatsapp'); form.append('type', a.file.mime);
      form.append('file', new Blob([a.file.bytes], { type: a.file.mime }), a.file.name);
      const uploaded = await this.http.request(`/${this.phoneNumberId}/media`, { method: 'POST', form });
      if (!uploaded.id) throw new Error('media upload acknowledgement missing');
      delete body.text;
      body.type = ['image', 'audio', 'video'].find(kind => a.file.mime.startsWith(kind + '/')) || 'document';
      body[body.type] = { id: uploaded.id, ...(body.type === 'document' ? { filename: a.file.name } : {}) };
    }
    if (a.target.replyTo) body.context = { message_id: a.target.replyTo };
    const r = await this.http.request(`/${this.phoneNumberId}/messages`, { method: 'POST', body });
    return { messageId: r.messages?.[0]?.id };
  }
  async download(_e, a, signal) {
    const media = await this.http.request(`/${encodeURIComponent(a.id)}`);
    return require('./media').download(media.url, { hosts: ['lookaside.fbsbx.com'], authorization: `Bearer ${this.token}`, signal });
  }
  async stop() {
    this.generation++; this.state = 'stopping'; await this.starting?.catch(() => {});
    if (this.server?.listening) {
      const server = this.server; server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), 1000);
      try { await new Promise(resolve => server.close(resolve)); } finally { clearTimeout(force); }
    }
    this.windows.clear(); this.token = null; this.appSecret = null; this.verifyToken = null;
    this.state = 'stopped';
  }
}
module.exports = { WhatsApp, caps, normalize, signature };
