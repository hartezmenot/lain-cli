'use strict';

/**
 * A COUNTER MAY NOT END A LEGITIMATE TURN.
 *
 * "A task may legitimately require 5, 20, 40, 80, or more tool calls. LAIN must
 * not decide that the model has 'had enough' merely because an arbitrary
 * counter was reached."
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES. `maxSteps: 30` ended a turn at thirty tool calls and
 * reported `STEP LIMIT`. The work was unfinished, the model was mid-way through
 * something it had every reason to continue, and the only thing that had
 * happened was that a variable reached a number nobody chose for this task.
 *
 * The property under test is stated as narrowly as it can be:
 *
 *     THE NUMBER OF TOOL CALLS ALONE CANNOT TERMINATE A TURN.
 *
 * Everything else that ends a turn — the model stopping, Ctrl+C, a provider
 * failure, a request that cannot be sent — is untouched and tested elsewhere.
 *
 * LIVE CLI VERIFIED: the real binary, the real turn loop, real child processes.
 * The network call is the mock.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A trusted project. No `maxSteps` — the default must be "no limit". */
function project(cfg = {}) {
  const cwd = tmpdir('longturn-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    trustedPaths: [{ path: cwd, level: 'TRUSTED' }], ...cfg,
  }));
  return { cwd, configDir };
}

/**
 * `n` steps of GENUINE PROGRESS — each writes a different file.
 *
 * Different target every time, so nothing here resembles repetition: this is a
 * long legitimate job, which is exactly the case the old ceiling punished.
 */
function realWork(n) {
  const steps = [];
  for (let i = 0; i < n; i++) {
    steps.push({
      text: `Step ${i}.`,
      tool_calls: [{ name: 'write_file', input: { path: `out/file-${i}.txt`, content: `content ${i}` } }],
    });
  }
  steps.push({ text: `FINISHED_AFTER_${n}_STEPS.` });
  return steps;
}

