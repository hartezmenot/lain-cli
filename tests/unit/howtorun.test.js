'use strict';

/**
 * THE END OF A TASK MUST SAY HOW TO RUN THE THING.
 *
 * The completion summary reported what changed and what was verified, and
 * stopped there. "I changed three files and the suite passes" is half of what
 * somebody needs at the end of a task; the other half is the command that
 * starts it, and it is the first thing they go looking for.
 *
 * DISCOVERED, NEVER INVENTED. The commands come from the same `runCommands`
 * that CONTEXT and /brief read — package.json scripts, a Makefile, pyproject.
 * A project that declares none gets NO block rather than a plausible guess: a
 * wrong run command is worse than an absent one, because it gets typed.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const views = require('../../src/ui/views');
const T = require('../../src/ui/text');

const render = (cwd) => views.completion({
  session: { task: { objective: 'fix the thing' }, lifecycle: null },
  checkpoints: null,
  cwd,
  verification: [{ ok: true, label: 'npm test' }],
  width: 76,
}).map((l) => T.strip(l)).join('\n');

module.exports = async function () {
  await test('SUMMARY: it says how to RUN and how to TEST the project', () => {
    const dir = tmpdir('howto-');
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { dev: 'vite', test: 'jest' } }), 'utf8');
    const out = render(dir);
    assert.match(out, /How to run/);
    assert.match(out, /npm run dev/, 'the real dev command, as this project declares it');
    assert.match(out, /How to test/);
    assert.match(out, /npm run test/, 'the real test command');
  });

  await test('SUMMARY: a project that declares nothing gets NO invented command', () => {
    // The failure mode worth guarding: a summary that confidently prints
    // `npm start` for a project with no package.json at all.
    const dir = tmpdir('howto-bare-');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'nothing here\n', 'utf8');
    const out = render(dir);
    // The blocks themselves must be ABSENT. Asserted as headings rather than by
    // scanning for command words: the Verification block legitimately carries
    // whatever command was actually run, so a text search finds that and calls
    // it a guess.
    assert.ok(!/How to run/.test(out), `invented a run command:\n${out}`);
    assert.ok(!/How to test/.test(out), `invented a test command:\n${out}`);
    // And it is still a summary — dropping the section must not drop the rest.
    assert.match(out, /TASK COMPLETE/);
    assert.match(out, /Verification/);
  });

  await test('SUMMARY: run and test are SEPARATE blocks, not one list', () => {
    // They answer different questions and get reached for at different moments.
    const dir = tmpdir('howto-split-');
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { start: 'node .', test: 'node t.js' } }), 'utf8');
    const out = render(dir);
    const runAt = out.indexOf('How to run');
    const testAt = out.indexOf('How to test');
    assert.ok(runAt >= 0 && testAt >= 0, 'both blocks must be present');
    assert.ok(runAt < testAt, 'run comes before test');
  });

  await test('SUMMARY: the test command is not repeated under "how to run"', () => {
    const dir = tmpdir('howto-dupe-');
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'node t.js' } }), 'utf8');
    const out = render(dir);
    const runBlock = out.split('How to test')[0];
    assert.ok(!/node t\.js/.test(runBlock), 'the test command belongs under How to test only');
  });

  await test('SUMMARY: it still renders when the project cannot be read', () => {
    // A summary that throws is worse than one missing a section.
    const out = render(path.join(tmpdir('howto-gone-'), 'does-not-exist'));
    assert.match(out, /TASK COMPLETE/);
  });
};
