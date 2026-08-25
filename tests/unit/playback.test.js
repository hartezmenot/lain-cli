'use strict';

/**
 * THE ACTIVITY TIMELINE.
 *
 * The load-bearing property is not that it looks good — it is that it is a PURE
 * FUNCTION OF (events, clock). Everything else follows from that: playback
 * cannot drift, cannot fire after teardown, cannot block the agent, and cannot
 * change what actually happened.
 *
 * So the clock is injected and every assertion below is made by moving it by
 * hand. Nothing here sleeps, and nothing here is timing-dependent.
 *
 * THE RULE UNDER TEST, stated once: the animation is allowed to be behind
 * reality; it is not allowed to change it.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Playback, PHASE, ENTER_MS, HOLD_MS, SETTLE_MS, EXIT_MS, MAX_EVENTS } = require('../../src/ui/playback');

/** A playback with a clock this test drives. */
function rig({ instant = false } = {}) {
  let t = 1000;
  const p = new Playback({ instant, now: () => t });
  return {
    p,
    set: (v) => { t = v; },
    tick: (ms) => { t += ms; return p.at(t); },
    at: () => p.at(t),
    now: () => t,
  };
}

const read = (target) => ({ name: 'read_file', target, ok: true });
const patch = (target, added, removed) => ({ name: 'apply_patch', target, ok: true, added, removed });

