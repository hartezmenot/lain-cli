'use strict';

/**
 * TASK IDENTITY — the single authority.
 *
 * V1 had four of these (`diagnostic.continuationOnly`, `diagnostic.taskContinuation`,
 * `App._planResumeIntent`, `TaskLifecycle.classifyPrompt`) and they disagreed.
 * One of them was anchored only at the start, so a pasted block beginning with
 * `continue;` was read as an instruction to resume.
 *
 * Everything that needs to know "is this the same task?" calls `classify()` and
 * consumes the verdict. Nothing re-interprets the raw input.
 *
 * THE RULES, in priority order:
 *   1. A PASTE IS NEVER A CONTROL WORD. The terminal told us structurally that
 *      this is content. No amount of "continue" at the top changes that.
 *   2. Multi-line input is never a control word either — same reason, weaker
 *      signal, for terminals that do not bracket pastes.
 *   3. A short, exact continuation phrase continues the ACTIVE task. With no
 *      active task it is a new task (there is nothing to continue).
 *   4. A restatement of the active objective is the SAME task, not a new one.
 *      This is what stops evidence being thrown away every time a user rephrases.
 *   5. Anything else with an active task is a STEER: it adjusts the current work
 *      without discarding it.
 *   6. Anything else is a new task.
 *
 * Session boundaries are NOT crossed here. `/resume` is the only thing that does
 * that, and it is a command, not a classification.
 */

const KIND = Object.freeze({
  NEW: 'new',
  CONTINUATION: 'continuation',
  RESTATEMENT: 'restatement',
  STEER: 'steer',
  CONTENT: 'content',
});

/** Exact, whole-input phrases that mean "carry on". Anchored at BOTH ends. */
const CONTINUE_RE = /^(?:continue|continue the previous task|continue please|keep working|keep going|carry on|go on|go ahead|proceed|resume|next|next step|and\?|\?)[.!]?$/i;

/** Words that carry no information about WHICH objective is meant. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'at', 'for',
  'it', 'its', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'please', 'can', 'you',
  'why', 'how', 'what', 'when', 'where', 'and', 'but', 'or', 'not', 'with', 'me', 'i',
  'still', 'again', 'now', 'then', 'so', 'do', 'does', 'did', 'have', 'has', 'had',
  'fix', 'make', 'add', 'change', 'update', 'get', 'use',
]);

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Jaccard overlap of content words. Deliberately crude, and the asymmetry is
 * deliberate too: a false "same task" costs one preserved evidence set, while a
 * false "new task" throws away everything already learned — which is the failure
 * this file exists to prevent.
 */
function objectiveOverlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const RESTATEMENT_THRESHOLD = 0.4;

/**
 * @param {string} text
 * @param {object} ctx
 *   isPaste     — the terminal said this was pasted
 *   activeTask  — { objective } or null
 * @returns {{kind, reason, sameTask:boolean}}
 */
function classify(text, ctx = {}) {
  const raw = String(text == null ? '' : text);
  const trimmed = raw.trim();
  const active = ctx.activeTask || null;
  const multiline = raw.includes('\n');

  if (ctx.isPaste) {
    return {
      kind: KIND.CONTENT, sameTask: Boolean(active),
      reason: 'the terminal reported this as pasted content, so it is never a control word',
    };
  }
  if (multiline) {
    return {
      kind: KIND.CONTENT, sameTask: Boolean(active),
      reason: 'multi-line input is content, not a control word',
    };
  }
  if (CONTINUE_RE.test(trimmed)) {
    return active
      ? { kind: KIND.CONTINUATION, sameTask: true, reason: 'exact continuation phrase with an active task' }
      : { kind: KIND.NEW, sameTask: false, reason: 'continuation phrase but there is no active task to continue' };
  }
  if (active && objectiveOverlap(active.objective, trimmed) >= RESTATEMENT_THRESHOLD) {
    return { kind: KIND.RESTATEMENT, sameTask: true, reason: 'restates the active objective' };
  }
  if (active) {
    return { kind: KIND.STEER, sameTask: true, reason: 'new instruction while a task is active — adjusts it, does not replace it' };
  }
  return { kind: KIND.NEW, sameTask: false, reason: 'no active task' };
}

/**
 * The current task. Owned by the session; there is no module-level state and no
 * second place that tracks "what are we doing".
 */
class Task {
  constructor(objective) {
    this.objective = String(objective || '');
    this.startedAt = new Date().toISOString();
    this.steers = [];        // [{ text, at }]
    this.turnIds = [];
    /**
     * HOW MANY TIMES SOMEBODY WENT OUTSIDE ABOUT THIS TASK.
     *
     * Declared here rather than stuck on the object by whoever needed it,
     * because `toJSON` is an allowlist: an ad-hoc `_externalConsults` was set
     * correctly, read correctly, and then silently dropped on save — so a
     * `--resume` came back believing no consultation had ever happened, and the
     * one thing that stops a chain of second opinions is the memory that there
     * already was one.
     */
    this.externalConsults = 0;
  }

  /** One more outside opinion on this task. See externalrequest.consultedOn. */
  consultedExternally() { this.externalConsults += 1; return this; }

  steer(text) {
    this.steers.push({ text: String(text), at: new Date().toISOString() });
    return this;
  }

  toJSON() {
    return {
      objective: this.objective, startedAt: this.startedAt,
      steers: this.steers, turnIds: this.turnIds,
      externalConsults: this.externalConsults,
    };
  }

  static from(data) {
    if (!data || typeof data !== 'object') return null;
    const t = new Task(data.objective);
    t.startedAt = data.startedAt || t.startedAt;
    t.steers = Array.isArray(data.steers) ? data.steers : [];
    t.turnIds = Array.isArray(data.turnIds) ? data.turnIds : [];
    t.externalConsults = Number(data.externalConsults) || 0;
    return t;
  }
}

module.exports = { KIND, classify, objectiveOverlap, tokens, Task, CONTINUE_RE, RESTATEMENT_THRESHOLD };
