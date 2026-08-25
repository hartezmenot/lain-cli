'use strict';

/**
 * CAN LAIN ACTUALLY DO THE WORK? — the whole loop, through the real binary.
 *
 * Every other smoke test proves one thing works. This proves the SEQUENCE
 * works, which is a different claim and the one that matters:
 *
 *     find the tests → run them → see them fail → read the code
 *       → change it → run them again → see them pass → report
 *
 * WHAT IS REAL HERE. bin/lain.js is spawned as a process. The REPL, session,
 * turn loop, tool dispatch, filesystem gate, edit tools, test discovery, the
 * shell that runs the fixture's suite, and the fixture's own tests are all the
 * real thing, and the file really changes on disk.
 *
 * WHAT IS NOT. The model's CHOICES are scripted (see mockprovider.js), because
 * a provider makes this slow, non-hermetic and expensive. So a green run here
 * is LIVE CLI VERIFIED — it proves LAIN can carry out the workflow. It is NOT
 * LIVE PROVIDER VERIFIED and never proves a model would choose to.
 *
 * ------------------------------------------------------------------------
 * THE PROPERTY WORTH THE MOST, and the reason this is a whole file: the loop
 * must NOT STOP AFTER THE FIRST SUCCESSFUL EDIT. A turn that writes a fix and
 * ends there is the single most common way an agent reports success over a
 * broken tree — the edit really happened, so nothing is technically false, and
 * the suite is still red. So the fixture's tests are run INDEPENDENTLY at the
 * end, by this file, against the bytes LAIN actually left behind.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { test, runCli, tmpdir } = require('../helpers');

/**
 * A project with ONE REAL BUG in it.
 *
 * `slug('Hello World')` must be `hello-world`. The split is on the wrong thing,
 * so it returns `hello world`. The fixture's own test catches it and exits
 * non-zero, printing counts in the shape a real runner prints them.
 */
function fixture() {
  const dir = tmpdir('lain-agentloop-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'slugger', version: '1.0.0', scripts: { test: 'node test.js' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'src', 'slug.js'), [
    "'use strict';",
    '',
    'function slug(s) {',
    '  return String(s).toLowerCase().split(/,/).join("-");',
    '}',
    '',
    'module.exports = { slug };',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'test.js'), [
    "'use strict';",
    "const assert = require('assert');",
    "const { slug } = require('./src/slug');",
    'let passed = 0; let failed = 0;',
    'const t = (name, fn) => { try { fn(); passed++; } catch (e) {',
    '  failed++; console.log("FAIL " + name + ": " + e.message); } };',
    't("lowercases", () => assert.strictEqual(slug("HELLO"), "hello"));',
    't("hyphenates spaces", () => assert.strictEqual(slug("Hello World"), "hello-world"));',
    'console.log(passed + " passed, " + failed + " failed");',
    'process.exit(failed ? 1 : 0);',
    '',
  ].join('\n'));
  return dir;
}

