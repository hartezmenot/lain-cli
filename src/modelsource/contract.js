'use strict';

/**
 * WHAT A CHAT MODEL SOURCE IS, AND WHAT IT IS NOT.
 *
 * ------------------------------------------------------------------------
 * THE DISTINCTION THIS FILE EXISTS TO HOLD.
 *
 * ChatGPT.com and Gemini.google.com are MODELS LAIN CAN CONSULT.
 * Telegram, Discord and WhatsApp are PLACES A PERSON CAN TALK TO LAIN.
 *
 * They are orthogonal, and a single "external adapter" abstraction over both
 * would be a category error with consequences: a messaging transport carries
 * the user's own authority and a consulted model carries none, so merging them
 * merges the one boundary that decides whether a sentence may cause an action.
 *
 * So:
 *
 *     ModelSource                     MessagingTransport  (src/bot — not here)
 *       ├─ RuntimeModelSource           ├─ Telegram
 *       └─ WebModelSource               ├─ Discord
 *            ├─ chatgpt-web             └─ WhatsApp
 *            └─ gemini-web
 *
 * ------------------------------------------------------------------------
 * A WEB MODEL IS NEVER AN EXECUTION AUTHORITY.
 *
 * Whatever a source returns is TEXT. It cannot read this filesystem, cannot run
 * a command, cannot widen a permission and cannot settle a task. gate.js,
 * trust.js and permissions.js remain the only authorities over machine actions,
 * and nothing here consults them, extends them or stands beside them. A reply
 * that says "I have run the tests" is a reply that is wrong about itself; see
 * `overclaims`, which flags it rather than passing it through.
 *
 * ------------------------------------------------------------------------
 * UNKNOWN IS A REAL VALUE, EVERYWHERE.
 *
 * A website does not publish authoritative token usage, so `usage` is null and
 * `authoritativeUsage` is false — never a plausible estimate presented as a
 * measurement. A model selector whose structure has changed produces UNKNOWN
 * availability, never a cheerful AVAILABLE. Every terminal state below is
 * reached deliberately and carries its reason; there is no default success.
 */

/** RUNTIME reaches an API LAIN holds a credential for. WEB drives a logged-in site. */
const KIND = Object.freeze({ RUNTIME: 'RUNTIME', WEB: 'WEB' });

/** The canonical source ids. Stable strings — a frontend and a session file hold them. */
const SOURCE = Object.freeze({
  LAIN: 'lain',
  CHATGPT_WEB: 'chatgpt-web',
  GEMINI_WEB: 'gemini-web',
});

/** What a source is, for a person and for a picker. */
const LABEL = Object.freeze({
  [SOURCE.LAIN]: 'LAIN',
  [SOURCE.CHATGPT_WEB]: 'ChatGPT.com',
  [SOURCE.GEMINI_WEB]: 'Gemini.google.com',
});

/**
 * HOW A SEND ENDED. Six outcomes, and none of them is a default.
 *
 *   COMPLETED      a real answer, with text. Requires text — see `result`.
 *   CANCELLED      the user stopped it. Not a failure of the source.
 *   AUTH_REQUIRED  the site wants a login, an MFA code or a CAPTCHA. A PERSON
 *                  completes those; LAIN never does. See webmodel.js.
 *   RATE_LIMITED   the account hit a cap. Distinct from UNAVAILABLE because the
 *                  fix is time, not configuration.
 *   UNAVAILABLE    the source cannot run here at all (no browser, no route).
 *   FAILED         it went wrong, with a reason. Includes INCONCLUSIVE cases —
 *                  see webmodel.js on why an uncertain send is never a success.
 */
const STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAVAILABLE: 'UNAVAILABLE',
  FAILED: 'FAILED',
});

/** Whether a model in a discovered inventory can be used right now. */
const MODEL_STATE = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  /** The selector was read and this entry's state could not be established. */
  UNKNOWN: 'UNKNOWN',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
});

/**
 * WHERE A SOURCE IS IN ITS LIFECYCLE. The frontend renders these directly; see
 * `docs/MODEL-SOURCES.md` for the mapping a picker is expected to draw.
 */
const CONNECTION = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  DISCOVERING: 'DISCOVERING',
  READY: 'READY',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAVAILABLE: 'UNAVAILABLE',
  FAILED: 'FAILED',
});

/**
 * WHAT A SOURCE CAN ACTUALLY DO — proven, never advertised.
 *
 * `unknown` is spelled as the string 'unknown' rather than as `false`, because
 * "this website may accept an image and we have not established it" and "this
 * source refuses images" are different facts and a picker must not draw them
 * the same way.
 */
function capabilities(over = {}) {
  return {
    text: true,
    imageInput: 'unknown',
    fileInput: 'unknown',
    streaming: false,
    cancel: true,
    /** Whether token counts from this source are a MEASUREMENT. Websites: no. */
    authoritativeUsage: false,
    ...over,
  };
}

/** How much of any one reply is carried into the LAIN conversation. */
const MAX_REPLY_CHARS = 60_000;

