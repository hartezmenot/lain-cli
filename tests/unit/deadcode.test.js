'use strict';

/**
 * CODE NOTHING REACHES —'s one acknowledged gap, and the traps in filling it.
 *
 * Every assertion below corresponds to a wrong answer the first version of
 * deadcode.js actually gave, which is why they are worth keeping: this is the
 * kind of tool that is easy to write and easy to have quietly lying.
 *
 *   it reported NOTHING          every export appears in its own
 *                                `module.exports` line, so everything looked
 *                                reached
 *   it reported EVERYTHING       constants a module uses throughout itself and
 *                                also exports came back as dead
 *   it said "none from           for a function called on the live path and
 *   production" about live code   also covered by a test
 *   it missed every generator    `defineRe` had no `*`, so `async function*
 *                                runTurn` was a name with no definition
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const dead = require('../../src/deadcode');
const { defineRe } = require('../../src/tools/search');

/** A tiny tree with one of each case in it. */
function tree() {
  const root = tmpdir('dead-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });

  fs.writeFileSync(path.join(root, 'src', 'alive.js'), [
    "const LIMIT = 10;",
    'function helper(n) { return n * LIMIT; }',
    'function exported(n) { return helper(n); }',
    'function orphan() { return 1; }',
    'function testedOnly() { return 2; }',
    'module.exports = { exported, orphan, testedOnly, helper, LIMIT };',
  ].join('\n'));

  fs.writeFileSync(path.join(root, 'src', 'caller.js'), [
    "const { exported } = require('./alive');",
    'function go() { return exported(2); }',
    'module.exports = { go };',
  ].join('\n'));

  fs.writeFileSync(path.join(root, 'tests', 'alive.test.js'), [
    "const { testedOnly } = require('../src/alive');",
    'testedOnly();',
  ].join('\n'));

  return root;
}

module.exports = async function () {
  await test('DEAD: something production calls is REACHED', () => {
    const root = tree();
    const files = dead.sources(root);
    const r = dead.check(root, 'exported', files);
    assert.strictEqual(r.verdict, dead.VERDICT.REACHED);
    assert.strictEqual(r.confidence, dead.CONFIDENCE.CONFIRMED);
  });

  await test('DEAD: a module\'s own export line is NOT a caller', () => {
    // The bug that made the first sweep return zero findings on a tree that
    // demonstrably contained dead code.
    const root = tree();
    const files = dead.sources(root);
    const r = dead.check(root, 'orphan', files);
    assert.strictEqual(r.verdict, dead.VERDICT.UNREFERENCED,
      `an export nothing calls must not be hidden by its own export line (got ${r.verdict})`);
    assert.deepStrictEqual(r.refs, [], 'and there is genuinely nothing to point at');
  });

  await test('DEAD: only the tests reaching it is TESTS_ONLY, and it says so', () => {
    const root = tree();
    const files = dead.sources(root);
    const r = dead.check(root, 'testedOnly', files);
    assert.strictEqual(r.verdict, dead.VERDICT.TESTS_ONLY);
    assert.strictEqual(r.confidence, dead.CONFIDENCE.CONFIRMED,
      'the tests naming it prove the search works, so the absence is a measurement');
    assert.ok(r.testRefs.length, 'and the evidence travels with the verdict');
    assert.match(r.testRefs[0].file, /tests\//);
  });

  await test('DEAD: used at home is INTERNAL_ONLY — the export is unused, the code is not', () => {
    // Reporting these as dead is the "confidently wrong in a way that costs
    // someone an afternoon" failure projecthealth.js warned about.
    const root = tree();
    const files = dead.sources(root);
    for (const name of ['helper', 'LIMIT']) {
      const r = dead.check(root, name, files);
      assert.strictEqual(r.verdict, dead.VERDICT.INTERNAL_ONLY, `${name} is alive inside its module`);
      assert.match(r.why, /the export is unused, the code is not/);
    }
  });

  await test('DEAD: a comment mentioning a name is not a reference', () => {
    // A module named only in the prose explaining why it was replaced is
    // exactly what this exists to find.
    const root = tmpdir('dead-comment-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), [
      'function ghost() { return 1; }',
      'module.exports = { ghost };',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'src', 'b.js'), [
      '// ghost used to be called from here, and is not any more.',
      '/* ghost */',
      'module.exports = {};',
    ].join('\n'));
    const r = dead.check(root, 'ghost', dead.sources(root));
    assert.strictEqual(r.verdict, dead.VERDICT.UNREFERENCED);
  });

  await test('DEAD: a word boundary, so `run` is not found inside `runTurn`', () => {
    const root = tmpdir('dead-bound-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), [
      'function run() { return 1; }',
      'module.exports = { run };',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'src', 'b.js'), [
      'function runTurn() { return 2; }',
      'const x = runTurn();',
      'module.exports = { runTurn, x };',
    ].join('\n'));
    const r = dead.check(root, 'run', dead.sources(root));
    assert.notStrictEqual(r.verdict, dead.VERDICT.REACHED,
      '`runTurn` must not count as a use of `run`');
  });

  await test('DEFINE: a generator declaration is a DEFINITION', () => {
    // `async function* runTurn` — the `*` sits between the keyword and the
    // name, so the old pattern matched nothing and the most important function
    // in turn.js was reported as defined nowhere, with every call site listed
    // as a use of something that does not exist.
    assert.ok(defineRe('runTurn').test('async function* runTurn(session, input) {'));
    assert.ok(defineRe('walk').test('function* walk(root) {'));
    assert.ok(defineRe('perform').test('async function perform(app, op) {'), 'and ordinary ones still match');
    assert.ok(!defineRe('runTurn').test('  const r = runTurn(a, b);'), 'a call is still a call');
  });

  await test('DEAD: the sweep grades an exported CONSTANT gently', () => {
    // `MAX_OUTPUT` exported so a test can assert the real value rather than a
    // copy that can drift is the export doing its job. Asserting it as dead
    // buried the handful of genuinely unwired functions under ninety rows of
    // good practice.
    const root = tmpdir('dead-const-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), [
      'const MAX_OUTPUT = 5;',
      'module.exports = { MAX_OUTPUT };',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'tests', 'a.test.js'),
      "const { MAX_OUTPUT } = require('../src/a');\nif (MAX_OUTPUT !== 5) throw new Error('x');\n");
    const r = dead.check(root, 'MAX_OUTPUT', dead.sources(root));
    assert.strictEqual(r.verdict, dead.VERDICT.TESTS_ONLY);
    assert.strictEqual(r.confidence, dead.CONFIDENCE.REVIEW, 'worth a look, not worth asserting');
  });

  await test('DEAD: nothing it reports is phrased as an instruction to delete', () => {
    // It cannot see a dynamic require, a name in a config, or a consumer
    // outside this tree, so it never gets to be sure enough to say that.
    const root = tree();
    const r = dead.sweep(root, { srcDir: 'src' });
    const text = dead.lines(r).join('\n');
    assert.ok(!/delete|remove it|safe to/i.test(text), `it told someone to delete something:\n${text}`);
    assert.ok(r.findings.length, 'and it did find the orphan');
  });
};
