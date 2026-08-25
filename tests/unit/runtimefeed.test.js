'use strict';

/**
 * THE CLIENT BOUNDARY — the shape a second surface will attach to.
 *
 * These are unit tests over the pure parts: the cursor, the merge order, the
 * phrasing, and the one question a notifier asks. Everything that needs a real
 * supervisor is proved in tests/integration/guardian.test.js instead; what is
 * checked HERE is that the boundary is honest with no runtime behind it, which
 * is the state every client will meet first.
 */

const assert = require('assert');
const { test } = require('../helpers');

const feed = require('../../src/runtimefeed');

module.exports = async function () {
  await test('FEED: a cursor survives being kept as a plain number', async () => {
    // A client stores whatever it was handed. The first thing it ever has is a
    // zero it made up itself, and that must work.
    assert.deepStrictEqual(feed.normalise(0), { runtime: 0, jobs: 0 });
    assert.deepStrictEqual(feed.normalise(7), { runtime: 7, jobs: 7 });
    assert.deepStrictEqual(feed.normalise({ runtime: 3, jobs: 9 }), { runtime: 3, jobs: 9 });
    // AND NOTHING IT COULD PLAUSIBLY SEND BACK IS FATAL. A cursor that arrived
    // over a network is a cursor somebody can corrupt.
    assert.deepStrictEqual(feed.normalise(undefined), { runtime: 0, jobs: 0 });
    assert.deepStrictEqual(feed.normalise({ runtime: -4, jobs: 'x' }), { runtime: 0, jobs: 0 });
    assert.deepStrictEqual(feed.normalise({}), { runtime: 0, jobs: 0 });
  });

  await test('FEED: with no runtime it answers empty, and says that it is empty', async () => {
    // THE STATE EVERY CLIENT MEETS FIRST. "Nothing has happened" and "I could
    // not ask" are different facts, and a surface that renders them the same
    // way reports a healthy quiet machine when it has simply been disconnected.
    const prev = process.env.LAIN_HOME;
    process.env.LAIN_HOME = require('path').join(require('os').tmpdir(), `lain-feed-${Date.now()}`);
    try {
      const s = await feed.state();
      assert.strictEqual(s.available, false);
      assert.deepStrictEqual(s.sessions, []);
      assert.deepStrictEqual(s.jobs, []);
      const b = await feed.since(0);
      assert.strictEqual(b.available, false);
      assert.deepStrictEqual(b.events, []);
      // AND THE CURSOR COMES BACK UNMOVED, so a client that polls through an
      // outage does not skip everything that happened during it.
      assert.deepStrictEqual(b.seq, { runtime: 0, jobs: 0 });
    } finally {
      if (prev === undefined) delete process.env.LAIN_HOME; else process.env.LAIN_HOME = prev;
    }
  });

  await test('FEED: a deadline headline never claims the work is finished', () => {
    // The distinction the whole long-job design rests on. The WINDOW ended;
    // whether the job did is a separate fact, and merging them into one sentence
    // is how "2 hours are up" gets read as "it is done".
    const h = feed.headline({ kind: 'JOB_DEADLINE_REACHED', job_id: 'j-1' });
    assert.match(h, /deadline/);
    assert.match(h, /may still be running/);
    assert.ok(!/finished|complete|done/i.test(h), `it must not imply completion: ${h}`);
  });

  await test('FEED: a headline states what happened and never why', () => {
    // A runtime reports; it does not diagnose. "exit 1" is an observation and
    // "CUDA ran out of memory" is a conclusion that belongs to whoever reads it.
    assert.strictEqual(feed.headline({ kind: 'JOB_ERROR', job_id: 'j-2', exit_code: 1 }),
      'job j-2 failed — exit 1');
    assert.strictEqual(feed.headline({ kind: 'JOB_COMPLETED', job_id: 'j-3', exit_code: 0 }),
      'job j-3 finished');
    assert.strictEqual(feed.headline({ kind: 'MODEL_SWITCHED', from: 'a', to: 'b' }),
      'the model changed — a to b');
    // AN EXIT CODE NOBODY RECORDED IS SAID TO BE UNKNOWN, never printed as 0.
    assert.match(feed.headline({ kind: 'JOB_ERROR', job_id: 'j' }), /exit unknown/);
    // An event kind this file has never heard of still produces something
    // readable rather than an empty notification.
    assert.strictEqual(feed.headline({ kind: 'SOMETHING_NEW' }), 'something new');
    assert.strictEqual(feed.headline(null), '');
  });

  await test('FEED: only decisions are notable — a phase change is not one', () => {
    // Worth RECORDING and worth WAKING SOMEBODY FOR are different questions, and
    // the second list is short on purpose. Every entry is something a person has
    // to decide about: wait or switch, look or ignore.
    for (const k of ['JOB_DEADLINE_REACHED', 'JOB_ERROR', 'INPUT_HELD', 'HANDOVER_CREATED', 'MODEL_SWITCHED']) {
      assert.ok(feed.NOTABLE.has(k), `${k} is a decision`);
    }
    for (const k of ['TURN_STARTED', 'TURN_COMPLETED', 'TOKEN_USAGE_UPDATED', 'DISK_VERIFIED']) {
      assert.ok(!feed.NOTABLE.has(k), `${k} is bookkeeping, not a notification`);
    }
  });

  await test('FEED: what needs a person is answerable without understanding the shapes', () => {
    const state = {
      sessions: [
        { session: 'a', effective_state: 'COMPLETED', needs_handover: false, held_count: 0 },
        { session: 'b', effective_state: 'PROVIDER_FAILED', needs_handover: true, held_count: 1 },
        { session: 'c', effective_state: 'LOST', needs_handover: false, held_count: 0 },
        { session: 'd', effective_state: 'TOOL_RUNNING', needs_handover: false, held_count: 0 },
      ],
    };
    const rows = feed.needsAttention(state).map((s) => s.session);
    assert.deepStrictEqual(rows, ['b', 'c']);
    // A TURN IN FLIGHT IS NOT AN ALERT. Work happening is the normal case, and a
    // notifier that fires on it is a notifier people turn off.
    assert.ok(!rows.includes('d'));
    assert.deepStrictEqual(feed.needsAttention(null), []);
  });

  await test('FEED: the boundary is READ-ONLY, and that is checked rather than intended', () => {
    // A surface reachable from outside the machine is a surface an attacker can
    // reach. The first version of one should be able to say what is happening
    // without being able to make anything happen — so the verbs are absent, and
    // their absence is asserted so that adding one is a deliberate act with a
    // failing test in front of it.
    const api = Object.keys(require('../../src/runtimefeed'));
    for (const verb of ['send', 'submit', 'cancel', 'continue', 'deliver', 'run', 'stop', 'write']) {
      assert.ok(!api.includes(verb), `runtimefeed must not expose ${verb}`);
    }
  });
};
