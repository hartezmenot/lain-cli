'use strict';

/**
 * THE EDIT SCRIPT — a change, described as the sequence of edits that made it.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS AND `ui/panes.js unified()` DOES NOT DO IT.
 *
 * `unified()` finds the common prefix and the common suffix and calls
 * everything in between one block. For the DIFF PANE that is exactly right: a
 * pane is READ, and a reader wants the whole changed region in front of them.
 *
 * The diff WINDOW is not read, it is WATCHED, and watching needs something
 * `unified()` cannot answer: WHERE ARE THE CHANGES. A refactor that renames a
 * symbol in three places is three edits ninety lines apart, and prefix/suffix
 * collapses it into one span containing the ninety unchanged lines between
 * them — so a presentation built on it can only scroll the whole file past at a
 * constant speed. There is nothing to stop AT, because the shape that says
 * "stop here" was thrown away before the window ever saw it.
 *
 * So this computes the real edit script — a line-level diff — and groups it
 * into HUNKS, each with the context around it. That is what lets the window
 * scroll to a change, stop, perform it, and move on.
 *
 * ------------------------------------------------------------------------
 * IT IS A PURE FUNCTION OF THE TWO TEXTS. No clock, no state, no I/O. The
 * before and after come from the CHECKPOINT — the same source the DIFF pane
 * reads — so what is animated is what is on disk, and a tool that reported
 * success while changing nothing produces an empty script and no window.
 */

/** Unchanged lines kept around a hunk, so a change is seen in its place. */
const CONTEXT = 3;
/**
 * The largest middle section a full diff is computed for.
 *
 * `m * n` cells is the cost of the table below. Two thousand changed lines
 * against two thousand is four million, which is a visible pause on the turn
 * loop's thread for a window nobody is required to watch — so past this the
 * change is described as ONE hunk (which is what `unified()` would have said)
 * rather than spending the time. It is a presentation detail degrading, not a
 * fact being lost: the counts and the content are the same either way.
 */
const MAX_CELLS = 400000;
/** Bound on the document the window can play, in rows. */
const MAX_ROWS = 600;

/** Split, tolerating either line ending, and never inventing a trailing line. */
function lines(s) {
  if (s == null) return null;
  const t = String(s).replace(/\r\n/g, '\n');
  return t === '' ? [] : t.split('\n');
}

/**
 * The longest common subsequence of two line arrays, as an op list.
 *
 * The classic table. Guarded by MAX_CELLS at the caller, and only ever run on
 * the MIDDLE — the common prefix and suffix are removed first, which is what
 * makes the guard almost never fire on a real edit.
 */
function script(a, b) {
  const m = a.length;
  const n = b.length;
  const L = new Uint32Array((m + 1) * (n + 1));
  const at = (i, j) => i * (n + 1) + j;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      L[at(i, j)] = a[i] === b[j]
        ? L[at(i + 1, j + 1)] + 1
        : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ op: 'eq', text: a[i] }); i++; j++; }
    else if (L[at(i + 1, j)] >= L[at(i, j + 1)]) { ops.push({ op: 'del', text: a[i] }); i++; }
    else { ops.push({ op: 'add', text: b[j] }); j++; }
  }
  while (i < m) { ops.push({ op: 'del', text: a[i] }); i++; }
  while (j < n) { ops.push({ op: 'add', text: b[j] }); j++; }
  return ops;
}

/** Every op, with the common prefix and suffix already known to be equal. */
function ops(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }

  const head = a.slice(0, s).map((text) => ({ op: 'eq', text }));
  const tail = a.slice(ea + 1).map((text) => ({ op: 'eq', text }));
  const midA = a.slice(s, ea + 1);
  const midB = b.slice(s, eb + 1);

  let mid;
  if (!midA.length) mid = midB.map((text) => ({ op: 'add', text }));
  else if (!midB.length) mid = midA.map((text) => ({ op: 'del', text }));
  else if (midA.length * midB.length > MAX_CELLS) {
    // TOO BIG TO DIFF PROPERLY, AND IT SAYS SO BY SHAPE: one hunk, every
    // removal then every addition. Exactly what `unified()` reports.
    mid = midA.map((text) => ({ op: 'del', text })).concat(midB.map((text) => ({ op: 'add', text })));
  } else mid = script(midA, midB);

  return head.concat(mid, tail);
}

