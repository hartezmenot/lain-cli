'use strict';

/**
 * A CHAT SITE, AS THE ORCHESTRATOR SEES IT.
 *
 * ------------------------------------------------------------------------
 * THE SEAM, AND WHY IT IS HERE RATHER THAN ONE LAYER UP OR DOWN.
 *
 *   pageops.js    knows about the DOM and nothing about model sources
 *   THIS FILE     turns a site PLAN into the ten operations an orchestrator needs
 *   webmodel.js   knows about model sources and nothing about the DOM
 *
 * webmodel.js therefore contains no selector, no `evaluate`, and no site name.
 * That is what makes the SAME orchestration — the send guard, the thread
 * binding, the retry rule, the cancellation — provably identical for ChatGPT,
 * for Gemini, and for the deterministic fixture the conformance suite drives.
 * A third site is a new plan, not a new orchestrator.
 *
 * ------------------------------------------------------------------------
 * NOTHING HERE DECIDES ANYTHING. Every method reports what it observed and
 * refuses when it could not observe it. The decisions — retry or not, fail
 * closed or not, which model, which thread — belong to webmodel.js, in one
 * place, where they can be read together.
 */

const pageops = require('./pageops');
const webbrowser = require('./webbrowser');

/** The auth verdicts a surface may return. Deliberately three, not two. */
const AUTH = Object.freeze({ READY: 'READY', AUTH_REQUIRED: 'AUTH_REQUIRED', UNKNOWN: 'UNKNOWN' });

/**
 * BUILD THE SURFACE FOR ONE SITE.
 *
 * @param {object} plan  see chatgpt.js / gemini.js for what a plan declares
 * @param {object} deps  { browser } — injected so a test drives a fake browser
 *                       without a fake site, and the fixture drives a fake site
 *                       without a browser. Those are different substitutions and
 *                       collapsing them would make one of them untestable.
 */
