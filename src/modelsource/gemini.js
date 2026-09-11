'use strict';

/**
 * GEMINI.GOOGLE.COM — the second chat source, and the proof the seam is real.
 *
 * ------------------------------------------------------------------------
 * A WEBSITE SOURCE AND AN API SOURCE ARE DIFFERENT THINGS.
 *
 * If a Gemini API connection is configured in LAIN's catalog, it is unrelated to
 * this. That one is `lain` with a Gemini model, reached with a key LAIN holds,
 * billed to that key, subject to the connection breaker and the model catalog.
 * THIS one is a page a person is signed into with their Google account, subject
 * to that account's own limits, needing no key at all.
 *
 * They can both exist at once and they must never be merged: the failure modes,
 * the quotas and the model lists are all different, and a picker that showed
 * them as one entry would make "why did it say I hit my limit" unanswerable.
 *
 * ------------------------------------------------------------------------
 * SAME PLAN SHAPE, SAME ORCHESTRATOR, NO SECOND IMPLEMENTATION.
 *
 * Everything below is a declaration. The connect, discover, select, guard,
 * submit, settle, bind, cancel and classify logic is webmodel.js — one copy,
 * shared with ChatGPT and with the fixture that the conformance suite drives.
 * Adding a third site is another file of this shape and no change to the core;
 * that property is asserted by the conformance suite rather than asserted here.
 *
 * ------------------------------------------------------------------------
 * NOT LIVE VERIFIED. Same caveat as chatgpt.js: the orchestration is fixture
 * verified, these selectors are proved only by `/source check gemini` against a
 * real signed-in account, and no default test tier contacts Google.
 */

const { SOURCE, LABEL } = require('./contract');
const websurface = require('./websurface');

const ORIGIN = 'https://gemini.google.com';

/**
 * A CONVERSATION ID OUT OF A URL.
 *
 * Gemini spells a thread `/app/<id>`. Strict, for the reason chatgpt.js gives:
 * a loose pattern binds a session to something that is not a conversation.
 */
function threadIdFromUrl(url) {
  const m = /^https:\/\/gemini\.google\.com\/app\/([0-9a-z]{6,})/i.exec(String(url || ''));
  return m ? m[1] : null;
}

const PLAN = {
  id: SOURCE.GEMINI_WEB,
  label: LABEL[SOURCE.GEMINI_WEB],
  origin: ORIGIN,
  url: `${ORIGIN}/app`,
  newChatUrl: `${ORIGIN}/app`,
  threadIdFromUrl,
  threadUrl: (id) => (id ? `${ORIGIN}/app/${id}` : null),

  auth: {
    signedInSelectors: [
      'rich-textarea [contenteditable="true"]',
      '[aria-label*="Enter a prompt" i]',
      'input-area-v2',
    ],
    signedOutSelectors: [
      'a[href*="accounts.google.com/ServiceLogin"]',
      'a[href*="accounts.google.com/signin"]',
      '[data-test-id="sign-in-button"]',
    ],
    challengeSelectors: [
      'iframe[src*="recaptcha"]',
      'form[action*="challenge" i]',
      '[aria-label*="2-step verification" i]',
    ],
  },

  modelMenu: {
    triggerSelectors: [
      'bard-mode-switcher button',
      'button[aria-label*="model" i]',
      'button[aria-haspopup="menu"][aria-label*="Gemini" i]',
    ],
    optionSelectors: [
      '[role="menu"] [role="menuitemradio"]',
      '[role="menu"] [role="menuitem"]',
      '[role="listbox"] [role="option"]',
    ],
    idAttributes: ['data-test-id', 'data-value', 'data-model', 'id'],
    currentSelectors: [
      'bard-mode-switcher button',
      'button[aria-label*="model" i]',
    ],
    closeSelectors: [],
  },

  composer: {
    selectors: ['rich-textarea [contenteditable="true"]', '[aria-label*="Enter a prompt" i]', 'textarea[aria-label]'],
    submitSelectors: [
      'button[aria-label*="Send message" i]',
      'button.send-button',
      '[data-test-id="send-button"]',
    ],
  },

  turns: {
    assistantSelectors: [
      'model-response',
      'message-content[data-test-id="model-response-text"]',
      '[data-response-index]',
    ],
    streamingSelectors: [
      'button[aria-label*="Stop response" i]',
      '[data-test-id="stop-button"]',
      '.response-loading',
    ],
    stopSelectors: ['button[aria-label*="Stop response" i]', '[data-test-id="stop-button"]'],
  },

  errors: {
    selectors: ['[role="alert"]', '.error-message', '[data-test-id="error-banner"]'],
    rateLimitPatterns: [
      'rate limit',
      'too many requests',
      "you'?ve reached",
      'limit for',
      'try again (?:in|after|later)',
      'quota',
    ],
  },
};

function surface(deps) { return websurface.create(PLAN, deps); }

module.exports = { PLAN, surface, threadIdFromUrl, ORIGIN };
