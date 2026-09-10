'use strict';

/**
 * `/session` AND `/ready`, DRIVEN AS A PROGRAM.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS TIER ADDS over the integration one, which already proves pairing,
 * authorization, dedupe, the capability boundary and the model that invents a
 * number against the real binary.
 *
 * It proves the part a person actually touches: that typing these commands
 * into a real LAIN, with a real terminal, produces the right screen — including
 * on the machine where none of this has been set up, which is every machine the
 * first time. A feature whose failure mode is a blank panel is a feature nobody
 * will report a bug about; they will simply decide it does not work.
 *
 * NOTHING HERE CONNECTS A BOT. The /rc command that set one up was removed
 * from LAIN CLI in 2026-09 (the supervisor capability wire survived — see
 * tests/integration/remote.test.js for the runtime side). What is asserted
 * here is the unconfigured path, which is the one that must not be a dead
 * end, and that `/session` degrades to a sentence rather than to an empty
 * table.
 */

const assert = require('assert');

const { test, tmpdir, runCli, assertIncludes } = require('../helpers');

function plain(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');
}

const ENTER = String.fromCharCode(13);

module.exports = async function () {
  await test('RC: /session with no runtime says so, rather than drawing an empty list', async () => {
    const cwd = tmpdir('lain-rc-session-');
    const r = await runCli([], {
      cwd,
      env: { LAIN_FORCE_TUI: '1' },
      script: [],
      stdinSteps: [`/session${ENTER}`, `/exit${ENTER}`],
      stepDelayMs: 1500,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);
    // "Nothing is happening" and "I could not ask" are different facts. A
    // surface that renders them identically reports a quiet healthy machine
    // when it is simply not connected to one.
    assertIncludes(out, 'No runtime is answering', 'it says it could not ask');
    assert.ok(!/LAIN SESSIONS/.test(out), 'and draws no list it has no data for');
  });

  await test('RC: /ready still reports LAIN readiness under its new name', async () => {
    // THE RENAME MUST NOT HAVE LOST THE REPORT. `/ready` is the readiness
    // engine's only name now — `/rc` used to mean this before it meant remote
    // control, and the command itself was removed in 2026-09. The engine is
    // unchanged and this is the test that would catch a removal that quietly
    // dropped the report with it.
    const cwd = tmpdir('lain-ready-');
    const r = await runCli([], {
      cwd,
      env: { LAIN_FORCE_TUI: '1' },
      script: [],
      stdinSteps: [`/ready${ENTER}`, `/exit${ENTER}`],
      stepDelayMs: 2000,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);
    // The readiness report's own vocabulary — see health.js.
    assert.ok(/stable|wired|missing|excluded/i.test(out), '/ready no longer reports readiness');
    // And it is NOT the remote-control panel.
    assert.ok(!/Telegram/i.test(out), '/ready must not have become remote control');
  });

  await test('RC: after a turn dies, /session names the conversation and what happened', async () => {
    const supervisor = require('../../src/supervisor');
    if (!supervisor.probe().available) {
      // DECLARED, NOT SILENT. A guarantee that quietly stopped being checked is
      // not a guarantee.
      assert.ok(supervisor.probe().why.includes('cargo build'));
      return;
    }
    const cwd = tmpdir('lain-rc-dead-');
    const r = await runCli([], {
      cwd,
      env: { LAIN_FORCE_TUI: '1' },
      script: [{ error: { status: 401, message: 'credential refused' } }, { text: 'ok.' }],
      stdinSteps: [`migrate the loader${ENTER}`, `/session${ENTER}`, `/exit${ENTER}`],
      // The supervisor starts with the first turn and takes about a second.
      stepDelayMs: 4000,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);
    assertIncludes(out, 'LAIN SESSIONS', 'the list is drawn from the runtime');
    // ---- THE SESSION IS NAMED, NOT NUMBERED ------------------------------
    //
    // The CLI reports the working directory as the name, so a person reading
    // three of these can tell which project is which.
    const project = require('path').basename(cwd);
    assertIncludes(out, project, 'and the conversation is named after its project');
    // A FAILED TURN IS A FAILED SESSION, in the session vocabulary rather than
    // the turn one — the distinction §9 asks for.
    assertIncludes(out, 'FAILED', 'and its state is stated');
    // AND NO PERCENTAGE, because nothing counted one.
    assert.ok(!/\d+%/.test(out), 'a session with no plan must not be given a percentage');
  });
};
