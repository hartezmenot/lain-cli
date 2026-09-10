'use strict';

/**
 * WHERE THE HARNESS MEETS THE REPL — the whole of the wiring, in one file.
 *
 * ------------------------------------------------------------------------
 * WHY THE SEAM IS A FILE AND NOT SIX LINES IN app.js.
 *
 * Two reasons, one architectural and one mechanical.
 *
 * The architectural one: the harness must be able to run without the CLI, and
 * the CLI must be able to run without the harness. Every line of glue that
 * lives inside `App.submit` is a line that makes one of those false. Kept here,
 * `app.js` calls three functions that each do nothing useful when the harness
 * is absent, and the harness has no idea an App exists.
 *
 * The mechanical one: `app.js` is at 698 lines against a 700-line architecture
 * guard, and that guard is not an inconvenience — it is the rule that stopped
 * this file's V1 ancestor reaching 17,511 lines.
 *
 * ------------------------------------------------------------------------
 * WHAT IT CONSUMES, AND WHAT IT REFUSES TO RE-DERIVE.
 *
 *   task.classify()      whether this input is the same task. CONSUMED via the
 *                        `verdict.sameTask` app.js already computed. There is
 *                        exactly one task-identity classifier in this program
 *                        and it is not this file.
 *   lifecycle state      whether the model is done, blocked, needs the person.
 *                        CONSUMED through `runtime.syncLifecycle`, which maps
 *                        and moves. Nothing here reads transcript text.
 *
 * The one judgement this file makes is the mapping from "a new task began" to
 * "open a harness task", and that is bookkeeping rather than an opinion.
 *
 * ------------------------------------------------------------------------
 * A MODEL SAYING "DONE" MOVES THE TASK TO VERIFYING, NOT TO PASSED.
 *
 * That is the entire behavioural change this wiring introduces, and it is
 * deliberately the smallest possible one: nothing is blocked, nothing is
 * refused, no extra request is made, and the conversation is untouched. What
 * changes is that the task record now says the work is UNPROVEN until a
 * contract has run — which is a fact that was previously nowhere.
 */

const { STATE } = require('./harness/state');
// The mode verdict is consumed, never re-derived — see beginTurn.
const modeId = require('./mode');

/**
 * ATTACH ONE. Lazy, because constructing it is cheap but not free, and a
 * one-shot `lain -p 'what is 2+2'` should not build a process manager.
 */
function harnessFor(app) {
  if (!app) return null;
  if (!app._harness) {
    const { Harness } = require('./harness');
    app._harness = Harness.forApp(app);
  }
  return app._harness;
}

/** The harness only if one already exists — for readers that must not create one. */
function existing(app) { return (app && app._harness) || null; }

/**
 * A TURN IS STARTING.
 *
 * A NEW task opens a task record and starts it. The SAME task carries on, and
 * a task that had already reached a verdict is REOPENED as a repair rather than
 * rewritten — a terminal state is never walked back (see harness/state.js), so
 * "it failed, I fixed it, it passed" keeps both halves.
 */
