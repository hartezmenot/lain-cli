'use strict';

/**
 * CAN A SYNTHESISED KEYSTROKE REACH AN EXTERNAL WINDOW ON THIS MACHINE AT ALL?
 *
 * THE REPORT this answers: LAIN asked for keyboard input, the Probe focused the
 * game and said so, LAIN said `W` was held — and the game did nothing. Two
 * completely different things produce that, with identical symptoms:
 *
 *   A. the ORDER is wrong — something takes the foreground between the aim and
 *      the injection, and the key goes to that instead
 *   B. the MACHINE refuses — Windows will not deliver injected input to that
 *      window, and nothing above it can fix that
 *
 * Guessing between them is how an investigation searches the wrong half of the
 * system for a week. So this establishes B, on its own, with no Probe and no
 * permission prompt in the way: a real external window that logs what it
 * receives, and one key sent to it with the foreground verified first.
 *
 * THE VERDICT COMES FROM THE TARGET. Not from SendInput's return count, which
 * means only that Windows queued the events; not from anything LAIN reports.
 * The witness window writes `KEY_DOWN W` when it gets `KEY_DOWN W`, and that
 * file is the whole of the evidence.
 *
 * WHAT THIS IS NOT. It is not a capability. `tools/wininput.js` is test
 * apparatus, is required by nothing in `src/`, and no model can reach it —
 * lain-probe owns OS input and that has not changed. See that file's header.
 *
 * WHAT IT IS NOT EVIDENCE OF. A green run here says the machine can deliver a
 * keystroke to a focused window. It says NOTHING about any transport-mediated
 * path — a real permission prompt and a real foreground change between the aim
 * and the injection. That verdict belonged to live/mcp-input.test.js, which was
 * removed with the Probe transport in 2026-09; a transport that can verify the
 * foreground will need its own such test before anything claims delivery
 * through it.
 *
 * IT PUTS A WINDOW ON THE SCREEN for about three seconds and takes the
 * foreground for that time. That is the cost of testing this honestly; a test
 * that avoids it is a test that proves nothing about input.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { test } = require('../helpers');

const witnessMod = require('../../tools/keywitness');
const win = require('../../tools/wininput');

const TITLE = 'LAIN KEY WITNESS';

function logPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-key-'));
  return path.join(dir, `${name}.log`);
}

/** Give the target's message loop a moment to record what it was sent. */
const settle = (ms = 600) => new Promise((r) => { setTimeout(r, ms); });

/**
 * A DESKTOP THAT WILL NOT LET GO OF THE FOREGROUND CANNOT ANSWER THE QUESTION.
 *
 * Measured on this machine mid-run: a fullscreen game kept taking the
 * foreground back within the 250ms between raising the witness and reading the
 * foreground, so the aim could not be held and — correctly — nothing was sent.
 *
 * That is neither a pass nor a failure. It is a desktop the question cannot be
 * asked on, and the only honest outcome is NOT VERIFIED with the name of the
 * window that is holding it. Reporting it as a failure would blame the code for
 * the user having a game open; reporting it as a pass would be the false green
 * this whole area exists to eliminate.
 *
 * A few attempts first, because the foreground is contended rather than locked.
 *
 * @returns {{ok:boolean, why:string}}
 */
function aim(pid, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = win.focus(pid, TITLE);
    if (last.ok) return { ok: true, why: '' };
  }
  const front = win.foreground();
  return {
    ok: false,
    why: `${front ? `"${front}"` : 'something else'} is holding the foreground`
      + ` (${last && last.why ? last.why : 'the aim could not be established'})`,
  };
}

function notVerified(why) {
  process.stdout.write(`  ~ NOT VERIFIED: ${why}. Nothing was sent, and nothing is proved either way.\n`);
}

