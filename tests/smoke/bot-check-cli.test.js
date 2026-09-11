'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('../helpers');
const cli = path.resolve(__dirname, '../../bin/lain.js');
module.exports = async () => {
  await test('BOT CHECK CLI: diagnostic flags and slash doctor create no session or supervisor state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-check-cli-'));
    try {
      const env = { ...process.env, LAIN_CONFIG_DIR: path.join(root, 'config'), LAIN_HOME: path.join(root, 'supervisor') };
      for (const args of [['--bot-check', 'telegram'], ['--bot-check', 'discord'], ['--bot-check', 'whatsapp'], ['/bot', 'doctor'], ['-p', '/bot doctor']]) {
        const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.equal(result.status, args.includes('--bot-check') ? 1 : 0, result.stderr);
        assert.ok(result.stdout.includes('NOT LIVE VERIFIED'), result.stdout);
        assert.deepEqual(fs.readdirSync(root), [], args.join(' '));
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test('BOT CHECK CLI: malformed or mixed live commands fail before session construction', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-check-cli-'));
    try {
      const env = { ...process.env, LAIN_CONFIG_DIR: path.join(root, 'config'), LAIN_HOME: path.join(root, 'supervisor') };
      for (const args of [['--bot-check'], ['--live'], ['--record'], ['--bot-check', 'slack'], ['--bot-check', 'telegram', '--record'], ['--bot-check', 'telegram', '--bot']]) {
        const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.equal(result.status, 2, result.stdout + result.stderr); assert.deepEqual(fs.readdirSync(root), []);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
};
