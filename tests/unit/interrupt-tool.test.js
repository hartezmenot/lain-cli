'use strict';

/**
 * CTRL+C DURING A RUNNING COMMAND.
 *
 * Found by pressing Ctrl+C during `run_bash sleep 30` and watching the real
 * screen: the header went to INTERRUPTING immediately — and then STAYED there
 * for the remaining 24 seconds. `child.kill()` ends the shell, but whatever the
 * shell started is a grandchild that inherits the pipes, so `close` never fired
 * until the sleep finished on its own.
 *
 * Two independent guarantees, because either one alone leaves a hole:
 *   1. the result settles the moment the user says stop, and
 *   2. the process tree is actually ended, so nothing is orphaned.
 */

const assert = require('assert');
const { test } = require('../helpers');

const shell = require('../../src/tools/shell');

/** A command that would take far longer than we are willing to wait. */
const LONG = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
const LONG_SHELL = process.platform === 'win32' ? 'powershell' : 'bash';

module.exports = async function () {
  await test('INT: aborting a long command returns AT ONCE, not when it finishes', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = shell.run(LONG, { shell: LONG_SHELL, cwd: process.cwd(), signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const r = await p;
    const took = Date.now() - started;
    assert.ok(took < 8000, `took ${took}ms — the user's Ctrl+C waited for the command`);
    assert.strictEqual(r.interrupted, true);
    assert.ok(r.isError, 'an interrupted command did not succeed');
    assert.match(r.output, /interrupted by the user/i, 'the model must be told WHY there is no output');
  });

  await test('INT: the result is delivered exactly once', async () => {
    // The abort path and the close path can both fire. Settling twice would
    // resolve one turn's tool call with another turn's answer.
    const ac = new AbortController();
    let count = 0;
    const p = shell.run(LONG, { shell: LONG_SHELL, cwd: process.cwd(), signal: ac.signal }).then((r) => { count += 1; return r; });
    setTimeout(() => { ac.abort(); ac.abort(); }, 200);
    await p;
    await new Promise((r) => setTimeout(r, 1500));   // let any late close event land
    assert.strictEqual(count, 1);
  });

  await test('INT: an already-aborted signal does not start a long wait', async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const r = await shell.run(LONG, { shell: LONG_SHELL, cwd: process.cwd(), signal: ac.signal });
    assert.ok(Date.now() - started < 8000, 'a pre-aborted call still ran to completion');
    assert.ok(r.isError);
  });

  await test('INT: a command that finishes normally is untouched by any of this', async () => {
    const ac = new AbortController();
    const r = await shell.run('echo hello', { shell: LONG_SHELL, cwd: process.cwd(), signal: ac.signal });
    assert.match(r.output, /hello/);
    assert.strictEqual(r.isError, false);
    assert.strictEqual(r.exitCode, 0);
    assert.ok(!r.interrupted);
  });

  await test('INT: the child process really is gone, not just detached from us', async () => {
    // Settling early is only half the fix. A grandchild left running would
    // still hold the CPU, the file, or the port it was using.
    const marker = `lain_interrupt_probe_${Date.now()}`;
    const cmd = process.platform === 'win32'
      ? `$host.UI.RawUI.WindowTitle='${marker}'; Start-Sleep -Seconds 25`
      : `sleep 25 # ${marker}`;
    const ac = new AbortController();
    const p = shell.run(cmd, { shell: LONG_SHELL, cwd: process.cwd(), signal: ac.signal });
    await new Promise((r) => setTimeout(r, 600));
    ac.abort();
    await p;
    await new Promise((r) => setTimeout(r, 1200));

    // The query must not match ITSELF. Both forms split the marker so the
    // searching process's own command line never contains the whole string —
    // without this the check reports one survivor forever, which is a test bug
    // that looks exactly like a product bug.
    const head = marker.slice(0, 8);
    const tail = marker.slice(8);
    const list = await shell.run(
      process.platform === 'win32'
        ? `$m = '${head}' + '${tail}'; @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$m*" }).Count`
        : `ps -ef | grep -c "[${marker[0]}]${marker.slice(1)}" || true`,
      { shell: LONG_SHELL, cwd: process.cwd() }
    );
    // THE COUNT IS THE OUTPUT, NOT THE FIRST DIGIT IN IT. A result carries a
    // `[via shell: … cwd=…]` stamp, and this repository lives in a directory
    // called `lain-v2` — so the first `\d+` in the result was the 2 in the
    // PATH, and a clean interrupt reported two survivors. The bracketed
    // provenance lines are not the answer; drop them before reading it.
    const counted = list.output.split('\n').filter((l) => !/^\s*\[/.test(l)).join('\n');
    const survivors = Number((counted.match(/\d+/) || ['0'])[0]);
    assert.strictEqual(survivors, 0, `${survivors} process(es) survived the interrupt:\n${list.output}`);
  });
};
