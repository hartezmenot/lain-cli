'use strict';

/**
 * THE TASK STATE MACHINE — eight states, and the legal moves between them.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT lifecycle.js, AND WHY NEITHER ONE ABSORBS THE OTHER.
 *
 * `src/lifecycle.js` answers a question about the CONVERSATION: is the model
 * still moving, is it narrating, is it repeating itself, did it ask the person
 * for something. Its states — ACTIVE / DONE / BLOCKED / NEEDS_USER /
 * NEEDS_AUTH / FAILED — are observations of a turn loop.
 *
 * This answers a question about the WORK: has it been planned, is it running,
 * is it being verified, and did the EVIDENCE come back green. Its states are
 * facts about a task record that outlives any one turn and any one session.
 *
 * Merging them was tried on paper and is wrong in both directions. A task can
 * be VERIFYING while the model is DONE talking — that is the entire point of an
 * evidence-driven harness. And a task can be RUNNING across four turns, three
 * provider deaths and a model switch, which no per-turn lifecycle can express.
 *
 * So: lifecycle observes the loop; this records the work. `fromLifecycle` is
 * the ONE bridge, and it is a read — this module CONSUMES lifecycle's verdict
 * and never re-derives it from raw text.
 *
 * ------------------------------------------------------------------------
 * THE RULE THIS FILE OBEYS, which is the project's oldest one:
 *
 *     OBSERVE != JUDGE.  A COUNTER MAY NOT REACH A VERDICT.
 *
 * There is no threshold in this file. Nothing here counts turns, steps,
 * retries or seconds and then writes a terminal state because a number got big
 * enough. Every transition is CAUSED by a named fact somebody else established:
 * a verification verdict, a user cancellation, a process that died. That is
 * what makes completion deterministic rather than atmospheric.
 *
 * ------------------------------------------------------------------------
 * WHY EIGHT STATES AND NOT `running` / `done`.
 *
 *   PLANNED        it exists and is scoped; nothing has executed
 *   RUNNING        execution is happening
 *   BLOCKED        it cannot proceed without something outside itself
 *                  (an approval, a credential, an answer from the person)
 *   VERIFYING      execution stopped and the evidence is being gathered
 *   PASSED         every REQUIRED piece of evidence passed
 *   FAILED         a required piece of evidence FAILED
 *   INCONCLUSIVE   a required piece of evidence is MISSING — nothing proved
 *                  the work wrong, and nothing proved it right
 *   CANCELLED      a person stopped it
 *
 * INCONCLUSIVE is the state the whole design turns on. Collapsed into `done`
 * it becomes a false pass; collapsed into `failed` it becomes a false alarm
 * that teaches people to ignore the harness. "The browser never started, so
 * the browser flow was never checked" is neither of those, and it is by far
 * the most common real outcome.
 */

const STATE = Object.freeze({
  PLANNED: 'PLANNED',
  RUNNING: 'RUNNING',
  BLOCKED: 'BLOCKED',
  VERIFYING: 'VERIFYING',
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  INCONCLUSIVE: 'INCONCLUSIVE',
  CANCELLED: 'CANCELLED',
});

const NAMES = Object.freeze(Object.values(STATE));

/**
 * States in which the task is over and its record will not change again.
 *
 * FAILED IS TERMINAL AND RECOVERY IS NOT AN EXCEPTION TO THAT. A failed task
 * that gets fixed does not quietly become PASSED — the runtime opens a REPAIR
 * task with the failed one named as its cause, so the flight recorder keeps
 * both. A state that can be walked back is a state nobody can cite.
 */
const TERMINAL = Object.freeze(new Set([
  STATE.PASSED, STATE.FAILED, STATE.INCONCLUSIVE, STATE.CANCELLED,
]));

/** The task reached a verdict about the work itself, rather than being stopped. */
const VERDICT = Object.freeze(new Set([STATE.PASSED, STATE.FAILED, STATE.INCONCLUSIVE]));

/**
 * THE LEGAL MOVES. Anything not listed is refused, with the reason named.
 *
 * The refusal matters more than the permission. A harness whose task can go
 * from PLANNED straight to PASSED has a hole exactly the shape of the failure
 * this project exists to stop: a model saying "done" and something believing
 * it. Reaching PASSED requires passing through VERIFYING, always, and VERIFYING
 * is only reachable from RUNNING — so no task is ever verified without having
 * executed, and no task is ever passed without having been verified.
 */
