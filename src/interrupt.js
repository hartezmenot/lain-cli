'use strict';

/**
 * THE CTRL+C POLICY — one pure decision, so the two-press exit is testable
 * without a terminal, a child process, or a real clock.
 *
 * V1 (and V2 before this) treated an idle Ctrl+C as "exit now": a single stray
 * keystroke ended the session and threw away the resume point. That is the one
 * thing a coding tool must not do by accident.
 *
 * The rule, in three cases:
 *   1. WORKING  — a model request or a tool is in flight. Ctrl+C CANCELS it and
 *      nothing else. Cancelling is not exiting; exiting is reached separately and
 *      deliberately, so a reflexive Ctrl+C to stop a runaway loop never also
 *      closes the session.
 *   2. IDLE, not yet armed — the first press ARMS a short confirmation and shows
 *      a hint. Nothing is torn down.
 *   3. IDLE, armed and still inside the window — the second press EXITS.
 *
 * Anything else the user does (typing, a navigation key, submitting a line)
 * clears the armed state; that is handled by the caller, which owns the hint and
 * the input events. This module only answers "given the state, what does this
 * Ctrl+C mean?" and never touches I/O.
 */

/** How long "press Ctrl+C again to exit" stays live. Short enough to feel immediate. */
const EXIT_CONFIRM_MS = 1500;

/**
 * @param {object} state
 *   working  — a model request or tool call is in flight right now
 *   armedAt  — ms timestamp the confirmation was armed, or 0 when not armed
 * @param {number} now  current time in ms
 * @returns {{ action: 'cancel'|'arm'|'exit', armedAt: number }}
 *   action  — what the caller should do
 *   armedAt — the new armed timestamp to store (0 clears it)
 */
function onInterrupt({ working = false, armedAt = 0 } = {}, now = Date.now()) {
  if (working) return { action: 'cancel', armedAt: 0 };
  if (armedAt && now - armedAt <= EXIT_CONFIRM_MS) return { action: 'exit', armedAt: 0 };
  return { action: 'arm', armedAt: now };
}

// ------------------------------------------------------------ side effects ---
//
// The DECISION above is pure. These two apply it: remember when we armed, show
// or clear the hint, and expire it on a timer. They lived in app.js as three
// methods, which meant one concern was spread across two files — the policy
// here, the state and the timer there. The window is enforced by the decision,
// not by the timer, so a late Ctrl+C after the hint has faded simply re-arms
// rather than exiting.

/** Show the hint where the user is looking: the input frame, or plain text. */
function showHint(app, msg) {
  if (app.ui && app.ui.enabled) app.ui.setExitHint(msg);
  else if (msg) app.render.notice('warn', msg);
}

/** First idle Ctrl+C: arm the window and show the hint. */
function armExit(app) {
  app._exitArmedAt = Date.now();
  if (app._exitTimer) clearTimeout(app._exitTimer);
  app._exitTimer = setTimeout(() => {
    app._exitTimer = null;
    app._exitArmedAt = 0;
    showHint(app, '');
  }, EXIT_CONFIRM_MS);
  if (app._exitTimer.unref) app._exitTimer.unref();
  showHint(app, 'Press Ctrl+C again to exit.');
}

/** The user did something else — cancel the confirmation. No-op when unarmed. */
function disarmExit(app) {
  if (!app._exitArmedAt && !app._exitTimer) return;
  app._exitArmedAt = 0;
  if (app._exitTimer) { clearTimeout(app._exitTimer); app._exitTimer = null; }
  showHint(app, '');
}

module.exports = { onInterrupt, EXIT_CONFIRM_MS, armExit, disarmExit };
