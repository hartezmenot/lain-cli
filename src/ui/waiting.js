'use strict';

/**
 * WAITING ON A PROVIDER, AND GETTING OUT OF IT.
 *
 * Split out of ui/index.js, which reached the god-object guard. The seam is the
 * same one ui/story.js, ui/reports.js, ui/menus.js and ui/keys.js follow: that
 * file owns the SCREEN and delegates each distinct surface to the module that
 * owns it. This one owns the state a rate-limit wait puts the UI into, and the
 * two ways a person can leave it.
 *
 * THERE IS ONE ABORT SIGNAL, and it is the app's. Both exits below fire the
 * same `app.abort` that `handleRateLimit` keeps alive for exactly the duration
 * of the wait — a second cancellation mechanism here would be a second source
 * of truth about whether the turn is still alive, which is the class of defect
 * the architecture guards exist to catch.
 *
 * THE TIMER IS UNREF'D, always: a pending four-hour wait must never be the
 * reason `/exit` takes four hours.
 */

/**
 * Hold the UI in a visible wait until `resumeAt`, or until the user escapes it.
 *
 * Resolves TRUE when the wait ran its course and FALSE when it was cancelled,
 * which is what lets the caller tell "the provider is back" from "the person
 * gave up" — two different next moves.
 */
function waitForReset(ui, resumeAt, { provider = '', label = '' } = {}) {
  const until = Number(resumeAt) || 0;
  if (!ui.enabled || until <= Date.now()) return Promise.resolve(true);
  ui.waitingUntil = until;
  ui.waitingLabel = label || `waiting for ${provider || 'the provider'} to reset`;
  ui._syncTicker();
  ui.refresh();

  return new Promise((resolve) => {
    const signal = ui.app.abort && ui.app.abort.signal;
    const done = (ok) => {
      if (ui._waitTimer) { clearTimeout(ui._waitTimer); ui._waitTimer = null; }
      if (signal) signal.removeEventListener('abort', onAbort);
      ui.waitingUntil = 0;
      ui.waitingLabel = '';
      ui._syncTicker();
      ui.refresh();
      resolve(ok);
    };
    const onAbort = () => done(false);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    ui._waitTimer = setTimeout(() => done(true), Math.max(0, until - Date.now()));
    if (ui._waitTimer.unref) ui._waitTimer.unref();
  });
}

/**
 * ESCAPE OUT OF A RETRY. Only meaningful while the turn loop says it is
 * retrying — otherwise there is nothing to cancel and saying so would be a lie.
 */
function cancelRetry(ui) {
  if (!ui.phase || ui.phase.phase !== 'RETRYING') return false;
  ui.retryCancelled = true;
  ui.interrupted = false;
  if (ui.app.abort && !ui.app.abort.signal.aborted) ui.app.abort.abort();
  // NO TRANSCRIPT NOTICE. `retryCancelled` is already a resting state that
  // liveState renders as `RETRY CANCELLED · the wait was stopped; the task is
  // intact` — the identical sentence, on the row built for it. Writing it into
  // the conversation as well reported one event twice, and the durable copy
  // outlived the state by hours: an alert glued into scrollback where a person
  // scrolling past tomorrow cannot tell it from something the model said. See
  // ui/operation.js, which made this argument for housekeeping notes, and
  // ui/alert.js, which owns the live half.
  ui.refresh();
  return true;
}

/**
 * ESCAPE OUT OF A LONG RATE-LIMIT WAIT — `waitForReset`'s sibling to
 * `cancelRetry`, and the same mechanism. `waitForReset` reports "stopped
 * waiting" once its promise resolves false; this only needs to fire the signal.
 */
function cancelWait(ui) {
  if (!ui.waitingUntil) return false;
  if (ui.app.abort && !ui.app.abort.signal.aborted) ui.app.abort.abort();
  return true;
}

module.exports = { waitForReset, cancelRetry, cancelWait };
