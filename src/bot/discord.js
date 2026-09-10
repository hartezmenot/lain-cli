'use strict';
const { Http, secret } = require('./http');
const INTENTS = 1 | 512 | 4096 | 32768;
const caps = { version: 1, platform: 'discord', maxLength: 2000, format: 'markdown', edit: true, typing: true, threads: true, buttons: true, mediaIn: true, mediaOut: true };
function normalize(message, { accountId, botId, channel = {} }) {
  const interaction = message.type === 3 && message.data?.custom_id;
  const author = message.author || message.member?.user || message.user || {};
  const reply = message.referenced_message;
  const thread = [10, 11, 12].includes(channel.type);
  const bits = interaction ? message.data.custom_id.split(':') : [];
  return { platform: 'discord', accountId, messageId: String(message.id || ''), senderId: String(author.id || ''),
    chatId: String(thread ? channel.parent_id : message.channel_id || ''), threadId: thread ? message.channel_id : '',
    channelId: String(thread ? channel.parent_id : message.channel_id || ''), guildId: String(message.guild_id || ''),
    kind: message.guild_id ? 'group' : 'dm', bot: author.bot === true || Boolean(message.webhook_id),
    addressed: Boolean(interaction || message.mentions?.some(u => u.id === botId) || reply?.author?.id === botId),
    text: String(message.content || '').replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim(),
    replyTo: message.id, replyText: reply?.content || '', timestamp: Date.parse(message.timestamp) || Date.now(),
    promptResponse: bits.length === 3 && bits[0] === 'lain' ? { id: bits[1], value: bits[2] } : null,
    attachments: (message.attachments || []).map(a => ({ id: a.id, name: a.filename, mime: a.content_type, size: a.size })),
  };
}
class Discord {
  constructor(cfg = {}, deps = {}) {
    this.cfg = cfg; this.accountId = cfg.accountId || 'default'; this.WebSocket = deps.WebSocket || globalThis.WebSocket;
    this.http = deps.http; this.state = 'stopped'; this.seq = null; this.channels = new Map(); this.backoff = 1000;
    this.attachments = new Map(); this.callbackAcks = new Set(); this.injectedHttp = Boolean(deps.http); this.generation = 0;
  }
  async start(receive) {
    if (this.state !== 'stopped') return;
    this.state = 'starting'; this.pendingIngress = 0; const generation = ++this.generation;
    if (!this.WebSocket) throw new Error('Discord requires Node 22 or newer');
    this.token = secret(this.cfg.tokenEnv || 'LAIN_DISCORD_TOKEN');
    if (!this.injectedHttp) this.http = new Http({ base: 'https://discord.com/api/v10', authorization: `Bot ${this.token}` });
    const [me, gateway] = await Promise.all([this.http.request('/users/@me'), this.http.request('/gateway/bot')]);
    if (generation !== this.generation) return;
    if (this.cfg.botId && me.id !== String(this.cfg.botId)) throw new Error('Discord account mismatch');
    if (gateway.shards > 1) throw new Error('Discord sharding is not supported');
    if (gateway.session_start_limit?.remaining === 0) throw new Error('Discord session start limit reached');
    this.identity = me.id; this.botId = me.id; this.gatewayUrl = gateway.url; this.receive = receive; this.stopped = false; this.connect();
  }
  connect() {
    if (this.stopped) return;
    let url; try { url = new URL(this.resumeUrl || this.gatewayUrl); } catch { this.state = 'unavailable'; return; }
    if (url.protocol !== 'wss:' || !(url.hostname === 'gateway.discord.gg' || url.hostname.endsWith('.discord.gg'))) { this.state = 'unavailable'; return; }
    url.search = '?v=10&encoding=json'; this.state = 'connecting';
    const ws = this.ws = new this.WebSocket(url.toString()); this.lastAck = 0; this.heartbeatInterval = 0;
    this.helloTimer = setTimeout(() => { if (this.ws === ws) ws.close(4000, 'handshake timeout'); }, 20000);
    ws.addEventListener('message', ev => {
      if (this.ws !== ws || this.stopped || String(ev.data).length > 2 * 1024 * 1024) return;
      let p; try { p = JSON.parse(String(ev.data)); } catch { return; }
      this.packet(p).catch(() => { if (!this.stopped && this.ws === ws) { this.state = 'degraded'; ws.close(4000, 'ingress retry'); } });
    });
    ws.addEventListener('error', () => { if (this.ws === ws) { this.state = 'degraded'; ws.close(); } });
    ws.addEventListener('close', ev => {
      if (this.ws !== ws) return;
      clearTimeout(this.helloTimer); clearTimeout(this.heartbeatTimer); this.ws = null;
      if (this.stopped) return;
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(ev.code)) { this.state = 'unavailable'; return; }
      if ([4007, 4009].includes(ev.code)) this.resetSession();
      this.state = 'reconnecting';
      const wait = Math.max(5000, this.backoff) + Math.random() * 1000;
      this.backoff = Math.min(60000, this.backoff * 2);
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
    });
  }
  resetSession() { this.sessionId = null; this.seq = null; this.committedSeq = null; this.resumeUrl = null; }
  diagnostics() {
    return { gatewayReachable: Boolean(this.ws?.readyState === 1 && this.heartbeatInterval),
      activeSession: Boolean(this.state === 'listening' && this.sessionId && this.ws?.readyState === 1),
      heartbeatHealthy: Boolean(this.ws?.readyState === 1 && this.lastAck && Date.now() - this.lastAck <= this.heartbeatInterval * 2), intents: INTENTS };
  }
  send(op, d) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op, d })); }
  async packet(p) {
    if (p.s != null) this.seq = p.s;
    if (p.op === 10) {
      clearTimeout(this.helloTimer); this.ack = true;
      const interval = Number(p.d?.heartbeat_interval);
      if (!Number.isFinite(interval) || interval < 1000 || interval > 120000) { this.ws.close(); return; }
      this.heartbeatInterval = interval;
      const beat = () => {
        if (!this.ack) { this.ws?.close(4000, 'heartbeat timeout'); return; }
        this.ack = false; this.send(1, this.seq); this.heartbeatTimer = setTimeout(beat, interval);
      };
      clearTimeout(this.heartbeatTimer); this.heartbeatTimer = setTimeout(beat, Math.random() * interval);
      if (this.sessionId) this.send(6, { token: this.token, session_id: this.sessionId, seq: this.committedSeq ?? this.seq });
      else this.send(2, { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: 'lain', device: 'lain' } });
    } else if (p.op === 11) { this.ack = true; this.lastAck = Date.now(); }
    else if (p.op === 1) this.send(1, this.seq);
    else if (p.op === 7) this.ws?.close(4000, 'reconnect requested');
    else if (p.op === 9) {
      if (!p.d) this.resetSession();
      this.ws?.close(4000, 'session invalid');
    } else if (p.op === 0) {
      if (p.t === 'READY') { this.sessionId = p.d.session_id; this.committedSeq = p.s; this.resumeUrl = p.d.resume_gateway_url; this.state = 'listening'; this.backoff = 1000; }
      else if (p.t === 'RESUMED') { this.state = 'listening'; this.backoff = 1000; }
      else if (['THREAD_CREATE', 'THREAD_UPDATE', 'CHANNEL_CREATE', 'CHANNEL_UPDATE'].includes(p.t)) this.cacheChannel(p.d);
      else if (p.t === 'THREAD_LIST_SYNC') for (const c of p.d.threads || []) this.cacheChannel(c);
      else if (p.t === 'MESSAGE_CREATE' || p.t === 'INTERACTION_CREATE') {
        if (this.pendingIngress >= 128) { this.ws?.close(4000, 'ingress capacity'); return; }
        this.pendingIngress++; const socket = this.ws;
        const work = (this.inboundWork || Promise.resolve()).catch(() => {}).then(async () => {
          if (this.stopped || this.ws !== socket) return;
          try { await this.inbound(p.d, p.t); }
          catch (error) {
            // Fence later queued dispatches before they can advance the resume cursor.
            if (!this.stopped && this.ws === socket) { this.state = 'degraded'; socket?.close(4000, 'ingress retry'); }
            throw error;
          }
          if (this.ws === socket) this.committedSeq = p.s;
        }).finally(() => { this.pendingIngress--; });
        this.inboundWork = work; await work;
      }
    }
  }
  cacheChannel(c) { if (this.channels.size >= 1024) this.channels.delete(this.channels.keys().next().value); this.channels.set(c.id, c); }
  async inbound(message, kind) {
    if (message.author?.bot || message.webhook_id) return;
    if (kind === 'INTERACTION_CREATE') {
      if (message.type !== 3 || !String(message.data?.custom_id || '').startsWith('lain:')) return;
      // Acknowledge immediately; the credential exists only in this callback scope.
      if (!this.callbackAcks.has(message.id)) {
        try { await this.http.request(`/interactions/${message.id}/${message.token}/callback`, { method: 'POST', body: { type: 6 } }); }
        catch (error) { if (!(error.status === 400 && error.code === 40060)) throw error; }
        if (this.callbackAcks.size >= 1024) this.callbackAcks.delete(this.callbackAcks.values().next().value);
        this.callbackAcks.add(message.id);
      }
    }
    let channel = this.channels.get(message.channel_id);
    if (message.guild_id && !channel) {
      channel = await this.http.request(`/channels/${message.channel_id}`); this.cacheChannel(channel);
    }
    const e = normalize(message, { accountId: this.accountId, botId: this.botId, channel });
    for (const a of message.attachments || []) {
      if (this.attachments.size >= 256) this.attachments.delete(this.attachments.keys().next().value);
      this.attachments.set(`${e.chatId}:${e.threadId}:${e.messageId}:${a.id}`, a.url);
    }
    const admitted = await this.receive(e);
    if (admitted?.busy) await this.http.request(`/channels/${message.channel_id}/messages`, { method: 'POST',
      body: { content: 'LAIN is at its queue limit. Please retry this message later.', allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: message.id, fail_if_not_exists: false } } });
  }
  async download(e, attachment, signal) {
    const url = this.attachments.get(`${e.chatId}:${e.threadId}:${e.messageId}:${attachment.id}`);
    if (!url) throw new Error('attachment download reference expired');
    return require('./media').download(url, { hosts: ['cdn.discordapp.com', 'media.discordapp.net'], signal });
  }
  async action(a) {
    require('./contract').assertAction(a, caps);
    const channel = encodeURIComponent(a.target.threadId || a.target.chatId);
    if (a.type === 'typingStop') return {};
    if (a.type === 'typingStart') { await this.http.request(`/channels/${channel}/typing`, { method: 'POST' }); return {}; }
    if (a.type === 'media') {
      const form = new FormData(); form.append('files[0]', new Blob([a.file.bytes], { type: a.file.mime }), a.file.name);
      form.append('payload_json', JSON.stringify({ allowed_mentions: { parse: [], replied_user: false },
        nonce: a.id.slice(0, 24), enforce_nonce: true, attachments: [{ id: 0, filename: a.file.name }] }));
      const r = await this.http.request(`/channels/${channel}/messages`, { method: 'POST', form }); return { messageId: r.id };
    }
    const body = { content: a.text, allowed_mentions: { parse: [], replied_user: false } };
    if (a.type === 'send' || a.type === 'prompt') {
      body.nonce = a.id.slice(0, 24); body.enforce_nonce = true;
      if (a.target.replyTo) body.message_reference = { message_id: a.target.replyTo, fail_if_not_exists: false };
    }
    if (a.type === 'prompt' && a.prompt.choices.length) {
      body.components = [];
      for (let i = 0; i < a.prompt.choices.length; i += 5) body.components.push({ type: 1,
        components: a.prompt.choices.slice(i, i + 5).map((label, j) => ({ type: 2, style: 2,
          label: label.slice(0, 80), custom_id: `lain:${a.prompt.id}:${i + j + 1}` })) });
    }
    const result = await this.http.request(`/channels/${channel}/messages${a.type === 'edit' ? '/' + a.messageId : ''}`,
      { method: a.type === 'edit' ? 'PATCH' : 'POST', body });
    return { messageId: result.id };
  }
  async stop() {
    this.stopped = true; this.generation++; clearTimeout(this.reconnectTimer); clearTimeout(this.heartbeatTimer); clearTimeout(this.helloTimer);
    const ws = this.ws; this.ws = null; ws?.close(1000, 'LAIN stopped'); this.state = 'stopped';
    await this.inboundWork?.catch(() => {});
    this.resetSession(); this.channels.clear(); this.attachments.clear(); this.callbackAcks.clear(); this.token = null;
  }
}
module.exports = { Discord, caps, normalize };
