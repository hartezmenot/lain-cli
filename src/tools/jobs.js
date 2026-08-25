'use strict';

/**
 * BACKGROUND WORK — the four tools that keep a long command from muting LAIN.
 *
 * `run_bash` waits, and for a 400-second suite that means the turn is parked
 * inside one tool call: nothing can be said, nothing asked, and the screen
 * cannot tell a running suite from a hung one.
 *
 * ------------------------------------------------------------------------
 * THE TRAP, AND WHY `job_wait` EXISTS.
 *
 * Give a model a job handle and the obvious thing it does is
 *
 *     start → job_status → job_status → job_status → …
 *
 * which is the same block paid one model turn at a time — strictly worse than
 * having waited. So `job_wait` BLOCKS ON THE CHILD'S OWN EXIT EVENT: one call,
 * one wake-up, no interval anywhere. The descriptions say plainly which tool to
 * reach for, because "there is a cheaper way" that a model cannot find is not a
 * cheaper way.
 *
 *     job_wait     you have nothing else to do → ONE call, sleeps until it ends
 *     job_status   you have something else to do → ask once, later
 */

const jobsMod = require('../jobs');
const { shellPrefix } = require('./shell');
const { via, KIND } = require('./via');

function jobsOf(app) {
  if (!app._jobs) {
    app._jobs = new jobsMod.Jobs({
      // Every chunk feeds the OUTPUT pane, so a running suite is watchable
      // instead of a blank pane that fills in at the end.
      onEvent: (job) => {
        if (!app.ui || !app.ui.enabled) return;
        app.ui.noteOutput(`${job.id} · ${job.command}`, job.tail(60), job.exitCode);
      },
    });
  }
  return app._jobs;
}

/**
 * START A COMMAND AS A JOB — the one place that turns a request into a child.
 *
 * `run_background` and `observe_start` both need this, and the alternative was
 * observe.js repeating the shell choice, the cwd and the timeout default. Two
 * copies of "which shell on this host" is exactly how a Windows session ends up
 * running one tool under PowerShell and the other under bash.
 *
 * @returns {{ok:boolean, job?:object, shell?:string, why?:string}}
 */
function startFor(app, ctx, { command, shell, timeoutMs, cwd } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, why: 'a command is required' };
  const want = String(shell || '').toLowerCase();
  const picked = ['bash', 'powershell', 'cmd'].includes(want)
    ? want
    : (process.platform === 'win32' ? 'powershell' : 'bash');
  // WHERE IT RUNS, resolved the same way the foreground tools resolve it — one
  // definition, so a job and a blocking command started in the same directory
  // genuinely are in the same directory.
  const where = require('./shell').resolveCwd(ctx || {}, { cwd });
  if (where.error) return { ok: false, why: where.error };
  const job = jobsOf(app).start({
    command: cmd,
    shell: shellPrefix(picked),
    cwd: where.cwd,
    timeoutMs: Number(timeoutMs) || undefined,
  });
  return { ok: true, job, shell: picked, cwd: where.cwd };
}

/**
 * ------------------------------------------------------------------------
 * TWO PLACES A JOB CAN LIVE, AND EXACTLY ONE AUTHORITY FOR EACH.
 *
 * An ordinary background job — a build, a test run, something that takes a
 * minute — belongs in this process, where `wait()` resolves on the child's own
 * exit event and costs nothing. That is unchanged and remains the default.
 *
 * Work that must SURVIVE this process is a different capability, and it is the
 * one Node cannot provide itself: a child of this process dies with it, so a
 * two-hour training run is over the moment LAIN is closed, crashes, or is
 * restarted to change a model. Those go to the supervisor (see supervisor.js),
 * which is a separate process that outlives us.
 *
 * IT IS REQUESTED, NOT GUESSED. `survive_restart` or an execution window makes a
 * job supervised; nothing else does. Routing every background command through a
 * second process would be "Rust everywhere" rather than Rust where its
 * guarantees are worth something, and it would put an IPC hop in front of
 * `npm test`.
 *
 * ONE AUTHORITY PER JOB. A supervised job's state is whatever the supervisor
 * says it is — this file never caches it, never decides a supervised job
 * finished, and never keeps a second copy that could disagree. Lookup order is
 * in-process first, then the supervisor, which is deterministic because a job
 * exists in exactly one of them.
 */
function supervisedWanted(input) {
  return Boolean(input && (input.survive_restart === true || Number(input.for_seconds) > 0));
}

