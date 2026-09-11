'use strict';

/**
 * CHAT OR CODING — one question, answered from the classifier that already
 * exists.
 *
 * ------------------------------------------------------------------------
 * THERE IS NO NEW CLASSIFIER HERE, AND THERE MUST NOT BE.
 *
 * mode.js already reads a sentence and says what kind of work it is, locally,
 * deterministically, for free. It also already knows which of its modes are
 * READ-ONLY — that set is declared at the top of that file and is what stops an
 * explanation request from writing to somebody's repository.
 *
 * The lane is that same fact, read out loud:
 *
 *     READ-ONLY mode   -> CHAT      answer it; touch nothing
 *     everything else  -> CODING    LAIN's runtime owns it
 *
 * That is a projection, not a second opinion, and it CANNOT disagree with
 * mode.js because it is computed from mode.js's own set. An LLM classifier here
 * would be a model call to decide how to spend model calls; a second regex table
 * would be the four-continuation-classifiers defect in a new subject.
 *
 * ------------------------------------------------------------------------
 * WHAT THE LANE DECIDES, AND WHAT IT EXPLICITLY DOES NOT.
 *
 * It decides WHO ANSWERS a turn when a web chat source is selected. It does NOT
 * decide what the turn is allowed to do: a CODING turn runs `turn.js` with the
 * tool registry, the permission gate, the checkpoints and the verification
 * contract exactly as it always has, whatever chat source happens to be chosen.
 *
 * So the invariant is short: SELECTING ChatGPT.com CHANGES WHO ANSWERS A
 * QUESTION. IT NEVER CHANGES WHO WRITES A FILE.
 */

const mode = require('../mode');

const LANE = Object.freeze({ CHAT: 'CHAT', CODING: 'CODING' });

/**
 * Which lane a mode belongs to.
 *
 * `mode.READ_ONLY` is the source of truth and is imported rather than copied.
 * If a mode is added to it, this follows automatically; if this file listed the
 * modes itself, the day somebody added one would be the day the two disagreed.
 */
function forMode(m) {
  return mode.READ_ONLY.has(String(m || '')) ? LANE.CHAT : LANE.CODING;
}

/**
 * The lane for a verdict from identify.js.
 *
 * A verdict is consumed rather than the raw text re-read — the same discipline
 * every other consumer of the classifier follows.
 */
function forVerdict(verdict) {
  return {
    lane: forMode(verdict && verdict.mode),
    mode: (verdict && verdict.mode) || null,
    reason: (verdict && verdict.modeReason) || '',
    // STATED SO A FRONTEND CAN SHOW IT. "Why did this go to LAIN instead of
    // ChatGPT" is a question a person will have the first time it happens, and
    // the answer is one sentence the classifier already produced.
    deterministic: true,
  };
}

module.exports = { LANE, forMode, forVerdict };
