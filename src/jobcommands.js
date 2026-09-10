'use strict';

/**
 * `/jobs`, `/bg` and `/cancel` — the smallest interface to work in flight.
 *
 * ------------------------------------------------------------------------
 * WHAT THESE ARE FOR, and it is one question in four spellings: what is
 * happening that I am not looking at?
 *
 *     what is running?          /bg          (a glance)  ·  /jobs (the account)
 *     what is #1 doing?         /jobs 1
 *     did it finish? fail?      /bg          ·  /jobs 1
 *     what processes is it?     /ps
 *     stop it                   /bg stop 1   ·  /cancel 1
 *     start another one         /bg <request>
 *
 * DELIBERATELY NOT A JOB MANAGER. There is no pause, no resume, no priority, no
 * dependency and no scheduling. Those are the parts of a job subsystem that
 * exist because a job subsystem exists, rather than because anybody wanted
 * them.
 *
 * ------------------------------------------------------------------------
 * SAFE DURING A TURN, ALL THREE. That is the whole point: a command about work
 * in flight that could not be run while work was in flight would be useless.
 * They read a record and set a flag; none of them touches the session, the plan
 * or the working tree, which is what `DURING_TURN.BLOCKED` is actually for.
 *
 * ------------------------------------------------------------------------
 * `/bg` IS THE ONLY WAY TO GET A SECOND CONCURRENT JOB, and that is a decision
 * rather than an omission. Text typed while a job runs is a STEER — a
 * correction to the work you are watching — which is what it has always been
 * and what "also check the backend" almost always means. Starting a competing
 * job by accident, because a correction was misread as a new task, is a far
 * worse failure than having to type three characters when you did mean one.
 * See src/repl.js for the steer path and src/agentjob.js for why only one job
 * may own the conversation.
 */

const { STATE } = require('./jobs');
/** How much of a job's own account `/jobs <n>` shows. Enough to judge it by. */
const MAX_DETAIL_ACTIONS = 20;
const MAX_DETAIL_SAID = 6;
// `/steer` (moved here from commands.js) resolves a routing steer through the
// same owner it always did. One implementation, one file to read.
const failover = require('./failover');

/** Marks the row so a glance finds the one that is not going to change. */
function mark(job, C) {
  if (job.state === STATE.SUCCEEDED) return C.green('✓');
  if (job.state === STATE.FAILED) return C.yellow('✗');
  if (job.state === STATE.CANCELLED) return C.dim('■');
  return job.waiting ? C.yellow('◒') : C.cyan('●');
}

/**
 * HOW LONG A JOB HAS BEEN AT IT — `00:03:18`, the same shape as everything else.
 *
 * IT WAS `3m18s`, AND THAT WAS A SECOND VOCABULARY FOR ONE IDEA. The foreground
 * work clock above the caret reads `HH:MM:SS` (ui/workclock.js); a background job
 * read `3m18s`; both are elapsed time on the same screen, and a person comparing
 * "how long has this taken" against "how long has that taken" had to convert
 * between two formats to do it.
 *
 * SO IT IS THE SAME FUNCTION, not merely the same shape. `hhmmss` is imported
 * rather than reimplemented, which is what stops the two drifting the day one of
 * them grows an hours field and the other does not.
 *
 * THE CLOCKS THEMSELVES STAY SEPARATE. A job owns its own `elapsedMs` and the
 * foreground owns its own accumulator; this is only how both are spelled. A
 * background job running for an hour must not put an hour on the foreground row,
 * and it does not — see ui/projection.js on why a `/bg` task never holds the
 * spinner.
 */
const elapsedOf = (ms) => require('./ui/workclock').hhmmss(ms);

/** One row per job: what it is, what it is doing, how long it has been at it. */
function rows(app, C) {
  const all = app.jobs.all();
  if (!all.length) return [C.dim('  Nothing has been started yet.')];
  return all.map((j) => {
    const id = C.dim(`#${j.id}`);
    const state = j.state === STATE.SUCCEEDED ? C.green('COMPLETED')
      : j.state === STATE.FAILED ? C.yellow('FAILED')
        : j.state === STATE.CANCELLED ? C.dim('CANCELLED')
          : j.waiting ? C.yellow('WAITING') : C.cyan('RUNNING');
    const what = String(j.request).replace(/\s+/g, ' ').slice(0, 46);
    const where = j.primary ? '' : C.dim(' ·bg');
    return `  ${mark(j, C)} ${id} ${state}  ${what}${where}  ${C.dim(elapsedOf(j.elapsedMs))}`;
  });
}

