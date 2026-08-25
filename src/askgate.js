'use strict';

/**
 * ask_user IS A BOUNDARY, NOT A TOOL THAT HAPPENS TO PAUSE.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR, found by reading the execution loop rather than
 * by a failing test.
 *
 * A model step may contain several tool calls, and turn.js ran every one of
 * them in order. `ask_user` blocks inside that loop until the person answers —
 * and then the loop CARRIED ON to the calls behind it. So a model that emitted
 *
 *     ask_user("Rewrite the loader, or keep it and add a shim?")
 *     apply_patch(src/loader.js, <the rewrite>)
 *
 * asked the question and performed the rewrite anyway. That is the reported
 * behaviour — "it says 'can I ask the user?' and then does the work regardless"
 * — and it is not the model being disobedient. Both calls were emitted in one
 * breath, so the second one was DECIDED BEFORE THE ANSWER EXISTED. It cannot be
 * a response to it.
 *
 * ------------------------------------------------------------------------
 * THE RULE, and it follows from that sentence alone:
 *
 *     EVERYTHING AFTER AN ask_user IN THE SAME STEP IS PRE-DECIDED.
 *
 * So it does not run. It is not silently dropped either — each deferred call
 * comes back as an ordinary tool result saying why, which puts the fact in the
 * conversation where the model can act on it. With the answer now in hand the
 * model decides again, and the call it makes next is a real response to a real
 * decision rather than a guess that happened to be in flight.
 *
 * WHAT IT DOES NOT DO. It does not stop the model asking, does not limit how
 * many questions a task may contain, does not reorder anything, and does not
 * touch a step with no question in it — which is almost every step, and pays
 * one array scan for the privilege.
 *
 * A question asked LAST in its own step is unaffected: there is nothing behind
 * it to defer, which is also the shape a well-behaved model produces.
 */

/** The one call that ends a step early. */
const ASK = 'ask_user';

/**
 * Split a step's calls at the question.
 *
 * @param {Array} calls  the normalized calls of one step, in order
 * @returns {{run: Array, deferred: Array}}
 *   `run` is everything up to and including the first question; `deferred` is
 *   everything behind it, which was decided before the answer existed.
 */
function cut(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const at = list.findIndex((c) => c && c.name === ASK);
  if (at < 0 || at === list.length - 1) return { run: list, deferred: [] };
  return { run: list.slice(0, at + 1), deferred: list.slice(at + 1) };
}

/**
 * What a deferred call is told.
 *
 * Addressed to the model, and it says the REASON rather than just the refusal:
 * "not run" invites a retry of the same call, while "you decided this before
 * you had the answer" invites the model to decide again — which is the whole
 * point of having asked.
 */
function deferredResult(call) {
  const name = (call && call.name) || 'this call';
  return `NOT RUN — \`${name}\` was requested in the same step as your question, so it was `
    + 'decided before the answer existed and cannot be a response to it. '
    + 'The answer is above. Decide again with it in hand, and call whatever it actually implies.';
}

/**
 * Answer every deferred call, so the conversation has no dangling half.
 *
 * EVERY tool_call NEEDS A RESULT. An OpenAI-shaped API rejects an assistant
 * message whose calls are not all answered, and the calls were already
 * persisted with the assistant turn before any of them ran — so skipping one
 * silently would not merely lose information, it would make the NEXT request a
 * 400. The refusal has to be spoken in the protocol's own vocabulary.
 *
 * Returns how many were answered, so the caller can record it.
 */
function answerDeferred(session, deferred) {
  const list = Array.isArray(deferred) ? deferred : [];
  for (const c of list) {
    session.messages.push({
      role: 'tool',
      tool_call_id: c.id,
      content: deferredResult(c),
      isError: false,
      ts: new Date().toISOString(),
    });
  }
  return list.length;
}

module.exports = { cut, deferredResult, answerDeferred, ASK };