function sup() {
  try { return require('../supervisor'); } catch { return null; }
}

/** Render a supervised job the way `describe` renders a local one. */
function describeSupervised(j) {
  const elapsed = j.finished_at && j.created_at ? j.finished_at - j.created_at : null;
  const head = j.state === 'running' || j.state === 'queued'
    ? `job ${j.id} is still ${j.state}`
    : `job ${j.id} ${j.state}${j.exit_code === null || j.exit_code === undefined ? '' : ` (exit ${j.exit_code})`}`
      + (elapsed !== null ? ` after ${elapsed}s` : '');
  const rows = [
    head,
    `${via(KIND.JOB)} supervised — this job outlives LAIN`,
    `command: ${j.command}`,
  ];
  if (j.deadline_at) {
    const left = j.deadline_at - Math.floor(Date.now() / 1000);
    rows.push(j.deadline_reached_at
      ? 'THE REQUESTED EXECUTION WINDOW HAS ENDED. Nothing has been assumed about whether the work succeeded — inspect it and decide.'
      : `execution window: ${left > 0 ? `${left}s remaining` : 'ended'}`);
  }
  if (j.error) rows.push(j.error);
  const tail = String(j.output || '').trim();
  const NL = String.fromCharCode(10);
  return rows.filter(Boolean).join(NL) + (tail ? NL + NL + tail : NL + '(no output yet)');
}

/** The supervised job with this id, or null. Never throws. */
async function supervisedJob(id) {
  const s = sup();
  if (!s) return null;
  try {
    const r = await s.status(id);
    return r && r.ok && r.job ? r.job : null;
  } catch { return null; }
}

const tools = {};

tools.run_background = {
  mutates: true,
  schema: {
    name: 'run_background',
    description:
      'Start a long command and KEEP WORKING while it runs — a test suite, a dev server, a build, '
      + 'a watcher. Returns a job id immediately; the command keeps going. '
      + 'Use this instead of run_bash whenever something takes more than a few seconds, so you can '
      + 'say what you are doing and answer the user while it runs. '
      + 'Then call job_wait (ONE call, sleeps until it finishes) — do NOT call job_status in a loop.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'the command line to run' },
        shell: { type: 'string', description: 'bash | powershell | cmd. Defaults to the best on this host.' },
        cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
        timeout_ms: { type: 'number', description: 'give up after this long. Default 30 minutes.' },
        survive_restart: {
          type: 'boolean',
          description: 'keep this job running even if LAIN exits, crashes, or its model is changed. '
            + 'Use for work measured in many minutes or hours — a training run, an overnight benchmark, '
            + 'a long watch. The job is handed to a supervisor process that outlives LAIN, and its result '
            + 'is still there when you come back.',
        },
        for_seconds: {
          type: 'number',
          description: 'the execution WINDOW the user asked for, e.g. 7200 for "run it for two hours". '
            + 'Implies survive_restart. When the window ends nothing is killed and nothing is assumed to '
            + 'have succeeded — you are told the window ended and you decide what to do.',
        },
      },
      required: ['command'],
    },
  },
  async run(input, ctx) {
    const app = ctx && ctx.app;
    if (!app) return { output: 'background jobs are not available in this context', isError: true };
    const command = String(input.command || '').trim();
    if (!command) return { output: 'run_background needs a command', isError: true };
    const { EVENT, busOf } = require('../events');

    // ---- WORK THAT MUST OUTLIVE THIS PROCESS ---------------------------
    //
    // Requested, never guessed — see the note above `supervisedWanted`. If the
    // supervisor is not built or will not start, this says so and does NOT
    // silently run the job in-process instead: a caller that asked for work to
    // survive a restart must not be told it will when it will not.
    if (supervisedWanted(input)) {
      const s = sup();
      const ready = s ? await s.ensure() : { running: false, why: 'the supervisor client is unavailable' };
      if (!ready.running) {
        return {
          output: `this job asked to survive a restart, and the supervisor is not available — ${ready.why}.`
            + ' Build it with `cargo build --release` in rust/lain-supervisor, or drop survive_restart'
            + ' to run it in-process (it will then end when LAIN does).',
          isError: true,
        };
      }
      const where = require('./shell').resolveCwd(ctx || {}, { cwd: input.cwd });
      if (where.error) return { output: where.error, isError: true };
      const forSeconds = Math.max(0, Math.floor(Number(input.for_seconds) || 0));
      const r = await s.submit({
        command,
        shell: String(input.shell || '').toLowerCase(),
        cwd: where.cwd,
        session: (app.session && app.session.id) || '',
        deadlineSecs: forSeconds,
      });
      if (!r || !r.ok) return { output: `the supervisor refused the job: ${(r && r.error) || 'unknown reason'}`, isError: true };
      busOf(app).emit(EVENT.JOB_STARTED, { id: r.job.id, command, shell: r.job.shell });
      if (typeof app.refreshSupervisedJobs === 'function') app.refreshSupervisedJobs();
      const window = forSeconds ? ` The execution window is ${forSeconds}s; when it ends you will be told, and nothing will be assumed about whether it worked.` : '';
      return {
        output: `${via(KIND.JOB)} supervised job ${r.job.id} started: ${command}`
          + `${String.fromCharCode(10)}It runs in a process that outlives LAIN — closing, crashing or switching model will not stop it.`
          + ` Collect it with job_wait id "${r.job.id}".${window}`,
        meta: { job: r.job.id, state: r.job.state, supervised: true },
      };
    }
    // ONE START PATH, shared with observe_start — see startFor. This used to
    // choose the shell here as well, which is two copies of "which shell on
    // this host" and one of them free to drift.
    const started = startFor(app, ctx, {
      command, shell: input.shell, timeoutMs: input.timeout_ms, cwd: input.cwd,
    });
    if (!started.ok) return { output: started.why, isError: true };
    const { job, shell } = started;
    // A LONG JOB IS THE ONE THING A COMPANION MOST NEEDS TO SHOW, because it is
    // the state where LAIN is legitimately quiet and a window with nothing in
    // it is indistinguishable from a window that has stopped working.
    busOf(app).emit(EVENT.JOB_STARTED, { id: job.id, command, shell });
    // ON ITS EXIT EVENT, not by polling — the job resolves its own waiters and
    // this rides the same promise. See jobs.js: there is no interval anywhere.
    Promise.resolve(job.wait()).then((s) => {
      busOf(app).emit(EVENT.JOB_COMPLETED, {
        id: job.id, state: s.state, exitCode: s.exitCode, command,
      });
    }).catch(() => {});
    return {
      output: `${via(KIND.JOB)} job ${job.id} started: ${command}\n`
        + 'It is running now — say what you are doing and carry on. '
        + `When you need the result, call job_wait with id "${job.id}" ONCE. `
        + 'Do not poll job_status repeatedly; job_wait sleeps until it finishes and costs one call.',
      meta: { job: job.id, state: job.state },
    };
  },
};

