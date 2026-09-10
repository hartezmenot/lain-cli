'use strict';

/**
 * GIT STATE IN THE PROMPT — gitsnapshot.js, the section GAP-MATRIX row 24
 * exists to close.
 *
 * ------------------------------------------------------------------------
 * THE THREE INVARIANTS THIS FILE HOLDS, which are the ones the change was
 * designed around rather than properties that happened to be true:
 *
 *   1. THE SECTION RIDES THE VOLATILE TAIL, never the stable prefix.
 *      Working-tree state is the definition of volatile: one write to disk
 *      changes it. If it ever reached the stable half, a session that touched
 *      any file would re-price its entire conversation on the next request —
 *      exactly the defect promptparts.js exists to prevent, recreated by the
 *      feature meant to add information. The assertion is on the seam where the
 *      split actually happens (promptparts.of), not on prompt.build, because
 *      the git section joins `live` AFTER the split, in promptparts.
 *
 *   2. SILENCE IS THE CORRECT ANSWER FOR MORE CASES THAN NOISE IS.
 *      A clean tree, a project with no .git, a review that failed, a
 *      measurement that has not landed yet, and a review with no files all
 *      render an empty string. None of those teaches the model anything, and a
 *      wrong one would — so say() is pinned to '' for each.
 *
 *   3. THE COUNTS, NOT THE DIFF. gitsense.review's own contract: reading diff
 *      content into context is the expensive thing a per-file number avoids.
 *      The section renders files and +added/-removed rows plus a bounded set
 *      of shape observations; anything that would require diff content is
 *      deliberately absent.
 *
 * ------------------------------------------------------------------------
 * HOW THESE TESTS AVOID DEPENDING ON A REAL GIT. The say()/reset() tests are
 * pure: they pass hand-shaped review results, the same shape
 * gitsense.review returns, so no repository, no config, no subprocess. The
 * prefetch()/touched() tests need a directory but no .git — the interesting
 * behaviours there are storage, silence-on-failure and the ledger read, all
 * of which happen before or instead of a successful git call.
 *
 * THE SEAM TEST (promptparts) also avoids git entirely: it checks WHERE a
 * non-empty section lands, by planting a review on the app and asserting the
 * two halves, not by measuring a tree.
 *
 * semantic.test.js already covers gitsense.review against real repositories;
 * that is not duplicated here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const gitsnapshot = require('../../src/gitsnapshot');

/**
 * A gitsense.review-shaped result. review() adds `added`/`removed`/`rewrite`/
 * `generated`/`untracked`/`deleted` on top of status(); the section reads only
 * those, so a literal here is the whole contract.
 */
function review(files, extra = {}) {
  return {
    ok: true,
    files,
    totalLines: files.reduce((n, f) => n + (f.added || 0) + (f.removed || 0), 0),
    huge: false,
    // `unexpected` defaults false here and is planted per-file where a test is
    // about it; gitsense.review sets it from the normalized expected list.
    ...extra,
  };
}

/** One modified file row, minimally. */
function mod(file, added = 3, removed = 1, more = {}) {
  return { file, added, removed, untracked: false, deleted: false, ...more };
}

/** An app-shaped object — the only fields gitsnapshot touches. */
function appLike(extra = {}) {
  return {
    session: { cwd: process.cwd() },
    _gitSnapshot: null,
    ...extra,
  };
}

