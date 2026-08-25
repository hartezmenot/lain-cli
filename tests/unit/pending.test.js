'use strict';

/**
 * PENDING USER INPUT — and, unit half.
 *
 * The behaviour: text typed at a WORKING LAIN is caught, shown as waiting, and
 * handed to the turn already running at its next safe point. What it must not
 * do is start a second task, arrive mid-tool-call, or vanish.
 *
 * The region is drawn from the same snapshot the strip reads, so what is on
 * screen and what the turn will receive cannot disagree — there is one queue.
 */

const assert = require('assert');
const { test } = require('../helpers');

const pending = require('../../src/ui/pending');
const strip = (s) => String(s).replace(new RegExp(String.fromCharCode(27) + '\[[0-9;]*m', 'g'), '');

/** A real App with a task, off a TTY — the same shape steer.test.js uses. */
function fakeApp() {
  const { App } = require('../../src/app');
  const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
  app.session.task = new (require('../../src/task').Task)('build the thing');
  return app;
}

module.exports = async function () {
  await test('PENDING: nothing waiting costs no rows at all', () => {
    // The conversation is the surface everything else exists to serve. A region
    // that reserved space for an empty queue would take a row of it forever.
    assert.strictEqual(pending.rows({ pending: [] }), 0);
    assert.strictEqual(pending.rows({}), 0);
    assert.deepStrictEqual(pending.draw({ pending: [] }, 80, 0), []);
  });

  await test('PENDING: one waiting line is a rule and the line', () => {
    const st = { pending: ['also check the backend'] };
    assert.strictEqual(pending.rows(st), 2);
    const rows = pending.draw(st, 60, 2).map(strip);
    assert.match(rows[0], /PENDING USER INPUT/);
    assert.match(rows[1], /also check the backend/);
  });

  await test('PENDING: ORDER IS KEPT and nothing is merged', () => {
    // Two sentences typed a minute apart are two messages. Merging them would
    // put words in somebody's mouth.
    const st = { pending: ['first thing', 'second thing'] };
    const rows = pending.draw(st, 60, pending.rows(st)).map(strip);
    const a = rows.findIndex((r) => /first thing/.test(r));
    const b = rows.findIndex((r) => /second thing/.test(r));
    assert.ok(a > 0 && b > a, `order was not preserved: ${JSON.stringify(rows)}`);
    assert.strictEqual(pending.itemsOf(st).length, 2, 'two items, not one joined one');
  });

  await test('PENDING: every waiting line carries its own marker', () => {
    // Three queued sentences under one marker read as one three-line sentence,
    // and the difference between one steer and three is the difference between
    // what you meant and what the model gets.
    const st = { pending: ['a', 'b', 'c'] };
    const rows = pending.draw(st, 40, pending.rows(st)).map(strip);
    const marked = rows.filter((r) => r.includes('▸')).length;
    assert.strictEqual(marked, 3, `each line needs its own marker: ${JSON.stringify(rows)}`);
  });

  await test('PENDING: a long queue is summarised, never silently truncated', () => {
    const st = { pending: ['one', 'two', 'three', 'four', 'five'] };
    const rows = pending.draw(st, 40, pending.rows(st)).map(strip);
    assert.ok(rows.some((r) => /2 more waiting/.test(r)),
      `the hidden ones must be counted: ${JSON.stringify(rows)}`);
  });

  await test('PENDING: on a cramped terminal it shrinks rather than overflowing', () => {
    const st = { pending: ['one', 'two', 'three', 'four'] };
    for (const room of [2, 3, 4, 5]) {
      const n = pending.rows(st, room);
      assert.ok(n <= room, `asked for ${n} rows with ${room} available`);
      assert.strictEqual(pending.draw(st, 40, n).length, n, 'and it draws exactly what it asked for');
    }
  });

  await test('PENDING: the region reads the SAME queue the turn drains', () => {
    // One source of truth. A region fed from its own copy would keep showing a
    // steer the model had already been given, or lose one it had not.
    const fs = require('fs');
    // THE PROJECTION MOVED to ui/projection.js when ui/index.js reached the
    // god-object guard. The property being asserted is unchanged and is the
    // whole point: the region must be fed from the SAME array the turn drains,
    // never from a copy of it.
    const ui = fs.readFileSync(require.resolve('../../src/ui/projection.js'), 'utf8');
    assert.ok(/pending:\s*\(ui\.app\.steerQueue/.test(ui),
      'the projection must expose the real steerQueue, not a second list');
    const repl = fs.readFileSync(require.resolve('../../src/repl.js'), 'utf8');
    assert.ok(/app\.queueSteer\(ev\.text\)/.test(repl),
      'typed text must go into that same queue');
  });

  await test('PENDING: the steer SURVIVES the turn it was delivered into', () => {
    // FOUND BY DRIVING THE REAL CLI. "also check the backend" was typed while a
    // command ran, showed in the PENDING region, was delivered to the model and
    // acted on — and vanished from the transcript the moment the turn ended.
    // Only a COUNT was recorded, so the finished conversation showed no sign
    // that anything had been said.
    //
    // Of everything a turn keeps, this is the least recoverable: a tool result
    // can be produced again by running the tool; a sentence somebody typed an
    // hour ago cannot be produced again by anything.
    const fs = require('fs');
    const turn = fs.readFileSync(require.resolve('../../src/turn.js'), 'utf8');
    assert.ok(/record\.steerTexts = record\.steerTexts \|\| \[\]\)\.push\(\{ step, text \}\)/.test(turn),
      'the turn must record the steer TEXT and the step it landed on, not just a count');
    // ---- ASSERTED ON THE DATA, NOT ON WHERE THE CODE LIVES ----------------
    //
    // This used to grep turn.js for the projection line, and it broke the
    // moment that projection moved to turnclose.js — a split forced by the
    // god-object guard, with the behaviour completely unchanged. A test that
    // fails when correct code is RELOCATED is testing the file layout. Worse,
    // it would have passed if the line had stayed put while quietly recording
    // the wrong thing. So it now runs the projection and reads what came out.
    const turnclose = require('../../src/turnclose');
    const session = { usage: { inputTokens: 0, outputTokens: 0, requests: 0 }, turns: [] };
    const record = {
      turnId: 't1', startedAt: new Date().toISOString(),
      userInput: 'audit the parser', text: 'Done.',
      toolCalls: 1, toolNames: ['read_file'], actions: [], narration: [],
      steerTexts: [{ step: 2, text: 'also check the backend' }],
      errors: [], mutations: [], stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 2, requests: 1 },
    };
    turnclose.remember(session, record);
    const kept = session.turns[0];
    assert.deepStrictEqual(kept.steerTexts, [{ step: 2, text: 'also check the backend' }],
      'the persisted projection must carry the steer, or it dies with the record');
    assert.strictEqual(kept.userInput, 'audit the parser', 'alongside what was originally asked');

    // AND THE REPLAY MUST DRAW IT, in order, as the USER speaking. The replay
    // moved to ui/conversation.js when ui/views.js reached the god-object
    // guard; the property is unchanged.
    const conv = fs.readFileSync(require.resolve('../../src/ui/conversation.js'), 'utf8');
    assert.ok(/steerTexts/.test(conv), 'the conversation replay must read it');
    assert.ok(/for \(const s of steers\.filter\(\(x\) => x\.step === st\)\) pushUser/.test(conv),
      'and place it at the step it was delivered to, as a USER line');
  });

  await test('PENDING: a multi-line message keeps its LINES in Context', () => {
    // Reported from a live screen: "the input that I send to context is not
    // properly lined up / new line". `pushUser` collapsed every run of
    // whitespace, so a message typed across several lines with Ctrl+J — or a
    // pasted stack trace, or a numbered list — arrived as one unbroken run.
    //
    // The MODEL's prose kept its lines all along, and the person's did not, so
    // the two halves of the conversation were laid out by different rules.
    const feed = require('../../src/ui/feed');
    const out = [];
    feed.pushUser(out, 'check the parser\nthen the backend\n\nand report');
    const lines = out.map((r) => r.text);
    assert.deepStrictEqual(lines, ['check the parser', 'then the backend', '', 'and report']);
    for (const r of out) assert.strictEqual(r.kind, 'user', 'every row is still the user speaking');

    // A single-line message is unchanged — this must not add rows to ordinary
    // input.
    const one = [];
    feed.pushUser(one, 'just one line');
    assert.deepStrictEqual(one.map((r) => r.text), ['just one line']);
  });

  await test('STEER MODE: the first Enter WAITS for the work in flight', () => {
    // Most corrections are "and also…", not "stop what you are doing", and
    // interrupting a healthy tool call to add a sentence costs the step it was
    // in the middle of.
    const app = fakeApp();
    app.queueSteer('also check the backend');
    assert.deepStrictEqual(app.steerQueue.map((s) => s.mode), ['WAIT']);
    assert.deepStrictEqual(app.waitingSteers(), ['also check the backend']);
  });

  await test('STEER MODE: a second Enter promotes everything waiting to NOW', () => {
    const app = fakeApp();
    app.queueSteer('first');
    app.queueSteer('second');
    assert.strictEqual(app.promoteSteers(), 2, 'both were waiting');
    assert.deepStrictEqual(app.steerQueue.map((s) => s.mode), ['NOW', 'NOW']);
    assert.deepStrictEqual(app.waitingSteers(), [], 'nothing is waiting any more');
    // Promoting again finds nothing, so the UI can stay quiet about it.
    assert.strictEqual(app.promoteSteers(), 0);
  });

  await test('STEER MODE: a PROMOTED steer is never destroyed by the end of the turn', () => {
    // ---- THE DEFECT, AND IT PUNISHED THE MORE URGENT GESTURE ------------
    //
    // At the end of a turn, app.js delivered `waitingSteers()` — which is
    // `mode !== 'NOW'` — and then cleared the WHOLE queue:
    //
    //     const waiting = this.waitingSteers();
    //     if (waiting.length && !this.wantExit) {
    //       this.steerQueue.length = 0;
    //
    // A NOW steer is handed to the running turn at a STEP BOUNDARY. If it was
    // promoted after the turn's last boundary, no boundary ever came — and this
    // line deleted it without delivering it. Pressing Enter a second time, which
    // is how a person says "this is urgent", was the way to lose the sentence.
    //
    // Worse when nothing else was queued: with only NOW steers pending,
    // `waiting.length` is 0, the branch never runs, and they sit in the queue
    // until some LATER, unrelated turn drains them at its first step boundary —
    // work performed outside the plan that asked for it.
    const app = fakeApp();
    app.queueSteer('urgent thing', 'NOW');
    app.queueSteer('also this');

    const drained = app.drainSteers();
    assert.deepStrictEqual(drained, ['urgent thing', 'also this'],
      'every queued steer must be delivered at the end of the turn, whatever its mode');
    assert.deepStrictEqual(app.steerQueue, [], 'and the queue is emptied exactly once');
  });

  await test('STEER MODE: a queue holding ONLY promoted steers still delivers them', () => {
    // The second half of the same defect: `waiting.length` was the gate, so a
    // queue of nothing but NOW steers delivered nothing at all.
    const app = fakeApp();
    app.queueSteer('only urgent', 'NOW');
    assert.deepStrictEqual(app.waitingSteers(), [], 'nothing is WAITING, by definition');
    assert.deepStrictEqual(app.drainSteers(), ['only urgent'],
      'but it is still what the user typed and still has to be delivered');
  });

  await test('STEER MODE: only the PROMOTED ones are handed to a running turn', () => {
    // The safety property in the new shape: a WAIT steer cannot land mid-turn
    // however long the turn runs.
    const app = fakeApp();
    app.queueSteer('urgent', 'NOW');
    app.queueSteer('can wait');
    const drain = () => {
      const take = [];
      for (let i = app.steerQueue.length - 1; i >= 0; i--) {
        if (app.steerQueue[i].mode === 'NOW') take.unshift(app.steerQueue.splice(i, 1)[0].text);
      }
      return take;
    };
    assert.deepStrictEqual(drain(), ['urgent']);
    assert.deepStrictEqual(app.steerQueue.map((s) => s.text), ['can wait'],
      'the waiting one stays for after the turn');
  });

  await test('STEER MODE: Escape gives the text BACK for editing, and un-tells the task', () => {
    // Escape means "I have not sent that yet". Discarding it would lose a
    // correction somebody was halfway through wording — and leaving it on the
    // task would carry an instruction the model was never given.
    const app = fakeApp();
    app.queueSteer('use the exsting logger');          // typo, hence the edit
    assert.strictEqual(app.session.task.steers.length, 1, 'the task was told');
    const back = app.takeBackSteer();
    assert.strictEqual(back, 'use the exsting logger', 'the text comes back verbatim');
    assert.strictEqual(app.steerQueue.length, 0, 'and leaves the queue');
    assert.strictEqual(app.session.task.steers.length, 0, 'and the task is un-told');
    assert.strictEqual(app.takeBackSteer(), null, 'with nothing pending it does nothing');
  });

  await test('PENDING: the region SHOWS which mode each line is in', () => {
    // A promoted steer is about to land; a waiting one is not. One heading for
    // both would make the second Enter invisible, which is the whole feature.
    const pending = require('../../src/ui/pending');
    const waiting = pending.draw({ pending: [{ text: 'later', mode: 'WAIT' }] }, 60, 3).join('\n');
    assert.match(waiting, /PENDING USER INPUT/);
    assert.match(waiting, /later/);

    const now = pending.draw({ pending: [{ text: 'right away', mode: 'NOW' }] }, 60, 3).join('\n');
    assert.match(now, /STEERING NOW/, 'a promoted steer says so');
    assert.match(now, /right away/);
  });

  await test('PENDING: a bare string still renders — never "[object Object]"', () => {
    // The queue used to hold strings and now holds objects. A resumed session,
    // or any caller that has not moved, must not paint `[object Object]` into
    // the region — the kind of break that reaches a screenshot before a test.
    const pending = require('../../src/ui/pending');
    const drawn = pending.draw({ pending: ['an old-shaped steer'] }, 60, 3).join('\n');
    assert.match(drawn, /an old-shaped steer/);
    assert.ok(!/object Object/.test(drawn));
  });

  await test('PENDING: a steer is never injected mid-tool-call', () => {
    // The safety half of. The queue is drained by the turn between steps,
    // immediately before it builds the next request — not by whatever happens
    // to be running when the key was pressed.
    // THE DRAIN NOW FILTERS BY MODE — it takes only the entries promoted to
    // NOW, leaving the rest for after the work in flight. The safety property
    // is unchanged and is the one asserted: the TURN pulls from the queue at a
    // boundary it chooses, and the reader never pushes into a request.
    const fs = require('fs');
    const app = fs.readFileSync(require.resolve('../../src/app.js'), 'utf8');
    assert.ok(/steer: \(\) => \{[\s\S]*steerQueue\.splice/.test(app),
      'the turn takes from the queue; the reader never pushes into a request');
    assert.ok(/mode === 'NOW'/.test(app),
      'and it takes only what was promoted, so a WAIT steer cannot land mid-turn');
  });
};
