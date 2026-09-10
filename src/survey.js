'use strict';

/**
 * THE SURVEY — gather every evidence source into one coherent picture.
 *
 * LAIN already has the instruments: a parser, a symbol model, a typo checker, a
 * residue scanner, a diff sensor, an execution ledger. Each answers
 * its own question well and none of them knows about the others, so using them
 * means calling six tools, holding six results in your head, and doing the
 * correlation yourself. That correlation is the work this file does once,
 * deterministically, so that it does not have to be redone by a model every
 * time it is needed.
 *
 * ------------------------------------------------------------------------
 * BUILD SUCCESS IS NOT ENGINEERING SUCCESS, and this is the file where that
 * distinction is enforced rather than merely believed.
 *
 * Four axes, computed separately and never allowed to overwrite one another:
 *
 *   BUILD      does the source parse and type-check
 *   TEST       does the suite pass
 *   RUNTIME    did the last thing that ran actually work
 *   ENGINEERING is the codebase in good order
 *
 * (A FRONTEND axis — the page's own console, read by the Chromium LAIN owned —
 * was a fifth until the browser was removed in 2026-09 per the browser-ownership
 * ruling. With no browser there was no way to observe a running front end, and
 * an axis that can never be anything but UNVERIFIED is not an axis.)
 *
 * A project can be `BUILD: PASS · TESTS: PASS · ENGINEERING: DEGRADED`, and
 * that combination is not a contradiction — it is the ordinary state of most
 * real code. A compiler produces an executable; it has no opinion on a leftover
 * dataset with two sources of truth, a name that resolves to nothing on a path
 * no test takes, or a warning that is a latent bug. Collapsing these axes into
 * one "healthy" flag is how all of that becomes invisible.
 *
 * NOTHING HERE IS ASKED OF A MODEL. Every value is read from the tree, from a
 * process that ran, or from this session's own ledgers.
 */

const fs = require('fs');
const path = require('path');

const F = require('./findings');
const langscan = require('./langscan');
const toolchain = require('./toolchain');
const environment = require('./environment');
const gitsense = require('./gitsense');
const residue = require('./residue');
const deadcode = require('./deadcode');
const { walk } = require('./tools/search');

/**
 * THE FIVE VERDICTS AN AXIS CAN CARRY.
 *
 * Deliberately not projecthealth.js's vocabulary, which grades individual ROWS
 * of a human-facing dashboard, and not health.js's, which grades LAIN's own
 * readiness. These grade an ENGINEERING AXIS, and `UNVERIFIED` is a first-class
 * member rather than a footnote — it is the answer whenever nothing looked, and
 * it must never be reachable by rounding up from "no findings".
 */
const HEALTH = Object.freeze({
  PASS: 'PASS',
  CLEAN: 'CLEAN',
  DEGRADED: 'DEGRADED',
  FAILED: 'FAILED',
  UNVERIFIED: 'UNVERIFIED',
});

const MAX_PYTHON_FILES = 2000;

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/** Every Python file, for the one-process batch compile. */
function pythonFiles(root) {
  const out = [];
  for (const f of walk(root)) {
    if (!/\.py$/i.test(f.rel)) continue;
    out.push(f.abs);
    if (out.length >= MAX_PYTHON_FILES) break;
  }
  return out;
}

// ------------------------------------------------------------ git as sensor --

