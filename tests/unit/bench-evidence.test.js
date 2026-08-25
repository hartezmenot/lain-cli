'use strict';

/**
 * THE EVIDENCE CLASSIFIER, JUDGED ON SYNTHETIC TRANSCRIPTS.
 *
 * The benchmark's central honesty property is PART 8 of its brief: a
 * legitimate reread after an edit must NEVER be counted as waste, and genuine
 * unchanged re-acquisition must ALWAYS be. These tests pin both directions on
 * transcripts small enough to read at a glance, so a regression in the
 * classifier is a named failure rather than a quietly wrong baseline.
 */

const assert = require('assert');
const { test } = require('../helpers');
const { traceFromSession, duplicateCalls, normalizedArgs } = require('../../bench/evidence');

/** A conversation builder: steps of [toolName, input, resultContent, isError]. */
function session(steps) {
  const messages = [];
  let n = 0;
  for (const [name, input, content, isError] of steps) {
    const id = `c${n++}`;
    messages.push({ role: 'assistant', tool_calls: [{ id, name, arguments: JSON.stringify(input) }] });
    messages.push({ role: 'tool', tool_call_id: id, content, isError: Boolean(isError) });
  }
  return { messages };
}

const classes = (s) => traceFromSession(s).events.map((e) => e.class);

