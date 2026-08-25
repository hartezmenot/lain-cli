'use strict';

/**
 * WHAT THE SUPERVISOR KNOWS, MIRRORED ONTO THE APP FOR SYNCHRONOUS READERS.
 *
 * ------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES, and it is a shape problem rather than a data one.
 *
 * Two facts live in the process that outlives LAIN — which background workers
 * are running, and which routes are shut — and both are wanted by code that
 * CANNOT AWAIT. `App.systemPrompt` is synchronous and builds a request; the
 * status strip redraws on a keystroke; `handover.build` composes a packet
 * without doing any I/O. A socket call in any of those would put a network
 * round trip on the path of a keypress.
 *
 * So the supervisor's answers are refreshed in the BACKGROUND into two fields
 * on the App, and every reader takes whatever is there. The worst case is a
 * handover that does not mention a job that finished four seconds ago, which is
 * exactly the behaviour LAIN had before a supervisor existed.
 *
 * ------------------------------------------------------------------------
 * THE ONE PLACE THAT AWAITS THEM, and why it is allowed to. A RECOVERY is
 * building a briefing, and a briefing assembled from a cache that has not
 * refreshed yet is the previous model's picture with a new heading. `refresh`
 * returns a promise for that caller alone; every other call site ignores it and
 * is unchanged. See inputgate.js, which also BOUNDS the wait — a wedged
 * supervisor must cost a recovery some latency and never the recovery itself.
 *
 * ------------------------------------------------------------------------
 * IT NEVER STARTS A SUPERVISOR. Opening a session, drawing a frame and building
 * a prompt are not reasons to spawn a process; the two moments that are —
 * submitting work, and observing a rate limit with a stated reset — are decided
 * in supervisor.js and providerhealth.js respectively. When nothing is running,
 * both fields go empty and stay empty, which is a true statement about what this
 * machine can currently be told.
 *
 * PLAIN FUNCTIONS OVER `app`, no `this`.
 */

/**
 * WORK THAT WAS RUNNING WHEN THIS PROCESS DID NOT EXIST.
 *
 * The one fact in a handover that cannot be recovered from the session or the
 * transcript: a worker may have finished, failed, or run out its window at a
 * moment when no LAIN was running at all.
 */
function jobs(app) {
  let sup;
  try { sup = require('./supervisor'); } catch { return; }
  if (!app) return;
  // Never STARTS one. A supervisor is started when work is actually submitted
  // to it, not because a session opened.
  let probe;
  try { probe = sup.probe(); } catch { return; }
  if (!probe.running) { app._supervisedJobs = []; return; }
  return Promise.resolve()
    .then(() => sup.list({ session: app.session && app.session.id }))
    .then((r) => { if (r && r.ok && Array.isArray(r.jobs)) app._supervisedJobs = r.jobs; })
    .catch(() => { /* the supervisor is not a dependency of this turn */ });
}

/**
 * WHICH ROUTES ARE SHUT. The reasoning about which of them survive a restart
 * lives in availability.js, next to the state it describes; this is only the
 * refresh.
 */
function providers(app, opts = {}) {
  return require('./providerhealth').refresh(app, opts);
}

/**
 * BOTH, for a caller that is about to describe the world.
 *
 * Bounded by `timeoutMs`, because the point of asking is to make a briefing
 * accurate and a briefing that never arrives is worse than a slightly stale one.
 */
function refresh(app, { timeoutMs = 2000 } = {}) {
  return Promise.race([
    Promise.all([
      Promise.resolve(jobs(app)).catch(() => {}),
      Promise.resolve(providers(app)).catch(() => {}),
    ]),
    new Promise((r) => setTimeout(r, Math.max(0, timeoutMs))),
  ]);
}

module.exports = { jobs, providers, refresh };
