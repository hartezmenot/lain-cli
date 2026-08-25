'use strict';

/**
 * ONE MACHINE, ONE VOCABULARY — and.
 *
 * There were three. `desktop` was advertised whenever an MCP bridge was
 * configured, `probe` whenever a Probe was running, and `computer` for either,
 * so a model with a Probe up was offered BOTH `computer{op:"key"}` AND
 * `probe{op:"input.keyboard.tap"}` for one keystroke — and with a bridge
 * configured, both `computer{op:"click"}` and `desktop{op:"mouse.click"}`.
 *
 * WHY THAT IS WORSE THAN IT LOOKS. The two spellings are not interchangeable:
 * only `computer` carries the permission-before-aiming order, the foreground
 * re-verification and the SENT_UNCONFIRMED distinction. A model that guessed
 * the Probe spelling got a keystroke with none of that, and no way to tell.
 *
 * WHAT THIS FILE PINS. That the subtraction actually happened, and that it was
 * subtraction — every operation that moved is still reachable, under one name.
 */

const assert = require('assert');
const { test } = require('../helpers');

const tools = require('../../src/tools');
const computer = require('../../src/computer');

module.exports = async function () {
  await test('ONE: `desktop` is not a tool name any more, in any configuration', () => {
    assert.ok(!tools.names().includes('desktop'),
      'the bridge is a transport, not a second vocabulary');
    // And it is gone, not merely unlisted — an unadvertised but dispatchable
    // name is the "advertised vs dispatchable" gap the registry exists to deny.
    assert.strictEqual(tools.has('desktop'), false);
    assert.throws(() => require('../../src/tools/desktop'), /Cannot find module/);
  });

  await test('ONE: everything `desktop` could do, `computer` can do', () => {
    // The reason the subtraction is safe. `computer` speaks both dialects, so
    // removing the bridge's own tool removed no capability at all.
    const bridgeOps = Object.keys(require('../../src/mcp').OPS);
    const speak = computer.DIALECT.desktop;
    const covered = new Set(Object.values(speak).filter(Boolean));
    for (const op of bridgeOps) {
      assert.ok(covered.has(op), `${op} has no computer equivalent — this would be a real loss`);
    }
    assert.ok(computer.NAMES.includes('ocr'), 'and it does more: the bridge never had OCR');
  });

  await test('ONE: the probe tool REDIRECTS screen and input, and says where', () => {
    // Redirected, not silently dropped: the model is told the operation exists
    // and what it is called now, so this costs one call and never a capability.
    const src = require('fs').readFileSync(require.resolve('../../src/tools/probe.js'), 'utf8');
    assert.ok(/MOVED_TO_COMPUTER/.test(src), 'the redirect must exist');
    assert.ok(/movedTo/.test(src), 'and it must name the replacement');
  });

  await test('ONE: the redirect is DERIVED from the dialect, so they cannot drift', () => {
    // Adding an operation to computer.js retires the probe spelling by itself.
    // Anything hand-written here would be a second list to keep in step, which
    // is the very problem being removed.
    const src = require('fs').readFileSync(require.resolve('../../src/tools/probe.js'), 'utf8');
    assert.ok(/DIALECT/.test(src), 'the map must come from computer.js, not be retyped');
    const moved = (op) => {
      for (const [ours, theirs] of Object.entries(computer.DIALECT.probe)) {
        if (theirs && theirs === op) return ours;
      }
      return null;
    };
    assert.strictEqual(moved('input.keyboard.tap'), 'key');
    assert.strictEqual(moved('input.mouse.click'), 'click');
    assert.strictEqual(moved('vision.ocr'), 'ocr');
    assert.strictEqual(moved('memory.scan'), null, 'memory is genuinely the Probe\'s');
    assert.strictEqual(moved('investigate.behavior'), null, 'and so is an investigation');
  });

  await test('ONE: the probe SCHEMA no longer advertises screen or input', () => {
    // What the model reads is the schema, not the dispatch. A tool that refuses
    // an operation it still advertises is a tool that wastes a call to say no.
    const src = require('fs').readFileSync(require.resolve('../../src/tools/probe.js'), 'utf8');
    const groups = src.slice(src.indexOf('const GROUPS'), src.indexOf('const schema'));
    assert.ok(!/^\s*vision:/m.test(groups), 'vision must not be an advertised group');
    assert.ok(!/^\s*input:/m.test(groups), 'input must not be an advertised group');
    const desc = src.slice(src.indexOf('description:'), src.indexOf('parameters:'));
    assert.ok(/computer/.test(desc), 'and the description must point at the tool that owns them');
  });

  await test('ONE: the Probe keeps what is genuinely its own', () => {
    const src = require('fs').readFileSync(require.resolve('../../src/tools/probe.js'), 'utf8');
    const groups = src.slice(src.indexOf('const GROUPS'), src.indexOf('const schema'));
    for (const kept of ['memory', 'debug', 'code', 'finding', 'process', 'investigate']) {
      assert.ok(new RegExp(`^\\s*${kept}:`, 'm').test(groups),
        `${kept} is the Probe's domain and must stay`);
    }
  });

  await test('ONE: schemas and dispatch still match exactly', () => {
    assert.deepStrictEqual(tools.schemas().map((s) => s.name).sort(), tools.names().sort());
  });
};
