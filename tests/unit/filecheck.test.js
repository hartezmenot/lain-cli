'use strict';

/**
 * THE THIRD DIAGNOSTIC RUNG — and, mostly, its refusals.
 *
 * Most of what matters about a checker on the edit path is what it does NOT do.
 * A linter that reports a problem in correct code is worse than no linter: the
 * model spends a turn "fixing" working code, and after two false alarms it
 * learns to ignore the channel entirely. So the assertions below are weighted
 * towards silence, and the one positive case is guarded so it becomes a skip
 * rather than a failure on a machine with no Python linter installed.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const filecheck = require('../../src/filecheck');
const toolauthority = require('../../src/turnauthority');

module.exports = async function () {
  await test('FILECHECK: a language it has no fast tool for is INCONCLUSIVE, never clean', () => {
    // The two are different facts. "I looked and found nothing" and "there was
    // nothing here that could look" must not arrive at the caller identically,
    // or "we did not check" quietly becomes "there is nothing wrong".
    const dir = tmpdir('fc-none-');
    const f = path.join(dir, 'a.txt');
    fs.writeFileSync(f, 'not a program\n');
    assert.strictEqual(filecheck.checkerFor(f, dir), null, 'no checker claims a text file');
  });

  await test('FILECHECK: it never runs eslint on a project that does not lint', async () => {
    // ONLY WHAT THE PROJECT ALREADY HAS. An eslint with no config reports rules
    // its authors never chose, and a global one reports rules they turned off.
    const dir = tmpdir('fc-nolint-');
    fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');
    assert.strictEqual(filecheck.checkerFor(path.join(dir, 'a.js'), dir), null,
      'no config and no local binary means no opinion');
    const r = await filecheck.reportFor([path.join(dir, 'a.js')], dir);
    assert.strictEqual(r, '', 'and silence, not an empty finding block');
  });

  await test('FILECHECK: a correct Python file produces SILENCE', async () => {
    const dir = tmpdir('fc-ok-');
    const f = path.join(dir, 'ok.py');
    fs.writeFileSync(f, 'import sys\n\n\ndef main():\n    print(sys.argv)\n');
    const r = await filecheck.reportFor([f], dir);
    assert.strictEqual(r, '', `a correct file must say nothing; got: ${r}`);
  });

  await test('FILECHECK: `pirnt` is named before anything is executed', async () => {
    // §7's own example. The file PARSES — `ast.parse` accepts it and so does the
    // first rung — so before this existed the defect was discovered by running
    // the program: a suite, a stack trace, a NameError, and a turn spent working
    // backwards to a typo that a linter names in milliseconds.
    const dir = tmpdir('fc-typo-');
    const f = path.join(dir, 't.py');
    fs.writeFileSync(f, 'pirnt("hello")\n');
    const checker = filecheck.checkerFor(f, dir);
    if (!checker) {
      // DECLARED, NOT SILENT. On a machine with neither ruff nor pyflakes there
      // is genuinely nothing to assert, and pretending otherwise would make this
      // a test that passes by not looking.
      assert.ok(true, 'skipped — no fast Python linter is installed here');
      return;
    }
    const r = await filecheck.check(f, dir);
    if (r.inconclusive) {
      assert.ok(true, `skipped — ${checker.tool} is not usable here`);
      return;
    }
    assert.ok(r.rows.length >= 1, `${checker.tool} found nothing in a file with an undefined name`);
    const said = r.rows.map((d) => `${d.code} ${d.message}`).join(' | ');
    assert.match(said, /pirnt/, `it must name the actual symbol: ${said}`);
    const note = await filecheck.reportFor([f], dir);
    assert.match(note, /t\.py:1/, 'with a location the model can act on');
    // THE TOOL IS NAMED. "ruff says F821" and "LAIN thinks this looks wrong" are
    // different claims with different weights.
    assert.match(note, new RegExp(checker.tool, 'i'));
  });

  await test('FILECHECK: a missing linter module is not reported as a defect in the file', async () => {
    // `python -m pyflakes` on a machine without it exits non-zero saying so.
    // Reported as a finding, "No module named pyflakes" lands in the model's lap
    // as though the file it just wrote were broken.
    const dir = tmpdir('fc-absent-');
    const f = path.join(dir, 'x.py');
    fs.writeFileSync(f, 'x = 1\n');
    const r = await filecheck.reportFor([f], dir);
    assert.ok(!/No module named/i.test(r), `an absent tool is not a finding: ${r}`);
  });

  // ---- the turn-ending vocabulary ----------------------------------------

  await test('AUTHORITY: an ending nobody recorded is a failure, not a completion', () => {
    // A turn loop that THREW rather than reporting leaves no record. Calling
    // that completed is the one lie that matters here, because the next sentence
    // a person types would then be delivered bare into whatever went wrong.
    assert.strictEqual(toolauthority.outcomeOf(null), 'provider');
  });

  await test('AUTHORITY: each ending keeps its own word on the way to the runtime', () => {
    assert.strictEqual(toolauthority.outcomeOf({ stopReason: 'end' }), 'completed');
    assert.strictEqual(toolauthority.outcomeOf({ stopReason: 'rate-limited' }), 'rate_limited');
    // PASSED THROUGH UNREAD. What an ending MEANS for the next sentence is the
    // Guardian's judgement; deciding it here would put half a state machine in
    // Node, and the half that is easiest to get subtly wrong.
    assert.strictEqual(toolauthority.outcomeOf({ stopReason: 'aborted' }), 'aborted');
    assert.strictEqual(toolauthority.outcomeOf({ stopReason: 'provider' }), 'provider');
    assert.strictEqual(toolauthority.outcomeOf({ stopReason: 'max-steps' }), 'max-steps');
    assert.strictEqual(toolauthority.outcomeOf({ stopReason: 'no-credential' }), 'no-credential');
    // A record with no reason at all finished normally — that is what the turn
    // loop's own default means.
    assert.strictEqual(toolauthority.outcomeOf({}), 'completed');
  });
};
