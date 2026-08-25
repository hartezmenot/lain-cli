'use strict';

/**
 * THE THIRD RUNG — the project's OWN linter, on ONE file, with a short budget.
 *
 * ------------------------------------------------------------------------
 * THE GAP THIS CLOSES, and it is one specific example that stands for a class.
 *
 *     pirnt("hello")
 *
 * That file parses. `ast.parse` accepts it, `node --check` would accept its
 * JavaScript equivalent, and `typos.js` — the second rung — reads a code model
 * that `codemodel.js` only builds for JavaScript. So in a Python file this
 * reached the model as a clean write, and the defect was discovered by RUNNING
 * it: a test suite, a stack trace, a NameError, and a turn spent working
 * backwards to a typo that a linter names in eight milliseconds.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT "ADD A LINTER TO THE EDIT PATH", which would be a bad idea.
 *
 * Three rules, and each of them is a thing that would otherwise make the edit
 * path worse than the problem it is solving:
 *
 *   FILE-SCOPED, NEVER PROJECT-SCOPED. `tsc --noEmit` and `cargo check` are the
 *     strongest analysers this repository knows about and they are deliberately
 *     NOT here: both are whole-project, both take seconds to minutes, and
 *     hanging that off every write would make editing a large repository
 *     unusable. They stay in toolchain.js, where a person asks for them.
 *
 *   ONLY WHAT THE PROJECT ALREADY HAS. A linter is a set of opinions, and
 *     running one the project did not choose produces findings its authors
 *     deliberately turned off. So: a local `node_modules/.bin` binary and an
 *     eslint config, or a `ruff` the environment actually provides. Nothing is
 *     installed, and nothing is inferred from a language alone.
 *
 *   SILENCE ON DOUBT. A checker that reports a problem in correct code is worse
 *     than no checker — the model spends a turn "fixing" working code, and after
 *     two false alarms learns to ignore the channel. Every path here that cannot
 *     answer returns nothing at all, and says so with `inconclusive` rather than
 *     with an empty list that reads as a clean result.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DOES NOT REPLACE. This is the cheap rung, and its whole purpose is
 * that the expensive ones are reached LESS OFTEN rather than never. A linter
 * does not know whether the change was correct; the tests do. §21 is explicit
 * that the runtime exposes the cheap verification and the model decides when to
 * escalate — this is the exposing half, and it decides nothing.
 */

const fs = require('fs');
const path = require('path');

const { execute, onPath, findPython } = require('./tools/exec');

/**
 * A file-scoped linter that has not answered in this long is not the cheap rung
 * any more. Short on purpose: the alternative to a slow answer here is not a
 * wrong answer, it is the model running the tests, which it was going to do
 * anyway.
 */
const TIMEOUT_MS = 6000;
/** Rows one file may contribute. A linter's opinion, not its collected works. */
const MAX_ROWS = 12;

const PY = /\.py$/i;
const JS = /\.(?:js|cjs|mjs|jsx|ts|tsx|mts|cts)$/i;

/**
 * Availability is asked ONCE per root per language, and the answer is kept.
 *
 * Probing costs a directory walk of PATH, and the edit path may run a dozen
 * times in a turn. The cache is per process, so installing a linter is picked up
 * by the next LAIN rather than the next keystroke — which is the right trade for
 * something consulted this often.
 */
const found = new Map();

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/** The locally installed CLI — the one the project actually uses. */
function localBin(root, name) {
  const dir = path.join(root, 'node_modules', '.bin');
  for (const ext of process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']) {
    const p = path.join(dir, name + ext);
    if (exists(p)) return p;
  }
  return null;
}

/** Does this project lint its JavaScript at all? A config is the evidence. */
function hasEslintConfig(root) {
  const names = [
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json',
    '.eslintrc.yml', '.eslintrc.yaml',
  ];
  if (names.some((n) => exists(path.join(root, n)))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return Boolean(pkg && pkg.eslintConfig);
  } catch { return false; }
}

/**
 * WHICH CHECKER, IF ANY, FOR THIS FILE.
 *
 * Returns `{ tool, file, args }` or null. Ordered strongest-first within a
 * language, and every entry is file-scoped and fast — see the three rules above.
 */
