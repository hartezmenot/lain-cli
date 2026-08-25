'use strict';

/**
 * `/external <text>` — THE ORDER, AND THAT NOTHING JUMPS IT.
 *
 * The command used to be configuration and only configuration, so
 * `/external create a plan for this` searched the model catalog for the phrase
 * "create a plan for this" and answered "No model matches". Every sentence a
 * person would naturally type did the same thing.
 *
 * These check the replacement, and the half that matters most is the NEGATIVE
 * half: a draft is not a send. So there are tests here for every route by which
 * something could leave without being confirmed — an unconfirmed draft, a
 * second Enter, a dismissed panel, a pipe with nobody to ask — because "it
 * usually asks first" is not a boundary.
 */

const assert = require('assert');
const { test } = require('../helpers');

const X = require('../../src/externalrequest');
const externalstate = require('../../src/externalstate');
const { Plan } = require('../../src/plan');
const { Lifecycle } = require('../../src/lifecycle');

/** An app with no provider, no UI and no network — a draft must not need one. */
function app({ ui = false, cfg = {} } = {}) {
  const out = [];
  // ---- TWO SURFACES, AND THEY ARE NOT INTERCHANGEABLE --------------------
  //
  // `render.write` under a TUI is the COMMAND SURFACE — the scrollable panel a
  // slash command draws into, which closes. `noteActor` is the CONVERSATION.
  // A rig that recorded only the first could not tell a compact event in the
  // feed from a wall of text in a panel, and that is exactly the pair of
  // defects the live run found. Both are captured now.
  const noted = [];
  const noop = () => {};
  return {
    _out: out,
    _noted: noted,
    render: new Proxy({ write: (s) => out.push(String(s)) }, { get: (t, k) => t[k] || noop }),
    session: { cwd: process.cwd(), id: 's1' },
    cfg,
    ui: ui
      ? { enabled: true, ask: async () => null, noteActor: (kind, text) => noted.push(`${kind}: ${text}`) }
      : { enabled: false },
    checkpoints: null,
    // ---- WHAT A SUCCESSFUL CONSULTATION NOW DOES -------------------------
    //
    // An external reply is no longer printed and dropped. It is handed to the
    // local agent as an ordinary turn on the SAME task, because the advisor has
    // no filesystem and LAIN does — see src/externalrequest.js `advisoryBrief`.
    // The rig records that submission so a test can assert on it.
    _submitted: [],
    async submit(text, opts) { this._submitted.push({ text, opts }); return { text: 'done' }; },
    ensureCatalog: async () => {},
    catalog: () => null,
    text() { return out.join(''); },
  };
}

const C = new Proxy({}, { get: () => (s) => String(s == null ? '' : s) });

