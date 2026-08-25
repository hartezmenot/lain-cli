'use strict';

/**
 * CODE NOTHING REACHES — the one project-understanding gap the design names.
 *
 *: "dead-code / stale-code detection is currently acknowledged as missing.
 * Determine whether it can be added without creating a second
 * project-understanding architecture."
 *
 * It can, and this is it. Every reference question is already answered by
 * search.js — `dependents` finds what imports a FILE, `symbols` finds where a
 * NAME is defined and used, both computed fresh from the bytes on disk with no
 * index to go stale. This adds no parser, no graph, no cache and no second
 * notion of what a reference is; it asks the same question from the other end.
 *
 * ------------------------------------------------------------------------
 * THE FAILURE MODE THIS MUST NOT BECOME, stated in projecthealth.js before this
 * existed: "reporting 'unused code' because a naive search found no reference,
 * and being confidently wrong in a way that costs someone an afternoon."
 *
 * That is a real risk and it is why the answer is GRADED rather than binary. A
 * name can be reached in ways no text search sees — a dynamic `require`, a
 * string in a config, a plugin loader, a name exported for a consumer outside
 * this tree. So nothing here says "delete this". It says how it is reached, and
 * how sure that is, and the four grades are the whole design:
 *
 *   UNREFERENCED   nothing anywhere names it. The strongest claim available,
 *                  and still not a claim that it is safe to delete.
 *   TESTS_ONLY     the tests reach it and production never does. THE MOST
 *                  USEFUL ONE, and the one nothing detects by accident: the
 *                  code passes, the suite is green, and the thing is wired to
 *                  nothing. It is how a module stays alive for months after the
 *                  last caller went away.
 *   INTERNAL_ONLY  alive inside its own module; only the EXPORT is unused.
 *   REACHED        production names it. Not a finding.
 *
 * The evidence — file and line of every reference — travels with the verdict,
 * so a person can disagree in one glance rather than by re-deriving it.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS WORTH HAVING, from this session: `inspection.Inspection` is a state
 * machine with five unit tests and no production caller anywhere. Everything
 * was green. `dependents` would have reported the file as imported — because
 * commands.js did import it, for a different function — and only asking about
 * the SYMBOL, and separating tests from production, shows what is actually true.
 */

const fs = require('fs');
const path = require('path');

const { walk, looksBinary, defineRe } = require('./tools/search');

const VERDICT = Object.freeze({
  UNREFERENCED: 'UNREFERENCED',
  TESTS_ONLY: 'TESTS_ONLY',
  /**
   * ALIVE INSIDE ITS OWN MODULE, and exported to nobody.
   *
   * THE DISTINCTION THAT KEPT THIS HONEST. The first sweep called these
   * UNREFERENCED and produced sixty findings, nearly all of them constants a
   * module uses throughout itself and also happens to export — `MAX_OUTPUT`,
   * `PASSIVE_KINDS`, `DEFAULT_TIMEOUT_MS`. Nothing about that code is dead;
   * what is unused is the EXPORT, which is a tidiness question and not a
   * correctness one. Reporting them as dead is precisely the "confidently
   * wrong in a way that costs someone an afternoon" failure — sixty rows of
   * noise, and the two real findings lost inside it.
   */
  INTERNAL_ONLY: 'INTERNAL_ONLY',
  REACHED: 'REACHED',
});

/** How sure the verdict is, in the vocabulary projecthealth.js already uses. */
const CONFIDENCE = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  LIKELY: 'LIKELY',
  REVIEW: 'REVIEW',
});

