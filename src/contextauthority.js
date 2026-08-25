'use strict';

/**
 * THE ONE OWNER OF CONTEXT TRANSITIONS.
 *
 * Session.compact remains a pure conversation primitive. This class decides
 * WHEN it may run, against WHICH provider profile, and how many times may be
 * attempted for one epoch. Nothing else in LAIN is allowed to compact.
 *
 * ------------------------------------------------------------------------
 * THE LIFECYCLE. Compaction is a state machine, not scattered boolean logic:
 *
 *     NORMAL ─near─► NEAR_LIMIT ─over─► COMPACTING ─ok─►
 *     COMPACTION_VALIDATED ─► NORMAL
 *
 * Failure is a state for the rest of the epoch, never a reason to re-enter:
 *
 *     COMPACTING ─threw / grew the context─► COMPACTION_FAILED
 *     COMPACTING ─changed nothing, still over─► CONTEXT_UNSATISFIABLE
 *
 * `touch()` — a change to canonical conversation state — is the only thing
 * that starts a new epoch and re-arms the attempt budget. Within one epoch
 * that budget is bounded (MAX_ATTEMPTS_PER_EPOCH), a compaction that changes
 * NOTHING while over budget ends the epoch as UNSATISFIABLE with evidence
 * instead of being retried on identical state, and a completion carrying an
 * id from another epoch is ignored.
 *
 * ------------------------------------------------------------------------
 * EDGE-TRIGGERED, NOT LEVEL-TRIGGERED. Any caller may ask "does this need
 * compaction?" on every request. A check that finds no pressure consumes
 * nothing — no attempt, no run of Session.compact — so asking repeatedly
 * cannot spend the epoch's budget merely by asking. This is the difference
 * between a caller that reports CONTEXT_PRESSURE and one that quietly
 * starts compacting: callers report, this class transitions.
 *
 * ------------------------------------------------------------------------
 * COMPACTION IS NOT CLEAR. `clearContext` empties the conversation the model
 * is sent, explicitly, and never compacts and never reads a provider
 * profile. Compaction transforms; clear drops. Neither calls the other.
 */

const crypto = require('crypto');
const contextbudget = require('./contextbudget');
const providerLimits = require('./providerlimits');

const STATE = Object.freeze({
  NORMAL: 'NORMAL',
  NEAR_LIMIT: 'NEAR_LIMIT',
  COMPACTION_REQUIRED: 'COMPACTION_REQUIRED',
  COMPACTING: 'COMPACTING',
  COMPACTION_VALIDATED: 'COMPACTION_VALIDATED',
  COMPACTION_FAILED: 'COMPACTION_FAILED',
  CONTEXT_UNSATISFIABLE: 'CONTEXT_UNSATISFIABLE',
});

/** One bounded lifecycle per epoch. A provider refusal is new evidence, not a new epoch. */
const MAX_ATTEMPTS_PER_EPOCH = 2;

/** When the conversation passes this fraction of the budget it is NEAR_LIMIT — watched, not compacted. */
const NEAR_RATIO = 0.8;

/** The event timeline is a diagnostic, not a log. Bounded, like everything. */
const MAX_TIMELINE = 64;

/**
 * THE CONTEXT LIFECYCLE, AS NAMED EVENTS.
 *
 * Every entry carries enough identity to correlate a failure without guessing:
 * session, epoch, compaction id, provider and model ride on every event.
 */
const EVENT = Object.freeze({
  CONTEXT_PRESSURE: 'CONTEXT_PRESSURE',
  COMPACTION_REQUESTED: 'COMPACTION_REQUESTED',
  COMPACTION_STARTED: 'COMPACTION_STARTED',
  COMPACTION_COMPLETED: 'COMPACTION_COMPLETED',
  COMPACTION_FAILED: 'COMPACTION_FAILED',
  CONTEXT_REBUILT: 'CONTEXT_REBUILT',
  CONTEXT_VALIDATED: 'CONTEXT_VALIDATED',
  CONTEXT_UNSATISFIABLE: 'CONTEXT_UNSATISFIABLE',
  CONTEXT_CLEARED: 'CONTEXT_CLEARED',
});

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function profileFor(pc) {
  const provider = String((pc && pc.provider) || '');
  const model = String((pc && pc.model) || '');
  const connectionId = String((pc && pc.connectionId) || provider || '');
  return {
    provider,
    model,
    connectionId,
    contextWindow: Number(pc && pc.ctx) || 0,
    maxOutput: Number(pc && pc.maxTokens) || 0,
    profileHash: fingerprint({ provider, model, connectionId, ctx: pc && pc.ctx, maxTokens: pc && pc.maxTokens }),
  };
}

