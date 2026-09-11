'use strict';

/**
 * Test helpers, including the SMOKE harness.
 *
 * `runCli` spawns bin/lain.js as a real child process. Nothing in the smoke
 * suite is allowed to require() application modules directly — that is the
 * difference between LIVE CLI VERIFIED and WIRED/UNIT VERIFIED, and V1 blurred
 * it badly enough to ship a runnable foreign-plan bug under a green suite.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'lain.js');

let passed = 0;
let failed = 0;
const failures = [];
let currentFile = '';

function setFile(f) { currentFile = f; }

/**
 * LET A TEST'S OWN WORK SETTLE BEFORE THE NEXT ONE STARTS.
 *
 * The in-process tiers run thousands of tests in ONE process, and some of them
 * start a turn and return without awaiting it. The mock provider's script
 * cursor is process-global — correct for the smoke tier, where every test
 * spawns its own binary — so a turn that outlives its test can read a step from
 * the NEXT test's script.
 *
 * WHAT THIS DOES AND DOES NOT DO, because a comment that overclaims is worse
 * than none. It gives a turn that is merely finishing a few ticks to do so. It
 * did NOT fix the failure it was written for — a background job that would not
 * park when an await was added in front of each model request — so that cause
 * lies elsewhere and is recorded in docs/STATUS.md. It is kept because settling
 * between tests is defensible on its own and costs nothing measurable.
 */
async function drain() {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
}

async function test(name, fn) {
  try {
    await fn();
    await drain();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    await drain();
    failed++;
    failures.push({ file: currentFile, name, error: e });
    process.stdout.write(`  ✗ ${name}\n      ${e && e.message}\n`);
  }
}

function results() { return { passed, failed, failures }; }

/** A disposable directory that is also an isolated LAIN config home. */
function tmpdir(prefix = 'lain-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeScript(dir, steps) {
  const p = path.join(dir, 'mock-script.json');
  fs.writeFileSync(p, JSON.stringify(steps, null, 2), 'utf8');
  return p;
}

/**
 * Spawn the REAL binary.
 *
 * @param {string[]} args      argv
 * @param {object}   o
 *   stdin      text piped to the process
 *   cwd        working directory
 *   configDir  LAIN_CONFIG_DIR (isolated home)
 *   script     mock script steps (array) or a path
 *   env        extra environment
 *   timeoutMs
 * @returns {Promise<{code, stdout, stderr, out}>}  `out` = stdout+stderr
 */
/**
 * Ask the supervisor serving one isolated home to stop.
 *
 * Deliberately not `require('../src/supervisor')`: that module reads
 * `process.env.LAIN_HOME`, which belongs to whichever test is running right now
 * and is not the home of the child that just exited. Reading the endpoint file
 * directly is both narrower and safer — it can only ever reach the process
 * recorded in THIS temporary directory.
 */
function shutdownSupervisorIn(home) {
  return require('../src/supervisor').shutdownIn(home);
}

