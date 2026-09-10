'use strict';

/**
 * Test runner. Three tiers, kept separate on purpose so a status claim can be
 * traced to the tier that earned it:
 *
 *   unit         one module in isolation          -> WIRED / UNIT VERIFIED
 *   integration  real modules wired together      -> INTEGRATION VERIFIED
 *   smoke        spawns bin/lain.js as a process  -> LIVE CLI VERIFIED
 *   distribution installs into a temp directory   -> INSTALL VERIFIED
 *   live         contacts a REAL provider          -> LIVE PROVIDER VERIFIED
 *
 * THE `distribution` TIER NEVER TOUCHES THE DEVELOPER'S PATH. Every case
 * installs into a temporary directory and drives PATH through an injected fake
 * adapter (distribution/pathenv.js takes one) — a test that edited the real
 * user environment would be damage outside the tree that no assertion sees,
 * which is the same argument the config-home guard above makes at length.
 *
 * Only the `live` tier touches a real provider, and it SKIPS ITSELF when no
 * bridge is reachable. A green run of the first three tiers therefore never
 * implies LIVE PROVIDER VERIFIED.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * THE RUNNER'S OWN CONFIG HOME — set before anything requires src/config.
 *
 * `runCli` gives every SPAWNED binary an isolated LAIN_CONFIG_DIR, but the unit
 * and integration tiers run IN THIS PROCESS, where config.configDir() resolved
 * to the user's real `~/.lain-v2`. A single in-process command that persists a
 * setting — `/compare` remembering its source, a picker saving a model — writes
 * the whole config object, so a test holding a partial cfg REPLACED the user's
 * real configuration and destroyed their declared connections. That happened:
 * it wiped a working omniroute connection and took the entire 975-model catalog
 * down with it, and no test failed, because the damage was outside the tree.
 *
 * A test must never be able to touch anything the user owns. This is the one
 * place that can guarantee it for every test, present and future.
 */
const REAL_HOME = path.join(os.homedir(), '.lain-v2');
if (!process.env.LAIN_CONFIG_DIR) {
  process.env.LAIN_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-test-home-'));
} else if (path.resolve(process.env.LAIN_CONFIG_DIR) === path.resolve(REAL_HOME)) {
  // REFUSE, rather than report afterwards. A test that fails on this has
  // already run every test before it, and one of those writes the config —
  // which is the damage itself. The only useful moment to stop is now, before
  // a single test has executed.
  process.stderr.write(
    `\nREFUSING TO RUN: LAIN_CONFIG_DIR points at the real config home (${REAL_HOME}).\n`
    + 'Tests persist settings, and a partial cfg replaces the whole file — this would\n'
    + 'destroy your connections and the model catalog with them. Unset it, or point it\n'
    + 'at a scratch directory.\n\n',
  );
  process.exit(2);
}

/**
 * AND V1'S CONFIG HOME, which is the same hazard one directory over.
 *
 * providers.js reads `~/.lain/config.json` so the `/api` picker can offer a
 * route the user already has — a private gateway on a port, a proxy behind a
 * name no table could carry. That is right in production and wrong in a test
 * run: a suite whose answers depend on what happens to be configured on the
 * machine is a suite that passes here and fails on a clean checkout, and the
 * first thing it did was offer a provider a test had just asserted was absent.
 *
 * Pointed at a path that does not exist, so every tier sees the same empty V1 —
 * which is also the state of every machine that never ran V1. A test that wants
 * V1 routes sets the variable itself and gets a fixture it wrote.
 */
if (!process.env.LAIN_V1_CONFIG) {
  process.env.LAIN_V1_CONFIG = path.join(process.env.LAIN_CONFIG_DIR, 'no-v1-config.json');
}

/**
 * AND THE SUPERVISOR'S HOME, WHICH IS A THIRD DIRECTORY THE USER OWNS.
 *
 * `supervisor.js` does not read LAIN_CONFIG_DIR. It has a home of its own —
 * LAIN_HOME, else `~/.lain-v2` — because the process it manages outlives every
 * LAIN and therefore cannot be scoped to one session's config. So isolating the
 * config home does not isolate this, and the in-process tiers construct real
 * Apps: an App now mirrors provider health to the supervisor, and any test that
 * disables a route or records a rate limit would write it into the user's real
 * `~/.lain-v2/supervisor/` — where a `MAINTENANCE` row survives into their next
 * real session and takes a working route out of service.
 *
 * OBSERVED, NOT ANTICIPATED. A full run left three files there, one of them a
 * route the SUITE had disabled. Nothing failed: `zz-hygiene.test.js` compares
 * the working tree against git, and a home directory is not in the working tree.
 *
 * Same rule as the config guard above, second directory. A test that wants a
 * real supervisor sets LAIN_HOME itself, per test, and gets a private one —
 * which is what tests/integration/supervisor.test.js and
 * tests/integration/provider-health.test.js already do.
 */
if (!process.env.LAIN_HOME) {
  process.env.LAIN_HOME = path.join(process.env.LAIN_CONFIG_DIR, 'supervisor-home');
} else if (path.resolve(process.env.LAIN_HOME) === path.resolve(REAL_HOME)) {
  // REFUSE, for the same reason the config guard refuses: by the time a test
  // could report this, the damage is already on disk.
  process.stderr.write(
    `\nREFUSING TO RUN: LAIN_HOME points at the real supervisor home (${REAL_HOME}).\n`
    + 'Tests record provider state and background jobs there, and a MAINTENANCE row\n'
    + 'written by the suite would disable one of your routes in your next real\n'
    + 'session. Unset it, or point it at a scratch directory.\n\n',
  );
  process.exit(2);
}

