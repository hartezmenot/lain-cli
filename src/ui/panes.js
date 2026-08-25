'use strict';

/**
 * THE CHANGE PANES — diff, files, output. Pure state → lines, like views.js.
 *
 * These live in their own module only because they are the three views that read
 * CHECKPOINT BYTES rather than session state; the rule is the same and so is the
 * signature. Nothing here calls a model, and nothing here mutates: a diff is
 * computed from the bytes captured before a mutating call and the bytes on disk
 * now, so it is a fact about the filesystem, never a claim by the model.
 */

const fs = require('fs');
const path = require('path');

const MAX_TREE_ENTRIES = 300;
const SKIP = /^(?:node_modules|\.git|dist|build|out|target|vendor|__pycache__|\.venv|venv|coverage|\.next|\.cache|\.idea|\.vscode)$/i;

// Measured VISIBLY — these panes carry colour now, and `.length` counts escape
// bytes as if they took cells. See ui/text.js.
const T = require('./text');
// THE ONE WRAPPER. A command and its output are content and may not be cut to
// the column - see the note in `outputView`. `wrapIndented` never drops a
// character and never rejoins an indented line into prose, which matters here:
// in command output the layout IS information.
const { wrapIndented, MAX_WRAPPED_ROWS } = require('./doc');
const clip = T.clip;
const pad = T.pad;
function rel(cwd, p) {
  try { return path.relative(cwd, p).replace(/\\/g, '/'); } catch { return String(p); }
}

/**
 * Every file this session touched, with a real line count for each.
 *
 * THE one place that answers "what changed" — the diff view, the files view, the
 * completion screen and the file picker all consume this rather than each
 * walking the checkpoints their own way.
 *
 * @returns {Array<{path, rel, kind, added, removed, before, after}>}
 */
function changedFiles({ checkpoints, cwd }) {
  const byPath = new Map();
  for (const entry of (checkpoints && checkpoints.entries) || []) {
    for (const f of entry.files) {
      // Keep the EARLIEST captured bytes: with several edits to one file, the
      // interesting diff is against how it started, not against the last edit.
      if (!byPath.has(f.path)) byPath.set(f.path, { path: f.path, before: f.bytes ? f.bytes.toString('utf8') : null, existed: f.existed });
    }
  }
  const out = [];
  for (const rec of byPath.values()) {
    let after = null;
    try { after = fs.readFileSync(rec.path, 'utf8'); } catch { after = null; }
    if (rec.before === after) continue;
    const a = rec.before == null ? [] : rec.before.split('\n');
    const b = after == null ? [] : after.split('\n');
    const { added, removed } = countChanges(a, b);
    out.push({
      path: rec.path,
      rel: rel(cwd, rec.path),
      kind: rec.before == null ? 'added' : after == null ? 'deleted' : 'modified',
      added, removed, before: rec.before, after,
    });
  }
  out.sort((x, y) => x.rel.localeCompare(y.rel));
  return out;
}

/** Line counts either side of the common prefix/suffix. Bounded and exact. */
function countChanges(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  return { added: Math.max(0, eb - s + 1), removed: Math.max(0, ea - s + 1) };
}

/**
 * A RENAME IS TWO EVENTS THAT MEAN ONE THING.
 *
 * The checkpoints record bytes per path, so moving a file appears as one path
 * deleted and another added. Pairing them is not a guess: it is only a rename
 * when the removed bytes and the added bytes are IDENTICAL and non-empty, which
 * is a fact about the two files rather than an inference about intent. Anything
 * else stays two separate changes, because reporting a rewrite as a rename
 * would hide the rewrite.
 */
function groupChanges(files) {
  const added = files.filter((f) => f.kind === 'added');
  const removed = files.filter((f) => f.kind === 'deleted');
  const renamed = [];
  const paired = new Set();
  for (const gone of removed) {
    if (!gone.before || !gone.before.trim()) continue;
    const match = added.find((n) => !paired.has(n) && n.after === gone.before);
    if (!match) continue;
    paired.add(match);
    paired.add(gone);
    renamed.push({ from: gone.rel, to: match.rel });
  }
  return {
    added: added.filter((f) => !paired.has(f)),
    modified: files.filter((f) => f.kind === 'modified'),
    removed: removed.filter((f) => !paired.has(f)),
    renamed,
  };
}

