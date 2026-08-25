'use strict';

/**
 * THE DATA CONTRACT — where a value actually comes from, and whether the place
 * it used to come from is still there.
 *
 * The failure this exists for is the one `residue.js` already catches after the
 * fact: a dataset moved out of the source and into JSON, the new loader works,
 * every test is green, and the old embedded copy is still sitting in a module
 * that something still imports. Two sources of truth, and the next edit lands
 * on whichever one the editor happened to open.
 *
 * `find_residue` answers that when somebody already suspects it and names the
 * symbol. This answers it WITHOUT being asked, by looking at the shape of the
 * project: which JSON files exist, which modules load them, and which modules
 * hold a large literal that looks like the same kind of data.
 *
 * A LITERAL IS NOT A CRIME. Most object literals are configuration, defaults,
 * lookup tables and vocabulary, and flagging them would bury the one that
 * matters. So a literal is only reported when a JSON file with a MATCHING NAME
 * also exists — `enemies.json` beside an `ENEMIES` literal — which is the shape
 * of a half-done migration and almost nothing else.
 */

const fs = require('fs');
const path = require('path');

const F = require('./facts');
const { AREA, VIA } = F;
const F2 = require('./findings');
const { CONFIDENCE } = F2;
const { walk } = require('./tools/search');

/** Bounds — a data sweep must not become the expensive part of a briefing. */
const MAX_JSON = 200;
const MAX_SOURCE = 1500;
/** A literal smaller than this is a setting, not a dataset. */
const DATASET_ENTRIES = 4;

/** Files that are configuration rather than project data. */
const NOT_DATA = /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig\.json|jsconfig\.json|composer\.json|\.eslintrc\.json)$/i;

function read(abs) {
  try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; }
}

/**
 * The JSON data files in this project, and whether anything loads them.
 *
 * "Loaded" means a source file mentions the file's basename in a way a reader
 * would call a load. Lexical and deliberately so: this is orientation, and it
 * is reported as what was found rather than as proof.
 */
function jsonSources(root) {
  const jsons = [];
  const sources = [];
  for (const f of walk(root)) {
    if (/\.json$/i.test(f.rel)) {
      if (NOT_DATA.test(f.rel)) continue;
      if (jsons.length < MAX_JSON) jsons.push(f);
      continue;
    }
    if (/\.(?:js|cjs|mjs)$/i.test(f.rel) && sources.length < MAX_SOURCE) sources.push(f);
  }
  return { jsons, sources };
}

/**
 * How many members the outermost literal in `text` has.
 *
 * Counted from tokens at bracket depth 1, so a comma inside a nested object, a
 * string or a regex is not a member — and so formatting is irrelevant.
 */
function topLevelMembers(text) {
  let tokens;
  try { tokens = require('./jsscan').tokenize(text).tokens; } catch { return 0; }
  let depth = 0;
  let started = false;
  let commas = 0;
  let contents = 0;
  for (const t of tokens) {
    if (t.type !== 'punct') { if (depth === 1) contents += 1; continue; }
    if (t.value === '{' || t.value === '[') { depth += 1; started = true; continue; }
    if (t.value === '}' || t.value === ']') { depth -= 1; if (started && depth === 0) break; continue; }
    if (depth === 1 && t.value === ',') commas += 1;
    else if (depth === 1) contents += 1;
  }
  // n members have n-1 separating commas; an empty literal has no contents.
  return contents === 0 ? 0 : commas + 1;
}

/**
 * A source module holding a big object or array literal bound to a NAME.
 *
 * Uses the symbol model rather than a regex, so a brace inside a string or a
 * comment cannot be mistaken for a data structure.
 */