module.exports = async function () {
  await test('LONG: 40 legitimate tool calls run to completion — no STEP LIMIT', async () => {
    const { cwd, configDir } = project();
    const r = await runCli(['-p', 'do the long job'], {
      cwd, configDir,
      script: realWork(40),
      timeoutMs: 180000,
    });
    const out = plain(r.out);
    assert.match(out, /FINISHED_AFTER_40_STEPS/,
      'the turn must reach its own ending, not a ceiling');
    assert.ok(!/STEP LIMIT/.test(out), 'no counter may end it');
    assert.ok(!/BLOCKED/.test(out), 'and nothing may declare it stuck');

    // THE WORK REALLY HAPPENED. 40 files on disk is the difference between a
    // turn that ran and a test that only read a transcript.
    const made = fs.readdirSync(path.join(cwd, 'out')).filter((f) => f.endsWith('.txt'));
    assert.strictEqual(made.length, 40, `only ${made.length} files were written`);
  });

  await test('LONG: 60 steps, same answer — the ceiling is gone, not raised', async () => {
    // A raised ceiling would pass the 40 test and fail this one. That is
    // precisely the "same jail with a bigger number" outcome to rule out.
    const { cwd, configDir } = project();
    const r = await runCli(['-p', 'do the longer job'], {
      cwd, configDir,
      script: realWork(60),
      timeoutMs: 240000,
    });
    const out = plain(r.out);
    assert.match(out, /FINISHED_AFTER_60_STEPS/);
    assert.ok(!/STEP LIMIT/.test(out));
    assert.strictEqual(fs.readdirSync(path.join(cwd, 'out')).length, 60);
  });

  await test('LONG: a limit the USER configured is still honoured, and says whose it is', async () => {
    // The distinction the whole change rests on. `maxSteps: 5` in config is a
    // person capping their own spend — user authority, not LAIN's opinion — so
    // it binds, and the wording says so.
    const { cwd, configDir } = project({ maxSteps: 5 });
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'do the long job\n',
      script: realWork(40),
      timeoutMs: 120000,
    });
    const out = plain(r.out);
    assert.match(out, /STEP LIMIT/, 'the user asked for a bound and it held');
    assert.match(out, /you configured/, 'and it is named as the USER\'s limit, not as LAIN\'s judgement');
    assert.ok(fs.readdirSync(path.join(cwd, 'out')).length <= 6, 'and it really stopped there');
  });

  await test('LIVENESS: real repetition is OBSERVED, and the turn keeps running', async () => {
    //. The model reads the same file with the same arguments and gets the
    // same bytes back, six times. That is worth noticing — and noticing is the
    // whole of what LAIN may do about it.
    const { cwd, configDir } = project();
    fs.writeFileSync(path.join(cwd, 'stuck.txt'), 'ALWAYS THE SAME\n');
    const same = { name: 'read_file', input: { path: 'stuck.txt' } };
    const script = Array.from({ length: 6 }, (_, i) => ({ text: `Look ${i}.`, tool_calls: [same] }));
    script.push({ text: 'RAN_TO_THE_END.' });

    const r = await runCli(['-p', 'investigate'], {
      cwd, configDir,
      env: { LAIN_MOCK_WIRELOG: path.join(cwd, 'wire.log') },
      script,
      timeoutMs: 120000,
    });
    const out = plain(r.out);

    // IT NOTICED.
    assert.match(out, /looping/i, 'six identical results must produce a liveness observation');

    // AND DID NOTHING ELSE. Each of these is a way the observation could have
    // seized authority, and none of them may happen.
    assert.match(out, /RAN_TO_THE_END/, 'the turn was not terminated');
    assert.ok(!/BLOCKED/.test(out), 'the task was not declared blocked');
    assert.ok(!/\bFAILED\b/.test(out), 'nor failed');
    assert.ok(!/STEP LIMIT/.test(out), 'and no ceiling was invented for it');

    // NOR DID IT COST ANYTHING. Seven scripted responses, seven requests: the
    // observation did not manufacture an eighth to tell the model about itself.
    const requests = fs.readFileSync(path.join(cwd, 'wire.log'), 'utf8').split('\n').filter(Boolean).length;
    assert.strictEqual(requests, 7,
      `${requests} requests for a 7-response script — the liveness signal created work of its own`);
  });

  await test('LIVENESS: 20 reads of 20 DIFFERENT files is not repetition', async () => {
    //, the false-positive side. "Same tool name" is not a loop: reading
    // twenty files is what reading a codebase looks like. A detector that
    // cannot tell these apart is worse than none, because it trains people to
    // ignore it.
    const { cwd, configDir } = project();
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(cwd, `f${i}.txt`), `unique content ${i}\n`);
    const script = Array.from({ length: 20 }, (_, i) => ({
      text: `Reading ${i}.`,
      tool_calls: [{ name: 'read_file', input: { path: `f${i}.txt` } }],
    }));
    script.push({ text: 'READ_THEM_ALL.' });

    const r = await runCli(['-p', 'read the tree'], { cwd, configDir, script, timeoutMs: 150000 });
    const out = plain(r.out);
    assert.match(out, /READ_THEM_ALL/);
    assert.ok(!/looping/i.test(out),
      'twenty different files is legitimate work and must not be flagged');
    assert.ok(!/STEP LIMIT|BLOCKED/.test(out));
  });

  await test('LIVENESS: the signal RESOLVES when the model changes approach', async () => {
    // The other half of: an observation about a condition that has passed is
    // noise, and noise is what people learn to ignore.
    const { cwd, configDir } = project();
    fs.writeFileSync(path.join(cwd, 'stuck.txt'), 'SAME\n');
    fs.writeFileSync(path.join(cwd, 'other.txt'), 'SOMETHING ELSE\n');
    const same = { name: 'read_file', input: { path: 'stuck.txt' } };
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'investigate\n',
      script: [
        { text: 'A.', tool_calls: [same] },
        { text: 'B.', tool_calls: [same] },
        { text: 'C.', tool_calls: [same] },
        { text: 'D.', tool_calls: [same] },
        // The model changes strategy on its own.
        { text: 'Trying something else.', tool_calls: [{ name: 'read_file', input: { path: 'other.txt' } }] },
        { text: 'CHANGED_APPROACH.' },
      ],
      timeoutMs: 120000,
    });
    const { frames, lastFrameRows } = require('../helpers');
    const drawn = frames(r.out).map(plain).join('\n');
    assert.match(drawn, /STILL\s+GOING\s+ROUND/i, 'it was raised while the repetition was happening');
    const last = plain(lastFrameRows(r.out).join('\n'));
    assert.ok(!/STILL\s+GOING\s+ROUND/i.test(last), 'and it is gone once the model moved on');
    assert.match(plain(r.out), /CHANGED_APPROACH/);
  });

  await test('LONG: the step COUNT is still kept — accounting survives', async () => {
    // Removing the authority must not remove the telemetry. `/status` and the
    // persisted record both need the number.
    const { cwd, configDir } = project();
    const r = await runCli(['-p', 'do a short job'], {
      cwd, configDir,
      script: realWork(6),
      timeoutMs: 90000,
    });
    const dir = path.join(r.configDir, 'sessions');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const turn = saved.turns[saved.turns.length - 1];
    assert.strictEqual(turn.toolCalls, 6, 'the tool calls are counted');
    assert.strictEqual(turn.stopReason, 'end', 'and the turn ended because the MODEL stopped asking');
  });
};
