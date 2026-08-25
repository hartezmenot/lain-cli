'use strict';

/**
 * THE EXECUTION ENVIRONMENT — which workspace owns the current task.
 *
 *     CLI      ordinary agent work: files, shell, git, the project
 *     PROBE    runtime investigation: the live target, its own tool surface
 *
 * WHY THIS FILE EXISTS. The Probe was reachable but not owned. `probeskill.js`
 * told the model what kind of turn it was only when the turn was typed IN THE
 * PROBE WINDOW (`from === 'probe'`) — a Probe task typed at the ordinary CLI
 * prompt arrived as a blank IMPLEMENT request, and the measured failure was the
 * model searching the filesystem for a value that only exists in a live process.
 * The routing decision therefore depended on the model remembering. It must not:
 * the runtime decides, the runtime states, and the runtime enforces.
 *
 * WHAT IT OWNS. One session-scoped state: which environment the current task
 * belongs to, who owns the tools while it does, and the counters the acceptance
 * criteria ask for. The classifier (mode.js) names a Probe task; `identify.js`
 * applies that verdict here; `tools/index.js` asks here whether a call is in
 * scope; `probeskill.js` renders the state the model reads. One authoritative
 * answer to "am I in Probe" and nothing downstream re-derives it.
 *
 * WHY SESSION-SCOPED, NOT GLOBAL. A second conversation in the same process
 * (tests, a reconnected Probe) must not inherit the first's environment. The
 * environment also deliberately outlives a Probe disconnect: an investigation
 * interrupted by a dropped connection is still an investigation, and silently
 * flipping back to CLI on a reconnect race is the fallback this module exists to
 * prevent. `clear()` is explicit — a completed task, or the user's own command.
 */

const ENVIRONMENTS = Object.freeze({ CLI: 'CLI', PROBE: 'PROBE' });

/**
 * THE PROBE TOOL GROUPS, by role in the investigation lifecycle.
 *
 * One line each, so a prompt can show the whole surface in a few lines. Names
 * follow the Probe's own `probe.tools` groups (`tools/probe.js` GROUPS); the
 * mapping is deliberately loose — "process" is ACQUIRE, "memory" is OBSERVE —
 * because this is orientation for the model, not a routing table. The Probe
 * remains the authority on what its operations actually are.
 */
const PROBE_TOOL_GROUPS = Object.freeze({
  ACQUIRE: 'find, authorise and attach the target (process, app)',
  OBSERVE: 'read, scan, watch and correlate the target (memory, investigate, debug, vision)',
  ANALYZE: 'disassembly, pointers, concept graph and evidence (code, pointer, findings)',
  IMPLEMENT: 'build a reader/capability artifact from a finding (artifact)',
  BUILD: 'generate and execute scripts against the target (automation, python)',
  EXECUTE: 'run the capability against the live target (automation, python, debug)',
  VALIDATE: 'compare the observed behaviour against the objective (investigation)',
});

/**
 * WHAT STAYS REACHABLE INSIDE PROBE, BY NAME.
 *
 * This is not "the CLI tools are forbidden" — it is the narrowest set the Probe
 * genuinely cannot replace. Everything else a CLI tool can do is what the Probe
 * itself does, so leaving the full CLI surface up while an investigation is live
 * is exactly the accidental-fallback the task names. ask_user stays because the
 * Probe's own contract makes the USER an evidence source. The shell tools stay
 * reachable ONLY through the explicit bridge (see BRIDGE), never silently.
 */
const ALWAYS_ALLOWED = new Set(['ask_user']);

/**
 * THE ONE CLI OPERATION PROBE MAY ASK FOR, and only by name.
 *
 * `probe.bridge_cli` exists so an investigation can still do the one thing the
 * Probe has no operation for — start or fetch an executable the user's own
 * machine has — without re-opening the whole CLI vocabulary. The result says
 * what ran, so the investigation trail keeps its provenance; the tool gate
 * (tools/index.js) refuses every OTHER CLI tool while the environment is PROBE.
 */
const BRIDGE_TOOL = 'probe.bridge_cli';

/** How many environment transitions the activity log keeps. */
const LOG_LIMIT = 60;

/**
 * THE STATE.
 *
 * Keyed by session id so two App instances in one process — a test, a harness —
 * cannot see each other's environment. `sessionKey(app)` is the seam: pass
 * nothing in tests and you get the shared single-session state.
 */
