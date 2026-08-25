'use strict';

/**
 * THE SEAM BETWEEN THIS PROCESS'S PROVIDER HEALTH AND THE DURABLE COPY.
 *
 * ------------------------------------------------------------------------
 * WHAT IS ON EACH SIDE, because the split is the design and not a filing
 * decision.
 *
 *   availability.js   what is true about a route, answered SYNCHRONOUSLY. It
 *                     is consulted immediately before a socket is opened, so
 *                     nothing in it may ever await; it also owns the rules for
 *                     which durable facts are still true after a restart, and
 *                     that reasoning belongs next to the state it describes.
 *   supervisor.js     the transport. One function per op, no policy.
 *   THIS FILE         the wiring, and the one judgement neither of the others
 *                     can make: when a fact is worth STARTING a process for.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS NOT IN app.js. It was, and app.js crossed the 700-line god-object
 * guard the moment it landed — the same guard `ratelimit.js` was lifted out
 * over. The subject is coherent on its own and the App only needs two verbs
 * from it, so it moves rather than being trimmed to fit.
 *
 * PLAIN FUNCTIONS OVER `app`, never methods, and nothing here uses `this`. The
 * architecture guard is explicit about this: an extraction that keeps a `this`
 * becomes `undefined` in strict mode and takes a turn down with it, in whatever
 * branch nothing routinely exercises — which for provider health is a real rate
 * limit at four in the morning.
 */

/**
 * SEND WHAT WE LEARN ABOUT A ROUTE TO THE PROCESS THAT WILL STILL BE HERE.
 *
 * `availability.js` learns provider health from requests that were happening
 * anyway; this carries what it learns across the process boundary so the next
 * LAIN does not have to buy the same fact again. Fire-and-forget on both sides —
 * see Availability._push, which swallows everything a sink can do wrong.
 *
 * ------------------------------------------------------------------------
 * WHEN IT IS WORTH STARTING A SUPERVISOR, which is the only judgement here.
 *
 * `app.refreshSupervisedJobs` is right that opening a session must not spawn a
 * process, and most of what flows through this sink is equally not worth one: a
 * successful request, or a connection refused, is true for about as long as this
 * process will live, and if no supervisor happens to be running the in-memory
 * copy loses nothing anybody will miss.
 *
 * EXACTLY ONE FACT IS WORTH IT: A RATE LIMIT WITH A STATED RESET. The provider
 * named a time that is very often hours away, it is the entire fact the durable
 * store exists to keep, and dropping it because nothing had been started yet
 * would leave the store empty at precisely the moment it would have paid for
 * itself. Everything else is recorded only if a supervisor is already listening.
 *
 * ------------------------------------------------------------------------
 * WHY A USER'S DECISION IS *NOT* ON THAT LIST, which is not obvious.
 *
 * "Disable this route" is the most durable-looking thing here, and persisting it
 * is genuinely better than not. It is still recorded when a supervisor is up,
 * and it survives a restart when it is. But `/provider disable` starting a Rust
 * process is the wrong trade twice over:
 *
 *   IT EXCEEDS THE ASK. Today a disable is session state — `availability.js`
 *   describes DISABLED and MAINTENANCE as "the user said so", and they have
 *   always cleared on restart. Making them durable is a behaviour change to a
 *   control nobody complained about, smuggled in beside a rate-limit fix.
 *
 *   IT SPAWNS A PROCESS FROM A UI COMMAND. Typing `/provider maintenance` should
 *   not start a background process on a machine that was not running one — and
 *   in a test suite it does it once per case and leaves each one behind.
 *
 * `/provider retry` is the clearest member of the same class: it means "forget
 * what you knew", and with nothing running there is nothing that knows anything,
 * so spawning a binary to record the absence of a fact is pure cost.
 */