async function runCli(args = [], o = {}) {
  const cwd = o.cwd || tmpdir('lain-cwd-');
  const configDir = o.configDir || path.join(cwd, '.config');
  // ---- THE PROJECT IS ALREADY TRUSTED, unless the test says otherwise ------
  //
  // Every run here happens in a fresh temporary directory nobody has decided
  // about, so without this LAIN correctly asks "trust this directory?" before
  // doing anything — which changes the first screen of every TUI test and makes
  // the filesystem gate refuse every read and write. 93 tests failed on it, and
  // not one of them was about trust.
  //
  // The realistic state for a test that is not ABOUT trust is the state a user
  // is in a second after answering: this is my project. So the harness answers
  // it, once, here.
  //
  // OPT OUT WITH `trust: false` — the live trust tests do exactly that, and get
  // the real unanswered question. Keyed on an explicit flag rather than on
  // "did you pass a configDir", because plenty of tests bring their own config
  // for unrelated reasons and would have been silently left untrusted.
  if (o.trust !== false) {
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cfg = {}; }
    if (!Array.isArray(cfg.trustedPaths) || !cfg.trustedPaths.length) {
      cfg.trustedPaths = [{ path: cwd, level: 'TRUSTED', at: new Date().toISOString() }];
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    }
  }
  // HERMETIC ENV. The integration tier sets LAIN_PROVIDER/LAIN_MOCK_SCRIPT on
  // the RUNNER process to exercise modules in-process. Spreading process.env
  // leaked those into every later smoke child, so tests that were supposed to
  // run with NO provider silently ran against the mock and passed for the wrong
  // reason. Every LAIN_* var a child sees is set deliberately below.
  const inherited = { ...process.env };
  for (const k of Object.keys(inherited)) if (k.startsWith('LAIN_')) delete inherited[k];
  const env = {
    ...inherited,
    LAIN_CONFIG_DIR: configDir,
    // ---- AND V1'S CONFIG HOME, WHICH THE SCRUB ABOVE DOES NOT COVER -------
    //
    // src/providers.js reads `~/.lain/config.json` so the `/api` picker can
    // offer a route the user already has. That is right in production and wrong
    // in a test: the loop above deletes every LAIN_* the runner set — including
    // the isolation tests/run.js applies to the in-process tiers — and rebuilds
    // the environment here, so without this line a SPAWNED child reads the real
    // file and the suite's answers depend on what happens to be configured on
    // the machine it runs on. Green here, red on a clean checkout.
    //
    // Pointed at a path that does not exist, which is also the state of every
    // machine that never ran V1. A test that wants V1 routes sets the variable
    // itself and gets a fixture it wrote.
    LAIN_V1_CONFIG: path.join(configDir, 'no-v1-config.json'),
    // ---- AND THE SUPERVISOR'S HOME, WHICH IS A THIRD DIRECTORY -------------
    //
    // `supervisor.js` does NOT read LAIN_CONFIG_DIR. It has its own home —
    // LAIN_HOME, else `~/.lain-v2` — because the process it manages outlives
    // every LAIN and cannot be scoped to one session's config. The scrub above
    // deletes LAIN_HOME along with every other LAIN_*, and until this line
    // existed nothing put it back, so a spawned child fell through to the
    // USERPROFILE default: the user's REAL home.
    //
    // FOUND BY WATCHING IT HAPPEN. Provider health is now mirrored to the
    // supervisor, so `/provider maintenance omniroute` in a smoke test started
    // a real supervisor and left `~/.lain-v2/supervisor/providers/` holding
    // `{"id":"ninerouter","status":"MAINTENANCE"}` — a route the SUITE disabled,
    // persisted into the user's next real session, on a machine no assertion
    // here looks at. `zz-hygiene.test.js` could not see it either: it compares
    // the working tree against git, and this damage is in a home directory.
    //
    // Nothing in a test may reach anything the user owns. The config guard at
    // the top of tests/run.js makes that argument at length; this is the same
    // argument about the second directory LAIN writes to.
    LAIN_HOME: path.join(configDir, 'supervisor-home'),
    ...(process.env.LAIN_SUPERVISOR_BIN ? { LAIN_SUPERVISOR_BIN: process.env.LAIN_SUPERVISOR_BIN } : {}),
    ...(process.env.LAIN_SUPERVISOR_LEASE_PORT ? { LAIN_SUPERVISOR_LEASE_PORT: process.env.LAIN_SUPERVISOR_LEASE_PORT } : {}),
    LAIN_NO_COLOR: '1',
    NO_COLOR: '1',
    // ---- THE RETRY SCHEDULE, WITHOUT WAITING FOR IT ---------------------
    //
    // backoff.js is ten attempts totalling about nineteen minutes, which is
    // right for a real provider and impossible for a smoke: the outage test
    // has a 45s deadline and the first three waits alone are 55s, so it was
    // killed by its own timeout and reported `code null`.
    //
    // An in-process test injects `opts.timers` (see turn.js); a smoke drives
    // the real binary in another process and cannot. This is the same kind of
    // seam as LAIN_MOCK_SCRIPT and LAIN_FORCE_TUI, and it changes only the
    // WAITING — every attempt still happens, in order, under the real policy.
    //
    // A test that wants the real schedule can override it through `o.env`.
    LAIN_BACKOFF_MS: '1,1,1,1,1,1,1,1,1,1',
    ...(o.env || {}),
  };
  if (o.script !== undefined && o.script !== null) {
    env.LAIN_PROVIDER = 'mock';
    env.LAIN_MOCK_SCRIPT = Array.isArray(o.script) ? writeScript(configDirEnsure(configDir), o.script) : o.script;
  }
  const scope = await require('./supervisor-scope').open();
  env.LAIN_SUPERVISOR_LEASE_PORT = String(scope.port);
  try {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, windowsHide: true });
    child.once('error', reject);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, o.timeoutMs || 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      // ---- TAKE THE SUPERVISOR DOWN WITH THE CLI THAT WOKE IT -------------
      //
      // A supervisor is BUILT to outlive its client — that is its entire
      // purpose, and it is why nothing kills it when a CLI exits. Correct in
      // production, and a leak in a suite that starts hundreds of CLIs: every
      // smoke test that runs a turn wakes one in its own isolated home, and
      // nothing ever asks it to stop.
      //
      // Measured mid-run while writing the remote-control tests: 217 orphaned
      // supervisors, ~10 per minute, all from one smoke pass. They hold the
      // built binary open, so the next `cargo build` fails with "Access is
      // denied" — a build error with no visible connection to its cause, which
      // is exactly how an afternoon disappears.
      //
      // SCOPED TO THIS TEST'S OWN HOME, and asked rather than killed: the op is
      // the supervisor's own `shutdown`, which stops that process and touches no
      // worker it started. Nothing outside this temporary directory can be
      // affected, and a supervisor that was never started is a no-op.
      shutdownSupervisorIn(env.LAIN_HOME)
        .then(() => resolve({ code, stdout, stderr, out: stdout + stderr, cwd, configDir }))
        // Cleanup is part of the result: a leaked process must fail visibly.
        .catch(reject);
    });
    // STAGED STDIN. Writing everything at once delivers keystrokes before the
    // async work they are meant to answer has even started — a panel opened by
    // a tool call would never see them. `stdinSteps` writes each chunk after a
    // pause, which is what a person at a terminal actually does: look, then type.
    if (Array.isArray(o.stdinSteps)) {
      const gap = o.stepDelayMs || 400;
      let i = 0;
      const writeNext = () => {
        if (i >= o.stdinSteps.length) { child.stdin.end(); return; }
        child.stdin.write(o.stdinSteps[i++]);
        setTimeout(writeNext, gap);
      };
      setTimeout(writeNext, gap);
    } else if (o.stdin !== undefined) child.stdin.end(o.stdin);
    else child.stdin.end();
  });
  } finally { await scope.close(); }
}

