'use strict';

/**
 * THE GOAL — what the user is trying to achieve.
 *
 * ------------------------------------------------------------------------
 * FOUR CONCEPTS, AND THEY MUST NOT COLLAPSE INTO EACH OTHER.
 *
 *   GOAL       what the user is trying to achieve.        Durable. Theirs.
 *   PLAN       the current strategy for reaching it.      Revisable.
 *   PLAN_STEP  the execution steps being worked through.  Runtime's.
 *   STEER      a correction to work already in flight.    Momentary.
 *
 * A task objective is NOT a goal. `task.objective` is whatever sentence started
 * the current unit of work — "fix the checkout race" — and it is replaced the
 * moment a person asks for something else. A goal outlives that: "stabilise the
 * CLI and finish the Harness" is true across a dozen tasks, and it is the thing
 * that says which of them were worth doing.
 *
 * A plan is not a goal either. A plan is one strategy, and it can be wrong,
 * replaced or abandoned while the goal is untouched.
 *
 * ------------------------------------------------------------------------
 * IT CHANGES ONLY WHEN THE PERSON CHANGES IT.
 *
 * Nothing in a turn writes here — not the model, not the runtime, not a
 * completion, not a failure. `/goal` is the only door, which is what makes it
 * safe to leave on screen and safe to carry into a resumed session. A goal that
 * a turn could quietly rewrite would be a second task objective wearing a
 * different label.
 *
 * ------------------------------------------------------------------------
 * ONE STORE. It lives on the session, is written by the session file, and is
 * read by everything else. There is deliberately no project-level goal file, no
 * config key and no `.lain` record of it: a second store is a second answer to
 * "what am I trying to do", and the day they disagreed neither would be
 * trustworthy.
 */

/** A goal is a direction, not a specification. Bounded like every other input. */
const MAX_GOAL = 2000;

/** What `/goal` shows in front of the composer while it is being written. */
const PROMPT = 'GOAL';

/** The goal this session is working towards, or null. */
function get(session) {
  const g = session && session.goal;
  return g && g.text ? g : null;
}

/** Its text, or '' — the form most callers want. */
function text(session) {
  const g = get(session);
  return g ? g.text : '';
}

/**
 * SET IT. The only mutation, and it is reached only from `/goal`.
 *
 * The previous goal is kept in `history` rather than overwritten in place. A
 * person who rewrites a goal mid-project is making a decision, and losing what
 * it replaced makes the session unable to say what changed or when — which is
 * exactly the question a resumed session is asked.
 */
function set(session, value) {
  if (!session) return null;
  const t = String(value == null ? '' : value).trim().slice(0, MAX_GOAL);
  if (!t) return clear(session);
  const prev = get(session);
  const now = new Date().toISOString();
  const history = (session.goal && Array.isArray(session.goal.history)) ? session.goal.history.slice(-9) : [];
  if (prev && prev.text !== t) history.push({ text: prev.text, until: now });
  session.goal = { text: t, setAt: now, history };
  return session.goal;
}

/** Drop it. Only `/goal clear` and a brand-new session reach this. */
function clear(session) {
  if (!session) return null;
  session.goal = null;
  return null;
}

/**
 * WHAT THE SYSTEM PROMPT IS TOLD, or ''.
 *
 * SHORT, AND MARKED AS DIRECTION RATHER THAN AS THE TASK. A model handed a goal
 * as though it were the request will start working on the goal — and the goal
 * is usually far larger than the sentence the person actually just typed. It is
 * context for judging what matters, not an instruction to act on.
 */
function forPrompt(session) {
  const t = text(session);
  if (!t) return '';
  return `THE USER'S STANDING GOAL — the direction this work serves, not this turn's request:\n  ${t}`;
}

/** What a session file carries. Ids and text; nothing derived. */
function toJSON(session) {
  const g = get(session);
  if (!g) return null;
  return {
    text: g.text,
    setAt: g.setAt || null,
    history: Array.isArray(g.history) ? g.history.slice(-9) : [],
  };
}

/**
 * Put it back on a resumed session.
 *
 * A session saved before goals existed has none, and that is the true answer
 * for it rather than a fallback.
 */
function from(data) {
  if (!data || typeof data !== 'object' || !data.text) return null;
  return {
    text: String(data.text).slice(0, MAX_GOAL),
    setAt: data.setAt || null,
    history: Array.isArray(data.history) ? data.history.slice(-9) : [],
  };
}

module.exports = { get, text, set, clear, forPrompt, toJSON, from, MAX_GOAL, PROMPT };
