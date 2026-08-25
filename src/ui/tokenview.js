'use strict';

/**
 * THE TOKEN PANE — what this conversation has actually cost.
 *
 * ------------------------------------------------------------------------
 * THE INCIDENT THIS PANE EXISTS FOR. A session reported 815 requests and
 * 59,243,462 input tokens against 202,310 output — 0.34% of everything spent
 * was the model speaking. Nothing on any screen could have shown that while it
 * was happening, and the first anyone knew of it was a provider bill.
 *
 * ------------------------------------------------------------------------
 * EVERY NUMBER HERE IS LABELLED WITH WHERE IT CAME FROM, and that is the whole
 * design. There are four kinds of number in this system and confusing them is
 * how a UI comes to lie:
 *
 *   MEASURED   the provider said so, in a usage block on the wire.
 *   ESTIMATED  LAIN counted characters and divided. Honest, and not the bill.
 *   PENDING    a request is open and this figure only exists when it closes.
 *   UNKNOWN    this provider has never reported this quantity at all.
 *
 * OUTPUT IS `PENDING` DURING EVERY REQUEST, on every provider LAIN speaks to:
 * Anthropic states it in `message_delta` at the end, the OpenAI shape in the
 * final chunk. A pane drawing a rising output count mid-stream would be drawing
 * a guess, so this draws the word instead.
 *
 * ------------------------------------------------------------------------
 * NOTHING HERE IS ANIMATED AND NOTHING COUNTS UP ON ITS OWN. The numbers change
 * when a usage event arrives and at no other time. A counter that ticks to look
 * alive is a counter nobody can use to diagnose anything.
 *
 * ------------------------------------------------------------------------
 * AND NONE OF IT REACHES THE MODEL. Telemetry in a prompt is a feedback loop:
 * the request carries the count, the count changes, the cached prefix is
 * invalidated by the act of measuring it. tests/unit/tokenarchitecture.test.js
 * asserts that these words never appear in a built prompt.
 */

const { doc } = require('./doc');
const { P } = require('./paint');

/** Where a number came from. Printed, never inferred by the reader. */
const SOURCE = Object.freeze({
  MEASURED: 'measured',
  ESTIMATED: 'estimated',
  PENDING: 'pending',
  UNKNOWN: 'unknown',
});

function n(v) {
  const x = Math.max(0, Math.floor(Number(v) || 0));
  return x.toLocaleString('en-US');
}

/** Compact, for ratios and averages where the exact digit does not help. */
function k(v) {
  const x = Math.max(0, Number(v) || 0);
  if (x < 1000) return String(Math.round(x));
  if (x < 1_000_000) return `${(x / 1000).toFixed(1)}K`;
  return `${(x / 1_000_000).toFixed(2)}M`;
}

/**
 * A figure with its provenance, or the reason there is no figure.
 *
 * `has` is passed separately from the value because ZERO IS A NUMBER: a route
 * that reported no cache reads and a route that has never mentioned caching are
 * different facts, and printing `0` for both is the specific dishonesty this
 * pane was built to avoid.
 */
function figure(d, label, value, { has = true, source = SOURCE.MEASURED, note = null } = {}) {
  if (!has) {
    d.field(label, source === SOURCE.PENDING ? 'pending' : 'unknown', { tone: P.dim, note });
    return;
  }
  d.field(label, n(value), { note: note || (source === SOURCE.ESTIMATED ? 'estimated' : null) });
}

/**
 * @param {object} o
 *   `usage`     session totals, as the provider reported them
 *   `live`      the open request's input side, when a provider states it early
 *   `audit`     the last request's composition, measured by tokenaudit.js
 *   `requests`  how many requests this session has made
 *   `open`      is a request in flight right now
 */
