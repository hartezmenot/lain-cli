'use strict';

/**
 * READING A CHAT SITE STRUCTURALLY — one implementation, two declarations.
 *
 * ------------------------------------------------------------------------
 * WHAT A SITE ADAPTER IS ALLOWED TO BE.
 *
 * ChatGPT.com and Gemini.google.com are different products with the same shape:
 * a signed-in state, a model menu, a composer, a stream of assistant turns, a
 * stop button and an error banner. So the ADAPTER is a PLAN — a declaration of
 * how each of those is recognised — and the machinery that acts on a plan is
 * here, once. Two hand-written DOM drivers would drift apart, and the second
 * one would be the one nobody tested.
 *
 * ------------------------------------------------------------------------
 * THE EVIDENCE ORDER, AND IT IS NOT NEGOTIABLE.
 *
 *   1. stable semantic attributes   [data-testid], [aria-label], role
 *   2. accessibility state          the tree, which says what a user is TOLD
 *   3. normalised visible text      the label a person reads
 *
 * NOT USED: pixel positions, nth-child indexes, generated class names, and
 * screenshots. A generated class survives until the site's next deploy; an
 * nth-child index survives until somebody adds a row. Both fail SILENTLY, which
 * is the worst property a selector can have — the wrong element is clicked and
 * everything downstream reports success.
 *
 * Vision is not a fallback for ordinary discovery. If the structure cannot be
 * read, that is reported as a structure that cannot be read.
 *
 * ------------------------------------------------------------------------
 * EVERY OPERATION FAILS EXPLICITLY.
 *
 * There is no branch below that returns a plausible default when it could not
 * establish something. A model menu that will not open produces "the model
 * selector could not be opened", not an empty list that reads as "this account
 * has no models". See webmodel.js for what the caller does with that.
 */

/** How long a menu, a composer or a page element gets to appear. */
const APPEAR_MS = 8_000;
/** How long the whole reply is allowed to take before it is INCONCLUSIVE. */
const SETTLE_MS = 300_000;
/** The reply is finished when nothing has changed for this long AND it is not streaming. */
const QUIET_MS = 1_500;
/** How often the page is polled while a reply arrives. */
const POLL_MS = 400;
/** Bound on anything read out of a page. */
const MAX_TEXT = 60_000;

/** JSON-encode for embedding in an evaluated expression. Never string concat. */
function lit(v) { return JSON.stringify(v == null ? null : v); }

/**
 * ONE EVALUATE, WITH A NAMED FAILURE.
 *
 * `page.evaluate` already reports a thrown page as `{ok:false, why}`; this adds
 * nothing but the name of what was being attempted, which is the difference
 * between a debuggable report and "the page threw".
 */
async function ask(page, what, expression) {
  if (!page || typeof page.evaluate !== 'function') return { ok: false, why: `${what}: there is no page to read` };
  const r = await page.evaluate(expression);
  if (!r.ok) return { ok: false, why: `${what}: ${r.why}` };
  return { ok: true, value: r.value };
}

/**
 * IS ANY OF THESE PRESENT AND VISIBLE?
 *
 * Visibility matters: chat sites keep their sign-in dialogs in the DOM and hide
 * them, so "the login button exists" is not "you are signed out".
 */
function visibleExpr(selectors) {
  return `(() => {
    const sel = ${lit(selectors)};
    for (const s of sel) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0) {
          return { matched: s, text: (el.innerText || el.textContent || '').trim().slice(0, 400) };
        }
      }
    }
    return null;
  })()`;
}

async function firstVisible(page, what, selectors) {
  const r = await ask(page, what, visibleExpr(selectors || []));
  if (!r.ok) return { ok: false, why: r.why, found: null };
  return { ok: true, found: r.value || null };
}

