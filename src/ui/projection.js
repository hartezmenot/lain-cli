'use strict';

/**
 * WHAT THE SCREEN IS TOLD — the projection of app state into a frame.
 *
 * Split out of ui/index.js, which had reached the god-object guard. The seam is
 * a real one and it is the one that matters most in this file: everything here
 * READS the application and returns a plain object. It mutates nothing, decides
 * nothing, and starts nothing.
 *
 * That is the rule the views depend on — "no derivation by model" — and keeping
 * it in its own module makes it checkable at a glance instead of being a
 * convention buried among the UI methods that DO change state (turn tracking,
 * interrupt handling, the ticker).
 *
 * NAMED `frameState`, NOT `snapshot`. There is already exactly one snapshot in
 * this program — checkpoint.js, which copies BYTES so `/undo` can put them back
 * — and an architecture guard enforces that there is only one. A second thing
 * wearing the word would not have broken anything on the day, and would have
 * made "restore the snapshot" ambiguous forever after.
 *
 * FREE FUNCTIONS OVER `ui`, not methods. The architecture guard requires an
 * extracted helper never to use `this`, and it is right to: a projection that
 * reaches back through `this` can quietly start depending on call order.
 */

const views = require('./views');
const termtitle = require('../termtitle');

function statusState(ui) {
  const turns = (ui.app.session && ui.app.session.turns) || [];
  const last = turns[turns.length - 1] || null;
  return {
    phase: ui.phase,
    phaseSince: ui.phaseSince,
    interrupting: ui.interrupting,
    interrupted: ui.interrupted,
    failed: ui.failed,
    retryCancelled: ui.retryCancelled,
    pendingCompletion: ui.app.pendingCompletion || null,
    // A DELIBERATE WAIT, so the strip can name it and count it down. Without
    // this a LAIN waiting four hours for a rate limit to clear is
    // indistinguishable from one that has died. See UI.waitForReset.
    waitingUntil: ui.waitingUntil || 0,
    waitingLabel: ui.waitingLabel || '',
    // WAITING ON A PERSON is a resting state the strip must carry, or it
    // reports the turn that asked the question as DONE.
    awaitingUser: (ui.app.session && ui.app.session.lifecycle
      && ui.app.session.lifecycle.state === 'NEEDS_USER')
      ? ui.app.session.lifecycle.reason : null,
    // A FAILING LAST CHECK, carried to the strip.
    //
    // Observed by driving the real CLI: the model said "All good, everything
    // works correctly now", the suite had just exited 1, LAIN printed the
    // contradiction into the conversation — and the strip still read
    // `✓ LAIN DONE`. Two surfaces disagreeing about one fact, and the one a
    // person reads at a glance was the wrong one. The strip is where "did
    // that work?" gets answered without reading anything.
    lastCheckFailed: (ui.app.session && ui.app.session.lifecycle
      && ui.app.session.lifecycle.lastCommand
      && ui.app.session.lifecycle.lastCommand.ok === false)
      ? ui.app.session.lifecycle.lastCommand : null,
    // THE PLAN IN HAND, not the last plan the session had. A retired plan is
    // still readable in the PLAN pane; it is no longer this turn's progress.
    //
    // STILL CARRIED, AND NO LONGER DRAWN BY THE STRIP. The bottom region used
    // to repeat the task banner's bar — the same three facts, twice on one
    // screen, competing for the same corner. `/copy` and the banner still read
    // this; see ui/status.js for what took its place above the caret.
    progress: views.progressOf(views.livePlan(ui.app.session)),
    // ---- WHAT THIS SESSION HAS COST -------------------------------------
    //
    // THE TOTALS ARE THE SESSION'S, not the turn's, because the question a
    // person asks of a status row is "what have I spent", not "what did that
    // one request cost". turnclose.js has already accumulated them.
    usage: (ui.app.session && ui.app.session.usage) || null,
    // AND THE REQUEST THAT IS OPEN RIGHT NOW, if its input side is known.
    //
    // Kept SEPARATE from the totals rather than added into them. It is not in
    // `session.usage` yet — the receipt has not arrived — so folding it in
    // would produce a number that goes DOWN when the request completes and the
    // real figure replaces the reading. Drawn as a `+`, which is what it is.
    liveUsage: ui.liveUsage || null,
    // Is a request open at all? Distinguishes "nothing is happening" from "a
    // request is in flight and this provider does not state its cost until it
    // finishes" — two very different things behind the same blank space.
    requestOpen: Boolean(ui.phase && (ui.phase.phase === 'WAITING_MODEL' || ui.phase.phase === 'RECEIVING')),
    steerQueued: Boolean(ui.app.steerQueue && ui.app.steerQueue.length),
    // THE PENDING TEXT ITSELF, not merely that some exists —. The region
    // shows what you typed, in the order you typed it, so you can see that
    // the sentence was caught and is waiting rather than lost.
    pending: (ui.app.steerQueue || []).slice(),
    // ---- WORK RUNNING BESIDE THE CONVERSATION ---------------------------
    //
    // SUMMARIES, not the live jobs. A projection hands the drawing layer a
    // snapshot of facts; handing it the objects themselves would let a redraw
    // read a job mid-transition and, worse, let a view reach back and change
    // one. See src/agentjob.js `summary`.
    jobs: ui.app.jobs ? ui.app.jobs.all().map((j) => j.summary()) : [],
    // THIS turn's calls while it runs, the last turn's once it has ended —
    // the trail is always about work that really happened.
    recent: ui.liveActions.length ? ui.liveActions : (last && last.actions) || [],
    // WHY IT STOPPED TRAVELS WITH THE COUNTS. Without it the strip said
    // `✓ DONE · 10 tool calls` about a turn that had been blocked for
    // producing no new evidence — the header said BLOCKED one region above
    // it, and the two disagreed about the same turn.
    lastTurn: last ? {
      toolCalls: last.toolCalls || 0,
      filesChanged: (last.mutations || []).length,
      stopReason: last.stopReason || null,
    } : null,
  };
}

