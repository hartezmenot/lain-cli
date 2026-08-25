'use strict';

/**
 * DIAGNOSTICS BEFORE A SUITE RUN.
 *
 * The workflow being pinned:
 *
 *     PATCH APPLIED
 *          |
 *     FAST DIAGNOSTICS  (the project's own ruff / pyflakes / eslint)
 *          |
 *      errors? --- YES --> report, do not spend the suite
 *          |
 *          NO
 *          |
 *     RUN THE SUITE
 *
 * Two properties matter more than the happy path, and both are tested here:
 * a clean check must NOT be treated as proof the code works, and the gate must
 * be escapable, because a guard that can trap you is one people route around.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { test, tmpdir } = require('../helpers');
const pretest = require('../../src/pretest');

/** A checkpoint ledger shaped like the real one, holding one changed file. */
function appWith(files) {
  return {
    checkpoints: {
      entries: [{
        files: files.map((f) => ({ path: f.path, bytes: Buffer.from(f.before), existed: true })),
      }],
    },
  };
}

module.exports = async function () {
  await test('PRETEST: with nothing changed the suite runs, and nothing is checked', async () => {
    const cwd = tmpdir('pretest-none-');
    const g = await pretest.guard({ app: appWith([]) }, cwd, {});
    assert.strictEqual(g.stop, false);
    assert.strictEqual(g.checked, 0);
  });

  await test('PRETEST: with no checkpoint ledger at all it never blocks', async () => {
    // A tool context without an app is an ordinary situation — a forked job, a
    // test harness. The gate must be invisible there rather than fragile.
    const cwd = tmpdir('pretest-noapp-');
    const g = await pretest.guard({}, cwd, {});
    assert.strictEqual(g.stop, false);
  });

  await test('PRETEST: force runs the suite without checking anything', async () => {
    const cwd = tmpdir('pretest-force-');
    const file = path.join(cwd, 'a.py');
    fs.writeFileSync(file, 'pirnt("hello")\n');
    const g = await pretest.guard({ app: appWith([{ path: file, before: 'print("hello")\n' }]) }, cwd, { force: true });
    assert.strictEqual(g.stop, false, 'force must always let the suite run');
    assert.strictEqual(g.forced, true);
    assert.strictEqual(g.checked, 0, 'and it must not pay for a check it is going to ignore');
  });

  await test('PRETEST: a deleted file is not checked and does not block', async () => {
    const cwd = tmpdir('pretest-gone-');
    const missing = path.join(cwd, 'gone.py');
    const g = await pretest.guard({ app: appWith([{ path: missing, before: 'x = 1\n' }]) }, cwd, {});
    assert.strictEqual(g.stop, false);
    assert.strictEqual(g.checked, 0);
  });

  await test('PRETEST: the typo is caught before the suite is spent — or the skip is declared', async () => {
    // ---- THE CASE THE WHOLE THING EXISTS FOR ----------------------------
    //
    //     pirnt("hello")
    //
    // ruff or pyflakes says `undefined name 'pirnt'` in milliseconds. Without
    // this gate the model learns it from a stack trace, minutes and one 65,000
    // token request later.
    //
    // DECLARED, NOT SILENT. On a machine with no Python linter installed there
    // is nothing to catch it with, and this says so rather than passing quietly
    // and pretending the guarantee was checked.
    const cwd = tmpdir('pretest-typo-');
    const file = path.join(cwd, 'a.py');
    fs.writeFileSync(file, 'pirnt("hello")\n');
    const app = appWith([{ path: file, before: 'print("hello")\n' }]);

    // ---- IS THERE A CHECKER THAT ACTUALLY RUNS? -------------------------
    //
    // `checkerFor` answers "what WOULD be used", and on this machine it names
    // `python -m pyflakes` for a Python file whether or not pyflakes is
    // installed — absence is only discovered when it is executed, which is why
    // filecheck carries an `absent` pattern. So the probe has to be a real run:
    // check a file that is definitely broken and see whether anything came back.
    const probe = await require('../../src/filecheck').check(file, cwd);
    if (!probe || probe.inconclusive || !probe.rows || !probe.rows.length) {
      process.stdout.write('      (no working Python checker on this machine — NOT VERIFIED here)\n');
      return;
    }
    const g = await pretest.guard({ app }, cwd, {});
    assert.strictEqual(g.stop, true, 'a real error must stop the suite');
    const out = g.result.output;
    assert.match(out, /TESTS NOT RUN/);
    assert.match(out, /pirnt/, 'and it must name the actual problem');
    assert.match(out, /force: true/, 'and the way past it');
    // NOT AN ERROR. The gate working is not the tool failing, and marking it as
    // a failure would put a red mark on the cheapest good outcome available.
    assert.ok(!g.result.isError, 'a caught typo is the gate working, not a tool error');
    assert.strictEqual(g.result.meta.pretest, 'blocked');
  });

  await test('PRETEST: a file that does not parse stops the suite on every machine', async () => {
    // ---- THE RUNG THAT NEEDS NO TOOLING ---------------------------------
    //
    // Rung three — the project's own linter — is what catches `pirnt("hello")`,
    // and it is only there if the project actually has ruff or pyflakes
    // installed. This machine has neither, which is exactly why the gate also
    // runs rung one: does the file parse at all. That needs nothing installed,
    // so this assertion holds everywhere and is not declared-skipped.
    const cwd = tmpdir('pretest-parse-');
    const file = path.join(cwd, 'broken.js');
    const NL = String.fromCharCode(10);
    fs.writeFileSync(file, `function half( {${NL}  return 1;${NL}`);
    const before = `function half() { return 1; }${NL}`;
    const g = await pretest.guard({ app: appWith([{ path: file, before }]) }, cwd, {});
    assert.strictEqual(g.stop, true, 'an unparseable file must not reach a suite run');
    assert.match(g.result.output, /TESTS NOT RUN/);
    assert.match(g.result.output, /broken\.js/, 'and it must name the file');
    assert.match(g.result.output, /force: true/);
  });

  await test('PRETEST: correct code is not blocked — a clean check is not a claim', async () => {
    const cwd = tmpdir('pretest-clean-');
    const file = path.join(cwd, 'a.py');
    fs.writeFileSync(file, 'print("hello")\n');
    const g = await pretest.guard({ app: appWith([{ path: file, before: 'print("hi")\n' }]) }, cwd, {});
    assert.strictEqual(g.stop, false, 'nothing found means the suite runs');
    // AND THAT IS ALL IT MEANS. The gate returns no verdict about behaviour —
    // there is no `passed`, no `ok`, nothing a caller could mistake for a test
    // result. A linter can prove a file is broken; it cannot prove it works.
    assert.ok(!('passed' in g), 'the gate must not imply a test outcome');
    assert.ok(!('ok' in g));
  });

  await test('PRETEST: run_tests advertises the escape, or it is not an escape', async () => {
    const tools = require('../../src/tools/tests');
    const schema = tools.tools.run_tests.schema;
    assert.ok(schema.parameters.properties.force, 'force must be in the schema the model sees');
    assert.match(schema.parameters.properties.force.description, /diagnostics/);
  });
};
