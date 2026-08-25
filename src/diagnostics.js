'use strict';

/**
 * DID THAT EDIT LEAVE THE FILE PARSEABLE?
 *
 * The feedback an editor gives before you run anything: the file was written,
 * and it is or is not still syntactically a file. Nothing here understands the
 * program — it answers one question, exactly, and says nothing when it cannot.
 *
 * WHY THIS SITS BETWEEN THE EDIT AND THE TEST SUITE. A broken edit used to be
 * discovered by whatever ran next, which on a large tree is a full suite: the
 * model writes a file with an unbalanced brace, runs 1,100 tests, waits, reads
 * a stack trace from a loader, and works backwards to the file it just touched.
 * The parse error was available in under a millisecond at the moment of the
 * write. This is the cheap rung of the ladder, and it exists so the expensive
 * ones are reached less often.
 *
 * SILENCE IS THE DEFAULT, and it is a design rule rather than a limitation. A
 * checker that reports a problem in a correct file is worse than no checker:
 * the model spends a turn "fixing" working code, and after two false alarms it
 * learns to ignore the channel entirely. So every check here is one that either
 * proves a defect or declines to answer — there is no heuristic, no style
 * opinion, and no severity below "this does not parse".
 *
 * WHAT IT CANNOT DO, stated plainly because the gap matters: this is a PARSER,
 * not a type system. `/\s+/` written as `/s+/` still compiles, still matches,
 * and matches the letter S — nothing here will ever see it. Those are caught by
 * `symbols`, `dependents` and the project's own tests, and pretending otherwise
 * would be the false confidence this file is built to avoid.
 *
 * ONE PART OF THAT GAP IS NOW CLOSED, and only one. `messages` mistyped as
 * `message`, a renamed function with one stale caller, `getUser` where
 * `getUsers` was meant — those are names that resolve to NOTHING, and a scanner
 * can see that without a type system. That check lives in typos.js and runs
 * from here on the same terms as the parse check: it reports only when it can
 * name what was probably meant, and it says nothing at all otherwise. It was
 * calibrated by running it over this entire repository, where a correct file
 * must produce silence — 63,000 references across 310 files, no report.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** Extensions this can say anything about at all. */
const JS = /\.(?:js|cjs|mjs|jsx)$/i;
const JSON_RE = /\.(?:json)$/i;
const PY = /\.py$/i;

/**
 * The parse errors that mean "this is module syntax", NOT "this is broken".
 *
 * `vm.Script` compiles a CommonJS script, so a perfectly valid ES module fails
 * against it with one of these. Reporting that as a defect would condemn every
 * `import` in the tree, which is precisely the false alarm that makes a
 * diagnostic worthless — so these are treated as "cannot answer" and handed to
 * `node --check`, which knows the difference.
 */
const MODULE_SYNTAX = /Cannot use import statement outside a module|Unexpected token 'export'|await is only valid in async|may appear only with 'sourceType: module'/i;

/**
 * Pull the line number out of a compile failure.
 *
 * `vm.Script` puts the offending line in the stack's first frame as
 * `filename:line`, and nowhere else — the SyntaxError itself carries only the
 * message. Absent or unparseable, the caller simply gets no line, which is
 * still a useful report.
 */
