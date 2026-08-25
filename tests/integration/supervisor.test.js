'use strict';

/**
 * THE WORKER OUTLIVES THE APPLICATION — proved, not asserted.
 *
 * ------------------------------------------------------------------------
 * WHAT FAILED BEFORE THIS EXISTED. A background job lived on `app._jobs`, in
 * memory, on the App object. A worker therefore survived a failed TURN and died
 * with the PROCESS, and it appeared in no session state — so a suite that
 * finished thirty seconds after LAIN crashed finished for nobody, and a
 * replacement model could not be told what any of it did.
 *
 * These tests do not mock that. A REAL child process is started, a REAL separate
 * Node process submits the work and is then KILLED, and the assertion is that
 * the work carried on and its result was still there afterwards. If the
 * supervisor were ever spawned in a way that ties it to its caller — shared
 * stdio, same process group, no `unref` — HANDOVER-7 stops passing, which is the
 * only reason it is worth the seconds it costs.
 *
 * THEY SKIP THEMSELVES when the Rust binary is not built, because LAIN is a
 * zero-dependency Node program and its suite may not become conditional on a
 * toolchain. See supervisor.probe().
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { test } = require('../helpers');
const supervisor = require('../../src/supervisor');
const handover = require('../../src/handover');

const NL = String.fromCharCode(10);
const ROOT = path.join(__dirname, '..', '..');

/** A private LAIN home, so a test never touches the user's real supervisor. */
function isolate(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `lain-sup-${tag}-`));
  return { ...process.env, LAIN_HOME: home, _home: home };
}

/** Run a supervisor client call inside an isolated home. */
function withHome(home, fn) {
  const prev = process.env.LAIN_HOME;
  process.env.LAIN_HOME = home;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.LAIN_HOME; else process.env.LAIN_HOME = prev;
  }
}

async function withHomeAsync(home, fn) {
  const prev = process.env.LAIN_HOME;
  process.env.LAIN_HOME = home;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.LAIN_HOME; else process.env.LAIN_HOME = prev;
  }
}

/**
 * A command that takes a known, short time and leaves a mark on disk.
 *
 * BACKSLASHES ON WINDOWS, and it is not cosmetic: `cmd.exe` rejects a redirect
 * target written with forward slashes — "The filename, directory name, or volume
 * label syntax is incorrect" — so the worker exits 1 having done nothing, and
 * the test reads as a supervisor failure when it is a fixture failure.
 */
function slowMark(file, seconds = 3) {
  if (process.platform === 'win32') {
    const p = file.replace(/\//g, '\\');
    return `ping -n ${seconds + 1} 127.0.0.1 > NUL & echo DONE> "${p}"`;
  }
  return `sleep ${seconds}; echo DONE > "${file}"`;
}

function until(fn, ms = 30000, step = 100) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = async () => {
      let v = null;
      try { v = await fn(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, step);
    };
    tick();
  });
}

