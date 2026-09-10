'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { test, runCli } = require('../helpers');
const service = require('../../src/bot/service');
module.exports = async () => {
  await test('BOT CLI: foreground flag starts once and authenticated shutdown exits the actual CLI', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-cli-'));
    const env = { ...process.env, LAIN_CONFIG_DIR: path.join(root, 'config'), LAIN_HOME: path.join(root, 'supervisor') };
    let child;
    try {
      child = spawn(process.execPath, [path.resolve(__dirname, '../../bin/lain.js'), '--bot', '--cwd', root], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
      const exited = new Promise(resolve => child.once('exit', resolve));
      const end = Date.now() + 10000;
      while (!output.includes('Bot: running') && Date.now() < end && child.exitCode == null) await new Promise(r => setTimeout(r, 25));
      assert.ok(output.includes('Bot: running'), output);
      assert.equal((await service.control('status', env.LAIN_CONFIG_DIR)).state, 'running');
      await service.control('stop', env.LAIN_CONFIG_DIR);
      assert.equal(await exited, 0); assert.equal((await service.control('status', env.LAIN_CONFIG_DIR)).state, 'stopped');
      assert.ok(!fs.existsSync(path.join(root, 'config', 'sessions')), 'no session/model starts without an admitted message');
    } finally { if (child?.exitCode == null) child.kill(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test('BOT CLI: help and platform report expose the registered adapters without connecting', async () => {
    const help = await runCli(['--help']); assert.ok(help.out.includes('--bot'));
    const list = await runCli(['/bot', 'platforms']);
    for (const name of ['telegram', 'discord', 'whatsapp']) assert.ok(list.out.includes(name));
  });
};
