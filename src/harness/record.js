'use strict';

/**
 * THE TASK RECORD — what a task IS, once a task is more than a sentence.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT src/task.js, AND WHY src/task.js STAYS EXACTLY AS IT IS.
 *
 * `src/task.js` owns TASK IDENTITY: is this input the same task as before, a
 * continuation, a restatement, a steer, or pasted content? That question is
 * about the person's words, it is answered deterministically from text, and it
 * has one classifier by architectural rule. Nothing here re-derives it — the
 * runtime consumes `task.classify()`'s verdict exactly as app.js already does.
 *
 * This owns the OTHER half, which src/task.js deliberately never had: a task as
 * a thing with a workspace, processes, observations, verifications, artifacts
 * and a state. `Task` in task.js is `{objective, steers, turnIds}` and lives on
 * the session — it dies with the session. This lives on disk, under
 * `.lain/tasks/<id>/`, and outlives the session, the model and the process.
 *
 * The two are LINKED, not merged: a record carries `objective` (copied from the
 * session task at creation) and `sessionId`. Merging them would put a
 * filesystem write inside the classifier that runs on every keystroke's worth
 * of input, and would give the thing that decides "is this a steer?" an opinion
 * about whether the browser is healthy.
 *
 * ------------------------------------------------------------------------
 * WHAT A RECORD MAY AND MAY NOT HOLD.
 *
 * MAY: facts with provenance. A state and when it changed. A process id and
 * its port. A verification verdict and the checks that produced it. Artifact
 * ids. Counts of things that happened.
 *
 * MAY NOT: anything a model said. The transcript is the session's, and copying
 * prose in here would make the record a second transcript that nothing
 * compacts. `title` is the one exception and it is a label, capped, one line.
 *
 * ------------------------------------------------------------------------
 * `verifications` APPENDS AND NOTHING REMOVES FROM IT.
 *
 * A task that failed verification, was repaired and re-verified keeps BOTH
 * entries. The flight recorder's value is that the first one is still there —
 * "it passed" and "it passed on the second attempt after the browser flow
 * failed" are different facts, and a record that can only express the first is
 * how a harness quietly starts lying.
 */

const state = require('./state');

/** A title is a label for a list, not a description. */
const MAX_TITLE = 120;

/** Bounded, like everything: a record is read on every surface. */
const MAX_PROCESSES = 32;
const MAX_VERIFICATIONS = 32;
const MAX_OBSERVATIONS = 200;

let seq = 0;

/**
 * Task ids are `t<n>-<timestamp36>`.
 *
 * The sequence makes ids readable in one session ("t3 failed"); the timestamp
 * makes them unique ACROSS sessions, which the sequence alone cannot — two
 * LAINs started an hour apart would both call their first task `t1` and write
 * into the same directory. The counter is module-level and is a COUNTER, not
 * state: it holds no session, no task and no opinion, which is what the
 * architecture guard's rule about module scope is actually about.
 */
function newId(now = Date.now()) {
  seq += 1;
  return `t${seq}-${now.toString(36)}`;
}

class TaskRecord {
  #state = state.STATE.PLANNED;
  constructor({ id = null, title = '', objective = '', workspace = process.cwd(), sessionId = null } = {}) {
    this.id = id || newId();
    this.title = String(title || objective || 'untitled').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || 'untitled';
    this.objective = String(objective || '');
    this.workspace = String(workspace);
    this.sessionId = sessionId ? String(sessionId) : null;
    /** Why the task is in the state it is in. Always a sentence a person reads. */
    this.reason = 'created';
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    /** Every state it has been in, in order: [{from, to, why, at}]. */
    this.history = [];
    /** Managed processes owned by this task: [{processId, name, port, status}]. */
    this.processes = [];
    /** Verification attempts, appended, never removed. */
    this.verifications = [];
    /** Observation summaries — the goal asked and the source that answered. */
    this.observations = [];
    /** Artifact ids kept for this task. The bodies live in the artifact store. */
    this.artifacts = [];
    /** How many events the durable log has taken. A count, not a copy. */
    this.eventCount = 0;
    /** A repair task names the task whose failure caused it. */
    this.causedBy = null;
    /** Agents that worked on this task: [{name, scope, at, outcome}]. */
    this.agents = [];
  }

