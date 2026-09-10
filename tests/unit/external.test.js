'use strict';

/**
 * THE EXTERNAL CONVERSATION WORKFLOW — dispatch, capture, choose, continue.
 *
 * The tests that remain are the STATE MACHINE: whether an answer was given,
 * whether it was used, and whether a failure can masquerade as either. Those
 * rules are transport-independent — they were written for the browser fan-out
 * and outlive it, because an API actor and a pasted relay answer to the same
 * ledger.
 *
 * What is gone, with the browser removed in 2026-09 per the browser-ownership
 * ruling: the multi-provider panel that drove one chat page per provider, the
 * image attachments that went through the page's file input, and the visual
 * block language that drew the fan-out (ui/blocks.js — its fan-out builders
 * went with the panel; the one primitive the activity feed still used, the
 * gutter, was moved into feed.js rather than deleted with them). The IMAGE
 * refusal below survives — an image that cannot travel must never become a
 * description.
 */

const assert = require('assert');
const fs = require('fs');
const { test } = require('../helpers');

const externalstate = require('../../src/externalstate');
const { STATE } = externalstate;

module.exports = async function () {
  // ---------------------------------------------------- the state machine ---

  await test('EXTERNAL: an adapter that returns nothing is FAILED, never RESPONDED', () => {
    // The guard the whole audit turned on: "the adapter returned an object" is
    // not "the provider answered".
    const l = new externalstate.ExternalLedger();
    const c = l.open({ provider: 'gpt' });
    c.dispatch('api');
    c.respond('');
    assert.strictEqual(c.state, STATE.EXTERNAL_FAILED);
    assert.match(c.error, /no text/);
    assert.strictEqual(c.answered, false);
  });

  await test('EXTERNAL: a real answer reaches RESPONDED and carries its text', () => {
    const l = new externalstate.ExternalLedger();
    const c = l.open({ provider: 'gpt' });
    c.dispatch('api');
    c.respond('use a per-client send lock');
    assert.strictEqual(c.state, STATE.EXTERNAL_RESPONDED);
    assert.strictEqual(c.response, 'use a per-client send lock');
  });

  await test('EXTERNAL: a timeout is its own state, not a content failure', () => {
    const c = new externalstate.ExternalCall({ provider: 'gpt' });
    c.dispatch('api');
    c.timeout('nothing settled in 180s');
    assert.strictEqual(c.state, STATE.EXTERNAL_TIMEOUT);
    assert.strictEqual(c.failed, true);
  });

  await test('EXTERNAL: USED and DISCARDED are different endings', () => {
    // "It answered" and "its answer was taken" are separate facts, and the
    // second is the only one that means the workflow actually completed.
    const a = new externalstate.ExternalCall({ provider: 'gpt' });
    const b = new externalstate.ExternalCall({ provider: 'gemini' });
    for (const c of [a, b]) { c.dispatch('api'); c.respond('x'); }
    a.use(); b.discard();
    assert.strictEqual(a.state, STATE.EXTERNAL_RESULT_USED);
    assert.strictEqual(b.state, STATE.EXTERNAL_RESULT_DISCARDED);
  });

  await test('EXTERNAL: nothing can be USED that was never answered', () => {
    const c = new externalstate.ExternalCall({ provider: 'gpt' });
    c.use();
    assert.strictEqual(c.state, STATE.EXTERNAL_FAILED);
    assert.match(c.error, /nothing was answered/);
  });

  await test('EXTERNAL: two concurrent calls keep separate ids, state and responses', () => {
    // The failure a single shared `last` variable produces silently.
    const l = new externalstate.ExternalLedger();
    const a = l.open({ provider: 'gpt' });
    const b = l.open({ provider: 'gemini' });
    a.dispatch('api'); b.dispatch('api');
    a.respond('answer A');
    b.fail('the route refused the request');
    assert.notStrictEqual(a.id, b.id);
    assert.strictEqual(a.response, 'answer A');
    assert.strictEqual(b.response, null);
    assert.strictEqual(l.get(a.id).state, STATE.EXTERNAL_RESPONDED);
    assert.strictEqual(l.get(b.id).state, STATE.EXTERNAL_FAILED);
  });

  await test('EXTERNAL: the overall state reports USED only when something was used', () => {
    const l = new externalstate.ExternalLedger();
    const a = l.open({ provider: 'gpt' });
    a.dispatch('api'); a.respond('x');
    assert.strictEqual(l.overall(), STATE.EXTERNAL_RESPONDED, 'answered is not the same as used');
    a.use();
    assert.strictEqual(l.overall(), STATE.EXTERNAL_RESULT_USED);
  });

  await test('EXTERNAL: with nothing configured the state is NOT_REQUESTED', () => {
    assert.strictEqual(new externalstate.ExternalLedger().overall(), STATE.NOT_REQUESTED);
  });

  // ------------------------------------------------- what was removed -------

  await test('RETIRED: the browser actor is not a kind, in any configuration', () => {
    // A config that still names `actor: 'BROWSER'` — left over from before the
    // removal — must not be special-cased back into existence. It falls to the
    // default, which is the API actor, exactly as an unknown name always did.
    const actors = require('../../src/actors');
    assert.ok(!Object.prototype.hasOwnProperty.call(actors.KIND, 'BROWSER'));
    assert.strictEqual(actors.kindOf({ externalTroubleshoot: { actor: 'BROWSER' } }), actors.KIND.API);
    assert.strictEqual(actors.kindOf({ externalTroubleshoot: { actor: 'browser' } }), actors.KIND.API);
    // And no actor class exists for it to resolve to.
    const s = actors.status({ cfg: { externalTroubleshoot: { actor: 'BROWSER', model: 'x' } } });
    assert.ok(s.actors.every((a) => a.kind !== 'BROWSER'), 'no BROWSER row in the actor menu');
  });

  await test('RETIRED: the panel module is gone, and the fan-out with it', () => {
    // The multi-provider fan-out existed to drive more than one chat page.
    // Its module must not come back piecemeal.
    assert.throws(() => require('../../src/externalpanel'), /Cannot find module/);
  });

  // ---------------------------------------------------------------- images --

  await test('IMAGE: LAIN never fabricates an ASCII stand-in for a picture', () => {
    // The audit found the image was OMITTED, not ASCII-ed — ui/images.js
    // deliberately refuses to approximate. That refusal must stay: an ASCII
    // rendering must never become what a vision model is given.
    const src = fs.readFileSync(require.resolve('../../src/ui/images'), 'utf8');
    assert.match(src, /NOT SEEN/, 'an unviewed image must still say so');
    assert.doesNotMatch(src, /toAscii|asciiArt|ansiArt/i, 'no ASCII rendering may creep in');
  });
};
