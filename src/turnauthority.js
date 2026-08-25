'use strict';

/**
 * TELLING THE RUNTIME THAT A TURN STARTED, AND HOW IT ENDED.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS A FILE AND NOT SIX LINES IN app.js. Two reasons, and the second
 * is the one that matters.
 *
 * The first is the god-object guard: app.js crossed it the moment this landed
 * inline, exactly as `ratelimit.js` and `providerhealth.js` did before it.
 *
 * The second is that the translation performed here is a real subject with real
 * judgement in it. `record.stopReason` is turnrecord.js's vocabulary — five
 * words about how a LOOP finished — and the Guardian's is about whether the next
 * sentence a person types may be sent. Those are different questions, and the
 * mapping between them is the whole of what this file contains. Left in app.js
 * it would read as glue; here it can be looked at, argued with, and tested.
 *
 * ------------------------------------------------------------------------
 * THE ONE JUDGEMENT: A CANCELLATION IS NOT A FAILURE.
 *
 * Every other bad ending — a dead provider, a step budget, a missing credential
 * — leaves work half-finished by something the person did not choose, and the
 * next thing they type deserves a briefing. `aborted` does not. They pressed
 * Ctrl+C; they know precisely what they stopped and why, and handing them a
 * recovery packet spends a request explaining their own decision back to them.
 *
 * The distinction is preserved by NAMING it here rather than by dropping the
 * ending: `aborted` goes to the Guardian as `aborted`, and guardian.rs decides
 * what that means. Node states facts; the runtime draws conclusions.
 *
 * PLAIN FUNCTIONS OVER `app`, no `this` — the shape every extracted helper in
 * this codebase follows, and for the reason providerhealth.js states.
 */

const guardian = require('./guardian');

/**
 * A turn is starting, and THIS process is answerable for it.
 *
 * The pid the Guardian records is the point of the call. It is the only evidence
 * it will later accept that nobody is going to finish this turn — a session file
 * cannot say "the process that was writing me was killed", because a killed
 * process writes nothing. See `effective` in guardian.rs.
 *
 * Free when no supervisor is running, and never awaited: a turn must not wait on
 * a socket to begin.
 */
function begin(app) {
  // WHAT IT IS CALLED, alongside what it is doing. One call site rather than
  // two: a session resumed by a NEW process has a runtime record older than the
  // process, and re-stating the name every turn is cheaper than remembering
  // whether this process has already done it.
  identify(app);
  const session = app && app.session;
  if (!session || !session.id) return;
  let pc = {};
  try {
    pc = require('./provider').resolve({ ...app.cfg, _evidence: app.connectionEvidence });
  } catch { pc = {}; }
  guardian.turnBegin(session.id, {
    turnId: `t${((session.turns || []).length) + 1}`,
    // THE MODEL IS SENT EVERY TIME, not only when it changes. Detecting the
    // change is the Guardian's job and it is the only party that can do it
    // across a restart — Node comparing against its own last value would miss
    // precisely the switch that happened while it was not running.
    model: pc.model || '',
    provider: pc.provider || '',
    connectionId: pc.connectionId || '',
  });
}

/**
 * HOW THE TURN ENDED, in the Guardian's terms.
 *
 * `record` may be null: that is a turn loop that THREW rather than reporting,
 * which is a turn that is over and that nobody knows the ending of. Recording
 * that as a completion would be the one lie that matters, because the next
 * sentence would then be delivered bare into whatever went wrong.
 */
function outcomeOf(record) {
  if (!record) return 'provider';
  const stop = String(record.stopReason || 'end');
  if (stop === 'end') return 'completed';
  if (stop === 'rate-limited') return 'rate_limited';
  // `aborted`, `provider`, `max-steps`, `no-credential` — passed through
  // unread. See the note above about who decides what they mean.
  return stop;
}

