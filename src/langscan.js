'use strict';

/**
 * THE ANALYSIS THAT NEEDS NO TOOLCHAIN — parse, symbols, names.
 *
 * Everything here runs IN PROCESS against the files as they are on disk right
 * now. No compiler, no install, no configuration, nothing to be missing on the
 * user's machine. That matters because it is the floor: whatever else is or is
 * not available, a briefing can always say whether the source parses and
 * whether it refers to things that exist.
 *
 * It is built entirely on machinery that already exists — `diagnostics.js` for
 * the parse verdict, `codemodel.js` for declarations and references,
 * `typos.js` for names that resolve to nothing. This file adds no analysis of
 * its own. Its whole job is to run those over a project rather than over one
 * file, and to turn what they say into the one finding shape everything
 * downstream reads.
 *
 * BOUNDED IN EVERY DIRECTION THAT CAN GROW. A briefing that takes ninety
 * seconds is a briefing nobody runs, and one that returns four thousand
 * findings is one nobody reads. Files visited, findings emitted and bytes read
 * per file are all capped, and a truncated sweep SAYS it was truncated — a
 * silent cap produces a confident "no problems found" over a project that was
 * never fully looked at.
 */

const fs = require('fs');
const path = require('path');

const diagnostics = require('./diagnostics');
const codemodel = require('./codemodel');
const typos = require('./typos');
const { walk } = require('./tools/search');
const F = require('./findings');

/** Bounds. See the header on why a silent cap is worse than a small one. */
const MAX_FILES = 2500;
const MAX_FINDINGS = 300;
const MAX_FILE_BYTES = 2_000_000;

/**
 * Source this can say anything at all about.
 *
 * PYTHON IS DELIBERATELY ABSENT. `diagnostics.checkFile` answers for a `.py`
 * file by spawning an interpreter, which is right for one file after an edit
 * and catastrophic across a tree — four hundred Python files would be four
 * hundred processes. toolchain.js compiles them all in ONE process instead,
 * which is both faster and the native-tool answer. The census below still
 * counts them, so the briefing knows the project has Python in it.
 */
const SOURCE_RE = /\.(?:js|cjs|mjs|jsx|ts|tsx|json)$/i;
/** The subset the JavaScript symbol model understands. */
const JS_RE = /\.(?:js|cjs|mjs)$/i;
/** Paths that are a test, so a finding there can be labelled as one. */
const TEST_RE = /(?:^|\/)(?:tests?|spec|__tests__)\/|\.(?:test|spec)\.[a-z]+$/i;

/**
 * WHY THIS MESSAGE MEANS WHAT IT MEANS.
 *
 * A parser says `Unexpected token ')'`. That is a symptom, and forwarding it
 * alone leaves the reader to reconstruct what the parser was doing when it
 * gave up. These explain the MECHANISM — what the parser was in the middle of,
 * and therefore where to look — without claiming to know the cause, which the
 * parser did not establish and neither can this.
 *
 * Keyed on the stable part of the message. Anything unmatched gets no
 * explanation rather than a generic one: a sentence that says nothing is worse
 * than a blank, because it looks like an answer.
 */
const EXPLAIN = [
  [/Unexpected token/i,
    'The parser reached a token that cannot continue the expression it was building. The defect is usually at or '
    + 'BEFORE this point — an unbalanced bracket, a missing comma between members, or a missing operator — because '
    + 'the parser only fails once the construction becomes impossible.'],
  [/Unexpected end of input|unexpected EOF/i,
    'The file ended while a bracket, brace, parenthesis, string or template was still open. The reported line is '
    + 'the END of the file, not the defect; the unclosed delimiter is earlier.'],
  [/Invalid or unexpected token/i,
    'A character sequence is not lexically valid — most often an unterminated string, a stray backslash, or a '
    + 'non-ASCII quote character pasted in place of an ASCII one.'],
  [/missing \) after argument list/i,
    'An argument list was left open. Check the call on this line and the ones nested inside it.'],
  [/Identifier .* has already been declared/i,
    'Two declarations bind the same name in one scope. This is frequently the residue of a migration: the new '
    + 'implementation was added and the old one was never removed.'],
  [/Unexpected string|Unexpected number/i,
    'A literal appears where an operator or a separator was required — commonly a missing comma in an object or '
    + 'array literal.'],
  [/Expected property name or/i,
    'A JSON object member is malformed. The usual cause is a trailing comma before the closing brace, which is '
    + 'legal in JavaScript and illegal in JSON.'],
  [/IndentationError|TabError/i,
    'Python block structure is inconsistent — mixed tabs and spaces, or a block that does not line up with its '
    + 'opening statement.'],
];

