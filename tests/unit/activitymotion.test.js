'use strict';

/**
 * THE ACTIVITY SURFACE MOVES, AND NOTHING IS DRAWN TWICE.
 *
 * ------------------------------------------------------------------------
 * TWO DEFECTS, BOTH FOUND BY MEASURING FRAMES RATHER THAN BY READING CODE.
 *
 * ONE OPERATION, DRAWN TWICE. `playback.at()` advances its cursor past an event
 * — so the event enters `history` — and ALSO hands the same event back as
 * `active.leaving`, because the drawing layer wants to show it moving out of
 * the live position. Both were drawn, for the whole ENTER phase:
 *
 *     r1 |  · read     beta.js     <- history
 *     r2 |
 *     r3 |  · read     beta.js     <- leaving: the same operation again
 *     r4 |  reading
 *
 * TELEPORTING BY TWO ROWS. Tracking each target's row index every 30ms showed
 * exactly two positions per operation and no intermediate:
 *
 *     beta.js   870ms:r3   1740ms:r1        <- a two-row jump, in one step
 *
 * Removing the duplicate fixed both: the `leaving` row IS the intermediate
 * position, and it was being cancelled out by the copy of itself sitting in the
 * history list.
 *
 * ONE FLAT WEIGHT. Every finished row carried the identical SGR `2`, so a read
 * from thirty seconds ago looked exactly like one that had just finished.
 *
 * ------------------------------------------------------------------------
 * WHAT IS ASSERTED, and it is deliberately about MEASURED FRAMES: row indices
 * sampled densely through a whole playback, and the actual escape codes on the
 * drawn rows. A test that read the state machine's fields would have passed
 * throughout both defects — the state was always right; the DRAWING was wrong.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Playback } = require('../../src/ui/playback');
const tl = require('../../src/ui/timeline');

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const FILES = ['alpha.js', 'beta.js', 'gamma.js', 'delta.js'];

/** A playback of four completed reads, driven by a clock the test owns. */
function reel() {
  let t = 1000;
  const pb = new Playback({ now: () => t });
  for (const f of FILES) { pb.enqueue({ name: 'read_file', target: f }); pb.complete({ ok: true }); }
  return { pb, at: (dt) => pb.at(1000 + dt) };
}

/** Every target's row index over the whole playback, sampled densely. */
function tracks(step = 30, until = 4400) {
  const r = reel();
  const seen = new Map();
  for (let dt = 0; dt <= until; dt += step) {
    const rows = tl.rows(r.at(dt), 80).map(strip);
    for (const f of FILES) {
      const i = rows.findIndex((row) => row.includes(f));
      if (i < 0) continue;
      if (!seen.has(f)) seen.set(f, []);
      const a = seen.get(f);
      if (!a.length || a[a.length - 1] !== i) a.push(i);
    }
  }
  return seen;
}

module.exports = async function () {
  await test('MOTION: no activity is ever drawn twice in one frame', () => {
    const r = reel();
    for (let dt = 0; dt <= 4400; dt += 30) {
      const rows = tl.rows(r.at(dt), 80).map(strip);
      for (const f of FILES) {
        const n = rows.filter((row) => row.includes(f)).length;
        assert.ok(n <= 1,
          `t+${dt}ms: ${f} appears ${n} times\n${rows.join('\n')}`);
      }
    }
  });

  await test('MOTION: the leaving transition is KEPT — the fix must not delete it', () => {
    // The duplicate was removed by dropping the history COPY, never the
    // transition. If this stops holding, the live position goes back to being
    // replaced between two frames, which is the flicker it was written to fix.
    const r = reel();
    let sawLeaving = false;
    for (let dt = 0; dt <= 4400; dt += 30) {
      const st = r.at(dt);
      if (st.active && st.active.leaving) {
        sawLeaving = true;
        const rows = tl.rows(st, 80).map(strip);
        assert.ok(rows.some((row) => row.includes(st.active.leaving.target)),
          'the leaving operation must still be drawn while it is leaving');
      }
    }
    assert.ok(sawLeaving, 'no ENTER phase carried a leaving operation at all');
  });

  await test('MOTION: a row moves ONE position at a time, not two', () => {
    // The measurement the audit made. An operation travelling from the live
    // position to the history list must be seen at an intermediate row.
    const t = tracks();
    for (const f of ['beta.js', 'gamma.js']) {
      const track = t.get(f);
      assert.ok(track && track.length >= 3,
        `${f} occupied ${track ? track.length : 0} positions — it teleported (${JSON.stringify(track)})`);
      for (let i = 1; i < track.length; i++) {
        assert.ok(Math.abs(track[i] - track[i - 1]) <= 1,
          `${f} jumped ${track[i - 1]} -> ${track[i]} (${JSON.stringify(track)})`);
      }
    }
  });

  await test('MOTION: history has THREE weights, not one', () => {
    // Measured on the escape codes, because that is what a person sees. The
    // whole defect was that these were identical.
    const prev = process.env.LAIN_FORCE_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      let t = 1000;
      const pb = new Playback({ now: () => t });
      for (const f of ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js']) {
        pb.enqueue({ name: 'read_file', target: f });
        pb.complete({ ok: true });
      }
      const rows = tl.rows(pb.at(1000 + 5200), 70).map(String);
      assert.ok(rows.length >= 6, 'need enough history to have tiers');

      const toneOf = (row) => (/\x1b\[2m[^\x1b]*read/.test(row) ? 'dim'
        : /\x1b\[38;5;244m[^\x1b]*read/.test(row) ? 'faint' : 'plain');
      const tones = rows.map(toneOf);

      // Oldest recedes furthest; the one that just finished is still warm.
      assert.strictEqual(tones[0], 'faint', `oldest row should recede: ${JSON.stringify(tones)}`);
      assert.strictEqual(tones[tones.length - 1], 'plain',
        `the row that just finished should still be warm: ${JSON.stringify(tones)}`);
      assert.ok(tones.includes('dim'), `the middle tier is missing: ${JSON.stringify(tones)}`);
      assert.ok(new Set(tones).size >= 3,
        `only ${new Set(tones).size} weight(s) in history: ${JSON.stringify(tones)}`);
    } finally {
      if (prev === undefined) delete process.env.LAIN_FORCE_COLOR;
      else process.env.LAIN_FORCE_COLOR = prev;
    }
  });

  await test('MOTION: the live operation is still the strongest thing on the surface', () => {
    const r = reel();
    const st = r.at(1400);
    assert.ok(st.active, 'something must be live at this moment');
    const rows = tl.rows(st, 80).map(strip);
    // Two rows for the live one — a verb and its subject — against one row for
    // everything finished. That is the hierarchy, and it survives monochrome.
    const live = rows.slice(-2);
    assert.ok(/^\s{2}\S/.test(live[0]), `the verb sits at the margin: ${JSON.stringify(live[0])}`);
    assert.ok(/^\s{4}\S/.test(live[1]), `its subject is indented under it: ${JSON.stringify(live[1])}`);
  });

  await test('MOTION: presentation stays a pure function of the clock', () => {
    // Asking twice at the same instant must answer the same thing, or the
    // surface is not replayable and a redraw could advance it.
    const r = reel();
    for (const dt of [300, 1200, 2400, 3600]) {
      const a = tl.rows(r.at(dt), 80).map(strip);
      const b = tl.rows(r.at(dt), 80).map(strip);
      assert.deepStrictEqual(b, a, `drawing twice at t+${dt}ms differed`);
    }
  });
};
