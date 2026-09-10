'use strict';
const assert = require('assert');
const { test } = require('../helpers');
const { Discord } = require('../../src/bot/discord');
class Socket {
  constructor(url) { this.url = url; this.listeners = {}; this.readyState = 1; this.sent = []; Socket.all.push(this); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close(code = 1000) { this.readyState = 3; this.listeners.close?.({ code }); }
}
Socket.all = [];
module.exports = async () => {
  await test('BOT DISCORD: native handshake, routing, components, edit, heartbeat and resume lifecycle', async () => {
    const prior = process.env.LAIN_DISCORD_TOKEN; process.env.LAIN_DISCORD_TOKEN = 'fixture-discord-credential';
    const requests = [], events = [];
    const http = { request: async (route, opts) => {
      requests.push({ route, opts });
      if (route === '/users/@me') return { id: '77' };
      if (route === '/gateway/bot') return { url: 'wss://gateway.discord.gg', shards: 1, session_start_limit: { remaining: 10 } };
      if (route === '/channels/thread') return { id: 'thread', parent_id: 'channel', type: 11 };
      return { id: 'receipt' };
    } };
    const a = new Discord({}, { http, WebSocket: Socket });
    try {
      await a.start(async e => events.push(e)); const ws = a.ws;
      await a.packet({ op: 10, d: { heartbeat_interval: 45000 } }); assert.equal(ws.sent[0].op, 2);
      await a.packet({ op: 0, t: 'READY', s: 1, d: { session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg' } });
      assert.equal(a.state, 'listening');
      await a.packet({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'message', channel_id: 'thread', guild_id: 'guild', author: { id: 'alice' }, mentions: [{ id: '77' }], content: 'hello' } });
      assert.equal(events[0].threadId, 'thread'); assert.equal(events[0].chatId, 'channel');
      await a.packet({ op: 0, t: 'INTERACTION_CREATE', s: 3, d: { type: 3, id: 'interaction', token: 'ephemeral-token', channel_id: 'thread', guild_id: 'guild', member: { user: { id: 'alice' } }, data: { custom_id: 'lain:0123456789abcdef01234567:2' } } });
      assert.equal(events[1].promptResponse.value, '2'); assert.ok(!JSON.stringify(events).includes('ephemeral-token'));
      const target = { chatId: 'channel', threadId: 'thread', replyTo: 'message' };
      await a.action({ type: 'prompt', target, text: 'Allow?', id: 'x'.repeat(64), prompt: { id: '0123456789abcdef01234567', choices: ['Yes', 'No'] } });
      const sent = requests.find(r => r.opts?.body?.components); assert.equal(sent.route, '/channels/thread/messages');
      assert.equal(sent.opts.body.allowed_mentions.parse.length, 0); assert.equal(sent.opts.body.components[0].components.length, 2);
      await a.action({ type: 'edit', target, messageId: 'receipt', text: 'Updated' }); assert.equal(requests.at(-1).opts.method, 'PATCH');
      await a.packet({ op: 1 }); assert.equal(ws.sent.at(-1).op, 1);
      await a.packet({ op: 10, d: { heartbeat_interval: 45000 } }); assert.equal(ws.sent.at(-1).op, 6);
      await a.packet({ op: 9, d: false }); assert.equal(a.sessionId, null); assert.equal(a.state, 'reconnecting');
      await a.stop(); assert.equal(a.reconnectTimer?._destroyed, true);
    } finally { await a.stop(); if (prior === undefined) delete process.env.LAIN_DISCORD_TOKEN; else process.env.LAIN_DISCORD_TOKEN = prior; }
  });
};
