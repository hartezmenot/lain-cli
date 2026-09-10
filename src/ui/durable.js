'use strict';

/**
 * WHICH OPERATIONS EARN A PERMANENT ROW, AND WHICH ARE LIVE STATE.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS ENDS. Measured against the real binary, one ordinary turn
 * left this behind in the conversation, for ever:
 *
 *     | OK Ran python -c "import ast"
 *     | OK Ran python -c "import json, tempfile"
 *     | OK Ran python -m py_compile a.py
 *     |     [via shell: bash - cwd=/tmp/op-vYP2g7]
 *     | OK Read a.py
 *     | OK Read b.py
 *
 * Six rows, no information. Nobody scrolls back an hour to learn that a
 * `py_compile` succeeded; they scroll back for what was decided and what
 * changed. Rows like these are what turned the transcript into a raw execution
 * log, and they crowd out the two things it is for - what the person said and
 * what LAIN answered.
 *
 * A SUCCESSFUL ROUTINE OPERATION IS LIVE STATE. It belongs in the one row above
 * the caret while it is happening, replaced in place by the next one, and then
 * it is over. That row already exists and already does exactly that
 * (ui/status.js); nothing new is drawn to take its place.
 *
 * ------------------------------------------------------------------------
 * WHAT IS KEPT, and every one of these is a thing somebody comes back for:
 *
 *   A FAILURE          the single most useful row in a long session, and the
 *                      one a person scrolls to find. Always kept.
 *   A CHANGE TO THE    `Edited router.js  +75 -40` is the account of the work.
 *   PROJECT            Reads and searches are how it was DECIDED; writes are
 *                      what was DONE, and only one of those is the record.
 *   A VERIFICATION     whether the suite passed is the answer to the question
 *                      the whole turn existed to answer.
 *   A DECISION         `ask_user` is the user's own approval, in order, where
 *                      they gave it.
 *   A SERVICE          starting one leaves a process behind that outlives the
 *                      turn, so the turn must say it did.
 *
 * NOTHING IS LOST BY DROPPING THE REST. Every call is still in the turn record,
 * in the Harness timeline and its artifacts, and reachable through `/brief`,
 * `/jobs <n>` and `/ps`. What changes is that the DEFAULT surface is a
 * conversation rather than a log of it.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS ITS OWN FILE. It is POLICY, and ui/feed.js DRAWS. They change for
 * different reasons: a new tool adds a name here and touches no drawing; a new
 * row shape does the reverse. The split also kept feed.js under the god-object
 * guard, which is how the seam got noticed - but the seam was already there.
 */

const V = () => require('./phrasing');

/** Verbs whose effect is a change to the project rather than a look at it. */
const CHANGED = new Set(['Wrote', 'Edited', 'Patched', 'Appended', 'Inserted', 'Deleted', 'Moved']);

/** Calls that are durable for a reason the verb cannot express. */
const DURABLE_TOOLS = new Set(['run_tests', 'verify_task', 'ask_user', 'service_start']);

function durable(a) {
  if (!a) return false;
  // A FAILURE IS ALWAYS DURABLE - see the header. This is first so that a
  // failed read is kept while a successful one is not.
  if (a.ok === false) return true;
  if (DURABLE_TOOLS.has(String(a.name || ''))) return true;
  if (CHANGED.has(V().verbOf(a.name))) return true;
  // WHOEVER PRODUCED THE ACTION MAY SAY SO. Nothing sets this today; it is the
  // seam for a tool that knows its own result is worth keeping, so that the
  // answer does not have to be guessed from a name in this file.
  return Boolean(a.durable);
}

/**
 * WHICH OF A TURN'S CALLS ARE KEPT, as a set of the very objects to keep.
 *
 * `durable` answers the question one call at a time, and for almost every call
 * that is the whole answer. ONE RULE NEEDS THE WHOLE LIST:
 *
 *   THE TURN'S STANDING VERDICT. A successful shell command is routine - `python
 *   -c "import ast"` and `sed -n 1,40p x.js` are implementation mechanics, and
 *   those are exactly what must stop accumulating. But a turn whose last command
 *   ran clean has just told you the most important thing about it, and the final
 *   verification result is something to keep.
 *
 *   SO THE LAST ONE IS KEPT AND THE REST ARE NOT. That is not a guess about the
 *   command's text - there is no keyword table here deciding that "test" means a
 *   verification, for the same reason `/bg` does not decide that "server" means a
 *   service. It is src/lifecycle.js's own semantic, quoted from `observeTool`:
 *   "Recorded per command, so the LAST one is always the current verdict. A
 *   failing test run followed by a fix and a passing run leaves `ok: true`, which
 *   is exactly right - the point is the state the task ends in." This reads that
 *   rule off the same list the lifecycle read it off.
 *
 * A FAILED COMMAND IS NEVER SUBJECT TO THIS. It is durable on its own account,
 * so a turn that ran six commands and broke on the third keeps the third.
 */
function keepers(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const keep = new Set();
  let verdict = null;
  for (const a of list) {
    if (durable(a)) keep.add(a);
    else if (a && a.ok !== false && /^run_/.test(String(a.name || ''))) verdict = a;
  }
  if (verdict) keep.add(verdict);
  return keep;
}

module.exports = { durable, keepers, CHANGED, DURABLE_TOOLS };
