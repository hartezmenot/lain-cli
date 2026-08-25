'use strict';

/**
 * THE EXTERNAL MODEL PROPOSES. LAIN INVESTIGATES. LAIN OWNS THE ANSWER.
 *
 * ------------------------------------------------------------------------
 * WHY THIS FILE EXISTS WHEN tests/unit/externaladvice.test.js ALREADY PASSES.
 *
 * That file asserts the handoff against a rig: an `app` object whose `submit`
 * pushes onto an array and whose `noteActor` records a string. Every assertion
 * in it was true, and TWO DEFECTS LIVED UNDERNEATH IT, both of them visible the
 * first time the real binary was driven:
 *
 *   THE ADVICE WAS DUMPED INTO THE CONVERSATION AFTER ALL. `noteActor` is not a
 *   side channel — `ui.extras` IS `session.actors`, and ui/conversation.js
 *   draws one row per entry. Pushing the reply through it line by line put
 *   forty lines of somebody else's prose into the middle of LAIN's own account
 *   of its work. The rig recorded those calls and rendered nothing, so the wall
 *   of text was invisible to the test written to prevent it.
 *
 *   THE COMPACT EVENT WENT SOMEWHERE ELSE ENTIRELY. The one-line summary was
 *   written with `render.write`, which under a TUI is the COMMAND SURFACE, not
 *   the feed. So the two surfaces were exactly inverted: the wall was in the
 *   conversation and the summary was not.
 *
 * A third defect was in the shape of the handoff rather than in its content.
 * The advisory brief is submitted like any other turn, so the feed drew it as
 *
 *     USER REQUEST
 *     > [pasted text #1]
 *
 * — a request the user never made, compacted as a paste that was never pasted.
 * On screen that reads as LAIN stopping and an unrelated task starting, which
 * is the one thing the advisory design exists to prevent.
 *
 * So this file drives bin/lain.js and reads the DRAWN FRAMES.
 *
 * ------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHAT IS NOT — stated because the distinction is the
 * whole value of the file.
 *
 * REAL: the binary, argv, the REPL, the config, the session store, the actor,
 * the confirmation panel, the external ledger, `submit`, the turn loop, the
 * tool dispatch, the shell, the renderer, and the frames a person would see.
 * The two shell commands really run and their output is really measured — the
 * fixture's slow.js is genuinely quadratic and reports real milliseconds.
 *
 * NOT REAL: both model endpoints are the scripted mock (src/mockprovider.js).
 * This is LIVE CLI VERIFIED and never LIVE PROVIDER VERIFIED. It proves that
 * the advice ARRIVES where the local agent can act on it and that acting on it
 * is drawn correctly; it cannot prove that a real model would choose to.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes } = require('../helpers');

const NL = String.fromCharCode(10);
const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * THE ROWS OF THE LAST DRAWN FRAME, WITH THE BLANK ONES KEPT.
 *
 * A harness that filters empty rows cannot be used to judge how a feed reads,
 * and one that does it silently reports a correct renderer as broken. Nothing
 * below drops a row for being empty.
 */
function lastPane(out) {
  const f = String(out).split('\x1b[?25l').pop() || '';
  const rows = f.split(/\x1b\[\d+;1H/).slice(1).map(plain).map((r) => r.replace(/\s+$/, ''));
  const i = rows.findIndex((r) => /\[1 activity\]/.test(r));
  const j = rows.findIndex((r) => /^┌─ INPUT/.test(r.trim()));
  return rows.slice(i < 0 ? 0 : i + 1, j < 0 ? rows.length : j);
}

/** Several hypotheses and the checks that would settle them — what an advisor gives. */
const ADVICE = [
  'FACT',
  '  A suite that feels slow is usually dominated by one of three costs.',
  'HYPOTHESIS',
  '  1. Process startup is being paid once per test file.',
  '  2. The same work is being repeated inside a hot loop.',
  '  3. Memory pressure is forcing garbage collection during the run.',
  'RECOMMENDATION',
  '  Measure startup on its own, time the hot loop directly, and inspect',
  '  resident memory while the suite runs.',
].join(NL);

/** An answer built from what was measured, not from what was suggested. */
const FINAL = [
  'Issue',
  'The cost is the copying loop in slow.js, not process startup.',
  '',
  'Verified',
  '- startup.js reported startup_ms in single digits, so hypothesis 1 is rejected',
  '- slow.js reported loop_ms in the thousands, so hypothesis 2 is confirmed',
  '',
  'Unverified',
  '- hypothesis 3, memory pressure: not measured, no resident-memory reading was taken',
  '',
  'How to test: node slow.js',
].join(NL);

/** A project with a bottleneck that a shell command can actually find. */
function fixture() {
  const cwd = tmpdir('advisory-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    connections: { omniroute: { provider: 'anthropic', via: 'bridge', baseUrl: 'http://127.0.0.1:1/v1', models: ['mock-model'] } },
    externalTroubleshoot: { enabled: true, actor: 'API', model: 'mock-model', maxRounds: 1 },
  }, null, 2));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node runtests.js' } }, null, 2));
  // CHEAP — the evidence that REJECTS hypothesis 1.
  fs.writeFileSync(path.join(cwd, 'startup.js'), [
    'const t = Date.now();',
    'require("path");',
    'console.log("startup_ms=" + (Date.now() - t));',
  ].join(NL));
  // EXPENSIVE, and genuinely so — the array is copied on every iteration. This
  // is the evidence that CONFIRMS hypothesis 2, and it is a real measurement.
  fs.writeFileSync(path.join(cwd, 'slow.js'), [
    'const t = Date.now();',
    'let a = [];',
    'for (let i = 0; i < 30000; i++) { a.push(String(i)); a = a.slice(); }',
    'console.log("loop_ms=" + (Date.now() - t) + " len=" + a.length);',
  ].join(NL));
  return { cwd, configDir };
}

