'use strict';

/**
 * WHICH CALLS MAY DRAW A CHANGE — and it is exactly the ones that can cause one.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, reported off a real screen: a READ and a SEARCH were drawing the
 * diff editor, with green `+` lines, as though the file were being written.
 *
 * The gate was "this call has a `path`", which is true of `read_file`,
 * `read_symbol` and a `grep` scoped to one file. `noteEdit` then looked that
 * path up among the session's CHANGED files — so reading a file LAIN had edited
 * earlier replayed that earlier edit's entire diff, attributing an addition to
 * a call that added nothing. The animation was of a real change; it was simply
 * not this call's, which is the same lie.
 *
 * These drive `turnevents.apply` with a stub app, because the defect is in the
 * WIRING — every module underneath it was behaving correctly.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const turnevents = require('../../src/turnevents');

/**
 * A FILE LAIN REALLY DID EDIT EARLIER IN THE SESSION.
 *
 * Without this the test proves nothing: `noteEdit` returns early when there are
 * no checkpoints, so a read would draw no window either way and the assertion
 * would pass with the defect still in place. The checkpoint has to be REAL —
 * captured bytes that differ from what is on disk now — for the old gate to do
 * the wrong thing.
 */
function edited() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-look-'));
  const file = path.join(dir, 'parser.js');
  fs.writeFileSync(file, ['const a = 1;', 'const b = 2;', 'const c = 3;', ''].join('\n'));
  return {
    dir,
    file,
    checkpoints: { entries: [{ files: [{ path: file, bytes: Buffer.from('const a = 1;\n'), existed: true }] }] },
    clean: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** An app that records what the UI was asked to draw, and nothing else. */
function stub(w) {
  const drew = { diffs: [], reads: [], actions: [] };
  return {
    drew,
    render: { toolResult() {}, toolStart() {}, text() {}, nl() {}, notice() {}, write() {} },
    session: { cwd: w ? w.dir : process.cwd(), turns: [], messages: [], actors: [] },
    checkpoints: w ? w.checkpoints : null,
    ui: {
      enabled: true,
      noteAction(a) { drew.actions.push(a); },
      noteNarration() {},
      noteActor() {},
      noteOutput() {},
      setRunning() {},
      noteEditCounts() {},
      showDiff(file) { drew.diffs.push(file); },
      showRead(file) { drew.reads.push(file); },
    },
  };
}

const result = (name, input, output = 'x') => ({ type: 'tool_result', name, input, output, isError: false });

module.exports = async function () {
  await test('LOOK: a READ never draws a change, even of a file LAIN edited earlier', () => {
    // The exact reported shape. `noteEdit` would find `src/parser.js` among the
    // changed files and replay its diff — green additions, under a `reading`
    // card, for a call that added nothing.
    const w = edited();
    try {
      // PROOF THE FIXTURE IS LIVE. Without a real earlier edit, `noteEdit`
      // returns immediately and a read draws nothing either way — the test
      // would pass with the defect still in place and prove nothing at all.
      const changed = require('../../src/ui/panes').changedFiles({ checkpoints: w.checkpoints, cwd: w.dir });
      assert.strictEqual(changed.length, 1, 'the file really was edited earlier in the session');
      assert.ok(changed[0].added > 0, 'and that earlier edit really did add lines');

      const app = stub(w);
      turnevents.apply(app, result('read_file', { path: w.file }, '    1\tconst a = 1;'), { liveText: '' });
      assert.deepStrictEqual(app.drew.diffs, [], 'a read must never open the edit window');
      assert.strictEqual(app.drew.reads.length, 1, 'it opens the read window instead');
    } finally { w.clean(); }
  });

  await test('LOOK: a SEARCH scoped to a file never draws a change either', () => {
    const w = edited();
    try {
      const app = stub(w);
      turnevents.apply(app, result('grep', { pattern: 'const', path: w.file }, `${w.file}:1`), { liveText: '' });
      assert.deepStrictEqual(app.drew.diffs, [], 'a search adds nothing and must not animate an addition');
    } finally { w.clean(); }
  });

  await test('LOOK: an EDIT still draws its change', () => {
    // The gate must not have closed on the one call it exists for.
    const w = edited();
    try {
      const app = stub(w);
      turnevents.apply(app, result('write_file', { path: w.file, content: 'x' }, 'wrote'), { liveText: '' });
      assert.deepStrictEqual(app.drew.diffs, [require('path').basename(w.file)],
        'the one call the window exists for still opens it');
      assert.deepStrictEqual(app.drew.reads, [], 'and a write is not a read');
    } finally { w.clean(); }
  });

  await test('LOOK: the gate is the registry own answer, not a hand-written list', () => {
    // A second list of "which tools change things" is the duplicate that drifts:
    // the day a tool is added, one of the two copies is updated.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'turnevents.js'), 'utf8');
    assert.ok(/isMutating\(ev\.name\)/.test(src), 'turnevents asks the tool registry');
    const tools = require('../../src/tools');
    assert.strictEqual(tools.isMutating('read_file'), false);
    assert.strictEqual(tools.isMutating('grep'), false);
    assert.strictEqual(tools.isMutating('write_file'), true);
    assert.strictEqual(tools.isMutating('apply_patch'), true);
  });
};
