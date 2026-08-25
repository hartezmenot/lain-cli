'use strict';

/**
 * SEMANTIC EDITS — change a definition by NAME, not by reproducing a file.
 *
 * apply_patch is safe because it verifies the exact text before splicing, and
 * that is the right primitive when you know what the text is. It is the wrong
 * one when the unit you mean is "this function": you have to quote the whole
 * body to replace it, quote its last line to append after it, and count lines
 * to delete it. So the model reads the file to find out what it already knows —
 * that `classify` is a function and it wants to change it.
 *
 * These operate on RANGES FROM A SCANNER (see jsscan.js and codemodel.js), so
 * "the function `classify`" means its exact bytes, including its `async`, its
 * decorators-in-spirit and its closing brace, and not one byte more.
 *
 * THE RULES THEY SHARE, and they are the same rules apply_patch has:
 *
 *   AMBIGUOUS IS REFUSED. Two things called `send` means the tool says so and
 *   names both, rather than picking one and being right most of the time.
 *
 *   A WRITE THAT BREAKS THE FILE IS ROLLED BACK. The file is re-parsed after
 *   every write; if it no longer parses, the original is restored and the call
 *   reports a rejection. A half-applied semantic edit is worse than none,
 *   because the model believes it landed.
 *
 *   WHAT IT CANNOT SEE, IT SAYS. Anything that is not JavaScript gets a plain
 *   "this scanner does not read that", never a guess. apply_patch still works
 *   on every file in every language, and remains the right tool there.
 */

const fs = require('fs');
const path = require('path');
const codemodel = require('../codemodel');
const diagnostics = require('../diagnostics');
const typos = require('../typos');
const renameMod = require('../rename');

/** Enough context to act on a rejection; never a whole file. */
const MAX_LISTED = 12;
const MAX_SYMBOL_CHARS = 20_000;

function resolve(cwd, p) {
  const s = String(p || '');
  if (!s) return null;
  return path.isAbsolute(s) ? s : path.resolve(cwd || process.cwd(), s);
}

function at(cwd, abs) {
  try {
    const r = path.relative(cwd || process.cwd(), abs);
    if (r && !r.startsWith('..')) return r.replace(/\\/g, '/');
  } catch { /* keep the absolute path */ }
  return abs;
}

/**
 * Load a file's model, or the reason there isn't one.
 *
 * Every tool here starts with this, so "no such file" and "not JavaScript" are
 * answered once, the same way, instead of five times slightly differently.
 */
function load(ctx, input) {
  const abs = resolve(ctx.cwd, input.path);
  if (!abs) return { error: 'a path is required' };
  let source;
  try { source = fs.readFileSync(abs, 'utf8'); } catch { return { error: `no such file: ${input.path}` }; }
  const model = codemodel.scan(source, abs);
  if (!model.supported) {
    return {
      error: `${at(ctx.cwd, abs)} — ${model.why}. The symbol tools read JavaScript (.js, .cjs, .mjs); `
        + 'use apply_patch for anything else, which works on every file in every language.',
    };
  }
  return { abs, source, model };
}

/**
 * THE OUTLINE IS NOT A JAVASCRIPT QUESTION, and treating it as one was a leak.
 *
 * The unresolved-name check genuinely is JS-only: it needs bindings, and
 * codemodel.js is the only thing here that produces them. But "what is this
 * file MADE OF" is answerable in every language structure.js knows — and that
 * engine was already in the tree, reachable only from the migration path.
 *
 * So a `.py` asking for an outline got the symbol tools' refusal and a route to
 * apply_patch, which edits and cannot answer the question. The model's only
 * remaining move was to read the file whole: the exact cost `list_symbols`
 * exists to avoid, reintroduced for every language but one.
 *
 * LEXICAL, and it says so. structure.js reads declaration lines, so it misses a
 * declaration written in a shape its patterns do not cover and never invents
 * one — under-reporting, which is the direction that stays honest.
 *
 * Returns null when there is nothing to say, so the caller's real error stands.
 */
