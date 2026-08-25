'use strict';

/**
 * THE PROBE SESSION LAYER — one addition to the system prompt, on the turns
 * that came from the Probe window and no others.
 *
 * WHY IT EXISTS. Phase D gave the model a route to the Probe and then measured
 * whether it took it. In one run of three, asked "Find my health.", it never
 * called the Probe at all: it searched the filesystem instead. The recorded
 * request showed why. LAIN introduces itself as *"an agentic coding CLI"* that
 * works *"through real tools: files, shell, git"*, and its own classifier had
 * labelled that sentence an implementation request, instructing the model to
 * *"find the existing architecture before you add to it"*. A single tool schema
 * among twenty-two had to overrule both, and sometimes did not.
 *
 * So the turn is told what kind of turn it is. Nothing is taken away: the base
 * prompt, the project section and the plan are untouched, and this is appended
 * after them.
 *
 * WHY ONLY PROBE-ORIGINATED TURNS. A user typing in the terminal with a Probe
 * connected is doing ordinary work and should get the ordinary agent. Making
 * the identity follow the *connection* rather than the *window* would change
 * LAIN's behaviour for everyone who ever ran `/mcp probe`, which is a much
 * larger claim than the evidence supports.
 *
 * WHY THE TEXT LIVES IN THE PROBE. `skills/reverse-engineering/SKILL.md` is the
 * source of truth and is fetched at connect. A copy kept here would drift the
 * first time that document changed, and the drift would be silent — LAIN would
 * go on describing a Probe that had moved. The fallback below is deliberately
 * minimal: enough to stop the model grepping the source tree for a value that
 * only exists in a live process, and no attempt to restate a contract it cannot
 * see.
 */

/** Did this input come from the Probe window? */
function isProbeTurn(from) { return from === 'probe'; }

/**
 * The minimum worth saying when the Probe's own contract could not be read —
 * an older Probe, or a fetch that failed. Short on purpose: a stale paraphrase
 * of a document nobody can check is worse than a single true sentence.
 */
const FALLBACK = `# This conversation came from the Probe window

A LAIN Probe is attached: a companion that observes and interacts with a
RUNNING program. Reach it with the probe tool; probe(op: "capabilities") lists what it
offers.

The user is asking about a running program, not the source tree. A value they
can watch change - health, ammo, position, a number on screen - lives at an
address in a live process; searching the codebase finds nothing. Investigate
with the Probe.

The Probe asks the user for permission in its own window, per capability, at
the moment it acts. A refusal is final for that request. Report evidence, and
never state an address you did not observe.
`;

/**
 * LAIN'S OWN DISCIPLINE FOR A PROBE TURN — distinct from the contract above.
 *
 * The Probe's own skill digest (or FALLBACK) describes what ITS operations do.
 * It cannot describe how LAIN should spend ITS OWN evidence budget around
 * them, because that is LAIN's call, not the Probe's — a Probe with a perfect
 * skill document still says nothing about whether to read this project's
 * source tree first.
 *
 * Measured failure modes this exists to close, found by driving a real
 * discovery session against a live target:
 *
 *   - a non-empty project was read start-to-finish before the first Probe
 *     call, on a task that was explicitly "start fresh, find this value" —
 *     the project being non-empty was treated as reason enough to read it;
 *   - the same unchanged screen was re-observed repeatedly with nothing
 *     between the observations that could have changed it;
 *   - a candidate address was WRITTEN to see what changed, on a task whose
 *     entire point was discovering what that address currently held — the
 *     experiment overwrote the very thing being measured, and did it without
 *     the user ever being asked.
 *
 * ALWAYS APPENDED, not only on the FALLBACK path: even a live, current skill
 * digest from the Probe is silent on all three of the above, so this is not a
 * substitute for a missing contract — it is a second, orthogonal one.
 */
