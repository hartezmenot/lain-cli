'use strict';

/**
 * LAIN'S OWN COMPUTER OPERATIONS — the ownership correction.
 *
 * WHAT WAS WRONG. Clicking, typing, focusing and seeing were all
 * `LAIN → Probe → capability`: the model named a FOREIGN operation string and a
 * foreign result came back, which made the Probe the owner of using the machine
 * and LAIN a pipe. say that is backwards.
 *
 * So what is pinned here is OWNERSHIP, not plumbing:
 *
 *   · the vocabulary is LAIN's — `click`, never `mouse.click`
 *   · the aim, the order and the refusal are LAIN's
 *   · a transport performs the syscall and decides nothing
 *   · a transport that cannot do something says so rather than having
 *     something similar substituted
 *
 * The desktop bridge is the one transport now (the Probe transport was removed
 * from LAIN CLI with the Probe integration in 2026-09), so "interchangeable" is
 * proven here with one carrier and kept honest by the dialect table: the day a
 * transport that can verify the foreground reappears, computer.js's FOCUS
 * branch becomes live again without being rewritten.
 *
 * A DOUBLE PROVES NONE OF IT ARRIVED ANYWHERE. Delivery is decided by a target
 * that logs what it received — see live/wininput.test.js.
 */

const assert = require('assert');
const { test } = require('../helpers');

const computer = require('../../src/computer');
const cap = require('../../src/capability');
const tool = require('../../src/tools/computer');

/** A desktop-bridge double that records the FOREIGN op names LAIN chose to send. */
function fakeBridge({ focus = true, fails = false, deny = null } = {}) {
  const calls = [];
  const app = {
    desktop: () => ({
      bridge: {
        calls,
        async call(op, params = {}) {
          calls.push({ op, params });
          if (deny && op === deny) return { ok: false, denied: true, capability: deny, error: 'refused' };
          if (fails) return { ok: false, error: 'the far side said no' };
          if (op === 'window.focus') {
            return { ok: true, result: { focused: focus, title: params.window, note: focus ? null : 'refused' } };
          }
          if (op === 'screen.capture') return { ok: true, result: { file: 'b.png', width: 1920, height: 1080 } };
          if (op === 'window.list') return { ok: true, result: { windows: [{ title: 'GAME' }] } };
          return { ok: true, result: { ok: true } };
        },
      },
    }),
  };
  return { app, calls };
}

