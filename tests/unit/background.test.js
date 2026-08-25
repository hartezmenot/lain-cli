'use strict';

/**
 * THE PROMPT DOES NOT WAIT FOR THE WORK.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS HAS TO PROVE, and it is a negative: that nothing is awaited.
 *
 * A test that starts a job and then reads a status field proves only that a
 * field was set. The claim is stronger and more awkward — that the caller GOT
 * CONTROL BACK while the work was still going — so every test here starts work
 * that takes a known, non-trivial length of time and then measures that control
 * came back long before it ended.
 *
 * `startPrimary` returning IS the moment the prompt comes back: src/repl.js
 * does nothing between that return and `input.prompt()`.
 *
 * ------------------------------------------------------------------------
 * THE REAL TURN, AGAINST THE MOCK PROVIDER. Nothing is stubbed. The real App,
 * the real `submit`, the real `runTurn`, the real event stream, the real job
 * registry. `LAIN_PROVIDER=mock` scripts what the model says — the mechanism
 * the smoke tier already drives the binary with — and `delayMs` scripts that
 * saying it took a while.
 *
 * AN EARLIER VERSION OF THIS FILE SWAPPED `runTurn` OUT INSTEAD, and it could
 * not work: src/app.js destructures `runTurn` at import, so the binding a test
 * replaces afterwards is not the one `submit` calls. The real turn then went
 * looking for a provider that was not there, nothing resolved, and Node exited
 * with every promise pending and NO OUTPUT AT ALL — the suite reporting success
 * by saying nothing. A stub that misses is worse than no stub.
 *
 * ------------------------------------------------------------------------
 * THE TIMING BOUNDS ARE DELIBERATELY LOPSIDED. The work takes `SLOW` ms; the
 * assertion is that control returned within a small fraction of that. A machine
 * under load makes the gap SMALLER, never larger, so the test fails towards
 * "we could not prove it" rather than towards a false pass.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const { App } = require('../../src/app');
const { STATE } = require('../../src/jobs');
const { AgentJob } = require('../../src/agentjob');
const mock = require('../../src/mockprovider');

/** How long a scripted turn is held open. Long enough to measure against. */
const SLOW = 900;
/** The prompt must come back in far less than that. */
const PROMPT_BUDGET = 250;

/** Point the mock provider at a script, for one test. */
function script(steps) {
  const dir = tmpdir('bgjob-');
  const file = path.join(dir, 'script.json');
  fs.writeFileSync(file, JSON.stringify(steps), 'utf8');
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = file;
  mock._reset();
  return dir;
}

function unscript() {
  delete process.env.LAIN_PROVIDER;
  delete process.env.LAIN_MOCK_SCRIPT;
  mock._reset();
}

/** An App with no terminal. Everything that decides behaviour is real. */
function app(cwd) {
  const a = new App({ interactive: false, cwd });
  a.render.write = () => {};
  a.render.notice = () => {};
  a.render.turnSummary = () => {};
  a.render.nl = () => {};
  a.session.save = () => {};
  return a;
}

