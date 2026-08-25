'use strict';

/**
 * Search is the tool the model reaches for before it knows where anything is,
 * so its failure modes are quiet ones: a pattern that silently matches nothing,
 * a cap that hides results without saying so, a walk that wanders out of the
 * project. Each of those is asserted here.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const search = require('../../src/tools/search');
const registry = require('../../src/tools');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-search-'));
  fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'auth', 'login.js'), 'function login(u, p) {\n  return check(u, p);\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'index.js'), "const { login } = require('./auth/login');\n");
  fs.writeFileSync(path.join(root, 'README.md'), '# login docs\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'login.js'), 'login everywhere\n');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x6c, 0x6f, 0x67, 0x69, 0x6e, 0x00, 0x01]));
  return root;
}

const run = (name, input, cwd) => registry.execute(name, input, { cwd });

module.exports = async function () {
  const root = fixture();

  await test('SEARCH: grep finds matching lines with file and line number', async () => {
    const r = await run('grep', { pattern: 'function login' }, root);
    assert.ok(!r.isError, r.output);
    assert.match(r.output, /src\/auth\/login\.js:1:/);
  });

  await test('SEARCH: grep never descends into generated directories', async () => {
    const r = await run('grep', { pattern: 'login' }, root);
    assert.ok(!/node_modules/.test(r.output), `node_modules leaked into results:\n${r.output}`);
  });

  await test('SEARCH: binary files are skipped, not emitted as garbage lines', async () => {
    const r = await run('grep', { pattern: 'login' }, root);
    assert.ok(!/blob\.bin/.test(r.output), `binary file was searched:\n${r.output}`);
  });

  await test('SEARCH: include narrows by glob', async () => {
    const r = await run('grep', { pattern: 'login', include: '**/*.md' }, root);
    assert.match(r.output, /README\.md/);
    assert.ok(!/\.js:/.test(r.output), r.output);
  });

  await test('SEARCH: no match is a RESULT, not an error, and says how much was searched', async () => {
    const r = await run('grep', { pattern: 'zzz-nothing-matches-this' }, root);
    assert.ok(!r.isError, 'a search that found nothing is not a failed search');
    assert.match(r.output, /no match/i);
    assert.match(r.output, /file\(s\)/);
  });

  await test('SEARCH: an invalid regex says what the engine objected to', async () => {
    const r = await run('grep', { pattern: '([unclosed' }, root);
    assert.ok(r.isError);
    assert.match(r.output, /invalid regular expression/i);
  });

  await test('SEARCH: files_only returns names, not lines', async () => {
    const r = await run('grep', { pattern: 'login', files_only: true }, root);
    assert.ok(!/:\d+:/.test(r.output), r.output);
    assert.match(r.output, /login\.js/);
  });

  await test('SEARCH: glob matches by name and excludes generated trees', async () => {
    const r = await run('glob', { pattern: '**/*.js' }, root);
    assert.match(r.output, /src\/index\.js/);
    assert.match(r.output, /src\/auth\/login\.js/);
    assert.ok(!/node_modules/.test(r.output), r.output);
  });

  await test('SEARCH: a bare *.js means anywhere, not only the top level', async () => {
    const r = await run('glob', { pattern: '*.js' }, root);
    assert.match(r.output, /src\/auth\/login\.js/);
  });

  await test('SEARCH: ** crosses directories and * does not', () => {
    assert.ok(search.globToRegExp('src/**/*.js').test('src/a/b/c.js'));
    assert.ok(!search.globToRegExp('src/*.js').test('src/a/b.js'));
    assert.ok(search.globToRegExp('src/*.js').test('src/b.js'));
    // `**/` may match nothing at all.
    assert.ok(search.globToRegExp('**/*.js').test('a.js'));
  });

  await test('SEARCH: brace alternation works', () => {
    const re = search.globToRegExp('**/*.{ts,tsx}');
    assert.ok(re.test('src/a.ts'));
    assert.ok(re.test('src/a.tsx'));
    assert.ok(!re.test('src/a.js'));
  });

  await test('SEARCH: truncation is ANNOUNCED, never silent', async () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-search-big-'));
    fs.writeFileSync(path.join(big, 'many.txt'), Array.from({ length: search.MAX_MATCHES + 50 }, () => 'hit').join('\n'));
    const r = await run('grep', { pattern: 'hit' }, big);
    assert.match(r.output, /truncated/i, 'a capped result that does not say so produces confident wrong conclusions');
    fs.rmSync(big, { recursive: true, force: true });
  });

  await test('SEARCH: a /g pattern still finds every line (regex state is not carried)', async () => {
    // A global regex is stateful across .test() calls and skips every other
    // match. The tool must not be able to be put into that state by its input.
    const r = await run('grep', { pattern: 'login' }, root);
    const lines = r.output.split('\n').filter((l) => /login/.test(l));
    assert.ok(lines.length >= 3, `expected matches in at least 3 places, got:\n${r.output}`);
  });

  fs.rmSync(root, { recursive: true, force: true });
};
