'use strict';

/**
 * THE MODEL OWNS ITS OWN REASONING LOOP.
 *
 * LAIN provides tools, context, evidence, execution and reliable transport. It
 * does not decide that the model meant to keep going and manufacture turns to
 * make it happen.
 *
 * WHAT WAS REMOVED, and why it looked reasonable. A turn is bounded at
 * `maxSteps`; a long investigation is not. So `carryon` continued the task
 * automatically when the bound was hit — up to four times, each an extra model
 * request carrying a synthetic "continue from exactly where you stopped"
 * prompt, each re-sending the whole conversation, each leaving that prompt
 * permanently in the history.
 *
 * The reasoning was that the bound is LAIN's, not the model's, so LAIN should
 * undo it. The flaw is that undoing it four times is not an architecture — it
 * is hiding an execution limit behind token spend, and it puts LAIN in charge
 * of whether the model is allowed to have stopped.
 *
 * These prove the boundary, through the real binary:
 *   — the bound stops the turn ONCE and says so truthfully
 *   — no synthetic prompt reaches the conversation
 *   — an EXPLICIT user continuation still works, because that is user control
 *   — transport retries are untouched, because those are not reasoning turns
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A project whose config caps the turn hard, through the REAL config key. */
function capped(steps) {
  const cwd = tmpdir('autonomy-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    maxSteps: steps,
    trustedPaths: [{ path: cwd, level: 'TRUSTED' }],
  }));
  return { cwd, configDir };
}

/** `n` responses that all ask for another tool — a model that never stops. */
const endless = (n) => Array.from({ length: n }, (_, i) => ({
  text: `Step ${i}.`,
  tool_calls: [{ name: 'run_bash', input: { command: `echo step-${i}` } }],
}));

module.exports = async function () {
  await test('AUTONOMY: the step limit stops the turn ONCE — no manufactured turns', async () => {
    const { cwd, configDir } = capped(3);
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'do the long thing\n',
      script: endless(20),
      timeoutMs: 90000,
    });
    const out = plain(r.out);

    // THE SCRIPT OFFERS TWENTY TOOL CALLS AND THE CAP IS THREE. Under the old
    // mechanism the chain ran 3 + 4×3 = up to fifteen. One turn runs three.
    //
    // COUNTED AS DISTINCT STEPS, NOT AS OCCURRENCES. The first version of this
    // matched `echo step-N` across the whole byte stream and reported 102 for a
    // run that made three calls — every redraw frame repaints the same rows, so
    // occurrences count REPAINTS. The step numbers are unique per call, so the
    // size of the set is the number of calls.
    const reached = new Set(out.match(/step-\d+/g) || []);
    assert.ok(reached.size <= 4,
      `${reached.size} distinct calls (${[...reached].join(', ')}) means the bound did not hold`);

    assert.ok(!/CONTINUING/.test(out), 'LAIN must not announce carrying on, because it must not carry on');
    assert.ok(!/automatic carry-ons/.test(out), 'there is no continuation budget');
    assert.ok(!/Continue from exactly where you stopped/i.test(out),
      'no synthetic continuation prompt may enter the conversation');
  });

  await test('AUTONOMY: the ending is TRUTHFUL — not DONE, not FAILED, not INTERRUPTED', async () => {
    const { cwd, configDir } = capped(2);
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'do the long thing\n',
      script: endless(20),
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    assert.match(out, /STEP LIMIT/, 'it must name its own execution boundary');
    // Nothing failed and nobody interrupted it, so it must claim neither.
    assert.ok(!/PROVIDER REFUSED|NOT AUTHENTICATED/.test(out), 'nothing failed');
    assert.ok(!/TASK COMPLETE/.test(out), 'and nothing was completed');
  });

  await test('AUTONOMY: an EXPLICIT user continuation still works', async () => {
    // The removal is about LAIN manufacturing turns, not about the user being
    // unable to ask for one. Typing `continue` is user control and must run.
    const { cwd, configDir } = capped(2);
    const r = await runCli([], {
      cwd, configDir,
      stdinSteps: ['do the long thing\n', 'continue\n', '/exit\n'],
      stepDelayMs: 2500,
      // TWO TOOL RESPONSES, THEN AN ENDING. The first version gave four, so the
      // continued turn spent its own two-step cap on tool calls and never
      // reached the closing message — the test failed on its own arithmetic
      // rather than on the behaviour. Turn 1 takes both tool responses; the
      // continuation lands on the ending.
      script: [...endless(2), { text: 'Carried on because you asked. FINISHED.' }],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    assert.match(out, /Carried on because you asked/,
      'an explicit continuation must start a real turn');
  });

  await test('AUTONOMY: transport retries are NOT reasoning turns, and survive', async () => {
    // The distinction the whole change rests on. Retrying the SAME failed
    // request after a 502 is transport recovery; inventing another turn is not.
    const { cwd, configDir } = capped(30);
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'say hello\n/exit\n',
      script: [
        { error: { status: 502, message: 'Bad Gateway' } },
        { error: { status: 503, message: 'Service Unavailable' } },
        { text: 'Recovered. FINISHED.' },
      ],
      timeoutMs: 60000,
    });
    const out = plain(r.out);
    assert.match(out, /retry \d+\/\d+/, 'the same request must be retried');
    assert.match(out, /Recovered/, 'and the work must complete once transport recovers');
    assert.ok(!/CONTINUING/.test(out), 'a retry is not a continuation');
  });

  await test('AUTONOMY: nothing in the tree manufactures a continuation any more', async () => {
    // A behaviour check on the SOURCE, because the mechanism could come back
    // under another name — the design asked for the behaviour to be gone, not
    // the word. What is banned is a submit whose input LAIN composed in order
    // to make the model take another turn.
    const src = path.join(__dirname, '..', '..', 'src');
    const offenders = [];
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.js')) continue;
      const text = fs.readFileSync(path.join(src, f), 'utf8');
      // The carry-on module itself, and the counter it kept.
      if (/require\(['"]\.\/carryon['"]\)/.test(text)) offenders.push(`${f}: still requires carryon`);
      if (/_carriedOn/.test(text)) offenders.push(`${f}: still tracks a continuation budget`);
      if (/from: 'carry-on'/.test(text)) offenders.push(`${f}: still submits a carry-on turn`);
    }
    assert.deepStrictEqual(offenders, [], offenders.join('\n'));
    assert.ok(!fs.existsSync(path.join(src, 'carryon.js')), 'carryon.js must be gone, not merely unused');
  });
};