module.exports = async function () {
  const probe = supervisor.probe();
  if (!probe.available) {
    await test('SUPERVISOR: skipped — the Rust binary is not built', () => {
      // Declared rather than silent: a skipped guarantee is not a kept one.
      assert.ok(probe.why.includes('cargo build'), probe.why);
    });
    return;
  }

  await test('SUPERVISOR: it starts, answers, and is discoverable by pid and port', async () => {
    const env = isolate('start');
    await withHomeAsync(env._home, async () => {
      const up = await supervisor.ensure();
      assert.ok(up.running, `supervisor did not start: ${up.why}`);
      assert.ok(up.endpoint.port > 0, 'it must announce a real port');
      assert.ok(supervisor.alive(up.endpoint.pid), 'and the pid it announced must be alive');
      const again = supervisor.probe();
      assert.ok(again.running, 'a second client must DISCOVER it rather than start another');
      assert.strictEqual(again.endpoint.pid, up.endpoint.pid, 'and find the same process');
      await supervisor.shutdown();
    });
  });

  await test('SUPERVISOR: a job runs and its REAL exit status is recorded', async () => {
    const env = isolate('exit');
    await withHomeAsync(env._home, async () => {
      await supervisor.ensure();
      const bad = await supervisor.submit({ command: process.platform === 'win32' ? 'exit 3' : 'exit 3', shell: process.platform === 'win32' ? 'cmd' : 'sh' });
      assert.ok(bad.ok, `submit failed: ${bad.error}`);
      const done = await until(async () => {
        const s = await supervisor.status(bad.job.id);
        return s.ok && s.job.state !== 'running' && s.job.state !== 'queued' ? s.job : null;
      });
      assert.ok(done, 'the job must reach a final state');
      assert.strictEqual(done.state, 'failed', 'a non-zero exit is failed, never guessed');
      assert.strictEqual(done.exit_code, 3, 'and the code is the real one');
      await supervisor.shutdown();
    });
  });

  // §14. A client that lost the connection between sending and reading does not
  // know whether the work started. Retrying must not launch a second build.
  await test('SUPERVISOR: a retried submission returns the SAME job, never a duplicate', async () => {
    const env = isolate('idem');
    await withHomeAsync(env._home, async () => {
      await supervisor.ensure();
      const opts = { command: process.platform === 'win32' ? 'exit 0' : 'exit 0', shell: process.platform === 'win32' ? 'cmd' : 'sh', requestId: 'fixed-key' };
      const a = await supervisor.submit(opts);
      const b = await supervisor.submit(opts);
      assert.ok(a.ok && b.ok);
      assert.strictEqual(a.job.id, b.job.id, 'the same request id must return the same job');
      const all = await supervisor.list({});
      assert.strictEqual(all.jobs.length, 1, 'and only one worker may have been launched');
      await supervisor.shutdown();
    });
  });

  // ---- HANDOVER-6 ---------------------------------------------------------
  //
  // The distinction the whole boundary exists for: the APPLICATION failing is
  // not the WORKER failing. The worker is not this process's child, so killing
  // this process cannot signal it.
  await test('HANDOVER-6: the application dying is NOT the worker dying', async () => {
    const env = isolate('h6');
    const mark = path.join(env._home, 'mark-h6.txt');

    // A separate Node process plays the part of LAIN: it submits and exits.
    const script = `
      process.env.LAIN_HOME = ${JSON.stringify(env._home)};
      const s = require(${JSON.stringify(path.join(ROOT, 'src', 'supervisor.js').replace(/\\/g, '/'))});
      (async () => {
        await s.ensure();
        const r = await s.submit({ command: ${JSON.stringify(slowMark(mark, 3))}, shell: ${JSON.stringify(process.platform === 'win32' ? 'cmd' : 'sh')}, session: 'sess-h6', requestId: 'h6' });
        process.stdout.write(JSON.stringify({ id: r.job.id, pid: r.job.pid }));
        process.exit(0);
      })();
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, `the submitting process failed: ${r.stderr}`);
    const submitted = JSON.parse(r.stdout.trim());
    assert.ok(submitted.id, 'a job id must come back');

    // THE APPLICATION IS NOW GONE. The worker must not be.
    await withHomeAsync(env._home, async () => {
      const alive = await supervisor.status(submitted.id);
      assert.ok(alive.ok, 'the supervisor must still answer after its client exited');
      assert.ok(['running', 'queued', 'completed'].includes(alive.job.state),
        `the worker must not have been killed with its client, got ${alive.job.state}`);

      const done = await until(async () => {
        const s = await supervisor.status(submitted.id);
        return s.ok && s.job.state === 'completed' ? s.job : null;
      });
      assert.ok(done, 'the worker must finish even though nothing was connected');
      assert.ok(fs.existsSync(mark), 'and it must actually have done its work');
      await supervisor.shutdown();
    });
  });

  // ---- HANDOVER-7 ---------------------------------------------------------
  //
  // The most important one. The worker finishes while NOTHING is connected, and
  // a replacement session picks the result up and puts it in the handover.
  await test('HANDOVER-7: a worker that completes after the app died is handed to the next model', async () => {
    const env = isolate('h7');
    const mark = path.join(env._home, 'mark-h7.txt');

    const script = `
      process.env.LAIN_HOME = ${JSON.stringify(env._home)};
      const s = require(${JSON.stringify(path.join(ROOT, 'src', 'supervisor.js').replace(/\\/g, '/'))});
      (async () => {
        await s.ensure();
        const r = await s.submit({ command: ${JSON.stringify(slowMark(mark, 3))}, shell: ${JSON.stringify(process.platform === 'win32' ? 'cmd' : 'sh')}, session: 'sess-h7', requestId: 'h7' });
        process.stdout.write(JSON.stringify({ id: r.job.id }));
        process.exit(0);
      })();
    `;
    const sub = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(sub.status, 0, `submitting process failed: ${sub.stderr}`);
    const { id } = JSON.parse(sub.stdout.trim());

    await withHomeAsync(env._home, async () => {
      // A BRAND NEW session — this stands in for the replacement model. It never
      // saw the submission and has no transcript of it.
      const done = await until(async () => {
        const l = await supervisor.list({ session: 'sess-h7' });
        const j = l.ok && l.jobs.find((x) => x.id === id);
        return j && j.state === 'completed' ? j : null;
      });
      assert.ok(done, 'the replacement must be able to SEE the completed work');
      assert.strictEqual(done.exit_code, 0);
      assert.ok(fs.existsSync(mark), 'the work really happened');

      // And it reaches the handover the replacement model actually reads.
      const session = {
        cwd: env._home,
        task: { objective: 'run the browser regression', steers: [] },
        lifecycle: { state: 'ACTIVE', evidence: { filesChanged: new Set() }, lastCommand: null },
        turns: [{ model: 'model-A', stopReason: 'provider', steps: 4, actions: [] }],
        evidence: { digest: () => '' },
      };
      const packet = handover.build(session, { cwd: env._home, toModel: 'model-B', jobs: [done] });
      assert.ok(/Background work owned by the supervisor/.test(packet),
        `the packet must carry the worker result:${NL}${packet}`);
      assert.ok(packet.includes(id), 'naming the job');
      assert.ok(/completed/.test(packet), 'and its verified state');
      await supervisor.shutdown();
    });
  });

  // §13: switching model must not duplicate the work that is already running.
  await test('HANDOVER-13: switching model leaves the SAME job with the same supervisor', async () => {
    const env = isolate('switch');
    await withHomeAsync(env._home, async () => {
      await supervisor.ensure();
      const first = await supervisor.submit({
        command: slowMark(path.join(env._home, 'm.txt'), 2),
        shell: process.platform === 'win32' ? 'cmd' : 'sh',
        session: 'sess-switch', requestId: 'switch-1',
      });
      assert.ok(first.ok);
      // The model changes. The session, and therefore the job, does not.
      const seen = await supervisor.list({ session: 'sess-switch' });
      assert.strictEqual(seen.jobs.length, 1, 'a model switch must not fork the job universe');
      assert.strictEqual(seen.jobs[0].id, first.job.id);
      await supervisor.shutdown();
    });
  });

  await test('SUPERVISOR: cancellation is deterministic and recorded', async () => {
    const env = isolate('cancel');
    await withHomeAsync(env._home, async () => {
      await supervisor.ensure();
      const j = await supervisor.submit({
        command: slowMark(path.join(env._home, 'never.txt'), 60),
        shell: process.platform === 'win32' ? 'cmd' : 'sh',
      });
      assert.ok(j.ok);
      const c = await supervisor.cancel(j.job.id);
      assert.ok(c.ok, `cancel failed: ${c.error}`);
      assert.strictEqual(c.job.state, 'cancelled', 'the state must say so, not merely be forgotten');
      await supervisor.shutdown();
    });
  });

  await test('SUPERVISOR: a malformed request is answered, and the supervisor stays up', async () => {
    const env = isolate('bad');
    await withHomeAsync(env._home, async () => {
      const up = await supervisor.ensure();
      const net = require('net');
      const reply = await new Promise((resolve) => {
        const sock = net.connect({ port: up.endpoint.port, host: '127.0.0.1' });
        let buf = '';
        sock.on('connect', () => sock.write('{not json' + NL));
        sock.on('data', (d) => { buf += d.toString(); if (buf.includes(NL)) { sock.end(); resolve(buf.trim()); } });
        sock.on('error', () => resolve(''));
      });
      assert.ok(/"ok":false/.test(reply), `a bad line must be answered: ${reply}`);
      const pong = await supervisor.list({});
      assert.ok(pong.ok, 'and the supervisor must still be serving afterwards');
      await supervisor.shutdown();
    });
  });
};
