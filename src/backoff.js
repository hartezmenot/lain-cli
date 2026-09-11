'use strict';

/**
 * WHEN TO TRY AGAIN — the retry schedule, and nothing else.
 *
 * Split out of turn.js, which had reached the god-object guard. The seam is a
 * real one rather than a convenient cut: this answers "how many times, and how
 * long between" and knows nothing about turns, sessions, providers, tools or
 * the conversation. It reads no state and holds none. The CALLER decides
 * WHETHER a failure is worth retrying — that is errors.js's classification —
 * and asks here only for the delay.
 *
 * ------------------------------------------------------------------------
 * THIS IS NOT AN LLM RETRY LOOP, and that difference is the whole point.
 *
 * A 502 from a gateway says nothing about the task, the model or the tools — it
 * says the request did not arrive. So the SAME request is sent again: no new
 * objective, no re-planning, no tool replayed, no user turn consumed, and no
 * new reasoning turn of any kind. The conversation is untouched, because
 * nothing about it changed.
 *
 * ------------------------------------------------------------------------
 * THE SCHEDULE WAS TOO AGGRESSIVE, MEASURED AGAINST A REAL PROVIDER.
 *
 * It was `[500, 1500, 3500, 7000, 8000]` across five attempts — about twenty
 * seconds in total, opening with a retry half a second after the failure. Two
 * things are wrong with that against a provider rate limiting an account:
 *
 *   IT HAMMERS. A 429 means "you are asking too often". Answering it 500ms
 *     later is asking too often again, and several of those inside twenty
 *     seconds can extend the limit rather than ride it out.
 *   IT FLICKERS. Each attempt paused and resumed the execution clock and
 *     flashed an amber alert, so five retries produced five pause/resume
 *     cycles in twenty seconds — a screen doing a great deal and saying
 *     nothing.
 *
 * The schedule below is the one the product brief fixes: ten attempts, opening
 * at ten seconds and reaching five minutes, about nineteen minutes in total.
 * Long enough to sit out a real rate limit; bounded, so it always ends.
 */

/**
 * HOW MANY TIMES ONE OPERATION IS RETRIED. Ten, and then it stops.
 *
 * THERE IS NO INFINITE RETRY. After the tenth wait the failure is handed back
 * to the existing failure semantics — settle, report, and require a person to
 * decide. A loop that never gives up is indistinguishable from a hang, and it
 * is the one shape that can keep an outage alive by feeding it.
 */
const MAX_RETRIES = 10;

/**
 * HOW LONG TO WAIT BEFORE EACH ATTEMPT, in milliseconds. 1-based by attempt.
 *
 *   1   10s      a real pause, not a reflex
 *   2   15s
 *   3   30s
 *   4   45s
 *   5   60s
 *   6   90s
 *   7   120s
 *   8   180s
 *   9   300s     five minutes is where it stops growing
 *   10  300s
 *
 * ESCALATING, because the two things that go wrong want opposite treatment: a
 * momentary reset is gone by the time you look again, and a rate limit or a
 * restarting gateway needs long enough to actually clear.
 */
const BACKOFF_MS = [
  10_000, 15_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 300_000, 300_000,
];

/**
 * NO JITTER, AND THAT IS A REVERSAL WORTH STATING.
 *
 * The previous schedule spread each wait by ±20% to stop many clients pointed
 * at one gateway retrying in lockstep. The argument was sound for a 500ms
 * first retry, where the whole schedule fits inside one restart and every
 * client lands on the same millisecond.
 *
 * It stops being worth its cost here. The delays are now tens of seconds to
 * minutes, so arrival times are already spread by far more than ±20% of a
 * short wait ever was — clients differ by when their request failed, not by a
 * random offset. And the cost is real: the strip promises "retry 3/10 in 30s"
 * and prints an absolute resume time, and a wait that could run to 36s makes
 * both of those a guess. An exact schedule is a schedule a person can plan
 * around, and one a test can assert.
 */
const JITTER = 0;

