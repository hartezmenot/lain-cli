'use strict';

/**
 * THE EXTERNAL MODEL — a SECOND opinion, through the provider system that
 * already exists.
 *
 * This is not a second provider stack. It resolves through `provider.resolve`
 * and speaks through `provider.chat`, exactly as a turn does; the only thing it
 * changes is WHICH model and connection are used, and what is asked of them. If
 * that stopped being true there would be two routing implementations that could
 * disagree about which endpoint a request went to, which is precisely the class
 * of bug the single catalog exists to prevent.
 *
 * WHAT IT IS FOR. LAIN investigates locally: it reads the tree, runs commands,
 * sees real output. Then it hands what it found to a different model and asks
 * for a review. Two models looking at one problem is only useful if you can
 * always tell which of them said a thing — so the reviewer is held to a
 * vocabulary:
 *
 *   FACT           something in the packet, restated
 *   EVIDENCE       the specific line/file/output that supports it
 *   HYPOTHESIS     a possible cause, explicitly not established
 *   RECOMMENDATION one concrete next action for LAIN to take
 *
 * AND IT MAY NOT PRETEND TO HAVE ACTED. The external model has no tools, no
 * filesystem and no shell here. It is told so, and the reply is checked: a claim
 * to have run or read something is flagged rather than passed through, because
 * an invented tool result read as a real one is the worst possible failure of a
 * two-model loop.
 *
 * NOT CONFIGURED IS A REAL STATE. With nothing set up, the caller is told so
 * plainly and local troubleshooting continues. Nothing here ever falls back to
 * LAIN's own model and calls the result an external review.
 */

const providerMod = require('./provider');
const errors = require('./errors');

/** Bounded: this is a review, not a conversation. */
const MAX_PACKET_CHARS = 60_000;
const DEFAULT_MAX_ROUNDS = 3;

const SYSTEM = `You are a second investigator reviewing another agent's work.

The other agent — LAIN — is running on the user's real machine and has already
done the local investigation. You have NO tools, NO filesystem and NO shell in
this conversation. You cannot read files, run commands, or inspect anything.
Everything you know is in the packet you are given.

NEVER claim to have performed an action. Do not write "I ran", "I checked",
"I opened", "I looked at the file" or anything that implies you did. If you need
something you were not given, ask for it as a RECOMMENDATION.

Answer with these labelled sections, in this order, and keep them short:

FACT
  What the packet establishes. Restate only what is actually in it.
EVIDENCE
  The specific file, line, output or exit code that supports each fact.
HYPOTHESIS
  What might be causing this. Say plainly that it is not established.
  If the packet does not support a hypothesis, say so instead of inventing one.
RECOMMENDATION
  ONE concrete next action for LAIN to take, and what result would confirm or
  refute the hypothesis.

If the evidence already settles it, say so under FACT and recommend the fix.
If the evidence is insufficient, say exactly what is missing.`;

/**
 * What is configured, and whether it can actually run.
 *
 * @returns {{enabled, connection, model, maxRounds, ok, why}}
 */
function settings(cfg = {}) {
  const raw = cfg.externalTroubleshoot || {};
  const enabled = raw.enabled !== false && Boolean(raw.model || raw.connection);
  const s = {
    enabled,
    connection: raw.connection || null,
    model: raw.model || null,
    maxRounds: Math.max(1, Math.min(6, Number(raw.maxRounds) || DEFAULT_MAX_ROUNDS)),
    ok: false,
    why: '',
  };
  if (!raw || (!raw.model && !raw.connection)) { s.why = 'NOT CONFIGURED'; return s; }
  if (raw.enabled === false) { s.why = 'disabled in config'; return s; }
  if (!raw.model) { s.why = 'no model chosen — set externalTroubleshoot.model'; return s; }
  s.ok = true;
  return s;
}

/**
 * The route the external model would use. Resolved through the SAME catalog and
 * connection machinery a turn uses — a different model, not a different system.
 */
function route(app) {
  const s = settings(app.cfg);
  if (!s.ok) return { ok: false, why: s.why, settings: s };
  const pc = providerMod.resolve({
    ...app.cfg,
    _evidence: app.connectionEvidence,
    model: s.model,
    connection: s.connection || app.cfg.connection,
  });
  if (!pc.protocol) {
    return { ok: false, why: `"${s.model}" is not served by any configured connection`, settings: s };
  }
  return { ok: true, pc, settings: s };
}

