'use strict';

/**
 * THE ORDER A KEYSTROKE IS SENT IN.
 *
 * The reported failure: LAIN asked for keyboard input, the Probe focused the
 * game and reported success, LAIN reported that `W` was held, and the game did
 * nothing. The cause is an ordering, and an ordering is exactly what a unit
 * test can pin down — the calls the sequence makes, in the order it makes them,
 * against a double that records them.
 *
 * WHAT A DOUBLE CAN AND CANNOT ESTABLISH. It proves the ORDER, the refusals and
 * the guarantees. It proves nothing whatever about a key arriving anywhere: a
 * double answers `{ok:true}` whether or not an operating system did anything,
 * which is the very failure under investigation. Delivery is decided by a
 * target that logs what it received — live/wininput.test.js for the machine,
 * live/mcp-input.test.js for the Probe path — and nothing here may claim it.
 */

const assert = require('assert');
const { test } = require('../helpers');

const kbd = require('../../src/keyboarddelivery');
const cap = require('../../src/capability');

/**
 * A Probe that records every call and answers however the test needs.
 *
 * `focusAfter` is the one that matters: it makes `window.focus` start
 * succeeding only after N calls, or stop succeeding after N — which is how the
 * foreground being stolen between the aim and the injection is reproduced
 * without a desktop.
 */
function fakeProbe({ granted = true, focus = true, focusSeq = null, opFails = false, denied = false } = {}) {
  const calls = [];
  let focusCalls = 0;
  return {
    calls,
    ops() { return calls.map((c) => c.op); },
    async call(op, params = {}, ms = 0) {
      calls.push({ op, params, ms });
      if (op === 'permission.state') {
        // TWO capabilities, because the sequence needs two: the key needs
        // `keyboard.press` and AIMING it needs `screen.capture`, which is what
        // the Probe gates window.focus behind.
        return {
          ok: true,
          result: {
            capabilities: {
              'keyboard.press': { granted: Boolean(granted) },
              'screen.capture': { granted: Boolean(granted) },
            },
          },
        };
      }
      if (op === 'permission.request') {
        return { ok: true, result: { granted: Boolean(granted), summary: granted ? 'granted' : 'denied: the user said no' } };
      }
      if (op === 'window.focus') {
        const ok = focusSeq ? Boolean(focusSeq[focusCalls]) : Boolean(focus);
        focusCalls++;
        return { ok: true, result: { focused: ok, title: params.window, note: ok ? null : 'Windows refused the foreground change' } };
      }
      if (opFails) return { ok: false, error: 'the far side said no' };
      if (denied) return { ok: false, denied: true, capability: 'keyboard.press', error: 'refused' };
      return { ok: true, result: { ok: true } };
    },
  };
}

const args = { op: 'input.keyboard.tap', params: { key: 'W' }, window: 'GAME', capability: 'keyboard.press' };