/** Snapshot the app's EXISTING state for the views. No derivation by model. */
/**
 * THE MOST RECENT REQUEST'S COMPOSITION, or null.
 *
 * A turn keeps only its last few audits (turn.js MAX_AUDITS): this is a
 * diagnostic, not a log. The newest audit of the newest turn that has one is
 * what "the last request" means to somebody looking at a pane.
 */
function lastAuditOf(session) {
  const turns = (session && session.turns) || [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const a = turns[i] && turns[i].audits;
    if (Array.isArray(a) && a.length) return a[a.length - 1];
  }
  return null;
}

function frameState(ui) {
  const app = ui.app;
  let pc = {};
  try { pc = require('../provider').resolve({ ...app.cfg, _evidence: app.connectionEvidence }); } catch { pc = {}; }
  let providerStatus = null;
  try { providerStatus = app.availability.get(pc.connectionId || pc.provider || '').status; } catch { /* none */ }
  const life = app.session.lifecycle;
  const summary = life && life.summary ? life.summary() : null;
  return {
    cwd: app.session.cwd,
    session: app.session,
    plan: app.session.plan,
    lifecycle: life,
    checkpoints: app.checkpoints,
    outputs: ui.outputs,
    model: pc.canonicalModel || pc.model || app.cfg.model,
    provider: pc.provider,
    connection: pc.connectionId,
    effort: app.cfg.effort,
    providerStatus,
    readiness: ui.readiness(pc),
    evidence: app.session.evidence,
    // Cached per session — a shallow scan, never re-run on a keystroke.
    project: app.projectScan(),
    tree: app.projectTree(),
    toolCount: require('../tools').names().length,
    running: ui.running,
    /** Everything the LLM status strip above the INPUT draws. See ui/status.js. */
    llm: ui.statusState(),
    // ---- WHAT THE TOKEN PANE READS ---------------------------------------
    //
    // The same two fields the status strip uses, and the last request's
    // composition. `lastAudit` is measured in contextfit.js at the one place the
    // transmitted array exists — a breakdown produced anywhere else would be a
    // reconstruction, which is exactly what nobody could trust when the reported
    // figure was 330,000 tokens and no part of the system could say of what.
    liveUsage: ui.liveUsage || null,
    requestOpen: Boolean(ui.phase && (ui.phase.phase === 'WAITING_MODEL' || ui.phase.phase === 'RECEIVING')),
    lastAudit: lastAuditOf(app.session),
    liveActions: ui.liveActions,
    liveNarration: ui.liveNarration,
    liveNotes: ui.liveNotes,
    liveUser: ui.liveUser || null,
    liveFrom: ui.liveFrom || null,
    /**
     * THE ACTIVITY TIMELINE — the live operation and the diff window, if any.
     *
     * Passed as the SURFACE rather than as rows, because the rows depend on the
     * width the pane is drawn at and that is not known here. Reading it is a
     * pure call (ui/activity.js `rows`), so asking twice in one frame is free
     * and cannot advance the animation.
     */
    activity: ui.activity || null,
    extras: ui.extras,
    resumeToken: ui.lastSessionToken(),
    transcript: app.render.transcript,
    changedCount: ui.changedCount(),
    stats: summary ? {
      toolCalls: summary.toolCalls,
      filesChanged: summary.filesChanged,
      elapsedMs: ui.startedAt ? Date.now() - ui.startedAt : 0,
    } : null,
  };
}