function installSink(app) {
  let sup;
  try { sup = require('./supervisor'); } catch { return; }
  if (!app || !app.availability) return;

  /** Is one already up? `probe()` reads a file and a pid — it never opens a
   *  socket and never spawns anything, so this is free to ask. */
  const running = () => {
    try { return Boolean(sup.probe().running); } catch { return false; }
  };

  app.availability.sink = (id, ev) => {
    // A DECISION IS AN INSTRUCTION, NOT AN OBSERVATION, and the two take
    // different ops — see §19: a machine may report what it saw; only a person
    // may declare a route's state. Both are recorded when something is
    // listening, and neither starts a process — see the note above.
    if (ev && ev.decision === 'SET') {
      return running() ? sup.setProvider(id, ev.status, ev.reason) : undefined;
    }
    if (ev && ev.decision === 'CLEAR') return running() ? sup.clearProvider(id) : undefined;

    // THE ONE FACT WORTH STARTING A SUPERVISOR FOR.
    const durable = Number(ev && ev.resetAt) > 0 && String(ev.kind) === 'RATE_LIMITED';
    if (!durable && !running()) return undefined;

    let pc = {};
    try {
      pc = require('./provider').resolve({ ...app.cfg, _evidence: app.connectionEvidence });
    } catch { pc = {}; }

    return sup.noteProvider({
      connectionId: id,
      ok: Boolean(ev && ev.ok),
      kind: (ev && ev.kind) || '',
      reason: (ev && ev.reason) || '',
      // NAMED FOR THE ROW'S SAKE, not for the key's. The store is keyed by
      // connection; these two ride along so `/provider status` can say which
      // provider a bare connection id belongs to after a restart, when nothing
      // else in this process has met it yet.
      provider: pc.provider || '',
      model: (app.cfg && app.cfg.model) || '',
      resetAt: Number(ev && ev.resetAt) || 0,
      failureThreshold: app.availability.failureThreshold,
    });
  };
}

/**
 * WHICH DOORS WERE SHUT WHILE THIS PROCESS DID NOT EXIST.
 *
 * The same shape as `app.refreshSupervisedJobs` and for the same reason: a
 * system prompt is built synchronously and may never wait on a socket, so this
 * fills a cache in the background and every reader takes whatever is there. A
 * supervisor that is missing, unbuilt or wedged costs nothing, and the app
 * behaves exactly as it did before any of this existed.
 *
 * IT DOES NOT START ONE. Nothing has been learned at this point, so there is
 * nothing worth a process; the sink starts one when there is.
 *
 * `adopt` IS TRUE EXACTLY ONCE, at the start of the process. Every later refresh
 * reads the rows without hydrating: after that point the in-memory copy has seen
 * this session's own requests and is the fresher of the two, and re-adopting
 * would let a limit the user has since cleared walk back in.
 */
function refresh(app, { adopt = false } = {}) {
  let sup;
  try { sup = require('./supervisor'); } catch { return; }
  if (!app) return;
  let probe;
  try { probe = sup.probe(); } catch { return; }
  if (!probe.running) { app._supervisedProviders = []; return; }

  // RETURNED for the same reason app.refreshSupervisedJobs returns its promise:
  // a recovery needs the rows to have landed before it builds a packet around
  // them. Every other caller ignores it and is unchanged.
  return Promise.resolve()
    .then(() => sup.providers())
    .then((r) => {
      if (!r || !r.ok || !Array.isArray(r.providers)) return;
      app._supervisedProviders = r.providers;
      if (!adopt) return;
      // HYDRATED ONLY ONCE THE ROWS ARE ACTUALLY HERE. Which of them survive a
      // restart is decided in availability.js, where the reasoning lives next
      // to the state it is about.
      const took = app.availability.hydrate(r.providers);
      if (took.limited && app.ui && app.ui.enabled) {
        // SAY IT. It is a fact the user cannot otherwise see and it changes what
        // they should do next: a route they believe is fine is shut, and LAIN
        // knows when it opens.
        app.transient('info', took.limited === 1
          ? '1 route is still rate limited from an earlier session'
          : `${took.limited} routes are still rate limited from an earlier session`);
      }
    })
    .catch(() => { /* provider health is not a dependency of this turn */ });
}

module.exports = { installSink, refresh };