/**
 * DIFF — WHAT WAS IMPLEMENTED, WHAT CHANGED, WHAT WENT AWAY.
 *
 * Grouped by what happened rather than listed alphabetically, because those are
 * the three different questions a person has when they look at this. Colour
 * carries the same meaning it does everywhere else: green added, yellow
 * modified, red removed, cyan for a path.
 */
/**
 * ONE DIFF ROW — conventional semantics, on its own reading surface.
 *
 *   +  added     green
 *   -  removed   red
 *      context   neutral
 *
 * THE MARKER IS NEVER THE COLOUR'S JOB. `+` and `-` stay in the text, so the
 * diff is still readable with colour off, in a pipe, or by somebody who cannot
 * distinguish the two hues — which is most of why the convention exists.
 *
 * The row is padded to the full width BEFORE the background is applied, so the
 * surface is a rectangle rather than a ragged stripe behind each line. The
 * foreground is applied inside it: an inner reset would close the background
 * too (see ui/paint.js on nesting).
 */
function diffRow(line, width, P) {
  const mark = line.slice(5, 6);
  const body = clip(line, Math.max(8, width - 4));
  const tone = mark === '+' ? P.ok : mark === '-' ? P.bad : P.meta;
  const padded = body + ' '.repeat(Math.max(0, width - 4 - T.width(body)));
  return '  ' + P.surface(tone(padded));
}

function diffView({ checkpoints, cwd, width = 80, selected = null, maxLines = 400 }) {
  const { P } = require('./paint');
  const files = changedFiles({ checkpoints, cwd });
  if (!files.length) {
    return [P.head('DIFF'), '', '  Nothing has changed yet.', '',
      P.meta('  Everything LAIN writes is captured here first,'),
      P.meta('  so /undo can always put it back.')];
  }

  const pick = selected ? files.find((f) => f.rel === selected) : null;
  if (!pick) {
    // EXPANDED BY DEFAULT.
    //
    // This pane used to be a LIST — `src/app.js   +3 -2` — with "Enter to open
    // a file" underneath it. So the one question the pane exists to answer,
    // "what actually changed?", cost a keystroke per file to reach, and
    // reviewing four files meant four round trips through a menu. A diff view
    // whose default state contains no diff is a table of contents.
    //
    // Every changed file is now shown in full, separated by a heavy rule
    // carrying the path and its counts, and the workspace windows the result:
    // scrolling down walks out of one file and into the next, which is how
    // every other diff a person reads behaves. `selected` still drills into a
    // single file, so nothing that worked before was taken away.
    const lines = [];
    let budget = maxLines;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (budget <= 0) {
        lines.push(P.meta(`  … ${files.length - i} more file(s) — Enter opens one on its own.`));
        break;
      }
      const counts = `+${f.added} -${f.removed}`;
      const kind = f.kind === 'added' ? P.ok : f.kind === 'deleted' ? P.bad : P.warn;
      // The divider IS the file boundary, and it stays findable while scrolling
      // because it is the widest, brightest thing in the pane. Measured
      // visibly — these rows carry colour, and `.length` counts escapes as
      // cells (see ui/text.js), which is what tears a rule off its right edge.
      const head = `━━ ${f.rel} `;
      const fill = Math.max(2, width - T.width(head) - counts.length - 3);
      lines.push(P.info(head + '━'.repeat(fill)) + ' ' + P.meta(counts));
      lines.push(kind('  ' + f.kind.toUpperCase()));
      const body = unified(f.before, f.after, Math.min(budget, 120));
      for (const l of body) lines.push(diffRow(l, width, P));
      if (!body.length) lines.push(P.meta('    (no line-level diff was captured for this file)'));
      lines.push('');
      budget -= body.length + 3;
    }
    return lines;
  }

  const kindPaint = pick.kind === 'added' ? P.ok : pick.kind === 'deleted' ? P.bad : P.warn;
  const lines = [
    P.head(pick.rel),
    '  ' + kindPaint(pick.kind.toUpperCase()) + P.meta(`   +${pick.added} -${pick.removed}`),
    '',
  ];
  // LINE-LEVEL, when the bytes are there to show it — and never faked when they
  // are not: `unified` works from the captured bytes and the file on disk.
  for (const l of unified(pick.before, pick.after, maxLines)) lines.push(diffRow(l, width, P));
  lines.push('');
  lines.push(P.meta('  Esc to go back.'));
  return lines;
}

