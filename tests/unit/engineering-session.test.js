'use strict';

/**
 * THE ENGINEERING SESSION — chat and coding in ONE session, and the boundary
 * between them.
 *
 * ------------------------------------------------------------------------
 * THE PRODUCT FACT UNDER TEST.
 *
 * A person asks why checkout is failing, asks to see the architecture, says
 * "implement the fix and run the tests", then asks why router.js changed. Four
 * turns, one session, one project, one history — and only the third is coding.
 * Nobody should have to start a new session because the next sentence changed
 * register, and nothing about selecting ChatGPT.com may change who writes a file.
 *
 * ------------------------------------------------------------------------
 * FIXTURE VERIFIED. Every web source below is the deterministic fixture: no
 * browser, no network, no account. What is proved is the ROUTING, the
 * PERSISTENCE and the AUTHORITY BOUNDARY, which is where the product decisions
 * live. Whether chatgpt.com's page still parses is `/source check`'s question.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const lane = require('../../src/modelsource/lane');
const chatdispatch = require('../../src/chatdispatch');
const registry = require('../../src/modelsource/registry');
const fixture = require('../../src/modelsource/fixture');
const { WebModelSource } = require('../../src/modelsource/webmodel');
const contextPolicy = require('../../src/modelsource/context');
const bindingMod = require('../../src/modelsource/binding');
const { SOURCE, STATUS } = require('../../src/modelsource/contract');
const { Session } = require('../../src/session');
const modeMod = require('../../src/mode');

/** An App just real enough for the dispatcher. Nothing here touches a provider. */
function appWith({ cwd = process.cwd(), script = {}, source = SOURCE.CHATGPT_WEB } = {}) {
  const session = new Session({ cwd });
  const notices = [];
  const app = {
    session,
    cfg: {},
    checkpoints: null,
    connectionEvidence: {},
    events: { emit: () => null },
    render: { notice: (l, m) => notices.push([l, m]), write: () => {} },
    transient: (l, m) => notices.push([l, m]),
    notices,
  };
  // The REAL orchestrator over the fixture surface, installed through the one
  // entry point — so this exercises registry.get's own wiring rather than
  // bypassing it.
  const surface = fixture.create({ id: source, label: source, ...script });
  app._modelSources = new Map([
    [source, new WebModelSource({ surface, app, id: source, label: source })],
  ]);
  app.surface = surface;
  registry.selectSource(app, source);
  return app;
}

/** Drain a turn-event generator into the shape a caller would see. */
async function drain(gen) {
  const events = [];
  let record = null;
  for await (const ev of gen) {
    events.push(ev);
    if (ev.type === 'done') record = ev.record;
  }
  return { events, record, text: events.filter((e) => e.type === 'text').map((e) => e.chunk).join('') };
}

