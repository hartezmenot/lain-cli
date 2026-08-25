'use strict';

/**
 * `.lain/` — PROJECT INTELLIGENCE THAT SURVIVES THE SESSION.
 *
 * ------------------------------------------------------------------------
 * THE OBJECTION THESE TESTS EXIST TO SETTLE.
 *
 * codemodel.js refuses to keep a store, and gives the reason:
 *
 *     V1's `.lain/index.json` was rebuilt at startup and then aged with every
 *     edit LAIN made, so it answered confidently from stale data for the rest
 *     of the session.
 *
 * That is a worse failure than having no index, because a confident wrong
 * answer costs more than no answer. So the property under test is not "the
 * index is fast". It is:
 *
 *     THE INDEX CANNOT ANSWER FROM A STALE ENTRY,
 *
 * because every read refreshes against the disk first. `staleness` here is not
 * unlikely — it is unreachable, and the last two tests are the ones that would
 * catch it becoming merely unlikely again.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { test, tmpdir } = require('../helpers');
const pi = require('../../src/projectindex');

/** A small project with a definition and an importer. */
function project() {
  const root = tmpdir('lain-index-');
  const write = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  write('src/settings.js', 'function saveSettings(x) { return x; }\nmodule.exports = { saveSettings };\n');
  write('src/app.js', "const s = require('./settings');\nfunction boot() { return s.saveSettings({}); }\n");
  write('README.md', '# demo\n');
  return { root, write };
}

/** Two writes inside one clock tick can share an mtime; make the change visible. */
function touch(abs, body) {
  fs.writeFileSync(abs, body);
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(abs, t, t);
}