/**
 * THE SCHEDULE A TEST RUNS AGAINST, when one asks.
 *
 * `opts.timers` (see turn.js) is the seam for an in-process test. A SMOKE
 * drives the real binary in another process and has no way to inject anything,
 * so the schedule that would make it take nineteen minutes is overridable by
 * environment — the same mechanism `LAIN_FORCE_TUI`, `LAIN_MOCK_SCRIPT` and
 * `LAIN_CONFIG_DIR` already use to make the real binary testable.
 *
 * IT CHANGES NOTHING IN PRODUCTION. Nothing sets this variable; an absent or
 * malformed value falls straight back to `BACKOFF_MS`, and the attempt COUNT
 * is untouched either way.
 */
function scheduleTable() {
  const raw = process.env.LAIN_BACKOFF_MS;
  if (!raw) return BACKOFF_MS;
  const parsed = String(raw).split(',')
    .map((n) => Number(String(n).trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : BACKOFF_MS;
}

/** The scheduled delay for `attempt` (1-based), exact. */
function scheduleFor(attempt) {
  const table = scheduleTable();
  const i = Math.min(Math.max(1, Math.floor(Number(attempt) || 1)) - 1, table.length - 1);
  return table[i];
}

/**
 * THE DELAY ACTUALLY USED — the schedule, or the provider's instruction,
 * whichever is LONGER.
 *
 * ------------------------------------------------------------------------
 * `MAX`, NOT "THE PROVIDER ALWAYS WINS". This is the correction §18 asks for.
 *
 * The old rule was `failure.retryAfterMs || backoffFor(retries)` — the
 * provider's number, unconditionally, whenever it sent one. That is right in
 * one direction and wrong in the other:
 *
 *   provider says 60s, schedule says 10s   →  wait 60s. Obeying a server that
 *                                             says when to come back.
 *   provider says 2s, schedule says 10s    →  wait 10s. A `reset-after: 2`
 *                                             from a rate limiter is often the
 *                                             window rolling, not permission
 *                                             to resume — and answering a 429
 *                                             two seconds later is exactly the
 *                                             hammering this schedule exists to
 *                                             stop.
 *
 * So the provider can only ever make LAIN wait LONGER, never shorter.
 *
 * A MALFORMED HINT IS IGNORED RATHER THAN TRUSTED. Not a number, negative, or
 * absurd (a header claiming a full day) falls back to the schedule — silently,
 * because a caller cannot do anything useful with "the provider sent nonsense"
 * and the schedule is a safe answer either way.
 */
const MAX_TRUSTED_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

function effectiveDelay(attempt, retryAfterMs = null) {
  const scheduled = scheduleFor(attempt);
  const hinted = Number(retryAfterMs);
  const trustworthy = Number.isFinite(hinted) && hinted > 0 && hinted <= MAX_TRUSTED_RETRY_AFTER_MS;
  return trustworthy ? Math.max(scheduled, Math.round(hinted)) : scheduled;
}

/**
 * The delay before `attempt` (1-based).
 *
 * Kept under its original name because turn.js and its tests call it, and
 * because "what is the backoff for attempt N" is still exactly the question.
 * It is now the exact schedule — see JITTER.
 */
function backoffFor(attempt, retryAfterMs = null) {
  return effectiveDelay(attempt, retryAfterMs);
}

/** The whole schedule as seconds, for a status surface or a test. */
function scheduleSeconds() {
  return scheduleTable().map((ms) => Math.round(ms / 1000));
}

/**
 * AN ABORTABLE WAIT — `await sleep(ms, signal)`.
 *
 * ABORT RESOLVES, IT DOES NOT REJECT. Escape during a rate-limit wait, or a
 * person typing `continue`, is not an error — it is the user declining to
 * wait — and the caller checks the signal afterwards to tell the two endings
 * apart. The listener is removed either way, so a long session cannot
 * accumulate one per retry.
 *
 * `timers` IS INJECTABLE so the schedule can be tested without spending
 * nineteen real minutes proving it. Production passes nothing.
 */
function sleep(ms, signal, timers = null) {
  const setT = timers && timers.setTimeout ? timers.setTimeout : setTimeout;
  const clearT = timers && timers.clearTimeout ? timers.clearTimeout : clearTimeout;
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setT(done, ms);
    function done() {
      clearT(t);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

module.exports = {
  MAX_RETRIES, BACKOFF_MS, JITTER, MAX_TRUSTED_RETRY_AFTER_MS,
  backoffFor, scheduleFor, effectiveDelay, scheduleSeconds, scheduleTable, sleep,
};