/** Run the fixture's own suite, with nothing of LAIN's involved. */
function runFixtureTests(dir) {
  const r = spawnSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** The model's decisions. Every tool below is the real one. */
const SCRIPT = [
  // 1. What tests does this project have? (Not "are there any" — a search.)
  { text: 'Checking what this project has.', tool_calls: [{ name: 'discover_tests', input: {} }] },
  // 2. Run them, and see the failure before touching anything.
  { tool_calls: [{ name: 'run_tests', input: {} }] },
  // 3. Read the code the failure points at.
  { text: 'The hyphenation case fails. Reading the implementation.', tool_calls: [{ name: 'read_file', input: { path: 'src/slug.js' } }] },
  // 4. Fix the one thing that is wrong.
  {
    tool_calls: [{
      name: 'edit_file',
      input: { path: 'src/slug.js', old: 'split(/,/)', new: 'split(/\\s+/)' },
    }],
  },
  // 5. AND RUN THEM AGAIN. This step is the whole point of the file.
  { tool_calls: [{ name: 'run_tests', input: {} }] },
  // 6. Report.
  // The regex is NOT repeated in this prose. The architecture guard scans for a
  // regex literal that has lost a backslash, and a doubled one inside a string
  // wears exactly that shape — see architecture.test.js. The edit above is
  // where the pattern belongs; a summary does not need to quote it.
  { text: 'Issue: slug() split on commas instead of whitespace.\nFix: it now splits on whitespace.\nVerification: npm test — 2 passed, 0 failed.\nHow to test: npm test' },
];

module.exports = async function () {
  await test('AGENT LOOP: red → read → edit → green, end to end through the real binary', async () => {
    const dir = fixture();

    // THE FIXTURE REALLY IS BROKEN BEFORE LAIN TOUCHES IT. Without this the
    // whole test could pass against a suite that was green all along.
    const before = runFixtureTests(dir);
    assert.notStrictEqual(before.code, 0, 'the fixture must start red, or this proves nothing');
    assert.match(before.out, /1 passed, 1 failed/);

    const r = await runCli(['-p', 'the slug helper is wrong — find it, fix it, and prove it'], {
      cwd: dir, script: SCRIPT, timeoutMs: 120000,
    });

    // ---- IT FOUND THE TESTS RATHER THAN GUESSING --------------------------
    assert.match(r.out, /TESTS_FOUND_NOT_RUN/,
      `discovery never reported what exists:\n${r.out.slice(0, 1500)}`);

    // ---- IT SAW THEM FAIL, THEN SAW THEM PASS -----------------------------
    const failedAt = r.out.indexOf('TESTS_FAILED');
    const passedAt = r.out.indexOf('TESTS_PASSED');
    assert.ok(failedAt >= 0, `the first run should have reported a real failure:\n${r.out.slice(0, 2000)}`);
    assert.ok(passedAt >= 0, `the second run never reported a pass:\n${r.out.slice(0, 2000)}`);
    assert.ok(failedAt < passedAt, 'the failure must come before the pass, or the loop did not happen');

    // ---- THE BYTES ON DISK REALLY CHANGED ---------------------------------
    const after = fs.readFileSync(path.join(dir, 'src', 'slug.js'), 'utf8');
    assert.ok(!after.includes('split(/,/)'), 'the bug is still in the file');
    assert.ok(/split\(\/\\s\+\/\)/.test(after), `the fix is not in the file:\n${after}`);

    // ---- AND THE PROJECT'S OWN SUITE AGREES, RUN BY THIS FILE -------------
    //
    // The claim being checked is not "LAIN said it passed" — it is that the
    // tree LAIN left behind actually passes, measured by something LAIN had no
    // part in.
    const verdict = runFixtureTests(dir);
    assert.strictEqual(verdict.code, 0, `the tree LAIN left behind is still red:\n${verdict.out}`);
    assert.match(verdict.out, /2 passed, 0 failed/);
  });

  await test('AGENT LOOP: it does NOT stop after the first successful edit', async () => {
    // The most common way an agent reports success over a broken tree: the edit
    // really happened, so nothing it said was false, and the suite is still red.
    // Scripted to stop right after the edit — LAIN must not present that as a
    // verified result.
    const dir = fixture();
    const stopEarly = SCRIPT.slice(0, 4).concat([{ text: 'Fixed it.' }]);
    const r = await runCli(['-p', 'fix the slug helper'], { cwd: dir, script: stopEarly, timeoutMs: 120000 });

    // The edit happened...
    const after = fs.readFileSync(path.join(dir, 'src', 'slug.js'), 'utf8');
    assert.ok(!after.includes('split(/,/)'), 'the edit should still have been applied');
    // ...and nothing anywhere claimed the tests passed, because none were run
    // after it. TESTS_FAILED from the FIRST run may legitimately appear.
    assert.ok(!r.out.includes('TESTS_PASSED'),
      `a green result was reported without a run to back it:\n${r.out.slice(0, 1500)}`);
  });

  await test('AGENT LOOP: a project with no tests is told so, not guessed at', async () => {
    // The other half of the false report. An empty tree must produce
    // NO_TESTS_FOUND with the search behind it — never silence, which reads
    // identically to a clean result.
    const dir = tmpdir('lain-agentloop-empty-');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'nothing here');
    const r = await runCli(['-p', 'are there tests?'], {
      cwd: dir,
      script: [{ tool_calls: [{ name: 'discover_tests', input: {} }] }, { text: 'No test infrastructure in this tree.' }],
      timeoutMs: 60000,
    });
    assert.match(r.out, /NO_TESTS_FOUND/, r.out.slice(0, 1200));
    assert.match(r.out, /checked:/, 'an absence must be reported with the search that found it');
  });

  await test('AGENT LOOP: LAIN can find its OWN tests — the reported regression', async () => {
    // "There are no tests" said about this repository, which has 179 of them.
    const root = path.join(__dirname, '..', '..');
    // AN ISOLATED CONFIG HOME, because `cwd` here is the repository itself and
    // the harness would otherwise write `.config/` into the working tree.
    const r = await runCli(['-p', 'what tests does this project have?'], {
      cwd: root,
      configDir: tmpdir('lain-agentloop-cfg-'),
      script: [{ tool_calls: [{ name: 'discover_tests', input: {} }] }, { text: 'Listed above.' }],
      timeoutMs: 90000,
    });
    assert.match(r.out, /TESTS_FOUND_NOT_RUN/, r.out.slice(0, 1200));
    assert.match(r.out, /npm test/);
    // THE HONESTY LINE MUST SURVIVE CLIPPING. Tool output is truncated for the
    // feed, so this being present proves it is near the top rather than in the
    // part that gets cut — which is where it was, and where it was useless.
    assert.match(r.out, /NOTHING HAS BEEN RUN/, `discovery must never imply a result:
${r.out.slice(0, 1500)}`);
  });
};