function end(app, record) {
  const session = app && app.session;
  if (!session || !session.id) return;
  // ---- WHAT THE TURN COST, BEFORE WHAT IT DID -----------------------------
  //
  // THE RECEIPT, and the counterpart to the live reading turnevents.js sends
  // while a request is open. Without it the runtime's totals stayed at zero on
  // every route that does not state usage early — which is most of them — and
  // `/runtime` reported a session that had apparently cost nothing.
  //
  // ORDERED BEFORE `turnEnd` deliberately: both go through the same per-session
  // stream, and a reader that sees the ending should already see the bill for
  // it. `live` is absent, so the far side ACCUMULATES rather than replaces —
  // see `usage_note` in guardian.rs on why those are two different operations.
  if (record && record.usage) guardian.noteUsage(session.id, record.usage);
  const f = record && record.providerFailure;
  guardian.turnEnd(session.id, {
    outcome: outcomeOf(record),
    // THE CLASSIFIED KIND, not the error text. errors.js already separated a
    // rate limit from an exhausted quota from a dead gateway, and re-deriving
    // that from a message on the far side of a socket would be a second, worse
    // copy of a classifier that already exists.
    kind: (f && f.kind) || '',
    reason: (f && f.message) || '',
  });
}

/**
 * ------------------------------------------------------------------------
 * WHAT THIS CONVERSATION IS, AND HOW FAR IT HAS GOT.
 *
 * Both are things only the CLI knows, and both are things a SECOND WINDOW has
 * no other way to learn. A person who leaves three LAINs working and then asks
 * a phone "which of these are still going?" is asking about sessions in
 * processes that phone cannot see; the runtime can answer only what these
 * calls put there.
 *
 * FIRE-AND-FORGET, both of them. Neither decides anything and neither is worth
 * making a turn wait on a socket for.
 */

const path = require('path');

/**
 * THE NAME A PERSON WOULD RECOGNISE.
 *
 * The directory the session is working in, which is what people call their
 * projects. Sent by the CLI rather than derived in the runtime: a runtime that
 * guessed a name from a path would be inventing one, and a session listed under
 * the wrong name is worse than one listed under an id.
 */
function identify(app) {
  const session = app && app.session;
  if (!session || !session.id) return;
  const cwd = String(app.cwd || session.cwd || '');
  guardian.identify(session.id, { name: cwd ? path.basename(cwd) : '', cwd });
}

/**
 * HOW FAR THROUGH, WHEN SOMETHING HAS COUNTED — AND NOT OTHERWISE.
 *
 * ------------------------------------------------------------------------
 * THE ONLY COUNTER LAIN ACTUALLY HAS is the plan: steps a model wrote down and
 * then marked done, one at a time, as it finished them. That is a real count of
 * real work, and it is reported with `source: 'plan'` so any screen showing a
 * percentage can say where the number came from.
 *
 * EVERYTHING ELSE REPORTS NO NUMBER. A turn with no plan sends the ACTIVITY and
 * an empty source, which clears any stale figure rather than leaving yesterday's
 * 80% on somebody's phone — see `progress_note` in guardian.rs. "RUNNING,
 * current: integration tests" is a better answer than an invented 47%.
 *
 * SENT ONLY WHEN IT CHANGES. `notePhase` fires several times a second inside a
 * busy turn, and a socket message per frame would be a spool.
 */
function reportProgress(app, phase) {
  const session = app && app.session;
  if (!session || !session.id) return;
  const plan = session.plan;
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const done = steps.length ? plan.completed.length : 0;
  const total = steps.length;
  const activity = String((phase && (phase.detail || phase.word || phase.phase)) || '');
  const key = `${done}/${total}|${activity}`;
  if (app._progressKey === key) return;
  app._progressKey = key;
  guardian.progress(session.id, {
    done,
    total,
    label: 'steps',
    // NO PLAN, NO SOURCE, NO NUMBER. The absence is the honest answer.
    source: total > 0 ? 'plan' : '',
    activity,
  });
}

module.exports = { begin, end, outcomeOf, identify, reportProgress };
