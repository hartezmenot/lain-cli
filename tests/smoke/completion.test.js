'use strict';

/**
 * THE COMPLETION GATE, THROUGH THE REAL BINARY.
 *
 * The unit tests assert the rules. These assert that the rules are WIRED —
 * which is the distinction that mattered here, because the completion screen
 * and its evidence check were fully implemented, fully unit-tested, and
 * unreachable on every real task for want of any way for the model to write a
 * plan. A green unit tier said nothing about that.
 *
 * So each case drives bin/lain.js as a child process with a scripted model and
 * a real filesystem and shell, and asserts on what a user would actually see.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes } = require('../helpers');

/** A project whose one test passes or fails on demand. */
function project({ passing }) {
  const dir = tmpdir('lain-complete-');
  fs.writeFileSync(path.join(dir, 'target.txt'), 'original\n');
  fs.writeFileSync(
    path.join(dir, 'check.js'),
    passing ? 'process.exit(0);\n' : 'console.log("1 test failed");\nprocess.exit(1);\n'
  );
  return dir;
}

/** Plan → edit → run the check → tick every step. The shape of a real task. */
function script(cwd) {
  return [
    { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { steps: ['change the file', 'verify it'] } }] },
    { text: 'Reading the target first.', tool_calls: [{ name: 'read_file', input: { path: 'target.txt' } }] },
    { text: 'Editing.', tool_calls: [{ name: 'write_file', input: { path: 'target.txt', content: 'changed\n' } }] },
    { text: 'Done with step 1.', tool_calls: [{ name: 'plan_step_done', input: { note: 'wrote target.txt' } }] },
    { text: 'Verifying.', tool_calls: [{ name: 'run_bash', input: { command: 'node check.js' } }] },
    { text: 'Done with step 2.', tool_calls: [{ name: 'plan_step_done', input: { note: 'ran the check' } }] },
    { text: 'Finished.' },
  ];
}

module.exports = async function () {
  await test('COMPLETE: a model-written plan plus a PASSING check reaches TASK COMPLETE', async () => {
    const cwd = project({ passing: true });
    const r = await runCli([], {
      cwd, stdin: 'make the change\n/plan\n', script: script(cwd),
      env: { LAIN_PROVIDER: 'mock' },
    });
    // The plan exists at all — impossible before the model could write one.
    assertIncludes(r.out, '2/2 done', 'the model must be able to drive the plan to completion');
    assertIncludes(r.out, 'TASK COMPLETE', 'the completion screen must fire on genuine completion');
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'target.txt'), 'utf8'), 'changed\n');
  });

  await test('COMPLETE: the same plan with a FAILING check does NOT complete, and says why', async () => {
    const cwd = project({ passing: false });
    const r = await runCli([], {
      cwd, stdin: 'make the change\n/plan\n', script: script(cwd),
      env: { LAIN_PROVIDER: 'mock' },
    });
    // Every box is ticked and a file really changed — the old evidence rule was
    // satisfied. The red check is what must overrule it.
    assertIncludes(r.out, '2/2 done', 'the plan really is finished; that is the point');
    assertNotIncludes(r.out, 'TASK COMPLETE', 'a red check must not be reported as finished work');
    assertIncludes(r.out, 'not complete', 'a silent refusal is indistinguishable from nothing happening');
    assertIncludes(r.out, 'node check.js', 'the refusal must name the command that failed');
  });

  await test('COMPLETE: the model is TOLD the check is red, in the tool result it can act on', async () => {
    const cwd = project({ passing: false });
    const r = await runCli([], {
      cwd, stdin: 'make the change\n', script: script(cwd),
      env: { LAIN_PROVIDER: 'mock' },
    });
    // Reporting this only to the user would mean the one party able to fix it
    // never hears about it.
    assertIncludes(r.out, 'NOT complete', 'plan_step_done must report the failing check back to the model');
  });

  await test('COMPLETE: a finished plan with NOTHING done does not complete', async () => {
    const cwd = project({ passing: true });
    const r = await runCli([], {
      cwd, stdin: 'do nothing\n', env: { LAIN_PROVIDER: 'mock' },
      script: [
        { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { steps: ['think about it'] } }] },
        { text: 'Done.', tool_calls: [{ name: 'plan_step_done', input: { note: 'thought about it' } }] },
        { text: 'All finished!' },
      ],
    });
    assertNotIncludes(r.out, 'TASK COMPLETE', 'ticking a box is not evidence of work');
  });

  await test('COMPLETE: search tools are registered and run through the real binary', async () => {
    const cwd = tmpdir('lain-search-cli-');
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'const needle = 1;\n');
    const r = await runCli([], {
      cwd, stdin: 'find it\n', env: { LAIN_PROVIDER: 'mock' },
      script: [
        { text: 'Searching.', tool_calls: [{ name: 'grep', input: { pattern: 'needle' } }] },
        { text: 'Listing.', tool_calls: [{ name: 'glob', input: { pattern: '**/*.js' } }] },
        { text: 'Found it.' },
      ],
    });
    assertIncludes(r.out, 'src/a.js:1:', 'grep must return file and line through the real dispatch path');
    assertIncludes(r.out, 'src/a.js', 'glob must return project-relative paths');
  });
};
