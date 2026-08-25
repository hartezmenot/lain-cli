'use strict';

/**
 * RATE LIMIT — the whole lifecycle, against a provider that really refuses.
 *
 * The mock returns a 429 with a `retryAfter`, exactly as a real provider does,
 * so every part of this is the real path: the failure classifier, the absolute
 * `resumeAt`, the countdown, the sleep, and the resume.
 *
 * WHAT MUST BE TRUE AFTERWARDS, and each is a separate way this could go wrong:
 *
 *   · the task CONTINUES — nobody types `continue`
 *   · it resumes the SAME step rather than starting the task again
 *   · the work already done is still there
 *   · the request is not sent twice
 *   · it is not an infinite retry loop
 *   · the screen said what was happening while it waited
 *
 * The interaction with carry-on matters too: a rate limit is handled INSIDE the
 * turn loop, so it must never look like a finished turn and must never spend a
 * carry-on. Both are checked.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function project() {
  const dir = tmpdir('rl-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const x = 1;\n');
  return dir;
}

module.exports = async function () {
  await test('RATE LIMIT: the task carries on by itself after the wait', async () => {
    const r = await runCli([], {
      cwd: project(),
      stdin: 'read the file and tell me what is in it\n',
      script: [
        { text: 'Reading it.', tool_calls: [{ name: 'read_file', input: { path: 'src/a.js' } }] },
        // A real 429, with a short retry-after so the test is not slow.
        { error: { status: 429, message: 'rate limit exceeded', retryAfter: 1 } },
        { text: 'It declares x. FINISHED.' },
      ],
      timeoutMs: 60000,
    });
    const out = plain(r.out);

    // IT SAID WHAT WAS HAPPENING. A silent wait is indistinguishable from a hang.
    assert.match(out, /rate limit exceeded/, `the reason must be shown:\n${out.slice(-800)}`);
    assert.match(out, /retry 1\/\d+ at \d\d:\d\d:\d\d/, 'with an ABSOLUTE time, not only a duration');
    assert.match(out, /Esc cancels the wait/, 'and a way out');

    // IT RESUMED, AND FINISHED, with nobody typing anything.
    assert.match(out, /the wait is over/, 'the resume is announced');
    assert.match(out, /FINISHED/, `the task must complete after the wait:\n${out.slice(-800)}`);
    assert.strictEqual(r.code, 0);
  });

  await test('RATE LIMIT: it resumes the SAME step — the task is not restarted', async () => {
    // Restarting would redo the work and, worse, look like progress.
    const r = await runCli([], {
      cwd: project(),
      stdin: 'read it\n',
      script: [
        { text: 'Reading.', tool_calls: [{ name: 'read_file', input: { path: 'src/a.js' } }] },
        { error: { status: 429, message: 'slow down', retryAfter: 1 } },
        { text: 'Done reading. FINISHED.' },
      ],
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    // The file was read ONCE. A restart would read it again.
    const reads = (out.match(/Read src[\\/]a\.js/g) || []).length;
    assert.ok(reads <= 1, `the work was repeated after the wait (${reads} reads):\n${out.slice(-900)}`);
    assert.match(out, /FINISHED/);
  });

  await test('RATE LIMIT: a wait does NOT spend a carry-on', async () => {
    // A rate limit is handled inside the turn loop. If it also looked like a
    // finished turn, every rate limit would cost one of the four carry-ons a
    // long investigation needs.
    const r = await runCli([], {
      cwd: project(),
      stdin: 'read it\n',
      script: [
        { text: 'Reading.', tool_calls: [{ name: 'read_file', input: { path: 'src/a.js' } }] },
        { error: { status: 429, message: 'slow down', retryAfter: 1 } },
        { text: 'Finished reading it.' },
      ],
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assert.ok(!/CONTINUING/.test(out), `a rate limit must not consume a carry-on:\n${out.slice(-600)}`);
  });

  await test('RATE LIMIT: it is BOUNDED — a provider that never recovers is not retried for ever', async () => {
    const r = await runCli([], {
      cwd: project(),
      stdin: 'read it\n',
      // Far more refusals than the retry budget.
      script: Array.from({ length: 12 }, () => ({ error: { status: 429, message: 'still limited', retryAfter: 1 } })),
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    const attempts = (out.match(/retry \d+\/\d+/g) || []).length;
    assert.ok(attempts >= 1, 'it did retry');
    assert.ok(attempts <= 6, `${attempts} retries is not a bounded budget:\n${out.slice(-600)}`);
    // And it gave up honestly rather than claiming anything.
    assert.strictEqual(r.code, 0, 'the binary still exits cleanly');
    assert.ok(!/FINISHED|TASK COMPLETE/.test(out), 'a provider that never answered completes nothing');
  });

  // THE CARRY-ON TEST THAT SAT HERE IS GONE WITH THE MECHANISM. It asserted
  // that a dead provider does not earn an automatic continuation — true then,
  // and now true of everything, because LAIN no longer manufactures model turns
  // at all. The property it protected is asserted directly against the real
  // binary in smoke/autonomy.test.js.
};
