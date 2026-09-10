'use strict';
const { randomBytes } = require('crypto');
const supervisor = require('../supervisor');
const caps = { version: 1, platform: 'telegram', maxLength: 4096, format: 'plain', edit: true, typing: true, threads: true, buttons: true, mediaIn: true, mediaOut: true };
class Telegram {
  constructor(cfg = {}, { rpc = (req) => supervisor.call(req, { timeoutMs: 25000 }) } = {}) {
    this.cfg = cfg; this.rpc = rpc; this.accountId = cfg.accountId || 'default'; this.owner = randomBytes(24).toString('hex'); this.state = 'stopped';
  }
  async call(op, args = {}) {
    const r = await this.rpc({ op: `remote_gateway_${op}`, owner: this.owner, ...args });
    if (!r?.ok && /unknown op/i.test(String(r?.error))) throw new Error('Running supervisor predates LAIN Bot; restart it after its existing work can stop');
    if (!r?.ok) throw new Error('Telegram gateway unavailable or lease lost');
    return r;
  }
  async start(receive) {
    if (this.state !== 'stopped') return;
    this.receive = receive; this.state = 'starting'; this.stopped = false;
    const setup = this.cfg.tokenEnv ? { token: require('./http').secret(this.cfg.tokenEnv) } : {};
    const attached = await this.call('attach', setup);
    this.identity = attached.botId;
    this.mediaProtocol = attached.mediaProtocol || 0;
    if (this.cfg.botId && String(this.cfg.botId) !== attached.botId) { await this.call('detach'); throw new Error('Telegram account mismatch'); }
    this.state = 'listening'; this.loop = this.poll();
  }
  async poll() {
    while (!this.stopped) {
      try {
        const r = await this.call('poll');
        for (const e of r.events || []) {
          const result = await this.receive({ ...e, accountId: this.accountId });
          if (result.busy) break;
          if (e.callbackId) await this.action({ type: 'callbackAck', callbackId: e.callbackId }).catch(() => {});
          await this.call('ack', { messageId: e.messageId });
        }
        this.state = 'listening';
      } catch { this.state = 'degraded'; if (!this.stopped) await this.call('attach').catch(() => {}); }
      if (!this.stopped) await new Promise(resolve => { this.wake = resolve; this.timer = setTimeout(resolve, 1000); });
    }
  }
  async action(a) {
    if (a.type !== 'callbackAck') require('./contract').assertAction(a, caps);
    if (a.type === 'typingStop') return {};
    if (a.type === 'media') {
      if (this.mediaProtocol === 0) throw Object.assign(new Error('Telegram media requires the current supervisor; restart it when its work can stop'), { definitive: true });
      const params = { chat_id: a.target.chatId };
      if (a.target.threadId) params.message_thread_id = Number(a.target.threadId);
      if (a.target.replyTo) params.reply_parameters = { message_id: Number(a.target.replyTo), allow_sending_without_reply: true };
      const r = await this.call('send_media', { params, name: require('./media').filename(a.file.name), mime: a.file.mime || 'application/octet-stream', data: a.file.bytes.toString('base64') });
      return this.accepted(r);
    }
    let method = 'sendMessage'; const params = {};
    if (a.type === 'callbackAck') { method = 'answerCallbackQuery'; params.callback_query_id = a.callbackId; }
    else {
      params.chat_id = a.target.chatId;
      if (a.target.threadId) params.message_thread_id = Number(a.target.threadId);
      if (a.type === 'typingStart') { method = 'sendChatAction'; params.action = 'typing'; }
      else {
        params.text = a.text;
        if (a.type === 'edit') { method = 'editMessageText'; params.message_id = Number(a.messageId); }
        else if (a.target.replyTo) params.reply_parameters = { message_id: Number(a.target.replyTo), allow_sending_without_reply: true };
        if (a.type === 'prompt' && a.prompt.choices.length) params.reply_markup = {
          inline_keyboard: a.prompt.choices.map((label, i) => [{ text: label.slice(0, 60), callback_data: `lain:${a.prompt.id}:${i + 1}` }]),
        };
      }
    }
    const r = await this.call('send', { method, params });
    return this.accepted(r);
  }
  accepted(r) {
    if (!r.accepted) throw Object.assign(new Error('Telegram rejected action'), { status: r.status, definitive: r.status >= 400 && r.status < 500, retryAfter: r.retryAfter });
    return { messageId: r.messageId && r.messageId !== '0' ? r.messageId : undefined };
  }
  async download(e, attachment, signal) {
    if (signal?.aborted) throw new Error('attachment download cancelled');
    if (this.mediaProtocol === 0) throw new Error('Telegram media requires the current supervisor');
    const r = await this.call('fetch', { messageId: e.messageId, chatId: e.chatId, senderId: e.senderId, threadId: e.threadId || '', fileId: attachment.id });
    const limit = require('./media').MAX_BYTES;
    if (signal?.aborted || typeof r.data !== 'string' || r.data.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.data)) throw new Error('invalid or cancelled attachment');
    const bytes = Buffer.from(r.data, 'base64');
    if (bytes.length > limit || bytes.toString('base64') !== r.data) throw new Error('attachment exceeds artifact limit');
    return bytes;
  }
  async stop() {
    this.stopped = true; clearTimeout(this.timer); this.wake?.(); await this.loop;
    await this.call('detach').catch(() => {}); this.state = 'stopped';
  }
}
module.exports = { Telegram, caps };
