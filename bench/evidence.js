'use strict';

/**
 * THE PER-TASK EVIDENCE TRACE — did LAIN already know this when it asked again?
 *
 * ------------------------------------------------------------------------
 * WHERE THE TRUTH COMES FROM: the persisted session, nowhere else.
 *
 * A session JSON holds the whole conversation: every assistant message with its
 * tool_calls and every tool result, in order, exactly as they were sent. That
 * is a complete record of what evidence was ACQUIRED and when — so the trace is
 * a projection of existing runtime truth, not a second recorder bolted alongside
 * the turn loop. Nothing here runs during the task; it reads the task's own
 * record afterwards.
 *
 * ------------------------------------------------------------------------
 * THE FOUR CLASSES, and the rule that assigns each one.
 *
 *   REUSE               the evidence ledger served the answer instead of
 *                       re-reading (the substitution's `[evidence]` note is in
 *                       the transcript). Measured, not inferred.
 *
 *   VALID RECHECK       the evidence was re-acquired AND IT CHANGED — a
 *                       mutation sat between the two acquisitions, or the
 *                       earlier acquisition had been folded out of the
 *                       conversation, so the model genuinely did not have it.
 *                       Legitimate. NEVER counted as waste.
 *
 *   STALE INVALIDATION  the evidence changed with no mutation of ours between
 *                       the two looks — something outside this session edited
 *                       the tree. In a hermetic fixture this should not happen;
 *                       reported loudly rather than silently, because it means
 *                       the fixture isolation leaked.
 *
 *   REDISCOVERY         the SAME, UNCHANGED evidence was acquired again while
 *                       the earlier copy was still sitting in the conversation.
 *                       This is the waste the benchmark exists to count.
 *
 * Fingerprints are exact content hashes of the tool result, not mtimes: two
 * reads whose bytes are identical are the same evidence, whatever the clock
 * says. A read after an edit produces different bytes and is a VALID RECHECK by
 * construction — which is the property PART 8 of the benchmark brief demands:
 * fingerprint-aware invalidation that does not call legitimate post-edit
 * rereads "waste".
 *
 * ------------------------------------------------------------------------
 * THE COMPACTION RULES, stated precisely because they are the approximation
 * every waste counter gets wrong.
 *
 * Context management leaves two shapes in the final transcript, and neither may
 * be counted as waste:
 *
 *   ELIDED STUB — the tool result message survives, but its body was replaced
 *   by `[elided to fit the context window] … Re-run the call if you need the
 *   rest.` The model that re-read the file was looking at a stub, not at the
 *   bytes; the re-read is a VALID RECHECK even though the file never changed.
 *   Detected by the `elided` field the compactor leaves on the message.
 *
 *   FOLD — whole old exchanges are REPLACED by one summary message, so the
 *   earlier acquisition is not in the transcript at all and the re-read reads
 *   as a FIRST acquisition. Also never waste, by construction.
 */

const crypto = require('crypto');

/** The one-way fingerprint. Same bytes in, same key out; nothing longer. */
function fp(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex').slice(0, 16);
}

/** Input with keys sorted, so argument order cannot hide a duplicate. */
function normalizedArgs(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const k of Object.keys(input).sort()) {
    out[k] = input && typeof input[k] === 'object' && input[k] !== null ? normalizedArgs(input[k]) : input[k];
  }
  return out;
}

/**
 * Tools whose calls ACQUIRE evidence about the project (rather than change it
 * or run things). A repeated acquisition of the same key is the subject of the
 * classification; a repeated mutating call is a different defect (and is
 * counted separately as a duplicate tool call).
 *
 * WHAT counts as a key per tool — deliberately coarse and deterministic:
 *   read_file      whole reads: the path. Ranged reads: path+offset+limit, and
 *                  a ranged read is NEVER a duplicate of a whole read (the
 *                  ledger's own rule: a range is not whole-file evidence).
 *   read_symbol    path + name + container.
 *   locate         the normalized `what` (case-folded, whitespace-trimmed).
 *   understand     the call itself (it takes no arguments).
 *   grep / glob    the pattern + include, exactly.
 *   symbols / dependents / check_symbols / list_dir / discover_tests
 *                  their identifying argument, or the call itself.
 */
const ACQUISITIONS = new Set([
  'read_file', 'read_symbol', 'locate', 'understand', 'grep', 'glob',
  'symbols', 'dependents', 'check_symbols', 'list_dir', 'discover_tests',
]);

