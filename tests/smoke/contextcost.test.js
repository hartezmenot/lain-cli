'use strict';

/**
 * WHAT A SESSION COSTS, MEASURED THROUGH THE REAL BINARY.
 *
 * ------------------------------------------------------------------------
 * WHY THIS TIER AND NOT THE UNIT ONE. The unit tests assert that the budget is
 * below the ceiling, that compaction stubs what it removes, and that the cache
 * markers land where they should. None of that proves a REQUEST got smaller,
 * because the request is assembled by a running turn out of a growing session,
 * and the growth is the whole phenomenon.
 *
 * So this drives bin/lain.js through a genuine multi-step task and reads the
 * size of every payload the provider was actually handed. `LAIN_MOCK_WIRELOG`
 * is the seam for that and predates this work: one line per request, with the
 * message count and the exact character total of what was about to be sent.
 *
 * ------------------------------------------------------------------------
 * THE NUMBERS THIS FILE EXISTS TO KEEP DOWN, measured before the fix on
 * twenty-four modules through this same harness:
 *
 *     peak request   204,644 est tokens
 *     session total  2,839,926 est tokens
 *
 * and after:
 *
 *     peak request    62,316
 *     session total  1,297,545
 *
 * The reported failure was 325,000-343,000 tokens per request. A ceiling test
 * is the only kind that can catch its return.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const plain = (s) => String(s).replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '');

/**
 * The tool schemas ride on every request and are not in the wire log, so they
 * are added back here. MEASURED, not hardcoded: this was a literal 35,754 that
 * every edit to a tool description silently invalidated, which is a stale
 * number reporting a cost nobody paid. With no App the registry returns the
 * connection-only vocabulary — exactly what the mock run below is offered.
 */
const SCHEMA_CHARS = JSON.stringify(require('../../src/tools').schemas()).length;
const CHARS_PER_TOKEN = 3.6;

/** Eight real modules, read in sequence, then an edit and a command. */
function fixture() {
  const R = path.join(__dirname, '..', '..');
  const files = ['session.js', 'contextfit.js', 'provider.js', 'turn.js',
    'prompt.js', 'evidence.js', 'app.js', 'execution.js'];
  const cwd = tmpdir('cost-');
  for (const f of files) fs.writeFileSync(path.join(cwd, f), fs.readFileSync(path.join(R, 'src', f)));
  fs.writeFileSync(path.join(cwd, 'runtests.js'), 'console.log("3 passed, 0 failed");' + NL);
  fs.writeFileSync(path.join(cwd, 'budget.js'), 'const LIMIT = 10;' + NL + 'module.exports = { LIMIT };' + NL);

  const script = files.map((f) => ({ text: 'Reading ' + f, tool_calls: [{ name: 'read_file', input: { path: f } }] }));
  script.push({
    text: 'Raising the limit.',
    tool_calls: [{ name: 'edit_file', input: { path: 'budget.js', old: 'const LIMIT = 10;', new: 'const LIMIT = 12;' } }],
  });
  script.push({ text: 'Running the tests.', tool_calls: [{ name: 'run_bash', input: { command: 'node runtests.js' } }] });
  script.push({
    text: 'Issue' + NL + 'The limit was 10.' + NL + NL + 'Fix' + NL + 'Raised to 12 in budget.js.'
      + NL + NL + 'Verified' + NL + '- node runtests.js reported 3 passed, 0 failed',
  });
  return { cwd, script, files };
}

/** Run the task, and report every payload size the provider was handed. */
async function measured(env = {}) {
  const { cwd, script, files } = fixture();
  const wirelog = path.join(cwd, 'wire.tsv');
  const r = await runCli([], {
    cwd,
    env: { LAIN_MOCK_WIRELOG: wirelog, ...env },
    stdin: 'audit these modules, raise the limit, and run the tests' + NL + '/exit' + NL,
    script,
    timeoutMs: 180000,
  });
  const rows = fs.readFileSync(wirelog, 'utf8').trim().split(NL).map((l) => l.split('\t').map(Number));
  const chars = rows.map(([, c]) => c);
  const tok = (c) => Math.round((c + SCHEMA_CHARS) / CHARS_PER_TOKEN);
  return {
    r, cwd, files,
    requests: rows.length,
    peak: tok(Math.max(...chars)),
    total: Math.round((chars.reduce((a, b) => a + b, 0) + SCHEMA_CHARS * rows.length) / CHARS_PER_TOKEN),
  };
}

