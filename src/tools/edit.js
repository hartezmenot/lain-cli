'use strict';

/**
 * SURGICAL EDITS — change a few lines without reading and rewriting a file.
 *
 * THE COST THIS EXISTS TO REMOVE. With only `read_file` and `write_file`, a
 * one-line change costs: read 2,000 lines in, hold them, emit 2,000 lines back
 * out. The input is paid for once and the OUTPUT is paid for at several times
 * the rate — so the cheapest possible edit was the most expensive thing the
 * model could do. Worse, every rewrite is a chance to silently drop a line the
 * model was not thinking about, and the diff then shows a 2,000-line change
 * where one line was meant.
 *
 * So these tools all share one shape: say WHERE, say WHAT, and the file is
 * spliced. Nothing here asks the model to reproduce content it is not changing.
 *
 * THE RULE THAT MAKES THEM SAFE TO USE BLIND:
 *
 *     AN EDIT THAT DOES NOT MATCH IS REJECTED, NEVER GUESSED.
 *
 * `apply_patch` states the lines it expects to replace and they are compared
 * byte for byte first. If the file has moved on — someone else edited it, the
 * model misremembered, an earlier patch already landed — the patch is refused
 * with the reason and the text that is actually there. That is the difference
 * between a tool a model can use without re-reading and a tool that quietly
 * corrupts a file when its memory is stale.
 *
 * Everything reports what it did in LINES, so the model learns from the result
 * that small edits are the normal size of an edit.
 */

const fs = require('fs');
const path = require('path');

/** Bound on what any one call sends back. Errors show context, not whole files. */
const MAX_CONTEXT_LINES = 12;

function resolve(cwd, p) {
  const s = String(p || '');
  if (!s) return null;
  return path.isAbsolute(s) ? s : path.resolve(cwd, s);
}

/**
 * Read a file, preserving what kind of line endings it had.
 *
 * A tool that splices LF into a CRLF file rewrites every line as far as git is
 * concerned, which turns a one-line patch into a whole-file diff — exactly the
 * outcome these tools exist to avoid, arrived at from the other direction.
 */
function readLines(abs) {
  const text = fs.readFileSync(abs, 'utf8');
  const crlf = /\r\n/.test(text);
  return { lines: text.split(/\r?\n/), crlf, text };
}

function writeLines(abs, lines, crlf) {
  fs.writeFileSync(abs, lines.join(crlf ? '\r\n' : '\n'), 'utf8');
}

/** `src/app.js:41` — how every result names a place. */
function at(cwd, abs, line) {
  let r = abs;
  try {
    const x = path.relative(cwd, abs);
    if (x && !x.startsWith('..')) r = x.replace(/\\/g, '/');
  } catch { /* keep the absolute path */ }
  return line ? `${r}:${line}` : r;
}

/**
 * WHICH LINE DID THEY PROBABLY MEAN?
 *
 * A rejected patch is only useful if it points at the real text. Looking for a
 * line CONTAINING the expected one cannot work — if it contained it the patch
 * would have applied — so the miss is almost always a small difference inside
 * an otherwise familiar line: `const y = 9;` against `const y = 2;`.
 *
 * Word overlap finds that, and finds nothing when there is genuinely nothing
 * close, which is the honest answer. Deliberately crude: this only has to beat
 * "no idea", and a real diff algorithm here would be a second implementation of
 * something ui/panes.js already owns for a different purpose.
 */
function closestLine(lines, want) {
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9_]+/g) || []);
  const target = words(want);
  if (!target.size) return -1;
  let best = -1;
  let bestScore = 0;
  lines.forEach((l, i) => {
    const here = words(l);
    let shared = 0;
    for (const w of target) if (here.has(w)) shared++;
    // Needs a real majority of the words, so an unrelated line that happens to
    // share `const` is never offered as "the closest".
    const score = shared / target.size;
    if (score > bestScore && score >= 0.5) { bestScore = score; best = i; }
  });
  return best;
}