function render({ usage = null, live = null, audit = null, requests = 0, open = false,
  model = '', provider = '', width = 80 } = {}) {
  const d = doc();
  d.title('token usage', model || '');
  d.subtitle('What this conversation has cost, and where it went');

  const u = usage || {};
  const input = Number(u.inputTokens) || 0;
  const output = Number(u.outputTokens) || 0;
  const cacheRead = Number(u.cacheReadTokens) || 0;
  const cacheMade = Number(u.cacheCreationTokens) || 0;
  const reqs = Math.max(0, Number(requests) || 0);
  const total = input + output;

  // ---- THE REQUEST HAPPENING RIGHT NOW ----------------------------------
  d.section('current request');
  if (open) {
    // Anthropic states the input side at `message_start`; the OpenAI shape
    // states it once and late. Either way, output does not exist yet.
    const hasLive = Boolean(live && Number(live.inputTokens) > 0);
    figure(d, 'input', live && live.inputTokens, { has: hasLive, source: hasLive ? SOURCE.MEASURED : SOURCE.PENDING });
    figure(d, 'cached', live && live.cacheReadTokens, {
      has: Boolean(live && live.cacheReadTokens > 0),
      source: SOURCE.UNKNOWN,
      note: live && live.cacheReadTokens > 0 ? null : 'this route has not reported a cache read',
    });
    // NEVER A RISING NUMBER. See the header: no provider states output until
    // the request closes, so any figure drawn here would be invented.
    figure(d, 'output', 0, { has: false, source: SOURCE.PENDING, note: 'stated only when the request completes' });
    d.note('A request is open. These are the provider\'s own figures, not a projection.');
  } else if (audit) {
    // No request open: the most recent one, as LAIN measured the array it sent.
    const est = audit.estTokens || {};
    d.field('input', k(est.total), { note: 'estimated from the transmitted array' });
    d.field('  system prompt', k(est.system));
    d.field('  tool schemas', k(est.toolSchemas), {
      note: audit.chars && audit.chars.total
        ? `${Math.round((audit.chars.toolSchemas / audit.chars.total) * 100)}% of the request`
        : null,
    });
    d.field('  conversation', k((est.user || 0) + (est.assistant || 0) + (est.toolResults || 0)));
    if (est.duplicate) d.field('  repeated', k(est.duplicate), { tone: P.warn, note: 'the same body twice in one request' });
    d.field('  cacheable head', k(est.stablePrefix), { note: 'identical to the previous request, where the route caches' });
  } else {
    d.text('No request has been made yet.');
  }

  // ---- WHAT THE PROVIDER HAS ACTUALLY BILLED ----------------------------
  d.section('session', reqs ? `${reqs} request(s)` : null);
  if (!reqs && !input && !output) {
    d.text('Nothing has been reported by a provider yet.');
    d.note('These figures come from usage blocks on the wire. Until a request '
      + 'completes there is nothing measured to show, and a plausible zero would '
      + 'be worse than an empty pane.');
    return d.render(width);
  }
  figure(d, 'input', input);
  // ---- ZERO AND UNKNOWN ARE DIFFERENT FACTS -----------------------------
  figure(d, 'cached read', cacheRead, {
    has: cacheRead > 0,
    source: SOURCE.UNKNOWN,
    note: cacheRead > 0 ? null : 'no route in this session has reported one',
  });
  if (cacheMade > 0) figure(d, 'cache written', cacheMade);
  figure(d, 'output', output);
  figure(d, 'total', total);

  // ---- THE RATIOS THAT MAKE AN INCIDENT VISIBLE -------------------------
  //
  // The reported incident was 293 input per output token. A number like that on
  // a pane is a question somebody asks; buried in a total it is invisible.
  d.section('per request');
  if (reqs > 0) {
    d.field('average input', k(input / reqs));
    d.field('average output', k(output / reqs));
    if (output > 0) {
      const ratio = input / output;
      d.field('input : output', `${ratio.toFixed(0)} : 1`, { tone: ratio >= 100 ? P.warn : null });
    } else {
      d.field('input : output', 'no output reported yet', { tone: P.dim });
    }
    if (input > 0) {
      d.field('cache hit rate', cacheRead > 0 ? `${((cacheRead / input) * 100).toFixed(1)}%` : 'unknown', {
        tone: cacheRead > 0 ? null : P.dim,
        note: cacheRead > 0 ? 'of input served from a cache' : 'this route reports no cache figures',
      });
    }
  }

  if (provider) {
    d.section('route');
    d.field('provider', provider);
    if (model) d.field('model', model);
    d.note('Usage is kept per session. Another session in another folder has its own.');
  }
  return d.render(width);
}

module.exports = { render, SOURCE };
