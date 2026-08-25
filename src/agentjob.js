'use strict';

/**
 * AGENT WORK THAT THE PROMPT DOES NOT WAIT FOR.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, and it was one line.
 *
 * src/repl.js drained its input queue like this:
 *
 *     const ev = queue.shift();
 *     await app.handle(ev.text, …);        <- the loop parks here
 *
 * The keyboard reader is event-driven and never stopped, so the input LINE
 * stayed editable the whole time — which is exactly what made this hard to see.
 * What stopped was the DRAIN: nothing was taken off the queue until the turn
 * resolved, so a task submitted during a six-second tool call did not begin
 * until that call was over. Measured against the real binary: the second turn's
 * first word appeared only after the first turn's last one.
 *
 * ------------------------------------------------------------------------
 * WHY DECOUPLING THAT LINE ALONE WOULD HAVE BEEN A DATA-CORRUPTION BUG.
 *
 * `runTurn` writes to `session.messages` throughout a turn: the user message,
 * then every assistant turn CARRYING ITS tool_calls, then a `role:'tool'`
 * result matched to each one by id. That pairing is the protocol the provider
 * validates, and V1's audit calls it the single most valuable idea it had.
 *
 * Two turns running against ONE session interleave those pushes. The result is
 * an assistant message whose tool_calls are answered after somebody else's, or
 * a tool result with no call in front of it — a 400 from the provider at some
 * later, unrelated moment. `app.abort`, `app.pendingAsk` and `app.steerQueue`
 * are singletons for the same reason, and src/commands.js says it outright:
 * "it starts a turn of its own, and two turns cannot own…".
 *
 * ------------------------------------------------------------------------
 * SO THE INVARIANT IS OWNERSHIP, AND IT IS ENFORCED RATHER THAN HOPED FOR:
 *
 *   AT MOST ONE JOB OWNS `app.session`.   The PRIMARY job. It is the ordinary
 *                                         conversation and it behaves exactly
 *                                         as it always did — same `submit`,
 *                                         same UI, same steer queue.
 *   EVERY OTHER JOB OWNS ITS OWN Session. `/bg` forks one. It can never touch
 *                                         the main `messages` array, so no
 *                                         interleaving is possible.
 *
 * The first half is kept true by the input path rather than by a lock: text
 * typed while the primary job runs becomes a STEER (src/repl.js), which is the
 * behaviour that was already there and the reason a second primary can never be
 * started. `start()` refuses one anyway — an invariant worth stating twice.
 *
 * ------------------------------------------------------------------------
 * ONE JOB VOCABULARY. src/jobs.js already owns the state machine for background
 * SHELL commands and says there must not be a second one. There is not: `STATE`
 * and `FINAL` are imported from it. What this file adds is a different KIND of
 * job, not a different set of states.
 *
 * WAITING IS A PHASE, NOT A STATE, and that is deliberate. "Is job #1 waiting?"
 * is answerable — see `waiting` below — but a job that is waiting for a tool,
 * a rate limit or an answer is still RUNNING as far as its lifecycle goes, and
 * minting a seventh state to describe a passing condition is how two vocabularies
 * start. The phase comes from the same `onStatus` the live UI uses.
 *
 * NO POLLING ANYWHERE. A job settles by resolving its own promise; `wait()`
 * blocks on that. There is no interval and no busy loop in this file, which is
 * the same rule src/jobs.js follows for child processes.
 */

const { STATE, FINAL } = require('./jobs');

/** Finished jobs kept so a result can still be read. Never unbounded. */
const MAX_KEPT = 20;

/**
 * Phases that mean the job is BLOCKED on something outside itself.
 *
 * Read from the turn's own status vocabulary rather than guessed at, so this
 * cannot drift from what the status strip says about the same moment.
 */
const WAITING_PHASES = new Set(['WAITING', 'RATE_LIMITED', 'ASKING', 'RETRYING', 'WAITING_FOR_INPUT']);