function keyFor(name, input) {
  const i = input || {};
  switch (name) {
    case 'read_file': {
      const path = String(i.path || '');
      const targeted = i.offset != null || i.limit != null;
      return targeted
        ? `range:${path}:${i.offset || 1}:${i.limit || 0}`
        : `file:${path}`;
    }
    case 'read_symbol': return `symbol:${i.path || ''}:${i.name || ''}${i.container ? `::${i.container}` : ''}`;
    case 'locate': return `locate:${String(i.what || '').trim().toLowerCase()}`;
    case 'understand': return 'understand:';
    case 'grep': return `grep:${i.pattern || ''}:${i.include || i.glob || ''}`;
    case 'glob': return `glob:${i.pattern || ''}`;
    case 'symbols': return `symbols:${i.name || ''}`;
    case 'dependents': return `dependents:${i.path || i.name || ''}`;
    case 'check_symbols': return `check_symbols:${i.path || ''}:${i.list_symbols ? 'list' : 'check'}`;
    case 'list_dir': return `list_dir:${i.path || '.'}`;
    case 'discover_tests': return 'discover_tests:';
    default: return `call:${name}:${JSON.stringify(normalizedArgs(i))}`;
  }
}

/**
 * FINGERPRINT-BY-ARGS exceptions. `understand` reports "what changed since last
 * time", so its output legitimately differs between two calls over an unchanged
 * tree; hashing it would misread the second call as a legitimate recheck. For
 * it, the fingerprint is the ARGS (there are none) and the change test is
 * whether anything mutated in between.
 */
function fingerprintOf(name, input, resultContent) {
  if (name === 'understand') return 'args';
  return fp(resultContent);
}

// What the trace reports for one acquisition.
// class is one of: FIRST, REUSE, VALID_RECHECK, STALE_INVALIDATION, REDISCOVERY.

/**
 * Walk a persisted session and classify every evidence acquisition in order.
 *
 * @param {object} session  the session JSON as saved by a finished run
 * @returns {{events: object[], summary: object}}
 */
