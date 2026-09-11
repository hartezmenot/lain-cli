'use strict';

/**
 * WHAT IS HAPPENING, AS NAMED FACTS — the contract a companion renders.
 *
 * THE PROBLEM THIS SOLVES. LAIN mirrored one thing into the Probe window: the
 * model's final prose, through `session.say`. So a companion that wanted to show
 * "what is LAIN doing right now" had to RECONSTRUCT it from transcript text —
 * guess from wording whether a tool was running, whether a question was open,
 * whether the task had finished. the design forbids exactly that, and it
 * is right to: a second reader inferring state from prose is a second state
 * machine, and it will disagree with the first one.
 *
 * So the events are named, LAIN owns them, and a companion renders them. There
 * is ONE source of truth and it is this side.
 *
 * WHAT THIS IS NOT:
 *
 *   · not a second task state — every payload is read from state that already
 *     exists at the moment it is emitted, and nothing here computes progress,
 *     decides completion or holds an opinion
 *   · not a control channel — a subscriber cannot answer, cancel or steer
 *   · not a transcript — prose lives in the session; these are facts about it
 *   · not a timer — nothing polls, and an event exists only because something
 *     genuinely happened
 *
 * A SUBSCRIBER THAT THROWS MUST NOT BREAK A TURN. A companion window is a
 * convenience; the work is not. Every handler is called inside a try, and a
 * broken one is dropped rather than allowed to take the turn down with it.
 */

/**
 * THE VOCABULARY. Exactly the names in and nothing invented
 * beside them — a companion written against this list is written against all of
 * it, and a name that appears in one place and not the other is the drift this
 * exists to prevent.
 */
const EVENT = Object.freeze({
  TASK_STARTED: 'task.started',
  TASK_PROGRESS: 'task.progress',
  MODEL_THINKING: 'model.thinking',
  MODEL_TOOL_CALL: 'model.tool_call',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  QUESTION_PRESENTED: 'question.presented',
  QUESTION_RESOLVED: 'question.resolved',
  JOB_STARTED: 'job.started',
  JOB_COMPLETED: 'job.completed',
  VISUAL_PRESENTED: 'visual.presented',
  VISUAL_JUDGED: 'visual.judged',
  WAITING_FOR_USER: 'waiting_for_user',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',

  // ---- THE HARNESS VOCABULARY -------------------------------------------
  //
  // ONE BUS, NOT TWO. The Task Runtime (src/harness/) needed named facts for
  // exactly the reason the block above exists: a second reader that infers
  // "is it verifying?" from prose is a second state machine, and it will
  // disagree with the first one. The temptation was a `harness/events.js`
  // with its own emitter, its own subscriber list and its own trimming — and
  // then a companion would have to attach to two channels and merge them in
  // arrival order, which is the drift this file was written to prevent.
  //
  // So the names live here, beside the ones that were already here, and the
  // rule above still holds: an unknown name is REFUSED, and a subscriber that
  // throws is dropped rather than allowed to take the turn down.
  //
  // THESE ARE STILL NOT A STATE MACHINE. Every payload is read from state
  // that already exists at the moment it is emitted. `task.state` REPORTS a
  // transition that src/harness/state.js already decided and the runtime
  // already applied; it never causes one, and nothing subscribed to it may.
  TASK_CREATED: 'task.created',
  TASK_PAUSED: 'task.paused',
  TASK_RESUMED: 'task.resumed',
  TASK_CANCELLED: 'task.cancelled',
  TASK_STATE: 'task.state',

  AGENT_STARTED: 'agent.started',
  AGENT_COMPLETED: 'agent.completed',
  AGENT_FAILED: 'agent.failed',

  TOOL_FAILED: 'tool.failed',

  PROCESS_STARTED: 'process.started',
  PROCESS_STOPPED: 'process.stopped',
  PROCESS_FAILED: 'process.failed',
  PROCESS_HEALTH: 'process.health',

  BROWSER_STARTED: 'browser.started',
  BROWSER_OBSERVED: 'browser.observed',
  BROWSER_ERROR: 'browser.error',
  BROWSER_CLOSED: 'browser.closed',

  VERIFICATION_STARTED: 'verification.started',
  VERIFICATION_PASSED: 'verification.passed',
  VERIFICATION_FAILED: 'verification.failed',
  VERIFICATION_INCONCLUSIVE: 'verification.inconclusive',

  OBSERVATION_MADE: 'observation.made',
  ARTIFACT_CREATED: 'artifact.created',

  APPROVAL_REQUIRED: 'approval.required',
  APPROVAL_RESOLVED: 'approval.resolved',

  RECOVERY_STARTED: 'recovery.started',
  HOOK_RAN: 'hook.ran',

  // ---- A CHAT MODEL SOURCE THAT IS NOT LAIN'S OWN RUNTIME ----------------
  //
  // NOT A SECOND BUS. These are names in THIS vocabulary, delivered by THIS
  // EventBus, subject to the same refusal of an unknown name — which is the
  // whole reason they are declared here rather than in the model-source
  // package. A website-backed model is slower than an API by a wide margin and
  // most of that time is spent waiting on a page, so a companion that cannot
  // distinguish CONNECTING from WAITING has nothing to draw for a minute.
  //
  // Every one of them is emitted from the point in src/modelsource where it
  // becomes true, never inferred from a timer. See modelsource/activity.js.
  WEB_MODEL_CONNECTING: 'webmodel.connecting',
  WEB_MODEL_AUTH_REQUIRED: 'webmodel.auth_required',
  WEB_MODEL_DISCOVERING: 'webmodel.discovering',
  WEB_MODEL_READY: 'webmodel.ready',
  WEB_MODEL_SENDING: 'webmodel.sending',
  WEB_MODEL_WAITING: 'webmodel.waiting',
  WEB_MODEL_RECEIVING: 'webmodel.receiving',
  WEB_MODEL_RATE_LIMITED: 'webmodel.rate_limited',
  WEB_MODEL_FAILED: 'webmodel.failed',
  WEB_MODEL_CANCELLED: 'webmodel.cancelled',
});

