'use strict';

/**
 * 502 / 504 / TRANSPORT FAILURE —,,.
 *
 * THE DISTINCTION THIS TIER EXISTS FOR, and it is the whole design:
 *
 *     an LLM retry loop      asks the model to try the task again
 *     a CONNECTION retry     sends the SAME request again
 *
 * A 502 from a gateway says nothing about the task, the model or the tools — it
 * says the request did not arrive. So the same request goes again: no new
 * objective, no re-planning, no tool replayed, no user turn consumed, no
 * carry-on spent. The conversation is untouched, because nothing about it
 * changed.
 *
 * THE ONE THAT MATTERS MOST is `a tool that SUCCEEDED is never replayed`. If a
 * write succeeded and then the model response 502'd, retrying the request must
 * not write again. A retry that replays side effects is worse than no retry.
 *
 * Everything here drives `bin/lain.js` with a mock that returns real HTTP
 * statuses, so the classifier, the backoff, the status strip and the turn loop
 * are all the production ones. Only the socket is a double.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli, assertIncludes, assertNotIncludes } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');

/** A transport failure the provider really returns, by status. */
const fail = (status, message) => ({ error: { status, message, retryAfter: 0 } });

/**
 * THE BUDGET IS READ, NOT SPELLED.
 *
 * These asserted `1/5`, `3/5` and `attempts <= 5` against a retry budget
 * that has now been 2, then 5, then 10. Every time it moved, tests that
 * hardcoded it failed on the NUMBER rather than on the behaviour they were
 * about — which is noise that hides a real regression. Derived from
 * backoff.js, they assert the property and follow the policy.
 */
const { MAX_RETRIES } = require('../../src/backoff');

