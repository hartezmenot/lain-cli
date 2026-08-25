'use strict';

/**
 * WHICH POWERSHELL — through the real binary, because that is where it was seen.
 *
 * ------------------------------------------------------------------------
 * THE REPORT, verbatim: "the && for the terminal kinda broken". Reproduced in
 * one call:
 *
 *     run_powershell   echo one && echo two
 *     -> The token '&&' is not a valid statement separator in this version.
 *
 * `powershell.exe` is WINDOWS POWERSHELL 5.1 — the one in the box, frozen, with
 * no `&&`, no `||`, no `??` and no ternary. PowerShell 7 has all of them and
 * installs alongside as a DIFFERENT executable called `pwsh`. The machine this
 * was reported on has 7.6.5 on PATH. LAIN was spawning 5.1 by name, so a
 * perfectly valid command came back as a PARSE ERROR — which a model reads as
 * "my command was wrong" and responds to by rewriting a command that was right.
 *
 * ------------------------------------------------------------------------
 * AND THE FIX HAD ITS OWN TRAP, which is why this test exists rather than a
 * one-line assertion on a constant. `fs.existsSync` RETURNS FALSE FOR PWSH:
 * PowerShell 7 installs an app execution alias in `%LOCALAPPDATA%\\Microsoft\\
 * WindowsApps`, a zero-length reparse point that `stat` cannot follow. The
 * first version of the lookup walked PATH with `existsSync`, skipped the very
 * shell it was looking for, and resolved silently back to 5.1 while reporting
 * success. Only running a command tells you which one you got.
 *
 * SKIPPED, NOT FAILED, on a machine with no PowerShell 7 — there `&&` genuinely
 * does not exist, and the honest behaviour is the diagnostic, which is asserted
 * in tests/unit/execution.test.js.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes } = require('../helpers');

const execution = require('../../src/execution');

module.exports = async function () {
  await test('SHELL LIVE: && really runs, through the binary, in the shell LAIN picks', async () => {
    if (process.platform !== 'win32') return;
    if (execution.powerShellIsLegacy()) return;

    const cwd = tmpdir('shellchoice-');
    const configDir = path.join(cwd, 'cfg');
    const r = await runCli([], {
      cwd, configDir,
      stdinSteps: ['chain two commands\n', '/exit\n'],
      stepDelayMs: 6000,
      script: [
        {
          text: 'Chaining them.',
          tool_calls: [{ name: 'run_powershell', input: { command: 'echo one && echo two' } }],
        },
        { text: 'Both ran.' },
      ],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0);

    const dir = path.join(configDir, 'sessions');
    const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).pop();
    const session = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const tool = session.messages.find((m) => m.role === 'tool');
    assert.ok(tool, 'the command must have run and reported back');

    // ---- THE EXACT SENTENCE THAT WAS REPORTED, and it must be gone --------
    assertNotIncludes(tool.content, 'not a valid statement separator',
      'the shell LAIN chose must be one that HAS the operator the model used');
    assertIncludes(tool.content, 'one', 'the first half ran');
    assertIncludes(tool.content, 'two', 'and so did the second — which is what && means');
  });

  await test('SHELL LIVE: the && diagnostic is not given when && is not the problem', async () => {
    if (process.platform !== 'win32') return;
    if (execution.powerShellIsLegacy()) return;

    // ---- WHY THIS MATTERS AS MUCH AS THE FIX -----------------------------
    //
    // The advice used to be a flat sentence attached to any failing command
    // containing `&&`. Once pwsh 7 is what runs, that sentence is FALSE — and a
    // false explanation is worse than none, because it sends the next turn to
    // look at an operator that is fine instead of at the error that is real.
    const cwd = tmpdir('shellchoice-');
    const configDir = path.join(cwd, 'cfg');
    const r = await runCli([], {
      cwd, configDir,
      stdinSteps: ['run the build\n', '/exit\n'],
      stepDelayMs: 6000,
      script: [
        {
          text: 'Building.',
          tool_calls: [{
            name: 'run_powershell',
            input: { command: 'node ./definitely-not-here.js && node ./also-not-here.js' },
          }],
        },
        { text: 'The first script is missing.' },
      ],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0);

    const dir = path.join(configDir, 'sessions');
    const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).pop();
    const session = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const tool = session.messages.find((m) => m.role === 'tool');
    assert.ok(tool, 'the failure must come back through the tool boundary');
    assertNotIncludes(tool.content, 'Windows PowerShell 5.1 does not have it',
      'blaming a valid operator for an unrelated failure sends the next turn nowhere');
  });
};
