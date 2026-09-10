'use strict';

/**
 * THE PROJECT BRIEFING — what `/brief` and `/brief detail` may say.
 *
 * ------------------------------------------------------------------------
 * THIS FILE WAS ABOUT A PANE, AND THE PANE IS GONE. WHAT IT PROVED IS NOT.
 *
 * CONTEXT and DETAIL were two of the nine workspace panes: two renderings of
 * ONE survey (ui/contextview.js), with CONTEXT carrying identity, state and the
 * next action, and DETAIL carrying the rows behind CONTEXT's counts. Half of
 * this file tested the crash that made CONTEXT unreachable (a temporal dead
 * zone in ui/reports.js `ensureReport`, thrown on the keystroke that opened the
 * pane) and the caching that stopped tab-cycling from starting 140 surveys.
 *
 * Both of those were properties of NAVIGATION, and there is no navigation. The
 * pane machinery, `ensureReport` and the survey cache went with it; a survey now
 * runs when somebody types `/brief`, which is once, on purpose, because they
 * asked.
 *
 * WHAT SURVIVES IS THE SPLIT ITSELF, and it survives because both renderings
 * do: `/brief` is CONTEXT and `/brief detail` is DETAIL, off the same pass. The
 * question those tests answered — what belongs in the summary and what belongs
 * in the evidence behind it — is exactly as live as it was, and the failure they
 * guard against (one of them growing into the other until neither is readable)
 * is the reason there were two renderings in the first place.
 * ------------------------------------------------------------------------
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const contextview = require('../../src/ui/contextview');

/** A survey shaped like survey.run()'s result, with something in every list. */
function fakeSurvey(root) {
  return {
    root,
    // (A `frontend` key was in this shape until the browser that observed the
    // axis was removed in 2026-09; the four that remain are what survey.run
    // actually returns.)
    health: { build: 'PASS', test: 'UNVERIFIED', runtime: 'PASS', engineering: 'DEGRADED' },
    languages: { js: 40, py: 3, json: 9 },
    scanned: 43,
    notes: ['The source sweep was truncated at 2500 files.'],
    environment: { os: 'Windows 11', shell: { preferred: 'powershell' }, packageManager: 'npm', runtimes: { node: 'node' } },
    git: {
      ok: true,
      totalLines: 412,
      files: [
        { file: 'src/a.js', added: 100, removed: 4 },
        { file: 'src/b.js', added: 40, removed: 40, rewrite: true },
        { file: 'src/c.js', added: 8, removed: 0, untracked: true },
        { file: 'src/d.js', added: 1, removed: 1 },
        { file: 'src/e.js', added: 2, removed: 2 },
      ],
    },
    testRun: null,
    findings: [
      { severity: 'ERROR', file: 'src/a.js', line: 12, message: 'a.js does not parse', explanation: 'a stray brace' },
      { severity: 'WARNING', file: 'src/b.js', message: 'whole-file rewrite', explanation: 'nearly every line differs' },
      // (This used to be the front-end finding nothing could produce any more;
      // the still-producible UNVERIFIED finding is the suite that did not run.)
      { severity: 'UNVERIFIED', message: 'The test suite was not run as part of this survey.', explanation: 'nothing ran' },
    ],
  };
}

