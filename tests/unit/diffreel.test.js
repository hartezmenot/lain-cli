'use strict';

/**
 * THE DIFF WINDOW — an edit being performed, not a document being scrolled.
 *
 * A permanent diff panel is wrong most of the time: it shows the last edit for
 * ever and takes rows from the work in progress. This is the glance you get
 * free when an edit lands, which then gets out of the way and leaves one
 * compact line behind.
 *
 * What these assert is the SHAPE OF THE PERFORMANCE, because that is the whole
 * requirement: it goes to a change, stops, marks the old code, writes the new
 * code, settles it, and only then moves on. A version that revealed the same
 * rows top to bottom would satisfy "the diff appeared" and none of this.
 *
 * Same load-bearing property as the timeline: PURE FUNCTION OF (script, clock).
 * The clock is injected and driven by hand — nothing sleeps, and nothing here
 * is timing-dependent.
 */

const assert = require('assert');
const { test } = require('../helpers');

const reel = require('../../src/ui/diffreel');

const { STAGE, OPEN_MS, MAX_ROWS, MAX_REEL_MS } = reel;

/**
 * ONE CHANGE, ON A CLOCK THIS TEST DRIVES.
 *
 * ------------------------------------------------------------------------
 * THE MODULE NO LONGER HAS A CLOCK OR A QUEUE, and that is the fix rather than
 * a convenience: a window belongs to the timeline event that produced it
 * (ui/activity.js), so ORDERING, BOUNDING and CATCH-UP are the one playhead's
 * job in ui/playback.js and are asserted there and in activitysurface.test.js.
 *
 * What is left here is the half that was always this file's own: the SHAPE OF
 * THE PERFORMANCE — go to the change, stop, mark the old code, write the new
 * code, settle it, move on. `frame(item, t)` is a pure function of the change
 * and the plan time reached, so this rig is nothing but a clock and one item.
 */
function rig({ instant = false } = {}) {
  let t = 5000;
  let item = null;
  let startedAt = 0;
  const at = (x) => {
    if (instant || !item) return reel.closed();
    return reel.frame(item, Math.max(0, x - startedAt));
  };
  const put = (built) => {
    if (!built) return false;
    item = built;
    startedAt = t;
    return true;
  };
  const d = {
    show: (f, a, b) => put(reel.build(f, a, b)),
    read: (f, text) => put(reel.buildRead(f, text)),
    at,
    close: () => { item = null; },
    busy: (x) => at(x === undefined ? t : x).open,
    duration: () => reel.planDuration(item),
    get file() { return item ? item.file : ''; },
    get script() { return item ? item.script : { rows: [], hunks: [], added: 0, removed: 0 }; },
    get plan() { return item ? item.plan : { hunks: [], total: 0 }; },
  };
  return {
    d,
    tick: (ms) => { t += ms; return at(t); },
    at: () => at(t),
    set: (v) => { t = v; },
    now: () => t,
    /** Walk the whole performance, collecting every distinct frame. */
    play: (stepMs = 20) => {
      const seen = [];
      const end = t + d.duration() + 200;
      for (let x = t; x <= end; x += stepMs) seen.push(at(x));
      return seen;
    },
  };
}

/** A file, and the same file with `edits` applied by line index. */
function file(n, edits = {}) {
  const a = Array.from({ length: n }, (_, i) => `  const value${i} = compute(${i});`);
  const b = a.slice();
  for (const k of Object.keys(edits)) b[Number(k)] = edits[k];
  return [a.join('\n'), b.join('\n')];
}

