'use strict';

/**
 * THE NEXT LINE YOU TYPE IS NOT A PROMPT — it is a goal, or a plan.
 *
 * ------------------------------------------------------------------------
 * WHY A MODE AND NOT AN ARGUMENT.
 *
 * `/goal stabilise the CLI and finish the Harness` works and is kept. But the
 * request in §14–§15 is the other half: `/goal` on its own opens a composer,
 * and if a goal already exists it comes BACK INTO THE COMPOSER for editing —
 * delete words, append detail, rewrite it — rather than being printed
 * read-only beside a message telling you to retype it.
 *
 * That needs exactly two things: the line prefilled, and the next Enter routed
 * somewhere other than the model.
 *
 * ------------------------------------------------------------------------
 * IT REUSES THE ONE MECHANISM THAT ALREADY EXISTS.
 *
 * `app.pendingAsk` is LAIN's existing rule for "the next line is an ANSWER, not
 * a new task" — it is what stops a pasted review starting a turn, mutating the
 * plan or resetting a step. This is the same rule for a different destination,
 * and it is checked in the same place in `App.handle`, immediately after it.
 *
 * A composed line therefore CANNOT start a turn, cannot touch task identity,
 * cannot spend a token and cannot reach a model. That is the whole safety
 * property, and it is structural rather than a promise: `App.handle` returns
 * before it reaches the classifier.
 *
 * ------------------------------------------------------------------------
 * ESCAPE IS ALWAYS A CANCEL, AND SO IS AN EMPTY LINE.
 *
 * Nothing is committed by pressing Enter on nothing. A person who opens the
 * goal composer, reads their own goal back and changes their mind has made no
 * decision, and a mode that treated that as "clear the goal" would be
 * destroying durable direction with the least deliberate keystroke there is.
 * Clearing a goal is `/goal clear`, typed on purpose.
 */

/** The things a composed line can become. */
const KIND = Object.freeze({
  GOAL: 'GOAL',
  PLAN_REPLACE: 'PLAN_REPLACE',
  PLAN_ADD: 'PLAN_ADD',
});

/** What the composer says in front of the line, per kind. */
const LABEL = Object.freeze({
  [KIND.GOAL]: 'GOAL',
  [KIND.PLAN_REPLACE]: 'PLAN',
  [KIND.PLAN_ADD]: 'PLAN +',
});

/**
 * OPEN THE COMPOSER.
 *
 * @param {string} prefill  the existing value, copied back for editing. This is
 *   the §15 behaviour and it is the point of the whole mode: an existing goal
 *   is EDITED, never retyped from memory.
 */
function open(app, kind, { prefill = '' } = {}) {
  if (!app || !KIND[kind]) return null;
  app.composing = { kind, at: Date.now() };
  // THE LINE ITSELF. `setLine` is the existing editor entry point — the one
  // history recall and completion acceptance already use — so the text arrives
  // with the cursor at its end, undo reset, and the paste flag cleared.
  try { if (app.input && typeof app.input.setLine === 'function') app.input.setLine(String(prefill || '')); } catch { /* a pipe has no line editor */ }
  return app.composing;
}

/** Is a composer open, and for what? */
function pending(app) { return (app && app.composing) || null; }

/** Shut it without committing anything. */
function cancel(app) {
  if (!app) return null;
  app.composing = null;
  try { if (app.input && typeof app.input.setLine === 'function') app.input.setLine(''); } catch { /* no editor */ }
  return null;
}

/** The label the input region draws while a composer is open, or ''. */
function label(app) {
  const c = pending(app);
  return c ? (LABEL[c.kind] || '') : '';
}

/**
 * CONSUME A LINE, IF A COMPOSER IS OPEN.
 *
 * Called from `App.handle` beside `answerPending`. Returns true when the line
 * was taken, which is the caller's signal to return without classifying it.
 *
 * @returns {boolean}
 */
function take(app, textIn) {
  const c = pending(app);
  if (!c) return false;
  app.composing = null;
  const value = String(textIn == null ? '' : textIn).trim();
  // AN EMPTY LINE COMMITS NOTHING. See the header: the least deliberate
  // keystroke there is must not destroy durable direction.
  if (!value) {
    app.transient('info', `${LABEL[c.kind]} unchanged.`);
    return true;
  }
  if (c.kind === KIND.GOAL) {
    const goal = require('./goal');
    goal.set(app.session, value);
    app.transient('info', `Goal set — ${value.replace(/\s+/g, ' ').slice(0, 60)}${value.length > 60 ? '…' : ''}`);
  } else if (c.kind === KIND.PLAN_REPLACE || c.kind === KIND.PLAN_ADD) {
    // ONE PLAN OWNER. The steps are built by plan.js from this text; nothing
    // here keeps a second copy of them or a second notion of what a step is.
    require('./plancompose').commit(app, c.kind === KIND.PLAN_REPLACE ? 'replace' : 'add', value);
  }
  try { app.session.save(); } catch { /* the change still holds for this run */ }
  return true;
}

module.exports = { KIND, LABEL, open, pending, cancel, label, take };
