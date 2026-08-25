'use strict';

/**
 * WHO FAILED, AND IN WHOSE WORDS —, from a live report on 2026-08-22.
 *
 * The screen said this:
 *
 *     ACTIONS
 *       ✓ Ran cd probot && sed -n '1470,1500p' runner.py && grep -n "def s
 *       ✗ 413 Payload Too Large - {"error": {"message": "Chat history exceeds
 *         the 800-message limit; compact the conversation and
 *         retry.","type":"payload_too_large","code":"chat_history_too_large"…
 *     NOTE
 *       MODEL INTERRUPTED — the provider stopped answering
 *
 * Three separate things wrong with one screen:
 *
 *   1. The shell command SUCCEEDED. What was refused was the next model
 *      REQUEST — but the refusal was pushed into the ACTIONS list wearing the
 *      same ✗ a failed tool call wears, directly beneath the call that had just
 *      worked, so it read as that command failing.
 *   2. The provider's raw JSON body was printed whole, four wrapped lines of
 *      braces with the one useful sentence buried in the middle.
 *   3. "MODEL INTERRUPTED" names the wrong actor twice: the model did not
 *      interrupt anything, and nobody interrupted it.
 *
 * These run the REAL BINARY over a scripted provider, because all three were
 * failures of what reached the screen, and only the screen can settle that.
 */

const assert = require('assert');
const { test, runCli, tmpdir, frames, assertIncludes, assertNotIncludes } = require('../helpers');

const E = String.fromCharCode(27);
const plain = (s) => String(s).split(new RegExp(E + '\\[[0-9;?]*[A-Za-z]', 'g')).join('');

const OMNIROUTE_413 = '413 Payload Too Large - {"error": {"message": "Chat history exceeds the '
  + '800-message limit; compact the conversation and retry.","type":"payload_too_large",'
  + '"code":"chat_history_too_large","reason":"message_limit"}}';

/** A tool call that works, then a provider that refuses the follow-up request. */
async function refusedAfterTool() {
  return runCli([], {
    cwd: tmpdir('refusal-'),
    env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
    stdin: 'check the runner\n',
    script: [
      { text: 'Checking the size_lot call:', tool_calls: [{ name: 'run_bash', input: { command: 'echo LINE1470' } }] },
      { error: { status: 413, message: OMNIROUTE_413 } },
    ],
    timeoutMs: 45000,
  });
}

module.exports = async function () {
  await test('REFUSAL: a tool that SUCCEEDED is not marked failed by the provider', async () => {
    const r = await refusedAfterTool();
    const last = frames(r.out).map(plain).pop() || '';
    // FOUND BY THE TOOL CALL ITSELF, not by a heading above it. `ACTIONS` was
    // removed: a run of calls is already distinguished by its quoted gutter,
    // and a word announcing that actions are actions added a row without adding
    // a distinction. What this test is about is unchanged — the region around
    // the successful call must not be wearing the provider's refusal.
    const i = last.indexOf('Ran echo LINE1470');
    assert.ok(i >= 0, `the tool call must be on screen:
${last.slice(-400)}`);
    const region = last.slice(Math.max(0, i - 60), i + 200);
    assert.match(region, /✓ Ran echo LINE1470/, `the command succeeded and must say so: ${region}`);
    assert.ok(!/✗ 413/.test(region),
      `the provider's refusal is wearing the tool's failure mark: ${region}`);
  });

  await test('REFUSAL: it is named in LAIN\'s words, with the fix, not as raw JSON', async () => {
    const r = await refusedAfterTool();
    const out = plain(r.out);
    assertIncludes(out, 'TOO MANY MESSAGES', 'the classification, not the status code alone');
    assertIncludes(out, '800-message limit', 'the number the provider actually gave');
    assertIncludes(out, '/compact', 'and the one command that acts on it');
  });

  await test('REFUSAL: the raw provider body is CLIPPED, never printed whole', async () => {
    const r = await refusedAfterTool();
    const out = plain(r.out);
    // The tail of the JSON object is the part that carries no information for
    // a person and four lines of screen for the braces.
    assertNotIncludes(out, 'payload_too_large', 'the machine-readable tail is noise on a screen');
    assertNotIncludes(out, 'chat_history_too_large');
  });

  await test('REFUSAL: the MODEL is not blamed for what the PROVIDER did', async () => {
    const r = await refusedAfterTool();
    const out = plain(r.out);
    assertIncludes(out, 'PROVIDER REFUSED', 'name the actor that actually refused');
    assert.ok(!/MODEL INTERRUPTED/.test(out),
      'the model did not interrupt anything, and nobody interrupted it');
  });

  await test('REFUSAL: the session survives it and the prompt comes back', async () => {
    const r = await refusedAfterTool();
    assert.strictEqual(r.code, 0, 'a refusal must not kill the REPL');
    assertNotIncludes(r.out, 'fatal:');
  });
};
