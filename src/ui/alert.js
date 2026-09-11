'use strict';

/**
 * A STALE ALERT IS NOT THE NEWS — what an amber or red resting state means, and
 * what a new submission does to it.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS OWNS, STATED AS THE SCREEN SHOWED IT.
 *
 *     Ⅱ Rate limited · retry in 38s                     00:04:17
 *     > continue
 *     Ⅱ Rate limited · retry in 38s                     00:00:00
 *
 * Two things are wrong on the third line and they have different causes.
 *
 *   THE WORDS ARE THE PREVIOUS ATTEMPT'S. `waitingUntil` outranks every other
 *     branch of ui/status.js `liveState` — correctly, while the wait is real,
 *     because a four-hour silent screen is indistinguishable from a dead one.
 *     But nothing cleared it on submission, so a wait that a person had just
 *     overridden by hand kept the live row and covered the new turn's phases.
 *     The most specific true statement became the least true one.
 *
 *   THE CLOCK IS ZERO AND SHOULD NOT BE. `beginTurn` calls `workclock.start`
 *     unconditionally, and `start` is the one thing that zeroes the value. For
 *     a genuinely new task that is right. For `continue` after a pause it
 *     throws away four minutes of work that really happened and reports the
 *     same execution attempt as if it had just begun.
 *
 * ------------------------------------------------------------------------
 * THE RULE: AN ALERT BELONGS TO AN ATTEMPT, AND AN ATTEMPT CAN END.
 *
 * This is the same defect class as the one workclock.js documents in `apply` —
 * a previous turn's SUCCESS settling the current turn's clock on its first
 * frame. The shape is identical: state that outlived the attempt it described,
 * read by a projection that had no way to know it was stale. The cure is the
 * same too — scope it, and clear it at the ONE moment that knows a submission
 * happened.
 *
 * ------------------------------------------------------------------------
 * NOT EVERY RED IS THE SAME RED, AND THE CLOCK DEPENDS ON WHICH.
 *
 *   BLOCKED    the attempt is intact and something outside it must change: a
 *              credential was refused, the context is full, the provider is
 *              rate limiting. A person fixes it and says continue — that is
 *              the SAME execution attempt carrying on, so the clock CONTINUES
 *              from the banked figure.
 *
 *   TERMINAL   the attempt is over: the provider died mid-turn, or refused the
 *              request outright. `retry` is a NEW attempt and starts at
 *              00:00:00. The failed one stays failed in the record — rewriting
 *              it into RUNNING would make the evidence dishonest.
 *
 * UNKNOWN IS TERMINAL, DELIBERATELY. Guessing CONTINUE on a failure nobody
 * classified would fold a previous attempt's minutes into a new one and
 * over-report the work; guessing TERMINAL loses a figure that was already
 * banked. Over-reporting elapsed work is the lie that matters, so the default
 * goes the other way.
 *
 * ------------------------------------------------------------------------
 * WHAT IS NOT HERE. Rendering — ui/status.js `liveState` still decides what the
 * row says, and this never writes a word to the screen. And the transcript: an
 * alert is live operational state and must not be appended to the conversation
 * as WARN / NOTE / SYSTEM glue. ui/operation.js already made that argument for
 * housekeeping notes; this is the same boundary for failures.
 */

const { FAILURE } = require('./failure');

/** What a new submission does to the clock. */
const ATTEMPT = Object.freeze({
  /** A different task. Zero the clock — see workclock.start. */
  FRESH: 'fresh',
  /** The same attempt carrying on after a pause or a block. Resume banked work. */
  CONTINUE: 'continue',
  /** The same task, but the previous attempt is over. A new attempt from zero. */
  RESTART: 'restart',
});

/**
 * FAILURE KINDS THAT LEAVE THE ATTEMPT INTACT.
 *
 * Keyed by ui/failure.js `FAILURE` rather than by a second vocabulary invented
 * here — there is one failure taxonomy in this tree and this consumes it. A
 * kind absent from this set is terminal by omission, which is the safe
 * direction (see the header).
 */
const BLOCKED_KINDS = new Set(['RATE_LIMITED', 'AUTH', 'CONTEXT_LIMIT']);

/**
 * IS THIS FAILURE RECOVERABLE WITHOUT STARTING OVER?
 *
 * `ui.failed` may be a boolean or the provider-failure object. A bare `true`
 * carries no kind, so it cannot be shown to be blocked and is treated as
 * terminal — the same safe direction as UNKNOWN.
 */
function blocked(failed) {
  if (!failed || typeof failed !== 'object') return false;
  const kind = String(failed.kind || '');
  return BLOCKED_KINDS.has(kind) && Object.prototype.hasOwnProperty.call(FAILURE, kind);
}

/**
 * THE RESTING ALERT, IF THERE IS ONE — a reading, not the state itself.
 *
 * Ordered to match `liveState`'s own precedence so the two cannot disagree
 * about which alert is resting. Each answers three questions: what colour a
 * person is looking at, whether the attempt behind it survived, and one short
 * word for a test to assert against.
 */