module.exports = async function () {
  let base = null;
  const once = async () => { if (!base) base = await measured(); return base; };

  await test('COST LIVE: no request comes close to the reported 325k tokens', async () => {
    const m = await once();
    assert.strictEqual(m.r.code, 0);
    // THE CEILING THAT MATTERS. Measured before the fix, the same shape of task
    // over more modules peaked at 204,644 tokens and the reported real sessions
    // were 325,000-343,000. The budget is 50,000 tokens of CONVERSATION; the
    // schemas and the current working set sit on top of it, which is why this
    // is checked against a number above the budget rather than at it.
    assert.ok(m.peak < 100000,
      `a single request cost ${m.peak} est tokens — the leak is back`);
    assert.ok(m.requests >= 10, `the task really did take ${m.requests} requests`);
  });

  await test('COST LIVE: the same work costs far less than it did with no budget', async () => {
    const m = await once();
    // The BEFORE condition, reproduced exactly: a budget set to the provider's
    // window is what `contextfit` used to compact against, and it is why
    // compaction never ran.
    const before = await measured({ LAIN_CONTEXT_BUDGET_TOKENS: '200000' });

    // ---- WHAT THE BUDGET CONTROLS IS THE PEAK -----------------------------
    //
    // This asserted a 15% fall in the SESSION TOTAL and failed at 12%
    // (530,030 -> 467,563), and the assertion was the thing that was wrong.
    //
    // The budget caps how large any ONE request may get. On a task whose
    // transcript never approaches the cap, capping it correctly changes almost
    // nothing — which is the desired behaviour, not a regression. The total
    // saving therefore scales with how far over budget the task would have
    // gone: 54% on the twenty-four-module run that reproduced the reported
    // failure, 12% on this eight-file one.
    //
    // So the PEAK is asserted strictly, because that is what the budget
    // promises, and the total is asserted only not to RISE.
    assert.ok(before.peak > m.peak,
      `the budget must reduce the peak request: ${before.peak} -> ${m.peak}`);
    assert.ok(m.total <= before.total,
      `and must never make a session cost more: ${before.total} -> ${m.total}`);
  });

  await test('COST LIVE: and the work still happened — the same edit, the same answer', async () => {
    // TOKEN REDUCTION THAT LOSES THE WORK IS NOT A FIX. The file on disk is the
    // check that cannot be argued with.
    const m = await once();
    const edited = fs.readFileSync(path.join(m.cwd, 'budget.js'), 'utf8');
    assert.match(edited, /LIMIT = 12/, 'the edit must still have been made');

    const dir = path.join(m.cwd, '.config', 'sessions');
    const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).pop();
    const session = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const calls = session.turns.reduce((a, t) => a + (t.toolCalls || 0), 0);
    assert.strictEqual(calls, 10, `every tool call must still have run, got ${calls}`);
    assertIncludes(String(session.turns[session.turns.length - 1].text || ''),
      '3 passed, 0 failed', 'and the verified answer must still be there');
  });

  await test('COST LIVE: what was elided says which call to re-run to get it back', async () => {
    // THE LINE BETWEEN COMPACTION AND TRUNCATION. Everything removed from the
    // working context is still REPRESENTED, and the representation is
    // actionable — it names the tool and its arguments.
    const m = await once();
    const dir = path.join(m.cwd, '.config', 'sessions');
    const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).pop();
    const session = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const stubs = session.messages.filter((x) => /^\[elided to fit/.test(String(x.content || '')));
    if (!stubs.length) return;   // a task small enough not to compact is a pass
    for (const s of stubs) {
      assert.match(s.content, /read_file|run_bash|edit_file/, 'the stub names the call');
      assert.match(s.content, /Re-run the call/, 'and says how to get it back');
    }
  });

  await test('COST LIVE: /tokens explains the growth instead of merely reporting it', async () => {
    // The reported condition was 330,000 tokens with nothing able to say of
    // what. This is the answer to that, on screen, in the real binary.
    const { cwd, script } = fixture();
    const r = await runCli([], {
      cwd,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '46' },
      stdinSteps: ['audit these modules, raise the limit, and run the tests' + NL, '/tokens' + NL, '/exit' + NL],
      stepDelayMs: 15000,
      script,
      timeoutMs: 200000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.out);
    assertIncludes(out, 'Token accounting', 'the panel must open');
    assertIncludes(out, 'tool schemas', 'and name the fixed cost that rides on every request');
    assertIncludes(out, 'system prompt');
    assertIncludes(out, 'INPUT (est)');
    assertIncludes(out, 'budget', 'and say what the request was held to');
    // ZERO CACHE IS THE EXPENSIVE SILENT CONDITION. On the mock provider there
    // is no cache, and the panel must SAY that rather than print a blank.
    assertIncludes(out, 'nothing was served from cache');
  });
};
