'use strict';

/**
 * SEMANTIC EDITING, RENAMING, RESIDUE, AND THE DIFF SENSOR.
 *
 * These run against real files in a real temporary directory, and the rename
 * and residue tests run against a real git repository, because every one of
 * these tools exists to make a claim about the filesystem and a stub would let
 * that claim go unchecked.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const semantic = require('../../src/tools/semantic');
const renameMod = require('../../src/rename');
const residue = require('../../src/residue');
const gitsense = require('../../src/gitsense');
const { execute } = require('../../src/tools/exec');

const T = semantic.tools;

/** A small project, written fresh for each test that needs one. */
function project(files) {
  const dir = tmpdir('lain-sem-');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

const SAMPLE = {
  'api.js': [
    "'use strict';",
    '',
    'const ENEMIES = {',
    '  slime: { hp: 10 },',
    '  wolf: { hp: 30 },',
    '};',
    '',
    'function getUsers(db) {',
    "  return db.all('users');",
    '}',
    '',
    'function spawn(kind) {',
    '  return { ...ENEMIES[kind], kind };',
    '}',
    '',
    'module.exports = { getUsers, spawn, ENEMIES };',
    '',
  ].join('\n'),
};

module.exports = async function () {
  // ------------------------------------------------------------ read_symbol --

  await test('READ_SYMBOL: one definition comes back with its exact range', async () => {
    const dir = project(SAMPLE);
    const r = await T.read_symbol.run({ path: 'api.js', name: 'spawn' }, { cwd: dir });
    assert.ok(!r.isError, r.output);
    assert.match(r.output, /api\.js:12-14/);
    assert.match(r.output, /function spawn\(kind\) \{/);
    assert.doesNotMatch(r.output, /getUsers/, 'and nothing outside the definition comes with it');
  });

  await test('READ_SYMBOL: an object member is addressable by its container', async () => {
    const dir = project(SAMPLE);
    const r = await T.read_symbol.run({ path: 'api.js', name: 'slime', container: 'ENEMIES' }, { cwd: dir });
    assert.match(r.output, /property in ENEMIES/);
    assert.match(r.output, /hp: 10/);
  });

  await test('READ_SYMBOL: a misspelled name is refused WITH what was probably meant', async () => {
    // A rejection the model cannot act on becomes a whole-file read next turn.
    const dir = project(SAMPLE);
    const r = await T.read_symbol.run({ path: 'api.js', name: 'getUser' }, { cwd: dir });
    assert.ok(r.isError);
    assert.match(r.output, /Did you mean getUsers/);
  });

  await test('READ_SYMBOL: a language it cannot read gets a declared NO and a route onward', async () => {
    const dir = project({ 'main.py': 'def go():\n    return 1\n' });
    const r = await T.read_symbol.run({ path: 'main.py', name: 'go' }, { cwd: dir });
    assert.ok(r.isError);
    assert.match(r.output, /apply_patch/, 'it must name the tool that DOES work here');
  });

  // --------------------------------------------------------- replace_symbol --

  await test('REPLACE_SYMBOL: it replaces exactly the definition and leaves the rest alone', async () => {
    const dir = project(SAMPLE);
    const r = await T.replace_symbol.run({
      path: 'api.js', name: 'spawn',
      replacement: 'function spawn(kind) {\n  return { ...ENEMIES[kind], kind, spawned: true };\n}',
    }, { cwd: dir });
    assert.ok(!r.isError, r.output);
    const after = fs.readFileSync(path.join(dir, 'api.js'), 'utf8');
    assert.ok(after.includes('spawned: true'));
    assert.ok(after.includes("return db.all('users');"), 'the neighbouring function is untouched');
    assert.ok(after.includes('module.exports = { getUsers, spawn, ENEMIES };'));
    assert.deepStrictEqual(r.mutated, [path.join(dir, 'api.js')], 'so /undo can capture it');
  });

  await test('REPLACE_SYMBOL: an edit that breaks the file is ROLLED BACK, not reported as done', async () => {
    // The whole contract. Without it, a broken write reports success and the
    // breakage is discovered by whatever expensive thing runs next.
    const dir = project(SAMPLE);
    const before = fs.readFileSync(path.join(dir, 'api.js'), 'utf8');
    const r = await T.replace_symbol.run({
      path: 'api.js', name: 'spawn', replacement: 'function spawn(kind) { return {',
    }, { cwd: dir });
    assert.ok(r.isError);
    assert.match(r.output, /RESTORED unchanged/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'api.js'), 'utf8'), before,
      'the file must be byte-for-byte what it was');
  });

  await test('REPLACE_SYMBOL: an ambiguous name is refused, and both candidates are named', async () => {
    const dir = project({ 'x.js': 'class A { send() { return 1; } }\nclass B { send() { return 2; } }\n' });
    const r = await T.replace_symbol.run({ path: 'x.js', name: 'send', replacement: 'send() { return 3; }' }, { cwd: dir });
    assert.ok(r.isError);
    assert.match(r.output, /declared 2 times/);
    assert.match(r.output, /in A/);
    assert.match(r.output, /in B/);
    const ok = await T.replace_symbol.run({
      path: 'x.js', name: 'send', container: 'B', replacement: 'send() { return 3; }',
    }, { cwd: dir });
    assert.ok(!ok.isError, ok.output);
    const after = fs.readFileSync(path.join(dir, 'x.js'), 'utf8');
    assert.ok(after.includes('return 1;') && after.includes('return 3;'), 'only B changed');
  });

  await test('REPLACE_SYMBOL: an edit that introduces an unresolved name says so with the result', async () => {
    const dir = project(SAMPLE);
    const r = await T.replace_symbol.run({
      path: 'api.js', name: 'spawn',
      replacement: 'function spawn(kind) {\n  return getUser(kind);\n}',
    }, { cwd: dir });
    assert.ok(!r.isError, 'the write did happen — this is not a failed call');
    assert.match(r.output, /UNRESOLVED NAME/);
    assert.match(r.output, /getUsers/);
  });

  // ------------------------------------------------ insert / remove symbol --

  await test('INSERT_NEAR_SYMBOL: new code lands beside the named one, separated properly', async () => {
    const dir = project(SAMPLE);
    const r = await T.insert_near_symbol.run({
      path: 'api.js', name: 'getUsers', where: 'after', text: 'function getAdmins(db) {\n  return db.all("admins");\n}',
    }, { cwd: dir });
    assert.ok(!r.isError, r.output);
    const after = fs.readFileSync(path.join(dir, 'api.js'), 'utf8');
    assert.ok(after.includes('function getAdmins'));
    assert.ok(after.indexOf('getAdmins') > after.indexOf('function getUsers'));
    assert.ok(after.indexOf('getAdmins') < after.indexOf('function spawn'));
    assert.ok(!/\}function/.test(after), 'definitions are not welded together');
  });

  await test('REMOVE_SYMBOL: the definition goes, the text is returned, the file still parses', async () => {
    const dir = project(SAMPLE);
    const r = await T.remove_symbol.run({ path: 'api.js', name: 'ENEMIES' }, { cwd: dir });
    assert.ok(!r.isError, r.output);
    assert.match(r.output, /const ENEMIES = \{/, 'what went is on the record');
    const after = fs.readFileSync(path.join(dir, 'api.js'), 'utf8');
    assert.ok(!after.includes('const ENEMIES'));
    assert.ok(after.includes('function getUsers'), 'and the neighbours survived');
    assert.ok(!/\n\n\n\n/.test(after), 'the hole it left was closed up');
  });

  await test('REMOVE_SYMBOL: a reference left dangling by the removal is reported, certainly', async () => {
    // The unresolved check stays quiet unless it can name what was meant,
    // because a name it cannot resolve is usually something it cannot see. That
    // reasoning does not apply one line after the definition was deleted BY
    // THIS CALL: the reference is dangling, and it is certain.
    const dir = project({ 'c.js': "'use strict';\nfunction keep() { return 1; }\nmodule.exports = { keep };\n" });
    const r = await T.remove_symbol.run({ path: 'c.js', name: 'keep' }, { cwd: dir });
    assert.ok(!r.isError, r.output);
    assert.match(r.output, /STILL REFERENCED/);
    // Line 2, not 3: the removal took a line out, and the reference is reported
    // where it is NOW rather than where it was before the edit.
    assert.match(r.output, /c\.js:2/);
  });

  await test('EDITS: a CRLF file stays a CRLF file, with no mixed endings introduced', async () => {
    // A model emits LF. Splicing that into a CRLF file leaves the new lines LF
    // and the rest CRLF, and the mixture spreads with every later edit.
    const crlf = ["'use strict';", '', 'function target(a) {', '  return a;', '}', ''].join('\r\n');
    const dir = project({ 'c.js': crlf });
    const r = await T.replace_symbol.run({
      path: 'c.js', name: 'target', replacement: 'function target(a) {\n  return a + 1;\n}',
    }, { cwd: dir });
    assert.ok(!r.isError, r.output);
    const after = fs.readFileSync(path.join(dir, 'c.js'), 'utf8');
    assert.ok(after.includes('return a + 1;'), 'the edit landed');
    assert.strictEqual((after.match(/(?<!\r)\n/g) || []).length, 0, 'no bare LF may be left behind');
  });

  // ------------------------------------------------------------- rename ----

  await test('RENAME: identifiers change; the same word in a string or comment does NOT', async () => {
    // The failure a regex rename produces every time, and the reason this
    // works on tokens.
    const dir = project({
      'a.js': [
        "const send = 1;",
        "// send the thing",
        "const url = 'https://x/send';",
        "const re = /send/;",
        'console.log(send);',
      ].join('\n'),
    });
    const r = await T.rename_symbol.run({ from: 'send', to: 'dispatch' }, { cwd: dir });
    assert.ok(!r.isError, r.output);
    const after = fs.readFileSync(path.join(dir, 'a.js'), 'utf8');
    assert.ok(after.includes('const dispatch = 1;'));
    assert.ok(after.includes('console.log(dispatch);'));
    assert.ok(after.includes('// send the thing'), 'the comment is untouched');
    assert.ok(after.includes("'https://x/send'"), 'the URL is untouched');
    assert.ok(after.includes('/send/'), 'the regex is untouched');
    assert.match(r.output, /strings, comments/, 'and the untouched ones are reported');
  });

  await test('RENAME: member accesses are counted and left alone unless asked for', async () => {
    // `x.send` may be a completely different `send`, and nothing short of type
    // inference can say. Guessing is how a rename half-lands.
    const dir = project({ 'a.js': 'const send = 1;\nother.send();\nsend();\n' });
    const r = await T.rename_symbol.run({ from: 'send', to: 'dispatch' }, { cwd: dir });
    const after = fs.readFileSync(path.join(dir, 'a.js'), 'utf8');
    assert.ok(after.includes('other.send()'), 'the member access is untouched');
    assert.ok(after.includes('dispatch();'));
    assert.match(r.output, /member access/);
    assert.match(r.output, /include_members/, 'and the way to change that is named');
  });

  await test('RENAME: dry_run reports and writes nothing at all', async () => {
    const dir = project({ 'a.js': 'const send = 1;\nsend();\n' });
    const before = fs.readFileSync(path.join(dir, 'a.js'), 'utf8');
    const r = await T.rename_symbol.run({ from: 'send', to: 'dispatch', dry_run: true }, { cwd: dir });
    assert.match(r.output, /WOULD change/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), before);
    assert.deepStrictEqual(r.mutated, []);
  });

  await test('RENAME: a file it cannot parse is reported, never rewritten by guesswork', async () => {
    const dir = project({ 'a.js': 'const send = 1;\nsend();\n', 'conf.json': '{ "send": true }' });
    const r = await T.rename_symbol.run({ from: 'send', to: 'dispatch' }, { cwd: dir });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'conf.json'), 'utf8'), '{ "send": true }');
    assert.match(r.output, /not JavaScript/);
  });

  await test('RENAME: a non-identifier is refused rather than run as text', () => {
    return T.rename_symbol.run({ from: 'a b', to: 'c' }, { cwd: process.cwd() })
      .then((r) => {
        assert.ok(r.isError);
        assert.match(r.output, /plain identifiers/);
      });
  });

  // ------------------------------------------------------------- residue ----

  await test('RESIDUE: a leftover the tests cannot see is found and named', async () => {
    // The exact failure: the new path works, every test passes, and the old
    // table is still in the tree being imported by something nobody looked at.
    const dir = project({
      'src/data.js': "'use strict';\nconst ENEMIES = { slime: { hp: 10 } };\nmodule.exports = { ENEMIES };\n",
      'src/loader.js': "'use strict';\nfunction loadEnemies() { return {}; }\nmodule.exports = { loadEnemies };\n",
      'src/legacy.js': "'use strict';\nconst { ENEMIES } = require('./data');\nmodule.exports = { table: ENEMIES };\n",
    });
    const r = await T.find_residue.run({
      gone: ['ENEMIES'], removed: ['src/data.js'], present: ['loadEnemies'],
    }, { cwd: dir });
    assert.match(r.output, /MIGRATION INCOMPLETE/);
    assert.match(r.output, /STILL DEFINED/);
    assert.match(r.output, /src\/legacy\.js/, 'the file nobody looked at is named');
    assert.match(r.output, /src\/data\.js — STILL ON DISK/);
    assert.match(r.output, /loadEnemies — present/);
  });

  await test('RESIDUE: a migration that IS finished is reported as finished', async () => {
    // A checker that always says "incomplete" is a checker nobody consults.
    const dir = project({
      'src/loader.js': "'use strict';\nfunction loadEnemies() { return {}; }\nmodule.exports = { loadEnemies };\n",
      'src/game.js': "'use strict';\nconst { loadEnemies } = require('./loader');\nmodule.exports = { t: loadEnemies() };\n",
    });
    const r = await T.find_residue.run({
      gone: ['ENEMIES'], removed: ['src/data.js'], present: ['loadEnemies'],
    }, { cwd: dir });
    assert.match(r.output, /MIGRATION COMPLETE/);
  });

  await test('RESIDUE: a deleted file that something still imports is a broken build, and says so', async () => {
    const dir = project({ 'src/uses.js': "const { ENEMIES } = require('./data');\nmodule.exports = ENEMIES;\n" });
    const r = await T.find_residue.run({ removed: ['src/data.js'] }, { cwd: dir });
    assert.match(r.output, /STILL IMPORT IT/);
    assert.match(r.output, /will fail at load/);
  });

  await test('RESIDUE: a name left only in a comment is a different finding from a live reference', async () => {
    const dir = project({ 'src/a.js': "// ENEMIES used to live here\nmodule.exports = {};\n" });
    const r = residue.check(dir, { gone: ['ENEMIES'] });
    assert.strictEqual(r.gone[0].state, residue.STATE.TEXT_ONLY);
    assert.match(residue.describe(r), /MIGRATION COMPLETE/, 'a comment is not a dependency');
  });

  await test('RESIDUE: a leftover kept alive by a TEST is called out as such', async () => {
    // A test that still exercises the old path keeps it alive and passes while
    // doing it — which is why the suite never notices.
    const dir = project({
      'src/a.js': 'function legacyPath() { return 1; }\nmodule.exports = { legacyPath };\n',
      'tests/a.test.js': "const { legacyPath } = require('../src/a');\nlegacyPath();\n",
    });
    const r = residue.check(dir, { gone: ['legacyPath'] });
    const text = residue.describe(r);
    assert.match(text, /MIGRATION INCOMPLETE/);
    assert.match(text, /in TESTS/);
    assert.match(text, /tests\/a\.test\.js/);
  });

  // --------------------------------------------------------- diff sensor ----

  await test('GIT: a whole-file rewrite is visible as a rewrite, not as a large edit', async () => {
    const dir = tmpdir('lain-git-');
    const run = (args) => execute('git', args, { cwd: dir, timeoutMs: 20_000 });
    const init = await run(['init', '-q']);
    if (!init.ok) return;                    // no git on this machine; nothing to test
    await run(['config', 'user.email', 't@example.com']);
    await run(['config', 'user.name', 'test']);
    const lines = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(dir, 'big.js'), lines + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'small.js'), 'const a = 1;\nconst b = 2;\n', 'utf8');
    await run(['add', '-A']);
    const c = await run(['commit', '-qm', 'base']);
    if (!c.ok) return;

    // A rewrite: every line replaced by a near-identical line.
    fs.writeFileSync(path.join(dir, 'big.js'),
      Array.from({ length: 60 }, (_, i) => `const v${i} = ${i + 1};`).join('\n') + '\n', 'utf8');
    // A real edit: one line.
    fs.writeFileSync(path.join(dir, 'small.js'), 'const a = 1;\nconst b = 3;\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'x\n', 'utf8');

    const r = await gitsense.review(dir, {});
    assert.ok(r.ok, r.error);
    const big = r.files.find((f) => f.file === 'big.js');
    const small = r.files.find((f) => f.file === 'small.js');
    assert.ok(big && big.rewrite, 'a file whose every line changed is a rewrite');
    assert.ok(small && !small.rewrite, 'a one-line change is not');
    const text = gitsense.describe(r);
    assert.match(text, /WHOLE-FILE REWRITE/);
    assert.match(text, /big\.js/);
    assert.match(text, /build output directory/, 'and dist/ is named as generated');
  });

  await test('GIT: files LAIN did not write are separated from files it did', async () => {
    const dir = tmpdir('lain-git2-');
    const run = (args) => execute('git', args, { cwd: dir, timeoutMs: 20_000 });
    if (!(await run(['init', '-q'])).ok) return;
    await run(['config', 'user.email', 't@example.com']);
    await run(['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(dir, 'mine.js'), 'const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'theirs.js'), 'const b = 1;\n', 'utf8');
    await run(['add', '-A']);
    if (!(await run(['commit', '-qm', 'base'])).ok) return;
    fs.writeFileSync(path.join(dir, 'mine.js'), 'const a = 2;\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'theirs.js'), 'const b = 2;\n', 'utf8');

    const r = await gitsense.review(dir, { expected: [path.join(dir, 'mine.js')] });
    const text = gitsense.describe(r);
    assert.match(text, /NOT CHANGED BY THIS SESSION/);
    assert.match(text, /theirs\.js/);
    assert.doesNotMatch(text.split('WORTH A SECOND LOOK')[1] || '', /mine\.js/,
      'the file LAIN did write is not a surprise');
  });

  await test('GIT: a session inside a SUBDIRECTORY sees its own frame, not the repo root\'s', async () => {
    // The defect this pins: porcelain v1 ALWAYS reports repo-root-relative
    // names — it ignores status.relativePaths on purpose — while the expected
    // list arrives as absolute paths, which review() normalizes against CWD.
    // From a subdirectory the two frames diverge on every file, and before the
    // frame join existed EVERY modified file was flagged `unexpected` (the
    // cwd-relative expected name could never equal git's root-relative one)
    // and countLines probed paths that did not exist, so `lines` came back
    // null and every size judgement built on it silently stopped working.
    const dir = tmpdir('lain-git4-');
    const run = (args) => execute('git', args, { cwd: dir, timeoutMs: 20_000 });
    if (!(await run(['init', '-q'])).ok) return;
    await run(['config', 'user.email', 't@example.com']);
    await run(['config', 'user.name', 'test']);
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pkg', 'mine.js'), 'const a = 1;\nconst b = 2;\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'pkg', 'theirs.js'), 'const c = 1;\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'root.js'), 'const r = 1;\n', 'utf8');
    await run(['add', '-A']);
    if (!(await run(['commit', '-qm', 'base'])).ok) return;
    fs.writeFileSync(path.join(dir, 'pkg', 'mine.js'), 'const a = 2;\nconst b = 2;\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'pkg', 'theirs.js'), 'const c = 2;\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'root.js'), 'const r = 2;\n', 'utf8');

    const sub = path.join(dir, 'pkg');
    const r = await gitsense.review(sub, { expected: [path.join(sub, 'mine.js')] });
    assert.ok(r.ok, r.error);
    // The subtree scoping: root.js differs from the last commit, but a session
    // rooted in pkg/ is not briefed on the rest of the repository.
    assert.ok(!r.files.some((f) => f.file === 'root.js'),
      'changes outside the session\'s subtree are not its state');
    // THE DEFECT: mine.js must match the expected list now that git's
    // root-relative name is converted into the session's cwd frame.
    const mine = r.files.find((f) => f.file === 'mine.js');
    assert.ok(mine, 'the file is named in the session\'s own frame, not the repo root\'s');
    assert.ok(!mine.unexpected, 'a file LAIN wrote is not a surprise — the frames join');
    assert.strictEqual(mine.added, 1, 'and the numstat half of the join lands on it');
    assert.strictEqual(mine.removed, 1);
    assert.strictEqual(mine.lines, 3, 'countLines reads the file where it actually is');
    const theirs = r.files.find((f) => f.file === 'theirs.js');
    assert.ok(theirs && theirs.unexpected, 'a file LAIN did not write still is a surprise');
    assert.deepStrictEqual(r.missing, [], 'and what was written is not reported missing');
  });

  await test('GIT: a clean tree says so plainly, with no observations to scroll past', async () => {
    const dir = tmpdir('lain-git3-');
    const run = (args) => execute('git', args, { cwd: dir, timeoutMs: 20_000 });
    if (!(await run(['init', '-q'])).ok) return;
    await run(['config', 'user.email', 't@example.com']);
    await run(['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n', 'utf8');
    await run(['add', '-A']);
    if (!(await run(['commit', '-qm', 'base'])).ok) return;
    const r = await gitsense.review(dir, {});
    assert.match(gitsense.describe(r), /working tree is clean/);
  });

  await test('GIT: somewhere that is not a repository is answered, not crashed on', async () => {
    const r = await gitsense.review(tmpdir('lain-nogit-'), {});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not a git repository/);
  });

  // ----------------------------------------------------------- vocabulary ---

  // ---- ORIENTATION: WHAT IS IN THIS FILE ----------------------------------
  //
  // "What does this file contain" is the most common orientation question in a
  // codebase, and the outline is its deterministic answer. What these guard is
  // not a broken tool — the capability worked all along — but an UNADVERTISED
  // one, which is the same leak seen from the model's side: with a file path
  // and that question, the only advertised move was to read the whole thing.
  await test('CHECK_SYMBOLS: list_symbols returns an outline, FAR cheaper than reading the file', async () => {
    const R = path.join(__dirname, '..', '..');
    const dir = project({ 'turn.js': fs.readFileSync(path.join(R, 'src', 'turn.js'), 'utf8') });
    const ctx = { cwd: dir };

    const outline = await T.check_symbols.run({ path: 'turn.js', list_symbols: true }, ctx);
    assert.ok(/DEFINED \(\d+\)/.test(outline.output), 'the outline must say how many definitions it found');
    assert.ok(outline.meta.symbols > 20, `expected a real outline, got ${outline.meta.symbols} symbols`);

    const whole = await require('../../src/tools/fs').tools.read_file.run({ path: 'turn.js' }, ctx);
    const ratio = whole.output.length / outline.output.length;
    assert.ok(ratio > 5, `the outline must be materially cheaper than the file; ratio was ${ratio.toFixed(1)}x`);
  });

  await test('CHECK_SYMBOLS: the outline comes back WITH findings, not only in their absence', async () => {
    const dir = project({
      'bad.js': "'use strict';\nfunction getUsers() { return []; }\n"
        + 'function main() { return getUser(); }\nmodule.exports = { getUsers, main };\n',
    });
    const r = await T.check_symbols.run({ path: 'bad.js', list_symbols: true }, { cwd: dir });
    assert.ok(/UNRESOLVED NAME/.test(r.output), 'the typo must still be reported');
    assert.ok(/DEFINED \(\d+\)/.test(r.output), 'the outline must be returned ALONGSIDE the finding');
    assert.ok(/getUsers/.test(r.output));
  });

  // The outline engine for everything that is not JavaScript was already in the
  // tree (structure.js) and was reachable only from the migration path, so a
  // .py asking what it contained got a refusal and a route to an EDITING tool.
  // The only move left was to read it whole — the cost the flag exists to avoid.
  await test('CHECK_SYMBOLS: a file that is not JavaScript still gets an outline', async () => {
    const dir = project({
      'app.py': 'import os\n\nclass Scanner:\n    def __init__(self):\n        pass\n'
        + '    def scan(self, x):\n        return x\n\ndef helper(a, b):\n    return a + b\n',
      'srv.go': 'package main\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\n\nfunc main() {}\n',
    });

    const py = await T.check_symbols.run({ path: 'app.py', list_symbols: true }, { cwd: dir });
    assert.ok(!py.isError, 'an outline in another language is an answer, not a refusal');
    assert.ok(/Scanner\.scan/.test(py.output), 'methods must carry their container');
    assert.ok(/helper/.test(py.output));
    assert.ok(/reads JavaScript/.test(py.output), 'it must say the typo check did NOT run');

    const go = await T.check_symbols.run({ path: 'srv.go', list_symbols: true }, { cwd: dir });
    assert.ok(/Server/.test(go.output) && /main/.test(go.output));

    // A real error still wins: the fallback must not swallow a missing file.
    const gone = await T.check_symbols.run({ path: 'nope.py', list_symbols: true }, { cwd: dir });
    assert.ok(gone.isError, 'a file that does not exist is still an error');
  });

  await test('CHECK_SYMBOLS: without list_symbols, a non-JavaScript file is still refused plainly', async () => {
    const dir = project({ 'app.py': 'def a():\n    return 1\n' });
    const r = await T.check_symbols.run({ path: 'app.py' }, { cwd: dir });
    assert.ok(r.isError, 'the unresolved-name check cannot run there and must not pretend otherwise');
  });

  await test('ORIENTATION: the cheap way to see inside a file is actually ADVERTISED', () => {
    const schema = T.check_symbols.schema;
    assert.ok(/outline/i.test(schema.description), 'check_symbols must advertise the outline, not only the typo check');
    assert.ok(/outline/i.test(schema.parameters.properties.list_symbols.description));

    const readFile = require('../../src/tools/fs').tools.read_file.schema;
    assert.ok(/check_symbols/.test(readFile.description),
      'read_file must route "what does this file contain" to the outline instead of a whole read');

    assert.ok(/list_symbols/.test(require('../../src/prompt').BASE),
      "the prompt's cheapest-first list must carry the outline, or nothing teaches the ladder");
  });

  await test('TOOLS: every semantic tool is advertised AND dispatchable', () => {
    const registry = require('../../src/tools');
    for (const name of Object.keys(semantic.tools)) {
      assert.ok(registry.has(name), `${name} is not dispatchable`);
      assert.ok(registry.schemas().some((s) => s.name === name), `${name} has no schema`);
    }
  });

  await test('TOOLS: the ones that write are declared mutating, so /undo can capture them', () => {
    for (const name of ['replace_symbol', 'insert_near_symbol', 'remove_symbol', 'rename_symbol']) {
      assert.strictEqual(semantic.tools[name].mutates, true, `${name} must be declared mutating`);
    }
    for (const name of ['read_symbol', 'check_symbols', 'find_residue', 'review_changes']) {
      assert.strictEqual(semantic.tools[name].mutates, false, `${name} changes nothing and must say so`);
    }
  });
};
