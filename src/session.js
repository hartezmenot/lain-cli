'use strict';

/**
 * A session owns the conversation and everything derived from it.
 *
 * THE RULE THAT SHAPES THIS FILE: a new session is EMPTY. There is no lookup of
 * previous sessions, no "is this plan related" heuristic, no scan of the cwd for
 * state to adopt. `new Session()` reads nothing from disk. The only way state
 * crosses a session boundary is `Session.resume(id)`, which the user asks for
 * explicitly.
 *
 * State lives on the instance, never at module scope, so two Apps in one process
 * cannot see each other (V1 could).
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { EvidenceLedger, BODY_READS } = require('./evidence');
const { Task } = require('./task');

/**
 * Pessimistic on purpose — see `contextChars`. Code and JSON tokenize worse
 * than prose, and the cost of guessing low is a rejected request.
 */
const CHARS_PER_TOKEN = 3.6;
/** Messages at the end that keep their full body: the current working set. */


const KEEP_RECENT = 10;
/** A tool result smaller than its own stub is left alone. */
const TOOL_STUB_MIN = 400;
/** Declarations kept in an elided read's stub, and how much room they get. */
const RESIDUE_UNITS = 25;
const RESIDUE_CHARS = 700;
/** How much of a long assistant message survives — the opening is the finding. */
const ASSISTANT_KEEP = 400;

/**
 * How many characters of CONVERSATION fit, given the resolved provider.
 *
 * The window also has to hold the system prompt, the tool schemas and the
 * model's own reply, none of which are in `messages`, so they are reserved
 * before the split. `pc.ctx` comes from provider.resolve.
 */