function create(plan, { browser } = {}) {
  const id = String(plan.id);

  /** The live page, launching the authenticated browser if it is not up. */
  async function ensurePage({ signal = null, launch = true } = {}) {
    const got = await browser.page(id, { launch, signal });
    if (!got.ok) return { ok: false, why: got.why, page: null };
    const page = got.session;
    // ALREADY ON THE SITE? Then do not reload it. A reload costs seconds, drops
    // the conversation the user can see, and on some accounts re-triggers a
    // consent interstitial. See webbrowser.js on why latency is correctness.
    const here = await pageops.ask(page, 'read the current location', 'location.href');
    const at = here.ok ? String(here.value || '') : '';
    if (!at.startsWith(plan.origin)) {
      const nav = await page.navigate(plan.url, webbrowser.NAV_TIMEOUT_MS);
      if (!nav.ok) return { ok: false, why: nav.why, page: null };
    }
    return { ok: true, page, why: '' };
  }

  /**
   * SIGNED IN, SIGNED OUT, OR UNREADABLE.
   *
   * UNKNOWN is a real answer and it is NOT collapsed into AUTH_REQUIRED. Telling
   * somebody to log in when they already are is a confusing instruction that
   * hides the actual problem, which is that the page does not look like the
   * page this adapter was written for.
   */
  async function authState(page) {
    const out = await pageops.firstVisible(page, 'the signed-out markers', plan.auth.signedOutSelectors || []);
    if (out.ok && out.found) {
      return { state: AUTH.AUTH_REQUIRED, why: `${plan.label} is showing a sign-in prompt — log in in the browser window LAIN opened` };
    }
    const inn = await pageops.firstVisible(page, 'the signed-in markers', plan.auth.signedInSelectors || []);
    if (inn.ok && inn.found) return { state: AUTH.READY, why: '' };
    // A CHALLENGE IS AUTH, NOT A FAILURE. MFA and CAPTCHA are things a PERSON
    // completes; LAIN surfaces them and waits. It never attempts either.
    const challenge = await pageops.firstVisible(page, 'a verification challenge', plan.auth.challengeSelectors || []);
    if (challenge.ok && challenge.found) {
      return { state: AUTH.AUTH_REQUIRED, why: `${plan.label} is asking you to verify — complete it in the browser window LAIN opened` };
    }
    return {
      state: AUTH.UNKNOWN,
      why: `LAIN could not tell whether you are signed in to ${plan.label} — the page did not show anything it recognises`,
    };
  }

  async function models(page) { return pageops.readModelMenu(page, plan); }

  /**
   * SELECT A MODEL, AND PROVE IT TOOK.
   *
   * The read-back is the whole value of this function. Clicking an option in a
   * menu that has re-rendered underneath you silently selects the wrong row, and
   * every later step — including the provenance stamped on the answer — would
   * then be confidently wrong about which model replied.
   */
  async function select(page, modelId, modelLabel = null) {
    const wanted = String(modelId);
    const opened = await pageops.click(page, 'open the model selector', plan.modelMenu.triggerSelectors || []);
    if (!opened.ok) return { ok: false, why: opened.why };
    const appeared = await pageops.waitVisible(page, 'the model list', plan.modelMenu.optionSelectors || []);
    if (!appeared.ok) { await pageops.closeMenu(page, plan); return { ok: false, why: appeared.why }; }
    const expr = `(() => {
      const sel = ${JSON.stringify(plan.modelMenu.optionSelectors || [])};
      const idAttrs = ${JSON.stringify(plan.modelMenu.idAttributes || ['data-testid', 'data-value', 'data-model', 'id'])};
      const want = ${JSON.stringify(wanted)};
      const wantLabel = ${JSON.stringify(modelLabel == null ? '' : String(modelLabel))};
      for (const s of sel) {
        for (const el of document.querySelectorAll(s)) {
          let id = null;
          for (const a of idAttrs) { const v = el.getAttribute(a); if (v) { id = v; break; } }
          const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').split(/[ \\t\\n\\r]+/).join(' ').trim();
          if (id !== want && label !== want && !(wantLabel && label === wantLabel)) continue;
          if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return { ok: false, why: 'that model is not available on this account' };
          el.click();
          return { ok: true };
        }
      }
      return { ok: false, why: 'absent' };
    })()`;
    const r = await pageops.ask(page, 'choose the model', expr);
    if (!r.ok) { await pageops.closeMenu(page, plan); return { ok: false, why: r.why }; }
    const v = r.value || {};
    if (!v.ok) {
      await pageops.closeMenu(page, plan);
      return { ok: false, why: v.why === 'absent' ? `"${wanted}" is not in this account's model list` : v.why };
    }
    // The menu closes itself on a successful choice on both sites; dismissing an
    // already-closed menu is harmless and covers the one that does not.
    await pageops.closeMenu(page, plan);
    const now = await pageops.currentModel(page, plan);
    if (!now.ok) {
      return { ok: false, why: `the model was clicked but ${plan.label} does not say which model is selected — LAIN will not claim it took` };
    }
    const shown = String(now.label || '');
    const want = String(modelLabel || wanted);
    // Substring rather than equality: a trigger routinely renders "GPT-x" for an
    // option labelled "GPT-x · legacy". Equality here would reject every correct
    // selection on one site and pass on the other.
    if (!shown.toLowerCase().includes(want.toLowerCase()) && !want.toLowerCase().includes(shown.toLowerCase())) {
      return { ok: false, why: `the selector still reads "${shown}" after choosing "${want}" — the selection did not take` };
    }
    return { ok: true, modelId: wanted, shown, why: '' };
  }

  async function current(page) { return pageops.currentModel(page, plan); }
  async function thread(page) { return pageops.threadId(page, plan); }
  async function turnCount(page) {
    const t = await pageops.turns(page, plan);
    return t.ok ? { ok: true, count: t.count } : { ok: false, why: t.why, count: 0 };
  }

  /** Open a thread this session owns. Never "the most recent chat". */
  async function openThread(page, binding) {
    const url = binding && binding.url ? String(binding.url) : (typeof plan.threadUrl === 'function' ? plan.threadUrl(binding && binding.threadId) : null);
    if (!url) return { ok: false, why: 'the binding does not say where that conversation is' };
    if (!url.startsWith(plan.origin)) return { ok: false, why: 'refusing to open a conversation URL outside this source' };
    const nav = await page.navigate(url, webbrowser.NAV_TIMEOUT_MS);
    if (!nav.ok) return { ok: false, why: nav.why };
    const seen = await pageops.threadId(page, plan);
    if (!seen.ok) return { ok: false, why: seen.why };
    if (String(seen.threadId || '') !== String(binding.threadId)) {
      return { ok: false, why: 'the site did not open the conversation LAIN asked for' };
    }
    return { ok: true, why: '' };
  }

  /** A fresh conversation, by going to the site's own new-chat URL. */
  async function newThread(page) {
    const nav = await page.navigate(plan.newChatUrl || plan.url, webbrowser.NAV_TIMEOUT_MS);
    if (!nav.ok) return { ok: false, why: nav.why };
    const ready = await pageops.waitVisible(page, 'the composer', plan.composer.selectors || []);
    return ready.ok ? { ok: true, why: '' } : { ok: false, why: ready.why };
  }

  /**
   * PUT THE PROMPT IN AND PRESS SEND.
   *
   * `submitted` is reported SEPARATELY from `ok` because the caller's retry rule
   * turns on exactly that distinction: a prompt that never reached the composer
   * may be retried, and one that may have been sent may not. See webmodel.js.
   */
  async function submit(page, text) {
    const filled = await pageops.fill(page, 'the composer', plan.composer.selectors || [], text);
    if (!filled.ok) return { ok: false, submitted: false, why: filled.why };
    const sent = await pageops.click(page, 'the send button', plan.composer.submitSelectors || []);
    if (!sent.ok) return { ok: false, submitted: false, why: sent.why };
    return { ok: true, submitted: true, why: '' };
  }

  async function settle(page, opts) { return pageops.settle(page, plan, opts); }

  /** Stop a reply in progress, so a cancel leaves the site in a usable state. */
  async function stop(page) {
    const r = await pageops.click(page, 'the stop button', plan.turns.stopSelectors || []);
    // A reply that already finished has no stop button, and that is not an error.
    return { ok: true, stopped: r.ok };
  }

  async function close() { return browser.close(id); }

  return {
    id,
    label: plan.label,
    url: plan.url,
    origin: plan.origin,
    plan,
    ensurePage, authState, models, select, current, thread, turnCount,
    openThread, newThread, submit, settle, stop, close,
    availability: () => browser.availability(),
  };
}

module.exports = { create, AUTH };