/** Wait for one of `selectors` to be visible. Bounded, and it says when it gave up. */
async function waitVisible(page, what, selectors, timeoutMs = APPEAR_MS) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling a page is the only
    // way to wait on arbitrary DOM; the deadline is the caller's bound.
    const r = await firstVisible(page, what, selectors);
    if (r.ok && r.found) return { ok: true, found: r.found };
    if (Date.now() >= deadline) {
      return { ok: false, why: `${what}: nothing matching ${(selectors || []).join(' | ')} appeared within ${timeoutMs}ms` };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 150));
  }
}

/** Click the first visible match. Reports WHICH selector it used. */
async function click(page, what, selectors) {
  const expr = `(() => {
    const sel = ${lit(selectors)};
    for (const s of sel) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') {
          if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return { ok: false, why: 'disabled', matched: s };
          el.click();
          return { ok: true, matched: s };
        }
      }
    }
    return { ok: false, why: 'absent' };
  })()`;
  const r = await ask(page, what, expr);
  if (!r.ok) return { ok: false, why: r.why };
  const v = r.value || {};
  if (!v.ok) return { ok: false, why: `${what}: ${v.why === 'disabled' ? `${v.matched} is disabled` : `nothing matching ${(selectors || []).join(' | ')} is on the page`}` };
  return { ok: true, matched: v.matched };
}

/**
 * TYPE INTO THE COMPOSER, then prove the text is there.
 *
 * Chat composers are `contenteditable` as often as they are `<textarea>`, and
 * both are driven by a framework that keeps its own state — setting `.value` or
 * `.textContent` without dispatching an input event submits an empty message.
 * The READ-BACK is what makes this an observation rather than a hope: a submit
 * that follows an unverified type is how an empty prompt reaches a website.
 */
async function fill(page, what, selectors, text) {
  const expr = `(() => {
    const sel = ${lit(selectors)};
    const body = ${lit(String(text))};
    for (const s of sel) {
      const el = document.querySelector(s);
      if (!el) continue;
      el.focus();
      if (el.isContentEditable) {
        el.textContent = '';
        document.execCommand('insertText', false, body);
        if (!el.textContent) el.textContent = body;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: body }));
      } else {
        const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
        if (d && d.set) d.set.call(el, body); else el.value = body;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const now = el.isContentEditable ? (el.innerText || el.textContent || '') : String(el.value == null ? '' : el.value);
      return { matched: s, chars: now.length, holds: now.trim() === body.trim() };
    }
    return null;
  })()`;
  const r = await ask(page, what, expr);
  if (!r.ok) return { ok: false, why: r.why };
  if (!r.value) return { ok: false, why: `${what}: no composer matching ${(selectors || []).join(' | ')}` };
  if (!r.value.holds) {
    return { ok: false, why: `${what}: the composer did not take the text (it holds ${r.value.chars} characters)` };
  }
  return { ok: true, matched: r.value.matched };
}

/**
 * THE MODEL MENU, READ RATHER THAN GUESSED.
 *
 * Opens the trigger, waits for options, reads role/label/state off each, closes
 * it again. Availability is read from what the option ACTUALLY SAYS about itself
 * — `aria-disabled`, a disabled attribute — and is UNKNOWN when the option
 * carries no such statement. A site that stops marking unavailable models must
 * make LAIN say "unknown", never "available".
 */