function explainFor(message) {
  for (const [re, text] of EXPLAIN) if (re.test(message)) return text;
  return null;
}

/**
 * WHERE THE DEFECT IS, said in the words of the symbol model.
 *
 * A line number alone makes the reader open the file to find out what they are
 * looking at. Naming the enclosing definition means they already know.
 */
function enclosing(model, line) {
  if (!model || !model.supported || !Number.isFinite(line)) return { symbol: null, container: null };
  // ---- THE CALLABLE THAT CONTAINS IT, NOT THE NEAREST DECLARATION --------
  //
  // "Tightest range wins" picked the wrong thing constantly. A defect on
  // `const rows = getUser(db);` sits inside a one-line `const` declaration,
  // which is tighter than the function around it — so the report named the
  // symbol `rows`, which tells a reader nothing they could not see, instead of
  // `activeUsers`, which is where they have to go. The useful answer to "what
  // is this inside" is always the enclosing FUNCTION, CLASS or METHOD.
  const CALLABLE = new Set([codemodel.KIND.FUNCTION, codemodel.KIND.CLASS, codemodel.KIND.METHOD]);
  let best = null;
  let fallback = null;
  for (const s of model.symbols) {
    if (s.startLine > line || s.endLine < line) continue;
    const tighter = (a, b) => !b || (a.endLine - a.startLine) < (b.endLine - b.startLine);
    if (CALLABLE.has(s.kind)) { if (tighter(s, best)) best = s; continue; }
    if (tighter(s, fallback)) fallback = s;
  }
  const pick = best || fallback;
  if (!pick) return { symbol: null, container: null };
  return { symbol: pick.container ? `${pick.container}.${pick.name}` : pick.name, container: pick.container };
}

/**
 * Every file that imports a given one, by specifier basename.
 *
 * Deliberately cheap and deliberately approximate: it exists to answer "who
 * else should I look at", not to be a dependency graph. It is reported as
 * RELATED, which is a suggestion of where to look, never as a claim.
 */
function relatedTo(rel, index) {
  const base = path.posix.basename(rel).replace(/\.[^.]+$/, '');
  const out = [];
  for (const [otherRel, model] of index) {
    if (otherRel === rel) continue;
    for (const imp of model.imports || []) {
      const specBase = path.posix.basename(String(imp.spec).replace(/\\/g, '/')).replace(/\.[^.]+$/, '');
      if (specBase !== base) continue;
      out.push(`${otherRel}:${imp.line}`);
      break;
    }
  }
  return out;
}

/**
 * Read a project into findings.
 *
 * @param {string} root
 * @param {object} [o]
 * @param {string[]} [o.only] restrict to these project-relative paths
 * @returns {Promise<{findings, scanned, truncated, sources: Set<string>, byLanguage}>}
 */
