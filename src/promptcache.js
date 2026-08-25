'use strict';

/**
 * MAKING THE REPLAYED TRANSCRIPT FREE, ON THE ROUTE WHERE IT IS NOT.
 *
 * ------------------------------------------------------------------------
 * THE MEASUREMENT THAT PRODUCED THIS FILE.
 *
 * A turn resends the whole accumulated message array on every step — that is
 * the chat-completions protocol, not a defect, and it is why prompt caching
 * exists. Measured on this machine, reading ten source files across eleven
 * requests:
 *
 *     236,711 chars of source on disk
 *   1,563,325 chars actually transmitted        6.6x amplification
 *
 * plus ~35,700 chars of tool schemas on every one of the eleven.
 *
 * provider.js already solves this, and its own comment states the stakes:
 * without a cache breakpoint "the uncached total grows like N(N+1)/2 instead of
 * N, which is exactly the shape of a 50-80x token blowup on a tool-heavy turn".
 *
 * THAT SOLUTION IS IN THE ANTHROPIC PATH ONLY. `openaiChat` — the sender for
 * every OpenAI-shaped route, which is what a bridge or gateway is — sent no
 * cache markers at all and read no cache figures back. So a user running a
 * Claude model through a gateway got the full N(N+1)/2 blowup with nothing on
 * screen to say so, while the identical model on a direct route was mostly
 * cached and nearly free. Same architecture, same session, two orders of
 * magnitude apart in cost, decided by a config field.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT SIMPLY "ALWAYS SEND cache_control".
 *
 * The marker is an ANTHROPIC extension. Gateways that front Anthropic models
 * (OpenRouter and the like) accept it inside OpenAI-shaped content blocks and
 * pass it through; that is the documented way to cache a Claude model over an
 * OpenAI-shaped API, and it is the case this exists for.
 *
 * OpenAI's own endpoints do not need it — their caching is automatic above a
 * size threshold — and a strict server may reject an unknown field or refuse
 * the block form of `content` outright. Sending it everywhere would trade a
 * cost bug for a compatibility bug.
 *
 * ------------------------------------------------------------------------
 * AND THEN IT WAS MEASURED, AND THE MARKERS TURNED OUT TO DO NOTHING HERE.
 *
 * Against the real configured gateway (`ag/claude-sonnet-4-6` over the local
 * omniroute bridge), two fresh prefixes, each sent twice:
 *
 *   WITH markers      1st: prompt=7752 cacheRead=0    2nd: cacheRead=5740
 *   WITHOUT markers   1st: prompt=7752 cacheRead=0    2nd: cacheRead=5740
 *
 * Identical. THIS GATEWAY CACHES ON ITS OWN, and `cache_control` changes
 * nothing about what it bills. The first attempt at this measurement was
 * worthless because all three requests shared one prefix, so the unmarked
 * control was reading a cache the marked requests had already created — a
 * control that reuses the treatment's cache is not a control.
 *
 * SO THE MARKERS ARE OFF BY DEFAULT. Lifting a string body into content blocks
 * is a real change to the request shape, some OpenAI-shaped servers are strict
 * about it, and the measured benefit on the route this was built for is zero.
 * Keeping it on because it was written would be exactly the thing this project
 * refuses to do.
 *
 * WHAT IS KEPT, and it is the half that mattered: `usageFrom` below. The chat
 * path read no cache figures at all, so LAIN reported 0 on a route that was
 * serving 5,740 of 7,752 tokens from cache. The saving was already happening
 * and was invisible.
 *
 * `promptCache: true` in the config turns the markers on for a gateway that
 * genuinely needs them — which is a real case, just not this one.
 *
 * ------------------------------------------------------------------------
 * AND THE FIGURES ARE READ BACK, WHICH MATTERS AS MUCH AS SENDING THEM.
 *
 * The chat path recorded only `prompt_tokens` and `completion_tokens`, so
 * whether a single byte was ever served from cache was unanswerable from
 * inside LAIN. A saving nobody can measure is a saving nobody can defend, and
 * a REGRESSION in it is invisible. `cached_tokens` is reported by OpenAI-shaped
 * endpoints under `prompt_tokens_details`, and by several gateways under their
 * own spelling; all the ones seen in the wild are read here.
 */

