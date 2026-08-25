'use strict';

/**
 * THE TWO FALSE TEST REPORTS, MADE UNREACHABLE.
 *
 *   "There are no tests."   about a tree with a suite in it
 *   "All tests pass."       about a run that never happened
 *
 * Both were sayable because discovery and execution shared one word. These
 * check that they no longer do: `discover` cannot reach a passing state however
 * it is called, and `classifyRun` cannot reach one from a run that was blocked,
 * timed out, or executed nothing.
 *
 * The third property here is the one that costs real money when it is missing:
 * a suite stopped by a provider rate limit exits non-zero exactly like a
 * failing assertion, and a model that cannot tell them apart edits working code
 * until the quota returns.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { test, tmpdir } = require('../helpers');
const T = require('../../src/testing');

/** A throwaway project tree. */
function project(files) {
  const dir = tmpdir('lain-testing-');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

module.exports = async function () {
  // ---- DISCOVERY CANNOT CLAIM A PASS -------------------------------------

  await test('DISCOVER: an empty tree is NO_TESTS_FOUND — and says where it looked', () => {
    const dir = project({ 'readme.md': 'nothing here' });
    const r = T.discover(dir);
    assert.strictEqual(r.state, T.STATE.NO_TESTS_FOUND);
    assert.strictEqual(r.found, false);
    assert.ok(r.searched.includes('package.json'), 'must record that package.json was checked');
    assert.ok(r.searched.includes('pytest.ini'), 'must record that pytest.ini was checked');
    const text = T.lines(r).join('\n');
    assert.ok(text.includes('looked in'), 'an absence must be reported with its search');
    assert.ok(!text.includes('NOTHING HAS BEEN RUN'), 'there is nothing to run — that line would be noise');
  });

  await test('DISCOVER: NO STATE IT RETURNS CAN EVER MEAN THE TESTS PASSED', () => {
    // The whole point of the split. Whatever the tree contains, discovery has
    // spawned nothing, so a green state must be unreachable from here.
    const trees = [
      { 'readme.md': 'x' },
      { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) },
      { 'tests/a.test.js': 'x', 'pytest.ini': '[pytest]' },
    ];
    for (const files of trees) {
      const r = T.discover(project(files));
      assert.ok(!T.RAN.has(r.state), `discovery reached ${r.state}, which implies a run`);
      assert.ok(
        r.state === T.STATE.NO_TESTS_FOUND || r.state === T.STATE.TESTS_FOUND_NOT_RUN,
        `discovery reached ${r.state}`,
      );
    }
  });

  await test('DISCOVER: a package.json test script is found, with the line that proves it', () => {
    const dir = project({ 'package.json': JSON.stringify({ scripts: { test: 'node run.js' } }) });
    const r = T.discover(dir);
    assert.strictEqual(r.state, T.STATE.TESTS_FOUND_NOT_RUN);
    const p = T.primary(r);
    assert.strictEqual(p.command, 'npm test');
    assert.strictEqual(p.from, 'package.json');
    assert.ok(p.why.includes('node run.js'), 'the evidence must quote the script it read');
  });

  await test('DISCOVER: npm hook scripts are not offered as suites of their own', () => {
    const dir = project({
      'package.json': JSON.stringify({ scripts: { pretest: 'build', test: 'jest', posttest: 'clean' } }),
    });
    const r = T.discover(dir);
    assert.deepStrictEqual(r.suites.map((s) => s.command), ['npm test']);
  });

  await test('DISCOVER: lint is not a test suite', () => {
    // A green linter is not a green suite, and folding it in is one of the
    // routes by which "all tests pass" gets said about a run with no test in it.
    const dir = project({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }) });
    const r = T.discover(dir);
    assert.strictEqual(r.suites.length, 0);
  });

  await test('DISCOVER: smoke suites are kept apart from the project suite', () => {
    const dir = project({
      'package.json': JSON.stringify({ scripts: { test: 'node r.js', 'test:smoke': 'node r.js smoke' } }),
    });
    const r = T.discover(dir);
    const smoke = r.suites.filter((s) => s.kind === T.KIND.SMOKE);
    const proj = r.suites.filter((s) => s.kind === T.KIND.PROJECT);
    assert.strictEqual(smoke.length, 1, 'the smoke suite must be identifiable as one');
    assert.strictEqual(proj.length, 1);
    assert.strictEqual(T.primary(r).command, 'npm test', 'primary must be the real suite');
  });

  await test('DISCOVER: test FILES count even when nothing declares a runner', () => {
    // The exact shape of the false report: files exist, no manifest names them,
    // and the honest answer is "there are tests and no way to run them" — not
    // "there are no tests".
    const dir = project({ 'tests/parser.test.js': 'x', 'tests/lexer.test.js': 'x' });
    const r = T.discover(dir);
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.state, T.STATE.TESTS_FOUND_NOT_RUN);
    assert.strictEqual(r.files.count, 2);
    assert.strictEqual(r.runnerMissing, true);
    assert.ok(T.lines(r).join('\n').includes('NO RUNNER DECLARED'));
  });

  await test('DISCOVER: node_modules is never walked', () => {
    const dir = project({
      'node_modules/pkg/index.test.js': 'x',
      'src/real.test.js': 'x',
    });
    const r = T.discover(dir);
    assert.strictEqual(r.files.count, 1, 'a dependency\'s own tests are not this project\'s');
  });

  await test('DISCOVER: the manifests of other ecosystems are recognised', () => {
    for (const [file, command] of [
      ['pytest.ini', 'pytest'],
      ['Cargo.toml', 'cargo test'],
      ['go.mod', 'go test ./...'],
    ]) {
      const r = T.discover(project({ [file]: 'x' }));
      assert.ok(r.suites.some((s) => s.command === command), `${file} should yield ${command}`);
    }
  });

  await test('DISCOVER: a Makefile is a runner only if it has a test target', () => {
    assert.strictEqual(T.discover(project({ Makefile: 'build:\n\tcc a.c\n' })).found, false);
    const r = T.discover(project({ Makefile: 'test:\n\t./run\n' }));
    assert.ok(r.suites.some((s) => s.command === 'make test'));
  });

  await test('DISCOVER: this repository is found, with its real suite', () => {
    // The regression itself: LAIN reporting that LAIN has no tests.
    const r = T.discover(path.join(__dirname, '..', '..'));
    assert.strictEqual(r.state, T.STATE.TESTS_FOUND_NOT_RUN);
    assert.ok(r.files.count > 100, `only found ${r.files.count} test files in LAIN's own tree`);
    assert.strictEqual(T.primary(r).command, 'npm test');
  });

  // ---- A RUN THAT HAPPENED -----------------------------------------------

  await test('RUN: exit 0 with a count is TESTS_PASSED', () => {
    const v = T.classifyRun({ code: 0, output: '1556 passed, 0 failed  (28.5s)' });
    assert.strictEqual(v.state, T.STATE.TESTS_PASSED);
    assert.strictEqual(v.counts.passed, 1556);
  });

  await test('RUN: exit non-zero with failures is TESTS_FAILED', () => {
    const v = T.classifyRun({ code: 1, output: '40 passed, 3 failed' });
    assert.strictEqual(v.state, T.STATE.TESTS_FAILED);
    assert.strictEqual(v.counts.failed, 3);
    assert.strictEqual(v.layer, null, 'a genuine failure names no external layer');
  });

  await test('RUN: A RATE LIMIT IS NOT A FAILING TEST', () => {
    // The distinction that costs the most when it is missing: this exits 1
    // exactly like a broken assertion, and the correct response is to change
    // nothing at all.
    const v = T.classifyRun({ code: 1, output: 'Error: 429 Too Many Requests from the provider' });
    assert.strictEqual(v.state, T.STATE.TESTS_BLOCKED);
    assert.ok(/rate limit/i.test(v.layer), `layer was ${v.layer}`);
  });

  await test('RUN: an exhausted quota is BLOCKED, and names billing rather than the code', () => {
    const v = T.classifyRun({ code: 1, output: 'insufficient credit — quota exhausted for this key' });
    assert.strictEqual(v.state, T.STATE.TESTS_BLOCKED);
    assert.ok(/quota|billing/i.test(v.layer));
  });

  await test('RUN: real results beside a blocker are PARTIAL, not BLOCKED', () => {
    // 1745 genuine results must not be thrown away because 3 could not run.
    const v = T.classifyRun({ code: 1, output: '1745 passed\n3 blocked: 429 rate limited' });
    assert.strictEqual(v.state, T.STATE.TESTS_PARTIAL);
    assert.strictEqual(v.counts.passed, 1745);
  });

  await test('RUN: a missing runner is BLOCKED, from the execution layer\'s own verdict', () => {
    const v = T.classifyRun({ code: 127, output: 'x', classification: 'COMMAND_NOT_FOUND' });
    assert.strictEqual(v.state, T.STATE.TESTS_BLOCKED);
    assert.ok(/not installed/.test(v.layer));
  });

  await test('RUN: a missing dependency is BLOCKED, not a code failure', () => {
    const v = T.classifyRun({ code: 1, output: 'ModuleNotFoundError: No module named "pytest"' });
    assert.strictEqual(v.state, T.STATE.TESTS_BLOCKED);
  });

  await test('RUN: a timeout is BLOCKED — nothing was learned about the code', () => {
    const v = T.classifyRun({ code: null, timedOut: true, output: 'partial output' });
    assert.strictEqual(v.state, T.STATE.TESTS_BLOCKED);
  });

  await test('RUN: an interrupt is BLOCKED, and is never reported as a failure', () => {
    const v = T.classifyRun({ interrupted: true, output: '[interrupted by the user]' });
    assert.strictEqual(v.state, T.STATE.TESTS_BLOCKED);
  });

  await test('RUN: EXIT ZERO WITH NOTHING RUN IS NOT A PASS', () => {
    // Several runners exit 0 when they collect no tests. Calling that green is
    // the "all tests pass" false report reached by a different route.
    const v = T.classifyRun({ code: 0, output: 'collected 0 items\n0 passed, 0 failed' });
    assert.strictEqual(v.state, T.STATE.TESTS_BLOCKED);
  });

  await test('RUN: skips make it PARTIAL, so a skipped suite never reads as green', () => {
    const v = T.classifyRun({ code: 0, output: '10 passed, 4 skipped' });
    assert.strictEqual(v.state, T.STATE.TESTS_PARTIAL);
    assert.strictEqual(v.counts.skipped, 4);
  });

  await test('RUN: exitCode and code are the same number under two names', () => {
    // Both runners in this tree exist and they spell it differently; reading
    // only one would turn every pass into NaN !== 0 and therefore a failure.
    assert.strictEqual(T.classifyRun({ exitCode: 0, output: '5 passed' }).state, T.STATE.TESTS_PASSED);
    assert.strictEqual(T.classifyRun({ code: 0, output: '5 passed' }).state, T.STATE.TESTS_PASSED);
  });

  await test('RUN: a passing suite that merely MENTIONS a limit is still passing', () => {
    // A test named "handles rate limiting" must not turn a green run amber.
    const v = T.classifyRun({ code: 0, output: '✓ retries when rate limited\n42 passed, 0 failed' });
    assert.strictEqual(v.state, T.STATE.TESTS_PASSED);
  });

  // ---- WHAT THE MODEL IS TOLD --------------------------------------------

  await test('PROMPT: the environment block names the suite and the file count', () => {
    const line = T.promptLine(path.join(__dirname, '..', '..'));
    assert.ok(line.includes('npm test'), line);
    assert.ok(/\d+ test files/.test(line), line);
  });

  await test('PROMPT: a project with no tests contributes no line at all', () => {
    // An empty heading costs tokens on every request to say nothing.
    assert.strictEqual(T.promptLine(project({ 'a.txt': 'x' })), '');
  });

  await test('PROMPT: the tools are registered and reachable by name', () => {
    const reg = require('../../src/tools');
    assert.ok(reg.has('discover_tests'), 'discover_tests must be dispatchable');
    assert.ok(reg.has('run_tests'), 'run_tests must be dispatchable');
    const named = reg.schemas().map((s) => s.name);
    assert.ok(named.includes('discover_tests'), 'and advertised, or the model never calls it');
    assert.ok(named.includes('run_tests'));
  });

  await test('TOOL: discover_tests reports LAIN\'s own suite through the registry', async () => {
    const reg = require('../../src/tools');
    const r = await reg.execute('discover_tests', {}, { cwd: path.join(__dirname, '..', '..') });
    assert.ok(!r.isError, r.output);
    assert.ok(r.output.startsWith('TESTS_FOUND_NOT_RUN'), r.output.slice(0, 120));
    assert.ok(r.output.includes('npm test'));
    // SECOND LINE, so it survives the feed's clipping of long tool output — at
    // the bottom it was the first thing cut, which is exactly backwards.
    const head = r.output.split('\n').slice(0, 2).join('\n');
    assert.ok(head.includes('NOTHING HAS BEEN RUN'), `the honesty line must be near the top:\n${r.output}`);
    assert.strictEqual(r.meta.testState, 'TESTS_FOUND_NOT_RUN');
  });

  await test('TOOL: run_tests names the LAYER when there is one', async () => {
    const reg = require('../../src/tools');
    const dir = project({
      'package.json': JSON.stringify({ scripts: { test: 'node t.js' } }),
      't.js': 'console.log("Error: 429 Too Many Requests");process.exit(1);',
    });
    const r = await reg.execute('run_tests', {}, { cwd: dir });
    assert.strictEqual(r.meta.testState, T.STATE.TESTS_BLOCKED);
    assert.ok(r.output.includes('THIS IS NOT A CODE FAILURE'), r.output.slice(0, 400));
    assert.ok(/rate limit/.test(r.output));
  });

  await test('TOOL: run_tests does NOT invent a layer when there is none', async () => {
    // A skipped-but-otherwise-green run is also PARTIAL, and it names nothing.
    // Keyed on the state rather than the layer, this printed "the layer that
    // stopped it is null" — a sentence worse than silence, because it sends the
    // model looking for something that does not exist.
    const reg = require('../../src/tools');
    const dir = project({
      'package.json': JSON.stringify({ scripts: { test: 'node t.js' } }),
      't.js': 'console.log("10 passed, 4 skipped");',
    });
    const r = await reg.execute('run_tests', {}, { cwd: dir });
    assert.strictEqual(r.meta.testState, T.STATE.TESTS_PARTIAL);
    assert.ok(!/null/.test(r.output), `a layer was invented:\n${r.output.slice(0, 400)}`);
    assert.ok(r.output.includes('SKIPPED'), r.output.slice(0, 400));
    assert.ok(!r.isError, 'a skipped run is not an error result — what ran did pass');
  });

  await test('TOOL: run_tests with nothing to run says so, and runs nothing', async () => {
    const reg = require('../../src/tools');
    const r = await reg.execute('run_tests', {}, { cwd: project({ 'a.txt': 'x' }) });
    assert.strictEqual(r.meta.testState, T.STATE.NO_TESTS_FOUND);
    assert.ok(r.output.includes('Nothing was run'), r.output.slice(0, 300));
  });

  // ---- A GREEN SUITE'S PER-TEST LINES ARE NOT EVIDENCE --------------------
  //
  // Measured on this project's own unit tier: 132,846 characters of output, of
  // which 1,973 lines were one tick and the name of a test that passed. The
  // classifier had already reduced all of it to `counts: 1974 passed, 0 failed`
  // before any of it was sent. What these guard is the DIRECTION of the trade —
  // that only confirmations of success go, and only when nothing failed.
  const { quietPass } = require('../../src/tools/tests');
  const bulk = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

  await test('QUIET: a passing run loses its per-test ticks and keeps its summary', () => {
    const out = `UNIT\n${bulk(200, (i) => `  ✓ THING: case number ${i} behaves`)}\n\n200 passed, 0 failed  (4.2s)\n`;
    const q = quietPass(out);
    assert.ok(q.dropped >= 200, `expected the ticks to go, dropped ${q.dropped}`);
    assert.ok(q.text.includes('200 passed, 0 failed'), 'the runner\'s own verdict must survive');
    assert.ok(q.text.includes('UNIT'), 'structure around the ticks must survive');
    assert.ok(q.text.length < out.length / 5, 'it must actually be smaller');
  });

  await test('QUIET: anything that is NOT a passing tick survives untouched', () => {
    const out = `UNIT\n${bulk(120, (i) => `  ✓ ok ${i}`)}\n`
      + 'DeprecationWarning: punycode is deprecated\n'
      + '  ✓ last one\nnpm WARN something odd\n120 passed, 0 failed\n';
    const q = quietPass(out);
    assert.ok(q.text.includes('DeprecationWarning: punycode is deprecated'), 'a warning is evidence and must stay');
    assert.ok(q.text.includes('npm WARN something odd'));
  });

  await test('QUIET: a runner it does not recognise is left exactly alone', () => {
    const out = `header\n${bulk(200, (i) => `<<< finished scenario ${i} >>>`)}\n`;
    const q = quietPass(out);
    assert.strictEqual(q.dropped, 0, 'an unrecognised shape must not be touched');
    assert.strictEqual(q.text, out);
  });

  await test('QUIET: a short output is left alone — there is nothing to save', () => {
    const out = '  ✓ one\n  ✓ two\n2 passed, 0 failed\n';
    const q = quietPass(out);
    assert.strictEqual(q.dropped, 0);
    assert.strictEqual(q.text, out);
  });

  await test('QUIET: a FAILING run is never quietened — failure output is the evidence', async () => {
    const reg = require('../../src/tools');
    const dir = project({
      'package.json': JSON.stringify({ scripts: { test: 'node t.js' } }),
      't.js': `console.log('SUITE');\n${bulk(200, (i) => `console.log('  \\u2713 GROUP: scenario ${i} behaves the way it was written to')`)};\n`
        + "console.log('  x case BROKEN: expected 1 to equal 2');\nconsole.log('200 passed, 1 failed');\nprocess.exit(1);\n",
    });
    const r = await reg.execute('run_tests', {}, { cwd: dir });
    assert.strictEqual(r.meta.testState, T.STATE.TESTS_FAILED);
    assert.ok(r.output.includes('case BROKEN'), 'the failing case must be in the result');
    assert.ok(!/passing test line\(s\) removed/.test(r.output),
      'a failing run must be returned whole — nothing removed, nothing claimed removed');
    assert.ok(r.output.includes('scenario 7'), 'even the passing ticks stay when something failed');
  });

  await test('QUIET: a PASSING run through the real tool says what it removed', async () => {
    const reg = require('../../src/tools');
    const dir = project({
      'package.json': JSON.stringify({ scripts: { test: 'node t.js' } }),
      't.js': `console.log('SUITE');\n${bulk(200, (i) => `console.log('  \\u2713 GROUP: scenario ${i} behaves the way it was written to')`)};\n`
        + "console.log('200 passed, 0 failed');\n",
    });
    const r = await reg.execute('run_tests', {}, { cwd: dir });
    assert.strictEqual(r.meta.testState, T.STATE.TESTS_PASSED);
    assert.ok(/passing test line\(s\) removed/.test(r.output), 'an elision must be declared, never silent');
    assert.ok(r.output.includes('200 passed, 0 failed'), 'the verdict survives');
    assert.ok(/counts: 200 passed/.test(r.output), 'the classified counts are still the headline');
  });

  await test('TOOL: discover_tests on an empty tree says NO_TESTS_FOUND, with its search', async () => {
    const reg = require('../../src/tools');
    const dir = project({ 'a.txt': 'x' });
    const r = await reg.execute('discover_tests', {}, { cwd: dir });
    assert.ok(r.output.startsWith('NO_TESTS_FOUND'), r.output.slice(0, 120));
    assert.ok(r.output.includes('checked:'), 'it must show where it looked');
  });
};
