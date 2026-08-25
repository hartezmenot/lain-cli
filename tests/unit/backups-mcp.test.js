'use strict';

/**
 * CHECKPOINTS AND MCP SERVERS.
 *
 * Two features whose value is entirely in what they REFUSE to claim:
 *
 *   A checkpoint is only "stable" if a suite actually passed on it. A list
 *   where everything says stable is a list that tells you nothing, and the way
 *   that happens is a caller being allowed to assert stability.
 *
 *   An MCP server that is configured-but-off, configured-but-not-active, and
 *   never-configured are three different situations. Collapsing them is how a
 *   person ends up debugging a bridge that they had themselves disabled.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const mcp = require('../../src/mcp');

/** A disposable config home, so checkpoints never land in the real one. */
function withHome(fn) {
  const home = tmpdir('home-');
  const before = process.env.LAIN_CONFIG_DIR;
  process.env.LAIN_CONFIG_DIR = home;
  // The module reads configDir() per call, so this is enough — but the require
  // cache is shared, so it is restored no matter what happens.
  try { return fn(home); } finally {
    if (before === undefined) delete process.env.LAIN_CONFIG_DIR;
    else process.env.LAIN_CONFIG_DIR = before;
  }
}

function project(files) {
  const dir = tmpdir('proj-');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

module.exports = async function () {
  // ------------------------------------------------------------ checkpoints --

  await test('BACKUP: a checkpoint copies the tree and records the surroundings', () => {
    withHome(() => {
      const B = require('../../src/backups');
      const dir = project({ 'src/a.js': 'const x = 1;\n', 'README.md': 'hi\n' });
      const r = B.create(dir, { label: 'before the change', reason: 'testing' });
      assert.ok(r.ok, r.why);
      assert.strictEqual(r.row.files, 2);
      assert.strictEqual(r.row.label, 'before the change');
      assert.ok(r.row.at, 'and when it was taken');
      assert.ok(fs.existsSync(path.join(r.dest, 'src', 'a.js')), 'the bytes are really there');
    });
  });

  await test('BACKUP: an untested checkpoint is NEVER called stable', () => {
    withHome(() => {
      const B = require('../../src/backups');
      const dir = project({ 'a.txt': 'x' });
      const r = B.create(dir, { label: 'no tests run' });
      assert.strictEqual(r.row.stable, false, 'untested is not stable');
      assert.strictEqual(r.row.tests, null);
    });
  });

  await test('BACKUP: stability is DERIVED from the result, not accepted from the caller', () => {
    withHome(() => {
      const B = require('../../src/backups');
      const dir = project({ 'a.txt': 'x' });
      const failing = B.create(dir, { label: 'red', tests: { passed: 800, failed: 3 } });
      assert.strictEqual(failing.row.stable, false, 'a failing suite is not stable however it is labelled');
      const passing = B.create(dir, { label: 'green', tests: { passed: 800, failed: 0 } });
      assert.strictEqual(passing.row.stable, true);
      const empty = B.create(dir, { label: 'nothing ran', tests: { passed: 0, failed: 0 } });
      assert.strictEqual(empty.row.stable, false, 'zero tests passing is not a passing suite');
    });
  });

  await test('BACKUP: restore puts the files back, and checkpoints the current state first', () => {
    withHome(() => {
      const B = require('../../src/backups');
      const dir = project({ 'src/a.js': 'const x = 1;\n' });
      const made = B.create(dir, { label: 'good' });
      fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'BROKEN\n', 'utf8');

      const r = B.restore(dir, made.row.id);
      assert.ok(r.ok, r.why);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8'), 'const x = 1;\n');
      assert.ok(r.safety, 'the state before the restore was itself checkpointed');
      assert.match(r.safety.reason, /restoring/);
    });
  });

  await test('BACKUP: restore does NOT delete files made since the checkpoint — it reports them', () => {
    // Deleting is the one thing a restore could do that another restore cannot
    // take back.
    withHome(() => {
      const B = require('../../src/backups');
      const dir = project({ 'a.txt': 'one' });
      const made = B.create(dir, { label: 'before' });
      fs.writeFileSync(path.join(dir, 'new.txt'), 'made later', 'utf8');

      const r = B.restore(dir, made.row.id);
      assert.ok(r.ok, r.why);
      assert.ok(fs.existsSync(path.join(dir, 'new.txt')), 'the newer file survives');
      assert.ok(r.extra.includes('new.txt'), `and is reported: ${JSON.stringify(r.extra)}`);
    });
  });

  await test('BACKUP: restoring something that does not exist is a plain refusal', () => {
    withHome(() => {
      const B = require('../../src/backups');
      const dir = project({ 'a.txt': 'x' });
      const r = B.restore(dir, 'nope');
      assert.strictEqual(r.ok, false);
      assert.match(r.why, /no checkpoint/);
    });
  });

  await test('BACKUP: newest first, so "1" is the most recent', () => {
    withHome(() => {
      const B = require('../../src/backups');
      const dir = project({ 'a.txt': 'x' });
      B.create(dir, { label: 'older' });
      B.create(dir, { label: 'newer' });
      const rows = B.list();
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].label, 'newer');
    });
  });

  await test('BACKUP: an enormous tree is refused rather than copied by surprise', () => {
    withHome(() => {
      const B = require('../../src/backups');
      assert.ok(B.MAX_BYTES > 0 && B.MAX_FILES > 0, 'there are real limits');
      assert.ok(B.SKIP.has('node_modules') && B.SKIP.has('.git'),
        'and the directories nobody wants copied are skipped');
    });
  });

  // ------------------------------------------------------------ MCP servers --

  await test('MCP: several named servers are read from the config', () => {
    const cfg = {
      mcp: {
        servers: {
          browser: { command: ['node', 'browser.js'] },
          files: { command: ['node', 'files.js'] },
        },
      },
    };
    const all = mcp.servers(cfg);
    assert.deepStrictEqual(all.map((s) => s.id).sort(), ['browser', 'files']);
    assert.ok(all.every((s) => s.enabled));
  });

  await test('MCP: `enabled: false` is switched OFF, not absent', () => {
    const cfg = { mcp: { servers: { a: { command: ['x'] }, b: { command: ['y'], enabled: false } } } };
    const all = mcp.servers(cfg);
    assert.strictEqual(all.length, 2, 'a disabled server is still configured');
    assert.strictEqual(all.find((s) => s.id === 'b').enabled, false);
    assert.strictEqual(mcp.settings(cfg).id, 'a', 'and it is not the one that gets connected');
  });

  await test('MCP: the OLD single-command config still works, as the server named desktop', () => {
    // Nobody's setup breaks, and there is still one resolver.
    const cfg = { mcp: { command: ['python', 'bridge.py'] } };
    const all = mcp.servers(cfg);
    assert.deepStrictEqual(all.map((s) => s.id), ['desktop']);
    assert.strictEqual(mcp.configured(cfg), true);
    assert.deepStrictEqual(mcp.settings(cfg).command, ['python', 'bridge.py']);
  });

  await test('MCP: `desktop` is preferred as the active bridge when there is one', () => {
    const cfg = { mcp: { servers: { browser: { command: ['a'] }, desktop: { command: ['b'] } } } };
    assert.strictEqual(mcp.settings(cfg).id, 'desktop', 'the permission model is built around one bridge');
  });

  await test('MCP: nothing configured is NOT CONFIGURED, and no server is invented', () => {
    assert.deepStrictEqual(mcp.servers({}), []);
    assert.strictEqual(mcp.configured({}), false);
    assert.strictEqual(mcp.settings({}), null);
    // A server with no command is not a server.
    assert.deepStrictEqual(mcp.servers({ mcp: { servers: { broken: { name: 'x' } } } }), []);
  });

  await test('MCP: a server inherits NO environment unless the config gives it one', () => {
    // It is a process with hands on the machine; handing it the whole
    // environment (tokens included) is not a convenience worth having.
    const cfg = { mcp: { servers: { a: { command: ['x'] } } } };
    assert.deepStrictEqual(mcp.servers(cfg)[0].env, {});
    const withEnv = { mcp: { servers: { a: { command: ['x'], env: { TOKEN: 'v' } } } } };
    assert.deepStrictEqual(mcp.servers(withEnv)[0].env, { TOKEN: 'v' });
  });
};
