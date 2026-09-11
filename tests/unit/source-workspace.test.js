'use strict';

/**
 * THE SOURCE WORKSPACE'S TWO HALVES THAT CAN BE TESTED WITHOUT A BROWSER:
 * the file authority, and the highlighter.
 *
 * The HTTP behaviour is driven end to end in tests/smoke/harnessapp-source.
 * These are the properties that must hold whatever the transport does — the
 * boundary, the save conditions, and the fact that a source file cannot become
 * markup.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const source = require('../../src/harnessapp/source');
const pagesource = require('../../src/harnessapp/pagesource');

/** The emitted client script, evaluated the way a browser would. */
function client() {
  const w = {};
  const d = { getElementById: () => null, addEventListener: () => {} };
  // eslint-disable-next-line no-new-func -- evaluating the page's own script is the point.
  new Function('window', 'document', pagesource.js())(w, d);
  return w.LAIN.source;
}

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-srcunit-'));
  fs.mkdirSync(path.join(dir, 'ui'));
  fs.writeFileSync(path.join(dir, 'ui', 'a.css'), '.row {\n  opacity: 0.2;\n}\n');
  return { dir, app: { session: { cwd: dir }, checkpoints: null } };
}

module.exports = async function () {
  // ------------------------------------------------------- THE BOUNDARY --

  await test('SOURCE: the project root is inside the project', () => {
    // `path.relative(cwd, cwd)` is the empty string, and an emptiness check
    // refused the one directory a tree exists to list.
    const { dir, app } = project();
    try {
      assert.strictEqual(source.inside(dir, dir), true);
      assert.ok(source.tree(app, '').ok, 'the root must be listable');
      assert.strictEqual(source.locate(app, '.').rel, '.');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('SOURCE: a shared path prefix is not the same tree', () => {
    // The mistake a `startsWith` on strings makes: `/proj` and `/project-two`.
    assert.strictEqual(source.inside('/proj', '/proj/a'), true);
    assert.strictEqual(source.inside('/proj', '/project-two/a'), false);
    assert.strictEqual(source.inside('/proj', '/proj/../elsewhere'), false);
  });

  await test('SOURCE: tree paths are project-relative, never absolute', () => {
    const { dir, app } = project();
    try {
      for (const e of source.tree(app, '').entries) {
        assert.ok(!path.isAbsolute(e.path), `${e.path} would put the person directory layout in the page`);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // ----------------------------------------------------- THE SAVE TOKEN --

  await test('SOURCE: identity is CONTENT, not a timestamp', () => {
    // THE MEASURED DEFECT: two writes inside one millisecond share an mtime, so
    // an mtime-conditional save failed OPEN exactly where it mattered — LAIN
    // edits, the person saves a moment later, and the model work is gone.
    const { dir, app } = project();
    const file = path.join(dir, 'ui', 'a.css');
    try {
      fs.writeFileSync(file, '.row{opacity:0.2}');
      const a = fs.statSync(file).mtimeMs;
      fs.writeFileSync(file, '.row{opacity:0.9}');
      const b = fs.statSync(file).mtimeMs;
      // This is allowed to be equal — that is the whole point.
      if (a === b) {
        assert.notStrictEqual(source.digest('.row{opacity:0.2}'), source.digest('.row{opacity:0.9}'),
          'a content hash must distinguish what a timestamp could not');
      }
      const open = source.open(app, 'ui/a.css');
      assert.ok(open.hash, 'an open must hand back a content identity');
      assert.strictEqual(open.hash, source.digest(open.body));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('SOURCE: a save over a changed file is refused and returns the current bytes', () => {
    const { dir, app } = project();
    try {
      const open = source.open(app, 'ui/a.css');
      fs.writeFileSync(path.join(dir, 'ui', 'a.css'), '.row {\n  opacity: 0.9;\n}\n');
      const r = source.save(app, 'ui/a.css', '.row { MINE }\n', { hash: open.hash });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.stale, true);
      assert.match(r.current, /opacity: 0\.9/, 'the caller must be able to show both versions');
      assert.match(fs.readFileSync(path.join(dir, 'ui', 'a.css'), 'utf8'), /opacity: 0\.9/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('SOURCE: a person save goes through the same truncation guard a model write does', () => {
    const { dir, app } = project();
    const big = path.join(dir, 'big.js');
    try {
      fs.writeFileSync(big, 'x'.repeat(5000));
      const open = source.open(app, 'big.js');
      const r = source.save(app, 'big.js', 'x', { hash: open.hash });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.truncation, true);
      // AND IT IS OVERRIDABLE, because sometimes a person really does mean it.
      assert.strictEqual(source.save(app, 'big.js', 'x', { hash: open.hash, force: true }).ok, true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('SOURCE: dependencies and build output are not offered as source', () => {
    for (const d of ['node_modules', '.git', 'dist', 'build', 'coverage', '.next']) {
      assert.ok(source.SKIP_DIRS.has(d), `${d} would bury the person own code`);
    }
  });

  // ----------------------------------------------------- THE HIGHLIGHTER --

  await test('HIGHLIGHT: a source file can never become markup', () => {
    const h = client().highlight;
    const hostile = '</pre><script>alert(1)</script>';
    const out = h(hostile, 'text');
    assert.ok(out.indexOf('<script') < 0, `injection survived: ${out}`);
    assert.strictEqual(h('a < b & c > d', 'text'), 'a &lt; b &amp; c &gt; d');
  });

  await test('HIGHLIGHT: it never corrupts the markup it emitted', () => {
    // THE REAL BUG THIS REPLACED. The first version chained `replace` calls, so
    // the keyword pass matched the word `class` inside `<span class="tk-n">`
    // that an earlier pass had emitted, and produced
    //     <span <span class="tk-k">class</span>="tk-n">1</span>
    // A single pass over the ORIGINAL text cannot have the bug.
    const h = client().highlight;
    for (const [lang, line] of [
      ['js', 'const x = 1; // note'],
      ['ts', 'interface X { a: 12px }'],
      ['css', '  opacity: 0.5;'],
      ['html', '<button id="pay">Pay</button>'],
      ['py', 'def f(): # hi'],
    ]) {
      const out = h(line, lang);
      assert.ok(!/<span <span/.test(out), `${lang}: nested span in ${out}`);
      // Every span it opens, it closes.
      const opens = (out.match(/<span /g) || []).length;
      const closes = (out.match(/<\/span>/g) || []).length;
      assert.strictEqual(opens, closes, `${lang}: unbalanced spans in ${out}`);
    }
  });

  await test('HIGHLIGHT: it colours what it claims to and nothing else', () => {
    const h = client().highlight;
    assert.match(h('const x = 1;', 'js'), /tk-k">const</);
    assert.match(h('const x = 1;', 'js'), /tk-n">1</);
    assert.match(h('a // b', 'js'), /tk-c">\/\/ b</);
    assert.match(h('var s = "hi";', 'js'), /tk-s">"hi"</);
    // A keyword of one language is not a keyword of another.
    assert.ok(!/tk-k/.test(h('interface X', 'py')), 'py must not colour a TS keyword');
    // And plain text is left entirely alone.
    assert.strictEqual(h('just words here', 'text'), 'just words here');
  });

  await test('HIGHLIGHT: a comment ends the line, and a string survives a quote inside it', () => {
    const h = client().highlight;
    const out = h('x = 1; // const "not a string"', 'js');
    assert.ok(!/tk-k/.test(out.slice(out.indexOf('tk-c'))), 'nothing after a comment is code');
    assert.match(h('var s = "a \\" b";', 'js'), /tk-s/);
  });

  // ------------------------------------------------------------- THE DIFF --

  await test('PATCH: the diff finds the changed lines and nothing else', () => {
    const d = client().diff;
    const before = '.row {\n  display: block;\n  opacity: 0.2;\n}\n';
    const after = '.row {\n  display: block;\n  opacity: 0.5;\n}\n';
    const p = d(before, after);
    assert.deepStrictEqual(p.removed, ['  opacity: 0.2;']);
    assert.deepStrictEqual(p.added, ['  opacity: 0.5;']);
    assert.deepStrictEqual(p.changed, [2], 'the third line, zero-based');
  });

  await test('PATCH: an unchanged file produces no patch', () => {
    const d = client().diff;
    const same = 'a\nb\nc\n';
    const p = d(same, same);
    assert.deepStrictEqual(p.removed, []);
    assert.deepStrictEqual(p.added, []);
  });
};