async function readModelMenu(page, plan) {
  const menu = (plan && plan.modelMenu) || {};
  const opened = await click(page, 'open the model selector', menu.triggerSelectors || []);
  if (!opened.ok) return { ok: false, why: opened.why, models: [] };
  const appeared = await waitVisible(page, 'the model list', menu.optionSelectors || [], APPEAR_MS);
  if (!appeared.ok) {
    await closeMenu(page, plan);
    return { ok: false, why: appeared.why, models: [] };
  }
  const expr = `(() => {
    const sel = ${lit(menu.optionSelectors || [])};
    const idAttrs = ${lit(menu.idAttributes || ['data-testid', 'data-value', 'data-model', 'id'])};
    const out = [];
    const seen = new Set();
    for (const s of sel) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;
        let id = null;
        for (const a of idAttrs) { const v = el.getAttribute(a); if (v) { id = v; break; } }
        const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').split(/[ \\t\\n\\r]+/).join(' ').trim();
        if (!id && !label) continue;
        const key = id || label;
        if (seen.has(key)) continue;
        seen.add(key);
        const ariaDisabled = el.getAttribute('aria-disabled');
        const checked = el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';
        out.push({
          id: key,
          label: label.slice(0, 120) || key,
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          disabled: ariaDisabled === 'true' || Boolean(el.disabled),
          statesAvailability: ariaDisabled != null || 'disabled' in el,
          current: checked,
        });
      }
    }
    return out;
  })()`;
  const read = await ask(page, 'read the model list', expr);
  await closeMenu(page, plan);
  if (!read.ok) return { ok: false, why: read.why, models: [] };
  const rows = Array.isArray(read.value) ? read.value : [];
  if (!rows.length) {
    return { ok: false, why: 'the model selector opened but listed nothing LAIN could read — the site structure has changed', models: [] };
  }
  return { ok: true, models: rows, why: '' };
}

/** Close whatever the menu was, without clicking anything inside it. */
async function closeMenu(page, plan) {
  const menu = (plan && plan.modelMenu) || {};
  if (menu.closeSelectors && menu.closeSelectors.length) {
    const r = await click(page, 'close the model selector', menu.closeSelectors);
    if (r.ok) return r;
  }
  return ask(page, 'dismiss the model selector', `(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    return true;
  })()`);
}

/**
 * WHAT THE PAGE SAYS IT IS USING RIGHT NOW.
 *
 * Read from the trigger's own label, which is what a person sees. Used to VERIFY
 * a selection took effect — never to decide which model to use, because the
 * whole point of an explicit selection is that "whatever is active" is not it.
 */
async function currentModel(page, plan) {
  const menu = (plan && plan.modelMenu) || {};
  const r = await firstVisible(page, 'the current model', menu.currentSelectors || menu.triggerSelectors || []);
  if (!r.ok) return { ok: false, why: r.why, label: null };
  if (!r.found) return { ok: false, why: 'the page does not say which model is selected', label: null };
  return { ok: true, label: String(r.found.text || '').replace(/\s+/g, ' ').trim().slice(0, 120) };
}

/**
 * THE ASSISTANT TURNS ON THE PAGE — how many, and what the last one says.
 *
 * The COUNT is what makes a send verifiable. "Did the reply arrive" cannot be
 * answered by looking at the last message alone: the last message before the
 * send was also an assistant message, and text that has not changed is
 * indistinguishable from text that has not arrived. Counting turns before and
 * after is the observation that separates them.
 */
async function turns(page, plan) {
  const t = (plan && plan.turns) || {};
  const expr = `(() => {
    const sel = ${lit(t.assistantSelectors || [])};
    let nodes = [];
    for (const s of sel) { const found = document.querySelectorAll(s); if (found.length) { nodes = [...found]; break; } }
    const streaming = ${lit(t.streamingSelectors || [])}.some((s) => document.querySelector(s));
    const last = nodes[nodes.length - 1];
    return {
      count: nodes.length,
      streaming,
      text: last ? (last.innerText || last.textContent || '').trim().slice(0, ${MAX_TEXT}) : '',
    };
  })()`;
  const r = await ask(page, 'read the conversation', expr);
  if (!r.ok) return { ok: false, why: r.why };
  const v = r.value || {};
  return { ok: true, count: Number(v.count) || 0, streaming: Boolean(v.streaming), text: String(v.text || '') };
}

/**
 * WHAT ERROR IS THE PAGE SHOWING, IF ANY.
 *
 * A rate limit and a generic failure are different events with different fixes,
 * and a website says which in words. The patterns are declared per site; nothing
 * here guesses that "something went wrong" means a quota.
 */
