'use strict';

/**
 * DID THE SUITE LEAVE ANYTHING IN THE WORKING TREE?
 *
 * NAMED TO SORT LAST, and the name is the whole mechanism: the runner takes the
 * files of a tier in sorted order, so `zz-` is how a check runs after everything
 * else in the tier that could have caused what it is checking for. A hygiene
 * assertion that runs first proves nothing.
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS GUARDING, from a real incident. A full run left `out/real.txt` in
 * the repository root — seven bytes, untracked, and invisible to every
 * assertion in the suite, because the damage was outside anything a test looks
 * at. Bisecting it took four runs to reach the cause, and the cause was a test
 * of this suite's own:
 *
 *   `clipboard-powershell.test.js` hands PowerShell a deliberately mangled
 *   command line to prove that the unsanitised form really fails. PowerShell
 *   does not stop at the first token it cannot resolve — it keeps parsing, and
 *   the OSC title `\x1b]0;LAIN - proj` left the bare word LAIN standing. On a
 *   machine where `lain` is on PATH, PowerShell RAN IT, inheriting this
 *   process's `LAIN_PROVIDER=mock` and `LAIN_MOCK_SCRIPT` — and that script's
 *   `write_file` landed in the working tree.
 *
 * That test now runs its child in a temporary directory with a scrubbed
 * environment. This exists so the next one does not have to be found the same
 * way: a tier that escapes its own temporary directory says so, here, by name.
 *
 * IT IS NOT A LIST OF FORBIDDEN FILES. It compares against what git already
 * knows should be there, so a file added deliberately is not a failure and a
 * file nobody meant to create is.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { test } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Untracked, unignored paths in the working tree.
 *
 * `--porcelain` with the standard ignore rules, so anything already listed in
 * `.gitignore` — build output, a local config — is not reported. What is left
 * is a file that appeared and that nothing in the project expects.
 */
function untracked() {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;                  // not a git tree — nothing to compare against
  return String(r.stdout || '')
    .split('\n')
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

module.exports = async function () {
  await test('HYGIENE: the suite left nothing of its own in the working tree', () => {
    const list = untracked();
    if (list === null) {
      // A tarball rather than a checkout. Say so rather than passing quietly.
      process.stdout.write('      (not a git tree — NOT VERIFIED here)\n');
      return;
    }
    // The names a test run produces, which are the ones that mean a tier
    // reached outside its own temporary directory. A new source file somebody
    // is working on is untracked too, and is none of this test's business.
    const OURS = [/^out\//, /^out$/, /^proof\.txt$/, /^real\.txt$/, /^mock-script\.json$/, /^\.config\//, /^lain-test-home-/];
    const stray = list.filter((f) => OURS.some((re) => re.test(f)));
    assert.deepStrictEqual(stray, [],
      `a test escaped its temporary directory and wrote into the repository: ${stray.join(', ')}`);
  });

  await test('HYGIENE: no test process is still holding the real config home', () => {
    // The other way a run reaches something the user owns. The runner refuses
    // to start pointed at the real home; this checks it never drifted there.
    const home = process.env.LAIN_CONFIG_DIR;
    if (!home) return;                              // spawned tiers set their own
    const real = path.join(require('os').homedir(), '.lain-v2');
    assert.notStrictEqual(path.resolve(home), path.resolve(real));
    assert.ok(fs.existsSync(home), 'the isolated config home vanished mid-run');
  });

  await test('HYGIENE: the supervisor home is isolated, so nothing can reach the real one', () => {
    // ---- THE THIRD DIRECTORY, AND THE ONE NOTHING WAS WATCHING ------------
    //
    // The two checks above cover the working tree and the config home. The
    // supervisor has neither: it keeps its own home (LAIN_HOME, else
    // `~/.lain-v2`) because the process it manages outlives every LAIN, so
    // isolating LAIN_CONFIG_DIR does not isolate it. Once provider health began
    // being mirrored there, any test recording a route would have written into
    // the user's real `~/.lain-v2/supervisor/` — where a MAINTENANCE row
    // survives into their next real session and disables a working route.
    //
    // ---- WHY THIS ASSERTS THE SETTING AND NOT THE DIRECTORY ---------------
    //
    // The obvious check is "the real supervisor home is empty", and it is the
    // wrong one. That directory is SHARED with the user: LAIN is a program they
    // run, and a real session of theirs — recording a real rate limit, exactly
    // as designed — writes there legitimately while the suite happens to be
    // running. The first draft of this test asserted emptiness and failed on a
    // developer's machine for the best possible reason: their own `lain
    // --resume` had just recorded a genuine 429. A guard that fails when the
    // product works is worse than no guard, because it teaches people to ignore
    // it.
    //
    // Nothing here can attribute a file in a shared directory to a writer. What
    // IS attributable is this process's own configuration, which is the actual
    // property: with an isolated LAIN_HOME, no test can reach the real home even
    // in principle. `tests/run.js` sets it and refuses to start if it points at
    // the real one; `runCli` passes an isolated one to every child.
    const home = process.env.LAIN_HOME;
    assert.ok(home, 'the runner must set an isolated LAIN_HOME — see tests/run.js');
    const real = path.join(require('os').homedir(), '.lain-v2');
    assert.notStrictEqual(path.resolve(home), path.resolve(real),
      'LAIN_HOME points at the real supervisor home; a test could disable one of the user\'s routes');
    // And a child gets one too, which is the half `runCli` owns.
    const { runCli: _rc } = require('../helpers');
    void _rc;
    const helpersSrc = fs.readFileSync(path.join(__dirname, '..', 'helpers.js'), 'utf8');
    assert.ok(/LAIN_HOME:\s*path\.join\(configDir/.test(helpersSrc),
      'runCli must give every spawned child its own LAIN_HOME, or the scrub leaves it on the real home');
  });
};
