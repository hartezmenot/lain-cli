'use strict';

/**
 * PYTHON AND PROGRAMS — and the measured reason they are not shell commands.
 *
 * `run_bash "python x.py"` runs a SHELL, which parses the line by its own
 * rules and returns ITS exit code. The claim that this matters is not taken on
 * faith here: the first test MEASURES the divergence on this machine, so if a
 * future shell stops flattening exit codes the test says so rather than
 * asserting a stale justification forever.
 *
 * Observed 2026-08-21, Windows:
 *   powershell -Command "python -c 'sys.exit(3)'"  → exit 1   (flattened)
 *   python -c "sys.exit(3)"  spawned directly      → exit 3   (true)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const exec = require('../../src/tools/exec');
const shell = require('../../src/tools/shell');
const tools = exec.tools;

const cfgWithPython = () => {
  const found = exec.findPython({});
  return found.ok ? {} : null;
};

module.exports = async function () {
  const py = exec.findPython({});
  if (!py.ok) {
    process.stdout.write(`  ~ NOT VERIFIED: no Python on this machine — ${py.why}\n`);
  }

  await test('EXEC: a program is spawned DIRECTLY — pid and exit code are its own', async () => {
    const r = await exec.execute(process.execPath, ['-e', 'process.exit(3)'], { cwd: process.cwd() });
    assert.strictEqual(r.exitCode, 3, 'the true exit code, not a shell\'s idea of it');
    assert.ok(r.pid > 0, 'and the real pid, not a shell\'s');
    assert.strictEqual(r.ok, false);
  });

  await test('EXEC: the shell really does flatten what direct execution preserves', async () => {
    // The measurement the module's existence rests on. If this ever stops
    // being true, this test fails and the justification gets revisited.
    const direct = await exec.execute(process.execPath, ['-e', 'process.exit(3)'], { cwd: process.cwd() });
    assert.strictEqual(direct.exitCode, 3);
    if (process.platform === 'win32') {
      const viaShell = await shell.run('node -e "process.exit(3)"', { shell: 'powershell', cwd: process.cwd() });
      assert.notStrictEqual(viaShell.exitCode, direct.exitCode,
        'if PowerShell no longer flattens exit codes, this justification is stale');
      process.stdout.write(`    · direct exit ${direct.exitCode} · via PowerShell exit ${viaShell.exitCode}\n`);
    }
  });

  await test('EXEC: stdout and stderr are kept APART — a traceback is not a result', async () => {
    const r = await exec.execute(process.execPath,
      ['-e', 'console.log("answer"); console.error("a warning")'], { cwd: process.cwd() });
    assert.match(r.stdout, /answer/);
    assert.match(r.stderr, /a warning/);
    assert.ok(!r.stdout.includes('a warning'), 'they must not be merged');
    const text = exec.report('x', r);
    assert.ok(text.indexOf('--- stdout ---') < text.indexOf('--- stderr ---'), 'and labelled in the report');
  });

  await test('EXEC: a path with SPACES needs no quoting, because no shell sees it', async () => {
    // The failure this prevents: quoting rules that differ per shell, applied
    // by a model that cannot know which shell it got.
    const dir = tmpdir('has space-');
    const file = path.join(dir, 'my script.js');
    fs.writeFileSync(file, 'console.log("ran from a spaced path")', 'utf8');
    const r = await exec.execute(process.execPath, [file], { cwd: dir });
    assert.strictEqual(r.exitCode, 0, `it must just run: ${r.stderr || r.error}`);
    assert.match(r.stdout, /ran from a spaced path/);
  });

  await test('EXEC: a timeout is reported as a timeout, with what it printed first', async () => {
    const r = await exec.execute(process.execPath,
      ['-e', 'console.log("before"); setTimeout(()=>{}, 30000)'], { cwd: process.cwd(), timeoutMs: 700 });
    assert.strictEqual(r.timedOut, true);
    assert.strictEqual(r.ok, false);
    assert.match(r.stdout, /before/, 'what it managed to print survives');
  });

  await test('EXEC: output is bounded and truncation is announced', async () => {
    const r = await exec.execute(process.execPath,
      ['-e', `process.stdout.write("x".repeat(${exec.MAX_OUTPUT + 50000}))`], { cwd: process.cwd() });
    assert.ok(r.stdout.length <= exec.MAX_OUTPUT);
    assert.strictEqual(r.truncated, true);
    assert.match(exec.report('x', r), /truncated/);
  });

  await test('PROCESS: a missing program is said plainly, not as a shell error', async () => {
    const r = await tools.process_run.run({ program: 'definitely-not-a-real-program-9931' }, { cwd: process.cwd() });
    assert.strictEqual(r.isError, true);
    assert.match(r.output, /no such program/);
    assert.match(r.output, /not on PATH/);
  });

  await test('PROCESS: arguments are a LIST — an argument with spaces stays ONE argument', async () => {
    // The failure this prevents: a shell re-splitting `two words` into two
    // arguments, which is where per-shell quoting bugs come from.
    const r = await tools.process_run.run({
      program: process.execPath,
      args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'two words', 'a|b && c'],
    }, { cwd: process.cwd() });
    assert.strictEqual(r.exitCode, 0, r.output);
    // WAS `/(\[.*\])/`, which matched the FIRST bracketed thing in the output.
    // Results now carry a `[via process: …]` stamp naming the mechanism that
    // ran them (), and that is bracketed too. Anchored on a
    // quote, so it can only match the JSON the program actually printed.
    const got = JSON.parse(/(\["[\s\S]*\])/.exec(r.output)[1]);
    assert.deepStrictEqual(got, ['two words', 'a|b && c'],
      'each argument must arrive whole, with its spaces and shell metacharacters intact');
    assert.match(tools.process_run.schema.parameters.properties.args.description, /one per element/);
  });

  await test('PYTHON: with none configured it says NOT CONFIGURED and never falls back to a shell', async () => {
    // Falling back would put the confusion straight back.
    const saved = process.env.PATH;
    const savedPy = process.env.LAIN_PYTHON;
    try {
      process.env.PATH = tmpdir('empty-');
      delete process.env.LAIN_PYTHON;
      const r = await tools.python_run.run({ code: 'print(1)' }, { cwd: process.cwd(), app: { cfg: {} } });
      assert.strictEqual(r.isError, true);
      assert.match(r.output, /PYTHON NOT CONFIGURED/);
      assert.match(r.output, /Looked for:/, 'and says where it looked');
    } finally {
      process.env.PATH = saved;
      if (savedPy) process.env.LAIN_PYTHON = savedPy;
    }
  });

  await test('PYTHON: the CONFIGURED interpreter wins over whatever is on PATH', () => {
    // A machine with three Pythons has one with the project's packages in it.
    const found = exec.findPython({ python: { exe: process.execPath } });
    assert.strictEqual(found.exe, process.execPath);
    assert.strictEqual(found.source, 'config');
    // `probe.python` is reused deliberately: the user already told LAIN where a
    // working interpreter is, and asking twice makes two answers to one question.
    const viaProbe = exec.findPython({ probe: { python: process.execPath } });
    assert.strictEqual(viaProbe.exe, process.execPath);
  });

  if (py.ok) {
    await test('PYTHON LIVE: a snippet runs and its real exit code comes back', async () => {
      const ctx = { cwd: process.cwd(), app: { cfg: {} } };
      const ok = await tools.python_run.run({ code: 'print("hello from python")' }, ctx);
      assert.strictEqual(ok.exitCode, 0, ok.output);
      assert.match(ok.output, /hello from python/);

      const bad = await tools.python_run.run({ code: 'import sys; sys.exit(3)' }, ctx);
      assert.strictEqual(bad.exitCode, 3, `the real exit code: ${bad.output}`);
      assert.strictEqual(bad.isError, true);
    });

    await test('PYTHON LIVE: a traceback lands on STDERR, where it belongs', async () => {
      const ctx = { cwd: process.cwd(), app: { cfg: {} } };
      const r = await tools.python_run.run({ code: 'raise ValueError("boom")' }, ctx);
      assert.strictEqual(r.isError, true);
      assert.match(r.output, /--- stderr ---/);
      assert.match(r.output, /ValueError: boom/);
      assert.ok(!/--- stdout ---/.test(r.output), 'and not mixed into stdout');
    });

    await test('PYTHON LIVE: a real script file runs with its arguments', async () => {
      const dir = tmpdir('py-');
      const file = path.join(dir, 'measure.py');
      fs.writeFileSync(file, 'import sys\nprint("args:", " ".join(sys.argv[1:]))\n', 'utf8');
      const r = await tools.python_run.run({ file, args: ['a', 'b'] }, { cwd: dir, app: { cfg: {} } });
      assert.strictEqual(r.exitCode, 0, r.output);
      assert.match(r.output, /args: a b/);
    });
  }
};
