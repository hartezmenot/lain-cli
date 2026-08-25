'use strict';

/**
 * PYTHON, PROGRAMS AND BACKGROUND WORK — through the real binary.
 *
 * The unit tier proves the execution layer in isolation. This proves the model
 * can actually REACH it: the tools are registered, dispatched, and their results
 * come back into a real turn. A capability that exists and is not wired to the
 * vocabulary is a capability the model cannot use.
 *
 * Every one of these drives `bin/lain.js` with the mock provider scripting the
 * tool call — so argv, the REPL, the session, the turn loop, dispatch and the
 * real child process are all genuine. Only the network is a double.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const exec = require('../../src/tools/exec');
const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

module.exports = async function () {
  // -------------------------------------------------------------- PROGRAM --

  await test('EXE LIVE: the model runs a real program and gets its real exit code', async () => {
    // `node` is the executable every machine running this suite is guaranteed
    // to have, and it is a genuine external process — not a shell builtin.
    const cwd = tmpdir('exe-');
    const r = await runCli([], {
      cwd,
      stdin: 'run the checker\n',
      script: [
        {
          text: 'Running it.',
          tool_calls: [{
            name: 'process_run',
            input: { program: process.execPath, args: ['-e', 'console.log("CHECKER OK"); process.exit(0)'] },
          }],
        },
        { text: 'It reported CHECKER OK.' },
      ],
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'CHECKER OK', 'the program really ran and its output came back');
    assert.match(out, /exited 0/);
    assert.strictEqual(r.code, 0);
  });

  await test('EXE LIVE: a program that fails is reported as failing, with its code', async () => {
    const r = await runCli([], {
      cwd: tmpdir('exe-'),
      stdin: 'run it\n',
      script: [
        {
          text: 'Running it.',
          tool_calls: [{
            name: 'process_run',
            input: { program: process.execPath, args: ['-e', 'console.error("BROKEN"); process.exit(4)'] },
          }],
        },
        { text: 'It failed.' },
      ],
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assert.match(out, /exited 4/, `the REAL exit code, not a shell's:\n${out.slice(-600)}`);
    assertIncludes(out, 'BROKEN', 'and stderr came back');
  });

  // --------------------------------------------------------------- PYTHON --

  const py = exec.findPython({});
  if (!py.ok) {
    process.stdout.write(`  ~ NOT VERIFIED: no Python on this machine — ${py.why}\n`);
  } else {
    process.stdout.write(`  · python: ${path.basename(py.exe)} (${py.source})\n`);

    await test('PYTHON LIVE: the model runs a real script and reads its result', async () => {
      // The shape the vision workflow needs: a script that MEASURES something
      // and prints structured output for the model to reason over.
      const cwd = tmpdir('py-');
      fs.writeFileSync(path.join(cwd, 'measure.py'),
        'import json\nprint(json.dumps({"ocr_confidence": 0.81, "regions": 12}))\n', 'utf8');
      const r = await runCli([], {
        cwd,
        stdin: 'measure the image\n',
        script: [
          { text: 'Measuring.', tool_calls: [{ name: 'python_run', input: { file: 'measure.py' } }] },
          { text: 'Confidence is 0.81 across 12 regions.' },
        ],
        timeoutMs: 90000,
      });
      const out = plain(r.out);
      assertIncludes(out, 'ocr_confidence', 'the structured result reached the model');
      assert.match(out, /0\.81/);
      assert.match(out, /exited 0/);
    });

    await test('PYTHON LIVE: a traceback comes back as stderr, and the call is an error', async () => {
      const cwd = tmpdir('py-');
      const r = await runCli([], {
        cwd,
        stdin: 'run the broken script\n',
        script: [
          { text: 'Running.', tool_calls: [{ name: 'python_run', input: { code: 'raise ValueError("boom")' } }] },
          { text: 'It raised.' },
        ],
        timeoutMs: 90000,
      });
      const out = plain(r.out);
      // THE RENDERER SHOWS THE FIRST EIGHT LINES of a tool result, so a deep
      // traceback line is legitimately below the cut. What must be true is that
      // it arrived on STDERR and was labelled as such — a traceback presented
      // as a result is the failure this separation exists to prevent.
      assert.match(out, /--- stderr ---/, 'stderr is labelled and kept apart from stdout');
      assert.match(out, /Traceback/, 'and the traceback itself came back');
      assert.match(out, /exited 1/, 'and the call is an error, not a result');
    });
  }

  // ----------------------------------------------------- BACKGROUND JOBS --

  await test('JOB LIVE: start → run → collect, through the real binary', async () => {
    // The whole point: the turn does not park inside the command.
    const cwd = tmpdir('job-');
    const r = await runCli([], {
      cwd,
      stdin: 'run the long check\n',
      script: [
        {
          text: 'Starting it in the background so I can keep working.',
          tool_calls: [{
            name: 'run_background',
            input: { command: `"${process.execPath}" -e "console.log('JOB DONE')"` },
          }],
        },
        // The model does something else while it runs — the behaviour the tool
        // exists to make possible.
        { text: 'While that runs, let me note the plan.', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
        { text: 'Now collecting it.', tool_calls: [{ name: 'job_wait', input: { id: 'j1' } }] },
        { text: 'The job finished.' },
      ],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    assert.match(out, /job j1 started/, 'it returned a handle immediately');
    // The model did something else BETWEEN starting and collecting — the whole
    // reason the tool exists.
    assert.ok(out.indexOf('list_dir') > out.indexOf('job j1 started'),
      'other work happened while the job ran');
    assert.match(out, /job_wait/, 'and it collected with ONE wait rather than polling');
    assertIncludes(out, 'JOB DONE', 'the job output was collected');
    assert.strictEqual(r.code, 0);
  });

  await test('JOB LIVE: a failing job comes back FAILED, with the shell exit code', async () => {
    // A BACKGROUND JOB RUNS THROUGH A SHELL — like run_bash and unlike
    // process_run — because pipes and redirection are the point of it. So the
    // exit code is the SHELL's, and on Windows `powershell -Command` flattens
    // any non-zero exit to 1. That is measured in unit/exec.test.js ("direct
    // exit 3 · via PowerShell exit 1") and is exactly why `process_run` exists
    // beside this one.
    //
    // This therefore exits through the shell's own `exit`, which does
    // propagate — asserting a real code rather than a flattening it cannot
    // control. A program's own exit code is `process_run`'s job, tested above.
    const cwd = tmpdir('job-');
    const r = await runCli([], {
      cwd,
      stdin: 'run it\n',
      script: [
        {
          text: 'Starting.',
          tool_calls: [{ name: 'run_background', input: { command: 'echo IT BROKE && exit 5', shell: 'cmd' } }],
        },
        { text: 'Collecting.', tool_calls: [{ name: 'job_wait', input: { id: 'j1' } }] },
        { text: 'It failed.' },
      ],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    assert.match(out, /FAILED \(exit 5\)/, `the shell's exit code must survive:\n${out.slice(-700)}`);
    assertIncludes(out, 'IT BROKE');
  });

  await test('JOB LIVE: a long job does not park the turn — OUTPUT shows it running', async () => {
    // The failure this replaces: `run_bash` on a 400-second suite parks the
    // turn inside one tool call, and the screen cannot tell running from hung.
    // The plain stream rather than the TUI: what is asserted here is that the
    // TURN ENDED while the job was still running, which is a fact about the
    // turn loop, not about how it was drawn.
    const cwd = tmpdir('job-');
    const r = await runCli([], {
      cwd,
      stdin: 'start the slow check\n',
      script: [
        {
          text: 'Starting the slow check.',
          tool_calls: [{
            name: 'run_background',
            input: { command: `"${process.execPath}" -e "console.log('WORKING'); setTimeout(()=>{},2500)"` },
          }],
        },
        { text: 'It is running. I will carry on in the meantime.' },
      ],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    // The turn ENDED while the job was still going — that is the feature.
    assert.match(out, /job j1 started/);
    assert.match(out, /carry on in the meantime/, 'the model kept talking rather than blocking');
    assert.strictEqual(r.code, 0, 'and the binary exited cleanly with a job still running');
  });
};
