'use strict';

/**
 * THE PRIMARY SURFACE — what a person must be able to see, and where it comes from.
 *
 * These do not test pixels. They test the four questions the primary interface
 * exists to answer without being asked — where am I, which model, how much
 * context, what is LAIN doing — and the one rule that makes the last of those
 * worth trusting: THE ACTIVITY IS PROJECTED FROM REAL WORK, NEVER INVENTED.
 *
 * The interesting half is the ABSENCE assertions. A surface test that only
 * checks the new word is present lets a timer-driven or randomised activity
 * quietly come back, and that is the failure mode the whole activity
 * architecture is built to prevent: a screen that says READING when nothing is
 * being read is worse than a blank one, because somebody believes it.
 */

const assert = require('assert');
const fsx = require('fs');
const path = require('path');
const { test } = require('../helpers');

const T = require('../../src/ui/text');
const { Screen } = require('../../src/ui/layout');
const status = require('../../src/ui/status');
const { describeTarget } = require('../../src/describe');

/** Draw the real screen and hand back what a terminal would have received. */
function draw(over = {}) {
  let wrote = '';
  const s = new Screen({ out: { columns: 100, rows: 30, isTTY: true, write(x) { wrote += x; }, on() {}, removeListener() {} } });
  s.active = true;
  s.state = Object.assign({
    cwd: 'C:\\work\\lain-v2',
    model: 'claude-opus-4', provider: 'anthropic', effort: 'auto',
    // THE HEADER'S ONE NUMBER: the output tokens of the response in front of
    // you. `measured: true` is the provider's own count; while a response is
    // streaming it is an estimate and wears a `~`.
    output: { tokens: 1200, measured: true },
    session: {
      cwd: 'C:\\work\\lain-v2',
      usage: { inputTokens: 42000, outputTokens: 1200, cacheReadTokens: 8000 },
      turns: [{ userInput: 'fix the routing', text: 'Routing fixed.', actions: [], errors: [] }],
    },
    llm: { phase: null, usage: { inputTokens: 42000, outputTokens: 1200, cacheReadTokens: 8000 } },
    liveActions: [], liveNarration: [], extras: [],
  }, over);
  s.draw();
  return T.strip(wrote);
}

