'use strict';

/**
 * SCRATCH — where a turn keeps its working notes, and why it is not memory.
 *
 * ------------------------------------------------------------------------
 * TWO KINDS OF THING, AND CONFUSING THEM IS THE FAILURE.
 *
 *     SCRATCH      what THIS turn is finding out. Half-checked, superseded
 *                  every few minutes, worthless in a week. Deleted when the
 *                  turn completes.
 *
 *     MEMORY       what is durably true about the project. Survives every
 *                  restart, and is read by models that were not here.
 *
 * A system that promotes everything accumulates a memory full of half-truths
 * from abandoned attempts, and then answers confidently from them. A system
 * that promotes nothing rediscovers the same fact every session. So promotion
 * is a DELIBERATE ACT WITH EVIDENCE ATTACHED — `promote()` refuses a fact that
 * cannot say what established it.
 *
 * ------------------------------------------------------------------------
 * THE INTERRUPTION CASE, which is the whole reason scratch is on disk.
 *
 *     turn opens        scratch created
 *     workers run       findings written as they are found
 *     TURN DIES         rate limit, crash, the user hits Ctrl-C, a model
 *                       switch mid-task
 *     handover          READS THE SCRATCH THAT IS STILL THERE
 *     new model         continues from findings instead of from nothing
 *     turn completes    scratch removed
 *
 * If scratch were in memory it would die with the process that made it, and the
 * replacement model would start from the transcript — which is a record of what
 * the DEAD model believed, and is exactly what handover.js exists to avoid.
 *
 * So: it is deleted on COMPLETION, never on failure. An orphaned scratch
 * directory is not a leak, it is the evidence of an unfinished turn, and
 * `orphans()` is how the next session finds it.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT A TRANSCRIPT. Nothing here stores model prose, a conversation, or a
 * tool's raw output. A scratch entry is a short named finding — "the socket
 * listens on 127.0.0.1 only", "tests/unit/foo.test.js covers this" — and the
 * cap below is what stops it becoming a log.
 */

const fs = require('fs');
const path = require('path');

const lainstore = require('./lainstore');

/** One finding. Longer than this is a log line, not a finding. */
const MAX_TEXT = 1_000;

/** Findings kept per session. A turn that has 200 findings has a log. */
const MAX_NOTES = 200;

/** Promoted facts kept. Old ones fall off the end rather than growing forever. */
const MAX_FACTS = 400;

const MANIFEST = 'manifest.json';

function dirOf(root, sessionId) { return lainstore.scratchDir(root, sessionId); }

function manifestPath(root, sessionId) { return path.join(dirOf(root, sessionId), MANIFEST); }

function readManifest(root, sessionId) {
  try {
    const j = JSON.parse(fs.readFileSync(manifestPath(root, sessionId), 'utf8'));
    if (!j || typeof j !== 'object') return null;
    return { notes: [], ...j, notes: Array.isArray(j.notes) ? j.notes : [] };
  } catch {
    return null;
  }
}

function writeManifest(root, sessionId, m) {
  const file = manifestPath(root, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * OPEN A SCRATCH for this turn. Idempotent: reopening keeps what is there.
 *
 * IDEMPOTENT ON PURPOSE. A turn that resumes after an interruption calls this
 * again, and wiping the findings at that moment would destroy exactly the thing
 * the directory exists to preserve.
 */
function open(root, sessionId, { goal = '', turn = 0 } = {}) {
  const existing = readManifest(root, sessionId);
  const m = existing || { session: String(sessionId), openedAt: Date.now(), goal: '', turn: 0, notes: [] };
  if (goal) m.goal = String(goal).slice(0, 400);
  if (turn) m.turn = Number(turn) || 0;
  m.touchedAt = Date.now();
  const ok = writeManifest(root, sessionId, m);
  return { ok, dir: dirOf(root, sessionId), manifest: m, resumed: Boolean(existing) };
}

/**
 * RECORD A FINDING.
 *
 * `by` is which worker found it, and it is not decoration: at handover time the
 * difference between "the test runner said this" and "the model thought this"
 * decides whether the next model re-checks it.
 */
function note(root, sessionId, { text, by = '', kind = 'finding' } = {}) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'a note needs text' };
  const m = readManifest(root, sessionId) || open(root, sessionId).manifest;
  m.notes.push({
    text: t.slice(0, MAX_TEXT),
    by: String(by).slice(0, 60),
    kind: String(kind).slice(0, 30),
    at: Date.now(),
  });
  // OLDEST FIRST OUT. A turn that keeps finding things keeps the recent ones,
  // which are the ones a handover would carry.
  if (m.notes.length > MAX_NOTES) m.notes = m.notes.slice(-MAX_NOTES);
  m.touchedAt = Date.now();
  return { ok: writeManifest(root, sessionId, m), count: m.notes.length };
}

/** What this turn has found so far. */
function notes(root, sessionId) {
  const m = readManifest(root, sessionId);
  return m ? m.notes : [];
}

