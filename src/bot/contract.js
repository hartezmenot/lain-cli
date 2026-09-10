'use strict';

const crypto = require('crypto');
const redact = require('../redact');
const VERSION = 1;
const id = (v) => typeof v === 'string' || Number.isSafeInteger(v) ? String(v) : '';
function required(v, name) {
  const s = id(v);
  if (!s || s.length > 160 || /[\x00-\x1f]/.test(s)) throw new Error(`invalid ${name}`);
  return s;
}
function event(raw) {
  const e = { version: VERSION };
  for (const k of ['platform', 'accountId', 'chatId', 'senderId', 'messageId']) e[k] = required(raw[k], k);
  for (const k of ['threadId', 'guildId', 'channelId', 'replyTo']) e[k] = raw[k] ? required(raw[k], k) : '';
  e.kind = raw.kind === 'group' ? 'group' : 'dm';
  e.addressed = raw.addressed === true;
  e.bot = raw.bot === true;
  e.paired = raw.paired === true;
  e.text = redact.text(String(raw.text || '').slice(0, 16000));
  e.replyText = redact.text(String(raw.replyText || '').slice(0, 1000));
  e.timestamp = Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now();
  e.attachments = (Array.isArray(raw.attachments) ? raw.attachments : []).slice(0, 8).map(a => ({
    id: required(a.id, 'attachment'), name: redact.text(String(a.name || 'attachment').slice(0, 120)),
    mime: String(a.mime || 'application/octet-stream').slice(0, 100), size: Math.max(0, Number(a.size) || 0),
  }));
  e.promptResponse = raw.promptResponse && typeof raw.promptResponse.id === 'string'
    ? { id: required(raw.promptResponse.id, 'prompt'), value: String(raw.promptResponse.value || '').slice(0, 2000) } : null;
  return Object.freeze(e);
}
function digest(parts) { return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
// Sender is deliberate: even two authorized people in one channel have separate histories.
function sessionKey(e) { return digest([e.platform, e.accountId, e.chatId, e.threadId || '', e.senderId]); }
function eventKey(e) { return digest([e.platform, e.accountId, e.chatId, e.messageId]); }
function authorized(e, policy = {}) {
  const contains = (key, value) => Array.isArray(policy[key]) && policy[key].map(String).includes(value);
  if (e.bot) return false;
  if (!contains('allowUsers', e.senderId) && !(e.platform === 'telegram' && e.kind === 'dm' && e.paired)) return false;
  if (policy.allowChats?.length && !contains('allowChats', e.chatId)) return false;
  if (e.kind === 'group') {
    if (!contains('allowChats', e.chatId) && !contains('allowChannels', e.channelId)) return false;
    if (e.guildId && !contains('allowGuilds', e.guildId)) return false;
    if (!e.addressed && !e.promptResponse && policy.ambient !== true) return false;
  }
  return true;
}
function descriptor(d) {
  if (d.version !== VERSION || !/^[a-z][a-z0-9_-]{0,31}$/.test(d.platform)) throw new Error('unsupported adapter contract');
  if (!Number.isInteger(d.maxLength) || d.maxLength < 128 || d.maxLength > 16000) throw new Error('invalid message limit');
  return Object.freeze({ version: VERSION, platform: d.platform, maxLength: d.maxLength,
    format: d.format === 'markdown' ? 'markdown' : 'plain', edit: d.edit === true,
    typing: d.typing === true, threads: d.threads === true, buttons: d.buttons === true,
    mediaIn: d.mediaIn === true, mediaOut: d.mediaOut === true });
}
class Registry {
  constructor() { this.entries = new Map(); }
  register(caps, factory) {
    const d = descriptor(caps);
    if (this.entries.has(d.platform)) throw new Error('duplicate adapter');
    this.entries.set(d.platform, { caps: d, factory }); return this;
  }
  create(platform, cfg, deps) {
    const row = this.entries.get(platform);
    if (!row) throw new Error('unknown messaging platform');
    const adapter = row.factory(cfg, deps); adapter.caps = row.caps; return adapter;
  }
  list() { return [...this.entries.values()].map(r => r.caps); }
}
function assertAction(a, caps) {
  const needed = { send: null, prompt: null, edit: 'edit', typingStart: 'typing', typingStop: 'typing', media: 'mediaOut' };
  if (!Object.hasOwn(needed, a.type) || (needed[a.type] && !caps[needed[a.type]])) throw Object.assign(new Error('adapter action unsupported'), { definitive: true });
  if (!a.target?.chatId) throw Object.assign(new Error('message target missing'), { definitive: true });
  if (['send', 'edit', 'prompt'].includes(a.type) && (typeof a.text !== 'string' || !a.text || a.text.length > caps.maxLength)) throw Object.assign(new Error('invalid message text'), { definitive: true });
  if (a.type === 'edit' && !a.messageId) throw Object.assign(new Error('edit requires platform message ID'), { definitive: true });
  if (a.type === 'media' && (!Buffer.isBuffer(a.file?.bytes) || a.file.bytes.length > 2 * 1024 * 1024)) throw Object.assign(new Error('invalid media body'), { definitive: true });
}
module.exports = { VERSION, event, sessionKey, eventKey, authorized, descriptor, Registry, digest, assertAction };