function configDirEnsure(d) { fs.mkdirSync(d, { recursive: true }); return d; }

/**
 * THE DRAWN FRAMES OF A TUI RUN, and the ROWS of one.
 *
 * A drawn frame contains no newlines. The Screen positions every row with
 * `ESC[<row>;<col>H` and writes the whole frame as one string, so stripping the
 * escapes and splitting on '\n' yields ONE enormous line — and any test that
 * counts rows that way counts zero, passes, and proves nothing. That is exactly
 * what happened to a bound on how many tool-call rows may share a screen.
 *
 * These split on the cursor-position sequence instead, which is what actually
 * separates one row from the next.
 *
 * SPLIT ON `\x1b[?25l` (hide-cursor), NOT `\x1b[2J` (erase-screen). `draw()`
 * used to open every single redraw with a full-screen erase — which is real,
 * visible flicker on every keystroke — before repainting every row from fixed-
 * length loops that already cover the whole terminal. That full erase is gone;
 * `\x1b[2J` is now written exactly once per session, at `Screen.enter()`, not
 * once per frame. `\x1b[?25l` is still written exactly once per `draw()` call
 * (it opens the final `HIDE_CUR + buf.join('')` write) and nowhere else in the
 * source, so it is now the correct per-frame boundary — the LAST chunk after
 * the last `\x1b[?25l` is still exactly one draw() call's content, same as the
 * last chunk after the last `\x1b[2J` used to be.
 */
function frames(out) {
  return String(out).split(/\x1b\[\?25l/);
}

function rowsOf(rawFrame) {
  // ---- ANY COLUMN, NOT COLUMN 1 --------------------------------------
  //
  // Every region is drawn inside the content frame, so the address carries the
  // frame's left edge rather than 1 (ui/frame.js `contentBounds`). Splitting on
  // `;1H` found ONE row — the whole frame as a single string — which is the
  // same silent zero this helper's header was written about, arrived at from the
  // other direction.
  return String(rawFrame)
    .split(/\x1b\[\d+;\d+H/)
    .map((r) => r
      .replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
    .filter((r) => r.length);
}

/** The rows of the LAST drawn frame — what a person would be looking at. */
function lastFrameRows(out) {
  const f = frames(out);
  return rowsOf(f[f.length - 1] || out);
}

function assertIncludes(haystack, needle, msg) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${msg || 'expected output to include'}: ${JSON.stringify(needle)}\n--- actual ---\n${String(haystack).slice(0, 2000)}`);
  }
}

function assertNotIncludes(haystack, needle, msg) {
  if (String(haystack).includes(needle)) {
    throw new Error(`${msg || 'expected output NOT to include'}: ${JSON.stringify(needle)}\n--- actual ---\n${String(haystack).slice(0, 2000)}`);
  }
}

/**
 * WHERE THE CONVERSATION BEGINS, ON A DRAWN FRAME.
 *
 * ------------------------------------------------------------------------
 * THIS USED TO BE THE TAB STRIP. A dozen tests located the workspace by
 * looking for the literal `1 context` — not because they were about CONTEXT,
 * but because the strip was the one row that reliably marked where the
 * workspace began. `firstTab()`, `firstTabLabel()` and `firstTabMark()` asked
 * ui/tabs.js for that label rather than writing it down, so the pane order
 * could change without a dozen unrelated failures.
 *
 * There is no strip. The landmark is the RULE under the header — one row of
 * `─` starting in column 1, drawn by ui/layout.js `separator`, and the only
 * row on the screen that begins that way. The input box's bottom border is
 * `└───┘` and starts with a corner, which is what keeps these unambiguous.
 *
 * `headerMark()` is the wordmark on the header row itself, for tests that want
 * the top of the frame rather than the boundary.
 */
function headerMark() { return 'LAIN'; }

/** True for the header rule — a row that STARTS with a run of box-drawing dash. */
function isRuleRow(line) { return /^─{4}/.test(String(line || '')); }

/** The index of the header rule in a list of drawn rows, or -1. */
function ruleRowIndex(rows) { return rows.findIndex((l) => isRuleRow(l)); }

module.exports = {
  ROOT, BIN, test, results, setFile, tmpdir, runCli, writeScript,
  frames, rowsOf, lastFrameRows,
  headerMark, isRuleRow, ruleRowIndex,
  assertIncludes, assertNotIncludes,
};
