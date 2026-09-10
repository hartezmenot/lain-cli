'use strict';

/**
 * THE CAPABILITY PATH — the unit half of "permission was granted and it hit
 * the wrong thing".
 *
 * Traced against the REAL Probe on 2026-08-20, and every number below is from
 * that trace rather than from a guess:
 *
 *   permission.state    15 capabilities, every one granted: false
 *   target.status       { authorized: false, reason: 'NO_AUTHORIZED_TARGET' }
 *   input.mouse.click   params: x, y, button, restore, double
 *
 * The click takes SCREEN COORDINATES. Nothing focuses the authorised window
 * first, and nothing afterwards establishes which window received it. So the
 * reported failure was never a broken grant — it was an UNAIMED ACTION being
 * reported as a successful one.
 *
 * These pin the two halves LAIN is responsible for: knowing the difference
 * between connected / granted / aimed, and never letting a model believe an
 * action reached a target that nothing confirmed.
 */

const assert = require('assert');
const { test } = require('../helpers');

const cap = require('../../src/capability');
const { describeTarget } = require('../../src/turn');
const phrasing = require('../../src/ui/phrasing');
const status = require('../../src/ui/status');

/** The real Probe's permission table, as observed: nothing granted. */
const NOTHING_GRANTED = {
  'process.attach': false, 'memory.read': false, 'memory.write': false,
  'screen.capture': false, 'mouse.move': false, 'mouse.click': false,
  'keyboard.press': false, 'python.execute': false,
};
const NO_TARGET = { authorized: false, reason: 'NO_AUTHORIZED_TARGET', selected: null, attached: false };

