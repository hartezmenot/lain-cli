'use strict';

/**
 * THE EXTERNAL MODEL PROPOSES. LAIN INVESTIGATES. LAIN OWNS THE ANSWER.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, from a real session.
 *
 * A person asked for a diagnostic audit — "I felt like the project is not clean
 * or something clogging or causing bottleneck". LAIN consulted an outside
 * advisor, which correctly proposed collecting test durations, checking startup
 * timing, looking for repeated work and inspecting resource use.
 *
 * Then LAIN stopped and printed it.
 *
 * The advisor has no filesystem, no shell and no project — it was told so, and
 * it proposed exactly what a machine WITH those things should go and do. LAIN
 * has all three. It printed the proposal.
 *
 * ROOT CAUSE, and it is structural rather than a missing feature: `dispatch` is
 * a COMMAND. Commands do not start turns. So the reply was written to the
 * transcript and the function returned, and nothing existed to carry the advice
 * anywhere. The external answer was TERMINAL BY CONSTRUCTION.
 *
 * ------------------------------------------------------------------------
 * WHY EVERY EXISTING TEST PASSED. tests/unit/externalrequest.test.js asserts
 * the PRE-SEND boundary exhaustively — drafting touches no provider, an
 * unconfirmed draft is refused, a dismissed panel is not a yes, a dispatched
 * call is recorded — and stops there. What happens AFTER a successful reply was
 * never asserted, so the one behaviour that mattered had no test to fail.
 *
 * That is what this file is: the assertions that were missing.
 */

const assert = require('assert');
const { test } = require('../helpers');

const request = require('../../src/externalrequest');
const redact = require('../../src/redact');

const NL = String.fromCharCode(10);
const C = new Proxy({}, { get: () => (s) => String(s) });

const ADVICE = [
  'FACT',
  '  The project may be spending time in test setup.',
  'RECOMMENDATION',
  '  Collect test durations with --durations, inspect startup timing,',
  '  check for repeated work, and inspect CPU and memory use.',
].join(NL);

/**
 * An app that records what was SUBMITTED as a turn — which is the whole
 * question. A stub actor answers with advice and touches no network.
 */
function rig({ objective = 'audit the project for bottlenecks' } = {}) {
  const written = [];
  const submitted = [];
  const noted = [];
  /** The `detail` payload of each note, in step with `noted`. */
  const details = [];
  const app = {
    cfg: { externalTroubleshoot: { enabled: true, actor: 'api', model: 'm' } },
    session: { cwd: process.cwd(), task: { objective }, actors: [], turns: [] },
    checkpoints: null,
    render: { write: (s) => written.push(String(s)) },
    ui: {
      enabled: true,
      noteActor: (kind, text, opts = {}) => { noted.push(`${kind}: ${text}`); details.push(opts.detail || null); },
    },
    submit: async (text, opts) => { submitted.push({ text, opts }); return { text: 'done' }; },
  };
  return { app, written, submitted, noted, details, out: () => written.join('') };
}

/** Stand in for the configured actor, so nothing leaves the machine. */
async function withActor(reply, fn) {
  const actors = require('../../src/actors');
  const real = actors.create;
  actors.create = () => ({
    kind: 'api',
    status: () => ({ ok: true, kind: 'api', label: 'Test Advisor', model: 'm' }),
    review: async () => reply,
  });
  try { return await fn(); } finally { actors.create = real; }
}

