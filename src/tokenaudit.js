'use strict';

/**
 * WHERE THE TOKENS WENT — measured at the one place the payload is assembled.
 *
 * ------------------------------------------------------------------------
 * WHY THIS HAD TO EXIST BEFORE ANYTHING COULD BE FIXED.
 *
 * A session was reported at 325k-343k input tokens per request against a few
 * hundred output, exhausting a rate limit in minutes. Nothing inside LAIN could
 * say WHY. `usage.inputTokens` is a single number handed back by the provider
 * after the fact; it cannot distinguish a system prompt from a tool schema from
 * the ninth replay of a file read an hour ago. Every explanation available was
 * a guess, and a guess is exactly what gets "fixed" by truncating the wrong
 * thing.
 *
 * So this counts the payload by CATEGORY, before it is sent, from the same
 * array that is sent. It is the difference between "the context is too big" and
 *
 *     transcript 78%, of which tool results 71%, of which one file 34%
 *
 * which is a sentence somebody can act on.
 *
 * ------------------------------------------------------------------------
 * CHARACTERS, NOT TOKENS, AND SAID SO EVERYWHERE.
 *
 * A real tokenizer is a per-model dependency and a large one, and LAIN talks to
 * models whose tokenizers it does not have. Characters are exact, free, and
 * available for every route; the token figures here are a division by
 * `CHARS_PER_TOKEN` and are labelled as estimates because they are.
 *
 * The estimate is DELIBERATELY PESSIMISTIC — code and JSON tokenize worse than
 * prose — because the cost of guessing low is a request the provider refuses,
 * and the cost of guessing high is a slightly early compaction.
 *
 * ------------------------------------------------------------------------
 * WHAT "DUPLICATE" MEANS HERE, precisely, because the obvious reading is wrong.
 *
 * It is NOT "the same file appears in two requests" — that is REPLAY, it is
 * inherent to the chat-completions protocol, and the answer to it is prompt
 * caching (src/promptcache.js), not deletion. Measured on this machine, the
 * evidence ledger already prevents an unchanged file being re-read into the
 * transcript a second time: six reads of a 34,338-char file added 1,240 chars
 * after the first.
 *
 * Duplicate here means the same content present TWICE IN ONE REQUEST, which is
 * pure waste with no protocol excuse. Reported as a ratio so a regression in it
 * is a number rather than an impression.
 */

const CHARS_PER_TOKEN = 3.6;

/** Characters of a message's content, whatever shape the content is in. */
function charsOf(m) {
  if (!m) return 0;
  let n = 0;
  const c = m.content;
  if (typeof c === 'string') n += c.length;
  else if (Array.isArray(c)) {
    n += c.reduce((t, b) => t + (b && typeof b.text === 'string' ? b.text.length : 0), 0);
  }
  // ---- A TOOL CALL IS PAYLOAD, AND IT IS COUNTED EVEN WHEN THERE IS ALSO
  // ---- TEXT ------------------------------------------------------------
  //
  // This returned early on a string body, so an assistant message carrying
  // both prose and a call counted only the prose — and the arguments, which
  // are transmitted and billed like everything else, were free in the ledger.
  // Caught by this file's own test: an eight-tool turn under-reported itself.
  for (const tc of (m.tool_calls || [])) {
    n += String(tc.name || '').length;
    n += typeof tc.arguments === 'string' ? tc.arguments.length : JSON.stringify(tc.arguments || {}).length;
  }
  return n;
}

const tokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);

/**
 * MEASURE ONE REQUEST.
 *
 * @param {Array}  wire     the exact array about to be transmitted
 * @param {object} o.tools  the tool schemas going with it
 * @param {number} o.budget the character budget this request is held to
 * @returns {object} a breakdown in characters, with token estimates alongside
 */
