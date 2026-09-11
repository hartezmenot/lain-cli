'use strict';

/**
 * TURNING A TYPED LINE INTO PLAN STEPS — and the ONE owner that does it.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE AND NOT A BRANCH IN composemode.js.
 *
 * composemode.js knows about the INPUT LINE — prefill, capture, cancel — and
 * nothing about what a plan is. plan.js owns what a plan is and never reads a
 * keystroke. This is the seam between them, and putting it in either would have
 * given that file a second subject.
 *
 * ------------------------------------------------------------------------
 * ONE PLAN STORE. `session.plan` is a `Plan` (src/plan.js) and remains the only
 * one. This file constructs steps THROUGH `Plan.addSteps` and `Plan.steer`; it
 * keeps no list of its own, so there is no second notion of what a step is or
 * what order they are in.
 *
 * ------------------------------------------------------------------------
 * HOW A LINE BECOMES STEPS, deterministically and with no model call.
 *
 * People write plans as arrows or as separators — "inspect router → patch retry
 * → run smoke". Splitting on those is what makes the composer feel like a plan
 * editor rather than a single-step box. Splitting on FULL STOPS is deliberately
 * NOT done: a step is routinely a sentence with a path or a version in it, and
 * "patch v1.2 handling" is one step and not two.
 */

/** How a typed plan line is broken into steps. Arrows and explicit separators. */
const SEPARATORS = /\s*(?:→|->|;|\n|\s\|\s)\s*/;

/** A plan is a strategy, not a specification. */
const MAX_STEPS = 40;

/** Split a typed line into step texts. Pure, deterministic, no model call. */
function split(line) {
  return String(line == null ? '' : line)
    .split(SEPARATORS)
    .map((s) => s.trim())
    // A leading list marker is punctuation people type, not part of the step.
    .map((s) => s.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_STEPS);
}

/**
 * THE CURRENT PLAN AS A LINE, for the composer to prefill with.
 *
 * ONLY THE WORK THAT IS STILL AHEAD. A plan half-done reads back as its
 * REMAINING steps, because that is what a person is editing when they reopen
 * it — offering finished work for rewriting invites exactly the redo loop
 * `Plan.steer` refuses to allow, and the completed steps are evidence.
 */
function asLine(plan) {
  if (!plan || !plan.steps || !plan.steps.length) return '';
  return plan.remaining.map((s) => s.text).join(' → ');
}

/**
 * COMMIT A COMPOSED PLAN LINE.
 *
 * @param {'replace'|'add'} mode
 */
function commit(app, mode, line) {
  const { Plan } = require('./plan');
  const session = app && app.session;
  if (!session) return null;
  const steps = split(line);
  if (!steps.length) return null;

  if (!session.plan) {
    session.plan = new Plan(session.task ? session.task.objective : 'session plan');
  }
  const plan = session.plan;

  if (mode === 'replace') {
    // ---- REPLACE MEANS THE STRATEGY, NOT THE HISTORY --------------------
    //
    // The steps still to do are dropped and the new ones take their place.
    // COMPLETED STEPS SURVIVE UNTOUCHED, and that is `Plan.steer`'s own rule
    // rather than a decision made here: a finished step is evidence of work
    // that really happened, and rewriting it is how a model is invited to do
    // it again. So "replace the plan" replaces the FUTURE.
    const drop = plan.remaining.map((s) => s.n);
    plan.steer(`plan replaced by the user: ${line}`.slice(0, 200), { drop });
    plan.addSteps(steps, { origin: 'user' });
  } else {
    plan.addSteps(steps, { origin: 'user' });
  }
  app.transient('info', mode === 'replace'
    ? `Plan replaced — ${steps.length} step${steps.length === 1 ? '' : 's'}`
    : `Plan extended — ${steps.length} step${steps.length === 1 ? '' : 's'} added`);
  return plan;
}

module.exports = { split, asLine, commit, SEPARATORS, MAX_STEPS };
