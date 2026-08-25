'use strict';

/**
 * A BUDGET IS NOT A CEILING, AND CONFUSING THE TWO IS THE WHOLE DEFECT.
 *
 * ------------------------------------------------------------------------
 * WHAT WAS THERE BEFORE. `session.budgetChars(pc)` answers one question:
 *
 *     how much conversation can this provider physically accept?
 *
 * For a 200k-token model that is 676,108 characters — about 188,000 tokens of
 * transcript before a single byte is elided. It was the only number in the
 * system, and `contextfit` compacted against it. So compaction was unreachable
 * in ordinary use: a session had to fill the entire context window before any
 * of the careful, information-aware folding in `session.compact` ran even once.
 *
 * By the time it fires you have already paid. The cost of a large transcript is
 * not paid when it finally exceeds the window — it is paid on EVERY REQUEST
 * that carried it there, and there are dozens of those on the way up.
 *
 * ------------------------------------------------------------------------
 * SO THERE ARE TWO NUMBERS NOW, and they answer different questions.
 *
 *   CEILING   what the provider will refuse.        session.budgetChars
 *             Used to decide whether a request can be sent at all.
 *
 *   BUDGET    what a request SHOULD cost.           this file
 *             Used to decide whether to compact before sending.
 *
 * The budget is far below the ceiling on purpose. A coding turn that genuinely
 * needs 180,000 characters of history is rare; one that has merely accumulated
 * that much is the normal case, and the difference between them is exactly what
 * `session.compact` already knows how to tell apart — it stubs completed tool
 * results and leaves the recent working set whole.
 *
 * ------------------------------------------------------------------------
 * THIS ADDS NO NEW TRUNCATION. That matters, and it is the reason this file is
 * thirty lines rather than three hundred.
 *
 * Every mechanism that decides WHAT to drop already existed and was already
 * careful: the objective is never touched, the recent working set keeps its
 * full bodies, a completed tool result becomes a stub that names the call and
 * says to re-run it, and nothing is deleted from the saved session. All that
 * was missing was a number low enough for any of it to happen.
 *
 * Lowering a threshold so that existing information-aware compaction runs is
 * the opposite of `context[-50000:]`.
 */

const { CHARS_PER_TOKEN } = require('./session');

/**
 * THE DEFAULT WORKING BUDGET, in tokens of conversation.
 *
 * 50,000 is an engineering target rather than a discovered constant: it is
 * comfortably above what a focused coding turn needs — a dozen files, their
 * edits, the test output and the reasoning around them — and far below the
 * point at which a request becomes expensive enough to matter. A turn that
 * wants more is not refused; it compacts and carries on.
 *
 * Deliberately NOT scaled to the provider's window. A 1M-token model does not
 * make a 900k-token request a good idea, and scaling to the window is precisely
 * how the ceiling came to be used as a budget in the first place.
 */
const DEFAULT_BUDGET_TOKENS = 50_000;

/** Below this, compaction cannot help enough to be worth the history it costs. */
const MIN_BUDGET_TOKENS = 8_000;

/**
 * The working budget in CHARACTERS, for this route and this config.
 *
 * Never above the ceiling: on a small-window model the provider's limit is the
 * binding constraint and asking for more than it accepts would be a budget that
 * permits a refused request.
 *
 * @param {object} pc   the resolved provider
 * @param {object} cfg  `contextBudgetTokens` overrides the default
 */
function charsFor(pc, cfg = {}) {
  const env = Number(process.env.LAIN_CONTEXT_BUDGET_TOKENS);
  const set = Number(cfg && cfg.contextBudgetTokens);
  const want = Number.isFinite(env) && env > 0 ? env
    : (Number.isFinite(set) && set > 0 ? set : DEFAULT_BUDGET_TOKENS);
  const budget = Math.max(MIN_BUDGET_TOKENS, want) * CHARS_PER_TOKEN;
  const ceiling = require('./session').budgetChars(pc);
  return Math.floor(Math.min(budget, ceiling));
}

/**
 * WHAT TO DO ABOUT A REQUEST OF THIS SIZE — named, so it can be reported.
 *
 * `SEND` and `COMPACT` are the two ordinary answers. `OVER` is the third and it
 * is not a failure: a payload that is still above budget after compaction is a
 * turn whose CURRENT working set is genuinely large — one read of a very big
 * file will do it — and the honest response is to send it and say so, not to
 * cut into the material the model is working from right now.
 */
const ACTION = Object.freeze({ SEND: 'SEND', COMPACT: 'COMPACT', OVER: 'OVER' });

function decide(chars, budget) {
  if (!budget || chars <= budget) return { action: ACTION.SEND, chars, budget, over: 0 };
  return { action: ACTION.COMPACT, chars, budget, over: chars - budget };
}

module.exports = { charsFor, decide, ACTION, DEFAULT_BUDGET_TOKENS, MIN_BUDGET_TOKENS };
