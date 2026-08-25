'use strict';

/**
 * WHAT TESTS DOES THIS PROJECT HAVE, AND WHAT ACTUALLY HAPPENED TO THEM?
 *
 * THE TWO FALSE REPORTS THIS FILE EXISTS TO END. Both were observed, both are
 * the same defect wearing different clothes, and neither is a prompting problem
 * — the model had no way to be right:
 *
 *   "There are no tests."   said about a tree with 185 test files in it,
 *                           because nothing had LOOKED and "I did not find any"
 *                           and "there are none" were the same sentence.
 *
 *   "All tests pass."       said without a runner ever having been spawned,
 *                           because "the suite exists" and "the suite is green"
 *                           were the same fact.
 *
 * The fix is not a better adjective. It is that DISCOVERY and EXECUTION are two
 * different questions with two different answers, and the vocabulary below
 * makes them impossible to say with one word. `discover()` costs nothing, spawns
 * nothing and can only ever produce NO_TESTS_FOUND or TESTS_FOUND_NOT_RUN. The
 * states that mean something ran are reachable only from a real result.
 *
 * ------------------------------------------------------------------------
 * A BLOCKED SUITE IS NOT A FAILING SUITE, and this is the distinction that
 * costs the most when it is missing. A run that stopped because a provider
 * returned 429, because a module is not installed, or because the runner is not
 * on PATH says NOTHING about the code — but it exits non-zero exactly like a
 * genuine failure, and a model that reads exit codes will go and "fix" working
 * code until the quota comes back. TESTS_BLOCKED names the layer that stopped
 * it and points the work somewhere else.
 *
 * ------------------------------------------------------------------------
 * SMOKE AND PROJECT ARE DIFFERENT CLAIMS. "The CLI starts" and "the suite is
 * green" are both worth having and neither substitutes for the other, so a
 * suite carries which KIND it is and a report never merges the two counts.
 *
 * ------------------------------------------------------------------------
 * NOTHING HERE GUESSES FROM WHAT IS INSTALLED. `pytest` being on PATH does not
 * make it this project's runner; a `test` script in package.json does. Every
 * suite carries `from` — the file that says so — because a discovery nobody can
 * trace is a guess with better manners. And `searched` records where it LOOKED,
 * so NO_TESTS_FOUND is an answer with evidence rather than an absence.
 */

const fs = require('fs');
const path = require('path');

/**
 * THE SEVEN STATES. Deliberately seven and not "pass/fail": each of these has a
 * different next move, and collapsing any two of them loses the move.
 */
const STATE = Object.freeze({
  /** Looked, found no test infrastructure at all. Carries where it looked. */
  NO_TESTS_FOUND: 'NO_TESTS_FOUND',
  /** A suite exists. Nothing has been run. THE DEFAULT AFTER DISCOVERY. */
  TESTS_FOUND_NOT_RUN: 'TESTS_FOUND_NOT_RUN',
  /** A runner is executing right now. */
  TESTS_RUNNING: 'TESTS_RUNNING',
  /** It ran, it finished, everything that ran passed. */
  TESTS_PASSED: 'TESTS_PASSED',
  /** It ran and something genuinely failed — the code is what is wrong. */
  TESTS_FAILED: 'TESTS_FAILED',
  /** It could not run, or could not finish, for a reason outside the code. */
  TESTS_BLOCKED: 'TESTS_BLOCKED',
  /** Some passed and some were skipped, blocked or not reached. */
  TESTS_PARTIAL: 'TESTS_PARTIAL',
});

/** States that mean a runner really was spawned. */
const RAN = new Set([STATE.TESTS_PASSED, STATE.TESTS_FAILED, STATE.TESTS_PARTIAL]);

/** What a suite is FOR. Never merged in a report — see the header. */
const KIND = Object.freeze({
  PROJECT: 'PROJECT',
  SMOKE: 'SMOKE',
});

// ------------------------------------------------------------- discovery ----

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