/** The whole workflow, once. Everything below reads its result. */
async function consultRun() {
  const { cwd, configDir } = fixture();
  const r = await runCli([], {
    cwd, configDir,
    env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '44' },
    // Staged the way a person works: ask, read, consult, approve, leave.
    stdinSteps: [
      'the test suite feels slow - audit this project and find the bottleneck\n',
      '/external give me a second opinion on what is causing the slowness\n',
      '\r',                                   // "Send it", the first option
      '/exit\n',
    ],
    stepDelayMs: 6000,
    script: [
      // ---- LAIN INVESTIGATES, before anybody is consulted -----------------
      { text: 'Let me look at the project first.', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
      { text: 'The project has slow.js and startup.js, and no timing has been taken yet.' },
      // ---- the advisor's reply, from the same scripted provider -----------
      { text: ADVICE },
      // ---- and the turn the advice is supposed to produce ------------------
      { text: 'Measuring startup on its own.', tool_calls: [{ name: 'run_bash', input: { command: 'node startup.js' } }] },
      { text: 'Now timing the loop directly.', tool_calls: [{ name: 'run_bash', input: { command: 'node slow.js' } }] },
      { text: FINAL },
    ],
    timeoutMs: 150000,
  });
  const dir = path.join(configDir, 'sessions');
  const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).pop();
  return { r, out: plain(r.out), pane: lastPane(r.out), session: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) };
}