function outlineAnywhere(ctx, input) {
  const abs = resolve(ctx.cwd, input.path);
  if (!abs) return null;
  const where = at(ctx.cwd, abs);
  let s;
  try { s = require('../structure').extractFile(abs, where); } catch { return null; }
  if (!s || !Array.isArray(s.units) || !s.units.length) return null;
  const rows = s.units.map((u) => `  ${String(u.line).padStart(5)}  ${String(u.kind).padEnd(9)} `
    + `${u.container ? `${u.container}.` : ''}${u.name}`);
  return {
    output: `${where}: OUTLINE ONLY — the unresolved-name check reads JavaScript, so nothing was checked here.\n`
      + `\nDEFINED (${s.units.length})\n${rows.slice(0, 200).join('\n')}`
      + (rows.length > 200 ? `\n  [${rows.length - 200} more]` : '')
      + '\nRead from declaration lines: an unusually written declaration can be missed, never invented.',
    meta: { unresolved: 0, symbols: s.units.length, lexical: true },
  };
}

/**
 * Find exactly one symbol, or explain why that could not be done.
 *
 * The refusal names every candidate with its line and its container, which is
 * what turns "ambiguous" into a call the model can immediately make correctly.
 */
function one(model, name, container, cwd, abs) {
  const hits = codemodel.find(model, name, { container: container || null });
  if (!hits.length) {
    const near = typos.nearMiss(name, new Set(model.symbols.map((s) => s.name)));
    const all = model.symbols.filter((s) => !s.container).map((s) => s.name);
    return {
      error: `no symbol named ${name}${container ? ` in ${container}` : ''} in ${at(cwd, abs)}.`
        + (near ? ` Did you mean ${near.name}? (${near.why})` : '')
        + (all.length ? `\nTop level here: ${all.slice(0, MAX_LISTED).join(', ')}`
          + (all.length > MAX_LISTED ? ` [+${all.length - MAX_LISTED}]` : '') : ''),
    };
  }
  if (hits.length > 1) {
    const rows = hits.map((s) => `  line ${s.startLine}: ${s.kind}${s.container ? ` in ${s.container}` : ' at top level'}`);
    return {
      error: `${name} is declared ${hits.length} times in ${at(cwd, abs)}, so which one to change is ambiguous:\n`
        + rows.join('\n') + '\nPass `container` to choose one.',
    };
  }
  return { symbol: hits[0] };
}

/**
 * TEXT THE MODEL WROTE, IN THE LINE ENDINGS THE FILE ALREADY USES.
 *
 * A model emits LF. Splicing that into a CRLF file leaves the new lines LF and
 * the rest CRLF, and the mixture then spreads with every subsequent edit — the
 * same defect apply_patch was built to avoid, arrived at from the other
 * direction. Normalised to LF first so a replacement that already carries CRLF
 * does not end up with doubled carriage returns.
 */
function matchEndings(text, fileText) {
  const lf = String(text).replace(/\r\n/g, '\n');
  return /\r\n/.test(fileText) ? lf.replace(/\n/g, '\r\n') : lf;
}

/**
 * Write, verify, and undo the write if it broke the file.
 *
 * The rollback is the whole contract. Without it a semantic edit that produces
 * an unbalanced brace reports success, and the breakage is discovered by
 * whatever expensive thing runs next.
 */
async function writeVerified(abs, next, before, cwd) {
  fs.writeFileSync(abs, next, 'utf8');
  let check;
  try { check = await diagnostics.checkFile(abs); } catch { check = { ok: true }; }
  if (check && check.ok === false) {
    fs.writeFileSync(abs, before, 'utf8');
    return {
      rejected: `REJECTED — ${at(cwd, abs)} would not parse after this edit, so the file was RESTORED unchanged.\n`
        + `REASON: ${check.message}${check.line ? ` (line ${check.line} of the attempted version)` : ''}`,
    };
  }
  return { ok: true };
}

