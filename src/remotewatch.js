'use strict';

/**
 * THE HAND THAT PICKS UP WHAT A PHONE PUT DOWN.
 *
 * ------------------------------------------------------------------------
 * WHY ANYTHING IS NEEDED HERE AT ALL.
 *
 * The runtime can record an intention — a continuation, a stop, a model switch
 * — and it cannot act on one. Running a model turn needs the transcript, the
 * tools, the credentials and the abort controller, and all four live in this
 * process. So the supervisor writes down what somebody asked for and THIS
 * decides when it is safe to do it.
 *
 * That division is the point of §7's list. A session is not a turn; a worker is
 * not a session; a runtime is not a CLI. The runtime owns the first three and
 * this owns the fourth, and neither pretends to the other's powers.
 *
 * ------------------------------------------------------------------------
 * IT IS A POLL, AND IT IS A POLL ON PURPOSE.
 *
 * A push would need the supervisor to hold an open connection to every attached
 * CLI, and to know when one died — which is precisely the thing that keeps
 * being hard, and which the owner-pid design exists to avoid needing. A local
 * socket question every two seconds costs about a millisecond and cannot leave
 * a CLI wedged waiting for a runtime that stopped.
 *
 * IT DOES NOT RUN WHEN THERE IS NOTHING TO WATCH FOR. No credential configured
 * means no timer at all — see `start`.
 *
 * ------------------------------------------------------------------------
 * NOTHING HERE IMPLEMENTS ANYTHING TWICE.
 *
 *     a continuation  -> inputgate.drainQueued, which is inputgate.recover
 *     a stop          -> app.abort.abort(), which is what Ctrl+C does
 *     a model switch  -> failover.targetOf + failover.apply, which is what a
 *                        steer naming a model does
 *
 * If any of those three improves, this improves with it.
 */

const guardian = require('./guardian');

/** How often to ask. Local socket, ~1ms, and a person waiting on a phone
 * notices two seconds far less than they notice never. */
const EVERY_MS = 2000;

/** Only these were queued by a surface with no prompt behind it. A steer the
 * user typed here is not this file's business. */
const REMOTE_KINDS = Object.freeze(['remote', 'telegram']);

/** One watcher per app. Held on the app rather than at module scope — two
 * sessions in one process must not share a timer, which is the rule
 * attempts.js states and the architecture guard enforces. */
function start(app) {
  if (!app || app._remoteWatch) return null;
  const timer = setInterval(() => {
    // A tick that throws must not kill the process: this runs on a timer, and
    // an unhandled rejection from a timer is the session ending under somebody
    // who was typing.
    Promise.resolve()
      .then(() => tick(app))
      .catch(() => { /* the next tick asks again */ });
  }, EVERY_MS);
  // UNREF'D: a background poll must never be the reason a CLI refuses to exit.
  if (typeof timer.unref === 'function') timer.unref();
  app._remoteWatch = timer;
  return timer;
}

function stop(app) {
  if (!app || !app._remoteWatch) return;
  clearInterval(app._remoteWatch);
  app._remoteWatch = null;
}

/**
 * ONE LOOK. Exported so the tests can drive it directly rather than waiting on
 * a timer, and so a caller can force a check at a moment it knows is quiet.
 */
async function tick(app) {
  const session = app && app.session;
  const id = session && session.id;
  if (!id || app.inputClosed) return;

  const state = await guardian.state(id);
  if (!state) return;                                   // no runtime, nothing to do

  const busy = Boolean(app.abort && !app.abort.signal.aborted) || app.dispatching > 0;

  // ---- 1. A STOP IS THE ONLY THING THAT ACTS DURING A TURN ---------------
  //
  // Everything else waits, because everything else would be starting work
  // while work is running. A stop is the opposite of starting work.
  if (state.stop_requested) {
    if (busy && app.abort && !app.abort.signal.aborted) {
      app.render.notice('warn', 'remote control asked for this turn to stop.');
      try { app.abort.abort(); } catch { /* already gone */ }
    }
    // CLEARED EITHER WAY. A request that found nothing to stop is spent — the
    // alternative is a flag that aborts a turn started minutes later by
    // somebody who never asked.
    guardian.stopClear(id);
    return;
  }
  if (busy) return;

  // ---- 2. A MODEL SWITCH, VALIDATED BY THE RUNTIME AND APPLIED HERE ------
  if (state.requested_model) {
    applyModel(app, String(state.requested_model));
    guardian.clearModel(id);
    // Deliberately no `return`: the switch and the continuation that usually
    // follows it should land in the same turn, which is the whole point of
    // arming the handover before the queue is drained.
  }

  // ---- 3. WHAT SOMEBODY QUEUED FROM SOMEWHERE ELSE ----------------------
  const held = Array.isArray(state.held) ? state.held : [];
  if (!held.some((h) => REMOTE_KINDS.includes(String(h && h.kind)))) return;
  await require('./inputgate').drainQueued(app);
}

/**
 * POINT THE SESSION AT ANOTHER ROUTE.
 *
 * `targetOf` is the same resolver a steer naming a model uses, and it REFUSES
 * to invent a route from a word it does not recognise — which matters more here
 * than anywhere, because the word arrived from a chat by way of a small model.
 * An unrecognised name changes nothing and says so.
 */
function applyModel(app, want) {
  const failover = require('./failover');
  let route = null;
  try { route = failover.targetOf(app, want); } catch { route = null; }
  if (!route) {
    app.render.notice('warn',
      `remote control asked to switch to "${want}", which matches no model or connection here. Nothing changed.`);
    return false;
  }
  const r = failover.apply(app, route);
  if (r.changed) {
    app.render.notice('info',
      `remote control switched this session to ${app.cfg.model} via ${app.cfg.connection}.`);
    if (app.ui && app.ui.enabled) app.ui.refresh();
  }
  return r.changed;
}

module.exports = { start, stop, tick, applyModel, EVERY_MS, REMOTE_KINDS };
