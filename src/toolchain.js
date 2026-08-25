'use strict';

/**
 * NATIVE ANALYSERS — the project's own toolchain, asked its own questions.
 *
 * A type error in TypeScript is a question only `tsc` can answer. A Go vet
 * finding is only available from `go vet`. Reimplementing any of that would
 * mean shipping a worse copy of a tool the project already has configured, and
 * being confidently wrong wherever the copy diverged. So this file does not
 * analyse anything: it FINDS the analyser, runs it, and translates what it says
 * into the one finding shape.
 *
 * THE HONESTY RULE, and it is the whole reason this file is shaped the way it
 * is. Every analyser answers three separate questions:
 *
 *   applies    does this project contain this language at all
 *   available  is the tool actually installed HERE
 *   run        what did it say
 *
 * When a language APPLIES and its tool is NOT AVAILABLE, that is reported as an
 * UNVERIFIED finding naming what is missing — never as silence. Silence would
 * be indistinguishable from a clean result, and "we did not look" quietly
 * becoming "there is nothing there" is the single failure this briefing exists
 * to prevent.
 *
 * Everything is spawned through the deterministic execution layer with argv as
 * an ARRAY — no shell, nothing re-parsed, no quoting to get wrong on a path
 * with a space in it — and every run is bounded by a timeout that is reported
 * as a timeout rather than as a clean pass.
 */

const fs = require('fs');
const path = require('path');

const { execute, onPath, findPython } = require('./tools/exec');
const F = require('./findings');

/** A toolchain that has not answered in this long is not going to. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PER_TOOL = 120;

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/** A locally installed node CLI, which is the one the project actually uses. */
function localBin(root, name) {
  const dir = path.join(root, 'node_modules', '.bin');
  for (const ext of process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']) {
    const p = path.join(dir, name + ext);
    if (exists(p)) return p;
  }
  return null;
}

function firstExisting(root, names) {
  for (const n of names) if (exists(path.join(root, n))) return n;
  return null;
}

/** Cap what any one tool can contribute, so a noisy linter cannot own the report. */
function cap(list, tool) {
  if (list.length <= MAX_PER_TOOL) return { findings: list, note: null };
  return {
    findings: list.slice(0, MAX_PER_TOOL),
    note: `${tool} reported ${list.length} findings; the first ${MAX_PER_TOOL} are listed.`,
  };
}

// ------------------------------------------------------------ typescript ----

const typescript = {
  id: 'typescript',
  tool: 'tsc',
  source: F.SOURCE.TYPE_CHECKER,
  applies(root) { return Boolean(firstExisting(root, ['tsconfig.json', 'jsconfig.json'])); },
  available(root) { return localBin(root, 'tsc') || (onPath('tsc') ? 'tsc' : null); },
  missing: 'TypeScript is configured (tsconfig.json) but tsc is not installed here. '
    + 'Run the project\'s install step, or `npm i -D typescript`. Type errors are NOT being checked.',
  async run(root, bin, timeoutMs) {
    // `--noEmit` so a diagnostic run cannot write build output into the tree.
    const r = await execute(bin, ['--noEmit', '--pretty', 'false'], { cwd: root, timeoutMs });
    if (r.timedOut) return { timedOut: true, findings: [] };
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    const out = [];
    // `src/x.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`
    const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
    let m;
    while ((m = re.exec(text))) {
      out.push(F.make({
        category: F.CATEGORY.TYPE,
        severity: m[4] === 'error' ? F.SEVERITY.ERROR : F.SEVERITY.WARNING,
        // The type checker IS the authority on types. Nothing is being guessed.
        confidence: F.CONFIDENCE.PROVEN,
        source: F.SOURCE.TYPE_CHECKER,
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]),
        column: Number(m[3]),
        message: `${m[5]}: ${m[6]}`,
        explanation: explainTs(m[5], m[6]),
        evidence: `tsc --noEmit reported ${m[5]} at ${m[1]}(${m[2]},${m[3]})`,
      }));
    }
    return { findings: out, exitCode: r.exitCode };
  },
};

/**
 * The TypeScript codes worth explaining, because their message names a symptom
 * whose mechanism is not obvious from the words.
 */
function explainTs(code, message) {
  if (code === 'TS2322' || code === 'TS2345') {
    return 'A value of one type reached a position that requires another. The two ends of this are a PRODUCER and '
      + 'a CONSUMER — check which of them changed, because fixing the wrong end propagates the mistake.';
  }
  if (code === 'TS2551' || code === 'TS2339') {
    return 'A property is being read that the type does not declare. This is the type-checked form of a typo: '
      + 'compare the spelling against the declaration, including singular versus plural.';
  }
  if (code === 'TS2304' || code === 'TS2552') return 'A name is used that nothing in scope declares or imports.';
  if (code === 'TS2554') return 'The number of arguments does not match the signature — a parameter was added or removed on one side only.';
  if (code === 'TS6133') return 'Declared and never read. Often the residue of a change that removed the only user.';
  if (code === 'TS2739' || code === 'TS2741') return 'An object literal is missing properties its target type requires.';
  return message.length > 160 ? null : null;
}

