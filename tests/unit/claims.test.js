'use strict';

/**
 * A SUCCESS CLAIM, CHECKED AGAINST THE EVIDENCE.
 *
 * Found by running LAIN against a real provider on a real task: the turn ended
 * with "Successful implementation. The tests affirm success" while
 * `node test/run.js` was failing on a syntax error. LAIN's own state was
 * correct — the task stayed ACTIVE and refused to complete — but the plan still
 * had an open step, so the completion gate was never consulted, and the last
 * thing on the user's screen was a confident false claim.
 *
 * The rule these encode: contradict the CLAIM, never the work. A turn that
 * makes no claim gets nothing said back, and a passing check is never argued
 * with.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Lifecycle, claimsSuccess } = require('../../src/lifecycle');

/** A task that ran `npm test` and got the given verdict. */
function afterCheck(ok, exitCode = ok ? 0 : 1) {
  const l = new Lifecycle('add a mute list');
  l.observeTool({ name: 'write_file', input: { path: 'a.js' }, output: 'ok', mutated: ['a.js'] });
  l.observeTool({ name: 'run_bash', input: { command: 'node test/run.js' }, output: 'x', isError: !ok, exitCode });
  return l;
}

module.exports = async function () {
  await test('CLAIM: "the tests pass" over a FAILING check is contradicted, by name', () => {
    const l = afterCheck(false);
    const msg = l.contradiction('All the tests pass now. Successful implementation.');
    assert.ok(msg, 'a false success claim must not be the last word');
    assert.match(msg, /node test\/run\.js/, 'the failing command must be named — "something failed" is not actionable');
    assert.match(msg, /exit 1/);
  });

  await test('CLAIM: the exact sentence the real model wrote is caught', () => {
    // Verbatim from a live run against the real provider.
    const l = afterCheck(false);
    assert.ok(l.contradiction('The tests affirm success:\n\n- A muted chat halts Telegram transmission.\n\nSuccessful implementation'));
  });

  await test('CLAIM: a PASSING check is never argued with', () => {
    const l = afterCheck(true);
    assert.strictEqual(l.contradiction('All the tests pass now.'), null);
  });

  await test('CLAIM: a turn that claims nothing is left alone', () => {
    const l = afterCheck(false);
    assert.strictEqual(l.contradiction('I traced the request as far as the settings module and stopped there.'), null);
    assert.strictEqual(l.contradiction(''), null);
  });

  await test('CLAIM: a task that ran no command is never contradicted', () => {
    // Nothing to disagree WITH. Inventing a warning here would be the same
    // failure in the other direction.
    const l = new Lifecycle('explain the router');
    assert.strictEqual(l.contradiction('Everything works as expected.'), null);
  });

  await test('CLAIM: honest reports of failure are not read as success', () => {
    assert.strictEqual(claimsSuccess('The tests do not pass yet.'), false);
    assert.strictEqual(claimsSuccess('Two tests are still failing, so this is not done.'), false);
    assert.strictEqual(claimsSuccess("I can't get it working — the import still fails."), false);
  });

  await test('CLAIM: it is the CLOSING statement that is judged', () => {
    // A trace that mentions a green run partway through and then reports a
    // failure is reporting a failure.
    assert.strictEqual(
      claimsSuccess('The unit tests passed at that point, but after wiring the API the suite fails on a syntax error.'),
      false
    );
  });

  await test('CLAIM: the plain claim shapes are recognised', () => {
    for (const s of [
      'Successfully implemented the mute list.',
      'Implementation complete.',
      'Everything works now.',
      'The suite is green.',
      'It is now working.',
    ]) assert.strictEqual(claimsSuccess(s), true, `not recognised: ${s}`);
  });

  await test('CLAIM: a later PASSING run clears the contradiction', () => {
    // The last command is the task's verdict on itself: fix, re-run, done.
    const l = afterCheck(false);
    assert.ok(l.contradiction('All tests pass.'));
    l.observeTool({ name: 'run_bash', input: { command: 'node test/run.js' }, output: 'ok', isError: false, exitCode: 0 });
    assert.strictEqual(l.contradiction('All tests pass.'), null);
  });

  await test('CLAIM: a resumed session still remembers the failing check', () => {
    const l = Lifecycle.from(afterCheck(false).toJSON());
    assert.ok(l.contradiction('Implementation complete.'), 'the verdict must survive /resume');
  });
};
