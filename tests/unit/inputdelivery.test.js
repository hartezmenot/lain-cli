'use strict';

/**
 * DELIVERED IS NOT ACCEPTED — the unit half of the OS-input audit.
 *
 * Audited against the real lain-probe on 2026-08-21, with a TARGET PROCESS that
 * wrote every event it received to a file. That file, not the Probe's return
 * value, was the verdict:
 *
 *     window.focus        SUCCEEDED   (the foreground really changed)
 *     input.mouse.click   target receipt VERIFIED    — 1 click logged
 *     input.keyboard.tap  target receipt NOT VERIFIED — 0 keys logged
 *
 * Both reported ok. The asymmetry is structural, and traced to the source:
 *
 *   input.keyboard.*  SendInput with a virtual-key code and NO window. It lands
 *                     on whatever holds focus at that instant.
 *   input.mouse.*     SendInput at ABSOLUTE SCREEN COORDINATES. It lands on
 *                     whatever pixel is there, focus or no focus.
 *
 * And the Probe's own permission prompt is a TOPMOST window: granting keyboard
 * permission puts the Probe in front, so the keystroke that follows the grant
 * goes to the Probe. That is the reported "input only affects the Probe's own
 * window", exactly — not a broken input engine, an unaimed keystroke.
 *
 * THEY DRIVE `computer`, NOT `probe`, and that is the point rather than an
 * incidental detail. Screen and input used to be reachable under two names;
 * only one of them carried this sequence, so the model could aim a keystroke
 * or not depending on which spelling it guessed. There is one name now, and
 * these tests exercise it. The Probe still sees `window.focus` and
 * `input.keyboard.tap` on the wire — computer.js translates — so every
 * assertion below about ORDER, and about what was NOT sent, means what it
 * always meant. See unit/onecomputer.test.js for the subtraction itself.
 *
 * These pin the two things LAIN is responsible for: never sending a keystroke
 * it could not aim, and never calling an accepted injection a delivery.
 */

const assert = require('assert');
const { test } = require('../helpers');

const cap = require('../../src/capability');
const probeTool = require('../../src/tools/probe').tools.probe;
const computerTool = require('../../src/tools/computer').tools.computer;

/** A Probe double that records what LAIN asked it to do, and in what order. */
function fakeProbe({ focusOk = true, calls = [] } = {}) {
  return {
    state: 'CONNECTED',
    capabilities: ['input.keyboard.tap', 'window.focus'],
    calls,
    async call(op, params) {
      calls.push({ op, params });
      if (op === 'permission.state') {
        // BOTH GRANTS. Aiming needs `screen.capture` as well as the key needing
        // `keyboard.press` — window.focus lives in the Probe's VISION engine, so
        // it is gated behind screen capture. Measured live on 2026-08-21:
        // FOCUS_FAILED, "permission to screen.capture is not granted", with the
        // keyboard already allowed. See keyboarddelivery.AIM_CAPABILITY.
        return { ok: true, result: { capabilities: { 'keyboard.press': { granted: true }, 'screen.capture': { granted: true } }, prompter: true } };
      }
      if (op === 'target.status') return { ok: true, result: { authorized: false, reason: 'NO_AUTHORIZED_TARGET' } };
      if (op === 'window.focus') return { ok: true, result: { focused: focusOk, note: focusOk ? null : 'Windows refused the foreground change' } };
      return { ok: true, result: { tapped: params && params.key, summary: 'pressed' } };
    },
  };
}

const inputOnly = (calls) => calls.filter((c) => !['permission.state', 'target.status'].includes(c.op));

