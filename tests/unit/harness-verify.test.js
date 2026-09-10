'use strict';

/**
 * THE VERIFICATION ENGINE — the arithmetic, and the third verdict.
 *
 * The assertions that matter most are the ones about INCONCLUSIVE. A check that
 * can only pass or fail reports a runner that is not installed as a red suite
 * and a browser that never started as a broken flow, and both of those are the
 * same lie: an ABSENT observation reported as a NEGATIVE one.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const verify = require('../../src/harness/verify');
const checks = require('../../src/harness/checks');
const { VERDICT } = verify;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lain-verify-')); }
const node = JSON.stringify(process.execPath);

module.exports = async function () {
  // ------------------------------------------------------------- arithmetic --

  await test('VERIFY: every required requirement passing is the ONLY way to PASSED', async () => {
    const r = await verify.run({
      name: 'two things',
      requirements: [
        { description: 'a', checks: [{ kind: 'command', label: 'ok', command: `${node} -e "process.exit(0)"` }] },
        { description: 'b', checks: [{ kind: 'command', label: 'ok2', command: `${node} -e "process.exit(0)"` }] },
      ],
    }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.PASSED);
    assert.strictEqual(r.passed, 2);
  });

  await test('VERIFY: FAILED outranks INCONCLUSIVE — a red check is not softened by a missing one', async () => {
    // The ordering in rollUpContract is load-bearing: something was proved
    // wrong, and missing evidence elsewhere does not make that less true.
    const r = await verify.run({
      requirements: [
        { description: 'red', checks: [{ kind: 'command', label: 'red', command: `${node} -e "process.exit(3)"` }] },
        { description: 'unknown', checks: [{ kind: 'command', label: 'absent', command: 'lain-definitely-not-a-real-binary-9f3a' }] },
      ],
    }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.FAILED);
    assert.strictEqual(r.failed, 1);
    assert.strictEqual(r.inconclusive, 1);
  });

  await test('VERIFY: a contract that requires nothing proves nothing', async () => {
    const r = await verify.run({ requirements: [] }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.INCONCLUSIVE);
    assert.match(r.why, /required nothing/);
  });

  await test('VERIFY: a requirement with no evidence named is INCONCLUSIVE, not PASSED', async () => {
    const r = await verify.run({ requirements: [{ description: 'it works, trust me', checks: [] }] }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.INCONCLUSIVE);
    assert.match(r.requirements[0].why, /no evidence was named/);
  });

  await test('VERIFY: an OPTIONAL requirement is reported and cannot change the verdict', async () => {
    const r = await verify.run({
      requirements: [
        { description: 'required', checks: [{ kind: 'command', label: 'ok', command: `${node} -e "process.exit(0)"` }] },
        { description: 'lint', required: false, checks: [{ kind: 'command', label: 'lint', command: `${node} -e "process.exit(1)"` }] },
      ],
    }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.PASSED, 'an optional failure must not fail the task');
    assert.strictEqual(r.requirements[1].verdict, VERDICT.FAILED, 'but it is still reported honestly');
  });

  await test('VERIFY: requirements default to REQUIRED — a contract cannot pass by omission', async () => {
    const c = verify.contract({ requirements: [{ description: 'x' }] });
    assert.strictEqual(c.requirements[0].required, true);
  });

  await test('VERIFY: EVERY check of a requirement must pass — there is no threshold', async () => {
    const r = await verify.run({
      requirements: [{
        description: 'both halves',
        checks: [
          { kind: 'command', label: 'a', command: `${node} -e "process.exit(0)"` },
          { kind: 'command', label: 'b', command: `${node} -e "process.exit(1)"` },
        ],
      }],
    }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.FAILED);
  });

  await test('VERIFY: nothing short-circuits — the whole report comes back every time', async () => {
    const r = await verify.run({
      requirements: [
        { description: 'first red', checks: [{ kind: 'command', label: 'a', command: `${node} -e "process.exit(1)"` }] },
        { description: 'second red', checks: [{ kind: 'command', label: 'b', command: `${node} -e "process.exit(1)"` }] },
      ],
    }, { cwd: process.cwd() });
    assert.strictEqual(r.failed, 2, 'a recovery loop that only ever sees one failure crawls');
  });

  // ----------------------------------------------------------- the checks --

  await test('CHECK: a command that is not installed is INCONCLUSIVE, never FAILED', async () => {
    const r = await checks.run({ kind: 'command', label: 'ghost', command: 'lain-definitely-not-a-real-binary-9f3a --version' }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.INCONCLUSIVE);
    assert.match(r.why, /not installed|could not start/);
  });

  await test('CHECK: a command that ran and exited non-zero is FAILED', async () => {
    const r = await checks.run({ kind: 'command', label: 'red', command: `${node} -e "process.exit(2)"` }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.FAILED);
    assert.match(r.why, /exit 2/);
  });

  await test('CHECK: an expected non-zero exit is a PASS', async () => {
    const r = await checks.run({ kind: 'command', label: 'expected', command: `${node} -e "process.exit(3)"`, expect_exit: 3 }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.PASSED);
  });

  await test('CHECK: a timeout is INCONCLUSIVE — nothing was learned about the code', async () => {
    const r = await checks.run({
      kind: 'command', label: 'slow', timeout_ms: 1000,
      command: `${node} -e "setTimeout(()=>{}, 60000)"`,
    }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.INCONCLUSIVE);
    assert.match(r.why, /timed out/);
  });

  await test('CHECK: a file check tells absence from unreadability', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'there.txt'), 'hello world');
    assert.strictEqual((await checks.run({ kind: 'file', path: 'there.txt' }, { cwd: dir })).verdict, VERDICT.PASSED);
    assert.strictEqual((await checks.run({ kind: 'file', path: 'nope.txt' }, { cwd: dir })).verdict, VERDICT.FAILED);
    assert.strictEqual((await checks.run({ kind: 'file', path: 'there.txt', contains: 'hello' }, { cwd: dir })).verdict, VERDICT.PASSED);
    assert.strictEqual((await checks.run({ kind: 'file', path: 'there.txt', contains: 'goodbye' }, { cwd: dir })).verdict, VERDICT.FAILED);
    // `must_exist: false` asserts the thing is GONE — a real requirement after
    // a migration, and the opposite of a missing file being a failure.
    assert.strictEqual((await checks.run({ kind: 'file', path: 'nope.txt', must_exist: false }, { cwd: dir })).verdict, VERDICT.PASSED);
    assert.strictEqual((await checks.run({ kind: 'file', path: 'there.txt', must_exist: false }, { cwd: dir })).verdict, VERDICT.FAILED);
  });

  await test('CHECK: an unknown kind is INCONCLUSIVE and names what IS known', async () => {
    const r = await checks.run({ kind: 'telepathy' }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.INCONCLUSIVE);
    assert.match(r.why, /unknown check kind/);
    assert.match(r.why, /tests/, 'it must say what does exist');
  });

  await test('CHECK: a runner that throws becomes INCONCLUSIVE, never an exception', async () => {
    // A verification run that dies half way produces no evidence at all, which
    // is the worst of the three answers.
    const original = checks.RUNNERS.command;
    checks.RUNNERS.command = () => { throw new Error('the check itself exploded'); };
    try {
      const r = await checks.run({ kind: 'command', command: 'x' }, { cwd: process.cwd() });
      assert.strictEqual(r.verdict, VERDICT.INCONCLUSIVE);
      assert.match(r.why, /the check itself failed/);
    } finally { checks.RUNNERS.command = original; }
  });

  await test('CHECK: a browser check with no browser in context is INCONCLUSIVE', async () => {
    const r = await checks.run({ kind: 'browser', url: 'http://127.0.0.1:1/' }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.INCONCLUSIVE);
    assert.match(r.why, /no browser harness/);
  });

  await test('CHECK: an http check against nothing is INCONCLUSIVE, not FAILED', async () => {
    // Port 1 on loopback answers nothing. "The endpoint is wrong" and "nothing
    // is listening" are different findings.
    const r = await checks.run({ kind: 'http', url: 'http://127.0.0.1:1/', timeout_ms: 800 }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.INCONCLUSIVE);
  });

  await test('CHECK: a process check with no manager is INCONCLUSIVE', async () => {
    const r = await checks.run({ kind: 'process', name: 'frontend' }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.INCONCLUSIVE);
    assert.match(r.why, /no process manager/);
  });

  await test('CHECK: a test suite that cannot be found is INCONCLUSIVE, not a red suite', async () => {
    const dir = tmp();                       // an empty directory: no tests anywhere
    const r = await checks.run({ kind: 'tests' }, { cwd: dir });
    assert.strictEqual(r.verdict, VERDICT.INCONCLUSIVE);
    assert.match(r.why, /no test suite/);
  });

  await test('CHECK: a real test run is classified by testing.js, not by a fresh regex', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'run.js'), 'console.log("3 passed, 0 failed");\n');
    const pass = await checks.run({ kind: 'tests', label: 't', command: `${node} run.js` }, { cwd: dir });
    assert.strictEqual(pass.verdict, VERDICT.PASSED);
    assert.deepStrictEqual(pass.counts, { passed: 3, failed: 0, skipped: 0 });

    fs.writeFileSync(path.join(dir, 'red.js'), 'console.log("2 passed, 1 failed"); process.exit(1);\n');
    const fail = await checks.run({ kind: 'tests', label: 't', command: `${node} red.js` }, { cwd: dir });
    assert.strictEqual(fail.verdict, VERDICT.FAILED);
    assert.strictEqual(fail.counts.failed, 1);
  });

  // ------------------------------------------------------------- the profile --

  await test('PROFILE: a contract is derived from what the project DECLARES', () => {
    const profile = require('../../src/harness/profile');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'p', scripts: { typecheck: 'tsc --noEmit', build: 'tsc -b', lint: 'eslint .', test: 'node t.js' },
    }));
    const p = profile.forProject(dir);
    assert.deepStrictEqual(p.requirements.map((r) => r.checks[0].command),
      ['npm run typecheck', 'npm run build', 'npm run lint', 'npm test'],
      'cheapest and most informative first');
    const lint = p.requirements.find((r) => r.checks[0].label === 'lint');
    assert.strictEqual(lint.required, false, 'a lint finding is worth reporting and not worth failing a bug fix over');
  });

  await test('PROFILE: it never invents a command the project does not declare', () => {
    const profile = require('../../src/harness/profile');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node t.js' } }));
    const p = profile.forProject(dir);
    const commands = p.requirements.map((r) => r.checks[0].command);
    assert.ok(!commands.some((c) => /lint|build|typecheck/.test(c)),
      `it offered ${commands.join(', ')} for a project that declares only a test script`);
  });

  await test('PROFILE: a project that declares nothing is EMPTY, and empty is not a pass', async () => {
    const profile = require('../../src/harness/profile');
    const p = profile.forProject(tmp());
    assert.strictEqual(p.empty, true);
    // And run through the engine it settles INCONCLUSIVE — never PASSED.
    const r = await verify.run({ requirements: p.requirements }, { cwd: process.cwd() });
    assert.strictEqual(r.verdict, VERDICT.INCONCLUSIVE);
  });

  await test('PROFILE: a toolchain manifest is a declaration, and is honoured', () => {
    const profile = require('../../src/harness/profile');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = \'x\'\n');
    const p = profile.forProject(dir);
    assert.ok(p.requirements.some((r) => r.checks[0].command === 'cargo build'));
  });

  // ------------------------------------------------------------- the report --

  await test('REPORT: it is greppable plain text with one line per check', () => {
    const rendered = verify.render({
      name: 'x', verdict: 'FAILED', why: 'one failed', passed: 1, failed: 1, inconclusive: 0, ms: 12,
      requirements: [
        { description: 'a', required: true, verdict: 'PASSED', checks: [{ label: 'tests', verdict: 'PASSED', why: 'ok' }] },
        { description: 'b', required: true, verdict: 'FAILED', checks: [{ label: 'browser', verdict: 'FAILED', why: 'not visible' }] },
      ],
    });
    assert.match(rendered, /^VERIFICATION FAILED/m);
    assert.match(rendered, /\[PASS\] a/);
    assert.match(rendered, /\[FAIL\] b/);
    assert.match(rendered, /browser — not visible/);
  });

  await test('REPORT: an optional requirement is marked as one', () => {
    const rendered = verify.render({
      name: 'x', verdict: 'PASSED', why: '', passed: 1, failed: 0, inconclusive: 0, ms: 1,
      requirements: [{ description: 'lint', required: false, verdict: 'FAILED', checks: [] }],
    });
    assert.match(rendered, /\(optional\)/);
  });
};
