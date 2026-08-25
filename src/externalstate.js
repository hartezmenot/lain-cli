'use strict';

/**
 * WHAT ACTUALLY HAPPENED TO AN EXTERNAL REQUEST.
 *
 * THE PROBLEM THIS EXISTS TO END. The relay had one notion of external state —
 * did the whole run stop, and why — and no notion at all of what happened to an
 * individual call. So "external" was a single boolean-ish mood, and the two
 * questions that matter could not be asked separately:
 *
 *     Did the provider actually receive it?
 *     Was its answer actually used?
 *
 * A call that was dispatched and timed out, a call that came back and was
 * discarded, and a call that was never made at all are three completely
 * different events. Reported as "external didn't work" they are
 * indistinguishable, and the fix for each is different.
 *
 * ------------------------------------------------------------------------
 * THE RULE THIS FILE ENFORCES: RESPONDED REQUIRES A RESPONSE.
 *
 * An adapter returning an object is not an answer. The transition into
 * RESPONDED is refused unless there is actual text, so "the call completed" can
 * never be manufactured by a well-formed empty result — which is exactly how a
 * broken external path comes to look like a working one.
 *
 * Every terminal state is reached deliberately and carries its reason. There is
 * no default success.
 * ------------------------------------------------------------------------
 *
 * ONE RECORD PER CALL, keyed by its own id, so two providers running at once
 * cannot overwrite each other's status — the thing a shared `last` variable
 * does silently.
 */

/** The lifecycle. Every one of these is a distinguishable, reportable event. */
const STATE = Object.freeze({
  /** Nobody asked for external help. */
  NOT_REQUESTED: 'NOT_REQUESTED',
  /** It was considered and deliberately not used. */
  LOCAL_ONLY: 'LOCAL_ONLY',
  /** Asked for, not yet sent anywhere. */
  EXTERNAL_REQUESTED: 'EXTERNAL_REQUESTED',
  /** It genuinely left — typed into a page, or sent to an API. */
  EXTERNAL_DISPATCHED: 'EXTERNAL_DISPATCHED',
  /** A real answer came back. Requires text; see `respond`. */
  EXTERNAL_RESPONDED: 'EXTERNAL_RESPONDED',
  /** It failed, with a real reason. */
  EXTERNAL_FAILED: 'EXTERNAL_FAILED',
  /** It was dispatched and nothing settled in time. NOT a failure of content. */
  EXTERNAL_TIMEOUT: 'EXTERNAL_TIMEOUT',
  /** The provider refused, or a person declined to send it. */
  EXTERNAL_REJECTED: 'EXTERNAL_REJECTED',
  /** Its answer was chosen and became input. The only fully successful end. */
  EXTERNAL_RESULT_USED: 'EXTERNAL_RESULT_USED',
  /** It answered and the answer was not taken. Success of transport, not of use. */
  EXTERNAL_RESULT_DISCARDED: 'EXTERNAL_RESULT_DISCARDED',
});

/** States after which nothing more happens to a call. */
const TERMINAL = new Set([
  STATE.EXTERNAL_FAILED, STATE.EXTERNAL_TIMEOUT, STATE.EXTERNAL_REJECTED,
  STATE.EXTERNAL_RESULT_USED, STATE.EXTERNAL_RESULT_DISCARDED, STATE.LOCAL_ONLY,
]);

/** The ones that mean the provider actually produced something. */
const ANSWERED = new Set([
  STATE.EXTERNAL_RESPONDED, STATE.EXTERNAL_RESULT_USED, STATE.EXTERNAL_RESULT_DISCARDED,
]);

let _seq = 0;

/**
 * One external call, from request to outcome.
 *
 * Timestamps are recorded at every transition rather than at the end, because
 * "it was dispatched at 12:04 and nothing came back" is the report that
 * distinguishes a slow provider from one that never received anything.
 */
class ExternalCall {
  constructor({ provider, kind = null, prompt = '', now = () => Date.now() }) {
    _seq += 1;
    this.id = `X${String(_seq).padStart(3, '0')}`;
    this.provider = String(provider || 'unknown');
    this.kind = kind;
    this.prompt = String(prompt || '');
    this.state = STATE.EXTERNAL_REQUESTED;
    this.response = null;
    this.error = null;
    this.attachments = [];
    this._now = now;
    this.requestedAt = now();
    this.dispatchedAt = null;
    this.respondedAt = null;
    this.endedAt = null;
    /** Every transition, in order — the audit trail for one call. */
    this.trail = [{ state: this.state, at: this.requestedAt }];
  }

  _to(state, extra = {}) {
    this.state = state;
    const at = this._now();
    this.trail.push({ state, at, ...extra });
    if (TERMINAL.has(state)) this.endedAt = at;
    return this;
  }

  /** It left. `how` records the mechanism, so a page and an API are distinguishable. */
  dispatch(how = null, { attachments = [] } = {}) {
    this.dispatchedAt = this._now();
    this.attachments = attachments.map(String);
    return this._to(STATE.EXTERNAL_DISPATCHED, { how, attachments: this.attachments.length });
  }