module.exports = async function () {
  // ------------------------------------------------ required information --

  await test('SURFACE: the project, the model and the live output count are on screen at once', () => {
    // Four questions, one glance. Each of these was individually present
    // before; what this pins is that no layout change may cost the user any
    // ONE of them, which is how a surface degrades — one field at a time.
    //
    // THE THIRD FIELD CHANGED AND THE RULE DID NOT. It was the session's
    // cumulative token bill (`42K`), which barely moves within a turn and reads
    // as noise on a permanent row; it is now the OUTPUT TOKENS OF THE RESPONSE
    // IN FRONT OF YOU, which climbs while the model writes and is the field
    // that proves it is still coming. The bill moved to `/token`.
    const out = draw();
    assert.match(out, /lain-v2/, 'the project must be named');
    assert.match(out, /claude-opus-4/, 'the active model must be named');
    assert.match(out, /1200/, 'the live output count must be readable');
    assert.match(out, /Ask LAIN/, 'and the input region must be present and say what it is for');
  });

  await test('SURFACE: the input is the anchor — one region, at the bottom, with no box', () => {
    // ONE place to talk to LAIN. Two input regions is the fragmentation this
    // rule exists to prevent, and a second one is easy to add by accident.
    // The frame is ONE string of cursor-addressed writes, not a list of lines,
    // so the position is read from the row each region is addressed to
    // (\x1b[<row>;1H) rather than from a split — which is what the terminal
    // actually does with it.
    const out = draw();
    const hits = out.match(/Ask LAIN/g) || [];
    assert.strictEqual(hits.length, 1, 'exactly one input region');
    // ---- AND IT HAS NO RECTANGLE AROUND IT ---------------------------
    //
    // The region was `┌─ INPUT ─┐ │ > text │ └───┘`. It is a grey fill now, and
    // the fill IS the region: no border, no label, no nested panel, no prompt
    // symbol. Asserted as the absence of box-drawing characters anywhere in the
    // frame, because there is nothing else on the surface that draws one.
    for (const glyph of ['┌', '┐', '└', '┘', '│']) {
      assert.ok(!out.includes(glyph), `a box-drawing character survived on the surface: ${glyph}`);
    }
    // ABSENT MUST NOT READ AS “LAST ROW”. indexOf returns -1 for a needle that
    // is not there, and slice(0, -1) then measures almost the whole frame — so
    // a missing string scored row 30 and quietly passed a bottom-of-screen
    // assertion. Absent is 0, and every caller checks for it.
    const rowOf = (frame, needle) => {
      const at = frame.indexOf(needle);
      if (at < 0) return 0;
      // ANY COLUMN, NOT COLUMN 1: every region is drawn inside the content frame
      // now (ui/frame.js `contentBounds`), so the address carries the frame's left
      // edge. Matching `;1H` found nothing and every row scored 0.
      const addr = frame.slice(0, at).match(/\x1b\[(\d+);\d+H/g) || [];
      const last = addr[addr.length - 1] || '';
      return Number((last.match(/\[(\d+);/) || [])[1] || 0);
    };
    const inputRow = rowOf(out, 'Ask LAIN');
    assert.ok(inputRow >= 25, `the input belongs on the floor of a 30-row screen, drawn at row ${inputRow}`);
    // AND THE RESULT READS ABOVE IT — the hierarchy this whole file is about.
    const answerRow = rowOf(out, 'Routing fixed.');
    assert.ok(answerRow > 0, 'the answer must be on screen at all');
    assert.ok(answerRow < inputRow, 'the result reads above the input');
  });

  // ----------------------------------------------------- real activity ----

  await test('ACTIVITY: every word the strip says is derived from a phase, never from a clock', () => {
    // THE RULE, ASSERTED DIRECTLY: same state in, same word out, no matter
    // what time it is. A surface that animates would fail this.
    const phase = { phase: 'RUNNING_TOOL', tool: 'read_file', target: 'src/router.js' };
    const a = status.liveState({ phase, phaseSince: 1000 }, 5000);
    const b = status.liveState({ phase, phaseSince: 1000 }, 900000);
    assert.strictEqual(a.word, 'READING');
    assert.strictEqual(b.word, a.word, 'the word may not change merely because time passed');
    assert.strictEqual(b.detail, a.detail, 'nor may the subject');
  });

  await test('ACTIVITY: with nothing running and nothing done, LAIN says READY — not a fake verb', () => {
    // The resting state is a state. Inventing READING here would be the exact
    // dishonesty the activity architecture forbids.
    const idle = status.liveState({}, Date.now());
    assert.strictEqual(idle.word, 'READY');
    assert.strictEqual(idle.detail, '');
  });

  await test('ACTIVITY: the harness tools are named by what they DO, not as a generic RUNNING', () => {
    // These four are the harness surfacing through the ordinary strip. They
    // all read `RUNNING` until this pass, which is the one word that loses
    // what makes them worth watching: proving, looking, and leaving something
    // alive on the user's machine are three different events.
    const word = (tool, target) => status.liveState({ phase: { phase: 'RUNNING_TOOL', tool, target } }).word;
    assert.strictEqual(word('verify_task', 'unit tests pass'), 'VERIFYING');
    assert.strictEqual(word('observe', 'errors'), 'OBSERVING');
    assert.strictEqual(word('service_start', 'npm run dev'), 'STARTING');
    assert.strictEqual(word('service_check', 'dev'), 'CHECKING');
    // And an ordinary command is still a command.
    assert.strictEqual(word('run_bash', 'npm test'), 'RUNNING');
  });

  await test('ACTIVITY: a harness call always names its subject — no subject-less rows', () => {
    // A row that says only `VERIFYING` is the same as thirty identical rows.
    // Each of these returned '' before this pass.
    assert.strictEqual(describeTarget('verify_task', { requirements: [{ what: 'unit tests pass' }] }), 'unit tests pass');
    assert.match(describeTarget('verify_task', { requirements: [{ what: 'a' }, { what: 'b' }] }), /\+1$/);
    assert.strictEqual(describeTarget('service_check', { name: 'dev' }), 'dev');
    assert.strictEqual(describeTarget('service_check', {}), 'all services');
    assert.strictEqual(describeTarget('observe', { goal: 'errors', url: 'http://localhost:3000/app' }), 'errors → localhost:3000/app');
    // A malformed URL must cost the goal, not the row.
    assert.strictEqual(describeTarget('observe', { goal: 'errors', url: ':::' }), 'errors');
  });

  await test('ACTIVITY: the strip draws the real phase, through the real screen', () => {
    // End to end rather than through the pure function: a phase set on the
    // state must reach the drawn frame, or the projection is decorative.
    const out = draw({ llm: { phase: { phase: 'RUNNING_TOOL', tool: 'verify_task', target: 'unit tests pass' }, phaseSince: Date.now() } });
    assert.match(out, /Verifying/);
    assert.match(out, /unit tests pass/);
  });

  await test('ACTIVITY: no timer drives the words — the status module owns no clock', () => {
    // THE STRUCTURAL VERSION OF THE RULE ABOVE. `liveState` takes `now` as an
    // argument precisely so it cannot consult one, and a module that grew a
    // setInterval could animate a lie past every behavioural test here.
    const src = fsx.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'status.js'), 'utf8');
    assert.ok(!/setInterval|setTimeout/.test(src), 'the status strip must not schedule anything');
    assert.ok(!/Math\.random/.test(src), 'and it must never invent what LAIN is doing');
  });

  // ---------------------------------------------------------- boundary ----

  await test('BOUNDARY: infrastructure detail is not injected into an ordinary turn', () => {
    // The harness may hold a rich task record; the ordinary screen does not
    // print task ids, event counts or verification contracts at a person who
    // only asked a question. Those live behind /tasks, /verify and /harness.
    const out = draw();
    assert.ok(!/Task ID|task_[0-9a-f]{6}|events\.jsonl|verification contract/i.test(out), out.slice(0, 400));
  });

  await test('BOUNDARY: there is ONE projection of harness state, and the surfaces share it', () => {
    // A second reader assembling its own notion of “is it done” is the failure
    // harnesssurface.js exists to prevent — see its header. The dashboard is
    // the existing consumer; this pins that it consumes rather than derives.
    const dash = fsx.readFileSync(path.join(__dirname, '..', '..', 'src', 'dash.js'), 'utf8');
    assert.match(dash, /harnesssurface/, 'the dashboard must read the shared projection');
    assert.ok(!/runtime\.snapshot\(\)/.test(dash), 'and must not reach past it into the runtime');
  });

  await test('BOUNDARY: a missing harness degrades to absent, never to a false empty task', () => {
    // `null` means “no task has been opened”. An object of zeroes would render
    // as a task that exists and has proved nothing, which is a different and
    // false claim — and the one that would read as “0 failed”.
    const surface = require('../../src/harnesssurface');
    assert.strictEqual(surface.project(null), null);
    assert.strictEqual(surface.project({}), null);
    assert.strictEqual(surface.line({}), null);
  });

  await test('ACTIVITY: IDLE and WAITING are different words for different states', () => {
    // ------------------------------------------------------------------
    // §29. `WAITING` must describe a GENUINE wait — something outside LAIN that
    // has to happen before it can continue — and must never be what LAIN says
    // when it is simply ready for input. A screen that says WAITING at an idle
    // prompt is asking the user to wait for themselves.
    // ------------------------------------------------------------------
    const idle = status.liveState({}, Date.now());
    assert.strictEqual(idle.word, 'READY', 'the resting state is READY');
    assert.ok(!/WAIT/.test(idle.word), 'and never a WAIT');
    assert.strictEqual(idle.detail, '', 'with nothing invented beside it');

    // A TURN THAT FINISHED is also not waiting.
    const done = status.liveState({ lastTurn: { toolCalls: 2, filesChanged: 1, stopReason: 'end' } });
    assert.ok(!/WAIT/.test(done.word), `a finished turn is not a wait: ${done.word}`);

    // THE GENUINE WAITS, each naming what is being waited ON — which is the
    // whole difference between this and an idle prompt.
    const limit = status.liveState({ waitingUntil: Date.now() + 60000, waitingLabel: 'rate limited' });
    assert.match(limit.word, /WAITING/, 'a rate limit is a real wait');
    assert.ok(limit.detail, 'and says what for');

    const onYou = status.liveState({ awaitingUser: 'which backend?' });
    assert.match(onYou.word, /WAITING FOR YOU/, 'a question is a real wait, on a person');
    assert.ok(onYou.detail.includes('which backend?'), 'and names the question');

    // AND BACKGROUND WORK DOES NOT MAKE THE FOREGROUND A WAIT. `/bg` runs
    // beside the conversation; the prompt is live, so the row must say so.
    const withBg = status.liveState({
      phase: null,
      jobs: [{ id: '3', primary: false, state: 'RUNNING', request: 'the integration suite' }],
    });
    assert.strictEqual(withBg.word, 'READY',
      'a running background task leaves the prompt ready, not waiting');
  });
};
