'use strict';

/**
 * THE HARNESS END TO END — real modules wired together, on a real project.
 *
 * Nothing is stubbed here except the project under test, which is written into
 * a temporary directory so the assertions are about behaviour rather than about
 * this repository. Real processes are spawned, a real browser is launched where
 * one exists, and the verdicts come from real exit codes.
 *
 * ------------------------------------------------------------------------
 * THE SCENARIOS, and what each proves that a unit test cannot.
 *
 *   A  backend    execute → verify → PASSED, with the receipts on disk
 *   B  frontend   a dev server and a browser observing the page it serves
 *   C  recovery   a red contract ends the task FAILED, a repair task passes,
 *                 and the first verdict is still there afterwards
 *   D  crash      a service dies on its own and the harness learns it from the
 *                 process rather than from a poll
 *   E  surfaces   every surface reads one projection of one state
 *
 * SCENARIO B DEGRADES HONESTLY. Where no browser exists the browser half is
 * INCONCLUSIVE and the test asserts THAT, rather than being skipped quietly —
 * a capability that is absent must be visible as absent.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const { Harness } = require('../../src/harness');
const { STATE } = require('../../src/harness/state');
const { VERDICT } = require('../../src/harness/verify');
const { EVENT } = require('../../src/events');
const { STATUS } = require('../../src/harness/processes');

const node = process.execPath;

/**
 * `node` BARE, NOT `process.execPath`, inside a package.json script.
 *
 * npm runs a script through a shell, and this machine's Node lives at
 * "C:\Program Files\nodejs\node.exe" — so an absolute path went in
 * unquoted and cmd stopped at "C:\Program". The harness reported that
 * correctly, as INCONCLUSIVE with "the test runner is not installed", which is
 * exactly right and was a fixture bug rather than a finding. Spawning the
 * binary directly (everywhere else in this file) still uses the absolute path.
 */

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-scenario-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

