'use strict';

/**
 * CHECKPOINTS — a state you can get back to, not an archive you hope is right.
 *
 * `/undo` already reverses the last edits from the byte snapshots taken before
 * each mutating call (checkpoint.js). That is the right tool for "that change
 * was wrong". It is the wrong tool for "this whole afternoon went sideways,
 * put me back to the last time everything worked", because it walks backward
 * one edit at a time and has no idea which of those points was GOOD.
 *
 * So a checkpoint is a copy of the tree plus THE EVIDENCE THAT IT WORKED:
 *
 *     when it was taken
 *     why it was taken, in the words of whoever took it
 *     what the test suite said AT THAT MOMENT
 *     the config hash and the V1 head, so the surroundings are on the record
 *
 * WHAT MAKES ONE "STABLE". Only a recorded, passing suite. Not "it looked
 * fine", not "the last thing I did was small". A checkpoint whose tests failed
 * — or was never tested — is kept and listed, because it is still somewhere to
 * return to, but it is never labelled stable. A list where everything says
 * stable is a list that tells you nothing.
 *
 * RESTORING IS ALWAYS EXPLICIT. Nothing here restores automatically, on a
 * failure, on a crash, or on a heuristic. `/backup restore <n>` and nothing
 * else, and it takes a checkpoint of the CURRENT state first — restoring is
 * itself a change, and it must be as reversible as anything else.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');

/** Directories never worth copying, and ruinous to copy. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '__pycache__', '.venv', 'venv']);
/** Refuse rather than spend minutes copying something enormous by surprise. */
const MAX_BYTES = 80 * 1024 * 1024;
const MAX_FILES = 5000;

function root() {
  return path.join(config.configDir(), 'backups');
}

function indexFile() {
  return path.join(root(), 'index.json');
}

/** Every checkpoint, newest first. Missing or unreadable reads as none. */
function list() {
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    const rows = Array.isArray(j) ? j : [];
    return rows.filter((r) => r && r.id).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  } catch { return []; }
}

function save(rows) {
  fs.mkdirSync(root(), { recursive: true });
  const f = indexFile();
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(rows, null, 2), 'utf8');
  fs.renameSync(`${f}.tmp`, f);
}

/** Walk a tree, refusing early if it is too large to copy sensibly. */
function survey(dir) {
  let bytes = 0;
  let files = 0;
  const out = [];
  const walk = (d, rel) => {
    if (bytes > MAX_BYTES || files > MAX_FILES) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(abs, r); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      bytes += st.size;
      files += 1;
      if (bytes > MAX_BYTES || files > MAX_FILES) return;
      out.push({ abs, rel: r });
    }
  };
  walk(dir, '');
  return { files: out, bytes, tooBig: bytes > MAX_BYTES || files > MAX_FILES };
}

/** The surroundings, recorded so a checkpoint says what world it came from. */
function surroundings() {
  const out = { config: null, v1: null };
  try {
    out.config = crypto.createHash('md5').update(fs.readFileSync(config.configFile())).digest('hex');
  } catch { out.config = null; }
  try {
    const { execFileSync } = require('child_process');
    out.v1 = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: path.join(require('os').homedir(), 'Documents', 'lain'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { out.v1 = null; }
  return out;
}

/**
 * Take a checkpoint of `cwd`.
 *
 * `tests` is `{ passed, failed }` when a suite has actually been run for this
 * state, and null when one has not. Only the first kind can be stable, and
 * `stable` is DERIVED here rather than accepted from the caller — otherwise
 * "stable" means whatever the last person to call this felt like.
 */
function create(cwd, { label = '', reason = '', tests = null } = {}) {
  const seen = survey(cwd);
  if (seen.tooBig) {
    return {
      ok: false,
      why: `${path.basename(cwd)} is larger than a checkpoint should copy `
        + `(> ${Math.round(MAX_BYTES / 1024 / 1024)}MB or ${MAX_FILES} files). Nothing was written.`,
    };
  }
  const at = new Date();
  const id = `${at.toISOString().replace(/[-:T]/g, '').slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`;
  const dest = path.join(root(), id);
  for (const f of seen.files) {
    const to = path.join(dest, f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f.abs, to);
  }
  const stable = Boolean(tests && tests.failed === 0 && tests.passed > 0);
  const row = {
    id,
    at: at.toISOString(),
    cwd,
    label: String(label || '').slice(0, 80),
    reason: String(reason || '').slice(0, 200),
    tests: tests ? { passed: tests.passed, failed: tests.failed } : null,
    stable,
    files: seen.files.length,
    bytes: seen.bytes,
    ...surroundings(),
  };
  save([row, ...list()]);
  return { ok: true, row, dest };
}

/**
 * Put `cwd` back to a checkpoint.
 *
 * Files the checkpoint has are overwritten; files it does NOT have are left
 * alone rather than deleted. Deleting is the one thing a restore could do that
 * cannot be taken back by another restore, and a checkpoint that predates a
 * whole new directory should not silently remove it. What was not restored is
 * reported, so the difference is visible instead of assumed.
 */
function restore(cwd, id) {
  const row = list().find((r) => r.id === id);
  if (!row) return { ok: false, why: `no checkpoint "${id}"` };
  const from = path.join(root(), id);
  if (!fs.existsSync(from)) return { ok: false, why: `checkpoint ${id} has no stored files` };

  // A restore is a change, so it is itself checkpointed first.
  const safety = create(cwd, { label: 'before restore', reason: `restoring ${id}`, tests: null });

  let written = 0;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(abs, r); continue; }
      const to = path.join(cwd, r);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(abs, to);
      written += 1;
    }
  };
  walk(from, '');

  const now = survey(cwd);
  const restoredRels = new Set();
  const collect = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) collect(path.join(d, e.name), r);
      else restoredRels.add(r);
    }
  };
  collect(from, '');
  const extra = now.files.filter((f) => !restoredRels.has(f.rel)).map((f) => f.rel);

  return { ok: true, row, written, extra, safety: safety.ok ? safety.row : null };
}

module.exports = { list, create, restore, root, SKIP, MAX_BYTES, MAX_FILES };