module.exports = async function () {
  // -------------------------------------------------- one vocabulary, three --

  await test('CAP: connected, granted and aimed are three different facts', () => {
    // The whole reason this module exists. Each of the three can be false on
    // its own, and the failure reads completely differently in each case.
    const bridgeDown = cap.preflight({ op: 'input.mouse.click', connected: false });
    assert.strictEqual(bridgeDown.stage, cap.STAGE.BRIDGE_LOST);

    const ungranted = cap.preflight({ op: 'input.mouse.click', connected: true, granted: NOTHING_GRANTED });
    assert.strictEqual(ungranted.stage, cap.STAGE.PERMISSION_REQUIRED);

    const noTarget = cap.preflight({ op: 'memory.read', connected: true, granted: NOTHING_GRANTED, target: NO_TARGET });
    assert.strictEqual(noTarget.stage, cap.STAGE.NO_TARGET);
  });

  await test('CAP: both dialects name the same capability', () => {
    // `mcp.js` says `mouse`, the Probe says `mouse.click`, and calling both
    // "capabilities" is how three different things came to share one word.
    assert.strictEqual(cap.capabilityOf('input.mouse.click'), 'mouse.click');
    assert.strictEqual(cap.capabilityOf('mouse.click'), 'mouse');
    assert.strictEqual(cap.capabilityOf('keyboard.type'), 'keyboard');
    assert.strictEqual(cap.capabilityOf('input.keyboard.type'), 'keyboard.press');
  });

  await test('CAP: an operation that needs no capability says so, rather than nothing', () => {
    // `probe.tools`, `target.list` and `window.list` genuinely need none. That
    // is an answer, not a gap in the table.
    assert.strictEqual(cap.capabilityOf('probe.tools'), null);
    assert.strictEqual(cap.aim('probe.tools'), 'NONE');
  });

  // ------------------------------------------------------------- the aiming --

  await test('AIM: a click is addressed to the SCREEN, and is labelled so', () => {
    assert.strictEqual(cap.aim('input.mouse.click'), 'SCREEN');
    assert.strictEqual(cap.aim('mouse.move'), 'SCREEN');
  });

  await test('AIM: typing goes to whatever holds FOCUS, which is worse and is labelled so', () => {
    // A coordinate at least says where it went. Typing says nothing at all,
    // and text sent to the wrong window is text typed into someone's document.
    assert.strictEqual(cap.aim('input.keyboard.type'), 'FOCUS');
    assert.strictEqual(cap.aim('keyboard.key'), 'FOCUS');
  });

  await test('AIM: memory and debugging act on an authorised PROCESS', () => {
    assert.strictEqual(cap.aim('memory.read'), 'TARGET');
    assert.strictEqual(cap.aim('debug.breakpoint'), 'TARGET');
  });

  // -------------------------------------------------- what the model is told --

  await test('EVIDENCE: a successful click is NEVER reported as simply successful', () => {
    // `{"success": true}` says an operation returned and nothing whatever
    // about whether the machine did anything, or to what.
    const e = cap.envelope({
      op: 'input.mouse.click', stage: cap.STAGE.SUCCEEDED, capability: 'mouse.click',
      aim: 'SCREEN', result: { landed: [900, 400] }, target: NO_TARGET,
    });
    assert.strictEqual(e.state, 'SUCCEEDED');
    assert.match(e.text, /SCREEN COORDINATES/);
    assert.match(e.text, /Nothing has confirmed which window received it/);
    assert.match(e.text, /window\.focus/, 'and it names the way to aim it');
    assert.strictEqual(e.evidence.verification.status, 'unconfirmed');
    assert.match(e.text, /landed/, 'while still carrying what the far side reported');
  });

  await test('EVIDENCE: typing carries the same warning, in its own words', () => {
    const e = cap.envelope({
      op: 'input.keyboard.type', stage: cap.STAGE.SUCCEEDED, capability: 'keyboard.press',
      aim: 'FOCUS', result: { typed: 12 },
    });
    assert.match(e.text, /WHATEVER HAS KEYBOARD FOCUS/);
    assert.strictEqual(e.evidence.verification.status, 'unconfirmed');
  });

  await test('EVIDENCE: every envelope carries the action, the state and the time', () => {
    const e = cap.envelope({ op: 'memory.read', stage: cap.STAGE.NO_TARGET, capability: 'memory.read', aim: 'TARGET' });
    assert.strictEqual(e.evidence.action, 'memory.read');
    assert.strictEqual(e.evidence.state, 'NO_TARGET');
    assert.strictEqual(e.evidence.capability, 'memory.read');
    assert.ok(Date.parse(e.evidence.at) > 0, 'and a real timestamp');
    assert.strictEqual(e.evidence.target, null, 'a target-scoped action with no target says target: null');
  });

  await test('EVIDENCE: an unaimed operation gets no aiming warning', () => {
    // The warning must mean something. Attaching it to every result is how it
    // stops being read.
    const e = cap.envelope({ op: 'probe.tools', stage: cap.STAGE.SUCCEEDED, aim: 'NONE', result: { tools: [] } });
    assert.ok(!/SCREEN COORDINATES|KEYBOARD FOCUS/.test(e.text));
    assert.strictEqual(e.evidence.verification.status, 'reported');
  });

  await test('EVERY STATE IS REACHABLE AND NAMED — none is "it did not work"', () => {
    const named = Object.values(cap.STAGE);
    for (const s of ['REQUESTED', 'BRIDGE_LOST', 'PERMISSION_REQUIRED', 'REFUSED',
      'NO_TARGET', 'TARGET_LOST', 'GRANTED', 'EXECUTING', 'SUCCEEDED', 'FAILED']) {
      assert.ok(named.includes(s), `${s} is not a state this can report`);
    }
  });

  // ---------------------------------------------------- reading the far side --

  await test('STATE: a disconnected Probe reports nothing and invents nothing', async () => {
    const s = await cap.readState({ state: 'DISCONNECTED' });
    assert.strictEqual(s.connected, false);
    assert.strictEqual(s.capabilities, null);
    assert.strictEqual(s.target, null);
    assert.ok(s.notes.join(' ').includes('DISCONNECTED'));
  });

  await test('STATE: UNKNOWN and NONE GRANTED are different answers', async () => {
    // An older bridge that cannot report permission state must not be
    // presented as one that reports everything denied.
    const silent = await cap.readState({
      state: 'CONNECTED', capabilities: ['a.b'],
      call: async () => ({ ok: false, error: 'unknown tool' }),
    });
    assert.strictEqual(silent.capabilities, null, 'unknown, not empty');
    assert.ok(silent.notes.some((n) => /UNKNOWN/.test(n)));

    const answering = await cap.readState({
      state: 'CONNECTED', capabilities: ['a.b'],
      call: async (op) => (op === 'permission.state'
        ? { ok: true, result: { capabilities: { 'mouse.click': { granted: false, why: 'not granted' } }, prompter: true } }
        : { ok: true, result: { authorized: false, reason: 'NO_AUTHORIZED_TARGET' } }),
    });
    assert.deepStrictEqual(answering.capabilities, { 'mouse.click': { granted: false, why: 'not granted' } });
    assert.strictEqual(answering.target.authorized, false);
    assert.strictEqual(answering.target.reason, 'NO_AUTHORIZED_TARGET');
  });

  await test('STATE: a far side that throws does not take the status screen with it', async () => {
    const s = await cap.readState({
      state: 'CONNECTED', capabilities: [],
      call: async () => { throw new Error('pipe closed'); },
    });
    assert.strictEqual(s.connected, true);
    assert.strictEqual(s.capabilities, null);
  });

  // ------------------------------------------------------ the visible surface --

  await test('UI: a dispatched call is described by its OPERATION, not by the tool name', () => {
    // `computer`, WHICH IS THE ONE THAT MATTERS NOW. This line read `desktop`
    // until the consolidation retired that name, and the rename was the whole
    // defect: the list in turn.js kept naming a tool that no longer exists, so
    // the tool that inherited its `op`-shaped input stopped being described by
    // its operation and drew as a bare "computer". Thirty screenshots, clicks
    // and keystrokes became indistinguishable again — the exact failure this
    // test was written for, reintroduced through the back door of a rename.
    assert.strictEqual(describeTarget('computer', { op: 'click' }), 'click');
    assert.strictEqual(describeTarget('computer', { op: 'focus', target: 'Notepad' }), 'focus → Notepad');
    assert.strictEqual(describeTarget('probe', { op: 'input.mouse.click' }), '',
      'the retired name must NOT be special-cased back into existence');
    assert.strictEqual(describeTarget('desktop', { op: 'mouse.click' }), '',
      'and neither must the one retired before it');
    // And an ordinary tool is untouched.
    assert.strictEqual(describeTarget('read_file', { path: 'a.js' }), 'a.js');
  });

  await test('UI: the feed names the bridge as the actor', () => {
    assert.strictEqual(phrasing.phrase('computer', 'click'), 'computer · click');
    assert.strictEqual(phrasing.verbOf('computer'), 'Computer');
  });

  await test('UI: the strip says RUNNING MCP, in the MCP column', () => {
    // `RUNNING npm test` and `RUNNING MCP click` are not the same
    // kind of event, and the second is the one somebody may want to stop.
    const mcp = status.liveState({ phase: { phase: 'RUNNING_TOOL', tool: 'computer', target: 'click' } });
    assert.strictEqual(mcp.word, 'RUNNING MCP');
    assert.strictEqual(mcp.actor, 'MCP');
    const local = status.liveState({ phase: { phase: 'RUNNING_TOOL', tool: 'run_bash', target: 'npm test' } });
    assert.strictEqual(local.word, 'RUNNING');
    assert.strictEqual(local.actor, 'TOOL');
  });

  await test('UI: WORKING is not WAITING — only a real question demands attention', () => {
    const views = require('../../src/ui/views');
    const S = views.STATE;
    // A bridge action in flight is WORKING, whoever is carrying it out.
    assert.notStrictEqual(views.statusOf({ phase: { phase: 'RUNNING_TOOL', tool: 'computer' } }), S.NEEDS_USER);
    // A question being asked is the one state that does.
    assert.strictEqual(views.statusOf({ awaitingUser: true, phase: { phase: 'RUNNING_TOOL', tool: 'computer' } }), S.NEEDS_USER);
  });
};
