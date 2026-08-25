'use strict';

/**
 * THE EVIDENCE LEDGER — a cache, never a prison.
 *
 * It records that a file's EXACT CONTENT has already been put into the model's
 * context, keyed on `{path, size, mtime}`. If the file changed, the entry is
 * stale and the real read goes through. If anything edited it, the entry is
 * dropped outright.
 *
 * WHAT IT MAY SAY:  "this exact content was already inspected"
 * WHAT IT MAY NOT SAY:  "you are forbidden to read this"
 *
 * So the substitution is narrow on purpose, and all four conditions must hold:
 *   - the same file, unchanged since it was read (size AND mtime identical)
 *   - a WHOLE-FILE read; any offset/limit is a targeted read and is never touched
 *   - the file is large enough that re-injecting it actually costs something
 *   - it has genuinely been read before in this session
 *
 * A targeted read is always served, deliberately, so the escape hatch the note
 * describes is guaranteed to work. Lifetime is the SESSION, because a user
 * rephrasing their goal must not throw away what was already learned.
 */

const fs = require('fs');
const path = require('path');

/** Below this, re-reading is cheap and a steer would be worse than the tokens. */
const LARGE_FILE_LINES = 250;

const BODY_READS = new Set(['read_file']);
const MUTATORS = new Set(['write_file', 'edit_file']);

function stampFor(cwd, p) {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  try {
    const st = fs.statSync(abs);
    return { size: st.size, mtime: Math.floor(st.mtimeMs) };
  } catch {
    return null; // missing file: never guarded — the error IS the answer
  }
}

function isTargeted(input) {
  return Boolean(input && (input.offset != null || input.limit != null));
}

class EvidenceLedger {
  constructor(cwd = process.cwd(), owner = null) {
    this.cwd = cwd;
    /**
     * WHICH SESSION THIS LEDGER BELONGS TO.
     *
     * Only used to tell OUR writes from SOMEBODY ELSE'S in the cross-session
     * note (see `foreignWrite`). Null is a legitimate value — a ledger with no
     * owner simply never triggers the foreign-write check, which is the right
     * behaviour for a test rig or a one-shot run with nothing to conflict with.
     */
    this.owner = owner;
    this.byPath = new Map(); // norm abs path -> { stamp, lines, reads, firstSeenAt }
  }

  _key(p) {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.cwd, p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }

  record(p, stamp, { lines = 0 } = {}) {
    if (!p || !stamp) return;
    const key = this._key(p);
    const prev = this.byPath.get(key);
    if (prev && prev.stamp.size === stamp.size && prev.stamp.mtime === stamp.mtime) {
      prev.reads += 1;
      prev.bodyPresent = true;      // read again: the body is back in context
      return;
    }
    this.byPath.set(key, { stamp, lines, reads: 1, firstSeenAt: Date.now(), bodyPresent: true });
  }

  /**
   * THE BODY WENT; WHAT WE KNOW DID NOT.
   *
   * Two states that were previously one. An entry means "this session read this
   * whole file"; `bodyPresent` says whether the bytes are still in the
   * conversation. Compaction changes the second and nothing about the first.
   *
   * This is deliberately NOT `invalidate`. Deleting the entry would throw away
   * the fact that the file was read at all, its size, its line count and how
   * often it mattered — knowledge that survives perfectly well without the
   * bytes, and that `digest` reports so a later turn is not surprised by it.
   */
  elide(p) {
    if (!p) return;
    const e = this.byPath.get(this._key(p));
    if (e) e.bodyPresent = false;
  }

  lookup(p, stamp) {
    if (!p || !stamp) return null;
    const e = this.byPath.get(this._key(p));
    if (!e) return null;
    if (e.stamp.size !== stamp.size || e.stamp.mtime !== stamp.mtime) return null; // changed → stale
    return e;
  }

  invalidate(p) {
    if (!p) return;
    this.byPath.delete(this._key(p));
  }

  size() { return this.byPath.size; }

