'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const { Registry, sessionKey } = require('../../src/bot/contract');
const { Gateway } = require('../../src/bot/gateway');
const { Runtime } = require('../../src/bot/runtime');
const supervisor = require('../../src/supervisor');
const tick = () => new Promise(r => setImmediate(r));
const source = (changes = {}) => ({ platform: 'fixture', accountId: 'default', chatId: 'chat', senderId: 'alice', messageId: '1', text: 'Say hello', ...changes });
module.exports = async () => {
  await test('BOT RUNTIME: real App turn, background work, prompt consent, exact resume and clean shutdown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-runtime-'));
    const previous = Object.fromEntries(['LAIN_HOME', 'LAIN_PROVIDER', 'LAIN_MOCK_SCRIPT'].map(k => [k, process.env[k]]));
    process.env.LAIN_HOME = path.join(dir, 'supervisor'); process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = path.join(dir, 'script.json');
    const script = steps => { fs.writeFileSync(process.env.LAIN_MOCK_SCRIPT, JSON.stringify(steps)); require('../../src/mockprovider')._reset(); };
    const sent = []; let g;
    const registry = new Registry().register({ version: 1, platform: 'fixture', maxLength: 2000, buttons: true, mediaIn: true, mediaOut: true }, () => ({
      download: async () => Buffer.from('untrusted report bytes'),
      state: 'listening', start: async () => {}, stop: async () => {}, action: async a => {
        sent.push(a);
        if (a.type === 'prompt') setImmediate(() => g.receive(source({ messageId: String(sent.length + 100),
          promptResponse: { id: a.prompt.id, value: '2' } }))); // deny the actual filesystem request
        return { messageId: String(sent.length) };
      },
    }));
    const cfg = { model: 'mock-model', trustedPaths: [], bot: { platforms: { fixture: { enabled: true, allowUsers: ['alice', 'bob'] } } } };
    const settings = { dir: path.join(dir, 'bot'), cwd: dir, cfg, registry };
    try {
      script([{ text: 'Hello from the existing core.' }]);
      g = new Gateway(settings); await g.start(); await g.receive(source()); await Promise.all([...g.tasks]);
      const first = g.runtimes.get(sessionKey(source())); assert.ok(first instanceof Runtime);
      assert.ok(sent.some(a => a.text?.includes('Hello from the existing core.')));
      const id = first.id; assert.equal(first.app.session.turns.length, 1);
      script([{ tool_calls: [{ name: 'write_file', input: { path: 'denied.txt', content: 'must not exist' } }] }, { text: 'The write was denied.' }]);
      await g.receive(source({ messageId: '2', text: 'Write denied.txt' })); await Promise.all([...g.tasks]);
      assert.ok(sent.some(a => a.type === 'prompt')); assert.ok(!fs.existsSync(path.join(dir, 'denied.txt')));
      script([{ text: 'Only Bob sees this.' }]);
      await g.receive(source({ senderId: 'bob', messageId: '3' })); await Promise.all([...g.tasks]);
      const bob = g.runtimes.get(sessionKey(source({ senderId: 'bob' })));
      assert.notEqual(bob.id, id); assert.ok(!JSON.stringify(bob.app.session.messages).includes('Hello from the existing core.'));
      script([{ text: 'Background completed in the core.' }]);
      await g.receive(source({ messageId: '4', text: '/bg inspect this workspace' })); await Promise.all([...g.tasks]);
      await Promise.all(first.app.jobs.running().map(j => j.wait())); await tick(); await tick();
      await Promise.all([...g.delivery.chains.values()]);
      assert.ok(sent.some(a => a.text?.includes('Background completed in the core.')));
      await g.stop();
      script([{ text: 'Resumed correctly.' }]);
      g = new Gateway(settings); await g.start(); await g.receive(source({ messageId: '5' })); await Promise.all([...g.tasks]);
      assert.equal(g.runtimes.get(sessionKey(source())).id, id);
      assert.ok(g.runtimes.get(sessionKey(source())).app.session.turns.length >= 3);
      script([{ text: 'Attachment inspected.' }]);
      await g.receive(source({ messageId: '6', text: 'Inspect the attached report for errors', attachments: [{ id: 'upload', name: 'report.txt', mime: 'text/plain' }] }));
      await Promise.all([...g.tasks]);
      const owner = g.runtimes.get(sessionKey(source()));
      const artifacts = require('../../src/bot/media').artifacts(owner.app);
      const attachment = artifacts.find(a => a.name === 'report.txt'); assert.ok(attachment, 'inbound file must be owned by a real Harness task');
      assert.equal(fs.readFileSync(attachment.path, 'utf8'), 'untrusted report bytes');
      await g.receive(source({ messageId: '7', text: '/send ' + attachment.id })); await Promise.all([...g.tasks]);
      assert.ok(sent.some(a => a.type === 'media' && a.file.bytes.toString() === 'untrusted report bytes'));
      const count = sent.filter(a => a.type === 'media').length;
      await g.receive(source({ senderId: 'bob', messageId: '8', text: '/send ' + attachment.id })); await Promise.all([...g.tasks]);
      assert.equal(sent.filter(a => a.type === 'media').length, count, 'another user must not export the artifact');
    } finally {
      await g?.stop(); await new Promise(r => setTimeout(r, 250)); await supervisor.cleanupOwned().catch(() => {});
      for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
};