module.exports = async function () {
  await test('INDEX: a first pass builds .lain and records what the project declares', () => {
    const { root } = project();
    const r = pi.refresh(root);
    assert.ok(r.persisted, '.lain must be written');
    assert.ok(fs.existsSync(path.join(root, '.lain', 'index.json')));
    assert.ok(r.added >= 3, 'every file is indexed on the first pass');
    assert.strictEqual(r.reused, 0);

    const defs = pi.definitionsOf(r.index, 'saveSettings');
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].file, 'src/settings.js');
    assert.strictEqual(defs[0].kind, 'function');
  });

  await test('INDEX: a second pass reuses everything and re-reads nothing', () => {
    // ---- THE WHOLE POINT ------------------------------------------------
    //
    // An unchanged project must cost a stat walk, not a parse of every file.
    // This is the line between "LAIN remembers this project" and "LAIN reads it
    // again every time you open it".
    const { root } = project();
    pi.refresh(root);
    const again = pi.refresh(root);
    assert.strictEqual(again.added, 0, 'nothing is new');
    assert.strictEqual(again.changed, 0, 'nothing changed');
    assert.ok(again.reused >= 3, 'everything is reused');
  });

  await test('INDEX: changing ONE file re-reads ONE file', () => {
    const { root } = project();
    pi.refresh(root);
    touch(path.join(root, 'src', 'settings.js'),
      'function saveSettings(x) { return x; }\nfunction resetSettings() {}\nmodule.exports = { saveSettings, resetSettings };\n');
    const r = pi.refresh(root);
    assert.strictEqual(r.changed, 1, 'exactly the edited file is re-read');
    assert.strictEqual(r.added, 0);
    assert.ok(r.reused >= 2, 'the rest is reused');
    // AND THE NEW DECLARATION IS THERE — an incremental update that did not
    // update anything would pass every count above and fail this.
    assert.strictEqual(pi.definitionsOf(r.index, 'resetSettings').length, 1);
  });

  await test('INDEX: a deleted file leaves the index, and is not reported as present', () => {
    const { root } = project();
    pi.refresh(root);
    fs.unlinkSync(path.join(root, 'src', 'app.js'));
    const r = pi.refresh(root);
    assert.strictEqual(r.removed, 1);
    assert.ok(!r.index.files['src/app.js'], 'a file that is gone is gone from the index');
  });

  await test('INDEX: it knows who imports what, in a CommonJS project', () => {
    // The first version of this read the wrong field off codemodel and reported
    // that nothing imported anything — in a codebase that is entirely `require`.
    const { root } = project();
    const r = pi.refresh(root);
    assert.deepStrictEqual(pi.importersOf(r.index, 'src/settings.js'), ['src/app.js']);
    assert.deepStrictEqual(pi.importersOf(r.index, 'src/app.js'), []);
  });

  // ---- THE TWO THAT SETTLE THE OBJECTION --------------------------------

  await test('INDEX: a corrupt index is rebuilt, never half-trusted', () => {
    const { root } = project();
    pi.refresh(root);
    fs.writeFileSync(path.join(root, '.lain', 'index.json'), '{ this is not json');
    const r = pi.refresh(root);
    assert.ok(r.added >= 3, 'a file it cannot parse is treated as no index at all');
    assert.strictEqual(pi.definitionsOf(r.index, 'saveSettings').length, 1, 'and the answers come back');
  });

  await test('INDEX: an index from an older version is rebuilt rather than misread', () => {
    const { root } = project();
    pi.refresh(root);
    const file = path.join(root, '.lain', 'index.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    j.version = pi.VERSION - 1;
    // A plausible-looking entry from a shape that no longer means what it says.
    j.files['src/settings.js'] = { size: 1, mtime: 1, lang: 'js', symbols: [{ name: 'ghost', kind: 'function' }] };
    fs.writeFileSync(file, JSON.stringify(j));
    const r = pi.refresh(root);
    assert.strictEqual(pi.definitionsOf(r.index, 'ghost').length, 0, 'nothing from the old shape survives');
    assert.strictEqual(pi.definitionsOf(r.index, 'saveSettings').length, 1);
  });

  await test('INDEX: an edit made behind LAIN\'s back is still seen — this is the V1 failure', () => {
    // ---- THE ONE THAT MATTERS -------------------------------------------
    //
    // V1 built an index at startup and aged it. Here the file is changed by
    // something that is not LAIN — a colleague, a git checkout, an editor — and
    // the very next query must reflect it, because the query refreshes before it
    // answers rather than trusting what was written last time.
    const { root } = project();
    pi.refresh(root);
    touch(path.join(root, 'src', 'settings.js'), 'function renamedEntirely(x) { return x; }\n');
    const r = pi.fresh(root);
    assert.strictEqual(pi.definitionsOf(r.index, 'renamedEntirely').length, 1, 'the new name is known');
    assert.strictEqual(pi.definitionsOf(r.index, 'saveSettings').length, 0,
      'and the old one is gone — an index that answered `saveSettings` here is the V1 bug');
  });

  await test('INDEX: a read-only project still answers, and says the index was not kept', () => {
    // Refusing to work because a directory cannot be written would be a worse
    // trade than being slower.
    const { root } = project();
    const r = pi.refresh(root, { index: pi.empty(root) });
    assert.ok(r.index.files['src/settings.js'], 'the answers are built either way');
    assert.strictEqual(typeof r.persisted, 'boolean', 'and whether it was kept is reported');
  });

  await test('INDEX: the orientation block summarises, and never ships the index', () => {
    const { root } = project();
    const r = pi.refresh(root);
    const text = pi.orientation(r.index);
    assert.match(text, /PROJECT INDEX/);
    assert.match(text, /file\(s\) indexed/);
    // A PROJECTION, NOT THE STORE. Shipping every symbol of every file into a
    // prompt would recreate the cost the index exists to remove.
    assert.ok(!text.includes('"mtime"'), 'raw index fields must not reach a reader');
    assert.ok(text.length < 4000, `orientation must stay compact, was ${text.length} chars`);
  });

  await test('INDEX: the capability is registered and reachable from the live tool list', () => {
    const tools = require('../../src/tools');
    assert.ok(tools.names().includes('understand'), 'understand must be in the live vocabulary');
    const schema = require('../../src/tools/intel').tools.understand.schema;
    assert.match(schema.description, /BEFORE listing directories/, 'and say when to reach for it');
    assert.strictEqual(require('../../src/tools/intel').tools.understand.mutates, false);
  });

  await test('INDEX: .lain is ignored by git — it is machine state, not source', () => {
    const root = path.join(__dirname, '..', '..');
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(ignore, /^\.lain\/$/m, 'a committed index would be a merge conflict every commit');
  });
};