/** A path inside the scratch, for a worker that needs a real file. */
function file(root, sessionId, name) {
  const safe = String(name || 'file').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'file';
  const dir = dirOf(root, sessionId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* read-only project */ }
  return path.join(dir, safe);
}

// ---------------------------------------------------------------------------
// PROMOTION — the one door from scratch into memory
// ---------------------------------------------------------------------------

function facts(root) {
  const body = lainstore.read(root, 'memory', null);
  return body && Array.isArray(body.facts) ? body.facts : [];
}

/**
 * PROMOTE A FINDING TO A DURABLE FACT.
 *
 * REFUSES WITHOUT EVIDENCE, and this is the load-bearing rule. `.lain/memory`
 * is read by models that were not present and cannot re-derive where a claim
 * came from; a fact with no provenance there is indistinguishable from a
 * confident guess, and it will be believed.
 *
 * `evidence` is what ESTABLISHED it — a command that ran, a test that passed, a
 * file that was read — not an argument that it is probably true.
 */
function promote(root, sessionId, { text, evidence, by = 'lain' } = {}) {
  const t = String(text || '').trim();
  const e = String(evidence || '').trim();
  if (!t) return { ok: false, error: 'a fact needs text' };
  if (!e) {
    return {
      ok: false,
      error: 'a promoted fact must name the evidence that established it — '
        + 'a command that ran, a test that passed, a file that was read. '
        + 'Without provenance the next model cannot tell it from a guess.',
    };
  }
  const list = facts(root);
  const fact = {
    text: t.slice(0, MAX_TEXT),
    evidence: e.slice(0, MAX_TEXT),
    by: String(by).slice(0, 60),
    session: String(sessionId || ''),
    at: Date.now(),
  };
  // THE SAME FACT TWICE IS ONE FACT, refreshed. Otherwise a loop that promotes
  // on every pass fills memory with copies.
  const idx = list.findIndex((f) => f.text === fact.text);
  if (idx >= 0) list[idx] = fact; else list.push(fact);
  const kept = list.slice(-MAX_FACTS);
  return { ok: lainstore.write(root, 'memory', { facts: kept }), fact, count: kept.length };
}

/** Durable facts, newest last. What a briefing reads. */
function remembered(root, { max = 20 } = {}) {
  return facts(root).slice(-max);
}

// ---------------------------------------------------------------------------
// LIFECYCLE
// ---------------------------------------------------------------------------

/**
 * THE TURN FINISHED. Remove the scratch.
 *
 * ONLY ON COMPLETION. There is no `close on failure`, and that omission is the
 * design: a failed turn's findings are precisely what the next model needs.
 */
function close(root, sessionId) {
  const dir = dirOf(root, sessionId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    // LEAVE NO SCAFFOLDING. A turn that opened a scratch and completed having
    // noted nothing must leave the working tree exactly as it found it — a
    // `.lain/` directory appearing because a request was retried is a side
    // effect the user never asked for (and a smoke test asserts is absent).
    // The empty parents go only when they are empty: `.lain/` holding the
    // project's index or architecture is not scratch's to remove.
    for (const parent of [lainstore.scratchRoot(root), lainstore.dirFor(root)]) {
      try { fs.rmdirSync(parent); } catch { /* not empty, or already gone */ }
    }
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * SCRATCHES FROM TURNS THAT NEVER COMPLETED.
 *
 * The handover's input, and the only way an interrupted turn's findings reach
 * the model that replaces it. Ordered oldest first so a caller cleaning up
 * removes the stalest.
 */
function orphans(root, { exclude = '', olderThanMs = 0 } = {}) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(lainstore.scratchRoot(root), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  const now = Date.now();
  for (const name of names) {
    if (exclude && name === String(exclude).replace(/[^A-Za-z0-9_.-]/g, '_')) continue;
    const m = readManifest(root, name);
    if (!m) continue;
    const age = now - (Number(m.touchedAt) || Number(m.openedAt) || 0);
    if (olderThanMs && age < olderThanMs) continue;
    out.push({ session: name, goal: m.goal || '', notes: m.notes, openedAt: m.openedAt, touchedAt: m.touchedAt, age });
  }
  return out.sort((a, b) => (a.touchedAt || 0) - (b.touchedAt || 0));
}

/**
 * WHAT AN INTERRUPTED TURN LEFT, in the words a handover carries.
 *
 * Findings only, newest first, capped. A handover rides a request that is
 * trying to recover, and a recovery that costs more than the work it saves is
 * not one.
 */
function say(entry, { max = 8 } = {}) {
  if (!entry || !entry.notes || !entry.notes.length) return '';
  const rows = entry.notes.slice(-max).reverse()
    .map((n) => `  - ${n.text}${n.by ? `  [${n.by}]` : ''}`);
  const head = entry.goal
    ? `UNFINISHED WORK from session ${entry.session} — ${entry.goal}`
    : `UNFINISHED WORK from session ${entry.session}`;
  return [head, ...rows].join('\n');
}

module.exports = {
  MAX_TEXT, MAX_NOTES, MAX_FACTS,
  dirOf, open, note, notes, file,
  promote, remembered, facts,
  close, orphans, say,
};
