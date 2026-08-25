'use strict';

/**
 * PASTE CLASSIFICATION — the one authority.
 *
 * V1 dispatched on the first character before it knew anything about pastes, and
 * separately used an unanchored regex so any text beginning with "continue" or
 * "proceed" was read as plan-resume intent. `continue` at the top of a pasted
 * code block is extremely common.
 */

const assert = require('assert');
const { test } = require('../helpers');
const commands = require('../../src/commands');

module.exports = async function () {
  await test('a bare registered command is a command', () => {
    assert.strictEqual(commands.looksLikeCommand('/help'), true);
    assert.strictEqual(commands.looksLikeCommand('  /status  '), true);
    assert.strictEqual(commands.looksLikeCommand('/resume abc-123'), true);
  });

  await test('an UNREGISTERED slash word is content, not an error', () => {
    assert.strictEqual(commands.looksLikeCommand('/frobnicate'), false);
    assert.strictEqual(commands.looksLikeCommand('/usr/local/bin/node --version'), false);
  });

  await test('multi-line input is NEVER a command, even starting with a real one', () => {
    assert.strictEqual(commands.looksLikeCommand('/help\nand here is more pasted text'), false);
    assert.strictEqual(commands.looksLikeCommand('/status\n{ "a": 1 }'), false);
  });

  await test('40-line paste beginning with "continue" is content', () => {
    const paste = ['continue;', '  }', '}', ...Array.from({ length: 37 }, (_, i) => `line ${i}`)].join('\n');
    assert.strictEqual(commands.looksLikeCommand(paste), false);
  });

  await test('100-line JSON paste containing "done" is content', () => {
    const paste = '{\n  "status": "done",\n' + Array.from({ length: 98 }, (_, i) => `  "k${i}": ${i},`).join('\n') + '\n}';
    assert.strictEqual(commands.looksLikeCommand(paste), false);
  });

  await test('shell output containing "plan" is content', () => {
    assert.strictEqual(commands.looksLikeCommand('$ ls\nplan.md\nREADME.md'), false);
  });

  await test('a pasted diff beginning with /* is content', () => {
    assert.strictEqual(commands.looksLikeCommand('/* eslint-disable */\nconst a = 1;'), false);
  });

  await test('plain prose is content', () => {
    assert.strictEqual(commands.looksLikeCommand('continue'), false);
    assert.strictEqual(commands.looksLikeCommand('fix the parser please'), false);
  });

  await test('the registry rejects a duplicate command name', () => {
    // V1 shipped two `case /status` in one switch; the second was unreachable.
    assert.throws(() => commands.define('/help', { desc: 'dup', run() {} }), /duplicate command/);
  });

  await test('every registered command has a description and a run function', () => {
    for (const c of commands.REGISTRY.values()) {
      assert.ok(c.desc, `${c.name} has no description`);
      assert.strictEqual(typeof c.run, 'function', `${c.name} has no run()`);
    }
  });
};
