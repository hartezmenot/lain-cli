'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const doctor = require('../../src/bot/doctor');
const check = require('../../src/bot/check');
const evidence = require('../../src/bot/certification');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-check-'));
const settings = { enabled: true, accountId: 'private-profile', tokenEnv: 'FIXTURE_BOT_TOKEN', allowUsers: ['private-user'] };
const cfg = { bot: { platforms: { discord: settings } } };
const env = { FIXTURE_BOT_TOKEN: 'fixture-credential-never-printed' };
const fingerprint = evidence.accountFingerprint('discord', settings.accountId, '123');
const absent = async () => ({ ok: false });
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true }).map(p => {
    const full = path.join(dir, p); return [p, fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : '<dir>'];
  }));
function fixtureInspect(changes = {}) {
  return async () => ({ platforms: [{ platform: 'discord', configured: true, accountFingerprint: fingerprint,
    currentFingerprint: fingerprint, connected: true, diagnostics: { activeSession: true, heartbeatHealthy: true }, ...changes }], shared: [] });
}
module.exports = async () => {
  await test('BOT CHECK: doctor is observational, creates no config/session/receipt state and calls only status', async () => {
    const root = temp(), dir = path.join(root, 'absent'), calls = [];
    try {
      const report = await doctor.inspect({ cfg: {}, dir, env: {}, control: async (op) => { calls.push(op); return {}; },
        rpc: async req => { calls.push(req.op); return {}; } });
      assert.deepEqual(calls.sort(), ['remote_gateway_status', 'status']);
      assert.ok(report.platforms.every(p => p.state === 'UNCONFIGURED'));
      assert.ok(!fs.existsSync(dir)); assert.ok(doctor.render(report).includes('NOT LIVE VERIFIED'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test('BOT CHECK: doctor never recovers interrupted receipts or leaks raw errors, credentials or identifiers', async () => {
    const root = temp();
    try {
      fs.mkdirSync(path.join(root, 'bot'));
      fs.writeFileSync(path.join(root, 'bot', 'transport.json'), JSON.stringify({ version: 1, sessions: {},
        inbox: { a: { state: 'running' } }, deliveries: { b: { state: 'sending' } }, accounts: { 'discord:private-profile': '123' } }));
      const before = snapshot(root);
      const report = await doctor.inspect({ cfg, dir: root, env, control: async () => ({ ok: true, state: 'running', platforms: [
        { platform: 'discord', accountId: settings.accountId, state: 'listening', accountFingerprint: fingerprint,
          reason: env.FIXTURE_BOT_TOKEN, diagnostics: { activeSession: true, heartbeatHealthy: true, intents: 37377, raw: env.FIXTURE_BOT_TOKEN } },
      ] }), rpc: async () => ({ error: env.FIXTURE_BOT_TOKEN }) });
      const text = doctor.render(report); assert.ok(text.includes('CONNECTED')); assert.ok(text.includes('heartbeat: healthy'));
      for (const privateValue of [env.FIXTURE_BOT_TOKEN, settings.accountId, 'private-user']) assert.ok(!text.includes(privateValue));
      assert.deepEqual(snapshot(root), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test('BOT CHECK: old Telegram supervisor requires deliberate restart without starting or attaching', async () => {
    const root = temp();
    try {
      const report = await doctor.inspect({ cfg: { bot: { platforms: { telegram: { enabled: true, tokenEnv: 'FIXTURE_BOT_TOKEN' } } } },
        dir: root, env, control: absent, rpc: async req => { assert.equal(req.op, 'remote_gateway_status'); return { ok: false, error: 'unknown op' }; } });
      const telegram = report.platforms[0]; assert.ok(telegram.restartRequired); assert.ok(doctor.render(report).includes('restart required'));
      assert.deepEqual(fs.readdirSync(root), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test('BOT CHECK: local WhatsApp listener never claims public webhook verification', async () => {
    const root = temp();
    try {
      const report = await doctor.inspect({ cfg: { bot: { platforms: { whatsapp: { enabled: true, phoneNumberId: '123456', apiVersion: 'v99.0' } } } },
        dir: root, env: { LAIN_WHATSAPP_TOKEN: 'fixture', LAIN_WHATSAPP_APP_SECRET: 'fixture', LAIN_WHATSAPP_VERIFY_TOKEN: 'fixture' }, rpc: absent,
        control: async () => ({ ok: true, platforms: [{ platform: 'whatsapp', accountId: 'default', state: 'listening', diagnostics: { localListener: true, publicWebhookVerified: true } }] }) });
      const text = doctor.render(report, 'whatsapp'); assert.ok(text.includes('local adapter: ready')); assert.ok(text.includes('public webhook: not verified'));
      assert.ok(!text.includes('LIVE VERIFIED checks'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test('BOT CHECK: live authentication is opt-in and record cannot promote local observations', async () => {
    const root = temp(); let calls = 0;
    try {
      const opts = { cfg, dir: root, env, control: absent, rpc: absent, auth: async () => { calls++; return { ok: true, identity: '123' }; } };
      const local = await check.run('discord', opts); assert.equal(local.code, 0); assert.equal(calls, 0);
      assert.equal((await check.run('discord', { ...opts, record: true })).code, 2); assert.equal(calls, 0);
      assert.deepEqual(fs.readdirSync(root), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test('BOT CHECK: auth failures classify safely and write no certificate', async () => {
    const root = temp();
    try {
      const result = await check.run('discord', { cfg, dir: root, env, live: true, record: true, inspect: fixtureInspect(),
        auth: async () => ({ ok: false, authFailed: true, error: env.FIXTURE_BOT_TOKEN }) });
      assert.equal(result.code, 1); assert.ok(result.text.includes('AUTH FAILED')); assert.ok(!result.text.includes(env.FIXTURE_BOT_TOKEN));
      assert.deepEqual(fs.readdirSync(root), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test('BOT CHECK: live HTTP auth uses read-only credential boundary and preserves identity checks', async () => {
    const calls = [];
    const makeHttp = opts => { assert.equal(opts.authorization, 'Bot ' + env.FIXTURE_BOT_TOKEN); return { request: async route => {
      calls.push(route); return { id: '123', bot: true, username: 'private-user' };
    } }; };
    const result = await check.authenticate('discord', settings, { env, makeHttp });
    assert.equal(result.identity, '123'); assert.deepEqual(calls, ['/users/@me']);
    assert.equal((await check.authenticate('discord', { ...settings, botId: '999' }, { env, makeHttp })).identityMatch, false);
    assert.equal((await check.authenticate('discord', settings, { env, makeHttp: () => ({ request: async () => { throw { status: 401, token: env.FIXTURE_BOT_TOKEN }; } }) })).authFailed, true);
    assert.equal((await check.authenticate('whatsapp', { tokenEnv: settings.tokenEnv, phoneNumberId: '123456', apiVersion: 'v99.0' }, { env,
      makeHttp: () => ({ request: async route => { assert.equal(route, '/123456?fields=id'); throw { status: 400, authFailed: true }; } }) })).authFailed, true);
  });
  await test('BOT CHECK: getMe alone never certifies delivery or connection and stores only bounded non-secret proof', async () => {
    const root = temp(), now = Date.now();
    try {
      const result = await check.run('discord', { cfg, dir: root, env, now, live: true, record: true,
        inspect: fixtureInspect({ currentFingerprint: undefined, connected: false }), auth: async () => ({ ok: true, identity: '123' }) });
      assert.equal(result.code, 0); assert.equal(result.checks.authentication, 'passed'); assert.equal(result.checks.connection, 'not_verified');
      assert.equal(result.checks.outbound, 'not_verified'); assert.ok(result.text.includes('Full platform certification remains incomplete'));
      const raw = fs.readFileSync(path.join(root, 'bot', 'certification', 'discord.json'), 'utf8');
      for (const privateValue of [env.FIXTURE_BOT_TOKEN, settings.accountId, 'private-user']) assert.ok(!raw.includes(privateValue));
      assert.equal(evidence.read(root, 'discord', settings, fingerprint, now).state, 'current');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test('BOT CHECK: evidence expires on age, configuration, adapter version or account change', () => {
    const root = temp(), now = Date.now();
    try {
      evidence.record(root, 'discord', settings, fingerprint, { authentication: 'passed', raw: env.FIXTURE_BOT_TOKEN }, now);
      assert.equal(evidence.read(root, 'discord', settings, fingerprint, now + evidence.MAX_AGE + 1).state, 'stale');
      assert.equal(evidence.read(root, 'discord', { ...settings, allowUsers: [] }, fingerprint, now).state, 'stale');
      assert.equal(evidence.read(root, 'discord', settings, 'f'.repeat(24), now).state, 'stale');
      const file = path.join(root, 'bot', 'certification', 'discord.json'), record = JSON.parse(fs.readFileSync(file, 'utf8'));
      record.adapterVersion = 'old'; fs.writeFileSync(file, JSON.stringify(record));
      assert.equal(evidence.read(root, 'discord', settings, fingerprint, now).state, 'stale');
      fs.writeFileSync(file, '{'); assert.equal(evidence.read(root, 'discord', settings, fingerprint, now).state, 'invalid');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test('BOT CHECK: mismatched running profile cannot claim connection or persist an authenticated replacement', async () => {
    const root = temp();
    try {
      const result = await check.run('discord', { cfg, dir: root, env, live: true, record: true, inspect: fixtureInspect(),
        auth: async () => ({ ok: true, identity: '999' }) });
      assert.equal(result.code, 1); assert.equal(result.checks.identity, 'failed'); assert.equal(result.checks.connection, 'not_verified');
      assert.ok(result.text.includes('IDENTITY MISMATCH')); assert.deepEqual(fs.readdirSync(root), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test('BOT CHECK: certificate writes refuse config-home symlink escape', () => {
    const root = temp(), outside = temp();
    try {
      try { fs.symlinkSync(outside, path.join(root, 'bot'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (e) { if (e.code === 'EPERM') return; throw e; }
      assert.throws(() => evidence.record(root, 'discord', settings, fingerprint, { authentication: 'passed' }), /escapes config home/);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
  });
};
