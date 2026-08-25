'use strict';

/**
 * REVERSIBILITY. LAIN's changes must be recoverable without depending on the
 * model remembering what it did.
 *
 * ONE mechanism, not the two overlapping byte-snapshot systems V1 grew
 * (`diffguard` + `checkpoint`, whose own header admitted the overlap).
 *
 * The contract: before a mutating tool touches a path, its PRIOR bytes are
 * captured. Nothing is prevented, nothing is gated, nothing asks permission —
 * the model edits freely and LAIN keeps the way back. A file that did not exist
 * is recorded as absent, so undoing a creation deletes it again.
 *
 * Checkpoints are session-scoped and live under the config home, never in the
 * user's project.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * What the file looked like when LAIN finished with it.
 *
 * A checkpoint holds the bytes from BEFORE an edit. Restoring them is only safe
 * if the file still says what LAIN left it saying — otherwise something else
 * has changed it since, and "undo" would silently destroy that newer work while
 * reporting success.
 *
 * This is not hypothetical. Session A edits a file; session B edits it again;
 * B resumes A and undoes. A's snapshot predates B's edit entirely, so restoring
 * it reverts BOTH — and the user asked to undo one thing.
 *
 * So each file records a fingerprint of its post-edit state, and undo compares
 * before touching anything.
 */
function digest(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

/** The fingerprint of a path right now, or null when it does not exist. */
function digestOf(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return digest(fs.readFileSync(p));
  } catch { return null; }
}

