'use strict';

/**
 * `/rc` AND `/session`, DRIVEN AS A PROGRAM.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS TIER ADDS over the integration one, which already proves pairing,
 * authorization, dedupe, the capability boundary and the model that invents a
 * number against the real binary.
 *
 * It proves the part a person actually touches: that typing these two commands
 * into a real LAIN, with a real terminal, produces the right screen — including
 * on the machine where none of this has been set up, which is every machine the
 * first time. A feature whose failure mode is a blank panel is a feature nobody
 * will report a bug about; they will simply decide it does not work.
 *
 * NOTHING HERE CONNECTS A BOT. There is no token to connect one with, and a
 * smoke test that asked for one would be a smoke test nobody could run. What is
 * asserted is the unconfigured path, which is the one that must not be a dead
 * end, and that `/session` degrades to a sentence rather than to an empty table.
 */

const assert = require('assert');

const { test, tmpdir, runCli, assertIncludes } = require('../helpers');

function plain(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');
}

const ENTER = String.fromCharCode(13);

module.exports = async function () {
  await test('RC: /rc on a machine with nothing set up explains itself and offers a way in', async () => {
    const cwd = tmpdir('lain-rc-none-');
    const r = await runCli([], {
      cwd,
      env: { LAIN_FORCE_TUI: '1' },
      // No turn, so no supervisor is woken. Asking about remote control must
      // not start a background process on a machine that has never used it.
      script: [],
      stdinSteps: [`/rc${ENTER}`, `/exit${ENTER}`],
      stepDelayMs: 1500,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);
    assertIncludes(out, 'Remote Control', 'the panel is drawn');
    assertIncludes(out, 'Telegram is not connected', 'and says plainly where it stands');
    // ---- IT EXPLAINS THE THREE LAYERS BEFORE ASKING FOR A CREDENTIAL ------
    //
    // A person about to paste a bot token is entitled to know what will hold it
    // and what will read their messages. "Telegram carries, a local model
    // interprets, the runtime answers" is the whole architecture in one line,
    // and it is the answer to the question they ask next.
    assertIncludes(out, 'A local model turns them into questions', 'the voice is local');
    // ---- AND THEN IT ASKS, THROUGH THE MASKED PANEL ----------------------
    //
    // Bare `/rc` on an unconfigured machine goes straight to the token prompt
    // rather than to a status screen about nothing.
    assertIncludes(out, 'TELEGRAM BOT TOKEN', 'the credential panel opens');
    assertIncludes(out, 'checked against Telegram before anything is stored', 'and says it proves it first');
    // AND IT MUST NOT CLAIM A CONNECTION IT DOES NOT HAVE.
    assert.ok(!/LISTENING/.test(out), 'nothing may read as connected');
    assert.ok(!/Authorized: 1/.test(out), 'nor as authorized');
  });

  await test('RC: /rc status changes nothing and asks for no token', async () => {
    const cwd = tmpdir('lain-rc-status-');
    const r = await runCli([], {
      cwd,
      env: { LAIN_FORCE_TUI: '1' },
      script: [],
      stdinSteps: [`/rc status${ENTER}`, `/exit${ENTER}`],
      stepDelayMs: 1500,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);
    assertIncludes(out, 'Remote Control');
    // `/rc status` IS A READ. It must never open the credential panel — a status
    // command that starts asking for secrets is a status command people stop
    // running.
    assert.ok(!/BOT TOKEN/i.test(out), '/rc status must not ask for a credential');
    assert.ok(!/Paste the bot token/i.test(out));
  });

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
    // THE RENAME MUST NOT HAVE LOST THE REPORT. `/rc` used to mean this; the
    // engine is unchanged and this is the test that would catch a rename that
    // quietly dropped it.
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
