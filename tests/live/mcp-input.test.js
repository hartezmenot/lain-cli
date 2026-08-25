'use strict';

/**
 * END TO END, THROUGH EVERY STAGE, WITH A TARGET THAT DECIDES THE VERDICT.
 *
 *     request → permission → focus → verified foreground → OS input
 *             → the TARGET's own record → evidence
 *
 * The reported failure: a capability is granted, the Probe focuses the game and
 * reports success, LAIN reports that `W` was held, and the game does nothing.
 * Nothing in the suite could catch that, because every test of this seam used a
 * protocol double — and a double answers `{"ok": true}` whether or not an
 * operating system did anything, which is the exact failure being investigated.
 *
 * SO THE VERDICT COMES FROM THE TARGET. `tools/keywitness.js` opens a real
 * window in a real process and writes `KEY_DOWN W` to a file when it receives
 * `KEY_DOWN W`. That file is the whole of the evidence. Not the Probe's return
 * value, not SendInput's count, not the model's account.
 *
 * WHAT CHANGED, AND WHY THIS IS NOW ONE CLICK. The witness is launched by LAIN
 * rather than by the Probe, so this needs neither `python.execute` nor
 * `app.launch` — only `keyboard.press`. And the sequence asks for that BEFORE
 * it aims at anything (src/keyboarddelivery.js), because the Probe's prompt is
 * a topmost window: asking after focusing meant the prompt took the foreground
 * and the keystroke that followed the grant went to the prompt. One decision,
 * made before anything is aimed, and no re-clicking the target afterwards.
 *
 * WHY IT MAY DECLINE TO RUN. The Probe asks the person at the machine for
 * `keyboard.press` in its own window. A test cannot grant that and must not
 * try. With no answer it reports NEEDS USER ACTION and skips — loudly, naming
 * what is missing, because a silent skip here would turn an unverified
 * capability into a green run.
 *
 * IF THIS FAILS AND live/wininput.test.js PASSES, that is a real result and the
 * one this pair exists to produce: the machine CAN deliver a keystroke to a
 * focused window, and the Probe path cannot. The fault is then above the OS and
 * inside the LAIN → Probe → target chain.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('../helpers');

const probeMod = require('../../src/probe');
const cap = require('../../src/capability');
const kbd = require('../../src/keyboarddelivery');
const witnessMod = require('../../tools/keywitness');

const TITLE = 'LAIN KEY WITNESS';

/**
 * The Probe is configured per machine, so this test needs the REAL config —
 * and reads it, never writes it.
 *
 * OPT-IN ON PURPOSE. Running it launches the Probe, which opens a window on
 * whoever's desktop is in front of the machine and waits for a decision. A
 * suite that does that every time it runs is a suite people stop running, and
 * the isolation rule the rest of the tests obey exists precisely so a test run
 * cannot reach into the real config home. So this stays inert unless somebody
 * asks for it by name:
 *
 *     LAIN_PROBE_E2E=1 node tests/run.js live
 *
 * Without it the Probe input path is NOT VERIFIED, and the notice says so
 * rather than the run simply being green.
 */
function realConfig() {
  if (!process.env.LAIN_PROBE_E2E) return null;
  const dir = process.env.LAIN_REAL_CONFIG_DIR || path.join(os.homedir(), '.lain-v2');
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); } catch { return null; }
}

const settle = (ms = 700) => new Promise((r) => { setTimeout(r, ms); });

