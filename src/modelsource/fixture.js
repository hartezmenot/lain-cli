'use strict';

/**
 * A CHAT SITE THAT IS NOT A CHAT SITE — the deterministic surface.
 *
 * ------------------------------------------------------------------------
 * WHY THIS SHIPS IN `src` RATHER THAN IN `tests`.
 *
 * It is the reference implementation of the surface contract. A new site
 * adapter is written by reading this, and `/source check` compares a live site's
 * behaviour against the same expectations. A copy of it living only in the test
 * tree would be a second definition of the contract that production code cannot
 * see, which is how a contract quietly acquires two meanings.
 *
 * It contacts nothing. There is no browser, no socket, no timer that outlives a
 * call and no filesystem access. Every answer is computed from a script the
 * caller handed it, so a conformance run is the same on every machine.
 *
 * ------------------------------------------------------------------------
 * IT MODELS THE FAILURES, NOT THE HAPPY PATH.
 *
 * A fake that always succeeds proves nothing worth proving. This one can be told
 * to be signed out, to be mid-CAPTCHA, to have a model selector that no longer
 * reads, to accept a prompt and never answer, to answer somebody else's
 * question, to be rate limited with and without a stated retry time, to refuse a
 * model that was listed a minute ago, and to open the wrong conversation. Every
 * one of those is a real thing a website does, and each has a decision in
 * webmodel.js that only fires when it happens.
 */

const { AUTH } = require('./websurface');

/**
 * @param {object} script
 *   auth          'READY' | 'AUTH_REQUIRED' | 'UNKNOWN'
 *   models        [{ id, label, disabled?, statesAvailability? }] or null to
 *                 make the model selector unreadable
 *   selected      the model the site currently shows
 *   reply         string, or a function ({prompt, model, turn}) => string
 *   error         null | { rateLimited, why, retryAfterMs }
 *   available     false to model "no browser on this machine"
 *   acceptPrompt  false to model a composer that refuses the text
 *   loseSubmit    true to model a send that MAY have happened and then failed
 *   silent        true to model a prompt that is accepted and never answered
 *   threads       the site's own conversation store, keyed by id
 *   openWrong     true to model a site that opens a different conversation
 */
