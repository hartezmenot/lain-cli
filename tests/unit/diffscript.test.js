'use strict';

/**
 * THE EDIT SCRIPT — where the changes ARE, which is the question the diff
 * window is built on and the one `ui/panes.js unified()` cannot answer.
 *
 * `unified()` takes the common prefix and the common suffix and calls
 * everything between them one block. That is right for a pane, which is READ.
 * It is useless for a window, which is WATCHED: with one block there is nothing
 * to stop at, so the presentation can only scroll the file past at a constant
 * speed — the exact failure this exists to remove.
 */

const assert = require('assert');
const { test } = require('../helpers');

const script = require('../../src/ui/diffscript');

const file = (n) => Array.from({ length: n }, (_, i) => `line ${i}`);
const edit = (arr, at, to) => { const b = arr.slice(); b[at] = to; return b; };

module.exports = async function () {
  await test('SCRIPT: two changes far apart are TWO hunks', () => {
    // This is the whole point. Prefix/suffix says one.
    const a = file(60);
    let b = edit(a, 5, 'CHANGED FIVE');
    b = edit(b, 45, 'CHANGED FORTYFIVE');
    const s = script.build(a.join('\n'), b.join('\n'));
    assert.strictEqual(s.hunks.length, 2, 'two places to stop');
    assert.strictEqual(s.added, 2);
    assert.strictEqual(s.removed, 2);
  });

  await test('SCRIPT: changes close together are ONE hunk', () => {
    // Two edits a line apart are one place a person would stop.
    const a = file(40);
    let b = edit(a, 10, 'A');
    b = edit(b, 11, 'B');
    const s = script.build(a.join('\n'), b.join('\n'));
    assert.strictEqual(s.hunks.length, 1);
    assert.strictEqual(s.added, 2);
  });

  await test('SCRIPT: unchanged runs are ELIDED, so the window does not scroll through them', () => {
    const a = file(400);
    let b = edit(a, 3, 'FIRST');
    b = edit(b, 380, 'LAST');
    const s = script.build(a.join('\n'), b.join('\n'));
    assert.ok(s.rows.length < 40, `not four hundred rows: ${s.rows.length}`);
    assert.ok(s.rows.some((r) => r.kind === 'gap'), 'and it says how many it skipped');
  });

  await test('SCRIPT: every hunk points at its own FIRST changed row', () => {
    // Where the window stops: on the edit, not near it.
    const a = file(60);
    let b = edit(a, 8, 'X');
    b = edit(b, 48, 'Y');
    const s = script.build(a.join('\n'), b.join('\n'));
    for (const h of s.hunks) {
      assert.ok(s.rows[h.at], `hunk ${h.index} points at a row`);
      assert.notStrictEqual(s.rows[h.at].kind, 'context', 'and that row is a change');
      assert.strictEqual(s.rows[h.at].hunk, h.index);
    }
  });

  await test('SCRIPT: a pure insertion has removals of zero, and vice versa', () => {
    const a = file(20);
    const b = a.slice(0, 10).concat(['NEW ONE', 'NEW TWO'], a.slice(10));
    const ins = script.build(a.join('\n'), b.join('\n'));
    assert.strictEqual(ins.added, 2);
    assert.strictEqual(ins.removed, 0);
    const del = script.build(b.join('\n'), a.join('\n'));
    assert.strictEqual(del.added, 0);
    assert.strictEqual(del.removed, 2);
  });

  await test('SCRIPT: a new file is all additions; a deleted one is all removals', () => {
    const made = script.build(null, 'a\nb\nc');
    assert.strictEqual(made.added, 3);
    assert.strictEqual(made.removed, 0);
    const gone = script.build('a\nb\nc', null);
    assert.strictEqual(gone.removed, 3);
    assert.strictEqual(gone.added, 0);
  });

  await test('SCRIPT: an unchanged file has NO hunks', () => {
    // Which is what stops the window opening to perform nothing — a tool that
    // reported success while changing nothing must not animate as an edit.
    const s = script.build('same\ntext', 'same\ntext');
    assert.strictEqual(s.hunks.length, 0);
    assert.strictEqual(s.added, 0);
    assert.strictEqual(s.removed, 0);
  });

  await test('SCRIPT: the counts match a plain line count of the difference', () => {
    const a = file(30);
    let b = edit(a, 2, 'P');
    b = edit(b, 14, 'Q');
    b = edit(b, 27, 'R');
    const s = script.build(a.join('\n'), b.join('\n'));
    assert.strictEqual(s.added, 3);
    assert.strictEqual(s.removed, 3);
    assert.strictEqual(s.rows.filter((r) => r.kind === 'added').length, 3);
    assert.strictEqual(s.rows.filter((r) => r.kind === 'removed').length, 3);
  });

  await test('SCRIPT: a change too large to diff properly degrades to ONE hunk, not to nothing', () => {
    // Past the cost guard the shape is what prefix/suffix would have said. The
    // COUNTS are still real — it is a presentation detail degrading, not a
    // fact being lost.
    const a = Array.from({ length: 900 }, (_, i) => `old ${i}`).join('\n');
    const b = Array.from({ length: 900 }, (_, i) => `new ${i}`).join('\n');
    const t0 = Date.now();
    const s = script.build(a, b);
    assert.ok(Date.now() - t0 < 500, 'and it is fast about it');
    assert.strictEqual(s.hunks.length, 1);
    assert.ok(s.added > 0 && s.removed > 0);
  });

  await test('SCRIPT: it is bounded — a vast change cannot produce a vast document', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const b = a.map((l, i) => (i % 2 ? l : `changed ${i}`));
    const s = script.build(a.join('\n'), b.join('\n'));
    assert.ok(s.rows.length <= script.MAX_ROWS, `bounded rows: ${s.rows.length}`);
    assert.ok(s.truncated, 'and it says it was cut');
  });

  await test('SCRIPT: CRLF is not a change', () => {
    const s = script.build('a\r\nb\r\nc', 'a\nb\nc');
    assert.strictEqual(s.hunks.length, 0, 'the same text with different line endings is the same text');
  });
};