module.exports = async function () {
  const cfg = realConfig();
  if (!cfg) {
    process.stdout.write('  ~ NOT VERIFIED: the Probe input path was not exercised. '
      + 'Set LAIN_PROBE_E2E=1 to run it against the real Probe.\n');
    return;
  }
  const settings = probeMod.settings(cfg);
  if (!settings.ok) {
    process.stdout.write(`  ~ NOT VERIFIED: no Probe configured — the input path was not exercised (${settings.reason})\n`);
    return;
  }

  const probe = new probeMod.Probe(cfg, { session: { id: 'e2e-input' } });
  const conn = await probe.connect(process.cwd());
  if (!conn.ok) {
    process.stdout.write(`  ~ SKIPPED: the Probe would not start — the input path is NOT VERIFIED (${conn.reason})\n`);
    return;
  }

  try {
    const state = await cap.readState(probe);

    await test('MCP E2E: the capability path is READABLE — connected, granted and aimed are separable', async () => {
      // The first thing that was missing: a way to see WHERE the path stops.
      assert.strictEqual(state.connected, true);
      assert.ok(state.operations.length > 0, 'the Probe offers operations');
      assert.ok(state.capabilities || state.notes.some((n) => /UNKNOWN/.test(n)),
        'either the capability table is readable or it is explicitly UNKNOWN');
      assert.ok(state.target || state.notes.some((n) => /UNKNOWN/.test(n)),
        'either the target state is readable or it is explicitly UNKNOWN');
    });

    await test('COMPUTER: an operation in LAINs own words reaches a real bridge', async () => {
      // THE OWNERSHIP CORRECTION, end to end. The model asks for `windows` —
      // LAIN's word — and LAIN translates it, carries it on whichever transport
      // is connected, and names which one did it. `windows` needs no capability,
      // so this runs unattended and tests the seam rather than the permission.
      const computer = require('../../src/computer');
      const r = await computer.perform({ _probe: probe }, 'windows', {});
      assert.strictEqual(r.stage, cap.STAGE.SUCCEEDED,
        'the operation did not complete:' + kbd.trailLines(r.trail).join(' | '));
      assert.strictEqual(r.transport, 'probe', 'and the evidence names which bridge carried it');
      assert.ok(r.result && Array.isArray(r.result.windows),
        'a real window list must come back: ' + JSON.stringify(r.result).slice(0, 200));
    });

    // ---- THE FULL PATH ----------------------------------------------------
    //
    // No pre-flight grant check and no skip-if-ungranted any more: the sequence
    // asks for the capability itself, and asking at the right moment is the fix
    // under test. If nobody answers the prompt it comes back REFUSED, which is
    // reported as NEEDS USER ACTION rather than as a failure of the code.

    const witness = await witnessMod.start({
      log: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-e2e-')), 'witness.log'),
      title: TITLE,
      seconds: 240,
    });
    let answered = true;

    try {
      await settle();

      await test('MCP E2E: window.focus really moves the foreground, with another app in front', async () => {
        // NEEDS NO PERMISSION, so it runs unattended — and it is the half of
        // the failure that had nothing to do with permission at all.
        //
        // A bare SetForegroundWindow is REFUSED whenever another application
        // owns the foreground. Measured here on 2026-08-21: with a browser in
        // front, the Probe's window.focus reported `focused: false` every time
        // — honestly — and since a key may not be sent without a verified
        // foreground, keyboard input to anything not already in front simply
        // never happened. The fix is AttachThreadInput, in the Probe's own
        // vision engine, and the witness's log is what proves it moved.
        const before = witness.events().length;
        const r = await probe.call('window.focus', { window: TITLE }, 20_000);
        assert.ok(r.ok, `window.focus failed outright: ${r.error}`);
        await settle(500);
        assert.strictEqual(r.result && r.result.focused, true,
          `the Probe could not take the foreground: ${JSON.stringify(r.result)}`);
        // AND THE TARGET AGREES. `focused: true` is the Probe reading
        // GetForegroundWindow back; this is the window itself saying it was
        // activated, which is a different observer.
        const gained = witness.events().slice(before).some((e) => e.event === 'FOREGROUND gained');
        assert.ok(gained,
          `the Probe said it focused the window and the window never noticed:\n${
            witness.events().slice(before).map((e) => e.event).join('\n') || '(nothing)'}`);
      });

      await test('MCP E2E: a real keystroke reaches a real window, proved by what that window wrote', async () => {
        const r = await kbd.deliver({
          probe,
          op: 'input.keyboard.tap',
          params: { key: 'W' },
          window: TITLE,
          capability: 'keyboard.press',
          reason: 'to prove a keystroke reaches the window it was aimed at',
        });

        if (r.stage === cap.STAGE.REFUSED) {
          answered = false;
          // NOT A FAILURE OF THE CODE, and it must not be recorded as one.
          // Nobody answered the prompt, nothing was sent, nothing is verified.
          process.stdout.write(
            '  ~ NEEDS USER ACTION: keyboard.press was not granted — the Probe asks in its own\n'
            + '    window and a test cannot answer for you. NOTHING WAS SENT and the Probe input\n'
            + '    path is NOT VERIFIED on this run.\n');
          return;
        }

        assert.strictEqual(r.stage, cap.STAGE.SENT_UNCONFIRMED,
          `the sequence did not reach the injection:\n${kbd.trailLines(r.trail).join('\n')}`);

        await settle(900);
        // ---- THE VERDICT IS THE TARGET'S OWN RECORD -------------------------
        assert.ok(witness.received('KEY_DOWN W'),
          'KEYBOARD EXTERNAL DELIVERY: NOT VERIFIED — the OS accepted the injection with the '
          + `target verified in front, and the target received nothing.\nSEQUENCE:\n${
            kbd.trailLines(r.trail).join('\n')}\nTARGET RECORDED:\n${
            witness.events().map((e) => e.event).join('\n') || '(nothing)'}`);
        assert.ok(witness.received('KEY_UP W'), 'and the release must arrive too');
      });

      if (answered) {
        await test('MCP E2E: a HOLD is two edges with real time between them, at the target', async () => {
          // "LAIN says W is being held but the game does nothing." A hold is not
          // one successful call: KEY_DOWN, a held state, KEY_UP — and the target
          // must be able to prove all three.
          const HELD_MS = 1200;
          const before = witness.events().length;
          const r = await kbd.hold({ probe, key: 'W', ms: HELD_MS, window: TITLE });
          assert.strictEqual(r.stage, cap.STAGE.SENT_UNCONFIRMED,
            `the hold did not complete:\n${kbd.trailLines(r.trail).join('\n')}`);

          await settle(900);
          const fresh = witness.events().slice(before);
          const d = fresh.find((e) => e.event === 'KEY_DOWN W');
          const u = [...fresh].reverse().find((e) => e.event === 'KEY_UP W');
          assert.ok(d, `the target never received the key DOWN:\n${fresh.map((e) => e.event).join('\n')}`);
          assert.ok(u, `the target got the down and never the UP — a key left held:\n${
            fresh.map((e) => e.event).join('\n')}`);
          assert.ok(u.at - d.at >= HELD_MS * 0.5,
            `the target saw it held for ${u.at - d.at}ms of an intended ${HELD_MS}ms — `
            + 'a down and an up delivered back to back is not a hold');
        });
      }

      await test('MCP E2E: an unaimed keystroke is refused, whatever the permission says', async () => {
        // The rule the whole path turns on, and it must hold even with a grant
        // in hand: without a window there is nothing to verify in front, and a
        // key sent now goes into whatever the person is looking at.
        const r = await kbd.deliver({
          probe, op: 'input.keyboard.tap', params: { key: 'W' }, window: '', capability: 'keyboard.press',
        });
        assert.strictEqual(r.stage, cap.STAGE.FOCUS_FAILED);
        assert.match(r.why, /NOTHING WAS SENT/);
      });
    } finally { witness.stop(); }
  } finally {
    probe.close('the end-to-end test finished');
  }
};