function measure(wire, { tools = [], budget = 0 } = {}) {
  const msgs = Array.isArray(wire) ? wire : [];
  const by = { system: 0, user: 0, assistant: 0, tool: 0, other: 0 };
  let elided = 0;
  let steers = 0;

  for (const m of msgs) {
    const n = charsOf(m);
    const role = (m && m.role) || 'other';
    if (by[role] === undefined) by.other += n;
    else by[role] += n;
    if (m && m.elided) elided += 1;
    if (m && m._steer) steers += 1;
  }

  // ---- DUPLICATE WITHIN THIS ONE REQUEST -------------------------------
  //
  // Keyed on the whole body rather than a hash of it: the arrays involved are
  // hundreds of entries, not millions, and an exact comparison cannot collide.
  // Short bodies are skipped — two identical "ok" results are not the waste
  // this is looking for, and counting them would bury the one that is.
  const MIN_DUP = 200;
  const seen = new Set();
  let duplicate = 0;
  for (const m of msgs) {
    const c = typeof (m && m.content) === 'string' ? m.content : null;
    if (!c || c.length < MIN_DUP) continue;
    if (seen.has(c)) duplicate += c.length;
    else seen.add(c);
  }

  const toolSchemaChars = tools && tools.length ? JSON.stringify(tools).length : 0;
  const messageChars = by.system + by.user + by.assistant + by.tool + by.other;
  const total = messageChars + toolSchemaChars;

  // ---- THE CACHEABLE PREFIX --------------------------------------------
  //
  // Everything except the last message, which is the only part that is new on
  // this request. It is what a working cache would spare, so reporting it is
  // how the caching claim is checked rather than assumed.
  const lastChars = msgs.length ? charsOf(msgs[msgs.length - 1]) : 0;
  const stablePrefix = Math.max(0, total - lastChars);

  return {
    chars: {
      system: by.system,
      user: by.user,
      assistant: by.assistant,
      toolResults: by.tool,
      other: by.other,
      toolSchemas: toolSchemaChars,
      messages: messageChars,
      total,
      duplicate,
      stablePrefix,
      fresh: lastChars,
    },
    estTokens: {
      system: tokens(by.system),
      user: tokens(by.user),
      assistant: tokens(by.assistant),
      toolResults: tokens(by.tool),
      toolSchemas: tokens(toolSchemaChars),
      total: tokens(total),
      duplicate: tokens(duplicate),
      stablePrefix: tokens(stablePrefix),
    },
    messages: msgs.length,
    elided,
    steers,
    budget,
    // A ratio rather than a verdict: what counts as too much is the budget's
    // question, and it is asked in src/contextbudget.js.
    duplicateRatio: total > 0 ? duplicate / total : 0,
    overBudget: budget > 0 && total > budget,
  };
}

/**
 * THE BLOCK A PERSON READS. One request, accounted for.
 *
 * Ordered largest contributor first rather than by category name, because the
 * question being asked is always "what is making this big" and an alphabetical
 * list makes the reader do the sorting.
 */
function report(a, { n = null, output = 0, cacheRead = 0 } = {}) {
  if (!a) return [];
  const c = a.chars;
  const pct = (x) => (c.total > 0 ? `${String(Math.round((x / c.total) * 100)).padStart(3)}%` : '   -');
  const row = (label, chars) => `  ${label.padEnd(16)}${String(tokens(chars)).padStart(9)}  ${pct(chars)}`;
  const parts = [
    ['system prompt', c.system],
    ['tool schemas', c.toolSchemas],
    ['tool results', c.toolResults],
    ['assistant', c.assistant],
    ['user / task', c.user],
    ['other', c.other],
  ].filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]);

  const out = [`REQUEST${n ? ` #${n}` : ''}   ${a.messages} messages`];
  for (const [label, v] of parts) out.push(row(label, v));
  out.push('  ' + '-'.repeat(30));
  out.push(`  ${'INPUT (est)'.padEnd(16)}${String(a.estTokens.total).padStart(9)}`);
  if (output) out.push(`  ${'output'.padEnd(16)}${String(output).padStart(9)}`);
  if (a.budget) {
    out.push(`  ${'budget'.padEnd(16)}${String(tokens(a.budget)).padStart(9)}`
      + (a.overBudget ? '   OVER — compacting' : '   ok'));
  }
  out.push(`  ${'duplicate'.padEnd(16)}${String(a.estTokens.duplicate).padStart(9)}  ${pct(c.duplicate)}`);
  out.push(`  ${'cacheable'.padEnd(16)}${String(a.estTokens.stablePrefix).padStart(9)}  ${pct(c.stablePrefix)}`);
  if (cacheRead) {
    const served = Math.round((cacheRead / Math.max(1, a.estTokens.total)) * 100);
    out.push(`  ${'cache served'.padEnd(16)}${String(cacheRead).padStart(9)}  ${String(served).padStart(3)}%`);
  } else {
    // SAID OUT LOUD. Zero here on a route that should be caching is the single
    // most expensive silent condition there is, and it looks like nothing.
    out.push(`  ${'cache served'.padEnd(16)}${'0'.padStart(9)}   —  nothing was served from cache`);
  }
  return out;
}

module.exports = { measure, report, charsOf, tokens, CHARS_PER_TOKEN };
