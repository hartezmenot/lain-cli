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

  await test('RETIRED: the panel module is gone, and the fan-out with it', () => {
    // The multi-provider fan-out existed to drive more than one chat page.
    // Its module must not come back piecemeal.
    assert.throws(() => require('../../src/externalpanel'), /Cannot find module/);
  });

  /**
   * ---- `/external` AND ITS FOUR MODULES ----------------------------------
   *
   * These assert the DECISION, in the shape this repository already uses for a
   * retired command: what is gone, and — the half that matters more — what
   * SURVIVED, so a future pass can tell "removed on purpose" from "lost".
   *
   * The useful behaviour did not disappear. It came back as a chat model
   * SOURCE: selecting ChatGPT.com or Gemini.google.com sends the next question
   * there, in the same session history, with provenance on the answer. See
   * src/modelsource and `/source`.
   */
  await test('RETIRED: the four /external modules are gone and cannot be required', () => {
    for (const m of ['../../src/external', '../../src/actors', '../../src/externalrequest', '../../src/investigation']) {
      assert.throws(() => require(m), /Cannot find module/, m);
    }
  });

  await test('RETIRED: `/external` is not a registered command, and nothing revives it', () => {
    const commands = require('../../src/commands');
    assert.ok(!commands.names().includes('/external'), '/external must stay gone');
    // AND ITS REPLACEMENT EXISTS. A removal with no successor would be a
    // capability quietly dropped rather than a command replaced by a selection.
    assert.ok(commands.names().includes('/source'), '/source is what replaced it');
  });

  await test('SURVIVED: the neutral pieces of /external were reused, not deleted', () => {
    // 1. THIS LEDGER — the file these tests are about. It is now written by the
    //    web model sources, so "did something leave this machine, and did it
    //    come back" is still answerable.
    assert.strictEqual(typeof externalstate.forSession, 'function');
    const web = fs.readFileSync(require.resolve('../../src/modelsource/webmodel'), 'utf8');
    assert.match(web, /externalstate/, 'the web sources write the same call ledger');

    // 2. THE OVERCLAIM CHECK — a consulted model that claims to have ACTED is
    //    flagged. It was never about transport.
    const contract = require('../../src/modelsource/contract');
    assert.ok(contract.overclaims('FACT: the loader is fine. I ran the tests and they pass.'));
    assert.strictEqual(contract.overclaims('FACT: the loader reads JSON. RECOMMENDATION: check the writer.'), null);

    // 3. THE BOUNDED, REDACTED SESSION-FACTS PACKET.
    const ctx = require('../../src/modelsource/context');
    assert.strictEqual(typeof ctx.facts, 'function');
    assert.ok(ctx.MAX_TOTAL > 0 && ctx.MAX_PROMPT > 0, 'still bounded');
  });

  await test('SURVIVED: a consulted model still gets no execution authority', () => {
    // The property `/external` was tested for, asserted against what replaced
    // it: a web reply is text. It cannot call a tool, widen a permission or
    // settle a task, and nothing in the model-source package reaches the
    // supervisor, the tool registry or the permission gate.
    const dir = require('path').join(__dirname, '..', '..', 'src', 'modelsource');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(require('path').join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const forbidden of ['supervisor', 'tools/index', "require('../gate')", "require('../trust')", "require('../permissions')"]) {
        assert.ok(!src.includes(forbidden), `modelsource/${f} reaches ${forbidden}`);
      }
    }
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