// ---------------------------------------------------------------- eslint ----

const eslint = {
  id: 'eslint',
  tool: 'eslint',
  source: F.SOURCE.LINTER,
  applies(root) {
    return Boolean(firstExisting(root, [
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
      '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
    ]));
  },
  available(root) { return localBin(root, 'eslint'); },
  missing: 'ESLint is configured but not installed here, so lint findings are NOT being collected.',
  async run(root, bin, timeoutMs) {
    const r = await execute(bin, ['--format', 'json', '.'], { cwd: root, timeoutMs });
    if (r.timedOut) return { timedOut: true, findings: [] };
    let report;
    try { report = JSON.parse(String(r.stdout || '[]')); } catch { return { findings: [], unparseable: true }; }
    const out = [];
    for (const file of Array.isArray(report) ? report : []) {
      for (const m of file.messages || []) {
        // A parse failure reported by the linter is a SYNTAX finding, not a
        // lint one — the same defect wearing a different tool's badge, and
        // filing it as lint would bury a file that cannot load under style.
        const fatal = Boolean(m.fatal);
        out.push(F.make({
          category: fatal ? F.CATEGORY.SYNTAX : F.CATEGORY.LINT,
          severity: fatal ? F.SEVERITY.CRITICAL : m.severity === 2 ? F.SEVERITY.WARNING : F.SEVERITY.INFO,
          confidence: fatal ? F.CONFIDENCE.PROVEN : F.CONFIDENCE.OBSERVED,
          source: fatal ? F.SOURCE.PARSER : F.SOURCE.LINTER,
          file: path.relative(root, file.filePath).replace(/\\/g, '/'),
          line: m.line || null,
          column: m.column || null,
          message: `${m.ruleId ? `${m.ruleId}: ` : ''}${m.message}`,
          evidence: `eslint --format json, rule ${m.ruleId || '(parse)'}`,
        }));
      }
    }
    return { findings: out, exitCode: r.exitCode };
  },
};

// ---------------------------------------------------------------- python ----

/**
 * Every Python file compiled in ONE process.
 *
 * `ast.parse` is the same front end that would reject the file at import time,
 * so its verdict is definitive rather than an approximation. Paths arrive on
 * STDIN rather than in argv: a tree with two thousand files would exceed the
 * command-line length limit on every platform, and a path with a quote in it
 * would mangle the invocation.
 */
const PY_PROGRAM = [
  'import sys, ast, json',
  'for p in sys.stdin.read().splitlines():',
  '    p = p.strip()',
  '    if not p: continue',
  '    try:',
  '        with open(p, encoding="utf-8") as fh: src = fh.read()',
  '        ast.parse(src, p)',
  '    except SyntaxError as e:',
  '        print(json.dumps({"f": p, "l": e.lineno, "c": e.offset, "m": type(e).__name__ + ": " + str(e.msg)}))',
  '    except Exception:',
  '        pass',
].join('\n');

const python = {
  id: 'python',
  tool: 'python',
  source: F.SOURCE.PARSER,
  applies(root, langs) { return Boolean(langs && langs.py); },
  available() { const p = findPython(); return p.ok ? p.exe : null; },
  missing: 'This project contains Python but no interpreter was found, so no Python file has been parsed.',
  async run(root, bin, timeoutMs, files = []) {
    if (!files.length) return { findings: [] };
    const r = await execute(bin, ['-I', '-c', PY_PROGRAM], {
      cwd: root, timeoutMs, input: files.join('\n'),
    });
    if (r.timedOut) return { timedOut: true, findings: [] };
    const out = [];
    for (const line of String(r.stdout || '').split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      out.push(F.make({
        category: F.CATEGORY.SYNTAX,
        severity: F.SEVERITY.CRITICAL,
        confidence: F.CONFIDENCE.PROVEN,
        source: F.SOURCE.PARSER,
        file: path.relative(root, j.f).replace(/\\/g, '/'),
        line: j.l || null,
        column: j.c || null,
        message: j.m,
        explanation: require('./langscan').explainFor(j.m),
        risk: 'This module cannot be imported. Anything importing it fails at import time.',
        evidence: `python ast.parse rejected ${j.f}`,
      }));
    }
    return { findings: out, exitCode: r.exitCode };
  },
};

// -------------------------------------------------------------------- go ----

const go = {
  id: 'go',
  tool: 'go vet',
  source: F.SOURCE.STATIC_ANALYSIS,
  applies(root) { return exists(path.join(root, 'go.mod')); },
  available() { return onPath('go') ? 'go' : null; },
  missing: 'This is a Go module (go.mod) but the go toolchain is not installed here; go vet did NOT run.',
  async run(root, bin, timeoutMs) {
    const r = await execute(bin, ['vet', './...'], { cwd: root, timeoutMs });
    if (r.timedOut) return { timedOut: true, findings: [] };
    const out = [];
    const re = /^(.+?):(\d+):(\d+):\s+(.+)$/gm;
    let m;
    while ((m = re.exec(String(r.stderr || '')))) {
      out.push(F.make({
        category: F.CATEGORY.CONTRACT,
        severity: F.SEVERITY.WARNING,
        confidence: F.CONFIDENCE.OBSERVED,
        source: F.SOURCE.STATIC_ANALYSIS,
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]),
        column: Number(m[3]),
        message: m[4],
        evidence: 'go vet ./...',
      }));
    }
    return { findings: out, exitCode: r.exitCode };
  },
};

