'use strict';

/**
 * EXECUTION OUTLIVES REASONING — the whole lifecycle, in seconds instead of hours.
 *
 * ------------------------------------------------------------------------
 * THE SCENARIO THIS COMPRESSES. A person says "run the training for two hours".
 * The model that started it becomes unresponsive; LAIN is closed and reopened
 * with a different model; the worker fails at 1h17m; the replacement model has
 * to find out what actually happened and decide what to do about it.
 *
 * Nothing about that story needs two hours to be true. The windows here are
 * seconds and the semantics are identical: a deadline that belongs to the JOB,
 * a worker that is nobody's child but the supervisor's, and events that are
 * observations rather than verdicts.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: that any of it means the work went well.
 * The supervisor is required not to have an opinion — see the deadline test.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { test } = require('../helpers');
const supervisor = require('../../src/supervisor');
const handover = require('../../src/handover');
const jobTools = require('../../src/tools/jobs').tools;

const NL = String.fromCharCode(10);
const ROOT = path.join(__dirname, '..', '..');
const WIN = process.platform === 'win32';
const SHELL = WIN ? 'cmd' : 'sh';

function isolate(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lain-exec-${tag}-`));
}

async function inHome(home, fn) {
  const prev = process.env.LAIN_HOME;
  process.env.LAIN_HOME = home;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.LAIN_HOME; else process.env.LAIN_HOME = prev;
  }
}

/** Runs for `seconds`, then exits with `code`. */
function runsFor(seconds, code = 0) {
  return WIN
    ? `ping -n ${seconds + 1} 127.0.0.1 > NUL & exit ${code}`
    : `sleep ${seconds}; exit ${code}`;
}