function create(script = {}) {
  const s = {
    id: script.id || 'fixture-web',
    label: script.label || 'Fixture',
    origin: 'https://fixture.invalid',
    auth: script.auth || AUTH.READY,
    models: script.models === undefined
      ? [{ id: 'fx-large', label: 'Fixture Large', statesAvailability: true },
        { id: 'fx-small', label: 'Fixture Small', statesAvailability: true }]
      : script.models,
    selected: script.selected || null,
    reply: script.reply === undefined ? 'the fixture answer' : script.reply,
    error: script.error || null,
    available: script.available !== false,
    acceptPrompt: script.acceptPrompt !== false,
    loseSubmit: script.loseSubmit === true,
    silent: script.silent === true,
    openWrong: script.openWrong === true,
    settleMs: Number(script.settleMs) || 0,
  };

  /** The site's own state. A page object stands in for its DOM. */
  const page = { fixture: true };
  let threadSeq = 0;
  let threadId = script.threadId || null;
  let turns = Number(script.turns) || 0;
  /** Every prompt the site received, in order — how duplicate sends are caught. */
  const received = [];

  const api = {
    id: s.id,
    label: s.label,
    url: `${s.origin}/`,
    origin: s.origin,
    plan: { id: s.id },
    /** The script, exposed so a test can change the site mid-run — as sites do. */
    script: s,
    received,
    get threadId() { return threadId; },
    get turns() { return turns; },

    availability: () => (s.available
      ? { available: true, why: 'fixture' }
      : { available: false, why: 'no browser is available on this machine' }),

    async ensurePage() {
      if (!s.available) return { ok: false, why: 'no browser is available on this machine', page: null };
      return { ok: true, page, why: '' };
    },

    async authState() {
      if (s.auth === AUTH.READY) return { state: AUTH.READY, why: '' };
      if (s.auth === AUTH.AUTH_REQUIRED) return { state: AUTH.AUTH_REQUIRED, why: 'sign in to the fixture' };
      return { state: AUTH.UNKNOWN, why: 'the fixture page was not recognised' };
    },

    async models() {
      if (!s.models) {
        // THE SELECTOR THAT NO LONGER READS. Not an empty list — see
        // webmodel.discoverModels for why those must not be the same answer.
        return { ok: false, models: [], why: 'the model selector opened but listed nothing LAIN could read — the site structure has changed' };
      }
      return {
        ok: true,
        models: s.models.map((m) => ({
          id: m.id,
          label: m.label || m.id,
          disabled: Boolean(m.disabled),
          statesAvailability: m.statesAvailability !== false,
          current: s.selected === m.id,
        })),
        why: '',
      };
    },

    async select(_page, modelId) {
      const row = (s.models || []).find((m) => m.id === modelId || m.label === modelId);
      if (!row) return { ok: false, why: `"${modelId}" is not in this account's model list` };
      if (row.disabled) return { ok: false, why: 'that model is not available on this account' };
      s.selected = row.id;
      return { ok: true, modelId: row.id, shown: row.label || row.id, why: '' };
    },

    async current() {
      return s.selected ? { ok: true, label: s.selected } : { ok: false, why: 'the page does not say which model is selected', label: null };
    },

    async thread() {
      return { ok: true, threadId, url: threadId ? `${s.origin}/c/${threadId}` : `${s.origin}/` };
    },

    async turnCount() { return { ok: true, count: turns }; },

    async openThread(_page, b) {
      if (s.openWrong) {
        // A SITE THAT REDIRECTED. webmodel must fail closed and start fresh.
        threadId = `other-${++threadSeq}`;
        return { ok: false, why: 'the site did not open the conversation LAIN asked for' };
      }
      if (!b || !b.threadId) return { ok: false, why: 'the binding does not say where that conversation is' };
      threadId = String(b.threadId);
      turns = Number(script.turns) || turns;
      return { ok: true, why: '' };
    },

    async newThread() {
      threadId = `fx-${++threadSeq}`;
      turns = 0;
      return { ok: true, why: '' };
    },

    async submit(_page, text) {
      if (!s.acceptPrompt) {
        // NOTHING LEFT. A bounded retry is safe, and the suite asserts it happens.
        return { ok: false, submitted: false, why: 'the composer did not take the text (it holds 0 characters)' };
      }
      received.push(String(text));
      if (s.loseSubmit) {
        // MAYBE SENT. The suite asserts this is NEVER retried.
        return { ok: false, submitted: true, why: 'the send button vanished after the click' };
      }
      if (!s.silent) turns += 1;
      return { ok: true, submitted: true, why: '' };
    },

    async settle(_page, { before = 0, signal = null, timeoutMs = 5_000, onProgress = null } = {}) {
      if (signal && signal.aborted) return { ok: false, status: 'CANCELLED', why: 'cancelled while waiting for the reply' };
      if (s.error) {
        return {
          ok: false,
          status: s.error.rateLimited ? 'RATE_LIMITED' : 'FAILED',
          why: s.error.why || 'the site is showing an error',
          retryAfterMs: s.error.retryAfterMs == null ? null : s.error.retryAfterMs,
        };
      }
      if (s.silent || turns <= before) {
        return {
          ok: false,
          status: 'FAILED',
          why: `no new reply appeared within ${Math.round(timeoutMs / 1000)}s — it is not certain the prompt was answered`,
          partial: false,
        };
      }
      const last = received[received.length - 1] || '';
      const text = typeof s.reply === 'function' ? s.reply({ prompt: last, model: s.selected, turn: turns }) : String(s.reply);
      if (onProgress) onProgress(text.length);
      if (s.settleMs) await new Promise((r) => setTimeout(r, s.settleMs));
      if (signal && signal.aborted) return { ok: false, status: 'CANCELLED', why: 'cancelled while waiting for the reply' };
      if (!threadId) threadId = `fx-${++threadSeq}`;
      return { ok: true, status: 'COMPLETED', text, why: '' };
    },

    async stop() { return { ok: true, stopped: true }; },
    async close() { return { ok: true }; },
  };
  return api;
}

module.exports = { create };
