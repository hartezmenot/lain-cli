'use strict';

/**
 * THE TWO SITE ADAPTERS, CHECKED FOR WHAT CAN BE CHECKED WITHOUT THE SITES.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS CAN AND CANNOT ESTABLISH — stated plainly, because the gap between
 * the two is exactly where an over-claimed status label would go.
 *
 * IT CAN establish that each plan DECLARES every operation the surface needs,
 * that its evidence order is the one pageops.js requires (semantic attributes
 * and ARIA, never a generated class or an nth-child index), that its thread-id
 * pattern accepts that site's URLs and rejects everything else including the
 * other site's, and that the DOM driver is honest about a page it cannot read.
 *
 * IT CANNOT establish that chatgpt.com's model menu still has that shape today.
 * Only chatgpt.com can, and asking needs an account, a browser and a person to
 * log in. That is `/source check chatgpt`, run by hand. Nothing in this file
 * opens a socket.
 *
 * A green run here is FIXTURE VERIFIED. It is never LIVE VERIFIED.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

const chatgpt = require('../../src/modelsource/chatgpt');
const gemini = require('../../src/modelsource/gemini');
const websurface = require('../../src/modelsource/websurface');
const pageops = require('../../src/modelsource/pageops');

const SITES = [['chatgpt', chatgpt], ['gemini', gemini]];

/** A page that answers every evaluate with a scripted value. No browser. */
function page(answers) {
  return {
    calls: [],
    async evaluate(expr) {
      this.calls.push(expr);
      for (const [pattern, value] of answers) {
        if (new RegExp(pattern).test(expr)) return { ok: true, value };
      }
      return { ok: true, value: null };
    },
    async navigate() { return { ok: true }; },
  };
}

