'use strict';

/**
 * THE SUITE MUST NOT DEPEND ON THE ENVIRONMENT IT WAS LAUNCHED FROM.
 *
 * FOUND BY DRIVING LAIN AGAINST THIS REPOSITORY. A session whose environment
 * carried `NO_COLOR=1` ran `node tests/run.js unit` through the shell tool. The
 * child inherited the variable and `userblock.test.js` failed:
 *
 *     SAID: a user message is a BLOCK on its own ground, full width
 *     exactly the one message the user sent   0 !== 1
 *
 * Nothing was wrong with the renderer. That test sets `LAIN_FORCE_COLOR=1` to
 * get colour over a pipe, and `useColor()` correctly lets `NO_COLOR` beat it,
 * because that is what the convention requires. So a test that explicitly asked
 * for colour silently got none, and the failure it produced pointed squarely at
 * the presentation layer — which was fine.
 *
 * A FAILURE THAT NAMES THE WRONG LAYER IS THE EXPENSIVE KIND. It is the same
 * defect this project keeps finding in other places: a shell fault reported as a
 * syntax error, a provider quota reported as a failing test. Here it was an
 * inherited environment variable reported as a broken renderer.
 *
 * Two things are checked. That the PRODUCT rule is intact — `NO_COLOR` must go
 * on beating a forced colour, because users rely on it. And that the RUNNER
 * scrubs it, so no test can ever again be judged against an environment nobody
 * chose.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { test } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');

/** Ask a fresh process what `render.C` does under a given environment. */
function colourUnder(env) {
  const r = spawnSync(process.execPath, [
    '-e',
    "const {C}=require('./src/render');process.stdout.write(C.onGray('x'));",
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  return String(r.stdout || '');
}

module.exports = async function () {
  await test('HERMETIC: the runner has scrubbed the colour environment', () => {
    // True only because tests/run.js deletes these before requiring anything.
    // It is what makes every colour assertion in the suite deterministic.
    for (const k of ['NO_COLOR', 'LAIN_NO_COLOR', 'FORCE_COLOR', 'LAIN_FORCE_COLOR']) {
      assert.strictEqual(process.env[k], undefined,
        `${k} is set during the run — a colour assertion can no longer be trusted`);
    }
  });

  await test('HERMETIC: the scrub is IN the runner, not a happy accident', () => {
    // The assertion above passes vacuously in a clean shell. This one does not:
    // it fails the moment the guard is removed, whatever the environment.
    const src = fs.readFileSync(path.join(ROOT, 'tests', 'run.js'), 'utf8');
    for (const k of ['NO_COLOR', 'LAIN_NO_COLOR', 'FORCE_COLOR', 'LAIN_FORCE_COLOR']) {
      assert.ok(src.includes(`'${k}'`), `the runner no longer scrubs ${k}`);
    }
    assert.match(src, /delete process\.env\[k\]/, 'the scrub itself is gone');
  });

  await test('HERMETIC: NO_COLOR STILL BEATS a forced colour — the product rule is intact', () => {
    // The fix must not have been "make LAIN_FORCE_COLOR win". Users rely on
    // NO_COLOR, and a program that ignores it under some other flag is broken
    // in a way no test in this repository would otherwise notice.
    const forced = colourUnder({ LAIN_FORCE_COLOR: '1', NO_COLOR: '' });
    assert.ok(forced.includes('\x1b[48;5;236m'), `forced colour produced none: ${JSON.stringify(forced)}`);
    const suppressed = colourUnder({ LAIN_FORCE_COLOR: '1', NO_COLOR: '1' });
    assert.strictEqual(suppressed, 'x', 'NO_COLOR must win over LAIN_FORCE_COLOR');
  });

  await test('HERMETIC: LAIN_NO_COLOR suppresses it too, and a pipe alone stays plain', () => {
    assert.strictEqual(colourUnder({ LAIN_FORCE_COLOR: '1', LAIN_NO_COLOR: '1' }), 'x');
    // No TTY and nothing forcing it: plain, which is what the smoke harness
    // depends on when it asserts on text.
    assert.strictEqual(colourUnder({ LAIN_FORCE_COLOR: '' }), 'x');
  });

  await test('HERMETIC: THE PROVIDER VARIABLES ARE SCRUBBED TOO', () => {
    // The same hazard as the colour one, pointed at a worse outcome. A stale
    // `LAIN_PROVIDER=mock` with a `LAIN_MOCK_SCRIPT` left in a shell makes the
    // in-process tiers run turns against whatever that script holds — and one
    // containing a `write_file` wrote a file into the REPOSITORY ROOT during the
    // unit tier. A test tier reaching outside its own temporary directory is
    // exactly what tests/helpers.js already scrubs for spawned children.
    for (const k of ['LAIN_PROVIDER', 'LAIN_MOCK_SCRIPT', 'LAIN_MOCK_WIRELOG']) {
      assert.strictEqual(process.env[k], undefined,
        `${k} is set — the in-process tiers can be steered from outside`);
    }
    const src = fs.readFileSync(path.join(ROOT, 'tests', 'run.js'), 'utf8');
    for (const k of ['LAIN_PROVIDER', 'LAIN_MOCK_SCRIPT', 'LAIN_MOCK_WIRELOG']) {
      assert.ok(src.includes(`'${k}'`), `the runner no longer scrubs ${k}`);
    }
  });

  await test('HERMETIC: no test wrote into the repository root', () => {
    // The visible symptom of the above, checked directly. A tier that leaves a
    // file in the working tree has escaped its temporary directory, and the
    // damage is outside anything a test asserts on.
    const stray = ['out', 'proof.txt', 'real.txt', 'mock-script.json']
      .filter((n) => fs.existsSync(path.join(ROOT, n)));
    assert.deepStrictEqual(stray, [], `the suite left files in the repository: ${stray.join(', ')}`);
  });

  await test('HERMETIC: the config home is isolated, and it is not the real one', () => {
    // The other half of the same rule, and the one with teeth: an in-process
    // test that persists a setting must never reach what the user owns.
    const home = process.env.LAIN_CONFIG_DIR;
    assert.ok(home, 'the runner must give the suite a config home of its own');
    const real = path.join(require('os').homedir(), '.lain-v2');
    assert.notStrictEqual(path.resolve(home), path.resolve(real),
      'the suite is pointed at the real config home');
  });
};
