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

/**
 * ---- AND WHAT THE FOLDED MESSAGES WERE ---------------------------------
 *
 * Moved here from session.js, which had reached the god-object guard. The seam
 * is the one this file already draws: session.js decides WHEN a conversation
 * must shrink and splices the array; this module owns HOW FAR to fold and, now,
 * WHAT THE FOLD SAYS. Both halves of the folding vocabulary are in one place,
 * and neither knows anything about a Session object.
 */
/** How much of each folded USER message is reproduced verbatim. */
const FOLD_USER_KEEP = 400;
/**
 * How many folded instructions one summary lists, newest first.
 *
 * Generous on purpose - instructions are short and they are the thread. The cap
 * exists so a very long session cannot grow a summary that itself needs
 * compacting, and when it bites it SAYS SO.
 */
const FOLD_SAID_KEEP = 60;
/**
 * WHAT THE FOLDED MESSAGES WERE, built from what they ARE rather than from
 * prose a model invents about them.
 *
 * COMPACTION HAS NEVER SUMMARISED, and this does not start. A stub says which
 * call produced the output it replaced; asking a model to write a précis would
 * cost a request, could invent things that were never said, and — the decisive
 * objection — is impossible in the one situation this exists for, because the
 * provider is at that moment refusing every request as too long.
 *
 * SO IT IS DERIVED, and it keeps the half that matters. What the USER said is
 * reproduced verbatim: those are the instructions, the corrections and the
 * steers, they are short, and losing them is losing the thread. What the TOOLS
 * returned is counted by name: that is the bulk, it is reproducible by calling
 * them again, and it is why the history got too long in the first place.
 */
function foldSummary(gone) {
  const said = [];
  const calls = new Map();
  let stood = 0;
  for (const m of gone) {
    if (!m) continue;
    // ---- A PRIOR FOLD IS MERGED, NEVER SUMMARISED AGAIN ----------------
    //
    // THE DEFECT, reproduced against the real Session: a second fold found the
    // first fold's summary in `gone`, saw `role: 'user'`, and filed the whole
    // rendered blob as ONE INSTRUCTION - truncated at 400 characters, so
    // everything the user had said beyond that point was destroyed, and what
    // survived was nested inside a bullet of the new summary:
    //
    //     What you asked for, in order:
    //       - [61 earlier messages folded...] What you asked for, in order:
    //         - instruction 0 - instruction 1 - ... - instru
    //
    // A third fold would have nested that again. The count went wrong too: the
    // old summary occupied ONE array slot while standing for sixty-one real
    // messages, so the new header under-reported by sixty every time.
    //
    // MERGED FROM THE PARTS, NOT FROM THE PROSE. The summary carries `said` and
    // `calls` for exactly this, so the instructions are taken over verbatim and
    // the call tallies are added - one summary, superseding the old marker,
    // which is what the old one always claimed to be.
    if (m.elided === 'folded') {
      stood += Math.max(1, Number(m.foldedCount) || 1);
      for (const t of m.said || []) said.push(String(t));
      for (const [n, c] of Object.entries(m.calls || {})) calls.set(n, (calls.get(n) || 0) + (Number(c) || 0));
      continue;
    }
    stood += 1;
    if (m.role === 'user' && String(m.content || '').trim()) {
      said.push(String(m.content).replace(/\s+/g, ' ').trim().slice(0, FOLD_USER_KEEP));
    }
    for (const tc of m.tool_calls || []) {
      const n = String((tc && tc.name) || 'tool');
      calls.set(n, (calls.get(n) || 0) + 1);
    }
  }
  // ---- BOUNDED, AND HONEST ABOUT IT ----------------------------------
  //
  // Instructions accumulate across folds by design - they are the thread, and
  // losing them is losing it. But a session with four hundred of them would
  // grow a summary that is itself the thing needing compaction, so the list is
  // capped at the MOST RECENT, which are the ones still in force. The drop is
  // STATED rather than silent: a summary that quietly forgot the first half of
  // a conversation while claiming to hold it is worse than one that says so.
  let dropped = 0;
  if (said.length > FOLD_SAID_KEEP) {
    dropped = said.length - FOLD_SAID_KEEP;
    said.splice(0, dropped);
  }
  const tools = [...calls.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}×${c}`)
    .join(', ');
  const head = `[${stood} earlier messages folded to fit this provider's message limit. `
    + 'Their full text is still in the session and on screen — it is no longer being sent.]';
  const parts = [head];
  if (said.length) {
    const lead = dropped
      ? `What you asked for, in order (the ${dropped} oldest are no longer listed here):`
      : 'What you asked for, in order:';
    parts.push(lead + '\n' + said.map((s) => `  · ${s}`).join('\n'));
  }
  if (tools) parts.push(`Tool calls made in that stretch: ${tools}. Re-run any of them if you need the output.`);
  // THE PARTS TRAVEL WITH THE TEXT, so the next fold merges instead of parsing.
  return {
    content: parts.join('\n'),
    said,
    calls: Object.fromEntries(calls),
    foldedCount: stood,
  };
}

module.exports = { capFor, foldedMessage, stuckMessage, foldSummary, MARGIN, FLOOR, SELF_FRACTION, FOLD_USER_KEEP, FOLD_SAID_KEEP };