/**
 * Did the reply claim to have done something it cannot do?
 *
 * A soft check on purpose: it flags rather than rejects, because the useful part
 * of a reply that overclaims in one sentence is still useful. What matters is
 * that the user is TOLD, and that the claim is never rendered as a LAIN action.
 */
const OVERCLAIM = /\b(?:I (?:ran|executed|opened|read|edited|wrote|modified|installed|checked the file|inspected the file)|I have (?:run|read|edited|modified))\b/i;

function overclaims(text) {
  const m = OVERCLAIM.exec(String(text || ''));
  return m ? m[0] : null;
}

/** Split the reply into the four sections. Missing ones stay empty. */
const HEADS = [
  ['fact', /^\W*(?:\*\*)?\s*facts?\b\s*(?:\*\*)?\s*[:\-—]?\s*/i],
  ['evidence', /^\W*(?:\*\*)?\s*evidence\b\s*(?:\*\*)?\s*[:\-—]?\s*/i],
  ['hypothesis', /^\W*(?:\*\*)?\s*(?:hypothesis|hypotheses)\b\s*(?:\*\*)?\s*[:\-—]?\s*/i],
  ['recommendation', /^\W*(?:\*\*)?\s*(?:recommendations?|recommended action)\b\s*(?:\*\*)?\s*[:\-—]?\s*/i],
];

function sections(text) {
  const out = { fact: [], evidence: [], hypothesis: [], recommendation: [], rest: [] };
  let current = 'rest';
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) { if (out[current].length) out[current].push(''); continue; }
    const head = HEADS.find(([, re]) => re.test(line));
    if (head) {
      current = head[0];
      const tail = line.replace(head[1], '').trim();
      if (tail) out[current].push(tail);
      continue;
    }
    out[current].push(line);
  }
  for (const k of Object.keys(out)) {
    while (out[k].length && !out[k][out[k].length - 1]) out[k].pop();
  }
  return out;
}

/**
 * Ask the external model to review a packet.
 *
 * @param {App}    app
 * @param {string} packetText   the rendered investigation packet
 * @param {object} opts         { signal, onStatus }
 * @returns {Promise<{ok, text, sections, overclaim, error, model, connection, usage}>}
 */
async function ask(app, packetText, { signal = null, onStatus = null } = {}) {
  const r = route(app);
  if (!r.ok) return { ok: false, error: r.why, notConfigured: r.settings.why === 'NOT CONFIGURED' };

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(packetText || '').slice(0, MAX_PACKET_CHARS) },
  ];

  // The strip says EXTERNAL, in its own colour, for the whole of this wait —
  // this is not LAIN thinking and must never look like it.
  if (onStatus) onStatus({ phase: 'EXTERNAL', actor: 'EXTERNAL', word: 'REVIEWING', detail: `${r.pc.model}` });

  let text = '';
  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    // No tools. The external model is a reviewer, not a second agent with hands
    // on this machine; anything it wants done comes back as a RECOMMENDATION and
    // LAIN decides whether to do it.
    // NAMED IN THE LEDGER as what it is. A second model's review is a real
    // request against the same quota, and it must be visible as one rather
    // than inflating the turn's own step count. See reqtrace.js.
    for await (const ev of providerMod.chat(r.pc, messages, {
      tools: [], signal, trace: { reason: require('./reqtrace').REASON.EXTERNAL },
    })) {
      if (signal && signal.aborted) break;
      if (!ev) continue;
      if (ev.type === 'text') text += ev.chunk || '';
      else if (ev.type === 'usage') usage = { inputTokens: ev.inputTokens || 0, outputTokens: ev.outputTokens || 0 };
    }
  } catch (e) {
    const f = errors.classify(e);
    return { ok: false, error: f.message, kind: f.kind, model: r.pc.model, connection: r.pc.connectionId };
  } finally {
    if (onStatus) onStatus({ phase: 'ENDED' });
  }

  if (!text.trim()) {
    return { ok: false, error: 'the external model returned nothing', model: r.pc.model, connection: r.pc.connectionId };
  }
  return {
    ok: true,
    text: text.trim(),
    sections: sections(text),
    overclaim: overclaims(text),
    model: r.pc.canonicalModel || r.pc.model,
    connection: r.pc.connectionId,
    usage,
  };
}

module.exports = { settings, route, ask, sections, overclaims, SYSTEM, DEFAULT_MAX_ROUNDS, MAX_PACKET_CHARS };
