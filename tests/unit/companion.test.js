'use strict';

/**
 * THE COMPANION RELAY — LAIN's facts, forwarded to a window that renders them.
 *
 * . The Probe used to receive one thing from LAIN, the
 * model's final prose, so anything a companion showed about what was HAPPENING
 * was inferred from wording — a second state machine that will disagree with
 * the first.
 *
 * What is pinned here is the relay's contract, not the window's drawing: that
 * every named fact goes out, that a stalled or ancient Probe cannot damage a
 * turn, and that nothing invented is ever sent.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { EventBus, EVENT } = require('../../src/events');
const companion = require('../../src/companion');

/** A Probe double that records what LAIN pushed, and can refuse in each way. */
function fakeProbe({ structured = true, hang = false } = {}) {
  const calls = [];
  const said = [];
  return {
    calls,
    said,
    async call(op, params) {
      calls.push({ op, params });
      if (op !== 'session.event') return { ok: false, error: `unknown operation ${op}` };
      if (hang) return new Promise(() => {});          // never answers
      if (!structured) return { ok: false, error: 'unknown operation session.event' };
      return { ok: true, result: { ok: true } };
    },
    async say(text, role) { said.push({ text, role }); return true; },
  };
}

const appWith = (bus) => ({ events: bus });
const settle = () => new Promise((r) => { setImmediate(r); });

module.exports = async function () {
  await test('RELAY: every named fact reaches the companion, structured', async () => {
    const bus = new EventBus();
    const probe = fakeProbe();
    companion.attach(appWith(bus), probe);

    bus.emit(EVENT.TASK_STARTED, { objective: 'find the reel handler' });
    bus.emit(EVENT.TOOL_STARTED, { tool: 'grep', target: 'src/' });
    await settle();
    await settle();

    assert.deepStrictEqual(probe.calls.map((c) => c.op), ['session.event', 'session.event']);
    assert.strictEqual(probe.calls[0].params.event.type, 'task.started');
    assert.strictEqual(probe.calls[0].params.event.objective, 'find the reel handler');
    assert.strictEqual(probe.said.length, 0, 'the structured channel needs no prose fallback');
  });

  await test('RELAY: an older Probe gets one readable line instead, decided ONCE', async () => {
    // Asking every time would spend a failed round trip per event against a
    // Probe that will never answer it — the opposite of what a status channel
    // should cost.
    const bus = new EventBus();
    const probe = fakeProbe({ structured: false });
    companion.attach(appWith(bus), probe);

    bus.emit(EVENT.TASK_STARTED, { objective: 'x' });
    await settle(); await settle();
    bus.emit(EVENT.TOOL_STARTED, { tool: 'grep' });
    await settle(); await settle();

    const attempts = probe.calls.filter((c) => c.op === 'session.event').length;
    assert.strictEqual(attempts, 1, `it kept retrying an operation that does not exist (${attempts}×)`);
    assert.strictEqual(probe.said.length, 2, 'and both facts still reached the window');
    assert.match(probe.said[0].text, /^TASK  x/);
  });

  await test('RELAY: a Probe that stops answering does NOT grow a backlog', async () => {
    // A window that has stalled must not become a queue in LAIN's memory. The
    // events it missed are still in the bus, which is where a reconnecting
    // companion reads them from.
    const bus = new EventBus();
    const probe = fakeProbe({ hang: true });
    companion.attach(appWith(bus), probe);

    for (let i = 0; i < 200; i++) bus.emit(EVENT.TASK_PROGRESS, { turns: i });
    await settle();

    assert.ok(probe.calls.length <= companion.MAX_INFLIGHT,
      `${probe.calls.length} sends are in flight against a window that never answered`);
    assert.strictEqual(bus.recent().length, 200, 'and nothing was lost from the bus itself');
  });

  await test('RELAY: a companion that throws cannot fail a turn', async () => {
    const bus = new EventBus();
    const probe = {
      call() { throw new Error('the socket died'); },
      say() { throw new Error('and so did that'); },
    };
    companion.attach(appWith(bus), probe);
    assert.doesNotThrow(() => bus.emit(EVENT.TASK_STARTED, { objective: 'x' }));
    await settle();
  });

  await test('RELAY: attaching twice does not double every line', async () => {
    const bus = new EventBus();
    const probe = fakeProbe();
    companion.attach(appWith(bus), probe);
    companion.attach(appWith(bus), probe);       // `/mcp probe` run again
    bus.emit(EVENT.TASK_STARTED, { objective: 'x' });
    await settle(); await settle();
    assert.strictEqual(probe.calls.length, 1);
  });

  // ------------------------------------------------- NOTHING IS INVENTED --

  await test('LINE: every line is built only from fields the event carries', () => {
    // A companion showing something LAIN never said is the drift the whole
    // contract exists to remove.
    assert.strictEqual(companion.line({ type: EVENT.TOOL_STARTED, tool: 'grep', target: 'src/' }),
      'RUN   grep src/');
    assert.strictEqual(companion.line({ type: EVENT.WAITING_FOR_USER, reason: 'it asked you' }),
      'WAITING FOR YOU — it asked you');
    assert.match(companion.line({ type: EVENT.TASK_FAILED, stopReason: 'provider' }), /FAILED/);
    assert.match(companion.line({ type: EVENT.TOOL_COMPLETED, tool: 'x', ok: false }), /FAIL/);
    // An event with nothing in it still produces a line rather than throwing.
    assert.strictEqual(typeof companion.line({ type: EVENT.MODEL_THINKING }), 'string');
  });

  await test('RELAY: it is not a control channel — it only ever sends', async () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/companion.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of ['app.handle', 'app.submit', 'input.emit', 'abort']) {
      assert.ok(!src.includes(forbidden),
        `a companion renders; it must not drive the session (${forbidden})`);
    }
  });
};
