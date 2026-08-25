'use strict';

/**
 * BACKGROUND JOBS — the gap LAIN's own V1 tool audit identified, and the
 * anti-pattern it must not become.
 *
 * `run_bash` waits. For a 400-second suite that parks the turn inside one tool
 * call: nothing can be said, nothing asked, and the screen cannot tell a
 * running suite from a hung one.
 *
 * The obvious way to misuse the fix is
 *
 *     start → job_status → job_status → job_status → …
 *
 * which is the same block paid one model turn at a time, and strictly worse
 * than having waited. So `job_wait` blocks on the child's own exit event —
 * there is no interval anywhere in jobs.js — and these tests hold that.
 */

const assert = require('assert');
const { test } = require('../helpers');

const jobsMod = require('../../src/jobs');
const jobTools = require('../../src/tools/jobs').tools;
const { shellPrefix } = require('../../src/tools/shell');

/** The shell that is always present on the host running the suite. */
const SHELL = process.platform === 'win32' ? 'cmd' : 'bash';
const start = (jobs, command, opts = {}) =>
  jobs.start({ command, shell: shellPrefix(SHELL), cwd: process.cwd(), ...opts });

function fakeApp() {
  const outputs = [];
  return { app: { ui: { enabled: true, noteOutput: (c, o, e) => outputs.push({ c, o, e }) } }, outputs };
}