async function errorState(page, plan) {
  const e = (plan && plan.errors) || {};
  const r = await firstVisible(page, 'an error banner', e.selectors || []);
  if (!r.ok || !r.found) return { present: false, rateLimited: false, why: '', retryAfterMs: null };
  const text = String(r.found.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const rateLimited = (e.rateLimitPatterns || []).some((p) => new RegExp(p, 'i').test(text));
  return { present: true, rateLimited, why: text || 'the site is showing an error', retryAfterMs: retryFrom(text) };
}

/**
 * A RETRY TIME, ONLY IF THE PAGE STATED ONE.
 *
 * Returns null far more often than not, and that is correct: an invented retry
 * time is worse than no retry time, because a caller will schedule against it.
 */
function retryFrom(text) {
  const s = String(text || '');
  let m = /\bin\s+(\d+)\s*(second|minute|hour)s?\b/i.exec(s);
  if (!m) m = /\bafter\s+(\d+)\s*(second|minute|hour)s?\b/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  return n * (unit === 'hour' ? 3_600_000 : unit === 'minute' ? 60_000 : 1_000);
}

/**
 * WAIT FOR THE REPLY TO THIS TURN, and be able to say it is THIS turn's.
 *
 * `before` is the turn count observed immediately before submitting. A reply is
 * only accepted once the count has GROWN — so a page that never accepted the
 * prompt produces a timeout rather than the previous answer read back as a new
 * one, which is the single most dangerous failure a driver like this can have.
 *
 * COMPLETION is: not streaming, and the text has stopped changing for QUIET_MS.
 * Either alone is wrong — a site between chunks is momentarily quiet, and a
 * streaming indicator that is removed early would truncate the answer.
 */
async function settle(page, plan, { before = 0, signal = null, timeoutMs = SETTLE_MS, onProgress = null } = {}) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let lastText = '';
  let lastChange = Date.now();
  let grew = false;
  for (;;) {
    if (signal && signal.aborted) return { ok: false, status: 'CANCELLED', why: 'cancelled while waiting for the reply' };
    // eslint-disable-next-line no-await-in-loop
    const err = await errorState(page, plan);
    if (err.present) {
      return {
        ok: false,
        status: err.rateLimited ? 'RATE_LIMITED' : 'FAILED',
        why: err.why,
        retryAfterMs: err.retryAfterMs,
      };
    }
    // eslint-disable-next-line no-await-in-loop
    const t = await turns(page, plan);
    if (!t.ok) return { ok: false, status: 'FAILED', why: t.why };
    if (t.count > before) {
      grew = true;
      if (t.text !== lastText) {
        lastText = t.text;
        lastChange = Date.now();
        if (onProgress) { try { onProgress(lastText.length); } catch { /* a listener may not stop the wait */ } }
      }
      if (!t.streaming && lastText && Date.now() - lastChange >= QUIET_MS) {
        return { ok: true, status: 'COMPLETED', text: lastText, why: '' };
      }
    }
    if (Date.now() >= deadline) {
      // INCONCLUSIVE, AND SAID AS SUCH. Two very different situations end up
      // here and the caller must be able to tell them apart: nothing ever
      // arrived, or something arrived and never stopped.
      return {
        ok: false,
        status: 'FAILED',
        why: grew
          ? `a reply started but had not finished after ${Math.round(timeoutMs / 1000)}s — the result is inconclusive`
          : `no new reply appeared within ${Math.round(timeoutMs / 1000)}s — it is not certain the prompt was answered`,
        partial: grew,
      };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** The thread this page is showing, from the URL the site itself put there. */
async function threadId(page, plan) {
  const r = await ask(page, 'read the conversation id', 'location.href');
  if (!r.ok) return { ok: false, why: r.why, threadId: null, url: null };
  const url = String(r.value || '');
  const id = plan && typeof plan.threadIdFromUrl === 'function' ? plan.threadIdFromUrl(url) : null;
  return { ok: true, threadId: id || null, url };
}

module.exports = {
  ask, firstVisible, waitVisible, click, fill,
  readModelMenu, closeMenu, currentModel, turns, errorState, settle, threadId, retryFrom,
  APPEAR_MS, SETTLE_MS, QUIET_MS, POLL_MS, MAX_TEXT,
};