/**
 * A line-level diff with line numbers and a little context.
 *
 * Not Myers: it brackets the changed region between the common prefix and
 * suffix, which is what a reviewer reads and is bounded by construction — a
 * 10,000-line rewrite cannot produce 10,000 rows.
 */
function unified(before, after, max = 400, context = 3) {
  const a = before == null ? [] : before.split('\n');
  const b = after == null ? [] : after.split('\n');
  if (before == null) return b.slice(0, max).map((l, i) => `${String(i + 1).padStart(4)} + ${l}`);
  if (after == null) return a.slice(0, max).map((l, i) => `${String(i + 1).padStart(4)} - ${l}`);

  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }

  const out = [];
  for (let i = Math.max(0, s - context); i < s; i++) out.push(`${String(i + 1).padStart(4)}   ${a[i]}`);
  const removed = a.slice(s, ea + 1);
  const added = b.slice(s, eb + 1);
  for (let i = 0; i < removed.length && out.length < max; i++) out.push(`${String(s + i + 1).padStart(4)} - ${removed[i]}`);
  for (let i = 0; i < added.length && out.length < max; i++) out.push(`${String(s + i + 1).padStart(4)} + ${added[i]}`);
  for (let i = eb + 1; i < Math.min(b.length, eb + 1 + context); i++) out.push(`${String(i + 1).padStart(4)}   ${b[i]}`);
  if (removed.length + added.length > max) out.push(`     … ${removed.length + added.length - max} more changed lines`);
  return out;
}

/**
 * FILES — the project as a bounded tree, with this session's changes marked.
 *
 * The old version listed ONLY changed files, so before the first edit the view
 * was empty and the tab was useless. The tree is a shallow scan with a hard cap
 * and the same SKIP set used everywhere else, so a generated directory can never
 * flood it.
 */
function filesView({ checkpoints, cwd, width = 80, tree = null, cursor = -1 }) {
  const { P } = require('./paint');
  const files = changedFiles({ checkpoints, cwd });
  const changed = new Map(files.map((f) => [f.rel, f]));
  const entries = tree || [];
  const lines = [];

  // WHAT CHANGED, FIRST — grouped by what happened to it.
  //
  // This grouping used to live at the top of the DIFF pane, where it stood
  // BETWEEN the user and the diff. DIFF is now expanded by default (see
  // diffView), so the question "which files did this touch?" needs its own
  // home, and it belongs here: this is the structural view of the project, and
  // "changed" is a structural fact about it. The tree below still marks each
  // one, so the two halves agree.
  if (files.length) {
    const g = groupChanges(files);
    const section = (mark, label, paint, rows) => {
      if (!rows.length) return;
      lines.push(paint(`${mark} ${label}`) + P.meta(`  ${rows.length}`));
      for (const f of rows) {
        const counts = `+${f.added} -${f.removed}`;
        const room = Math.max(10, width - counts.length - 8);
        lines.push('    ' + pad(P.path(clip(f.rel, room)), room + 2) + P.meta(counts));
      }
      lines.push('');
    };
    section('+', 'ADDED', P.ok, g.added);
    section('~', 'MODIFIED', P.warn, g.modified);
    section('-', 'REMOVED', P.bad, g.removed);
    for (const r of g.renamed) {
      lines.push(P.info('→ RENAMED') + '    ' + P.path(clip(r.from, width / 2 - 6)) + P.meta(' → ') + P.path(clip(r.to, width / 2 - 6)));
    }
    if (g.renamed.length) lines.push('');
  }

  lines.push(P.head('PROJECT'), '');

  if (!entries.length) {
    lines.push('  Nothing scanned yet.');
    return lines;
  }

  // Real tree connectors. `last[d]` says whether the entry at depth d is the
  // final child, which is what decides between `├─` and `└─` and whether the
  // deeper levels still need a `│` running through them.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let prefix = '';
    for (let d = 0; d < e.depth; d++) prefix += lastAtDepth(entries, i, d) ? '   ' : '│  ';
    const branch = lastAtDepth(entries, i, e.depth) ? '└─ ' : '├─ ';
    // A DIRECTORY IS NOT A FILE, and a file this session touched is not an
    // untouched one. Both are said with colour rather than another column.
    const mark = changed.has(e.rel) ? ' ' + P.ok('●') : '';
    const sel = i === cursor ? '❯' : ' ';
    const name = e.isDir ? P.info(e.name) : changed.has(e.rel) ? P.ok(e.name) : e.name;
    const body = `${sel} ${P.meta(prefix + branch)}${name}`;
    lines.push(pad(clip(body, width - 3), Math.max(0, width - 3)) + mark);
  }
  if (changed.size) {
    lines.push('');
    lines.push('  ' + P.ok('●') + P.meta(` changed this session — ${changed.size} file${changed.size === 1 ? '' : 's'}`));
  }
  return lines;
}

