'use strict';

/**
 * A LIMIT LAIN WROTE INTO YOUR CONFIG IS NOT A LIMIT YOU CHOSE.
 *
 * Observed in a live session, after the default had already been changed to
 * "no limit":
 *
 *     NOTE
 *       STEP LIMIT — it reached the step limit you configured
 *     USER
 *       › proceed
 *
 * The turn stopped mid-work and had to be restarted by hand — and the message
 * blamed the user for a number LAIN had picked and written down on their
 * behalf. `save()` persists the whole merged config, so the old default of 30
 * was sitting in every existing config file. Changing the default only helped
 * people who had never run LAIN before.
 *
 * The migration drops EXACTLY the legacy value and keeps everything else,
 * because a number that is not 30 is one somebody actually chose.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const config = require('../../src/config');

/** Write a config file into an isolated home and load it through the real path. */
function withConfig(saved) {
  const dir = tmpdir('cfgmig-');
  const before = process.env.LAIN_CONFIG_DIR;
  process.env.LAIN_CONFIG_DIR = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(saved, null, 2));
    return config.load();
  } finally {
    if (before === undefined) delete process.env.LAIN_CONFIG_DIR;
    else process.env.LAIN_CONFIG_DIR = before;
  }
}

module.exports = async function () {
  await test('MIGRATE: the legacy step ceiling is dropped from an existing config', () => {
    // The exact shape found in a real config file.
    const cfg = withConfig({ model: 'claude-opus-5', maxSteps: 30, stream: true });
    assert.strictEqual(cfg.maxSteps, 0,
      'a saved 30 is the old default LAIN wrote itself, not a limit the user asked for');
    assert.strictEqual(cfg.model, 'claude-opus-5', 'and nothing else in the config is disturbed');
    assert.strictEqual(cfg.stream, true);
  });

  await test('MIGRATE: a limit the user actually chose is kept', () => {
    for (const n of [5, 10, 20, 50, 100]) {
      assert.strictEqual(withConfig({ maxSteps: n }).maxSteps, n,
        `${n} is not the legacy default and must be honoured`);
    }
  });

  await test('MIGRATE: an explicit 0 stays 0', () => {
    assert.strictEqual(withConfig({ maxSteps: 0 }).maxSteps, 0);
  });

  await test('MIGRATE: a config with no maxSteps gets the no-limit default', () => {
    assert.strictEqual(withConfig({ model: 'x' }).maxSteps, 0);
  });

  await test('MIGRATE: the default itself is no limit, and 30 is only the retired value', () => {
    // Both halves matter: if the default ever goes back to a number, the
    // migration above would be dropping a value that is once again the default,
    // and the ceiling would return without anything failing.
    assert.strictEqual(config.DEFAULTS.maxSteps, 0, 'LAIN does not choose a step ceiling');
    assert.strictEqual(config.LEGACY_MAX_STEPS, 30, 'and 30 is retired, not current');
  });

  await test('MIGRATE: the migration is pure — it does not rewrite the file', () => {
    // Loading a config must not silently edit what is on disk. The value is
    // ignored at load; the file is the user's and is theirs to change.
    const dir = tmpdir('cfgmig-pure-');
    const before = process.env.LAIN_CONFIG_DIR;
    process.env.LAIN_CONFIG_DIR = dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'config.json');
      const text = JSON.stringify({ maxSteps: 30 }, null, 2);
      fs.writeFileSync(file, text);
      config.load();
      assert.strictEqual(fs.readFileSync(file, 'utf8'), text,
        'loading a config must not rewrite it behind the user');
    } finally {
      if (before === undefined) delete process.env.LAIN_CONFIG_DIR;
      else process.env.LAIN_CONFIG_DIR = before;
    }
  });
};
