'use strict';

/**
 * STARTING AGENT WORK WITHOUT THE PROMPT WAITING FOR IT.
 *
 * ------------------------------------------------------------------------
 * TWO WAYS IN, AND THEY ARE DELIBERATELY NOT THE SAME.
 *
 *   PRIMARY      the ordinary conversation. It owns `app.session`, it uses
 *                `app.submit` UNCHANGED, and everything that has always
 *                happened around a turn still happens: the live UI, the
 *                completion policy, the session save, the steer drain, the
 *                events bus. The ONLY difference is that src/repl.js no
 *                longer awaits it before taking the next line off the queue.
 *
 *   BACKGROUND   `/bg`. A second piece of work, running at the same time. It
 *                owns a FORKED session, so it can never interleave writes into
 *                the main `messages` array, and it drives `runTurn` directly
 *                with a compact consumer that updates the job record instead
 *                of the live turn surface.
 *
 * ONE EXECUTOR. Both paths run `runTurn` — there is no second agent loop here,
 * and this file contains no provider call, no tool dispatch and no retry
 * policy. What differs between them is WHICH SESSION is written to and WHICH
 * SURFACE the events are drawn on, which is exactly the seam the defect was
 * hiding behind.
 *
 * WHY BACKGROUND DOES NOT REUSE `submit`: almost everything `submit` does after
 * the turn is about the MAIN conversation — ending the live turn, deciding
 * whether the task is complete, saving the session, draining the steer queue.
 * A background job doing any of that would reach across into work it does not
 * own. It runs the turn and records the outcome; that is the whole of its job.
 *
 * ------------------------------------------------------------------------
 * NOTHING HERE POLLS. A job settles by resolving its promise (agentjob.js), the
 * screen redraws from an `onChange` callback, and `wait()` blocks on the
 * promise. There is no interval and no busy loop in this file or in that one.
 */

const { runTurn } = require('./turn');
const { Session } = require('./session');
const { STATE } = require('./jobs');

/**
 * THE OPTIONS A TURN IS RUN WITH — built once, for both paths.
 *
 * Extracted from `app.submit`, where it was an inline literal. Two copies of a
 * twelve-field executor configuration is precisely the kind of thing that
 * drifts: somebody adds an option to the foreground turn, the background one
 * quietly does without it, and the difference shows up months later as "it
 * behaves differently when I run it with /bg".
 *
 * Everything session-shaped is taken FROM THE SESSION PASSED IN, never from
 * `app.session` — that is what makes a forked job actually forked.
 */
function turnOptions(app, { session, signal, from = null, ask = null, onStatus = null, steer = null }) {
  return {
    cfg: { ...app.cfg, _evidence: app.connectionEvidence },
    // ---- TWO HALVES, NOT ONE STRING --------------------------------------
    //
    // The stable half becomes messages[0] and must not move; the changing half
    // rides at the tail of the wire. See promptparts.js for why, and for the
    // measurement. `app.systemPrompt` still exists and still returns the whole
    // thing for anything that wants it in one piece.
    ...(() => { const p = require('./promptparts').of(app); return { systemPrompt: p.stable, live: p.live }; })(),
    // CARRIED, not merely consumed. `from` shaped the system prompt and stopped
    // there, so the turn record had no idea who asked for it — and the feed,
    // which has to tell a person's request from LAIN continuing its own work,
    // had nothing to read. See turn.js `record.from`.
    from,
    signal,
    evidence: session.evidence,
    lifecycle: session.lifecycle,
    availability: app.availability,
    checkpoints: app.checkpoints,
    // THE ENVIRONMENT OWNS THE VOCABULARY, and the desktop tool reaches the
    // permission gate through this. One `app`, passed once — the literal this
    // replaced named it twice.
    app,
    ask,
    onStatus,
    steer,
  };
}

/**
 * THE ORDINARY CONVERSATION, STARTED AND NOT WAITED FOR.
 *
 * `app.submit` is called and deliberately NOT awaited. Its body runs
 * synchronously as far as its first `await`, which is past the line that
 * assigns `app.abort` — so by the time this returns, the controller Ctrl+C
 * reads is already in place and the job can adopt it. One signal, two ways to
 * send it.
 *
 * REFUSES A SECOND PRIMARY. Text typed while one is running becomes a steer
 * (src/repl.js), so this should never be reachable — which is exactly why it
 * is checked. An invariant that matters is worth stating twice.
 *
 * @returns {AgentJob|null} the job, or null if one already owns the session
 */
