'use strict';

/**
 * "CHAT HISTORY EXCEEDS THE 800-MESSAGE LIMIT" — the other kind of too-big.
 *
 * Reported from a live session on 2026-08-22. omniroute answered:
 *
 *     413 Payload Too Large — {"error":{"message":"Chat history exceeds the
 *     800-message limit; compact the conversation and retry.",
 *     "code":"chat_history_too_large","reason":"message_limit"}}
 *
 * and LAIN, doing exactly what it was built to do, replied:
 *
 *     Nothing to elide — 291k chars, and the recent working set is kept whole.
 *
 * Both statements were true and the session was dead. Compaction shortens
 * BODIES; the provider was counting MESSAGES. A thousand short messages are
 * still a thousand messages, so the one tool built to rescue a too-long
 * conversation had no lever on the limit that conversation had actually hit,
 * and every request after it was refused identically.
 *
 * WHAT THESE PIN
 *   · the two limits are told apart, from the provider's own words
 *   · folding reduces the COUNT, and never leaves a tool result without its call
 *   · what the user SAID survives the fold verbatim — that is the thread
 *   · nothing is invented: no model is asked to summarise anything
 * · it happens ONCE per turn, so a fold that did not help is not a loop ()
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const errors = require('../../src/errors');

const OMNIROUTE_413 = '413 Payload Too Large - {"error": {"message": "Chat history exceeds the '
  + '800-message limit; compact the conversation and retry.","type":"payload_too_large",'
  + '"code":"chat_history_too_large","reason":"message_limit"}}';

function freshSession(home, { pairs = 40, asks = [] } = {}) {
  const { Session } = require('../../src/session');
  const s = new Session({ cwd: home });
  s.messages = [{ role: 'user', content: 'THE OBJECTIVE: make the renderer fast' }];
  for (let i = 0; i < pairs; i++) {
    if (asks[i]) s.messages.push({ role: 'user', content: asks[i] });
    s.messages.push({
      role: 'assistant',
      content: `step ${i}`,
      tool_calls: [{ id: `c${i}`, name: i % 3 ? 'read_file' : 'run_bash', arguments: '{}' }],
    });
    s.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(400) });
  }
  return s;
}

/** Every tool result must still have the call that produced it, or it is a 400. */
function orphans(session) {
  const ids = new Set();
  for (const m of session.messages) for (const tc of m.tool_calls || []) ids.add(String(tc.id));
  return session.messages.filter((m) => m.role === 'tool' && !ids.has(String(m.tool_call_id))).length;
}