function checkerFor(abs, root) {
  // THE KEY IS A JSON PAIR, not two strings glued together. A separator has
  // to be a character a filesystem path cannot contain, which on the way to
  // being correct means a raw control byte in a source file — invisible in
  // every editor and diff, and banned by the architecture guard for that
  // reason. (It caught the first draft of this line.) A pair is unambiguous
  // without needing a byte nobody can see.
  const key = JSON.stringify([root, PY.test(abs) ? 'py' : JS.test(abs) ? 'js' : 'other']);
  if (!found.has(key)) found.set(key, probe(abs, root));
  const c = found.get(key);
  return c ? { ...c, args: c.argsFor(abs) } : null;
}

function probe(abs, root) {
  if (PY.test(abs)) {
    // RUFF FIRST. It is the only widely available Python tool that is both fast
    // enough for this path (single-digit milliseconds) and able to answer the
    // question that matters here — F821, a name that resolves to nothing, which
    // is the `pirnt` case exactly.
    const local = localBin(root, 'ruff');
    if (local) {
      return {
        tool: 'ruff',
        file: local,
        argsFor: (f) => ['check', '--output-format=json', '--force-exclude', '--quiet', f],
        parse: parseRuff,
      };
    }
    if (onPath('ruff')) {
      return {
        tool: 'ruff',
        file: 'ruff',
        argsFor: (f) => ['check', '--output-format=json', '--force-exclude', '--quiet', f],
        parse: parseRuff,
      };
    }
    // PYFLAKES IS THE SAME QUESTION, ASKED BY AN OLDER TOOL. Reached through
    // `-m` rather than a binary because that is how it is usually present, and
    // because it works whether it was installed globally or into a venv this
    // interpreter is already inside.
    const py = findPython();
    if (py.ok) {
      return {
        tool: 'pyflakes',
        file: py.exe,
        argsFor: (f) => ['-m', 'pyflakes', f],
        parse: parsePyflakes,
        // A MISSING MODULE IS NOT A CLEAN FILE. `python -m pyflakes` on a
        // machine without it exits non-zero saying so, and reporting that as a
        // finding would put "No module named pyflakes" in the model's lap as
        // though it were a defect in the file it just wrote.
        absent: /No module named/i,
      };
    }
    return null;
  }

  if (JS.test(abs)) {
    // ONLY IF THE PROJECT LINTS. An eslint with no config lints nothing useful,
    // and an eslint the project did not choose reports rules its authors turned
    // off. Both halves are required.
    const local = localBin(root, 'eslint');
    if (local && hasEslintConfig(root)) {
      return {
        tool: 'eslint',
        file: local,
        argsFor: (f) => ['--format', 'json', '--no-color', f],
        parse: parseEslint,
      };
    }
    return null;
  }

  return null;
}

// ------------------------------------------------------------------ parsers --
//
// Each returns `{ rows }` or `{ inconclusive: true }`. Output a parser does not
// recognise is inconclusive, NEVER an empty list: "the tool said something I
// could not read" and "the file is clean" are different facts, and collapsing
// them is how a checker starts silently passing everything.

function parseRuff(r) {
  const text = String(r.stdout || '').trim();
  if (!text) return r.exitCode === 0 ? { rows: [] } : { inconclusive: true };
  let j;
  try { j = JSON.parse(text); } catch { return { inconclusive: true }; }
  if (!Array.isArray(j)) return { inconclusive: true };
  return {
    rows: j.map((d) => ({
      line: (d.location && d.location.row) || null,
      column: (d.location && d.location.column) || null,
      code: d.code || '',
      message: String(d.message || '').trim(),
    })).filter((d) => d.message),
  };
}

function parsePyflakes(r) {
  const out = `${r.stdout || ''}`;
  const rows = [];
  for (const line of out.split('\n')) {
    // `path:line:col message` — col is absent in older releases.
    const m = /^(.*?):(\d+):(?:(\d+):)?\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    rows.push({ line: Number(m[2]), column: m[3] ? Number(m[3]) : null, code: '', message: m[4].trim() });
  }
  if (!rows.length && r.exitCode !== 0 && out.trim()) return { inconclusive: true };
  return { rows };
}