/** Model families whose caching must be asked for by hand. */
const EXPLICIT = /claude|sonnet|opus|haiku/i;

/**
 * Does this route need `cache_control` spelled out?
 *
 * @param {object} pc   the resolved provider (protocol, model)
 * @param {object} cfg  the user's config; `promptCache` overrides the guess
 */
function needsExplicitCache(pc, cfg = {}) {
  // The resolved provider carries the override when one was configured;
  // `cfg` is accepted too so a caller that has one can pass it directly.
  const forced = (pc && pc.promptCache !== undefined) ? pc.promptCache : (cfg && cfg.promptCache);
  if (forced === false) return false;
  if (forced === true) return true;
  // The anthropic protocol has its own handling in provider.js and must not be
  // marked twice; there are only four breakpoints per request to spend.
  if (pc && pc.protocol === 'anthropic') return false;
  // ---- OFF BY DEFAULT, BECAUSE IT WAS MEASURED AND IT DID NOTHING --------
  //
  // See the header. On the real gateway, marked and unmarked requests cached
  // identically. Sending markers nobody needs is a behaviour change with no
  // measured benefit, so it waits to be asked for.
  return false;
}

/**
 * Lift a message's content into the one block that can carry the marker.
 *
 * `cache_control` sits on a content BLOCK and never on a bare string, so a
 * plain-text message has to be converted. A message that is already blocks
 * keeps them and the marker goes on the last one; an empty message is left
 * alone, because a marker on nothing is a wasted breakpoint.
 */
function mark(msg) {
  if (!msg) return msg;
  if (Array.isArray(msg.content)) {
    if (!msg.content.length) return msg;
    const content = msg.content.slice();
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
    return { ...msg, content };
  }
  if (typeof msg.content === 'string' && msg.content) {
    return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }] };
  }
  return msg;
}

/**
 * Place the breakpoints on an OpenAI-shaped message array.
 *
 * TWO OF THEM, AND WHERE THEY GO IS THE WHOLE POINT:
 *
 *   THE SYSTEM MESSAGE, which never changes within a session. It is the single
 *   most stable thing in the request and it sits at the front, so caching it
 *   covers the prompt on every step of every turn.
 *
 *   THE LAST MESSAGE, which is the moving boundary. Request N+1's array is
 *   request N's array with messages appended, so the bytes up to request N's
 *   boundary are unchanged — and the cache lookup walks backward from this
 *   request's marker to find the longest matching prefix. It does not require
 *   an earlier request to have marked that same position, only that the content
 *   match. That is what turns N(N+1)/2 back into N.
 *
 * A `tool` message is deliberately never given the block form: several
 * OpenAI-shaped servers accept only a string there, and a tool result is never
 * the stable prefix anyway — the marker moves to the nearest earlier message
 * that can carry one.
 *
 * @returns {Array} a NEW array; the input is not modified.
 */
function applyToChat(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.slice();

  const sys = out.findIndex((m) => m && m.role === 'system');
  if (sys >= 0) out[sys] = mark(out[sys]);

  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!m || m.role === 'tool' || m.role === 'system') continue;
    if (!m.content || (Array.isArray(m.content) && !m.content.length)) continue;
    out[i] = mark(m);
    break;
  }
  return out;
}

/**
 * What an OpenAI-shaped endpoint said about caching.
 *
 * Every spelling seen in the wild, because a figure read under the wrong key is
 * indistinguishable from no caching at all — and that is the exact reading this
 * whole file exists to make possible.
 */
function usageFrom(u) {
  if (!u || typeof u !== 'object') return { cacheReadTokens: 0, cacheCreationTokens: 0 };
  const d = u.prompt_tokens_details || u.input_tokens_details || {};
  const read = d.cached_tokens || u.cached_tokens || u.cache_read_input_tokens || 0;
  const made = d.cache_creation_tokens || u.cache_creation_input_tokens || 0;
  return { cacheReadTokens: Number(read) || 0, cacheCreationTokens: Number(made) || 0 };
}

module.exports = { needsExplicitCache, applyToChat, usageFrom, mark, EXPLICIT };
