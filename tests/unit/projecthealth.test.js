'use strict';

/**
 * PROJECT HEALTH IS NOT LAIN HEALTH.
 *
 * `/health` inside scalpbot used to report LAIN's provider, context window and
 * connections: all true, all about the tool, none of it what the user asked. The
 * two questions are now two commands with two engines, and these hold that line
 * — plus the thing that keeps a local scan from being confidently wrong, which
 * is that findings say how sure they are.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const ph = require('../../src/projecthealth');
const T = require('../../src/ui/text');

/** A small project with a KNOWN set of problems in it. */
function sickProject() {
  const dir = tmpdir('ph-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"sickbot","main":"src/index.js"}');
  fs.writeFileSync(path.join(dir, 'src', 'index.js'),
    'function go() {\n  try { risky(); } catch (e) {}\n  try { other(); } catch {}\n}\nmodule.exports = { go };\n');
  fs.writeFileSync(path.join(dir, 'src', 'todo.js'),
    '// TODO: finish this\nfunction later() { throw new Error("not implemented"); }\nmodule.exports = { later };\n');
  return dir;
}

module.exports = async function () {
  await test('PH: it reads the PROJECT and names it', async () => {
    const a = await ph.assess(sickProject(), null);
    assert.strictEqual(a.name, 'sickbot');
    const titles = a.groups.map((g) => g.title);
    assert.deepStrictEqual(titles, ['Structure', 'Code health', 'Work state']);
  });

  await test('PH: real problems are found, and pointed AT A FILE', async () => {
    const a = await ph.assess(sickProject(), null);
    const text = T.strip(ph.projectHealthLines(a, 100).join('\n'));
    assert.match(text, /Silent errors\s+⚠/, 'two empty catch blocks are two silently dropped errors');
    assert.match(text, /src\/index\.js/, 'and the file that has them is named');
    assert.match(text, /Tests\s+✕ MISSING/, 'no test files is a real finding, not a blank');
  });

  await test('PH: findings carry CONFIDENCE, so a scan cannot be confidently wrong', async () => {
    const a = await ph.assess(sickProject(), null);
    const kinds = new Set(a.findings.map((f) => f.sure.word));
    // An empty catch IS the finding — the evidence and the conclusion are the
    // same fact. A TODO note only MIGHT matter, and says so.
    assert.ok(kinds.has('CONFIRMED'), 'a fact about the bytes is confirmed');
    assert.ok(kinds.has('NEEDS REVIEW') || kinds.has('LIKELY'), 'a judgement call is graded, not asserted');
    const silent = a.findings.find((f) => /silently dropped/.test(f.text));
    assert.strictEqual(silent.sure.word, 'CONFIRMED');
    const todo = a.findings.find((f) => /left-for-later/.test(f.text));
    assert.strictEqual(todo.sure.word, 'NEEDS REVIEW', 'a TODO is not evidence of a defect');
  });

  await test('PH: a healthy project is allowed to be healthy', async () => {
    const dir = tmpdir('ph-ok-');
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"okbot","main":"index.js"}');
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = () => 1;\n');
    fs.writeFileSync(path.join(dir, 'tests', 'a.test.js'), 'require("../index");\n');
    const a = await ph.assess(dir, null);
    assert.strictEqual(a.overall.word, 'HEALTHY', JSON.stringify(a.groups, null, 1));
    assert.deepStrictEqual(a.findings, [], 'nothing invented when nothing is wrong');
  });

  await test('PH: the next action is ONE thing, chosen from what is actually wrong', async () => {
    // With no tests, nothing here can be verified — that outranks every other
    // finding, because fixing anything else cannot be shown to have worked.
    const bare = await ph.assess(sickProject(), null);
    assert.match(bare.next, /Add a test/i);
    assert.strictEqual(bare.next.split('\n').length, 1, 'one action, not a lecture');
    // Once there ARE tests, the silently dropped errors become the next thing.
    const dir = sickProject();
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests', 'a.test.js'), 'require("../src/index");\n');
    const withTests = await ph.assess(dir, null);
    assert.match(withTests.next, /silently dropped errors/i);
    assert.match(withTests.next, /src\/index\.js/, 'and it says where to start');
  });

  await test('PH: /health is the project and /ready is LAIN — two commands, two engines', () => {
    const commands = require('../../src/commands');
    const health = commands.REGISTRY.get('/health');
    const ready = commands.REGISTRY.get('/ready');
    assert.ok(health && ready, 'both must exist');
    assert.notStrictEqual(health.run, ready.run, '/ready must not be an alias of /health');
    assert.match(health.desc, /project/i);
    assert.match(ready.desc, /LAIN/);
    // THE READINESS REPORT KEPT ITS ENGINE THROUGH THE RENAME. This is the
    // assertion that would have caught a rename that quietly dropped it.
    assert.strictEqual(ready.run.name, commands.REGISTRY.get('/ready').run.name);
    assert.ok(!/remote control/i.test(ready.desc), '/ready is readiness, not remote control');
  });

  await test('PH: work state reports THIS session, and a red check is not softened', async () => {
    const dir = sickProject();
    const app = {
      session: {
        cwd: dir,
        task: { objective: 'fix the dropped errors' },
        plan: { steps: [{ status: 'done' }, { status: 'active' }] },
        lifecycle: { lastCommand: { command: 'npm test', ok: false } },
      },
      checkpoints: null,
    };
    const a = await ph.assess(dir, app);
    const text = T.strip(ph.projectHealthLines(a, 100).join('\n'));
    assert.match(text, /Current task\s+● INFO\s+fix the dropped errors/);
    assert.match(text, /Last verification\s+✕ FAILED/, 'a failing check must read as failing');
    assert.match(a.next, /Fix the failing check first/, 'and it outranks everything else as the next action');
  });
};
