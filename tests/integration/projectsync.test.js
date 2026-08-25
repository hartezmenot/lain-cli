'use strict';

/**
 * THE TWO STATE DOMAINS, against a real supervisor.
 *
 * ------------------------------------------------------------------------
 *     ~/.lain-v2/supervisor/projects/   identity and a digest. Rust owns it,
 *                                       and it outlives every CLI process.
 *     <project>/.lain/                  the materialised index: symbols,
 *                                       imports, fingerprints, per file.
 *
 * The property under test is that NEITHER IS A COPY OF THE OTHER, and that the
 * runtime can answer "have I seen this tree before, and has it moved" across a
 * restart — which is the thing no session file records and the reason this
 * bookkeeping is in the runtime at all.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { test } = require('../helpers');
const supervisor = require('../../src/supervisor');
const guardian = require('../../src/guardian');
const projectsync = require('../../src/projectsync');
const projectindex = require('../../src/projectindex');

function isolate(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lain-psync-${tag}-`));
}

/** A private LAIN home, and the supervisor taken down whatever happens. */
async function withHome(fn) {
  const home = isolate('home');
  const prev = process.env.LAIN_HOME;
  process.env.LAIN_HOME = home;
  guardian.forgetLocal();
  try {
    await supervisor.ensure();
    return await fn(home);
  } finally {
    try { await supervisor.shutdown(); } catch { /* never started */ }
    guardian.forgetLocal();
    if (prev === undefined) delete process.env.LAIN_HOME; else process.env.LAIN_HOME = prev;
  }
}