const NAMES = Object.freeze(Object.values(EVENT));
const KNOWN = new Set(NAMES);

/** How many events are kept for a companion that connects late. Bounded, like everything. */
const MAX_KEPT = 200;
/** No payload field is worth more than this to a window that is drawing it. */
const MAX_FIELD = 2000;

/**
 * Trim one payload to what a companion can actually use.
 *
 * A tool result can be a megabyte, and a companion window drawing a status line
 * needs a sentence of it. Bounding here rather than at each call site means no
 * emitter can accidentally push a screenshot through the event channel.
 */
function trim(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') out[k] = v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 12).map((x) => String(x).slice(0, 200));
    else out[k] = String(v).slice(0, MAX_FIELD);
  }
  return out;
}

class EventBus {
  constructor() {
    this._handlers = [];
    this._kept = [];
    /** Emitted but never delivered, because a handler threw. Reported, not hidden. */
    this.dropped = 0;
  }

  /**
   * Subscribe. Returns a function that unsubscribes — a companion that
   * disconnects must be able to stop being called, or every reconnect leaks a
   * handler that draws to a window nobody is looking at.
   */
  on(fn) {
    if (typeof fn !== 'function') return () => {};
    this._handlers.push(fn);
    return () => {
      const at = this._handlers.indexOf(fn);
      if (at >= 0) this._handlers.splice(at, 1);
    };
  }

  /**
   * State a fact. Unknown names are REFUSED rather than forwarded.
   *
   * A typo'd event name is a companion that silently never shows something, and
   * that is indistinguishable from the feature not working. The contract is the
   * list above; anything else is a bug on this side and says so.
   *
   * @returns {object|null} the event as it was delivered, or null if refused.
   */
  emit(name, payload = {}) {
    const type = String(name || '');
    if (!KNOWN.has(type)) return null;
    const ev = { type, at: Date.now(), ...trim(payload) };
    this._kept.push(ev);
    if (this._kept.length > MAX_KEPT) this._kept.splice(0, this._kept.length - MAX_KEPT);
    for (const fn of [...this._handlers]) {
      // A COMPANION WINDOW IS A CONVENIENCE; THE WORK IS NOT. A subscriber that
      // throws is dropped from the count and the turn carries on.
      try { fn(ev); } catch { this.dropped++; }
    }
    return ev;
  }

  /** What has happened, oldest first — for a companion that connected late. */
  recent(limit = MAX_KEPT) {
    const n = Math.max(0, Math.min(Number(limit) || MAX_KEPT, MAX_KEPT));
    return this._kept.slice(-n);
  }

  /** The most recent event of a kind, or null. */
  last(name) {
    for (let i = this._kept.length - 1; i >= 0; i--) {
      if (this._kept[i].type === name) return this._kept[i];
    }
    return null;
  }

  clear() { this._kept.length = 0; }
}

/**
 * A BUS THAT IS ALWAYS THERE, even when the app is not.
 *
 * Tools are called with whatever context their caller has — the turn loop
 * passes a whole App, and a unit test passes the three fields the tool reads.
 * An emitter that assumed `app.events` turned "this tool works in isolation"
 * into a TypeError, which is a real fragility and not only a test artefact: a
 * companion channel is a convenience, and nothing may fail because it is
 * absent.
 *
 * So a missing bus is a bus that swallows. Nothing is queued, nothing is
 * remembered, and nothing throws.
 */
const NULL_BUS = Object.freeze({
  emit() { return null; },
  on() { return () => {}; },
  recent() { return []; },
  last() { return null; },
  clear() {},
});

function busOf(app) {
  return (app && app.events) || NULL_BUS;
}

module.exports = { EVENT, NAMES, KNOWN, EventBus, MAX_KEPT, MAX_FIELD, trim, busOf, NULL_BUS };