/** Paths whose references do not count as production reaching something. */
const TEST_RE = /(^|\/)(tests?|spec|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/i;

/**
 * NAMES THAT MEAN SOMETHING TO A RUNTIME RATHER THAN TO A CALLER.
 *
 * A default export, a lifecycle hook, an entry point — reached by position or
 * by convention, never by anything naming them. Reporting these as dead is the
 * confident wrongness above, so they are graded REVIEW rather than asserted.
 */
const CONVENTIONAL = /^(main|default|index|register|activate|deactivate|setup|teardown|run|handler|constructor)$/;

/** Every source file under `root`, relative and posix-style. */
function sources(root, { include = /\.(js|mjs|cjs|ts|tsx|jsx)$/ } = {}) {
  const out = [];
  // `walk` already yields `{ abs, rel }` with rel in posix form, and already
  // skips node_modules, symlinks and the rest. Re-deriving rel here is how the
  // two would come to disagree about what a path looks like.
  for (const { rel } of walk(root)) {
    if (!include.test(rel)) continue;
    out.push(rel);
  }
  return out;
}

/**
 * WHERE IS THIS NAME REACHED FROM?
 *
 * Definitions are excluded from the reference count, which is the whole
 * subtlety: a function that only appears on the line that defines it is
 * unreferenced, and counting that line would make every symbol look reached.
 *
 * A REFERENCE FROM THE DEFINING MODULE IS NOT A CALLER, and getting this wrong
 * made the first version of this file report nothing at all. Every exported
 * name appears in its own `module.exports = { … }` line, so every symbol had at
 * least one "reference outside its definition" and every module looked
 * perfectly alive — a sweep that returns zero findings on a tree that demonstrably
 * contains dead code, which is worse than not having the sweep, because it
 * answers the question wrongly instead of leaving it open.
 *
 * Internal uses are kept separately rather than discarded: a helper used all
 * over its own module and never outside it is a different fact from one nothing
 * touches at all, and the caller may want to say so.
 *
 * @returns {{defs:Array, refs:Array, testRefs:Array, internal:Array}}
 */
function referencesTo(root, name, files) {
  const def = defineRe(name);
  // A WORD BOUNDARY, not a substring. `run` must not match `runTurn`, and
  // getting that wrong is how a report claims a live function is dead.
  const use = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const defs = [];
  const refs = [];
  const testRefs = [];
  const internal = [];
  // WHICH FILES DEFINE IT, found first, so a reference can be told from a use
  // inside the definition's own home. Two passes over the same list rather than
  // one, because the second pass needs an answer the first is still computing.
  const homes = new Set();
  for (const rel of files) {
    try {
      const buf = fs.readFileSync(path.join(root, rel));
      if (looksBinary(buf)) continue;
      if (def.test(buf.toString('utf8'))) homes.add(rel);
    } catch { /* unreadable files simply define nothing */ }
  }
  for (const rel of files) {
    let text;
    try {
      const buf = fs.readFileSync(path.join(root, rel));
      if (looksBinary(buf)) continue;
      text = buf.toString('utf8');
    } catch { continue; }
    if (!use.test(text)) continue;
    const isTest = TEST_RE.test(rel);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!use.test(line)) continue;
      const hit = { file: rel, line: i + 1, text: line.trim().slice(0, 140) };
      if (def.test(line)) { defs.push(hit); continue; }
      // A COMMENT IS NOT A CALLER. A module named only in the prose explaining
      // why it was replaced is exactly the case this exists to find, and
      // counting that mention as a reference would hide it.
      if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) continue;
      // NOR IS A MODULE'S OWN EXPORT LINE A USE OF WHAT IT EXPORTS. It is the
      // declaration of the surface, not somebody reaching through it — and
      // counting it made every exported name look used-at-home, which turned
      // the genuinely unwired ones (`Inspection`) into INTERNAL_ONLY and hid
      // them behind the tidiness findings.
      if (/^\s*module\.exports\b/.test(line) || /^\s*(exports\.[A-Za-z0-9_$]+\s*=)/.test(line)) continue;
      if (homes.has(rel)) { internal.push(hit); continue; }
      (isTest ? testRefs : refs).push(hit);
    }
  }
  return { defs, refs, testRefs, internal };
}

/**
 * IS THIS NAME REACHED, AND HOW SURE IS THAT?
 *
 * @param {string} root
 * @param {string} name
 * @param {string[]} files  from sources(), passed in so a sweep reads the tree once
 */