module.exports = async function () {
  if (process.platform !== 'win32') {
    process.stdout.write('  ~ NOT VERIFIED: keyboard delivery is a Windows question and this is not Windows\n');
    return;
  }

  await test('WIN INPUT: an external window receives a key sent to it, and says so itself', async () => {
    const w = await witnessMod.start({ log: logPath('tap'), title: TITLE, seconds: 25 });
    try {
      await settle(700);

      // AIM FIRST, AND VERIFY. Nothing is sent otherwise — see wininput.js.
      const f = aim(w.pid);
      if (!f.ok) { notVerified(f.why); return; }

      const t = win.tap(w.pid, win.VK.W, { title: TITLE });
      if (!t.down.sent || !t.up.sent) {
        notVerified(`the aim was lost between the two edges — ${(t.up || t.down).why}`);
        return;
      }

      await settle();
      // THE ONLY LINE THAT DECIDES ANYTHING. Everything above is the sender's
      // account of itself; this is the target's.
      assert.ok(w.received('KEY_DOWN W'),
        `THE TARGET RECEIVED NOTHING. Accepted by the OS and never delivered:\n${
          w.events().map((e) => e.event).join('\n')}`);
      assert.ok(w.received('KEY_UP W'), 'and the release must arrive too');
    } finally { w.stop(); }
  });

  await test('WIN INPUT: a HOLD is two edges with real time between them, measured at the target', async () => {
    // "LAIN says W is being held but the game does nothing." A hold is not one
    // successful call — it is KEY_DOWN, a held state, KEY_UP, and the target
    // has to be able to prove all three. The duration is read from the target's
    // own timestamps, so it is the interval the TARGET experienced.
    const HELD_MS = 1200;
    const w = await witnessMod.start({ log: logPath('hold'), title: TITLE, seconds: 25 });
    try {
      await settle(700);
      const f = aim(w.pid);
      if (!f.ok) { notVerified(f.why); return; }
      const down = win.key(w.pid, win.VK.W, { up: false, title: TITLE });
      if (!down.sent) { notVerified(`the key down could not be aimed — ${down.why}`); return; }
      await settle(HELD_MS);
      const up = win.key(w.pid, win.VK.W, { up: true, title: TITLE });
      // A KEY THAT WENT DOWN AND COULD NOT BE LIFTED IS A REAL FAILURE, not an
      // unanswerable question — it is a key still held on the user's machine.
      assert.strictEqual(up.sent, true,
        `the key went DOWN and the release could not be aimed: ${up.why}`);
      await settle();

      const events = w.events();
      const d = events.find((e) => e.event === 'KEY_DOWN W');
      const u = [...events].reverse().find((e) => e.event === 'KEY_UP W');
      assert.ok(d, `the target never received the key DOWN:\n${events.map((e) => e.event).join('\n')}`);
      assert.ok(u, `the target received the down and never the UP — a key left held:\n${
        events.map((e) => e.event).join('\n')}`);
      const held = u.at - d.at;
      assert.ok(held >= HELD_MS * 0.5,
        `the target saw the key held for only ${held}ms of an intended ${HELD_MS}ms — `
        + 'a down and an up delivered back to back is not a hold');
    } finally { w.stop(); }
  });

  await test('WIN INPUT: with the target NOT in front, nothing is sent at all', async () => {
    // The rule the whole path turns on, tested from the failing side: an
    // unaimed keystroke goes into whatever the person is looking at. A pid with
    // no window cannot be verified in front, so the answer must be refusal —
    // not a best-effort send.
    const noWindow = process.pid;          // this test process has no window
    const r = win.key(noWindow, win.VK.W, { up: false, title: TITLE });
    assert.strictEqual(r.sent, false, 'a key was sent at an unverified foreground');
    assert.match(r.why, /NOTHING WAS SENT/, 'and it must say so in those words');
  });

  await test('WIN INPUT: the witness is trustworthy — an untouched window records no keys', async () => {
    // If the witness silently recorded nothing, every NOT VERIFIED verdict it
    // ever gave would be meaningless. So: it reports what it got when it got
    // something, and reports nothing when it got nothing.
    const w = await witnessMod.start({ log: logPath('quiet'), title: TITLE, seconds: 20 });
    try {
      await settle(900);
      const keys = w.events().filter((e) => /^KEY_/.test(e.event));
      assert.strictEqual(keys.length, 0, `the witness invented events: ${JSON.stringify(keys)}`);
      assert.ok(w.events().some((e) => e.event.startsWith('READY')),
        'and it must still be alive and recording');
    } finally { w.stop(); }
  });
};