function beginTurn(app, verdict, text) {
  // ---- A CONVERSATION IS NOT A TASK -------------------------------------
  //
  // "hello", "what does this file do", "explain the routing" are CHAT and
  // EXPLAIN, and opening a task record for each would fill `.lain/tasks/` with
  // directories that have nothing to verify and no evidence to keep. Worse, it
  // would make `/tasks` useless — the list somebody scans for "what have I been
  // doing" is only worth reading if everything in it is work.
  //
  // The mode verdict is CONSUMED, not re-derived: mode.js already decided this,
  // deterministically and for free, when the input arrived. A task that is
  // already open carries on regardless — a question asked in the middle of real
  // work is part of that work.
  const chatty = verdict.mode === modeId.KIND.CHAT || verdict.mode === modeId.KIND.EXPLAIN;
  if (chatty && !existing(app)) return null;

  let h;
  try { h = harnessFor(app); } catch { return null; }
  if (!h) return null;
  const objective = (app.session.task && app.session.task.objective) || text;
  // LATEST, NOT ACTIVE, AND THE DIFFERENCE IS A REAL BUG THIS AVOIDS.
  // `activeId` is cleared the moment a task reaches a verdict, so `active()`
  // is null straight after a PASSED or FAILED one — and the next sentence about
  // the same objective would then have opened a fresh task with no `causedBy`,
  // silently losing the link between a failure and the work that fixed it. The
  // repair branch below is only reachable because this reads `latest()`.
  const live = h.runtime.latest();
  if (chatty && (!live || live.terminal)) return null;

  if (!verdict.sameTask || !live) {
    const task = h.begin({
      title: String(objective || text).replace(/\s+/g, ' ').slice(0, 100),
      objective,
      sessionId: app.session.id,
    });
    h.runtime.start(task.id, 'the person asked for something');
    return task;
  }
  if (live.terminal) {
    // THE SAME OBJECTIVE AFTER A VERDICT IS A REPAIR, and naming it as one is
    // what makes "two attempts" visible later. Silently reopening the old task
    // would erase the first verdict, which is the one worth keeping.
    const repair = h.runtime.repairFor(live.id, { title: `repair: ${live.title}` });
    if (repair) h.runtime.start(repair.id, 'the work continued after a verdict');
    return repair;
  }
  if (live.state === STATE.BLOCKED || live.state === STATE.VERIFYING) {
    h.runtime.resume(live.id, 'the person said something else');
  }
  return live;
}

/**
 * A TURN HAS ENDED.
 *
 * The lifecycle's verdict is handed over and mapped. Note what is NOT here:
 * nothing marks the task complete, because nothing in a turn can. `DONE` from
 * the lifecycle becomes VERIFYING, and only a verification contract moves it
 * past that.
 */
function endTurn(app, record = null) {
  const h = existing(app);
  if (!h) return null;
  const task = h.runtime.active();
  if (!task) return null;
  const life = app.session && app.session.lifecycle;
  if (!life) return null;
  const summary = life.summary ? life.summary() : { state: life.state, reason: '' };
  const mapped = h.runtime.syncLifecycle(task.id, summary.state, summary.reason || '');
  // ---- AND THE CLAIM ITSELF, WHICH THE LIFECYCLE DELIBERATELY DOES NOT ACT ON
  //
  // `lifecycle.complete()` only accepts DONE with real evidence, which is
  // right and is why a turn that ends with "all fixed" leaves the state
  // ACTIVE. That is the correct answer to "is the conversation over?" and the
  // wrong answer to "should this be checked?" — a task whose model has just
  // announced success is exactly the task worth proving, and leaving it
  // RUNNING means nothing ever asks.
  //
  // So the CLAIM moves the task to VERIFYING. It is not treated as evidence
  // and it cannot reach PASSED; it means "stop executing and go and prove it",
  // which is precisely what a claim is worth. `Lifecycle.claimsSuccess` is
  // CONSUMED — the closing-statement rule and its negation guard are older
  // than this file, and a second regex here would be the drift the
  // architecture guard exists to prevent.
  if (mapped && mapped.ok && h.runtime.get(task.id).state === STATE.RUNNING
      && record && require('./lifecycle').claimsSuccess(record.text)) {
    return h.runtime.verifying(task.id, 'the model reported success — the evidence decides');
  }
  return mapped;
}

/**
 * THE SESSION IS ENDING.
 *
 * Takes every managed process and browser down. This is the answer to the
 * orphaned-process incident in this repository's own history: ownership plus
 * one teardown, rather than a teardown per call site that a timeout can skip.
 */
async function shutdown(app) {
  const h = existing(app);
  if (!h) return;
  try { await h.shutdown(); } catch { /* the way out is never blocked by cleanup */ }
}

module.exports = { harnessFor, existing, beginTurn, endTurn, shutdown };
