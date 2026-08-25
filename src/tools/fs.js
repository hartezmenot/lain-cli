'use strict';

/**
 * Filesystem tools.
 *
 * No "you must read before you write" rule, no forced ordering, no guard that
 * refuses a write because the model did not do something else first. V1 grew a
 * stack of those (empty-write guard, orphan-file guard, nest guard, rewrite
 * guard) and every one carries a comment about the infinite loop it later
 * caused. If the model wants to write a file, it writes the file; LAIN's job is
 * to make that reversible (phase 9), not to prevent it.
 */

const fs = require('fs');
const path = require('path');

const MAX_READ_BYTES = 400_000;

function resolve(cwd, p) {
  const s = String(p || '');
  if (!s) return null;
  return path.isAbsolute(s) ? s : path.resolve(cwd, s);
}

function rel(cwd, abs) {
  try {
    const r = path.relative(cwd, abs);
    return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : abs;
  } catch { return abs; }
}

/**
 * BELOW THIS, A FILE IS SMALL ENOUGH THAT REWRITING IT WHOLE IS ORDINARY.
 *
 * A 200-byte config replaced by a 40-byte one is somebody editing a config. A
 * 30KB source file replaced by 2KB is somebody losing 28KB. The threshold is
 * where "rewrite the file" stops being the natural way to make a change.
 */
const TRUNCATION_FLOOR_BYTES = 2_000;

/** A write keeping less than this share of the file is a collapse, not an edit. */
const TRUNCATION_RATIO = 0.5;

/**
 * Would this write destroy most of an existing file?
 *
 * Returns the sizes when it would, and null otherwise — including for a new
 * file, which cannot lose anything, and for a file that is already small.
 *
 * AN EMPTY WRITE TO A NON-EMPTY FILE ALWAYS COUNTS, whatever the size: nothing
 * about "replace this with nothing" is an edit, and it is the exact shape that
 * emptied a 900-line file.
 */
function truncationRisk(abs, content) {
  let was;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    was = st.size;
  } catch { return null; }              // a new file loses nothing
  if (was === 0) return null;
  const now = Buffer.byteLength(content, 'utf8');
  if (now === 0) return { was, now };
  if (was < TRUNCATION_FLOOR_BYTES) return null;
  if (now >= was * TRUNCATION_RATIO) return null;
  return { was, now };
}