async function scanProject(root, { only = null } = {}) {
  const findings = [];
  const index = new Map();
  const byLanguage = {};
  let scanned = 0;
  let truncated = false;
  const onlySet = only && only.length ? new Set(only.map((p) => p.replace(/\\/g, '/'))) : null;

  const files = [];
  for (const f of walk(root)) {
    if (!SOURCE_RE.test(f.rel)) continue;
    if (onlySet && !onlySet.has(f.rel)) continue;
    if (files.length >= MAX_FILES) { truncated = true; break; }
    files.push(f);
  }

  // ---- PASS ONE: parse, and build the symbol index ------------------------
  //
  // The index is built first because the second pass needs it: naming the
  // enclosing symbol of a parse error, and listing which other files import
  // the broken one, both require having read everything.
  for (const f of files) {
    let st;
    try { st = fs.statSync(f.abs); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    scanned += 1;
    const ext = path.extname(f.rel).toLowerCase().replace('.', '');
    byLanguage[ext] = (byLanguage[ext] || 0) + 1;

    let verdict;
    try { verdict = await diagnostics.checkFile(f.abs); } catch { verdict = { ok: true, inconclusive: true }; }

    let model = null;
    if (JS_RE.test(f.rel)) {
      try { model = codemodel.scanFile(f.abs); } catch { model = null; }
      if (model && model.supported) index.set(f.rel, model);
    }

    if (verdict && verdict.ok === false) {
      const where = enclosing(model, verdict.line);
      findings.push(F.make({
        category: f.rel.endsWith('.json') ? F.CATEGORY.CONFIGURATION : F.CATEGORY.SYNTAX,
        severity: F.SEVERITY.CRITICAL,
        // The parser REJECTED the file. There is nothing left to establish:
        // this file cannot load, whatever else is true.
        confidence: F.CONFIDENCE.PROVEN,
        source: F.SOURCE.PARSER,
        file: f.rel,
        line: verdict.line,
        symbol: where.symbol,
        container: where.container,
        message: verdict.message,
        explanation: explainFor(verdict.message),
        risk: 'This file cannot be loaded or imported. Anything that requires it fails at load time, '
          + 'so a passing test suite means only that no test reached it.',
        evidence: `${f.rel}${verdict.line ? `:${verdict.line}` : ''} — ${verdict.message}`,
      }));
    }
  }

  // ---- PASS TWO: names that resolve to nothing ---------------------------
  for (const [rel, model] of index) {
    if (findings.length >= MAX_FINDINGS) { truncated = true; break; }
    let unresolved;
    try { unresolved = typos.unresolved(model); } catch { unresolved = []; }
    for (const u of unresolved) {
      const where = enclosing(model, u.line);
      const refs = model.used.filter((x) => x.name === u.name).length;
      findings.push(F.make({
        category: F.CATEGORY.TYPO,
        // Not CRITICAL: the file parses and may never take this path. It is an
        // ERROR because when the path IS taken it is a certain failure.
        severity: F.SEVERITY.ERROR,
        // Two facts are proven — the name is used, and nothing declares it.
        // That the SUGGESTION is what was meant is not proven, and the wording
        // of the finding keeps those apart.
        confidence: F.CONFIDENCE.INFERRED,
        source: F.SOURCE.SYMBOL_GRAPH,
        file: rel,
        line: u.line,
        symbol: where.symbol,
        container: where.container,
        actual: u.name,
        expected: u.suggestion,
        references: refs,
        message: `${u.name}${u.calls ? '()' : ''} is used here and nothing in this file declares, imports or `
          + `inherits it. ${u.suggestion} does exist (${u.why}).`,
        explanation: 'This is valid syntax, so no parser will ever object to it. The name resolves to nothing at '
          + 'run time, which raises a ReferenceError — or, for a property read, silently yields undefined — at '
          + 'whatever moment this line is first reached.',
        risk: u.calls
          ? 'A call to an undefined name throws the instant it executes.'
          : 'A read of an undefined name yields undefined and usually fails somewhere further away.',
        evidence: `Symbol model: ${model.used.length} reference(s) checked against ${model.bindings.size} binding(s) in this file.`,
        related: { files: relatedTo(rel, index), symbols: [u.suggestion], tests: [] },
      }));
    }
  }

  return {
    findings: findings.slice(0, MAX_FINDINGS),
    scanned,
    truncated: truncated || findings.length > MAX_FINDINGS,
    byLanguage,
    index,
    sources: new Set([F.SOURCE.PARSER, F.SOURCE.SYMBOL_GRAPH]),
  };
}

/**
 * WHAT LANGUAGES ARE ACTUALLY IN THIS TREE, and therefore which toolchains are
 * worth asking about.
 *
 * Counted from the files rather than guessed from a manifest: a repository with
 * a `package.json` and four hundred Python files is a Python project with a
 * build script in it.
 */
function languages(root) {
  const counts = {};
  let n = 0;
  for (const f of walk(root)) {
    const ext = path.extname(f.rel).toLowerCase().replace('.', '');
    if (!ext) continue;
    counts[ext] = (counts[ext] || 0) + 1;
    if (++n > MAX_FILES) break;
  }
  return counts;
}

module.exports = { scanProject, languages, explainFor, enclosing, TEST_RE, MAX_FILES, MAX_FINDINGS };
