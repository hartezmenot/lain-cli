'use strict';

/**
 * THE EXTERNAL CONVERSATION WORKFLOW — dispatch, capture, choose, continue.
 *
 * Every test here stands for one of the gaps the audit found:
 *
 *   · an adapter returning an object was indistinguishable from an answer
 *   · one shared actor meant two calls could overwrite each other
 *   · `open(url)` every round started a NEW chat, so nothing continued
 *   · an image reached the provider as a DESCRIPTION and never as an image
 *   · the answer was consumed by the orchestrator and never offered as a choice
 *
 * The browser is stubbed at the RUNTIME boundary — the real CDP transport is
 * not exercised here, and no test contacts a provider. What is proved is the
 * execution path: which calls were made, with what, in what state, and what
 * became of the result.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const externalstate = require('../../src/externalstate');
const panel = require('../../src/externalpanel');
const { STATE } = externalstate;

/**
 * A browser runtime that records instead of driving Chromium.
 *
 * `reply` is what the page will appear to say. `fileInput` null means the page
 * has no file input, which is the case that must FAIL rather than send text
 * alone.
 */
function fakeRuntime({ reply = 'a real answer', hasFileInput = true, failOpen = null } = {}) {
  return {
    running: true,
    opens: [],
    typed: [],
    attached: [],
    keys: [],
    async start() { return { ok: true }; },
    async open(url) { this.opens.push(url); if (failOpen) return { ok: false, error: failOpen }; this.url = url; return { ok: true }; },
    async inspect(sel) {
      // The compose box exists; everything else does not.
      if (sel === '#prompt-textarea') return { ok: true, found: true, visible: true, text: reply };
      return { ok: true, found: false };
    },
    async fileInput() { return hasFileInput ? 'input[type="file"]' : null; },
    async attach(sel, files) { this.attached.push({ sel, files }); return { ok: true, files, selector: sel }; },
    async type(sel, text) { this.typed.push({ sel, text }); return { ok: true }; },
    async key(k) { this.keys.push(k); return { ok: true }; },
  };
}

/** An app whose browser runtimes are the fakes above, one per provider. */
function fakeApp(providers, runtimes) {
  const cfg = { externalTroubleshoot: { actor: 'BROWSER', providers } };
  const app = { cfg, session: {}, _browsers: new Map(), render: { write() {} }, ui: { enabled: false } };
  const browser = require('../../src/browser');
  const real = browser.runtimeFor;
  browser.runtimeFor = (a, id) => runtimes[id] || runtimes.default;
  app._restore = () => { browser.runtimeFor = real; };
  return app;
}