/** Is entry `i` the last child at depth `d` within its parent? */
function lastAtDepth(entries, i, d) {
  for (let j = i + 1; j < entries.length; j++) {
    if (entries[j].depth < d) return true;      // left the parent
    if (entries[j].depth === d) return false;   // another sibling follows
  }
  return true;
}

/**
 * A shallow, bounded project tree. Directories are expanded one level below the
 * root only — enough to orient, and it cannot walk a monorepo forever.
 */
function scanTree(cwd, { max = MAX_TREE_ENTRIES, depth = 2 } = {}) {
  const out = [];
  const walk = (dir, d, prefix) => {
    if (out.length >= max || d > depth) return;
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const dirs = names.filter((e) => e.isDirectory() && !SKIP.test(e.name) && !e.name.startsWith('.'));
    const files = names.filter((e) => e.isFile() && !e.name.startsWith('.'));
    for (const e of dirs) {
      if (out.length >= max) return;
      const r = prefix + e.name;
      out.push({ name: e.name + '/', rel: r, depth: d, isDir: true });
      walk(path.join(dir, e.name), d + 1, r + '/');
    }
    for (const e of files) {
      if (out.length >= max) return;
      out.push({ name: e.name, rel: prefix + e.name, depth: d, isDir: false });
    }
  };
  walk(cwd, 0, '');
  return out;
}

/** OUTPUT — bounded command/test output, newest last. */
/**
 * IMAGE FILES MENTIONED BY A COMMAND'S OUTPUT.
 *
 * Read from the text rather than declared by the caller, because the caller is
 * often a shell command that has no idea it produced a picture - a screenshot
 * tool, a test that writes a diff image, a Python script that saves a plot.
 */
const img = require('./images');

function imagesIn(o) {
  const found = [];
  const text = String((o && o.output) || '');
  const EXT = '(?:png|jpe?g|gif|webp|bmp)';
  const WIN = `[A-Za-z]:[\\\\/][^\\s"']+\\.${EXT}`;      // C:\a\b.png
  const NIX = `/[^\\s"']+\\.${EXT}`;                     // /a/b.png
  for (const m of text.matchAll(new RegExp(`${WIN}|${NIX}`, 'gi'))) {
    if (!found.includes(m[0])) found.push(m[0]);
  }
  return found.slice(0, 3);
}

