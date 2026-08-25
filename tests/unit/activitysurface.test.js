'use strict';

/**
 * THE ACTIVITY SURFACE — the three parts wired together.
 *
 * ui/playback.js and ui/diffreel.js are tested on their own; this is the seam
 * between them and the rest of the program. What it holds is the property the
 * whole feature rests on, stated as one assertion wherever it can be:
 *
 *     THE ANIMATION MAY BE BEHIND REALITY. IT MAY NOT CHANGE IT.
 *
 * So the cases below are mostly about what must NOT happen: the surface must
 * not block, must not lose an event, must not report different facts when it is
 * turned off, and must not need a timer of its own.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { ActivitySurface } = require('../../src/ui/activity');

/** A newline, as a value — these files are written without literal escapes. */
const NL = String.fromCharCode(10);

function rig({ instant = false } = {}) {
  let t = 2000;
  const a = new ActivitySurface({ instant, now: () => t });
  return { a, tick: (ms) => { t += ms; return t; }, now: () => t, set: (v) => { t = v; } };
}

/** Drive one whole tool call through the surface. */
function call(r, name, target, patch) {
  r.a.begin(name, target);
  r.a.end({ name, ok: true, ...(patch || {}) });
}

module.exports = async function () {
  await test('SURFACE: a REFACTOR of three files performs all three windows', () => {
    // Three edits landing within a second of each other is the case the queue
    // was built for. Showing one and skipping the rest is the failure it exists
    // to prevent, so the debt ceiling has to clear a refactor.
    const r = rig();
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join(NL);
    const after = body.split(NL).map((l, i) => (i % 9 === 0 ? `CHANGED ${i}` : l)).join(NL);
    let performed = 0;
    for (const f of ['first.js', 'second.js', 'third.js']) {
      call(r, 'edit_file', f, { added: 5, removed: 5 });
      if (r.a.showDiff(f, body, after)) performed += 1;
    }
    assert.strictEqual(performed, 3, 'every change in a refactor is performed');
  });

  await test('SURFACE: a FLOOD of operations does not park the presentation', () => {
    // ---- THE CEILING THE SECOND QUEUE USED TO PROVIDE --------------------
    //
    // `MAX_QUEUE` went with ui/diffreel.js's queue. Without a replacement every
    // event carried a window, and a burst of thirty reads ran for thirty-three
    // seconds after the work was over. The WINDOW is the part that goes; every
    // operation still gets its card.
    const r = rig();
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join(NL);
    let performed = 0;
    for (let i = 0; i < 30; i++) {
      call(r, 'read_file', `f${i}.js`);
      if (r.a.showRead(`f${i}.js`, body)) performed += 1;
    }
    assert.ok(performed >= 2 && performed <= 8,
      `a few are performed and the rest are cards: ${performed}/30`);

    // AND IT CONVERGES. Walk the clock until nothing is playing.
    let x = r.now();
    while (r.a.busy(x) && x < r.now() + 300000) x += 16;
    const secs = (x - r.now()) / 1000;
    assert.ok(secs < 25, `the presentation drains rather than parking: ${secs.toFixed(1)}s`);

    // NOTHING WAS DROPPED FROM THE ACCOUNT — only from the performance.
    r.set(10 ** 7);
    const rows = r.a.rows(120, r.now()).join(NL);
    for (let i = 0; i < 30; i++) {
      assert.ok(rows.includes(`f${i}.js`), `f${i}.js is still in the account`);
    }
  });

  await test('SURFACE: the window is never drawn under a card naming a different file', () => {
    // ---- SEEN ON SCREEN, and it is the incoherence to remove -------------
    //
    //     reading
    //       python.js
    //
    //     ┌─ router.js ────────────────────────────────┐
    //
    // Two halves of one surface naming two files. `_linger` buys a card the
    // time its own window needs, which covers the common case; it cannot cover
    // drift, because the reel and the timeline advance on separate catch-up
    // clocks. So the DRAWING enforces what the counters already enforce.
    const r = rig();
    // A window is opened for one file while the card on screen names another.
    r.a.begin('read_file', 'python.js');
    r.a.end({ name: 'read_file', ok: true });
    r.a.showRead('router.js', ['a', 'b', 'c', 'd'].join(String.fromCharCode(10)));
    r.tick(300);
    const rows = r.a.liveRows(100, r.now()).join(String.fromCharCode(10));
    assert.match(rows, /python\.js/, 'the card is still drawn, and still names its own file');
    assert.ok(!/┌─ router\.js/.test(rows),
      `no window may be drawn under a card naming something else:${String.fromCharCode(10)}${rows}`);
  });

  await test('SURFACE: the window IS drawn when it names the same file as its card', () => {
    // The guard must not have closed on the case the window exists for — and
    // the two halves are named by different sources, so `src/parser.js` on the
    // card and `parser.js` in the window are one file spelled two ways.
    const r = rig();
    r.a.begin('read_file', 'src/parser.js');
    r.a.end({ name: 'read_file', ok: true });
    r.a.showRead('src/parser.js', ['a', 'b', 'c', 'd'].join(String.fromCharCode(10)));
    r.tick(400);
    const rows = r.a.liveRows(100, r.now()).join(String.fromCharCode(10));
    assert.match(rows, /┌─ src[\/]parser\.js/, `the window opens under its own card:${String.fromCharCode(10)}${rows}`);
  });

  await test('SURFACE: a tool call becomes rows', () => {
    const r = rig();
    call(r, 'read_file', 'python.js');
    r.tick(200);
    const rows = r.a.rows(80, r.now()).join('\n');
    assert.match(rows, /reading/, 'the label');
    assert.match(rows, /python\.js/, 'and the thing it is reading');
  });

  await test('SURFACE: begin() and end() return immediately — nothing awaits them', () => {
    // The agent must never be paced by the UI. A promise here would let a turn
    // loop that awaited it start waiting on an animation.
    const r = rig();
    const a = r.a.begin('read_file', 'x.js');
    const b = r.a.end({ name: 'read_file', ok: true });
    for (const v of [a, b]) assert.ok(!v || typeof v.then !== 'function', 'must not be awaitable');
  });

  await test('SURFACE: it holds no timer of its own', () => {
    // Everything is computed from a clock reading passed in. A timer here could
    // fire after teardown, drift, or keep the process alive.
    const r = rig();
    call(r, 'read_file', 'x.js');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'ui', 'activity.js'), 'utf8');
    // THE CLASS, not the file. The redraw clock (`syncTicker`) lives in this
    // module too and is the ONE timer in it — but it belongs to the SCREEN: it
    // is handed the ui and asks it to refresh. The surface it drives computes
    // everything from a clock reading passed in, and must schedule nothing.
    const inSurface = src.split('class ActivitySurface')[1].split('function syncTicker')[0];
    assert.ok(!/setInterval|setTimeout/.test(inSurface),
      'the surface itself must not schedule anything');
    // And the timer that does exist is unref'd, so it can never be the reason
    // the process stays alive.
    assert.match(src, /unref/, 'the redraw clock must not hold the process open');
  });

  await test('SURFACE: a long backlog keeps every event, in order', () => {
    const r = rig();
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.js`);
    for (const f of files) call(r, 'read_file', f);
    r.set(10 ** 7);
    const rows = r.a.rows(120, r.now()).join('\n');
    for (const f of files) assert.ok(rows.includes(f), `${f} was dropped from the account`);
  });

  await test('SURFACE: INSTANT reports the same events as animated', () => {
    // The property that makes animation safe to turn off. A pipe, a test and a
    // real terminal must agree about what happened.
    const run = (instant) => {
      const r = rig({ instant });
      call(r, 'read_file', 'a.js');
      call(r, 'apply_patch', 'b.js', { added: 9, removed: 2 });
      call(r, 'run_bash', 'npm test');
      r.set(10 ** 7);
      return r.a.rows(120, r.now()).join('\n');
    };
    const off = run(true);
    const on = run(false);
    for (const marker of ['a.js', 'b.js', 'npm test']) {
      assert.ok(off.includes(marker), `animation off lost ${marker}`);
      assert.ok(on.includes(marker), `animation on lost ${marker}`);
    }
  });

  await test('SURFACE: the edit counters come from the CHECKPOINT, not the tool', () => {
    // `counts` is called after the result, with the real numbers read off the
    // checkpoint (turnevents.js). Until then the card shows nothing, which is
    // better than showing a number the tool guessed.
    const r = rig();
    r.a.begin('edit_file', 'python.js');
    r.a.end({ name: 'edit_file', ok: true });
    r.a.counts(72, 40);
    r.set(10 ** 7);
    const rows = r.a.rows(100, r.now()).join('\n');
    assert.match(rows, /\+72/, 'the real addition count');
    assert.match(rows, /-40/, 'and the real removal count');
  });

  await test('SURFACE: a diff window opens under the edit and then goes away', () => {
    const r = rig();
    call(r, 'edit_file', 'python.js', { added: 2, removed: 1 });
    r.a.showDiff('python.js', ['+ added line', '- removed line']);
    // ---- THE CARD FIRST, THEN ITS WINDOW ---------------------------------
    //
    // The window plays from the END of ENTER, so the subject is under the verb
    // before anything opens beneath it — which is the lifecycle the brief asks
    // for: `patching / python.js`, a beat, then the viewer. So the walk has to
    // clear ENTER and the window's own opening before there is content to
    // assert on. It used to be 300ms because the window ran on a clock of its
    // own that started the moment `showDiff` was called.
    r.tick(600);
    assert.match(r.a.rows(90, r.now()).join('\n'), /added line|removed line/,
      'the change is shown');
    r.set(10 ** 7);
    assert.ok(!/added line/.test(r.a.rows(90, r.now()).join('\n')),
      'and the window does not stay open');
  });

  await test('SURFACE: the card and the window it sits over name the SAME file', () => {
    // ---- WATCHED ON A REAL RUN --------------------------------------------
    //
    // The card read `patching src/parser.js` while the window under it was
    // still striking and rewriting `src/serializer.js`. Two halves of one
    // surface naming two different files is the incoherence this presentation
    // exists to remove.
    const r = rig();
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const after = before.split('\n').map((l, i) => (i === 5 ? 'CHANGED' : l)).join('\n');
    call(r, 'edit_file', 'src/serializer.js', { added: 1, removed: 1 });
    r.a.showDiff('src/serializer.js', before, after);
    call(r, 'edit_file', 'src/parser.js', { added: 1, removed: 1 });

    // ---- NOW UNREACHABLE, AND THE ASSERTION SAYS SO ----------------------
    //
    // It used to be a property that held because two clocks happened to agree.
    // The window is a property of the EVENT now (ui/playback.js `window`), so
    // the surface cannot produce a frame in which they differ — this walks the
    // whole performance looking for one anyway, because a structural guarantee
    // that nothing checks is a comment.
    let framesWithWindow = 0;
    for (let t = 0; t < 20000; t += 40) {
      const now = r.now() + t;
      const state = r.a.playback.at(now);
      const win = r.a._window(state);
      if (!state.active || !win || !win.open) continue;
      framesWithWindow += 1;
      assert.strictEqual(win.file, state.active.target,
        `at +${t}ms the card says ${state.active.target} and the window says ${win.file}`);
    }
    assert.ok(framesWithWindow > 0, 'and a window really was drawn during the walk');
  });

  await test('SURFACE: a window is performed for EACH change, in the order they happened', () => {
    // The ordering that used to belong to a second queue in ui/diffreel.js. It
    // is the playhead's now, which is the whole point: one order for the cards
    // and the windows, because they are the same list.
    const r = rig();
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join(NL);
    const edit = (n) => before.split(NL).map((l, i) => (i === n ? `CHANGED ${n}` : l)).join(NL);
    for (const [n, f] of [[5, 'first.js'], [12, 'second.js'], [20, 'third.js']]) {
      call(r, 'edit_file', f, { added: 1, removed: 1 });
      r.a.showDiff(f, before, edit(n));
    }
    const order = [];
    for (let t = 0; t < 60000; t += 40) {
      const now = r.now() + t;
      const win = r.a._window(r.a.playback.at(now));
      if (win && win.open && order[order.length - 1] !== win.file) order.push(win.file);
    }
    assert.deepStrictEqual(order, ['first.js', 'second.js', 'third.js']);
  });

  await test('SURFACE: a READ and an EDIT are performed in the order they happened', () => {
    const r = rig();
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join(NL);
    const after = before.split(NL).map((l, i) => (i === 5 ? 'CHANGED' : l)).join(NL);
    call(r, 'read_file', 'first.js');
    r.a.showRead('first.js', before);
    call(r, 'edit_file', 'second.js', { added: 1, removed: 1 });
    r.a.showDiff('second.js', before, after);
    const order = [];
    for (let t = 0; t < 60000; t += 40) {
      const win = r.a._window(r.a.playback.at(r.now() + t));
      if (win && win.open && order[order.length - 1] !== win.file) order.push(win.file);
    }
    assert.deepStrictEqual(order, ['first.js', 'second.js']);
  });

  await test('SURFACE: the verb stays PRESENT TENSE while its own window performs', () => {
    // The third way the two halves could disagree: the card settling to `edit`
    // — the finished tense — while the window under it was still striking lines
    // out and typing replacements. The operation is manifestly still being
    // performed, so the card must not describe it as over.
    const r = rig();
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join(NL);
    const after = before.split(NL).map((l, i) => (i === 5 ? 'CHANGED' : l)).join(NL);
    call(r, 'edit_file', 'python.js', { added: 1, removed: 1 });
    r.a.showDiff('python.js', before, after);
    let sawOpen = false;
    for (let t = 0; t < 20000; t += 25) {
      const state = r.a.playback.at(r.now() + t);
      const win = r.a._window(state);
      if (!state.active || !win || !win.open) continue;
      sawOpen = true;
      assert.strictEqual(state.active.verb, 'patching',
        `at +${t}ms the window is still performing but the card says "${state.active.verb}"`);
    }
    assert.ok(sawOpen, 'the window really did open during the walk');
  });

  await test('SURFACE: the counters on the card are the ones from ITS OWN window', () => {
    // The guard for when the two can still come apart — a card released by
    // `settle`, or a queue that had to drop one. Counting one file's lines onto
    // a card naming another is worse than showing no counters at all.
    const r = rig();
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const after = before.split('\n').map((l, i) => (i === 5 ? 'CHANGED' : l)).join('\n');
    call(r, 'edit_file', 'a.js', { added: 9, removed: 9 });
    r.a.showDiff('b.js', before, after);              // deliberately mismatched
    r.tick(500);
    const rows = r.a.liveRows(90, r.now()).join('\n');
    assert.ok(!/\+1 /.test(rows), `b.js's counts must not land on a.js's card:\n${rows}`);
  });

  await test('SURFACE: an edit HOLDS its card while its own change is performed', () => {
    const r = rig();
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const after = before.split('\n').map((l, i) => (i === 5 || i === 40 ? 'CHANGED' : l)).join('\n');
    call(r, 'edit_file', 'big.js', { added: 2, removed: 2 });
    const e = r.a.playback.events[r.a.playback.events.length - 1];
    assert.strictEqual(e.linger, 0, 'nothing is held for a change with no window');
    r.a.showDiff('big.js', before, after);
    assert.ok(e.linger > 0, `the card is given its window's time: ${e.linger}ms`);
    const { MAX_LINGER_MS } = require('../../src/ui/activity');
    assert.ok(e.linger <= MAX_LINGER_MS, 'and never more than the ceiling');
  });

  await test('SURFACE: the compact edit line REMAINS after the window closes', () => {
    // The window is temporary; the record of the edit is not.
    const r = rig();
    call(r, 'edit_file', 'python.js', { added: 72, removed: 40 });
    r.a.showDiff('python.js', ['+ a', '- b']);
    r.set(10 ** 7);
    const rows = r.a.rows(100, r.now()).join('\n');
    assert.match(rows, /edit/, 'the edit is still in the account');
    assert.match(rows, /python\.js/);
  });

  await test('SURFACE: busy() goes false once everything has played', () => {
    const r = rig();
    assert.strictEqual(r.a.busy(r.now()), false, 'nothing to do yet');
    call(r, 'read_file', 'a.js');
    assert.strictEqual(r.a.busy(r.now()), true);
    r.set(10 ** 7);
    assert.strictEqual(r.a.busy(r.now()), false, 'and it lets the clock stop');
  });

  await test('SURFACE: with animation off it is NEVER busy', () => {
    // A pipe must not spin a redraw clock for an animation it is not playing.
    const r = rig({ instant: true });
    call(r, 'read_file', 'a.js');
    assert.strictEqual(r.a.busy(r.now()), false);
  });

  await test('SURFACE: reset() empties it for a new task', () => {
    const r = rig();
    call(r, 'read_file', 'a.js');
    r.a.reset();
    r.tick(500);
    assert.strictEqual(r.a.rows(80, r.now()).length, 0);
  });

  await test('SURFACE: rows() is pure — asking twice does not advance it', () => {
    const r = rig();
    call(r, 'read_file', 'a.js');
    r.tick(200);
    assert.deepStrictEqual(r.a.rows(80, r.now()), r.a.rows(80, r.now()));
  });

  await test('SURFACE: a failed call is not animated away', () => {
    const r = rig();
    r.a.begin('run_bash', 'npm test');
    r.a.end({ name: 'run_bash', ok: false, note: '3 failing' });
    r.set(10 ** 7);
    assert.match(r.a.rows(90, r.now()).join('\n'), /✗/, 'the failure survives into history');
  });

  await test('SURFACE: it survives junk without throwing', () => {
    // It sits on the draw path. Anything that can throw here takes the screen
    // down over a picture.
    const r = rig();
    for (const bad of [null, undefined, {}, { name: null }]) {
      assert.doesNotThrow(() => { r.a.begin(bad && bad.name, 'x'); r.a.end(bad); });
    }
    assert.doesNotThrow(() => r.a.showDiff(null, null));
    assert.doesNotThrow(() => r.a.counts(NaN, undefined));
    assert.doesNotThrow(() => r.a.rows(0, r.now()));
  });
};