/**
 * DID ANYTHING STILL WANT THE THING THAT WAS JUST REMOVED?
 *
 * The unresolved check deliberately stays silent unless it can name what was
 * probably meant, because a name it cannot resolve is usually something the
 * scanner cannot see rather than a mistake. That reasoning does not apply here
 * at all: the definition was removed A MOMENT AGO, by this call, so a remaining
 * reference to it is not a scanner limitation — it is a dangling reference, and
 * it is certain.
 *
 * `module.exports = { keep, target }` after removing `keep` is the exact shape,
 * and it is invisible until something imports the module and gets undefined.
 * Scoped to the one file, because a project-wide sweep on every removal would
 * cost more than it saves — find_residue is the tool for that question.
 */
function danglingNote(abs, name, cwd) {
  try {
    const model = codemodel.scanFile(abs);
    if (!model.supported) return '';
    const left = model.used.filter((u) => u.name === name);
    if (!left.length) return '';
    const where = at(cwd, abs);
    const rows = left.slice(0, 6).map((u) => `  ${where}:${u.line}`);
    return `\n\nSTILL REFERENCED — ${name} was removed, and ${left.length} reference(s) to it remain in this `
      + `file:\n${rows.join('\n')}${left.length > 6 ? `\n  [+${left.length - 6}]` : ''}`
      + '\nOther files are not checked here; find_residue sweeps the project.';
  } catch { return ''; }
}

/** What a successful edit says, plus anything the scanner noticed afterwards. */
function afterNote(abs, cwd) {
  try {
    const model = codemodel.scanFile(abs);
    const found = typos.unresolved(model);
    return typos.report(found, at(cwd, abs));
  } catch { return ''; }
}

const tools = {};

tools.read_symbol = {
  mutates: false,
  schema: {
    name: 'read_symbol',
    description:
      'Read ONE definition by name — a function, class, method, constant or object member — with its exact '
      + 'line range. Far cheaper than reading a file to find something in it, and it gives you the exact text '
      + 'to hand to replace_symbol. JavaScript only (.js, .cjs, .mjs).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        name: { type: 'string', description: 'the identifier being defined' },
        container: { type: 'string', description: 'the class or object it belongs to, when the name is not unique' },
      },
      required: ['path', 'name'],
    },
  },
  async run(input, ctx) {
    const f = load(ctx, input);
    if (f.error) return { output: f.error, isError: true };
    const found = one(f.model, String(input.name || ''), input.container, ctx.cwd, f.abs);
    if (found.error) return { output: found.error, isError: true };
    const s = found.symbol;
    const text = f.source.slice(s.start, s.end);
    const body = text.length > MAX_SYMBOL_CHARS
      ? `${text.slice(0, MAX_SYMBOL_CHARS)}\n[truncated — this definition is ${text.length} characters]`
      : text;
    return {
      output: `${at(ctx.cwd, f.abs)}:${s.startLine}-${s.endLine}  ${s.kind}`
        + `${s.container ? ` in ${s.container}` : ''}\n\n${body}`,
      meta: { startLine: s.startLine, endLine: s.endLine, kind: s.kind },
    };
  },
};

tools.replace_symbol = {
  mutates: true,
  schema: {
    name: 'replace_symbol',
    description:
      'Replace an entire definition by NAME with new text. The old definition\'s exact range is found by '
      + 'scanning, so you never quote the body you are replacing and never touch a byte outside it. The file '
      + 'is re-parsed afterwards and RESTORED unchanged if the edit broke it. Refused when the name is '
      + 'declared more than once — pass `container` to choose. JavaScript only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        name: { type: 'string' },
        replacement: { type: 'string', description: 'the complete new definition, including its declaration keyword' },
        container: { type: 'string' },
      },
      required: ['path', 'name', 'replacement'],
    },
  },
  async run(input, ctx) {
    if (typeof input.replacement !== 'string') {
      return { output: 'replace_symbol needs `replacement` (use remove_symbol to delete)', isError: true };
    }
    const f = load(ctx, input);
    if (f.error) return { output: f.error, isError: true };
    const found = one(f.model, String(input.name || ''), input.container, ctx.cwd, f.abs);
    if (found.error) return { output: found.error, isError: true };
    const s = found.symbol;
    const body = matchEndings(input.replacement, f.source);
    const next = f.source.slice(0, s.start) + body + f.source.slice(s.end);
    const w = await writeVerified(f.abs, next, f.source, ctx.cwd);
    if (w.rejected) return { output: w.rejected, isError: true };
    const wasLines = s.endLine - s.startLine + 1;
    const nowLines = input.replacement.split('\n').length;
    return {
      output: `replaced ${s.kind} ${s.name} at ${at(ctx.cwd, f.abs)}:${s.startLine} — `
        + `${wasLines} line(s) became ${nowLines}` + afterNote(f.abs, ctx.cwd),
      mutated: [f.abs],
    };
  },
};