class ContextAuthority {
  constructor(session) {
    if (!session || !Array.isArray(session.messages)) throw new Error('ContextAuthority requires a session');
    this.session = session;
    this.epoch = 0;
    this.state = STATE.NORMAL;
    this.attempts = 0;
    this.lastProfileHash = '';
    this.lastProfile = null;
    this.lastProjectionHash = '';
    this.lastCompactionId = '';
    this.compactionId = '';
    this.unsatisfiable = null;
    this.reason = 'constructed';
    this.timeline = [];
    this._project = null;
    this.touch();
  }

  /**
   * Canonical mutations start a new epoch and invalidate the model projection.
   *
   * EVERY touch re-arms the attempt budget, because every touch follows a real
   * change to canonical state — the user's input, a step's tool results, a
   * model switch, an explicit clear. A new epoch with a spent budget would be
   * a session permanently over budget whose only recourse is sending
   * overweight requests; the bound is per EPOCH, and the epoch is the state.
   */
  touch({ reason = 'canonical-state-changed' } = {}) {
    this.epoch += 1;
    this.state = STATE.NORMAL;
    this.attempts = 0;
    this.reason = reason;
    // A NEW EPOCH RETIRES ANY OPERATION IN FLIGHT. A completion that arrives
    // for the previous epoch is stale by id alone: `touch` cleared the id, so
    // it can neither validate against state it was not issued for nor start
    // another compaction of it. This is the epoch guard.
    this.compactionId = '';
    this.unsatisfiable = null;
    this._project = null;
    return this;
  }

  get active() {
    return this.state === STATE.COMPACTION_REQUIRED || this.state === STATE.COMPACTING;
  }

  profile(pc) {
    const next = profileFor(pc);
    if (this.lastProfileHash && next.profileHash !== this.lastProfileHash) {
      this.touch({ reason: `model-profile-changed:${next.provider}:${next.model}` });
    }
    this.lastProfileHash = next.profileHash;
    this.lastProfile = next;
    return next;
  }

  /**
   * MEASURED PRESSURE, WITHOUT TRANSITIONING.
   *
   * Both budgets a payload must pass — characters and message count, which are
   * unrelated quantities (providerlimits.js) — measured against THIS provider
   * profile. `over` is the edge that may trigger compaction; `near` is the
   * watch state below it. Calling this changes nothing: pressure is a fact to
   * report, and the transition belongs to `compact` alone.
   */
  pressure(pc, cfg = {}) {
    const budget = contextbudget.charsFor(pc, cfg);
    const chars = this.session.contextChars();
    const messages = this.session.messages.length;
    const limits = providerLimits.limitsFor(pc, cfg);
    const cap = Number(limits.messages) || 0;
    const allowedMessages = cap > 0 ? Math.max(1, Math.floor(cap * providerLimits.HEADROOM)) : 0;
    const overChars = budget > 0 && chars > budget;
    const overMessages = allowedMessages > 0 && messages > allowedMessages;
    return {
      budget, chars, messages, cap, allowedMessages,
      over: overChars || overMessages,
      overChars, overMessages,
      near: !overChars && !overMessages && budget > 0 && chars > budget * NEAR_RATIO,
      why: overChars
        ? `context ${chars} chars over the ${budget}-char budget`
        : (overMessages ? `${messages} messages over this provider's ${allowedMessages}-message allowance` : ''),
    };
  }

  /**
   * STATE A FACT ON THE TIMELINE. Identity rides on every entry — session,
   * epoch, compaction id, provider, model — so the next failure can be
   * correlated from the record rather than reconstructed from prose.
   */
  note(type, fields = {}) {
    const ev = {
      type,
      at: new Date().toISOString(),
      sessionId: (this.session && this.session.id) || '',
      epoch: this.epoch,
      compactionId: this.compactionId || this.lastCompactionId || '',
      provider: this.lastProfile ? this.lastProfile.provider : '',
      model: this.lastProfile ? this.lastProfile.model : '',
      ...fields,
    };
    this.timeline.push(ev);
    if (this.timeline.length > MAX_TIMELINE) this.timeline.splice(0, this.timeline.length - MAX_TIMELINE);
    return ev;
  }