/**
 * THE NORMALIZED RESULT. Website-specific detail stops at the adapter; this is
 * the only shape the engineering session ever sees.
 *
 * COMPLETED REQUIRES TEXT, and the refusal is structural rather than advisory —
 * the same rule externalstate.js enforces for a dispatched call, for the same
 * reason: an adapter returning a well-formed empty object is exactly how a
 * broken extraction comes to look like a working one. An empty COMPLETED is
 * rewritten to FAILED here, at the one place every source passes through.
 */
function result({
  source, model, status, text = '', error = null,
  conversationBinding = null, retryAfterMs = null, usage = null, at = Date.now(),
} = {}) {
  const body = String(text == null ? '' : text).trim().slice(0, MAX_REPLY_CHARS);
  let state = String(status || STATUS.FAILED);
  let why = error == null ? null : String(error);
  if (state === STATUS.COMPLETED && !body) {
    state = STATUS.FAILED;
    why = 'the source returned no text — nothing was captured';
  }
  return {
    source: String(source || ''),
    model: model == null ? null : String(model),
    status: state,
    text: state === STATUS.COMPLETED ? body : '',
    // NEVER INVENTED. A website publishes no authoritative token count, and a
    // plausible estimate in this field would be indistinguishable from a
    // measurement everywhere downstream. Unknown means null.
    usage: usage || null,
    conversationBinding,
    // Only ever a number a source actually read off a page or a header.
    retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.floor(retryAfterMs) : null,
    error: why,
    /** WHO ANSWERED, recorded AT EXECUTION TIME. See `provenance`. */
    provenance: provenance(source, model, at),
  };
}

/**
 * WHO ANSWERED THIS TURN — stamped when the request is made, never reconstructed.
 *
 * Reconstructing it afterwards from what a picker currently shows would attribute
 * an answer to whatever is selected NOW, which is wrong the instant a person
 * switches source — and switching source is the whole point of the feature. It
 * is a durable field on the message, and it is what a resumed session, the
 * history view and any later comparison read.
 */
function provenance(source, model, at = Date.now()) {
  const id = String(source || '');
  const label = LABEL[id] || id || 'unknown';
  return {
    sourceId: id,
    sourceLabel: label,
    model: model == null ? null : String(model),
    label: model ? `${label} · ${model}` : label,
    at,
  };
}

/**
 * A REPLY THAT CLAIMS TO HAVE ACTED HAS CLAIMED SOMETHING IT CANNOT DO.
 *
 * Kept from the retired `/external` path, which is the one piece of it that was
 * never about transport: a consulted model has no tools here whatever carried
 * the words. It FLAGS rather than rejects — the useful part of a reply that
 * overclaims in one sentence is still useful — and the flag is what stops the
 * claim being rendered as a LAIN action.
 */
const OVERCLAIM = /\b(?:I (?:ran|executed|opened|read|edited|wrote|modified|installed|checked the file|inspected the file)|I have (?:run|read|edited|modified))\b/i;

function overclaims(text) {
  const m = OVERCLAIM.exec(String(text || ''));
  return m ? m[0] : null;
}

/**
 * THE INTERFACE EVERY SOURCE ANSWERS TO.
 *
 * Declared as a class so the shape is on the record and a conformance suite has
 * something to assert against — not so that behaviour can hide in a base. Every
 * method here throws: a source that does not implement one is a bug at its own
 * definition, which is where it is cheapest to find.
 */
class ModelSource {
  constructor({ id, label = null, kind = KIND.RUNTIME } = {}) {
    this.id = String(id || '');
    this.label = label || LABEL[this.id] || this.id;
    this.kind = kind;
  }

  /** @returns {Promise<{state, why, models?, selected?}>} — never throws. */
  status() { throw new Error(`${this.id}: a source must report its status`); }

  /** Make the source usable. For a website this is a USER-DRIVEN login. */
  connect() { throw new Error(`${this.id}: a source must declare how it connects`); }

  /** Forget this source's live state. Never deletes a person's saved login. */
  disconnect() { throw new Error(`${this.id}: a source must declare how it disconnects`); }

  /** @returns {Promise<{ok, models:[{id,label,state}], why, cached, at}>} */
  discoverModels() { throw new Error(`${this.id}: a source must discover its models`); }

  /** @returns {Promise<{ok, modelId, why}>} */
  selectModel() { throw new Error(`${this.id}: a source must select a model`); }

  /** @returns {Promise<result>} — the normalized shape above, always. */
  send() { throw new Error(`${this.id}: a source must accept a prompt`); }

  /** Stop whatever is in flight. Idempotent by contract. */
  cancel() { throw new Error(`${this.id}: a source must be cancellable`); }

  /** What this source can prove it does. See `capabilities`. */
  capabilities() { return capabilities(); }
}

module.exports = {
  KIND, SOURCE, LABEL, STATUS, MODEL_STATE, CONNECTION,
  ModelSource, capabilities, result, provenance, overclaims,
  MAX_REPLY_CHARS,
};
