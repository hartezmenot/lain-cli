'use strict';

/**
 * TOO MANY MESSAGES — the one refusal that has a fix, and how far to apply it.
 *
 * Split out of turn.js, which had reached the god-object guard. The seam is
 * real: the turn loop decides WHETHER to act on a failure; this decides HOW FAR
 * to fold and what to say about it. It touches no provider and starts nothing.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL. Reported live on 2026-08-22: omniroute answered 413
 * `chat_history_too_large / message_limit` — "Chat history exceeds the
 * 800-message limit; compact the conversation and retry." LAIN compacted,
 * truthfully said "Nothing to elide — 291k chars", and was refused again on
 * every following request. Compaction only ever shortened BODIES, and a
 * thousand short messages are still a thousand messages, so the one tool built
 * to rescue the session had no lever on the limit it had hit.
 *
 * THIS IS NOT THE TRANSPORT RETRY and must never be folded into it. The request
 * is not re-sent unchanged: the conversation is made SMALLER first, and only if
 * that actually removed messages is anything sent again.
 */

/**
 * A margin under the provider's stated cap, for the messages this step is about
 * to add — the assistant turn and its tool results.
 */
const MARGIN = 8;
/** Never fold below this, whatever the arithmetic says. */
const FLOOR = 8;
/**
 * How much to keep when we have to pick a size ourselves — see `capFor`.
 * Enough to be a real reduction, not so much that the task loses its thread.
 */
const SELF_FRACTION = 0.6;

/**
 * HOW FAR TO FOLD, WHEN THE TWO COUNTS DISAGREE.
 *
 * The provider just stated its cap, so believe it — but do not assume it counts
 * the way LAIN counts. LAIN sends `[system, ...messages]`, and a provider
 * keeping its own history may count pairs, or count messages this session never
 * sent.
 *
 * THE BUG THIS FIXES, seen live: the refusal said "exceeds the 800-message
 * limit" while `session.messages.length` was BELOW 800, so the cap was already
 * satisfied, the fold removed nothing, and LAIN retried into the identical wall
 * and reported the identical 413 — having just announced that it was folding.
 *
 * So when the provider says we are over and our own count says we are not, the
 * provider wins: fold to a real fraction of what we hold. A refusal is evidence
 * about the request; our count is only a belief about it.
 *
 * @param {number} own     how many messages the session holds
 * @param {number} stated  the cap the provider named, or 0 if it named none
 */
function capFor(own, stated) {
  const held = Math.max(0, Number(own) || 0);
  const said = Math.max(0, Number(stated) || 0);
  let cap = said ? Math.max(FLOOR, said - MARGIN) : Math.floor(held / 2);
  if (cap >= held) cap = Math.max(FLOOR, Math.floor(held * SELF_FRACTION));
  return cap;
}

/** What to say once a fold has actually removed something. */
function foldedMessage(fold, stated, cap) {
  return `The provider refused ${fold.beforeMessages} messages (its limit is `
    + `${stated || cap}). ${fold.folded} of the oldest were folded into one summary — `
    + `${fold.afterMessages} are being sent now. Their text is still in the session and `
    + 'on screen; it is no longer in the request.';
}

/**
 * What to say when nothing could be folded.
 *
 * THIS PATH USED TO SAY NOTHING AT ALL, and that was the defect: the notice
 * before the fold sets `working`, which holds the panel busy until a later
 * notice clears it — and there was no later notice here. The screen sat on
 * "working …" under a failed fold, permanently. An announcement with no outcome
 * is worse than silence, because it says something is happening and then
 * nothing ever contradicts it.
 */
function stuckMessage(remaining) {
  return `nothing could be folded — ${remaining} messages, and all of them are either `
    + 'the objective or the step in flight. /compact, or switch provider.';
}

module.exports = { capFor, foldedMessage, stuckMessage, MARGIN, FLOOR, SELF_FRACTION };