  /**
   * THE EVIDENCE AN UNSATISFIABLE EPOCH CARRIES.
   *
   * "Compaction cannot make this fit" is a claim about specific numbers
   * against a specific provider profile. Reporting the claim without the
   * numbers is what made the original loop undiagnosable: every retry looked
   * like the first one.
   */
  evidence(pc, cfg = {}, pressure) {
    const profile = profileFor(pc);
    return {
      provider: profile.provider,
      model: profile.model,
      contextWindow: profile.contextWindow,
      maxOutput: profile.maxOutput,
      budgetChars: pressure ? pressure.budget : contextbudget.charsFor(pc, cfg),
      contextChars: this.session.contextChars(),
      messages: this.session.messages.length,
      messageCap: pressure ? pressure.cap : providerLimits.limitsFor(pc, cfg).messages,
      attempts: this.attempts,
      epoch: this.epoch,
      why: pressure ? pressure.why : '',
    };
  }

  beginCompaction({ reason = 'context-pressure' } = {}) {
    // COMPACTING + pressure REMAINS COMPACTING: the second report is a no-op.
    if (this.active) return null;
    // A FAILED or UNSATISFIABLE epoch does not re-arm itself. Only `touch` —
    // genuinely new canonical state — starts a fresh lifecycle.
    if (this.state === STATE.COMPACTION_FAILED || this.state === STATE.CONTEXT_UNSATISFIABLE) return null;
    if (this.attempts >= MAX_ATTEMPTS_PER_EPOCH) {
      this.state = STATE.CONTEXT_UNSATISFIABLE;
      return null;
    }
    // The edge fires: pressure was reported and this call is taking the
    // transition. REQUIRED is transient by design — the operation begins in
    // the same synchronous call — but the machine's transitions are explicit
    // in the code that owns them, not implied.
    this.state = STATE.COMPACTION_REQUIRED;
    this.attempts += 1;
    this.reason = reason;
    this.compactionId = `${this.epoch}-${this.attempts}-${Date.now().toString(36)}`;
    this.state = STATE.COMPACTING;
    this.note(EVENT.COMPACTION_REQUESTED, { reason, attempt: this.attempts });
    return this.compactionId;
  }

  finishCompaction(id) {
    // STALE BY ID ALONE. An id from another epoch was cleared by `touch`; an
    // id from another operation was replaced by `beginCompaction`. Either way
    // it validates nothing and compacts nothing.
    if (!id || id !== this.compactionId) {
      if (id) return { stale: true, ignored: true, result: null };
      return { stale: false, ignored: true, result: null };
    }
    const valid = Boolean(this.session && Array.isArray(this.session.messages));
    this.state = valid ? STATE.COMPACTION_VALIDATED : STATE.COMPACTION_FAILED;
    this.lastCompactionId = id;
    this.compactionId = '';
    this._project = null;
    this.reason = valid ? 'compaction-validated' : 'compaction-invalid';
    this.note(valid ? EVENT.CONTEXT_VALIDATED : EVENT.COMPACTION_FAILED, { compactionId: id });
    return { stale: false, ignored: false, result: valid ? this : null };
  }

  normalize() {
    if (this.state === STATE.COMPACTION_VALIDATED) {
      this.state = STATE.NORMAL;
      return true;
    }
    return false;
  }