module.exports = async function () {
  // ---- CONVERGENCE, MEASURED IN TIME RATHER THAN IN EVENTS ---------------

  await test('PLAYBACK: a SHALLOW queue holding long windows is still deep DEBT', () => {
    // ---- THE DEFECT, watched at the end of a real turn --------------------
    //
    // The work was over, the status said READY, the model's summary was drawn —
    // and underneath it the timeline was still reading a file from the start of
    // the turn, for fifteen seconds. Two events is a shallow queue by COUNT, so
    // the catch-up barely engaged; but each carried a `linger` for the window
    // playing under it, and two shallow events were fourteen seconds of debt.
    const r = rig();
    for (const f of ['router.js', 'python.js']) {
      const e = r.p.enqueue(read(f));
      e.linger = 4000;                        // its window is still performing
    }
    r.p.complete({});
    r.p.complete({});
    assert.ok(r.p.debtMs(r.now()) > 8000, `the debt is real: ${Math.round(r.p.debtMs(r.now()))}ms`);
    assert.ok(r.p.speed() > 1.8,
      `and a shallow queue of long events catches up: x${r.p.speed().toFixed(2)}`);

    // AND IT ACTUALLY CONVERGES, rather than merely reporting that it should.
    let n = r.now();
    while (r.p.at(n).busy && n < r.now() + 60000) n += 16;
    const tail = n - r.now();
    assert.ok(tail < 8000, `the tail drains in a few seconds, not fifteen: ${tail}ms`);
  });

  await test('PLAYBACK: a single ordinary operation is NEVER hurried', () => {
    // The other half of the same constant. Catching up exists so a busy turn
    // drains; it must not touch the case it was never about.
    const r = rig();
    r.p.enqueue(read('python.js'));
    r.p.complete({});
    assert.strictEqual(r.p.speed(), 1, 'nothing is behind, so nothing is rushed');
  });

  await test('PLAYBACK: a LONG-RUNNING command is watched, not counted as debt', () => {
    // A command that really took seven seconds was watched for seven seconds —
    // the screen was level with it the whole time. Counting its full length as
    // debt the instant it completes would say playback had fallen seven seconds
    // behind at the exact moment it caught up, and would then hurry that same
    // card's SETTLE — skipping the frame where the counters land.
    const r = rig();
    r.p.enqueue(patch('src/serializer.js', 2, 2));
    r.tick(ENTER_MS + 10);
    r.tick(HOLD_MS * 12);
    r.p.complete({ added: 2, removed: 2 });
    assert.strictEqual(r.at().active.phase, PHASE.SETTLE,
      'the finished state is reached rather than sped past');
    assert.strictEqual(r.at().active.added, 2, 'and the real numbers are on it');
  });

  await test('PLAYBACK: one activity passes ENTER → ACTIVE → SETTLE → EXIT → history', () => {
    const r = rig();
    r.p.enqueue(read('python.js'));
    r.p.complete({});                      // the tool finished immediately

    assert.strictEqual(r.at().active.phase, PHASE.ENTER, 'it enters first');
    assert.strictEqual(r.tick(ENTER_MS + 10).active.phase, PHASE.ACTIVE, 'then holds');
    assert.strictEqual(r.tick(HOLD_MS).active.phase, PHASE.SETTLE, 'then settles');
    assert.strictEqual(r.tick(SETTLE_MS).active.phase, PHASE.EXIT, 'then leaves');
    const done = r.tick(EXIT_MS + 10);
    assert.strictEqual(done.active, null, 'and is gone from the active position');
    assert.strictEqual(done.history.length, 1, 'left behind as one compact line');
    assert.strictEqual(done.history[0].target, 'python.js');
  });

  await test('PLAYBACK: the completed quotation does NOT stay on screen', () => {
    // The defect this whole file exists to end: every call appearing in full
    // and staying there for ever, so thirty reads filled the screen.
    const r = rig();
    for (const f of ['a.js', 'b.js', 'c.js']) { r.p.enqueue(read(f)); r.p.complete({}); }
    r.set(100000);                          // long past everything
    const s = r.at();
    assert.strictEqual(s.active, null);
    assert.strictEqual(s.history.length, 3, 'three quiet lines');
    // And each is ONE compact record, not a card.
    for (const h of s.history) assert.ok(h.verb && h.target, 'compact form keeps verb and target');
  });

  await test('PLAYBACK: only ONE activity is active at a time', () => {
    const r = rig();
    r.p.enqueue(read('a.js')); r.p.complete({});
    r.p.enqueue(read('b.js')); r.p.complete({});
    r.p.enqueue(read('c.js')); r.p.complete({});
    const s = r.tick(ENTER_MS + 10);
    assert.ok(s.active, 'something is active');
    assert.strictEqual(s.active.target, 'a.js', 'and it is the FIRST, in real order');
    assert.strictEqual(s.history.length, 0, 'nothing has finished yet');
  });

  await test('PLAYBACK: order is exactly what happened — nothing is skipped', () => {
    const r = rig();
    const files = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
    for (const f of files) { r.p.enqueue(read(f)); r.p.complete({}); }
    r.set(500000);
    assert.deepStrictEqual(r.at().history.map((h) => h.target), files,
      'every event, in the order it really occurred');
  });

  await test('PLAYBACK: a deep backlog plays FASTER, never shorter', () => {
    // The catch-up rule. Thirty instant reads must not take half a minute to
    // show, but all thirty must still be shown.
    const fast = rig();
    for (let i = 0; i < 30; i++) { fast.p.enqueue(read(`f${i}.js`)); fast.p.complete({}); }
    assert.ok(fast.p.speed() > 1, 'a backlog speeds the clock up');

    const slow = rig();
    slow.p.enqueue(read('only.js')); slow.p.complete({});
    assert.strictEqual(slow.p.speed(), 1, 'a single event plays at full length');

    // Drain the deep one and count what was shown.
    fast.set(1000000);
    assert.strictEqual(fast.at().history.length, 30, 'all thirty were played, none dropped');
  });

  await test('PLAYBACK: a SLOW tool holds the active phase until it finishes', () => {
    // A command that takes a minute is watched for a minute. The hold is
    // released by the real result, not by a timer.
    const r = rig();
    r.p.enqueue({ name: 'run_bash', target: 'npm test', ok: true });   // not done
    r.tick(ENTER_MS + 10);
    r.tick(HOLD_MS * 10);
    assert.strictEqual(r.at().active.phase, PHASE.ACTIVE, 'still running, still active');
    r.p.complete({ ok: true });
    const after = r.tick(HOLD_MS * 5);
    assert.ok(after.active === null || after.active.phase !== PHASE.ACTIVE,
      'once the tool finishes, the activity is released');
  });

  await test('PLAYBACK: even the WORST case is long enough to perceive', () => {
    // ---- THE REPORTED SYMPTOM, as a number ---------------------------------
    //
    // "The reading quotation appears for a split second." With the old floor of
    // 260ms and a catch-up ceiling of 6, a queued operation was ACTIVE for 43
    // milliseconds — under three frames at 60Hz, which is a flicker rather than
    // a thing you can read a path off.
    //
    // This pins the floor at the other end of the catch-up range, where it is
    // smallest, so neither constant can be moved back without failing here.
    const r = rig();
    for (let i = 0; i < 40; i++) r.p.enqueue(read(`f${i}.js`));
    for (let i = 0; i < 40; i++) r.p.complete({});
    const speed = r.p.speed();
    assert.ok(speed > 1, `the queue really is catching up: x${speed.toFixed(1)}`);
    const active = HOLD_MS / speed;
    const whole = (ENTER_MS + HOLD_MS + SETTLE_MS + EXIT_MS) / speed;
    assert.ok(active >= 150, `the subject is readable at full catch-up: ${Math.round(active)}ms`);
    assert.ok(whole >= 280, `and the whole card is a glance, not a flicker: ${Math.round(whole)}ms`);
  });

  await test('PLAYBACK: a SLOW tool still gets its SETTLE — the counters have to land somewhere', () => {
    // ---- THE DEFECT THIS REPLACES, found by watching a real session --------
    //
    // The hold was `max(HOLD_MS, min(tookMs, HOLD_MS * 4))`, measured from when
    // playback started showing the card. An operation that took longer than
    // that ceiling had therefore already run out of ACTIVE, SETTLE and EXIT by
    // the time its result arrived — so it jumped straight to the next card the
    // instant it completed.
    //
    // The counters land in SETTLE. In a real run recorded off the terminal, not
    // one patch card ever showed its own `+n -m`: every edit sat behind a model
    // response longer than the ceiling.
    const r = rig();
    r.p.enqueue(patch('src/serializer.js', 2, 2));
    r.tick(ENTER_MS + 10);
    r.tick(HOLD_MS * 12);            // far past the old ceiling
    assert.strictEqual(r.at().active.phase, PHASE.ACTIVE, 'still running');
    r.p.complete({ added: 2, removed: 2 });
    const settling = r.tick(20);
    assert.strictEqual(settling.active.phase, PHASE.SETTLE,
      'the finished state is REACHED rather than skipped past');
    assert.strictEqual(settling.active.added, 2, 'and the real numbers are on it');
    assert.strictEqual(settling.active.removed, 2);
  });

  await test('PLAYBACK: `linger` holds a card while its own diff window plays', () => {
    // Watched on a real run: the card said `patching src/parser.js` while the
    // window below it was still rewriting `src/serializer.js`. Two halves of one
    // surface naming two different files.
    const r = rig();
    const e = r.p.enqueue(patch('src/serializer.js', 2, 2));
    r.p.complete({ added: 2, removed: 2 });
    e.linger = 2000;
    r.tick(ENTER_MS + HOLD_MS + SETTLE_MS + 50);
    assert.ok(r.at().active && r.at().active.target === 'src/serializer.js',
      'the card is still the one whose change is being performed');
    r.tick(2000 + EXIT_MS + 50);
    assert.ok(!r.at().active, 'and it leaves once the window is done with it');
  });

  await test('PLAYBACK: an INSTANT tool is still seen', () => {
    // A read that takes a millisecond must not flash past unseen — HOLD_MS is
    // a floor, not a target.
    const r = rig();
    r.p.enqueue(read('quick.js'));
    r.p.complete({});
    const s = r.tick(ENTER_MS + 10);
    assert.strictEqual(s.active.target, 'quick.js', 'it occupies the active position');
    assert.strictEqual(s.active.phase, PHASE.ACTIVE);
  });

  await test('PLAYBACK: edit counters climb and LAND on the real numbers', () => {
    const r = rig();
    r.p.enqueue(patch('python.js', 72, 40));
    r.p.complete({ added: 72, removed: 40 });
    const start = r.tick(ENTER_MS + 1).active;
    assert.ok(start.added < 72, `counters start below the total, saw +${start.added}`);
    const mid = r.tick(HOLD_MS / 2).active;
    assert.ok(mid.added > start.added, 'and climb');
    const settled = r.tick(HOLD_MS).active;
    assert.strictEqual(settled.added, 72, 'landing exactly on the real addition count');
    assert.strictEqual(settled.removed, 40, 'and the real removal count');
  });

  await test('PLAYBACK: the FINAL numbers are always available, whatever the animation', () => {
    // Presentation may interpolate; the truth may not. A renderer that needs
    // the real value must never have to wait for an animation to reach it.
    const r = rig();
    r.p.enqueue(patch('x.js', 5, 3));
    r.p.complete({ added: 5, removed: 3 });
    const s = r.tick(ENTER_MS + 1).active;
    assert.strictEqual(s.finalAdded, 5);
    assert.strictEqual(s.finalRemoved, 3);
  });

  await test('PLAYBACK: an edit settles into `edit <file> +a -b`', () => {
    const r = rig();
    r.p.enqueue(patch('python.js', 72, 40));
    r.p.complete({ added: 72, removed: 40 });
    r.set(100000);
    const h = r.at().history[0];
    assert.strictEqual(h.verb, 'edit');
    assert.strictEqual(h.target, 'python.js');
    assert.strictEqual(h.added, 72);
    assert.strictEqual(h.removed, 40);
  });

  await test('PLAYBACK: the label is the VERB — reading, patching, running', () => {
    // The label above the quotation says what LAIN is doing. There is no
    // generic "action" row, and the verb comes from the tool.
    const r = rig();
    for (const [name, want] of [
      ['read_file', 'reading'], ['grep', 'searching'], ['write_file', 'writing'],
      ['apply_patch', 'patching'], ['delete_file', 'removing'], ['run_bash', 'running'],
    ]) {
      const q = rig();
      q.p.enqueue({ name, target: 't' });
      assert.strictEqual(q.tick(ENTER_MS + 1).active.verb, want, name);
    }
    assert.ok(r);
  });

  await test('INSTANT: with animation off, everything is immediately history', () => {
    // The path a pipe, a test and a disabled-animation run take. The CONTENT
    // must be identical — only the picture differs.
    const r = rig({ instant: true });
    for (const f of ['a.js', 'b.js']) { r.p.enqueue(read(f)); r.p.complete({}); }
    const s = r.at();
    assert.strictEqual(s.active, null, 'nothing is mid-animation');
    assert.strictEqual(s.busy, false);
    assert.deepStrictEqual(s.history.map((h) => h.target), ['a.js', 'b.js'],
      'and every event is present, in order');
  });

  await test('INSTANT and ANIMATED end with the SAME history', () => {
    // The property that makes animation safe to turn off: it is presentation.
    const build = (inst) => {
      const q = rig({ instant: inst });
      q.p.enqueue(read('a.js')); q.p.complete({});
      q.p.enqueue(patch('b.js', 9, 2)); q.p.complete({ added: 9, removed: 2 });
      q.p.enqueue({ name: 'run_bash', target: 'npm test' }); q.p.complete({ ok: false });
      q.set(1000000);
      return q.at().history;
    };
    assert.deepStrictEqual(build(true), build(false),
      'the account of what happened cannot depend on whether it was animated');
  });

  await test('PLAYBACK: busy() says whether the ticker still has work', () => {
    const r = rig();
    assert.strictEqual(r.p.busy(r.now()), false, 'nothing queued, nothing to do');
    r.p.enqueue(read('a.js')); r.p.complete({});
    assert.strictEqual(r.p.busy(r.now()), true);
    r.set(100000);
    r.at();
    assert.strictEqual(r.p.busy(r.now()), false, 'drained');
  });

  await test('PLAYBACK: the playhead never moves BACKWARDS', () => {
    // A redraw at an earlier clock reading — a resize, a replayed frame — must
    // not un-finish an activity that has already been left behind.
    const r = rig();
    for (const f of ['a.js', 'b.js']) { r.p.enqueue(read(f)); r.p.complete({}); }
    r.set(100000);
    const drained = r.at().history.length;
    r.set(1000);                            // clock goes backwards
    assert.ok(r.at().history.length >= drained, 'history cannot shrink');
  });

  await test('PLAYBACK: calling at() twice with one clock gives one answer', () => {
    // Purity. A frame drawn twice must not advance the timeline.
    const r = rig();
    r.p.enqueue(read('a.js')); r.p.complete({});
    r.tick(ENTER_MS + 10);
    const a = r.at();
    const b = r.at();
    assert.deepStrictEqual(a.active, b.active);
    assert.strictEqual(a.history.length, b.history.length);
  });

  await test('PLAYBACK: a failed activity keeps its failure into history', () => {
    const r = rig();
    r.p.enqueue({ name: 'run_bash', target: 'npm test' });
    r.p.complete({ ok: false, note: '3 failing' });
    r.set(100000);
    const h = r.at().history[0];
    assert.strictEqual(h.ok, false, 'a failure is not animated away');
    assert.strictEqual(h.note, '3 failing');
  });

  await test('PLAYBACK: it is bounded — a runaway turn cannot grow it for ever', () => {
    const r = rig();
    for (let i = 0; i < MAX_EVENTS + 50; i++) r.p.enqueue(read(`f${i}.js`));
    assert.ok(r.p.events.length <= MAX_EVENTS, `bounded at ${MAX_EVENTS}`);
  });

  await test('PLAYBACK: reset clears the timeline for a new task', () => {
    const r = rig();
    r.p.enqueue(read('a.js')); r.p.complete({});
    r.p.reset();
    const s = r.at();
    assert.strictEqual(s.history.length, 0);
    assert.strictEqual(s.active, null);
  });

  await test('PLAYBACK: enqueue is synchronous and returns at once', () => {
    // The agent never waits on the UI. If this ever returned a promise, a turn
    // loop that awaited it would be pacing itself to an animation.
    const r = rig();
    const got = r.p.enqueue(read('a.js'));
    assert.ok(got && typeof got.then !== 'function', 'enqueue must not be awaitable');
  });
  await test('PLAYBACK: two calls enqueued before either result STILL both finish', () => {
    // THE STICKING BUG. `complete` took the NEWEST event, which is right only
    // while calls are strictly sequential. Enqueue two before either result and
    // the FIRST was never marked done — its hold is Infinity, so the timeline
    // stopped on it for the rest of the session, permanently occupying the
    // active position and the rows beneath it.
    const r = rig();
    r.p.enqueue(read('a.js'));
    r.p.enqueue(read('b.js'));
    r.p.complete({});                       // a.js finished
    r.p.complete({});                       // b.js finished
    assert.ok(r.p.events.every((e) => e.done), 'both must be marked finished');
    r.set(500000);
    assert.strictEqual(r.at().active, null, 'and the timeline must drain');
    assert.deepStrictEqual(r.at().history.map((h) => h.target), ['a.js', 'b.js']);
  });

  await test('PLAYBACK: results are matched to calls in the order they were made', () => {
    // The failing/succeeding outcome has to land on the right activity.
    const r = rig();
    r.p.enqueue(read('first.js'));
    r.p.enqueue(read('second.js'));
    r.p.complete({ ok: false, note: 'first failed' });
    r.p.complete({ ok: true });
    r.set(500000);
    const h = r.at().history;
    assert.strictEqual(h[0].target, 'first.js');
    assert.strictEqual(h[0].ok, false, 'the failure belongs to the FIRST call');
    assert.strictEqual(h[1].ok, true);
  });
};