module.exports = async function () {
  await test('JOB: starting one returns IMMEDIATELY, while the command keeps running', async () => {
    // The whole point. If this ever blocks, the feature is not there.
    const jobs = new jobsMod.Jobs({});
    const t0 = Date.now();
    const job = start(jobs, process.platform === 'win32' ? 'ping -n 3 127.0.0.1' : 'sleep 2');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `starting took ${elapsed}ms — it blocked`);
    assert.strictEqual(job.state, jobsMod.STATE.RUNNING);
    assert.ok(job.id, 'and it has an id to collect it by');
    job.cancel('test over');
  });

  await test('JOB: the state machine ends in exactly one final state', async () => {
    const jobs = new jobsMod.Jobs({});
    const ok = await start(jobs, 'exit 0').wait();
    assert.strictEqual(ok.state, jobsMod.STATE.SUCCEEDED);
    assert.strictEqual(ok.exitCode, 0);

    const bad = await start(jobs, 'exit 3').wait();
    assert.strictEqual(bad.state, jobsMod.STATE.FAILED);
    assert.strictEqual(bad.exitCode, 3, 'the real exit code, not a flattened 1');
  });

  await test('JOB: exit codes match what the blocking runner reports — one shell resolver', async () => {
    // jobs.js and shell.js spawn the same three shells; a second copy of that
    // arithmetic would be free to disagree the day one gains a flag.
    const shell = require('../../src/tools/shell');
    const direct = await shell.run('exit 3', { shell: SHELL, cwd: process.cwd() });
    const viaJob = await start(new jobsMod.Jobs({}), 'exit 3').wait();
    assert.strictEqual(viaJob.exitCode, direct.exitCode);
  });

  await test('JOB: wait() resolves ON THE EVENT — no polling interval exists', async () => {
    // Held structurally as well as behaviourally: an interval in this file
    // would make every job cost CPU while it waited.
    const src = require('fs').readFileSync(require.resolve('../../src/jobs'), 'utf8');
    assert.ok(!/setInterval/.test(src), 'jobs.js must contain no polling interval');
    const jobs = new jobsMod.Jobs({});
    const job = start(jobs, 'exit 0');
    const s = await job.wait();
    assert.strictEqual(s.done, true);
  });

  await test('JOB: waiting on a FINISHED job answers at once, and can be done twice', async () => {
    const jobs = new jobsMod.Jobs({});
    const job = start(jobs, 'exit 0');
    await job.wait();
    const t0 = Date.now();
    const again = await job.wait();
    assert.ok(Date.now() - t0 < 200, 'a finished job must not make anyone wait');
    assert.strictEqual(again.state, jobsMod.STATE.SUCCEEDED);
  });

  await test('JOB: a bounded wait reports STILL RUNNING rather than pretending', async () => {
    const jobs = new jobsMod.Jobs({});
    const job = start(jobs, process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 9');
    const s = await job.wait(300);
    assert.strictEqual(s.done, false);
    assert.strictEqual(s.state, jobsMod.STATE.RUNNING);
    job.cancel('test over');
  });

  await test('JOB: a cancelled job KEEPS the output it produced', async () => {
    const jobs = new jobsMod.Jobs({});
    const job = start(jobs, process.platform === 'win32'
      ? 'echo before && ping -n 10 127.0.0.1' : 'echo before; sleep 9');
    await new Promise((r) => setTimeout(r, 700));
    const s = job.cancel('stopped');
    assert.strictEqual(s.state, jobsMod.STATE.CANCELLED);
    assert.match(job.output, /before/, 'what it printed before being stopped survives');
  });

  await test('JOB: a timeout is its own state, not a failure', async () => {
    const jobs = new jobsMod.Jobs({});
    const job = start(jobs, process.platform === 'win32' ? 'ping -n 20 127.0.0.1' : 'sleep 19',
      { timeoutMs: 600 });
    const s = await job.wait();
    assert.strictEqual(s.state, jobsMod.STATE.TIMED_OUT);
    assert.match(job.output, /timed out/);
  });

  await test('JOB: output is bounded, and truncation is ANNOUNCED', () => {
    const jobs = new jobsMod.Jobs({});
    const job = start(jobs, 'exit 0');
    job._append('x'.repeat(jobsMod.MAX_OUTPUT + 5000));
    assert.ok(job.output.length <= jobsMod.MAX_OUTPUT);
    assert.strictEqual(job.truncated, true);
  });

  await test('JOB: OUTPUT is fed as the bytes arrive, not once at the end', async () => {
    const { app, outputs } = fakeApp();
    const r = await jobTools.run_background.run({ command: 'echo hello', shell: SHELL }, { app, cwd: process.cwd() });
    await jobTools.job_wait.run({ id: r.meta.job }, { app });
    assert.ok(outputs.length > 0, 'the OUTPUT pane saw the job');
    assert.match(outputs.map((o) => o.o).join(''), /hello/);
  });

  await test('JOB: the tools point the model at job_wait and AWAY from polling', () => {
    // A cheaper path a model cannot find is not a cheaper path.
    assert.match(jobTools.run_background.schema.description, /job_wait/);
    assert.match(jobTools.run_background.schema.description, /do NOT call job_status in a loop/i);
    assert.match(jobTools.job_status.schema.description, /use job_wait instead/i);
    assert.match(jobTools.job_wait.schema.description, /ONE call/);
  });

  await test('JOB: collecting a job returns its TAIL, not the whole stream', async () => {
    // A suite's last forty lines carry the failures and the totals; its first
    // four hundred carry the names of everything that passed.
    const jobs = new jobsMod.Jobs({});
    const job = start(jobs, 'exit 0');
    job.output = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const tail = job.tail(40);
    assert.ok(tail.includes('line 499'), 'the end is what matters');
    assert.ok(!tail.includes('line 10'), 'and the beginning is left in OUTPUT');
  });

  await test('JOB: an unknown id is a plain refusal, not a crash', async () => {
    const { app } = fakeApp();
    const r = await jobTools.job_wait.run({ id: 'nope' }, { app });
    assert.strictEqual(r.isError, true);
    assert.match(r.output, /no job/);
  });

  await test('JOB: stopAll leaves no orphan when the session ends', async () => {
    const jobs = new jobsMod.Jobs({});
    start(jobs, process.platform === 'win32' ? 'ping -n 20 127.0.0.1' : 'sleep 19');
    start(jobs, process.platform === 'win32' ? 'ping -n 20 127.0.0.1' : 'sleep 19');
    assert.strictEqual(jobs.running().length, 2);
    jobs.stopAll('the session ended');
    assert.strictEqual(jobs.running().length, 0);
  });

  await test('JOB: finished jobs are kept so a result can still be read — but not forever', async () => {
    const jobs = new jobsMod.Jobs({});
    for (let i = 0; i < jobsMod.MAX_KEPT + 5; i++) await start(jobs, 'exit 0').wait();
    assert.ok(jobs.all().length <= jobsMod.MAX_KEPT + 1, `${jobs.all().length} jobs kept`);
  });

  await test('ARCH: there is exactly ONE job state machine', () => {
    // The guard's rule about duplicate vocabularies. A second one would be free
    // to disagree about what RUNNING means.
    const fs = require('fs');
    const path = require('path');
    const offenders = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        const rel = path.relative(path.join(__dirname, '..', '..'), p).replace(/\\/g, '/');
        if (rel === 'src/jobs.js') continue;
        const t = fs.readFileSync(p, 'utf8');
        if (/TIMED_OUT:\s*'TIMED_OUT'/.test(t)) offenders.push(rel);
      }
    };
    walk(path.join(__dirname, '..', '..', 'src'));
    assert.deepStrictEqual(offenders, [], `a second job state machine: ${offenders.join(', ')}`);
  });
};