/**
 * THE RUNNER'S OWN COLOUR ENVIRONMENT — scrubbed, for the same reason its config
 * home is.
 *
 * FOUND BY DRIVING LAIN AGAINST ITS OWN REPOSITORY. A session started with
 * `NO_COLOR=1` in its environment ran `node tests/run.js unit` through the shell
 * tool, the child inherited the variable, and `userblock.test.js` failed with
 * "exactly the one message the user sent: 0 !== 1". Nothing was wrong with the
 * renderer. The test sets `LAIN_FORCE_COLOR=1` to get colour over a pipe — and
 * `useColor()` correctly lets `NO_COLOR` beat it, because that is the
 * convention. So a test that explicitly asked for colour silently got none, and
 * the failure it produced pointed at the presentation layer.
 *
 * WHOSE BUG IT IS. Not the renderer's: NO_COLOR winning is right. Not really
 * the test's either — every future test that asserts on colour would have to
 * remember the same two variables. It belongs HERE, beside the config-home
 * guard, for the identical reason: this is the one place that can guarantee a
 * deterministic environment for every test, present and future.
 *
 * ONLY THE IN-PROCESS TIERS need this. `runCli` already builds each child's
 * environment deliberately and sets `LAIN_NO_COLOR` itself where a test wants
 * plain text, so spawned binaries are unaffected by what is done here.
 *
 * The values are RESTORED to the process on exit only in the sense that nothing
 * else in this process reads them — the runner owns its own environment.
 */
/**
 * AND THE PROVIDER VARIABLES, which are the same hazard pointed at a worse
 * outcome.
 *
 * `LAIN_PROVIDER=mock` and `LAIN_MOCK_SCRIPT` left in a shell make the
 * IN-PROCESS tiers run turns against whatever script that path happens to hold.
 * Observed while investigating the colour bug above: a stale script containing
 * a `write_file` call ran during the unit tier and wrote a file into the
 * REPOSITORY ROOT — a test tier reaching outside its own temporary directory,
 * which is the one thing tests/helpers.js already scrubs for spawned children
 * and could not scrub for this process.
 *
 * The integration tier sets both itself, deliberately, inside `freshModules` —
 * so clearing them here takes nothing away from any test that wants them.
 */
for (const k of [
  'NO_COLOR', 'LAIN_NO_COLOR', 'FORCE_COLOR', 'LAIN_FORCE_COLOR',
  'LAIN_PROVIDER', 'LAIN_MOCK_SCRIPT', 'LAIN_MOCK_WIRELOG', 'LAIN_REQTRACE',
  'LAIN_CONTEXT_BUDGET_TOKENS',
]) {
  delete process.env[k];
}

const helpers = require('./helpers');
// Terminal fixtures opt into a capable terminal. A host TERM=dumb must not
// silently suppress their OSC output; tests of dumb terminals set it explicitly.
process.env.TERM = 'xterm-256color';

const TIERS = ['unit', 'integration', 'smoke', 'distribution', 'live'];

/**
 * `adversarial` is DELIBERATELY NOT in the default run.
 *
 * It drives a REAL model against a fixture with real defects and decides pass
 * or fail by running that fixture's own tests. That costs tokens, takes
 * minutes, and depends on a provider answering — none of which belongs in the
 * run somebody does before every commit. Ask for it by name:
 *
 *     node tests/run.js adversarial
 *
 * It skips itself when no bridge answers, and says so. A green default run
 * therefore never implies anything was adversarially verified, and a report
 * that claims otherwise is wrong.
 */
const EXTRA_TIERS = ['adversarial'];

async function main() {
  const scope = await require('./supervisor-scope').open();
  process.env.LAIN_SUPERVISOR_LEASE_PORT = String(scope.port);
  try {
  const supervisorBin = require('../src/supervisor').binary();
  if (supervisorBin) {
    const probe = require('child_process').spawnSync(supervisorBin, ['where'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    let facts = null;
    try { facts = JSON.parse(probe.stdout); } catch { /* named below */ }
    if (!facts || facts.lifetime !== 'lease-v1') throw new Error('The supervisor test binary predates scoped ownership. Rebuild rust/lain-supervisor or set LAIN_SUPERVISOR_BIN to the rebuilt binary before running tests.');
  }
  const want = process.argv[2];
  const tiers = want ? [want] : TIERS;
  if (want && !TIERS.includes(want) && !EXTRA_TIERS.includes(want)) {
    process.stderr.write(`unknown tier "${want}" (${[...TIERS, ...EXTRA_TIERS].join('|')})\n`);
    process.exit(2);
  }

  const started = Date.now();
  for (const tier of tiers) {
    const dir = path.join(__dirname, tier);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && (!process.argv[3] || new RegExp(process.argv[3]).test(f))).sort(); } catch { files = []; }
    if (!files.length) continue;
    process.stdout.write(`\n${tier.toUpperCase()}\n`);
    for (const f of files) {
      process.stdout.write(`${f}\n`);
      helpers.setFile(`${tier}/${f}`);
      const mod = require(path.join(dir, f));
      if (typeof mod === 'function') await mod();
    }
  }

  const { passed, failed, failures } = helpers.results();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`\n${passed} passed, ${failed} failed  (${secs}s)\n`);
  if (failed) {
    process.stdout.write('\nFAILURES\n');
    for (const f of failures) process.stdout.write(`  ${f.file} :: ${f.name}\n    ${f.error && f.error.message}\n`);
    process.exitCode = 1;
  }
  } finally {
    try { await require('../src/supervisor').cleanupOwned(); }
    finally {
      try { await require('../src/harness/processes').cleanupOwned(); }
      finally { await scope.close(); }
    }
  }
}

main().catch((e) => { process.stderr.write(String(e && e.stack) + '\n'); process.exit(1); });
