'use strict';

/**
 * ONE QUESTION, ONE ROUND TRIP: "where is this, and what touches it?"
 *
 * ------------------------------------------------------------------------
 * THE MEASURED FAILURE THIS EXISTS FOR.
 *
 * A request in this codebase costs about 65,000 input tokens — 14,778 of fixed
 * prompt and tool schemas, and up to 50,000 of conversation — and returns a
 * tool call of about 36 output tokens. That is the whole shape of the incident:
 * 815 requests, 59.2M input, 202K output.
 *
 * The model was not being wasteful. It was doing the only thing available to
 * it. Asked to change one function, it had to run this sequence, and EVERY ARROW
 * IS A FULL 65K REQUEST:
 *
 *     symbols("saveSettings")      -> where is it?
 *          |
 *     read_symbol("saveSettings")  -> what does it do?
 *          |
 *     dependents("src/settings.js") -> what breaks if I change it?
 *          |
 *     read_file(...)               -> ...and what did that caller look like?
 *
 * Four hops, ~260,000 input tokens, to learn four facts that are all sitting on
 * disk and are all derivable from ONE pass over the tree.
 *
 * ------------------------------------------------------------------------
 * SO THE COMPOSITION HAPPENS HERE, NOT IN THE MODEL.
 *
 * This walks the project ONCE and answers all four at the same time. It is not
 * a new index and not a new subsystem: it uses `search.walk` for the traversal,
 * the same `defineRe` classification `symbols` uses, the same import matching
 * `dependents` uses, and `codemodel` for the definition body. Nothing here
 * knows anything those do not.
 *
 * WALKING ONCE IS ALSO CHEAPER THAN THE TWO TOOLS IT REPLACES. `symbols` and
 * `dependents` each walk the whole tree; asking both costs two traversals and
 * two model round trips. This costs one of each.
 *
 * ------------------------------------------------------------------------
 * IT RETURNS EVIDENCE, NOT A VERDICT. The definition is quoted because that is
 * the thing being changed. References are COUNTED PER FILE rather than listed
 * line by line: "7 uses across 4 files" is what a person decides with, and the
 * forty lines behind it are what made the old output expensive. Anything deeper
 * remains one `read_file` away — see the note on escalation at `MAX_*`.
 *
 * WHAT IT CANNOT DO, stated because a tool that overstates its reach is worse
 * than one that is narrow. It is LEXICAL, exactly like the two tools it
 * composes: it cannot tell two different things with the same name apart, it
 * cannot follow an alias or a re-export chain, and it counts a mention in a
 * comment as a use. It is a very good index. It is not a compiler.
 */

const fs = require('fs');
const path = require('path');

const search = require('./tools/search');
const codemodel = require('./codemodel');

/** Files bigger than this are indexed by name only — see search.js. */
const MAX_FILE_BYTES = 2_000_000;

/**
 * ---- WHERE THE ANSWER STOPS AND ESCALATION BEGINS ----------------------
 *
 * These are the budget for a CURATED answer, not a ceiling on what the model
 * may know. The rule this file follows is "cheapest sufficient evidence first",
 * never "cheapest evidence forever": every cap below is reported when it bites
 * (`[N more]`), and the ordinary tools remain available for the case where the
 * summary genuinely was not enough. A tool that silently truncated would teach
 * the model to distrust the channel, which costs more than it saves.
 */
const MAX_DEF_LINES = 60;
const MAX_DEF_FILES = 6;
const MAX_REF_FILES = 12;
const MAX_DEPENDENT_FILES = 12;

/** Which line looks like a definition, and which like an import. */
const IMPORT_RE = /\b(?:import|require|from|include)\b/;

function rel(root, abs) {
  return path.relative(root, abs).replace(/\\/g, '/');
}

/**
 * The specifier forms a file can be imported by — the same set `dependents`
 * builds, kept here so one walk can answer both questions.
 */