module.exports = async function () {
  await test('BENCH-EVIDENCE: a first acquisition is FIRST, not waste', () => {
    const r = traceFromSession(session([['read_file', { path: 'src/a.js' }, 'body v1']]));
    assert.deepStrictEqual(classes(r), []);
    assert.strictEqual(r.summary.firsts, 1);
    assert.strictEqual(r.summary.rediscoveries, 0);
  });

  await test('BENCH-EVIDENCE: an unchanged reread, earlier copy still present, is REDISCOVERY', () => {
    const r = traceFromSession(session([
      ['read_file', { path: 'src/a.js' }, 'body v1'],
      ['read_file', { path: 'src/a.js' }, 'body v1'],
    ]));
    assert.strictEqual(r.summary.rediscoveries, 1);
    assert.strictEqual(r.summary.validRechecks, 0);
  });

  await test('BENCH-EVIDENCE: a reread after an edit is a VALID RECHECK, never waste', () => {
    const r = traceFromSession(session([
      ['read_file', { path: 'src/a.js' }, 'body v1'],
      ['edit_file', { path: 'src/a.js', find: 'v1', replace: 'v2' }, 'ok'],
      ['read_file', { path: 'src/a.js' }, 'body v2'],
    ]));
    assert.strictEqual(r.summary.validRechecks, 1);
    assert.strictEqual(r.summary.rediscoveries, 0);
    assert.strictEqual(r.summary.staleInvalidations, 0);
  });

  await test('BENCH-EVIDENCE: a changed file with no mutation of ours is STALE_INVALIDATION', () => {
    const r = traceFromSession(session([
      ['read_file', { path: 'src/a.js' }, 'body v1'],
      ['read_file', { path: 'src/a.js' }, 'body v2'],  // changed, nothing of ours between
    ]));
    assert.strictEqual(r.summary.staleInvalidations, 1);
    assert.strictEqual(r.summary.rediscoveries, 0);
  });

  await test('BENCH-EVIDENCE: the evidence ledger substitution is REUSE, measured', () => {
    const r = traceFromSession(session([
      ['read_file', { path: 'src/big.js' }, 'body v1'],
      ['read_file', { path: 'src/big.js' }, '[evidence] src/big.js is unchanged since you read it'],
    ]));
    assert.strictEqual(r.summary.reuse, 1);
    assert.strictEqual(r.summary.rediscoveries, 0);
  });

  await test('BENCH-EVIDENCE: a reread whose earlier copy was elided to a stub is a VALID RECHECK', () => {
    // The compactor leaves the result message but replaces its body with a
    // stub — the model re-read something it could no longer see.
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"src/a.js"}' }] },
      { role: 'tool', tool_call_id: 'c1', elided: 'stub',
        content: '[elided to fit the context window] read_file {"path":"src/a.js"} returned 400 chars. Re-run the call if you need the rest.' },
      { role: 'assistant', tool_calls: [{ id: 'c2', name: 'read_file', arguments: '{"path":"src/a.js"}' }] },
      { role: 'tool', tool_call_id: 'c2', content: 'body v1' },
    ];
    const r = traceFromSession({ messages });
    assert.strictEqual(r.summary.validRechecks, 1);
    assert.strictEqual(r.summary.rediscoveries, 0);
    assert.strictEqual(r.summary.staleInvalidations, 0);
  });

  await test('BENCH-EVIDENCE: a reread after the earlier pair was folded away reads as FIRST, never waste', () => {
    // A fold REPLACES the old exchange with a summary, so the earlier read is
    // not in the transcript at all — the surviving read is the only one the
    // trace can see, and it is not counted as waste.
    const messages = [
      { role: 'user', content: 'task' },
      { role: 'user', content: '(folded) earlier work', elided: 'folded', foldedCount: 2 },
      { role: 'assistant', tool_calls: [{ id: 'c9', name: 'read_file', arguments: '{"path":"src/a.js"}' }] },
      { role: 'tool', tool_call_id: 'c9', content: 'body v1' },
    ];
    const r = traceFromSession({ messages });
    assert.strictEqual(r.summary.firsts, 1);
    assert.strictEqual(r.summary.rediscoveries, 0);
  });

  await test('BENCH-EVIDENCE: a ranged read is never a duplicate of a whole read', () => {
    const r = traceFromSession(session([
      ['read_file', { path: 'src/a.js' }, 'body v1'],
      ['read_file', { path: 'src/a.js', offset: 10, limit: 5 }, 'lines 10-15'],
      ['read_file', { path: 'src/a.js', offset: 10, limit: 5 }, 'lines 10-15'], // same range twice IS redundant
    ]));
    assert.strictEqual(r.summary.firsts, 2);
    assert.strictEqual(r.summary.rediscoveries, 1);
  });

  await test('BENCH-EVIDENCE: understand re-asked with nothing between is REDISCOVERY', () => {
    const r = traceFromSession(session([
      ['understand', {}, 'the project is 8 files'],
      ['understand', {}, 'the project is 8 files (nothing changed)'],
    ]));
    assert.strictEqual(r.summary.rediscoveries, 1);
  });

  await test('BENCH-EVIDENCE: understand re-asked after an edit is a VALID RECHECK', () => {
    const r = traceFromSession(session([
      ['understand', {}, 'the project is 8 files'],
      ['replace_symbol', { path: 'src/a.js', name: 'f', replacement: '...' }, 'replaced'],
      ['understand', {}, 'the project is 8 files, 1 changed'],
    ]));
    assert.strictEqual(r.summary.validRechecks, 1);
    assert.strictEqual(r.summary.rediscoveries, 0);
  });

  await test('BENCH-EVIDENCE: an errored acquisition establishes nothing', () => {
    const r = traceFromSession(session([
      ['read_file', { path: 'nope.js' }, 'no such file', true],
      ['read_file', { path: 'nope.js' }, 'no such file', true],
    ]));
    assert.strictEqual(r.summary.acquisitions, 0);
    assert.strictEqual(r.summary.rediscoveries, 0);
  });

  await test('BENCH-EVIDENCE: a symbol read twice unchanged is a rediscovery, keyed on name', () => {
    const r = traceFromSession(session([
      ['read_symbol', { path: 'src/a.js', name: 'applyDiscount' }, 'function applyDiscount() {}'],
      ['read_symbol', { path: 'src/a.js', name: 'applyDiscount' }, 'function applyDiscount() {}'],
    ]));
    assert.strictEqual(r.summary.rediscoveries, 1);
  });

  await test('BENCH-EVIDENCE: the same locate query twice is a rediscovery, case-folded', () => {
    const r = traceFromSession(session([
      ['locate', { what: 'applyDiscount' }, 'declared in src/cart.js:30'],
      ['locate', { what: 'applydiscount' }, 'declared in src/cart.js:30'],
    ]));
    assert.strictEqual(r.summary.rediscoveries, 1);
  });

  await test('BENCH-DUP: an identical successful call twice is a duplicate', () => {
    const d = duplicateCalls(session([
      ['grep', { pattern: 'discount' }, 'src/cart.js: hit'],
      ['grep', { pattern: 'discount' }, 'src/cart.js: hit'],
    ]));
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].name, 'grep');
  });

  await test('BENCH-DUP: the same call after a mutation is not a duplicate', () => {
    const d = duplicateCalls(session([
      ['grep', { pattern: 'discount' }, 'src/cart.js: hit'],
      ['edit_file', { path: 'src/cart.js', find: 'a', replace: 'b' }, 'ok'],
      ['grep', { pattern: 'discount' }, 'src/cart.js: different hit'],
    ]));
    assert.strictEqual(d.length, 0);
  });

  await test('BENCH-DUP: argument key order cannot hide a duplicate', () => {
    const d = duplicateCalls(session([
      ['grep', { pattern: 'x', include: 'src/**' }, 'hits'],
      ['grep', { include: 'src/**', pattern: 'x' }, 'hits'],
    ]));
    assert.strictEqual(d.length, 1);
    assert.deepStrictEqual(normalizedArgs({ b: 1, a: { d: 2, c: 3 } }), { a: { c: 3, d: 2 }, b: 1 });
  });
};
