'use strict';

/**
 * THE 800-MESSAGE REFUSAL, AND THE FOLD THAT DID NOTHING.
 *
 * Reported from a live screen: LAIN announced "over this provider's 800 limit —
 * folding the oldest exchanges…", folded nothing at all, retried into the same
 * wall, reported the identical 413 — and left the panel showing "working …"
 * forever, because the only thing that could clear it was the success branch.
 *
 * Two separate defects behind one symptom:
 *
 *   THE CAP WAS COMPUTED FROM LAIN'S OWN COUNT. When the provider said "over
 *   800" and `session.messages.length` was BELOW 800, the cap was already
 *   satisfied and the fold was a no-op. LAIN's count and the provider's count
 *   are simply not the same number, and a REFUSAL is evidence while a local
 *   count is only a belief.
 *
 *   THE FAILURE PATH SAID NOTHING. An announcement with no outcome is worse
 *   than silence: it states that something is happening and then never
 *   contradicts itself.
 */

const assert = require('assert');
const { test } = require('../helpers');

const fold = require('../../src/msgfold');
const { Session } = require('../../src/session');

/** A session of `pairs` assistant/tool exchanges plus the objective. */
function session(pairs) {
  const s = new Session({ cwd: process.cwd() });
  s.messages = [{ role: 'user', content: 'the objective' }];
  for (let i = 0; i < pairs; i++) {
    s.messages.push({ role: 'assistant', content: `step ${i}`, tool_calls: [{ id: `c${i}`, function: { name: 'read_file', arguments: '{}' } }] });
    s.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `result ${i}` });
  }
  return s;
}

module.exports = async function () {
  await test('FOLD: with a stated cap BELOW what we hold, it folds to just under it', () => {
    const cap = fold.capFor(1801, 800);
    assert.strictEqual(cap, 792, 'the provider said 800; leave a margin for this step');
    assert.ok(cap < 800);
  });

  await test('FOLD: when the provider says OVER and our count says UNDER, the provider wins', () => {
    // THE DEFECT. 601 held, "800-message limit" refused: the old arithmetic
    // produced a cap of 792, which is above 601, so nothing was folded and the
    // identical request went out again.
    const own = 601;
    const cap = fold.capFor(own, 800);
    assert.ok(cap < own, `cap ${cap} must be below the ${own} we hold, or the fold does nothing`);
    // And it must be a REAL reduction, not one message off the front.
    assert.ok(cap <= own * 0.75, `cap ${cap} is not a meaningful reduction of ${own}`);
  });

  await test('FOLD: with no stated cap it still halves rather than giving up', () => {
    const cap = fold.capFor(400, 0);
    assert.ok(cap < 400 && cap >= 8, `cap was ${cap}`);
  });

  await test('FOLD: it never folds below the floor, however small the session', () => {
    for (const own of [0, 1, 5, 9]) {
      assert.ok(fold.capFor(own, 800) >= fold.FLOOR, `own=${own} produced ${fold.capFor(own, 800)}`);
    }
  });

  await test('FOLD: the chosen cap really removes messages, end to end', () => {
    // The arithmetic is only worth anything if `compact` acts on it.
    const s = session(300);                       // 601 messages
    const cap = fold.capFor(s.messages.length, 800);
    const r = s.compact({ maxMessages: cap, force: true });
    assert.ok(r.folded > 0, 'the fold must remove something');
    assert.ok(r.afterMessages < 601, `after ${r.afterMessages}, before 601`);
    assert.strictEqual(s.messages[0].content, 'the objective', 'the objective always survives');
  });

  await test('FOLD: the folded conversation is still VALID to send', () => {
    // A `tool` message whose call was folded away is a 400 from every
    // OpenAI-shaped API — the failure mode that makes a rescue worse than the
    // refusal it was rescuing from.
    const s = session(300);
    s.compact({ maxMessages: fold.capFor(s.messages.length, 800), force: true });
    const open = new Set();
    for (const m of s.messages) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) open.add(c.id);
      if (m.role === 'tool') {
        assert.ok(open.has(m.tool_call_id),
          `orphaned tool result ${m.tool_call_id} — its call was folded away`);
      }
    }
  });

  await test('FOLD: the failure path has WORDS, so the busy surface is released', () => {
    // The panel is held busy until a later notice clears it. This path had no
    // later notice, so the screen sat on "working …" under a failed fold.
    const said = fold.stuckMessage(42);
    assert.ok(said && said.length > 20, 'it must say something');
    assert.match(said, /42/, 'and name how many are left');
    assert.match(said, /\/compact|switch provider/, 'and what the user can actually do');
  });

  await test('FOLD: the success message names the real numbers, not a guess', () => {
    const said = fold.foldedMessage({ beforeMessages: 601, afterMessages: 360, folded: 241 }, 800, 792);
    for (const n of ['601', '360', '241', '800']) {
      assert.ok(said.includes(n), `the message must carry ${n}: ${said}`);
    }
    assert.match(said, /still in the session/, 'and must say the text is not lost');
  });
};
