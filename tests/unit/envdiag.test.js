'use strict';

/**
 * ENVIRONMENT FACTS AND POST-EDIT DIAGNOSTICS.
 *
 * Two capabilities that were absent, and whose absence cost the same thing in
 * both cases: a round trip the machine could have answered for free.
 *
 * The prompt used to tell the model `Platform: win32` and nothing else — not
 * the shell, not which package manager this tree uses, not whether a venv was
 * sitting unactivated. Every one of those was rediscovered by running a command
 * and reading its failure.
 *
 * And a write that left a file unparseable was reported as a successful write.
 * The breakage surfaced from whatever ran next, which on a large tree is a full
 * suite — a stack trace from a loader, minutes later, for a parse error that
 * was available in under a millisecond at the moment of the edit.
 *
 * These drive the real modules against real files on disk. The one thing they
 * must prove above all is that a CORRECT file is silent: a checker that cries
 * wolf is one the model learns to ignore, and then it has cost more than it
 * saved.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const environment = require('../../src/environment');
const diagnostics = require('../../src/diagnostics');
const mode = require('../../src/mode');
const prompt = require('../../src/prompt');
const tools = require('../../src/tools');

function tmp(prefix = 'envdiag-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function write(dir, name, body) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

module.exports = async function () {
  // ------------------------------------------------------- environment ----

  await test('ENV: the OS is reported by its real name, not process.platform\'s', () => {
    // `win32` is what Node calls 64-bit Windows 11. It was the entire content
    // of the old `Platform:` line, and it reads as wrong to anyone who has not
    // memorised it.
    assert.strictEqual(environment.osName('win32'), 'Windows');
    assert.strictEqual(environment.osName('darwin'), 'macOS');
    assert.strictEqual(environment.osName('linux'), 'Linux');
    // An OS nobody anticipated is passed through rather than guessed at.
    assert.strictEqual(environment.osName('freebsd'), 'freebsd');
  });

  await test('ENV: the shell is resolved, and a real one is always named', () => {
    const sh = environment.detectShell();
    assert.ok(sh.preferred, 'some shell must be named — the model has to run commands somehow');
    assert.ok(sh.available.includes(sh.preferred), 'the preferred shell must be one of the available ones');
    if (process.platform === 'win32') {
      assert.strictEqual(sh.preferred, 'powershell', 'PowerShell is the shell that is actually present on Windows');
      assert.ok(sh.available.includes('cmd'));
    }
  });

  await test('ENV: the package manager comes from the LOCKFILE, not from package.json', () => {
    // A package.json says nothing about npm vs pnpm vs yarn. The lockfile is
    // the artifact one of them wrote, so it settles it exactly — and running
    // the wrong one writes a second competing lockfile into the user's repo.
    const dir = tmp();
    write(dir, 'package.json', '{"name":"x"}');
    assert.strictEqual(environment.detectPackageManager(dir), null,
      'a manifest alone must not be treated as evidence of any particular manager');

    write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 6.0\n');
    const pm = environment.detectPackageManager(dir);
    assert.strictEqual(pm.manager, 'pnpm');
    assert.strictEqual(pm.from, 'pnpm-lock.yaml');
  });

  await test('ENV: a lockfile whose tool is NOT installed is reported as missing, not hidden', () => {
    // Naming a manager that cannot run just moves the failed call one step
    // later; saying it is absent is the fact that actually helps.
    const dir = tmp();
    write(dir, 'bun.lockb', '');
    const pm = environment.detectPackageManager(dir);
    assert.strictEqual(pm.manager, 'bun');
    // Whether bun happens to be installed on the machine running the tests is
    // not the assertion — that the ANSWER IS DEFINITE either way is.
    assert.ok(pm.missing === true || pm.missing === undefined);
    if (pm.missing) {
      assert.match(environment.summary(dir), /NOT installed/, 'the summary must say so plainly');
    }
  });

  await test('ENV: an UNACTIVATED venv is reported — the ModuleNotFoundError case', () => {
    // The confusing failure this prevents: a bare `python` cannot see packages
    // installed into .venv, so a dependency that is plainly present reports as
    // missing.
    const dir = tmp();
    const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
    const exe = process.platform === 'win32' ? 'python.exe' : 'python';
    write(dir, path.join('.venv', bin, exe), '');
    const saved = process.env.VIRTUAL_ENV;
    delete process.env.VIRTUAL_ENV;
    try {
      const v = environment.detectVenv(dir);
      assert.ok(v, 'an interpreter sitting in .venv must be found');
      assert.strictEqual(v.active, false);
      assert.match(environment.summary(dir), /NOT active/, 'and the summary must say it is not active');
    } finally {
      if (saved !== undefined) process.env.VIRTUAL_ENV = saved;
    }
  });

  await test('ENV: an ACTIVE venv is reported as active, and is not a warning', () => {
    const dir = tmp();
    const saved = process.env.VIRTUAL_ENV;
    process.env.VIRTUAL_ENV = path.join(dir, '.venv');
    try {
      const v = environment.detectVenv(dir);
      assert.strictEqual(v.active, true);
      assert.ok(!/NOT active/.test(environment.summary(dir)));
    } finally {
      if (saved === undefined) delete process.env.VIRTUAL_ENV;
      else process.env.VIRTUAL_ENV = saved;
    }
  });

  await test('ENV: the test runner is read from the manifest, never guessed', () => {
    // pytest being installed does not make it THIS project's runner, and
    // `npm test` means nothing without a test script to back it.
    const dir = tmp();
    write(dir, 'package.json', '{"name":"x"}');
    assert.strictEqual(environment.detectTestRunner(dir), null,
      'a package.json with no test script must not produce "npm test"');
    write(dir, 'package.json', '{"name":"x","scripts":{"test":"node t.js"}}');
    assert.strictEqual(environment.detectTestRunner(dir).command, 'npm test');
  });

  await test('ENV: the summary states nothing it has not established', () => {
    // An empty directory on a real machine: OS and shell are always knowable,
    // and a fact that is not true is ABSENT rather than hedged — "no package
    // manager detected" is a line that spends tokens to say nothing.
    const dir = tmp();
    const s = environment.summary(dir);
    assert.match(s, /^OS: /m);
    assert.match(s, /^Shell: /m);
    assert.ok(!/Package manager:/.test(s), 'an empty directory has no package manager to report');
    assert.ok(!/Python venv:/.test(s));
    assert.ok(!/Tests:/.test(s));
  });

  await test('ENV: detection spawns no processes and stays cheap enough for every prompt', () => {
    // This rides on the stable prefix of every request of every turn. Asking a
    // dozen interpreters for version numbers would cost more at each startup
    // than the guessing it saves.
    const dir = tmp();
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) environment.detect(dir);
    assert.ok(Date.now() - t0 < 1000, `20 detections took ${Date.now() - t0}ms — too slow for the prompt path`);
  });

  await test('ENV: the summary is STABLE across a turn that changes the project', () => {
    // THE CACHE DEPENDS ON THIS. The summary sits in the system block, which
    // carries the request's cache breakpoint, and Anthropic matches an exact
    // prefix — so a summary that can change between two steps of one turn
    // silently rebills the whole conversation as uncached input.
    //
    // A turn CAN change what this reads: the model runs `npm install`, a
    // package-lock.json appears, and a recomputed summary gains a line.
    const dir = tmp();
    write(dir, 'package.json', '{"name":"x"}');
    const before = environment.summary(dir);
    write(dir, 'package-lock.json', '{}');           // exactly what npm install does
    assert.strictEqual(environment.summary(dir), before,
      'the prompt prefix must not move underneath a running turn');
    // A NEW session must still see the world as it now is — this is a memo,
    // not a permanent blindness.
    environment.reset();
    assert.notStrictEqual(environment.summary(dir), before);
  });

  await test('ENV: the built prompt carries the environment, not "Platform: win32"', () => {
    const out = prompt.build({ cwd: process.cwd(), platform: process.platform, model: 'm' });
    assert.ok(!/Platform: win32|Platform: linux|Platform: darwin/.test(out),
      'the raw Node constant must not be what the model is told');
    assert.match(out, /OS: /);
    assert.match(out, /Shell: /);
  });

  await test('ENV: a prompt still builds if the directory cannot be read', () => {
    // Orientation is a convenience. A prompt that failed to build would take
    // the whole turn with it, and the model still has a shell.
    const gone = path.join(tmp(), 'does', 'not', 'exist');
    const out = prompt.build({ cwd: gone, platform: process.platform, model: 'm' });
    assert.ok(out.length > 0);
    assert.match(out, /OS: |Platform: /);
  });

  // ------------------------------------------------------- diagnostics ----

  await test('DIAG: a file that parses is SILENT — the property that makes this usable', async () => {
    // A checker that reports problems in correct files is worse than none: the
    // model spends a turn "fixing" working code and then learns to ignore the
    // channel. Every valid form here must produce nothing at all.
    const dir = tmp();
    const valid = [
      ['plain.js', 'function a(){ return 1; }\nmodule.exports = { a };\n'],
      ['async.js', 'async function go(){ await Promise.resolve(); }\ngo();\n'],
      // String.raw, so the line above is not itself `/\\s+/` in the source —
      // which is the exact shape the backslash-corruption guard in
      // architecture.test.js hunts for, and it was right to flag it here.
      ['regex.js', String.raw`const re = /\s+/g;` + '\nconst s = "a b".replace(re, "");\n'],
      ['classy.js', 'class A { #x = 1; get x(){ return this.#x; } }\n'],
      ['esm.mjs', 'import a from "b";\nexport default a;\n'],
      ['conf.json', '{"a":[1,2,{"b":true}]}'],
      ['py.py', 'def f(x):\n    return [i for i in range(x)]\n'],
    ];
    for (const [name, body] of valid) {
      const r = await diagnostics.checkFile(write(dir, name, body));
      assert.notStrictEqual(r.ok, false, `${name} is valid and must not be reported: ${r.message}`);
    }
  });

  await test('DIAG: an unbalanced brace is caught, with the line', async () => {
    const dir = tmp();
    const r = await diagnostics.checkFile(write(dir, 'b.js', 'function a(){\n  return 1;\n'));
    assert.strictEqual(r.ok, false);
    assert.ok(r.line > 0, 'a line number is what makes the report actionable');
  });

  await test('DIAG: a broken ES MODULE is caught too, not waved through as "module syntax"', async () => {
    // The dangerous shortcut: `vm.Script` rejects every valid `import`, so the
    // module case has to be handed to a parser that knows the difference —
    // and it must still catch a module that is genuinely broken.
    const dir = tmp();
    const r = await diagnostics.checkFile(write(dir, 'b.mjs', 'import x from "y";\nfunction q({\n'));
    assert.strictEqual(r.ok, false, 'module syntax must not become a blanket excuse');
    assert.ok(r.line > 0);
  });

  await test('DIAG: a trailing comma in JSON is caught, and reported by LINE not by offset', async () => {
    const dir = tmp();
    const r = await diagnostics.checkFile(write(dir, 'c.json', '{\n  "a": 1,\n  "b": 2,\n}\n'));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.line, 4, '"position 24" is not something anyone can act on');
    assert.ok(!/position \d+/.test(r.message), 'the raw character offset must not survive into the message');
  });

  await test('DIAG: a Python syntax error is caught through the interpreter\'s own parser', async () => {
    const dir = tmp();
    const r = await diagnostics.checkFile(write(dir, 'b.py', 'def f(:\n    return 1\n'));
    // No interpreter on this machine means no answer, which is honest rather
    // than a failure — a machine without Python is not one with a broken file.
    if (r.inconclusive) return;
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /SyntaxError|IndentationError|does not parse/);
  });

  await test('DIAG: a file type it cannot judge is declined, never guessed at', async () => {
    const dir = tmp();
    for (const name of ['notes.txt', 'data.csv', 'image.png']) {
      const r = await diagnostics.checkFile(write(dir, name, 'function a(){ unbalanced\n'));
      assert.notStrictEqual(r.ok, false, `${name} is not code this can parse and must not be reported`);
    }
  });

  await test('DIAG: a missing file is not a syntax error', async () => {
    const r = await diagnostics.checkFile(path.join(tmp(), 'never-written.js'));
    assert.notStrictEqual(r.ok, false);
  });

  await test('DIAG: checking a file does NOT execute it', async () => {
    // `new vm.Script` compiles; running needs `runInContext`, which is never
    // called. A file whose top level would delete something must be safe to
    // check.
    const dir = tmp();
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'still here', 'utf8');
    const src = `require('fs').unlinkSync(${JSON.stringify(victim)});\n`;
    await diagnostics.checkFile(write(dir, 'dangerous.js', src));
    assert.ok(fs.existsSync(victim), 'compiling a file must never run it');
  });

  // ------------------------------------- diagnostics through the tools ----

  await test('DIAG: a broken write is flagged THROUGH the real tool dispatcher', async () => {
    const cwd = tmp();
    const r = await tools.execute('write_file', { path: 'x.js', content: 'function a(){\n' }, { cwd });
    assert.match(r.output, /SYNTAX ERROR/, 'the model must learn about it from the edit itself');
    assert.match(r.output, /x\.js:2/, 'named by project-relative path and line');
  });

  await test('DIAG: the write still SUCCEEDED — a real edit is never reported as a failed call', async () => {
    // The file is on disk. Calling the write a failure would be a false report
    // the model would then try to undo.
    const cwd = tmp();
    const r = await tools.execute('write_file', { path: 'x.js', content: 'function a(){\n' }, { cwd });
    assert.notStrictEqual(r.isError, true, 'the edit happened; only the parse failed');
    assert.strictEqual(r.syntaxError, true, 'and it is marked so callers can tell the two apart');
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'x.js'), 'utf8'), 'function a(){\n');
  });

  await test('DIAG: a good write through the dispatcher says nothing extra', async () => {
    const cwd = tmp();
    const r = await tools.execute('write_file', { path: 'x.js', content: 'const a = 1;\n' }, { cwd });
    assert.ok(!/SYNTAX ERROR/.test(r.output));
    assert.notStrictEqual(r.syntaxError, true);
  });

  await test('DIAG: edit_file is covered too — one check serves every mutating tool', async () => {
    // The check hangs off `mutated`, which every writing tool reports, so a
    // tool added later is covered without its author knowing this exists.
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, 'y.js'), 'function ok(){ return 1; }\n', 'utf8');
    const r = await tools.execute('edit_file', { path: 'y.js', old: 'return 1; }', new: 'return 1;' }, { cwd });
    assert.match(r.output, /SYNTAX ERROR/);
  });

  await test('DIAG: a failed edit is not also blamed for a syntax error', async () => {
    // A rejected patch wrote nothing, so there is nothing to check and the
    // rejection must come back unchanged.
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, 'z.js'), 'const a = 1;\n', 'utf8');
    const r = await tools.execute('edit_file', { path: 'z.js', old: 'nowhere in the file', new: 'x' }, { cwd });
    assert.strictEqual(r.isError, true);
    assert.ok(!/SYNTAX ERROR/.test(r.output));
  });

  // -------------------------------------------------------------- mode ----

  await test('MODE: restructuring work is its own mode, not an implementation request', () => {
    // The risk inverts: the behaviour already exists and is correct, so the
    // question is "did it survive", which changes what to do first.
    for (const s of [
      'refactor the session module',
      'rename runTask to executeTask',
      'extract the parser into its own file',
      'clean up the duplication in turn.js',
      'split out the rendering code',
    ]) {
      assert.strictEqual(mode.classify(s, {}).mode, 'REFACTOR', s);
    }
  });

  await test('MODE: a DEFECT still outranks a restructuring verb', () => {
    // "refactor it, it crashes on save" is a bug report that happens to
    // contain the word refactor.
    assert.strictEqual(mode.classify('refactor it but it crashes on save', {}).mode, 'BUGFIX');
  });

  await test('MODE: building something new is still IMPLEMENT', () => {
    for (const s of ['add a dark mode toggle', 'implement session export']) {
      assert.strictEqual(mode.classify(s, {}).mode, 'IMPLEMENT', s);
    }
  });

  await test('MODE: REFACTOR guidance says to take a baseline and find the callers', () => {
    // Without these two the mode is a label. A rename that misses one caller
    // is the commonest way this goes wrong, and it is silent until run.
    const g = prompt.MODE_GUIDANCE.REFACTOR;
    assert.ok(g, 'a mode with no guidance changes nothing about the request');
    assert.match(g, /baseline/i);
    assert.match(g, /symbols|dependents|caller/i);
  });

  await test('MODE: REFACTOR is not read-only — it changes code', () => {
    assert.strictEqual(mode.classify('refactor the parser', {}).readOnly, false);
    assert.strictEqual(mode.classify('audit the parser', {}).readOnly, true);
  });
};
