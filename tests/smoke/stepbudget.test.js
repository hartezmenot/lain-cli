'use strict';

/**
 * AN INFRASTRUCTURE LIMIT IS NOT AN INSTRUCTION TO THE MODEL.
 *
 * "The infrastructure may have a maximum number of tool/action steps for
 * safety, accounting, or liveness. That limit must NOT become an instruction to
 * the model to continue."
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS COUNTED IN PROVIDER REQUESTS AND NOTHING ELSE.
 *
 * The previous test for this asserted on SCREEN TEXT — that the word
 * CONTINUING was absent, that no synthetic prompt appeared. That is worth
 * having and it is not the property. LAIN could manufacture a continuation
 * silently, print nothing, and pass every one of those assertions while
 * spending four more requests of somebody's money.
 *
 * The only measurement that cannot be talked around is how many times a
 * provider was asked. `LAIN_MOCK_WIRELOG` records one line per request, so a
 * capped turn has an exact, checkable cost.
 *
 * LIVE CLI VERIFIED: the real binary, the real turn loop, the real config key.
 * The network call is the mock.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** How many requests this run made. One line per request. */
function requests(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

/** A project whose config caps the turn, through the REAL config key. */
function capped(steps) {
  const cwd = tmpdir('budget-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    maxSteps: steps,
    trustedPaths: [{ path: cwd, level: 'TRUSTED' }],
  }));
  return { cwd, configDir };
}

/** A model that never stops asking for tools. */
const endless = (n) => Array.from({ length: n }, (_, i) => ({
  text: `Step ${i}.`,
  tool_calls: [{ name: 'run_bash', input: { command: `echo step-${i}` } }],
}));

module.exports = async function () {
  await test('BUDGET: reaching the step limit costs EXACTLY the capped number of requests', async () => {
    // THE MEASUREMENT THAT MATTERS. A cap of 3 means three requests: one per
    // step. Any automatic continuation — however it is spelled, whatever it
    // prints — shows up here as a fourth.
    const { cwd, configDir } = capped(3);
    const log = path.join(cwd, 'wire.log');
    const r = await runCli(['-p', 'do the long thing'], {
      cwd, configDir,
      env: { LAIN_MOCK_WIRELOG: log },
      script: endless(30),
      timeoutMs: 90000,
    });
    const n = requests(log);
    assert.strictEqual(n, 3,
      `a 3-step cap made ${n} provider requests — anything above 3 is LAIN deciding the model `
      + 'should keep going and paying for that decision');
    const out = plain(r.out);
    assert.ok(!/CONTINUING/i.test(out), 'and it does not announce carrying on');
    assert.ok(!/Continue from exactly where you stopped/i.test(out), 'nor compose a prompt to do it');
  });

  await test('BUDGET: the ending is the INFRASTRUCTURE state, not a claim about the work', async () => {
    const { cwd, configDir } = capped(2);
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'do the long thing\n',
      script: endless(30),
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    assert.match(out, /STEP LIMIT/, 'it names its own execution boundary');
    // NOT DONE — nothing was finished. NOT FAILED — nothing failed. NOT
    // INTERRUPTED — nobody interrupted it. Three different untruths that the
    // same event used to be reported as at different times.
    assert.ok(!/TASK COMPLETE/.test(out), 'the task is not complete');
    assert.ok(!/\bFAILED\b/.test(out), 'and nothing failed merely because a budget ended');
    assert.ok(!/MODEL INTERRUPTED/.test(out), 'and nobody interrupted it');
  });

  await test('BUDGET: the evidence of the capped turn is INTACT afterwards', async () => {
    // Stopping at a bound must not cost the work already done. Everything the
    // turn actually did is still in the conversation the next request would
    // carry, which is what makes an explicit continuation useful rather than a
    // restart.
    const { cwd, configDir } = capped(3);
    const r = await runCli(['-p', 'do the long thing'], {
      cwd, configDir,
      script: endless(30),
      timeoutMs: 90000,
    });
    const dir = path.join(r.configDir, 'sessions');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const toolResults = (saved.messages || []).filter((m) => m.role === 'tool');
    assert.ok(toolResults.length >= 3, `only ${toolResults.length} tool results survived a 3-step turn`);
    // AND THE PROTOCOL IS WHOLE: every result still has the call that produced
    // it, or the next request is a 400 rather than a continuation.
    const callIds = new Set();
    for (const m of saved.messages || []) for (const tc of m.tool_calls || []) callIds.add(String(tc.id));
    const orphans = toolResults.filter((m) => !callIds.has(String(m.tool_call_id)));
    assert.deepStrictEqual(orphans, [], 'a capped turn left an unanswerable conversation behind');
  });

  await test('BUDGET: an EXPLICIT continuation from the user is allowed, and costs one request', async () => {
    // The distinction the whole section rests on: LAIN must not decide to carry
    // on; the user always may. Typing `continue` is user control and must work.
    const { cwd, configDir } = capped(2);
    const log = path.join(cwd, 'wire.log');
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_MOCK_WIRELOG: log },
      stdinSteps: ['do the long thing\n', 'continue\n', '/exit\n'],
      stepDelayMs: 2500,
      script: [...endless(2), { text: 'Carried on because you asked. FINISHED.' }],
      timeoutMs: 90000,
    });
    assert.match(plain(r.out), /Carried on because you asked/,
      'an explicit continuation must start a real turn');
    const n = requests(log);
    assert.strictEqual(n, 3, `two capped steps plus one asked-for continuation is 3 requests, not ${n}`);
  });

  await test('BUDGET: nothing in the tree turns the budget into another request', async () => {
    // A CALL-GRAPH CHECK, because the mechanism could return under any name.
    // What is banned is a submit whose input LAIN composed in order to make the
    // model take another turn. The three `submit` calls that exist are the
    // user's own steer text and the two answers to the rate-limit question —
    // all three chosen by a person, none of them reachable from a step budget.
    const src = path.join(__dirname, '..', '..', 'src');
    const offenders = [];
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.js')) continue;
      const text = fs.readFileSync(path.join(src, f), 'utf8');
      const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      if (/from:\s*'carry-on'/.test(code)) offenders.push(`${f}: submits a carry-on turn`);
      if (/_carriedOn/.test(code)) offenders.push(`${f}: tracks a continuation budget`);
      // A submit reached from the max-steps branch, under any name.
      if (/stopReason\s*=\s*'max-steps'[\s\S]{0,400}?\.submit\(/.test(code)) {
        offenders.push(`${f}: reaches a provider request from the step budget`);
      }
    }
    assert.deepStrictEqual(offenders, [], offenders.join('\n'));
    assert.ok(!fs.existsSync(path.join(src, 'carryon.js')), 'carryon.js must stay gone');
  });
};