tools.job_wait = {
  mutates: false,
  schema: {
    name: 'job_wait',
    description:
      'Wait for a background job to finish and return its result. ONE call — it sleeps until the '
      + 'job actually ends, so it costs nothing while it waits. This is the right way to collect a '
      + 'job; polling job_status in a loop is not.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'the job id from run_background' },
        limit_ms: { type: 'number', description: 'stop waiting after this long and report it as still running' },
      },
      required: ['id'],
    },
  },
  async run(input, ctx) {
    const app = ctx && ctx.app;
    const job = app && app._jobs && app._jobs.get(input.id);
    if (job) {
      const s = await job.wait(Number(input.limit_ms) || null);
      return { output: describe(job, s), meta: { job: job.id, state: s.state } };
    }
    // ---- A SUPERVISED JOB IS WAITED ON WHERE IT ACTUALLY LIVES ---------
    //
    // There is no in-process child to resolve on, so this asks the authority.
    // It is still ONE model call however long it takes: the polling happens
    // inside this function, and the description's promise — one call, not a
    // loop of turns — is what actually matters to the caller.
    const svc = sup();
    if (svc) {
      const limit = Number(input.limit_ms) || 0;
      const deadline = limit > 0 ? Date.now() + limit : 0;
      let last = await supervisedJob(input.id);
      if (last) {
        while (last && (last.state === 'running' || last.state === 'queued')) {
          if (deadline && Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 1000));
          last = await supervisedJob(input.id);
        }
        if (last) return { output: describeSupervised(last), meta: { job: last.id, state: last.state, supervised: true } };
      }
    }
    return { output: `no job "${input.id}". Start one with run_background.`, isError: true };
  },
};