function specForms(relPath) {
  const forms = new Set();
  const noExt = relPath.replace(/\.[^./]+$/, '');
  forms.add(relPath);
  forms.add(noExt);
  if (/\/index$/.test(noExt)) forms.add(noExt.replace(/\/index$/, ''));
  forms.add(path.posix.basename(relPath));
  forms.add(path.posix.basename(noExt));
  if (/\.py$/.test(relPath)) forms.add(noExt.replace(/\//g, '.'));
  return forms;
}

function importsTarget(line, fromRel, targetRel, forms) {
  if (!IMPORT_RE.test(line)) return false;
  const m = line.match(/['"]([^'"]+)['"]/);
  if (!m) return false;
  const spec = m[1].replace(/\\/g, '/').replace(/^\.\//, '').replace(/[?#].*$/, '');
  if (!spec) return false;
  if (/^\.\.?\//.test(m[1]) || m[1].startsWith('./')) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    return resolved === targetRel
      || targetRel.startsWith(resolved + '.')
      || targetRel === resolved + '/index.js'
      || targetRel === resolved + '/index.ts';
  }
  if (forms.has(spec)) return true;
  return targetRel.endsWith('/' + spec);
}

/**
 * ONE PASS. Collects, for `name`: every line that defines it, every line that
 * imports it, and a per-file count of every other mention.
 */
function sweep(root, name, { include = null } = {}) {
  const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const isDef = search.defineRe(name);
  const includeRe = include ? search.globToRegExp(String(include)) : null;

  const defs = [];
  const refsByFile = new Map();
  let scanned = 0;
  let refs = 0;

  for (const f of search.walk(root)) {
    if (includeRe && !includeRe.test(f.rel)) continue;
    let st;
    try { st = fs.statSync(f.abs); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    let buf;
    try { buf = fs.readFileSync(f.abs); } catch { continue; }
    if (search.looksBinary(buf)) continue;
    scanned += 1;

    const lines = buf.toString('utf8').split('\n');
    let inFile = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!word.test(line)) continue;
      if (isDef.test(line)) {
        defs.push({ file: f.rel, abs: f.abs, line: i + 1, text: line.trim().slice(0, 160) });
      } else {
        inFile += 1;
        refs += 1;
      }
    }
    if (inFile > 0) refsByFile.set(f.rel, inFile);
  }
  return { defs, refsByFile, refs, scanned };
}

/** Every file that imports `targetRel`, from one pass. */
function dependentsOf(root, targetRel, { include = null } = {}) {
  const forms = specForms(targetRel);
  const includeRe = include ? search.globToRegExp(String(include)) : null;
  const hits = [];
  for (const f of search.walk(root)) {
    if (f.rel === targetRel) continue;
    if (includeRe && !includeRe.test(f.rel)) continue;
    let st;
    try { st = fs.statSync(f.abs); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    let buf;
    try { buf = fs.readFileSync(f.abs); } catch { continue; }
    if (search.looksBinary(buf)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (importsTarget(lines[i], f.rel, targetRel, forms)) {
        hits.push({ file: f.rel, line: i + 1, text: lines[i].trim().slice(0, 120) });
        break;
      }
    }
  }
  return hits;
}

/**
 * The definition body, when the file is one `codemodel` can read.
 *
 * BOUNDED AND SAID SO. A 400-line function is quoted to its first 60 lines with
 * the range named, because the point of this call is to decide WHERE to work —
 * the whole body is one `read_symbol` away and the answer says so.
 */
function definitionBody(abs, name) {
  let model;
  try { model = codemodel.scanFile(abs); } catch { return null; }
  if (!model || !model.supported || !model.source) return null;
  const hits = codemodel.find(model, name);
  if (!hits.length) return null;
  const s = hits[0];
  const body = model.source.slice(s.start, s.end);
  const lines = body.split('\n');
  const startLine = model.source.slice(0, s.start).split('\n').length;
  return {
    kind: s.kind,
    container: s.container || null,
    startLine,
    endLine: startLine + lines.length - 1,
    lines: lines.length,
    text: lines.slice(0, MAX_DEF_LINES).join('\n'),
    truncated: lines.length > MAX_DEF_LINES,
  };
}

/**
 * WHERE IS THIS, AND WHAT TOUCHES IT.
 *
 * @param {string} root  the project root
 * @param {string} what  an identifier, or a project-relative file path
 * @returns {{ok:boolean, text:string, meta:object}}
 */
function locate(root, what, { include = null } = {}) {
  const q = String(what == null ? '' : what).trim();
  if (!q) return { ok: false, text: 'locate needs a name or a path', meta: {} };

  // ---- A PATH IS A DIFFERENT QUESTION FROM A NAME ------------------------
  //
  // "what is wired into src/settings.js" and "where is saveSettings" are both
  // asked with one word, and answering the wrong one wastes the round trip this
  // call exists to save. A value that names a file that EXISTS is a path;
  // everything else is a name, including a word with a dot in it.
  const asPath = path.resolve(root, q);
  let isFile = false;
  try { isFile = fs.statSync(asPath).isFile(); } catch { isFile = false; }

  if (isFile) return locateFile(root, rel(root, asPath), { include });
  if (!/^[\w$.-]+$/.test(q)) {
    return {
      ok: false,
      text: `"${q}" is neither a file in this project nor an identifier.\n`
        + 'Use grep for free text, or give a project-relative path.',
      meta: {},
    };
  }
  return locateName(root, q, { include });
}

function locateFile(root, relPath, { include = null } = {}) {
  const abs = path.resolve(root, relPath);
  const deps = dependentsOf(root, relPath, { include });
  let outline = null;
  try {
    const model = codemodel.scanFile(abs);
    if (model && model.supported) outline = model.symbols;
  } catch { outline = null; }

  const out = [`LOCATE ${relPath}`, ''];
  if (outline && outline.length) {
    out.push(`DEFINES ${outline.length} symbol(s)`);
    for (const s of outline.slice(0, 40)) {
      out.push(`  ${s.kind.padEnd(9)} ${s.container ? `${s.container}.` : ''}${s.name}`);
    }
    if (outline.length > 40) out.push(`  [${outline.length - 40} more]`);
    out.push('');
  }
  out.push(deps.length
    ? `IMPORTED BY ${deps.length} file(s)`
    : 'IMPORTED BY nothing — no textual import of this path was found');
  for (const d of deps.slice(0, MAX_DEPENDENT_FILES)) out.push(`  ${d.file}:${d.line}  ${d.text}`);
  if (deps.length > MAX_DEPENDENT_FILES) out.push(`  [${deps.length - MAX_DEPENDENT_FILES} more]`);
  out.push('');
  out.push(CAVEAT);
  return { ok: true, text: out.join('\n'), meta: { kind: 'file', dependents: deps.length } };
}

function locateName(root, name, { include = null } = {}) {
  const { defs, refsByFile, refs, scanned } = sweep(root, name, { include });

  if (!defs.length && !refs) {
    return {
      ok: true,
      text: `LOCATE ${name}\n\n"${name}" does not appear in ${scanned} file(s)`
        + `${include ? ` matching ${include}` : ''}.\n\n`
        + 'Nothing defines it and nothing mentions it. If it should exist, it has not been written yet.',
      meta: { kind: 'name', defs: 0, refs: 0, scanned },
    };
  }

  const out = [`LOCATE ${name}`, ''];

  // ---- WHERE IT IS DECLARED ---------------------------------------------
  if (defs.length) {
    out.push(`DECLARED in ${defs.length} place(s)`);
    for (const d of defs.slice(0, MAX_DEF_FILES)) out.push(`  ${d.file}:${d.line}  ${d.text}`);
    if (defs.length > MAX_DEF_FILES) out.push(`  [${defs.length - MAX_DEF_FILES} more]`);
    out.push('');
  } else {
    // A name that is used everywhere and declared nowhere is a fact worth
    // stating plainly: it is imported from a dependency, or it is a typo.
    out.push('DECLARED nowhere in this project');
    out.push('  It is used but never defined here — it comes from a dependency, or it is misspelled.');
    out.push('');
  }

  // ---- WHAT IT ACTUALLY IS ----------------------------------------------
  const primary = defs[0];
  if (primary) {
    const body = definitionBody(primary.abs, name);
    if (body) {
      out.push(`DEFINITION ${primary.file}:${body.startLine}-${body.endLine}`
        + `  (${body.kind}${body.container ? ` on ${body.container}` : ''}, ${body.lines} lines)`);
      for (const l of body.text.split('\n')) out.push(`  ${l}`);
      if (body.truncated) {
        out.push(`  [${body.lines - MAX_DEF_LINES} more lines — read_symbol ${name} for the whole definition]`);
      }
      out.push('');
    }
  }

  // ---- WHO TOUCHES IT ---------------------------------------------------
  //
  // COUNTED PER FILE, not listed line by line. "7 uses across 4 files" is what
  // the decision is made with; the forty individual lines behind it are what
  // made the old answer expensive without making it better.
  const files = [...refsByFile.entries()].sort((a, b) => b[1] - a[1]);
  if (files.length) {
    out.push(`REFERENCED ${refs} time(s) across ${files.length} file(s)`);
    for (const [file, count] of files.slice(0, MAX_REF_FILES)) {
      out.push(`  ${String(count).padStart(3)}  ${file}`);
    }
    if (files.length > MAX_REF_FILES) out.push(`  [${files.length - MAX_REF_FILES} more files]`);
    out.push('');
  }

  // ---- WHAT BREAKS IF IT CHANGES ----------------------------------------
  //
  // FROM THE INDEX WHERE THERE IS ONE. `.lain/` already records every file's
  // import specifiers, so this question costs a lookup rather than a second
  // walk of the tree - see projectindex.js. The index is refreshed against the
  // disk before it is read, so it cannot answer from a stale entry; when there
  // is no index, or it holds nothing for this project, the walk still happens.
  if (primary) {
    const deps = importersFromIndex(root, primary.file) || dependentsOf(root, primary.file, { include });
    out.push(deps.length
      ? `${primary.file} IS IMPORTED BY ${deps.length} file(s)`
      : `${primary.file} is imported by nothing found textually`);
    for (const d of deps.slice(0, MAX_DEPENDENT_FILES)) out.push(`  ${d.file}:${d.line}`);
    if (deps.length > MAX_DEPENDENT_FILES) out.push(`  [${deps.length - MAX_DEPENDENT_FILES} more]`);
    out.push('');
  }

  out.push(CAVEAT);
  return {
    ok: true,
    text: out.join('\n'),
    meta: { kind: 'name', defs: defs.length, refs, files: files.length, scanned },
  };
}

/**
 * Importers from `.lain/`, or null when the index cannot answer.
 *
 * NULL RATHER THAN AN EMPTY LIST, and the difference is the whole care here: an
 * empty list means "nothing imports this", which is a claim, and a missing
 * index means "ask the tree". Returning `[]` for the second would report a file
 * as unused because an index had not been built yet.
 */
function importersFromIndex(root, relPath) {
  let pi;
  try { pi = require('./projectindex'); } catch { return null; }
  let r;
  // REFRESHED BEFORE IT IS READ. A stat pass over the tree, and a re-scan of
  // anything that moved - never a read of what was written last time.
  try { r = pi.fresh(root); } catch { return null; }
  if (!r || !r.index || !r.index.files || !r.index.files[relPath]) return null;
  return pi.importersOf(r.index, relPath).map((file) => ({ file, line: 0, text: '' }));
}

/** Said on every answer, because a very good index is not a compiler. */
const CAVEAT = 'LEXICAL: matched as text across the tree on disk. It cannot tell two things '
  + 'with the same name apart, follow an alias or a re-export, and counts a mention in a comment '
  + 'as a use. Confirm anything you are about to rewrite.';

module.exports = { locate, locateName, locateFile, sweep, dependentsOf, definitionBody, importersFromIndex, CAVEAT };
