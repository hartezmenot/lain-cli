'use strict';

/**
 * CHATGPT.COM — a chat source, declared rather than programmed.
 *
 * ------------------------------------------------------------------------
 * NO API KEY, AND IT IS NOT AN API.
 *
 * This does not pretend the website is an OpenAI-compatible endpoint. It does
 * not call `api.openai.com`, does not hold a token, and is not registered in the
 * connection catalog — a route in that catalog is something LAIN can reach with
 * a credential it holds, and this is a page a PERSON is logged into. Merging the
 * two would make `/models` offer web models it cannot route to and would make a
 * turn's failure modes incomprehensible.
 *
 * If an OpenAI API connection is also configured, the two are unrelated and both
 * work: one is `lain` with a model from the catalog, the other is `chatgpt-web`
 * with a model from the account.
 *
 * ------------------------------------------------------------------------
 * WHAT A PLAN IS, AND WHY IT LOOKS LIKE THIS.
 *
 * Each entry is a LIST of candidate selectors tried in order, and the order is
 * the evidence order pageops.js states: `data-testid` first (the site's own
 * stable hooks), then ARIA role and label (what a user is TOLD), then a
 * structural tag. There is no class name here, no nth-child and no coordinate.
 *
 * SELECTOR DRIFT IS EXPECTED AND IS HANDLED BY FAILING LOUDLY. When none of the
 * candidates matches, the operation reports "the model selector could not be
 * opened" and the turn ends INCONCLUSIVE. It never proceeds on a guess, because
 * every downstream consequence of a wrong guess — the wrong model selected, the
 * prompt typed into the wrong box, an old reply returned as new — is silent.
 *
 * ------------------------------------------------------------------------
 * NOT LIVE VERIFIED. These selectors are the site's documented and observable
 * hooks as of this pass; they are exercised by the fixture, which proves the
 * ORCHESTRATION, and they are proved against the real site only by
 * `/source check chatgpt`, which a person runs deliberately. Nothing in the
 * default test tiers touches chatgpt.com. See docs/MODEL-SOURCES.md.
 */

const { SOURCE, LABEL } = require('./contract');
const websurface = require('./websurface');

const ORIGIN = 'https://chatgpt.com';

/**
 * A CONVERSATION ID OUT OF A URL, and null for anything else.
 *
 * Deliberately strict. A loose pattern that matched the site's other paths would
 * bind a LAIN session to something that is not a conversation, and binding.js
 * would then faithfully keep returning to it.
 */
function threadIdFromUrl(url) {
  const m = /^https:\/\/chatgpt\.com\/c\/([0-9a-f-]{8,})/i.exec(String(url || ''));
  return m ? m[1] : null;
}

const PLAN = {
  id: SOURCE.CHATGPT_WEB,
  label: LABEL[SOURCE.CHATGPT_WEB],
  origin: ORIGIN,
  url: `${ORIGIN}/`,
  newChatUrl: `${ORIGIN}/`,
  threadIdFromUrl,
  threadUrl: (id) => (id ? `${ORIGIN}/c/${id}` : null),

  auth: {
    // SIGNED IN: the composer exists. It is the strongest possible evidence,
    // because it is the thing the whole session is for — a page that has it is
    // a page that can be asked something.
    signedInSelectors: [
      '[data-testid="composer-speech-button"]',
      '#prompt-textarea',
      'form [contenteditable="true"]',
      'textarea[placeholder]',
    ],
    // SIGNED OUT: the site's own login and signup controls.
    signedOutSelectors: [
      '[data-testid="login-button"]',
      '[data-testid="signup-button"]',
      'a[href*="/auth/login"]',
      'button[data-testid="mobile-login-button"]',
    ],
    // A CHALLENGE IS AUTH, NOT A FAILURE — and LAIN never attempts one.
    challengeSelectors: [
      'iframe[title*="challenge" i]',
      'iframe[src*="cloudflare"]',
      '[aria-label*="verify you are human" i]',
      'form[action*="mfa" i]',
    ],
  },

  modelMenu: {
    triggerSelectors: [
      '[data-testid="model-switcher-dropdown-button"]',
      'button[aria-label*="model" i]',
      'button[aria-haspopup="menu"][id*="model" i]',
    ],
    optionSelectors: [
      '[data-testid^="model-switcher-"]',
      '[role="menu"] [role="menuitem"]',
      '[role="listbox"] [role="option"]',
    ],
    // WHERE AN ID COMES FROM, in order. `data-testid` on this site encodes the
    // model slug, which is a far better identity than a visible label that is
    // translated, decorated and re-worded between deploys.
    idAttributes: ['data-testid', 'data-value', 'data-model', 'id'],
    currentSelectors: [
      '[data-testid="model-switcher-dropdown-button"]',
      'button[aria-label*="model" i]',
    ],
    closeSelectors: [],
  },

  composer: {
    selectors: ['#prompt-textarea', 'form [contenteditable="true"]', 'textarea[data-id]'],
    submitSelectors: [
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[data-testid="fruitjuice-send-button"]',
    ],
  },

  turns: {
    // ONE ROW PER ASSISTANT TURN. Counting these before and after a submit is
    // what proves a reply belongs to this turn — see pageops.settle.
    assistantSelectors: [
      '[data-message-author-role="assistant"]',
      '[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
    ],
    // STILL PRODUCING. The stop button is the site's own statement that a
    // response is in flight, which is more reliable than watching text grow.
    streamingSelectors: [
      '[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      '.result-streaming',
    ],
    stopSelectors: ['[data-testid="stop-button"]', 'button[aria-label="Stop generating"]'],
  },

  errors: {
    selectors: [
      '[role="alert"]',
      '[data-testid="error-message"]',
      '.text-token-text-error',
    ],
    // A QUOTA IS NOT A CRASH. Only these words make a failure RATE_LIMITED, and
    // everything else stays FAILED — the two have different fixes and a person
    // acting on the wrong one waits for a limit that will never clear.
    rateLimitPatterns: [
      'usage (?:cap|limit)',
      "you'?ve reached",
      'rate limit',
      'too many requests',
      'limit reached',
      'try again (?:in|after)',
      'upgrade to',
    ],
  },
};

/** The surface for this site. `deps.browser` is injected — see websurface.js. */
function surface(deps) { return websurface.create(PLAN, deps); }

module.exports = { PLAN, surface, threadIdFromUrl, ORIGIN };
