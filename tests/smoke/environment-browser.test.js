'use strict';

/**
 * THE HARNESS BROWSER, ACTUALLY LAUNCHED. (§27)
 *
 * Everything in tests/unit/environment-model.test.js is structural — it reads
 * source and asserts shapes. This starts a real Chromium, drives it over CDP,
 * and proves the five things §27 asks for against the running process:
 *
 *   · the person's own Chrome and Edge are untouched
 *   · the browser that launches is the Harness-owned one, by version
 *   · it runs on a Harness profile, not a personal one
 *   · it exits and cleans up
 *   · no orphan browser is left behind
 *
 * PROCESS COUNTS ARE TAKEN BEFORE AND AFTER, because "we did not touch your
 * browser" is a claim about a machine, and the only honest way to make it is to
 * count what was running on that machine either side.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { test } = require('../helpers');

const chromium = require('../../src/env/chromium');
const purpose = require('../../src/env/purpose');
const chromiuminstall = require('../../src/env/chromiuminstall');

/**
 * EVERY BROWSER PROCESS ON THIS MACHINE, keyed by executable path.
 *
 * Windows only for the counting half — this is where the acceptance is being
 * run and a wrong count is worse than an absent one, so elsewhere it reports
 * "not counted" rather than a number it did not measure.
 */
function browserProcesses() {
  if (process.platform !== 'win32') return { counted: false, lines: [] };
  let out = '';
  try {
    out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | " +
      'ForEach-Object { $_.CommandLine }',
    ], { encoding: 'utf8', timeout: 60_000 });
  } catch { return { counted: false, lines: [] }; }
  return { counted: true, lines: out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
}

/**
 * WHICH RUNNING BROWSERS ARE OURS — BY PROFILE, NOT BY EXECUTABLE.
 *
 * THE EXECUTABLE CANNOT ANSWER THIS, and assuming it could made the first
 * version of this test report the person's own browser as nineteen orphans.
 * The test runner isolates LAIN_CONFIG_DIR, so the managed build is invisible
 * to it and `resolve()` correctly BORROWS the system Chrome — at which point
 * "processes running the Harness executable" and "the person's own browser"
 * are the same path and cannot be told apart.
 *
 * `--user-data-dir` can. It is unique per launch for a VERIFY browser, it is
 * ours by construction for every purpose, and no personal browser ever carries
 * one of our profile paths. That is the property that actually distinguishes a
 * Harness browser from a person's.
 */
function usingProfile(snapshot, profileDir) {
  if (!profileDir) return 0;
  const want = String(profileDir).toLowerCase();
  return snapshot.lines.filter((l) => l.toLowerCase().includes(want)).length;
}

/** Everything NOT running on one of our profiles: the person's own browsers. */
function personalCount(snapshot, ourProfiles = []) {
  const mine = ourProfiles.filter(Boolean).map((p) => String(p).toLowerCase());
  return snapshot.lines.filter((l) => {
    const low = l.toLowerCase();
    return !mine.some((p) => low.includes(p));
  }).length;
}