/**
 * Record a worker against the active task, if there is one.
 *
 * BEST EFFORT AND SILENT. A background job must not fail because the flight
 * recorder was busy, and a session with no harness task open (a chat, a
 * one-shot) simply records nothing.
 */
function noteAgent(app, entry) {
  try {
    const h = require('./harnesslink').existing(app);
    if (!h || !h.runtime.activeId) return;
    h.runtime.noteAgent(h.runtime.activeId, entry);
  } catch { /* the work is not a convenience; the record is */ }
}

function startPrimary(app, text, opts = {}) {
  if (app.jobs.primary()) return null;
  const job = app.jobs.create({ request: text, primary: true, session: app.session });
  job.state = STATE.RUNNING;
  job.startedAt = Date.now();
  // THE BUSY FLAG MOVED HERE FROM THE REPL LOOP, which used to bracket the
  // awaited turn with it. The loop no longer waits, so the only thing that
  // knows the work has begun is the job. `submit` still clears it when the turn
  // ends, exactly as before — one setter each side, in the two places that
  // actually know.
  if (app.ui.enabled) app.ui.setBusy(true);
  app.jobs.changed();

  // NO try/catch AROUND THIS CALL, and that is not an oversight. `submit` is
  // `async`, so nothing it does can throw synchronously — every failure inside
  // it, including one raised before its first await, arrives as a REJECTION and
  // is handled below. A catch here would be unreachable code pretending to be a
  // safety net, which is worse than no net: it reads as though the case is
  // covered somewhere it is not.
  const p = app.submit(text, opts);
  // The SAME controller the interrupt handler reads, so `/cancel 1` and Ctrl+C
  // are one mechanism rather than two that can disagree.
  if (app.abort) job.abort = app.abort;

  Promise.resolve(p).then(
    (record) => {
      // Cancelled beats finished: a turn that was aborted still returns, and
      // reporting that as success is the one reading a person would dispute.
      if (job.state === STATE.CANCELLED) return;
      job._finish(STATE.SUCCEEDED, { result: record || null });
    },
    (e) => {
      if (job.state === STATE.CANCELLED) return;
      job._finish(STATE.FAILED, { error: (e && e.message) || String(e) });
      // The REPL used to catch this. It no longer awaits the turn, so the
      // report belongs here — and it is a notice rather than a throw, because
      // a failed job must not end the session.
      try { app.render.notice('error', `job #${job.id} failed: ${job.error}`); } catch { /* no renderer */ }
    },
  ).then(() => app.jobs.changed());

  return job;
}

/**
 * SAYING A JOB FINISHED, WITHOUT SAYING IT THREE TIMES.
 *
 * ------------------------------------------------------------------------
 * ONE LINE PER JOB IS RIGHT UNTIL THREE END TOGETHER, and then it is three
 * lines about one moment:
 *
 *     job #1 completed
 *     job #2 completed
 *     job #3 completed
 *
 * which is a wall about nothing, arriving over whatever the person was reading.
 * Batched it is one line saying the same thing, pointing at where the detail is.
 *
 * THE WINDOW IS ONE TURN OF THE EVENT LOOP, not a duration to tune. Everything
 * that settles in the same tick is one announcement; anything later is a
 * genuinely separate event and gets its own line. Nothing polls, and a single
 * completion still reads as a single completion.
 *
 * UNREF'D, so a pending announcement can never be the reason a process stays up.
 */
let pendingSay = [];
let sayTimer = null;