function traceFromSession(session) {
  const messages = (session && Array.isArray(session.messages) ? session.messages : [])
    .filter((m) => m && (m.role === 'assistant' || m.role === 'tool'));

  // Pair each assistant tool_call with its result message by id, keeping the
  // CONVERSATION order (the order the model saw results in).
  const calls = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = tc.arguments && String(tc.arguments).trim() ? JSON.parse(tc.arguments) : {}; } catch { input = {}; }
        calls.push({ name: String(tc.name || ''), input, id: String(tc.id || '') });
      }
    }
  }
  const resultById = new Map();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) resultById.set(String(m.tool_call_id), m);
  }

  const seen = new Map();      // evidence key -> { fingerprint, callId, idx }
  const events = [];
  const summary = {
    acquisitions: 0,
    reuse: 0,
    validRechecks: 0,
    staleInvalidations: 0,
    rediscoveries: 0,
    firsts: 0,
    keysByClass: {},
  };

  calls.forEach((call, idx) => {
    const result = resultById.get(call.id);
    const content = result ? String(result.content == null ? '' : result.content) : '';
    const errored = Boolean(result && result.isError);

    // The evidence ledger's substitution, visible in the transcript itself.
    if (String(call.name) === 'read_file' && content.startsWith('[evidence]')) {
      events.push({ idx, tool: call.name, key: keyFor(call.name, call.input), class: 'REUSE', why: 'served by the evidence ledger' });
      summary.reuse += 1;
      return;
    }
    if (!ACQUISITIONS.has(call.name) || errored) return;   // errors acquire nothing

    summary.acquisitions += 1;
    const key = keyFor(call.name, call.input);
    const print = fingerprintOf(call.name, call.input, content);
    const prev = seen.get(key);

    if (!prev) {
      summary.firsts += 1;
      events.push({ idx, tool: call.name, key, class: 'FIRST', why: '' });
      seen.set(key, { fingerprint: print, callId: call.id, idx });
      return;
    }

    // A re-acquisition. Which of the three legitimate reasons, if any?
    let cls;
    let why;
    const mutatedBetween = calls.slice(prev.idx + 1, idx).some((c) => {
      if (!MUTATING.has(c.name)) return false;
      const r = resultById.get(c.id);
      return r && !r.isError;
    });
    // THE COMPACTION RULE: if the earlier acquisition's body was elided to a
    // stub, the model re-acquired something it could no longer see. Never waste.
    const prevResult = resultById.get(prev.callId);
    const prevElided = Boolean(prevResult && (prevResult.elided
      || String(prevResult.content || '').startsWith('[elided')));
    if (prevElided) {
      cls = 'VALID_RECHECK';
      why = 'the earlier acquisition was elided to a stub to fit the window — the model no longer had the bytes';
    } else if (print !== prev.fingerprint) {
      // The evidence CHANGED between the two looks. Something edited it; the
      // only question is whether the edit was ours. Mutation attribution per
      // call is not recoverable from the transcript, so the honest split is:
      // changed + any successful mutating call in between = ours (VALID);
      // changed + none = foreign (STALE, and suspicious in a hermetic fixture).
      if (mutatedBetween) {
        cls = 'VALID_RECHECK';
        why = 'the evidence changed between looks (an edit sat between them)';
      } else {
        cls = 'STALE_INVALIDATION';
        why = 'the evidence changed with no mutation of ours between the two looks';
      }
    } else if (print === 'args') {
      // ARGS-ONLY tools (understand): the output legitimately differs call to
      // call over an unchanged tree, so the change test is whether work that
      // could have altered the answer sat between the two asks.
      if (mutatedBetween) {
        cls = 'VALID_RECHECK';
        why = 're-asked after work that could have changed its answer';
      } else {
        cls = 'REDISCOVERY';
        why = 're-asked with nothing having changed and the earlier answer still in context';
      }
    } else {
      cls = 'REDISCOVERY';
      why = 'unchanged, and the earlier copy was still in the conversation';
    }

    events.push({ idx, tool: call.name, key, class: cls, why });
    if (cls === 'VALID_RECHECK') summary.validRechecks += 1;
    else if (cls === 'STALE_INVALIDATION') summary.staleInvalidations += 1;
    else if (cls === 'REDISCOVERY') summary.rediscoveries += 1;

    // The LATEST look is now the evidence of record.
    seen.set(key, { fingerprint: print, callId: call.id, idx });
  });

  for (const e of events) {
    if (e.class === 'FIRST') continue;
    (summary.keysByClass[e.class] = summary.keysByClass[e.class] || []).push(`${e.tool} ${e.key}`);
  }
  return { events, summary };
}

/** Mutating vocabulary, taken from the tool registry rather than re-listed. */
const MUTATING = new Set(
  Object.entries(require('../src/tools').TOOLS)
    .filter(([, t]) => t && t.mutates)
    .map(([n]) => n),
);

/**
 * DUPLICATE TOOL CALLS — the same tool with the same normalized arguments,
 * both succeeding, with no mutation in between. Distinct from evidence
 * rediscovery (a duplicate grep whose output CHANGED is a recheck, not a
 * duplicate): this is literally re-issuing a call whose answer was still true.
 */
function duplicateCalls(session) {
  const messages = (session && Array.isArray(session.messages) ? session.messages : []);
  const calls = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = tc.arguments && String(tc.arguments).trim() ? JSON.parse(tc.arguments) : {}; } catch { input = {}; }
        calls.push({ name: String(tc.name || ''), input, id: String(tc.id || '') });
      }
    }
  }
  const resultById = new Map(messages.filter((m) => m.role === 'tool' && m.tool_call_id)
    .map((m) => [String(m.tool_call_id), m]));
  const dups = [];
  const bySig = new Map();     // name+args -> { idx, id }
  calls.forEach((call, idx) => {
    const r = resultById.get(call.id);
    if (!r || r.isError) return;
    const sig = `${call.name}::${JSON.stringify(normalizedArgs(call.input))}`;
    const prev = bySig.get(sig);
    if (prev) {
      const mutatedBetween = calls.slice(prev.idx + 1, idx).some((c) => {
        if (!MUTATING.has(c.name)) return false;
        const rr = resultById.get(c.id);
        return rr && !rr.isError;
      });
      if (!mutatedBetween) dups.push({ name: call.name, args: normalizedArgs(call.input), idx });
    }
    bySig.set(sig, { idx, id: call.id });
  });
  return dups;
}

module.exports = { traceFromSession, duplicateCalls, normalizedArgs, keyFor, fp, ACQUISITIONS, MUTATING };