async function gitFindings(root, expected) {
  const r = await gitsense.review(root, { expected });
  if (!r.ok) {
    return {
      state: null,
      findings: [F.make({
        category: F.CATEGORY.GIT,
        severity: F.SEVERITY.INFO,
        confidence: F.CONFIDENCE.PROVEN,
        source: F.SOURCE.FILESYSTEM,
        message: r.error,
        explanation: 'Without version control there is no baseline, so nothing here can tell a change made for '
          + 'this task from code that has always looked like that.',
      })],
      review: r,
    };
  }
  const out = [];
  for (const f of r.files) {
    if (f.rewrite) {
      out.push(F.make({
        category: F.CATEGORY.GIT,
        severity: F.SEVERITY.SUSPICIOUS,
        confidence: F.CONFIDENCE.OBSERVED,
        source: F.SOURCE.GIT_DIFF,
        file: f.file,
        message: `${f.file} has +${f.added}/-${f.removed} against ${f.lines} lines — nearly every line is on both sides of the diff.`,
        explanation: 'That is the signature of a file written back WHOLE rather than patched, or of a reformat. '
          + 'Both produce a diff in which the intended change is indistinguishable from the noise around it.',
        risk: 'Unrelated lines may have changed. A review cannot separate the intended edit from the rest.',
        evidence: 'git diff --numstat',
      }));
    }
    if (f.generated) {
      out.push(F.make({
        category: F.CATEGORY.GIT,
        severity: F.SEVERITY.WARNING,
        confidence: F.CONFIDENCE.PROVEN,
        source: F.SOURCE.GIT_DIFF,
        file: f.file,
        message: `${f.file} is ${f.generated} and is in the change set.`,
        explanation: 'Files of this kind are produced by a command rather than edited, so their presence usually '
          + 'means a build or install ran rather than that anyone intended to change them.',
        evidence: 'git status --porcelain',
      }));
    }
    if (f.deleted) {
      out.push(F.make({
        category: F.CATEGORY.GIT,
        severity: F.SEVERITY.WARNING,
        confidence: F.CONFIDENCE.PROVEN,
        source: F.SOURCE.GIT_DIFF,
        file: f.file,
        message: `${f.file} has been DELETED.`,
        risk: 'Anything still importing it fails at load. find_residue on this path lists what still points at it.',
        evidence: 'git status --porcelain',
      }));
    }
    if (f.unexpected) {
      out.push(F.make({
        category: F.CATEGORY.GIT,
        severity: F.SEVERITY.INFO,
        confidence: F.CONFIDENCE.OBSERVED,
        source: F.SOURCE.GIT_DIFF,
        file: f.file,
        message: `${f.file} differs from the last commit but was not written by this session.`,
        explanation: 'It may have been dirty before this session started. It is named so that a change nobody '
          + 'intended is not mistaken for part of the work.',
        evidence: 'git status --porcelain, compared against this session\'s recorded writes',
      }));
    }
  }
  if (r.huge) {
    out.push(F.make({
      category: F.CATEGORY.GIT,
      severity: F.SEVERITY.SUSPICIOUS,
      confidence: F.CONFIDENCE.OBSERVED,
      source: F.SOURCE.GIT_DIFF,
      message: `The working tree differs from the last commit by ${r.totalLines} lines across ${r.files.length} files.`,
      explanation: 'A small task producing a very large diff is worth confirming before it is committed.',
      evidence: 'git diff --numstat',
    }));
  }
  return { findings: out, review: r };
}

// -------------------------------------------------------- execution state ----

/**
 * WHAT THE SHELL HAS BEEN DOING, from the attempt ledger.
 *
 * A command that has failed the same way under two shells is a fact the
 * execution layer already established. Carrying it into the briefing is what
 * stops it being rediscovered.
 */
function executionFindings(session) {
  const attempts = session && session.attempts;
  if (!attempts || typeof attempts.loops !== 'function') return { findings: [], loops: [] };
  const loops = attempts.loops();
  const out = loops.map((l) => F.make({
    category: F.CATEGORY.ENVIRONMENT,
    severity: F.SEVERITY.WARNING,
    confidence: F.CONFIDENCE.PROVEN,
    source: F.SOURCE.EXECUTION_ENGINE,
    message: `\`${l.command.slice(0, 120)}\` failed ${l.attempts} times and never succeeded `
      + `(${l.classifications.join(', ')}${l.shells.length > 1 ? `, across ${l.shells.length} shells` : ''}).`,
    explanation: l.shells.length > 1 && l.classifications.length === 1
      ? `Every attempt produced ${l.classifications[0]} under ${l.shells.length} different shells, which `
        + 'eliminates the shell as the cause. Another shell will produce the same result.'
      : 'The failure classification has not changed across attempts, so nothing tried so far has addressed it.',
    risk: 'Repeating it without changing the cause spends a request per attempt.',
    evidence: `Attempt ledger: ${l.attempts} recorded executions of this exact command.`,
  }));
  return { findings: out, loops };
}

// ---------------------------------------------------------------- frontend ----