function lineOf(err, filename) {
  const stack = String((err && err.stack) || '');
  const esc = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}:(\\d+)`).exec(stack);
  return m ? Number(m[1]) : null;
}

/**
 * Compile JavaScript without running a byte of it.
 *
 * `new vm.Script` parses and compiles; it does NOT execute — execution needs
 * `runInContext`, which is never called here. So this is safe against a file
 * whose top level would delete something.
 */
function checkJs(source, filename) {
  try {
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename });
    return { ok: true };
  } catch (e) {
    if (!(e instanceof SyntaxError)) return { ok: true, inconclusive: true };
    if (MODULE_SYNTAX.test(String(e.message))) return { ok: true, inconclusive: true, module: true };
    return { ok: false, message: e.message, line: lineOf(e, filename) };
  }
}

/**
 * `node --check`, for the files `vm.Script` cannot judge.
 *
 * Spawned only when the cheap path came back inconclusive, which on a CommonJS
 * tree is never — so the common case pays nothing for this existing.
 */
function checkWithNode(abs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = require('child_process').spawn(process.execPath, ['--check', abs], { windowsHide: true });
    } catch { resolve({ ok: true, inconclusive: true }); return; }
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', () => resolve({ ok: true, inconclusive: true }));
    child.on('close', (code) => {
      if (code === 0) { resolve({ ok: true }); return; }
      // `\r?\n` — node prints `<path>:<line>` on its own line, and on Windows
      // that line ends CRLF. Matching only `\n` dropped every line number on
      // the platform this is being written on.
      const m = /:(\d+)\r?\n/.exec(err);
      const msg = /SyntaxError: (.+)/.exec(err);
      resolve({ ok: false, message: msg ? msg[1].trim() : 'syntax error', line: m ? Number(m[1]) : null });
    });
  });
}

/**
 * JSON, where a trailing comma is a real and very common defect.
 *
 * The parser reports a character offset rather than a line, so it is converted
 * — "position 1184" is not something a person or a model can act on directly.
 */
function checkJson(source) {
  try {
    JSON.parse(source);
    return { ok: true };
  } catch (e) {
    const msg = String(e.message);
    const at = /position (\d+)/.exec(msg);
    const line = at ? source.slice(0, Number(at[1])).split('\n').length : null;
    return { ok: false, message: msg.replace(/\s+in JSON at position \d+.*$/, ''), line };
  }
}

/**
 * Python, through the interpreter's own parser.
 *
 * `ast.parse` is the same front end that would reject the file at import time,
 * so its verdict is definitive rather than an approximation of one. It is
 * spawned with `-c` and reads the path itself, which keeps the source out of
 * the command line — a file with a quote in it would otherwise mangle the
 * invocation.
 *
 * No interpreter means no answer, not a failure: `findPython` already knows
 * every place one might be, and a machine without Python is not a machine with
 * a broken Python file.
 */
function checkPython(abs) {
  return new Promise((resolve) => {
    let py;
    try { py = require('./tools/exec').findPython(); } catch { py = { ok: false }; }
    if (!py || !py.ok) { resolve({ ok: true, inconclusive: true }); return; }
    const code = 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read(),sys.argv[1])';
    let child;
    try {
      child = require('child_process').spawn(py.exe, ['-c', code, abs], { windowsHide: true });
    } catch { resolve({ ok: true, inconclusive: true }); return; }
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', () => resolve({ ok: true, inconclusive: true }));
    child.on('close', (exit) => {
      if (exit === 0) { resolve({ ok: true }); return; }
      const line = /line (\d+)/.exec(err);
      const msg = /(SyntaxError|IndentationError|TabError): (.+)/.exec(err);
      resolve({
        ok: false,
        message: msg ? `${msg[1]}: ${msg[2].trim()}` : 'does not parse',
        line: line ? Number(line[1]) : null,
      });
    });
  });
}

/**
 * Check one file on disk.
 *
 * @returns {Promise<{ok, message?, line?, inconclusive?}>} `ok` with no message
 *   means "parses, or nothing here can judge it" — the two are deliberately the
 *   same answer to the caller, because neither is something to report.
 */
async function checkFile(abs) {
  const name = path.basename(abs);
  let source;
  if (PY.test(name)) return checkPython(abs);
  try { source = fs.readFileSync(abs, 'utf8'); } catch { return { ok: true, inconclusive: true }; }
  if (JSON_RE.test(name)) return checkJson(source);
  if (!JS.test(name)) return { ok: true, inconclusive: true };
  const quick = checkJs(source, abs);
  if (!quick.inconclusive) return quick;
  if (quick.module) return checkWithNode(abs);
  return quick;
}

/**
 * Check everything one tool call wrote, and phrase it for the model.
 *
 * Returned as a STRING to append to the tool's own output rather than as an
 * error, because the write did happen: the file is on disk and reporting it as
 * a failed call would be untrue. What changed is that the model now learns
 * about the breakage from the edit itself instead of from whatever runs next.
 *
 * @param {string[]} paths  absolute paths, as `mutated` reports them
 * @returns {Promise<string>} '' when there is nothing worth saying
 */
async function reportFor(paths, cwd) {
  if (!Array.isArray(paths) || !paths.length) return '';
  const bad = [];
  const unresolved = [];
  for (const abs of paths) {
    let r;
    try { r = await checkFile(abs); } catch { r = { ok: true }; }
    const where = cwd ? path.relative(cwd, abs) || abs : abs;
    if (r && r.ok === false) {
      bad.push(`${where}${r.line ? `:${r.line}` : ''} — ${r.message}`);
      continue;
    }
    // ---- THE SECOND RUNG, and only reached when the file PARSES ------------
    //
    // A file that does not compile has one problem and it has already been
    // named; running a name check over a broken parse would add noise to an
    // answer that is complete. On a file that does parse, this is the cheapest
    // remaining thing that can prove a defect.
    try {
      const model = require('./codemodel').scanFile(abs);
      if (model.supported) {
        for (const f of require('./typos').unresolved(model)) unresolved.push({ ...f, where });
      }
    } catch { /* a checker that fails must never fail the edit it was checking */ }
  }
  let out = '';
  if (bad.length) out += `\n\nSYNTAX ERROR — the file was written but does not parse:\n${bad.join('\n')}`;
  if (unresolved.length) {
    const rows = unresolved.map((f) => `  ${f.where}:${f.line}  ${f.name}${f.calls ? '()' : ''} `
      + `is not defined here — ${f.suggestion} is (${f.why})`);
    out += `\n\nUNRESOLVED NAME${unresolved.length > 1 ? 'S' : ''} — the file parses, but `
      + `${unresolved.length > 1 ? 'these names resolve' : 'this name resolves'} to nothing:\n${rows.join('\n')}`;
  }
  return out;
}

module.exports = { checkFile, reportFor, checkJs, checkJson, checkPython, checkWithNode };