module.exports = async function () {
  // ONE RUN, MANY QUESTIONS. Spawning the binary six times to ask six questions
  // about one workflow would cost six minutes and would not be the same
  // workflow — the interesting properties are relationships BETWEEN the steps.
  let R = null;
  const once = async () => { if (!R) R = await consultRun(); return R; };

  await test('ADVISORY LIVE: the advice is acted on — local tools run AFTER it, on real evidence', async () => {
    const { session } = await once();
    assert.strictEqual(session.turns.length, 2, 'the consultation must produce a turn, not end the work');

    const before = session.turns[0];
    assert.ok((before.actions || []).some((a) => a.name === 'list_dir'),
      'LAIN must have been investigating locally BEFORE anybody was consulted');

    const after = session.turns[1];
    assert.strictEqual(after.from, 'external-advice', 'the second turn is the one the advice produced');
    const ran = (after.actions || []).filter((a) => a.name === 'run_bash').map((a) => a.target);
    assert.deepStrictEqual(ran, ['node startup.js', 'node slow.js'],
      `the advisor proposed checks and LAIN must have CARRIED THEM OUT, got: ${JSON.stringify(ran)}`);

    // ---- AND THE EVIDENCE IS REAL --------------------------------------
    //
    // Not "a tool was called" — the numbers those calls produced are read back
    // and compared, so the confirmed hypothesis is confirmed BY A MEASUREMENT.
    const outputs = session.messages.filter((m) => m.role === 'tool').map((m) => String(m.content || '')).join(NL);
    const startup = Number((/startup_ms=(\d+)/.exec(outputs) || [])[1]);
    const loop = Number((/loop_ms=(\d+)/.exec(outputs) || [])[1]);
    assert.ok(Number.isFinite(startup) && Number.isFinite(loop),
      `both checks must have produced a reading, got: ${outputs.slice(0, 300)}`);
    assert.ok(loop > startup,
      `the measurement must actually separate the two hypotheses (startup ${startup}ms, loop ${loop}ms)`);
  });

  await test('ADVISORY LIVE: the answer is evidence-based — one rejected, one confirmed, one UNVERIFIED', async () => {
    const { session } = await once();
    const answer = String(session.turns[1].text || '');
    assert.match(answer, /hypothesis 1 is rejected/, 'a suggestion the evidence contradicts must be said to be contradicted');
    assert.match(answer, /hypothesis 2 is confirmed/, 'and one the evidence supports, supported');
    assert.match(answer, /Unverified/, 'and what was never checked must be labelled');
    assert.match(answer, /hypothesis 3[\s\S]*not measured/,
      'an unchecked suggestion must be marked UNVERIFIED rather than repeated as a finding');
  });

  await test('ADVISORY LIVE: the conversation shows the EVENT, and never the wall of relayed text', async () => {
    const { pane } = await once();
    const feed = pane.join(NL);

    // ---- THE COMPACT EVENT IS THERE ------------------------------------
    assertIncludes(feed, 'external consultation', 'the consultation must be announced in the conversation');
    assertIncludes(feed, 'advice received', 'and so must the fact that a reply arrived');

    // ---- AND THE ADVISOR'S PROSE IS NOT --------------------------------
    //
    // THE DEFECT, precisely: every one of these lines WAS in the feed, one row
    // each, under an EXTERNAL heading, in the middle of LAIN's own account.
    for (const line of [
      'Process startup is being paid once per test file',
      'The same work is being repeated inside a hot loop',
      'Memory pressure is forcing garbage collection',
      'Measure startup on its own, time the hot loop directly',
    ]) {
      assertNotIncludes(feed, line, 'the advisor prose must not be relayed into the conversation');
    }
    // Two lines is the budget, and it is checked as a number rather than by eye.
    const external = pane.filter((r) => /consultation ·|advice received/.test(r));
    assert.strictEqual(external.length, 2, `the consultation is worth two lines, got:\n${external.join(NL)}`);
  });

  await test('ADVISORY LIVE: the advice is KEPT — one entry, carrying the whole reply', async () => {
    const { session } = await once();
    const ext = (session.actors || []).filter((a) => a.kind === 'external');
    assert.strictEqual(ext.length, 2, 'the channel carries the event, not one entry per line of prose');
    const withDetail = ext.find((a) => Array.isArray(a.detail));
    assert.ok(withDetail, 'the advisor own words must be preserved on the entry');
    const kept = withDetail.detail.join(NL);
    assertIncludes(kept, 'Memory pressure is forcing garbage collection',
      'including the hypothesis LAIN could not check — losing it would lose the only record of it');
    assertIncludes(kept, 'Measure startup on its own', 'and the checks it proposed');
    // It also survives verbatim where the model saw it.
    const brief = session.messages.find((m) => m.role === 'user' && /EXTERNAL ADVICE/.test(m.content || ''));
    assert.ok(brief, 'the brief itself is in the saved session');
    assertIncludes(brief.content, 'repeated inside a hot loop', 'with the advice inside it');
  });

  await test('ADVISORY LIVE: it reads as one investigation continuing, not as a new task', async () => {
    const { pane, session } = await once();
    const feed = pane.join(NL);

    // ---- THE DEFECT, AND IT IS ABOUT ONE ROW ---------------------------
    //
    //     USER REQUEST
    //     > [pasted text #1]
    //
    // for a six-hundred-character brief that nobody typed and nobody pasted.
    assertNotIncludes(feed, '[pasted text', 'a brief LAIN wrote itself was never pasted by anyone');
    assertNotIncludes(feed, 'EXTERNAL ADVICE — advisory input',
      'and the brief is instruction to the model, not something to read on screen');
    assertIncludes(feed, 'continuing the investigation with the external advice',
      'the turn must be drawn as the continuation it is');

    // THE BANNER NEVER CHANGES — the task is still the one the person asked for.
    assertIncludes(feed, 'TASK  the test suite feels slow');
    assert.strictEqual(session.task.objective,
      'the test suite feels slow - audit this project and find the bottleneck',
      'an advisory turn must never replace the objective');
    assert.strictEqual((session.task.steers || []).length, 0);
  });

  await test('ADVISORY LIVE: ONE consultation — stamped on the task, and it survives a save', async () => {
    const { session } = await once();
    assert.strictEqual(session.task.externalConsults, 1,
      'the stamp that stops a chain of second opinions must be in the SAVED session — '
      + 'an ad-hoc property is dropped by Task.toJSON and a resumed session forgets');
    assert.strictEqual((session.external || []).length, 1, 'exactly one packet left the machine');
    assert.strictEqual(session.external[0].state, 'EXTERNAL_RESPONDED');
    // The audit trail is the record that something LEFT; the packet is not
    // written into the session file with it. See externalstate.toJSON.
    assert.ok(!('prompt' in session.external[0]), 'the packet body is not duplicated onto disk');
    assert.strictEqual(typeof session.external[0].promptChars, 'number');
  });

  await test('ADVISORY LIVE: nothing was sent until the panel was answered', async () => {
    const { out } = await once();
    assertIncludes(out, 'SEND THIS OUTSIDE LAIN?', 'the confirmation is the real one, and it was asked');
    assertIncludes(out, 'Nothing has been sent yet.');
    assertIncludes(out, 'drafted locally, nothing sent', 'and the draft was shown before it was approved');
  });
};