function resting(ui, now = Date.now()) {
  const none = { level: null, word: '', resumable: false, terminal: false };
  if (!ui) return none;
  if (ui.waitingUntil && ui.waitingUntil > now) {
    return { level: 'amber', word: 'WAITING FOR LIMIT RESET', resumable: true, terminal: false };
  }
  if (ui.interrupting) return { level: 'amber', word: 'INTERRUPTING', resumable: true, terminal: false };
  if (ui.retryCancelled) return { level: 'amber', word: 'RETRY CANCELLED', resumable: true, terminal: false };
  if (ui.interrupted) return { level: 'amber', word: 'INTERRUPTED', resumable: true, terminal: false };
  if (ui.failed) {
    const soft = blocked(ui.failed);
    return { level: 'red', word: soft ? 'BLOCKED' : 'ERROR', resumable: soft, terminal: !soft };
  }
  return none;
}

/**
 * WHAT THIS SUBMISSION SHOULD DO TO THE CLOCK.
 *
 * `verdict` is identify.js's, whose `sameTask` comes from the ONE task-identity
 * classifier (task.js). Nothing here re-derives it from the text — a second
 * notion of continuation is exactly what the architecture guard forbids, and it
 * would be a second answer to "is this the same task" living two files from the
 * first.
 */
function attemptFor(ui, verdict, now = Date.now()) {
  if (!verdict || !verdict.sameTask) return ATTEMPT.FRESH;
  const r = resting(ui, now);
  if (r.terminal) return ATTEMPT.RESTART;
  return ATTEMPT.CONTINUE;
}

/**
 * THE SUBMISSION WAS ACCEPTED — every stale alert stops being the resting state.
 *
 * ON SUBMISSION, NOT ON TYPING, and the distinction is the whole of §5: this is
 * called from the turn lifecycle, which runs after `app.handle` has taken the
 * line. A person who types `con` and changes their mind has not reached here,
 * so nothing they can see has moved.
 *
 * IT CLEARS FIELDS AND TOUCHES NO ABORT CONTROLLER — see `cancelPendingWait`,
 * which does that, and must run BEFORE the new turn's controller exists.
 */
function clearResting(ui) {
  if (!ui) return { cleared: [] };
  const cleared = [];
  const r = resting(ui);
  if (r.level) cleared.push(r.word);

  ui.waitingUntil = 0;
  ui.waitingLabel = '';
  ui.interrupted = false;
  ui.interrupting = false;
  ui.retryCancelled = false;
  ui.failed = false;
  return { cleared };
}

/**
 * END A PENDING PROVIDER WAIT, ON THE CONTROLLER IT IS ACTUALLY LISTENING TO.
 *
 * ------------------------------------------------------------------------
 * THE ORDERING BUG THIS EXISTS TO FIX, WHICH I SHIPPED IN `clearResting`.
 *
 * `waitForReset` listens on `app.abort.signal` — whatever controller was
 * current when the wait began. `app.submit` then does, in this order:
 *
 *     this.abort = new AbortController();        // line ~205
 *     ...
 *     this.ui.beginTurn(verdict);                // line ~234  → clearResting
 *
 * So an abort fired from `clearResting` lands on the controller created for
 * the turn that is STARTING, not the one the wait holds. Both halves fail:
 *
 *   the pending wait is never cancelled and goes on counting down against an
 *     orphaned signal nothing will ever fire;
 *   and the FRESH turn begins with an already-aborted signal, so a person who
 *     typed `continue` during a rate-limit wait got a turn that cancelled
 *     itself on its first step.
 *
 * Measured, not reasoned about: the reproduction printed
 * `pending wait cancelled: false` / `fresh turn signal aborted: true`.
 *
 * THE FIX IS THE CALL SITE, NOT THE MECHANISM. This runs from `submit` BEFORE
 * the new controller replaces the old one, so `app.abort` is still the wait's.
 * It is the same signal ui/waiting.js `cancelWait` uses — one way out of a
 * wait, not two.
 *
 * SAFETY IS THE CALLER'S, NOT THIS FUNCTION'S (§19/§22). Cancelling a WAIT is
 * always safe: no request has been sent, and the thing being abandoned is a
 * timer. Whether the operation behind it may then be re-sent is a different
 * question, decided by the existing operation semantics.
 */
function cancelPendingWait(app) {
  const ui = app && app.ui;
  if (!ui || !ui.waitingUntil) return { cancelled: false };
  try {
    if (app.abort && !app.abort.signal.aborted) {
      app.abort.abort();
      return { cancelled: true };
    }
  } catch { /* no controller: the field clearing in clearResting still applies */ }
  return { cancelled: false };
}

module.exports = { ATTEMPT, resting, attemptFor, clearResting, cancelPendingWait, blocked, BLOCKED_KINDS };
