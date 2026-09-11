'use strict';

/**
 * THE WEB MODEL CONFORMANCE SUITE.
 *
 * ------------------------------------------------------------------------
 * WHAT IT PROVES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It drives the REAL orchestrator — src/modelsource/webmodel.js — over the
 * deterministic fixture surface. Every decision in this feature lives in that
 * file: when a send is allowed, what proves it happened, what may be retried,
 * how a thread is bound, what a failure means. So these tests exercise the thing
 * that matters rather than a mock of it.
 *
 * IT PROVES NOTHING ABOUT chatgpt.com OR gemini.google.com. It cannot: only the
 * real sites can say whether their model menus still have the shape those
 * adapters declare, and asking them needs an account, a login and a person. That
 * is `/source check`, run by hand. A green run here is FIXTURE VERIFIED and is
 * never LIVE VERIFIED — see docs/MODEL-SOURCES.md.
 *
 * ------------------------------------------------------------------------
 * IT RUNS TWICE, UNDER TWO SOURCE IDS.
 *
 * The whole point of the surface seam is that ChatGPT and Gemini share one
 * orchestrator. Running the identical suite under two ids is what makes that a
 * fact rather than an intention: a decision that quietly special-cased one
 * source would pass under one id and fail under the other.
 *
 * Nothing here contacts a network, launches a browser, reads the user's config
 * or writes outside a scratch session.
 */

const assert = require('assert');
const { test } = require('../helpers');

const fixture = require('../../src/modelsource/fixture');
const { WebModelSource } = require('../../src/modelsource/webmodel');
const { STATUS, CONNECTION, MODEL_STATE, SOURCE } = require('../../src/modelsource/contract');
const { AUTH } = require('../../src/modelsource/websurface');
const bindingMod = require('../../src/modelsource/binding');

/** A session-shaped object. Nothing here touches the real session store. */
function session(id = 'sess-a') {
  return { id, sourceSelections: {}, providerBindings: {}, external: null };
}

/** An app-shaped object: a session, and a bus that records what was said. */
function appFor(s) {
  const seen = [];
  return {
    session: s,
    events: { emit: (type, payload) => { seen.push({ type, ...payload }); return { type }; } },
    seen,
  };
}

function sourceOver(script, { id = SOURCE.CHATGPT_WEB, app = null } = {}) {
  const surface = fixture.create({ id, label: id, ...script });
  const a = app || appFor(session());
  return { src: new WebModelSource({ surface, app: a, id, label: id }), surface, app: a };
}

