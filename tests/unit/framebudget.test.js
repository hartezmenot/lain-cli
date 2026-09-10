'use strict';

/**
 * THE FRAME BUDGET — 16ms, and it is measured rather than asserted in a comment.
 *
 * The activity presentation runs the redraw clock at 60Hz while anything is
 * animating (ui/activity.js FRAME_MS). That is only affordable because the
 * conversation is not rebuilt between two frames on which it did not change —
 * so most of what is here is about the CACHE BEING EXACT, which is the half
 * that can go silently wrong. A feed that stops updating is a far worse defect
 * than a slow one.
 *
 * The timing assertion is deliberately loose. It exists to catch a REGRESSION
 * of the kind the profile found — a frame that went from a fifth of a
 * millisecond to thirteen — not to pin a number to this machine.
 */

const assert = require('assert');
const { test } = require('../helpers');

const cache = require('../../src/ui/feedcache');
const conv = require('../../src/ui/conversation');
const { Screen } = require('../../src/ui/layout');
const { ActivitySurface } = require('../../src/ui/activity');

function fakeOut(cols, rows) {
  return { columns: cols, rows, isTTY: true, write() {}, on() {}, removeListener() {} };
}

function session(turns, calls) {
  const list = [];
  for (let i = 0; i < turns; i++) {
    list.push({
      userInput: `do the thing number ${i}`,
      text: `The loader reads the manifest but the writer never sees field ${i}.`,
      narration: [{ step: 0, text: `Checked the loader for ${i}.` }],
      actions: Array.from({ length: calls }, (_, k) => ({
        step: 0,
        name: k % 3 === 0 ? 'read_file' : k % 3 === 1 ? 'grep' : 'edit_file',
        target: `src/module${k}.js`,
        ok: true,
      })),
      toolNames: [],
      errors: [],
    });
  }
  return { turns: list, task: { objective: 'do the thing number 0' }, plan: null, actors: [] };
}

function screenFor(sess, activity) {
  const s = new Screen({ out: fakeOut(120, 40) });
  s.active = true;
  s.state = {
    cwd: process.cwd(), session: sess, model: 'm', provider: 'p', connection: {}, effort: 'high',
    plan: null, current: null, transcript: [], liveActions: [], liveNarration: [], liveNotes: [],
    liveUser: null, extras: [], outputs: [], checkpoints: [], tree: [], activity, stats: {},
    running: null,
  };
  s.view = 'activity';
  return s;
}