  /**
   * THE ONE TRANSITION INTO COMPACTION.
   *
   * Edge-triggered: no pressure means no attempt, no run of Session.compact.
   * Bounded: at most MAX_ATTEMPTS_PER_EPOCH productive attempts per epoch, and
   * a no-progress attempt while over budget ends the epoch immediately with
   * evidence. Validated: a compaction that threw, or that GREW the context,
   * is COMPACTION_FAILED — `compact() returned` is never taken as proof.
   *
   * @param {object}    pc    the resolved provider (its profile is the budget)
   * @param {object}    cfg   the loaded config (budget overrides, provider limits)
   * @param {object}    o     { reason, force } — `force` skips the pressure
   *                          gate for a manual /compact, never the bounds
   */
  compact(pc, cfg = {}, { reason = 'context-pressure', force = false } = {}) {
    const profile = this.profile(pc);
    const pressure = this.pressure(pc, cfg);

    // ---- EDGE-TRIGGERED, NOT LEVEL-TRIGGERED ------------------------------
    // A check that finds no pressure consumes nothing — no attempt, no
    // compaction — so a caller that asks on every step cannot spend the
    // epoch's budget by asking. NEAR_LIMIT is the watch state, not a trigger.
    if (!pressure.over && !force) {
      if (this.state === STATE.NORMAL || this.state === STATE.NEAR_LIMIT || this.state === STATE.COMPACTION_VALIDATED) {
        this.state = pressure.near ? STATE.NEAR_LIMIT : STATE.NORMAL;
      }
      return {
        attempted: false, stale: false, ignored: true,
        reason: pressure.near ? 'near-limit' : 'under-budget',
        id: null, pressure, profile,
        result: {
          compacted: false,
          before: pressure.chars, after: pressure.chars, elided: 0, folded: 0,
          beforeMessages: pressure.messages, afterMessages: pressure.messages,
        },
      };
    }

    if (pressure.over) this.note(EVENT.CONTEXT_PRESSURE, { reason, ...pressure });
    // NOTE: no state is assigned here. `beginCompaction` owns the
    // REQUIRED→COMPACTING edge, so a refusal leaves whatever state refused
    // it — COMPACTING stays COMPACTING, FAILED stays FAILED — instead of
    // being clobbered to REQUIRED by the very check that was refused.

    const id = this.beginCompaction({ reason: pressure.why || reason });
    if (!id) {
      // Refused: already COMPACTING, already FAILED, or the epoch's budget is
      // spent. The state says which; nothing here recurses. Evidence is
      // noted ONCE per epoch — when the verdict is first reached — so a
      // caller that asks on every step cannot fill the timeline with the
      // same verdict repeated.
      if (this.state === STATE.CONTEXT_UNSATISFIABLE && !this.unsatisfiable) {
        this.unsatisfiable = this.evidence(pc, cfg, pressure);
        this.note(EVENT.CONTEXT_UNSATISFIABLE, this.unsatisfiable);
      }
      return {
        attempted: false, stale: false, ignored: true,
        reason: this.reason, id: null, pressure, profile,
        busy: this.active,
        failed: this.state === STATE.COMPACTION_FAILED,
        unsatisfiable: this.unsatisfiable,
      };
    }
    this.note(EVENT.COMPACTION_STARTED, { compactionId: id, attempt: this.attempts, reason: pressure.why || reason });

    const room = contextbudget.charsFor(pc, cfg);
    const limits = providerLimits.limitsFor(pc, cfg);
    const target = providerLimits.targetFor(limits);

    let result;
    try {
      result = this.session.compact({ budgetChars: room, maxMessages: target });
    } catch (e) {
      // A compaction that threw leaves the machine FAILED for the rest of
      // this epoch. It is NOT retried inside the same lifecycle — that is
      // the loop this class exists to make impossible.
      this.state = STATE.COMPACTION_FAILED;
      this.compactionId = '';
      this.reason = 'compaction-threw';
      this.note(EVENT.COMPACTION_FAILED, { compactionId: id, error: String((e && e.message) || e) });
      return {
        attempted: true, stale: false, ignored: false, failed: true,
        reason: 'compaction-threw', error: String((e && e.message) || e),
        id, pressure, profile,
      };
    }

    // ---- VALIDATED, NOT TRUSTED -------------------------------------------
    // `compact() returned` is not proof. The result is checked against the
    // state it claims about. A compaction that GREW the characters while
    // removing no messages made the pressure worse and is a failure; one that
    // shrank EITHER dimension did real work, because char pressure and
    // message-count pressure are different walls (providerlimits.js).
    const before = Number(result && result.before) || 0;
    const after = Number(result && result.after) || 0;
    const beforeMessages = Number(result && result.beforeMessages) || 0;
    const afterMessages = Number(result && result.afterMessages) || 0;
    const grew = after > before && afterMessages >= beforeMessages;
    const valid = Array.isArray(this.session && this.session.messages) && !grew;
    this.finishCompaction(id);
    if (!valid) {
      this.state = STATE.COMPACTION_FAILED;
      this.reason = 'compaction-invalid';
      this.note(EVENT.COMPACTION_FAILED, { compactionId: id, reason: 'compaction-invalid', before, after });
      return {
        attempted: true, stale: false, ignored: false, failed: true,
        reason: 'compaction-invalid', result, id, pressure, profile,
      };
    }
    this.note(EVENT.COMPACTION_COMPLETED, {
      compactionId: id, before, after,
      elided: (result && result.elided) || 0, folded: (result && result.folded) || 0,
      beforeMessages: (result && result.beforeMessages) || 0,
      afterMessages: (result && result.afterMessages) || 0,
    });
    this.note(EVENT.CONTEXT_REBUILT, { compactionId: id, after, messages: this.session.messages.length });
    this.normalize();

    // ---- STILL OVER?  DIAGNOSE, DO NOT RECURSE -----------------------------
    // Compaction ran and the context is still over budget. The causes are
    // named in the evidence, and the response is bounded: an attempt that
    // CHANGED NOTHING while over budget proves folding cannot help this
    // state — the epoch ends UNSATISFIABLE now, without spending a second
    // attempt on identical state. A productive attempt leaves one more, and
    // only if the budget still has room for it.
    const afterPressure = this.pressure(pc, cfg);
    if (afterPressure.over) {
      const productive = Boolean(result && result.compacted);
      if (!productive || this.attempts >= MAX_ATTEMPTS_PER_EPOCH) {
        this.state = STATE.CONTEXT_UNSATISFIABLE;
        const unsatisfiable = this.evidence(pc, cfg, afterPressure);
        this.unsatisfiable = unsatisfiable;
        this.note(EVENT.CONTEXT_UNSATISFIABLE, unsatisfiable);
        return { attempted: true, stale: false, ignored: false, result, reason, id, pressure, profile, unsatisfiable };
      }
    }
    return { attempted: true, stale: false, ignored: false, result, reason, id, pressure, profile };
  }

