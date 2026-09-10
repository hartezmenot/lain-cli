'use strict';

/**
 * GIT AS AN INSTRUMENT — what the working tree says happened, versus what was
 * meant to happen.
 *
 * A model that has just made a change believes it knows what it changed. It
 * knows what it INTENDED; the working tree knows what is actually different,
 * and the two come apart constantly and quietly:
 *
 *   · a one-line fix arrives as a 4,000-line diff, because an editor reformatted
 *   · a file was rewritten whole when three lines were meant, and the diff is
 *     the entire file replaced by a near-identical copy
 *   · a build ran and `dist/` is now in the change set
 *   · a file was deleted that nobody mentioned deleting
 *   · a debug print added while diagnosing is still there
 *
 * None of these fails a test. All of them are obvious the moment somebody looks
 * at the shape of the diff, and nobody does, because looking costs a tool call
 * and reading the output costs more.
 *
 * So the shape is measured. This does not read the diff CONTENT into a model's
 * context — that is the expensive thing it exists to avoid. It reads the
 * NUMBERS: which files, how many lines each way, how that compares to the size
 * of the file, and whether the change set matches the files LAIN actually
 * touched this session.
 *
 * IT MAKES NO JUDGEMENT ABOUT CORRECTNESS. A 4,000-line diff can be exactly
 * right. What it does is make the shape visible so a wrong one cannot pass
 * unremarked, and it says which observations are suspicious rather than
 * treating them as errors.
 */

const fs = require('fs');
const path = require('path');
const { execute } = require('./tools/exec');

/** A diff bigger than this in one file is worth remarking on. */
const BIG_FILE_LINES = 400;
/** A change set bigger than this in total is worth remarking on. */
const BIG_TOTAL_LINES = 1500;
/** Above this fraction of a file's lines touched, it is a rewrite not an edit. */
const REWRITE_FRACTION = 0.8;

/** Paths that are produced rather than written, and rarely belong in a diff. */
const GENERATED = [
  [/(?:^|\/)node_modules\//, 'a dependency directory'],
  [/(?:^|\/)(?:dist|build|out|target|coverage|\.next|__pycache__)\//, 'a build output directory'],
  [/\.min\.(?:js|css)$/, 'a minified bundle'],
  [/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock)$/, 'a lockfile'],
  [/\.(?:pyc|pyo|class|o|so|dll|exe)$/, 'a compiled artifact'],
  [/(?:^|\/)\.env(?:\.|$)/, 'an environment file, which may hold secrets'],
];

async function git(cwd, args) {
  const r = await execute('git', args, { cwd, timeoutMs: 20_000 });
  return { ok: r.ok, out: String(r.stdout || ''), err: String(r.stderr || ''), code: r.exitCode };
}

/**
 * The working tree, from `--porcelain`, which is the machine-readable form and
 * is stable across git versions in a way the human output is not.
 *
 * `-- .`: the tree AS SEEN FROM cwd. Unscoped, git reports the whole
 * repository's state — so a session rooted in one directory of a monorepo
 * would be briefed on every other directory's changes. The pathspec scopes
 * the answer to the session's own subtree. The names stay repo-root-relative
 * regardless: porcelain v1 ignores `status.relativePaths` on purpose
 * (git-status(1): "paths shown will always be relative to the repository
 * root"), and review() is where that base is converted.
 */
async function status(cwd) {
  const r = await git(cwd, ['status', '--porcelain=v1', '-uall', '--', '.']);
  if (!r.ok) return { ok: false, error: r.err.trim() || 'git status failed' };
  const files = [];
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    let file = line.slice(3).trim();
    // A rename is reported as `old -> new`; the new name is the one that exists.
    const arrow = file.indexOf(' -> ');
    let from = null;
    if (arrow >= 0) { from = file.slice(0, arrow).trim(); file = file.slice(arrow + 4).trim(); }
    files.push({
      file: file.replace(/^"|"$/g, ''),
      from,
      staged: x !== ' ' && x !== '?',
      untracked: x === '?',
      deleted: x === 'D' || y === 'D',
      renamed: Boolean(from),
    });
  }
  return { ok: true, files };
}

/**
 * Lines added and removed per file, for both the staged and unstaged halves.
 *
 * `--numstat` rather than a diff: the numbers are what reveal the shape, and
 * the content is the part that costs a context window.
 */
