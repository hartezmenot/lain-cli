'use strict';

/**
 * THE LIVENESS STATE MACHINE.
 *
 * The failure this exists to prevent is not a crash — it is a screen that
 * cannot tell a working LAIN from a dead one. So these assert the two halves
 * that make the indicator trustworthy:
 *
 *   1. It SAYS SOMETHING whenever work is genuinely in flight.
 *   2. It says NOTHING when it is not. An indicator that animates while nothing
 *      is happening is worse than none: it teaches you to ignore it.
 */

const assert = require('assert');
const { test } = require('../helpers');

/** A newline, as a value. */
const NL = String.fromCharCode(10);

const views = require('../../src/ui/views');
const { PHASE } = require('../../src/turn');
const S = views.STATE;

// THE LIVE ROW LIVES IN THE STATUS STRIP, above the INPUT. It used to be built
// by views.liveLine and drawn at the TOP of the workspace; there is now one
// owner, and these are the same properties asserted against it.
const status = require('../../src/ui/status');
const at = (phase, since = 0, now = 1000, extra = {}) =>
  status.statusStrip({ phase, phaseSince: since, ...extra }, 80, 1, now).join('\n');

module.exports = async function () {
  // ------------------------------------------------------------- header ----

  await test('LIVE: the header distinguishes waiting-on-model from running-a-tool', () => {
    // Both are "busy"; they are different problems and must read differently.
    assert.strictEqual(views.statusOf({ phase: { phase: PHASE.WAITING_MODEL } }), S.THINKING);
    assert.strictEqual(views.statusOf({ phase: { phase: PHASE.RUNNING_TOOL } }), S.RUNNING);
    assert.strictEqual(views.statusOf({ phase: { phase: PHASE.RECEIVING } }), S.WORKING);
    assert.strictEqual(views.statusOf({ phase: { phase: PHASE.RETRYING } }), S.WAITING);
  });

  await test('LIVE: a live phase OUTRANKS the coarse busy flag', () => {
    // `busy` is true for the whole turn and says only "something is happening".
    assert.strictEqual(views.statusOf({ busy: true, phase: { phase: PHASE.WAITING_MODEL } }), S.THINKING);
    assert.strictEqual(views.statusOf({ busy: true }), S.WORKING);
  });

  await test('LIVE: a question being asked outranks any phase', () => {
    assert.strictEqual(
      views.statusOf({ awaitingUser: true, phase: { phase: PHASE.RUNNING_TOOL } }),
      S.NEEDS_USER
    );
  });

  await test('LIVE: INTERRUPTING outranks everything, and INTERRUPTED rests after it', () => {
    assert.strictEqual(views.statusOf({ interrupting: true, phase: { phase: PHASE.WAITING_MODEL } }), S.INTERRUPTING);
    assert.strictEqual(views.statusOf({ interrupted: true }), S.INTERRUPTED);
    // A new turn makes the old cancellation stop being the news.
    assert.strictEqual(views.statusOf({ interrupted: true, phase: { phase: PHASE.WAITING_MODEL } }), S.THINKING);
  });

  await test('LIVE: ENDED is not a state — the turn is over and the header rests', () => {
    assert.strictEqual(views.statusOf({ phase: { phase: PHASE.ENDED } }), S.READY);
  });

  await test('LIVE: a failed turn rests on ERROR, never silently on READY', () => {
    // The header said READY the instant a provider died. The failure was in the
    // activity feed, but the one word summarising the session contradicted it —
    // and returning quietly to READY after a failure reads as success.
    assert.strictEqual(views.statusOf({ failed: true }), S.ERROR);
    // A new turn makes the old failure stop being the news.
    assert.strictEqual(views.statusOf({ failed: true, phase: { phase: PHASE.WAITING_MODEL } }), S.THINKING);
    assert.strictEqual(views.statusOf({ failed: true, busy: true }), S.WORKING);
  });

  await test('LIVE: being cancelled and having failed are different endings', () => {
    assert.strictEqual(views.statusOf({ interrupted: true }), S.INTERRUPTED);
    assert.strictEqual(views.statusOf({ failed: true }), S.ERROR);
  });

  // --------------------------------------------------------- the live row --

  await test('LIVE: waiting on the model says so, in words', () => {
    const line = at({ phase: PHASE.WAITING_MODEL }, 0, 1000);
    assert.match(line, /Thinking/);
    assert.match(line, /waiting for the model/, 'the state word alone is jargon; say what it means');
  });

  await test('LIVE: a running tool names what it is running', () => {
    const line = at({ phase: PHASE.RUNNING_TOOL, tool: 'read_file', target: 'src/auth.js' }, 0, 1000);
    // SENTENCE CASE: a transient state is SPOKEN, not shouted (ui/status.js
    // `sentence`). The distinction this test is about - which KIND of work is in
    // flight - is unchanged.
    assert.match(line, /Reading/, 'reading a file and running a command are different states');
    assert.match(line, /src\/auth\.js/, 'and the subject must be named');
    const shell = at({ phase: PHASE.RUNNING_TOOL, tool: 'run_bash', target: 'npm test' }, 0, 1000);
    assert.match(shell, /Running\s+npm test/);
  });

  await test('LIVE: a long wait shows HOW LONG — the difference between slow and hung', () => {
    // THE NUMBER IS THE TASK'S CLOCK NOW, not the age of this phase.
    //
    // It used to be `liveState`'s `age` — `45s`, restarted at every phase
    // change, so a turn that read, thought and wrote showed three small numbers
    // none of which was how long the person had been waiting. The property this
    // test exists for is unchanged and is what is asserted: a long wait must
    // carry a figure, or a working LAIN reads as a dead one. See
    // ui/workclock.js for why that figure is `HH:MM:SS` and why it does not
    // count time a rate limit spent refusing us.
    const wc = require('../../src/ui/workclock');
    const clockAt = (ms) => { const c = wc.create(); wc.start(c, 0); return wc.reading(c, ms); };
    const short = at({ phase: PHASE.WAITING_MODEL }, 1000, 1200, { clock: clockAt(1200) });
    const long = at({ phase: PHASE.WAITING_MODEL }, 1000, 46000, { clock: clockAt(45000) });
    assert.match(long, /00:00:45/, 'a 45-second wait must say so, or it reads as a hang');
    assert.ok(!/\d+s\b/.test(short), `the per-phase age is gone: ${short}`);
    // AND IT IS ONE CLOCK. The same turn a minute later reads a minute later —
    // it does not start again because the phase did.
    const next = at({ phase: PHASE.RUNNING_TOOL, tool: 'read_file' }, 46000, 46000, { clock: clockAt(45000) });
    assert.match(next, /00:00:45/, 'a new phase must not restart the task clock');
  });

  await test('LIVE: NOTHING is claimed when nothing is running', () => {
    // The strip always occupies its row — it is a region, not a popup — but it
    // must never imply work. No spinner, no verb: it rests on READY.
    const idle = at(null, 0, 1000);
    assert.match(idle, /READY/);
    assert.ok(!/[◐◓◑◒]/.test(idle), `a resting strip must not spin: ${idle}`);
    assert.ok(!/THINKING|RUNNING|RECEIVING/.test(idle), `nothing is running: ${idle}`);
    assert.match(at({ phase: PHASE.ENDED }, 0, 1000), /READY/, 'ENDED is not a state');
  });

  await test('LIVE: the spinner is a function of the CLOCK, so it cannot fake motion', () => {
    // Same instant, same frame — always. Motion is only ever real elapsed time,
    // never a counter that ticks whether or not anything is happening.
    const a = at({ phase: PHASE.WAITING_MODEL }, 0, 5000);
    const b = at({ phase: PHASE.WAITING_MODEL }, 0, 5000);
    assert.strictEqual(a, b);
    const later = at({ phase: PHASE.WAITING_MODEL }, 0, 5000 + 250);
    assert.notStrictEqual(a, later, 'and it does advance as real time passes');
  });

  await test('LIVE: a rate-limit wait says when it ends, counts down, and offers a way out', () => {
    const phase = { phase: PHASE.RETRYING, attempt: 1, of: 2, waitMs: 20000, rateLimited: true, resumeAt: 21000 };
    const wide = status.statusStrip({ phase, phaseSince: 1000 }, 100, 1, 6000).join('');
    assert.match(wide, /Rate limited/, 'name the actual problem, not just "retrying"');
    assert.match(wide, /00:15 remaining/, 'a countdown from the real wait it was given');
    assert.match(wide, /attempt 1\/2/);
    assert.match(wide, /retrying at \d\d:\d\d:\d\d/, 'an absolute time answers "can I go and do something else"');
    assert.match(wide, /Esc to cancel/, 'a wait with no way out is a hang with a spinner');
    // NARROW: the sentence is shortened and then thinned by IMPORTANCE. Clipping
    // it from the right would throw away the way out first, which is the one
    // part the user cannot do without.
    const narrow = status.statusStrip({ phase, phaseSince: 1000 }, 40, 1, 6000).join('');
    assert.match(narrow, /Rate limited/);
    assert.match(narrow, /00:15/, 'the countdown survives');
    assert.match(narrow, /Esc/, 'and so does the way out');
  });

  await test('LIVE: a cancelled retry rests on RETRY CANCELLED, not on INTERRUPTED', () => {
    // Escape during a wait and Ctrl+C during work are two different things the
    // user did, and the resting state must not blur them together.
    const cancelled = status.statusStrip({ retryCancelled: true, interrupted: true }, 80, 1, 1000).join('\n');
    assert.match(cancelled, /Retry cancelled/);
    assert.ok(!/INTERRUPTED/.test(cancelled), `the more specific ending wins: ${cancelled}`);
  });

  await test('LIVE: the strip trails what the turn just did, and never invents it', () => {
    const lines = status.statusStrip({
      phase: { phase: PHASE.RUNNING_TOOL, tool: 'run_bash', target: 'npm test' },
      phaseSince: 0,
      recent: [
        { name: 'read_file', target: 'src/a.js', ok: true },
        { name: 'grep', target: '/TODO/', ok: false },
      ],
    }, 80, 3, 1000);
    assert.strictEqual(lines.length, 3, 'the strip fills exactly the rows it was given');
    const text = lines.join('\n');
    assert.match(text, /src\/a\.js/);
    assert.match(text, /✗/, 'a failed call is not quietly reported as a tick');
    assert.match(text, /Running\s+npm test/, 'and the live row is last, closest to the caret');
    // With no history there is nothing to trail — and nothing is made up.
    const bare = status.statusStrip({ recent: [] }, 80, 3, 1000);
    assert.strictEqual(bare.length, 3);
    assert.match(bare.join('\n'), /READY/);
  });

  await test('LIVE: every strip row fits the width it was given, coloured or not', () => {
    const T = require('../../src/ui/text');
    const s = {
      phase: { phase: PHASE.RUNNING_TOOL, tool: 'run_bash', target: 'a'.repeat(300) },
      recent: [{ name: 'read_file', target: 'b'.repeat(300), ok: true }],
    };
    for (const w of [40, 60, 96]) {
      for (const l of status.statusStrip(s, w, 2, 1000)) {
        assert.strictEqual(T.width(l), w, `a strip row was ${T.width(l)} wide at width ${w}`);
      }
    }
  });

  // ------------------------------------------------------------- banner ----

  await test('LIVE: PROGRESS and STATUS are two different questions, in two places', () => {
    const plan = { steps: [
      { n: 1, text: 'a', status: 'done' },
      { n: 2, text: 'b', status: 'active' },
      { n: 3, text: 'c', status: 'todo' },
    ] };
    // WHERE THE WORK IS and HOW MUCH IS FINISHED is the PLAN's measurement,
    // drawn by `/plan`. It used to be pinned above the feed by the task banner;
    // the banner is gone with the panes and the measurement is not.
    const p = views.progressOf(plan);
    assert.strictEqual(p.current, 2, 'where the work is');
    assert.strictEqual(p.percent, 33, 'how much is FINISHED — not the step number');
    // WHAT IS HAPPENING THIS SECOND belongs to the live row above the caret,
    // and to nothing else. Two owners for one sentence read as two things
    // happening at once, which is why the banner never carried it either.
    const row = status.statusStrip({ phase: { phase: PHASE.WAITING_MODEL } }, 60, 1, 1000).join('');
    assert.match(row, /Thinking/, 'in the one place that owns it');
    const planned = require('../../src/ui/text').strip(views.planView({ plan, width: 60 }).join(NL));
    assert.ok(!/THINKING|◐/.test(planned), `the plan view must not carry the live row: ${planned}`);
  });

  await test('LIVE: on a small terminal the STATUS row is the last thing sacrificed', () => {
    // The geometry gives the strip a row at every size LAIN supports, before it
    // gives one to the header frame or to the trail of completed calls.
    const { Screen } = require('../../src/ui/layout');
    for (const rows of [9, 15, 24, 40]) {
      const s = new Screen({ out: { columns: 40, rows, isTTY: true, write() {}, on() {}, removeListener() {} } });
      assert.ok(s.geometry().statusRows >= 1, `no live status row at ${rows} rows`);
    }
  });

  await test('LIVE: progress is COMPLETED work — starting step 1 of 5 is still 0%', () => {
    const plan = { steps: [
      { n: 1, text: 'a', status: 'active' }, { n: 2, text: 'b', status: 'todo' },
      { n: 3, text: 'c', status: 'todo' }, { n: 4, text: 'd', status: 'todo' },
      { n: 5, text: 'e', status: 'todo' },
    ] };
    const p = views.progressOf(plan);
    assert.strictEqual(p.current, 1);
    assert.strictEqual(p.percent, 0, 'a started step is not a finished one');
  });

  // -------------------------------------------------------------- feed ----

  await test('FEED: a tool call is phrased the way a person would say it', () => {
    // `verb · subject`, which is what a tool row IS - a fact with two parts -
    // rather than a little sentence. See ui/phrasing.js.
    assert.strictEqual(views.phrase('grep', '/SessionStrategist/'), 'search · SessionStrategist');
    assert.strictEqual(views.phrase('read_file', 'a.js'), 'read · a.js');
    // ---- THE RUNNING FORM IS THE SAME SHAPE ------------------------------
    //
    // It used to be a different sentence in a different tense — `Reading a.js…`
    // while it ran, `Read a.js` once it had — so the row visibly rewrote itself at
    // the moment the call finished. Only the MARK changes now, which is the one
    // thing that actually changed.
    assert.strictEqual(views.phrase('read_file', 'a.js', true), 'read · a.js');
    // AND A SHELL COMMAND'S VERB IS ITS PROGRAM, because `Ran` said only that
    // something ran — which every row on the screen shares.
    assert.strictEqual(views.phrase('run_bash', 'python -m py_compile a.py'),
      'python · -m py_compile a.py');
  });

  await test('FEED: the turn IN FLIGHT is visible, not only after it ends', () => {
    // session.turns gains its entry when a turn ENDS. Without the live list the
    // feed was empty for the whole time the work was actually happening.
    //
    // AND A ROUTINE READ IS NOT PART OF THAT, which is the other half of the
    // contract: a successful read is LIVE STATE and belongs in the one row above
    // the caret, not as a permanent row in the conversation. A change to the
    // project is the record and is kept. See ui/feed.js `durable`, and the
    // transcript rule it implements.
    const lines = views.activity({
      session: { turns: [] },
      liveActions: [
        { name: 'read_file', target: 'a.js', ok: true },
        { name: 'edit_file', target: 'a.js', ok: true },
      ],
      liveNarration: [{ text: 'Looking at the router.', after: 0 }],
      width: 70,
    }).join('\n');
    assert.match(lines, /Looking at the router/);
    assert.match(lines, /edited · a\.js/, 'a change to the project is the account of the work');
    assert.ok(!/read · a\.js/.test(lines), 'a routine read must not accumulate in the conversation');
  });

  await test('FEED: a failed call is reported ONCE, not again as a trailing error', () => {
    const lines = views.activity({
      session: { turns: [{
        actions: [{ name: 'read_file', target: 'a.js', ok: false, note: 'no such file: a.js', step: 0, brief: true }],
        narration: [],
        errors: [{ kind: 'TOOL', message: 'read_file: no such file: a.js' }],
      }] },
      width: 70,
    }).join('\n');
    const hits = (lines.match(/no such file/g) || []).length;
    assert.strictEqual(hits, 1, `the same failure was told twice:\n${lines}`);
  });

  await test('FEED: a PROVIDER failure still surfaces — it has no call of its own', () => {
    const lines = views.activity({
      session: { turns: [{ actions: [], narration: [], errors: [{ kind: 'UNAVAILABLE', message: 'provider is down' }] }] },
      width: 70,
    }).join('\n');
    assert.match(lines, /provider is down/);
  });
};
