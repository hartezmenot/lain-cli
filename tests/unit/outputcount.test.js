'use strict';

/**
 * THE HEADER'S ONE NUMBER — the output tokens of the response in front of you.
 *
 * ------------------------------------------------------------------------
 * WHAT IT REPLACED, AND WHY.
 *
 * The header carried the session's cumulative token bill (`42K`), and before
 * that a context-occupancy figure (`42k/128k`). Both are genuinely useful and
 * both are the wrong number for a permanent row: they barely move within a
 * turn, they are large enough to read as noise, and the questions they answer
 * are asked occasionally. `/token` answers those.
 *
 * What a person watching a response wants is proof it is still coming, and how
 * much of it there has been. That number climbs while the model writes, and
 * stops when the model stops.
 *
 * ------------------------------------------------------------------------
 * AND IT IS HONEST ABOUT BEING AN ESTIMATE, which is the whole of what these
 * tests are for.
 *
 * NO PROVIDER LAIN SPEAKS TO STATES OUTPUT TOKENS WHILE A RESPONSE IS BEING
 * PRODUCED. Anthropic states them once, in `message_delta`, at the end; the
 * OpenAI shape states them in the final chunk. So the finest truthful
 * granularity available during a response is the one thing that genuinely
 * arrives continuously — the characters — and the figure derived from them is
 * drawn with a `~` in front of it until the receipt lands.
 *
 * An estimate that looks like a measurement is worse than no number.
 */

const assert = require('assert');
const { test } = require('../helpers');

const views = require('../../src/ui/views');
const { CHARS_PER_TOKEN } = require('../../src/session');

/** The smallest UI double `noteOutputChars` and `endTurn` actually touch. */
function ui(over = {}) {
  const u = Object.assign({
    liveOutput: { chars: 0, tokens: 0, measured: false },
    liveUsage: null,
    story: { beginTurn() {}, endTurn() {} },
    app: { session: { turns: [] } },
    interrupted: false, retryCancelled: false,
    refresh() {}, _syncTicker() {},
  }, over);
  u.noteOutputChars = require('../../src/ui').UI.prototype.noteOutputChars.bind(u);
  return u;
}

const header = (output) => views.header({
  cwd: 'C:\\work\\lain-v2', model: 'claude-opus-5', output, width: 80,
}).join('');