module.exports = async function () {
  // ------------------------------------------------- telling them apart ----

  await test('LIMIT: a message-count refusal is not the same thing as a full window', () => {
    const f = errors.classify(Object.assign(new Error(OMNIROUTE_413), { status: 413 }));
    assert.strictEqual(f.kind, errors.KIND.CONTEXT_LIMIT);
    assert.strictEqual(f.limitKind, errors.LIMIT.MESSAGES, 'the provider said MESSAGES, not size');
    assert.strictEqual(f.maxMessages, 800, 'and it said how many — believe it');
    assert.strictEqual(f.retriable, false, 'resending the identical request would fail identically');
  });

  await test('LIMIT: an ordinary too-many-tokens refusal is still SIZE', () => {
    const f = errors.classify(
      Object.assign(new Error('This model maximum context length is 128000 tokens'), { status: 413 })
    );
    assert.strictEqual(f.limitKind, errors.LIMIT.SIZE, 'compaction already handles this one');
  });

  // ------------------------------------------------------- the new lever ---

  await test('FOLD: compaction can finally reduce the COUNT, not only the size', () => {
    const s = freshSession(tmpdir('fold-'));
    const before = s.messages.length;
    const r = s.compact({ maxMessages: 30 });
    assert.ok(s.messages.length <= 31, `still ${s.messages.length} messages`);
    assert.ok(r.folded > 0, 'nothing was folded');
    assert.strictEqual(r.beforeMessages, before);
    assert.strictEqual(r.afterMessages, s.messages.length);
  });

  await test('FOLD: it NEVER leaves a tool result whose call is gone', () => {
    // The failure that would turn a fix into a 400 on every request instead.
    // The first version of this left exactly one orphan, at the cut boundary.
    for (const max of [30, 31, 12, 9, 40]) {
      const s = freshSession(tmpdir('fold-'));
      s.compact({ maxMessages: max });
      assert.strictEqual(orphans(s), 0, `max=${max} left a dangling tool result`);
    }
  });

  await test('FOLD: the objective is never folded away', () => {
    const s = freshSession(tmpdir('fold-'));
    s.compact({ maxMessages: 6 });
    assert.match(String(s.messages[0].content), /THE OBJECTIVE/,
      'a session that forgets what it was asked is worse than one that is refused');
  });

  await test('FOLD: what the USER said survives VERBATIM — it is the thread', () => {
    // The half that must not become a number. These are the instructions and
    // the corrections; tool output is the bulk, and it is reproducible.
    const asks = [];
    asks[3] = 'also check the backend';
    asks[17] = 'use tabs not spaces';
    const s = freshSession(tmpdir('fold-'), { asks });
    s.compact({ maxMessages: 30 });
    const folded = s.messages.find((m) => m.elided === 'folded');
    assert.ok(folded, 'a fold summary must exist');
    assert.match(folded.content, /also check the backend/);
    assert.match(folded.content, /use tabs not spaces/);
    assert.ok(folded.content.indexOf('also check') < folded.content.indexOf('use tabs'),
      'and in the order they were said');
  });

  await test('FOLD: a mangled regex once ate every letter S out of those words', () => {
    // `\s+` lost its backslash and became `s+`, so "also check the backend" was
    // folded in as "al o check the backend" — the one piece of text this whole
    // mechanism exists to preserve, silently corrupted. Caught by reading the
    // output rather than the assertion, which is why this one is explicit.
    const asks = [];
    asks[3] = 'suppress spurious session stats';
    const s = freshSession(tmpdir('fold-'), { asks });
    s.compact({ maxMessages: 30 });
    const folded = s.messages.find((m) => m.elided === 'folded');
    assert.match(folded.content, /suppress spurious session stats/);
  });

  await test('FOLD: the tool calls are named and counted, never dropped in silence', () => {
    const s = freshSession(tmpdir('fold-'));
    s.compact({ maxMessages: 30 });
    const folded = s.messages.find((m) => m.elided === 'folded');
    assert.match(folded.content, /read_file×\d+/);
    assert.match(folded.content, /Re-run any of them/, 'and the way to get them back is stated');
  });

  await test('FOLD: nothing is SUMMARISED by a model — it is derived, and free', () => {
    // Compaction has never asked a model to write a précis and this does not
    // start: it would cost a request, could invent what was never said, and is
    // impossible in the one situation it exists for — the provider is at that
    // moment refusing every request as too long.
    const src = require('fs').readFileSync(require.resolve('../../src/session.js'), 'utf8');
    const fn = src.slice(src.indexOf('function foldSummary'), src.indexOf('module.exports'));
    // The word "provider" appears in the text it WRITES ("this provider's
    // message limit"), so the guard is about calls, not vocabulary.
    for (const forbidden of ['require(', 'await ', 'fetch(', '.chat(', '.stream(']) {
      assert.ok(!fn.includes(forbidden), `foldSummary must not reach a provider (${forbidden})`);
    }
    assert.ok(!/async\s+function foldSummary/.test(src), 'and it must not even be able to');
  });

  await test('FOLD: it refuses to eat the step in flight', () => {
    // Asked for an impossible count it folds what it safely can and reports the
    // count that really remains. A request still refused is better than one that
    // has lost the work it was in the middle of.
    const s = freshSession(tmpdir('fold-'));
    const r = s.compact({ maxMessages: 2 });
    assert.ok(s.messages.length > 2, 'the recent working set is not folded');
    assert.strictEqual(r.afterMessages, s.messages.length, 'and the caller is told what remains');
  });

  await test('FOLD: the turn folds ONCE, and never becomes a retry loop', () => {
    //. A second identical refusal means the fold could not reach far enough;
    // repeating it would burn tokens against a wall. The latch is separate from
    // the transport retry budget on purpose — these are different problems.
    const src = require('fs').readFileSync(require.resolve('../../src/turn.js'), 'utf8');
    assert.ok(/let foldedOnce = false/.test(src), 'there must be a latch');
    assert.ok(/!foldedOnce/.test(src), 'and it must gate the recovery');
    assert.ok(/step -= 1/.test(src), 'the same step is repeated, not a fresh one');
  });
};