module.exports = async function () {
  // ---------------------------------------------------- the state machine ---

  await test('EXTERNAL: an adapter that returns nothing is FAILED, never RESPONDED', () => {
    // The guard the whole audit turned on: "the adapter returned an object" is
    // not "the provider answered".
    const l = new externalstate.ExternalLedger();
    const c = l.open({ provider: 'gpt' });
    c.dispatch('browser');
    c.respond('');
    assert.strictEqual(c.state, STATE.EXTERNAL_FAILED);
    assert.match(c.error, /no text/);
    assert.strictEqual(c.answered, false);
  });

  await test('EXTERNAL: a real answer reaches RESPONDED and carries its text', () => {
    const l = new externalstate.ExternalLedger();
    const c = l.open({ provider: 'gpt' });
    c.dispatch('browser');
    c.respond('use a per-client send lock');
    assert.strictEqual(c.state, STATE.EXTERNAL_RESPONDED);
    assert.strictEqual(c.response, 'use a per-client send lock');
  });

  await test('EXTERNAL: a timeout is its own state, not a content failure', () => {
    const c = new externalstate.ExternalCall({ provider: 'gpt' });
    c.dispatch('browser');
    c.timeout('nothing settled in 180s');
    assert.strictEqual(c.state, STATE.EXTERNAL_TIMEOUT);
    assert.strictEqual(c.failed, true);
  });

  await test('EXTERNAL: USED and DISCARDED are different endings', () => {
    // "It answered" and "its answer was taken" are separate facts, and the
    // second is the only one that means the workflow actually completed.
    const a = new externalstate.ExternalCall({ provider: 'gpt' });
    const b = new externalstate.ExternalCall({ provider: 'gemini' });
    for (const c of [a, b]) { c.dispatch('browser'); c.respond('x'); }
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
    a.dispatch('browser'); b.dispatch('browser');
    a.respond('answer A');
    b.fail('page had no message box');
    assert.notStrictEqual(a.id, b.id);
    assert.strictEqual(a.response, 'answer A');
    assert.strictEqual(b.response, null);
    assert.strictEqual(l.get(a.id).state, STATE.EXTERNAL_RESPONDED);
    assert.strictEqual(l.get(b.id).state, STATE.EXTERNAL_FAILED);
  });

  await test('EXTERNAL: the overall state reports USED only when something was used', () => {
    const l = new externalstate.ExternalLedger();
    const a = l.open({ provider: 'gpt' });
    a.dispatch('browser'); a.respond('x');
    assert.strictEqual(l.overall(), STATE.EXTERNAL_RESPONDED, 'answered is not the same as used');
    a.use();
    assert.strictEqual(l.overall(), STATE.EXTERNAL_RESULT_USED);
  });

  await test('EXTERNAL: with nothing configured the state is NOT_REQUESTED', () => {
    assert.strictEqual(new externalstate.ExternalLedger().overall(), STATE.NOT_REQUESTED);
  });

  // ------------------------------------------------------------- fan-out ---

  await test('PANEL: both providers are asked, each with its own call record', async () => {
    const runtimes = {
      chatgpt: fakeRuntime({ reply: 'GPT says use a lock' }),
      gemini: fakeRuntime({ reply: 'Gemini says drop dead peers' }),
    };
    const app = fakeApp(
      [{ id: 'chatgpt', url: 'https://chatgpt.com/' }, { id: 'gemini', url: 'https://gemini.google.com/' }],
      runtimes,
    );
    try {
      const r = await panel.ask(app, 'the packet', { session: app.session });
      assert.deepStrictEqual(r.providers, ['chatgpt', 'gemini']);
      assert.strictEqual(r.calls.length, 2, 'one record per provider');
      assert.strictEqual(new Set(r.calls.map((c) => c.id)).size, 2, 'and the ids are distinct');
      assert.ok(runtimes.chatgpt.typed.length, 'GPT was actually typed into');
      assert.ok(runtimes.gemini.typed.length, 'and so was Gemini');
    } finally { app._restore(); }
  });

  await test('PANEL: answers become selectable choices, including BOTH', async () => {
    const l = new externalstate.ExternalLedger();
    const a = l.open({ provider: 'chatgpt' });
    const b = l.open({ provider: 'gemini' });
    a.dispatch('browser'); a.respond('answer A');
    b.dispatch('browser'); b.respond('answer B');
    const options = panel.choicesFrom([a, b]);
    assert.strictEqual(options.length, 3, 'two answers plus BOTH');
    assert.ok(options.some((o) => o.provider === 'chatgpt'));
    assert.ok(options.some((o) => o.provider === 'gemini'));
    const both = options.find((o) => o.id === 'BOTH');
    assert.ok(both.text.includes('answer A') && both.text.includes('answer B'));
  });

  await test('PANEL: a failed provider is not offered as a choice', async () => {
    const a = new externalstate.ExternalCall({ provider: 'chatgpt' });
    const b = new externalstate.ExternalCall({ provider: 'gemini' });
    a.dispatch('browser'); a.respond('answer A');
    b.fail('no message box on the page');
    const options = panel.choicesFrom([a, b]);
    assert.strictEqual(options.length, 1, 'only the one that answered');
    assert.strictEqual(options[0].provider, 'chatgpt');
  });

  await test('PANEL: choosing one marks it USED and the other DISCARDED', () => {
    const a = new externalstate.ExternalCall({ provider: 'chatgpt' });
    const b = new externalstate.ExternalCall({ provider: 'gemini' });
    for (const c of [a, b]) { c.dispatch('browser'); c.respond('x'); }
    panel.settle([a, b], a.id);
    assert.strictEqual(a.state, STATE.EXTERNAL_RESULT_USED);
    assert.strictEqual(b.state, STATE.EXTERNAL_RESULT_DISCARDED);
  });

  // ------------------------------------------ the failure that must propagate

  await test('FAILURE: a provider that cannot be reached is FAILED with its real reason', async () => {
    // Requirement: never report COMPLETE because an adapter returned an object.
    const runtimes = { chatgpt: fakeRuntime({ failOpen: 'net::ERR_NAME_NOT_RESOLVED' }) };
    const app = fakeApp([{ id: 'chatgpt', url: 'https://chatgpt.com/' }], runtimes);
    try {
      const r = await panel.ask(app, 'the packet', { session: app.session });
      assert.strictEqual(r.answered.length, 0);
      assert.strictEqual(r.failed.length, 1);
      assert.notStrictEqual(r.overall, STATE.EXTERNAL_RESULT_USED);
      assert.notStrictEqual(r.overall, STATE.EXTERNAL_RESPONDED);
      assert.ok(r.calls[0].error, 'the real reason must be recorded');
    } finally { app._restore(); }
  });

  await test('FAILURE: an adapter that throws does not lose the exception', async () => {
    const boom = fakeRuntime();
    boom.type = async () => { throw new Error('CDP socket closed'); };
    const app = fakeApp([{ id: 'chatgpt', url: 'https://chatgpt.com/' }], { chatgpt: boom });
    try {
      const r = await panel.ask(app, 'the packet', { session: app.session });
      assert.strictEqual(r.failed.length, 1);
      assert.match(r.calls[0].error, /CDP socket closed/, 'the exception must reach the call record');
    } finally { app._restore(); }
  });

  // ------------------------------------------------------------- continuity --

  await test('CONTINUITY: a second send does NOT re-open the page', async () => {
    // The defect: open(url) every round, with ?temporary-chat=true, started a
    // fresh conversation each time.
    const rt = fakeRuntime({ reply: 'ok' });
    const app = fakeApp([{ id: 'chatgpt', url: 'https://chatgpt.com/' }], { chatgpt: rt });
    try {
      await panel.ask(app, 'first', { session: app.session });
      const opensAfterFirst = rt.opens.length;
      await panel.ask(app, 'second', { session: app.session });
      assert.strictEqual(opensAfterFirst, 1, 'the first send opens the page');
      assert.strictEqual(rt.opens.length, 1,
        `the second send re-opened the page (${rt.opens.length} opens) — the conversation restarted`);
      assert.strictEqual(rt.typed.length, 2, 'and both messages were typed into it');
    } finally { app._restore(); }
  });

  await test('CONTINUITY: providers get separate profiles, so they cannot share a session', () => {
    const browser = require('../../src/browser');
    const gpt = browser.dirs('chatgpt').profile;
    const gem = browser.dirs('gemini').profile;
    const def = browser.dirs().profile;
    assert.notStrictEqual(gpt, gem, 'two providers must not share a cookie jar');
    assert.notStrictEqual(gpt, def, 'and neither may take over the default profile');
    assert.ok(gpt.includes('chatgpt') && gem.includes('gemini'));
  });

  await test('CONTINUITY: the default profile path is unchanged for existing callers', () => {
    const browser = require('../../src/browser');
    assert.ok(browser.dirs().profile.endsWith(path.join('browser', 'profile')),
      'the shared profile must stay exactly where it was');
  });

  // ------------------------------------------------------------------ images --

  await test('IMAGE: a real file is ATTACHED to the page, not described', async () => {
    // The whole of the second steer. The image must reach the provider as an
    // upload; a description is what it used to get.
    const dir = tmpdir('lain-img-');
    const img = path.join(dir, 'screenshot.png');
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const rt = fakeRuntime({ reply: 'I can see a chessboard' });
    const app = fakeApp([{ id: 'chatgpt', url: 'https://chatgpt.com/' }], { chatgpt: rt });
    try {
      const r = await panel.ask(app, 'what is in this image?', { images: [img], session: app.session });
      assert.strictEqual(rt.attached.length, 1, 'the file input was actually used');
      assert.deepStrictEqual(rt.attached[0].files, [img], 'with the REAL path, not a description');
      assert.deepStrictEqual(r.calls[0].attachments, [img], 'and the call records the attachment');
    } finally { app._restore(); }
  });

  await test('IMAGE: the attachment happens BEFORE the text is typed', async () => {
    // A chat page attaches to the message being composed. Typing and sending
    // first posts the words without the picture.
    const dir = tmpdir('lain-img2-');
    const img = path.join(dir, 'a.png');
    fs.writeFileSync(img, 'x');
    const order = [];
    const rt = fakeRuntime();
    const attach = rt.attach.bind(rt);
    const type = rt.type.bind(rt);
    rt.attach = async (...a) => { order.push('attach'); return attach(...a); };
    rt.type = async (...a) => { order.push('type'); return type(...a); };
    const app = fakeApp([{ id: 'chatgpt', url: 'https://chatgpt.com/' }], { chatgpt: rt });
    try {
      await panel.ask(app, 'describe it', { images: [img], session: app.session });
      assert.deepStrictEqual(order, ['attach', 'type']);
    } finally { app._restore(); }
  });

  await test('IMAGE: a page with no file input FAILS rather than sending text alone', async () => {
    // Sending the words without the picture produces an answer about nothing,
    // and it looks like success.
    const dir = tmpdir('lain-img3-');
    const img = path.join(dir, 'a.png');
    fs.writeFileSync(img, 'x');
    const rt = fakeRuntime({ hasFileInput: false });
    const app = fakeApp([{ id: 'chatgpt', url: 'https://chatgpt.com/' }], { chatgpt: rt });
    try {
      const r = await panel.ask(app, 'describe it', { images: [img], session: app.session });
      assert.strictEqual(r.answered.length, 0);
      assert.match(r.calls[0].error, /could NOT be attached/);
      assert.strictEqual(rt.typed.length, 0, 'and nothing was typed');
    } finally { app._restore(); }
  });

  await test('IMAGE: a missing file is refused before anything is sent', () => {
    // browser.attach checks every path first: a silent partial attach is the
    // failure that looks like success.
    const { BrowserRuntime } = require('../../src/browser');
    const b = new BrowserRuntime({});
    return b.attach('input[type=file]', ['/definitely/not/here.png']).then((r) => {
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /not running|no such file/);
    });
  });

  await test('IMAGE: LAIN never fabricates an ASCII stand-in for a picture', () => {
    // The audit found the image was OMITTED, not ASCII-ed — ui/images.js
    // deliberately refuses to approximate. That refusal must stay: an ASCII
    // rendering must never become what a vision model is given.
    const src = fs.readFileSync(require.resolve('../../src/ui/images'), 'utf8');
    assert.match(src, /NOT SEEN/, 'an unviewed image must still say so');
    assert.doesNotMatch(src, /toAscii|asciiArt|ansiArt/i, 'no ASCII rendering may creep in');
  });

  // ------------------------------------------------- the visual language ---

  await test('BLOCKS: agent activity is quoted; the gutter is the whole mechanism', () => {
    // A glance down the left edge must separate what LAIN SAID from what it
    // DID, without reading a word.
    const B = require('../../src/ui/blocks');
    const rows = B.actionBlock('Ask external models for a second opinion', { width: 70 });
    assert.ok(rows.every((r) => r.includes(B.GUTTER)), 'every row of a block carries the gutter');
    assert.match(rows.join('\n'), /ACTION/);
  });

  await test('BLOCKS: a tool call and its outcome are ONE block', () => {
    // Rendered apart, a reader loses which result belongs to which call.
    const B = require('../../src/ui/blocks');
    const rows = B.toolBlock('browser to chatgpt', { width: 70, ok: true, status: 'responded, 42 chars' }).join('\n');
    assert.match(rows, /TOOL/);
    assert.match(rows, /browser to chatgpt/);
    assert.match(rows, /responded/);
  });

  await test('BLOCKS: an answer card is exactly rectangular at every width', () => {
    // A ragged right edge is what makes a terminal card look broken.
    const B = require('../../src/ui/blocks');
    const T = require('../../src/ui/text');
    for (const w of [40, 62, 100]) {
      const rows = B.answerCard('CHATGPT',
        'a fairly long answer that will certainly need wrapping at these widths', { width: w });
      assert.strictEqual(new Set(rows.map((r) => T.width(r))).size, 1,
        `card rows must all be one width at ${w}`);
    }
  });

  await test('BLOCKS: the SELECTED block says the answer became user input', () => {
    // Without this the next thing that happens is LAIN working on something
    // nobody typed, which reads as the system rewriting the user's input.
    const B = require('../../src/ui/blocks');
    const rows = B.selectedBlock('chatgpt', { width: 70 }).join('\n');
    assert.match(rows, /SELECTED/);
    assert.match(rows, /USER INPUT/);
  });

  await test('BLOCKS: a failure is its own block and is never dressed as a result', () => {
    const B = require('../../src/ui/blocks');
    const rows = B.failureBlock('EXTERNAL_FAILED', 'no message box on the page', { width: 70 }).join('\n');
    assert.match(rows, /FAILED/);
    assert.doesNotMatch(rows, /RESULT/);
  });

  await test('BLOCKS: the external flow and ordinary activity use the SAME primitives', () => {
    // The requirement is one visual language, and the only way to guarantee it
    // is one implementation — not two renderers kept in step by hand.
    const src = fs.readFileSync(require.resolve('../../src/investigation'), 'utf8');
    assert.match(src, /require\('\.\/ui\/blocks'\)/, 'the external path must use the shared blocks');
    assert.match(src, /actionBlock|toolBlock|selectedBlock/, 'and the shared primitives');
  });
};
