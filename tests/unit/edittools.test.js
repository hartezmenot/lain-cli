'use strict';

/**
 * SURGICAL EDITS — the tools that stop a one-line change costing a whole file.
 *
 * With only read_file and write_file, changing one line meant reading 2,000
 * lines in and emitting 2,000 back out — and output is the expensive direction,
 * so the smallest possible edit was the most costly thing the model could do.
 * It is also the most dangerous: every rewrite is a chance to drop a line
 * nobody was thinking about, and the diff then shows a 2,000-line change where
 * one was meant.
 *
 * The tests that matter here are the REJECTIONS. A patch tool that silently
 * applies when its assumption is stale is worse than no patch tool at all,
 * because the model stops re-reading and the corruption is invisible.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const tools = require('../../src/tools');

const NL = String.fromCharCode(10);

function project(files) {
  const dir = tmpdir('edit-');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

const run = (name, input, cwd) => tools.execute(name, input, { cwd });
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

module.exports = async function () {
  // ------------------------------------------------------------ apply_patch --

  await test('PATCH: it replaces exactly the lines it said it would', async () => {
    const dir = project({ 'a.js': `const x = 1;${NL}const y = 9;${NL}console.log(x);${NL}` });
    const r = await run('apply_patch', { path: 'a.js', expect: 'const y = 9;', replace: 'const y = 2;' }, dir);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(read(dir, 'a.js'), `const x = 1;${NL}const y = 2;${NL}console.log(x);${NL}`);
    assert.match(r.output, /patched a\.js:2/, 'and says where: ' + r.output);
  });

  await test('PATCH: a STALE expectation is rejected, not guessed', async () => {
    // The whole reason the tool can be used without re-reading.
    const dir = project({ 'a.js': `const y = 2;${NL}` });
    const r = await run('apply_patch', { path: 'a.js', expect: 'const y = 9;', replace: 'const y = 3;' }, dir);
    assert.ok(r.isError, 'it must refuse');
    assert.match(r.output, /PATCH REJECTED/);
    assert.match(r.output, /REASON/);
    assert.strictEqual(read(dir, 'a.js'), `const y = 2;${NL}`, 'and the file is untouched');
  });

  await test('PATCH: the rejection SHOWS what is actually there', async () => {
    // A refusal the model cannot act on just becomes a whole-file rewrite next turn.
    const dir = project({ 'a.js': `alpha${NL}const y = 2;${NL}omega${NL}` });
    const r = await run('apply_patch', { path: 'a.js', expect: `const y = 9;`, replace: 'x' }, dir);
    assert.match(r.output, /const y = 2;/, 'the real line is quoted back: ' + r.output);
    assert.match(r.output, /\b2\b/, 'with its line number');
  });

  await test('PATCH: an AMBIGUOUS expectation is rejected and says how many', async () => {
    const dir = project({ 'a.js': `foo();${NL}bar();${NL}foo();${NL}` });
    const r = await run('apply_patch', { path: 'a.js', expect: 'foo();', replace: 'baz();' }, dir);
    assert.ok(r.isError);
    assert.match(r.output, /appears 2 times/);
    assert.strictEqual(read(dir, 'a.js'), `foo();${NL}bar();${NL}foo();${NL}`, 'nothing changed');
  });

  await test('PATCH: an empty replacement deletes the block', async () => {
    const dir = project({ 'a.js': `keep${NL}drop${NL}keep2${NL}` });
    const r = await run('apply_patch', { path: 'a.js', expect: `drop${NL}`, replace: '' }, dir);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(read(dir, 'a.js'), `keep${NL}keep2${NL}`);
  });

  await test('PATCH: a CRLF file stays CRLF — a one-line edit is not a whole-file diff', async () => {
    const CRLF = String.fromCharCode(13) + NL;
    const dir = project({ 'a.js': `one${CRLF}two${CRLF}three${CRLF}` });
    const r = await run('apply_patch', { path: 'a.js', expect: 'two', replace: 'TWO' }, dir);
    assert.ok(!r.isError, r.output);
    const after = read(dir, 'a.js');
    assert.strictEqual(after, `one${CRLF}TWO${CRLF}three${CRLF}`);
    assert.ok(!/[^\r]\n/.test(after), 'no bare LF was introduced');
  });

  await test('PATCH: a patch written with LF still matches a CRLF file', async () => {
    // Otherwise every edit on Windows is refused for invisible reasons.
    const CRLF = String.fromCharCode(13) + NL;
    const dir = project({ 'a.js': `a${CRLF}b${CRLF}` });
    const r = await run('apply_patch', { path: 'a.js', expect: `a${NL}b`, replace: `a${NL}B` }, dir);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(read(dir, 'a.js'), `a${CRLF}B${CRLF}`);
  });

  await test('PATCH: a missing file is a normal, readable failure', async () => {
    const dir = project({});
    const r = await run('apply_patch', { path: 'nope.js', expect: 'x', replace: 'y' }, dir);
    assert.ok(r.isError);
    assert.match(r.output, /no such file/);
  });

  // ----------------------------------------------------------- append_file --

  await test('APPEND: it adds to the end without reading the file', async () => {
    const dir = project({ 'routes.js': `route('/a');${NL}` });
    const r = await run('append_file', { path: 'routes.js', text: `route('/b');` }, dir);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(read(dir, 'routes.js'), `route('/a');${NL}route('/b');${NL}`);
    assert.match(r.output, /appended 1 line/);
  });

  await test('APPEND: a file with no trailing newline does not get its last line welded', async () => {
    const dir = project({ 'x.txt': 'first' });
    await run('append_file', { path: 'x.txt', text: 'second' }, dir);
    assert.strictEqual(read(dir, 'x.txt'), `first${NL}second${NL}`);
  });

  await test('APPEND: it creates the file when there is none, and says so', async () => {
    const dir = project({});
    const r = await run('append_file', { path: 'sub/new.txt', text: 'hello' }, dir);
    assert.ok(!r.isError, r.output);
    assert.match(r.output, /created/);
    assert.strictEqual(read(dir, 'sub/new.txt'), `hello${NL}`);
  });

  // -------------------------------------------------------------- insert_at --

  await test('INSERT: it puts a line after the anchor', async () => {
    const dir = project({ 'app.js': `import a from 'a';${NL}import c from 'c';${NL}start();${NL}` });
    const r = await run('insert_at', { path: 'app.js', anchor: "import a from 'a';", text: "import b from 'b';" }, dir);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(read(dir, 'app.js'), `import a from 'a';${NL}import b from 'b';${NL}import c from 'c';${NL}start();${NL}`);
  });

  await test('INSERT: before works too', async () => {
    const dir = project({ 'app.js': `second${NL}` });
    await run('insert_at', { path: 'app.js', anchor: 'second', text: 'first', where: 'before' }, dir);
    assert.strictEqual(read(dir, 'app.js'), `first${NL}second${NL}`);
  });

  await test('INSERT: an AMBIGUOUS anchor is rejected and the candidates are listed', async () => {
    const dir = project({ 'app.js': `x();${NL}y();${NL}x();${NL}` });
    const r = await run('insert_at', { path: 'app.js', anchor: 'x();', text: 'z();' }, dir);
    assert.ok(r.isError);
    assert.match(r.output, /INSERT REJECTED/);
    assert.match(r.output, /2 lines contain/);
    assert.match(r.output, /1: x\(\);/, 'the candidates are shown so the model can pick: ' + r.output);
    assert.strictEqual(read(dir, 'app.js'), `x();${NL}y();${NL}x();${NL}`);
  });

  await test('INSERT: a MISSING anchor is rejected', async () => {
    const dir = project({ 'app.js': `a${NL}` });
    const r = await run('insert_at', { path: 'app.js', anchor: 'nowhere', text: 'z' }, dir);
    assert.ok(r.isError);
    assert.match(r.output, /no line contains/);
  });

  // ----------------------------------------------------------- delete_range --

  await test('DELETE RANGE: it removes the lines and returns what went', async () => {
    const dir = project({ 'a.txt': `1${NL}2${NL}3${NL}4${NL}` });
    const r = await run('delete_range', { path: 'a.txt', from: 2, to: 3 }, dir);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(read(dir, 'a.txt'), `1${NL}4${NL}`);
    assert.match(r.output, /deleted 2 line/);
    assert.match(r.output, /2/, 'and shows the removed text');
  });

  await test('DELETE RANGE: a range past the end is refused rather than silently clipped', async () => {
    const dir = project({ 'a.txt': `1${NL}` });
    const r = await run('delete_range', { path: 'a.txt', from: 50, to: 60 }, dir);
    assert.ok(r.isError);
    assert.match(r.output, /past the end/);
  });

  // -------------------------------------------------------- move and delete --

  await test('MOVE: it moves, creates the directory, and refuses to clobber', async () => {
    const dir = project({ 'a.txt': 'x', 'taken.txt': 'y' });
    const ok = await run('move_file', { from: 'a.txt', to: 'sub/b.txt' }, dir);
    assert.ok(!ok.isError, ok.output);
    assert.strictEqual(read(dir, 'sub/b.txt'), 'x');
    const clobber = await run('move_file', { from: 'sub/b.txt', to: 'taken.txt' }, dir);
    assert.ok(clobber.isError);
    assert.match(clobber.output, /already exists/);
    assert.strictEqual(read(dir, 'taken.txt'), 'y', 'and the destination is intact');
  });

  await test('DELETE FILE: a directory is refused — that is a larger act', async () => {
    const dir = project({ 'sub/a.txt': 'x' });
    const r = await run('delete_file', { path: 'sub' }, dir);
    assert.ok(r.isError);
    assert.match(r.output, /is a directory/);
    assert.ok(fs.existsSync(path.join(dir, 'sub', 'a.txt')));
  });

  // --------------------------------------------------------------- file_info --

  await test('INFO: it reports size and lines WITHOUT reading the file into context', async () => {
    const dir = project({ 'big.js': `line${NL}`.repeat(1200) });
    const r = await run('file_info', { path: 'big.js' }, dir);
    assert.ok(!r.isError, r.output);
    assert.match(r.output, /1201 lines/);
    assert.ok(r.output.length < 400, 'the answer must be small — that is the point');
    assert.match(r.output, /read a range/i, 'and it steers away from reading it whole');
  });

  // ------------------------------------------------ the vocabulary is one list --

  await test('TOOLS: every new tool is dispatchable and advertised', async () => {
    const names = tools.names();
    for (const n of ['apply_patch', 'append_file', 'insert_at', 'delete_range', 'move_file', 'delete_file', 'file_info']) {
      assert.ok(names.includes(n), `${n} is missing from the registry`);
      assert.ok(tools.has(n), `${n} is not dispatchable`);
    }
    const schemaNames = tools.schemas().map((s) => s.name).sort();
    assert.deepStrictEqual(schemaNames, [...names].sort(), 'schemas and dispatch must be the same list');
  });

  await test('TOOLS: the mutating ones are declared mutating, so /undo can capture them', async () => {
    for (const n of ['apply_patch', 'append_file', 'insert_at', 'delete_range', 'move_file', 'delete_file']) {
      assert.strictEqual(tools.isMutating(n), true, `${n} must be marked mutating`);
    }
    assert.strictEqual(tools.isMutating('file_info'), false, 'and a read is not');
  });

  await test('TOOLS: the descriptions tell the model to work small', async () => {
    // Tool descriptions ARE behaviour: they are what the model reads before
    // choosing between "patch three lines" and "rewrite the file".
    const by = Object.fromEntries(tools.schemas().map((s) => [s.name, s.description]));
    assert.match(by.apply_patch, /cheapest way|never read a large file/i);
    assert.match(by.append_file, /instead of reading a file/i);
    assert.match(by.file_info, /without reading it/i);
  });
};