async function numstat(cwd) {
  const totals = new Map();
  for (const args of [
    // --no-relative: numstat's names must sit in the same frame as status's.
    // Both default to repo-root-relative, but a user's `diff.relative` config
    // can flip diff's frame (git-diff(1) --relative), which would silently
    // desync the two halves of the join in review(). Pinning it here makes
    // the frame a property of the code, not of the machine's config.
    // `-- .`: same subtree scoping as status().
    ['diff', '--numstat', '--no-relative', '--', '.'],
    ['diff', '--numstat', '--staged', '--no-relative', '--', '.'],
  ]) {
    const r = await git(cwd, args);
    if (!r.ok) continue;
    for (const line of r.out.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (!m) continue;
      const file = m[3].includes(' => ') ? m[3].replace(/.*=> /, '').replace(/[{}]/g, '') : m[3];
      const prev = totals.get(file) || { added: 0, removed: 0, binary: false };
      if (m[1] === '-' || m[2] === '-') prev.binary = true;
      else { prev.added += Number(m[1]); prev.removed += Number(m[2]); }
      totals.set(file, prev);
    }
  }
  return totals;
}

function countLines(abs) {
  try { return fs.readFileSync(abs, 'utf8').split('\n').length; } catch { return null; }
}

/**
 * The whole assessment.
 *
 * @param {string} cwd
 * @param {object} [o]
 * @param {string[]} [o.expected] the files LAIN believes it changed. Anything in
 *   the tree that is not in here is reported as unexpected — which is not the
 *   same as wrong: the tree may have been dirty before the session started.
 */
async function review(cwd, { expected = [] } = {}) {
  // One rev-parse answers both entry questions at once: is cwd inside a work
  // tree at all, and — the fact the frame conversion below turns on — how cwd
  // sits under the repository root. This replaces the separate isRepo probe,
  // because review() runs once per request on the per-turn path and a git
  // spawn on Windows is not free.
  const pf = await git(cwd, ['rev-parse', '--is-inside-work-tree', '--show-prefix']);
  const pfl = String(pf.out || '').split('\n');
  if (!pf.ok || pfl[0].trim() !== 'true') {
    return { ok: false, error: 'not a git repository, so there is nothing to compare against' };
  }
  const st = await status(cwd);
  if (!st.ok) return { ok: false, error: st.error };
  const stats = await numstat(cwd);

  // ---- THE TWO FRAMES, JOINED IN ONE PLACE --------------------------------
  //
  // status() and numstat() both report names relative to the REPOSITORY ROOT
  // (porcelain v1 ignores status.relativePaths on purpose; --no-relative pins
  // numstat the same way), while everything downstream of here — the expected
  // list, countLines, the names a model reads back — is in the CWD frame. When
  // cwd is the repo root the two coincide and none of this matters; when it is
  // a subdirectory they diverge on every file, and before this join existed a
  // subdirectory session had EVERY file flagged `unexpected` (its expected
  // paths, normalized cwd-relative, could never equal git's root-relative
  // names) while countLines probed paths that did not exist. The second line
  // of the rev-parse above is git's own answer for how cwd sits under the
  // root: 'sub/dir/' from inside one, '' at the root — where the conversion
  // is the identity, so a root-level session's answers are byte-for-byte
  // what they always were.
  const prefix = (pfl[1] || '').trim();
  const inCwd = (name) => (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name);

  const want = new Set(expected.map((p) => {
    const rel = path.isAbsolute(p) ? path.relative(cwd, p) : p;
    return rel.replace(/\\/g, '/');
  }));

  const files = st.files.map((f) => {
    // The stats join happens in git's root frame — both sides as git reported
    // them — and only then is the name converted to the cwd frame for
    // everything LAIN does with it.
    const s = stats.get(f.file) || { added: 0, removed: 0, binary: false };
    const total = s.added + s.removed;
    const file = inCwd(f.file);
    const lines = f.deleted ? null : countLines(path.join(cwd, file));
    const generated = GENERATED.find(([re]) => re.test(file));
    return {
      ...f,
      file,
      from: f.from ? inCwd(f.from) : f.from,
      added: s.added,
      removed: s.removed,
      binary: s.binary,
      lines,
      // A "rewrite" is a file where nearly every line is on both sides of the
      // diff — the signature of writing a file back whole instead of patching
      // it, and of a reformat.
      rewrite: !f.deleted && !f.untracked && lines != null && lines > 30
        && s.removed >= lines * REWRITE_FRACTION && s.added >= lines * REWRITE_FRACTION,
      big: total >= BIG_FILE_LINES,
      generated: generated ? generated[1] : null,
      unexpected: want.size > 0 && !want.has(file),
    };
  });

  const totalLines = files.reduce((n, f) => n + f.added + f.removed, 0);
  return {
    ok: true,
    files,
    totalLines,
    huge: totalLines >= BIG_TOTAL_LINES,
    hadExpectation: want.size > 0,
    missing: [...want].filter((w) => !files.some((f) => f.file === w)),
  };
}