function budgetChars(pc) {
  // An explicit override, because the advertised context length is metadata and
  // metadata is frequently wrong — a local model served behind an OpenAI-shaped
  // API routinely claims 128k and rejects at 8k. The user who knows better must
  // be able to say so without editing a catalog.
  const forced = Number(process.env.LAIN_CONTEXT_CHARS);
  if (Number.isFinite(forced) && forced > 0) return Math.floor(forced);
  const ctx = Number(pc && pc.ctx) || 128000;
  const out = Number(pc && pc.maxTokens) || 4096;
  const reserve = 4000;                                  // system prompt + tool schemas
  const usable = Math.max(4000, ctx - out - reserve);
  return Math.floor(usable * CHARS_PER_TOKEN);
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

class Session {
  /** A brand-new, EMPTY session. Touches no previous session's state. */
  constructor({ id = null, cwd = process.cwd() } = {}) {
    this.id = id || newId();
    this.createdAt = new Date().toISOString();
    this.cwd = cwd;
    /** The conversation, including the tool protocol. See turn.js. */
    this.messages = [];
    this.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0 };
    this.turns = [];
    /** The active task, or null. ONE place — see task.js. */
    this.task = null;
    /** Lifecycle + liveness for the active task. Fed by turn.js on every turn. */
    this.lifecycle = null;
    /** Session-scoped evidence: what content is already in context. */
    // OWNED, so a mutation can tell this session's writes from another's — see
    // evidence.js `foreignWrite`. Two jobs share a filesystem and not a ledger.
    this.evidence = new EvidenceLedger(this.cwd, this.id);
    /** Session-owned plan, or null. A plan NEVER arrives from anywhere else. */
    this.plan = null;
    /** The workflow this session is doing — see mode.js. Restored on /resume so
     *  a resumed bugfix keeps tracing rather than reverting to a generic turn. */
    this.mode = null;
    /**
     * ONE OWNER for compaction and provider projections. Held on the session
     * so forked jobs, primary turns and `/clear` each have an independent
     * lifecycle and can never mutate one another's context authority.
     */
    this.contextAuthority = new (require('./contextauthority').ContextAuthority)(this);
    /**
     * WHAT THE OTHER ACTORS SAID — the external reviewer and the desktop
     * bridge, in the order they spoke.
     *
     * This lives on the SESSION rather than on the UI because it is part of the
     * task's story, not part of the screen. Held on the UI it was lost on
     * resume: a session came back with its transcript, its objective and its
     * changed files, and the external review that produced half of them was
     * simply gone — the one voice in the room that could not be recovered by
     * re-reading anything.
     *
     * Each entry is `{ kind, text, afterTurns }`. `afterTurns` is how many turns
     * had happened when it was said, which is what lets Context replay the story
     * IN ORDER rather than appending every review to the bottom.
     */
    this.actors = [];
    // WHO ANSWERS A CHAT TURN, and which website thread is this one's.
    require('./modelsource/sessionstate').attach(this);
    this.goal = null;    // the standing goal, changed only by /goal — goal.js   // its own module: see there
  }

  file() {
    return path.join(config.sessionsDir(), `${this.id}.json`);
  }

  // ------------------------------------------------------ context window ----

  /**
   * How big the conversation currently is, in characters.
   *
   * Characters rather than tokens on purpose: a real tokenizer is a dependency
   * and a per-model one at that, and the only decision this feeds is "are we
   * near the edge". `CHARS_PER_TOKEN` is deliberately pessimistic, so the
   * estimate errs towards compacting slightly early rather than one step late —
   * one step late is a hard provider rejection with the turn's work in it.
   */
  contextChars() {
    let n = 0;
    for (const m of this.messages) {
      n += String((m && m.content) || '').length + 24;   // + envelope
      for (const tc of (m && m.tool_calls) || []) n += String(tc.arguments || '').length + String(tc.name || '').length + 40;
    }
    return n;
  }

  /**
   * ELIDE THE BULK, KEEP THE SHAPE.
   *
   * V2 had no context management whatsoever: `session.messages` grew forever and
   * every step re-sent all of it. A long task therefore ended in a provider
   * rejection — with the whole turn's work sitting in the payload that was
   * refused — and nothing recovered from it.
   *
   * V1's answer was `/compact`, which asked a model to summarise the history.
   * That is a hidden request, it costs tokens at exactly the moment tokens are
   * scarce, and what it deletes is decided by a generation. This does none of
   * that. It is pure local string work:
   *
   *   - tool RESULTS are the bulk (a grep dump, a file body, a test log), and
   *     they are the one thing that is exactly reproducible — the call that
   *     produced them is still right there. So an old result is replaced by a
   *     stub naming the tool, the size removed, and its first line.
   *   - old assistant PROSE is trimmed to its opening, which is where the
   *     finding is.
   *   - NOTHING is deleted and nothing is reordered. Every message keeps its
   *     place, every `tool_call_id` keeps its partner. A compacted conversation
   *     is still a valid one for every provider protocol, which is not true of
   *     any scheme that drops messages.
   *   - the first user message — the objective — is never touched, and neither
   *     is the recent working set.
   *
   * The plan, the task and the evidence ledger are rebuilt into the system
   * prompt every turn, so they survive this by construction.
   *
   * @returns {{compacted:boolean, before:number, after:number, elided:number}}
   */
  /**
   * WHAT WAS JUST ELIDED IS NO LONGER "ALREADY IN CONTEXT".
   *
   * ------------------------------------------------------------------------
   * THE CONTRADICTION THIS RESOLVES, reproduced through the real tool path:
   * read a 400-line file, let the session grow, compact, then try to read it
   * again. Two subsystems answer at once, and they disagree.
   *
   *   the stub says    "…returned 20469 chars. Re-run the call if you need
   *                     the rest."
   *   the ledger says  "unchanged since you read it earlier this session, so
   *                     re-reading it produces the same bytes… continue from
   *                     what you already have."
   *
   * The model has neither the content nor permission to fetch it. The evidence
   * ledger's contract — stated where it is constructed above — is "what content
   * is already in context", and compaction is the one operation that takes
   * content OUT of context. It was never told.
   *
   * What a model does next when whole reads are refused is crawl the file back
   * in the ranged reads the refusal itself recommends, which is the read-read-
   * read behaviour this was found underneath.
   *
   * ONLY BODY READS ARE FORGOTTEN. A stubbed `grep` never claimed content was
   * in context, so it has no claim to retract. And this retracts a claim rather
   * than deleting knowledge: the file is on disk, and the next read is served.
   */
  _forgetElided(tc) {
    if (!tc || !this.evidence) return;
    if (!BODY_READS.has(String(tc.name))) return;
    let p = null;
    try {
      const a = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
      p = a && a.path;
    } catch { p = null; }
    if (p) this.evidence.elide(String(p));
  }

  /**
   * WHAT THE FILE CONTAINED, WHEN ITS BODY NO LONGER FITS.
   *
   * ------------------------------------------------------------------------
   * THE DISTINCTION THIS ENCODES. A 20,000-character read is EVIDENCE. That
   * `Session` declares `compact`, `_forgetElided` and `restore`, and where each
   * one starts, is KNOWLEDGE. Compaction is entitled to drop the first; it was
   * dropping the second at the same time purely because they arrived in the
   * same message, and the receipt it left behind — "returned 20469 chars" —
   * records that a read HAPPENED without preserving anything it established.
   *
   * So the stub keeps its receipt AND gains an outline. From it the model can
   * ask read_symbol for the one definition it actually wants, which is the
   * targeted rehydration that replaces re-reading the file. Measured on this
   * repository the outline is roughly 18x smaller than the body it replaces.
   *
   * BOUNDED, because a session can elide many files: top-level declarations
   * first, capped by count and by characters. Any language — structure.js reads
   * declaration lines for all of them and never invents one.
   *
   * Returns '' when there is nothing useful to say, and the bare receipt stands.
   */
  _semanticResidue(tc) {
    if (!tc || !BODY_READS.has(String(tc.name))) return '';
    let p = null;
    try {
      const a = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
      p = a && a.path;
    } catch { return ''; }
    if (!p) return '';
    try {
      const abs = path.isAbsolute(p) ? p : path.resolve(this.cwd || process.cwd(), p);
      const s = require('./structure').extractFile(abs, String(p));
      const all = s && Array.isArray(s.units) ? s.units : [];
      if (!all.length) return '';
      // ---- SPEND THE ROOM ON THE API SURFACE ------------------------------
      //
      // A JavaScript scan reports every binding, so `fs`, `path` and `config`
      // — the requires at the top — arrive before the first function and would
      // eat a budget this small on the least informative names in the file.
      // Callable and type declarations go first; plain bindings fill whatever
      // is left. Line order is preserved inside each group, because a file's
      // order is part of how it reads.
      const meaty = all.filter((u) => u.kind !== 'variable');
      const rest = all.filter((u) => u.kind === 'variable');
      const units = [...meaty, ...rest].slice(0, RESIDUE_UNITS);
      let out = '';
      for (const u of units.sort((a, b) => a.line - b.line)) {
        const row = `\n  ${String(u.line).padStart(5)}  ${String(u.kind).padEnd(8)} `
          + `${u.container ? `${u.container}.` : ''}${u.name}`;
        if (out.length + row.length > RESIDUE_CHARS) break;
        out += row;
      }
      if (!out) return '';
      // PRESENT TENSE, DELIBERATELY. This is read from disk at the moment of
      // compaction, so it describes the file as it IS — which is the more useful
      // of the two and, if the file has been edited since, not the same thing as
      // the bytes that were elided. Saying "what it defined" would quietly
      // attribute the current shape to the old read.
      return `\nThe body is gone. What this file defines, read from disk just now `
        + `(${(s.units || []).length} declarations):${out}`
        + '\nread_symbol returns any one of these without the rest of the file.';
    } catch { return ''; }
  }

  compact({ budgetChars = 0, maxMessages = 0, keepRecent = KEEP_RECENT, force = false } = {}) {
    const before = this.contextChars();
    const beforeCount = this.messages.length;
    const overCount = maxMessages > 0 && beforeCount > maxMessages;
    if (!force && !overCount && budgetChars > 0 && before <= budgetChars) {
      return { compacted: false, before, after: before, elided: 0, folded: 0, beforeMessages: beforeCount, afterMessages: beforeCount };
    }

    // Which tool produced each result — the stub is useless without it, and the
    // tool message itself only carries an id.
    const toolFor = new Map();
    for (const m of this.messages) {
      for (const tc of (m && m.tool_calls) || []) toolFor.set(String(tc.id), tc);
    }

    const last = this.messages.length - 1;
    const frontier = Math.max(1, last - keepRecent + 1);   // index 0 is the objective
    let elided = 0;

    for (let i = 1; i < frontier; i++) {
      const m = this.messages[i];
      // 'stub' is final. 'truncated' is NOT: a result kept in part because it
      // was the live one becomes an ordinary old result once the work moves on,
      // and then the call that made it is repeatable like any other. Without
      // this, whatever happened to be recent when the window first filled kept a
      // large body for the rest of the session.
      if (!m || m.elided === 'stub') continue;
      const body = String(m.content || '');

      if (m.role === 'tool') {
        if (body.length <= TOOL_STUB_MIN) continue;
        const tc = toolFor.get(String(m.tool_call_id));
        const name = (tc && tc.name) || 'tool';
        const args = tc ? String(tc.arguments || '').slice(0, 120) : '';
        const head = (body.split('\n').find((l) => l.trim()) || '').slice(0, 140);
        const orig = m.origChars || body.length;
        m.content =
          `[elided to fit the context window] ${name}${args ? ' ' + args : ''} returned ${orig} chars.`
          + (head ? ` First line: ${head}` : '')
          + ` Re-run the call if you need the rest.`
          + this._semanticResidue(tc);
        m.elided = 'stub';
        m.origChars = orig;
        elided += body.length - m.content.length;
        this._forgetElided(tc);              // see _forgetElided
        continue;
      }

      if (m.elided) continue;
      if (m.role === 'assistant' && body.length > ASSISTANT_KEEP * 2) {
        m.content = body.slice(0, ASSISTANT_KEEP) + `\n[…${body.length - ASSISTANT_KEEP} chars elided to fit the context window]`;
        m.elided = 'stub';
        elided += body.length - m.content.length;
      }
    }

    // STILL over. Then the RECENT working set is itself bigger than the window
    // — one read of a 400KB file will do it — and keeping it whole is no longer
    // a kindness, it is the rejection. Elide inwards from the frontier.
    if (budgetChars > 0 && this.contextChars() > budgetChars) {
      for (let i = frontier; i <= last && this.contextChars() > budgetChars; i++) {
        const m = this.messages[i];
        if (!m || m.elided === 'stub' || m.role !== 'tool') continue;
        const body = String(m.content || '');
        if (body.length <= TOOL_STUB_MIN) continue;
        const tc = toolFor.get(String(m.tool_call_id));
        const name = (tc && tc.name) || 'tool';

        // The LAST result is the one the model is working from right now, so it
        // is TRUNCATED rather than stubbed: the head of a file or a search is
        // usually the part that answers the question, and a model told only
        // "there was output" can neither use it nor sensibly ask again. Every
        // earlier one is stubbed, because the call is repeatable.
        if (i >= last - 1) {
          const note = (n) => `\n[…${n} more chars — this result is larger than the context window. `
            + `Read a range, or narrow the search, to see the rest.]`;
          // The note itself occupies the window, so it comes out of the room
          // before the slice — otherwise the trim lands exactly one note over.
          const room = Math.max(TOOL_STUB_MIN, budgetChars - (this.contextChars() - body.length) - note(body.length).length);
          if (body.length <= room) continue;
          m.origChars = m.origChars || body.length;
          m.content = body.slice(0, room) + note(body.length - room);
          m.elided = 'truncated';
          // A HEAD IS NOT THE FILE. Whole-file evidence is exactly what this
          // claim no longer supports, so it is retracted here too.
          this._forgetElided(tc);
        } else {
          m.origChars = m.origChars || body.length;
          // ---- NAME THE CALL, OR THE ADVICE IS UNFOLLOWABLE -------------
          //
          // This said only `read_file returned 40000 chars. Re-run the call`
          // — without WHICH FILE. The first pass above already includes the
          // arguments; this one did not, so a stub produced by the inward
          // pass told the model to repeat a call it could no longer
          // identify. A pointer that does not point is worse than a gap,
          // because a gap is at least visibly a gap.
          const args2 = tc ? String(tc.arguments || '').slice(0, 120) : '';
          m.content = `[elided to fit the context window] ${name}${args2 ? ' ' + args2 : ''}`
            + ` returned ${m.origChars} chars. Re-run the call if you need it.`
            + this._semanticResidue(tc);
          m.elided = 'stub';
          this._forgetElided(tc);
        }
        elided += body.length - m.content.length;
      }
    }

    // ---- AND THE OTHER KIND OF TOO-BIG: TOO MANY MESSAGES ---------------
    //
    // Everything above shortens BODIES. Against a window measured in tokens
    // that is the whole answer. Against a provider that caps the NUMBER of
    // messages it is no answer at all — a thousand short messages are still a
    // thousand messages — so compaction would run, honestly report "nothing to
    // elide", and every request after it was refused exactly as before. That
    // is a session that cannot be rescued by the one tool built to rescue it.
    //
    // WHAT THIS DOES. Folds the OLDEST exchanges into a single message that
    // says what they were, until the count fits. The objective at index 0 and
    // the recent working set are never folded.
    //
    // IT IS A REAL LOSS AND IS REPORTED AS ONE. Unlike a stub, a folded
    // message cannot be recovered by re-running a call — the words are gone
    // from what the model sees. They remain in the session file, so /resume
    // and the transcript still have them; it is the REQUEST that gets smaller.
    const foldedCount = maxMessages > 0 ? this._foldOldest(maxMessages, keepRecent) : 0;

    const after = this.contextChars();
    return {
      compacted: elided > 0 || foldedCount > 0,
      before, after, elided,
      folded: foldedCount,
      beforeMessages: beforeCount,
      afterMessages: this.messages.length,
    };
  }

  /**
   * Fold the oldest exchanges into one summary message until at most
   * `maxMessages` remain. Returns how many messages disappeared.
   *
   * WHY WHOLE MESSAGES AND NOT A CLEVERER MERGE. An assistant message with
   * `tool_calls` and the `tool` messages answering it are ONE unit to every
   * OpenAI-shaped API: a tool result whose call is missing is a 400, and so is
   * a call whose result is missing. Folding a contiguous run from the front
   * and replacing it with a single plain message is the one edit that cannot
   * leave a dangling half.
   *
   * INDEX 0 SURVIVES. It is the objective, and a session that forgets what it
   * was asked is worse than one that is refused.
   */
  _foldOldest(maxMessages, keepRecent = KEEP_RECENT) {
    const target = Math.max(2, Math.floor(maxMessages));
    if (this.messages.length <= target) return 0;
    // Never fold into the recent working set, even if that leaves us over: a
    // request that is still refused is better than one that has lost the step
    // it is in the middle of. The caller is told the count that remains.
    const floor = Math.max(1, this.messages.length - Math.max(1, keepRecent));
    let cut = Math.min(floor, this.messages.length - target + 1);
    // SNAP TO A UNIT BOUNDARY, or this is the 400 the comment above warns
    // about. A `tool` message at the cut is the answer to a call that is INSIDE
    // the folded run: keeping it leaves a result whose call has vanished, and
    // every OpenAI-shaped API rejects the whole request for it. Measured — the
    // first version of this left exactly one orphan.
    //
    // Forward first, because folding one more message is free. Only if that
    // would eat into the recent working set does it retreat and fold less.
    const isAnswer = (i) => this.messages[i] && this.messages[i].role === 'tool';
    while (cut < floor && isAnswer(cut)) cut += 1;
    while (cut > 1 && isAnswer(cut)) cut -= 1;
    if (cut <= 1) return 0;
    const gone = this.messages.slice(1, cut);
    if (!gone.length) return 0;
    // ---- ONE SUMMARY, WHICH SUPERSEDES THE PREVIOUS ONE ----------------
    //
    // msgfold.foldSummary MERGES a fold it finds inside `gone` rather than quoting
    // it, and hands back the structured parts so the next fold can do the same.
    // See its header for the defect that produced this.
    const folded = require('./msgfold').foldSummary(gone);
    const summary = {
      role: 'user',
      content: folded.content,
      elided: 'folded',
      // HOW MANY REAL MESSAGES THIS STANDS FOR, not how many array slots it
      // replaced. A prior summary occupied one slot and stood for sixty-one, and
      // counting it as one is how the total silently shrank on every fold.
      foldedCount: folded.foldedCount,
      // THE PARTS, kept so the NEXT fold can merge instead of re-reading prose
      // it would have to parse. Reconstructing structure out of our own rendered
      // text is exactly how the nesting bug was possible.
      said: folded.said,
      calls: folded.calls,
    };
    this.messages.splice(1, gone.length, summary);
    return gone.length - 1;
  }

  toJSON() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      cwd: this.cwd,
      messages: this.messages,
      usage: this.usage,
      turns: this.turns,
      task: this.task ? this.task.toJSON() : null,
      lifecycle: this.lifecycle ? this.lifecycle.toJSON() : null,
      evidence: this.evidence.toJSON(),
      plan: this.plan ? this.plan.toJSON() : null,
      mode: this.mode || null,
      actors: this.actors,
      // THE RECORD THAT SOMETHING LEFT THIS MACHINE. Summaries only — see
      // externalstate.ExternalLedger.toJSON for why the packet itself is not
      // written here.
      external: this.external ? this.external.toJSON() : [],
      // THE CHAT SOURCE SURVIVES A RESUME. See modelsource/sessionstate.js.
      ...require('./modelsource/sessionstate').toJSON(this),
      cowork: require('./cowork/sessionstate').from(this.cowork),
      goal: require('./goal').toJSON(this),
    };
  }

  /** Explicit lifecycle clear. This never compacts and never reads a provider profile. */
  clearContext() {
    if (this.contextAuthority) return this.contextAuthority.clearContext();
    const removed = this.messages.length;
    const chars = this.contextChars();
    this.messages = [];
    return { removed, chars };
  }

  save() {
    const dir = config.sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const f = this.file();
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2), 'utf8');
    fs.renameSync(tmp, f);
    return f;
  }

  /**
   * EXPLICIT restore. The only path that crosses a session boundary.
   * Returns null when the id is unknown — callers must not fall back to
   * "the most recent session" or to anything found in the cwd.
   */
  static resume(id) {
    const f = path.join(config.sessionsDir(), `${String(Session.match(id) || id)}.json`);
    let data;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
    if (!data || typeof data !== 'object') return null;
    const s = new Session({ id: data.id, cwd: data.cwd });
    s.createdAt = data.createdAt || s.createdAt;
    s.messages = Array.isArray(data.messages) ? data.messages : [];
    // MERGED, NOT REPLACED. A session saved before cacheReadTokens/
    // cacheCreationTokens existed has a `usage` object without them — assigning
    // it wholesale left those keys `undefined`, and turnclose.js's `+=` on an
    // `undefined` accumulator turns every later count into NaN for the rest of
    // the resumed session's life.
    if (data.usage && typeof data.usage === 'object') s.usage = { ...s.usage, ...data.usage };
    s.turns = Array.isArray(data.turns) ? data.turns : [];
    // Restoring THIS session's task, evidence and plan is the whole point of an
    // explicit resume. None of it can reach any other session.
    s.task = Task.from(data.task);
    s.lifecycle = require('./lifecycle').Lifecycle.from(data.lifecycle);
    // The ledger's owner is restored too — the resumed session notes its
    // writes under its own id, so `noInspection` never mistakes its second
    // write to a file it just wrote for a blind one.
    s.evidence = EvidenceLedger.from(data.evidence, s.cwd, s.id);
    s.plan = require('./plan').Plan.from(data.plan);
    s.mode = data.mode || null;
    // The other voices come back with the rest of the story. A session written
    // before this existed simply has none, which is the true answer for it.
    s.actors = Array.isArray(data.actors) ? data.actors : [];
    s.external = require('./externalstate').ExternalLedger.from(data.external);
    require('./modelsource/sessionstate').restore(s, data);
    s.cowork = require('./cowork/sessionstate').from(data.cowork);
    s.goal = require('./goal').from(data.goal);
    return s;
  }

  /**
   * The short form a person types: `20260815-224200-ayze` → `ayze`.
   *
   * The full id is a filename, and a timestamp plus a random suffix is internal
   * bookkeeping to read aloud. The token is the random part — the bit that
   * actually distinguishes one session from another.
   */
  static shortId(id) {
    const s = String(id || '');
    const tail = s.split('-').pop();
    return tail || s;
  }

  /**
   * Resolve what the user typed to a real session id.
   *
   * Exact id first, then a UNIQUE short token, then a unique prefix. Ambiguity
   * resolves to nothing rather than to a guess: restoring the wrong session is
   * far worse than saying "that matches three".
   */
  static match(input) {
    const want = String(input || '').trim();
    if (!want) return null;
    const all = Session.list(500);
    if (all.includes(want)) return want;
    const byToken = all.filter((id) => Session.shortId(id) === want);
    if (byToken.length === 1) return byToken[0];
    if (byToken.length > 1) return null;
    const byPrefix = all.filter((id) => id.startsWith(want));
    return byPrefix.length === 1 ? byPrefix[0] : null;
  }

  /** Session ids, newest first. Used by `/sessions` — never to auto-resume. */
  static list(limit = 20) {
    let names = [];
    try { names = fs.readdirSync(config.sessionsDir()); } catch { return []; }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .sort()
      .reverse()
      .slice(0, limit);
  }
}


module.exports = { Session, newId, budgetChars, CHARS_PER_TOKEN, KEEP_RECENT, TOOL_STUB_MIN, ASSISTANT_KEEP };
