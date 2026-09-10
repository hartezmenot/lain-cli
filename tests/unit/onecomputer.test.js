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

  // The remaining tests here were pinned against the `probe` TOOL — the
  // redirect, the dialect-derived movedTo, the schema groups — and that tool was
  // removed from LAIN CLI with the Probe integration in 2026-09 (the instrument
  // it exposed belongs to the LAIN Harness now; see the header of
  // src/tools/computer.js). Their coverage falls as follows:
  //
  //   `desktop` is not a tool name      kept above — the consolidation it pinned
  //                                     happened and is permanent
  //   everything desktop did, computer  kept below — still the reason the
  //     can do                          subtraction is safe
  //   the probe redirect (×2) and the   DIED with the tool. A redirect is a
  //     schema-not-advertising-screen   migration aid for a live tool; with the
  //                                     tool gone there is nothing to redirect
  //                                     and nothing to advertise, and keeping
  //                                     the assertions would be test coverage
  //                                     pretending the tool exists.
  //   the Probe keeps what is genuinely DIED with the tool — that was a test of
  //     its own                          the Harness's instrument, not of LAIN.

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

  await test('ONE: the `probe` tool is not a tool name either, in any configuration', () => {
    // The third way to press one key, retired with the Probe integration in
    // 2026-09 (the instrument it exposed belongs to the LAIN Harness, not this
    // CLI). Gone means gone: not advertised, not dispatchable, not on disk.
    assert.ok(!tools.names().includes('probe'),
      'one vocabulary — the instrument is not a tool here any more');
    assert.strictEqual(tools.has('probe'), false);
    assert.throws(() => require('../../src/tools/probe'), /Cannot find module/);
  });

  await test('ONE: schemas and dispatch still match exactly', () => {
    assert.deepStrictEqual(tools.schemas().map((s) => s.name).sort(), tools.names().sort());
  });
};