class Checkpoints {
  /**
   * @param {string}  sessionId
   * @param {string}  cwd
   * @param {object}  opts  load: read this session's checkpoints back off disk
   */
  constructor(sessionId, cwd, { load = false } = {}) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.entries = []; // [{ id, turnId, at, files: [{ path, existed, bytes|null }] }]
    if (load) this.load();
  }

  dir() { return path.join(config.configDir(), 'checkpoints', this.sessionId); }

  /**
   * Read this session's checkpoints back.
   *
   * Every snapshot was already being written to disk, and nothing ever read one
   * — so `/undo` after `/resume` reported "nothing to undo" while the blobs
   * needed to perform it sat in the config home. The write half of the feature
   * worked; the feature did not.
   *
   * SESSION BOUNDARIES ARE PRESERVED BY CONSTRUCTION, not by a check: the
   * directory is keyed by session id, so this can only ever load the snapshots
   * belonging to the session being resumed. Undoing another session's work
   * remains impossible.
   *
   * Ordering is NUMERIC (`c2` before `c10`). Lexicographic sorting would make
   * `undo` pop the wrong entry the moment a session passed ten mutations, which
   * is a corruption, not a cosmetic bug.
   */
  load() {
    let names = [];
    try { names = fs.readdirSync(this.dir()); } catch { return this; }
    const ordered = names
      .map((n) => ({ n, seq: Number(/^c(\d+)$/.exec(n) ? /^c(\d+)$/.exec(n)[1] : NaN) }))
      .filter((x) => Number.isFinite(x.seq))
      .sort((a, b) => a.seq - b.seq);

    for (const { n } of ordered) {
      const d = path.join(this.dir(), n);
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')); } catch { continue; }
      if (!manifest || !Array.isArray(manifest.files)) continue;
      const files = [];
      for (const f of manifest.files) {
        let bytes = null;
        if (f.blob) {
          // A missing blob is not a reason to drop the whole entry: the other
          // files in it are still restorable, and `undo` already reports a file
          // it could not restore rather than pretending it did.
          try { bytes = fs.readFileSync(path.join(d, f.blob)); } catch { bytes = null; }
        }
        files.push({ path: f.path, existed: Boolean(f.existed), bytes, after: f.after || null });
      }
      if (files.length) this.entries.push({ id: manifest.id || n, turnId: manifest.turnId || null, at: manifest.at || null, files });
    }
    return this;
  }

  /** Capture prior bytes for the paths a mutating call is about to touch. */
  capture(turnId, absPaths) {
    const files = [];
    for (const abs of absPaths || []) {
      let existed = false;
      let bytes = null;
      try {
        const st = fs.statSync(abs);
        existed = st.isFile();
        if (existed && st.size <= MAX_FILE_BYTES) bytes = fs.readFileSync(abs);
      } catch { existed = false; }
      // `after` is filled in by settle() once the mutating call has run.
      files.push({ path: abs, existed, bytes, after: undefined });
    }
    if (!files.length) return null;
    // Derived from the HIGHEST id present, not from the count. With entries
    // loaded from disk a count-based id collides the moment one entry failed to
    // parse, and the collision silently overwrites a real snapshot.
    const nextSeq = this.entries.reduce((max, e) => {
      const m = /^c(\d+)$/.exec(e.id);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0) + 1;
    const entry = { id: `c${nextSeq}`, turnId, at: new Date().toISOString(), files };
    this.entries.push(entry);
    this._persist(entry);
    return entry;
  }

  /**
   * Record what each file looks like NOW — immediately after the mutating call
   * that this checkpoint was captured for.
   *
   * That fingerprint is what lets `undo` tell "the file is as I left it" from
   * "someone else has changed it since", which is the difference between
   * reverting one edit and quietly discarding somebody's work.
   */
  settle(entry) {
    if (!entry) return null;
    for (const f of entry.files) f.after = digestOf(f.path);
    this._persist(entry);
    return entry;
  }

  _persist(entry) {
    try {
      const d = path.join(this.dir(), entry.id);
      fs.mkdirSync(d, { recursive: true });
      const manifest = entry.files.map((f, i) => ({
        path: f.path, existed: f.existed, blob: f.bytes ? `${i}.blob` : null,
        after: f.after === undefined ? null : f.after,
      }));
      for (let i = 0; i < entry.files.length; i++) {
        if (entry.files[i].bytes) fs.writeFileSync(path.join(d, `${i}.blob`), entry.files[i].bytes);
      }
      fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: entry.id, turnId: entry.turnId, at: entry.at, files: manifest }, null, 2), 'utf8');
    } catch { /* a checkpoint that cannot be written must not break the edit */ }
  }

  /** What changed since a checkpoint, by comparing bytes on disk now. */
  diff(entry) {
    const rows = [];
    for (const f of entry.files) {
      let now = null;
      let exists = false;
      try { const st = fs.statSync(f.path); exists = st.isFile(); if (exists) now = fs.readFileSync(f.path); } catch { exists = false; }
      let kind;
      if (!f.existed && exists) kind = 'created';
      else if (f.existed && !exists) kind = 'deleted';
      else if (f.existed && exists && f.bytes && !f.bytes.equals(now)) kind = 'modified';
      else if (f.existed && exists) kind = 'unchanged';
      else kind = 'absent';
      rows.push({ path: f.path, kind, beforeBytes: f.bytes ? f.bytes.length : 0, afterBytes: now ? now.length : 0 });
    }
    return rows;
  }

  /**
   * Restore the most recent checkpoint. Returns what it did.
   *
   * REFUSES when a file no longer holds what LAIN left there. Undo reverts ONE
   * edit; if something else has written to the file since, restoring pre-edit
   * bytes would revert that too — destroying work while reporting success. The
   * checkpoint is kept, not discarded, so the user can look and decide.
   *
   * Entries captured before `after` fingerprints existed carry `null` and are
   * restored unconditionally, exactly as they were before.
   */
  undo() {
    const entry = this.entries[this.entries.length - 1];
    if (!entry) return { ok: false, error: 'nothing to undo' };

    const stale = entry.files.filter((f) => f.after != null && digestOf(f.path) !== f.after);
    if (stale.length) {
      const names = stale.map((f) => path.relative(this.cwd, f.path) || f.path);
      return {
        ok: false,
        stale: true,
        error: `${names.join(', ')} changed after LAIN last wrote to it. `
          + 'Undoing would discard that change too, so nothing was touched.',
      };
    }

    this.entries.pop();
    const restored = [];
    for (const f of entry.files) {
      try {
        if (!f.existed) {
          // It did not exist before: undoing a creation removes it.
          try { fs.rmSync(f.path, { force: true }); restored.push({ path: f.path, action: 'removed' }); } catch { /* already gone */ }
        } else if (f.bytes) {
          fs.mkdirSync(path.dirname(f.path), { recursive: true });
          fs.writeFileSync(f.path, f.bytes);
          restored.push({ path: f.path, action: 'restored' });
        } else {
          restored.push({ path: f.path, action: 'skipped (too large to snapshot)' });
        }
      } catch (e) {
        restored.push({ path: f.path, action: `failed: ${e.message}` });
      }
    }
    // Discard the snapshot on disk too, or a later resume would load it back and
    // offer to undo the same edit a second time — re-applying stale bytes over
    // whatever the file has become since.
    try { fs.rmSync(path.join(this.dir(), entry.id), { recursive: true, force: true }); } catch { /* already gone */ }
    return { ok: true, id: entry.id, restored };
  }

  list() {
    return this.entries.map((e) => ({ id: e.id, turnId: e.turnId, at: e.at, files: e.files.map((f) => f.path) }));
  }
}

module.exports = { Checkpoints, MAX_FILE_BYTES };
