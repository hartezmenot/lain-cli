'use strict';

/**
 * LOOK BEFORE YOU SPEND: deterministic diagnostics in front of a test run.
 *
 * ------------------------------------------------------------------------
 * THE WASTE THIS REMOVES.
 *
 * A suite run on this repository is minutes. A typo is microseconds. Today the
 * order is the wrong way round: the model edits a file, runs the suite, waits,
 * reads a stack trace, and discovers
 *
 *     NameError: name 'pirnt' is not defined
 *
 * which `ruff` would have said before a single test started. The cost is not
 * only the minutes — it is the model REQUEST that reads the failure, at the
 * measured ~65,000 input tokens, to learn something a linter already knew.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DOES, AND THE ONE THING IT REFUSES TO DO.
 *
 * Before a suite runs, the files changed IN THIS SESSION are checked with the
 * project's own tooling — the same `filecheck` ladder the edit path uses, which
 * runs `ruff`, `pyflakes` or the project's configured `eslint` and NOTHING it
 * had to invent. If that finds an error, the suite does not run and the error
 * is returned instead.
 *
 * IT DOES NOT DECIDE THAT THE CODE IS CORRECT. A clean check is not a passing
 * test and this never says it is: when nothing is found, the suite runs exactly
 * as it always did. The asymmetry is the whole design — a linter can prove a
 * file is broken and cannot prove it works.
 *
 * ------------------------------------------------------------------------
 * IT IS A GATE THAT OPENS. `force: true` runs the suite anyway, and the message
 * says so. That matters more than it looks: a pre-existing error in a file that
 * was touched for an unrelated reason would otherwise make the tests
 * unreachable, and a guard that can trap you is a guard people learn to route
 * around. The escape is one argument and it is named in the refusal.
 *
 * ------------------------------------------------------------------------
 * ONLY WHAT CHANGED. Checking the whole tree before every run would be its own
 * kind of waste and would surface a hundred pre-existing warnings nobody asked
 * about. The changed set comes from the checkpoint ledger, which is the same
 * source `/changes` and `/undo` read — there is no second idea here of what has
 * been touched.
 */

const path = require('path');

/** Never stall a test run behind a checker: this is meant to be the cheap step. */
const BUDGET_MS = 8000;

/** Beyond this many changed files, checking them all stops being the cheap step. */
const MAX_FILES = 25;

/**
 * The files this session has changed, as absolute paths.
 *
 * Read from the checkpoint ledger rather than from git: the question is "what
 * has LAIN touched in this session", which is not the same as "what differs
 * from HEAD", and only the first one is this gate's business.
 */
function changedPaths(app, cwd) {
  const checkpoints = app && app.checkpoints;
  if (!checkpoints) return [];
  let rows = [];
  try { rows = require('./ui/panes').changedFiles({ checkpoints, cwd }); } catch { return []; }
  const out = [];
  for (const r of rows) {
    if (!r || !r.path) continue;
    // A file that was DELETED has nothing to check.
    try { if (!require('fs').statSync(r.path).isFile()) continue; } catch { continue; }
    out.push(path.resolve(r.path));
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/**
 * SHOULD THIS SUITE RUN?
 *
 * @returns {Promise<{stop:boolean, result?:object, checked:number}>}
 *   `stop` is true only when a real checker reported a real error in a file
 *   this session changed. Everything else — no checker, nothing changed, a
 *   checker that could not read its own output — lets the suite run.
 */
async function guard(ctx, cwd, input = {}) {
  if (input && input.force) return { stop: false, checked: 0, forced: true };
  const app = ctx && ctx.app;
  const paths = changedPaths(app, cwd);
  if (!paths.length) return { stop: false, checked: 0 };

  // ---- THE SAME LADDER THE EDIT PATH USES, IN THE SAME ORDER -------------
  //
  // `diagnostics` is rung one: does the file parse at all. It needs no external
  // tool, so it works on every machine — which matters, because rung three
  // needs the project to actually have a linter installed and this repository's
  // own machine has no `ruff` and no `pyflakes`. A gate that only used rung
  // three would be silently inert exactly where it was most needed.
  //
  // `filecheck` is rung three: the project's own linter on the changed file.
  // It is what catches `pirnt("hello")`, which parses perfectly.
  let report = '';
  try {
    report = await Promise.race([
      (async () => {
        const parse = await require('./diagnostics').reportFor(paths, cwd);
        // A FILE THAT DOES NOT PARSE ENDS IT HERE. Running a linter over
        // something the parser already rejected produces noise about a file
        // whose one real problem is already known.
        if (parse) return parse;
        return require('./filecheck').reportFor(paths, cwd);
      })(),
      // A CHECKER THAT HANGS MUST NOT HOLD THE SUITE. The budget expiring is
      // indistinguishable from "nothing found" on purpose: the failure mode of
      // this gate must always be to let the tests run.
      new Promise((r) => setTimeout(() => r(''), BUDGET_MS)),
    ]);
  } catch {
    report = '';
  }
  if (!report) return { stop: false, checked: paths.length };

  const rel = paths.map((p) => path.relative(cwd, p).replace(/\\/g, '/'));
  const output = [
    'TESTS NOT RUN — the checker found an error in what you just changed.',
    '',
    report,
    '',
    `Checked ${paths.length} file(s) changed in this session:`,
    ...rel.slice(0, 10).map((r) => `  ${r}`),
    rel.length > 10 ? `  [${rel.length - 10} more]` : null,
    '',
    'A suite run takes minutes and this took milliseconds. Fix the error and run',
    'the tests again. If this is pre-existing or you want the suite anyway, call',
    'run_tests again with force: true.',
  ].filter((l) => l !== null).join('\n');

  return {
    stop: true,
    checked: paths.length,
    result: {
      output,
      // NOT `isError`. Nothing failed — a cheap check found a problem before an
      // expensive one could, which is the gate working rather than breaking.
      meta: { testState: null, pretest: 'blocked', checked: paths.length },
    },
  };
}

module.exports = { guard, changedPaths, BUDGET_MS, MAX_FILES };
