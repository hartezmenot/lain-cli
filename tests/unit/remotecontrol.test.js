'use strict';

/**
 * THE SUPERVISOR CAPABILITY WIRE AND ITS TERMINAL WINDOWS, at the tier that
 * needs no runtime.
 *
 * ------------------------------------------------------------------------
 * WHAT IS WORTH ASSERTING WITHOUT A SUPERVISOR, and what is not.
 *
 * The behaviour of the supervisor's remote features — pairing, authorization,
 * dedupe, capability validation, the model that invents a number — is proved
 * against the REAL binary in tests/integration/remote.test.js, because none of
 * it is true unless the process that implements it says so.
 *
 * What belongs here is the part that is true of the CODE rather than of the
 * runtime: that the command surface is what it claims to be, and that nothing
 * in the Node half quietly grew a second implementation of something the
 * runtime owns. (/rc and its Telegram setup flow were removed from LAIN CLI
 * in 2026-09; the capability wire and /session survived.)
 */

const assert = require('assert');
const { test } = require('../helpers');

module.exports = async function () {
  // ---- THE COMMAND SURFACE ------------------------------------------------

  await test('RC: /session, /ready and /dash are three things, none an alias', () => {
    const commands = require('../../src/commands');
    for (const name of ['/session', '/ready', '/dash']) {
      assert.ok(commands.REGISTRY.has(name), `${name} must exist`);
    }
    const runs = ['/session', '/ready', '/dash'].map((n) => commands.REGISTRY.get(n).run);
    assert.strictEqual(new Set(runs).size, 3, 'two of them share an implementation');
  });

  await test('RC: typing a complete command name runs THAT command, not a longer one', () => {
    // ---- A REAL COLLISION, FOUND BY DRIVING THE CLI ----------------------
    //
    // `/session` and `/sessions` are different commands about different
    // subjects — live runtime state, and saved transcripts. The palette listed
    // matches in registry order, so typing the whole of `/session` and pressing
    // Enter ran `/sessions`. The user had typed a complete, unambiguous name
    // and got something else.
    const { commandPaletteAdapter } = require('../../src/ui/adapters');
    const commands = [
      { name: '/sessions', args: '[text]', desc: 'saved sessions' },
      { name: '/session', args: '[n]', desc: 'runtime sessions' },
    ];
    const a = commandPaletteAdapter({ commands, filter: '/session' });
    assert.strictEqual(a.items[0].command, '/session', 'the exact match must be the default');
    // AND NOTHING ELSE MOVED. A partial prefix keeps the order it had.
    const partial = commandPaletteAdapter({ commands, filter: '/sess' });
    assert.deepStrictEqual(partial.items.map((i) => i.command), ['/sessions', '/session']);
  });

  await test('RC: /session is safe during a turn — it only reads', () => {
    const commands = require('../../src/commands');
    // A command that could not run while work was running would be useless
    // precisely when it is wanted: a person checks on a session BECAUSE one is
    // busy. It may not be BLOCKED.
    const cmd = commands.REGISTRY.get('/session');
    assert.notStrictEqual(cmd.duringTurn, commands.DURING_TURN.BLOCKED, '/session must not block');
  });

  // ---- NO SECOND IMPLEMENTATION -------------------------------------------

  await test('RC: the Node half computes no session state of its own', () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', '..', 'src');
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // ---- THE VIEW MAY NOT DERIVE WHAT THE RUNTIME DECIDES -----------------
    //
    // §20: one runtime, several windows. A window that worked out for itself
    // whether a session was RUNNING would be a second authority, and on the day
    // the two disagreed there would be no way to say which was wrong. So the
    // terminal view is allowed to COLOUR the runtime's words and nothing else.
    const view = strip(fs.readFileSync(path.join(root, 'sessionview.js'), 'utf8'));
    for (const derived of ['owner_alive', 'in_flight', 'effective_state', 'turn_started_at', 'held_count']) {
      assert.ok(!view.includes(derived), `sessionview.js reads ${derived} — that is the runtime's job`);
    }
    // The client is a transport. It must not grow verbs of its own either.
    const client = strip(fs.readFileSync(path.join(root, 'remotecontrol.js'), 'utf8'));
    for (const f of ['getUpdates', 'sendMessage', 'api.telegram.org']) {
      assert.ok(!client.includes(f), `remotecontrol.js speaks ${f} — Telegram belongs to the runtime`);
    }
  });

  await test('RC: the terminal view colours the runtime words without rewriting them', () => {
    const { paint } = require('../../src/sessionview');
    const C = { cyan: (s) => `<c>${s}</c>`, green: (s) => `<g>${s}</g>`, yellow: (s) => `<y>${s}</y>`, dim: (s) => `<d>${s}</d>` };
    assert.strictEqual(paint('  RUNNING · 61%', C), '  <c>RUNNING</c> · 61%');
    // RATE_LIMITED must not be painted as if it contained LIMITED — a word
    // boundary, not a substring.
    assert.strictEqual(paint('  RATE_LIMITED', C), '  <y>RATE_LIMITED</y>');
    // A project genuinely called "Running Costs" is not a state word.
    assert.strictEqual(paint('+ 2. Running Costs', C), '+ 2. Running Costs');
    // Nothing is added, removed or reordered.
    const line = '  COMPLETED';
    assert.strictEqual(paint(line, C).replace(/<\/?[cgyd]>/g, ''), line);
  });

  // ---- DEGRADING WITHOUT A RUNTIME ----------------------------------------

  await test('RC: with no runtime answering, everything reports absence rather than guessing', async () => {
    const rc = require('../../src/remotecontrol');
    assert.strictEqual(rc.ABSENT.available, false);
    assert.strictEqual(rc.ABSENT.configured, false);
    assert.strictEqual(Object.isFrozen(rc.ABSENT), true, 'a shared "nothing" must not be mutable');
    // The capability door answers with `available: false` rather than throwing,
    // which is what lets `/session` say "no runtime is answering" instead of
    // showing an empty table that reads as "nothing is happening".
    const out = await rc.capability('session.list');
    assert.strictEqual(typeof out.available, 'boolean');
    assert.strictEqual(typeof out.ok, 'boolean');
  });
};
