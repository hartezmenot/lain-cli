'use strict';

/**
 * `/runtime` — the first client of the boundary a second surface will use.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS WORTH A SMOKE TEST rather than a unit one. `runtimefeed.js` is the
 * shape a dashboard, and eventually a notifier, will attach to. A boundary with
 * no caller is a boundary that is wrong in ways nobody has noticed — so the
 * terminal goes through it, and this proves that the whole path works when
 * driven as a program: real binary, real supervisor, real socket, real screen.
 *
 * What it asserts is the part a person needs. After a turn dies, `/runtime` must
 * be able to say WHICH conversation is stuck and WHY, from a process that was
 * running before this LAIN started — because that is precisely what `/jobs` and
 * `/provider status`, both scoped to this process, cannot do.
 */

const assert = require('assert');

const { test, tmpdir, runCli, assertIncludes } = require('../helpers');

function plain(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');
}

const supervisor = require('../../src/supervisor');

const ENTER = String.fromCharCode(13);

module.exports = async function () {
  const probe = supervisor.probe();
  if (!probe.available) {
    await test('RUNTIME: skipped — the Rust binary is not built', () => {
      assert.ok(probe.why.includes('cargo build'), probe.why);
    });
    return;
  }

  await test('RUNTIME: with nothing running it says so, instead of drawing an empty table', async () => {
    // THE FIRST THING ANYBODY SEES. "Nothing has happened" and "I could not ask"
    // are different facts, and a surface that renders them the same way reports
    // a healthy quiet machine when it is simply not connected to one.
    const cwd = tmpdir('lain-rt-none-');
    const r = await runCli([], {
      cwd,
      env: { LAIN_FORCE_TUI: '1' },
      // No turn is ever started, so no supervisor is ever woken — which is the
      // point: opening a session must not spawn a process.
      script: [],
      stdinSteps: [`/runtime${ENTER}`, `/exit${ENTER}`],
      stepDelayMs: 1500,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);
    assertIncludes(out, 'No runtime is answering', 'it says it could not ask');
    assert.ok(!/CONVERSATIONS/.test(out), 'and draws no table it has no data for');
  });

  await test('RUNTIME: after a turn dies it names the stuck conversation and why', async () => {
    const cwd = tmpdir('lain-rt-');
    const r = await runCli([], {
      cwd,
      env: { LAIN_FORCE_TUI: '1' },
      script: [{ error: { status: 401, message: 'credential refused' } }, { text: 'ok.' }],
      stdinSteps: [`migrate the loader${ENTER}`, `/runtime${ENTER}`, `/exit${ENTER}`],
      // The supervisor is started when the first turn begins and takes about a
      // second, so the gap is the real sequence rather than an arrangement.
      stepDelayMs: 4000,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);

    // THE STATE, AS THE RUNTIME HOLDS IT — not as this process remembers it.
    assertIncludes(out, 'CONVERSATIONS', 'the section is drawn');
    assertIncludes(out, 'PROVIDER_FAILED', 'and names what happened to the turn');
    assertIncludes(out, 'this one', 'and which of the rows is the session in front of you');
    // AND THE OWED BRIEFING, with the provider's own words rather than a flag.
    assertIncludes(out, 'handover', 'a packet is owed');
    assertIncludes(out, 'credential refused', 'for a reason it can state');
    // The other two sections exist even when they are empty, because an absent
    // section reads as a section that failed.
    assertIncludes(out, 'WORKERS', 'workers are reported even when there are none');
    assertIncludes(out, 'nothing is running', 'and said to be none, rather than omitted');
  });
};