function until(fn, ms = 40000, step = 250) {
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

/** A minimal App, the shape the job tools actually reach for. */
function fakeApp(sessionId, cwd) {
  return {
    session: { id: sessionId, cwd },
    _jobs: null,
    events: null,
    refreshSupervisedJobs() { /* the real one is async; nothing to do here */ },
  };
}

module.exports = async function () {
  const probe = supervisor.probe();
  if (!probe.available) {
    await test('EXECUTION: skipped — the Rust supervisor is not built', () => {
      assert.ok(probe.why.includes('cargo build'), probe.why);
    });
    return;
  }

  // ---- §1: the model's clock is not the worker's clock --------------------
  await test('EXECUTION: a supervised job is not bound to any model request', async () => {
    const home = isolate('decouple');
    await inHome(home, async () => {
      await supervisor.ensure();
      const app = fakeApp('sess-decouple', home);
      // The tool call returns immediately; the work keeps its own clock.
      const started = await jobTools.run_background.run(
        { command: runsFor(3), shell: SHELL, survive_restart: true },
        { app, cwd: home },
      );
      assert.ok(!started.isError, started.output);
      assert.strictEqual(started.meta.supervised, true, 'it must actually be supervised');

      const job = await supervisedJobState(started.meta.job);
      assert.ok(['running', 'queued'].includes(job.state), 'the worker is going');
      // Nothing about a model turn ending touches it.
      const after = await supervisedJobState(started.meta.job);
      assert.ok(['running', 'queued', 'completed'].includes(after.state));
      await supervisor.shutdown();
    });
  });

  // ---- §4: the window ends; nothing is assumed ----------------------------
  await test('EXECUTION: a reached deadline is REPORTED, not enforced as success or failure', async () => {
    const home = isolate('deadline');
    await inHome(home, async () => {
      await supervisor.ensure();
      const app = fakeApp('sess-deadline', home);
      // A two-second window around work that would run far longer.
      const started = await jobTools.run_background.run(
        { command: runsFor(60), shell: SHELL, for_seconds: 2 },
        { app, cwd: home },
      );
      assert.ok(!started.isError, started.output);

      const ev = await until(async () => {
        const r = await supervisor.events({ after: 0, limit: 100 });
        const hit = r.ok && r.events.find((e) => e.kind === 'JOB_DEADLINE_REACHED' && e.job_id === started.meta.job);
        return hit || null;
      });
      assert.ok(ev, 'the end of the window must reach the reasoning layer as an event');

      const job = await supervisedJobState(started.meta.job);
      assert.strictEqual(job.state, 'running', 'the worker must NOT have been killed by the deadline');
      assert.strictEqual(job.exit_code, null, 'and no exit status may be invented');
      assert.ok(job.deadline_reached_at, 'the observation is recorded on the job');

      // What the model is shown says the same thing in words.
      const shown = await jobTools.job_status.run({ id: started.meta.job }, { app });
      assert.ok(/EXECUTION WINDOW HAS ENDED/.test(shown.output), shown.output);
      assert.ok(/Nothing has been assumed/.test(shown.output));

      await jobTools.job_stop.run({ id: started.meta.job }, { app });
      await supervisor.shutdown();
    });
  });

  // ---- §5: failing BEFORE the window is its own event ---------------------
  await test('EXECUTION: a worker that fails before its deadline reports the time it had left', async () => {
    const home = isolate('earlyfail');
    await inHome(home, async () => {
      await supervisor.ensure();
      const app = fakeApp('sess-earlyfail', home);
      const started = await jobTools.run_background.run(
        { command: runsFor(1, 7), shell: SHELL, for_seconds: 600 },
        { app, cwd: home },
      );
      assert.ok(!started.isError, started.output);

      const ev = await until(async () => {
        const r = await supervisor.events({ after: 0, limit: 100 });
        const hit = r.ok && r.events.find((e) => e.kind === 'JOB_ERROR' && e.job_id === started.meta.job);
        return hit || null;
      });
      assert.ok(ev, 'a failure must reach the reasoning layer');
      assert.strictEqual(ev.exit_code, 7, 'with the real exit code');
      assert.ok(ev.deadline_remaining > 0, 'and with how much of the window was left');
      await supervisor.shutdown();
    });
  });

  // ---- §2: job_wait works against the authority ---------------------------
  await test('EXECUTION: job_wait collects a supervised job in ONE call', async () => {
    const home = isolate('wait');
    await inHome(home, async () => {
      await supervisor.ensure();
      const app = fakeApp('sess-wait', home);
      const started = await jobTools.run_background.run(
        { command: runsFor(2, 0), shell: SHELL, survive_restart: true },
        { app, cwd: home },
      );
      const waited = await jobTools.job_wait.run({ id: started.meta.job }, { app });
      assert.strictEqual(waited.meta.state, 'completed', waited.output);
      assert.ok(/supervised/.test(waited.output), 'and it says where the job lived');
      await supervisor.shutdown();
    });
  });

  // ---- §2 + §12: a NEW Node process finds the job, and Rust is authority ---
  await test('EXECUTION: a restarted LAIN finds the job it never started', async () => {
    const home = isolate('restart');
    const script = `
      process.env.LAIN_HOME = ${JSON.stringify(home)};
      const s = require(${JSON.stringify(path.join(ROOT, 'src', 'supervisor.js').replace(/\\/g, '/'))});
      (async () => {
        await s.ensure();
        const r = await s.submit({ command: ${JSON.stringify(runsFor(3, 0))}, shell: ${JSON.stringify(SHELL)},
                                   session: 'sess-restart', requestId: 'restart-1' });
        process.stdout.write(JSON.stringify({ id: r.job.id }));
        process.exit(0);
      })();
    `;
    const sub = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(sub.status, 0, sub.stderr);
    const { id } = JSON.parse(sub.stdout.trim());

    await inHome(home, async () => {
      // THIS process never started it and has no in-process record of it.
      const app = fakeApp('sess-restart', home);
      const seen = await jobTools.job_status.run({ id }, { app });
      assert.ok(!seen.isError, `a restarted LAIN must find it: ${seen.output}`);
      assert.strictEqual(seen.meta.supervised, true, 'and the supervisor is the authority for it');

      const done = await until(async () => {
        const j = await supervisedJobState(id);
        return j && j.state === 'completed' ? j : null;
      });
      assert.ok(done, 'and can collect the result');
      await supervisor.shutdown();
    });
  });

  // ---- §7 + §8: the replacement model is handed observed state -------------
  await test('EXECUTION: model failure hands the new model VERIFIED execution state', async () => {
    const home = isolate('takeover');
    await inHome(home, async () => {
      await supervisor.ensure();
      const app = fakeApp('sess-takeover', home);
      const started = await jobTools.run_background.run(
        { command: runsFor(1, 3), shell: SHELL, for_seconds: 300 },
        { app, cwd: home },
      );
      const failed = await until(async () => {
        const j = await supervisedJobState(started.meta.job);
        return j && j.state === 'failed' ? j : null;
      });
      assert.ok(failed, 'the worker failed on its own');

      // Model A died. Model B builds a handover out of what LAIN can observe.
      const session = {
        cwd: home,
        task: { objective: 'run the training for the requested window', steers: [] },
        lifecycle: { state: 'ACTIVE', evidence: { filesChanged: new Set() }, lastCommand: null },
        turns: [{ model: 'model-A', stopReason: 'provider', steps: 9, actions: [] }],
        evidence: { digest: () => '' },
      };
      const packet = handover.build(session, { cwd: home, toModel: 'model-B', jobs: [failed] });
      assert.ok(/different model \(model-A\)/.test(packet));
      assert.ok(packet.includes(started.meta.job), `the job must be named:${NL}${packet}`);
      assert.ok(/failed/.test(packet), 'with its observed state');
      assert.ok(/only claimed/.test(packet), 'and the instruction not to inherit claims');
      await supervisor.shutdown();
    });
  });

  await test('EXECUTION: asking for survival without a supervisor REFUSES rather than pretending', async () => {
    const home = isolate('nosup');
    await inHome(home, async () => {
      const prevBin = process.env.LAIN_SUPERVISOR_BIN;
      process.env.LAIN_SUPERVISOR_BIN = path.join(home, 'does-not-exist.exe');
      try {
        const app = fakeApp('sess-nosup', home);
        const r = await jobTools.run_background.run(
          { command: runsFor(1), shell: SHELL, survive_restart: true },
          { app, cwd: home },
        );
        assert.ok(r.isError, 'it must not quietly run in-process instead');
        assert.ok(/supervisor is not available/.test(r.output), r.output);
      } finally {
        if (prevBin === undefined) delete process.env.LAIN_SUPERVISOR_BIN;
        else process.env.LAIN_SUPERVISOR_BIN = prevBin;
      }
    });
  });

  // ---- §9: A CONSULTED MODEL GRANTS NO EXECUTION, and must not start -----
  //
  // Checked here rather than beside the model-source tests because the property
  // being guarded is about THIS migration: the supervisor is a privileged
  // execution service, and the temptation once one exists is to let the second
  // opinion reach it. A consulted model — `/external`'s reviewer once, a web
  // chat source now — has no tools, no filesystem and no shell, it is TOLD so,
  // and a claim to have acted is flagged rather than passed through. Giving it
  // supervisor authority would add privilege where the design deliberately has
  // none.
  //
  // `/external` and its four modules are retired; what replaced them is
  // src/modelsource. The assertions are the same property, re-aimed.
  await test('CONSULT: a chat model source is granted no execution, and says so', () => {
    const contract = require('../../src/modelsource/contract');
    const ctx = require('../../src/modelsource/context');
    // It is TOLD it has nothing, in the payload that actually leaves.
    const built = ctx.build({ session: { cwd: ROOT, messages: [] } }, 'why is this slow?', { continuing: false });
    assert.match(built.text, /no tools, no filesystem and no shell/i,
      'the consulted model must be told it has none of them');
    // A claim to have acted is caught, whatever else the reply contains.
    assert.ok(contract.overclaims('FACT: the loader is fine. I ran the tests and they pass.'),
      'a claim to have executed must be flagged');
    assert.strictEqual(contract.overclaims('FACT: the loader reads JSON. RECOMMENDATION: check the writer.'), null,
      'and an honest reply must not be');
    // NOTHING IN THE WHOLE PACKAGE MAY REACH THE EXECUTION SERVICE — asserted
    // over every file rather than the two that happened to exist before, so a
    // module added later is covered by construction.
    const dir = path.join(ROOT, 'src', 'modelsource');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!/supervisor/i.test(src),
        `modelsource/${f} must not reach the supervisor — consultation is not execution authority`);
    }
    // AND NEITHER MAY THE DISPATCHER that puts a reply into the conversation.
    const disp = fs.readFileSync(path.join(ROOT, 'src', 'chatdispatch.js'), 'utf8');
    assert.ok(!/require\(['"]\.\/supervisor['"]\)/.test(disp), 'and neither may the dispatch path');
  });

  await test('CONSULT: an empty or malformed reply degrades to a failure, never an action', () => {
    const { result, STATUS } = require('../../src/modelsource/contract');
    // COMPLETED REQUIRES TEXT. A well-formed empty result is exactly how a
    // broken extraction comes to look like a working one, and it is refused at
    // the one place every source passes through.
    const empty = result({ source: 'chatgpt-web', model: 'gpt-x', status: STATUS.COMPLETED, text: '   ' });
    assert.strictEqual(empty.status, STATUS.FAILED);
    assert.match(empty.error, /no text/i);
    // And whatever the shape, it still carries provenance — so nothing can
    // enter the conversation without a record of who said it.
    assert.strictEqual(empty.provenance.sourceId, 'chatgpt-web');
    assert.strictEqual(empty.usage, null, 'a website publishes no authoritative usage');
  });

  async function supervisedJobState(id) {
    const r = await supervisor.status(id);
    return r && r.ok ? r.job : null;
  }
};
