'use strict';

/**
 * THE EVENT CONTRACT — what a companion is allowed to render.
 *
 * "Do not rely on Probe reconstructing state from arbitrary
 * transcript text. Use structured events. Probe renders these. LAIN owns them."
 *
 * Before this, LAIN mirrored exactly one thing into the Probe window — the
 * model's final prose, through `session.say`. Anything a companion wanted to
 * show about what was HAPPENING had to be inferred from wording, which is a
 * second state machine that will disagree with the first.
 *
 * So what is pinned here is the contract itself: the names, that an unknown
 * name is refused rather than forwarded, that nothing here is a control channel,
 * and — the one that matters most in practice — that a broken companion cannot
 * take a turn down with it.
 */

const assert = require('assert');
const { test } = require('../helpers');

const eventsMod = require('../../src/events');
const { EVENT, EventBus, busOf, NAMES } = eventsMod;

module.exports = async function () {
  await test('EVENTS: the vocabulary is exactly the declared names', () => {
    // A name that exists on one side and not the other is the drift the whole
    // contract exists to prevent, so the list is asserted rather than sampled.
    assert.deepStrictEqual([...NAMES].sort(), [
      'job.completed', 'job.started',
      'model.thinking', 'model.tool_call',
      'question.presented', 'question.resolved',
      'task.completed', 'task.failed', 'task.progress', 'task.started',
      'tool.completed', 'tool.started',
      'visual.judged', 'visual.presented',
      'waiting_for_user',
    ].sort());
  });

  await test('EVENTS: an unknown name is REFUSED, not quietly forwarded', () => {
    // A typo'd event is a companion that silently never shows something, which
    // is indistinguishable from the feature not working.
    const bus = new EventBus();
    const seen = [];
    bus.on((e) => seen.push(e.type));
    assert.strictEqual(bus.emit('task.startd', {}), null, 'a near-miss must not go through');
    assert.strictEqual(bus.emit('anything.at.all', {}), null);
    assert.deepStrictEqual(seen, []);
    assert.ok(bus.emit(EVENT.TASK_STARTED, {}), 'and a real one still does');
  });

  await test('EVENTS: a subscriber that throws does not take the turn down', () => {
    // A companion window is a convenience; the work is not.
    const bus = new EventBus();
    const good = [];
    bus.on(() => { throw new Error('the window fell over'); });
    bus.on((e) => good.push(e.type));
    assert.doesNotThrow(() => bus.emit(EVENT.TOOL_STARTED, { tool: 'grep' }));
    assert.deepStrictEqual(good, ['tool.started'], 'and the other subscriber still got it');
    assert.strictEqual(bus.dropped, 1, 'the failure is counted, not hidden');
  });

  await test('EVENTS: unsubscribing really stops the calls', () => {
    // A companion that reconnects must not leak a handler drawing to a window
    // nobody is looking at.
    const bus = new EventBus();
    const seen = [];
    const off = bus.on((e) => seen.push(e.type));
    bus.emit(EVENT.TASK_STARTED, {});
    off();
    bus.emit(EVENT.TASK_COMPLETED, {});
    assert.deepStrictEqual(seen, ['task.started']);
  });

  await test('EVENTS: payloads are BOUNDED — a tool result cannot be pushed through', () => {
    const bus = new EventBus();
    const ev = bus.emit(EVENT.TOOL_COMPLETED, { tool: 'grep', summary: 'x'.repeat(50_000) });
    assert.ok(ev.summary.length <= eventsMod.MAX_FIELD + 1,
      `a companion status row got ${ev.summary.length} characters`);
    assert.ok(ev.summary.endsWith('…'), 'and it is visibly cut rather than silently short');
  });

  await test('EVENTS: the backlog is bounded and ordered oldest first', () => {
    const bus = new EventBus();
    for (let i = 0; i < eventsMod.MAX_KEPT + 50; i++) bus.emit(EVENT.TASK_PROGRESS, { turns: i });
    const kept = bus.recent();
    assert.strictEqual(kept.length, eventsMod.MAX_KEPT);
    assert.strictEqual(kept[kept.length - 1].turns, eventsMod.MAX_KEPT + 49, 'newest last');
    assert.ok(kept[0].turns > kept[1].turns - 2, 'oldest first');
  });

  await test('EVENTS: a companion that connects late can read what it missed', () => {
    const bus = new EventBus();
    bus.emit(EVENT.TASK_STARTED, { objective: 'find the reel handler' });
    bus.emit(EVENT.TOOL_STARTED, { tool: 'grep' });
    assert.strictEqual(bus.last(EVENT.TASK_STARTED).objective, 'find the reel handler');
    assert.strictEqual(bus.last(EVENT.JOB_STARTED), null, 'and is told plainly when there is none');
  });

  await test('EVENTS: it is NOT a control channel — a subscriber cannot answer anything', () => {
    const bus = new EventBus();
    const api = Object.keys(EventBus.prototype).concat(Object.getOwnPropertyNames(EventBus.prototype));
    for (const name of api) {
      assert.ok(!/answer|reply|cancel|steer|abort|resolve/i.test(name),
        `the bus must not offer ${name} — a companion renders, it does not drive`);
    }
    // And what a handler receives is a plain fact, with nothing callable on it.
    let got = null;
    bus.on((e) => { got = e; });
    bus.emit(EVENT.QUESTION_PRESENTED, { question: 'which?', kind: 'CHOICE' });
    for (const v of Object.values(got)) assert.notStrictEqual(typeof v, 'function');
  });

  await test('EVENTS: no timer, no polling — an event exists because something happened', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/events.js'), 'utf8');
    for (const forbidden of ['setInterval', 'setTimeout', 'setImmediate']) {
      assert.ok(!src.includes(forbidden), `events.js must not schedule anything (${forbidden})`);
    }
  });

  // ------------------------------------------------------------ NULL BUS --

  await test('BUS: a missing bus swallows rather than throwing', () => {
    // Tools are called with whatever context their caller has. An emitter that
    // assumed `app.events` turned "this tool works in isolation" into a
    // TypeError — a real fragility, not only a test artefact.
    assert.doesNotThrow(() => busOf(null).emit(EVENT.TASK_STARTED, {}));
    assert.doesNotThrow(() => busOf({}).emit(EVENT.TASK_STARTED, {}));
    assert.doesNotThrow(() => busOf(undefined).on(() => {}));
    assert.deepStrictEqual(busOf(null).recent(), []);
    assert.strictEqual(busOf(null).last(EVENT.TASK_STARTED), null);
  });

  await test('BUS: a real app gets its own bus, and two apps never share one', () => {
    const a = { events: new EventBus() };
    const b = { events: new EventBus() };
    busOf(a).emit(EVENT.TASK_STARTED, { objective: 'a' });
    assert.strictEqual(busOf(a).recent().length, 1);
    assert.strictEqual(busOf(b).recent().length, 0, 'module-scope state is what V1 got wrong');
  });
};