  /**
   * Called BEFORE a tool runs. Returns a substitute result, or null to let the
   * call through untouched. Null is the overwhelmingly common answer.
   */
  check(name, input) {
    if (!BODY_READS.has(name)) return null;
    const p = input && input.path;
    if (!p) return null;
    if (isTargeted(input)) return null;             // never guard a targeted read
    const stamp = stampFor(this.cwd, p);
    if (!stamp) return null;                        // missing file → let it error
    const e = this.lookup(p, stamp);
    if (!e) return null;                            // unseen or changed
    // THE BODY IS GONE, SO THE CLAIM IS GONE. Suppressing here is what trapped
    // the model between "you already read this" and a transcript that no longer
    // held it. Never block a read whose content compaction removed — see
    // `elide` and Session._forgetElided.
    if (!e.bodyPresent) return null;
    if (e.lines < LARGE_FILE_LINES) return null;    // small file: not worth a steer

    return {
      output:
        `[evidence] ${p} (${e.lines} lines) is unchanged since you read it earlier this session, `
        + `so re-reading it produces the same bytes. `
        + `If you need a specific part again, read a range: read_file {"path":"${p}","offset":<line>,"limit":<n>} — `
        + `ranged reads are always served. Otherwise continue from what you already have.`,
      fromEvidence: true,
    };
  }

  /** Called AFTER a tool ran. */
  observe(name, input, result) {
    const p = input && input.path;
    // EVERY SUCCESSFUL MUTATION IS NOTED ACROSS SESSIONS, not just invalidated
    // within this one. See `noteWrite` for the hole that closes.
    for (const abs of (result && result.mutated) || []) noteWrite(this.cwd, abs, this.owner);
    if (MUTATORS.has(name)) { if (p) this.invalidate(p); return; }
    for (const abs of (result && result.mutated) || []) this.invalidate(abs);
    if (!BODY_READS.has(name) || !p) return;
    if (result && result.isError) return;
    if (result && result.fromEvidence) return;      // don't re-record a substitution
    // A TARGETED read is not whole-file evidence. Recording one as such made the
    // ledger claim a 400-line file had been "inspected" after the model had seen
    // ten lines of it, and then suppress the real full read — the ledger lying,
    // and the exact prison it must never become. Only a whole-file read can
    // establish whole-file evidence.
    if (isTargeted(input)) return;
    const meta = (result && result.meta) || {};
    const stamp = meta.size != null && meta.mtimeMs != null
      ? { size: meta.size, mtime: meta.mtimeMs }
      : stampFor(this.cwd, p);
    if (!stamp) return;
    const lines = meta.lines != null ? meta.lines : String((result && result.output) || '').split('\n').length;
    this.record(p, stamp, { lines });
  }

  /** Persisted so `/resume` restores the session's evidence, not just its text.
   *  Entries stay keyed on size+mtime, so anything edited meanwhile is stale on
   *  arrival and re-read normally. */
  toJSON() {
    return [...this.byPath.entries()].map(([abs, e]) => ({ path: abs, ...e }));
  }

  static from(rows, cwd, owner = null) {
    // The owner travels with the rows. Without it a resumed session could
    // not recognise its OWN next write (`noteWrite` drops ownerless notes),
    // and `noInspection` would treat that write as blind.
    const l = new EvidenceLedger(cwd, owner);
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !r.path || !r.stamp) continue;
      l.byPath.set(r.path, {
        stamp: r.stamp, lines: r.lines || 0, reads: r.reads || 1, firstSeenAt: r.firstSeenAt || Date.now(),
        // A resumed session restores the LEDGER, not the elided bodies. An
        // older row that predates this field is treated as present, which is
        // what it meant when it was written.
        bodyPresent: r.bodyPresent !== false,
      });
    }
    return l;
  }

  /** Compact, credential-free summary for a resume brief. */
  digest(limit = 8) {
    const all = [...this.byPath.entries()]
      .sort((a, b) => b[1].reads - a[1].reads || b[1].firstSeenAt - a[1].firstSeenAt)
      .slice(0, limit);
    if (!all.length) return '';
    const label = ([abs, e]) => `  - ${path.basename(abs)} (${e.lines} lines${e.reads > 1 ? ` ×${e.reads}` : ''})`;
    const present = all.filter(([, e]) => e.bodyPresent !== false).map(label);
    // ---- WHAT WAS READ, AND IS NO LONGER IN FRONT OF YOU -------------------
    //
    // Reported rather than dropped. "I read that file earlier" stays true after
    // its body is elided, and a model that is told so can ask for the ONE piece
    // it wants instead of either re-reading everything or assuming it still has
    // it. Naming the cheap routes here is what makes this adaptation rather
    // than a refusal — the whole read is available too, and nothing forbids it.
    const gone = all.filter(([, e]) => e.bodyPresent === false).map(label);
    const parts = [];
    if (present.length) parts.push('Already inspected this session (unchanged since):\n' + present.join('\n'));
    if (gone.length) {
      parts.push('Read earlier, but the body has since been elided to fit the window — you no longer have it:\n'
        + gone.join('\n')
        + '\nFor these, check_symbols {list_symbols:true} gives the outline and read_symbol one definition; '
        + 'a ranged or whole read is still available if you actually need it.');
    }
    return parts.join('\n\n');
  }
}

