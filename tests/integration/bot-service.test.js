'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { test } = require('../helpers');
const service = require('../../src/bot/service');
const { Registry } = require('../../src/bot/contract');
module.exports = async () => {
  await test('BOT SERVICE: OS singleton, authenticated stop, independent platform failure and restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-service-'));
    const registry = new Registry();
    registry.register({ version: 1, platform: 'broken', maxLength: 128 }, () => ({ start: async () => { throw new Error('fixture failure'); }, stop: async () => {} }));
    registry.register({ version: 1, platform: 'working', maxLength: 128 }, () => ({ state: 'listening', start: async () => {}, stop: async () => {}, action: async () => ({ messageId: 'a' }) }));
    const opts = { dir, registry, cfg: { bot: { platforms: { broken: { enabled: true }, working: { enabled: true } } } } };
    let running;
    try {
      running = await service.start(opts); const status = await service.control('status', dir);
      assert.equal(status.platforms.find(p => p.platform === 'broken').state, 'unavailable');
      assert.equal(status.platforms.find(p => p.platform === 'working').state, 'listening');
      await assert.rejects(() => service.start(opts));
      const reply = await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: service.location(dir).port });
        socket.on('error', reject); socket.on('connect', () => socket.write('{"op":"stop","token":"wrong"}\n'));
        socket.on('data', data => { socket.destroy(); resolve(JSON.parse(data)); });
      });
      assert.equal(reply.ok, false); assert.equal(running.stopped, false);
      await service.control('stop', dir); await running.done;
      assert.equal((await service.control('status', dir)).state, 'stopped');
      running = await service.start(opts); assert.equal((await service.control('status', dir)).state, 'running');
    } finally { await running?.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('BOT SERVICE: CLI restart waits for an external service to release its socket', async () => {
    const registry = new Registry();
    registry.register({ version: 1, platform: 'fixture', maxLength: 128 }, () => ({
      state: 'listening', start: async () => {},
      stop: () => new Promise(resolve => setTimeout(resolve, 150)),
    }));
    const previous = await service.start({ registry, cfg: { bot: { platforms: { fixture: { enabled: true } } } } });
    let command; let output = '';
    require('../../src/botcommand').register({ define: (_name, value) => { command = value; } });
    const app = { cfg: {}, session: { cwd: process.cwd() }, ui: { enabled: true }, render: { write: value => { output += value; } } };
    try {
      await command.run(app, { rest: 'restart' });
      assert.ok(app._botService, output);
      assert.equal(previous.stopped, true);
      assert.equal((await service.control()).state, 'running');
      assert.ok(output.includes('Bot: running'), output);
    } finally { await previous.stop(); await app._botService?.stop(); }
  });
};