function check(root, name, files) {
  const { defs, refs, testRefs, internal } = referencesTo(root, name, files);
  if (!defs.length) {
    return {
      name, verdict: VERDICT.REACHED, confidence: CONFIDENCE.REVIEW,
      why: 'nothing in this tree defines that name, so there is nothing to call dead',
      defs, refs, testRefs, internal,
    };
  }
  if (refs.length) {
    return { name, verdict: VERDICT.REACHED, confidence: CONFIDENCE.CONFIRMED,
      why: `named in ${refs.length} place(s) outside its own module`, defs, refs, testRefs, internal };
  }
  const conventional = CONVENTIONAL.test(name);
  // ---- USED AT HOME IS CHECKED BEFORE USED BY TESTS -----------------------
  //
  // The order was the other way round and it made the report lie in a
  // specific, checkable way: `turnevents.flushParagraphs` is called on the live
  // text path AND asserted by a test, so it came back TESTS_ONLY with the words
  // "none from production" — which is false, and false about a function on the
  // hot path. A name its own module uses is alive, whatever the tests do.
  if (internal.length) {
    return {
      name, verdict: VERDICT.INTERNAL_ONLY, confidence: CONFIDENCE.LIKELY,
      why: `used ${internal.length} time(s) inside ${defs[0].file} and named by nothing outside it`
        + (testRefs.length ? ` (the tests name it ${testRefs.length} time(s))` : '')
        + ' — the export is unused, the code is not',
      defs, refs, testRefs, internal,
    };
  }
  if (testRefs.length) {
    // ---- A CONSTANT THE TESTS ASSERT AGAINST IS NOT DEAD CODE -------------
    //
    // `MAX_OUTPUT`, `BACKOFF_MS`, `JITTER` are exported precisely so a test can
    // assert the REAL value rather than a copy of it that can drift. That is
    // the export doing its job, and grading it CONFIRMED put ninety rows of
    // good practice above the handful of genuinely unwired functions. An
    // UPPER_SNAKE name reached only by tests is therefore REVIEW: worth a look,
    // not worth asserting.
    const looksConstant = /^[A-Z][A-Z0-9_]*$/.test(name);
    return {
      name, verdict: VERDICT.TESTS_ONLY,
      // CONFIRMED IS DESERVED FOR THE REST: the tests naming it prove the name
      // is spelled right and the search works, so "production never names it"
      // is a measurement rather than an absence.
      confidence: (conventional || looksConstant) ? CONFIDENCE.REVIEW : CONFIDENCE.CONFIRMED,
      why: looksConstant
        ? `only the tests name it — ${testRefs.length} reference(s). A constant exported so a test `
          + 'can assert the real value is doing its job; check that is what this is.'
        : `only the tests reach it — ${testRefs.length} reference(s), none from production`,
      defs, refs, testRefs, internal,
    };
  }
  // USED AT HOME, EXPORTED FOR NOBODY. Tidiness, not dead code — and saying so
  // is what keeps the two real findings visible among the sixty.
  if (internal.length) {
    return {
      name, verdict: VERDICT.INTERNAL_ONLY, confidence: CONFIDENCE.LIKELY,
      why: `used ${internal.length} time(s) inside ${defs[0].file} and exported to nobody — `
        + 'the export is unused, the code is not',
      defs, refs, testRefs, internal,
    };
  }
  return {
    name, verdict: VERDICT.UNREFERENCED,
    // NEVER CONFIRMED WITHOUT A WITNESS. Nothing naming it is also what a
    // dynamic require, a plugin loader or an external consumer looks like from
    // in here, and this file does not get to be certain about those.
    confidence: conventional ? CONFIDENCE.REVIEW : CONFIDENCE.LIKELY,
    why: conventional
      ? 'nothing names it, but a name like this is usually reached by convention rather than by a caller'
      : 'nothing in this tree names it at all, in production or in the tests',
    defs, refs, testRefs, internal,
  };
}

/**
 * THE EXPORTED NAMES OF ONE MODULE — what other code could possibly call.
 *
 * Read from `module.exports = { … }`, which is this tree's one export style.
 * A shape it cannot read returns nothing rather than a guess: a wrong list of
 * names would produce wrong findings about real code.
 */
function exportsOf(root, rel) {
  let text;
  try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return []; }
  const m = text.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/);
  if (!m) return [];
  const names = [];
  for (const raw of m[1].split(',')) {
    const part = raw.split('//')[0].trim();
    if (!part || part.startsWith('...')) continue;
    const name = part.includes(':') ? part.split(':')[0].trim() : part;
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) names.push(name);
  }
  return names;
}

/**
 * SWEEP A TREE. Every exported name of every module, graded.
 *
 * BOUNDED, because this reads every file once per name and a large tree with
 * hundreds of exports would otherwise be a long synchronous walk. The cap is
 * reported when it bites — a truncated answer that says so is usable, and one
 * that does not is a lie about coverage.
 */
function sweep(root, { srcDir = 'src', limit = 400 } = {}) {
  const files = sources(root);
  const modules = files.filter((f) => f.startsWith(`${srcDir}/`) && !TEST_RE.test(f));
  const findings = [];
  let looked = 0;
  let truncated = false;
  for (const rel of modules) {
    for (const name of exportsOf(root, rel)) {
      if (looked >= limit) { truncated = true; break; }
      looked += 1;
      const r = check(root, name, files);
      if (r.verdict === VERDICT.REACHED) continue;
      findings.push({ ...r, module: rel });
    }
    if (truncated) break;
  }
  // WORST FIRST: something nothing reaches at all, then something only the
  // tests reach, and within each the ones this is surest about.
  const order = { [VERDICT.UNREFERENCED]: 0, [VERDICT.TESTS_ONLY]: 1, [VERDICT.INTERNAL_ONLY]: 2 };
  const sure = { [CONFIDENCE.CONFIRMED]: 0, [CONFIDENCE.LIKELY]: 1, [CONFIDENCE.REVIEW]: 2 };
  findings.sort((a, b) => (order[a.verdict] - order[b.verdict]) || (sure[a.confidence] - sure[b.confidence]));
  return { findings, looked, truncated, modules: modules.length };
}

/** The findings as lines a person reads, evidence attached. */
function lines(result) {
  if (!result.findings.length) return ['Nothing unreachable was found.'];
  const out = [];
  for (const f of result.findings) {
    out.push(`${f.confidence.padEnd(9)} ${f.verdict.padEnd(13)} ${f.module} · ${f.name}`);
    out.push(`          ${f.why}`);
    for (const t of f.testRefs.slice(0, 2)) out.push(`          test: ${t.file}:${t.line}`);
  }
  if (result.truncated) out.push(`(stopped after ${result.looked} names — there are more)`);
  return out;
}

module.exports = { sweep, check, exportsOf, referencesTo, sources, lines, VERDICT, CONFIDENCE, TEST_RE };