/** A few lines around a point, for an error the model has to act on. */
function around(lines, index, span = 4) {
  const from = Math.max(0, index - span);
  const to = Math.min(lines.length, index + span + 1);
  return lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`).join('\n');
}

/**
 * WHY `expect` WAS NOT FOUND — answered, never guessed.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT WAS THE MESSAGE, NOT THE SAFETY.
 *
 * `apply_patch` re-reads the file at patch time and compares CONTENT, so a
 * target that changed underneath it already fails rather than corrupting
 * anything. That part was right, and it is a stronger guarantee than any
 * timestamp: it is about the bytes being replaced rather than about the file's
 * age. What the rejection then SAID was
 *
 *     REASON: the expected text is not in the file.
 *
 * which is the symptom restated. Handed that, a model does the only thing it
 * can — it speculates ("probably whitespace") and then either retries blind or
 * falls back to rewriting the whole file, which is the one operation that can
 * lose an edit LAIN never saw. A mutation system that cannot say WHY it refused
 * turns every refusal into a guess.
 *
 * So the causes are TESTED, most consequential first, and every one of them is
 * a fact about these exact bytes rather than a hypothesis:
 *
 *   CHANGED SINCE READ   the ledger holds this file's size and mtime from when
 *                        it was read whole, and LAIN's own writes clear that
 *                        entry — so a mismatch means something ELSE edited it.
 *                        This is the concurrent-session case, named.
 *   WHITESPACE           it matches once runs of whitespace are collapsed. The
 *                        kind is then named: tabs against spaces, or spacing
 *                        inside the line.
 *   A LONE CARRIAGE RETURN   CRLF is already normalised; a bare CR is not, and
 *                        it is invisible in any diff a person would look at.
 *   UNICODE FORM         it matches after NFC. A composed and a decomposed
 *                        accent are the same character and different bytes.
 *   INVISIBLE CHARACTERS a non-breaking space, a zero-width mark, a BOM, a
 *                        bidi override. Named with the code point, because that
 *                        is the only form anybody can act on.
 *
 * If none of them fires, the text genuinely is not there, and the closest-line
 * report the caller falls back to is the right answer.
 *
 * NOTHING HERE MUTATES OR RETRIES. It explains a refusal that has already
 * happened; the decision to refuse was made on the content, above.
 *
 * @returns {string|null} the reason, ready to print, or null for "not present"
 */
/**
 * THE CHARACTERS YOU CANNOT SEE, BUILT FROM CODE POINTS.
 *
 * Written as escapes rather than as the characters themselves, and that is not
 * a style choice: two of them (U+2028, U+2029) ARE line terminators to a
 * JavaScript parser, so a literal class containing them splits this file in
 * half. The project's control-byte guard exists for the same family of
 * accident. A pattern about invisible characters must not contain any.
 */
const INVISIBLE = new RegExp('['
  + String.fromCharCode(0x00a0)                                  // no-break space
  + String.fromCharCode(0x200b) + '-' + String.fromCharCode(0x200f)  // zero-width, marks
  + String.fromCharCode(0x2028) + String.fromCharCode(0x2029)    // line/paragraph separators
  + String.fromCharCode(0x202a) + '-' + String.fromCharCode(0x202e)  // bidi overrides
  + String.fromCharCode(0xfeff)                                  // byte-order mark
  + ']');

function whyNotFound(hay, needle, ctx, abs) {
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);

  // ---- SOMETHING OTHER THAN LAIN EDITED IT ------------------------------
  const { staleness, ledgerOf } = require('../evidence');
  const conflict = staleness(ledgerOf(ctx), ctx.cwd, abs);
  if (conflict.stale) {
    return [
      'PATCH CONFLICT: this file changed after you read it.',
      `It was ${conflict.was.size} bytes when you read it; it is ${conflict.now.size} now.`,
      "LAIN did not make that change — its own writes clear this record — so another",
      'session, an editor or a build step did. Re-read the range you mean to change',
      'and patch against what is there now. NOTHING WAS WRITTEN.',
    ].join(NL);
  }

  // ---- THE TEXT IS THERE, SPACED DIFFERENTLY ----------------------------
  const flat = (s) => s.replace(/[ \t]+/g, ' ').split(NL).map((l) => l.trim()).join(NL).trim();
  if (flat(needle) && flat(hay).includes(flat(needle))) {
    const tabsInFile = hay.includes('\t');
    const tabsInExpect = needle.includes('\t');
    const which = tabsInFile && !tabsInExpect
      ? 'the file indents with TABS and `expect` uses spaces'
      : tabsInExpect && !tabsInFile
        ? '`expect` indents with TABS and the file uses spaces'
        : 'the indentation depth or the spacing inside a line differs';
    return [
      `REASON: the text IS there, but the WHITESPACE differs — ${which}.`,
      'Copy the lines out of a read_file result rather than retyping them.',
    ].join(NL);
  }

  // ---- A BARE CR, WHICH NO DIFF WILL SHOW YOU ---------------------------
  if (hay.includes(CR) || needle.includes(CR)) {
    return [
      'REASON: a bare carriage return is present. CRLF is normalised before comparing;',
      'a lone CR is not, and it is invisible in any diff. Re-read the range and copy it.',
    ].join(NL);
  }

  // ---- THE SAME CHARACTERS, STORED DIFFERENTLY --------------------------
  try {
    if (hay.normalize('NFC').includes(needle.normalize('NFC'))) {
      return [
        'REASON: it matches only after Unicode normalisation — the same characters are',
        'stored in a different form. Copy the lines out of a read_file result.',
      ].join(NL);
    }
  } catch { /* an environment without full ICU: fall through to the next test */ }

  // ---- SOMETHING YOU CANNOT SEE -----------------------------------------
  const inExpect = INVISIBLE.exec(needle);
  const bad = inExpect || INVISIBLE.exec(hay);
  if (bad) {
    const cp = bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    return [
      `REASON: ${inExpect ? '`expect`' : 'the file'} contains an invisible character (U+${cp})`,
      '— a non-breaking space, a zero-width mark, a BOM or a bidi override.',
      'Copy the lines out of a read_file result.',
    ].join(NL);
  }

  return null;
}

/**
 * A DESTRUCTIVE MUTATION MUST KNOW WHAT IT IS DESTROYING.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, reproduced on a real file before this was written.
 *
 * `delete_range` addresses lines by NUMBER and verified nothing. An agent read
 * a file, something else prepended two lines, and the agent then asked to
 * delete lines 2..3:
 *
 *     wanted:   DELETE ME A / DELETE ME B
 *     deleted:  ALSO INSERTED / keep 1        <- somebody else's line, and a keeper
 *     survived: DELETE ME A / DELETE ME B     <- the actual targets
 *     reported: "deleted 2 line(s)"  isError: false
 *
 * Line numbers are the single most perishable way to name a piece of a file,
 * and they were the one addressing mode with no check at all. `apply_patch` and
 * `edit_file` are safe by construction because they match CONTENT; `write_file`
 * has a staleness guard. These three had neither.
 *
 * ------------------------------------------------------------------------
 * THREE QUESTIONS, ASKED IN THIS ORDER, and they catch different things.
 *
 *   DID IT CHANGE SINCE WE READ IT?   `staleness` — our own ledger against the
 *                                     file. Catches the case where this session
 *                                     has evidence and the evidence is old.
 *   DID SOMEBODY ELSE WRITE IT?       `foreignWrite` — the cross-session note.
 *                                     Catches the case where this session has
 *                                     NO evidence at all, which is the one a
 *                                     per-session ledger cannot see.
 *   DID WE READ IT AT ALL?            `noInspection` — the entry that never
 *                                     existed. Catches the case with no fact to
 *                                     check: the file is on disk, we hold
 *                                     nothing about it, and `write_file` would
 *                                     replace bytes nobody here has seen.
 *
 * None is a lock. All are questions about bytes, answered from records that
 * already existed; the mutation either proceeds or refuses with a reason.
 *
 * `anchored` waives the third question for a caller whose mutation IS its own
 * inspection — `delete_range` with `expect` quotes the exact bytes it removes,
 * the same guarantee `apply_patch` has by construction. See evidence.js
 * `noInspection` for every exemption stated.
 */
function refuseIfUnsafe(ctx, abs, what, { anchored = false } = {}) {
  const NL = String.fromCharCode(10);
  const { staleness, ledgerOf, foreignWrite, noInspection, sessionIdOf } = require('../evidence');
  const rel = at(ctx.cwd, abs);
  const ledger = ledgerOf(ctx);

  const conflict = staleness(ledger, ctx.cwd, abs);
  if (conflict.stale) {
    return {
      isError: true,
      output: [
        `${what} REFUSED - ${rel}`,
        'REASON: this file changed after you read it, so the lines you are naming are',
        'not the lines you saw.',
        `It was ${conflict.was.size} bytes when you read it; it is ${conflict.now.size} now.`,
        'Re-read the range and name it again. NOTHING WAS CHANGED.',
      ].join(NL),
    };
  }

  const other = foreignWrite(ledger, ctx.cwd, abs, sessionIdOf(ctx));
  if (other) {
    return {
      isError: true,
      output: [
        `${what} REFUSED - ${rel}`,
        'REASON: another job in this session wrote this file, and you have not read it.',
        'Acting on it now would destroy work you have never seen.',
        'Read it first, then say what to change. NOTHING WAS CHANGED.',
      ].join(NL),
    };
  }

  const blind = anchored ? null : noInspection(ledger, ctx.cwd, abs, sessionIdOf(ctx));
  if (blind) {
    return {
      isError: true,
      output: [
        `${what} REFUSED - ${rel}`,
        'REASON: NO_INSPECTION_PROVENANCE - this file exists, and this session has',
        'never read it, so there are no inspected bytes to act on. Mutating it now',
        'would discard work nobody here has seen.',
        'Read the file first, then make the change. NOTHING WAS CHANGED.',
      ].join(NL),
    };
  }
  return null;
}

const tools = {
  /**
   * THE IMPORTANT ONE.
   *
   * Replace an exact block of lines, having first proved those lines are what
   * the model thinks they are. `expect` is the current content; `replace` is
   * what it becomes. Deleting is `replace: ""`.
   */
  apply_patch: {
    mutates: true,
    schema: {
      name: 'apply_patch',
      description:
        'Replace an exact block of text in a file, verified first. Give the CURRENT text in `expect` '
        + 'and the new text in `replace`. The patch is REJECTED if `expect` is not found exactly, or '
        + 'is found more than once — so you can edit without re-reading the whole file, and a stale '
        + 'assumption fails loudly instead of corrupting the file. This is the cheapest way to change '
        + 'a few lines: never read a large file just to write it back.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          expect: { type: 'string', description: 'the exact text that is there now' },
          replace: { type: 'string', description: 'what it becomes; empty string deletes it' },
        },
        required: ['path', 'expect', 'replace'],
      },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'apply_patch needs a path', isError: true };
      if (typeof input.expect !== 'string' || !input.expect.length) {
        return { output: 'apply_patch needs `expect` — the exact text that is there now', isError: true };
      }
      if (typeof input.replace !== 'string') {
        return { output: 'apply_patch needs `replace` (use "" to delete)', isError: true };
      }
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { return { output: `no such file: ${input.path}`, isError: true }; }

      // Compared with line endings normalised, so a CRLF file does not reject a
      // patch that is correct in every way except invisible bytes.
      const norm = (s) => s.replace(/\r\n/g, '\n');
      const hay = norm(text);
      const needle = norm(input.expect);
      const first = hay.indexOf(needle);

      if (first < 0) {
        // WHY IT WAS REFUSED, with what is actually there. A rejection the model
        // cannot act on just becomes a whole-file rewrite on the next turn - and a
        // whole-file rewrite is the one operation that can lose an edit LAIN never
        // saw. `whyNotFound` names the cause when the cause is knowable; the
        // closest-line report is what 'it is genuinely not there' looks like.
        const NL = String.fromCharCode(10);
        const lines = hay.split(NL);
        const near = closestLine(lines, needle.split(NL)[0]);
        const why = whyNotFound(hay, needle, ctx, abs);
        return {
          isError: true,
          output: `PATCH REJECTED - ${at(ctx.cwd, abs)}` + NL
            + (why || ('REASON: the expected text is not in the file.' + NL
              + (near >= 0
                ? `The closest line is ${near + 1}:` + NL + around(lines, near)
                : 'Nothing resembling the first line was found. Read the range you mean to change.'))),
        };
      }
      if (hay.indexOf(needle, first + 1) >= 0) {
        const n = hay.split(needle).length - 1;
        return {
          isError: true,
          output: `PATCH REJECTED — ${at(ctx.cwd, abs)}\nREASON: the expected text appears ${n} times, so `
            + 'which one to change is ambiguous. Include more surrounding lines in `expect`.',
        };
      }

      const before = hay.slice(0, first).split('\n').length;
      const removed = needle.split('\n').length;
      const added = input.replace ? norm(input.replace).split('\n').length : 0;
      const out = hay.slice(0, first) + norm(input.replace) + hay.slice(first + needle.length);
      const crlf = /\r\n/.test(text);
      fs.writeFileSync(abs, crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
      return {
        output: `patched ${at(ctx.cwd, abs, before)} — ${removed} line(s) replaced by ${added}`,
        mutated: [abs],
      };
    },
  },

  /**
   * ADD TO THE END. "Append this" should cost the size of the addition, not the
   * size of the file.
   */
  append_file: {
    mutates: true,
    schema: {
      name: 'append_file',
      description:
        'Add text to the END of a file (creating it if absent). Use this instead of reading a file '
        + 'and writing it back with something added — it costs the size of the addition, not the size '
        + 'of the file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, text: { type: 'string' } },
        required: ['path', 'text'],
      },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'append_file needs a path', isError: true };
      if (typeof input.text !== 'string') return { output: 'append_file needs `text`', isError: true };
      let existed = true;
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { existed = false; }
      const crlf = /\r\n/.test(text);
      const nl = crlf ? '\r\n' : '\n';
      // A file that does not end in a newline would otherwise have the addition
      // welded onto its last line.
      const sep = !text || text.endsWith('\n') ? '' : nl;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, sep + input.text + (input.text.endsWith('\n') ? '' : nl), 'utf8');
      const added = input.text.split('\n').length;
      return {
        output: `appended ${added} line(s) to ${at(ctx.cwd, abs)}${existed ? '' : ' (created)'}`,
        mutated: [abs],
      };
    },
  },

  /**
   * PUT SOMETHING NEXT TO SOMETHING ELSE — an import beside the imports, a route
   * beside the routes — without reproducing the file to say where.
   */
  insert_at: {
    mutates: true,
    schema: {
      name: 'insert_at',
      description:
        'Insert text immediately BEFORE or AFTER the line matching `anchor` (a plain substring). '
        + 'Use this to add an import, a route, a case or a config entry without rewriting the file. '
        + 'Rejected if the anchor is missing or appears more than once.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          anchor: { type: 'string', description: 'a substring identifying ONE line' },
          text: { type: 'string' },
          where: { type: 'string', enum: ['before', 'after'], description: 'default after' },
        },
        required: ['path', 'anchor', 'text'],
      },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'insert_at needs a path', isError: true };
      if (!input.anchor) return { output: 'insert_at needs an `anchor`', isError: true };
      if (typeof input.text !== 'string') return { output: 'insert_at needs `text`', isError: true };
      let f;
      try { f = readLines(abs); } catch { return { output: `no such file: ${input.path}`, isError: true }; }
      const hits = [];
      f.lines.forEach((l, i) => { if (l.includes(input.anchor)) hits.push(i); });
      if (!hits.length) {
        return { output: `INSERT REJECTED — ${at(ctx.cwd, abs)}\nREASON: no line contains ${JSON.stringify(input.anchor)}.`, isError: true };
      }
      if (hits.length > 1) {
        const where = hits.slice(0, MAX_CONTEXT_LINES).map((i) => `  ${i + 1}: ${f.lines[i].trim()}`).join('\n');
        return {
          isError: true,
          output: `INSERT REJECTED — ${at(ctx.cwd, abs)}\nREASON: ${hits.length} lines contain that anchor:\n${where}\n`
            + 'Use a longer anchor that matches exactly one line.',
        };
      }
      const idx = hits[0];
      const put = String(input.where || 'after').toLowerCase() === 'before' ? idx : idx + 1;
      const added = input.text.split('\n');
      f.lines.splice(put, 0, ...added);
      writeLines(abs, f.lines, f.crlf);
      return {
        output: `inserted ${added.length} line(s) ${input.where === 'before' ? 'before' : 'after'} ${at(ctx.cwd, abs, idx + 1)}`,
        mutated: [abs],
      };
    },
  },

  /** Remove a run of lines by number, having said which they are. */
  delete_range: {
    mutates: true,
    schema: {
      name: 'delete_range',
      description:
        'Delete lines `from`..`to` (1-based, inclusive). Read the range first so you know what goes; '
        + 'the deleted text is returned so the removal is on the record.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          from: { type: 'number' },
          to: { type: 'number' },
          expect: {
            type: 'string',
            description: 'the exact text currently on those lines. Strongly recommended: line '
              + 'numbers go stale the moment anything else edits the file, and this is the only '
              + 'check that catches it. The delete is REFUSED if it does not match.',
          },
        },
        required: ['path', 'from', 'to'],
      },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'delete_range needs a path', isError: true };
      let f;
      try { f = readLines(abs); } catch { return { output: `no such file: ${input.path}`, isError: true }; }
      const from = Number(input.from);
      const to = Number(input.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) {
        return { output: 'delete_range needs 1-based `from` and `to`, with to >= from', isError: true };
      }
      if (from > f.lines.length) {
        return { output: `delete_range: ${at(ctx.cwd, abs)} has ${f.lines.length} lines; ${from} is past the end`, isError: true };
      }
      // ---- THE LINES MUST STILL BE THE LINES YOU SAW ---------------------
      // `expect` IS an inspection of the range: quoting the exact bytes about to
      // be removed carries the same guarantee apply_patch's match carries, so
      // its presence anchors the call and waives the never-read-it question.
      const unsafe = refuseIfUnsafe(ctx, abs, 'DELETE',
        { anchored: Boolean(typeof input.expect === 'string' && input.expect.length) });
      if (unsafe) return unsafe;
      // AND, WHEN OFFERED, THE TEXT ITSELF. A targeted read (offset/limit) is
      // deliberately not recorded as whole-file evidence, so an agent can hold
      // line numbers with nothing in the ledger to go stale. `expect` is the
      // only check that covers that, which is why the schema asks for it.
      if (typeof input.expect === 'string' && input.expect.length) {
        // Compared with line endings normalised and trailing blanks ignored,
        // for the same reason apply_patch does: a CRLF file must not reject a
        // correct expectation over bytes nobody can see.
        const NLC = String.fromCharCode(10);
        const norm = (x) => String(x).split(String.fromCharCode(13) + NLC).join(NLC)
          .split(NLC).map((l) => l.replace(/[ 	]+$/, '')).join(NLC).trim();
        const have = norm(f.lines.slice(from - 1, to).join(String.fromCharCode(10)));
        if (norm(input.expect) !== have) {
          return {
            isError: true,
            output: [
              `DELETE REFUSED - ${at(ctx.cwd, abs)}`,
              'REASON: lines ' + from + '..' + to + ' are not what you said they were.',
              'THERE NOW:',
              have.split(String.fromCharCode(10)).slice(0, 8).map((l) => '  ' + l).join(String.fromCharCode(10)),
              'NOTHING WAS DELETED. Re-read the range.',
            ].join(String.fromCharCode(10)),
          };
        }
      }
      const cut = f.lines.splice(from - 1, to - from + 1);
      writeLines(abs, f.lines, f.crlf);
      const shown = cut.slice(0, MAX_CONTEXT_LINES).join('\n');
      return {
        output: `deleted ${cut.length} line(s) from ${at(ctx.cwd, abs, from)}:\n${shown}`
          + (cut.length > MAX_CONTEXT_LINES ? `\n[${cut.length - MAX_CONTEXT_LINES} more deleted lines not shown]` : ''),
        mutated: [abs],
      };
    },
  },

  /** Move or rename, creating the destination directory. */
  move_file: {
    mutates: true,
    schema: {
      name: 'move_file',
      description: 'Move or rename a file. Creates the destination directory. Refuses to overwrite.',
      parameters: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
      },
    },
    async run(input, ctx) {
      const a = resolve(ctx.cwd, input.from);
      const b = resolve(ctx.cwd, input.to);
      if (!a || !b) return { output: 'move_file needs `from` and `to`', isError: true };
      if (!fs.existsSync(a)) return { output: `no such file: ${input.from}`, isError: true };
      if (fs.existsSync(b)) return { output: `move_file refused: ${input.to} already exists`, isError: true };
      // MOVING A FILE SOMEBODY ELSE JUST CHANGED takes their work somewhere the
      // reader will not look for it. Same two questions as a delete.
      const unsafeMove = refuseIfUnsafe(ctx, a, 'MOVE');
      if (unsafeMove) return unsafeMove;
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.renameSync(a, b);
      return { output: `moved ${at(ctx.cwd, a)} -> ${at(ctx.cwd, b)}`, mutated: [a, b] };
    },
  },

  /** Delete a file. Directories are refused — that is a different, larger act. */
  delete_file: {
    mutates: true,
    schema: {
      name: 'delete_file',
      description: 'Delete a single file. Directories are refused. The file is captured first, so /undo can restore it.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'delete_file needs a path', isError: true };
      let st;
      try { st = fs.statSync(abs); } catch { return { output: `no such file: ${input.path}`, isError: true }; }
      if (st.isDirectory()) return { output: `${input.path} is a directory — delete_file only removes one file`, isError: true };
      // DELETING A FILE SOMEBODY ELSE JUST WROTE is the most complete way to
      // lose work nobody saw. A checkpoint can put it back; nothing puts back
      // the knowledge that it mattered.
      const unsafeDelete = refuseIfUnsafe(ctx, abs, 'DELETE');
      if (unsafeDelete) return unsafeDelete;
      fs.unlinkSync(abs);
      return { output: `deleted ${at(ctx.cwd, abs)} (${st.size} bytes)`, mutated: [abs] };
    },
  },

  /**
   * HOW BIG IS IT, before deciding how to read it.
   *
   * The cheapest call in the set, and the one that stops the expensive mistake:
   * a model that knows a file is 4,000 lines reaches for a range instead of the
   * whole thing.
   */
  file_info: {
    mutates: false,
    schema: {
      name: 'file_info',
      description:
        'Size, line count and last-modified for a file, without reading it. Call this before reading '
        + 'anything you suspect is large, then read only the range you need.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    async run(input, ctx) {
      const abs = resolve(ctx.cwd, input.path);
      if (!abs) return { output: 'file_info needs a path', isError: true };
      let st;
      try { st = fs.statSync(abs); } catch { return { output: `no such file: ${input.path}`, isError: true }; }
      if (st.isDirectory()) return { output: `${at(ctx.cwd, abs)} is a directory`, meta: { directory: true } };
      let lines = null;
      try { lines = fs.readFileSync(abs, 'utf8').split('\n').length; } catch { lines = null; }
      const big = lines && lines > 400;
      return {
        output: `${at(ctx.cwd, abs)}  ${st.size} bytes` + (lines ? `  ${lines} lines` : '')
          + `  modified ${new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 16)}`
          + (big ? '\nThis is large — read a range (read_file offset/limit) and edit with apply_patch.' : ''),
        meta: { size: st.size, lines },
      };
    },
  },
};

module.exports = { tools, MAX_CONTEXT_LINES };