/**
 * THE SCRIPT, as a document to play plus the hunks to stop at.
 *
 * `rows` is the whole thing the window scrolls through, in order, each row
 * carrying which hunk it belongs to and what is going to happen to it. `hunks`
 * indexes into it: where the window stops, and what it does when it gets there.
 *
 * Unchanged runs longer than twice the context are ELIDED — one row saying how
 * many lines were skipped. Without that, two changes at either end of a
 * thousand-line file are a thousand rows of scrolling between two seconds of
 * editing, which is the "generic scroll speed" this replaces.
 */
function build(before, after) {
  const a = lines(before);
  const b = lines(after);
  if (a == null && b == null) return empty();
  const all = a == null
    ? (b || []).map((text) => ({ op: 'add', text }))
    : b == null
      ? a.map((text) => ({ op: 'del', text }))
      : ops(a, b);

  // Which ops are near a change — everything else is elidable.
  const near = new Uint8Array(all.length);
  for (let i = 0; i < all.length; i++) {
    if (all[i].op === 'eq') continue;
    for (let k = Math.max(0, i - CONTEXT); k < Math.min(all.length, i + CONTEXT + 1); k++) near[k] = 1;
  }

  // ---- THE COUNTS ARE THE WHOLE CHANGE, NOT THE PART THAT FITS ----------
  //
  // Counted from the ops rather than accumulated in the row loop below, which
  // stops at MAX_ROWS. A 900-line rewrite hit that ceiling among its removals
  // and reported `+0`, so the window's own numbers disagreed with the change on
  // disk — the one thing the counters exist to be right about. The DOCUMENT is
  // bounded; the arithmetic is not.
  let added = 0;
  let removed = 0;
  for (const o of all) {
    if (o.op === 'add') added++;
    else if (o.op === 'del') removed++;
  }

  const rows = [];
  const hunks = [];
  let hunk = -1;
  let noA = 0;
  let noB = 0;
  let skipped = 0;

  const flushSkip = () => {
    if (!skipped) return;
    rows.push({ kind: 'gap', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}`, hunk: -1, no: 0 });
    skipped = 0;
  };

  for (let i = 0; i < all.length; i++) {
    const o = all[i];
    if (o.op === 'eq') { noA++; noB++; } else if (o.op === 'del') noA++; else noB++;
    if (o.op === 'eq' && !near[i]) {
      // A run of unchanged lines nobody needs to watch scroll past.
      if (hunk >= 0) hunk = -1;
      skipped++;
      continue;
    }
    flushSkip();
    if (o.op !== 'eq') {
      if (hunk < 0) {
        hunk = hunks.length;
        hunks.push({ index: hunk, at: rows.length, removed: 0, added: 0, first: rows.length });
      }
      if (o.op === 'del') hunks[hunk].removed++; else hunks[hunk].added++;
    }
    rows.push({
      kind: o.op === 'eq' ? 'context' : o.op === 'del' ? 'removed' : 'added',
      text: o.text,
      hunk: o.op === 'eq' ? -1 : hunk,
      no: o.op === 'del' ? noA : noB,
    });
    if (rows.length >= MAX_ROWS) break;
  }
  flushSkip();

  // WHERE THE WINDOW STOPS, and it is the first CHANGED row of the hunk rather
  // than the context above it: the eye should land on the edit, not near it.
  for (const h of hunks) {
    const first = rows.findIndex((r) => r.hunk === h.index);
    h.at = first < 0 ? h.at : first;
    h.last = rows.reduce((acc, r, k) => (r.hunk === h.index ? k : acc), h.at);
  }

  return { rows, hunks, added, removed, truncated: rows.length >= MAX_ROWS };
}

function empty() { return { rows: [], hunks: [], added: 0, removed: 0, truncated: false }; }

module.exports = { build, ops, script, lines, empty, CONTEXT, MAX_CELLS, MAX_ROWS };