function announce(app, job) {
  pendingSay.push(job);
  if (sayTimer) return;
  sayTimer = setTimeout(() => {
    const batch = pendingSay;
    pendingSay = [];
    sayTimer = null;
    try {
      if (batch.length === 1) {
        const j = batch[0];
        // ---- `Background #17 COMPLETED - run the integration suite` -------
        //
        // `Background`, not `job`, because that is the word `/bg` and `/ps`
        // use and a person should not have to learn that the two are the same
        // thing. And `COMPLETED`, never `PASSED`: this line is reporting that
        // the WORK ENDED, which is a fact this code has. Whether the work is
        // PROVED is the harness's verdict on the task, it needs evidence, and
        // announcing it here would be the shortcut harness/state.js exists to
        // refuse. `/bg` shows the verdict beside the row once there is one.
        if (j.state === STATE.SUCCEEDED) app.render.notice('info', `Background #${j.id} COMPLETED - ${String(j.request).slice(0, 60)}`);
        else if (j.state === STATE.FAILED) app.render.notice('warn', `Background #${j.id} FAILED - ${j.error}`);
        return;
      }
      const ok = batch.filter((j) => j.state === STATE.SUCCEEDED).length;
      const bad = batch.length - ok;
      const ids = batch.map((j) => '#' + j.id).join(' ');
      const what = bad ? `${ok} background task(s) completed, ${bad} failed` : `${batch.length} background tasks completed`;
      app.render.notice(bad ? 'warn' : 'info', `${what} - ${ids} · /bg`);
    } catch { /* no renderer is not a reason to leave a job unsettled */ }
  }, 0);
  if (sayTimer && typeof sayTimer.unref === 'function') sayTimer.unref();
}

/**
 * A FORKED SESSION — the same conversation so far, and a separate future.
 *
 * The background job can see what was discussed before it started, because a
 * request like "inspect the README too" is only meaningful in the context of
 * what "too" refers to. From that point the two diverge: the fork has its own
 * `messages`, its own evidence ledger and its own turns, so no write from
 * either can land in the middle of the other's tool protocol.
 *
 * THE MESSAGE OBJECTS ARE COPIED, not shared. They are append-only in practice,
 * but "in practice" is not a guarantee, and a folded or trimmed message in the
 * fork must not edit the main conversation's history.
 */
function forkSession(app) {
  const s = new Session({ cwd: app.session.cwd });
  s.messages = (app.session.messages || []).map((m) => ({ ...m }));
  // The task identity is inherited so the fork orients itself in the same work,
  // and nothing else is: the plan, the lifecycle and the actor log all belong
  // to the conversation that owns them.
  s.task = app.session.task ? { ...app.session.task } : null;
  s.mode = app.session.mode || null;
  return s;
}

/**
 * `/bg <request>` — a second piece of work, alongside the conversation.
 *
 * Drives `runTurn` directly. The consumer below is deliberately tiny: a
 * background job updates a RECORD, and the record is what the screen draws. It
 * must not touch the live turn surface, which belongs to the primary job.
 *
 * NO `ask`. A background job cannot open the interaction panel: the panel is a
 * single surface the user is looking at, and a job they are not watching
 * stealing it — over a half-typed line, for a question about work they had
 * moved on from — is worse than the job saying it needs an answer. `ask_user`
 * reports that it has no terminal, which is the same thing it already reports
 * in a pipe.
 */