// ------------------------------------------------------------------ rust ----

const rust = {
  id: 'rust',
  tool: 'cargo check',
  source: F.SOURCE.TYPE_CHECKER,
  applies(root) { return exists(path.join(root, 'Cargo.toml')); },
  available() { return onPath('cargo') ? 'cargo' : null; },
  missing: 'This is a Cargo project but cargo is not installed here; the crate was NOT type-checked.',
  async run(root, bin, timeoutMs) {
    const r = await execute(bin, ['check', '--message-format', 'short'], { cwd: root, timeoutMs });
    if (r.timedOut) return { timedOut: true, findings: [] };
    const out = [];
    const re = /^(.+?):(\d+):(\d+):\s+(error|warning)(?:\[([^\]]+)\])?:\s+(.+)$/gm;
    let m;
    while ((m = re.exec(String(r.stderr || '')))) {
      out.push(F.make({
        category: m[4] === 'error' ? F.CATEGORY.TYPE : F.CATEGORY.LINT,
        severity: m[4] === 'error' ? F.SEVERITY.ERROR : F.SEVERITY.WARNING,
        confidence: F.CONFIDENCE.PROVEN,
        source: F.SOURCE.TYPE_CHECKER,
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]),
        column: Number(m[3]),
        message: `${m[5] ? `${m[5]}: ` : ''}${m[6]}`,
        evidence: 'cargo check --message-format short',
      }));
    }
    return { findings: out, exitCode: r.exitCode };
  },
};

const ANALYZERS = [typescript, eslint, python, go, rust];

/**
 * Run every analyser this project warrants and can actually use.
 *
 * @param {string} root
 * @param {object} o
 * @param {object} o.languages    the file census from langscan
 * @param {string[]} [o.pythonFiles]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{findings, ran: Set<string>, skipped, notes}>}
 */
async function analyze(root, { languages = {}, pythonFiles = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const findings = [];
  const ran = new Set();
  const skipped = [];
  const notes = [];

  for (const a of ANALYZERS) {
    let applicable = false;
    try { applicable = Boolean(a.applies(root, languages)); } catch { applicable = false; }
    if (!applicable) continue;

    let bin = null;
    try { bin = a.available(root); } catch { bin = null; }
    if (!bin) {
      // ---- APPLIES BUT CANNOT RUN --------------------------------------
      //
      // Reported, never skipped silently. A missing type checker on a
      // TypeScript project means the report has NOTHING to say about types,
      // and a reader who is not told that will read the silence as a clean
      // bill of health.
      skipped.push({ tool: a.tool, why: a.missing });
      findings.push(F.make({
        category: F.CATEGORY.UNVERIFIED,
        severity: F.SEVERITY.UNVERIFIED,
        confidence: F.CONFIDENCE.PROVEN,
        source: F.SOURCE.FILESYSTEM,
        message: `${a.tool} did not run.`,
        explanation: a.missing,
        risk: 'Findings this tool would have produced are absent from this briefing. Absence here is not evidence '
          + 'of absence of defects.',
        evidence: `${a.tool} was looked for in node_modules/.bin and on PATH and was not found.`,
      }));
      continue;
    }

    let r;
    try { r = await a.run(root, bin, timeoutMs, pythonFiles); } catch (e) {
      skipped.push({ tool: a.tool, why: `it failed to run: ${e && e.message}` });
      continue;
    }
    if (r.timedOut) {
      // A TIMEOUT IS NOT A PASS. Said explicitly, because an analyser that was
      // killed produces exactly as many findings as a clean one.
      findings.push(F.make({
        category: F.CATEGORY.UNVERIFIED,
        severity: F.SEVERITY.UNVERIFIED,
        confidence: F.CONFIDENCE.PROVEN,
        source: F.SOURCE.EXECUTION_ENGINE,
        message: `${a.tool} was still running after ${Math.round(timeoutMs / 1000)}s and was stopped.`,
        explanation: 'It produced no verdict. This is not a clean result.',
        evidence: `${a.tool} exceeded the analysis timeout.`,
      }));
      skipped.push({ tool: a.tool, why: 'it timed out' });
      continue;
    }
    if (r.unparseable) {
      skipped.push({ tool: a.tool, why: 'its output could not be parsed' });
      continue;
    }
    ran.add(a.source);
    const c = cap(r.findings, a.tool);
    if (c.note) notes.push(c.note);
    findings.push(...c.findings);
  }
  return { findings, ran, skipped, notes };
}

module.exports = { analyze, ANALYZERS, localBin, explainTs, DEFAULT_TIMEOUT_MS, MAX_PER_TOOL };