tools.insert_near_symbol = {
  mutates: true,
  schema: {
    name: 'insert_near_symbol',
    description:
      'Insert new code immediately BEFORE or AFTER a named definition, without quoting it. Use this to add a '
      + 'function beside its siblings or a method beside the others in a class. The file is re-parsed and '
      + 'RESTORED unchanged if the insertion broke it. JavaScript only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        name: { type: 'string', description: 'the definition to insert next to' },
        text: { type: 'string' },
        where: { type: 'string', enum: ['before', 'after'], description: 'default after' },
        container: { type: 'string' },
      },
      required: ['path', 'name', 'text'],
    },
  },
  async run(input, ctx) {
    if (typeof input.text !== 'string' || !input.text.length) {
      return { output: 'insert_near_symbol needs `text`', isError: true };
    }
    const f = load(ctx, input);
    if (f.error) return { output: f.error, isError: true };
    const found = one(f.model, String(input.name || ''), input.container, ctx.cwd, f.abs);
    if (found.error) return { output: found.error, isError: true };
    const s = found.symbol;
    const before = String(input.where || 'after').toLowerCase() === 'before';
    // A blank line between two definitions, because that is how definitions are
    // separated everywhere and a tool that welds them together produces a diff
    // nobody wants to read.
    const body = matchEndings(String(input.text).replace(/^[\r\n]+|[\r\n]+$/g, ''), f.source);
    const gap = /\r\n/.test(f.source) ? '\r\n\r\n' : '\n\n';
    const next = before
      ? `${f.source.slice(0, s.start)}${body}${gap}${f.source.slice(s.start)}`
      : `${f.source.slice(0, s.end)}${gap}${body}${f.source.slice(s.end)}`;
    const w = await writeVerified(f.abs, next, f.source, ctx.cwd);
    if (w.rejected) return { output: w.rejected, isError: true };
    return {
      output: `inserted ${body.split('\n').length} line(s) ${before ? 'before' : 'after'} `
        + `${s.kind} ${s.name} at ${at(ctx.cwd, f.abs)}:${before ? s.startLine : s.endLine}`
        + afterNote(f.abs, ctx.cwd),
      mutated: [f.abs],
    };
  },
};