function outputView({ outputs = [], width = 80, running = null }) {
  const { P } = require('./paint');
  if (!outputs.length && !running) {
    return [P.head('OUTPUT'), '', '  Nothing has been run yet.', '', P.meta('  Shell and test output appears here.')];
  }
  const lines = [P.head('OUTPUT'), ''];
  for (const o of outputs.slice(-5)) {
    const ok = o.exitCode === 0;
    const mark = ok ? P.ok('✓') : o.exitCode == null ? P.meta('·') : P.bad('✗');
    // ---- A COMMAND AND ITS OUTPUT ARE CONTENT, NOT LABELS ---------------
    //
    // The same defect the how-to callout had (ui/markdown.js), on the pane
    // whose entire job is to show what was run and what it said. `clip` ended a
    // long command with an ellipsis - so the pane that answers 'what did LAIN
    // actually execute?' answered with most of it - and did the same to every
    // output line, which is where a stack frame's tail, a failing assertion's
    // actual value and a deep path all live.
    //
    // A row that is a LABEL may be cut to the column; this pane has none.
    // THE MARK IS DRAWN ONCE. Repeating it on a continuation would read as
    // several commands with several outcomes; the wrapped rows are indented
    // under it instead, so the whole thing is visibly one command.
    const cmd = wrapIndented(String(o.command || ''), Math.max(12, width - 6));
    lines.push(`  ${mark} ` + P.cmd(cmd[0]));
    for (const part of cmd.slice(1)) lines.push('    ' + P.cmd(part));
    const body = String(o.output || '').split(String.fromCharCode(10));
    const shown = body.slice(0, 200);
    // Trailing blank lines are just a gap between one command and the next.
    while (shown.length && !shown[shown.length - 1].trim()) shown.pop();
    for (const l of shown) {
      // BOUNDED PER SOURCE LINE, because a minified bundle printed to stdout is
      // one line of forty thousand characters and wrapping it unconditionally
      // turns a scrollable pane into a wall. What is past the bound is COUNTED
      // and said, never silently cut.
      const parts = wrapIndented(String(l), Math.max(12, width - 8));
      const keep = parts.slice(0, MAX_WRAPPED_ROWS);
      for (const part of keep) lines.push('      ' + part);
      if (parts.length > keep.length) {
        lines.push(P.meta(`      ... ${parts.length - keep.length} more wrapped row(s) of this line`));
      }
    }
    // AN IMAGE IS NAMED AND MEASURED, NEVER APPROXIMATED. A screenshot's path in
    // a stream of text says nothing about what was captured; an ASCII rendering
    // of it would say something false. See ui/images.js.
    for (const f of imagesIn(o)) for (const l of img.imageLines(f, width)) lines.push(l);
    if (body.length > 200) lines.push(P.meta(`      … ${body.length - 200} more lines`));
    // THE EXIT STATUS IS ALWAYS STATED, including zero.
    //
    // It was announced only on failure, on the reasoning that success is the
    // expected case — but this is the pane a person opens to find out whether
    // something FINISHED, and silence is exactly as consistent with "still
    // running", "killed", and "output truncated" as it is with success. A
    // command that ended says so.
    lines.push('      ' + (ok
      ? P.meta('Process exited 0')
      : P.bad(`Process exited ${o.exitCode == null ? '?' : o.exitCode}`)));
    lines.push('');
  }
  // WHAT IS EXECUTING RIGHT NOW, at the foot where the newest thing belongs.
  // Without it this pane described only the past, and "what is running?" — the
  // question it exists to answer — had no answer here at all.
  //
  // The fields are the ones a person checks when something is taking too long:
  // what was asked for, which program is doing it, and that it has not finished.
  // Everything shown is read from the call already in flight; nothing here
  // starts, probes or polls anything.
  if (running) {
    const what = running.target || running.name || '';
    // The command IN FLIGHT, whole - see the note above. This is the row a
    // person reads when something is taking too long, and half of it is no use.
    const flight = wrapIndented(String(what), Math.max(12, width - 6));
    lines.push('  ' + P.warn('◒ ') + P.cmd(flight[0]));
    for (const part of flight.slice(1)) lines.push('    ' + P.cmd(part));
    lines.push('      ' + P.meta('tool     ') + P.meta(running.name || '—'));
    lines.push('      ' + P.meta('status   ') + P.warn('RUNNING'));
  }
  return lines;
}

module.exports = {
  changedFiles, countChanges, groupChanges, diffView, unified, filesView, scanTree, outputView,
  // EXPORTED so `/image` can offer the images LAIN has actually seen mentioned
  // without keeping a second list of them. One record of a thing, read both by
  // the pane that draws it and by the command that opens it — see imageview.js.
  imagesIn,
  MAX_TREE_ENTRIES,
};