const settle = () => new Promise((r) => setImmediate(r));
const after = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` with a scripted provider, and always put the environment back. */
async function scripted(steps, fn) {
  const dir = script(steps);
  try { return await fn(dir); } finally { unscript(); }
}

module.exports = async function () {
  // ------------------------------------------------------------- TEST 1 ---
  //
  // THE ONE THAT MATTERS. Everything else here is a property of the job model;
  // this is the behaviour the whole change exists for.

  await test('BG: the prompt comes back IMMEDIATELY while the turn is still running', async () => {
    await scripted([{ text: 'working on it', delayMs: SLOW }], async (dir) => {
      const a = app(dir);
      const t0 = Date.now();
      const job = a.startPrimary('fix the failing tests');
      const returned = Date.now() - t0;

      assert.ok(job, 'a job must come back');
      assert.strictEqual(job.state, STATE.RUNNING);
      assert.ok(returned < PROMPT_BUDGET,
        `the prompt took ${returned}ms to come back against ${SLOW}ms of work — it is still blocking`);

      // AND THE CALLER GENUINELY KEEPS GOING. Not just that the call returned:
      // that other work completes, in order, while the turn is unfinished.
      const done = [];
      await after(50);
      done.push('typed something else');
      assert.strictEqual(job.done, false, 'the work must still be running for this to mean anything');
      await after(50);
      done.push('and something after that');
      assert.deepStrictEqual(done, ['typed something else', 'and something after that']);
      assert.strictEqual(job.done, false);

      await job.wait();
      assert.strictEqual(job.state, STATE.SUCCEEDED);
      assert.ok(job.elapsedMs >= SLOW * 0.5, 'the turn really did take time');
    });
  });

  // ------------------------------------------------------------- TEST 3 ---

  await test('BG: a job goes RUNNING → COMPLETED and its result stays readable', async () => {
    await scripted([{ text: 'all done here', delayMs: 20 }], async (dir) => {
      const a = app(dir);
      const job = a.startPrimary('do the thing');
      assert.strictEqual(job.state, STATE.RUNNING);
      await job.wait();
      assert.strictEqual(job.state, STATE.SUCCEEDED);
      assert.ok(job.result, 'the record must survive so /jobs <n> can show it');
      assert.match(String(job.result.text), /all done here/);
      assert.ok(job.endedAt >= job.startedAt);
      assert.strictEqual(a.jobs.get(job.id), job, 'and it is still findable afterwards');
    });
  });

  // ------------------------------------------------------------- TEST 2 ---

  await test('BG: WAITING is a phase of RUNNING, and the caller is free throughout', async () => {
    // The plumbing — that a turn's status reaches the job — is exercised by the
    // real run below. The DERIVATION is pure arithmetic over that phase, and is
    // asserted directly rather than by contriving a rate limit.
    const j = new AgentJob({ id: '1', request: 'x' });
    j.state = STATE.RUNNING;
    j.phase = 'RUNNING_TOOL';
    assert.strictEqual(j.waiting, false);
    assert.strictEqual(j.label, STATE.RUNNING);
    j.phase = 'WAITING';
    assert.strictEqual(j.waiting, true, 'blocked on something outside itself');
    assert.strictEqual(j.label, 'WAITING');
    assert.strictEqual(j.state, STATE.RUNNING, 'and it is STILL running — one vocabulary, six states');
    j.phase = 'RATE_LIMITED';
    assert.strictEqual(j.waiting, true);
    j._finish(STATE.SUCCEEDED);
    assert.strictEqual(j.waiting, false, 'a finished job is not waiting for anything');

    // And the real turn does feed the phase through, on the real path.
    await scripted([{ text: 'thinking', delayMs: SLOW }], async (dir) => {
      const a = app(dir);
      const job = a.startPrimary('run the suite');
      await after(120);
      assert.ok(job.phase, `the turn never reported a phase (got ${job.phase})`);
      assert.strictEqual(job.done, false);
      job.cancel('done looking');
      await job.wait();
    });
  });

  // ------------------------------------------------------------- TEST 5 ---

  await test('BG: cancelling ends CANCELLED — not failed, and leaves no rejection', async () => {
    const rejections = [];
    const onRej = (r) => rejections.push(r);
    process.on('unhandledRejection', onRej);
    try {
      await scripted([{ text: 'long one', delayMs: 5000 }], async (dir) => {
        const a = app(dir);
        const job = a.startPrimary('something long');
        await after(60);
        const t0 = Date.now();
        assert.strictEqual(job.cancel('you cancelled it'), true);
        assert.strictEqual(job.state, STATE.CANCELLED);
        assert.strictEqual(job.abort.signal.aborted, true,
          'the signal the turn is reading must be the one that was aborted');
        await job.wait();
        // COOPERATIVE MEANS PROMPT. The scripted delay was five seconds; the
        // turn unwinds at its next safe point rather than sitting it out.
        assert.ok(Date.now() - t0 < 2000, 'cancellation did not reach the running turn');
        await settle(); await settle();
        assert.strictEqual(job.state, STATE.CANCELLED,
          'a cancelled job must not later be re-marked as succeeded');
      });
      await settle();
      assert.deepStrictEqual(rejections, [], 'cancellation left an unhandled rejection');
    } finally {
      process.removeListener('unhandledRejection', onRej);
    }
  });

  // ------------------------------------------------------------- TEST 4 ---

  await test('BG: a failing job leaves the app, the registry and the next job alone', async () => {
    const rejections = [];
    const onRej = (r) => rejections.push(r);
    process.on('unhandledRejection', onRej);
    try {
      await scripted([{ error: { status: 500, message: 'upstream is down' } }, { text: 'fine', delayMs: 20 }],
        async (dir) => {
          const a = app(dir);
          const bad = a.startPrimary('this one breaks');
          await bad.wait();
          assert.ok(bad.done, 'it must settle rather than hang');

          // THE APP IS STILL USABLE. This is the whole of "error isolation":
          // not that the failure was recorded, but that everything else works.
          const ok = a.startPrimary('this one is fine');
          assert.ok(ok, 'a finished-badly job must not hold the conversation');
          await ok.wait();
          assert.strictEqual(ok.state, STATE.SUCCEEDED);
          assert.strictEqual(a.jobs.all().length, 2);
        });
      await settle();
      assert.deepStrictEqual(rejections, [], 'a failing job left an unhandled rejection');
    } finally {
      process.removeListener('unhandledRejection', onRej);
    }
  });

  await test('BG: a throw from inside the turn is RECORDED on the job, never propagated', async () => {
    // The REPL used to catch this, because it awaited. It no longer does, so the
    // failure has to land on the job or it reaches the event loop as an
    // unhandled rejection and Node ends the session under a person who was
    // typing.
    //
    // ASSERTED AFTER `wait()`, because `submit` is `async`: even a throw raised
    // before its first await arrives as a rejection, so the job is marked on a
    // later tick and reading the state immediately would be reading it too soon.
    const rejections = [];
    const onRej = (r) => rejections.push(r);
    process.on('unhandledRejection', onRej);
    try {
      await scripted([{ text: 'never reached' }], async (dir) => {
        const a = app(dir);
        // ---- THE PROMPT BUILDER, WHEREVER IT LIVES -------------------------
        //
        // This used to stub `a.systemPrompt`, which is no longer what the job
        // runner calls: the prompt is now built in two halves by promptparts.js
        // so the stable half can stay out of the volatile one's way. The
        // INVARIANT under test is unchanged and is the whole point of the test —
        // a throw while building a prompt must land on the JOB, not on the event
        // loop, where it would end the session under somebody who was typing.
        const parts = require('../../src/promptparts');
        const real = parts.of;
        parts.of = () => { throw new Error('prompt could not be built'); };
        try {
          const job = a.startPrimary('anything');
          assert.ok(job, 'a job must still come back');
          await job.wait();
          assert.strictEqual(job.state, STATE.FAILED);
          assert.match(job.error, /prompt could not be built/);
        } finally {
          parts.of = real;
        }
        // And the app is still usable afterwards.
        assert.ok(a.startPrimary('next'), 'the conversation must not be stuck');
      });
      await settle();
      assert.deepStrictEqual(rejections, [], 'the throw escaped as an unhandled rejection');
    } finally {
      process.removeListener('unhandledRejection', onRej);
    }
  });

  // ------------------------------------------------------------- TEST 6 ---

  await test('BG: two jobs run at once and NEVER share a messages array', async () => {
    // The corruption the whole design exists to prevent. `runTurn` writes the
    // user message, every assistant turn CARRYING its tool_calls, and every
    // tool result matched by id. Two turns interleaving those pushes produce a
    // conversation the provider rejects — so the invariant is OWNERSHIP.
    await scripted([{ text: 'one', delayMs: SLOW }, { text: 'two', delayMs: SLOW }], async (dir) => {
      const a = app(dir);
      const one = a.startPrimary('fix the failing tests');
      const two = a.startBackground('inspect the README');
      assert.ok(two, 'the background job must start');
      assert.strictEqual(a.jobs.running().length, 2, 'both must be running at once');
      assert.strictEqual(one.primary, true);
      assert.strictEqual(two.primary, false);

      assert.strictEqual(one.session, a.session, 'the primary owns the conversation');
      assert.notStrictEqual(two.session, a.session, 'the background job must be forked');
      assert.notStrictEqual(two.session.messages, a.session.messages,
        'two jobs sharing one messages array is the corruption, not a style point');

      await Promise.all([one.wait(), two.wait()]);
      assert.strictEqual(one.state, STATE.SUCCEEDED);
      assert.strictEqual(two.state, STATE.SUCCEEDED);
      assert.strictEqual(
        a.session.messages.filter((m) => /inspect the README/.test(String(m.content || ''))).length, 0,
        "the background job's request reached the main conversation");
      assert.ok(two.session.messages.some((m) => /inspect the README/.test(String(m.content || ''))),
        'and it really did land in its own');
    });
  });

  await test('BG: only ONE job may own the conversation', async () => {
    await scripted([{ text: 'a', delayMs: SLOW }, { text: 'b', delayMs: 20 }], async (dir) => {
      const a = app(dir);
      const first = a.startPrimary('one');
      assert.ok(first);
      assert.strictEqual(a.startPrimary('two'), null,
        'a second owner of session.messages must be refused');
      await first.wait();
      const third = a.startPrimary('three');
      assert.ok(third, 'and a finished job must not hold the seat for ever');
      await third.wait();
    });
  });

  await test('BG: cancelAll stops everything the session started', async () => {
    await scripted([{ text: 'a', delayMs: 5000 }, { text: 'b', delayMs: 5000 }], async (dir) => {
      const a = app(dir);
      a.startPrimary('one');
      a.startBackground('two');
      assert.strictEqual(a.jobs.running().length, 2);
      assert.strictEqual(a.jobs.cancelAll('the session ended'), 2);
      assert.strictEqual(a.jobs.running().length, 0);
      for (const j of a.jobs.all()) assert.strictEqual(j.state, STATE.CANCELLED);
      await settle();
    });
  });

  // ---- A BACKGROUND JOB CAN ASK, WITHOUT TAKING THE SCREEN ---------------

  await test('BG: a background job that asks PARKS as NEEDS INPUT, and the foreground is untouched', async () => {
    await scripted([
      { text: 'asking', tool_calls: [{ name: 'ask_user', input: { question: 'Which provider should I use?', options: ['openrouter', 'anthropic'] } }] },
      { text: 'done, used it' },
    ], async (dir) => {
      const a = app(dir);
      const t0 = Date.now();
      const job = a.startBackground('inspect the README');
      assert.ok(Date.now() - t0 < PROMPT_BUDGET, 'asking must not block the caller either');

      await after(400);
      assert.strictEqual(job.state, STATE.RUNNING, 'parked is a phase of RUNNING, not a new state');
      assert.strictEqual(job.needsInput, true);
      assert.strictEqual(job.label, 'NEEDS INPUT');
      assert.strictEqual(job.waiting, true, 'and it reads as waiting, consistently');
      assert.match(job.question.question, /Which provider/);
      assert.deepStrictEqual(job.question.options, ['openrouter', 'anthropic']);

      // THE FOREGROUND IS NOT DISTURBED. No primary job was started, nothing
      // was written to the conversation, and no panel was opened — the whole
      // point of parking instead of asking.
      assert.strictEqual(a.jobs.primary(), null);
      assert.strictEqual(a.session.messages.length, 0);

      assert.strictEqual(job.reply('openrouter'), true);
      assert.strictEqual(job.needsInput, false, 'answering clears the block');
      await job.wait();
      assert.strictEqual(job.state, STATE.SUCCEEDED);
      // AND THE MODEL ACTUALLY GOT THE ANSWER, through the ordinary tool result.
      const results = job.session.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
      assert.ok(results.some((r) => /openrouter/.test(r)), `the answer never reached the model: ${JSON.stringify(results)}`);
    });
  });

  await test('BG: cancelling a PARKED job releases it rather than leaving a promise nobody settles', async () => {
    const rejections = [];
    const onRej = (r) => rejections.push(r);
    process.on('unhandledRejection', onRej);
    try {
      await scripted([
        { text: 'asking', tool_calls: [{ name: 'ask_user', input: { question: 'go on?', options: ['yes'] } }] },
        { text: 'never reached' },
      ], async (dir) => {
        const a = app(dir);
        const job = a.startBackground('something that asks');
        await after(400);
        assert.strictEqual(job.needsInput, true, 'it must actually be parked for this to mean anything');
        job.cancel('you cancelled it');
        await job.wait();
        assert.strictEqual(job.state, STATE.CANCELLED);
        assert.strictEqual(job.question, null, 'the parked question must be released');
      });
      await settle();
      assert.deepStrictEqual(rejections, [], 'cancelling a parked job leaked a rejection');
    } finally {
      process.removeListener('unhandledRejection', onRej);
    }
  });

  await test('BG: the region shows NEEDS INPUT and the question, within the rows it reserved', () => {
    const jobs = require('../../src/ui/jobsview');
    const T = require('../../src/ui/text');
    const now = Date.now();
    const state = {
      jobs: [
        { id: '2', primary: false, state: 'RUNNING', request: 'inspect the README', activity: 'Which provider?', elapsedMs: 4000, needsInput: true, question: 'Which provider should I use?' },
        { id: '3', primary: false, state: 'RUNNING', request: 'lint', activity: 'reading', elapsedMs: 2000 },
      ],
    };
    for (const width of [50, 90]) {
      const want = jobs.rows(state, 20, now);
      const drawn = jobs.draw(state, width, want, now);
      assert.strictEqual(drawn.length, want, 'the region must draw exactly the rows it reserved');
      for (const r of drawn) assert.ok(T.width(T.strip(String(r))) <= width, 'no row may overflow');
      const plain = drawn.map((r) => T.strip(String(r))).join(' ');
      assert.ok(/NEEDS INPUT/.test(plain), 'the state must be named');
      assert.ok(/Which provider should I use\?/.test(plain), 'and the question must be readable at a glance');
    }
  });

  // ------------------------------------------------------------- TEST 7 ---

  await test('BG: the background region is bounded, one row per job, and never wraps', async () => {
    // UI integrity, asserted where it is decidable: the region returns exactly
    // the height it was given, every row fits the width, and no row carries a
    // newline. A region that returns more rows than it asked for, or a row
    // wider than the terminal, is what corrupts the lines around it.
    const jobs = require('../../src/ui/jobsview');
    const T = require('../../src/ui/text');
    const now = Date.now();
    const state = {
      jobs: [
        { id: '1', primary: true, state: 'RUNNING', request: 'the conversation', activity: 'x', elapsedMs: 1000 },
        { id: '2', primary: false, state: 'RUNNING', request: 'inspect the README '.repeat(6), activity: 'read_file '.repeat(9), elapsedMs: 2000 },
        { id: '3', primary: false, state: 'RUNNING', request: 'lint', activity: 'waiting', elapsedMs: 3000, waiting: true },
        { id: '4', primary: false, state: 'FAILED', request: 'count TODOs', activity: 'nope', elapsedMs: 400, endedAt: now - 500 },
        { id: '5', primary: false, state: 'SUCCEEDED', request: 'tidy', activity: 'done', elapsedMs: 400, endedAt: now - 500 },
        { id: '6', primary: false, state: 'SUCCEEDED', request: 'old news', activity: 'done', elapsedMs: 400, endedAt: now - jobs.KEEP_DONE_MS - 1 },
      ],
    };
    for (const width of [40, 80, 120]) {
      const want = jobs.rows(state, 20, now);
      const drawn = jobs.draw(state, width, want, now);
      assert.strictEqual(drawn.length, want, `width ${width}: the region drew ${drawn.length} of ${want} rows`);
      for (const r of drawn) {
        assert.ok(!String(r).includes('\n'), 'a region row must never contain a newline');
        assert.ok(T.width(T.strip(String(r))) <= width, `a row overflowed ${width} columns: ${JSON.stringify(T.strip(String(r)))}`);
      }
      const plain = drawn.map((r) => T.strip(String(r))).join(' ');
      assert.ok(!/the conversation/.test(plain), 'the primary job is the feed, not a status row');
      assert.ok(!/old news/.test(plain), 'a long-finished job must stop taking a row');
      assert.ok(/#2/.test(plain) && /#3/.test(plain), 'running jobs must be listed');
    }
    // And it costs nothing when nothing is running.
    assert.strictEqual(jobs.rows({ jobs: [] }, 20, now), 0);
    assert.deepStrictEqual(jobs.draw({ jobs: [] }, 80, 0, now), []);
  });
};
