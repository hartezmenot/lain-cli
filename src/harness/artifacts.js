'use strict';

/**
 * THE ARTIFACT STORE — durable evidence, addressable after the conversation is
 * gone.
 *
 * ------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO END.
 *
 * LAIN already produced evidence: a test run's output, a diagnostic on a write,
 * a screenshot, a diff. All of it went into the TRANSCRIPT — and the transcript
 * is the one place in this program that is deliberately lossy. Compaction stubs
 * a result over 400 characters with its first line and "Re-run the call if you
 * need it" (session.js), which is exactly right for a context window and
 * exactly wrong for a receipt. So the proof that a suite passed was routinely
 * the first thing thrown away, and the only way to answer "what actually
 * happened?" an hour later was to do the work again.
 *
 * An artifact is the other half: written to disk, named, indexed, and never
 * compacted. The transcript keeps what the MODEL needs to think; this keeps
 * what a PERSON needs to check.
 *
 * ------------------------------------------------------------------------
 * WHERE IT LIVES, AND WHY THAT IS NOT DECIDED HERE.
 *
 * `<project>/.lain/tasks/<task-id>/`, and every path comes from lainstore.js.
 * That file's first rule is that nothing outside it joins a path inside
 * `.lain/`, and an artifact store that quietly built its own filenames would be
 * the second authority that rule exists to prevent. This module decides WHAT is
 * worth keeping and in what shape; lainstore decides where the bytes sit.
 *
 * ------------------------------------------------------------------------
 * IT NEVER THROWS, AND IT NEVER FAILS A TASK.
 *
 * A read-only checkout, a full disk, a directory somebody chmod'd — every one
 * of those is a STATE, reported in the return value, and none of them may take
 * down the work that was producing the evidence. `put` returns null and says
 * why in `lastError`. A harness whose evidence store can crash a task is worse
 * than one with no evidence store, because it fails at exactly the moment
 * something interesting was happening.
 */

const fs = require('fs');
const path = require('path');
const lainstore = require('../lainstore');

/** How much of one artifact body is kept. Enough to diagnose; never unbounded. */
const MAX_BODY = 2 * 1024 * 1024;

/**
 * How many events one read of a task's durable log exposes.
 *
 * MUCH LARGER THAN THE BUS's 200. The bus is a live channel for a window that
 * connected late; this is the flight recorder, and the whole value of a flight
 * recorder is that it still has the beginning of the flight. It is bounded all
 * the same, because an unbounded log on disk is a disk that fills.
 */
const MAX_EVENTS = 5000;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_TASK_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 256;

/**
 * How many task directories a project keeps. Generous — this is a receipt
 * drawer, not a cache — but not unbounded. See `prune`.
 */
const MAX_TASKS = 200;

/**
 * The states in which a task will not change again.
 *
 * DUPLICATED FROM state.js DELIBERATELY, and it is the one duplication in this
 * file. Requiring `./state` here would make the artifact store depend on the
 * task vocabulary in order to delete a directory, and `prune` reads records
 * that were written by an older version of this program — where an unknown
 * state must mean "leave it alone", which is exactly what a set-membership test
 * against a literal list gives.
 */
const TERMINAL_STATES = new Set(['PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED']);

/** Artifact kinds. A closed list, so every surface can draw them consistently. */
const KIND = Object.freeze({
  LOG: 'log',
  TEST: 'test',
  DIFF: 'diff',
  SCREENSHOT: 'screenshot',
  OBSERVATION: 'observation',
  VERIFICATION: 'verification',
  REPORT: 'report',
  BROWSER: 'browser',
});

/** Which directory a kind lands in. See lainstore.AREAS — that list is closed. */
const AREA_OF = Object.freeze({
  [KIND.LOG]: 'logs',
  [KIND.TEST]: 'tests',
  [KIND.DIFF]: 'diff',
  [KIND.SCREENSHOT]: 'screenshots',
  [KIND.OBSERVATION]: 'observations',
  [KIND.VERIFICATION]: 'verification',
  [KIND.REPORT]: 'reports',
  [KIND.BROWSER]: 'browser',
});

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

