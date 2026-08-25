'use strict';

/**
 * A WHOLE-FILE WRITE MUST NOT BE HOW A FILE IS LOST.
 *
 * ------------------------------------------------------------------------
 * THE INCIDENT THIS COMES FROM, and it happened to this repository.
 *
 * A 900-line Rust source file went to 0 bytes. The cause was a script that
 * opened it for writing — which truncates — and then failed before writing
 * anything. The file was untracked, so there was nothing to restore it from.
 *
 * The general shape is not specific to that script, and `write_file` can do it
 * in one call: replace a substantial file with a fraction of itself, from a
 * reconstruction that was not complete. `apply_patch` and `edit_file` cannot,
 * because they verify the exact text they are replacing.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS A REFUSAL AND NOT A WARNING. A warning after the write is a report
 * about data that is already gone. The write is the thing that has to not
 * happen, and the acknowledgement — `truncate: true` — exists so that
 * deliberately emptying a file is still one call away.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { test, tmpdir } = require('../helpers');
const fsTools = require('../../src/tools/fs');

const ctx = (cwd) => ({ cwd, session: { id: 'x' } });
const write = (input, cwd) => fsTools.tools.write_file.run(input, ctx(cwd));

module.exports = async function () {
  await test('TRUNCATE: emptying a file is refused, and nothing is written', async () => {
    const cwd = tmpdir('trunc-empty-');
    const file = path.join(cwd, 'big.js');
    const body = 'x'.repeat(30_000);
    fs.writeFileSync(file, body);

    const r = await write({ path: 'big.js', content: '' }, cwd);
    assert.strictEqual(r.isError, true);
    assert.match(r.output, /TRUNCATION REFUSED/);
    assert.match(r.output, /30000 bytes; this write is 0 \(empty\)/);
    // THE FILE IS UNTOUCHED. This is the assertion that would have saved a day.
    assert.strictEqual(fs.readFileSync(file, 'utf8'), body, 'nothing may be written');
    assert.match(r.output, /NOTHING WAS WRITTEN/);
  });

  await test('TRUNCATE: collapsing a file to a fraction is refused', async () => {
    const cwd = tmpdir('trunc-frac-');
    const file = path.join(cwd, 'big.js');
    fs.writeFileSync(file, 'x'.repeat(30_000));
    const r = await write({ path: 'big.js', content: 'y'.repeat(2_000) }, cwd);
    assert.strictEqual(r.isError, true);
    assert.match(r.output, /TRUNCATION REFUSED/);
    // AND IT NAMES THE WAY TO DO IT SAFELY, because a refusal with no next step
    // is a refusal somebody works around.
    assert.match(r.output, /apply_patch/);
    assert.match(r.output, /edit_file/);
    assert.match(r.output, /truncate: true/);
    assert.strictEqual(fs.statSync(file).size, 30_000);
  });

  await test('TRUNCATE: an ordinary rewrite is not obstructed', async () => {
    // THE COMMON CASE MUST BE UNAFFECTED. A guard that fires on ordinary work is
    // a guard people learn to pass `truncate: true` to reflexively, and then it
    // guards nothing.
    const cwd = tmpdir('trunc-ok-');
    const file = path.join(cwd, 'big.js');
    fs.writeFileSync(file, 'x'.repeat(30_000));
    const r = await write({ path: 'big.js', content: 'y'.repeat(26_000) }, cwd);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(fs.statSync(file).size, 26_000);
  });

  await test('TRUNCATE: a small file is rewritten freely', async () => {
    // A 200-byte config replaced by a 40-byte one is somebody editing a config.
    const cwd = tmpdir('trunc-small-');
    fs.writeFileSync(path.join(cwd, 'c.json'), JSON.stringify({ a: 1, b: 2, c: 3 }));
    const r = await write({ path: 'c.json', content: '{}' }, cwd);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'c.json'), 'utf8'), '{}');
  });

  await test('TRUNCATE: a new file is never a truncation', async () => {
    const cwd = tmpdir('trunc-new-');
    const r = await write({ path: 'fresh.js', content: '' }, cwd);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'fresh.js'), 'utf8'), '');
  });

  await test('TRUNCATE: acknowledging it lets it through', async () => {
    const cwd = tmpdir('trunc-ack-');
    const file = path.join(cwd, 'big.js');
    fs.writeFileSync(file, 'x'.repeat(30_000));
    const r = await write({ path: 'big.js', content: '', truncate: true }, cwd);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(fs.statSync(file).size, 0, 'deliberately emptying a file is still one call away');
  });

  await test('TRUNCATE: the predicate answers on sizes alone, with no side effects', () => {
    const cwd = tmpdir('trunc-pred-');
    const file = path.join(cwd, 'f.js');
    fs.writeFileSync(file, 'x'.repeat(10_000));
    const { truncationRisk } = fsTools;
    assert.deepStrictEqual(truncationRisk(file, ''), { was: 10_000, now: 0 });
    assert.deepStrictEqual(truncationRisk(file, 'y'.repeat(1_000)), { was: 10_000, now: 1_000 });
    assert.strictEqual(truncationRisk(file, 'y'.repeat(9_000)), null);
    assert.strictEqual(truncationRisk(path.join(cwd, 'missing.js'), ''), null);
    // A directory is not a file and must not be reported as one.
    assert.strictEqual(truncationRisk(cwd, ''), null);
    assert.strictEqual(fs.statSync(file).size, 10_000, 'asking must never write');
  });

  await test('TRUNCATE: the escape is advertised in the schema the model sees', () => {
    const schema = fsTools.tools.write_file.schema;
    assert.ok(schema.parameters.properties.truncate, 'a guard with an unadvertised escape traps the model');
    assert.match(schema.description, /apply_patch|edit_file/, 'and the cheaper way is named');
  });
};