module.exports = async function () {
  await test('OUTPUT: the header shows the output count and nothing else numeric', () => {
    const h = header({ tokens: 624, measured: true });
    assert.match(h, /624/, 'the count');
    // NOT the cumulative bill, and not a context figure with a denominator.
    assert.ok(!/\d+k\/\d+k/.test(h), 'no context occupancy on the permanent row');
    assert.ok(!/↑|⚡|↓/.test(h), 'and none of the session-total glyphs');
  });

  await test('OUTPUT: nothing produced yet is 0 — a fact, not a placeholder', () => {
    assert.match(header(null), /\b0\b/);
    assert.match(header({ tokens: 0, measured: false }), /0/);
  });

  await test('OUTPUT: an estimate wears a tilde; a measurement does not', () => {
    assert.match(header({ tokens: 624, measured: false }), /~624/,
      'while the response streams there is no provider figure to have');
    assert.match(header({ tokens: 624, measured: true }), /(^|[^~])624/,
      'once the receipt lands it is the provider\'s own count');
    assert.ok(!header({ tokens: 624, measured: true }).includes('~624'));
  });

  await test('OUTPUT: the count climbs from REAL characters, with no timer behind it', () => {
    const u = ui();
    assert.strictEqual(u.liveOutput.tokens, 0);
    u.noteOutputChars(360);
    const first = u.liveOutput.tokens;
    assert.ok(first > 0, 'characters that arrived moved the number');
    assert.strictEqual(first, Math.round(360 / CHARS_PER_TOKEN),
      'and it is the same ratio src/session.js compacts against, not a second one');
    u.noteOutputChars(360);
    assert.ok(u.liveOutput.tokens > first, 'more characters, a bigger number');
    // NOTHING MOVES ON ITS OWN. The same object, asked again with nothing
    // arriving, reports the same figure — at any clock value.
    const held = u.liveOutput.tokens;
    u.noteOutputChars(0);
    assert.strictEqual(u.liveOutput.tokens, held, 'a quiet model must show a still number');
  });

  await test('OUTPUT: it is fed by the events that carry the model\'s words', () => {
    // Structural, because the wiring is what makes the number real: a counter
    // fed from anywhere but the text on the wire would be a fabrication.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'turnevents.js'), 'utf8');
    const at = src.indexOf("case 'text':");
    assert.ok(at > 0);
    assert.ok(src.slice(at, at + 700).includes('noteOutputChars'), 'answer text is counted');
    const think = src.indexOf("case 'reasoning':");
    assert.ok(src.slice(think, think + 700).includes('noteOutputChars'),
      'and so is reasoning, which every provider bills as output');
    // AND NOTHING ELSE FEEDS IT.
    // CALLS, not mentions — the comment above each of them names the function.
    const all = (src.match(/ui\.noteOutputChars\(/g) || []).length;
    assert.strictEqual(all, 2, `only the two text events may feed the counter, found ${all}`);
  });

  await test('OUTPUT: the RECEIPT replaces the estimate when the turn ends', () => {
    const turnstate = require('../../src/ui/turnstate');
    const u = ui({ app: { session: { turns: [{ usage: { outputTokens: 812 } }] } } });
    u.noteOutputChars(1000);
    assert.strictEqual(u.liveOutput.measured, false, 'an estimate while it streams');
    turnstate.endTurn(u);
    assert.strictEqual(u.liveOutput.tokens, 812, 'the provider\'s own count once it lands');
    assert.strictEqual(u.liveOutput.measured, true, 'and it stops calling itself an estimate');
  });

  await test('OUTPUT: a measured figure is never overwritten by a later estimate', () => {
    const u = ui();
    u.liveOutput = { chars: 900, tokens: 812, measured: true };
    u.noteOutputChars(500);
    assert.strictEqual(u.liveOutput.tokens, 812,
      'text arriving after a receipt must not turn a measurement back into a guess');
  });

  await test('OUTPUT: a new turn starts the counter at nothing', () => {
    const turnstate = require('../../src/ui/turnstate');
    const u = ui();
    u.noteOutputChars(2000);
    assert.ok(u.liveOutput.tokens > 0);
    turnstate.beginTurn(u);
    assert.strictEqual(u.liveOutput.tokens, 0, 'a new turn is a new response');
    assert.strictEqual(u.liveOutput.measured, false);
  });

  await test('OUTPUT: a turn with NO receipt keeps the estimate, still marked', () => {
    // Some routes never state usage at all. The honest outcome is the estimate
    // and its tilde, not a zero and not a fabricated total.
    const turnstate = require('../../src/ui/turnstate');
    const u = ui({ app: { session: { turns: [{ usage: { outputTokens: 0 } }] } } });
    u.noteOutputChars(1000);
    const before = u.liveOutput.tokens;
    turnstate.endTurn(u);
    assert.strictEqual(u.liveOutput.tokens, before);
    assert.strictEqual(u.liveOutput.measured, false, 'and it still says it is an estimate');
  });

  await test('TOKEN: the detailed accounting is a command, and it is `/token`', () => {
    const { REGISTRY } = require('../../src/commands');
    assert.ok(REGISTRY.has('/token'), 'the detail has a door');
    assert.ok(!REGISTRY.has('/tokens'), 'and exactly one spelling of it');
    const desc = REGISTRY.get('/token').desc.toLowerCase();
    assert.match(desc, /session|context|token/, `it says what it is for: ${desc}`);
  });

  await test('TOKEN: MEASURED, ESTIMATED, PENDING and UNKNOWN are still distinguished', () => {
    // The vocabulary ui/tokenview.js exists for, and the reason `/token` is
    // where the detail lives: a provider's silence must never render as a zero.
    const out = require('../../src/ui/tokenview').render({
      usage: { inputTokens: 42000, outputTokens: 1204, cacheReadTokens: 8000, cacheCreationTokens: 0 },
      requests: 3, open: true, model: 'claude-opus-5', width: 100,
    }).join(String.fromCharCode(10));
    const text = require('../../src/ui/text').strip(out);
    // WHAT THE PROVIDER SAID — the session totals, which are its own figures.
    assert.match(text, /SESSION/, 'the measured account');
    assert.match(text, /42,000/, 'stated exactly, because it was stated to us');
    // AND WHAT IT HAS NOT SAID YET, in words rather than as a zero. This is the
    // whole reason the detail is a command rather than a row: `pending` and
    // `unknown` need a sentence each, and a header has no room for one.
    assert.match(text, /pending/i, 'an open request whose cost is not known yet');
    assert.match(text, /unknown/i, 'and a quantity this route has never reported');
    assert.ok(!/\bcached\s+0\b/.test(text), 'silence must never render as a zero');
  });
};