// (A frontendFindings function lived here — the front-end health axis, read
// off the console of the Chromium LAIN owned. It was removed with the browser
// in 2026-09 per the browser-ownership ruling, together with the axis it fed:
// with no browser there is no way to observe a running front end, and an axis
// that can never be anything but UNVERIFIED is not an axis. The static
// front-end boundary detection in audit.js and projecthealth.js survives — it
// never needed the browser, only the filenames.)

// -------------------------------------------------------------- dead code ----

/**
 * OPT-IN, because it is by far the most expensive thing here: the sweep
 * resolves references for every exported name, which is a tree scan per name.
 * It is also the least urgent — an unreferenced export breaks nothing today —
 * so paying for it on every briefing would make the cheap checks feel slow and
 * teach people not to run them.
 */
function deadCodeFindings(root) {
  let swept;
  try { swept = deadcode.sweep(root, { limit: 200 }); } catch { return []; }
  const rows = (swept && swept.findings) || [];
  return rows
    .filter((r) => r.confidence === deadcode.CONFIDENCE.CONFIRMED)
    .slice(0, 25)
    .map((r) => F.make({
      category: F.CATEGORY.DEAD_CODE,
      severity: F.SEVERITY.INFO,
      confidence: F.CONFIDENCE.INFERRED,
      source: F.SOURCE.SYMBOL_GRAPH,
      file: r.module || null,
      symbol: r.name || null,
      message: `${r.name} (${r.module}) — ${r.verdict}`,
      explanation: r.why || 'No production reference was found.',
      risk: 'A project that reaches code by name at run time can use something this cannot see, so this is a '
        + 'place to look rather than a licence to delete.',
      related: { files: (r.testRefs || []).slice(0, 3).map((t) => `${t.file}:${t.line}`), symbols: [], tests: [] },
      evidence: 'Reference sweep over the source tree',
    }));
}

// ------------------------------------------------------------------ verdicts --

/**
 * Grade each axis from the findings, and from what actually ran.
 *
 * The order of the checks matters: UNVERIFIED is tested FIRST everywhere, so
 * that an axis nobody measured can never fall through into PASS.
 */
function grade({ findings, ran, testRun, lastCommand }) {
  const has = (pred) => findings.some(pred);
  const buildBlocking = (f) => (f.category === F.CATEGORY.SYNTAX || f.category === F.CATEGORY.TYPE)
    && (f.severity === F.SEVERITY.CRITICAL || f.severity === F.SEVERITY.ERROR);

  const build = has(buildBlocking)
    ? HEALTH.FAILED
    : ran.has(F.SOURCE.PARSER) ? HEALTH.PASS : HEALTH.UNVERIFIED;

  const test = !testRun ? HEALTH.UNVERIFIED : testRun.ok ? HEALTH.PASS : HEALTH.FAILED;

  const runtime = !lastCommand ? HEALTH.UNVERIFIED : lastCommand.ok ? HEALTH.PASS : HEALTH.FAILED;

  // ---- ENGINEERING IS GRADED ON EVERYTHING THE BUILD IGNORES -------------
  //
  // Which is the point. A CRITICAL finding fails it, an ERROR or WARNING or
  // SUSPICIOUS degrades it, and only a genuinely empty list is CLEAN — with
  // UNVERIFIED reserved for a sweep that could not complete.
  const engineering = has((f) => f.severity === F.SEVERITY.CRITICAL)
    ? HEALTH.FAILED
    : has((f) => f.severity === F.SEVERITY.ERROR
      || f.severity === F.SEVERITY.WARNING
      || f.severity === F.SEVERITY.SUSPICIOUS)
      ? HEALTH.DEGRADED
      : HEALTH.CLEAN;

  // (The FRONTEND axis was removed with the browser in 2026-09. The axes are
  // build, tests, runtime and engineering.)
  return { build, test, runtime, engineering };
}

/**
 * Run the whole survey.
 *
 * @param {object} o
 * @param {string} o.root
 * @param {object} [o.app]      supplies this session's ledgers
 * @param {object} [o.session]
 * @param {object} [o.testRun]  `{ ok, command, exitCode, output }` if a suite was run
 * @param {object} [o.residue]  `{ gone, removed, present }` to check a migration
 * @param {number} [o.timeoutMs]
 */