/** Directories never worth walking for tests. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  'vendor', '.venv', 'venv', 'env', '__pycache__', '.tox', '.next', '.nuxt',
  'coverage', '.cache', '.idea', '.vscode', 'bin', 'obj',
]);

/** Filenames that ARE a test, by the convention of each ecosystem. */
const TEST_FILE = [
  /\.test\.[cm]?[jt]sx?$/i,        // foo.test.js / .ts / .tsx / .mjs
  /\.spec\.[cm]?[jt]sx?$/i,        // foo.spec.js
  /^test_.+\.py$/i,                // test_foo.py
  /^.+_test\.py$/i,                // foo_test.py
  /_test\.go$/i,                   // foo_test.go
  /^.+Test\.java$/,                // FooTest.java
  /^.+Tests?\.cs$/,                // FooTests.cs
  /_spec\.rb$/i,                   // foo_spec.rb
  /Test\.php$/,
];

/** A test file whose name says it is a SMOKE test rather than the real suite. */
const SMOKE_HINT = /smoke/i;

function isTestFile(name) { return TEST_FILE.some((re) => re.test(name)); }

/**
 * Walk for test files. BOUNDED — depth and count — because this runs on a real
 * tree that may be enormous, and a discovery that takes ten seconds is one
 * nobody will wait for and everybody will work around.
 */
function walkTests(root, { maxDepth = 6, maxFiles = 4000 } = {}) {
  const files = [];
  const dirs = new Set();
  const stack = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (stack.length && files.length < maxFiles && seen < 40000) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen += 1;
      if (seen > 40000) break;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (depth < maxDepth) stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      if (!isTestFile(e.name)) continue;
      const abs = path.join(dir, e.name);
      files.push(abs);
      dirs.add(path.dirname(abs));
      if (files.length >= maxFiles) break;
    }
  }
  return { files, dirs: [...dirs] };
}

/** package.json scripts, sorted into what each one is for. */
function npmSuites(cwd, searched) {
  const p = path.join(cwd, 'package.json');
  searched.push('package.json');
  if (!exists(p)) return [];
  let j;
  try { j = JSON.parse(readText(p)); } catch { return []; }
  const scripts = (j && j.scripts) || {};
  const out = [];
  for (const name of Object.keys(scripts)) {
    // `pretest` and `posttest` are npm's own hooks and are run BY `npm test`,
    // never instead of it — offering them would be offering the same run twice.
    if (/^(pre|post)/.test(name)) continue;
    if (!/^(test|tests|check|verify|smoke|e2e|spec)(:|$)/i.test(name)) continue;
    out.push({
      kind: SMOKE_HINT.test(name) ? KIND.SMOKE : KIND.PROJECT,
      command: name === 'test' ? 'npm test' : `npm run ${name}`,
      script: name,
      from: 'package.json',
      why: `scripts.${name} = ${String(scripts[name]).slice(0, 120)}`,
    });
  }
  return out;
}

/** Every non-npm runner, keyed on the file that declares it. */
const MANIFESTS = [
  { file: 'pytest.ini', command: 'pytest' },
  { file: 'tox.ini', command: 'tox' },
  { file: 'Cargo.toml', command: 'cargo test' },
  { file: 'go.mod', command: 'go test ./...' },
  { file: 'pom.xml', command: 'mvn test' },
  { file: 'build.gradle', command: 'gradle test' },
  { file: 'build.gradle.kts', command: 'gradle test' },
  { file: 'phpunit.xml', command: 'phpunit' },
  { file: 'phpunit.xml.dist', command: 'phpunit' },
  { file: 'Gemfile', command: 'bundle exec rspec', needsDir: 'spec' },
  { file: 'deno.json', command: 'deno test' },
  { file: 'mix.exs', command: 'mix test' },
];