function parseEslint(r) {
  const text = String(r.stdout || '').trim();
  if (!text) return r.exitCode === 0 ? { rows: [] } : { inconclusive: true };
  let j;
  try { j = JSON.parse(text); } catch { return { inconclusive: true }; }
  if (!Array.isArray(j)) return { inconclusive: true };
  const rows = [];
  for (const f of j) {
    for (const m of f.messages || []) {
      // ERRORS ONLY. A warning is a style opinion the project has explicitly
      // declined to enforce, and putting one in front of a model mid-edit is
      // asking it to spend a turn on something nobody wanted stopped for.
      if (m.severity !== 2) continue;
      rows.push({
        line: m.line || null,
        column: m.column || null,
        code: m.ruleId || '',
        message: String(m.message || '').trim(),
      });
    }
  }
  return { rows };
}

/**
 * RUN THE CHECKER FOR ONE FILE.
 *
 * @returns {Promise<{tool, rows}|{inconclusive:true}>} — `rows: []` means the
 *   checker ran and found nothing, which is the only clean result there is.
 */
async function check(abs, cwd) {
  const root = cwd || process.cwd();
  let c;
  try { c = checkerFor(abs, root); } catch { c = null; }
  if (!c) return { inconclusive: true };
  let r;
  try {
    // ARGV AS AN ARRAY, no shell: a path with a space in it is a path with a
    // space in it, and nothing re-parses it on the way to the process.
    r = await execute(c.file, c.args, { cwd: root, timeoutMs: TIMEOUT_MS });
  } catch { return { inconclusive: true }; }
  // A TIMEOUT IS NOT A PASS. Reported as inconclusive so it disappears rather
  // than becoming a clean bill of health for a file nobody managed to check.
  if (!r || r.timedOut || r.interrupted) return { inconclusive: true };
  if (c.absent && c.absent.test(`${r.stderr || ''}`)) return { inconclusive: true };
  let parsed;
  try { parsed = c.parse(r); } catch { parsed = { inconclusive: true }; }
  if (!parsed || parsed.inconclusive) return { inconclusive: true };
  return { tool: c.tool, rows: parsed.rows.slice(0, MAX_ROWS), truncated: parsed.rows.length > MAX_ROWS };
}

/**
 * PHRASE IT FOR THE MODEL — the same contract diagnostics.reportFor has.
 *
 * A STRING appended to the tool's own output, never an error: the write really
 * happened and the file really is on disk, and reporting a lint finding as a
 * failed call would be untrue. What changed is where the model learns about it.
 *
 * '' when there is nothing to say, which includes every case where nothing could
 * be asked.
 */
async function reportFor(paths, cwd) {
  if (!Array.isArray(paths) || !paths.length) return '';
  const byTool = new Map();
  for (const abs of paths) {
    let r;
    try { r = await check(abs, cwd); } catch { r = { inconclusive: true }; }
    if (!r || r.inconclusive || !r.rows.length) continue;
    const where = cwd ? (path.relative(cwd, abs) || abs).replace(/\\/g, '/') : abs;
    if (!byTool.has(r.tool)) byTool.set(r.tool, []);
    for (const d of r.rows) {
      byTool.get(r.tool).push(`  ${where}:${d.line || '?'}${d.column ? `:${d.column}` : ''}`
        + `  ${d.code ? `${d.code}  ` : ''}${d.message}`);
    }
  }
  if (!byTool.size) return '';
  const blocks = [];
  for (const [tool, rows] of byTool) {
    // THE TOOL IS NAMED. "ruff says F821" and "LAIN thinks this looks wrong" are
    // different claims with different weights, and a model deciding whether to
    // act on a finding is entitled to know which one it is reading.
    blocks.push(`${tool.toUpperCase()} — the file was written; ${tool} reports:\n${rows.join('\n')}`);
  }
  return `\n\n${blocks.join('\n\n')}`;
}

module.exports = { check, reportFor, checkerFor, TIMEOUT_MS, MAX_ROWS, _found: found };