/** One line per file, then the observations that are worth a second look. */
function describe(r) {
  if (!r.ok) return r.error;
  if (!r.files.length) return 'The working tree is clean — git reports nothing changed, added or deleted.';

  const lines = [`${r.files.length} file(s) differ from the last commit, ${r.totalLines} line(s) in total.`];
  for (const f of r.files.slice(0, 40)) {
    const marks = [
      f.untracked ? 'NEW' : null,
      f.deleted ? 'DELETED' : null,
      f.renamed ? `renamed from ${f.from}` : null,
      f.binary ? 'binary' : null,
    ].filter(Boolean).join(' ');
    lines.push(`  ${f.file}  +${f.added} -${f.removed}${marks ? `  ${marks}` : ''}`);
  }
  if (r.files.length > 40) lines.push(`  [${r.files.length - 40} more]`);

  // ---- WHAT IS WORTH A SECOND LOOK ---------------------------------------
  //
  // Phrased as observations with their reasoning attached, never as errors.
  // Every one of these can be entirely correct, and saying so is what keeps
  // the section readable rather than something to scroll past.
  const notes = [];
  const rewrites = r.files.filter((f) => f.rewrite);
  if (rewrites.length) {
    notes.push(`WHOLE-FILE REWRITE: ${rewrites.map((f) => f.file).join(', ')} — nearly every line is on both `
      + 'sides of the diff. That is what writing a file back whole looks like, and what a reformat looks like. '
      + 'If a few lines were meant, the rest of the diff is unintended.');
  }
  const deleted = r.files.filter((f) => f.deleted);
  if (deleted.length) notes.push(`DELETED: ${deleted.map((f) => f.file).join(', ')}.`);
  const gen = r.files.filter((f) => f.generated);
  if (gen.length) {
    notes.push('GENERATED OR BUILT FILES in the change set: '
      + gen.map((f) => `${f.file} (${f.generated})`).join(', ')
      + ' — these are usually produced by a command rather than edited.');
  }
  const big = r.files.filter((f) => f.big && !f.rewrite && !f.untracked);
  if (big.length) notes.push(`LARGE: ${big.map((f) => `${f.file} (${f.added + f.removed} lines)`).join(', ')}.`);
  if (r.huge) notes.push(`The change set is ${r.totalLines} lines. If the task was small, most of this was not asked for.`);
  if (r.hadExpectation) {
    const surprise = r.files.filter((f) => f.unexpected);
    if (surprise.length) {
      notes.push(`NOT CHANGED BY THIS SESSION: ${surprise.map((f) => f.file).join(', ')} — these differ from the `
        + 'last commit but are not files LAIN wrote. They may have been dirty before this session started.');
    }
    if (r.missing.length) {
      // "No change" is two observations, not one: the write matched the
      // committed bytes, or git never looks at the path at all (ignored, or
      // outside the reviewed subtree). Only the first was being stated — a
      // false inference whenever the second was the case.
      notes.push(`WRITTEN BUT NOT DIFFERENT: ${r.missing.join(', ')} — LAIN wrote these and git reports no change `
        + 'for them: either the write produced the same bytes that were already there, or the path is not one '
        + 'git tracks (ignored, or outside this directory).');
    }
  }
  if (notes.length) lines.push('', 'WORTH A SECOND LOOK', ...notes.map((n) => `  ${n}`));
  return lines.join('\n');
}

module.exports = {
  review, describe, status, numstat,
  GENERATED, BIG_FILE_LINES, BIG_TOTAL_LINES, REWRITE_FRACTION,
};