async function run({ root, app = null, session = null, testRun = null, residue: residueQuery = null,
  includeDeadCode = false, timeoutMs = toolchain.DEFAULT_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const findings = [];
  const ran = new Set();
  const notes = [];

  // ---- language census, then the analysis that needs no toolchain --------
  const langs = langscan.languages(root);
  const lang = await langscan.scanProject(root);
  findings.push(...lang.findings);
  for (const s of lang.sources) ran.add(s);
  if (lang.truncated) {
    notes.push(`The source sweep was truncated at ${lang.scanned} files. Findings below are from what was read, `
      + 'not from the whole tree.');
  }

  // ---- the project's own toolchain --------------------------------------
  const tc = await toolchain.analyze(root, {
    languages: langs,
    pythonFiles: langs.py ? pythonFiles(root) : [],
    timeoutMs,
  });
  findings.push(...tc.findings);
  for (const s of tc.ran) ran.add(s);
  notes.push(...tc.notes);

  // ---- git ---------------------------------------------------------------
  const life = session && session.lifecycle;
  const expected = life && life.evidence && life.evidence.filesChanged ? [...life.evidence.filesChanged] : [];
  const git = await gitFindings(root, expected);
  findings.push(...git.findings);
  if (git.review && git.review.ok) ran.add(F.SOURCE.GIT_DIFF);

  // ---- execution ---------------------------------------------------------
  const exec = executionFindings(session);
  findings.push(...exec.findings);
  if (session && session.attempts) ran.add(F.SOURCE.EXECUTION_ENGINE);

  // ---- front end ---------------------------------------------------------
  // (This used to read the browser console of a running front end — see the
  // frontend note above the dead-code section. The browser it read is gone,
  // and with it the only way this survey had of observing a page at runtime.)

  // ---- migration residue, when a migration was named ---------------------
  let residueResult = null;
  if (residueQuery && (residueQuery.gone || residueQuery.removed || residueQuery.present)) {
    residueResult = residue.check(root, residueQuery);
    ran.add(F.SOURCE.RESIDUE_SCANNER);
    findings.push(...residueToFindings(residueResult));
  }

  // ---- dead code, only when asked ---------------------------------------
  if (includeDeadCode) {
    findings.push(...deadCodeFindings(root));
    ran.add(F.SOURCE.SYMBOL_GRAPH);
  }

  // ---- THE OPERATIONAL CONTRACT -----------------------------------------
  //
  // Facts, not findings, and kept apart from them all the way through — see
  // facts.js. A convention that could not be established becomes an UNKNOWN
  // fact rather than an absent one, because absence reads as "fine".
  //
  // The contradiction detectors are the other half: where the DOCUMENTATION of
  // a convention disagrees with its IMPLEMENTATION. Those genuinely are
  // findings, and are pushed into the same list as everything else.
  const facts = [];
  const factErrors = [];
  const gather = (label, fn) => {
    try { return fn(); } catch (e) { factErrors.push(`${label}: ${(e && e.message) || e}`); return null; }
  };

  const contractFacts = gather('execution contract', () => require('./contracts').discover(root, {
    sessionCwd: session && session.cwd ? session.cwd : null,
  }));
  if (contractFacts) facts.push(...contractFacts);

  const cli = gather('CLI and configuration contract', () => require('./clifacts').discover(root));
  if (cli) { facts.push(...cli.facts); findings.push(...cli.contradictions); }

  const data = gather('data contract', () => require('./datafacts').discover(root));
  if (data) { facts.push(...data.facts); findings.push(...data.findings); }

  if (factErrors.length) {
    notes.push(`Some conventions could not be established: ${factErrors.join('; ')}.`);
  }

  // ---- tests -------------------------------------------------------------
  if (testRun) {
    ran.add(F.SOURCE.TEST_RUNNER);
    if (!testRun.ok) {
      findings.push(F.make({
        category: F.CATEGORY.TEST,
        severity: F.SEVERITY.ERROR,
        confidence: F.CONFIDENCE.PROVEN,
        source: F.SOURCE.TEST_RUNNER,
        message: `${testRun.command} exited ${testRun.exitCode}.`,
        explanation: 'The suite ran and reported failures. The failing test names are the fastest route to the '
          + 'defect, and they are in the output rather than in this summary.',
        evidence: String(testRun.output || '').slice(-1200),
      }));
    }
  } else {
    findings.push(F.make({
      category: F.CATEGORY.UNVERIFIED,
      severity: F.SEVERITY.UNVERIFIED,
      confidence: F.CONFIDENCE.PROVEN,
      source: F.SOURCE.FILESYSTEM,
      message: 'The test suite was not run as part of this survey.',
      explanation: 'Static analysis cannot tell whether behaviour is correct. Run the suite to grade TEST health.',
    }));
  }

  const lastCommand = life ? life.lastCommand : null;
  const health = grade({ findings, ran, testRun, lastCommand });

  return {
    root,
    findings,
    facts,
    health,
    ran,
    notes,
    skipped: tc.skipped,
    languages: langs,
    scanned: lang.scanned,
    environment: safeEnvironment(root),
    git: git.review,
    loops: exec.loops,
    residue: residueResult,
    lastCommand,
    testRun,
    elapsedMs: Date.now() - started,
  };
}

function safeEnvironment(root) {
  try { return environment.detect(root); } catch { return null; }
}

/** Turn a residue result into findings, one per thing that should have gone. */
function residueToFindings(r) {
  const out = [];
  for (const g of r.gone || []) {
    if (g.state === residue.STATE.GONE || g.state === residue.STATE.TEXT_ONLY) continue;
    const first = g.definitions[0] || g.references[0] || null;
    out.push(F.make({
      category: F.CATEGORY.MIGRATION_RESIDUE,
      severity: F.SEVERITY.ERROR,
      confidence: F.CONFIDENCE.PROVEN,
      source: F.SOURCE.RESIDUE_SCANNER,
      file: first ? first.where : null,
      line: first ? first.line : null,
      symbol: g.name,
      message: `${g.name} was supposed to be gone and is ${g.state.toLowerCase()}.`,
      explanation: 'The replacement exists and works, which is why the tests are green. The old implementation '
        + 'also still exists, so the project now has two sources of truth and the next edit may land on the '
        + 'wrong one.',
      risk: 'Two sources of truth. Whichever is edited, the other keeps serving somebody.',
      evidence: `${g.definitions.length} definition(s), ${g.references.length} live reference(s), `
        + `${g.text.length} mention(s) in strings or comments.`,
      related: {
        files: [...g.definitions, ...g.references].slice(0, 8).map((d) => `${d.where}:${d.line}`),
        symbols: [g.name],
        tests: g.references.filter((x) => x.test).slice(0, 4).map((x) => `${x.where}:${x.line}`),
      },
    }));
  }
  for (const p of r.removed || []) {
    if (!p.stillThere && !p.importers.length) continue;
    out.push(F.make({
      category: F.CATEGORY.MIGRATION_RESIDUE,
      severity: p.stillThere ? F.SEVERITY.WARNING : F.SEVERITY.CRITICAL,
      confidence: F.CONFIDENCE.PROVEN,
      source: F.SOURCE.RESIDUE_SCANNER,
      file: p.path,
      message: p.stillThere
        ? `${p.path} was supposed to be deleted and is still on disk (${p.importers.length} importer(s)).`
        : `${p.path} is deleted but ${p.importers.length} file(s) still import it.`,
      explanation: p.stillThere
        ? 'A file that should have gone is still present and may still be reachable.'
        : 'An import of a file that does not exist fails at load time, not at call time.',
      related: { files: p.importers.map((i) => `${i.where}:${i.line}`), symbols: [], tests: [] },
      evidence: 'Import specifiers resolved from the symbol model',
    }));
  }
  for (const p of r.present || []) {
    if (p.definitions.length) continue;
    out.push(F.make({
      category: F.CATEGORY.MIGRATION_RESIDUE,
      severity: F.SEVERITY.CRITICAL,
      confidence: F.CONFIDENCE.PROVEN,
      source: F.SOURCE.RESIDUE_SCANNER,
      symbol: p.name,
      message: p.references.length
        ? `${p.name} is referenced but never defined — the new path is wired to something that does not exist.`
        : `${p.name} was supposed to replace the old implementation and does not exist anywhere.`,
      related: { files: p.references.slice(0, 6).map((x) => `${x.where}:${x.line}`), symbols: [], tests: [] },
      evidence: 'Symbol sweep found no definition',
    }));
  }
  return out;
}

module.exports = { run, HEALTH, grade, residueToFindings, executionFindings, pythonFiles };
