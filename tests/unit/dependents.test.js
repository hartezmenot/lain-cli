'use strict';

/**
 * WHO DEPENDS ON THIS FILE — the V2-native replacement for V1's Feature Graph.
 *
 * V1's FGM answered this from a `.lain/fgm.json` store built by a scan and never
 * updated by an edit, so it answered confidently from stale data. The query was
 * worth keeping; the database was the defect. These tests assert the query is
 * right AND that it reads the tree as it is right now — the property the store
 * could not have.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const { tools } = require('../../src/tools/search');

function project(files) {
  const dir = tmpdir('deps-');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

const run = (cwd, input) => tools.dependents.run(input, { cwd });

module.exports = async function () {
  await test('DEPS: finds the files that import a file, with the line that does it', async () => {
    const cwd = project({
      'src/telegram.js': 'module.exports = { send() {} };',
      'src/api.js': "const t = require('./telegram');\n",
      'src/web/panel.js': "import { send } from '../telegram.js';\n",
      'src/unrelated.js': "const x = require('./other');\n",
    });
    const r = await run(cwd, { path: 'src/telegram.js' });
    assert.match(r.output, /src\/api\.js:1/);
    assert.match(r.output, /src\/web\/panel\.js:1/);
    assert.ok(!/unrelated/.test(r.output), `an unrelated import was reported:\n${r.output}`);
    assert.strictEqual(r.meta.dependents, 2);
  });

  await test('DEPS: a relative specifier resolves against the file that WROTE it', async () => {
    // `./util` in two different folders is two different files. Matching on the
    // basename alone is what makes a dependency report quietly wrong.
    const cwd = project({
      'a/util.js': 'module.exports = 1;',
      'b/util.js': 'module.exports = 2;',
      'a/use.js': "require('./util');",
      'b/use.js': "require('./util');",
    });
    const r = await run(cwd, { path: 'a/util.js' });
    assert.match(r.output, /a\/use\.js/);
    assert.ok(!/b\/use\.js/.test(r.output), `resolved to the wrong util.js:\n${r.output}`);
  });

  await test('DEPS: an extensionless or index import still resolves', async () => {
    const cwd = project({
      'src/store/index.js': 'module.exports = {};',
      'src/a.js': "const s = require('./store');\n",
      'src/b.js': "import s from './store/index.js';\n",
    });
    const r = await run(cwd, { path: 'src/store/index.js' });
    assert.strictEqual(r.meta.dependents, 2, r.output);
  });

  await test('DEPS: a page that LINKS a script counts as depending on it', async () => {
    const cwd = project({
      'app.js': 'console.log(1);',
      'index.html': '<html><body><script src="app.js"></script></body></html>',
    });
    const r = await run(cwd, { path: 'app.js' });
    assert.match(r.output, /index\.html/);
  });

  await test('DEPS: "nothing imports this" is reported as a FINDING, never as proof', async () => {
    // The most destructive possible mistake this tool could invite is "no
    // dependents, therefore delete it". An entry point has no importer by
    // definition — that is what makes it the entry point.
    const cwd = project({ 'bin/cli.js': 'require("../src/app");', 'src/app.js': 'module.exports = 1;' });
    const r = await run(cwd, { path: 'bin/cli.js' });
    assert.strictEqual(r.meta.dependents, 0);
    assert.match(r.output, /entry point/i);
    assert.match(r.output, /not proof/i);
  });

  await test('DEPS: dynamic loading is disclosed, because a scan cannot see it', async () => {
    const cwd = project({
      'src/plug.js': 'module.exports = 1;',
      'src/loader.js': 'const name = process.argv[2];\nrequire(path.join("./", name));\n',
    });
    const r = await run(cwd, { path: 'src/plug.js' });
    assert.match(r.output, /loads code dynamically/);
    assert.match(r.output, /src\/loader\.js/);
  });

  await test('DEPS: the answer reflects the tree RIGHT NOW, not a cached scan', async () => {
    // This is the whole reason there is no store. V1's graph was written once
    // and consulted forever.
    const cwd = project({ 'src/t.js': 'module.exports = 1;', 'src/one.js': "require('./t');" });
    assert.strictEqual((await run(cwd, { path: 'src/t.js' })).meta.dependents, 1);
    fs.writeFileSync(path.join(cwd, 'src', 'two.js'), "require('./t');", 'utf8');
    assert.strictEqual((await run(cwd, { path: 'src/t.js' })).meta.dependents, 2, 'a new importer must appear immediately');
    fs.unlinkSync(path.join(cwd, 'src', 'one.js'));
    assert.strictEqual((await run(cwd, { path: 'src/t.js' })).meta.dependents, 1, 'a removed importer must disappear immediately');
  });

  await test('DEPS: a missing file is an ordinary error, and the cwd is the boundary', async () => {
    const cwd = project({ 'a.js': '1' });
    const gone = await run(cwd, { path: 'nope.js' });
    assert.ok(gone.isError);
    const out = await run(cwd, { path: '../../../etc/hosts' });
    assert.ok(out.isError, 'a path outside the project must be refused');
  });

  await test('DEPS: include narrows which files are searched', async () => {
    const cwd = project({
      'src/t.js': '1',
      'src/use.js': "require('./t');",
      'tests/use.test.js': "require('../src/t');",
    });
    const all = await run(cwd, { path: 'src/t.js' });
    assert.strictEqual(all.meta.dependents, 2);
    const only = await run(cwd, { path: 'src/t.js', include: 'src/**' });
    assert.strictEqual(only.meta.dependents, 1, only.output);
  });
};
