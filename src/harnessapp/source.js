'use strict';

/**
 * THE SOURCE WORKSPACE'S BACK HALF — the tree, the file, the save.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT A SECOND FILESYSTEM AUTHORITY, AND THAT IS THE WHOLE DESIGN.
 *
 * The blueprint says it in as many words: the Source UI owns PRESENTATION AND
 * EDIT INTENT; Core/Harness owns the actual read, write and trust. So this
 * module resolves paths through `tools/fs.js` (the one resolver), refuses
 * anything outside the workspace, and applies the SAME truncation guard a model
 * write goes through — because a person dragging a selection over a 30KB file
 * and hitting save is the identical accident, and the guard does not care who
 * caused it.
 *
 * What it adds is the things an EDITOR needs and a tool call does not: a tree
 * to navigate, the modification time so a stale buffer can be noticed, and the
 * knowledge that a file is one this session has already changed.
 *
 * ------------------------------------------------------------------------
 * A SAVE IS CONDITIONAL ON WHAT WAS READ.
 *
 * Every open carries the file's `mtime` and size, and every save sends them
 * back. If the file on disk has moved on — LAIN edited it, a build wrote it,
 * git checked something out — the save is REFUSED and the caller is told, with
 * the current bytes, so a person can look before deciding.
 *
 * This is the one interaction where a Harness editor could destroy work that a
 * model just did, and the ordinary last-write-wins would do it silently and
 * often: the entire point of the product is that LAIN is editing these files at
 * the same time as the person is looking at them.
 *
 * ------------------------------------------------------------------------
 * BOUNDED, because it is served over HTTP to a page. A file bigger than
 * MAX_FILE_BYTES is reported as too large rather than streamed into a browser
 * that will hang trying to syntax-highlight it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fstools = require('../tools/fs');

/**
 * THE IDENTITY OF A FILE'S CONTENTS — the save token.
 *
 * ---- WHY NOT `mtimeMs`, WHICH IS WHAT THIS USED TO BE -----------------
 *
 * Two writes inside the same millisecond produce the IDENTICAL mtime. Measured
 * on this machine:
 *
 *     write .a{opacity:0.2}  -> mtimeMs 1789025279604.5515
 *     write .a{opacity:0.9}  -> mtimeMs 1789025279604.5515   (unchanged)
 *
 * So the conditional save FAILED OPEN exactly where it mattered: LAIN edits a
 * file, the person hits save a moment later, the mtimes match, the guard is
 * satisfied and the model's work is overwritten silently. Not a rare race —
 * LAIN writes fast, and saving straight afterwards is the normal thing to do.
 *
 * A hash of the bytes has no resolution to run out of. It costs a few
 * microseconds on files this editor will open at all (2MB ceiling), and it
 * answers the actual question — "is this still the file I read?" — rather than
 * a proxy for it.
 */
function digest(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 32);
}

/** What an editor can usefully hold. Past this it is a data file, not source. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** How many entries one directory listing returns. A tree, not an index. */
const MAX_ENTRIES = 800;

/**
 * DIRECTORIES A SOURCE TREE SHOULD NOT OFFER TO OPEN.
 *
 * Not a security boundary — `inside()` is that. This is about usefulness: a
 * tree whose first expansion is 40,000 files of `node_modules` is a tree
 * nobody can navigate, and the person is looking for their own code.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'coverage', '.cache',
  '.lain', '.lain-probe', 'vendor', '.gradle', '.idea',
]);

/** Extensions the editor will open as text, from the blueprint's list. */
const TEXT_EXT = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.json', '.jsonc', '.md', '.markdown', '.mdx',
  '.py', '.rs', '.go', '.rb', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.sql', '.graphql', '.vue', '.svelte', '.txt', '.gitignore', '.editorconfig',
]);

/** What a highlighter should treat this as. One name, decided once, server-side. */
function language(rel) {
  const e = path.extname(String(rel || '')).toLowerCase();
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(e)) return 'js';
  if (['.ts', '.tsx'].includes(e)) return 'ts';
  if (['.css', '.scss', '.sass', '.less'].includes(e)) return 'css';
  if (['.html', '.htm', '.vue', '.svelte'].includes(e)) return 'html';
  if (['.json', '.jsonc'].includes(e)) return 'json';
  if (['.md', '.markdown', '.mdx'].includes(e)) return 'md';
  if (e === '.py') return 'py';
  if (e === '.rs') return 'rs';
  if (['.yml', '.yaml'].includes(e)) return 'yaml';
  if (['.sh', '.bash', '.zsh'].includes(e)) return 'sh';
  return 'text';
}

function isText(name) {
  const e = path.extname(name).toLowerCase();
  return TEXT_EXT.has(e) || TEXT_EXT.has(name.toLowerCase());
}

