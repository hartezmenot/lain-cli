'use strict';

/**
 * DID THE OLD IMPLEMENTATION ACTUALLY GO?
 *
 * The failure this exists to catch is specific, extremely common, and invisible
 * to every test in the project:
 *
 *     "Move the enemy table out of the code and into enemies.json."
 *
 *     ENEMIES = load_json('enemies.json')        ← added, works, tests pass
 *     ENEMIES = { slime: …, wolf: … }            ← still there, in another file
 *
 * The new implementation exists. Every test is green, because the new path
 * works. And the migration is not done: the old table is still in the tree,
 * still imported somewhere, and the next person to edit the data will edit the
 * wrong one. A model looks at the new code, sees it is correct, and reports
 * success — truthfully about what it added and falsely about what the request
 * actually asked for.
 *
 * "Replace X with Y" is TWO claims. Y exists, and X is gone. Nothing in a test
 * suite checks the second one, because a leftover definition breaks nothing —
 * that is exactly why it survives. So it is checked here, mechanically.
 *
 * WHAT MAKES THE ANSWER TRUSTWORTHY is that occurrences are classified on
 * TOKENS, not counted as text. "Still mentioned 4 times" is useless: a name in
 * a changelog is finished business and the same name in a `require` is a live
 * dependency. These are different findings and they get different words.
 *
 * IT NEVER DELETES ANYTHING. It reports. Some leftovers are deliberate — a
 * compatibility shim, a documented deprecation — and the difference is a
 * judgement about intent that belongs to whoever made the change.
 */

const fs = require('fs');
const path = require('path');
const codemodel = require('./codemodel');
const { sitesIn, SITE } = require('./rename');
const { walk, globToRegExp } = require('./tools/search');
const { supports } = require('./jsscan');

const MAX_FILES = 4000;
const MAX_HITS_PER_NAME = 60;

/** The verdict for one thing that was supposed to disappear. */
const STATE = Object.freeze({
  GONE: 'GONE',
  DEFINED: 'STILL DEFINED',
  REFERENCED: 'STILL REFERENCED',
  TEXT_ONLY: 'ONLY IN TEXT',
});

/** A path that looks like a test, so a leftover there can be named as one. */
const TEST_RE = /(?:^|\/)(?:tests?|spec|__tests__)\/|\.(?:test|spec)\.[a-z]+$/i;

/**
 * Sweep the tree for one identifier.
 *
 * @returns {{name, state, definitions, references, text, files}}
 */