const tools = {
  read_file: {
    mutates: false,
    schema: {
      name: 'read_file',
      description: 'Read a text file. Use offset/limit for a line range instead of re-reading a large file whole. '
        + 'NOT the way to FIND something: to locate a definition or its callers use symbols, to search contents use grep, '
        + 'to find files by name use glob, to ask what would break if a file changed use dependents, and to see what a '
        + 'file CONTAINS use check_symbols with list_symbols — its outline, in any language, a fraction of the cost of reading it whole. '
        + 'Each answers in one result what reading the candidate files whole costs tens of thousands of tokens to answer. '
        + 'Read a file once you know it is the one you need, and do not re-read a file that has not changed since you read it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'number', description: '1-based first line' },
          limit: { type: 'number', description: 'number of lines' },
        },
        required: ['path'],
      },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'read_file needs a path', isError: true };
      let st;
      try { st = fs.statSync(abs); } catch { return { output: `no such file: ${input.path}`, isError: true }; }
      if (st.isDirectory()) return { output: `${input.path} is a directory — use list_dir`, isError: true };
      if (st.size > MAX_READ_BYTES && !input.limit) {
        return { output: `${input.path} is ${st.size} bytes. Read a range with offset/limit.`, isError: true };
      }
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return { output: `could not read ${input.path}: ${e.message}`, isError: true }; }
      const lines = text.split('\n');
      const start = Math.max(1, Number(input.offset) || 1);
      const count = Number(input.limit) || lines.length;
      const slice = lines.slice(start - 1, start - 1 + count);
      const numbered = slice.map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join('\n');
      return {
        output: numbered || '[empty file]',
        meta: { path: rel(ctx.cwd, abs), size: st.size, mtimeMs: Math.floor(st.mtimeMs), lines: lines.length },
      };
    },
  },

  write_file: {
    mutates: true,
    schema: {
      name: 'write_file',
      description:
        'Write a file, creating parent directories. Overwrites if it exists. '
        + 'To change PART of an existing file use apply_patch or edit_file instead - they verify '
        + 'the exact text they replace, so they cannot lose an edit they did not see. '
        + 'An existing file this session has never read is refused until it is read - '
        + 'read_file it first. '
        + 'A write that would replace a substantial file with a fraction of itself is refused '
        + 'unless truncate is set.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          truncate: { type: 'boolean', description: 'acknowledge deliberately replacing a file with much less content' },
        },
        required: ['path', 'content'],
      },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'write_file needs a path', isError: true };
      if (input.content == null) return { output: 'write_file needs content', isError: true };
      // ---- THE ONE MUTATOR THAT CAN DESTROY SOMEBODY ELSE'S WORK ----------
      //
      // `apply_patch` and `edit_file` verify their target CONTENT before
      // splicing, so a file that changed underneath them fails loudly and
      // nothing is lost — the exact-text match is a stronger guarantee than any
      // timestamp, because it is about the bytes being changed rather than
      // about the file's age.
      //
      // `write_file` has no such anchor. It replaces the whole file with
      // whatever the model composed from what it read, so if anything edited
      // that file after the read, this silently throws those edits away and
      // reports success. That is not a rejected patch; it is data loss with a
      // green result line, and it is reachable whenever a second LAIN session,
      // an editor or a build step touches the same tree.
      //
      // So this is the one place a timestamp check earns its keep. It fires
      // ONLY when this session actually read the file whole and the file has
      // changed since — see evidence.js `staleness`, and note that LAIN's own
      // writes invalidate the entry, so its own edits can never trip it.
      const { staleness, ledgerOf } = require('../evidence');
      const conflict = staleness(ledgerOf(ctx), ctx.cwd, abs);
      if (conflict.stale) {
        return {
          isError: true,
          output: [
            `WRITE CONFLICT - ${rel(ctx.cwd, abs)}`,
            'REASON: this file changed after you read it, and write_file would replace the whole',
            'file with what you composed from the old bytes - silently discarding that change.',
            `It was ${conflict.was.size} bytes when read; it is ${conflict.now.size} now.`,
            'Re-read it, then either write it again or make the change with apply_patch, which',
            'verifies the exact text it is replacing and therefore cannot lose an edit it did',
            'not see. NOTHING WAS WRITTEN.',
          ].join(String.fromCharCode(10)),
        };
      }
      // ---- THE THIRD QUESTION: WAS THERE ANYTHING TO GO STALE? --------------
      //
      // `staleness` above guards a file we read that changed. It says nothing
      // about the file we never read at all — which is the quieter failure:
      // no stale bytes, just no bytes, with a whole existing file about to be
      // replaced by ones composed from no evidence. Same refusal shape, same
      // reason code, so the model has one move to make: read it first.
      // Exemptions live in evidence.js `noInspection` — absent file (creation),
      // session-less context, and OUR OWN previous write still standing.
      const { noInspection, sessionIdOf } = require('../evidence');   // `ledgerOf` is already in scope above
      const blind = noInspection(ledgerOf(ctx), ctx.cwd, abs, sessionIdOf(ctx));
      if (blind) {
        return {
          isError: true,
          output: [
            `WRITE REFUSED - ${rel(ctx.cwd, abs)}`,
            'REASON: NO_INSPECTION_PROVENANCE - this file exists, and this session has never',
            'read it. Writing it now would replace every byte of it with ones composed from',
            'no inspection of what is there.',
            'read_file it first, then write it again. NOTHING WAS WRITTEN.',
          ].join(String.fromCharCode(10)),
        };
      }
      // ---- AND THE OTHER WAY TO LOSE A FILE: WRITING LESS THAN IS THERE ----
      //
      // The staleness check above catches a file that MOVED under you. It does
      // not catch the shape that actually happened: a large file replaced by a
      // fraction of itself, with nothing stale about it. A 900-line source file
      // went to 0 bytes that way - a small edit attempted as a whole-file
      // rewrite, from an incomplete reconstruction - and the file was untracked,
      // so there was nothing to restore it from.
      //
      // A COLLAPSE IS ALMOST NEVER WHAT SOMEBODY MEANT. Deleting most of a file
      // is a real operation and it is rare; making a small change is common, and
      // `apply_patch` and `edit_file` do it without putting the rest of the file
      // at risk. So the collapse is REFUSED and named, with both the way to do
      // it safely and the way to say you meant it.
      //
      // `truncate: true` is the acknowledgement. Not a force flag for every
      // write - just for this one shape, so the ordinary case is unaffected.
      const shrink = truncationRisk(abs, String(input.content));
      if (shrink && !input.truncate) {
        return {
          isError: true,
          output: [
            `TRUNCATION REFUSED - ${rel(ctx.cwd, abs)}`,
            `It is ${shrink.was} bytes; this write is ${shrink.now}${shrink.now === 0 ? ' (empty)' : ''}.`,
            'A whole-file write that keeps a fraction of the file is usually a small edit',
            'attempted the expensive way, or a reconstruction that was not complete.',
            '',
            'To change part of it:  apply_patch, or edit_file - both verify the exact text',
            'they replace, so they cannot destroy what they did not see.',
            'If you really do mean to replace it:  write_file with truncate: true.',
            'NOTHING WAS WRITTEN.',
          ].join(String.fromCharCode(10)),
        };
      }
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(input.content), 'utf8');
      } catch (e) { return { output: `could not write ${input.path}: ${e.message}`, isError: true }; }
      const bytes = Buffer.byteLength(String(input.content), 'utf8');
      return { output: `wrote ${rel(ctx.cwd, abs)} (${bytes} bytes)`, mutated: [abs] };
    },
  },

  edit_file: {
    mutates: true,
    schema: {
      name: 'edit_file',
      description: 'Replace an exact string in a file. `old` must appear exactly once unless replace_all is set.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old: { type: 'string' },
          new: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old', 'new'],
      },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'edit_file needs a path', isError: true };
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { return { output: `no such file: ${input.path}`, isError: true }; }
      const oldStr = String(input.old);
      if (!oldStr) return { output: 'edit_file needs a non-empty `old`', isError: true };
      const count = text.split(oldStr).length - 1;
      if (count === 0) return { output: `\`old\` not found in ${input.path}`, isError: true };
      if (count > 1 && !input.replace_all) {
        return { output: `\`old\` appears ${count} times in ${input.path} — pass replace_all or use a longer unique string`, isError: true };
      }
      const next = input.replace_all ? text.split(oldStr).join(String(input.new)) : text.replace(oldStr, String(input.new));
      try { fs.writeFileSync(abs, next, 'utf8'); } catch (e) { return { output: `could not write ${input.path}: ${e.message}`, isError: true }; }
      return { output: `edited ${rel(ctx.cwd, abs)} (${count} replacement${count === 1 ? '' : 's'})`, mutated: [abs] };
    },
  },

  list_dir: {
    mutates: false,
    schema: {
      name: 'list_dir',
      // WHEN, not merely what. "List entries in a directory" competes silently
      // with `glob` and says nothing about which to reach for — so the cheap
      // structural answer loses to the habit of listing a folder and then
      // reading whatever it contained. A description that does not place a tool
      // among its neighbours leaves that tool weak.
      description: 'List the entries of ONE directory. Use it to see what is immediately '
        + 'inside a folder. To find files by name across the tree use glob; to find where '
        + 'a name is defined and who uses it, symbols; for what imports a file, dependents '
        + '— each answers in a single call without reading any file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path || '.');
      let entries;
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return { output: `could not list ${input.path || '.'}: ${e.message}`, isError: true }; }
      const rows = entries.slice(0, 500).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return { output: rows.join('\n') || '[empty directory]' };
    },
  },
};

module.exports = { tools, resolve, rel, truncationRisk, TRUNCATION_FLOOR_BYTES, TRUNCATION_RATIO };
