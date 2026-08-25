'use strict';

/**
 * A TURN THAT SAID NOTHING MUST NOT LOOK LIKE ONE THAT DID.
 *
 * ------------------------------------------------------------------------
 * THE REPORTED FAILURE, with a screenshot: `stealth/ox-alpha` through
 * omniroute, asked "hello". The screen showed the task banner, an empty
 * Context, and a green DONE. Everything had worked and there was nothing to
 * read — which is indistinguishable from LAIN having lost the reply, and that
 * is exactly what the user concluded.
 *
 * TWO SEPARATE DEFECTS, and only the first is about reasoning models:
 *
 *   THE PROSE WAS PARSED AND DROPPED. `openaiChat` read `delta.content` and
 *     nothing else. Reasoning models behind OpenRouter-shaped gateways stream
 *     their prose as `reasoning` or `reasoning_content`, and some emit ONLY
 *     that — so every word the model produced was decoded, discarded, and
 *     reported as a successful empty turn.
 *
 *   SILENCE WAS NOT REPORTED AS SILENCE. Even with genuinely no output, the
 *     turn ended DONE with a blank pane. "The answer was empty" is a fact, and
 *     a fact stated is worth incomparably more than a blank rectangle.
 *
 * REASONING IS KEPT SEPARATE FROM THE ANSWER. It is shown so the screen is not
 * blank; it is NOT added to `record.text`, because that is what the transcript,
 * the session projection and the completion check read. Thinking aloud is not
 * an answer, and merging them would put working-out into the record as though
 * the model had said it.
 *
 * LIVE CLI VERIFIED: the real binary and the real draw path. The network call
 * is the mock.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, lastFrameRows } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function project() {
  const cwd = tmpdir('empty-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    trustedPaths: [{ path: cwd, level: 'TRUSTED' }],
  }));
  return { cwd, configDir };
}

module.exports = async function () {
  await test('EMPTY: a reasoning-only reply reaches the screen instead of vanishing', async () => {
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'hello\n',
      script: [{ reasoning: 'DISTINCTIVE_THOUGHT the user said hello, so I greet them.' }],
      timeoutMs: 60000,
    });
    const frame = plain(lastFrameRows(r.out).join('\n'));
    assert.match(frame, /DISTINCTIVE_THOUGHT/,
      `a model that streams only \`reasoning\` produced a blank Context:\n${frame}`);
  });

  await test('EMPTY: reasoning is NOT recorded as the model\'s answer', async () => {
    // The line that must not be crossed. `record.text` feeds the transcript,
    // the completion check and the session projection; putting working-out
    // there would be LAIN reporting thinking as speech.
    const { cwd, configDir } = project();
    const r = await runCli(['-p', 'hello'], {
      cwd, configDir,
      script: [{ reasoning: 'DISTINCTIVE_THOUGHT considering the greeting.' }],
      timeoutMs: 60000,
    });
    const dir = path.join(r.configDir, 'sessions');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const turn = saved.turns[saved.turns.length - 1];
    assert.ok(!/DISTINCTIVE_THOUGHT/.test(String(turn.text || '')),
      'reasoning must not be recorded as what the model said');
  });

  await test('EMPTY: a genuinely silent turn SAYS it was silent', async () => {
    const { cwd, configDir } = project();
    const r = await runCli(['-p', 'hello'], {
      cwd, configDir,
      script: [{ text: '' }],
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assert.match(out, /returned no text and called no tools/,
      'an empty answer must be reported, not left as a blank pane');
    // AND IT NAMES THE LIKELIEST CAUSE, because this is not something a user
    // can diagnose by looking at their own screen.
    assert.match(out, /reasoning/, 'it points at the field the prose may be arriving in');
  });

  await test('EMPTY: an ordinary reply is untouched, and says nothing extra', async () => {
    // The guard must not fire on a working turn — a warning that appears on
    // healthy runs is one people stop reading.
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'hello\n',
      script: [{ text: 'Hello! How can I help you today?' }],
      timeoutMs: 60000,
    });
    const frame = plain(lastFrameRows(r.out).join('\n'));
    assert.match(frame, /How can I help you today/);
    assert.ok(!/returned no text/.test(plain(r.out)), 'a working turn is not warned about');
  });

  await test('EMPTY: reasoning AND an answer — the answer is what is recorded', async () => {
    const { cwd, configDir } = project();
    const r = await runCli(['-p', 'hello'], {
      cwd, configDir,
      script: [{ reasoning: 'THINKING_PART weighing it up.', text: 'ANSWER_PART Hello!' }],
      timeoutMs: 60000,
    });
    const dir = path.join(r.configDir, 'sessions');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const turn = saved.turns[saved.turns.length - 1];
    assert.match(String(turn.text), /ANSWER_PART/, 'the answer is the record');
    assert.ok(!/THINKING_PART/.test(String(turn.text)), 'and the thinking is not');
    assert.ok(!/returned no text/.test(plain(r.out)), 'nor is the turn called silent');
  });
};