module.exports = async function () {
  await test('EXT: an external reply is NOT the end — LAIN takes a turn on the advice', async () => {
    const r = rig();
    r.app._externalDraft = request.draft(r.app, 'audit the project for bottlenecks');
    await withActor({ ok: true, text: ADVICE, overclaim: [] }, async () => {
      await request.dispatch(r.app, { C });
    });

    // THE ASSERTION THE OLD BEHAVIOUR COULD NOT PASS.
    assert.strictEqual(r.submitted.length, 1,
      'the advice must be handed to the local agent as a turn, not printed and dropped');
    const { text, opts } = r.submitted[0];
    assert.strictEqual(opts.sameTask, true, "the user's task stays authoritative");
    assert.strictEqual(opts.from, 'external-advice', 'and the provenance is recorded');
    assert.ok(text.includes(ADVICE.split(NL)[3].trim()),
      'the advice itself must reach the model');
  });

  await test('EXT: the brief frames it as ADVICE, names the blindness, and keeps the objective', async () => {
    const brief = request.advisoryBrief({
      objective: 'audit the project for bottlenecks',
      actor: 'Test Advisor',
      advice: ADVICE,
    });
    assert.match(brief, /EXTERNAL ADVICE/, 'named as advice');
    assert.ok(!/FINAL ANSWER/i.test(brief), 'never as a result');
    assert.match(brief, /NO filesystem, NO shell/, 'the advisor cannot have run anything');
    assert.match(brief, /audit the project for bottlenecks/, 'the original request is carried');
    assert.match(brief, /CARRY THEM OUT with your own tools/, 'LAIN is told to investigate');
    assert.match(brief, /UNVERIFIED/, 'and to label what it could not check');
    assert.match(brief, /Do not restate the advice as your answer/, 'not a relay');
    assert.match(brief, /Do not ask for another external consultation/, 'loop prevention, stated');
  });

  await test('EXT: the CONVERSATION gets the event; the ADVICE goes to the command surface', async () => {
    // ---- THE ASSERTION THIS FILE GOT WRONG THE FIRST TIME ----------------
    //
    // It asserted `external consultation` in `render.write` and the advice in
    // `noteActor`, and both were exactly backwards. `noteActor` is not a side
    // channel: `ui.extras` IS `session.actors`, and ui/conversation.js draws
    // one row per entry — so pushing the reply through it line by line put the
    // whole of it into the conversation, which is the wall this was written to
    // prevent. Meanwhile `render.write` under a TUI is the COMMAND SURFACE, a
    // panel that closes, so the compact event never reached the feed at all.
    //
    // A rig cannot catch that on its own: it records calls and renders nothing.
    // tests/smoke/external-advisory.test.js reads the drawn frames. What this
    // test can do is pin which channel carries which, so they cannot silently
    // swap back.
    const r = rig();
    r.app._externalDraft = request.draft(r.app, 'audit it');
    await withActor({ ok: true, text: ADVICE, overclaim: [] }, async () => {
      await request.dispatch(r.app, { C });
    });

    // THE CONVERSATION: the event, and a budget of two lines for it.
    const feed = r.noted.filter((n) => /^external: /.test(n));
    assert.strictEqual(feed.length, 2, `the consultation is worth two lines, got: ${JSON.stringify(feed)}`);
    assert.ok(feed.some((n) => /external consultation/.test(n)), 'it says a consultation happened');
    assert.ok(feed.some((n) => /advice received/.test(n)), 'and that a reply arrived');
    assert.ok(!feed.some((n) => /Collect test durations/.test(n)),
      'and not one line of the advisor prose is drawn in the conversation');

    // THE COMMAND SURFACE: the whole of it, where a panel has room.
    const shown = r.out();
    assert.match(shown, /EXTERNAL ADVICE/, 'the surface names what it is showing');
    assert.ok(shown.includes('Collect test durations with --durations'),
      'and carries the advisor own words, so they can be read now and not only in the session file');
  });

  await test('EXT: the advice is KEPT on the entry, not lost with the panel', async () => {
    // The command surface closes. The entry is what survives into the saved
    // session and onto the dashboard, so the words have to ride on it.
    const r = rig();
    r.app._externalDraft = request.draft(r.app, 'audit it');
    await withActor({ ok: true, text: ADVICE, overclaim: [] }, async () => {
      await request.dispatch(r.app, { C });
    });
    const withDetail = r.details.find((d) => Array.isArray(d));
    assert.ok(withDetail, 'one entry must carry the whole reply');
    assert.ok(withDetail.join(String.fromCharCode(10)).includes('Collect test durations'),
      'including the checks it proposed');
  });

  await test('EXT: nothing secret crosses the wire, and the PREVIEW shows what leaves', () => {
    const SENT = 'LAIN_SECRET_SENTINEL_DO_NOT_RENDER_9f3a';
    redact.clear();
    redact.register(SENT);
    try {
      const r = rig();
      const d = request.draft(r.app, `audit this, the key is ${SENT} and it is slow`);
      assert.ok(!d.packet.includes(SENT),
        'a credential must never reach the packet — a sent packet cannot be recalled');
      assert.ok(d.packet.includes('LAI'), 'the shape is kept so the sentence still reads');
      // The preview is what a person approves; it must BE the bytes that leave.
      assert.ok(!request.preview(d).join(NL).includes(SENT),
        'the confirmation must not show one thing and send another');
    } finally {
      redact.clear();
    }
  });

  await test('EXT: one consultation is recorded on the task, so a second is a decision', async () => {
    const r = rig();
    assert.strictEqual(request.consultedOn(r.app), 0);
    r.app._externalDraft = request.draft(r.app, 'audit it');
    await withActor({ ok: true, text: ADVICE, overclaim: [] }, async () => {
      await request.dispatch(r.app, { C });
    });
    assert.strictEqual(request.consultedOn(r.app), 1,
      'the consultation is stamped on the task, so momentum cannot turn one into a loop');
  });

  await test('EXT: the model has no way to consult anybody by itself', () => {
    // The loop that would matter most is a model-driven one. It is structurally
    // impossible rather than merely discouraged: `/external` is a slash command
    // and there is no external tool in the registry for a model to call.
    const tools = require('../../src/tools');
    const reachable = tools.names().filter((n) => /extern|consult|advis/i.test(n));
    assert.deepStrictEqual(reachable, [],
      `a model-callable external tool would make a consultation loop reachable: ${reachable}`);
  });

  await test('EXT: a FAILED consultation starts no turn — there is nothing to act on', async () => {
    const r = rig();
    r.app._externalDraft = request.draft(r.app, 'audit it');
    await withActor({ ok: false, why: 'the advisor did not answer' }, async () => {
      await request.dispatch(r.app, { C });
    });
    assert.strictEqual(r.submitted.length, 0,
      'a failure must not hand the model an empty brief to investigate');
    assert.match(r.out(), /did not answer/);
  });
};