/**
 * HAS THIS FILE CHANGED SINCE LAIN READ IT, AND WHO CHANGED IT?
 *
 * ------------------------------------------------------------------------
 * THE QUESTION A MUTATION MUST BE ABLE TO ASK, and could not.
 *
 * The ledger already holds `{size, mtime}` for every whole file this session
 * read, and it already invalidates that entry the moment LAIN itself writes the
 * file (see `observe`). So an entry that exists AND disagrees with the file on
 * disk means exactly one thing: something OTHER than this session changed it
 * after LAIN looked. Another LAIN session, an editor, a build step, a git
 * checkout.
 *
 * That fact was sitting in the ledger unread, and its absence is what turned a
 * concurrent edit into "the expected text is not in the file" — a message that
 * describes the symptom and names no cause, which is an invitation to guess.
 * A mutation system must not answer "probably whitespace".
 *
 * NO ENTRY MEANS NO CLAIM. A file this session never read whole is not stale;
 * it is simply unknown, and inventing a conflict for it would refuse the
 * ordinary act of creating or replacing a file nobody had looked at.
 *
 * @returns {{stale: boolean, was: object|null, now: object|null}}
 */
function staleness(ledger, cwd, p) {
  const none = { stale: false, was: null, now: null };
  if (!ledger || !p) return none;
  let entry = null;
  try { entry = ledger.byPath.get(ledger._key(p)); } catch { entry = null; }
  if (!entry) return none;
  const now = stampFor(cwd, p);
  if (!now) return none;                       // gone: the write is the answer
  const was = entry.stamp;
  if (was.size === now.size && was.mtime === now.mtime) return none;
  return { stale: true, was, now };
}

/** The ledger a tool context carries, or null. One place that knows where it lives. */
function ledgerOf(ctx) {
  return (ctx && ctx.session && ctx.session.evidence) || null;
}

/**
 * WHO WROTE WHAT, ACROSS EVERY SESSION IN THIS PROCESS.
 *
 * ------------------------------------------------------------------------
 * THE GAP THIS CLOSES, and it is the one `staleness` alone cannot.
 *
 * A ledger is per-SESSION, and a `/bg` job runs on a forked session. So when
 * two jobs work the same tree:
 *
 *   job A reads foo.js   -> A's ledger holds A's stamp
 *   job B writes foo.js  -> the FILE's stamp changes
 *   job A mutates foo.js -> A's stamp no longer matches: `staleness` CATCHES it
 *
 * That case was already safe. The one that was not is the mirror of it:
 *
 *   job B writes foo.js  -> nothing in A's ledger at all
 *   job A mutates foo.js -> no entry, so no claim, so no protection
 *
 * A has no evidence to be stale, which read as "nothing to check" when it
 * actually means "A is acting on a file it has never seen, that somebody else
 * is actively changing". That is the last-writer-wins hole.
 *
 * So every successful mutation is noted HERE, at module scope, against the
 * session that made it. Module scope is correct and deliberate: the thing being
 * described is the FILESYSTEM, which is shared by every session in the process,
 * and a per-session record of a shared resource is exactly what could not see
 * the problem.
 *
 * NOT A LOCK. Nothing waits, nothing is held, and nothing is serialised. It is
 * a note that lets a mutation answer "has somebody else touched this since I
 * last had evidence about it" — the fingerprint-and-verify model the rest of
 * the mutation path already uses, extended across the session boundary.
 *
 * BOUNDED. Oldest notes fall off; a session that runs for hours does not grow
 * this without limit.
 */
const MAX_WRITE_NOTES = 500;
const writes = new Map();   // key -> { stamp, by, at }