const DISCIPLINE = `# How to spend evidence on this investigation

The project is PRIOR EVIDENCE, not the source of truth for a running target.
Read only what becomes relevant once you know what you are looking for; the
live target answers what the source tree cannot.

Before any expensive observation (screen capture, project read, Probe scan),
name the one uncertainty it removes. Cannot name one -> you do not need it yet.
Re-observing what has not changed answers an answered question.

Prefer a STATE TRANSITION to a static read: "20 -> 19 after one item used" is
strong because the cause is known. Ask the user to perform the ordinary action
that should change the value; do not manufacture the transition by writing a
candidate address - writing to unidentified state destroys its own answer
without the user's knowledge. Write only when the user explicitly asked for
that experiment, on a value already established.

The Probe is one evidence source among several. Reach for it when it is the
cheapest reliable way to remove the SPECIFIC uncertainty in front of you.
`;

/**
 * Append the Probe session layer to a finished system prompt.
 *
 * Returns `sys` unchanged for every turn that did not come from the Probe
 * window, and for any turn where no Probe is connected — a prompt describing a
 * companion that is not there would be worse than saying nothing.
 */
function decorate(app, sys, from) {
  const env = require('./environment');
  const st = app ? env.describe(app) : null;
  // ---- THE HANDOFF TURNS: a Probe task typed at the CLI ---------------------
  //
  // The original rule decorated only `from === 'probe'` turns, and that is the
  // exact hole the measured failure fell through: "Find my health." typed at the
  // ordinary prompt classified as IMPLEMENT, and the model searched the
  // filesystem. When the SESSION's environment is PROBE — set by the handoff in
  // identify.js, whatever surface the words came from — the turn is told so.
  if (st && st.isProbe) return decorateProbeEnvironment(app, sys, st);
  if (!isProbeTurn(from)) return sys;
  const probe = app && app._probe;
  let live = null;
  try { live = require('./probe').live(); } catch (e) { live = null; }
  if (!probe || !live || live !== probe) return sys;
  const contract = String(probe.skillDigest || '').trim() || FALLBACK;
  // THE LIVE STATE, IF THE PROBE SENT IT. This is the part that makes a Probe
  // turn behave like a Probe turn: the model is told what the investigation
  // currently IS - its target, its stage, what is already known, its objective -
  // rather than being handed a blank page and letting it re-derive (or broadly
  // re-discover) everything. A newer Probe carries this on every user.message
  // event; an older one does not, and the turn simply behaves as before.
  const liveInvestigation = (probe._investigation && String(probe._investigation).trim())
    ? `\n\n${String(probe._investigation).trim()}`
    : '';
  return `${sys}\n\n# You are investigating a running program\n${contract}${liveInvestigation}\n\n${DISCIPLINE}`;
}

/**
 * THE ENVIRONMENT BLOCK, for any turn inside the PROBE environment — however
 * the task got there.
 *
 * Compact by rule (the task's §5): state the environment, the objective, the
 * Probe's own live investigation snapshot when it has one, and the ownership
 * rule. No chat history, no provider metadata, no identity — the Probe context
 * is the target, the state, the evidence, the next action.
 */
function decorateProbeEnvironment(app, sys, st) {
  const probe = app && app._probe;
  const lines = [
    '# EXECUTION ENVIRONMENT: PROBE',
    '',
    'This task is a runtime investigation and Probe owns it. The ordinary CLI',
    'tools are withdrawn: memory, scanning, watching, code, findings and',
    'artifacts go through the probe tool, and a genuine shell-level step is',
    'probe.bridge_cli — named, deliberate, never a silent fallback.',
    '',
  ];
  if (st.objective) lines.push(`OBJECTIVE: ${st.objective}`);
  if (st.probeSessionId) lines.push(`PROBE_SESSION: ${st.probeSessionId}`);
  if (st.targetSummary) lines.push(`TARGET: ${st.targetSummary}`);
  // THE PROBE'S OWN STATE, when it carries one. The compact, structured snapshot
  // (target, stage, intelligence, last action) — never the chat transcript,
  // which stays LAIN's and is not forwarded to the Probe context.
  const liveState = probe && probe._investigation && String(probe._investigation).trim();
  if (liveState) lines.push('', String(liveState).trim());
  return `${sys}\n\n${lines.join('\n')}\n\n${DISCIPLINE}`;
}

module.exports = { decorate, isProbeTurn, decorateProbeEnvironment, FALLBACK, DISCIPLINE };