const _sessions = new Map();

/** The key one App's environment hangs off. */
function sessionKey(app) {
  const id = app && app.session && app.session.id;
  return id ? `s:${id}` : 'anon';
}

function stateFor(app) {
  const k = sessionKey(app);
  let s = _sessions.get(k);
  if (!s) {
    s = {
      environment: ENVIRONMENTS.CLI,
      since: Date.now(),
      probeSessionId: null,
      targetSummary: '',
      log: [],
      metrics: {
        probe_entries: 0,
        probe_handoffs: 0,
        cli_fallbacks: 0,
        repeated_scans: 0,
        repeated_hypotheses: 0,
        imported_intelligence_reused: 0,
        verified_findings: 0,
        implementation_attempts: 0,
        validation_attempts: 0,
        repair_cycles: 0,
      },
    };
    _sessions.set(k, s);
  }
  return s;
}

/**
 * THE CLASSIFIER'S VOCABULARY, consumed from mode.js — the way task.js and
 * mode.js already keep one vocabulary. A second word list here could disagree
 * with the classifier; importing theirs cannot.
 */
const PROBE_TASK_RE = require('./probetask').PROBE_TASK_RE;

/**
 * IS THIS TEXT A PROBE TASK? One deterministic test, used by mode.js.
 *
 * Exported so tests and callers ask one module. It never inspects the live
 * Probe: "inspect this target" classifies as a Probe task whether or not one
 * is connected, because the user said what the task IS.
 */
function isProbeTaskText(text) {
  return PROBE_TASK_RE.test(String(text == null ? '' : text));
}

/**
 * THE HANDOFF. Record that this session's work now belongs to Probe.
 *
 * Called from `identify.js` when a new task classifies as PROBE with a Probe
 * connected, and from `probe.enter` (the explicit bridge op) when the model or
 * the user says so directly. A session that is ALREADY in Probe re-records the
 * objective but does not count a second entry — "continue the investigation" is
 * a turn inside Probe, not a second handoff.
 *
 * @param {object} app
 * @param {object} opts
 *   objective    the user's words, verbatim — Probe keeps them as the objective
 *   probeSessionId  the Probe's own session id, when one is connected
 *   targetSummary   the attached target, as a short line for the prompt
 *   reason          one line for the activity log
 * @returns {{ environment, entered: boolean, metrics }}
 */
function enterProbe(app, { objective = '', probeSessionId = null, targetSummary = '', reason = '' } = {}) {
  const s = stateFor(app);
  const already = s.environment === ENVIRONMENTS.PROBE;
  s.environment = ENVIRONMENTS.PROBE;
  s.since = Date.now();
  s.probeSessionId = probeSessionId || s.probeSessionId;
  s.targetSummary = String(targetSummary || s.targetSummary || '');
  // THE OBJECTIVE IS THE USER'S WORDS, not a paraphrase — Probe renders it into
  // its own state and the round trip is checked by name in the tests.
  if (objective) s.objective = String(objective);
  s.metrics.probe_entries += 1;            // every entry attempt is counted
  if (!already) s.metrics.probe_handoffs += 1;   // ...but one handoff per task
  s.log.push({ at: Date.now(), event: 'PROBE_ENTER', reason: String(reason || (already ? 'already active' : 'task classified as PROBE')) });
  if (s.log.length > LOG_LIMIT) s.log.shift();
  return { environment: s.environment, entered: !already, metrics: { ...s.metrics } };
}

/** Record that this session is back in ordinary CLI work. Idempotent. */
function enterCli(app, reason = '') {
  const s = stateFor(app);
  const was = s.environment;
  s.environment = ENVIRONMENTS.CLI;
  if (was !== ENVIRONMENTS.CLI) {
    s.log.push({ at: Date.now(), event: 'CLI_RESTORE', reason: String(reason || 'explicitly') });
    if (s.log.length > LOG_LIMIT) s.log.shift();
  }
  return { environment: s.environment };
}

/**
 * MAY THIS TOOL CALL HAPPEN IN THE CURRENT ENVIRONMENT?
 *
 * THE ENFORCEMENT POINT. Called from `tools/index.js:execute` — the same single
 * door the filesystem gate already sits behind — so a tool added tomorrow is
 * covered without its author knowing. Rules, in order:
 *
 *   CLI      everything is allowed. This module adds nothing to ordinary work.
 *   PROBE    Probe tools, the always-allowed set, and the bridge. A CLI tool is
 *            refused with the bridge's name in the message, so the model's next
 *            call is the right one instead of a second guess.
 *
 * The refusal is a RESULT, not a redirect: the model is told what happened and
 * what to call instead, exactly as gate.js does for paths.
 */