function manifestSuites(cwd, searched) {
  const out = [];
  for (const m of MANIFESTS) {
    searched.push(m.file);
    if (!exists(path.join(cwd, m.file))) continue;
    if (m.needsDir && !exists(path.join(cwd, m.needsDir))) continue;
    out.push({ kind: KIND.PROJECT, command: m.command, from: m.file, why: `${m.file} is present` });
  }
  // pyproject.toml and setup.cfg declare pytest INSIDE the file rather than by
  // existing, so they are read rather than stat'd.
  for (const f of ['pyproject.toml', 'setup.cfg']) {
    searched.push(f);
    const t = readText(path.join(cwd, f));
    if (/\[tool[.:]pytest/i.test(t)) {
      out.push({ kind: KIND.PROJECT, command: 'pytest', from: f, why: `${f} configures pytest` });
    }
  }
  // A Makefile is only a test runner if it has a target that says so.
  searched.push('Makefile');
  const mk = readText(path.join(cwd, 'Makefile'));
  const target = /^(test|check)\s*:/m.exec(mk);
  if (target) {
    out.push({ kind: KIND.PROJECT, command: `make ${target[1]}`, from: 'Makefile', why: `a "${target[1]}:" target exists` });
  }
  return out;
}

/** What CI runs, which is the project's own statement of how it is verified. */
function ciCommands(cwd, searched) {
  const dir = path.join(cwd, '.github', 'workflows');
  searched.push('.github/workflows');
  if (!exists(dir)) return [];
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)); } catch { return []; }
  for (const f of files.slice(0, 12)) {
    const text = readText(path.join(dir, f));
    for (const line of text.split('\n')) {
      const m = /^\s*(?:-\s*)?run:\s*(.+)$/.exec(line);
      if (!m) continue;
      const cmd = m[1].trim().replace(/^["']|["']$/g, '');
      if (!/\b(test|pytest|jest|vitest|mocha)\b/i.test(cmd)) continue;
      out.push({ command: cmd.slice(0, 160), from: `.github/workflows/${f}` });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/**
 * WHAT THIS PROJECT HAS. Reads files. Spawns nothing. Costs nothing.
 *
 * The state it returns can only ever be NO_TESTS_FOUND or TESTS_FOUND_NOT_RUN,
 * because nothing has run — see the header.
 */
function discover(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const searched = [];
  const suites = [...npmSuites(root, searched), ...manifestSuites(root, searched)];
  const { files, dirs } = walkTests(root);
  const ci = ciCommands(root, searched);

  // A tree with test FILES but no declared runner is still a tree with tests in
  // it. Saying NO_TESTS_FOUND there is the exact false report this file exists
  // to prevent — so the files count, and the missing runner is stated as the
  // missing thing it is.
  const smokeFiles = files.filter((f) => SMOKE_HINT.test(path.basename(f))
    || SMOKE_HINT.test(path.basename(path.dirname(f))));
  const found = Boolean(suites.length || files.length);

  return {
    state: found ? STATE.TESTS_FOUND_NOT_RUN : STATE.NO_TESTS_FOUND,
    found,
    cwd: root,
    suites,
    ci,
    files: {
      count: files.length,
      smoke: smokeFiles.length,
      dirs: dirs.map((d) => path.relative(root, d).replace(/\\/g, '/') || '.').sort(),
      sample: files.slice(0, 10).map((f) => path.relative(root, f).replace(/\\/g, '/')),
    },
    // WHERE IT LOOKED. An absence is only an answer if you can see the search.
    searched,
    /** True when files exist but nothing declares how to run them. */
    runnerMissing: Boolean(files.length && !suites.length),
  };
}

/** The one suite to reach for, when something has to pick. */
function primary(report) {
  if (!report || !report.suites || !report.suites.length) return null;
  return report.suites.find((s) => s.kind === KIND.PROJECT && /^(npm test|pytest|cargo test|go test)/.test(s.command))
    || report.suites.find((s) => s.kind === KIND.PROJECT)
    || report.suites[0];
}

// ------------------------------------------------------------ classifying ---

/**
 * WHAT STOPPED IT, WHEN THE ANSWER IS NOT "THE CODE".
 *
 * Ordered, and read against the runner's own output. Each entry names the LAYER
 * that failed, because that is the whole value: "the provider is rate limiting
 * you" and "your assertion is wrong" both exit non-zero and have nothing else
 * in common.
 */
const BLOCKED_SIGNS = [
  [/\b429\b|rate[ _-]?limit(ed|ing)?|too many requests/i, 'provider rate limit'],
  [/quota|insufficient (credit|balance|funds)|billing|payment required|\b402\b/i, 'provider quota or billing'],
  [/\b(401|403)\b|unauthori[sz]ed|invalid api key|authentication failed/i, 'authentication'],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network is unreachable|getaddrinfo/i, 'network'],
  [/ModuleNotFoundError|No module named|Cannot find module|ERR_MODULE_NOT_FOUND/i, 'a missing dependency'],
  [/is not recognized as (?:the name of )?a cmdlet|command not found|: not found\b/i, 'the runner is not installed'],
  [/no tests? (?:were )?(?:ran|run|found|collected)|collected 0 items/i, 'the runner matched no tests'],
];

/** Counts, in the shapes the common runners print them. */
function counts(output) {
  const s = String(output || '');
  const out = { passed: 0, failed: 0, skipped: 0, seen: false };
  const grab = (re, key) => {
    const m = re.exec(s);
    if (m) { out[key] = Number(String(m[1]).replace(/,/g, '')) || 0; out.seen = true; }
  };
  // "1556 passed, 0 failed"  /  "1745 passed"  /  "Tests: 3 failed, 20 passed"
  grab(/(\d[\d,]*)\s+pass(?:ed|ing)/i, 'passed');
  grab(/(\d[\d,]*)\s+fail(?:ed|ing|ures?)/i, 'failed');
  grab(/(\d[\d,]*)\s+(?:skipped|pending|ignored)/i, 'skipped');
  // go test prints "ok" / "FAIL" per package rather than a count.
  if (!out.seen && /^ok\s+\S/m.test(s)) { out.passed = (s.match(/^ok\s+\S/gm) || []).length; out.seen = true; }
  if (!out.seen && /^FAIL\s+\S/m.test(s)) { out.failed = (s.match(/^FAIL\s+\S/gm) || []).length; out.seen = true; }
  return out;
}

/**
 * WHAT ACTUALLY HAPPENED to a run that really was spawned.
 *
 * @param {object} r  `{ code, output, timedOut, interrupted, classification }`
 *                    — the shape tools/shell and tools/exec already return.
 * @returns {{state:string, why:string, counts:object, layer:string|null}}
 */
function classifyRun(r = {}) {
  const output = String(r.output == null ? `${r.stdout || ''}${r.stderr || ''}` : r.output);
  const c = counts(output);
  // `code` and `exitCode` are the two names the two runners in this tree use
  // for one number. Reading both here is what stops a caller passing the wrong
  // one and silently getting NaN, which compares false against 0 and would turn
  // every passing run into a failure.
  const code = Number(r.code != null ? r.code : r.exitCode);

  if (r.interrupted) {
    return { state: STATE.TESTS_BLOCKED, why: 'the run was interrupted before it finished', counts: c, layer: 'interrupted' };
  }
  if (r.timedOut) {
    return { state: STATE.TESTS_BLOCKED, why: 'the run timed out before it finished', counts: c, layer: 'timeout' };
  }
  // THE EXECUTION LAYER'S OWN VERDICT OUTRANKS THE TEXT. A runner that is not
  // installed and a dependency that is missing are already named upstream by
  // execution.js, and re-deriving them from a regex here would be a second
  // opinion that can disagree with the first.
  if (r.classification === 'COMMAND_NOT_FOUND') {
    return { state: STATE.TESTS_BLOCKED, why: 'the test runner is not installed on this machine', counts: c, layer: 'the runner is not installed' };
  }
  if (r.classification === 'DEPENDENCY_MISSING') {
    return { state: STATE.TESTS_BLOCKED, why: 'a dependency the suite imports is not installed', counts: c, layer: 'a missing dependency' };
  }

  for (const [re, layer] of BLOCKED_SIGNS) {
    if (!re.test(output)) continue;
    // A BLOCKER BESIDE REAL RESULTS IS PARTIAL, NOT BLOCKED. "1745 passed, 3
    // blocked by quota" is the honest report, and calling the whole run blocked
    // throws away 1745 real results.
    if (c.passed > 0 && code !== 0) {
      return { state: STATE.TESTS_PARTIAL, why: `some tests were blocked by ${layer}`, counts: c, layer };
    }
    if (c.passed > 0 && code === 0) break;   // a passing run that merely mentions it
    return { state: STATE.TESTS_BLOCKED, why: `blocked by ${layer}`, counts: c, layer };
  }

  if (code === 0) {
    if (c.skipped > 0) {
      return { state: STATE.TESTS_PARTIAL, why: `${c.passed} passed, ${c.skipped} skipped`, counts: c, layer: null };
    }
    // EXIT ZERO WITH NOTHING RUN IS NOT A PASS. A runner that collected no
    // tests exits 0 in several ecosystems, and calling that green is the
    // "all tests pass" false report by another route.
    if (c.seen && c.passed === 0 && c.failed === 0) {
      return { state: STATE.TESTS_BLOCKED, why: 'the runner ran but executed no tests', counts: c, layer: 'the runner matched no tests' };
    }
    return { state: STATE.TESTS_PASSED, why: c.seen ? `${c.passed} passed` : 'the runner exited 0', counts: c, layer: null };
  }
  return {
    state: STATE.TESTS_FAILED,
    why: c.seen && c.failed ? `${c.failed} failed` : `the runner exited ${Number.isFinite(code) ? code : 'non-zero'}`,
    counts: c,
    layer: null,
  };
}

// --------------------------------------------------------------- reporting --

/** One line per fact, for a terminal or a tool result. Never invents a count. */
function lines(report) {
  const out = [];
  if (!report) return out;
  if (report.state === STATE.NO_TESTS_FOUND) {
    out.push('NO_TESTS_FOUND');
    out.push(`  looked in ${report.cwd}`);
    out.push(`  checked: ${report.searched.join(', ')}`);
    out.push('  and walked the tree for *.test.*, *_test.*, test_*.py and spec files — none matched.');
    return out;
  }
  out.push(report.state);
  // SECOND LINE, NOT LAST. A tool result is CLIPPED for the feed — the CLI
  // shows the first handful of lines and "… N more". With this at the bottom it
  // was the first thing to disappear, which is precisely backwards: of
  // everything here, "nothing has been run" is the line that must survive.
  out.push('  NOTHING HAS BEEN RUN — this is what EXISTS, not what passes.');
  const proj = report.suites.filter((s) => s.kind === KIND.PROJECT);
  const smoke = report.suites.filter((s) => s.kind === KIND.SMOKE);
  if (proj.length) {
    out.push('  project suites:');
    for (const s of proj) out.push(`    ${s.command}   (${s.from} — ${s.why})`);
  }
  if (smoke.length) {
    out.push('  smoke suites:');
    for (const s of smoke) out.push(`    ${s.command}   (${s.from} — ${s.why})`);
  }
  if (report.files.count) {
    out.push(`  ${report.files.count} test files`
      + (report.files.smoke ? ` (${report.files.smoke} named smoke)` : '')
      + (report.files.dirs.length ? ` under ${report.files.dirs.slice(0, 6).join(', ')}` : ''));
  }
  if (report.runnerMissing) {
    out.push('  NO RUNNER DECLARED — the files exist but nothing in the tree says how to run them.');
  }
  if (report.ci.length) {
    out.push('  CI runs:');
    for (const c of report.ci.slice(0, 4)) out.push(`    ${c.command}   (${c.from})`);
  }
  return out;
}

/**
 * The compact form for the system prompt.
 *
 * Rides on the stable prefix of every request, so it is two lines at most and
 * says only what stops the model being wrong: that tests exist, and the command.
 */
function promptLine(cwd = process.cwd()) {
  let r;
  try { r = discover(cwd); } catch { return ''; }
  if (!r.found) return '';
  const p = primary(r);
  const bits = [];
  if (p) bits.push(`Tests: ${p.command} (${p.from})${r.files.count ? ` — ${r.files.count} test files` : ''}`);
  else if (r.files.count) bits.push(`Tests: ${r.files.count} test files, no runner declared`);
  const others = r.suites.filter((s) => s !== p).map((s) => s.command);
  if (others.length) bits.push(`Also: ${others.slice(0, 5).join(' · ')}`);
  return bits.join('\n');
}

module.exports = {
  STATE, KIND, RAN,
  discover, primary, classifyRun, counts, lines, promptLine,
  isTestFile, walkTests, BLOCKED_SIGNS,
};