module.exports = async function () {
  await test('DIFF: it OPENS, performs the change, and CLOSES — then it is gone', () => {
    const r = rig();
    const [a, b] = file(20, { 5: '  const value5 = other(5);' });
    r.d.show('python.js', a, b);
    assert.strictEqual(r.at().stage, STAGE.OPENING);
    r.set(r.now() + 60000);
    assert.strictEqual(r.at().open, false, 'the window does not stay open');
  });

  await test('DIFF: the window GROWS as it opens and SHRINKS as it closes', () => {
    const r = rig();
    const [a, b] = file(30, { 10: '  const value10 = other(10);' });
    r.d.show('python.js', a, b);
    const early = r.tick(OPEN_MS / 3).height;
    const openFull = r.tick(OPEN_MS).height;
    assert.ok(openFull > early, `it grows: ${early} -> ${openFull}`);
    const frames = r.play(20);
    const closing = frames.filter((f) => f.stage === STAGE.CLOSING).map((f) => f.height);
    assert.ok(closing.length, 'it has a closing motion');
    assert.ok(closing[closing.length - 1] < closing[0], `and it shrinks: ${closing[0]} -> ${closing[closing.length - 1]}`);
  });

  await test('EDITOR: old code is STRUCK before new code is written', () => {
    // The requirement, and the one a scrolling reveal cannot meet: there is a
    // moment where the old line is visibly going and the new one is not there
    // yet. Order matters — a frame with the replacement already written and the
    // original untouched would be the edit shown backwards.
    const r = rig();
    const [a, b] = file(14, { 6: '  const value6 = replaced(6);' });
    r.d.show('python.js', a, b);
    const frames = r.play(15);
    // `striking` is the pen part way across a line; `struck` is a line that has
    // been crossed out. The order under test is about the STRIKE beginning
    // before the write, so the first of either counts.
    const struckAt = frames.findIndex((f) => f.rows.some(
      (x) => x.state === 'struck' || x.state === 'striking'));
    const writeAt = frames.findIndex((f) => f.rows.some((x) => x.state === 'writing'));
    const addedAt = frames.findIndex((f) => f.rows.some((x) => x.state === 'added'));
    assert.ok(struckAt >= 0, 'the old line is struck at some point');
    assert.ok(writeAt >= 0, 'the new line is seen being written');
    assert.ok(addedAt >= 0, 'and it settles');
    assert.ok(struckAt < writeAt, `struck before written: ${struckAt} < ${writeAt}`);
    assert.ok(writeAt < addedAt, `written before settled: ${writeAt} < ${addedAt}`);
  });


  await test('EDITOR: the strike crosses the line out PROGRESSIVELY, not in one step', () => {
    // ---- THE ASYMMETRY THAT WAS THE DEFECT --------------------------------
    //
    // The write phase has always been spent across CHARACTERS; the strike was
    // spent across LINES. So a replacement of ONE line went from ordinary code
    // to fully red between two frames — a state change — while the new line
    // underneath was visibly typed. Half the edit was performed and half of it
    // blinked.
    const r = rig();
    const [a, b] = file(14, { 6: '  const value6 = replacedWithSomethingLonger(6);' });
    r.d.show('python.js', a, b);
    const cuts = [];
    for (const f of r.play(10)) {
      for (const row of f.rows) {
        if (row.state === 'striking' && cuts[cuts.length - 1] !== row.cut) cuts.push(row.cut);
      }
    }
    assert.ok(cuts.length >= 3, `the pen is seen at several positions: ${cuts.join(',')}`);
    assert.ok(cuts.every((c, i) => i === 0 || c >= cuts[i - 1]),
      `and it only ever moves forward: ${cuts.join(',')}`);
    assert.ok(cuts[0] < cuts[cuts.length - 1], 'from the start of the line towards its end');
  });

  await test('EDITOR: a replacement is written PROGRESSIVELY, not pasted in', () => {
    const r = rig();
    const long = '  const value6 = replaced(6, { with: "a considerably longer call" });';
    const [a, b] = file(14, { 6: long });
    r.d.show('python.js', a, b);
    const partials = r.play(15)
      .map((f) => (f.rows.find((x) => x.state === 'writing') || {}).text)
      .filter((x) => typeof x === 'string');
    assert.ok(partials.length >= 3, `several partial states: ${partials.length}`);
    assert.ok(partials[0].length < long.length, 'it starts short');
    for (const p of partials) assert.ok(long.startsWith(p), `every partial is a real prefix: ${p}`);
  });

  await test('EDITOR: a line that has not been reached yet is not shown edited', () => {
    // The window must never perform a change it has not scrolled to. A hunk
    // ahead of the playhead is blank, not written.
    const r = rig();
    const [a, b] = file(60, { 3: '  const value3 = one(3);', 40: '  const value40 = two(40);' });
    r.d.show('python.js', a, b);
    r.tick(OPEN_MS + 5);
    const early = r.at();
    assert.strictEqual(early.hunk, 0, 'it starts at the first change');
    const later = early.rows.filter((x) => x.kind === 'added' && x.state === 'added');
    assert.strictEqual(later.length, 0, 'nothing is settled before it has been written');
  });

  await test('EDITOR: the viewport FOLLOWS the edit and holds still while it happens', () => {
    // Not a scroll speed. `top` moves between changes and does not move during
    // one — which is the difference between someone working through a file and
    // a list going past.
    const r = rig();
    const [a, b] = file(90, { 4: '  const value4 = one(4);', 70: '  const value70 = two(70);' });
    r.d.show('python.js', a, b);
    const frames = r.play(20).filter((f) => f.open && f.rows.length);
    const tops = frames.map((f) => f.top);
    assert.ok(Math.max(...tops) > Math.min(...tops), 'the viewport moved');
    const moving = frames.filter((f) => f.stage === STAGE.SCROLL);
    assert.ok(moving.length, 'and there is a stage where moving is what it is doing');
    // During a WRITE the viewport is stationary: the editor is typing, not
    // travelling.
    const writes = frames.filter((f) => f.stage === STAGE.WRITE && f.hunk === 0).map((f) => f.top);
    if (writes.length > 1) {
      assert.strictEqual(new Set(writes).size, 1, `it holds still while writing: ${[...new Set(writes)]}`);
    }
  });

  await test('COUNTERS: they climb with the real edit and land on the real totals', () => {
    const r = rig();
    const [a, b] = file(60, {
      3: '  const value3 = one(3);',
      4: '  const value4 = one(4);',
      40: '  const value40 = two(40);',
    });
    r.d.show('python.js', a, b);
    const frames = r.play(20).filter((f) => f.open);
    const adds = frames.map((f) => f.added);
    for (let i = 1; i < adds.length; i++) {
      assert.ok(adds[i] >= adds[i - 1], `the counter never goes backwards: ${adds[i - 1]} -> ${adds[i]}`);
    }
    const final = frames[frames.length - 1];
    assert.ok(Math.max(...adds) <= final.finalAdded, 'and never exceeds the truth');
    assert.strictEqual(final.finalAdded, 3);
    assert.strictEqual(final.finalRemoved, 3);
    // It reaches the truth before it closes.
    const settled = frames.filter((f) => f.stage === STAGE.SETTLE || f.stage === STAGE.CLOSING);
    assert.strictEqual(settled[settled.length - 1].added, 3, 'the last thing shown is the real number');
  });

  await test('COUNTERS: the removal count climbs while STRIKING, the addition while WRITING', () => {
    // What the card's ▲ / ▼ marker is derived from (ui/activity.js `track`).
    const r = rig();
    const [a, b] = file(20, { 8: '  const value8 = replaced(8);' });
    r.d.show('python.js', a, b);
    const frames = r.play(15).filter((f) => f.open);
    const strike = frames.filter((f) => f.stage === STAGE.STRIKE);
    const write = frames.filter((f) => f.stage === STAGE.WRITE);
    assert.ok(strike.length && write.length, 'both stages happen');
    // ---- A LINE HALF CROSSED OUT HAS NOT GONE YET ------------------------
    //
    // The count used to jump to 1 the instant the strike began, because the
    // strike advanced a line at a time and starting on a line was the same
    // event as finishing it. Now the pen moves across characters, so those are
    // two different moments — and the honest one for the counter is the second.
    // A card reading `-1` over a line still visibly being struck is the card
    // ahead of the change it is counting.
    assert.strictEqual(strike[0].removed, 0, 'nothing is counted while the pen is still on the line');
    assert.strictEqual(write[0].removed, 1,
      'and by the time it writes, the removal really has happened');
    assert.ok(write[write.length - 1].added >= 0, 'the addition count moves while writing');
  });

  await test('DIFF: several changes are performed IN ORDER, one at a time', () => {
    const r = rig();
    const [a, b] = file(120, {
      5: '  const value5 = one(5);',
      50: '  const value50 = two(50);',
      100: '  const value100 = three(100);',
    });
    r.d.show('python.js', a, b);
    const seen = [];
    for (const f of r.play(20)) {
      if (f.open && f.hunk >= 0 && seen[seen.length - 1] !== f.hunk) seen.push(f.hunk);
    }
    assert.deepStrictEqual(seen, [0, 1, 2], `three changes, in order: ${seen}`);
  });

  await test('DIFF: a huge refactor is bounded in both rows and time', () => {
    const r = rig();
    const edits = {};
    for (let i = 0; i < 300; i += 3) edits[i] = `  const value${i} = rewritten(${i});`;
    const [a, b] = file(400, edits);
    r.d.show('big.js', a, b);
    r.tick(OPEN_MS + 10);
    assert.ok(r.at().rows.length <= MAX_ROWS, 'bounded rows');
    assert.ok(r.d.duration() <= OPEN_MS + MAX_REEL_MS + 1000,
      `bounded time: ${Math.round(r.d.duration())}ms`);
    r.set(r.now() + 60000);
    assert.strictEqual(r.at().open, false, 'and it finished');
  });

  await test('DIFF: a tiny change still opens and still closes', () => {
    const r = rig();
    r.d.show('tiny.js', 'a\nb\nc', 'a\nB\nc');
    assert.ok(r.at().open, 'one line is still worth showing');
    r.set(r.now() + 30000);
    assert.strictEqual(r.at().open, false);
  });

  await test('DIFF: an unchanged file never opens at all', () => {
    // Nothing to perform means no window. A tool that reported success while
    // changing nothing is worth NOT animating.
    const r = rig();
    assert.strictEqual(r.d.show('x.js', 'same\ntext', 'same\ntext'), false);
    assert.strictEqual(r.at().open, false);
  });

  // ---- THE QUEUE TESTS HAVE MOVED, AND SO HAS THE QUEUE ------------------
  //
  // Ordering, bounding and catch-up used to live here, in a second queue with
  // a second clock — which is exactly what let a card and the window under it
  // name two different files. A window now belongs to the timeline event that
  // produced it, so those three questions are the one playhead's and are
  // asserted where it lives: `activitysurface.test.js` for order and for the
  // card/window identity, `playback.test.js` for bounding and catch-up.
  //
  // Nothing was dropped; the assertions are on the owner instead of on a
  // duplicate of it.


  await test('INSTANT: with animation off the window never opens', () => {
    // The path a pipe and a test take. The EDIT still happened — this only
    // decides whether it is performed on screen.
    const r = rig({ instant: true });
    const [a, b] = file(30, { 5: '  const value5 = one(5);' });
    r.d.show('python.js', a, b);
    assert.strictEqual(r.at().open, false);
    assert.strictEqual(r.at().rows.length, 0);
  });

  await test('DIFF: busy() tells the ticker when it still has work', () => {
    const r = rig();
    assert.strictEqual(r.d.busy(r.now()), false, 'nothing showing');
    const [a, b] = file(20, { 5: '  const value5 = one(5);' });
    r.d.show('python.js', a, b);
    assert.strictEqual(r.d.busy(r.now()), true);
    r.set(r.now() + 60000);
    assert.strictEqual(r.d.busy(r.now()), false, 'and it lets go when finished');
  });

  await test('DIFF: close() takes it away immediately', () => {
    const r = rig();
    const [a, b] = file(30, { 5: '  const value5 = one(5);' });
    r.d.show('python.js', a, b);
    r.tick(OPEN_MS + 10);
    r.d.close();
    assert.strictEqual(r.at().open, false);
  });

  await test('DIFF: calling at() twice with one clock gives one answer', () => {
    const r = rig();
    const [a, b] = file(30, { 5: '  const value5 = one(5);', 20: '  const value20 = two(20);' });
    r.d.show('python.js', a, b);
    r.tick(OPEN_MS + 200);
    assert.deepStrictEqual(r.at(), r.at(), 'a frame drawn twice must not advance it');
  });

  await test('DIFF: a caller with only rendered rows still gets a window', () => {
    // The honest floor. It cannot know where the changes are relative to each
    // other — that is one hunk — but the markers, the colours and the counts
    // are real.
    const r = rig();
    assert.strictEqual(r.d.show('python.js', ['   1   context', '   2 - old line', '   2 + new line']), true);
    r.tick(OPEN_MS + 10);
    const s = r.at();
    assert.strictEqual(s.finalAdded, 1);
    assert.strictEqual(s.finalRemoved, 1);
    assert.ok(s.rows.some((x) => x.kind === 'removed'), 'the removal survives');
  });

  await test('DIFF: a NEW file animates as all additions and no removals', () => {
    const r = rig();
    r.d.show('new.js', null, 'one\ntwo\nthree');
    r.tick(OPEN_MS + 10);
    assert.strictEqual(r.at().finalRemoved, 0);
    assert.strictEqual(r.at().finalAdded, 3);
  });

  await test('READ: the code is ALREADY THERE — nothing is written', () => {
    // ---- THE DISTINCTION THIS EXISTS FOR ---------------------------------
    //
    // An edit is something HAPPENING: the old line is going and the new one is
    // being typed, and striking and writing them is true. A READ changes
    // nothing — the code was on disk before LAIN opened it — so animating it as
    // though it were being written is the presentation layer inventing an
    // event. The content is present from the first frame.
    const r = rig();
    const text = Array.from({ length: 40 }, (_, i) => `  const value${i} = compute(${i});`).join('\n');
    assert.strictEqual(r.d.read('src/parser.js', text), true);
    const frames = r.play(40).filter((f) => f.open && f.rows.length);
    assert.ok(frames.length, 'the window opens');
    for (const f of frames) {
      for (const row of f.rows) {
        assert.ok(row.state === 'plain' || row.state === 'gap',
          `a read has one neutral weight, got ${row.state}`);
      }
      assert.strictEqual(f.added, 0, 'nothing was added');
      assert.strictEqual(f.removed, 0, 'nothing was removed');
    }
    // Every row is the real text, whole, from the very first frame.
    const first = frames[0].rows.find((x) => x.kind === 'context');
    assert.ok(/const value\d+ = compute/.test(first.text), `the code is there: ${first.text}`);
  });

  await test('READ: the window TRAVELS down the file', () => {
    const r = rig();
    const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    r.d.read('big.js', text);
    const tops = r.play(40).filter((f) => f.open && f.rows.length).map((f) => f.top);
    assert.ok(Math.max(...tops) > Math.min(...tops), `the viewport moved: ${Math.min(...tops)} -> ${Math.max(...tops)}`);
    // Downwards only. A read that scrolled back up would be re-reading, which
    // is not what happened.
    for (let i = 1; i < tops.length; i++) assert.ok(tops[i] >= tops[i - 1], 'and only downwards');
  });

  await test('READ: it is bounded in rows and in time', () => {
    const { READ_ROWS, READ_MAX } = require('../../src/ui/diffreel');
    const r = rig();
    r.d.read('huge.js', Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n'));
    assert.ok(r.d.script.rows.length <= READ_ROWS + 1, `bounded rows: ${r.d.script.rows.length}`);
    assert.ok(r.d.duration() <= READ_MAX + 2000, `bounded time: ${Math.round(r.d.duration())}ms`);
    assert.ok(r.d.script.rows.some((x) => x.kind === 'gap'), 'and it says what it did not show');
    r.set(r.now() + 60000);
    assert.strictEqual(r.at().open, false);
  });

  await test('READ: an empty file opens no window', () => {
    const r = rig();
    assert.strictEqual(r.d.read('empty.js', ''), false);
    assert.strictEqual(r.at().open, false);
  });

  await test('READ and EDIT build the SAME shape of item', () => {
    // They are performed differently and drawn on one surface, so they have to
    // be interchangeable to the thing that owns them — a timeline event holds
    // either without knowing which it has. The ORDER they play in is the
    // playhead's and is asserted in activitysurface.test.js.
    const [a, b] = file(30, { 5: '  const value5 = one(5);' });
    const look = reel.buildRead('first.js', a);
    const edit = reel.build('second.js', a, b);
    for (const item of [look, edit]) {
      assert.ok(item && item.file && item.script && item.plan, 'file, script and plan');
      assert.ok(reel.planDuration(item) > 0, 'and a length the owner can reserve');
    }
    assert.strictEqual(look.reading, true, 'a read says it is one');
    assert.strictEqual(edit.reading, false, 'and an edit says it is not');
  });
};