module.exports = async function () {
  // ---------------------------------------------------------- THE ORDER --

  await test('ORDER: permission is asked for BEFORE the window is aimed', async () => {
    // THE WHOLE BUG. The Probe's prompt is a topmost window and takes the
    // foreground; asking after focusing means the key that follows the grant
    // lands on the prompt. Asking first lets it steal a foreground nobody is
    // relying on yet.
    // Ungranted to begin with, and the user says yes when asked — the ordinary
    // first-use case, and the one the reported failure happened in.
    const p = {
      calls: [],
      ops() { return this.calls.map((c) => c.op); },
      async call(op, params = {}) {
        this.calls.push({ op, params });
        if (op === 'permission.state') return { ok: true, result: { capabilities: { 'keyboard.press': { granted: false } } } };
        if (op === 'permission.request') return { ok: true, result: { granted: true, summary: 'granted' } };
        if (op === 'window.focus') return { ok: true, result: { focused: true, title: params.window } };
        return { ok: true, result: { ok: true } };
      },
    };

    const r = await kbd.deliver({ probe: p, ...args });
    const ops = p.ops();
    assert.ok(ops.indexOf('permission.request') >= 0, 'it must ask');
    assert.ok(ops.indexOf('permission.request') < ops.indexOf('window.focus'),
      `permission must come first, not after the aim: ${ops.join(' → ')}`);
    assert.strictEqual(r.stage, cap.STAGE.SENT_UNCONFIRMED);
  });

  await test('ORDER: the full sequence is permission → focus → verify again → inject', async () => {
    const p = fakeProbe({ granted: true });
    await kbd.deliver({ probe: p, ...args });
    // TWO permission reads, one per capability: the key needs keyboard.press
    // and AIMING it needs screen.capture, because the Probe implements
    // window.focus in its vision engine. Both are settled BEFORE the first
    // focus, so no prompt can appear between the aim and the key.
    assert.deepStrictEqual(p.ops(),
      ['permission.state', 'permission.state', 'window.focus', 'window.focus', 'input.keyboard.tap'],
      'and the foreground is checked a SECOND time immediately before the key');
  });

  await test('ORDER: an already-granted capability is not asked for again', async () => {
    const p = fakeProbe({ granted: true });
    await kbd.deliver({ probe: p, ...args });
    assert.ok(!p.ops().includes('permission.request'),
      'a prompt the user has already answered is a prompt they learn to click through');
  });

  // ------------------------------------------------- NOTHING IS SENT WHEN --

  await test('REFUSAL: a denied capability sends nothing and says it is final', async () => {
    const p = fakeProbe({ granted: false });
    const r = await kbd.deliver({ probe: p, ...args });
    assert.strictEqual(r.stage, cap.STAGE.REFUSED);
    assert.ok(!p.ops().includes('input.keyboard.tap'), 'nothing may be injected after a refusal');
    assert.match(r.why, /Nothing was sent/);
    assert.match(r.why, /Do not ask again/, 'a denial that can be worn down is not a denial');
  });

  await test('FOCUS_FAILED: the OS refusing the foreground means NOTHING WAS SENT', async () => {
    const p = fakeProbe({ granted: true, focus: false });
    const r = await kbd.deliver({ probe: p, ...args });
    assert.strictEqual(r.stage, cap.STAGE.FOCUS_FAILED);
    assert.ok(!p.ops().includes('input.keyboard.tap'));
    assert.match(r.why, /NOTHING WAS SENT/);
  });

  await test('FOCUS_FAILED: losing the foreground BETWEEN the aim and the key is caught', async () => {
    // The exact shape of the reported failure: the window really did come up,
    // and something took the foreground before the key went. Without the second
    // check this injects into whatever stole it.
    const p = fakeProbe({ granted: true, focusSeq: [true, false] });
    const r = await kbd.deliver({ probe: p, ...args });
    assert.strictEqual(r.stage, cap.STAGE.FOCUS_FAILED);
    assert.ok(!p.ops().includes('input.keyboard.tap'),
      'a key sent now goes to whatever stole the foreground');
    assert.match(r.why, /lost the foreground/);
  });

  await test('NO WINDOW: without something to aim at, nothing is sent', async () => {
    const p = fakeProbe({ granted: true });
    const r = await kbd.deliver({ probe: p, ...args, window: '' });
    assert.strictEqual(r.stage, cap.STAGE.FOCUS_FAILED);
    assert.strictEqual(p.calls.length, 0, 'it must not even ask — there is nothing to ask about');
    assert.match(r.why, /NOTHING WAS SENT/);
  });

  await test('NO BRIDGE: with nothing connected it is BRIDGE_LOST, not a failure to explain', async () => {
    const r = await kbd.deliver({ probe: null, ...args });
    assert.strictEqual(r.stage, cap.STAGE.BRIDGE_LOST);
  });

  // ------------------------------------------- ACCEPTANCE IS NOT DELIVERY --

  await test('EVIDENCE: a successful injection is SENT_UNCONFIRMED, never SUCCEEDED', async () => {
    const p = fakeProbe({ granted: true });
    const r = await kbd.deliver({ probe: p, ...args });
    assert.strictEqual(r.stage, cap.STAGE.SENT_UNCONFIRMED);
    assert.notStrictEqual(r.stage, cap.STAGE.SUCCEEDED);
    assert.notStrictEqual(r.stage, cap.STAGE.DELIVERED,
      'DELIVERED belongs to a witness that saw the target receive it, and there is none here');
  });

  await test('EVIDENCE: the trail names every stage that was reached, in order', async () => {
    const p = fakeProbe({ granted: true });
    const r = await kbd.deliver({ probe: p, ...args });
    const stages = r.trail.map((t) => t.stage);
    assert.deepStrictEqual(stages, [
      cap.STAGE.REQUESTED,
      cap.STAGE.PERMISSION_REQUIRED,          // keyboard.press
      cap.STAGE.PERMISSION_REQUIRED,          // screen.capture, which aiming needs
      cap.STAGE.FOCUSING,
      cap.STAGE.FOCUSED,
      cap.STAGE.INJECTING,
      cap.STAGE.SENT_UNCONFIRMED,
    ], '"it did not work" is not a state; every attempt ends on a named one');
  });

  await test('EVIDENCE: a failed attempt still carries the trail up to where it stopped', async () => {
    const p = fakeProbe({ granted: true, focus: false });
    const r = await kbd.deliver({ probe: p, ...args });
    assert.ok(r.trail.some((t) => t.stage === cap.STAGE.FOCUSING), 'it got as far as aiming');
    assert.ok(!r.trail.some((t) => t.stage === cap.STAGE.INJECTING), 'and no further');
  });

  // ------------------------------------------------------ THE HOLD --------

  await test('HOLD: it is a press, a measured wait, and a release', async () => {
    const p = fakeProbe({ granted: true });
    const started = Date.now();
    const r = await kbd.hold({ probe: p, key: 'W', ms: 250, window: 'GAME' });
    assert.ok(Date.now() - started >= 200, 'the key must actually be held, not pressed and dropped');
    const ops = p.ops();
    assert.ok(ops.includes('input.keyboard.press'), 'the down edge');
    assert.ok(ops.includes('input.keyboard.release'), 'and the up edge');
    assert.ok(ops.indexOf('input.keyboard.press') < ops.indexOf('input.keyboard.release'));
    assert.strictEqual(r.stage, cap.STAGE.SENT_UNCONFIRMED, 'and neither edge is DELIVERED');
  });

  await test('HOLD: a release that FAILS is reported, loudly, as a key that may still be down', async () => {
    // A key left down is the user's machine typing `wwwwww` into whatever they
    // open next. There is no failure for which that is an acceptable outcome,
    // so it may never be swallowed — the attempt is always made, and when the
    // attempt fails the caller is told in those words.
    const p = fakeProbe({ granted: true });
    const original = p.call.bind(p);
    p.call = async (op, params, ms) => {
      if (op === 'input.keyboard.release') throw new Error('the far side went away');
      return original(op, params, ms);
    };
    const r = await kbd.hold({ probe: p, key: 'W', ms: 100, window: 'GAME' });
    assert.strictEqual(r.stage, cap.STAGE.FAILED, 'a hold that could not be released has not succeeded');
    assert.match(r.why, /may still be down/);
    assert.strictEqual(r.up.ok, false);
  });

  await test('HOLD: the release is attempted even when the press throws on the way back', async () => {
    // The `finally` is the point: whatever happens between the two edges, the
    // key comes up. A throw the caller never sees is also part of the contract
    // — a hold reports, it does not explode into the turn loop.
    const p = fakeProbe({ granted: true });
    const original = p.call.bind(p);
    p.call = async (op, params, ms) => {
      const out = await original(op, params, ms);
      if (op === 'window.focus' && p.calls.filter((c) => c.op === 'window.focus').length > 4) {
        throw new Error('boom, mid-hold');
      }
      return out;
    };
    let threw = null;
    let r = null;
    try { r = await kbd.hold({ probe: p, key: 'W', ms: 100, window: 'GAME' }); }
    catch (e) { threw = e; }
    assert.strictEqual(threw, null, 'a mid-hold failure must be reported, not thrown at the caller');
    assert.ok(p.ops().includes('input.keyboard.release'), 'and the key must have been lifted');
    assert.ok(r, 'and there must be a result to read');
  });

  await test('HOLD: a press that never happened is not reported as a hold', async () => {
    const p = fakeProbe({ granted: true, focus: false });
    const r = await kbd.hold({ probe: p, key: 'W', ms: 100, window: 'GAME' });
    assert.strictEqual(r.stage, cap.STAGE.FOCUS_FAILED);
    assert.strictEqual(r.held, 0);
    assert.strictEqual(r.up, null, 'there is nothing to lift');
    assert.ok(!p.ops().includes('input.keyboard.release'));
  });

  await test('HOLD: it is bounded — a model cannot ask for a key held for an hour', async () => {
    assert.ok(kbd.MAX_HOLD_MS <= 60_000, 'an unbounded hold is a stuck keyboard with a timer');
  });

  // -------------------------------------------------------- THE BOUNDARY --

  await test('BOUNDARY: LAIN synthesises no input and grants no permission of its own', async () => {
    const fs = require('fs');
    // COMMENTS ARE STRIPPED FIRST. The header names `SendInput` and `user32`
    // because explaining the mechanism is the whole reason the file reads the
    // way it does; what must not appear is CODE that touches them.
    const src = fs.readFileSync(require.resolve('../../src/keyboarddelivery.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of ['SendInput', 'user32', 'ffi', 'koffi', 'spawn', 'execSync', 'child_process']) {
      assert.ok(!src.includes(forbidden),
        `OS input belongs to lain-probe — this orchestrates it (${forbidden})`);
    }
    assert.ok(!/permissions\s*\[|\bgrant\s*\(/.test(src),
      'and the Probe decides what is allowed; LAIN only chooses when it is asked');
    // Everything it can do, it does by asking the far side.
    assert.strictEqual((src.match(/probe\.call\(/g) || []).length > 0, true);
  });

  await test('BOUNDARY: an older Probe with no permission.request is not treated as a denial', async () => {
    const p = {
      calls: [],
      async call(op, params) {
        this.calls.push(op);
        if (op === 'permission.state') return { ok: true, result: {} };
        if (op === 'permission.request') return { ok: false, error: 'unknown operation permission.request' };
        if (op === 'window.focus') return { ok: true, result: { focused: true, title: params.window } };
        return { ok: true, result: { ok: true } };
      },
    };
    const r = await kbd.deliver({ probe: p, ...args });
    assert.strictEqual(r.stage, cap.STAGE.SENT_UNCONFIRMED,
      'a missing operation is not the user saying no — the Probe\'s own gate still asks');
  });
};