  /**
   * THE MODEL CONTEXT PROJECTION, cached per (epoch, profile, shape).
   *
   * The same compacted state is not re-read or re-built for every request:
   * the projection is reused while the epoch, the provider profile, the
   * message count, the character count and the tool set are unchanged, and
   * rebuilt only when one of them materially changes. A model switch
   * produces a NEW projection for the NEW profile — never universal-context
   * reuse, and never a compaction it did not need.
   */
  project(pc, build, { stable = '', live = '', tools = 0 } = {}) {
    const profile = this.profile(pc);
    const projectionHash = fingerprint({
      epoch: this.epoch,
      profile: profile.profileHash,
      stable,
      live,
      tools,
      messages: this.session ? this.session.messages.length : 0,
      chars: this.session ? this.session.contextChars() : 0,
    });
    if (this._project && this.lastProjectionHash === projectionHash) return this._project;
    this._project = { wire: build(), profile, projectionHash, builtAt: Date.now() };
    this.lastProjectionHash = projectionHash;
    return this._project;
  }

  /**
   * EXPLICIT CLEAR — a different lifecycle operation, never a compaction.
   *
   * Empties the conversation the model is sent. Reads no provider profile,
   * consumes no attempt, runs no Session.compact, and can never see
   * "context too large" and start one. The persistent session state — task,
   * plan, evidence ledger, actors — is untouched; those are the work's
   * record, not the transcript of it.
   */
  clearContext() {
    const removed = this.session ? this.session.messages.length : 0;
    const chars = this.session ? this.session.contextChars() : 0;
    // Noted BEFORE the epoch turns, so an in-flight compaction id — if any —
    // is on the record as the operation the clear retired.
    this.note(EVENT.CONTEXT_CLEARED, { removed, chars });
    if (this.session) this.session.messages = [];
    this.touch({ reason: 'explicit-context-clear' });
    return { removed, chars };
  }
}

module.exports = {
  ContextAuthority, profileFor, STATE, EVENT,
  MAX_ATTEMPTS_PER_EPOCH, NEAR_RATIO, MAX_TIMELINE,
};