function project() {
  const root = isolate('proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), "const a = require('./a');\nfunction beta() { return a.alpha(); }\n");
  return root;
}

/** Two writes in one clock tick can share an mtime; make the change visible. */
function touch(abs, body) {
  fs.writeFileSync(abs, body);
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(abs, t, t);
}

module.exports = async function () {
  const probe = supervisor.probe();
  if (!probe.available) {
    await test('PSYNC: skipped — the Rust binary is not built', () => {
      assert.ok(probe.why.includes('cargo build'), probe.why);
    });
    return;
  }

  await test('PSYNC: a project is NEW once, then UNCHANGED, then MODIFIED', async () => {
    await withHome(async () => {
      const root = project();

      const first = await projectsync.open(root);
      assert.strictEqual(first.verdict, 'NEW', 'the runtime has never seen this tree');
      assert.ok(fs.existsSync(path.join(root, '.lain', 'index.json')), 'and the index is materialised in the project');

      // ---- NOTHING MOVED --------------------------------------------------
      const second = await projectsync.open(root);
      assert.strictEqual(second.verdict, 'UNCHANGED');
      assert.strictEqual(second.refresh.changed, 0, 'and nothing was re-read');
      assert.strictEqual(second.refresh.added, 0);

      // ---- ONE FILE MOVED -------------------------------------------------
      touch(path.join(root, 'src', 'a.js'), 'function alpha() { return 2; }\nfunction gamma() {}\n');
      const third = await projectsync.open(root);
      assert.strictEqual(third.verdict, 'MODIFIED');
      assert.strictEqual(third.refresh.changed, 1, 'exactly the edited file');
      assert.strictEqual(
        projectindex.definitionsOf(third.index, 'gamma').length, 1,
        'and the new declaration is in the index',
      );
    });
  });

  await test('PSYNC: the runtime remembers the tree across its own restart', async () => {
    // THE WHOLE REASON THIS IS IN THE RUNTIME. A CLI that indexes a project and
    // exits has learned something no session file records; the next one would
    // rediscover it. The supervisor outlives both.
    await withHome(async () => {
      const root = project();
      await projectsync.open(root);

      await supervisor.shutdown();
      guardian.forgetLocal();
      await supervisor.ensure();

      const after = await projectsync.open(root);
      assert.strictEqual(after.verdict, 'UNCHANGED', 'a restart did not lose what it had seen');
      assert.strictEqual(after.refresh.changed, 0);
    });
  });

  await test('PSYNC: the runtime store holds counts and a digest — never the index', async () => {
    await withHome(async (home) => {
      const root = project();
      await projectsync.open(root);

      const dir = path.join(home, 'supervisor', 'projects');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      assert.strictEqual(files.length, 1, 'one record for one project');
      const raw = fs.readFileSync(path.join(dir, files[0]), 'utf8');
      const rec = JSON.parse(raw);

      // What it DOES hold: identity and bookkeeping.
      assert.ok(rec.path && rec.digest && rec.last_sync > 0);
      assert.ok(rec.files >= 2 && rec.symbols >= 2, 'counts, so a person can see it did something');

      // ---- AND WHAT IT MUST NOT ------------------------------------------
      //
      // A symbol table here would be a second copy of <project>/.lain and a
      // second authority for the same truth.
      for (const leaked of ['alpha', 'beta', 'mtime', 'imports', 'src/a.js']) {
        assert.ok(!raw.includes(leaked), `the runtime record is carrying index data: ${leaked}`);
      }
    });
  });

  await test('PSYNC: two projects keep independent state', async () => {
    await withHome(async () => {
      const a = project();
      const b = project();
      await projectsync.open(a);
      await projectsync.open(b);
      touch(path.join(a, 'src', 'a.js'), 'function alpha() { return 99; }\n');

      assert.strictEqual((await projectsync.open(a)).verdict, 'MODIFIED');
      assert.strictEqual((await projectsync.open(b)).verdict, 'UNCHANGED', 'the other project is untouched');
      // AND THEIR INDEXES ARE THEIR OWN.
      assert.ok(fs.existsSync(path.join(a, '.lain', 'index.json')));
      assert.ok(fs.existsSync(path.join(b, '.lain', 'index.json')));
    });
  });

  await test('PSYNC: a deleted .lain is rebuilt, and the runtime notices the tree is the same', async () => {
    await withHome(async () => {
      const root = project();
      await projectsync.open(root);
      fs.rmSync(path.join(root, '.lain'), { recursive: true, force: true });

      const after = await projectsync.open(root);
      // The INDEX had to be rebuilt from nothing...
      assert.ok(after.refresh.added >= 2, 'every file was re-read');
      // ...and the TREE is still the one the runtime last saw, because the
      // digest is computed from the files rather than from the index's history.
      assert.strictEqual(after.verdict, 'UNCHANGED');
    });
  });

  await test('PSYNC: with no runtime it still indexes, and refuses to claim a history', async () => {
    const root = project();
    const prev = process.env.LAIN_HOME;
    // A home with no supervisor in it, and nothing is started: opening a
    // project is bookkeeping, not work whose continuity matters.
    process.env.LAIN_HOME = isolate('norun');
    guardian.forgetLocal();
    try {
      const r = await projectsync.open(root);
      assert.strictEqual(r.verdict, 'UNKNOWN', 'no runtime answered, so there is no verdict');
      assert.ok(r.index.files['src/a.js'], 'but the index was still built');
      assert.match(projectsync.say(r.verdict, r.refresh), /no runtime is running/);
    } finally {
      if (prev === undefined) delete process.env.LAIN_HOME; else process.env.LAIN_HOME = prev;
      guardian.forgetLocal();
    }
  });

  await test('PSYNC: the digest is stable for a tree and moves when the tree does', async () => {
    const root = project();
    const one = projectindex.refresh(root);
    const a = projectsync.digestOf(one.index);
    const two = projectindex.refresh(root);
    assert.strictEqual(projectsync.digestOf(two.index), a, 'the same tree digests the same');
    touch(path.join(root, 'src', 'b.js'), 'function beta() { return 3; }\n');
    const three = projectindex.refresh(root);
    assert.notStrictEqual(projectsync.digestOf(three.index), a, 'a changed tree digests differently');
  });
};