  /**
   * MOVE. Refuses illegal transitions rather than performing them quietly.
   *
   * @returns {{ok:boolean, why:string}} — the refusal reason is shown to a
   *   person, which is why it is a sentence rather than a code.
   */
  get state() { return this.#state; }

  moveTo(next, why = '', verification = null) {
    if (next === state.STATE.PASSED && (!require('./verify').isResult(verification, this.id) || verification.verdict !== next)) {
      return { ok: false, why: 'PASSED requires a verification result for this task' };
    }
    const verdict = state.transition(this.state, next);
    if (!verdict.ok) return verdict;
    if (this.state !== next) {
      this.history.push({ from: this.state, to: next, why: String(why || ''), at: Date.now() });
      this.#state = next;
    }
    this.reason = String(why || this.reason);
    this.updatedAt = Date.now();
    return { ok: true, why: '' };
  }

  get terminal() { return state.TERMINAL.has(this.state); }
  get tone() { return state.TONE[this.state] || 'idle'; }

  noteProcess(p) {
    const at = this.processes.findIndex((x) => x.processId === p.processId);
    const row = {
      processId: p.processId, name: p.name, port: p.port == null ? null : p.port,
      status: p.status, health: p.health || null, pid: p.pid == null ? null : p.pid,
    };
    if (at >= 0) this.processes[at] = row;
    else this.processes.push(row);
    if (this.processes.length > MAX_PROCESSES) this.processes.splice(0, this.processes.length - MAX_PROCESSES);
    this.updatedAt = Date.now();
    return row;
  }

  noteVerification(result) {
    this.verifications.push({
      at: Date.now(),
      verdict: result.verdict,
      contract: result.contract || null,
      passed: result.passed || 0,
      failed: result.failed || 0,
      inconclusive: result.inconclusive || 0,
      why: String(result.why || '').slice(0, 400),
    });
    if (this.verifications.length > MAX_VERIFICATIONS) this.verifications.shift();
    this.updatedAt = Date.now();
  }

  noteObservation(o) {
    this.observations.push({
      at: Date.now(),
      goal: String(o.goal || '').slice(0, 120),
      source: String(o.source || '').slice(0, 40),
      ok: Boolean(o.ok),
      summary: String(o.summary || '').slice(0, 300),
    });
    if (this.observations.length > MAX_OBSERVATIONS) this.observations.shift();
    this.updatedAt = Date.now();
  }

  noteArtifact(rec) {
    this.artifacts.push({ id: rec.id, kind: rec.kind, name: rec.name, bytes: rec.bytes, at: rec.at });
    this.updatedAt = Date.now();
  }

  noteAgent(a) {
    this.agents.push({
      name: String(a.name || 'agent').slice(0, 60),
      scope: String(a.scope || '').slice(0, 200),
      at: Date.now(),
      outcome: a.outcome ? String(a.outcome).slice(0, 80) : null,
    });
    this.updatedAt = Date.now();
  }

  /** The last verification, or null. What "is it proved?" actually reads. */
  get lastVerification() {
    return this.verifications.length ? this.verifications[this.verifications.length - 1] : null;
  }

  toJSON() {
    return {
      id: this.id, title: this.title, objective: this.objective, workspace: this.workspace,
      sessionId: this.sessionId, state: this.state, reason: this.reason,
      createdAt: this.createdAt, updatedAt: this.updatedAt,
      history: this.history, processes: this.processes, verifications: this.verifications,
      observations: this.observations, artifacts: this.artifacts, agents: this.agents,
      eventCount: this.eventCount, causedBy: this.causedBy,
    };
  }

  static from(data) {
    if (!data || typeof data !== 'object') return null;
    const t = new TaskRecord({
      id: data.id, title: data.title, objective: data.objective,
      workspace: data.workspace, sessionId: data.sessionId,
    });
    t.#state = state.isState(data.state) ? data.state : state.STATE.PLANNED;
    t.reason = String(data.reason || '');
    t.createdAt = Number(data.createdAt) || t.createdAt;
    t.updatedAt = Number(data.updatedAt) || t.updatedAt;
    for (const k of ['history', 'processes', 'verifications', 'observations', 'artifacts', 'agents']) {
      t[k] = Array.isArray(data[k]) ? data[k] : [];
    }
    t.eventCount = Number(data.eventCount) || 0;
    t.causedBy = data.causedBy || null;
    return t;
  }
}

module.exports = { TaskRecord, newId, MAX_TITLE, MAX_PROCESSES, MAX_VERIFICATIONS, MAX_OBSERVATIONS };