/**
 * IS THIS PATH INSIDE THE WORKSPACE? The security boundary, checked on every
 * call rather than once at the edge.
 *
 * `path.relative` rather than a `startsWith` on strings: `/proj` and
 * `/project-two` share a prefix and are not the same tree, and that is exactly
 * the mistake a string comparison makes.
 */
function inside(cwd, abs) {
  const r = path.relative(path.resolve(cwd), path.resolve(abs));
  // AN EMPTY RESULT IS THE ROOT ITSELF, AND THE ROOT IS INSIDE. Requiring a
  // non-empty relative path refused the project directory — so the tree could
  // not list the one directory it exists to list.
  if (r === '') return true;
  return !r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r);
}

/** Resolve a caller-supplied relative path, or say why not. */
function locate(app, rel) {
  const cwd = app.session.cwd || process.cwd();
  const abs = fstools.resolve(cwd, String(rel || ''));
  if (!abs) return { ok: false, why: 'no path given' };
  if (!inside(cwd, abs)) return { ok: false, why: `outside the project: ${rel}` };
  // `fstools.rel` hands back the ABSOLUTE path when the relative one is empty —
  // i.e. for the project root itself, which is exactly what a tree asks for
  // first. Left alone, every path in the first listing came back absolute.
  const r = path.relative(path.resolve(cwd), path.resolve(abs)).replace(/\\/g, '/');
  return { ok: true, abs, cwd, rel: r === '' ? '.' : r };
}

/**
 * ONE DIRECTORY, not the whole tree.
 *
 * LAZY BY DIRECTORY, because a recursive walk of an unknown project is
 * unbounded and the person only ever looks at one branch. Directories first,
 * then files, each alphabetical — the order every file tree has used for
 * thirty years, and the one a hand goes to without looking.
 */
function tree(app, rel = '') {
  const at = locate(app, rel || '.');
  if (!at.ok) return at;
  let entries;
  try {
    entries = fs.readdirSync(at.abs, { withFileTypes: true });
  } catch (e) {
    return { ok: false, why: `cannot read ${at.rel}: ${(e && e.message) || e}` };
  }
  const changed = new Set(changedPaths(app));
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.gitignore' && e.name !== '.editorconfig') continue;
    const childRel = at.rel === '.' ? e.name : `${at.rel}/${e.name}`;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      dirs.push({ name: e.name, path: childRel, dir: true });
    } else if (e.isFile()) {
      let size = 0;
      try { size = fs.statSync(path.join(at.abs, e.name)).size; } catch { size = 0; }
      files.push({
        name: e.name,
        path: childRel,
        dir: false,
        text: isText(e.name),
        size,
        // CHANGED BY THIS SESSION, from the checkpoint ledger — the same source
        // the CLI's Changes pane reads, never a second idea of what is dirty.
        changed: changed.has(childRel),
      });
    }
    if (dirs.length + files.length >= MAX_ENTRIES) break;
  }
  const by = (a, b) => a.name.localeCompare(b.name);
  return { ok: true, path: at.rel, entries: [...dirs.sort(by), ...files.sort(by)] };
}

/** Files this session has changed, as project-relative paths. */
function changedPaths(app) {
  try {
    return require('../ui/panes')
      .changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd })
      .map((f) => f.rel);
  } catch { return []; }
}

/**
 * OPEN A FILE.
 *
 * `mtimeMs` and `size` come back with the body and are the SAVE TOKEN — see
 * the header. They are the file's identity at the moment it was read, and a
 * save that cannot present them is a save from a buffer that may be stale.
 */
function open(app, rel) {
  const at = locate(app, rel);
  if (!at.ok) return at;
  let st;
  try { st = fs.statSync(at.abs); } catch (e) {
    return { ok: false, why: `cannot open ${at.rel}: ${(e && e.message) || e}` };
  }
  if (!st.isFile()) return { ok: false, why: `${at.rel} is not a file` };
  if (st.size > MAX_FILE_BYTES) {
    return { ok: false, why: `${at.rel} is ${(st.size / 1048576).toFixed(1)}MB — too large to edit here` };
  }
  let body;
  try { body = fs.readFileSync(at.abs, 'utf8'); } catch (e) {
    return { ok: false, why: `cannot read ${at.rel}: ${(e && e.message) || e}` };
  }
  // A NUL BYTE MEANS BINARY, whatever the extension said. Rendering it into a
  // textarea produces garbage the person may then save back over the original.
  if (body.includes('\0')) return { ok: false, why: `${at.rel} is a binary file` };

  return {
    ok: true,
    path: at.rel,
    body,
    language: language(at.rel),
    // THE SAVE TOKEN. `mtimeMs` is still carried for display and for cheap
    // change detection, but the DECISION is made on `hash` — see `digest`.
    hash: digest(body),
    mtimeMs: st.mtimeMs,
    size: st.size,
    lines: body.split('\n').length,
    changed: changedPaths(app).includes(at.rel),
  };
}