  /**
   * A real answer arrived.
   *
   * REFUSED WITHOUT TEXT. This is the guard the whole file exists for: an
   * adapter that returns `{ ok: true }` with nothing in it must not be able to
   * produce a RESPONDED state. An empty answer is a failure of the capture, and
   * is recorded as one.
   */
  respond(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) {
      this.error = 'the provider returned no text — nothing was captured';
      return this._to(STATE.EXTERNAL_FAILED, { why: this.error });
    }
    this.response = s;
    this.respondedAt = this._now();
    return this._to(STATE.EXTERNAL_RESPONDED, { chars: s.length });
  }

  fail(reason) {
    this.error = String(reason || 'unknown failure');
    return this._to(STATE.EXTERNAL_FAILED, { why: this.error });
  }

  timeout(reason) {
    this.error = String(reason || 'nothing settled in time');
    return this._to(STATE.EXTERNAL_TIMEOUT, { why: this.error });
  }

  reject(reason) {
    this.error = String(reason || 'refused');
    return this._to(STATE.EXTERNAL_REJECTED, { why: this.error });
  }

  /** Its answer was chosen. Only reachable from a state that HAS an answer. */
  use() {
    if (!ANSWERED.has(this.state)) return this.fail('nothing was answered, so nothing could be used');
    return this._to(STATE.EXTERNAL_RESULT_USED);
  }

  discard() {
    if (!ANSWERED.has(this.state)) return this;
    return this._to(STATE.EXTERNAL_RESULT_DISCARDED);
  }

  get answered() { return ANSWERED.has(this.state); }
  get failed() {
    return this.state === STATE.EXTERNAL_FAILED
      || this.state === STATE.EXTERNAL_TIMEOUT
      || this.state === STATE.EXTERNAL_REJECTED;
  }

  get elapsedMs() { return (this.endedAt || this._now()) - this.requestedAt; }

  /** One line a person can read, and a machine can grep. */
  summary() {
    const secs = Math.round(this.elapsedMs / 100) / 10;
    const bits = [`${this.id}  ${this.provider}  ${this.state}  ${secs}s`];
    if (this.attachments.length) bits.push(`${this.attachments.length} attachment(s)`);
    if (this.response) bits.push(`${this.response.length} chars`);
    if (this.error) bits.push(`reason: ${this.error}`);
    return bits.join(' · ');
  }
}

/**
 * Every external call in a session, kept apart.
 *
 * Held on the session, never at module scope — the same rule the attempt and
 * finding ledgers follow, for the same reason: two sessions in one process must
 * not share state.
 */
class ExternalLedger {
  constructor() { this.calls = []; }

  open({ provider, kind = null, prompt = '' }) {
    const call = new ExternalCall({ provider, kind, prompt });
    this.calls.push(call);
    return call;
  }

  get(id) { return this.calls.find((c) => c.id === id) || null; }
  answered() { return this.calls.filter((c) => c.answered); }
  failed() { return this.calls.filter((c) => c.failed); }

  /**
   * The state of the WHOLE external attempt, from the calls that make it up.
   *
   * Deliberately conservative: it reports success only when something was
   * actually used. Everything answering and nothing being taken is a real and
   * different outcome, and it is reported as itself.
   */
  overall() {
    if (!this.calls.length) return STATE.NOT_REQUESTED;
    if (this.calls.some((c) => c.state === STATE.EXTERNAL_RESULT_USED)) return STATE.EXTERNAL_RESULT_USED;
    if (this.calls.some((c) => c.state === STATE.EXTERNAL_RESULT_DISCARDED)) return STATE.EXTERNAL_RESULT_DISCARDED;
    if (this.calls.some((c) => c.answered)) return STATE.EXTERNAL_RESPONDED;
    if (this.calls.every((c) => c.state === STATE.EXTERNAL_TIMEOUT)) return STATE.EXTERNAL_TIMEOUT;
    if (this.calls.every((c) => c.failed)) return STATE.EXTERNAL_FAILED;
    if (this.calls.some((c) => c.state === STATE.EXTERNAL_DISPATCHED)) return STATE.EXTERNAL_DISPATCHED;
    return STATE.EXTERNAL_REQUESTED;
  }

  /** The audit trail, one line per call. */
  lines() { return this.calls.map((c) => c.summary()); }

  /**
   * WHAT SURVIVES THE SESSION FILE — and deliberately not the packet.
   *
   * THE GAP THIS CLOSES. The ledger is the only record that something left this
   * machine: who it went to, when, and whether it came back. It lived on
   * `session.external` as a class instance, and `Session.toJSON` is an
   * allowlist, so it was dropped on every save. A resumed session could not say
   * that anything had ever been sent anywhere.
   *
   * THE PROMPT IS NOT KEPT. It is the packet — the project path, the changed
   * files, the last command, the user's own words — and writing a second copy
   * of it into the session file would put more of that on disk than the run
   * itself needs. What matters for an audit is that a call happened, to whom,
   * and how it ended. The advice that came back is already in `session.messages`
   * inside the brief, where the model saw it.
   */
  toJSON() {
    return this.calls.map((c) => ({
      id: c.id,
      provider: c.provider,
      kind: c.kind,
      state: c.state,
      promptChars: String(c.prompt || '').length,
      responseChars: c.response == null ? 0 : String(c.response).length,
      error: c.error || null,
      requestedAt: c.requestedAt,
      dispatchedAt: c.dispatchedAt,
      respondedAt: c.respondedAt,
      endedAt: c.endedAt,
      trail: c.trail,
    }));
  }

  /**
   * Rebuild a ledger from what was saved. The restored calls are RECORDS rather
   * than live calls — a call whose transitions already happened cannot be
   * transitioned again, and pretending otherwise would let a resumed session
   * dispatch something that was dispatched an hour ago.
   */
  static from(data) {
    const led = new ExternalLedger();
    if (!Array.isArray(data)) return led;
    led.restored = data.map((d) => ({ ...d, answered: ANSWERED.has(d && d.state) }));
    return led;
  }
}

function forSession(session) {
  if (!session) return new ExternalLedger();
  if (!session.external) session.external = new ExternalLedger();
  return session.external;
}

module.exports = { STATE, TERMINAL, ANSWERED, ExternalCall, ExternalLedger, forSession };