/**
 * THE PHASE THAT MEANS "I ASKED YOU SOMETHING AND I AM HOLDING".
 *
 * A background job that needs a decision used to have no way to ask: the
 * interaction panel is a single surface the user is looking at, so a job they
 * are not watching must never take it. The answer was to give it no `ask` at
 * all, which turned "I need to know something" into "I will guess".
 *
 * PARKING IS NOT A NEW STATE. The job is still RUNNING — it is running and
 * blocked, exactly as it is when a tool is slow or a limit is in force, which
 * is what every other entry in WAITING_PHASES describes. What is new is that
 * the block can be CLEARED BY THE USER, so the question and the resolver ride
 * on the job and `/answer <n>` reaches them.
 */
const NEEDS_INPUT = 'WAITING_FOR_INPUT';

class AgentJob {
  constructor({ id, request, primary = false, session = null }) {
    this.id = id;
    this.request = String(request || '');
    /** Does this job own `app.session`? Exactly one may. See the header. */
    this.primary = Boolean(primary);
    /** The session this job's turn writes to. Never shared with another job. */
    this.session = session;
    this.state = STATE.QUEUED;
    /** What it is doing this instant — the "current activity". */
    this.phase = null;
    this.detail = '';
    this.startedAt = null;
    this.endedAt = null;
    /** The turn record when it finished, or null. */
    this.result = null;
    /** The message when it failed, or null. Never an Error object: this is
     *  rendered, persisted and read by the model. */
    this.error = null;
    /** Cooperative cancellation. The SAME AbortController the turn is given. */
    this.abort = new AbortController();
    /**
     * THE QUESTION THIS JOB IS HOLDING FOR, and the promise waiting on it.
     *
     * Both null unless the job is parked in `WAITING_FOR_INPUT`. They live on
     * the job because the job is the thing `/answer <n>` names — there is no
     * registry of outstanding questions to keep in step with the registry of
     * jobs, which is the second bookkeeping system this avoids having.
     */
    this.question = null;
    this._answer = null;
    this._waiters = [];
  }

  get done() { return FINAL.has(this.state); }

  /** Blocked on something outside itself — a tool, a limit, an answer. */
  get waiting() { return this.state === STATE.RUNNING && WAITING_PHASES.has(this.phase); }

  /** Blocked on the USER specifically, which is the one a person can clear. */
  get needsInput() { return this.state === STATE.RUNNING && this.phase === NEEDS_INPUT && Boolean(this.question); }

  /** What `/jobs` prints. RUNNING, WAITING and NEEDS INPUT are one state. */
  get label() { return this.needsInput ? 'NEEDS INPUT' : this.waiting ? 'WAITING' : this.state; }

  /**
   * PARK UNTIL SOMEBODY ANSWERS. Returns the promise the tool awaits.
   *
   * Cancellation resolves it with null rather than leaving it hanging: a
   * cancelled job must unwind, and a tool awaiting a promise nobody will settle
   * is the one shape that cannot.
   */
  askUser(question, options = []) {
    this.question = { question: String(question || ''), options: options.slice(0, 12), at: Date.now() };
    this.phase = NEEDS_INPUT;
    return new Promise((resolve) => { this._answer = resolve; });
  }

  /** `/answer <n> <text>` — settle the parked question and let the turn resume. */
  reply(text) {
    if (!this._answer) return false;
    const done = this._answer;
    this._answer = null;
    this.question = null;
    this.phase = 'RUNNING_TOOL';
    done(String(text == null ? '' : text));
    return true;
  }

  get elapsedMs() {
    if (!this.startedAt) return 0;
    return (this.endedAt || Date.now()) - this.startedAt;
  }

  /** One line: what it is doing, or how it ended. */
  get activity() {
    if (this.needsInput) return this.question.question;
    if (this.state === STATE.QUEUED) return 'queued';
    if (this.done) return this.error || (this.result ? 'finished' : String(this.state).toLowerCase());
    return this.detail || String(this.phase || 'working').toLowerCase();
  }

