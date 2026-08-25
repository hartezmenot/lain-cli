'use strict';

/**
 * THE TOKEN PANE — every number carries where it came from.
 *
 * The incident that produced this pane was 815 requests and 59.2M input tokens
 * against 202K output. What made it survivable for so long was not that the
 * numbers were hidden — it was that nothing on screen distinguished a figure a
 * provider had stated from one LAIN had guessed, so there was nothing to
 * disbelieve.
 *
 * These tests pin the four states apart. A pane that prints `0` where it means
 * `unknown` is the failure, and it is a quiet one.
 */

const assert = require('assert');
const { test } = require('../helpers');

const tokenview = require('../../src/ui/tokenview');

/** Render and strip colour, so assertions are about words rather than escapes. */
function plain(opts) {
  return String(tokenview.render({ width: 80, ...opts })).replace(/\x1b\[[0-9;]*m/g, '');
}

module.exports = async function () {
  await test('TOKENVIEW: with nothing reported it says so instead of showing zeros', () => {
    const out = plain({});
    assert.match(out, /No request has been made yet|Nothing has been reported/);
    // ---- THE FAILURE THIS PREVENTS ---------------------------------------
    //
    // A pane of neat zeros reads as "this session has cost nothing", which is a
    // claim. The truth is that nothing has been measured yet, and those are
    // different statements.
    assert.ok(!/\b0\b\s*$/m.test(out), 'a plausible zero must not stand in for an absent measurement');
  });

  await test('TOKENVIEW: output is PENDING while a request is open, never a rising number', () => {
    const out = plain({
      open: true,
      live: { inputTokens: 42000, cacheReadTokens: 0 },
      usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    });
    assert.match(out, /42,000/, 'the input side is stated when the provider states it');
    // Every provider LAIN speaks to reports output only when the request
    // closes. A number here would be invented.
    assert.match(out, /pending/i);
    assert.match(out, /stated only when the request completes/);
  });

  await test('TOKENVIEW: a cache nobody reported reads as unknown, not as zero', () => {
    const out = plain({
      usage: { inputTokens: 100000, outputTokens: 500, cacheReadTokens: 0, requests: 4 },
      requests: 4,
    });
    // ZERO AND UNKNOWN ARE DIFFERENT FACTS. A route that reported a cold cache
    // told us something; one that has never mentioned caching has not.
    assert.match(out, /cached read\s+unknown/i);
    assert.match(out, /no route in this session has reported one/);
    assert.match(out, /cache hit rate\s+unknown/i);
  });

  await test('TOKENVIEW: a reported cache is shown as the number it is', () => {
    const out = plain({
      usage: { inputTokens: 100000, outputTokens: 500, cacheReadTokens: 24500, requests: 4 },
      requests: 4,
    });
    assert.match(out, /24,500/);
    assert.match(out, /24\.5%/, 'and the hit rate is derived from it');
    assert.ok(!/cached read\s+unknown/i.test(out));
  });

  await test('TOKENVIEW: the ratio that made the incident visible is on the pane', () => {
    // 59,243,462 input against 202,310 output over 815 requests — the reported
    // numbers. 293:1 is the fact nobody could see.
    const out = plain({
      usage: { inputTokens: 59243462, outputTokens: 202310, cacheReadTokens: 14535826, requests: 815 },
      requests: 815,
    });
    assert.match(out, /input : output\s+293 : 1/);
    assert.match(out, /average input\s+72\.7K/);
    assert.match(out, /24\.5%/, 'and the cache rate that explains part of it');
  });

  await test('TOKENVIEW: with no output yet the ratio says so rather than dividing by zero', () => {
    const out = plain({ usage: { inputTokens: 5000, outputTokens: 0, requests: 1 }, requests: 1 });
    assert.match(out, /no output reported yet/);
    assert.ok(!/Infinity|NaN/.test(out), 'a ratio with no denominator must not be printed');
  });

  await test('TOKENVIEW: a completed request is labelled ESTIMATED, because it is', () => {
    // The composition comes from tokenaudit.js counting characters in the array
    // LAIN transmitted. That is honest and it is not the provider's bill, and
    // the pane must not let those be confused.
    const out = plain({
      audit: {
        estTokens: { total: 64778, system: 3504, toolSchemas: 10329, user: 200, assistant: 100, toolResults: 50000, stablePrefix: 60000, duplicate: 0 },
        chars: { total: 233200, toolSchemas: 37186 },
      },
      usage: { inputTokens: 64778, outputTokens: 36, requests: 1 },
      requests: 1,
    });
    assert.match(out, /estimated from the transmitted array/);
    assert.match(out, /tool schemas\s+10\.3K/);
    // The share is what makes a fixed cost arguable rather than invisible.
    assert.match(out, /16% of the request/);
  });

  await test('TOKENVIEW: nothing on this pane is a counter that moves on its own', () => {
    // Two renders of identical state must be identical. A pane that animated to
    // look alive would differ, and would be unusable for diagnosis.
    const state = { usage: { inputTokens: 1000, outputTokens: 10, requests: 1 }, requests: 1 };
    assert.strictEqual(plain(state), plain(state));
  });
};