tools.remove_symbol = {
  mutates: true,
  schema: {
    name: 'remove_symbol',
    description:
      'Delete an entire definition by NAME. Its exact range is found by scanning, so nothing around it is '
      + 'disturbed. THE DELETED TEXT IS RETURNED, so the removal is on the record and can be put back. Use '
      + 'this when replacing an implementation: the old one has to actually go, and deleting it by name is '
      + 'how you can be sure which one went. JavaScript only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        name: { type: 'string' },
        container: { type: 'string' },
      },
      required: ['path', 'name'],
    },
  },
  async run(input, ctx) {
    const f = load(ctx, input);
    if (f.error) return { output: f.error, isError: true };
    const found = one(f.model, String(input.name || ''), input.container, ctx.cwd, f.abs);
    if (found.error) return { output: found.error, isError: true };
    const s = found.symbol;
    const gone = f.source.slice(s.start, s.end);
    // Take the blank lines the definition was sitting in with it, or every
    // removal leaves a widening gap behind.
    //
    // Character by character rather than by re-slicing the file at each step:
    // the slice-and-test version allocated a copy of the remaining file for
    // every blank line it walked past, which on a large file with a run of
    // them is quadratic for no reason.
    const src = f.source;
    let from = s.start;
    let to = s.end;
    while (from > 0 && (src[from - 1] === ' ' || src[from - 1] === '\t')) from -= 1;
    while (to < src.length && (src[to] === ' ' || src[to] === '\t')) to += 1;
    if (src[to] === '\r') to += 1;
    if (src[to] === '\n') to += 1;
    for (;;) {
      let j = to;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j += 1;
      if (j >= src.length || src[j] !== '\n') break;
      to = j + 1;
    }
    const next = src.slice(0, from) + src.slice(to);
    const w = await writeVerified(f.abs, next, f.source, ctx.cwd);
    if (w.rejected) return { output: w.rejected, isError: true };
    const head = gone.split('\n').slice(0, MAX_LISTED).join('\n');
    return {
      output: `removed ${s.kind} ${s.name} from ${at(ctx.cwd, f.abs)}:${s.startLine}-${s.endLine} `
        + `(${s.endLine - s.startLine + 1} lines):\n${head}`
        + (gone.split('\n').length > MAX_LISTED ? '\n[…]' : '')
        + danglingNote(f.abs, s.name, ctx.cwd)
        + afterNote(f.abs, ctx.cwd),
      mutated: [f.abs],
    };
  },
};

tools.rename_symbol = {
  mutates: true,
  schema: {
    name: 'rename_symbol',
    description:
      'Rename an identifier across the whole project, on TOKENS rather than by text — so the name inside a '
      + 'string, a comment, a regex or a URL is never rewritten by accident. Those occurrences are COUNTED '
      + 'AND REPORTED instead, because a string holding the old name is often a real reference. Member '
      + 'accesses (x.name) are reported and left alone unless include_members is set, since nothing here can '
      + 'tell one object\'s method from another\'s. Every changed file is re-parsed and rolled back on its own '
      + 'if it broke. Use dry_run first on anything large.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'the current identifier' },
        to: { type: 'string', description: 'the new identifier' },
        include: { type: 'string', description: 'glob limiting which files are touched, e.g. "src/**/*.js"' },
        include_members: { type: 'boolean', description: 'also rewrite x.from and { from: … } (default false)' },
        dry_run: { type: 'boolean', description: 'report what would change without writing anything' },
      },
      required: ['from', 'to'],
    },
  },
  async run(input, ctx) {
    const from = String(input.from || '').trim();
    const to = String(input.to || '').trim();
    if (!from || !to) return { output: 'rename_symbol needs `from` and `to`', isError: true };
    if (from === to) return { output: 'from and to are the same name', isError: true };
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(from) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(to)) {
      return { output: 'both names must be plain identifiers — use grep and apply_patch for free text', isError: true };
    }
    const root = ctx.cwd || process.cwd();
    const r = await renameMod.rename(root, from, to, {
      include: input.include ? String(input.include) : '',
      members: Boolean(input.include_members),
      dryRun: Boolean(input.dry_run),
    });
    const mutated = r.dryRun ? [] : r.changed.filter((c) => !c.rolledBack).map((c) => c.abs);
    return {
      output: renameMod.describe(r),
      isError: r.changed.some((c) => c.rolledBack),
      mutated,
      meta: { renamed: mutated.length, sites: r.sites, textOnly: r.textOnly.length },
    };
  },
};