module.exports = async function () {
  // ---- WHAT THE SECTION SAYS ----------------------------------------------

  await test('GIT-PROMPT: a dirty tree renders its files with per-file counts', () => {
    const text = gitsnapshot.say(review([mod('src/app.js', 12, 4), mod('src/gate.js', 1, 0)]));
    assert.match(text, /src\/app\.js  \+12 -4/, 'each file with its own counts');
    assert.match(text, /src\/gate\.js  \+1 -0/);
    // NUMBERS, NOT CONTENT: nothing that would require reading the diff.
    assert.ok(!text.includes('++'), 'no diff hunk content may ride this section');
  });

  await test('GIT-PROMPT: untracked and deleted files are named by group', () => {
    const text = gitsnapshot.say(review([
      mod('tracked.js', 1, 1),
      { file: 'notes.md', added: 0, removed: 0, untracked: true, deleted: false },
      { file: 'gone.js', added: 0, removed: 0, untracked: false, deleted: true },
    ]));
    assert.match(text, /untracked: notes\.md/);
    assert.match(text, /deleted: gone\.js/);
    // A 0/0 untracked row is real information, not noise: a file on disk that
    // the last commit never saw is exactly what the model should know about.
    assert.ok(!/gone\.js  \+0 -0/.test(text), 'deleted files are grouped, not rowed as diffs');
  });

  await test('GIT-PROMPT: the shape observations attach reasoning, never a verdict', () => {
    const text = gitsnapshot.say(review([mod('a.js', 2000, 1990)], { huge: true, totalLines: 3990 }));
    assert.match(text, /Worth knowing:/);
    assert.match(text, /the change set is 3990 lines/, 'a huge set says its size');
    assert.match(text, /most of this was not asked for/, 'as a conditional observation');
    assert.ok(!/error/i.test(text.split('Worth knowing:')[1]), 'no observation is phrased as an error');
  });

  await test('GIT-PROMPT: files this session never wrote are called out — with the innocent reading', () => {
    // The `unexpected` flag is GITSENSE's judgement, made under the one
    // normalization rule that compares ledger paths to git names. say() renders
    // it; it does not re-derive it — an earlier version re-derived from a
    // second copy of the expected list and, comparing absolute against
    // relative, flagged EVERY modified file. The renderer-level contract is
    // that flag placement, so the flag is planted directly.
    const text = gitsnapshot.say(review([
      mod('mine.js', 2, 0),
      mod('theirs.js', 5, 0, { unexpected: true }),
    ]));
    assert.match(text, /theirs\.js/, 'the unexpected file is named');
    assert.match(text, /never wrote/, 'the observation is about provenance');
    assert.match(text, /dirty before/, 'and carries the explanation that keeps it from being an accusation');
    // mine.js still renders as an ordinary row — every modified file does — but
    // it must not appear as a FINDING. The notes section is where findings live,
    // so that is the scope of the assertion; checking the whole text would fail
    // on the row and prove nothing.
    const notes = text.split('Worth knowing:')[1] || '';
    assert.ok(!notes.includes('mine.js'), 'the file the session did write is not a finding');
    assert.match(text, /mine\.js  \+2 -0/, 'it is present as an ordinary row');
  });

  await test('GIT-PROMPT: a huge change set and whole-file rewrites both get their note', () => {
    // They advise DIFFERENT responses — scope (was the task small?) and edit
    // method (was a file written back whole?) — so one must not suppress the
    // other. An earlier version dropped the rewrite note whenever the huge
    // note fired.
    const text = gitsnapshot.say(review([
      mod('r1.js', 300, 300, { rewrite: true }),
    ], { huge: true, totalLines: 600 }));
    assert.match(text, /the change set is 600 lines/);
    assert.match(text, /whole-file rewrites: r1\.js/);
  });

  await test('GIT-PROMPT: the listing is a briefing — 12 rows, then a count', () => {
    const many = Array.from({ length: 20 }, (_, i) => mod(`f${i}.js`, 1, 1));
    const text = gitsnapshot.say(review(many));
    assert.strictEqual(gitsnapshot.MAX_FILES, 12, 'the cap the test is written against');
    const rows = text.split('\n').filter((l) => /^  f\d+\.js/.test(l));
    assert.strictEqual(rows.length, gitsnapshot.MAX_FILES, 'the listed rows are capped');
    assert.match(text, /\(\+8 more\)/, 'and the rest are counted, not hidden');
  });

  // ---- WHAT THE SECTION STAYS SILENT ABOUT --------------------------------

  await test('GIT-PROMPT: silence for a clean tree, no review, or a failed one', () => {
    assert.strictEqual(gitsnapshot.say(null), '', 'no measurement yet');
    assert.strictEqual(gitsnapshot.say(undefined), '', 'never measured');
    assert.strictEqual(gitsnapshot.say({ ok: false, error: 'not a git repository' }), '', 'a failed review');
    assert.strictEqual(gitsnapshot.say(review([])), '', 'a clean tree');
    assert.strictEqual(
      gitsnapshot.say({ ok: true, files: null }),
      '',
      'a malformed review is silence, not a crash',
    );
  });

  // ---- THE BACKGROUND REFRESH ---------------------------------------------

  await test('GIT-PROMPT: prefetch stores the review for the synchronous reader, or nothing', async () => {
    const dir = tmpdir('gitsnap-');
    const a = appLike({ session: { cwd: dir } });
    // No .git here — the real gitsense.review path, exercising silence-on-failure
    // end to end rather than by stubbing the module.
    const before = a._gitSnapshot;
    const p = gitsnapshot.prefetch(a, []);
    assert.ok(p instanceof Promise, 'the caller gets a promise it may ignore');
    await p;
    // Either a failed review ({ok:false}) or null — never a throw, and never a
    // stale value presented as fresh. The next say() from it must be silence.
    assert.ok(a._gitSnapshot === null || a._gitSnapshot.ok === false,
      `expected silence-shaped storage, got ${JSON.stringify(a._gitSnapshot).slice(0, 120)}`);
    assert.strictEqual(gitsnapshot.say(a._gitSnapshot), '');
    assert.strictEqual(before, null, 'and the field started empty');
  });

  await test('GIT-PROMPT: prefetch with no app or no cwd resolves null and touches nothing', async () => {
    const nothing = await gitsnapshot.prefetch(null, []);
    assert.strictEqual(nothing, null);
    const a = { session: null, _gitSnapshot: 'STALE' };
    const r = await gitsnapshot.prefetch(a, []);
    assert.strictEqual(r, null);
    assert.strictEqual(a._gitSnapshot, 'STALE', 'a session-less app keeps whatever it had');
  });

  await test('GIT-PROMPT: reset forgets the measurement — adopt calls it for a new tree', () => {
    const a = appLike({ _gitSnapshot: review([mod('x.js')]) });
    gitsnapshot.reset(a);
    assert.strictEqual(a._gitSnapshot, null);
    assert.strictEqual(gitsnapshot.say(a._gitSnapshot), '', 'and the section is gone with it');
    gitsnapshot.reset(null); // never throws
  });

  // ---- THE EXPECTED LIST, FROM THE CHECKPOINT LEDGER -----------------------

  await test('GIT-PROMPT: touched reads the checkpoint ledger, the one source /changes knows', () => {
    const dir = tmpdir('gitsnap-');
    const real = require('../../src/ui/panes').changedFiles;
    let asked = null;
    // ONE SOURCE, NOT A SECOND IDEA: the assertion is on the arguments, which
    // is where a second idea of "what LAIN wrote" would have to diverge.
    require('../../src/ui/panes').changedFiles = (o) => {
      asked = o;
      return [{ path: path.join(dir, 'written.js') }];
    };
    let paths;
    try {
      paths = gitsnapshot.touched({ checkpoints: 'LEDGER', session: { cwd: dir } });
    } finally {
      require('../../src/ui/panes').changedFiles = real;
    }
    assert.deepStrictEqual(paths, [path.join(dir, 'written.js')]);
    assert.strictEqual(asked.checkpoints, 'LEDGER', 'the ledger itself is what is asked');
    assert.strictEqual(asked.cwd, dir);
  });

  await test('GIT-PROMPT: the ledger list reaches GITSENSE, which owns the path normalization', async () => {
    // The absolute-vs-relative comparison that decides "did this session write
    // this file" lives in ONE place — gitsense.review's expected handling. What
    // must hold at THIS seam is only that prefetch hands the ledger's paths to
    // it untransformed: any filtering or re-mapping here would be the second
    // idea, and the bug this file exists to prevent came from exactly that.
    //
    // THE PATCH IS HELD ACROSS THE AWAIT, deliberately. prefetch calls review
    // inside a `.then` — a microtask that runs after prefetch returns. A patch
    // restored in a synchronous `finally` would be gone before the call it
    // exists to observe, and the assertion would read null on a correct
    // implementation.
    const dir = tmpdir('gitsnap-');
    const realReview = require('../../src/gitsense').review;
    let sawExpected = null;
    require('../../src/gitsense').review = (cwd, o) => {
      sawExpected = { cwd, expected: (o && o.expected) || [] };
      return Promise.resolve({ ok: false, error: 'stubbed: this test observes the arguments, not the tree' });
    };
    const a = appLike({ session: { cwd: dir } });
    try {
      await gitsnapshot.prefetch(a, [path.join(dir, 'led.js')]);
    } finally {
      require('../../src/gitsense').review = realReview;
    }
    assert.deepStrictEqual(sawExpected.expected, [path.join(dir, 'led.js')],
      'the ledger paths pass through untouched — gitsense normalizes, nothing else');
    assert.strictEqual(sawExpected.cwd, dir);
  });

  await test('GIT-PROMPT: a ledger that cannot be read is an empty list, not a crash', () => {
    const paths = gitsnapshot.touched(null);
    assert.deepStrictEqual(paths, []);
    const thrown = gitsnapshot.touched({ checkpoints: { smell: undefined } });
    assert.deepStrictEqual(thrown, []);
  });

  // ---- THE SEAM: WHERE THE SECTION LANDS ON THE WIRE -----------------------

  await test('GIT-PROMPT: the section lands in the VOLATILE half, never the stable prefix', () => {
    // ---- WHY THIS IS THE ONE THAT MATTERS --------------------------------
    //
    // Working-tree state is the definition of volatile. The whole point of
    // gitsnapshot is free information for the model; if it rode the stable
    // prefix, a session that wrote any file would invalidate the cached head
    // of every later request — the token incident this split exists to
    // prevent, recreated by the feature that was meant to add information.
    const parts = require('../../src/promptparts');
    const app = appLike({
      _gitSnapshot: review([mod('src/thing.js', 4, 2)]),
      _projectBrief: '',
      session: (() => {
        const { Session } = require('../../src/session');
        return new Session({ cwd: process.cwd() });
      })(),
      // The fields promptparts.of reads on its way to prompt.build. The
      // expected-paths list is deliberately absent: of() is a pure renderer
      // of the stored review and no longer reads the ledger — that list now
      // travels through prefetch, which is the test above this one.
      cfg: {},
      checkpoints: null,
      _supervisedJobs: [],
      _supervisedProviders: [],
    });
    const halves = parts.of(app);
    assert.ok(halves.live.includes('# Working tree (git)'),
      'the section must be visible in the volatile half');
    assert.match(halves.live, /src\/thing\.js  \+4 -2/);
    assert.ok(!halves.stable.includes('Working tree'),
      'a git section in the stable prefix would re-price the conversation on every file write');
  });

  await test('GIT-PROMPT: a clean tree leaves both halves without a git section', () => {
    const parts = require('../../src/promptparts');
    const app = appLike({
      _gitSnapshot: null,
      _projectBrief: '',
      session: (() => {
        const { Session } = require('../../src/session');
        return new Session({ cwd: process.cwd() });
      })(),
      cfg: {},
      checkpoints: null,
      _supervisedJobs: [],
      _supervisedProviders: [],
    });
    const halves = parts.of(app);
    assert.ok(!halves.stable.includes('# Working tree'), 'nothing in the stable half');
    assert.ok(!halves.live.includes('# Working tree'), 'and nothing in the volatile one — silence is the product');
  });
};