class ArtifactStore {
  /** @param {string} root the project directory whose `.lain/` this is. */
  constructor(root) {
    this.root = String(root || process.cwd());
    /** The last reason a write did not land. Reported, never thrown. */
    this.lastError = null;
    this._seq = 0;
  }

  dirFor(taskId) { return lainstore.taskDir(this.root, taskId); }

  /**
   * KEEP SOMETHING. Returns the artifact record, or null if it could not land.
   *
   * `body` may be a string or a Buffer — a screenshot is bytes and a test log is
   * text, and forcing one through the other's encoding is how a PNG becomes
   * 40KB of replacement characters.
   */
  put(taskId, { kind, name, body, note = '' } = {}) {
    const k = String(kind || KIND.LOG);
    const area = AREA_OF[k];
    if (!area) { this.lastError = `unknown artifact kind "${k}"`; return null; }
    this._seq += 1;
    const id = `a${this._seq}-${stamp()}`;
    const file = lainstore.taskFile(this.root, taskId, area, `${id}-${String(name || 'artifact')}`);
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
    if (Buffer.isBuffer(body) && bytes.length > MAX_BODY) {
      this.lastError = 'binary artifact exceeds capacity and cannot be kept intact';
      return null;
    }
    const kept = bytes.length > MAX_BODY ? bytes.subarray(0, MAX_BODY) : bytes;
    const existing = this.index(taskId);
    const used = existing.reduce((n, a) => { try { return n + fs.statSync(a.path).size; } catch { return n; } }, 0);
    if (existing.length >= MAX_ARTIFACTS || used + kept.length > MAX_TASK_BYTES) {
      this.lastError = 'task artifact capacity reached; existing evidence was preserved';
      return null;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, kept);
    } catch (e) {
      this.lastError = String((e && e.message) || e);
      return null;
    }
    const rec = {
      id,
      taskId: String(taskId),
      kind: k,
      name: String(name || 'artifact'),
      note: String(note || '').slice(0, 400),
      path: file,
      bytes: kept.length,
      truncated: kept.length < bytes.length,
      at: Date.now(),
    };
    if (!this._appendIndex(taskId, rec)) {
      try { fs.unlinkSync(file); } catch (e) { this.lastError += `; artifact rollback failed: ${e.message}`; }
      return null;
    }
    return rec;
  }

  /** Everything kept for one task, newest last. */
  index(taskId) {
    const file = path.join(this.dirFor(taskId), 'artifacts.json');
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(doc)) return [];
      const root = fs.realpathSync(this.dirFor(taskId));
      return doc.filter((a) => {
        if (!a || a.taskId !== String(taskId) || typeof a.path !== 'string') return false;
        try {
          const relative = path.relative(root, fs.realpathSync(a.path));
          return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative) && fs.statSync(a.path).isFile();
        } catch { return false; }
      });
    } catch { return []; }
  }

  _appendIndex(taskId, rec) {
    const file = path.join(this.dirFor(taskId), 'artifacts.json');
    const all = this.index(taskId);
    all.push(rec);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      this.lastError = String((e && e.message) || e);
      try { fs.unlinkSync(`${file}.tmp`); } catch { /* no temporary index to remove */ }
      return false;
    }
  }

  /** The bytes of one artifact, or null. */
  bytes(taskId, artifactId) {
    const rec = this.index(taskId).find((a) => a.id === artifactId);
    if (!rec) return null;
    try { return fs.readFileSync(rec.path); } catch { return null; }
  }

  // ------------------------------------------------------------- the record --

  /**
   * THE TASK RECORD ITSELF — written on every state change.
   *
   * Written whole and atomically, not appended to, because it is a snapshot of
   * a small object rather than a history. The history is `events.jsonl`, right
   * below, and the two answer different questions: this one is "what is true
   * now", that one is "how did it get here".
   */
  saveTask(task) {
    const file = path.join(this.dirFor(task.id), 'task.json');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(task.toJSON ? task.toJSON() : task, null, 2));
      fs.renameSync(tmp, file);
      return true;
    } catch (e) { this.lastError = String((e && e.message) || e); return false; }
  }

  loadTask(taskId) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dirFor(taskId), 'task.json'), 'utf8'));
    } catch { return null; }
  }

  /** Every task this project has a directory for, newest first by mtime. */
  listTasks() {
    const dir = lainstore.tasksRoot(this.root);
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
    const out = [];
    for (const n of names) {
      const rec = this.loadTask(n);
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /**
   * KEEP THE LAST `keep` TASKS, AND NO MORE.
   *
   * A task directory per request, forever, is a project that quietly grows a
   * `.lain/tasks/` with ten thousand entries in it — and the first person to
   * notice will be somebody whose `git status` got slow. Bounded, like
   * everything else in this project.
   *
   * THE TWO RULES THAT MAKE AUTOMATIC DELETION DEFENSIBLE:
   *
   *   1. ONLY A TASK THAT REACHED A VERDICT is ever removed. Anything still
   *      RUNNING, BLOCKED or VERIFYING is left alone however old it looks — an
   *      unfinished task's evidence is the evidence somebody is about to want.
   *   2. ONLY BEYOND THE CAP, oldest first. The newest `keep` are untouchable,
   *      so nothing that happened recently can vanish.
   *
   * Ordered by directory mtime rather than by parsing every record, because
   * this runs when a task is created and must not cost a JSON parse per task in
   * the project's history. Only the candidates for deletion are read.
   */
  prune(keep = MAX_TASKS) {
    const root = lainstore.tasksRoot(this.root);
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          let at = 0;
          try { at = fs.statSync(path.join(root, e.name)).mtimeMs; } catch { at = 0; }
          return { name: e.name, at };
        })
        .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
    } catch { return []; }
    const n = Math.max(1, Number(keep) || MAX_TASKS);
    if (dirs.length <= n) return [];
    const removed = [];
    for (const d of dirs.slice(n)) {
      const rec = this.loadTask(d.name);
      // An unreadable record may still belong to active work. Only a known
      // terminal state is enough evidence to authorize pruning.
      if (!rec || !TERMINAL_STATES.has(rec.state)) continue;
      try { fs.rmSync(path.join(root, d.name), { recursive: true, force: true }); removed.push(d.name); } catch { /* leave it */ }
    }
    return removed;
  }

  // -------------------------------------------------------- the flight log --

  /**
   * ONE LINE PER EVENT, APPENDED.
   *
   * JSON lines rather than a JSON array on purpose: an append is one `write`
   * with no read-modify-write window, so two processes writing the same task's
   * log interleave lines instead of losing each other's. A crash mid-write
   * costs the last line, not the file.
   */
  appendEvent(taskId, ev) {
    const file = path.join(this.dirFor(taskId), 'events.jsonl');
    try {
      const line = `${JSON.stringify(ev)}\n`;
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* first event */ }
      if (size + Buffer.byteLength(line) > MAX_EVENT_BYTES) {
        this.lastError = 'task event capacity reached; earlier evidence was preserved';
        return false;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line);
      return true;
    } catch (e) { this.lastError = String((e && e.message) || e); return false; }
  }

  /** The durable event log, oldest first, bounded on read rather than on write. */
  events(taskId, limit = MAX_EVENTS) {
    const file = path.join(this.dirFor(taskId), 'events.jsonl');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const lines = text.split('\n').filter(Boolean);
    const n = Math.max(0, Math.min(Number(limit) || MAX_EVENTS, MAX_EVENTS));
    const out = [];
    for (const l of lines.slice(-n)) {
      // A HALF-WRITTEN LAST LINE IS SKIPPED, NOT AN ERROR. A crash during an
      // append is the ordinary way this file ends, and refusing to read the
      // whole log because of it would lose the evidence at exactly the moment
      // somebody wanted it most.
      try { out.push(JSON.parse(l)); } catch { /* torn line */ }
    }
    return out;
  }
}

module.exports = { ArtifactStore, KIND, AREA_OF, MAX_BODY, MAX_EVENTS, MAX_TASKS, TERMINAL_STATES, MAX_TASK_BYTES, MAX_EVENT_BYTES, MAX_ARTIFACTS };
