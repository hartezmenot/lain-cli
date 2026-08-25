'use strict';

/**
 * `/steer` — CORRECTING WORK THAT IS ALREADY RUNNING.
 *
 * The failure modes this must not have: starting a second task, discarding the
 * one in flight, arriving in the middle of a tool call, or quietly doing
 * nothing. A steer is queued and delivered by the turn loop between steps —
 * immediately before it builds the next request — and it must be visible in the
 * conversation the model actually receives, not merely recorded somewhere.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const { runTurn } = require('../../src/turn');
const { Session } = require('../../src/session');

/** A two-step scripted turn, so there IS a "between steps" to land in. */
function mockCfg(steps) {
  return {
    provider: 'mock',
    model: 'mock-model',
    _mockScript: steps,
  };
}

module.exports = async function () {
  await test('STEER: the instruction reaches the model between steps, as the user', async () => {
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = require('../helpers').writeScript(tmpdir('steer-'), [
      { text: 'first', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
      { text: 'second' },
    ]);
    try {
      const session = new Session({ cwd: tmpdir('steer-cwd-') });
      const queue = ['stop editing and read the logs first'];
      const notices = [];
      for await (const ev of runTurn(session, 'do the thing', {
        cfg: {}, steer: () => queue.splice(0, queue.length),
      })) {
        if (ev.type === 'notice') notices.push(ev.message);
      }
      const steered = session.messages.filter((m) => m._steer);
      assert.strictEqual(steered.length, 1, 'delivered exactly once, not per step');
      assert.strictEqual(steered[0].role, 'user', 'a correction is the USER speaking');
      assert.match(steered[0].content, /⚑ USER STEER: stop editing and read the logs first/);
      assert.ok(notices.some((n) => /USER STEER delivered/.test(n)), 'and the user is told it landed');
    } finally {
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });

  await test('STEER: an empty queue costs nothing and says nothing', async () => {
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = require('../helpers').writeScript(tmpdir('steer2-'), [{ text: 'done' }]);
    try {
      const session = new Session({ cwd: tmpdir('steer2-cwd-') });
      let calls = 0;
      const notices = [];
      for await (const ev of runTurn(session, 'x', { cfg: {}, steer: () => { calls += 1; return []; } })) {
        if (ev.type === 'notice') notices.push(ev.message);
      }
      assert.ok(calls >= 1, 'the loop does ask');
      assert.ok(!session.messages.some((m) => m._steer));
      assert.ok(!notices.some((n) => /STEER/.test(n)));
    } finally {
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });

  await test('STEER: queueing records it on the task, so a resumed session still has it', () => {
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
    app.session.task = new (require('../../src/task').Task)('build the thing');
    assert.strictEqual(app.queueSteer('  '), false, 'an empty steer is not a steer');
    assert.strictEqual(app.queueSteer('use the existing logger'), true);
    // THE QUEUE CARRIES A MODE NOW. A steer defaults to WAIT — delivered once
    // the work in flight has finished — and a second Enter promotes it to NOW,
    // which lands at the next step. What this test is about is unchanged: the
    // text reaches the queue.
    assert.deepStrictEqual(app.steerQueue, [{ text: 'use the existing logger', mode: 'WAIT' }]);
    assert.match(app.session.task.steers[app.session.task.steers.length - 1].text, /existing logger/);
  });

  await test('STEER: it is SAFE during a turn — that is the entire point of it', () => {
    const commands = require('../../src/commands');
    assert.ok(commands.REGISTRY.has('/steer'));
    assert.strictEqual(commands.blockedDuringTurn('/steer'), false,
      'a command that can only be blocked while a turn runs would never run at all');
  });
};