function forName(root, name, { includeRe = null } = {}) {
  const definitions = [];
  const references = [];
  const text = [];
  let scanned = 0;

  for (const f of walk(root)) {
    if (includeRe && !includeRe.test(f.rel)) continue;
    if (scanned >= MAX_FILES) break;
    let source;
    try { source = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    if (!source.includes(name)) continue;
    scanned += 1;

    if (!supports(f.abs)) {
      // Not JavaScript, so nothing here can say whether it is a reference or a
      // word in a sentence. Reported as text, which is the honest answer.
      text.push({ where: f.rel, line: lineOfFirst(source, name), why: 'not JavaScript' });
      continue;
    }
    const model = codemodel.scan(source, f.abs);
    for (const s of model.symbols) {
      if (s.name !== name) continue;
      definitions.push({ where: f.rel, line: s.startLine, kind: s.kind, container: s.container, test: TEST_RE.test(f.rel) });
    }
    const declaredHere = new Set(model.symbols.filter((s) => s.name === name).map((s) => s.startLine));
    for (const site of sitesIn(source, name)) {
      if (site.kind === SITE.TEXT) { text.push({ where: f.rel, line: site.line, why: 'string or comment' }); continue; }
      if (declaredHere.has(site.line)) continue;              // that is the definition, already listed
      references.push({ where: f.rel, line: site.line, kind: site.kind, test: TEST_RE.test(f.rel) });
    }
  }

  const state = definitions.length ? STATE.DEFINED
    : references.length ? STATE.REFERENCED
      : text.length ? STATE.TEXT_ONLY
        : STATE.GONE;
  return {
    name,
    state,
    definitions: definitions.slice(0, MAX_HITS_PER_NAME),
    references: references.slice(0, MAX_HITS_PER_NAME),
    text: text.slice(0, MAX_HITS_PER_NAME),
    scanned,
  };
}

function lineOfFirst(source, needle) {
  const i = source.indexOf(needle);
  return i < 0 ? 1 : source.slice(0, i).split('\n').length;
}

/**
 * Sweep for a FILE that was supposed to go away.
 *
 * Two separate questions — is the file still there, and does anything still
 * point at it — because the answers come apart: a deleted file with three live
 * imports is a broken build, and a surviving file nobody imports is dead weight.
 */
function forPath(root, rel, { includeRe = null } = {}) {
  const abs = path.resolve(root, rel);
  const target = path.relative(root, abs).replace(/\\/g, '/');
  const stillThere = fs.existsSync(abs);
  const base = path.posix.basename(target).replace(/\.[^.]+$/, '');
  const importers = [];
  let scanned = 0;

  for (const f of walk(root)) {
    if (f.rel === target) continue;
    if (includeRe && !includeRe.test(f.rel)) continue;
    if (scanned >= MAX_FILES) break;
    let source;
    try { source = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    if (!source.includes(base)) continue;
    scanned += 1;
    if (!supports(f.abs)) continue;
    const model = codemodel.scan(source, f.abs);
    for (const imp of model.imports) {
      const spec = String(imp.spec).replace(/\\/g, '/');
      const specBase = path.posix.basename(spec).replace(/\.[^.]+$/, '');
      if (specBase !== base) continue;
      importers.push({ where: f.rel, line: imp.line, spec: imp.spec, test: TEST_RE.test(f.rel) });
    }
  }
  return { path: target, stillThere, importers: importers.slice(0, MAX_HITS_PER_NAME), scanned };
}

/**
 * The whole check: what should be gone, and what should have replaced it.
 *
 * @param {string} root
 * @param {object} q
 * @param {string[]} q.gone     identifiers that should no longer exist
 * @param {string[]} q.removed  file paths that should no longer exist
 * @param {string[]} q.present  identifiers the replacement should have introduced
 * @param {string} [q.include]  glob limiting the sweep
 */
function check(root, { gone = [], removed = [], present = [], include = '' } = {}) {
  const includeRe = include ? globToRegExp(include) : null;
  return {
    gone: gone.map((n) => forName(root, n, { includeRe })),
    removed: removed.map((p) => forPath(root, p, { includeRe })),
    present: present.map((n) => ({ ...forName(root, n, { includeRe }), wanted: true })),
  };
}

/** Rows for one identifier that was supposed to disappear. */
function describeGone(r) {
  const lines = [];
  if (r.state === STATE.GONE) { lines.push(`  ${r.name} — GONE. No definition, no reference, no mention.`); return lines; }
  if (r.state === STATE.TEXT_ONLY) {
    lines.push(`  ${r.name} — ONLY IN TEXT. No code references it; ${r.text.length} mention(s) remain in `
      + `strings, comments or non-JavaScript files: ${r.text.slice(0, 5).map((t) => `${t.where}:${t.line}`).join(', ')}`);
    return lines;
  }
  lines.push(`  ${r.name} — ${r.state}. The migration is not finished.`);
  for (const d of r.definitions.slice(0, 8)) {
    lines.push(`      DEFINED  ${d.where}:${d.line}  ${d.kind}${d.container ? ` in ${d.container}` : ''}`
      + `${d.test ? '  [test]' : ''}`);
  }
  const live = r.references.filter((x) => !x.test);
  const inTests = r.references.filter((x) => x.test);
  for (const u of live.slice(0, 8)) lines.push(`      USED     ${u.where}:${u.line}  (${u.kind})`);
  if (live.length > 8) lines.push(`      [${live.length - 8} more live reference(s)]`);
  if (inTests.length) {
    lines.push(`      ${inTests.length} reference(s) in TESTS — a test that still exercises the old path `
      + 'keeps it alive and passes while doing it: ' + inTests.slice(0, 4).map((t) => `${t.where}:${t.line}`).join(', '));
  }
  if (r.text.length) lines.push(`      ${r.text.length} mention(s) in strings or comments`);
  return lines;
}

/** The full report. Verdict first, because that is what is being asked. */
function describe(result) {
  const lines = [];
  const notGone = result.gone.filter((r) => r.state === STATE.DEFINED || r.state === STATE.REFERENCED);
  const missing = result.present.filter((r) => r.state === STATE.GONE || r.state === STATE.TEXT_ONLY);
  const stillThere = result.removed.filter((r) => r.stillThere);
  const orphanImports = result.removed.filter((r) => !r.stillThere && r.importers.length);

  const complete = !notGone.length && !missing.length && !stillThere.length && !orphanImports.length;
  lines.push(complete
    ? 'MIGRATION COMPLETE — everything that was supposed to go is gone, and everything that was supposed to replace it is there.'
    : 'MIGRATION INCOMPLETE.');

  if (result.gone.length) {
    lines.push('', 'SHOULD BE GONE');
    for (const r of result.gone) lines.push(...describeGone(r));
  }
  if (result.removed.length) {
    lines.push('', 'FILES THAT SHOULD BE GONE');
    for (const r of result.removed) {
      if (r.stillThere) {
        lines.push(`  ${r.path} — STILL ON DISK.`
          + (r.importers.length ? ` ${r.importers.length} file(s) still import it.` : ' Nothing imports it.'));
      } else if (r.importers.length) {
        lines.push(`  ${r.path} — deleted, but ${r.importers.length} file(s) STILL IMPORT IT, which will fail at load:`);
        for (const i of r.importers.slice(0, 6)) lines.push(`      ${i.where}:${i.line}  ${i.spec}`);
      } else {
        lines.push(`  ${r.path} — GONE, and nothing imports it.`);
      }
    }
  }
  if (result.present.length) {
    lines.push('', 'SHOULD EXIST');
    for (const r of result.present) {
      if (r.definitions.length) {
        const d = r.definitions[0];
        lines.push(`  ${r.name} — present (${d.where}:${d.line}, ${d.kind}).`);
      } else if (r.references.length) {
        lines.push(`  ${r.name} — REFERENCED BUT NEVER DEFINED (${r.references[0].where}:${r.references[0].line}). `
          + 'The new path is wired up to something that does not exist.');
      } else {
        lines.push(`  ${r.name} — NOT FOUND. The replacement is not there.`);
      }
    }
  }
  lines.push('', 'Occurrences are classified on tokens: a name in a string or a comment is reported separately '
    + 'from one in code, and is not evidence of a live dependency by itself. Nothing here was changed.');
  return lines.join('\n');
}

module.exports = { check, describe, forName, forPath, STATE, TEST_RE };