module.exports = async function () {
  for (const [name, site] of SITES) {
    await test(`ADAPTER[${name}]: the plan declares every operation the surface needs`, () => {
      const p = site.PLAN;
      assert.ok(p.id && p.label && p.origin && p.url, 'identity');
      assert.ok(typeof p.threadIdFromUrl === 'function' && typeof p.threadUrl === 'function', 'threads');
      for (const key of ['signedInSelectors', 'signedOutSelectors', 'challengeSelectors']) {
        assert.ok(Array.isArray(p.auth[key]) && p.auth[key].length, `auth.${key}`);
      }
      for (const key of ['triggerSelectors', 'optionSelectors', 'currentSelectors', 'idAttributes']) {
        assert.ok(Array.isArray(p.modelMenu[key]) && p.modelMenu[key].length, `modelMenu.${key}`);
      }
      assert.ok(p.composer.selectors.length && p.composer.submitSelectors.length, 'composer');
      for (const key of ['assistantSelectors', 'streamingSelectors', 'stopSelectors']) {
        assert.ok(Array.isArray(p.turns[key]) && p.turns[key].length, `turns.${key}`);
      }
      assert.ok(p.errors.selectors.length && p.errors.rateLimitPatterns.length, 'errors');
    });

    await test(`ADAPTER[${name}]: no selector depends on a generated class or a position`, () => {
      // A generated class survives until the next deploy and an nth-child index
      // until somebody adds a row — and both fail SILENTLY, which is the worst
      // property a selector can have here: the wrong element is clicked and
      // everything downstream reports success.
      const every = JSON.stringify(site.PLAN);
      const banned = [/:nth-child/, /:nth-of-type/, /\.[a-z]+-[0-9a-f]{5,}/i, /\bstyle=/];
      for (const re of banned) assert.ok(!re.test(every), `${re} appears in the ${name} plan`);
    });

    await test(`ADAPTER[${name}]: every rate-limit pattern is a valid, anchored-enough regex`, () => {
      for (const p of site.PLAN.errors.rateLimitPatterns) {
        assert.doesNotThrow(() => new RegExp(p, 'i'), p);
        assert.ok(p.length >= 5, `"${p}" is short enough to match an unrelated banner`);
      }
    });

    await test(`ADAPTER[${name}]: a thread id is read only from that site's own URL`, () => {
      const other = name === 'chatgpt' ? gemini : chatgpt;
      assert.strictEqual(site.threadIdFromUrl(''), null);
      assert.strictEqual(site.threadIdFromUrl('https://example.com/c/abc123def'), null);
      assert.strictEqual(site.threadIdFromUrl(`${other.ORIGIN}/app/abc123def`), null,
        'one site must never claim the other site\'s conversation');
      const mine = site.PLAN.threadUrl('abc123def456');
      assert.strictEqual(site.threadIdFromUrl(mine), 'abc123def456', mine);
    });

    await test(`ADAPTER[${name}]: refuses to open a conversation URL outside its own origin`, async () => {
      const surface = site.surface({ browser: { page: async () => ({ ok: true, session: page([]) }), availability: () => ({ available: true }), close: async () => ({ ok: true }) } });
      const r = await surface.openThread(page([]), { threadId: 'x', url: 'https://evil.example/c/x' });
      assert.strictEqual(r.ok, false);
      assert.match(r.why, /outside this source/);
    });
  }

  // ------------------------------------------------------- the DOM driver --

  await test('PAGEOPS: an unreadable model menu is a stated failure, not an empty list', async () => {
    const p = page([]);                       // nothing matches anything
    const r = await pageops.readModelMenu(p, chatgpt.PLAN);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.models, []);
    assert.match(r.why, /model selector/i);
  });

  await test('PAGEOPS: a composer that does not hold the text refuses to submit', async () => {
    // A submit after an unverified type is how an EMPTY prompt reaches a website.
    const p = page([['isContentEditable', { matched: '#prompt-textarea', chars: 0, holds: false }]]);
    const r = await pageops.fill(p, 'the composer', ['#prompt-textarea'], 'hello');
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /did not take the text/);
  });

  await test('PAGEOPS: a reply is only accepted once the assistant turn count GREW', async () => {
    // Without this a prompt that was never accepted returns the PREVIOUS answer
    // as this turn's, and nothing anywhere can tell.
    const p = page([['nodes.length', { count: 3, streaming: false, text: 'an older answer' }]]);
    const r = await pageops.settle(p, chatgpt.PLAN, { before: 3, timeoutMs: 60 });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /not certain the prompt was answered/);
  });

  await test('PAGEOPS: a reply that started and did not finish says so distinctly', async () => {
    const p = page([['nodes.length', { count: 4, streaming: true, text: 'half an ans' }]]);
    const r = await pageops.settle(p, chatgpt.PLAN, { before: 3, timeoutMs: 60 });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /started but had not finished/);
  });

  await test('PAGEOPS: a retry time is read only when the page states one', () => {
    assert.strictEqual(pageops.retryFrom('something went wrong'), null);
    assert.strictEqual(pageops.retryFrom('try again in 15 minutes'), 900000);
    assert.strictEqual(pageops.retryFrom('please try again after 2 hours'), 7200000);
    assert.strictEqual(pageops.retryFrom('try again later'), null, 'no number means no claim');
  });

  await test('PAGEOPS: the two site plans share ONE driver — no second implementation', () => {
    // The value of the plan/driver split is that it holds. A hand-written DOM
    // routine inside an adapter would drift from the other one, and the second
    // is the one nobody tests.
    for (const [name] of SITES) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modelsource', `${name}.js`), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/\bevaluate\s*\(/.test(code), `${name}.js drives the DOM itself`);
      assert.ok(!/document\./.test(code), `${name}.js reaches into a document`);
      assert.ok(!/querySelector/.test(code), `${name}.js has its own selector code`);
    }
  });

  await test('SURFACE: both adapters produce the SAME set of operations', () => {
    const fake = { page: async () => ({ ok: false, why: 'no' }), availability: () => ({ available: false, why: 'no' }), close: async () => ({ ok: true }) };
    const a = Object.keys(chatgpt.surface({ browser: fake })).sort();
    const b = Object.keys(gemini.surface({ browser: fake })).sort();
    assert.deepStrictEqual(a, b);
    for (const op of ['ensurePage', 'authState', 'models', 'select', 'thread', 'openThread', 'newThread', 'turnCount', 'submit', 'settle', 'stop', 'close']) {
      assert.ok(a.includes(op), `the surface must declare ${op}`);
    }
    // AND THE FIXTURE ANSWERS TO THE SAME CONTRACT, which is what makes the
    // conformance suite a test of the real orchestrator rather than of a mock.
    const fx = require('../../src/modelsource/fixture').create({});
    for (const op of a) {
      if (['plan', 'label', 'id', 'url', 'origin', 'availability'].includes(op)) continue;
      assert.strictEqual(typeof fx[op], 'function', `the fixture is missing ${op}`);
    }
  });

  await test('SURFACE: the auth verdict is three-valued, and UNKNOWN is not AUTH_REQUIRED', () => {
    assert.deepStrictEqual(Object.keys(websurface.AUTH).sort(), ['AUTH_REQUIRED', 'READY', 'UNKNOWN']);
  });

  await test('SURFACE: the settle verdicts pageops emits are ones the contract knows', () => {
    // pageops.js is the DOM layer and deliberately does not import the contract
    // — a selector driver has no business knowing about model sources. The cost
    // of that seam is that its verdict strings and `contract.STATUS` could
    // silently drift apart, and the symptom would be a real answer classified
    // as an unknown failure. This is the assertion that they have not.
    const { STATUS } = require('../../src/modelsource/contract');
    const src = fs.readFileSync(require.resolve('../../src/modelsource/pageops'), 'utf8');
    const emitted = new Set([...src.matchAll(/status:\s*'([A-Z_]+)'/g)].map((m) => m[1]));
    assert.ok(emitted.size >= 3, `expected pageops to emit several verdicts, saw ${[...emitted].join(', ')}`);
    for (const v of emitted) assert.ok(v in STATUS, `pageops emits "${v}", which the contract does not declare`);
  });
};