module.exports = async function () {
  // ------------------------------------------------------- THE VOCABULARY --

  await test('OWNERSHIP: the model names what it WANTS, never a foreign op string', () => {
    // `click`, not `mouse.click`. The foreign spelling exists in exactly
    // one table and nothing above it ever sees one.
    for (const name of computer.NAMES) {
      assert.ok(!name.includes('.'), `${name} is a foreign operation name leaking into LAIN's vocabulary`);
    }
    assert.deepStrictEqual(computer.NAMES,
      ['windows', 'focus', 'screenshot', 'ocr', 'move', 'click', 'type', 'key', 'hold']);
  });

  await test('OWNERSHIP: LAIN translates to the dialect the transport speaks', async () => {
    const b = fakeBridge();
    const shot = await computer.perform(b.app, 'screenshot', {});
    assert.strictEqual(shot.stage, cap.STAGE.SUCCEEDED);
    assert.ok(b.calls.some((c) => c.op === 'screen.capture'), 'the bridge dialect');
    const click = await computer.perform(b.app, 'click', { x: 10, y: 20 });
    assert.strictEqual(click.transport, 'desktop');
    assert.ok(b.calls.some((c) => c.op === 'mouse.click'), 'one vocabulary, translated at the boundary');
  });

  await test('OWNERSHIP: a transport that CANNOT do something says so, not something similar', async () => {
    // The bridge has no OCR. Substituting a screenshot would be LAIN inventing
    // an answer to a question nobody could answer.
    const b = fakeBridge();
    const r = await computer.perform(b.app, 'ocr', {});
    assert.strictEqual(r.stage, cap.STAGE.BRIDGE_LOST);
    assert.match(r.why, /cannot ocr/);
    assert.strictEqual(b.calls.length, 0, 'and nothing was attempted');
  });

  await test('OWNERSHIP: with nothing connected it is BRIDGE_LOST, and nothing is attempted', async () => {
    const r = await computer.perform({}, 'click', { x: 1, y: 1 });
    assert.strictEqual(r.stage, cap.STAGE.BRIDGE_LOST);
    assert.match(r.why, /nothing is connected/);
  });

  // ------------------------------------------------ AIM, AND WHAT IT MEANS --

  await test('AIM: a keystroke is FOCUS-aimed and a click is SCREEN-aimed', () => {
    // The asymmetry the whole design turns on: merging them into "input" is how
    // a click succeeded while a keystroke went nowhere and both reported ok.
    assert.strictEqual(computer.OPS.key.aim, 'FOCUS');
    assert.strictEqual(computer.OPS.type.aim, 'FOCUS');
    assert.strictEqual(computer.OPS.hold.aim, 'FOCUS');
    assert.strictEqual(computer.OPS.click.aim, 'SCREEN');
    assert.strictEqual(computer.OPS.move.aim, 'SCREEN');
    assert.strictEqual(computer.OPS.screenshot.aim, 'NONE', 'a read endangers nothing');
  });

  await test('AIM: typing without a window is refused before anything is attempted', async () => {
    const b = fakeBridge();
    const r = await tool.tools.computer.run({ op: 'type', text: 'hello' }, { app: b.app });
    assert.strictEqual(r.isError, true);
    assert.match(r.output, /NOTHING WAS SENT/);
    assert.strictEqual(b.calls.length, 0, 'not even a permission read');
  });

  await test('AIM: clicking without coordinates is refused, and says why a window will not do', async () => {
    const b = fakeBridge();
    const r = await tool.tools.computer.run({ op: 'click', window: 'GAME' }, { app: b.app });
    assert.strictEqual(r.isError, true);
    assert.match(r.output, /screen coordinate, not at a window/);
    assert.strictEqual(b.calls.length, 0);
  });

  await test('AIM: keyboard through the desktop bridge is REFUSED, with the reason', async () => {
    // The bridge cannot verify the foreground before each keystroke, and an
    // unverified keystroke goes wherever the user is looking. The delivery
    // sequence itself (permission → focus → verify → inject) has exactly one
    // home, keyboarddelivery.js, which this proves nothing about — its own
    // suite drives it with a transport double.
    const b = fakeBridge();
    const r = await computer.perform(b.app, 'key', { key: 'W' }, { window: 'GAME' });
    assert.strictEqual(r.stage, cap.STAGE.FAILED);
    assert.match(r.why, /verify the foreground/);
    assert.ok(!b.calls.some((c) => c.op === 'keyboard.key'));
  });

  // ------------------------------------------------------------- EVIDENCE --

  await test('EVIDENCE: a READ succeeds; an injected click is SENT_UNCONFIRMED', async () => {
    const b = fakeBridge();
    const read = await computer.perform(b.app, 'screenshot', {});
    assert.strictEqual(read.stage, cap.STAGE.SUCCEEDED,
      'there is nothing unconfirmed about a picture that came back');
    const click = await computer.perform(b.app, 'click', { x: 5, y: 5 });
    assert.strictEqual(click.stage, cap.STAGE.SENT_UNCONFIRMED,
      'the OS accepted a coordinate; nothing observed which window was under it');
  });

  await test('EVIDENCE: focus reports the VERIFIED answer, not the API return', async () => {
    const ok = await computer.perform(fakeBridge({ focus: true }).app, 'focus', {}, { window: 'GAME' });
    assert.strictEqual(ok.stage, cap.STAGE.SUCCEEDED);
    const no = await computer.perform(fakeBridge({ focus: false }).app, 'focus', {}, { window: 'GAME' });
    assert.strictEqual(no.stage, cap.STAGE.FOCUS_FAILED);
    assert.match(no.why, /did not put GAME in front/);
  });

  await test('EVIDENCE: the trail names every stage, and the transport is named too', async () => {
    const b = fakeBridge();
    const r = await computer.perform(b.app, 'screenshot', {});
    assert.deepStrictEqual(r.trail.map((t) => t.stage),
      [cap.STAGE.REQUESTED, cap.STAGE.EXECUTING, cap.STAGE.SUCCEEDED]);
    assert.strictEqual(r.transport, 'desktop', '"which bridge did this" is part of the evidence');
  });

  await test('EVIDENCE: a denial is final and says so', async () => {
    const b = fakeBridge({ deny: 'screen.capture' });
    const r = await computer.perform(b.app, 'screenshot', {});
    assert.strictEqual(r.stage, cap.STAGE.REFUSED);
    assert.match(r.why, /Do not ask again/);
  });

  // -------------------------------------------------------- THE BOUNDARY --

  await test('BOUNDARY: LAIN performs no syscall of its own', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/computer.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of ['SendInput', 'user32', 'child_process', 'spawn', 'ffi']) {
      assert.ok(!src.includes(forbidden),
        `the syscall belongs to the bridge — LAIN owns the operation (${forbidden})`);
    }
  });

  await test('BOUNDARY: the vocabulary is screen and input, and stays that way', () => {
    // Memory, breakpoints, disassembly and findings belong to an external
    // instrument, not to using the computer. (This was the boundary against the
    // Probe's domain; the Probe is gone from LAIN CLI, and the rule keeps the
    // vocabulary from growing into whatever external instrument comes next.)
    for (const op of ['memory.read', 'debug.attach', 'finding.save']) {
      assert.ok(!computer.NAMES.includes(op.split('.')[0]),
        `${op} is an external instrument's domain and must not be absorbed`);
    }
  });

  await test('BOUNDARY: it is offered only while a transport is connected', () => {
    const registry = require('../../src/tools/index');
    // Nothing is connected in a plain unit run, so the model is never told the
    // machine can be driven — and cannot try.
    assert.ok(!registry.has('computer'),
      'a tool for a bridge that is not there is an offer that cannot be kept');
  });
};