function checkToolAllowed(name, app) {
  const s = stateFor(app);
  if (s.environment !== ENVIRONMENTS.PROBE) return { ok: true };
  // The Probe's own surface: the `probe` tool, its `probe.*` op names, and the
  // bridge under its registry spelling (`probe_bridge_cli`) or its op spelling
  // (`probe.bridge_cli`). All one vocabulary.
  const n = String(name || '');
  if (n === 'probe' || n.startsWith('probe.') || n.startsWith('probe_')) {
    return { ok: true };
  }
  if (ALWAYS_ALLOWED.has(name)) return { ok: true };
  return {
    ok: false,
    output: `refused by the environment: this session is in the PROBE environment (an investigation `
      + `owns the task), and "${name}" is a CLI tool. Investigate with the probe tool — the Probe `
      + `owns memory, scanning, watching, code, findings and artifacts — or, if the investigation `
      + `genuinely needs a shell command, call probe.bridge_cli with it. `
      + `Nothing was done.`,
  };
}

/**
 * THE CURRENT ENVIRONMENT, FOR PROMPTS AND GATES.
 *
 * `isProbe` is the one question everything downstream asks; `describe()` is the
 * compact block probeskill.js appends. Metrics ride along because the summary
 * is where a human checks them (see /mcp probe).
 */
function describe(app) {
  const s = stateFor(app);
  const probeConnected = Boolean(app && app._probe
    && app._probe.state === 'CONNECTED');
  return {
    environment: s.environment,
    isProbe: s.environment === ENVIRONMENTS.PROBE,
    probeConnected,
    probeSessionId: s.probeSessionId,
    targetSummary: s.targetSummary,
    objective: s.objective || '',
    metrics: { ...s.metrics },
    log: s.log.slice(-12),
  };
}

/**
 * THE METRICS LEDGER, for the counters the task names.
 *
 * `note` bumps any of them from wherever the fact is known — a repeated scan
 * detected in the Probe's own investigation counters, a repair cycle after a
 * LOCALIZE_FAILURE. Best effort by design: a metric that throws out of a turn
 * would be a bug worse than a missing number.
 */
function note(app, metric, by = 1) {
  try {
    const s = stateFor(app);
    if (metric in s.metrics) s.metrics[metric] += by;
    return { ...s.metrics };
  } catch { return null; }
}

/**
 * TEST SEAM: forget one session's environment, so a test never inherits the
 * previous test's state. Called with no argument it forgets everything.
 */
function _reset(app) {
  if (app) _sessions.delete(sessionKey(app));
  else _sessions.clear();
}

// ---------------------------------------------------------------------------
// THE MACHINE-DETECTION SURFACE, re-exported.
//
// `environment.js` used to be ONLY this: what OS, shell, package manager, venv
// and test runner the machine and project have, feeding the prompt's stable
// prefix (prompt.js), the execution contract (contracts.js) and the survey
// (survey.js). It is now two modules in one file:
//
//     envdetect.js   the machine — OS, shell, lockfiles, venv, test runner
//     (this file)    the workspace — which environment owns the current task
//
// Both are "the environment"; one file means every consumer keeps importing
// `./environment` and no module has to know which half it is asking for.
// ---------------------------------------------------------------------------
const envdetect = require('./envdetect');

module.exports = {
  // the workspace (this module's own concern)
  ENVIRONMENTS, PROBE_TOOL_GROUPS, ALWAYS_ALLOWED, BRIDGE_TOOL,
  isProbeTaskText, enterProbe, enterCli, checkToolAllowed, describe, note,
  _reset,
  // the machine (envdetect.js, re-exported under the same names the consumers
  // already call — contracts.js, survey.js, clifacts.js, prompt.js, tools)
  osName: envdetect.osName,
  detectShell: envdetect.detectShell,
  detectPackageManager: envdetect.detectPackageManager,
  detectVenv: envdetect.detectVenv,
  detectTestRunner: envdetect.detectTestRunner,
  detectRuntimes: envdetect.detectRuntimes,
  detect: envdetect.detect,
  summary: envdetect.summary,
  reset: envdetect.reset,
};
