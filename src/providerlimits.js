'use strict';

/**
 * WHAT THIS PROVIDER WILL ACCEPT — one source of truth, three different limits.
 *
 *: "Do not hardcode 800 throughout the code. Create one provider
 * capability/limit source. At minimum distinguish message_count_limit,
 * context_token_limit, request_size_limit, because these are not the same
 * thing."
 *
 * ------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT, observed live against omniroute:
 *
 *     413 Payload Too Large — Chat history exceeds the 800-message limit;
 *     compact the conversation and retry.
 *
 * LAIN's pre-flight check measured CHARACTERS and only characters. A thousand
 * short messages are a small payload by every measure it had, so the request
 * passed its own check, went out, and was refused — and the refusal arrived
 * carrying the whole turn's work inside the request that was rejected. The
 * provider was being used as LAIN's context-size calculator.
 *
 * A message-count cap and a token window are unrelated quantities and neither
 * implies the other:
 *
 *     1,000 messages of one word     tiny in tokens, over a MESSAGE cap
 *     3 messages holding a 400KB file  three messages, over a TOKEN window
 *
 * So they are separate fields, measured separately, and a payload has to pass
 * all three.
 *
 * ------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM, in order of trust:
 *
 *   1. WHAT THE PROVIDER SAID. A 413 naming its own cap is the provider stating
 *      a fact about itself, and it is remembered (see `learn`). This is the only
 *      source that cannot be out of date.
 *   2. WHAT THE USER CONFIGURED. `providerLimits` in the config file, for a
 *      route whose limits LAIN has not met yet.
 *   3. A CONSERVATIVE DEFAULT for providers whose limit is known.
 *   4. NOTHING. No cap is a real answer and is reported as one — an invented
 *      number would compact conversations that never needed it.
 */

/**
 * KNOWN MESSAGE-COUNT CAPS, by provider.
 *
 * Deliberately short. A guess here is worse than no entry: it silently folds
 * history that the provider would have accepted. Only providers observed to
 * enforce a count belong in it, and the comment says when it was observed,
 * because a limit is a fact with a date on it.
 */
const KNOWN = Object.freeze({
  // Observed 2026-08-22: `code: "chat_history_too_large", reason:
  // "message_limit"`, stated as 800 in the refusal text.
  omniroute: { messages: 800 },
});

/**
 * HOW MUCH OF THE CAP A REQUEST MAY USE.
 *
 * NOT 100%, and the margin is doing real work. The provider counts what it
 * receives, which includes the system prompt and anything the wire format adds;
 * LAIN counts what it is about to send. Sitting exactly on the boundary means
 * a single miscount is a refused request with a whole turn inside it, and the
 * cost of the margin is a slightly earlier compaction nobody notices.
 */
const HEADROOM = 0.95;

/** The `learn`ed caps of this process, by connection id. */
const learned = new Map();

/**
 * WHAT THIS ROUTE WILL TAKE.
 *
 * @param {object} pc   the resolved provider (provider.resolve)
 * @param {object} cfg  the loaded config, for a user-stated limit
 * @returns {{messages:number, tokens:number, bytes:number, source:string}}
 *          0 means NO KNOWN LIMIT of that kind — never "unlimited", just unknown.
 */
function limitsFor(pc, cfg = {}) {
  const provider = String((pc && pc.provider) || '').toLowerCase();
  const id = String((pc && pc.connectionId) || provider);

  // 1. WHAT THE PROVIDER TOLD US, this session.
  const seen = learned.get(id);

  // 2. WHAT THE USER CONFIGURED. Per connection id first, then per provider —
  //    a person with two omniroute routes may know they differ.
  const configured = (cfg && cfg.providerLimits) || {};
  const byId = configured[id] || configured[provider] || {};

  // 3. A KNOWN DEFAULT.
  const known = KNOWN[provider] || {};

  const messages = Number(seen && seen.messages) || Number(byId.messages) || Number(known.messages) || 0;
  return {
    messages,
    // THE TOKEN WINDOW IS ALREADY MODELLED as `pc.ctx`, and this does not
    // invent a second one — session.budgetChars is the owner of that
    // conversion and stays the owner. It is named here so the three limits can
    // be talked about together, which is what the design asks for.
    tokens: Number(pc && pc.ctx) || 0,
    bytes: Number(byId.bytes) || 0,
    source: seen ? 'the provider said so' : (byId.messages ? 'configured' : (known.messages ? 'known default' : 'unknown')),
  };
}