const MOVES = Object.freeze({
  [STATE.PLANNED]: Object.freeze([STATE.RUNNING, STATE.BLOCKED, STATE.CANCELLED]),
  [STATE.RUNNING]: Object.freeze([STATE.BLOCKED, STATE.VERIFYING, STATE.CANCELLED, STATE.FAILED]),
  [STATE.BLOCKED]: Object.freeze([STATE.RUNNING, STATE.CANCELLED, STATE.FAILED]),
  [STATE.VERIFYING]: Object.freeze([
    STATE.PASSED, STATE.FAILED, STATE.INCONCLUSIVE, STATE.RUNNING, STATE.CANCELLED,
  ]),
  // Terminal. Named explicitly rather than left undefined, so `moves()` can
  // answer "nothing" without the caller having to know the difference between
  // "no moves" and "no such state".
  [STATE.PASSED]: Object.freeze([]),
  [STATE.FAILED]: Object.freeze([]),
  [STATE.INCONCLUSIVE]: Object.freeze([]),
  [STATE.CANCELLED]: Object.freeze([]),
});

/**
 * VERIFYING -> RUNNING is deliberate and is the recovery seam.
 *
 * A contract that comes back red does not have to end the task. The runtime may
 * decide to repair and re-execute, and that is a return to RUNNING with the
 * failed verification kept in the record. What it may NOT do is go back and
 * pretend the verification never happened: `verifications` on the task record
 * appends, and nothing removes an entry.
 */

function isState(s) { return NAMES.includes(String(s)); }

function moves(from) {
  return MOVES[String(from)] || [];
}

/**
 * May the task go from `from` to `to`?
 *
 * @returns {{ok: boolean, why: string}} — `why` is written for a person, because
 *   a refused transition is shown in the CLI and on the dashboard, not only
 *   thrown at a developer.
 */
function transition(from, to) {
  if (!isState(from)) return { ok: false, why: `"${from}" is not a task state` };
  if (!isState(to)) return { ok: false, why: `"${to}" is not a task state` };
  if (from === to) return { ok: true, why: 'already there' };
  if (TERMINAL.has(from)) {
    return { ok: false, why: `the task is already ${from}, and a terminal state is never rewritten` };
  }
  if (!moves(from).includes(to)) {
    return {
      ok: false,
      why: `${from} cannot become ${to} — a task reaches ${to} only from ${
        NAMES.filter((s) => moves(s).includes(to)).join(' or ') || 'nowhere'}`,
    };
  }
  return { ok: true, why: '' };
}

/**
 * THE VERDICT MAP — a verification result becomes a task state, and this is the
 * only place that conversion happens.
 *
 * `verify.js` produces PASSED / FAILED / INCONCLUSIVE for a CONTRACT. Those
 * three words are deliberately the same three the task uses, and the mapping is
 * deliberately the identity: any cleverness here — "two inconclusive checks but
 * the build passed, call it a pass" — would be the harness forming an opinion
 * about evidence, which is exactly what it must not do.
 */
function fromVerdict(verdict) {
  const v = String(verdict || '').toUpperCase();
  if (v === 'PASSED') return STATE.PASSED;
  if (v === 'FAILED') return STATE.FAILED;
  if (v === 'INCONCLUSIVE') return STATE.INCONCLUSIVE;
  return null;
}

/**
 * THE ONE BRIDGE FROM lifecycle.js, and it is a READ.
 *
 * The turn loop knows things this module must not re-derive: that the model
 * asked the person a question, that a credential is missing, that the loop
 * genuinely failed. Those are conversation facts with task consequences.
 *
 * What is NOT mapped, on purpose:
 *
 *   lifecycle DONE -> PASSED   NEVER. `DONE` means the model stopped and the
 *                              turn's own completion gate accepted. That is a
 *                              claim about the conversation. PASSED is a claim
 *                              about evidence, and only a contract may make it.
 *                              DONE moves a RUNNING task to VERIFYING — "stop
 *                              executing and go and prove it" — which is the
 *                              single most important line in this file.
 *
 *   lifecycle ACTIVE -> null   nothing to say; a task already RUNNING stays
 *                              RUNNING and a PLANNED one is started by whoever
 *                              started the work, not by an observation of it.
 *
 * @returns {string|null} the state to move to, or null for "this says nothing".
 */
function fromLifecycle(lifecycleState) {
  switch (String(lifecycleState || '')) {
    case 'DONE': return STATE.VERIFYING;
    case 'BLOCKED': return STATE.BLOCKED;
    case 'NEEDS_USER': return STATE.BLOCKED;
    case 'NEEDS_AUTH': return STATE.BLOCKED;
    case 'FAILED': return STATE.FAILED;
    default: return null;
  }
}

/** A one-word colour for a surface that draws states. Not a judgement, a hue. */
const TONE = Object.freeze({
  [STATE.PLANNED]: 'idle',
  [STATE.RUNNING]: 'busy',
  [STATE.BLOCKED]: 'warn',
  [STATE.VERIFYING]: 'busy',
  [STATE.PASSED]: 'good',
  [STATE.FAILED]: 'bad',
  [STATE.INCONCLUSIVE]: 'warn',
  [STATE.CANCELLED]: 'idle',
});

module.exports = { STATE, NAMES, TERMINAL, VERDICT, MOVES, TONE, isState, moves, transition, fromVerdict, fromLifecycle };