module.exports = async function () {
  // ---------------------------------------------------------------- lanes --

  await test('LANE: the chat lane IS mode.js READ_ONLY, not a second classifier', () => {
    // A copied list here would be a second opinion that could drift. This is the
    // assertion that it is a projection of the one classifier.
    for (const m of modeMod.READ_ONLY) assert.strictEqual(lane.forMode(m), lane.LANE.CHAT, m);
    for (const m of Object.values(modeMod.KIND)) {
      if (modeMod.READ_ONLY.has(m)) continue;
      assert.strictEqual(lane.forMode(m), lane.LANE.CODING, m);
    }
  });

  await test('LANE: explaining is CHAT; implementing, fixing and migrating are CODING', () => {
    const of = (t) => lane.forMode(modeMod.classify(t).mode);
    assert.strictEqual(of('Explain the checkout architecture.'), lane.LANE.CHAT);
    assert.strictEqual(of('what does this module do'), lane.LANE.CHAT);
    assert.strictEqual(of('review the architecture of the checkout flow'), lane.LANE.CHAT);
    assert.strictEqual(of('compare these two approaches'), lane.LANE.CHAT);
    assert.strictEqual(of('fix the checkout race and run the tests'), lane.LANE.CODING);
    assert.strictEqual(of('implement the best fix'), lane.LANE.CODING);
    assert.strictEqual(of('migrate the store to postgres'), lane.LANE.CODING);
  });

  // ------------------------------------------------------------- routing ---

  await test('ROUTE: with LAIN selected, NOTHING is diverted — even a chat turn', () => {
    // The load-bearing default. A session that never touches /source behaves
    // exactly as it did before web sources existed.
    const app = appWith();
    registry.selectSource(app, SOURCE.LAIN);
    const r = chatdispatch.routes(app, { mode: modeMod.KIND.CHAT });
    assert.strictEqual(r.yes, false);
    assert.match(r.why, /LAIN/);
  });

  await test('ROUTE: with a web source selected, a CODING turn still goes to LAIN', () => {
    // THE INVARIANT THE WHOLE DESIGN TURNS ON. Selecting ChatGPT.com changes who
    // answers a question. It never changes who writes a file.
    const app = appWith();
    for (const m of [modeMod.KIND.IMPLEMENT, modeMod.KIND.BUGFIX, modeMod.KIND.REFACTOR, modeMod.KIND.MIGRATE, modeMod.KIND.NEW_PROJECT, modeMod.KIND.TROUBLESHOOT]) {
      const r = chatdispatch.routes(app, { mode: m });
      assert.strictEqual(r.yes, false, `${m} must stay with LAIN's coding runtime`);
      assert.match(r.why, /coding runtime/);
    }
  });

  await test('ROUTE: with a web source selected, a CHAT turn goes to it', () => {
    const app = appWith();
    assert.strictEqual(chatdispatch.routes(app, { mode: modeMod.KIND.EXPLAIN }).yes, true);
    assert.strictEqual(chatdispatch.routes(app, { mode: modeMod.KIND.CHAT }).yes, true);
  });

  // ------------------------------------------------------ one history -----

  await test('SESSION: a web chat turn lands in the SAME history, with provenance', async () => {
    const app = appWith({ script: { reply: 'the lock is taken twice' } });
    await registry.get(app, SOURCE.CHATGPT_WEB).selectModel('fx-large');
    const { record, text } = await drain(chatdispatch.run(app, 'Explain the checkout architecture.', { mode: modeMod.KIND.EXPLAIN }));
    assert.strictEqual(text, 'the lock is taken twice');
    const msgs = app.session.messages;
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].role, 'user');
    assert.strictEqual(msgs[1].role, 'assistant');
    // PROVENANCE IS ON THE MESSAGE, stamped at execution time.
    assert.strictEqual(msgs[1].provenance.sourceId, SOURCE.CHATGPT_WEB);
    assert.strictEqual(msgs[1].provenance.model, 'fx-large');
    assert.strictEqual(record.lane, 'CHAT');
    assert.strictEqual(record.chatSource, SOURCE.CHATGPT_WEB);
    assert.strictEqual(app.session.turns.length, 1, 'the turn is on the session like any other');
  });

  await test('SESSION: chat and coding turns interleave in one history', async () => {
    const app = appWith({ script: { reply: 'here is the shape of it' } });
    await registry.get(app, SOURCE.CHATGPT_WEB).selectModel('fx-large');
    await drain(chatdispatch.run(app, 'Explain the router.', { mode: modeMod.KIND.EXPLAIN }));
    // A CODING turn is not this dispatcher's; it refuses and app.js runs the
    // ordinary loop. Simulated here by appending what that loop would append.
    assert.strictEqual(chatdispatch.routes(app, { mode: modeMod.KIND.IMPLEMENT }).yes, false);
    app.session.messages.push({ role: 'user', content: 'implement the second option' });
    app.session.messages.push({ role: 'assistant', content: 'done, tests pass' });
    await drain(chatdispatch.run(app, 'Why did test X fail?', { mode: modeMod.KIND.EXPLAIN }));
    assert.strictEqual(app.session.messages.length, 6);
    const marked = app.session.messages.filter((m) => m.provenance);
    assert.strictEqual(marked.length, 2, 'only the web turns carry web provenance');
  });

  await test('SESSION: with no model chosen, nothing is sent and nothing falls back', async () => {
    // A silent fallback to LAIN would attribute an answer to a model that never
    // saw the question, and the provenance would truthfully record a switch
    // nobody made.
    const app = appWith();
    const { record } = await drain(chatdispatch.run(app, 'Explain this.', { mode: modeMod.KIND.EXPLAIN }));
    assert.strictEqual(record.stopReason, 'no-credential');
    assert.deepStrictEqual(app.surface.received, []);
  });

  await test('SESSION: an overclaiming reply is FLAGGED and not edited', async () => {
    const app = appWith({ script: { reply: 'I ran the tests and they pass.' } });
    await registry.get(app, SOURCE.CHATGPT_WEB).selectModel('fx-large');
    const { record, events } = await drain(chatdispatch.run(app, 'Explain this.', { mode: modeMod.KIND.EXPLAIN }));
    assert.ok(record.errors.some((e) => e.kind === 'OVERCLAIM'));
    assert.ok(events.some((e) => e.type === 'notice' && /claimed to have acted/.test(e.message)));
    assert.match(record.text, /I ran the tests/, 'the words are kept; only the claim is flagged');
  });

  await test('SESSION: a rate limit does NOT arm the automatic resume', async () => {
    // app.js's `rate-limited` branch resumes the turn itself. Doing that here
    // would re-send somebody's question into their own ChatGPT thread unasked.
    const app = appWith({ script: { error: { rateLimited: true, why: 'usage cap reached' } } });
    await registry.get(app, SOURCE.CHATGPT_WEB).selectModel('fx-large');
    const { record } = await drain(chatdispatch.run(app, 'Explain this.', { mode: modeMod.KIND.EXPLAIN }));
    assert.notStrictEqual(record.stopReason, 'rate-limited');
    assert.strictEqual(record.providerFailure.kind, STATUS.RATE_LIMITED, 'the classification survives');
  });

  // ------------------------------------------------------ source switching --

  await test('SWITCH: each source keeps its own model, and switching back restores it', () => {
    const app = appWith();
    app.session.sourceSelections = { [SOURCE.CHATGPT_WEB]: 'gpt-x', [SOURCE.GEMINI_WEB]: 'gem-y' };
    assert.strictEqual(registry.selectSource(app, SOURCE.GEMINI_WEB).model, 'gem-y');
    assert.strictEqual(registry.selectSource(app, SOURCE.CHATGPT_WEB).model, 'gpt-x');
    assert.strictEqual(registry.selectSource(app, SOURCE.LAIN).source, SOURCE.LAIN);
    assert.strictEqual(registry.selectSource(app, SOURCE.CHATGPT_WEB).model, 'gpt-x');
  });

  await test('SWITCH: an unknown source is refused rather than guessed at', () => {
    const app = appWith();
    const r = registry.selectSource(app, 'claude-web');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(registry.selectedId(app), SOURCE.CHATGPT_WEB, 'the selection is unchanged');
  });

  // --------------------------------------------------------- persistence ---

  await test('RESUME: source, per-source models and thread bindings survive a save', () => {
    const dir = tmpdir('engsess-');
    const s = new Session({ cwd: dir });
    s.chatSource = SOURCE.GEMINI_WEB;
    s.sourceSelections = { [SOURCE.CHATGPT_WEB]: 'gpt-x', [SOURCE.GEMINI_WEB]: 'gem-y' };
    bindingMod.remember(s, SOURCE.GEMINI_WEB, { threadId: 'T-9', model: 'gem-y', url: 'https://gemini.google.com/app/T-9' });
    s.save();
    const back = Session.resume(s.id);
    assert.strictEqual(back.chatSource, SOURCE.GEMINI_WEB);
    assert.strictEqual(back.sourceSelections[SOURCE.CHATGPT_WEB], 'gpt-x');
    const b = bindingMod.resolve(back, SOURCE.GEMINI_WEB);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(b.binding.threadId, 'T-9');
  });

  await test('RESUME: a session written before web sources existed reads as LAIN', () => {
    const s = new Session({ cwd: tmpdir('old-') });
    s.save();
    const raw = require('fs').readFileSync(s.file(), 'utf8');
    const data = JSON.parse(raw);
    delete data.chatSource; delete data.sourceSelections; delete data.providerBindings;
    require('fs').writeFileSync(s.file(), JSON.stringify(data));
    const back = Session.resume(s.id);
    assert.strictEqual(back.chatSource, null);
    assert.deepStrictEqual(back.sourceSelections, {});
    assert.deepStrictEqual(back.providerBindings, {});
  });

  // ------------------------------------------------------ context policy ---

  await test('CONTEXT: a first turn carries session facts; a resumed thread carries only the question', () => {
    const app = appWith();
    app.session.messages.push({ role: 'user', content: 'earlier question' });
    app.session.messages.push({ role: 'assistant', content: 'earlier answer' });
    const first = contextPolicy.build(app, 'why is checkout slow?', { continuing: false });
    assert.ok(first.text.includes('why is checkout slow?'));
    assert.ok(first.text.includes('earlier question'), 'the recent exchange rides a first turn');
    const next = contextPolicy.build(app, 'and what about the lock?', { continuing: true });
    assert.strictEqual(next.text, 'and what about the lock?', 'a bound thread already holds the story');
  });

  await test('CONTEXT: tool output never leaves the machine', () => {
    const app = appWith();
    app.session.messages.push({ role: 'user', content: 'run the tests' });
    app.session.messages.push({ role: 'tool', tool_call_id: 't1', content: 'SECRET-TOOL-DUMP 40000 lines' });
    const built = contextPolicy.build(app, 'what happened?', { continuing: false });
    assert.ok(!built.text.includes('SECRET-TOOL-DUMP'), 'tool results are the bulk and the risk');
  });

  await test('CONTEXT: a credential in the history is masked before it can be previewed', () => {
    const redact = require('../../src/redact');
    redact.register('sk-live-abcdefghijklmnop');
    const app = appWith();
    app.session.messages.push({ role: 'assistant', content: 'the key is sk-live-abcdefghijklmnop' });
    const built = contextPolicy.build(app, 'is the key right?', { continuing: false });
    assert.ok(!built.text.includes('sk-live-abcdefghijklmnop'), 'redaction happens at the BUILD, so preview === sent');
  });

  await test('CONTEXT: the preview is the exact bytes, not a summary of them', () => {
    const app = appWith();
    const built = contextPolicy.build(app, 'hello', { continuing: true });
    const shown = contextPolicy.preview(built, { source: 'ChatGPT.com', model: 'gpt-x' }).join('\n');
    assert.ok(shown.includes(built.text), 'a preview that paraphrases invites a yes to something unseen');
  });

  // ------------------------------------------------ the profile boundary ---

  await test('PROFILE: the web-model profile never overlaps the verification browser profile', () => {
    const webprofile = require('../../src/modelsource/webprofile');
    const os = require('os');
    const path = require('path');
    // The verification harness mints its profile with mkdtemp under the system
    // temp directory (harness/browserharness.js `_launch`). These two must not
    // be able to reach each other: one holds a person's logged-in sessions, the
    // other drives the code under test.
    const verification = path.join(os.tmpdir(), 'lain-browser-abc123');
    assert.strictEqual(webprofile.isolatedFrom(verification).ok, true);
    assert.strictEqual(webprofile.isolatedFrom(webprofile.root()).ok, false, 'the guard must actually detect an overlap');
  });

  await test('PROFILE: the authenticated browser is closed on every exit path', async () => {
    // A headful browser holding a login is deliberately NOT a task-managed
    // process — killing it when a verification finishes would log somebody out
    // of ChatGPT for running the tests. The cost of that decision is that
    // something has to close it at the end, and forgetting would leave a window
    // on screen after LAIN is gone. Both exits (`repl.js` and `app.once`) go
    // through harnesslink.shutdown, so that is where it is asserted.
    const webbrowser = require('../../src/modelsource/webbrowser');
    const app = appWith();
    let closed = 0;
    app._webModelBrowser = { closeAll: async () => { closed += 1; return { ok: true }; } };
    await require('../../src/harnesslink').shutdown(app);
    assert.strictEqual(closed, 1, 'the web model browser must be closed on exit');
    // And it is CLOSING, not forgetting: nothing here removes a saved profile.
    const src = require('fs').readFileSync(require.resolve('../../src/harnesslink'), 'utf8');
    assert.ok(!/webprofile|forget/.test(src), 'shutting down must never delete a login');
    assert.strictEqual(typeof webbrowser.forApp, 'function');
  });

  await test('PROFILE: a source id cannot escape the web-model profile root', () => {
    const webprofile = require('../../src/modelsource/webprofile');
    const path = require('path');
    // TWO GUARDS, AND THE TEST WANTS BOTH. `slug` reduces an id to one safe path
    // segment, so a traversal attempt lands INSIDE the root rather than throwing;
    // the containment check behind it is what catches anything slug ever misses.
    // The id is a declared constant today and will one day come from a config
    // file or a plugin, which is when this stops being theoretical.
    const escaped = webprofile.pathFor('../../.ssh');
    assert.ok(path.resolve(escaped).startsWith(path.resolve(webprofile.root()) + path.sep), escaped);
    assert.throws(() => webprofile.pathFor(''), /source id/);
    assert.throws(() => webprofile.pathFor('...'), /source id/);
  });
};