/**
 * REMEMBER WHAT A REFUSAL TAUGHT US.
 *
 * A 413 that names its cap is the provider stating a fact about itself. Kept
 * for the process rather than written to disk: a limit can change on the
 * provider's side, and a stale number in a config file would quietly compact
 * conversations for a limit that no longer exists. The cost of forgetting at
 * exit is one refused request in the next session, which teaches it again.
 */
function learn(pc, { messages = 0 } = {}) {
  const id = String((pc && pc.connectionId) || (pc && pc.provider) || '');
  if (!id || !(Number(messages) > 0)) return null;
  const prev = learned.get(id) || {};
  // THE LOWEST OBSERVED CAP WINS. Two routes behind one id may differ, and the
  // smaller number is the one that keeps requests getting through.
  const next = { messages: prev.messages ? Math.min(prev.messages, Number(messages)) : Number(messages) };
  learned.set(id, next);
  return next;
}

/** For tests and for a fresh process. */
function forget() { learned.clear(); }

/**
 * MEASURE A PAYLOAD THE WAY THE PROVIDER WILL COUNT IT.
 *
 * THE WIRE ARRAY, NOT `session.messages`, and that distinction is the bug: the
 * system prompt is prepended at send time, so the array LAIN checked was one
 * message shorter than the array the provider received. On the boundary that
 * is the difference between a request going through and a 413.
 *
 * @param {Array} wire  exactly what will be transmitted
 */
function measure(wire) {
  const messages = Array.isArray(wire) ? wire.length : 0;
  let chars = 0;
  for (const m of wire || []) {
    chars += String((m && m.content) || '').length;
    // TOOL CALLS ARE PAYLOAD TOO. An assistant message carrying six tool calls
    // has arguments in it that the provider counts and `content` does not show,
    // and a turn full of large arguments was measured as nearly empty.
    for (const tc of (m && m.tool_calls) || []) {
      chars += String((tc && tc.arguments) || '').length + String((tc && tc.name) || '').length;
    }
  }
  return { messages, chars };
}

/**
 * WOULD THIS PAYLOAD BE REFUSED?
 *
 * @returns {{ok:boolean, why:string, over:string, count:number, limit:number}}
 */
function check(wire, limits) {
  const m = measure(wire);
  const cap = Number(limits && limits.messages) || 0;
  if (cap > 0) {
    const allowed = Math.max(1, Math.floor(cap * HEADROOM));
    if (m.messages > allowed) {
      return {
        ok: false, over: 'messages', count: m.messages, limit: cap,
        why: `${m.messages} messages against this provider's ${cap}-message limit`,
      };
    }
  }
  return { ok: true, over: '', count: m.messages, limit: cap, why: '' };
}

/**
 * HOW MANY MESSAGES A PAYLOAD MAY KEEP — the target a compaction aims at.
 *
 * Below the headroom rather than at it, because compaction folds whole
 * exchanges and landing exactly on the cap leaves no room for the next turn's
 * own messages: the request after the one that just squeezed through would be
 * over again immediately, and every turn would pay for a compaction.
 */
function targetFor(limits) {
  const cap = Number(limits && limits.messages) || 0;
  if (!cap) return 0;
  return Math.max(8, Math.floor(cap * HEADROOM) - 8);
}

module.exports = { limitsFor, learn, forget, measure, check, targetFor, KNOWN, HEADROOM };
