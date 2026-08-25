'use strict';

/**
 * WHICH LAINS ARE RUNNING —, the multi-instance registry.
 *
 * The dashboard assumed one global LAIN. Two projects in two terminals gave two
 * dashboards on two ephemeral ports, with nothing to say which was which and no
 * way to move between them.
 *
 * The properties that matter are all about NOT LYING: a row must open something
 * that exists, a dead instance must disappear, and switching must never merge
 * two LAINs into one view or carry one's credential to the other.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { test } = require('../helpers');

/** A fresh config dir per test, so runs cannot see each other's registry. */
function isolated(name) {
  const dir = path.join(os.tmpdir(), `lain-inst-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.LAIN_CONFIG_DIR = dir;
  for (const m of ['../../src/config', '../../src/instances']) delete require.cache[require.resolve(m)];
  const inst = require('../../src/instances');
  // `announce` creates this on its way past; a test that only plants a FOREIGN
  // record never calls it, so the directory has to exist first.
  fs.mkdirSync(inst.dir(), { recursive: true });
  return inst;
}

module.exports = async function () {
  const saved = process.env.LAIN_CONFIG_DIR;

  await test('INSTANCES: announcing puts this LAIN in the registry, and withdrawing removes it', () => {
    const inst = isolated('announce');
    assert.strictEqual(inst.list().length, 0, 'it starts empty');
    inst.announce({ port: 5100, project: 'alpha', cwd: 'C:/alpha', session: 's1', model: 'm1', state: 'ACTIVE', task: 'do the thing' });
    const [me] = inst.list();
    assert.ok(me, 'this instance must be listed');
    assert.strictEqual(me.pid, process.pid);
    assert.strictEqual(me.self, true, 'and must know it is this one');
    assert.strictEqual(me.url, 'http://127.0.0.1:5100/', 'with a URL that opens it');
    assert.strictEqual(me.project, 'alpha');
    assert.strictEqual(me.task, 'do the thing');
    inst.withdraw();
    assert.strictEqual(inst.list().length, 0, 'stopping must stop advertising');
  });

  await test('INSTANCES: a record whose process is GONE is swept, never offered', () => {
    // The one thing this must never do is point somebody at a port that now
    // belongs to something else. The pid is the truth; the file is a hint.
    const inst = isolated('dead');
    fs.writeFileSync(path.join(inst.dir(), '999999.json'),
      JSON.stringify({ pid: 999999, port: 5101, project: 'ghost', startedAt: Date.now(), at: Date.now() }));
    assert.strictEqual(inst.list().length, 0, 'a dead pid must not be listed');
    assert.ok(!fs.existsSync(path.join(inst.dir(), '999999.json')), 'and its file must be swept');
  });

  await test('INSTANCES: a SECOND live process is listed, and is not marked as this one', async () => {
    // A real child, because `self` is the field a switcher uses to decide which
    // chip is you — and a test that fakes the pid cannot tell it apart.
    const inst = isolated('two');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { windowsHide: true });
    try {
      await new Promise((r) => setTimeout(r, 200));
      inst.announce({ port: 5200, project: 'mine' });
      fs.writeFileSync(path.join(inst.dir(), `${child.pid}.json`),
        JSON.stringify({ pid: child.pid, port: 5201, project: 'theirs', cwd: 'C:/theirs', startedAt: Date.now(), at: Date.now() }));

      const list = inst.list();
      assert.strictEqual(list.length, 2, `expected both, saw ${list.map((i) => i.project).join(', ')}`);
      const mine = list.find((i) => i.project === 'mine');
      const theirs = list.find((i) => i.project === 'theirs');
      assert.strictEqual(mine.self, true, 'this process is HERE');
      assert.strictEqual(theirs.self, false, 'the other one is not');
      assert.strictEqual(theirs.url, 'http://127.0.0.1:5201/', 'and is reachable at its OWN port');

      // NO CREDENTIAL TRAVELS. Switching means opening that instance's own
      // dashboard and proving yourself there; a token in this list would make
      // one LAIN's secret readable from another's page.
      const blob = JSON.stringify(list);
      assert.ok(!/token/i.test(blob), 'the registry must carry no credential');
      assert.ok(!/password/i.test(blob));
    } finally {
      try { child.kill(); } catch { /* gone */ }
      inst.withdraw();
    }
  });

  await test('INSTANCES: a killed process disappears from the list by itself', async () => {
    const inst = isolated('kill');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { windowsHide: true });
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(inst.dir(), `${child.pid}.json`),
      JSON.stringify({ pid: child.pid, port: 5300, project: 'doomed', startedAt: Date.now(), at: Date.now() }));
    assert.strictEqual(inst.list().length, 1, 'listed while it lives');
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(inst.list().length, 0, 'and gone once it does not');
  });

  await test('INSTANCES: the task label is bounded — it is a label, not a log', () => {
    const inst = isolated('bound');
    inst.announce({ port: 5400, project: 'p', task: 'x'.repeat(500) });
    const [me] = inst.list();
    assert.ok(me.task.length <= inst.MAX_TASK, `task was ${me.task.length} characters`);
    inst.withdraw();
  });

  await test('INSTANCES: an unreadable file is swept rather than crashing the list', () => {
    // A half-written record — a crash mid-write — must cost that row, not the
    // whole switcher.
    const inst = isolated('junk');
    fs.writeFileSync(path.join(inst.dir(), '12345.json'), '{ this is not json');
    assert.doesNotThrow(() => inst.list());
    assert.strictEqual(inst.list().length, 0);
  });

  process.env.LAIN_CONFIG_DIR = saved;
  for (const m of ['../../src/config', '../../src/instances']) delete require.cache[require.resolve(m)];
};