module.exports = async function () {
  await test('CONTEXT: a malformed or partial survey renders a placeholder, never a throw', () => {
    for (const bad of [null, undefined, {}, { languages: null, health: null }, { git: { ok: true } }, 42, 'nonsense']) {
      for (const view of ['context', 'detail']) {
        assert.doesNotThrow(() => contextview.render(view, bad, { width: 80 }), `${view} on ${JSON.stringify(bad)}`);
      }
    }
  });

  // ============================================ WHAT BELONGS IN WHICH PANE ==

  await test('CONTEXT: the pane carries identity, state and the next action — not the discovery output', () => {
    const root = tmpdir('ctxpane-');
    const survey = fakeSurvey(root);
    const text = contextview.contextDoc(survey, { width: 100, session: null, cwd: root }).join('\n');

    // HIGH SIGNAL, present.
    assert.ok(/PROJECT/.test(text), 'project identity');
    assert.ok(/Stack/.test(text) && /js \(40\)/.test(text), 'the stack it is written in');
    assert.ok(/STATE/.test(text) && /Build/.test(text), 'the active state');
    assert.ok(/NEXT/.test(text), 'what to do next');

    // LOW SIGNAL, absent — this is the whole point of the split.
    assert.ok(!/surveying/i.test(text), 'the pane must not lead with its own discovery process');
    assert.ok(!/a stray brace/.test(text), 'a finding explanation belongs in DETAIL');
    assert.ok(!/test suite was not run/.test(text), 'and so does the list of findings');
    assert.ok(!/truncated at 2500/.test(text), 'sweep bookkeeping is not context');
    assert.ok(!/Windows 11/.test(text), 'the machine is not the project');

    // THE ONE EXCEPTION, AND IT IS THE POINT OF THE PANE. The single `next`
    // action names the finding that is actually blocking, because "what do I
    // do now" is the most actionable thing there is. What is excluded is the
    // LIST — every finding, with its explanation, as a wall to read.
    const blocking = (text.match(/does not parse/g) || []).length;
    assert.strictEqual(blocking, 1, `the blocking finding is named once, as the next action: ${blocking} occurrence(s)`);
    assert.ok(/→ Investigate/.test(text), 'and it is named as an action, not as a report');

    // THE COUNT IS THERE, WITH A POINTER — a summary, not a silence.
    assert.ok(/1 error/.test(text), `the number of findings must be stated: ${text}`);
    assert.ok(/DETAIL \(8\)/.test(text), 'and where to read them');
  });

  await test('DETAIL: the pane carries the rows behind the counts', () => {
    const root = tmpdir('ctxpane-');
    const survey = fakeSurvey(root);
    const text = contextview.detailDoc(survey, { width: 100, cwd: root }).join('\n');
    assert.ok(/does not parse/.test(text), 'the finding itself');
    assert.ok(/a stray brace/.test(text), 'and its explanation');
    assert.ok(/truncated at 2500/.test(text), 'and what the sweep did not reach');
    assert.ok(/ENVIRONMENT/.test(text) && /Windows 11/.test(text), 'and the machine');
    assert.ok(/src\/e\.js/.test(text), 'and every changed file, not the first three');
    assert.ok(/CONTEXT \(1\)/.test(text), 'with the way back');
  });

  await test('CONTEXT and DETAIL do not print the same list twice', () => {
    const root = tmpdir('ctxpane-');
    const survey = fakeSurvey(root);
    const ctx = contextview.contextDoc(survey, { width: 100, session: null, cwd: root }).join('\n');
    const det = contextview.detailDoc(survey, { width: 100, cwd: root }).join('\n');
    // The finding ROWS live in exactly one of them. CONTEXT may name the ONE
    // that is blocking, as its next action; DETAIL carries all of them with
    // the evidence behind each.
    assert.strictEqual((ctx.match(/does not parse/g) || []).length, 1);
    assert.ok(/does not parse/.test(det) && /a stray brace/.test(det));
    assert.ok(!/a stray brace/.test(ctx), 'the evidence behind a finding is never in both');
    // CONTEXT shows the first few changed files as a shape and says where the
    // rest are; DETAIL has all of them. That is a summary and its detail, not
    // a duplicate.
    assert.ok(/src\/a\.js/.test(ctx), 'the shape of the change is context');
    assert.ok(!/src\/e\.js/.test(ctx), 'the tail of the list is not');
    assert.ok(/more in DETAIL/.test(ctx));
  });

  await test('CONTEXT: a migration in flight is stated, because it changes how everything else reads', () => {
    const root = tmpdir('ctxpane-');
    const M = require('../../src/migration');
    const intent = require('../../src/migrationintent');
    const map = require('../../src/migrationmap');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/scanner.cpp'), 'void Scanner::scan() { }\n', 'utf8');
    const d = intent.parse('Migrate src to Python');
    d.paths = ['src'];
    d.dispositionHint = 'REPLACE';
    const built = map.build(root, d, { intent: 'Migrate src to Python' });
    M.save(built.contract);

    const rows = contextview.migrationRows(root);
    assert.ok(rows, 'an active migration must be reported');
    assert.ok(rows.outstanding.includes('src/scanner.cpp'),
      `what has not gone yet is the part somebody coming back needs: ${JSON.stringify(rows)}`);

    const text = contextview.contextDoc(fakeSurvey(root), { width: 100, session: null, cwd: root }).join('\n');
    assert.ok(/MIGRATION/.test(text), 'and it must appear on the pane');
    assert.ok(/Not yet gone/.test(text), 'saying what is still there that should not be');

    // A FINISHED MIGRATION IS NOT ACTIVE STATE. It would be one more true,
    // useless line — exactly what this pane was cleared out of.
    M.note(built.contract, M.STAGE.COMPLETE, 'done');
    M.save(built.contract);
    assert.strictEqual(contextview.migrationRows(root), null);
  });

  await test('BRIEF: `/brief detail` is the door the DETAIL pane left behind', () => {
    // §12: the pane went, the capability did not. `parseArgs` is where the word
    // is recognised, and briefcommand's renderer branch is what it selects — so
    // this asserts the seam rather than the spelling of one line of output.
    const brief = require('../../src/briefcommand');
    assert.strictEqual(brief.parseArgs('detail').detail, true, '`/brief detail` selects the detail rendering');
    assert.strictEqual(brief.parseArgs('').detail, false, 'bare `/brief` is the summary');
    assert.strictEqual(brief.parseArgs('--full').full, true, 'and the long evidence document is still one flag away');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'briefcommand.js'), 'utf8');
    assert.ok(/opts\.detail/.test(src) && /contextview/.test(src),
      'the detail branch must reach ui/contextview.js — the SAME renderer the pane used');
  });
};