  /** Settle once, and wake everything waiting. Never throws. */
  _finish(state, { result = null, error = null } = {}) {
    if (this.done) return this;
    this.state = state;
    this.result = result;
    this.error = error;
    this.endedAt = Date.now();
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) { try { w(this); } catch { /* a waiter must not unsettle the job */ } }
    return this;
  }

  /**
   * COOPERATIVE, AND IT IS THE SAME MECHANISM Ctrl+C ALREADY USES.
   *
   * Aborting the controller is read at every safe boundary the turn already
   * has — before a provider request, between tool calls, inside a long wait,
   * and in the retry loop — because those checks were written for the
   * interrupt and this hands them the identical signal. Nothing is killed and
   * no process is torn down.
   *
   * A CANCELLED JOB IS NOT A FAILED ONE. It ends in CANCELLED, which reads as
   * the user's decision rather than as something going wrong.
   */
  cancel(why = 'cancelled') {
    if (this.done) return false;
    try { this.abort.abort(); } catch { /* already aborted */ }
    // A PARKED QUESTION IS RELEASED, or the turn awaiting it never unwinds and
    // the "cancelled" job goes on holding a promise for the life of the process.
    if (this._answer) { const done = this._answer; this._answer = null; this.question = null; done(null); }
    this._finish(STATE.CANCELLED, { error: String(why) });
    return true;
  }

  /** Resolves when the job settles. No interval, no poll — see the header. */
  wait() {
    if (this.done) return Promise.resolve(this);
    return new Promise((resolve) => { this._waiters.push(resolve); });
  }

  /** What the UI and `/jobs` read. A plain object; never the live job. */
  summary() {
    return {
      id: this.id,
      state: this.state,
      label: this.label,
      waiting: this.waiting,
      needsInput: this.needsInput,
      question: this.question ? this.question.question : null,
      primary: this.primary,
      request: this.request,
      activity: this.activity,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      elapsedMs: this.elapsedMs,
      error: this.error,
    };
  }
}

/**
 * THE JOBS THIS SESSION HAS STARTED.
 *
 * Per-App, never module scope: two LAINs in one process must not see each
 * other's work, which is the same rule every other piece of session state in
 * this program follows.
 */
class AgentJobs {
  constructor({ onChange = null } = {}) {
    this.list = [];
    /** Called whenever anything about any job changes, so the screen can
     *  redraw without anybody polling. */
    this.onChange = onChange;
    this._seq = 0;
  }

  changed() { if (this.onChange) { try { this.onChange(); } catch { /* drawing must not break the job */ } } }

  /** The job that owns `app.session`, or null. At most one, ever. */
  primary() { return this.list.find((j) => j.primary && !j.done) || null; }

  create({ request, primary = false, session = null }) {
    this._seq += 1;
    const job = new AgentJob({ id: String(this._seq), request, primary, session });
    this.list.push(job);
    // Finished jobs are kept so a result can still be read, but not forever.
    while (this.list.length > MAX_KEPT) {
      const oldest = this.list.findIndex((j) => j.done);
      if (oldest < 0) break;
      this.list.splice(oldest, 1);
    }
    this.changed();
    return job;
  }

  get(id) { return this.list.find((j) => j.id === String(id)) || null; }
  running() { return this.list.filter((j) => !j.done); }
  all() { return this.list.slice(); }

  /** Everything still going, stopped. Called when the session ends. */
  cancelAll(why = 'the session ended') {
    let n = 0;
    for (const j of this.running()) if (j.cancel(why)) n += 1;
    if (n) this.changed();
    return n;
  }
}

module.exports = { AgentJob, AgentJobs, STATE, FINAL, MAX_KEPT, WAITING_PHASES, NEEDS_INPUT };