module.exports = async function () {
  for (const ID of [SOURCE.CHATGPT_WEB, SOURCE.GEMINI_WEB]) {
    const N = `CONFORMANCE[${ID}]`;

    // ------------------------------------------------------------ status ---

    await test(`${N}: an unavailable browser is UNAVAILABLE, with the reason`, async () => {
      const { src } = sourceOver({ available: false }, { id: ID });
      const st = await src.status();
      assert.strictEqual(st.state, CONNECTION.UNAVAILABLE);
      assert.match(st.why, /no browser/i);
    });

    await test(`${N}: status does not open a browser unless it is asked to`, async () => {
      const { src, surface } = sourceOver({}, { id: ID });
      let opened = 0;
      const real = surface.ensurePage;
      surface.ensurePage = (...a) => { opened += 1; return real(...a); };
      await src.status();
      assert.strictEqual(opened, 0, 'a cheap status must not launch anything');
      await src.status({ open: true });
      assert.ok(opened > 0, 'an explicit open must actually connect');
    });

    // ------------------------------------------------------ authentication --

    await test(`${N}: signed out is AUTH_REQUIRED, never a failure`, async () => {
      const { src } = sourceOver({ auth: AUTH.AUTH_REQUIRED }, { id: ID });
      const st = await src.connect();
      assert.strictEqual(st.state, CONNECTION.AUTH_REQUIRED);
    });

    await test(`${N}: a send while signed out is AUTH_REQUIRED and sends nothing`, async () => {
      const { src, surface } = sourceOver({ auth: AUTH.AUTH_REQUIRED, selected: 'fx-large' }, { id: ID });
      const r = await src.send({ prompt: 'hello', modelId: 'fx-large' });
      assert.strictEqual(r.status, STATUS.AUTH_REQUIRED);
      assert.deepStrictEqual(surface.received, [], 'nothing may leave while signed out');
    });

    await test(`${N}: an unrecognised page is UNKNOWN, not "please log in"`, async () => {
      // Telling somebody to sign in when they already are hides the real
      // problem, which is that the page is not the page this adapter knows.
      const { src } = sourceOver({ auth: AUTH.UNKNOWN }, { id: ID });
      const st = await src.connect();
      assert.strictEqual(st.state, CONNECTION.FAILED);
      assert.notStrictEqual(st.state, CONNECTION.AUTH_REQUIRED);
    });

    await test(`${N}: a login that expires mid-session is AUTH_REQUIRED on the next send`, async () => {
      const { src, surface } = sourceOver({}, { id: ID });
      await src.selectModel('fx-large');
      assert.strictEqual((await src.send({ prompt: 'first' })).status, STATUS.COMPLETED);
      surface.script.auth = AUTH.AUTH_REQUIRED;          // the cookie expired
      const r = await src.send({ prompt: 'second' });
      assert.strictEqual(r.status, STATUS.AUTH_REQUIRED);
      assert.strictEqual(surface.received.length, 1, 'the second prompt never left');
    });

    await test(`${N}: reconnecting after a login works without restarting anything`, async () => {
      const { src, surface } = sourceOver({ auth: AUTH.AUTH_REQUIRED }, { id: ID });
      assert.strictEqual((await src.connect()).state, CONNECTION.AUTH_REQUIRED);
      surface.script.auth = AUTH.READY;                  // the person signed in
      assert.strictEqual((await src.connect()).state, CONNECTION.READY);
      await src.selectModel('fx-large');
      assert.strictEqual((await src.send({ prompt: 'now' })).status, STATUS.COMPLETED);
    });

    await test(`${N}: disconnect forgets live state and keeps the saved login`, async () => {
      // "Stop using ChatGPT for now" and "log me out of ChatGPT" are different
      // requests, and conflating them would destroy a login on a source switch.
      const { src } = sourceOver({}, { id: ID });
      await src.discoverModels();
      const st = await src.disconnect();
      assert.strictEqual(st.state, CONNECTION.DISCONNECTED);
      const src2 = require('../../src/modelsource/webprofile');
      assert.strictEqual(typeof src2.forget, 'function', 'removing a login is a separate, named operation');
    });

    // ---------------------------------------------------------- discovery --

    await test(`${N}: models are discovered from the account, with states`, async () => {
      const { src } = sourceOver({
        models: [
          { id: 'a', label: 'Model A', statesAvailability: true },
          { id: 'b', label: 'Model B', disabled: true, statesAvailability: true },
          { id: 'c', label: 'Model C', statesAvailability: false },
        ],
      }, { id: ID });
      const inv = await src.discoverModels();
      assert.strictEqual(inv.ok, true);
      assert.deepStrictEqual(inv.models.map((m) => m.state), [
        MODEL_STATE.AVAILABLE, MODEL_STATE.UNAVAILABLE, MODEL_STATE.UNKNOWN,
      ]);
    });

    await test(`${N}: a model list that cannot be read is a FAILURE, not an empty list`, async () => {
      // "This account has no models" and "the site changed" are different
      // statements, and a person would act on the first by re-subscribing.
      const { src } = sourceOver({ models: null }, { id: ID });
      const inv = await src.discoverModels();
      assert.strictEqual(inv.ok, false);
      assert.strictEqual(inv.models.length, 0);
      assert.match(inv.why, /structure has changed/i);
    });

    await test(`${N}: the inventory is cached, and an explicit refresh re-reads it`, async () => {
      const { src, surface } = sourceOver({}, { id: ID });
      let reads = 0;
      const real = surface.models;
      surface.models = (...a) => { reads += 1; return real(...a); };
      await src.discoverModels();
      await src.discoverModels();
      assert.strictEqual(reads, 1, 'a second call inside the TTL must be served from cache');
      await src.discoverModels({ refresh: true });
      assert.strictEqual(reads, 2, 'refresh must actually re-read the site');
    });

    await test(`${N}: authentication changing throws the cached inventory away`, async () => {
      const { src, surface } = sourceOver({}, { id: ID });
      await src.discoverModels();
      surface.script.auth = AUTH.AUTH_REQUIRED;
      await src.connect();
      surface.script.auth = AUTH.READY;
      let reads = 0;
      const real = surface.models;
      surface.models = (...a) => { reads += 1; return real(...a); };
      await src.discoverModels();
      assert.strictEqual(reads, 1, 'a different account has a different model list');
    });

    // ----------------------------------------------------------- selection --

    await test(`${N}: a model outside the discovered list is refused`, async () => {
      const { src } = sourceOver({}, { id: ID });
      const r = await src.selectModel('gpt-imaginary');
      assert.strictEqual(r.ok, false);
      assert.match(r.why, /not a model this account has/i);
    });

    await test(`${N}: a listed but unavailable model is refused`, async () => {
      const { src } = sourceOver({ models: [{ id: 'a', label: 'A', disabled: true, statesAvailability: true }] }, { id: ID });
      const r = await src.selectModel('a');
      assert.strictEqual(r.ok, false);
      assert.match(r.why, /not available on this account/i);
    });

    await test(`${N}: a selection is remembered on the session, per source`, async () => {
      const s = session();
      const { src } = sourceOver({}, { id: ID, app: appFor(s) });
      const r = await src.selectModel('fx-small');
      assert.strictEqual(r.ok, true);
      assert.strictEqual(s.sourceSelections[ID], 'fx-small');
      assert.strictEqual(src.selectedModel(), 'fx-small');
    });

    // ---------------------------------------------------------------- send --

    await test(`${N}: with no model selected, nothing is sent`, async () => {
      // A silent default to "whatever the site has active" is the exact failure
      // an explicit model selection exists to prevent.
      const { src, surface } = sourceOver({}, { id: ID });
      const r = await src.send({ prompt: 'hello' });
      assert.strictEqual(r.status, STATUS.FAILED);
      assert.match(r.error, /no model is selected/i);
      assert.deepStrictEqual(surface.received, []);
    });

    await test(`${N}: a completed send returns the extracted text with provenance`, async () => {
      const { src } = sourceOver({ reply: 'the checkout race is in the lock' }, { id: ID });
      await src.selectModel('fx-large');
      const r = await src.send({ prompt: 'what is wrong?' });
      assert.strictEqual(r.status, STATUS.COMPLETED);
      assert.strictEqual(r.text, 'the checkout race is in the lock');
      assert.strictEqual(r.provenance.sourceId, ID);
      assert.strictEqual(r.provenance.model, 'fx-large');
      assert.ok(r.provenance.label.includes('fx-large'));
    });

    await test(`${N}: a website reports no authoritative token usage`, async () => {
      const { src } = sourceOver({}, { id: ID });
      await src.selectModel('fx-large');
      const r = await src.send({ prompt: 'hi' });
      assert.strictEqual(r.usage, null, 'unknown must stay unknown, never an estimate');
      assert.strictEqual(src.capabilities().authoritativeUsage, false);
    });

    await test(`${N}: an empty reply is FAILED, never a COMPLETED with no text`, async () => {
      const { src } = sourceOver({ reply: '   ' }, { id: ID });
      await src.selectModel('fx-large');
      const r = await src.send({ prompt: 'hi' });
      assert.strictEqual(r.status, STATUS.FAILED);
      assert.match(r.error, /no text/i);
    });

    await test(`${N}: a prompt that is accepted and never answered is FAILED and says it is uncertain`, async () => {
      const { src } = sourceOver({ silent: true }, { id: ID });
      await src.selectModel('fx-large');
      const r = await src.send({ prompt: 'hi' });
      assert.strictEqual(r.status, STATUS.FAILED);
      assert.match(r.error, /not certain the prompt was answered/i);
    });

    // ------------------------------------------------- duplicate submission --

    await test(`${N}: a prompt that provably never left is retried once`, async () => {
      const { src, surface } = sourceOver({ acceptPrompt: false }, { id: ID });
      await src.selectModel('fx-large');
      const r = await src.send({ prompt: 'hi' });
      assert.strictEqual(r.status, STATUS.FAILED);
      assert.deepStrictEqual(surface.received, [], 'a refused composer sends nothing');
    });

    await test(`${N}: a prompt that MAY have been sent is never sent twice`, async () => {
      // The rule that cannot be got wrong: a duplicate message in somebody's own
      // ChatGPT thread cannot be withdrawn.
      const { src, surface } = sourceOver({ loseSubmit: true }, { id: ID });
      await src.selectModel('fx-large');
      const r = await src.send({ prompt: 'the only copy' });
      assert.strictEqual(r.status, STATUS.FAILED);
      assert.strictEqual(surface.received.length, 1, 'exactly one copy reached the site');
      assert.match(r.error, /may already have been sent/i);
    });

    await test(`${N}: two sends cannot interleave on one page`, async () => {
      const { src } = sourceOver({ settleMs: 30 }, { id: ID });
      await src.selectModel('fx-large');
      const [a, b] = await Promise.all([src.send({ prompt: 'one' }), src.send({ prompt: 'two' })]);
      const states = [a.status, b.status].sort();
      assert.deepStrictEqual(states, [STATUS.COMPLETED, STATUS.FAILED]);
    });

    // ------------------------------------------------------ errors + limits --

    await test(`${N}: a quota message is RATE_LIMITED, not a generic failure`, async () => {
      const { src } = sourceOver({ error: { rateLimited: true, why: 'you have reached your usage cap', retryAfterMs: 900000 } }, { id: ID });
      await src.selectModel('fx-large');
      const r = await src.send({ prompt: 'hi' });
      assert.strictEqual(r.status, STATUS.RATE_LIMITED);
      assert.strictEqual(r.source, ID, 'the limit keeps its source');
      assert.strictEqual(r.retryAfterMs, 900000);
    });

    await test(`${N}: a limit with no stated retry time does not invent one`, async () => {
      const { src } = sourceOver({ error: { rateLimited: true, why: 'limit reached' } }, { id: ID });
      await src.selectModel('fx-large');
      const r = await src.send({ prompt: 'hi' });
      assert.strictEqual(r.status, STATUS.RATE_LIMITED);
      assert.strictEqual(r.retryAfterMs, null);
    });

    await test(`${N}: an ordinary site error is FAILED and keeps its wording`, async () => {
      const { src } = sourceOver({ error: { rateLimited: false, why: 'Something went wrong.' } }, { id: ID });
      await src.selectModel('fx-large');
      const r = await src.send({ prompt: 'hi' });
      assert.strictEqual(r.status, STATUS.FAILED);
      assert.match(r.error, /Something went wrong/);
    });

    await test(`${N}: a model that vanishes between selection and send is UNAVAILABLE`, async () => {
      const { src, surface } = sourceOver({}, { id: ID });
      await src.selectModel('fx-large');
      surface.script.models = [{ id: 'fx-small', label: 'Fixture Small', statesAvailability: true }];
      const r = await src.send({ prompt: 'hi' });
      assert.strictEqual(r.status, STATUS.UNAVAILABLE);
      assert.match(r.error, /choose another model/i);
    });

    // ------------------------------------------------------- cancellation ---

    await test(`${N}: a cancelled send is CANCELLED, and the source stays usable`, async () => {
      const { src } = sourceOver({ settleMs: 200 }, { id: ID });
      await src.selectModel('fx-large');
      const ac = new AbortController();
      const p = src.send({ prompt: 'hi', signal: ac.signal });
      setTimeout(() => ac.abort(), 20);
      const r = await p;
      assert.strictEqual(r.status, STATUS.CANCELLED);
      const again = await src.send({ prompt: 'hi again' });
      assert.strictEqual(again.status, STATUS.COMPLETED, 'a cancel must not poison the next request');
    });

    await test(`${N}: cancel() with nothing in flight is not an error`, () => {
      const { src } = sourceOver({}, { id: ID });
      const r = src.cancel();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.cancelled, false);
    });

    // ------------------------------------------------------ thread binding --

    await test(`${N}: a completed send binds the thread to THIS session`, async () => {
      const s = session('sess-bind');
      const { src } = sourceOver({}, { id: ID, app: appFor(s) });
      await src.selectModel('fx-large');
      await src.send({ prompt: 'hi' });
      const b = bindingMod.resolve(s, ID);
      assert.strictEqual(b.ok, true);
      assert.strictEqual(b.binding.sessionId, 'sess-bind');
      assert.strictEqual(b.binding.model, 'fx-large');
    });

    await test(`${N}: a second turn resumes the SAME thread`, async () => {
      const s = session();
      const { src } = sourceOver({}, { id: ID, app: appFor(s) });
      await src.selectModel('fx-large');
      await src.send({ prompt: 'one' });
      const first = bindingMod.resolve(s, ID).binding.threadId;
      await src.send({ prompt: 'two' });
      assert.strictEqual(bindingMod.resolve(s, ID).binding.threadId, first);
    });

    await test(`${N}: a site that opens the wrong conversation FAILS CLOSED into a new one`, async () => {
      const s = session();
      const { src, surface } = sourceOver({}, { id: ID, app: appFor(s) });
      await src.selectModel('fx-large');
      await src.send({ prompt: 'one' });
      const first = bindingMod.resolve(s, ID).binding.threadId;
      surface.script.openWrong = true;
      await src.send({ prompt: 'two' });
      const now = bindingMod.resolve(s, ID).binding.threadId;
      assert.notStrictEqual(now, first, 'it must never adopt whatever thread is on screen');
    });

    await test(`${N}: two sessions on ONE browser never share a thread`, async () => {
      // THE REAL CROSSOVER, reproduced the way it would actually happen: one
      // App, one authenticated browser, one live site — and a `/resume` that
      // swaps the session underneath it. A source that resumed "the latest
      // chat" would hand session B the thread session A was using, and nothing
      // on screen would say so.
      const a = session('A');
      const b = session('B');
      const app = appFor(a);
      const { src } = sourceOver({}, { id: ID, app });
      await src.selectModel('fx-large');
      await src.send({ prompt: 'from A' });
      const ta = bindingMod.resolve(a, ID).binding.threadId;

      app.session = b;                     // the resume
      await src.selectModel('fx-small');
      await src.send({ prompt: 'from B' });
      const tb = bindingMod.resolve(b, ID).binding.threadId;

      assert.notStrictEqual(ta, tb, 'session B must not inherit session A\'s conversation');
      assert.strictEqual(a.sourceSelections[ID], 'fx-large');
      assert.strictEqual(b.sourceSelections[ID], 'fx-small', 'no model-selection crossover');
      assert.strictEqual(bindingMod.resolve(a, ID).binding.threadId, ta, 'A keeps its own');
    });

    await test(`${N}: a binding minted by another session is refused`, () => {
      const s = session('mine');
      s.providerBindings[ID] = { threadId: 'T1', sessionId: 'somebody-else', model: 'x', url: null, at: 1 };
      const r = bindingMod.resolve(s, ID);
      assert.strictEqual(r.ok, false);
      assert.match(r.why, /different session/i);
    });

    // --------------------------------------------------------- the ledger ---

    await test(`${N}: what left the machine is on the session's own call ledger`, async () => {
      const s = session();
      const { src } = sourceOver({}, { id: ID, app: appFor(s) });
      await src.selectModel('fx-large');
      await src.send({ prompt: 'hi' });
      assert.ok(s.external, 'the external ledger records that something left');
      assert.strictEqual(s.external.calls.length, 1);
      assert.strictEqual(s.external.calls[0].provider, ID);
      assert.strictEqual(s.external.calls[0].answered, true);
    });

    // ------------------------------------------------------------- events ---

    await test(`${N}: the activity states are announced on the ONE event bus`, async () => {
      const s = session();
      const app = appFor(s);
      const { src } = sourceOver({}, { id: ID, app });
      await src.selectModel('fx-large');
      await src.send({ prompt: 'hi' });
      const types = app.seen.map((e) => e.type);
      for (const want of ['webmodel.connecting', 'webmodel.ready', 'webmodel.sending', 'webmodel.waiting']) {
        assert.ok(types.includes(want), `${want} was never emitted (saw ${[...new Set(types)].join(', ')})`);
      }
      // NOTHING SECRET TRAVELS ON IT.
      const blob = JSON.stringify(app.seen);
      assert.ok(!blob.includes('hi"') || !/prompt/.test(blob), 'no prompt or reply may ride the event bus');
    });
  }
};