function startBackground(app, text) {
  const session = forkSession(app);
  const job = app.jobs.create({ request: text, primary: false, session });
  job.state = STATE.RUNNING;
  job.startedAt = Date.now();
  app.jobs.changed();
  // ---- THE TASK RECORD IS TOLD A SECOND WORKER STARTED --------------------
  //
  // `/bg` forks a session and runs a whole turn beside the conversation, and
  // until now the only trace of that on the task's own record was whatever
  // tools it happened to call. The flight recorder is supposed to answer "who
  // did what" — an agent that appears only as an anonymous run of tool calls
  // makes that unanswerable the moment there are two of them.
  //
  // SCOPE, NOT INSTRUCTIONS. What is recorded is the request and the fact that
  // it has its own session; nothing here hands the worker anything, and the
  // harness has no opinion about what it does. See harness/record.js noteAgent.
  noteAgent(app, { name: `bg#${job.id}`, scope: String(text).slice(0, 200) });
  // ---- WHICH HARNESS TASK THIS WORK BELONGS TO --------------------------
  //
  // READ, NOT OPENED. `runtime.create` would set `activeId` and hijack the
  // conversation's own task, which is a change to how the harness attributes
  // everything — exactly the kind of thing the CLI layer must not do. So this
  // records the task that is ALREADY open, if one is, and nothing more.
  //
  // It is what lets `/bg` say `task PASSED` beside a finished row without
  // inventing a verdict: the state comes from `runtime.get(taskId).state`,
  // which only `settle()` can move to PASSED and only from evidence. With no
  // task open the field is null and `/bg` simply says the job COMPLETED.
  try {
    const h = require('./harnesslink').existing(app);
    job.taskId = (h && h.runtime.activeId) || null;
  } catch { job.taskId = null; }

  // A PER-JOB STEER QUEUE. `/steer <n>` puts words here and the turn takes them
  // at its next step boundary — the same mechanism the primary conversation
  // uses, pointed at a different job.
  job.steerQueue = [];

  const run = async () => {
    let record = null;
    for await (const ev of runTurn(session, text, turnOptions(app, {
      session,
      signal: job.abort.signal,
      from: 'background',
      // ---- IT CAN ASK, AND IT STILL CANNOT TAKE THE SCREEN ---------------
      //
      // The panel is a single surface the user is looking at, so a job they are
      // not watching must never open one — that part was always right. What was
      // wrong was the conclusion drawn from it: `ask: null` made the tool report
      // that there was no terminal, so a job that needed a decision GUESSED.
      //
      // Parking is the third option. The job holds, says so in its row, and the
      // foreground prompt is untouched — see agentjob.js `askUser` and the
      // `/answer` command. Nothing is drawn over anything the user is typing.
      ask: (q) => app.interaction
        ? require('./interaction').ask(app, q, job.abort.signal)
        : job.askUser(q && q.question, (q && q.options) || []),
      onStatus: (p) => {
        if (!p) return;
        job.phase = p.phase || p.word || null;
        job.detail = String(p.detail || p.tool || '').slice(0, 80);
        app.jobs.changed();
      },
      steer: () => {
        const take = job.steerQueue.slice();
        job.steerQueue.length = 0;
        return take;
      },
    }))) {
      if (!ev) continue;
      // WHAT A BACKGROUND JOB SHOWS, and it is one line at a time on purpose:
      // this is a thing you glance at while doing something else, not a second
      // transcript competing with the one you are reading.
      if (ev.type === 'tool_start') {
        job.detail = `${ev.name}${ev.input && ev.input.path ? ' ' + ev.input.path : ''}`.slice(0, 80);
        app.jobs.changed();
      } else if (ev.type === 'done') {
        record = ev.record || null;
      }
    }
    return record;
  };

  const launch = app.interaction
    ? () => require('./interaction').run(app, { ...require('./interaction').port(app), signal: job.abort.signal }, run)
    : run;
  launch().then(
    (record) => {
      if (job.state === STATE.CANCELLED) return;
      job._finish(STATE.SUCCEEDED, { result: record || null });
    },
    (e) => {
      if (job.state === STATE.CANCELLED) return;
      job._finish(STATE.FAILED, { error: (e && e.message) || String(e) });
    },
  ).then(() => {
    noteAgent(app, {
      name: `bg#${job.id}`,
      scope: String(text).slice(0, 200),
      outcome: String(job.state),
    });
    // IT SAYS SO, WITHOUT TAKING THE SCREEN. A notice lands in the feed where
    // the account of the session lives; it opens no panel and cannot interrupt
    // a half-typed line. Batched — see `announce`.
    announce(app, job);
    // ISOLATION IS THE POINT. A background job that fails must not end the
    // session, disturb the primary job, or leave an unhandled rejection — so
    // everything above settles the record and nothing rethrows.
    app.jobs.changed();
    // ---- THE JOB'S OWN ACCOUNT IS KEPT ----------------------------------
    //
    // The fork held the whole story — what it read, what it ran, what it found —
    // and nothing saved it, so `/jobs 2` could show a tool count and two
    // hundred characters and the rest was gone at exit. A background job you
    // cannot read afterwards is a background job you cannot trust.
    //
    // SAVED AS A SESSION, because that is what it is: the same `Session.save`
    // the conversation uses, writing the same shape to the same place. There is
    // no second transcript format and nothing new to keep in step — `/resume`
    // can already open one.
    try { job.session.save(); } catch { /* a job's account is best effort, like the main one */ }
    try { app.session.save(); } catch { /* the main session save is best effort */ }
  });

  return job;
}

module.exports = { turnOptions, startPrimary, startBackground, forkSession };
