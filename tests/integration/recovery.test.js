'use strict';

/**
 * RECOVERY ACROSS A RESUME.
 *
 * Snapshots were written to disk on every mutating call and nothing ever read
 * one back. So `/undo` and `/changes` after `/resume` reported "nothing to
 * undo" and "no changes" while the exact bytes needed to perform the undo sat
 * in the config home. The write half worked; the feature did not.
 *
 * The opposing invariant is just as important and is asserted here too: undo
 * must NEVER cross a session boundary. That is preserved by construction — the
 * snapshot directory is keyed by session id — and this proves it rather than
 * trusting it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const { Checkpoints } = require('../../src/checkpoint');

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-recover-'));
  const prev = process.env.LAIN_CONFIG_DIR;
  process.env.LAIN_CONFIG_DIR = dir;
  return { dir, restore: () => { if (prev === undefined) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = prev; } };
}

function work() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-work-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'original\n');
  return { dir, file };
}

module.exports = async function () {
  await test('RECOVERY: a resumed session can undo its OWN earlier work', () => {
    const h = home();
    const w = work();
    try {
      // Session one edits a file, then the process ends.
      const first = new Checkpoints('sess-A', w.dir);
      first.capture('t1', [w.file]);
      fs.writeFileSync(w.file, 'edited\n');

      // A fresh process resumes the SAME session.
      const resumed = new Checkpoints('sess-A', w.dir, { load: true });
      assert.strictEqual(resumed.entries.length, 1, 'the snapshot was on disk the whole time');

      const r = resumed.undo();
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(fs.readFileSync(w.file, 'utf8'), 'original\n', 'the undo must actually restore bytes');
    } finally { h.restore(); fs.rmSync(w.dir, { recursive: true, force: true }); }
  });

  await test('RECOVERY: /changes after a resume sees the real diff', () => {
    const h = home();
    const w = work();
    try {
      const first = new Checkpoints('sess-B', w.dir);
      first.capture('t1', [w.file]);
      fs.writeFileSync(w.file, 'much longer content\n');

      const resumed = new Checkpoints('sess-B', w.dir, { load: true });
      const rows = resumed.diff(resumed.entries[0]);
      assert.strictEqual(rows[0].kind, 'modified');
      assert.strictEqual(rows[0].beforeBytes, 'original\n'.length);
      assert.strictEqual(rows[0].afterBytes, 'much longer content\n'.length);
    } finally { h.restore(); fs.rmSync(w.dir, { recursive: true, force: true }); }
  });

  await test('RECOVERY: undo NEVER crosses a session boundary', () => {
    const h = home();
    const w = work();
    try {
      const a = new Checkpoints('sess-C', w.dir);
      a.capture('t1', [w.file]);
      fs.writeFileSync(w.file, 'edited by C\n');

      // A DIFFERENT session, loading with the same flag, must find nothing.
      const b = new Checkpoints('sess-D', w.dir, { load: true });
      assert.strictEqual(b.entries.length, 0, 'one session must never see another session\'s snapshots');
      assert.strictEqual(b.undo().ok, false);
      assert.strictEqual(fs.readFileSync(w.file, 'utf8'), 'edited by C\n', 'and it must certainly not revert it');
    } finally { h.restore(); fs.rmSync(w.dir, { recursive: true, force: true }); }
  });

  await test('RECOVERY: a NEW session loads nothing, even with snapshots on disk', () => {
    const h = home();
    const w = work();
    try {
      const a = new Checkpoints('sess-E', w.dir);
      a.capture('t1', [w.file]);
      // Same id, but not a resume: nothing is loaded, because a new session has
      // no history of its own to restore.
      const fresh = new Checkpoints('sess-E', w.dir);
      assert.strictEqual(fresh.entries.length, 0);
    } finally { h.restore(); fs.rmSync(w.dir, { recursive: true, force: true }); }
  });

  await test('RECOVERY: entries load in NUMERIC order, so undo pops the latest', () => {
    const h = home();
    const w = work();
    try {
      const a = new Checkpoints('sess-F', w.dir);
      // Past ten, lexicographic ordering would put c10 before c2 and undo would
      // restore the wrong bytes — a corruption, not a cosmetic bug.
      for (let i = 0; i < 12; i++) {
        fs.writeFileSync(w.file, `version ${i}\n`);
        a.capture(`t${i}`, [w.file]);
      }
      const resumed = new Checkpoints('sess-F', w.dir, { load: true });
      assert.deepStrictEqual(
        resumed.entries.map((e) => e.id),
        Array.from({ length: 12 }, (_, i) => `c${i + 1}`)
      );
      fs.writeFileSync(w.file, 'final\n');
      resumed.undo();
      assert.strictEqual(fs.readFileSync(w.file, 'utf8'), 'version 11\n', 'the LATEST snapshot must be the one restored');
    } finally { h.restore(); fs.rmSync(w.dir, { recursive: true, force: true }); }
  });

  await test('RECOVERY: a new capture after loading does not collide with a loaded id', () => {
    const h = home();
    const w = work();
    try {
      const a = new Checkpoints('sess-G', w.dir);
      a.capture('t1', [w.file]);
      a.capture('t2', [w.file]);
      const resumed = new Checkpoints('sess-G', w.dir, { load: true });
      const next = resumed.capture('t3', [w.file]);
      assert.strictEqual(next.id, 'c3', 'a count-based id would silently overwrite a real snapshot');
    } finally { h.restore(); fs.rmSync(w.dir, { recursive: true, force: true }); }
  });

  await test('RECOVERY: an undone checkpoint does not come back on the next resume', () => {
    const h = home();
    const w = work();
    try {
      const a = new Checkpoints('sess-H', w.dir);
      a.capture('t1', [w.file]);
      fs.writeFileSync(w.file, 'edited\n');
      a.undo();
      assert.strictEqual(fs.readFileSync(w.file, 'utf8'), 'original\n');

      // Deliberate later change. If the spent snapshot reloaded, a second undo
      // would stamp stale bytes over it.
      fs.writeFileSync(w.file, 'deliberate later change\n');
      const resumed = new Checkpoints('sess-H', w.dir, { load: true });
      assert.strictEqual(resumed.entries.length, 0, 'a spent snapshot must be gone from disk too');
      assert.strictEqual(fs.readFileSync(w.file, 'utf8'), 'deliberate later change\n');
    } finally { h.restore(); fs.rmSync(w.dir, { recursive: true, force: true }); }
  });

  await test('RECOVERY: undo REFUSES when the file changed after LAIN wrote it', () => {
    const h = home();
    const w = work();
    try {
      const a = new Checkpoints('sess-J', w.dir);
      const entry = a.capture('t1', [w.file]);
      fs.writeFileSync(w.file, 'written by LAIN\n');
      a.settle(entry);

      // Somebody else — another session, an editor, a git checkout — writes it.
      fs.writeFileSync(w.file, 'written by someone else\n');

      const r = a.undo();
      assert.strictEqual(r.ok, false, 'restoring pre-edit bytes here would discard the newer change');
      assert.strictEqual(r.stale, true);
      assert.match(r.error, /changed after LAIN last wrote to it/);
      assert.strictEqual(fs.readFileSync(w.file, 'utf8'), 'written by someone else\n', 'nothing may be touched');
      assert.strictEqual(a.entries.length, 1, 'the checkpoint is kept so the user can still decide');
    } finally { h.restore(); fs.rmSync(w.dir, { recursive: true, force: true }); }
  });

  await test('RECOVERY: undo proceeds when the file is exactly as LAIN left it', () => {
    const h = home();
    const w = work();
    try {
      const a = new Checkpoints('sess-K', w.dir);
      const entry = a.capture('t1', [w.file]);
      fs.writeFileSync(w.file, 'written by LAIN\n');
      a.settle(entry);

      // The ordinary case, and the one that must not be broken by the guard.
      const reloaded = new Checkpoints('sess-K', w.dir, { load: true });
      const r = reloaded.undo();
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(fs.readFileSync(w.file, 'utf8'), 'original\n');
    } finally { h.restore(); fs.rmSync(w.dir, { recursive: true, force: true }); }
  });

  await test('RECOVERY: undoing a CREATION removes the file, across a resume', () => {
    const h = home();
    const w = work();
    try {
      const made = path.join(w.dir, 'new.txt');
      const a = new Checkpoints('sess-I', w.dir);
      a.capture('t1', [made]);          // captured while ABSENT
      fs.writeFileSync(made, 'created\n');

      const resumed = new Checkpoints('sess-I', w.dir, { load: true });
      resumed.undo();
      assert.strictEqual(fs.existsSync(made), false, 'undoing a creation deletes it again');
    } finally { h.restore(); fs.rmSync(w.dir, { recursive: true, force: true }); }
  });
};