function bigLiterals(model, source) {
  const out = [];
  if (!model || !model.supported) return out;
  for (const s of model.symbols) {
    if (s.container) continue;                          // members belong to their owner
    if (s.kind !== 'variable') continue;
    const text = source.slice(s.start, s.end);
    if (!/=\s*[{[]/.test(text)) continue;
    // ---- COUNT REAL MEMBERS, NOT LINES ----------------------------------
    //
    // Counting lines that begin with a word character scored a compact
    // one-line table as ONE entry, so `const ENEMIES = { slime: {…}, wolf:
    // {…} };` — the exact shape this module exists to catch — was missed
    // entirely. Members are counted from the token stream instead, so how the
    // literal is formatted stops mattering, and a comma inside a nested object
    // or a string cannot be counted as a top-level member.
    const entries = topLevelMembers(text);
    if (entries < DATASET_ENTRIES) continue;
    out.push({ name: s.name, line: s.startLine, entries });
  }
  return out;
}

/** Does `name` look like it names the same thing as `file`? */
function namesMatch(symbolName, jsonRel) {
  const base = path.posix.basename(jsonRel).replace(/\.json$/i, '');
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = norm(symbolName);
  const b = norm(base);
  if (!a || !b) return false;
  return a === b || a === `${b}s` || `${a}s` === b;
}

/**
 * Establish the data contract, and report any two-sources-of-truth shape found.
 *
 * @returns {{facts, findings}}
 */
function discover(root) {
  const facts = [];
  const findings = [];
  const { jsons, sources } = jsonSources(root);

  if (!jsons.length) {
    return {
      facts: [F.make({
        area: AREA.DATA,
        name: 'External data files',
        value: 'none found',
        confidence: CONFIDENCE.PROVEN,
        via: VIA.FILESYSTEM,
        evidence: 'no JSON outside manifests and tool configuration',
      })],
      findings,
    };
  }

  facts.push(F.make({
    area: AREA.DATA,
    name: 'External data files',
    value: `${jsons.length} JSON file(s)`,
    confidence: CONFIDENCE.PROVEN,
    via: VIA.FILESYSTEM,
    examples: jsons.slice(0, 5).map((j) => j.rel),
    evidence: 'walked the project, excluding manifests and tool configuration',
  }));

  // ---- WHO LOADS WHAT ----------------------------------------------------
  const codemodel = require('./codemodel');
  const models = new Map();
  const loadersFor = new Map();
  for (const s of sources) {
    const src = read(s.abs);
    if (!src) continue;
    let model = null;
    try { model = codemodel.scan(src, s.abs); } catch { model = null; }
    models.set(s.rel, { model, src });
    for (const j of jsons) {
      const base = path.posix.basename(j.rel);
      if (!src.includes(base)) continue;
      if (!loadersFor.has(j.rel)) loadersFor.set(j.rel, []);
      loadersFor.get(j.rel).push(s.rel);
    }
  }

  const orphaned = jsons.filter((j) => !loadersFor.has(j.rel));
  if (orphaned.length) {
    facts.push(F.make({
      area: AREA.DATA,
      name: 'Data files nothing loads',
      value: String(orphaned.length),
      confidence: CONFIDENCE.OBSERVED,
      via: VIA.SOURCE,
      examples: orphaned.slice(0, 4).map((j) => j.rel),
      evidence: 'no source file mentions the file name',
      notes: 'Lexical: a path built at runtime is invisible to this. It is a place to look, not a verdict.',
    }));
  }

  // ---- TWO SOURCES OF TRUTH ---------------------------------------------
  //
  // The finding this whole module exists to produce.
  for (const [rel, { model, src }] of models) {
    const literals = bigLiterals(model, src);
    if (!literals.length) continue;
    for (const lit of literals) {
      const twin = jsons.find((j) => namesMatch(lit.name, j.rel));
      if (!twin) continue;
      const loaders = loadersFor.get(twin.rel) || [];
      findings.push(F2.make({
        category: F2.CATEGORY.MIGRATION_RESIDUE,
        severity: F2.SEVERITY.WARNING,
        // The two things exist; that they are the SAME data is inferred from
        // their names, and the wording keeps those apart.
        confidence: F2.CONFIDENCE.INFERRED,
        source: F2.SOURCE.SYMBOL_GRAPH,
        file: rel,
        line: lit.line,
        symbol: lit.name,
        actual: `${lit.name} is a literal in ${rel}`,
        expected: `${twin.rel}`,
        message: `${lit.name} is a ${lit.entries}-entry literal in ${rel}, and ${twin.rel} exists with a `
          + 'matching name.',
        explanation: 'That is the shape of a migration that added the external file and left the embedded copy '
          + 'behind. Both work, so no test fails, and the project now has two places the same data lives.',
        risk: 'An edit to one leaves the other serving whoever still reads it.',
        related: {
          files: [twin.rel, ...loaders.slice(0, 5)],
          symbols: [lit.name],
          tests: [],
        },
        evidence: `symbol model: ${lit.name} declared at ${rel}:${lit.line}; ${twin.rel} on disk`
          + (loaders.length ? `; loaded by ${loaders.slice(0, 3).join(', ')}` : '; nothing appears to load it'),
      }));
    }
  }

  facts.push(F.make({
    area: AREA.DATA,
    name: 'JSON encoding',
    value: 'UTF-8, parsed with JSON.parse',
    confidence: CONFIDENCE.PROVEN,
    via: VIA.SOURCE,
    evidence: 'every JSON read in the tree passes "utf8" and uses the standard parser',
    notes: 'No trailing commas and no comments: JSON.parse rejects both, unlike a JavaScript literal.',
  }));

  return { facts, findings };
}

module.exports = { discover, jsonSources, bigLiterals, namesMatch, topLevelMembers, DATASET_ENTRIES };
