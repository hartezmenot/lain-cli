'use strict';

const assert = require('assert');
const { test } = require('../helpers');
const { Session } = require('../../src/session');
const { ContextAuthority, STATE, EVENT, MAX_ATTEMPTS_PER_EPOCH } = require('../../src/contextauthority');

const PC_A = { provider: 'p', connectionId: 'p:a', model: 'm-a', ctx: 200000, maxTokens: 4096 };
const PC_B = { provider: 'p', connectionId: 'p:b', model: 'm-b', ctx: 32000, maxTokens: 2048 };

function largeSession(body = 12000, steps = 40) {
  const session = new Session({ cwd: process.cwd() });
  session.messages.push({ role: 'user', content: 'do the work' });
  for (let i = 0; i < steps; i++) {
    session.messages.push({
      role: 'assistant', content: `step ${i}`, ts: new Date().toISOString(),
      tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: JSON.stringify({ path: `f${i}.js` }) }],
    });
    session.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(body) });
  }
  return session;
}

/**
 * A session that stays over budget no matter how many compactions run: the
 * huge recent assistant message is beyond the elision pass's frontier and is
 * not a tool result, so nothing in `Session.compact` can shrink it. This is
 * the state that used to re-enter compaction forever.
 */
function irreducibleSession() {
  const session = largeSession();
  session.messages.push({ role: 'assistant', content: 'x'.repeat(260000), ts: new Date().toISOString() });
  return session;
}