tools.job_status = {
  mutates: false,
  schema: {
    name: 'job_status',
    description:
      'What a background job is doing right now, with its recent output. Ask ONCE, when you have '
      + 'been doing something else and want to check. If you are only waiting for it, use job_wait '
      + 'instead — asking this repeatedly is a loop that costs a model turn each time. '
      + 'With no id, lists every job of this session.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'a job id, or omit for all of them' } },
    },
  },
  async run(input, ctx) {
    const app = ctx && ctx.app;
    const jobs = app && app._jobs;
    if (input.id) {
      const local = jobs && jobs.get(input.id);
      if (!local) {
        const sj = await supervisedJob(input.id);
        if (sj) return { output: describeSupervised(sj), meta: { job: sj.id, state: sj.state, supervised: true } };
        return { output: `no job "${input.id}".`, isError: true };
      }
      return { output: describe(local, local.summary()), meta: { job: local.id, state: local.state } };
    }
    // THE LISTING SPANS BOTH, because "which jobs are there" is one question.
    // Supervised rows are marked, so nobody has to infer where a job lives.
    let supervisedRows = [];
    const svc = sup();
    if (svc) {
      try {
        const r = await svc.list({ session: (app.session && app.session.id) || '' });
        if (r && r.ok && Array.isArray(r.jobs)) {
          supervisedRows = r.jobs.map((j) => {
            const el = (j.finished_at || Math.floor(Date.now() / 1000)) - j.created_at;
            return `${j.id}  ${String(j.state).padEnd(10)} ${el}s  ${String(j.command).slice(0, 50)}  [supervised]`;
          });
        }
      } catch { supervisedRows = []; }
    }
    if ((!jobs || !jobs.all().length) && !supervisedRows.length) {
      return { output: 'no background jobs have been started.' };
    }
    if (!input.id) {
      const rows = jobs.all().map((j) => {
        const s = j.summary();
        return `${s.id}  ${s.state.padEnd(10)} ${Math.round(s.elapsedMs / 1000)}s  ${s.command.slice(0, 60)}`;
      });
      return { output: rows.join('\n'), meta: { jobs: jobs.all().length } };
    }
    const job = jobs.get(input.id);
    if (!job) return { output: `no job "${input.id}".`, isError: true };
    return { output: describe(job, job.summary()), meta: { job: job.id, state: job.state } };
  },
};

tools.job_stop = {
  mutates: true,
  schema: {
    name: 'job_stop',
    description: 'Stop a background job that is still running. A stopped job keeps the output it produced.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'the job id' } },
      required: ['id'],
    },
  },
  async run(input, ctx) {
    const app = ctx && ctx.app;
    const job = app && app._jobs && app._jobs.get(input.id);
    if (!job) {
      // Cancellation of a supervised job is the supervisor's to perform: it owns
      // the process, and forgetting it here would leave the work running while
      // reporting it stopped.
      const svc = sup();
      if (svc) {
        const r = await svc.cancel(input.id);
        if (r && r.ok && r.job) {
          return { output: `job ${r.job.id} ${r.job.state}.`, meta: { job: r.job.id, state: r.job.state, supervised: true } };
        }
      }
      return { output: `no job "${input.id}".`, isError: true };
    }
    if (job.done) return { output: `job ${job.id} had already finished (${job.state}).` };
    const s = job.cancel('stopped by the model');
    return { output: `job ${job.id} stopped after ${Math.round(s.elapsedMs / 1000)}s.`, meta: { job: job.id, state: s.state } };
  },
};

/**
 * What a job's result reads like.
 *
 * THE TAIL, NOT THE WHOLE STREAM. A test suite's last forty lines carry the
 * failures and the totals; its first four hundred carry the names of everything
 * that passed. Sending all of it back would undo the point of running it in the
 * background — OUTPUT has the complete stream for a person to scroll.
 */
function describe(job, s) {
  const secs = Math.round(s.elapsedMs / 1000);
  const head = s.done
    ? `job ${s.id} ${s.state}${s.exitCode === null ? '' : ` (exit ${s.exitCode})`} after ${secs}s`
    : `job ${s.id} is still ${s.state} after ${secs}s`;
  const body = job.tail(40).trim();
  return [
    head,
    //: WHICH MECHANISM RAN IT. A background job is the fourth way LAIN can
    // run something and was the one with no stamp at all, so its output was
    // indistinguishable from a foreground shell call in the transcript.
    via(KIND.JOB),
    `command: ${s.command}`,
    s.truncated ? '[output was truncated; the full stream is in OUTPUT]' : '',
    body ? `\n${body}` : '(no output yet)',
  ].filter(Boolean).join('\n');
}

module.exports = { tools, jobsOf, startFor, describe };