tools.check_symbols = {
  mutates: false,
  schema: {
    name: 'check_symbols',
    description:
      'TWO USES, and the first is ORIENTATION. With list_symbols it returns the file\'s OUTLINE — every '
      + 'definition with its line and kind — which is how to see what an unfamiliar file CONTAINS without '
      + 'reading it whole: on a 700-line module that is around 18x cheaper than read_file, and it gives you '
      + 'the exact names to hand to read_symbol or replace_symbol. The outline comes back whenever you ask '
      + 'for it, independently of whether anything was found, and it works in EVERY language — Python, Go, Rust, '
      + 'C++, Ruby and the rest come back read from declaration lines, which can miss an unusually written '
      + 'declaration but never invents one. '
      + 'It ALSO finds names a file uses that nothing declares — the typo class a parser cannot catch, because '
      + '`getUser` where `getUsers` was meant is perfectly valid syntax; it reports one only when it can name '
      + 'what was probably meant, so silence means it found nothing rather than that it gave up. That second '
      + 'check is JavaScript only, and it says so when it did not run.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'the file to check' },
        list_symbols: { type: 'boolean', description: 'return the file\'s outline: every definition with its line and kind' },
      },
      required: ['path'],
    },
  },
  async run(input, ctx) {
    const f = load(ctx, input);
    if (f.error) {
      // A file this scanner cannot read still HAS a shape — see outlineAnywhere.
      if (input.list_symbols) {
        const alt = outlineAnywhere(ctx, input);
        if (alt) return alt;
      }
      return { output: f.error, isError: true };
    }
    const where = at(ctx.cwd, f.abs);
    const found = typos.unresolved(f.model);
    const parts = [];
    if (found.length) {
      parts.push(typos.report(found, where).trim());
    } else {
      parts.push(`${where}: every name it uses resolves to a declaration, an import or a global. `
        + `(${f.model.used.length} reference(s) checked against ${f.model.bindings.size} binding(s).)`);
    }
    if (input.list_symbols) {
      const rows = f.model.symbols.map((s) => `  ${String(s.startLine).padStart(5)}  ${s.kind.padEnd(9)} `
        + `${s.container ? `${s.container}.` : ''}${s.name}`);
      parts.push(`\nDEFINED (${f.model.symbols.length})\n${rows.slice(0, 200).join('\n')}`
        + (rows.length > 200 ? `\n  [${rows.length - 200} more]` : ''));
    }
    return { output: parts.join('\n'), meta: { unresolved: found.length, symbols: f.model.symbols.length } };
  },
};

tools.find_residue = {
  mutates: false,
  schema: {
    name: 'find_residue',
    description:
      'Prove a replacement actually REPLACED something. "Move X to Y", "migrate to the new API", "remove the '
      + 'legacy path" are two claims — the new thing exists, AND the old thing is gone — and a test suite only '
      + 'ever checks the first, because a leftover definition breaks nothing. Give the names and files that '
      + 'should have disappeared and, optionally, what should have replaced them. Occurrences are classified '
      + 'on tokens, so a name in a comment is reported separately from a live reference. Changes nothing.',
    parameters: {
      type: 'object',
      properties: {
        gone: { type: 'array', items: { type: 'string' }, description: 'identifiers that should no longer exist anywhere' },
        removed: { type: 'array', items: { type: 'string' }, description: 'file paths that should no longer exist' },
        present: { type: 'array', items: { type: 'string' }, description: 'identifiers the replacement should have introduced' },
        include: { type: 'string', description: 'glob limiting the sweep, e.g. "src/**/*.js"' },
      },
    },
  },
  async run(input, ctx) {
    const list = (v) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []);
    const gone = list(input.gone);
    const removed = list(input.removed);
    const present = list(input.present);
    if (!gone.length && !removed.length && !present.length) {
      return { output: 'find_residue needs at least one of `gone`, `removed` or `present`', isError: true };
    }
    const residue = require('../residue');
    const r = residue.check(ctx.cwd || process.cwd(), { gone, removed, present, include: input.include || '' });
    const stuck = r.gone.filter((x) => x.state === residue.STATE.DEFINED || x.state === residue.STATE.REFERENCED);
    return {
      output: residue.describe(r),
      meta: { incomplete: stuck.length, checked: gone.length + removed.length + present.length },
    };
  },
};

