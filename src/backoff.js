'use strict';

/**
 * WHEN TO TRY AGAIN — the retry schedule, and nothing else.
 *
 * Split out of turn.js, which had reached the god-object guard. The seam is a
 * real one rather than a convenient cut: this answers "how many times, and how
 * long between" and knows nothing about turns, sessions, providers, tools or
 * the conversation. It reads no state and holds none. turn.js decides WHETHER a
 * failure is worth retrying — that is errors.js's classification and the loop's
 * business — and asks here only for the delay.
 *
 * ------------------------------------------------------------------------
 * THIS IS NOT AN LLM RETRY LOOP, and that difference is the whole point.
 *
 * A 502 from a gateway says nothing about the task, the model or the tools — it
 * says the request did not arrive. So the SAME request is sent again: no new
 * objective, no re-planning, no tool replayed, no user turn consumed, and no
 * new reasoning turn of any kind. The conversation is untouched, because
 * nothing about it changed.
 */

/**
 * HOW MANY TIMES ONE MODEL REQUEST IS RETRIED WHEN THE TRANSPORT FAILS.
 *
 * WAS 2, which is enough for a hiccup and not enough for a gateway having a bad
 * thirty seconds. Configurable as `maxConnectionRetries`, and clamped by the
 * caller either way — a retry budget a config file can set to a thousand is a
 * spiral with a settings key.
 */
const MAX_RETRIES = 5;

/**
 * How long to wait before each attempt, in milliseconds.
 *
 * ESCALATING, because the two things that go wrong want opposite treatment: a
 * momentary reset is gone by the time you look again, and a restarting gateway
 * needs long enough to finish restarting. A flat delay serves neither — it is
 * either a wasted second or five attempts inside the outage.
 *
 * BOUNDED AND SHORT IN TOTAL: about twenty seconds across all five, which is
 * long enough to ride out a restart and short enough that a person watching
 * does not conclude LAIN has hung. `retryAfter` from the provider always wins
 * over this — a server that says when to come back has been believed.
 */
const BACKOFF_MS = [500, 1500, 3500, 7000, 8000];

/**
 * HOW MUCH OF EACH WAIT IS RANDOM. ±20%.
 *
 * A DETERMINISTIC BACKOFF SYNCHRONISES ITS CLIENTS, and that is the failure it
 * exists to prevent. Every LAIN pointed at one gateway computes the identical
 * schedule from the identical table, so a gateway that drops connections at t=0
 * is hit again by all of them at t=500, and again at t=2000 — the retry arrives
 * as a burst precisely when the thing it is retrying against is least able to
 * serve one, and a restart that would have finished gets knocked over by its
 * own clients. Spreading each wait breaks the lockstep.
 *
 * It is deliberately SMALL. The point is to decorrelate clients, not to make a
 * wait unpredictable to the person watching it: the status strip prints the
 * absolute time work resumes, and a wait that could run half again as long as
 * announced would make that number a guess. ±20% keeps the schedule honest.
 *
 * NOT APPLIED TO `retryAfter`. When a server states when to come back that is an
 * instruction rather than an estimate, and jittering it early only produces a
 * request the server has already said it would refuse. The caller uses
 * `retryAfter` unmodified when it is present; this is only for the schedule
 * LAIN invents for itself.
 */
const JITTER = 0.2;

/**
 * The delay before `attempt` (1-based), spread.
 *
 * CLAMPED PAST THE END OF THE TABLE, because `maxConnectionRetries` goes to 10
 * while the table has five rows: reading off the end would be `undefined`, and
 * the arithmetic below would turn that into `NaN` — a setTimeout of NaN fires
 * immediately, which is a retry storm dressed as a backoff.
 *
 * NEVER ZERO. A wait rounded down to nothing is not a wait.
 */
function backoffFor(attempt) {
  const base = BACKOFF_MS[Math.min(Math.max(1, attempt) - 1, BACKOFF_MS.length - 1)];
  const spread = base * JITTER;
  return Math.max(1, Math.round(base - spread + Math.random() * spread * 2));
}

module.exports = { MAX_RETRIES, BACKOFF_MS, JITTER, backoffFor };