module.exports = async function () {
  await test('AUTH: a session starts with one independent context authority', () => {
    const a = new Session();
    const b = new Session();
    assert.ok(a.contextAuthority);
    assert.notStrictEqual(a.contextAuthority, b.contextAuthority);
    assert.strictEqual(a.contextAuthority.state, STATE.NORMAL);
  });

  await test('AUTH: compacting is bounded within one context epoch', () => {
    // IRREDUCIBLE pressure: the huge recent assistant message survives every
    // pass of Session.compact, so each attempt below is answering REAL
    // pressure — the bound must be reached by the conversation refusing to
    // shrink, never by the authority re-entering on unchanged state.
    const session = irreducibleSession();
    const authority = session.contextAuthority;
    const first = authority.compact(PC_A, {}, { reason: 'test' });
    const second = authority.compact(PC_A, {}, { reason: 'test' });
    const third = authority.compact(PC_A, {}, { reason: 'test' });
    assert.strictEqual(authority.attempts, MAX_ATTEMPTS_PER_EPOCH);
    assert.strictEqual(first.attempted, true);
    assert.strictEqual(second.attempted, true, 'the second attempt answers pressure the first could not fix');
    assert.strictEqual(third.attempted, false, 'a third attempt in one epoch must be refused');
    assert.strictEqual(authority.state, STATE.CONTEXT_UNSATISFIABLE);
  });

  await test('AUTH: a pressure check with no pressure consumes nothing', () => {
    const session = largeSession();
    const authority = session.contextAuthority;
    const first = authority.compact(PC_A, {});
    authority.compact(PC_A, {});
    authority.compact(PC_A, {});
    authority.compact(PC_A, {});
    assert.strictEqual(first.result.compacted, true, 'the genuinely over-budget first check compacts');
    assert.strictEqual(authority.attempts, 1, 'asking again with no pressure spends no attempt');
    assert.strictEqual(authority.state, STATE.NORMAL);
    assert.ok(!authority.timeline.some((e) => e.type === EVENT.COMPACTION_REQUESTED && e.attempt === 2),
      'no second compaction was ever requested');
  });

  await test('AUTH: a compaction that throws ends the epoch FAILED, not retried', () => {
    const session = largeSession();
    const authority = session.contextAuthority;
    session.compact = () => { throw new Error('elision exploded'); };
    const first = authority.compact(PC_A, {});
    assert.strictEqual(first.failed, true);
    assert.strictEqual(authority.state, STATE.COMPACTION_FAILED);
    const second = authority.compact(PC_A, {});
    assert.strictEqual(second.attempted, false, 'a FAILED epoch does not re-enter within its lifecycle');
    assert.strictEqual(authority.state, STATE.COMPACTION_FAILED);
    const noted = authority.timeline.filter((e) => e.type === EVENT.COMPACTION_FAILED);
    assert.ok(noted.length >= 1);
    assert.ok(String(noted[0].error).includes('elision exploded'), 'the failure carries its cause');
  });

  await test('AUTH: an unsatisfiable epoch carries its evidence', () => {
    const session = irreducibleSession();
    const authority = session.contextAuthority;
    authority.compact(PC_A, {});
    const second = authority.compact(PC_A, {});
    const evidence = second.unsatisfiable || authority.unsatisfiable;
    assert.strictEqual(authority.state, STATE.CONTEXT_UNSATISFIABLE);
    assert.ok(evidence, 'the epoch ends with evidence, not silence');
    assert.strictEqual(evidence.provider, PC_A.provider);
    assert.strictEqual(evidence.model, PC_A.model);
    assert.strictEqual(evidence.attempts, MAX_ATTEMPTS_PER_EPOCH);
    assert.strictEqual(evidence.epoch, authority.epoch);
    assert.ok(evidence.contextChars > 0);
    assert.ok(evidence.budgetChars > 0);
    assert.ok(evidence.why.length > 0, 'the evidence names which wall was hit');
  });

  await test('AUTH: a new epoch re-arms the attempt budget', () => {
    const session = irreducibleSession();
    const authority = session.contextAuthority;
    authority.compact(PC_A, {});
    authority.compact(PC_A, {});
    assert.strictEqual(authority.state, STATE.CONTEXT_UNSATISFIABLE);
    // New canonical state — the user's next input, or the next step's
    // results — starts a genuinely new epoch, and with it a fresh budget.
    session.messages.push({ role: 'user', content: 'the work moved on' });
    authority.touch({ reason: 'step-result:new' });
    const again = authority.compact(PC_A, {});
    assert.strictEqual(again.attempted, true, 'a new epoch may compact again');
    assert.strictEqual(authority.attempts, 1);
    assert.notStrictEqual(authority.state, STATE.CONTEXT_UNSATISFIABLE);
  });

  await test('AUTH: clear during COMPACTING retires the in-flight operation', () => {
    const session = largeSession();
    const authority = session.contextAuthority;
    const id = authority.beginCompaction({ reason: 'in-flight' });
    assert.ok(id);
    const cleared = session.clearContext();
    assert.strictEqual(session.messages.length, 0);
    assert.strictEqual(cleared.removed > 0, true);
    // The clear touched a new epoch; the old operation's completion is stale
    // by id, and no compaction of the cleared state ever runs.
    const done = authority.finishCompaction(id);
    assert.strictEqual(done.stale, true);
    assert.strictEqual(authority.state, STATE.NORMAL);
    assert.strictEqual(authority.reason, 'explicit-context-clear');
    assert.ok(!authority.timeline.some((e) => e.type === EVENT.COMPACTION_COMPLETED),
      'no compaction completed against the cleared state');
  });

  await test('AUTH: a completion arriving after a new epoch is ignored', () => {
    const session = largeSession();
    const authority = session.contextAuthority;
    const id = authority.beginCompaction({ reason: 'old-epoch' });
    // A step result lands mid-compaction: canonical state changed, so the
    // epoch turned and the in-flight id was retired with it.
    session.messages.push({ role: 'tool', tool_call_id: 'c0', content: 'late result' });
    authority.touch({ reason: 'step-result:late' });
    const stale = authority.finishCompaction(id);
    assert.strictEqual(stale.stale, true);
    assert.strictEqual(stale.ignored, true);
    assert.strictEqual(authority.compactionId, '');
  });

  await test('AUTH: a model switch alone never compacts', () => {
    // Under BOTH profiles' budgets, so any compaction here could only be the
    // model switch triggering one it did not need.
    const session = largeSession(400, 12);
    const authority = session.contextAuthority;
    const a = authority.project(PC_A, () => ['a'], { stable: 's', live: 'l', tools: 1 });
    const b = authority.project(PC_B, () => ['b'], { stable: 's', live: 'l', tools: 1 });
    assert.notStrictEqual(b, a, 'the new profile gets a new projection');
    assert.strictEqual(authority.attempts, 0, 'no compaction was spent on the switch');
    assert.strictEqual(authority.state, STATE.NORMAL);
    assert.ok(authority.reason.includes('model-profile-changed'));
  });

  await test('AUTH: the lifecycle is on the timeline with correlation identity', () => {
    const session = largeSession();
    const authority = session.contextAuthority;
    authority.compact(PC_A, {});
    const types = authority.timeline.map((e) => e.type);
    for (const expected of [EVENT.CONTEXT_PRESSURE, EVENT.COMPACTION_REQUESTED,
      EVENT.COMPACTION_STARTED, EVENT.COMPACTION_COMPLETED, EVENT.CONTEXT_REBUILT,
      EVENT.CONTEXT_VALIDATED]) {
      assert.ok(types.includes(expected), `the timeline records ${expected}`);
    }
    for (const e of authority.timeline) {
      assert.ok(e.sessionId === session.id, 'every event names the conversation');
      assert.ok(typeof e.epoch === 'number');
      assert.strictEqual(e.provider, PC_A.provider);
      assert.strictEqual(e.model, PC_A.model);
    }
    const started = authority.timeline.find((e) => e.type === EVENT.COMPACTION_STARTED);
    assert.ok(started.compactionId, 'the operation is identifiable across its events');
  });

  await test('AUTH: compacting is idempotent and only counted once', () => {
    const session = largeSession();
    const first = session.contextAuthority.compact(PC_A, {});
    const before = session.contextChars();
    const second = session.contextAuthority.compact(PC_A, {});
    assert.strictEqual(session.contextChars(), before, 'a compacted compact must change nothing');
    assert.strictEqual(first.result.compacted, true);
    assert.strictEqual(second.result.compacted, false);
  });

  await test('AUTH: a stale compaction completion is ignored', () => {
    const authority = new ContextAuthority(new Session());
    const stale = authority.beginCompaction({ reason: 'stale' });
    authority.finishCompaction(stale);
    const current = authority.beginCompaction({ reason: 'current' });
    const result = authority.finishCompaction(stale);
    assert.strictEqual(result.stale, true);
    assert.strictEqual(authority.compactionId, current);
  });

  await test('AUTH: repeated pressure checks cannot start a second operation', () => {
    const session = largeSession();
    const authority = session.contextAuthority;
    const id = authority.beginCompaction({ reason: 'pressure' });
    assert.ok(id);
    assert.strictEqual(authority.beginCompaction({ reason: 'pressure-again' }), null);
    assert.strictEqual(authority.state, STATE.COMPACTING);
    assert.strictEqual(authority.attempts, 1);
    authority.finishCompaction(id);
  });

  await test('AUTH: clear is explicit and never compacts', () => {
    const session = largeSession();
    const authority = session.contextAuthority;
    const epoch = authority.epoch;
    const before = authority.attempts;
    const cleared = session.clearContext();
    assert.strictEqual(session.messages.length, 0);
    assert.strictEqual(cleared.removed, largeSession().messages.length);
    assert.strictEqual(authority.epoch, epoch + 1);
    assert.strictEqual(authority.attempts, before);
    assert.strictEqual(authority.reason, 'explicit-context-clear');
  });

  await test('AUTH: a model switch produces a new projection, not universal reuse', () => {
    const session = largeSession();
    const authority = session.contextAuthority;
    const a = authority.project(PC_A, () => ['a'], { stable: 's', live: 'l', tools: 1 });
    const same = authority.project(PC_A, () => ['a'], { stable: 's', live: 'l', tools: 1 });
    assert.strictEqual(same, a, 'an unchanged projection is reused');
    const b = authority.project(PC_B, () => ['b'], { stable: 's', live: 'l', tools: 1 });
    assert.notStrictEqual(b, a);
    assert.strictEqual(b.profile.model, 'm-b');
    assert.ok(authority.reason.includes('model-profile-changed'));
  });

  await test('AUTH: a changed context epoch invalidates the projection', () => {
    const session = new Session();
    const authority = session.contextAuthority;
    const first = authority.project(PC_A, () => ['a'], { stable: 's', live: 'l', tools: 1 });
    session.messages.push({ role: 'user', content: 'new canonical state' });
    authority.touch({ reason: 'new-message' });
    const second = authority.project(PC_A, () => ['b'], { stable: 's', live: 'l', tools: 1 });
    assert.notStrictEqual(second, first);
    assert.deepStrictEqual(second.wire, ['b']);
  });
};