tools.review_changes = {
  mutates: false,
  schema: {
    name: 'review_changes',
    description:
      'The SHAPE of the working tree against the last commit: which files differ, how many lines each way, '
      + 'and which of that is worth a second look — a whole-file rewrite where a patch was meant, a build '
      + 'directory that got committed, a deleted file nobody mentioned, a change set far larger than the task. '
      + 'It reads the NUMBERS, not the diff content, so it costs almost nothing. By default it also compares '
      + 'against the files this session actually wrote, and names anything in the tree that is not one of them.',
    parameters: {
      type: 'object',
      properties: {
        all_files: {
          type: 'boolean',
          description: 'report every difference without comparing against what this session wrote (default false)',
        },
      },
    },
  },
  async run(input, ctx) {
    const gitsense = require('../gitsense');
    // WHAT LAIN BELIEVES IT CHANGED comes from the lifecycle ledger, which is
    // already tracking it for completion evidence. Asking the model to restate
    // the list would be asking it to remember something the harness knows.
    let expected = [];
    if (!input.all_files) {
      const life = ctx.session && ctx.session.lifecycle;
      const changed = life && life.evidence && life.evidence.filesChanged;
      if (changed) expected = [...changed];
    }
    const r = await gitsense.review(ctx.cwd || process.cwd(), { expected });
    return {
      output: gitsense.describe(r),
      isError: !r.ok,
      meta: r.ok ? { files: r.files.length, lines: r.totalLines } : undefined,
    };
  },
};

tools.engineering_brief = {
  mutates: false,
  schema: {
    name: 'engineering_brief',
    description:
      'ONE call that replaces the eight you would otherwise spend orienting: a full engineering briefing on this '
      + 'project. Health on FIVE SEPARATE AXES (build, tests, runtime, frontend, engineering — a passing build '
      + 'does not make the others pass), every finding with a stable id, exact file and line, the enclosing '
      + 'symbol, an explanation of what the message means, how confident it is (PROVEN/OBSERVED/INFERRED/'
      + 'SUSPECTED), what evidence source saw it, and related files to look at next. Findings that share a file '
      + 'or symbol are grouped into root-cause candidates so several symptoms are not fixed separately. What was '
      + 'NOT measured is listed as UNVERIFIED rather than omitted. Ids are stable across calls, so re-run it '
      + 'after repairs to see what is fixed, what is new, and what merely stopped being observed. Changes nothing.',
    parameters: {
      type: 'object',
      properties: {
        run_tests: { type: 'boolean', description: "run the project's own test command and grade TEST health (slow)" },
        dead_code: { type: 'boolean', description: 'include the unreferenced-export sweep (slow)' },
        gone: {
          type: 'array', items: { type: 'string' },
          description: 'identifiers a migration should have removed — checked and reported as residue',
        },
        removed: { type: 'array', items: { type: 'string' }, description: 'file paths that should no longer exist' },
        present: { type: 'array', items: { type: 'string' }, description: 'identifiers the replacement should have introduced' },
      },
    },
  },
  async run(input, ctx) {
    const list = (v) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []);
    const flags = [];
    if (input.run_tests) flags.push('--tests');
    if (input.dead_code) flags.push('--dead');
    const gone = list(input.gone);
    const removed = list(input.removed);
    const present = list(input.present);
    if (gone.length) flags.push(`--gone=${gone.join(',')}`);
    if (removed.length) flags.push(`--removed=${removed.join(',')}`);
    if (present.length) flags.push(`--present=${present.join(',')}`);

    // THE SAME BUILDER THE `/brief` COMMAND USES. Two paths to one briefing
    // would be two briefings the day one of them gained a section.
    const briefcommand = require('../briefcommand');
    let out;
    try {
      out = await briefcommand.build(
        { _browser: ctx.app && ctx.app._browser },
        { argv: flags.join(' '), session: ctx.session, root: ctx.cwd },
      );
    } catch (e) {
      return { output: `the survey failed: ${(e && e.message) || e}`, isError: true };
    }
    const h = out.survey.health;
    return {
      output: out.text,
      meta: {
        findings: out.delta.findings.length,
        build: h.build,
        engineering: h.engineering,
        fixed: out.delta.fixed.length,
        appeared: out.delta.appeared.length,
      },
    };
  },
};

module.exports = { tools, load, one, writeVerified, MAX_SYMBOL_CHARS };
