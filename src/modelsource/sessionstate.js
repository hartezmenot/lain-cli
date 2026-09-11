'use strict';

/**
 * WHAT A SESSION REMEMBERS ABOUT ITS CHAT MODEL SOURCES.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT THIRTY LINES INSIDE session.js.
 *
 * The same seam `plan`, `lifecycle`, `evidence` and the external ledger already
 * sit on: each owns its own fields, its own `toJSON` and its own `from`, and
 * `Session` composes them. session.js is the CONVERSATION and the context
 * window; which website a person is consulting is not that subject, and putting
 * it inline pushed that file against the god-object guard — which is the guard
 * doing its job rather than an inconvenience to route around.
 *
 * ------------------------------------------------------------------------
 * THREE FIELDS, AND EACH EARNS ITS PLACE.
 *
 *   chatSource        the source answering chat turns. `null` means LAIN's own
 *                     runtime — which is what every session already did, so a
 *                     session file written before web sources existed restores
 *                     to exactly the behaviour it had.
 *
 *   sourceSelections  the model chosen FOR EACH source, kept apart. Going
 *                     ChatGPT -> Gemini -> ChatGPT returns to the ChatGPT model
 *                     already picked rather than asking again; and when that
 *                     model is gone from the account the person is TOLD, rather
 *                     than being moved silently onto another one whose answers
 *                     they would attribute to the first.
 *
 *   providerBindings  which website conversation is THIS session's, per source.
 *                     Opaque and owned. See binding.js for the crossover it
 *                     prevents — the one failure in this area that is completely
 *                     invisible when it happens.
 *
 * ------------------------------------------------------------------------
 * SESSION STATE RATHER THAN CONFIG. A session is one piece of work on one
 * project. Consulting ChatGPT.com about toradb's checkout and Gemini about
 * lain-v2's router are two conversations that must not adopt each other's
 * source, model or thread — and config is process-wide, so a selection kept
 * there would be shared by every session at once.
 *
 * NOTHING SECRET IS HELD OR WRITTEN. Ids, model names and stamps. Never a
 * cookie, never a page, never the words said in a website thread.
 */

const binding = require('./binding');

/** Give a fresh session its defaults. Called from the Session constructor. */
function attach(session) {
  session.chatSource = null;
  session.sourceSelections = {};
  session.providerBindings = {};
  return session;
}

/** What goes into the session file. */
function toJSON(session) {
  return {
    chatSource: (session && session.chatSource) || null,
    sourceSelections: (session && session.sourceSelections) || {},
    providerBindings: binding.toJSON(session),
  };
}

/**
 * Put it back on a resumed session.
 *
 * A session saved before any of this existed has none of these keys, and the
 * defaults are the TRUE answer for it rather than a fallback: it was using
 * LAIN's own runtime, it had picked nothing per source, and no website thread
 * was ever bound to it.
 */
function restore(session, data = {}) {
  const d = data && typeof data === 'object' ? data : {};
  session.chatSource = d.chatSource || null;
  session.sourceSelections = (d.sourceSelections && typeof d.sourceSelections === 'object')
    ? { ...d.sourceSelections } : {};
  session.providerBindings = binding.from(d.providerBindings);
  return session;
}

module.exports = { attach, toJSON, restore };
