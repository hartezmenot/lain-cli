'use strict';

/**
 * THE TWO TEST QUESTIONS, AS TWO TOOLS.
 *
 * `discover_tests` answers WHAT EXISTS. It reads files, spawns nothing, costs
 * nothing, and its answer can never be "they pass" — the only two states it can
 * return are NO_TESTS_FOUND and TESTS_FOUND_NOT_RUN.
 *
 * `run_tests` answers WHAT HAPPENED. It can only be reached by actually
 * spawning a runner, and it returns a classified state that distinguishes a
 * genuine failure from a blocked one.
 *
 * WHY THIS IS NOT `run_powershell "npm test"`. It is, underneath — the shell is
 * unrestricted and the model may still do exactly that. What these add is the
 * two things a raw shell cannot give it:
 *
 *   A SEARCH IT DID NOT HAVE TO INVENT. "Are there tests?" was previously
 *     answered by whatever the model happened to `ls`, which is how a tree with
 *     179 test files in it got reported as having none.
 *
 *   A VERDICT THAT SEPARATES LAYERS. `npm test` exits 1 when an assertion fails
 *     and exits 1 when the provider rate-limits the suite, and only one of those
 *     is a reason to change code. See testing.js BLOCKED_SIGNS.
 *
 * NEITHER TOOL EVER SUMMARISES OPTIMISTICALLY. Every result leads with the
 * state word, and the state word is derived from the run, never from the shape
 * of the request.
 */

const path = require('path');

const testing = require('../testing');
const shell = require('./shell');
const execution = require('../execution');
const environment = require('../environment');

/** A suite gets longer than an ordinary command: a real one takes minutes. */
const DEFAULT_TIMEOUT_MS = 600000;

/**
 * A GREEN SUITE'S PER-TEST LINES ARE NOT EVIDENCE.
 *
 * ------------------------------------------------------------------------
 * THE MEASUREMENT. A passing run of this project's own unit tier prints
 * 137,234 characters — 2,122 lines, all but a handful of them one `✓` and the
 * name of a test that did what it was written to do. Capped by shell.js at
 * 100,000, that is roughly 27,800 estimated tokens handed back for a result the
 * classifier above has ALREADY reduced to its decision-relevant form:
 *
 *     TESTS_PASSED
 *       counts: 1974 passed, 0 failed
 *
 * Verification is the most repeated step in a coding loop — the prompt tells
 * the model to run something that would fail if it were wrong, after every
 * change — so this is not one large result, it is a large result per fix.
 *
 * ------------------------------------------------------------------------
 * WHAT IS DROPPED, AND WHY IT COSTS NOTHING TO DROP IT.
 *
 * ONLY on TESTS_PASSED, which by construction means nothing failed and nothing
 * was skipped — a skip makes it TESTS_PARTIAL, a failure TESTS_FAILED, and a
 * blocker TESTS_BLOCKED. On those three, every byte is returned untouched:
 * failure output is the single most valuable evidence this tool can produce and
 * is never abbreviated.
 *
 * And only lines that are THEMSELVES a passing-test marker. Everything else
 * survives — headers, blank lines, deprecation warnings, the runner's own
 * summary, anything unrecognised. That is the safe direction: a pattern that
 * fails to match keeps a line that could have gone, while the reverse would
 * hide something nobody chose to hide. Under-eliding is recoverable; eliding
 * something that mattered is not.
 *
 * THIS IS NOT A CONTEXT CAP. It removes confirmations of success that the
 * counts state exactly, and it says how many it removed.
 */
const QUIET_PASS_MIN_CHARS = 4000;
const QUIET_PASS_MIN_LINES = 40;
/**
 * One line that says one test passed, across the runners a project is likely to
 * use: ✓/✔/√ (mocha, vitest, jest, this repo), TAP `ok 12 - name`, pytest's
 * `path::test_x PASSED`, and unittest's `test_x (...) ... ok`.
 *
 * Deliberately anchored and narrow. `ok` alone would match prose; a bare `PASS`
 * would match a jest per-FILE line, which is a summary worth keeping.
 */
const PASS_LINE = /^\s*(?:[✓✔√]\s|ok\s+\d+\s|.+\s\.{3}\s+ok\s*$|\S+::\S+\s+PASSED\b)/u;

/**
 * Drop the per-test confirmations from an output that already passed.
 * Returns the text unchanged whenever there is nothing worth doing.
 */