/** Everything known about one job, for `/jobs <n>`. */
function detail(app, id, C) {
  const j = app.jobs.get(id);
  if (!j) return [C.dim(`  No job #${id}. /jobs to see what there is.`)];
  const out = [
    `  ${mark(j, C)} ${C.bold(`#${j.id}`)}  ${j.label}${j.primary ? C.dim('  (the conversation)') : C.dim('  (background)')}`,
    '',
    `  ${C.dim('request  ')} ${String(j.request).replace(/\s+/g, ' ').slice(0, 200)}`,
    `  ${C.dim('doing    ')} ${j.activity}`,
    `  ${C.dim('elapsed  ')} ${elapsedOf(j.elapsedMs)}`,
  ];
  if (j.needsInput) {
    out.push('', `  ${C.yellow('NEEDS INPUT')}  ${j.question.question}`);
    j.question.options.forEach((o, i) => out.push(`  ${C.dim(String(i + 1) + '.')} ${o}`));
    out.push('', C.dim(`  /answer ${j.id} <your answer>  — it resumes where it stopped`));
  }
  if (j.error) out.push(`  ${C.dim('why      ')} ${C.yellow(j.error)}`);
  const rec = j.result;
  if (rec) {
    const calls = rec.actions ? rec.actions.length : (rec.toolCalls || 0);
    out.push(`  ${C.dim('result   ')} ${calls} tool call(s)`);
    if (rec.text) out.push(`  ${C.dim('said     ')} ${String(rec.text).replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  // ---- THE WHOLE ACCOUNT, NOT A SUMMARY OF IT ---------------------------
  //
  // What it actually did, in order, read from the job's OWN session — which is
  // the same record the conversation keeps, so there is no second transcript
  // format here. The main ACTIVITY feed stays calm because this is on demand:
  // you ask for a job's story when you want it, rather than having two stories
  // interleaved in one pane. See the note in ui/jobsview.js.
  const acts = [];
  for (const t of (j.session && j.session.turns) || []) {
    for (const a of (t.actions || [])) acts.push(a);
  }
  if (acts.length) {
    out.push('', `  ${C.dim('WHAT IT DID')}`);
    for (const a of acts.slice(-MAX_DETAIL_ACTIONS)) {
      const mark = a.ok === false ? C.yellow('✗') : C.dim('·');
      out.push(`  ${mark} ${C.dim(String(a.name || '').padEnd(14))} ${String(a.target || '').slice(0, 60)}`);
    }
    if (acts.length > MAX_DETAIL_ACTIONS) {
      out.push(C.dim(`    … ${acts.length - MAX_DETAIL_ACTIONS} earlier operation(s) not shown`));
    }
  }
  const said = ((j.session && j.session.turns) || [])
    .flatMap((t) => (t.narration || []).map((n) => String(n.text || '')))
    .filter(Boolean);
  if (said.length) {
    out.push('', `  ${C.dim('WHAT IT SAID')}`);
    for (const line of said.slice(-MAX_DETAIL_SAID)) {
      out.push(`    ${String(line).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  if (j.session && j.session.id) out.push('', C.dim(`  its own session: ${j.session.id}`));
  if (!j.done) out.push('', C.dim(`  /cancel ${j.id} stops it · /steer ${j.id} <instruction> corrects it`));
  return out;
}

function register({ define, C }) {
  // ---- /steer MOVED HERE, UNCHANGED IN MEANING -------------------------
  //
  // It is the same subject as the three below: work in flight, and what you
  // can do to it while it is in flight. It kept every word of its behaviour -
  // bare `/steer <instruction>` still means the conversation you are watching,
  // and the routing form still routes - and gained one branch that lets a
  // NUMBER aim it at a background job. See the note inside it.
  //
  // The move also took commands.js back under the size guard, which is the
  // guard doing its job rather than a reason for the move.
/**
 * `/steer` — CORRECT THE WORK THAT IS ALREADY RUNNING.
 *
 * Not a second task and not a cancellation: the instruction is queued and the
 * turn loop hands it to the model between steps, before the next request. That
 * is the first moment a correction can land without arriving in the middle of a
 * tool call. SAFE during a turn by construction — it is the one command whose
 * entire purpose is to run during one.
 */
define('/steer', {
  // MACHINERY: LAIN talking about itself, not about the work. Goes to the
  // command panel, never into the conversation the model reads.
  surface: true,
  args: '<instruction>  ·  to <provider|model>  ·  routes',
  desc: 'Correct the running task at its next model turn, or move it to another provider/model',
  run(app, { rest }) {
    if (!rest) {
      app.render.write(C.dim('  Usage: /steer stop editing files and read the logs first\n'));
      return;
    }
    // A ROUTING STEER FIRST — and only when the words genuinely name a route.
    // `/steer to omniroute` moves the SAME MODEL to another provider, which is
    // a failover and not a model change; `/steer stop editing files` is what it
    // has always been. See failover.steer for how the two are told apart, and
    // why an unrecognised word stays an instruction rather than becoming a
    // route nobody asked for.
    const routed = failover.steer(app, rest);
    if (routed.handled) {
      app.render.write((routed.ok ? C.green(`  ${routed.message}`) : C.dim(`  ${routed.message}`)) + '\n');
      if (routed.detail) app.render.write(C.dim(`${routed.detail}\n`));
      return;
    }

    // ---- `/steer <n> <instruction>` REACHES A BACKGROUND JOB --------------
    //
    // ADDED WITHOUT MOVING THE DEFAULT. Bare `/steer <instruction>` still means
    // exactly what it always meant — the conversation you are watching — so
    // every existing use, every muscle memory and every test is unchanged. A
    // LEADING NUMBER is the only thing that redirects it, and only when a job
    // by that number actually exists: `/steer 2 read the files first` steers
    // job #2, while `/steer 2 spaces of indent, not 4` is an instruction that
    // happens to begin with a digit and is treated as one.
    //
    // A background job has its own steer queue for the same reason it has its
    // own session — see src/jobrunner.js. Its turn takes them at the next step
    // boundary, which is the identical mechanism pointed somewhere else.
    const aimed = /^(\d+)\s+(\S[\s\S]*)$/.exec(rest);
    if (aimed) {
      const job = app.jobs.get(aimed[1]);
      if (job && !job.primary && !job.done) {
        if (!Array.isArray(job.steerQueue)) job.steerQueue = [];
        job.steerQueue.push(aimed[2]);
        app.jobs.changed();
        app.render.write(C.green(`  ⚑ STEER #${job.id}`) + C.dim(' — queued for its next model turn\n'));
        app.render.write(C.dim(`    ${aimed[2]}\n`));
        return;
      }
      if (job && job.done) {
        app.render.write(C.dim(`  #${job.id} has already ${String(job.state).toLowerCase()} — nothing to steer.\n`));
        return;
      }
      // No job by that number: fall through and treat the whole thing as an
      // ordinary instruction, which is what it almost certainly is.
    }
    const running = Boolean(app.abort && !app.abort.signal.aborted);
    if (!running) {
      app.render.write(C.dim('  No active task to steer. Type the instruction on its own to start one.\n'));
      return;
    }
    // `NOW`, BECAUSE NAMING THE COMMAND IS THE DELIBERATE ACT. A bare sentence
    // typed during a turn is ambient and WAITS; `/steer` is the same intent as
    // pressing Enter a second time. Its description has always promised "at its
    // next model turn", which WAIT would quietly have stopped meaning.
    app.queueSteer(rest, 'NOW');
    app.render.write(C.green('  ⚑ STEER') + C.dim(' — queued for the next model turn\n'));
    app.render.write(C.dim(`    ${rest}\n`));
  },
});


  define('/jobs', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[<n>]',
    desc: 'What is running, and what it is doing',
    run(app, { args }) {
      const w = (s) => app.render.write(s + '\n');
      const lines = args && args[0] ? detail(app, args[0], C) : rows(app, C);
      for (const l of lines) w(l);
    },
  });

  /**
   * `/bg` — LAIN'S BACKGROUND WORK.
   *
   * ------------------------------------------------------------------------
   * IT CREATES NO SECOND EXECUTION SYSTEM. Every form below delegates:
   *
   *     /bg <instruction>   app.startBackground  ->  src/jobrunner.js
   *     /bg                 app.jobs             ->  src/agentjob.js
   *     /bg stop <id>       job.cancel           ->  the same cooperative stop
   *                                                  `/cancel` has always used
   *
   * `startBackground` opens an AgentJob with its own session and its own steer
   * queue, running the ordinary turn loop. Whether the work it then does
   * becomes a JOB or a SERVICE is decided by the tools it reaches for, using
   * semantics that already exist and are not re-implemented here:
   *
   *     `run the integration suite`   -> run_background  -> jobs.js
   *                                      a command that ENDS and yields a
   *                                      RESULT. QUEUED -> RUNNING -> SUCCEEDED
   *                                      / FAILED / CANCELLED / TIMED_OUT.
   *     `start the dev server`        -> service_start   -> harness/processes.js
   *                                      a process that STAYS UP and has a
   *                                      HEALTH, a port and an owning task.
   *
   * That distinction is spelled out at length in harness/processes.js and this
   * command does not get a vote in it. LAIN classifies by doing.
   *
   * ------------------------------------------------------------------------
   * `/bg` AND `/ps` ARE TWO ALTITUDES OF ONE THING.
   *
   *     /bg   LOGICAL work — what you asked for, what it is doing, whether it
   *           finished, and whether the finish was proved.
   *     /ps   PHYSICAL processes — the pids and services that work is currently
   *           made of.
   *
   * One request can be several processes, or none yet, or none any more. Which
   * is exactly why they are separate commands rather than one list.
   *
   * ------------------------------------------------------------------------
   * BACKGROUND IS NOT UNVERIFIED. A `/bg` task runs under the same harness
   * contract as the conversation: execution, then verification, then
   * settlement. A process exiting zero is not a verdict — the task reaches
   * PASSED only when its verification contract has the evidence, which is
   * harness/state.js's rule and not something this command can shortcut.
   * `/verify` and `/tasks` show the settled state.
   *
   * ------------------------------------------------------------------------
   * IT DOES NOT SPAM THE CONVERSATION. Starting one prints a single line and
   * hands the prompt straight back; the running account lives in the job's own
   * session and is reached with `/jobs <n>`. Progress and completion surface as
   * ONE ROW in the background region above the input (ui/jobsview.js), which is
   * event-driven — `app.jobs.changed()` redraws, nothing polls.
   */
  define('/bg', {
    surface: true,
    args: '[<instruction>]  ·  stop <id>',
    desc: 'Background work: start some, or see what is running',
    run(app, { rest }) {
      const w = (s) => app.render.write(s + '\n');
      const arg = String(rest || '').trim();

      // ---- BARE `/bg` IS A SUMMARY, NOT A USAGE MESSAGE -------------------
      //
      // It used to print `Usage: /bg inspect the README…`, which is the one
      // thing somebody typing `/bg` on its own almost never wants: they are
      // asking what is running, and being told how to start more is an answer
      // to a question they did not ask. The usage line is still here — it is
      // what an EMPTY list says, where it is the only useful thing to say.
      if (!arg) return void summary(app, C, w);

      const words = arg.split(/\s+/);
      if (words[0].toLowerCase() === 'stop') return void stop(app, C, w, words[1]);

      // ---- ANYTHING ELSE IS THE WORK ITSELF -------------------------------
      //
      // No parsing, no classification, no keyword table deciding "server" means
      // a service. The instruction goes to the model and the model reaches for
      // the tool that fits, which is the only classifier in this program that
      // has ever been right about an arbitrary sentence.
      const job = app.startBackground(arg);
      w(C.green(`  Background #${job.id} started`) + C.dim(`  ·  ${arg.replace(/\s+/g, ' ').slice(0, 60)}`));
      w(C.dim(`  Keep talking — /bg to check on it · /bg stop ${job.id} to end it`));
    },
  });

  define('/answer', {
    surface: true,
    args: '<n> <answer>',
    desc: 'Answer a background job that is waiting on you',
    run(app, { args, rest }) {
      const w = (t) => app.render.write(t + String.fromCharCode(10));
      const waiting = app.jobs.running().filter((j) => j.needsInput);
      // ONE WAITING JOB NEEDS NO NUMBER. Naming it is precision nobody needs
      // when there is only one thing it could mean.
      const first = args && args[0];
      const numbered = first && /^[0-9]+$/.test(first) ? app.jobs.get(first) : null;
      const job = numbered || (waiting.length === 1 ? waiting[0] : null);
      const text = numbered ? String(rest || '').replace(/^[ ]*[0-9]+[ ]*/, '') : String(rest || '');
      if (!job) {
        w(C.dim(waiting.length
          ? '  Which one? /jobs to see them, then /answer <n> <your answer>.'
          : '  Nothing is waiting on you.'));
        return;
      }
      if (!job.needsInput) { w(C.dim(`  #${job.id} is not waiting on you.`)); return; }
      if (!text.trim()) { w(C.dim(`  /answer ${job.id} <your answer>`)); return; }
      const q = job.question.question;
      job.reply(text.trim());
      app.jobs.changed();
      w(C.green(`  ✓ answered #${job.id}`) + C.dim(` — it resumes now`));
      w(C.dim(`    ${q}`));
      w(C.dim(`    ${text.trim()}`));
    },
  });

  define('/cancel', {
    surface: true,
    args: '<n>',
    desc: 'Stop a running job at its next safe point',
    run(app, { args }) {
      const w = (s) => app.render.write(s + '\n');
      const running = app.jobs.running();
      if (!args || !args[0]) {
        if (running.length === 1) return void cancelOne(app, running[0], C, w);
        w(C.dim(running.length ? '  Which one? /jobs to see them, then /cancel <n>.' : '  Nothing is running.'));
        return;
      }
      const j = app.jobs.get(args[0]);
      if (!j) { w(C.dim(`  No job #${args[0]}.`)); return; }
      cancelOne(app, j, C, w);
    },
  });
}

/**
 * BARE `/bg` — the LOGICAL background work, one row each.
 *
 *     Background
 *     #17  RUNNING   run the integration suite            2m14s
 *     #18  PASSED    start the frontend dev server          41s
 *
 * ------------------------------------------------------------------------
 * DELIBERATELY NOT `/ps`, AND DELIBERATELY NOT `/jobs`.
 *
 * `/ps` is the processes this work is currently MADE OF — pids, ports,
 * services. One row here can be several rows there, or none.
 *
 * `/jobs` is the full account, including the conversation itself and the whole
 * of what each job did and said. This is the glance: what did I ask for, is it
 * still going, and did it work.
 *
 * THE CONVERSATION IS NOT A ROW. `job.primary` is the work you are watching —
 * the feed IS its output and the live row above the input says what it is
 * doing. Repeating it here would be a fourth copy of the one thing hardest to
 * miss. Only work you are NOT looking at earns a row, which is the same rule
 * ui/jobsview.js follows for the same reason.
 *
 * ------------------------------------------------------------------------
 * `COMPLETED` IS NOT `PASSED`, AND THIS COLUMN NEVER CONFLATES THEM.
 *
 * The state column is the JOB's own lifecycle: the turn ended, or it failed, or
 * you stopped it. That is a fact this code has.
 *
 * Whether the WORK IS PROVED is a different question with a different owner.
 * The harness settles a task PASSED or FAILED from evidence — `settle()` is the
 * only thing in harness/runtime.js that can reach PASSED, and it only takes a
 * verification result. A background task that ran to completion has proved
 * nothing by doing so, and printing PASSED off a clean exit is precisely the
 * shortcut harness/state.js exists to refuse.
 *
 * So the verdict rides BESIDE the row, in the harness's own words, and only
 * once the task it belongs to is terminal: `COMPLETED  task PASSED`. With no
 * verdict yet, the row says COMPLETED and stops there — which is the honest
 * answer and the one that sends somebody to `/verify`.
 */
function summary(app, C, w) {
  const all = app.jobs.all().filter((j) => !j.primary);
  if (!all.length) {
    w(C.dim('  Nothing is running in the background.'));
    w('');
    w(C.dim('  /bg run the integration suite      a job — it ends and yields a result'));
    w(C.dim('  /bg start the frontend dev server  a service — it stays up'));
    w(C.dim('  Plain text works the conversation; /bg works beside it.'));
    return;
  }
  w('');
  w(C.bold('  Background'));
  for (const j of all) {
    const word = j.state === STATE.SUCCEEDED ? 'COMPLETED'
      : j.state === STATE.FAILED ? 'FAILED'
        : j.state === STATE.CANCELLED ? 'CANCELLED'
          : j.needsInput ? 'NEEDS INPUT' : j.waiting ? 'WAITING' : 'RUNNING';
    const state = word === 'COMPLETED' ? C.green(word)
      : word === 'FAILED' ? C.yellow(word)
        : word === 'CANCELLED' ? C.dim(word)
          : word === 'RUNNING' ? C.cyan(word) : C.yellow(word);
    const pad = ' '.repeat(Math.max(2, 13 - word.length));
    const verdict = settledState(app, j);
    const proof = verdict ? '  ' + tone(C, `task ${verdict}`) : '';
    w(`  ${mark(j, C)} ${C.dim(`#${j.id}`)}  ${state}${pad}${String(j.request).replace(/\s+/g, ' ').slice(0, 44)}  ${C.dim(elapsedOf(j.elapsedMs))}${proof}`);
    if (j.needsInput && j.question) w(C.dim(`         ${String(j.question.question).slice(0, 60)}`));
  }
  w('');
  w(C.dim('  /jobs <n> — the whole account · /bg stop <n> — end one · /ps — its processes'));
}

/**
 * The harness's verdict for the task this background work belongs to, or ''.
 *
 * READ, NEVER DERIVED. `job.taskId` is the task that was already open when the
 * work started (see jobrunner.startBackground — it reads `activeId` and never
 * opens one, because opening one would move the conversation's own task). The
 * state comes straight from the runtime, and only `settle()` puts a task in a
 * terminal state.
 *
 * A NON-TERMINAL TASK YIELDS NOTHING. RUNNING and VERIFYING are not verdicts,
 * and rendering them beside a finished job would read as one.
 */
function settledState(app, job) {
  try {
    const h = require('./harnesslink').existing(app);
    if (!h || !job.taskId) return '';
    const t = h.runtime.get(job.taskId);
    return t && t.terminal ? String(t.state) : '';
  } catch { return ''; }
}

function tone(C, state) {
  if (state === 'PASSED') return C.green(state);
  if (state === 'FAILED' || state === 'INCONCLUSIVE') return C.yellow(state);
  return C.dim(state);
}

/**
 * `/bg stop <id>` — the same cooperative stop `/cancel` has always performed.
 *
 * NOT A SECOND LIFECYCLE. It resolves the same AgentJob and calls the same
 * `cancelOne` below, so "stopped" means exactly what it has always meant: the
 * job ends at its next safe point, and anything it owns is taken down by the
 * process manager's cleanup for its task rather than by this command reaching
 * for pids.
 *
 * `/bg logs`, `/bg resume` and `/bg restart` are deliberately absent. They are
 * the parts of a job manager that exist because a job manager exists.
 */
function stop(app, C, w, id) {
  const running = app.jobs.running().filter((j) => !j.primary);
  if (!id) {
    // ONE RUNNING TASK NEEDS NO NUMBER — naming it is precision nobody needs
    // when there is only one thing it could mean. `/answer` reads the same way.
    if (running.length === 1) return void cancelOne(app, running[0], C, w);
    w(C.dim(running.length ? '  Which one? /bg to see them, then /bg stop <n>.' : '  Nothing is running in the background.'));
    return;
  }
  const j = app.jobs.get(id);
  if (!j) { w(C.dim(`  No background task #${id}. /bg to see what there is.`)); return; }
  if (j.primary) {
    // THE CONVERSATION IS NOT BACKGROUND WORK, and stopping it is Ctrl+C —
    // which is the key a person already has their hand on. Silently cancelling
    // the turn they are watching because they typed a number would be the
    // worst possible reading of an ambiguous command.
    w(C.dim('  #' + j.id + ' is the conversation, not background work. Ctrl+C stops the turn.'));
    return;
  }
  cancelOne(app, j, C, w);
}

/**
 * COOPERATIVE, and it says which. A job that had already finished is not an
 * error to report — it is a race the user lost by a second, and telling them it
 * "failed to cancel" would be describing their timing as a fault.
 */
function cancelOne(app, job, C, w) {
  if (job.done) { w(C.dim(`  #${job.id} had already ${String(job.state).toLowerCase()}.`)); return; }
  job.cancel('you cancelled it');
  app.jobs.changed();
  w(C.dim(`  ■ #${job.id} cancelled`) + C.dim(' — it stops at its next safe point'));
}

module.exports = { register, rows, detail, elapsedOf, summary, stop, settledState };
