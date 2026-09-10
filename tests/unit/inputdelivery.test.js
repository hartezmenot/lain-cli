'use strict';

/**
 * DELIVERED IS NOT ACCEPTED — the unit half of the OS-input audit.
 *
 * Audited against the real lain-probe on 2026-08-21, with a TARGET PROCESS that
 * wrote every event it received to a file. That file, not the far side's return
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
 * THE SEQUENCE the audit produced — permission first, then focus, then a
 * second foreground check immediately before the key, and NOTHING sent when it
 * cannot be aimed — has exactly one home, keyboarddelivery.js, and its order
 * and refusals are pinned by that suite (keyboarddelivery.test.js) driving the
 * sequence with a transport double. It speaks the Probe dialect because that is
 * the dialect the audit measured; the transport that carried it was removed
 * from LAIN CLI with the Probe integration in 2026-09, and the sequence is kept
 * for whatever transport can verify the foreground next — until one exists,
 * computer.js refuses keyboard input outright rather than send an unverified
 * keystroke through the desktop bridge.
 *
 * What is pinned HERE is the EVIDENCE VOCABULARY that audit made necessary:
 * the states that tell a refused aim from an unwatched delivery, and the
 * envelope fields that keep `accepted` and `delivered` from collapsing into
 * one word. Machine delivery is proven only by a target that logs what it
 * received — see live/wininput.test.js — and nothing here may claim it.
 */

const assert = require('assert');
const { test } = require('../helpers');

const cap = require('../../src/capability');

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

  // --------------------------------------------- accepted is not delivered --

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

  await test('CLAIM: the far side reporting ok is never by itself evidence of delivery', () => {
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