function quietPass(output) {
  const text = String(output == null ? '' : output);
  if (text.length < QUIET_PASS_MIN_CHARS) return { text, dropped: 0 };
  const lines = text.split('\n');
  if (lines.length < QUIET_PASS_MIN_LINES) return { text, dropped: 0 };
  const kept = lines.filter((l) => !PASS_LINE.test(l));
  const dropped = lines.length - kept.length;
  // Nothing recognisable was found, so this runner reports in a shape these
  // patterns do not cover. Say nothing and change nothing.
  if (dropped < QUIET_PASS_MIN_LINES) return { text, dropped: 0 };
  return { text: kept.join('\n'), dropped };
}

function resolveCwd(ctx, input) {
  const base = (ctx && ctx.cwd) || process.cwd();
  const want = input && input.cwd ? String(input.cwd).trim() : '';
  if (!want) return base;
  return path.isAbsolute(want) ? want : path.resolve(base, want);
}

const tools = {
  discover_tests: {
    mutates: false,
    schema: {
      name: 'discover_tests',
      description: 'Find out whether this project has tests, and how they are run — WITHOUT running them. '
        + 'Reads manifests (package.json scripts, pytest.ini, Cargo.toml, go.mod, Makefile targets, CI workflows) '
        + 'and walks the tree for test files. Returns NO_TESTS_FOUND or TESTS_FOUND_NOT_RUN, the exact commands, '
        + 'the file counts, and — when nothing is found — where it looked. '
        + 'Call this before saying anything about a project\'s tests: "there are no tests" is a claim that needs '
        + 'a search behind it, and this is the search. It costs nothing and spawns no process.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'directory to inspect; defaults to the working directory' },
        },
      },
    },
    async run(input, ctx) {
      const cwd = resolveCwd(ctx, input);
      let report;
      try { report = testing.discover(cwd); } catch (e) {
        return { output: `could not inspect ${cwd}: ${(e && e.message) || e}`, isError: true };
      }
      const out = testing.lines(report).join('\n');
      return {
        output: out,
        meta: {
          testState: report.state,
          suites: report.suites.map((s) => s.command),
          testFiles: report.files.count,
        },
      };
    },
  },

  run_tests: {
    // A suite runs the project's own code, which may write anything. Treated as
    // mutating for the same reason the shell is: what it does is not knowable
    // from the command line.
    mutates: true,
    schema: {
      name: 'run_tests',
      description: 'Actually run this project\'s tests and report a CLASSIFIED result. '
        + 'Discovers the command if you do not pass one. Returns one of TESTS_PASSED, TESTS_FAILED, '
        + 'TESTS_BLOCKED (something outside the code stopped it — a rate limit, a quota, a missing dependency, '
        + 'a runner that is not installed), TESTS_PARTIAL (some ran, some were skipped or blocked) or '
        + 'NO_TESTS_FOUND. A BLOCKED result is NOT a failing test and is not a reason to change code — '
        + 'it names the layer that stopped the run. Use this rather than reading an exit code yourself.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'the exact command to run; omit to use the discovered one' },
          which: {
            type: 'string',
            description: '"project" (default) for the real suite, "smoke" for a quick start-up check',
          },
          cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
          force: { type: 'boolean',
          description: 'run the suite even if fast diagnostics report an error in a file you changed (default false)' },
        timeout_ms: { type: 'number', description: 'optional timeout in milliseconds' },
        },
      },
    },
    async run(input, ctx) {
      const cwd = resolveCwd(ctx, input);

      // ---- THE CHEAP CHECK GOES FIRST ------------------------------------
      //
      // A suite run is minutes; a linter is milliseconds. Discovering
      // `NameError: name 'pirnt' is not defined` from a stack trace costs the
      // run AND the model request that reads it - measured at ~65,000 input
      // tokens to learn something ruff already knew.
      //
      // IT ONLY EVER STOPS ON A REAL ERROR in a file this session changed, and
      // `force: true` runs the suite anyway. A clean check is NOT treated as
      // proof the code works: when nothing is found, everything below runs
      // exactly as it did before. See src/pretest.js.
      const gate = await require('../pretest').guard(ctx, cwd, input);
      if (gate.stop) return gate.result;

      const report = testing.discover(cwd);

      let command = String((input && input.command) || '').trim();
      let chosen = null;
      if (!command) {
        const which = String((input && input.which) || 'project').toLowerCase();
        const wantSmoke = which === 'smoke';
        chosen = wantSmoke
          ? report.suites.find((s) => s.kind === testing.KIND.SMOKE) || testing.primary(report)
          : testing.primary(report);
        if (!chosen) {
          // NOT A FAILURE OF THE TOOL, and the difference matters: the model
          // asked a reasonable question and the honest answer is that this tree
          // does not say how to run anything.
          return {
            output: testing.lines(report).join('\n')
              + '\n\nNothing was run — no command was given and none could be discovered.',
            meta: { testState: report.state },
          };
        }
        command = chosen.command;
      }

      const preferred = environment.detectShell().preferred;
      const sh = preferred === 'powershell' ? 'powershell' : (preferred === 'cmd' ? 'cmd' : 'bash');

      const r = await shell.run(command, {
        shell: sh,
        cwd,
        timeoutMs: Number(input && input.timeout_ms) || DEFAULT_TIMEOUT_MS,
        signal: ctx && ctx.signal,
      });

      // The user stopping it is the user's decision, not a verdict about tests.
      if (r.interrupted) return { output: r.output, isError: true, meta: { testState: null } };

      // `r` already carries `exitCode`, which is the field execution.classify
      // reads. Adding a second name for it here would be a spare copy that a
      // later edit could set and this one would go on ignoring.
      const { text, verdict } = execution.annotate({ ...r, shell: sh, cwd, command });
      const v = testing.classifyRun({
        output: r.output,
        stderr: r.stderr,
        code: r.exitCode,
        timedOut: r.timedOut,
        classification: verdict.class,
      });

      const head = [
        v.state,
        `  command: ${command}${chosen ? `   (${chosen.from})` : ''}`,
        `  ${v.why}`,
        v.counts.seen
          ? `  counts: ${v.counts.passed} passed, ${v.counts.failed} failed`
            + (v.counts.skipped ? `, ${v.counts.skipped} skipped` : '')
          : '  counts: the runner printed none',
      ];
      // KEYED ON THE LAYER, NOT ON THE STATE. TESTS_PARTIAL has two causes: a
      // blocker beside real results, which names a layer, and an ordinary run
      // with skips, which names nothing. Keying on the state printed "the layer
      // that stopped it is null" for the second one — a sentence that is worse
      // than silence, because it invites the model to go looking for a layer
      // that does not exist.
      if (v.layer) {
        head.push(`  THIS IS NOT A CODE FAILURE — the layer that stopped it is ${v.layer}.`);
        head.push('  Do not change code to "fix" it. Say what is blocked and why.');
      } else if (v.state === testing.STATE.TESTS_PARTIAL) {
        head.push('  Some tests were SKIPPED. What ran passed; what was skipped was not measured.');
      }

      // ONLY THE GREEN PATH IS QUIETENED — see quietPass. A failing, blocked or
      // partial run returns every byte it produced.
      let body = r.output;
      if (v.state === testing.STATE.TESTS_PASSED) {
        const q = quietPass(r.output);
        if (q.dropped) {
          // THE ADVICE HERE IS THE TARGETED ONE, deliberately. An earlier
          // version said "re-run `<command>` with run_bash and grep it" —
          // which teaches the model to spend a SECOND FULL SUITE RUN (minutes,
          // and another request to read) to answer a question the first run
          // already settled. The counts above ARE the complete verdict; a
          // single test's line is recoverable with the runner's own filter,
          // which costs one flag, not one re-run of everything.
          body = `${q.text}\n\n[${q.dropped} individually passing test line(s) removed from this result — `
            + `the counts above are the complete verdict. To see one test by name, run the suite `
            + `with the runner's own filter for it (e.g. \`-t\`/\`--filter\`/\`-k\`) rather than `
            + `re-running everything.]`;
        }
      }

      return {
        output: `${head.join('\n')}\n\n${execution.leadWith(body, text)}`,
        // A BLOCKED RUN IS AN ERROR RESULT and a PASSED one is not; PARTIAL is
        // not an error either, because the tests that ran really did pass.
        isError: v.state === testing.STATE.TESTS_FAILED || v.state === testing.STATE.TESTS_BLOCKED,
        meta: {
          testState: v.state,
          counts: v.counts,
          layer: v.layer,
          command,
          shell: sh,
          cwd,
          classification: verdict.class,
        },
      };
    },
  },
};

module.exports = { tools, DEFAULT_TIMEOUT_MS, quietPass, PASS_LINE };