module.exports = async function () {
  await test('ENV LIVE: a Harness browser launches, is owned, and leaves the person browser alone', async () => {
    const resolved = chromium.resolve({ policy: 'prefer-managed' });
    if (!resolved.ok) {
      // NOT A PASS. An unavailable capability that reports itself is useful;
      // one that silently succeeds is a liability.
      assert.fail(`no browser could be resolved: ${resolved.why}`);
    }

    const before = browserProcesses();
    // Nothing of ours is running yet, so every browser process on this machine
    // right now is the person's. That is the number that must not move.
    const personalBefore = personalCount(before, []);

    // A REAL ProcessManager, because a VERIFY browser is TASK-OWNED and the
    // runtime refuses to start one that nothing can clean up.
    //
    // THIS WAS THE BUG IN MY OWN FIRST DRAFT OF THIS TEST. It passed `null`
    // and then treated the resulting "no process manager" refusal as an
    // acceptable outcome and returned early — so the whole §27 acceptance
    // asserted nothing at all while reporting a tick. A smoke that can pass
    // without launching the thing it exists to launch is worse than no smoke.
    const { ProcessManager } = require('../../src/harness/processes');
    const rt = new chromium.ChromiumRuntime({ processes: new ProcessManager({}) });
    const got = await rt.launch(purpose.PURPOSE.VERIFY, { taskId: 'smoke-env', headless: true });
    assert.ok(got.ok, `the Harness browser did not launch: ${got.why || ''} ${got.detail || ''}`);

    const inst = got.instance;
    try {
      // ---- IT IS THE BROWSER WE OWN, AND THE VERSION IS RECORDED --------
      assert.ok(inst.version, 'a verdict that cannot name its browser cannot be compared with last week');
      if (chromiuminstall.installed().ok) {
        assert.strictEqual(inst.owned, true, 'the managed build must be preferred once installed');
        assert.strictEqual(inst.managed, true);
        assert.ok(inst.browserPath.startsWith(chromiuminstall.root()),
          `the running browser is ${inst.browserPath}, not the Harness build`);
      }

      // ---- ON A HARNESS PROFILE, NOT A PERSONAL ONE --------------------
      const home = require('os').homedir();
      for (const personal of [
        path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
        path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
        path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
        path.join(home, '.config', 'google-chrome'),
      ]) {
        assert.ok(!path.resolve(inst.profileDir).startsWith(path.resolve(personal)),
          `the Harness browser is running on the person profile at ${personal}`);
      }
      assert.ok(fs.existsSync(inst.profileDir), 'and the profile it was given actually exists');

      // ---- IT IS REALLY RUNNING AND REALLY ANSWERS CDP -----------------
      assert.ok(inst.port > 0, 'it chose its own port');
      assert.notStrictEqual(inst.port, 9222, 'never the well-known port that would collide with the person browser');
      const live = await require('../../src/harness/cdp').endpoint(inst.port);
      assert.ok(live.ok, `the launched browser did not answer CDP: ${live.why}`);
      assert.ok(/chrom/i.test(String(live.browser || '')), `unexpected browser: ${live.browser}`);

      // ---- THE PERSON'S OWN BROWSERS ARE UNTOUCHED ---------------------
      const during = browserProcesses();
      if (before.counted && during.counted) {
        assert.strictEqual(
          personalCount(during, [inst.profileDir]), personalBefore,
          'launching a Harness browser changed how many personal Chrome/Edge processes are running',
        );
        assert.ok(usingProfile(during, inst.profileDir) > 0,
          'no running process is using the Harness profile — nothing actually launched');
      }
    } finally {
      await rt.stop(inst);
    }

    // ---- IT EXITS, AND LEAVES NOTHING BEHIND --------------------------
    const deadline = Date.now() + 10_000;
    while (inst.alive && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- waiting on a process exit.
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(inst.alive, false, 'the Harness browser is still running after stop()');
    assert.strictEqual(fs.existsSync(inst.profileDir), false,
      'the disposable verification profile survived the browser that used it');

    const after = browserProcesses();
    if (before.counted && after.counted) {
      assert.strictEqual(personalCount(after, [inst.profileDir]), personalBefore,
        'the personal browser process count changed across the run');
      // THE WHOLE TREE, not just the process we spawned. A Chromium is a
      // browser process plus a renderer, a GPU process and several utility
      // processes; killing only the parent leaves the rest running, which is
      // exactly the orphan §27 asks to be proved absent.
      assert.strictEqual(usingProfile(after, inst.profileDir), 0,
        `${usingProfile(after, inst.profileDir)} Harness browser processes survived the stop — that is an orphan tree`);
    }
    assert.deepStrictEqual(rt.list(), [], 'the runtime still believes it owns a browser');
  });

  await test('ENV LIVE: two purposes launched together never share a profile', async () => {
    const resolved = chromium.resolve({ policy: 'prefer-managed' });
    if (!resolved.ok) assert.fail(resolved.why);

    const rt = new chromium.ChromiumRuntime();
    const shop = await rt.launch(purpose.PURPOSE.WORKSHOP, {
      projectPath: process.cwd(), headless: true,
    });
    if (!shop.ok) assert.fail(`workshop browser: ${shop.why}`);
    try {
      const webRoot = require('../../src/modelsource/webprofile').root();
      assert.ok(!path.resolve(shop.instance.profileDir).startsWith(path.resolve(webRoot)),
        'the Workshop browser is running on the authenticated web-model profile');
      // AND IT IS PROJECT-BOUND: the same project resolves to the same
      // directory, a different project to a different one.
      const other = rt.profileFor(purpose.PURPOSE.WORKSHOP, { projectPath: path.join(process.cwd(), '..', 'elsewhere') });
      assert.notStrictEqual(other, shop.instance.profileDir,
        'two projects would share a preview profile, and collide on localhost');
    } finally {
      await rt.stop(shop.instance);
    }

    // ---- THE DETACHED PATH LEAVES NO ORPHAN EITHER ---------------------
    //
    // A WORKSHOP browser is spawned detached rather than through the
    // ProcessManager, because it must outlive the tasks that use it — so
    // nothing else in the tree is responsible for ending it.
    //
    // THIS GUARD HAS NOT BEEN SHOWN TO FAIL. Reintroducing the parent-only
    // kill did not orphan anything: Chromium's children die with the browser
    // process (nine on our profile, 9 → 0 after killing only the parent, both
    // headless and headful). So this asserts a property that currently holds
    // for a reason OUTSIDE our code, and it is kept for exactly that reason —
    // the day a launch flag or a platform changes that, this is what notices.
    const after = browserProcesses();
    if (after.counted) {
      assert.strictEqual(usingProfile(after, shop.instance.profileDir), 0,
        'the detached Workshop browser left part of its process tree behind');
    }
  });
};