module.exports = async function () {
  await test('BUDGET: an unchanged conversation is not rebuilt', () => {
    cache.reset();
    const sess = session(20, 6);
    const first = conv.activity({ session: sess, width: 100 });
    const k = cache.key({
      width: 100, turns: sess.turns, extras: [], plan: null, liveActions: [], liveNotes: [],
      liveUser: null, transcript: null, current: null, liveTexts: [],
      objective: sess.task.objective,
    });
    assert.ok(cache.get(k), 'the render was remembered');
    const second = conv.activity({ session: sess, width: 100 });
    assert.deepStrictEqual(second, first, 'and the same state gives the same rows');
  });

  await test('BUDGET: the caller gets a COPY, so appending to it cannot poison the next frame', () => {
    // ui/panesource.js pushes the live timeline rows onto whatever it gets.
    // Handing out the cached array itself would accumulate a tail of stale
    // cards into every subsequent frame.
    cache.reset();
    const sess = session(5, 3);
    const a = conv.activity({ session: sess, width: 100 });
    const n = a.length;
    a.push('  a live card row');
    const b = conv.activity({ session: sess, width: 100 });
    assert.strictEqual(b.length, n, 'the next frame is unaffected');
  });

  await test('BUDGET: every input that changes the drawing changes the key', () => {
    const base = {
      width: 100, turns: session(3, 2).turns, extras: [], plan: null,
      liveActions: [], liveNotes: [], liveUser: null, transcript: [], current: null,
      liveTexts: [], objective: 'x',
    };
    const k0 = cache.key(base);
    const differs = (patch, why) => assert.notStrictEqual(cache.key({ ...base, ...patch }), k0, why);

    differs({ width: 101 }, 'width');
    differs({ turns: base.turns.concat([{ userInput: 'more', text: 'said', actions: [] }]) }, 'a new turn');
    differs({ extras: [{ kind: 'external', text: 'a review', afterTurns: 1 }] }, 'an external review');
    differs({ plan: { steps: [{ status: 'todo', text: 'a' }] } }, 'a plan');
    differs({ liveActions: [{ name: 'read_file', ok: true }] }, 'a live call');
    differs({ liveNotes: [{ text: 'a note' }] }, 'a note');
    differs({ liveUser: 'proceed' }, 'the live message');
    differs({ transcript: ['printed'] }, 'command output');
    differs({ liveTexts: ['half-resolved'] }, 'prose still resolving');
    differs({ objective: 'a longer objective' }, 'the objective');
    differs({ current: { steps: [{ label: 'a', done: false, active: true }] } }, 'progress steps');

    // A DIFFERENT CONVERSATION OF THE SAME SHAPE is a different key. This is
    // the collision `/resume` would otherwise walk straight into.
    const twin = session(3, 2).turns;
    differs({ turns: twin }, 'a different array of the same shape');
  });

  await test('BUDGET: a live call landing IS a change, and is drawn', () => {
    // The failure mode a cache introduces: the screen stops updating. Driven
    // through the real function rather than through the key.
    cache.reset();
    const sess = session(2, 2);
    const before = conv.activity({ session: sess, width: 100 }).join('\n');
    // AN EDIT, NOT A READ. A successful read is live state and is drawn in the
    // one row above the caret, not in the conversation (ui/feed.js `durable`) —
    // so it is no longer a change to THIS function's output. A call that changes
    // the project still is, and that is what the cache must never stale on.
    const after = conv.activity({
      session: sess, width: 100, liveActions: [{ name: 'edit_file', target: 'src/new.js', ok: true }],
    }).join('\n');
    assert.notStrictEqual(after, before);
    assert.ok(after.includes('src/new.js'), 'and the new call is on screen');
  });

  await test('BUDGET: a SETTLED recorded answer costs almost nothing per frame', () => {
    // ---- THE COST THE HANDOVER FIX COULD HAVE ADDED ----------------------
    //
    // The last turn's prose keeps resolving across the end of its turn
    // (ui/conversation.js), so `reveal` is now asked about RECORDED text and
    // not only live text. `duration` walks the whole string — so without a
    // short circuit the whole of a finished answer would be re-costed sixty
    // times a second, for ever, to be told each time that it had finished.
    //
    // MEASURED AS THE THING THAT MATTERS — cost per frame — rather than by
    // spying on which function was called. `duration` is capped at MAX_MS, so
    // anything older than the cap is settled and one subtraction says so.
    const revealMod = require('../../src/ui/reveal');
    const long = new Array(600).fill('The loader never sees the field.').join(' ');
    const settledAt = 1000;
    const now = settledAt + revealMod.MAX_MS + 60000;
    assert.strictEqual(revealMod.resolve(long, settledAt, now), long,
      'it still returns exactly what was said');

    // A minute of frames at 60Hz, over a paragraph of twenty thousand
    // characters. Walked each time this is seconds; short-circuited it is
    // milliseconds. The bound is loose on purpose — it is here to catch the
    // regression, not to pin a number to this machine.
    const frames = 60 * 60;
    const t0 = Date.now();
    for (let i = 0; i < frames; i++) revealMod.resolve(long, settledAt, now + i * 16);
    const ms = Date.now() - t0;
    assert.ok(ms < 250, `${frames} frames over a settled answer cost ${ms}ms`);
  });

  await test('BUDGET: prose resolving is a change, so it is not cached still', () => {
    cache.reset();
    const sess = session(2, 2);
    const text = 'The supervisor never restarted it.';
    const at = 1000;
    const frame = (now) => conv.activity({
      session: sess, width: 100,
      liveNarration: [{ text, after: 0, at }],
      reveal: (t, a) => require('../../src/ui/reveal').resolve(t, a, now),
    }).join('\n');
    const early = frame(at + 20);
    const later = frame(at + 60);
    assert.notStrictEqual(early, later, 'the frame moves while the paragraph resolves');
    assert.ok(frame(at + 5000).includes(text), 'and it settles on the real text');
  });

  await test('BUDGET: a large session composes a whole frame well inside 16ms', () => {
    cache.reset();
    let now = 1000;
    const act = new ActivitySurface({ instant: false, now: () => now });
    for (let i = 0; i < 30; i++) { act.begin('read_file', `src/f${i}.js`); act.end({ ok: true, name: 'read_file' }); }
    const before = Array.from({ length: 200 }, (_, i) => `  const value${i} = compute(${i});`).join('\n');
    const after = before.split('\n').map((l, i) => (i % 40 === 5 ? `  const value${i} = rewritten(${i});` : l)).join('\n');
    act.begin('edit_file', 'src/big.js');
    act.end({ ok: true, name: 'edit_file' });
    act.showDiff('src/big.js', before, after);

    const s = screenFor(session(120, 12), act);
    for (let i = 0; i < 20; i++) { now += 16; s.draw(); }   // warm
    let worst = 0;
    let total = 0;
    const N = 120;
    for (let i = 0; i < N; i++) {
      now += 16;
      const t0 = process.hrtime.bigint();
      s.draw();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      total += ms;
      if (ms > worst) worst = ms;
    }
    const mean = total / N;
    // Loose on purpose: this catches the regression the profile found (a frame
    // that cost thirteen milliseconds), not a particular machine's number.
    assert.ok(mean < 8, `mean frame ${mean.toFixed(3)}ms must stay well inside the 16ms budget`);
    assert.ok(worst < 40, `worst frame ${worst.toFixed(3)}ms`);
  });

  await test('BUDGET: the clock is asked for a rate the platform can actually serve', () => {
    // ---- THE ASSERTION THAT PASSED WHILE THE RATE WAS HALVED -------------
    //
    // It used to be `FRAME_MS <= 17`, and 16 satisfied it — while delivering
    // THIRTY-TWO frames a second. Measured on this machine:
    //
    //     setInterval(12) -> 64.7 Hz  (15.4 ms actual)
    //     setInterval(16) -> 35.1 Hz  (28.5 ms actual)
    //
    // The timer granularity is about 15.6ms. A request for 16 is 0.4ms too
    // late for that tick, so it waits for the next one and the cadence halves.
    // A bound of "17 or less" cannot see that; the bound has to be BELOW the
    // granularity, which is what actually buys the frame rate.
    const { FRAME_MS, TICK_MS } = require('../../src/ui/activity');
    assert.ok(FRAME_MS <= 15,
      `must be asked for inside one timer tick, not just near 60fps: ${FRAME_MS}ms`);
    assert.ok(TICK_MS > FRAME_MS, 'and a still screen costs less');
  });

  await test('BUDGET: the ticker really delivers what it asks for', async () => {
    // Measured, not derived. The constant above is a REQUEST; this is what the
    // platform does with it, which is the number a person actually sees.
    const A = require('../../src/ui/activity');
    const { ActivitySurface } = A;
    let drawn = 0;
    const ui = {
      enabled: true, phase: 'working', interrupting: false, waitingUntil: 0,
      app: { session: { turns: [] } }, story: { narration: [] },
      activity: new ActivitySurface({ now: () => Date.now() }),
      refresh() { drawn += 1; }, _tick: null, _tickMs: 0,
    };
    ui.activity.begin('read_file', 'a.js');
    A.syncTicker(ui);
    const started = Date.now();
    await new Promise((done) => setTimeout(done, 600));
    if (ui._tick) clearInterval(ui._tick);
    const hz = drawn / ((Date.now() - started) / 1000);
    // Loose, because it is a real timer on a real machine and this must not
    // become a flaky test about scheduler jitter. It is here to catch the
    // HALVING, which is a factor of two, not a few per cent.
    assert.ok(hz > 45, `the ticker delivers about the rate it asks for: ${hz.toFixed(1)} Hz`);
  });
};