/**
 * SAVE, IF THE FILE IS STILL THE ONE THAT WAS OPENED.
 *
 * THREE REFUSALS, and each is a way a person loses work that they would not
 * find out about until much later:
 *
 *   STALE       the bytes on disk changed since the open. Almost always LAIN,
 *               because that is the product working as intended. Refused with
 *               the current body so the caller can show both.
 *   TRUNCATION  the same guard a model write goes through (tools/fs.js). A
 *               save that keeps under half of a file over 2KB is a collapse
 *               far more often than it is an edit.
 *   OUTSIDE     not this project's business at all.
 */
function save(app, rel, body, { hash = null, mtimeMs = null, force = false } = {}) {
  const at = locate(app, rel);
  if (!at.ok) return at;
  const text = String(body == null ? '' : body);

  let st = null;
  try { st = fs.statSync(at.abs); } catch { st = null; }

  if (st && hash && !force) {
    let current = '';
    try { current = fs.readFileSync(at.abs, 'utf8'); } catch { current = ''; }
    if (digest(current) !== String(hash)) {
      return {
        ok: false,
        stale: true,
        why: `${at.rel} changed on disk since you opened it`,
        current,
        hash: digest(current),
        mtimeMs: st.mtimeMs,
      };
    }
  }

  if (st && !force) {
    // THE SAME FUNCTION A MODEL WRITE GOES THROUGH, called the way it is
    // actually shaped: `(abs, content)` in, `{was, now}` or null out. It does
    // its own `statSync`, so a new file and a small file are already handled
    // there rather than re-decided here.
    const risk = fstools.truncationRisk(at.abs, text);
    if (risk) {
      return {
        ok: false,
        truncation: true,
        why: `this save keeps ${Math.round((risk.now / risk.was) * 100)}% of ${at.rel} — save again to confirm`,
        was: risk.was,
        now: risk.now,
      };
    }
  }

  try {
    fs.mkdirSync(path.dirname(at.abs), { recursive: true });
    fs.writeFileSync(at.abs, text, 'utf8');
  } catch (e) {
    return { ok: false, why: `cannot write ${at.rel}: ${(e && e.message) || e}` };
  }
  const after = fs.statSync(at.abs);
  return { ok: true, path: at.rel, hash: digest(text), mtimeMs: after.mtimeMs, size: after.size, bytes: after.size };
}

/**
 * HAS ANYTHING THE EDITOR HOLDS MOVED UNDER IT?
 *
 * Polled with the rest of the state. Cheap — one `stat` per open tab — and it
 * is what turns "LAIN edited this file" into a thing the editor NOTICES rather
 * than something the person discovers when their save is refused.
 */
function freshness(app, open = []) {
  const out = [];
  for (const t of Array.isArray(open) ? open.slice(0, 24) : []) {
    const at = locate(app, t && t.path);
    if (!at.ok) { out.push({ path: t.path, gone: true }); continue; }
    try {
      const st = fs.statSync(at.abs);
      // SAME REASON AS `save`: a timestamp cannot tell two writes in one
      // millisecond apart, and "LAIN just edited this" is precisely that case.
      let current = '';
      try { current = fs.readFileSync(at.abs, 'utf8'); } catch { current = ''; }
      const h = digest(current);
      out.push({ path: at.rel, hash: h, mtimeMs: st.mtimeMs, size: st.size, changed: String(t.hash || '') !== h });
    } catch {
      out.push({ path: at.rel, gone: true });
    }
  }
  return out;
}

/**
 * QUICK OPEN — a bounded search by filename, not a full-text index.
 *
 * Deliberately NOT a second search implementation: for CONTENT there is
 * tools/search.js and the model uses it. This answers only "where is the file
 * called something like this", which is what a quick-open box is for.
 */
function find(app, query, { limit = 40 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { ok: true, matches: [] };
  const cwd = app.session.cwd || process.cwd();
  const matches = [];
  const walk = (dir, rel, depth) => {
    if (matches.length >= limit || depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (matches.length >= limit) return;
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile() && isText(e.name) && childRel.toLowerCase().includes(q)) {
        matches.push({ path: childRel, name: e.name });
      }
    }
  };
  walk(cwd, '', 0);
  // A NAME MATCH BEATS A DIRECTORY MATCH. Typing "state" should offer
  // `state.js` before `src/state/helpers.js`, which is what a person means.
  matches.sort((a, b) => {
    const an = a.name.toLowerCase().includes(q) ? 0 : 1;
    const bn = b.name.toLowerCase().includes(q) ? 0 : 1;
    return an - bn || a.path.length - b.path.length;
  });
  return { ok: true, matches: matches.slice(0, limit) };
}

module.exports = {
  tree, open, save, find, freshness, digest, language, isText, inside, locate, changedPaths,
  MAX_FILE_BYTES, MAX_ENTRIES, SKIP_DIRS, TEXT_EXT,
};