/**
 * The most recent OTHER session, as its short token — an offer on the start
 * screen, never an action. Showing the current session's own id there would
 * be telling you how to resume the thing you are already in. Read once: the
 * set of saved sessions cannot change while this one is running.
 */
function lastSessionToken(ui) {
  if (ui._lastToken === undefined) {
    try {
      const { Session } = require('../session');
      const prev = Session.list(5).find((id) => id !== ui.app.session.id);
      ui._lastToken = prev ? Session.shortId(prev) : null;
    } catch { ui._lastToken = null; }
  }
  return ui._lastToken;
}

/** Credential readiness for the CURRENT route, kept distinct from availability. */
function readiness(ui, pc) {
  try {
    const id = (pc && pc.connectionId) || '';
    const base = id.includes(':') ? id.slice(0, id.indexOf(':')) : id;
    const c = ui.app.connections().find((x) => x.id === base || x.id === id);
    return c ? c.readiness : null;
  } catch { return null; }
}

/**
 * How many files this session changed. Counted from checkpoint bytes, which is
 * the same source the diff and files views read — never a separate tally that
 * could disagree with them.
 */
function changedCount(ui) {
  // Memoised on the number of checkpoints, because this runs on EVERY redraw
  // — including every keystroke — and computing it re-reads each changed file
  // from disk. Files only change through a mutating call, and a mutating call
  // always adds a checkpoint, so the entry count is a sound cache key.
  const n = (ui.app.checkpoints && ui.app.checkpoints.entries.length) || 0;
  if (ui._countKey === n) return ui._count;
  try {
    ui._count = require('./panes').changedFiles({ checkpoints: ui.app.checkpoints, cwd: ui.app.session.cwd }).length;
  } catch { ui._count = 0; }
  ui._countKey = n;
  return ui._count;
}

/**
 * Name the terminal tab after the project and the work.
 *
 * Driven from the same snapshot the screen draws, so it cannot describe a
 * different session than the one on screen, and it follows `/cwd` and
 * `/resume` for free. `termtitle.set` drops identical repeats, so calling
 * this on every redraw costs one string comparison.
 */
function title(ui, s) {
  const busy = Boolean(ui.phase || ui.busy);
  termtitle.update({
    folder: views.projectName(s.cwd),
    topic: s.session && s.session.task ? s.session.task.objective : '',
    busy,
  });
}

module.exports = { statusState, frameState, lastSessionToken, readiness, changedCount, title };