async function until(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

module.exports = async function () {
  // ---------------------------------------------------------- SCENARIO A ----

  await test('SCENARIO A: a backend task executes, is verified, and leaves receipts', async () => {
    const dir = project({
      'src/add.js': 'module.exports = (a, b) => a + b;\n',
      'test.js': 'const add = require("./src/add");\nif (add(2,2) !== 4) { console.log("0 passed, 1 failed"); process.exit(1); }\nconsole.log("1 passed, 0 failed");\n',
      'package.json': JSON.stringify({ name: 'scenario-a', scripts: { test: 'node test.js' } }),
    });
    const h = new Harness({ workspace: dir, persist: true });
    const task = h.begin({ title: 'make add work', objective: 'add two numbers' });
    assert.strictEqual(task.state, STATE.PLANNED, 'created is not started');
    h.runtime.start(task.id, 'the person asked');

    const report = await h.verify({
      name: 'add works',
      requirements: [
        { description: 'the module exists', checks: [{ kind: 'file', label: 'source', path: 'src/add.js' }] },
        { description: 'the suite passes', checks: [{ kind: 'tests', label: 'suite' }] },
      ],
    });

    assert.strictEqual(report.verdict, VERDICT.PASSED, report.why);
    assert.strictEqual(h.runtime.get(task.id).state, STATE.PASSED);
    // THE STATE PASSED THROUGH VERIFYING. There is no route around it.
    const path_ = h.runtime.get(task.id).history.map((x) => x.to);
    assert.deepStrictEqual(path_, [STATE.RUNNING, STATE.VERIFYING, STATE.PASSED]);

    // AND THE EVIDENCE IS ON DISK, addressable after the conversation is gone.
    const artifacts = h.runtime.store.index(task.id);
    assert.ok(artifacts.some((a) => a.kind === 'verification'), 'the report itself is kept');
    assert.ok(artifacts.some((a) => a.kind === 'test'), 'and so is the test output');
    const verdictFile = artifacts.find((a) => a.kind === 'verification');
    assert.match(fs.readFileSync(verdictFile.path, 'utf8'), /VERIFICATION PASSED/);
    // AND THE TASK RECORD SURVIVES THIS PROCESS.
    const reloaded = h.runtime.store.loadTask(task.id);
    assert.strictEqual(reloaded.state, STATE.PASSED);
    await h.shutdown();
  });

  await test('SCENARIO A2: the same work with a red suite ends FAILED, not done', async () => {
    const dir = project({
      'test.js': 'console.log("1 passed, 1 failed"); process.exit(1);\n',
      'package.json': JSON.stringify({ name: 'scenario-a2', scripts: { test: 'node test.js' } }),
    });
    const h = new Harness({ workspace: dir, persist: true });
    const task = h.begin({ title: 'red' });
    h.runtime.start(task.id);
    const report = await h.verify({ requirements: [{ description: 'the suite passes', checks: [{ kind: 'tests', label: 'suite' }] }] });
    assert.strictEqual(report.verdict, VERDICT.FAILED);
    assert.strictEqual(h.runtime.get(task.id).state, STATE.FAILED);
    await h.shutdown();
  });

  // ---------------------------------------------------------- SCENARIO B ----

  await test('SCENARIO B: a dev server is started, served, observed and verified', async () => {
    const dir = project({
      'server.js': `const http = require('http');
const PAGE = '<!doctype html><title>app</title><h1 id="title">Dashboard</h1>'
  + '<button id="go">Go</button><div id="panel" style="display:none">welcome back</div>'
  + '<script>document.getElementById("go").onclick=()=>{document.getElementById("panel").style.display="block";};</script>';
const port = Number(process.env.PORT);
http.createServer((q, s) => { s.writeHead(200, {'content-type':'text/html'}); s.end(PAGE); }).listen(port, '127.0.0.1', () => console.log('listening on ' + port));
`,
    });
    // A PORT NOBODY ELSE IS USING, chosen by asking the OS rather than guessing.
    const net = require('net');
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));

    const h = new Harness({ workspace: dir, persist: true });
    const task = h.begin({ title: 'the dashboard renders' });
    h.runtime.start(task.id);

    const proc = h.processes.start({
      taskId: task.id, name: 'frontend', command: node, args: ['server.js'],
      cwd: dir, env: { PORT: String(port) }, port,
    });
    const health = await h.processes.waitUntilHealthy(proc.processId, 10000);
    assert.strictEqual(health.health, 'HEALTHY', `the server did not come up: ${health.why}`);
    assert.strictEqual(h.runtime.get(task.id).processes[0].name, 'frontend', 'the task owns it');

    const url = `http://127.0.0.1:${port}/`;
    const browser = await h.browser.availability();
    if (browser.available) {
      // Observe while the task still owns a running service. Settlement now
      // releases task resources deterministically.
      const dom = await h.observe('element', { url, selector: '#title' }, task.id);
      assert.strictEqual(dom.source, 'dom');
      assert.match(String(dom.value), /Dashboard/);
    }

    const report = await h.verify({
      name: 'the dashboard works',
      requirements: [
        { description: 'the server answers', checks: [{ kind: 'http', label: 'root', url, expect_status: 200 }] },
        { description: 'the service is healthy', checks: [{ kind: 'process', label: 'frontend', name: 'frontend' }] },
        {
          description: 'the panel appears when Go is clicked',
          checks: [{
            kind: 'browser', label: 'panel flow', url,
            actions: [{ type: 'click', selector: '#go' }, { type: 'wait', ms: 150 }],
            assert: [{ selector: '#panel', visible: true, text: 'welcome back' }],
            no_console_errors: true,
          }],
        },
      ],
    });

    if (browser.available) {
      assert.strictEqual(report.verdict, VERDICT.PASSED, report.why);
      assert.strictEqual(h.runtime.get(task.id).state, STATE.PASSED);
      // A SCREENSHOT IS A REAL PNG, kept as bytes rather than mangled to text.
      const shot = h.runtime.store.index(task.id).find((a) => a.kind === 'screenshot');
      assert.ok(shot, 'a browser flow keeps a screenshot');
      const bytes = fs.readFileSync(shot.path);
      assert.strictEqual(bytes.subarray(1, 4).toString('ascii'), 'PNG', 'and it is genuinely an image');
    } else {
      // NO BROWSER IS A STATE, AND IT IS VISIBLE AS ONE.
      assert.strictEqual(report.verdict, VERDICT.INCONCLUSIVE, 'a missing browser must not pass and must not fail');
      assert.strictEqual(h.runtime.get(task.id).state, STATE.INCONCLUSIVE);
      const browserReq = report.requirements[2];
      assert.match(browserReq.why, /browser/i, `the reason must name the browser: ${browserReq.why}`);
      process.stdout.write(`      (no browser on this machine — the browser half is ENVIRONMENT BLOCKED: ${browser.why})\n`);
    }

    await h.shutdown();
    assert.ok(!proc.alive, 'shutdown takes the service down with the task');
  });

  // ---------------------------------------------------------- SCENARIO C ----

  await test('SCENARIO C: a failed contract is repaired, and both verdicts survive', async () => {
    const dir = project({
      'check.js': 'const fs = require("fs");\nif (!fs.existsSync("fixed.txt")) { console.log("0 passed, 1 failed"); process.exit(1); }\nconsole.log("1 passed, 0 failed");\n',
      'package.json': JSON.stringify({ name: 'scenario-c', scripts: { test: 'node check.js' } }),
    });
    const h = new Harness({ workspace: dir, persist: true });
    const first = h.begin({ title: 'make the check pass' });
    h.runtime.start(first.id);

    const red = await h.verify({ requirements: [{ description: 'the check passes', checks: [{ kind: 'tests', label: 'suite' }] }] });
    assert.strictEqual(red.verdict, VERDICT.FAILED);
    assert.strictEqual(h.runtime.get(first.id).state, STATE.FAILED);

    // RECOVERY: the failure is classified, and it says re-plan rather than retry.
    const advice = h.recover({ output: red.why, exitCode: 1 }, 'npm test');
    assert.strictEqual(advice.action, 'REPLAN');

    // The repair is a NEW task naming the old one — a terminal state is never
    // walked back, so "it took two attempts" survives.
    const repair = h.runtime.repairFor(first.id);
    assert.strictEqual(repair.causedBy, first.id);
    h.runtime.start(repair.id, 'fixing it');
    fs.writeFileSync(path.join(dir, 'fixed.txt'), 'done');

    const green = await h.verify({ requirements: [{ description: 'the check passes', checks: [{ kind: 'tests', label: 'suite' }] }] }, { taskId: repair.id });
    assert.strictEqual(green.verdict, VERDICT.PASSED);
    assert.strictEqual(h.runtime.get(repair.id).state, STATE.PASSED);
    assert.strictEqual(h.runtime.get(first.id).state, STATE.FAILED, 'the first verdict is not rewritten');
    assert.strictEqual(h.runtime.store.loadTask(first.id).state, STATE.FAILED, 'and not on disk either');
    await h.shutdown();
  });

  await test('SCENARIO C2: reopen keeps the failed verification in the record', async () => {
    // The other recovery shape: stay in the same task and re-execute. The
    // failed attempt is still listed afterwards.
    const h = new Harness({ workspace: os.tmpdir(), persist: false });
    const t = h.begin({ title: 'x' });
    h.runtime.start(t.id);
    h.runtime.verifying(t.id);
    h.runtime.get(t.id).noteVerification({ verdict: 'FAILED', failed: 1, why: 'the flow failed' });
    h.runtime.reopen(t.id, 'fixing the selector');
    assert.strictEqual(h.runtime.get(t.id).state, STATE.RUNNING);
    assert.strictEqual(h.runtime.get(t.id).verifications.length, 1, 'the failed attempt is still there');
    await h.shutdown();
  });

  // ---------------------------------------------------------- SCENARIO D ----

  await test('SCENARIO D: a service that dies is learned from the process, not from a poll', async () => {
    const dir = project({ 'die.js': 'setTimeout(() => { console.error("fatal: out of memory"); process.exit(3); }, 200);\n' });
    const h = new Harness({ workspace: dir, persist: true });
    const task = h.begin({ title: 'watch a service' });
    h.runtime.start(task.id);

    const seen = [];
    h.bus.on((e) => { if (e.type === EVENT.PROCESS_FAILED) seen.push(e); });

    const proc = h.processes.start({ taskId: task.id, name: 'worker', command: node, args: ['die.js'], cwd: dir });
    const healthy = await h.processes.waitUntilHealthy(proc.processId, 500);
    assert.strictEqual(healthy.health, 'UNKNOWN', 'no health spec means UNKNOWN, honestly');

    const crashed = await until(() => (proc.status === STATUS.CRASHED ? true : null), 6000);
    assert.ok(crashed, 'the crash must be observed');
    assert.strictEqual(seen.length, 1, 'and announced exactly once');
    assert.strictEqual(seen[0].exitCode, 3);
    assert.match(seen[0].tail, /out of memory/, 'with the process own last words attached');

    // THE TASK KNOWS, and a verification that depends on it is FAILED rather
    // than passing because nobody checked.
    const report = await h.verify({ requirements: [{ description: 'the worker is up', checks: [{ kind: 'process', label: 'worker', name: 'worker' }] }] });
    assert.strictEqual(report.verdict, VERDICT.FAILED);
    assert.strictEqual(h.runtime.get(task.id).state, STATE.FAILED);

    // AND THE RECOVERY ENGINE CLASSIFIES IT rather than retrying blindly.
    const advice = h.recover({ output: proc.healthWhy, exitCode: 3 }, 'start worker');
    assert.ok(['LOGICAL', 'UNKNOWN', 'ENVIRONMENTAL'].includes(advice.kind), advice.kind);
    assert.notStrictEqual(advice.action, 'RETRY', 'a process that exited 3 on its own is not a transient blip');
    await h.shutdown();
  });

  // ---------------------------------------------------------- SCENARIO E ----

  await test('SCENARIO E: every surface reads one projection of one state', async () => {
    const dir = project({ 'x.txt': 'x' });
    const h = new Harness({ workspace: dir, persist: true });
    const task = h.begin({ title: 'a task somebody far away cares about' });
    h.runtime.start(task.id);

    // A REMOTE CLIENT SUBSCRIBES; it never computes a second state from prose.
    const delivered = [];
    h.bus.on((e) => {
      if ([EVENT.TASK_STATE, EVENT.VERIFICATION_FAILED, EVENT.TASK_FAILED].includes(e.type)) delivered.push(e);
    });

    await h.verify({ requirements: [{ description: 'a file that is not there', checks: [{ kind: 'file', label: 'missing', path: 'nope.txt' }] }] });

    assert.ok(delivered.some((e) => e.type === EVENT.VERIFICATION_FAILED), 'a failure reaches a subscriber');
    assert.ok(delivered.some((e) => e.type === EVENT.TASK_STATE && e.to === STATE.FAILED));

    // AND THE SNAPSHOT IS THE SAME SHAPE FOR EVERY READER.
    const snap = h.snapshot();
    assert.strictEqual(snap.task.state, STATE.FAILED);
    assert.strictEqual(snap.task.verification.verdict, VERDICT.FAILED);
    assert.strictEqual(snap.workspace, dir);
    assert.ok(snap.tasks.length >= 1);

    // THE TIMELINE IS A PROJECTION OF THE SAME EVENTS, not a second log.
    const rows = h.timeline(task.id, { limit: 100 });
    assert.ok(rows.some((r) => /verification FAILED/.test(r.text)), rows.map((r) => r.text).join(' | '));
    assert.ok(rows.some((r) => /task created/.test(r.text)));
    // and it is ordered
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].at >= rows[i - 1].at, 'the timeline must be in order');
    await h.shutdown();
  });

  await test('SCENARIO E2: the doctor reports what is genuinely available here', async () => {
    const h = new Harness({ workspace: os.tmpdir(), persist: false });
    const rows = await h.doctor();
    const names = rows.map((r) => r.name);
    // The CORE four, plus one row from each plane. Named individually because
    // a doctor that quietly stopped measuring something would otherwise pass.
    for (const n of ['CLI', 'runtime', 'task storage', 'event integration',
      'shell', 'process manager', 'filesystem', 'browser', 'contracts', 'desktop bridge']) {
      assert.ok(names.includes(n), `the doctor does not mention ${n}`);
    }
    for (const r of rows) {
      assert.ok(r.why && r.why.length, `${r.name} reports no reason`);
      assert.ok(['core', 'optional'].includes(r.kind), `${r.name} is neither core nor optional`);
      assert.ok(['AVAILABLE', 'UNAVAILABLE', 'MISCONFIGURED'].includes(r.state), `${r.name}: ${r.state}`);
    }
    // AN ABSENT OPTIONAL IS NOT AN ERROR. Core alone decides the verdict.
    const summary = Harness.summarise(rows);
    assert.strictEqual(summary.ok, true, `core should be fine here: ${summary.why}`);
    // Persistence off is a deliberate MODE and must not read as a fault.
    assert.match(rows.find((r) => r.name === 'task storage').why, /in-memory by request/);
    await h.shutdown();
  });
};
