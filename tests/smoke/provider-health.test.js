'use strict';

/**
 * THE DURABLE HEALTH STORE MAY NEVER BECOME A DEPENDENCY.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS TIER IS FOR HERE. The unit and integration tests prove the store
 * keeps the right facts and drops the wrong ones. Neither can prove the thing
 * that actually breaks a user's machine, because both run inside the runner
 * process with modules they required themselves.
 *
 * The rule from supervisor.js is hard and predates all of this: LAIN is a
 * zero-dependency Node program that must run identically where no Rust
 * toolchain exists. Wiring a durable store in behind `availability.js` is
 * exactly the kind of change that quietly violates it — by starting a process,
 * by waiting on a socket, or by failing when neither is there — and the only
 * honest way to check is to run the real binary and look.
 *
 * ------------------------------------------------------------------------
 * THE SPECIFIC REGRESSION THE SECOND TEST EXISTS FOR.
 *
 * Provider observations now flow to a supervisor. Some of them are worth
 * STARTING one for: a limit with a stated reset is true for hours, so dropping
 * it because nothing happened to be running would leave the store empty at the
 * one moment it would have paid for itself. Most are not.
 *
 * `/provider retry` is the clearest case of "not". It means "forget what you
 * knew about this route", and with nothing running there is nothing that knows
 * anything — so spawning a Rust binary to record the absence of a fact would
 * make a routine command silently start a process on a machine that was not
 * using one. The assertion is a missing endpoint file, which is the only place
 * a started supervisor can hide.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

/** A private supervisor home, so the assertion is about THIS run only. */
function home(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lain-sup-smoke-${tag}-`));
}

function startedOne(h) {
  return fs.existsSync(path.join(h, 'supervisor', 'endpoint.json'));
}

module.exports = async function () {
  await test('SMOKE: /provider status works with no supervisor and no Rust toolchain', async () => {
    const cwd = tmpdir('lain-health-');
    const h = home('status');
    const r = await runCli([], {
      cwd,
      stdin: '/provider status\n/exit\n',
      script: [],
      // A binary that is definitely not there — the state of every machine that
      // never ran `cargo build`.
      env: { LAIN_HOME: h, LAIN_SUPERVISOR_BIN: path.join(h, 'no-such-binary') },
    });
    assert.strictEqual(r.code, 0, `LAIN must exit cleanly: ${r.out.slice(-600)}`);
    assertIncludes(r.stdout, 'Connections', 'and still answer the question');
    assert.ok(!startedOne(h), 'reading provider health must not start anything');
  });

  await test('SMOKE: /provider retry does not start a supervisor to forget nothing', async () => {
    const cwd = tmpdir('lain-health-');
    const h = home('retry');
    const r = await runCli([], {
      cwd,
      stdin: '/provider retry mock\n/provider status\n/exit\n',
      script: [],
      env: { LAIN_HOME: h },
    });
    assert.strictEqual(r.code, 0, `LAIN must exit cleanly: ${r.out.slice(-600)}`);
    assert.ok(!startedOne(h),
      'clearing state that was never stored must not spawn a process');
  });

  await test('SMOKE: /provider maintenance does not start a supervisor either', async () => {
    // A UI COMMAND MAY NOT SPAWN A BACKGROUND PROCESS. Persisting a disable is
    // better than not, and it happens when a supervisor is already up — but it
    // is not worth starting one, because that both exceeds what was asked (a
    // disable has always been session state) and starts a process on a machine
    // that was not running one. This test caught the opposite behaviour: the
    // suite spawned a supervisor per case and left every one behind.
    const cwd = tmpdir('lain-health-');
    const h = home('maint');
    const r = await runCli([], {
      cwd,
      stdin: '/provider maintenance omniroute\n/provider status\n/exit\n',
      script: [],
      env: { LAIN_HOME: h },
    });
    assert.strictEqual(r.code, 0, `LAIN must exit cleanly: ${r.out.slice(-600)}`);
    assertIncludes(r.stdout, 'Connections', 'and the command still works');
    assert.ok(!startedOne(h), 'a UI command must not spawn a background process');
  });

  await test('SMOKE: a session opening never starts a supervisor', async () => {
    // The same restraint refreshSupervisedJobs already observes, now that a
    // second subsystem reads from the same process at startup. One is started
    // when there is something to say, never because a session began.
    const cwd = tmpdir('lain-health-');
    const h = home('open');
    const r = await runCli([], { cwd, stdin: '/exit\n', script: [], env: { LAIN_HOME: h } });
    assert.strictEqual(r.code, 0, `LAIN must exit cleanly: ${r.out.slice(-600)}`);
    assert.ok(!startedOne(h), 'opening a session is not work submitted to anybody');
  });
};