module.exports = async function () {
  // ---- DRAFTING IS LOCAL AND FREE ----------------------------------------

  await test('EXT: a sentence is drafted, not searched for in the model catalog', async () => {
    const a = app();
    await X.runRequest(a, 'create a plan for this', { C });
    const t = a.text();
    assert.ok(!/No model matches/.test(t), 'the old failure was a catalog search');
    assert.ok(/WHAT THE USER ASKED FOR/.test(t), t.slice(0, 200));
    assert.ok(/create a plan for this/.test(t));
  });

  await test('EXT: DRAFTING TOUCHES NO PROVIDER — the module is never even loaded into use', () => {
    // The claim is that typing `/external` costs nothing. Proved by breaking
    // the only thing that could spend anything and drafting anyway.
    const providerMod = require('../../src/provider');
    const realChat = providerMod.chat;
    let called = 0;
    providerMod.chat = () => { called += 1; throw new Error('a draft must not call a provider'); };
    try {
      const d = X.draft(app(), 'write a complaint about this');
      assert.strictEqual(d.ok, true);
      assert.strictEqual(called, 0, 'drafting spent a request');
    } finally {
      providerMod.chat = realChat;
    }
  });

  await test('EXT: a fresh draft is NOT sent, and says which state it is in', () => {
    const d = X.draft(app(), 'this looks like a bug');
    assert.strictEqual(d.sent, false);
    assert.strictEqual(d.confirmed, undefined);
    assert.strictEqual(d.state, externalstate.STATE.EXTERNAL_REQUESTED);
  });

  await test('EXT: intent is read from the words, locally', () => {
    const a = app();
    assert.strictEqual(X.draft(a, 'create a plan for this').intent, X.INTENT.PLAN);
    assert.strictEqual(X.draft(a, 'this looks like a bug').intent, X.INTENT.BUG);
    assert.strictEqual(X.draft(a, 'write a complaint').intent, X.INTENT.COMPLAINT);
    assert.strictEqual(X.draft(a, 'tell them about it').intent, X.INTENT.MESSAGE);
  });

  await test('EXT: the preview is the EXACT bytes, not a summary of them', () => {
    // A preview that paraphrases invites a yes to something never actually
    // seen. The packet has to appear in the preview verbatim.
    const d = X.draft(app(), 'review the parser change');
    const shown = X.preview(d).join('\n');
    for (const line of d.packet.split('\n')) {
      assert.ok(shown.includes(line), `the preview omitted: ${line}`);
    }
    assert.ok(shown.includes('NOTHING HAS BEEN SENT.'));
  });

  await test('EXT: the session facts that would leave are LISTED, not smuggled', () => {
    const d = X.draft(app(), 'review this');
    assert.ok(d.packet.includes('WHAT LAIN CAN SEE'));
    assert.ok(d.packet.includes(process.cwd()), 'the working directory is going with it and must be visible');
  });

  // ---- THE FACTS ARE READ FROM THE RUNTIME'S OWN RECORDS -------------------
  //
  // Both rows this covers used to read invented fields (`x.done` on plan
  // steps, `s.lastVerification` on the session), so the packet said "0/N
  // steps done" forever and nothing about a red check — the advisor was
  // handed the transcript and left to reconstruct state from prose, exactly
  // the failure this mission exists to remove. A step that has genuinely
  // finished must count, and a red check must be the fact that travels.

  await test('EXT: a genuinely done step counts in the packet, and a red check travels', () => {
    const a = app();
    const plan = new Plan('review the parser');
    plan.addSteps(['inspect it', 'fix it']);
    plan.complete('read the parser');
    a.session.plan = plan;
    const life = new Lifecycle('review the parser');
    life.observeTool({ name: 'run_bash', input: { command: 'node check.js' }, output: '1 failing', isError: true, exitCode: 1 });
    a.session.lifecycle = life;

    const d = X.draft(a, 'review this');
    assert.ok(d.facts.some(([k, v]) => k === 'plan' && v === '1/2 steps done'),
      `a done step must count — the steps carry \`status\`, and the count reads it:\n${d.facts}`);
    assert.ok(d.facts.some(([k, v]) => k === 'last check' && v === 'node check.js — failed'),
      `a red check is the fact an advisor needs most and cannot see any other way:\n${d.facts}`);
  });

  await test('EXT: empty text drafts nothing', () => {
    assert.strictEqual(X.draft(app(), '   ').ok, false);
  });

  // ---- NOTHING LEAVES WITHOUT A YES --------------------------------------

  await test('EXT: send REFUSES AN UNCONFIRMED DRAFT', async () => {
    const d = X.draft(app(), 'send this somewhere');
    const r = await X.send(app(), d, { actor: { kind: 'API', review: async () => ({ ok: true, text: 'hi' }) } });
    assert.strictEqual(r.ok, false);
    assert.ok(/not been confirmed/.test(r.why), r.why);
    assert.strictEqual(d.sent, false, 'and it must not be marked as sent');
  });

  await test('EXT: send REFUSES A SECOND DISPATCH — one Enter, one packet', async () => {
    let calls = 0;
    const actor = { kind: 'API', review: async () => { calls += 1; return { ok: true, text: 'answer' }; } };
    const a = app();
    const d = X.draft(a, 'ask them');
    d.confirmed = true;
    await X.send(a, d, { actor });
    const again = await X.send(a, d, { actor });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(calls, 1, 'the packet was dispatched twice');
  });

  await test('EXT: with NO ACTOR configured, nothing is sent and the draft is kept', async () => {
    const a = app();
    await X.runRequest(a, 'have a look at this', { C });
    assert.ok(X.pending(a), 'the draft must survive so it can be sent once an actor exists');
    assert.ok(/NO EXTERNAL ACTOR/.test(a.text()));
  });

  await test('EXT: WITH NO SCREEN THERE IS NO SEND — a pipe dispatches nothing', async () => {
    // A send that happens because nobody could object is exactly what this
    // flow exists to prevent.
    const a = app({ cfg: { externalTroubleshoot: { enabled: true, actor: 'API', model: 'm' } } });
    let dispatched = 0;
    const real = require('../../src/actors').create;
    require('../../src/actors').create = () => ({
      kind: 'API',
      status: () => ({ kind: 'API', label: 'API', ok: true }),
      review: async () => { dispatched += 1; return { ok: true, text: 'x' }; },
    });
    try {
      await X.runRequest(a, 'send this to the other model', { C });
      assert.strictEqual(dispatched, 0, 'a non-interactive run must not dispatch');
      assert.ok(X.pending(a), 'it is held instead');
      assert.ok(/no interactive terminal/.test(a.text()), a.text().slice(-200));
    } finally { require('../../src/actors').create = real; }
  });

  await test('EXT: a DISMISSED panel is not a yes', async () => {
    const a = app({ ui: true, cfg: { externalTroubleshoot: { enabled: true, actor: 'API', model: 'm' } } });
    a.ui.ask = async () => null;                    // Escape / EOF / dismissed
    let dispatched = 0;
    const actors = require('../../src/actors');
    const real = actors.create;
    actors.create = () => ({
      kind: 'API',
      status: () => ({ kind: 'API', label: 'API', ok: true }),
      review: async () => { dispatched += 1; return { ok: true, text: 'x' }; },
    });
    try {
      await X.runRequest(a, 'ask the other model about this', { C });
      assert.strictEqual(dispatched, 0);
      assert.strictEqual(X.pending(a), null, 'a cancel drops the draft');
    } finally { actors.create = real; }
  });

  await test('EXT: CHOOSING "Send it" is what dispatches, and only then', async () => {
    const a = app({ ui: true, cfg: { externalTroubleshoot: { enabled: true, actor: 'API', model: 'm' } } });
    const seen = [];
    a.ui.ask = async (spec) => { seen.push(spec); return 'Send it'; };
    let packet = null;
    const actors = require('../../src/actors');
    const real = actors.create;
    actors.create = () => ({
      kind: 'API',
      status: () => ({ kind: 'API', label: 'API', ok: true }),
      review: async (p) => { packet = p; return { ok: true, text: 'the answer' }; },
    });
    try {
      await X.runRequest(a, 'ask about the parser', { C });
      assert.ok(packet, 'nothing was dispatched after an explicit yes');
      assert.ok(packet.includes('ask about the parser'));
      assert.strictEqual(seen.length, 1, 'exactly one question was asked');
      // ---- THE REPLY IS ACTED ON, NOT PRINTED -----------------------------
      //
      // This used to assert the answer appeared in the output, which is exactly
      // the behaviour that was wrong: the advisor's text was dumped into the
      // conversation and the workflow stopped. What must be true now is that
      // the conversation says a consultation happened, and the ADVICE reaches
      // the local agent as a turn on the same task.
      // ANNOUNCED ON THE CHANNEL THE FEED DRAWS, which is `noteActor` and not
      // `render.write`. Under a TUI `render.write` is the COMMAND SURFACE, so
      // asserting there was asserting about a panel the conversation never
      // shows — the mistake this whole file's contract was rewritten to catch.
      assert.ok(a._noted.some((n) => /external consultation/.test(n)),
        `the consultation is announced in the conversation, got: ${JSON.stringify(a._noted)}`);
      assert.match(a.text(), /EXTERNAL ADVICE/,
        'and the advisor own words go to the command surface, where there is room for them');
      assert.strictEqual(a._submitted.length, 1, 'the advice must reach the local agent');
      assert.ok(/the answer/.test(a._submitted[0].text), 'carrying what the advisor said');
      assert.strictEqual(a._submitted[0].opts.sameTask, true, "and the user's task stays authoritative");
      assert.strictEqual(X.pending(a), null, 'the draft is spent');
    } finally { actors.create = real; }
  });

  await test('EXT: an empty reply is a FAILURE, never a successful external path', async () => {
    // externalstate refuses RESPONDED without text; this checks the refusal
    // survives all the way out to the caller rather than reading as success.
    const a = app();
    const d = X.draft(a, 'ask them');
    d.confirmed = true;
    const r = await X.send(a, d, { actor: { kind: 'API', review: async () => ({ ok: true, text: '   ' }) } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.state, externalstate.STATE.EXTERNAL_FAILED);
  });

  await test('EXT: a dispatched call is recorded in the session ledger', () => {
    const a = app();
    const d = X.draft(a, 'ask them');
    d.confirmed = true;
    return X.send(a, d, { actor: { kind: 'API', review: async () => ({ ok: true, text: 'ok' }) } })
      .then(() => {
        const ledger = externalstate.forSession(a.session);
        assert.strictEqual(ledger.calls.length, 1);
        assert.strictEqual(ledger.calls[0].state, externalstate.STATE.EXTERNAL_RESPONDED);
      });
  });

  // ---- THE SHORTHAND THAT HAD TO KEEP WORKING ----------------------------

  await test('EXT: a MODEL NAME is one token; a request has spaces', () => {
    assert.strictEqual(X.looksLikeModelName('gpt-5'), true);
    assert.strictEqual(X.looksLikeModelName('claude-opus-5'), true);
    assert.strictEqual(X.looksLikeModelName('create a plan for this'), false);
    assert.strictEqual(X.looksLikeModelName('browser'), true);
  });

  await test('EXT: /external <model> still reaches the catalog, not the drafter', async () => {
    const cmds = require('../../src/commands');
    const a = app();
    let searched = null;
    a.catalog = () => ({ models: [] });
    a.ensureCatalog = async () => { searched = 'yes'; };
    await cmds.run(a, '/external some-model-name');
    assert.strictEqual(searched, 'yes', 'a single token must still be treated as a model name');
    assert.strictEqual(X.pending(a), null, 'and must not have drafted anything');
  });

  await test('EXT: /external <sentence> reaches the drafter through the real registry', async () => {
    const cmds = require('../../src/commands');
    const a = app();
    await cmds.run(a, '/external write a complaint about the build');
    assert.ok(X.pending(a), 'a sentence must draft');
    assert.ok(/WHAT THE USER ASKED FOR/.test(a.text()));
  });

  await test('EXT: /external browser <text> selects the browser AND drafts for it', async () => {
    // Item 10: the browser must not be a route that bypasses LAIN. Selecting it
    // and addressing it are the same command, and the draft still happens.
    const cmds = require('../../src/commands');
    const a = app();
    await cmds.run(a, '/external browser this looks like a bug');
    assert.strictEqual((a.cfg.externalTroubleshoot || {}).actor, 'BROWSER');
    const d = X.pending(a);
    assert.ok(d, 'it must draft rather than only configure');
    assert.strictEqual(d.actorKind, 'BROWSER');
    assert.strictEqual(d.sent, false, 'and still send nothing');
  });

  await test('EXT: /external browser alone is still just the setting', async () => {
    const cmds = require('../../src/commands');
    const a = app();
    await cmds.run(a, '/external browser');
    assert.strictEqual((a.cfg.externalTroubleshoot || {}).actor, 'BROWSER');
    assert.strictEqual(X.pending(a), null);
  });

  await test('EXT: /external cancel discards without sending', async () => {
    const cmds = require('../../src/commands');
    const a = app();
    await cmds.run(a, '/external look at this for me');
    assert.ok(X.pending(a));
    await cmds.run(a, '/external cancel');
    assert.strictEqual(X.pending(a), null);
  });

  await test('EXT: single WORDS people type are subcommands, not model searches', async () => {
    // `/external status` answered `No model matches "status"` — the shorthand
    // below treats any single token as a model name, and these are words people
    // type at a CLI far more often than they are model ids.
    const cmds = require('../../src/commands');
    for (const word of ['status', 'list', 'send', 'show', 'cancel']) {
      const a = app();
      let searched = false;
      a.ensureCatalog = async () => { searched = true; };
      a.catalog = () => ({ models: [] });
      await cmds.run(a, `/external ${word}`);
      assert.strictEqual(searched, false, `/external ${word} reached the model catalog`);
      assert.ok(!/No model matches/.test(a.text()), `/external ${word}: ${a.text()}`);
    }
  });

  await test('EXT: /external send with nothing drafted sends nothing and says so', async () => {
    const cmds = require('../../src/commands');
    const a = app();
    await cmds.run(a, '/external send');
    assert.ok(/nothing drafted/.test(a.text()), a.text());
  });
};
