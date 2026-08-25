'use strict';

/** Real-binary verification of /models, /model, /effort, /provider, /oauth. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli, assertIncludes, assertNotIncludes } = require('../helpers');

const CONFIG = {
  connections: {
    anthropic: { provider: 'anthropic', via: 'native', auth: 'api_key', envKey: 'DEMO_KEY', models: ['claude-opus-5', 'claude-sonnet-5'] },
    omniroute: { provider: 'anthropic', via: 'bridge', baseUrl: 'http://localhost:20128/v1', models: ['claude-opus-5-low', 'claude-opus-5-medium', 'claude-opus-5-high', 'gemini-3.5-flash', 'kimi-k3'] },
    ninerouter: { provider: 'bridge9', via: 'bridge', baseUrl: 'http://localhost:9999/v1', models: ['claude-opus-5-low', 'claude-opus-5-high', 'gpt-5.5-low', 'gpt-5.5-medium', 'gpt-5.5-extra-high', 'qwen-max'] },
  },
};

function withConfig() {
  const cwd = tmpdir('lain-cat-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2), 'utf8');
  return { cwd, configDir };
}

module.exports = async function () {
  await test('SMOKE: /models collapses effort variants — 13 upstream ids become 6 models', async () => {
    const { cwd, configDir } = withConfig();
    const r = await runCli([], { cwd, configDir, stdin: '/models\n/exit\n', script: [] });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, '6 model(s)');
    assertIncludes(r.stdout, 'Claude Opus 5');
    // The V1 failure: four rows for one model.
    assertNotIncludes(r.stdout, 'claude-opus-5-low');
    assertNotIncludes(r.stdout, 'claude-opus-5-high');
    assertNotIncludes(r.stdout, 'gpt-5.5-extra', 'no phantom base from greedy splitting');
  });

  await test('SMOKE: /models is generic — Gemini, Kimi, GPT and Qwen route the same way', async () => {
    const { cwd, configDir } = withConfig();
    const r = await runCli([], { cwd, configDir, stdin: '/models\n/exit\n', script: [] });
    for (const n of ['Gemini 3.5 Flash', 'GPT 5.5', 'Qwen Max']) assertIncludes(r.stdout, n);
    assertIncludes(r.stdout, 'Kimi');
  });

  await test('SMOKE: selecting a model shows every route that actually serves it', async () => {
    const { cwd, configDir } = withConfig();
    // An unambiguous name now COMMITS rather than only describing — the same
    // rule Enter follows in the picker, so the two cannot disagree. The routes
    // are still all listed, because a selection that quietly picked one of
    // three would hide the choice it made.
    const r = await runCli([], { cwd, configDir, stdin: '/models claude-opus-5\n/exit\n', script: [] });
    assertIncludes(r.stdout, '3 routes serve this model');
    for (const c of ['omniroute', 'ninerouter', 'anthropic']) assertIncludes(r.stdout, c);
    // A route that does NOT serve it must not appear under it.
    const r2 = await runCli([], { cwd, configDir, stdin: '/models gemini-3.5-flash\n/exit\n', script: [] });
    assertNotIncludes(r2.stdout, 'ninerouter');
  });

  await test('SMOKE: /model selects a model AND its route', async () => {
    const { cwd, configDir } = withConfig();
    const r = await runCli([], { cwd, configDir, stdin: '/model claude-opus-5 omniroute\n/status\n/exit\n', script: [] });
    assertIncludes(r.stdout, 'Claude Opus 5');
    assertIncludes(r.stdout, 'omniroute');
  });

  await test('SMOKE: /effort exists, validates against the route, and /efforts does NOT exist', async () => {
    const { cwd, configDir } = withConfig();
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/model claude-opus-5 omniroute\n/effort high\n/effort\n/effort banana\n/exit\n',
      script: [{ text: 'ack' }],
    });
    assertIncludes(r.stdout, 'effort high');
    assertIncludes(r.stdout, 'available here: low, medium, high');
    assertIncludes(r.stdout, 'is not offered by omniroute', 'an unavailable effort is refused, not silently accepted');
    // /efforts is not registered, so it is CONTENT and goes to the model.
    const r2 = await runCli([], { cwd, configDir, stdin: '/efforts\n/exit\n', script: [{ text: 'not a command' }] });
    assertIncludes(r2.stdout, 'not a command');
  });

  await test('SMOKE: /help lists /effort exactly once and never /efforts', async () => {
    const r = await runCli([], { stdin: '/help\n/exit\n', script: [] });
    const effortLines = r.stdout.split('\n').filter((l) => /^\s*\/effort\b/.test(l));
    assert.strictEqual(effortLines.length, 1, 'exactly one effort command');
    assertNotIncludes(r.stdout, '/efforts');
  });

  await test('SMOKE: /provider status separates readiness from availability', async () => {
    const { cwd, configDir } = withConfig();
    const r = await runCli([], { cwd, configDir, stdin: '/provider status\n/exit\n', script: [] });
    assertIncludes(r.stdout, 'Connections');
    assertIncludes(r.stdout, 'readiness');
    assertIncludes(r.stdout, 'availability');
    assertIncludes(r.stdout, 'They are separate.');
  });

  await test('SMOKE: /provider disable/enable/maintenance work with no provider running', async () => {
    const { cwd, configDir } = withConfig();
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/provider disable omniroute\n/provider maintenance ninerouter\n/provider enable omniroute\n/exit\n',
      script: [],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'omniroute → DISABLED');
    assertIncludes(r.stdout, 'ninerouter → MAINTENANCE');
    assertIncludes(r.stdout, 'omniroute → UNKNOWN');
    // Nothing here may contact anything.
    assert.strictEqual((r.stdout.match(/no request was sent/g) || []).length, 3);
  });

  await test('SMOKE: /oauth never fakes OAuth and offers the keyless bridge route first', async () => {
    const { cwd, configDir } = withConfig();
    const r = await runCli([], { cwd, configDir, stdin: '/oauth anthropic\n/exit\n', script: [] });
    assertIncludes(r.stdout, 'OAUTH NOT AVAILABLE FOR THIS PROVIDER');
    assertIncludes(r.stdout, 'not faked');
    assertIncludes(r.stdout, 'the bridge authenticates upstream itself');
    assertIncludes(r.stdout, 'keyless route is already authenticated');
    const bridgeAt = r.stdout.indexOf('via omniroute');
    const keyAt = r.stdout.indexOf('API key');
    assert.ok(bridgeAt >= 0 && bridgeAt < keyAt, 'a real authenticated route is offered before an API key');
  });
};
