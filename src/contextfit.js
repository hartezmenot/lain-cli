'use strict';

/**
 * MAKING THE REQUEST FIT, BEFORE IT IS SENT.
 *
 * Split out of turn.js, which had crossed the god-object guard again. The seam
 * is a real one: turn.js owns the LOOP — steps, tools, retries, what the model
 * said — and this owns one question asked immediately before each send:
 *
 *     will this provider accept the payload I am about to hand it?
 *
 * It knows nothing about tools, steps or the conversation's meaning. It reads
 * a session, a resolved provider and a system prompt, and returns the exact
 * array to transmit plus whatever should be said about the trimming.
 *
 * ------------------------------------------------------------------------
 * THE BUG IT WAS BUILT FROM, measured on the wire at 1,002 messages:
 *
 *     413 Payload Too Large — Chat history exceeds the 800-message limit
 *
 * The pre-flight check measured CHARACTERS and only characters. A message-count
 * cap and a token window are unrelated quantities — a thousand one-word
 * messages are tiny in tokens and over a count cap; three messages holding a
 * 400KB file are the reverse — so a payload has to pass both, separately.
 *
 * THE PROVIDER MUST NEVER BE LAIN'S CONTEXT-SIZE CALCULATOR. Sending a payload
 * already known to be over the limit costs a round trip, and the refusal
 * arrives with the whole turn's work inside the request that was rejected.
 *
 * ------------------------------------------------------------------------
 * WHAT IT WILL NOT DO. It never refuses to send. If a conversation cannot be
 * folded small enough, the request goes anyway and the notice says plainly that
 * it may be refused — a provider can accept more than it advertises, and
 * stranding the user on LAIN's arithmetic would be a worse failure than the
 * one being fixed. What it will not do is send silently.
 */

const providerLimits = require('./providerlimits');
const tokenaudit = require('./tokenaudit');

/**
 * BUILD THE EXACT ARRAY THAT WILL BE TRANSMITTED.
 *
 * The system prompt is prepended HERE rather than by the caller, because the
 * count that matters is the count the provider receives — and the array LAIN
 * used to check was one message shorter than the one it sent. On the boundary
 * that difference is a refused request.
 */
function buildWire(session, systemPrompt, live = '') {
  const head = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  // ---- THE CHANGING HALF GOES LAST --------------------------------------
  //
  // Not role `system`: the Anthropic mapping hoists every system message into
  // the cached system block, which would put the volatile text straight back
  // into the prefix this exists to protect. A trailing user turn is what both
  // protocols already accept, and provider.js merges it into a preceding
  // tool-result turn so no two user messages ever arrive in a row.
  //
  // `_live` marks it for the accounting in tokenaudit.js and for compaction,
  // which must never fold the one message describing the current state.
  const tail = live ? [{ role: 'user', content: live, _live: true }] : [];
  return [...head, ...session.messages, ...tail];
}

/**
 * FIT THE PAYLOAD, AND SAY WHAT WAS DONE TO IT.
 *
 * @param {object} session
 * @param {object} pc      the resolved provider
 * @param {object} o       { systemPrompt, cfg }
 * @returns {{wire:Array, notices:Array, compactions:number, fit:object, verdict:object}}
 *          `notices` are events for the caller to yield — this yields nothing
 *          itself, so the whole thing is testable without a turn.
 */
function fit(session, pc, { systemPrompt = '', live = '', cfg = {}, surface = 'COMPACT', tools = [] } = {}) {
  const notices = [];
  let compactions = 0;
  const authority = session.contextAuthority;
  if (!authority) throw new Error('session has no context authority');

  // ---- PASS ONE: both budgets, before the array is built ------------------
  // ---- THE BUDGET, NOT THE CEILING --------------------------------------
  //
  // WAS `sessionMod.budgetChars(pc)`, which is what the provider will ACCEPT
  // — 676,108 characters on a 200k-token model. Compacting against that meant
  // compaction never ran until the window was nearly full, and by then the
  // cost had already been paid on every request that carried the transcript
  // up there. See src/contextbudget.js for why these are two numbers.
  //
  // The ceiling is still consulted below, for the different question of
  // whether this provider will refuse the payload outright.
  const firstDecision = authority.compact(pc, cfg, { reason: 'preflight-context-pressure' });
  const first = firstDecision.result || {
    compacted: false, before: session.contextChars(), after: session.contextChars(),
    elided: 0, folded: 0, beforeMessages: session.messages.length, afterMessages: session.messages.length,
  };
  if (first.compacted) {
    compactions += 1;
    // WHAT IT DID, then WHAT SURVIVED — the second is the question a person
    // actually has when their context is rewritten mid-task. Both are checked
    // against the session as it now stands (continuity.js); neither is a
    // reassurance printed unconditionally.
    // ---- ONE CONCISE LINE, AND NOT A COMPRESSION REPORT ------------------
    //
    // IT USED TO BE THREE, and the first was 120 characters of them:
    //
    //     CONTEXT COMPACTION  84k → 31k chars — elided 42k chars of earlier
    //     tool output (nothing was deleted; re-run a call to get it back)
    //     kept: the objective · 3 corrections you made · the plan (2/5 done)
    //
    // Auto-compaction is housekeeping the user did not ask for, happening in the
    // middle of their task. What they need from it is that it happened and that
    // nothing was lost; the accounting - what was elided, what survived, how
    // close to the budget this leaves them - is `/token`, which exists and says
    // all of it properly. A reassurance paragraph printed over the work it was
    // making room for is the thing it was making room for.
    //
    // STILL NOT INTO THE CONVERSATION: the surface is transient and closes
    // itself (src/turnevents.js). Nobody said this to the model.
    const kb = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.max(0, Math.round(n))));
    notices.push({
      type: 'notice', level: 'info', surface,
      message: `Context compacted · ${kb(first.before)} → ${kb(first.after)} · nothing was deleted · /token`,
    });
  }

  // ---- PASS TWO: measure what is ACTUALLY going out -----------------------
  const projection = authority.project(pc, () => buildWire(session, systemPrompt, live), {
    stable: systemPrompt, live, tools: (tools || []).length,
  });
  const wire = projection.wire;
  const limits = providerLimits.limitsFor(pc, cfg);
  const verdict = providerLimits.check(wire, limits);
  if (!verdict.ok) {
    notices.push({
      type: 'notice', level: 'warn', surface,
      message: `still ${verdict.count} messages against a ${verdict.limit}-message limit — sending anyway; `
        + `compaction attempts for context epoch ${authority.epoch} are exhausted (${authority.attempts}/${authority.attempts})`,
    });
  }

  // ---- ACCOUNTED, EVERY TIME -------------------------------------------
  //
  // Measured HERE because this is the one place the exact transmitted array
  // exists. A breakdown produced anywhere else would be a reconstruction, and
  // a reconstruction is what nobody could trust when the reported figure was
  // 330,000 tokens and no part of the system could say of what.
  const audit = tokenaudit.measure(wire, {
    tools: tools || [],
    budget: require('./contextbudget').charsFor(pc, cfg),
  });
  return { wire, notices, compactions, fit: first, verdict, audit };
}

module.exports = { fit, buildWire };
