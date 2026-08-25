'use strict';

/**
 * WHICH LAYER FAILED — the program, its dependencies, or the shell.
 *
 * THE DEFECT. PowerShell's diagnostic list matches `/Unexpected token/`, and
 * that is exactly what Node prints for a JavaScript syntax error:
 *
 *     node bad.js  ->  SyntaxError: Unexpected token ';'
 *
 * So a broken source FILE was classified SHELL_SYNTAX — "this shell does not
 * support that syntax". The model was told the shell was the problem, and the
 * obvious next move from there is to run the same command under a different
 * shell: the exact retry loop src/execution.js exists to prevent, aimed at the
 * wrong layer entirely.
 *
 * A missing import had the opposite failure: it collapsed into
 * APPLICATION_ERROR alongside ordinary test failures, so "install this" and
 * "the code is wrong" arrived indistinguishable.
 *
 * These run REAL interpreters against REAL broken files. A fixture of
 * remembered stderr would go stale the first time Node reworded a diagnostic,
 * and the whole point is that the words come from the machine.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, tmpdir } = require('../helpers');

const ex = require('../../src/execution');

/** Run something for real and classify what came back. */
function classifyRun(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd, windowsHide: true });
  return {
    verdict: ex.classify({
      command: `${cmd} ${args.join(' ')}`,
      exitCode: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      shell: 'powershell',
      cwd,
      startFailed: Boolean(r.error),
    }),
    ran: !r.error,
  };
}

/** Is this interpreter actually here? A skip is honest; a fake pass is not. */
function have(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true });
  return !r.error;
}

module.exports = async function () {
  const dir = tmpdir('cls-');
  fs.writeFileSync(path.join(dir, 'bad.js'), 'const x = ;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'bad.py'), 'print("hello"\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'imp.py'), 'import nosuchmodule_xyzzy\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'imp.js'), "require('nosuchmodule_xyzzy');\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'fail.js'), 'process.exit(3);\n', 'utf8');

  await test('CLASS: a JavaScript syntax error is the SOURCE, not the shell', () => {
    // The defect itself. Before the fix this was SHELL_SYNTAX, which sends the
    // model to try another shell instead of fixing the file.
    const { verdict } = classifyRun(process.execPath, ['bad.js'], dir);
    assert.strictEqual(verdict.class, 'SOURCE_ERROR');
    assert.ok(!/shell/i.test(String(verdict.fact || '')) || /not the shell/i.test(String(verdict.fact)),
      'the fact must not blame the shell');
  });

  await test('CLASS: a Python syntax error is the SOURCE too', () => {
    if (!have('python')) return;              // reported as a skip by the runner
    const { verdict } = classifyRun('python', ['bad.py'], dir);
    assert.strictEqual(verdict.class, 'SOURCE_ERROR');
  });

  await test('CLASS: a missing module is a DEPENDENCY, not a code defect', () => {
    // "install it" and "the code is wrong" are different next actions, and they
    // used to arrive as the same word.
    const { verdict } = classifyRun(process.execPath, ['imp.js'], dir);
    assert.strictEqual(verdict.class, 'DEPENDENCY_MISSING');
    assert.match(String(verdict.fact || ''), /install|resolve/i, 'and it says what to do about it');
  });

  await test('CLASS: a missing Python module is a DEPENDENCY', () => {
    if (!have('python')) return;
    const { verdict } = classifyRun('python', ['imp.py'], dir);
    assert.strictEqual(verdict.class, 'DEPENDENCY_MISSING');
  });

  await test('CLASS: an ordinary non-zero exit is still APPLICATION_ERROR', () => {
    // The categories are deliberately not finer than "what would I do next".
    // A failing test, an assertion and a plain bad exit all mean read the
    // output, and they must not be split into names nobody acts on.
    const { verdict } = classifyRun(process.execPath, ['fail.js'], dir);
    assert.strictEqual(verdict.class, 'APPLICATION_ERROR');
  });

  await test('CLASS: a REAL shell syntax error is still SHELL_SYNTAX', () => {
    // The other direction. Putting the program's diagnostics first must not
    // have taken the shell's own errors away from it.
    const v = ex.classify({
      command: 'echo a && echo b',
      exitCode: 1,
      stderr: "The token '&&' is not a valid statement separator in this version.",
      stdout: '',
      shell: 'powershell',
      cwd: dir,
    });
    assert.strictEqual(v.class, 'SHELL_SYNTAX');
  });

  await test('CLASS: a missing command is still COMMAND_NOT_FOUND', () => {
    const v = ex.classify({
      command: 'frobnicate --all',
      exitCode: 1,
      stderr: "frobnicate : The term 'frobnicate' is not recognized as the name of a cmdlet",
      stdout: '',
      shell: 'powershell',
      cwd: dir,
    });
    assert.strictEqual(v.class, 'COMMAND_NOT_FOUND');
  });

  await test('CLASS: a success is never classified as anything', () => {
    const { verdict } = classifyRun(process.execPath, ['-e', 'process.exit(0)'], dir);
    assert.strictEqual(verdict.class, 'OK');
    assert.strictEqual(ex.failureBlock(verdict, { exitCode: 0 }), '',
      'a command that worked pays nothing for any of this');
  });

  await test('CLASS: the block the MODEL reads names the classification', () => {
    // The wire, not the internal value: this string is what reaches the model.
    const { verdict } = classifyRun(process.execPath, ['bad.js'], dir);
    const block = ex.failureBlock(verdict, { exitCode: 1 });
    assert.match(block, /CLASSIFICATION: SOURCE_ERROR/);
    assert.ok(!/SHELL MISMATCH/.test(block), 'and does not add a shell note to a source problem');
  });
};