function worldKey(cwd, p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** Record that `by` mutated this path. Called from `observe` on every write. */
function noteWrite(cwd, p, by) {
  if (!p || !by) return;
  const key = worldKey(cwd, p);
  writes.delete(key);                       // re-insert so iteration order is age
  writes.set(key, { stamp: stampFor(cwd, p), by: String(by), at: Date.now() });
  while (writes.size > MAX_WRITE_NOTES) writes.delete(writes.keys().next().value);
}

/** Forget everything. For tests, and for a process starting a fresh run. */
function forgetWrites() { writes.clear(); }

/**
 * HAS ANOTHER SESSION WRITTEN THIS FILE, WITH NOTHING IN OURS TO SAY SO?
 *
 * Only fires when BOTH are true: somebody else wrote it, and we hold no
 * evidence of our own about it. If we do hold evidence, `staleness` is the
 * sharper test and answers first — this is for the blind case.
 */
function foreignWrite(ledger, cwd, p, mine) {
  if (!p || !mine) return null;
  const note = writes.get(worldKey(cwd, p));
  if (!note || note.by === String(mine)) return null;
  try { if (ledger && ledger.byPath.get(ledger._key(p))) return null; } catch { /* no ledger */ }
  return note;
}

/**
 * WAS THIS FILE EVER INSPECTED BY THE SESSION NOW ABOUT TO MUTATE IT?
 *
 * ------------------------------------------------------------------------
 * THE THIRD QUESTION, for the case with no fact to check at all.
 *
 * `staleness` guards a file we read that has since changed. `foreignWrite`
 * guards a file another session wrote while we held nothing. Both need a
 * matching record to exist. What neither covers is the plainest case: a
 * file that EXISTS on disk, that this session never read whole — so a
 * whole-file `write_file` would replace every byte in it with ones composed
 * from no evidence at all, and report success. Content-anchored mutations
 * (apply_patch, edit_file, …) are already safe here by construction: they
 * must name the exact bytes they replace, so a file they never saw fails
 * loudly instead of quietly winning. `write_file` is the one path with no
 * anchor, and this is its guard.
 *
 * EXEMPT, each for a stated reason:
 *   - the file does not exist: creation — there is nothing to have inspected
 *   - no ledger at all: a session-less context, which makes no claims
 *   - OUR OWN write, unchanged since: `noteWrite` recorded it under this
 *     session's id and nothing has touched the file since. A session that
 *     reads, writes and writes again must not be sent back to re-read its
 *     own work between writes. If something DID touch the file after our
 *     write, the stamp disagrees and this fires — the one case neither
 *     `staleness` (our write cleared the entry) nor `foreignWrite` (the note
 *     is ours) could see.
 *   - a caller whose mutation IS the inspection (`anchored` in edit.js):
 *     `delete_range` with `expect` quotes the very bytes it removes.
 *
 * An ELIDED entry still counts: entry existence is the fact of inspection;
 * `bodyPresent` is about the conversation window, not the session's
 * knowledge, and is deliberately not asked here.
 *
 * @returns {{now: {size: number, mtime: number}}|null} the file's current
 * stamp when the target was never inspected by this session, null to
 * proceed.
 */
function noInspection(ledger, cwd, p, mine) {
  if (!ledger || !p) return null;
  let entry = null;
  try { entry = ledger.byPath.get(ledger._key(p)); } catch { entry = null; }
  if (entry) return null;                  // inspected: `staleness` answers first
  const now = stampFor(cwd, p);
  if (!now) return null;                   // absent: creation, not blindness
  if (mine) {
    const note = writes.get(worldKey(cwd, p));
    if (note && note.by === String(mine)
      && note.stamp && note.stamp.size === now.size && note.stamp.mtime === now.mtime) {
      return null;                         // ours, and untouched since
    }
  }
  return { now };
}

/** The identity a session mutates under. One place that decides what that is. */
function sessionIdOf(ctx) {
  return (ctx && ctx.session && ctx.session.id) || null;
}

module.exports = {
  EvidenceLedger, LARGE_FILE_LINES, stampFor, isTargeted, BODY_READS, MUTATORS,
  staleness, ledgerOf, noteWrite, forgetWrites, foreignWrite, noInspection, sessionIdOf,
  MAX_WRITE_NOTES,
};