module.exports = async function () {
  // ---------------------------------------------------------- IT RETRIES --

  await test('502: the SAME request is retried and the task completes', async () => {
    const r = await runCli([], {
      cwd: tmpdir('conn-'),
      stdin: 'what is two plus two\n',
      script: [fail(502, 'Bad Gateway'), { text: 'Four. FINISHED.' }],
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'Bad Gateway', 'the reason is shown, not swallowed');
    // `retry in 1s · 1/5` — the compact transient form. It said `retry 1/5 at
    // 16:17:24 (1s)` as a durable WARN carrying the provider's raw body; the row is
    // one sentence now and goes to the operation channel (turn.js `retryWord`).
    assert.match(out, new RegExp(`\\b1/${MAX_RETRIES}\\b`), 'and which attempt, out of the real budget');
    assertIncludes(out, 'Four. FINISHED.', 'the task completed on the retry');
    assert.strictEqual(r.code, 0);
  });

  await test('504: a gateway timeout is retried the same way', async () => {
    const r = await runCli([], {
      cwd: tmpdir('conn-'),
      stdin: 'go\n',
      script: [fail(504, 'Gateway Timeout'), { text: 'Done. FINISHED.' }],
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'Gateway Timeout');
    assertIncludes(out, 'Done. FINISHED.');
  });

  await test('TRANSPORT: several failures in a row are ridden out', async () => {
    const r = await runCli([], {
      cwd: tmpdir('conn-'),
      stdin: 'go\n',
      script: [fail(502, 'Bad Gateway'), fail(504, 'Gateway Timeout'), fail(503, 'Service Unavailable'),
        { text: 'Through at last. FINISHED.' }],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    assert.match(out, new RegExp(`\\b3/${MAX_RETRIES}\\b`), `three attempts must be within the budget:\n${out.slice(-700)}`);
    assertIncludes(out, 'Through at last.');
  });

  await test('BOUNDED: a gateway that never recovers stops after the budget, honestly', async () => {
    const r = await runCli([], {
      cwd: tmpdir('conn-'),
      stdin: 'go\n',
      script: Array.from({ length: MAX_RETRIES + 4 }, () => fail(502, 'Bad Gateway')),
      timeoutMs: 120000,
    });
    const out = plain(r.out);
    // COUNTED ON THE ATTEMPT MARKER ALONE, for two reasons found the hard way:
    // `plain` above replaces each SGR sequence with a NEWLINE, so a coloured
    // retry line arrives split into pieces and no whole-phrase pattern can
    // match it; and a `\d` written inside a template literal collapses to a
    // literal `d`, which silently matched nothing and reported 0 attempts.
    const attempts = (out.match(new RegExp('\\d+/' + MAX_RETRIES + '\\b', 'g')) || []).length;
    assert.ok(attempts >= 1 && attempts <= MAX_RETRIES, `${attempts} attempts is not a bounded budget`);
    assert.ok(!/FINISHED|TASK COMPLETE/.test(out), 'a provider that never answered completes nothing');
    assert.strictEqual(r.code, 0, 'and the binary still exits cleanly');
  });

  // ------------------------------------------- NETWORK IS NOT MODEL FAILURE --

  await test('NET: a 502 reads as NETWORK, not as LAIN failing', async () => {
    const r = await runCli([], {
      cwd: tmpdir('conn-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['go\n', '\n'],
      stepDelayMs: 1200,
      script: Array.from({ length: MAX_RETRIES + 4 }, () => fail(502, 'Bad Gateway')),
      timeoutMs: 120000,
    });
    const out = plain(r.out);
    assert.match(out, /NETWORK/i, 'a gateway failure must not be attributed to LAIN or the model');
    assertIncludes(out, '502', 'and the status code is the most useful fact about it');
    assertNotIncludes(out, 'MODEL REFUSED', 'a 502 is not a refusal');
  });

  await test('NET: a rejected credential reads as NOT AUTHENTICATED, and is NOT retried', async () => {
    // The other half of the same rule: retrying a 401 is pointless, and calling
    // it a network problem sends somebody to check their router.
    const r = await runCli([], {
      cwd: tmpdir('conn-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['go\n', '\n'],
      stepDelayMs: 1200,
      script: [{ error: { status: 401, message: 'invalid key' } }, { text: 'never reached' }],
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assert.ok(!/retry in \d+s/.test(out), 'a bad credential was retried');
    assertNotIncludes(out, 'never reached', 'and the request was not sent again');
  });

  // ------------------------------------------------ NO SIDE EFFECT REPLAY --

  await test('NET: a tool that SUCCEEDED is NEVER replayed when the model request fails', async () => {
    // THE TEST THIS FILE EXISTS FOR. The tool appends a line; if the retry
    // replays it, the file has two.
    const cwd = tmpdir('conn-');
    const marker = path.join(cwd, 'count.txt');
    fs.writeFileSync(marker, '');
    const r = await runCli([], {
      cwd,
      stdin: 'append once\n',
      script: [
        // Step 1: the model calls a tool, and it succeeds.
        {
          text: 'Appending.',
          tool_calls: [{ name: 'append_file', input: { path: 'count.txt', text: 'X\n' } }],
        },
        // Step 2: the model request after that tool result fails, twice.
        fail(502, 'Bad Gateway'),
        fail(504, 'Gateway Timeout'),
        // Then it recovers.
        { text: 'Appended once. FINISHED.' },
      ],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    assert.match(out, /retry in \d+s/, `the failures must have been retried:\n${out.slice(-700)}`);
    const written = fs.readFileSync(marker, 'utf8');
    const times = (written.match(/X/g) || []).length;
    assert.strictEqual(times, 1,
      `the tool ran ${times} times — a connection retry replayed a side effect`);
    assertIncludes(out, 'Appended once. FINISHED.');
  });

  await test('NET: a failure BEFORE any tool leaves the working tree untouched', async () => {
    const cwd = tmpdir('conn-');
    const r = await runCli([], {
      cwd,
      stdin: 'go\n',
      script: [fail(502, 'Bad Gateway'), { text: 'Nothing to do. FINISHED.' }],
      timeoutMs: 60000,
    });
    assert.deepStrictEqual(fs.readdirSync(cwd).filter((f) => f !== '.config'), [],
      'a retry created files of its own');
    assertIncludes(plain(r.out), 'Nothing to do.');
  });

  await test('NET: a connection retry does NOT spend a carry-on or start a task', async () => {
    const r = await runCli([], {
      cwd: tmpdir('conn-'),
      stdin: 'go\n',
      script: [fail(502, 'Bad Gateway'), fail(502, 'Bad Gateway'), { text: 'Fine. FINISHED.' }],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    assertNotIncludes(out, 'CONTINUING', 'a transport failure is not a carry-on');
    const tasks = new Set((out.match(/^TASK {2}(.+)$/gm) || []).map((s) => s.trim()));
    assert.ok(tasks.size <= 1, `a retry started ${tasks.size} tasks`);
  });
};