module.exports = async function () {
  // ------------------------------------------------- the five states apart --

  await test('DELIVERY: focus failure and unconfirmed delivery are their own states', () => {
    // Neither existed. Their absence is the whole reported bug: a keystroke
    // that went nowhere and a keystroke nobody watched arrive both reported ok.
    assert.ok(cap.STAGE.FOCUS_FAILED, 'FOCUS_FAILED must be a state');
    assert.ok(cap.STAGE.SENT_UNCONFIRMED, 'SENT_UNCONFIRMED must be a state');
    assert.notStrictEqual(cap.STAGE.SENT_UNCONFIRMED, cap.STAGE.SUCCEEDED);
  });

  await test('DELIVERY: a keystroke follows FOCUS; a click follows COORDINATES', () => {
    // The one fact the whole audit turns on.
    assert.strictEqual(cap.needsFocus('input.keyboard.tap'), true);
    assert.strictEqual(cap.needsFocus('input.keyboard.type'), true);
    assert.strictEqual(cap.needsFocus('input.mouse.click'), false, 'a click is aimed by coordinate, not by focus');
    assert.strictEqual(cap.aim('input.mouse.click'), 'SCREEN');
  });

  // --------------------------------------- focus before input, or no input --

  await test('FOCUS: a named window is focused BEFORE the keys, and verified again after', async () => {
    // WAS `['window.focus', 'input.keyboard.tap']` — one focus, then the key.
    // That was not enough: focusing establishes the foreground at the moment of
    // the call, and the reported failure happened in the gap AFTER it, when the
    // Probe's own topmost permission prompt took the foreground and the key
    // landed on the prompt. So the foreground is checked a SECOND time
    // immediately before the injection, and that check is what catches it.
    // See src/keyboarddelivery.js.
    const calls = [];
    const app = { _probe: fakeProbe({ focusOk: true, calls }) };
    const r = await computerTool.run({ op: 'key', key: 'a', window: 'TEST TARGET' }, { app });
    const seq = inputOnly(calls).map((c) => c.op);
    assert.deepStrictEqual(seq, ['window.focus', 'window.focus', 'input.keyboard.tap'],
      `focus must come first, and be re-checked immediately before the key: ${JSON.stringify(seq)}`);
    assert.ok(!r.isError, r.output);
  });

  await test('FOCUS: if the OS refuses the focus, NOTHING IS SENT', async () => {
    // The safety requirement. An unaimed keystroke goes into whatever the
    // person is looking at, which may be their editor.
    const calls = [];
    const app = { _probe: fakeProbe({ focusOk: false, calls }) };
    const r = await computerTool.run({ op: 'key', key: 'a', window: 'TEST TARGET' }, { app });
    assert.strictEqual(r.isError, true);
    assert.strictEqual(r.meta.state, 'FOCUS_FAILED');
    assert.match(r.output, /NOTHING WAS SENT/);
    assert.ok(!inputOnly(calls).some((c) => c.op === 'input.keyboard.tap'),
      `the key was sent anyway: ${JSON.stringify(inputOnly(calls).map((c) => c.op))}`);
  });

  await test('FOCUS: `window` is LAIN\'s argument and is not forwarded to the Probe', async () => {
    // Passing it on would be an unknown argument to an operation that never
    // had one — which the Probe would reject, turning a fix into a failure.
    const calls = [];
    const app = { _probe: fakeProbe({ calls }) };
    await computerTool.run({ op: 'key', key: 'a', window: 'TEST TARGET' }, { app });
    const tap = calls.find((c) => c.op === 'input.keyboard.tap');
    assert.ok(tap, 'the key was sent');
    assert.strictEqual(tap.params.window, undefined, `window leaked to the Probe: ${JSON.stringify(tap.params)}`);
    assert.strictEqual(tap.params.key, 'a', 'and the real arguments survived');
  });

  await test('FOCUS: a mouse click is NOT focus-gated — it is aimed by coordinate', async () => {
    const calls = [];
    const app = { _probe: fakeProbe({ focusOk: false, calls }) };
    const r = await computerTool.run({ op: 'click', x: 10, y: 20 }, { app });
    assert.ok(!r.isError, 'a click must not be refused for a focus it does not use');
    assert.ok(!calls.some((c) => c.op === 'window.focus'), 'and no focus is attempted for it');
  });

  // --------------------------------------------- accepted is not delivered --

  await test('EVIDENCE: an injected keystroke comes back SENT_UNCONFIRMED, never SUCCEEDED', async () => {
    const app = { _probe: fakeProbe({}) };
    const r = await computerTool.run({ op: 'key', key: 'a', window: 'T' }, { app });
    assert.strictEqual(r.meta.state, 'SENT_UNCONFIRMED');
    assert.match(r.output, /NOBODY OBSERVED THE TARGET RECEIVE IT/);
    assert.ok(!/SUCCEEDED/.test(r.output), 'the word SUCCEEDED must not appear for an unobserved delivery');
  });

  await test('EVIDENCE: injection and delivery are separate fields, and delivery is false', () => {
    const e = cap.envelope({
      op: 'input.keyboard.type', stage: cap.STAGE.SENT_UNCONFIRMED, aim: 'FOCUS', result: { typed: 3 },
    });
    assert.deepStrictEqual(e.evidence.injection, { requested: true, accepted: true });
    assert.deepStrictEqual(e.evidence.delivery, { verified: false, reason: 'TARGET_RECEIPT_NOT_OBSERVED' });
    assert.deepStrictEqual(e.evidence.result, { typed: 3 }, 'while what the far side said is still carried');
  });

  await test('EVIDENCE: a refused focus records the injection as NOT accepted', () => {
    const e = cap.envelope({ op: 'input.keyboard.tap', stage: cap.STAGE.FOCUS_FAILED, aim: 'FOCUS' });
    assert.deepStrictEqual(e.evidence.injection, { requested: true, accepted: false });
    assert.strictEqual(e.evidence.delivery.reason, 'FOCUS_FAILED');
  });

  await test('EVIDENCE: an operation that is not input still reports plainly', async () => {
    // The new states must not leak onto everything: `probe.status` succeeded,
    // and saying its delivery is unconfirmed would be nonsense.
    const app = { _probe: fakeProbe({}) };
    const r = await probeTool.run({ op: 'probe.status', params: {} }, { app });
    assert.ok(!/SENT_UNCONFIRMED|delivery/.test(r.output), r.output);
  });

  await test('CLAIM: the Probe reporting ok is never by itself evidence of delivery', () => {
    // The rule the audit exists to enforce, held as an assertion rather than a
    // comment: `{"ok":true}` from the far side maps to an UNCONFIRMED delivery.
    const e = cap.envelope({
      op: 'input.mouse.click', stage: cap.STAGE.SENT_UNCONFIRMED, aim: 'SCREEN',
      result: { clicked: true, at: [363, 245] },
    });
    assert.strictEqual(e.evidence.delivery.verified, false);
    assert.match(e.text, /an accepted injection is not a delivered keystroke/);
  });
};
