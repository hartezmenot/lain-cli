'use strict';

/**
 * THE CAPABILITY REGISTRY — one description of everything LAIN can do, whoever
 * provides it.
 *
 * ------------------------------------------------------------------------
 * THE PROBLEM IT SOLVES, WHICH IS NOT "WE NEED A REGISTRY".
 *
 * LAIN's tools, the desktop bridge's operations and whatever an MCP server
 * offers are three vocabularies with three shapes. A person asking "what can
 * this thing do to my machine, and what will it ask me before doing?" had to
 * read three different lists and know which was which. Worse, only one of them
 * carried the answer at all: `mutates: true` on a LAIN tool says a file might
 * change, and says nothing about whether the action reaches the network,
 * whether it is reversible, or whether it touches an account somewhere.
 *
 * So this normalises. Every capability, wherever it comes from, is described
 * with the same six facts, and one of them is the one that matters most:
 * WHAT KIND OF EFFECT DOES THIS HAVE ON THE WORLD.
 *
 * ------------------------------------------------------------------------
 * IT DESCRIBES AND ADVISES. IT DOES NOT ENFORCE.
 *
 * Enforcement already exists and is good: `gate.js` is the single door every
 * tool call passes through, `trust.js` decides which directories are ours to
 * work in, and `permissions.js` decides whether the screen may be seen, asking
 * on every call rather than once. A registry that also enforced would be a
 * second gate, and on the day the two disagreed the weaker one would win —
 * which is the failure mode of every security layer ever added beside another.
 *
 * What this adds is the vocabulary those gates never had, and a POLICY: which
 * side effects need a person to say yes. `gate.js` keeps the door; this says
 * what is written on it.
 *
 * ------------------------------------------------------------------------
 * WHY THE POLICY IS NOT "ASK ABOUT EVERYTHING".
 *
 * A harness that asks before every write is a harness nobody leaves running,
 * and a person who has clicked yes forty times is not consenting any more —
 * they are clearing a dialog. Reading source, running tests and editing files
 * in a trusted directory are the WORK, and they proceed. What is worth
 * interrupting somebody for is the small set that is hard to undo or reaches
 * outside this machine.
 */

const SIDE_EFFECT = Object.freeze({
  READ: 'READ',
  WRITE: 'WRITE',
  EXECUTE: 'EXECUTE',
  NETWORK: 'NETWORK',
  DESTRUCTIVE: 'DESTRUCTIVE',
  EXTERNAL: 'EXTERNAL',
});

/** How much a capability's PROVIDER is trusted, which is not how safe it is. */
const TRUST = Object.freeze({
  /** Shipped in this repository, covered by these tests. */
  BUILT_IN: 'BUILT_IN',
  /** A bridge or server the user configured. Their choice; still not our code. */
  CONFIGURED: 'CONFIGURED',
  /** Reached over a network to somebody else's service. */
  EXTERNAL: 'EXTERNAL',
});

const APPROVAL = Object.freeze({
  AUTOMATIC: 'AUTOMATIC',
  REQUIRED: 'REQUIRED',
});

/**
 * THE POLICY — the whole of it, in one readable table.
 *
 * DESTRUCTIVE and EXTERNAL require approval. Everything else proceeds.
 *
 * NETWORK IS DELIBERATELY AUTOMATIC and that deserves defending: `web_fetch` is
 * a plain GET with no profile and no cookies, and a question whose answer is in
 * a changelog should never have to be answered from a training cut-off. What
 * needs consent is not reading the internet, it is CHANGING something out
 * there — and that is EXTERNAL, which is not automatic.
 */
const POLICY = Object.freeze({
  [SIDE_EFFECT.READ]: APPROVAL.AUTOMATIC,
  [SIDE_EFFECT.WRITE]: APPROVAL.AUTOMATIC,
  [SIDE_EFFECT.EXECUTE]: APPROVAL.AUTOMATIC,
  [SIDE_EFFECT.NETWORK]: APPROVAL.AUTOMATIC,
  [SIDE_EFFECT.DESTRUCTIVE]: APPROVAL.REQUIRED,
  [SIDE_EFFECT.EXTERNAL]: APPROVAL.REQUIRED,
});

/** A capability that has not answered by now has stopped answering. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * RETRY POLICY, and the rule behind the table.
 *
 * A retry is safe when the operation is IDEMPOTENT: reading a file twice is
 * reading a file. It is not safe when repeating it does the thing twice —
 * creating an issue, sending a message, deleting something that was already
 * deleted and now takes a different path. So writes retry (they overwrite the
 * same bytes), and anything DESTRUCTIVE or EXTERNAL never does.
 */
const RETRY = Object.freeze({
  [SIDE_EFFECT.READ]: 'IDEMPOTENT',
  [SIDE_EFFECT.WRITE]: 'IDEMPOTENT',
  [SIDE_EFFECT.EXECUTE]: 'ONCE',
  [SIDE_EFFECT.NETWORK]: 'IDEMPOTENT',
  [SIDE_EFFECT.DESTRUCTIVE]: 'DISABLED',
  [SIDE_EFFECT.EXTERNAL]: 'DISABLED',
});

/**
 * WHAT EACH LAIN TOOL ACTUALLY DOES, where `mutates` is not specific enough.
 *
 * Only the exceptions are listed. Everything else is derived: a tool that
 * mutates is WRITE, a tool that does not is READ. That derivation is what keeps
 * this table from becoming a second copy of the tool registry that drifts —
 * a tool added tomorrow gets a correct description without anybody editing this
 * file, and only a tool with an UNUSUAL effect needs a row.
 */
const OVERRIDES = Object.freeze({
  run_bash: SIDE_EFFECT.EXECUTE,
  run_powershell: SIDE_EFFECT.EXECUTE,
  run_cmd: SIDE_EFFECT.EXECUTE,
  process_run: SIDE_EFFECT.EXECUTE,
  python_run: SIDE_EFFECT.EXECUTE,
  run_background: SIDE_EFFECT.EXECUTE,
  run_tests: SIDE_EFFECT.EXECUTE,
  service_start: SIDE_EFFECT.EXECUTE,
  service_stop: SIDE_EFFECT.EXECUTE,
  verify_task: SIDE_EFFECT.EXECUTE,
  web_fetch: SIDE_EFFECT.NETWORK,
  delete_file: SIDE_EFFECT.DESTRUCTIVE,
  delete_range: SIDE_EFFECT.DESTRUCTIVE,
  remove_symbol: SIDE_EFFECT.DESTRUCTIVE,
  computer: SIDE_EFFECT.EXECUTE,
});

/** Providers whose capabilities are never LAIN's own code. */
const PROVIDER = Object.freeze({
  TOOL: 'lain',
  BRIDGE: 'bridge',
  MCP: 'mcp',
  HARNESS: 'harness',
});

function effectFor(name, { mutates = false } = {}) {
  return OVERRIDES[name] || (mutates ? SIDE_EFFECT.WRITE : SIDE_EFFECT.READ);
}

/**
 * DESCRIBE ONE CAPABILITY. The six facts, always the same six.
 */
function describe(name, { mutates = false, description = '', provider = PROVIDER.TOOL, trust = TRUST.BUILT_IN, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const sideEffect = effectFor(name, { mutates });
  return {
    name: String(name),
    description: String(description || '').slice(0, 400),
    provider,
    source: provider,
    category: provider === PROVIDER.BRIDGE ? 'Observation' : sideEffect === SIDE_EFFECT.EXECUTE ? 'Execution' : 'Core',
    availability: provider === PROVIDER.BRIDGE ? 'REQUIRES_CONFIGURATION' : 'AVAILABLE',
    requirements: provider === PROVIDER.BRIDGE ? ['configured bridge', 'connected transport', 'existing permission grant'] : [],
    limitations: provider === PROVIDER.BRIDGE ? ['configuration alone does not prove a working connection'] : ['subject to existing trust and permission checks'],
    trust,
    sideEffect,
    approval: POLICY[sideEffect] || APPROVAL.AUTOMATIC,
    retry: RETRY[sideEffect] || 'ONCE',
    timeoutMs: Number(timeoutMs) || DEFAULT_TIMEOUT_MS,
  };
}

/**
 * EVERY CAPABILITY AVAILABLE RIGHT NOW.
 *
 * READ FROM THE LIVE TOOL REGISTRY rather than from a list kept here, because
 * a registry that can disagree with the thing it describes is worse than none —
 * the architecture guard already enforces that schemas and dispatch are one
 * list, and this rides on that guarantee instead of adding a third list to keep
 * in step.
 */
function all(app = null) {
  const out = [];
  const cfg = (app && app.cfg) || require('../config').load();
  let tools;
  try { tools = require('../tools'); } catch { tools = null; }
  if (tools) {
    // BUILT ONCE. `schemas()` re-derives the whole active vocabulary on every
    // call, so asking it per tool made this quadratic in the tool count for no
    // reason — and this runs on `/harness capabilities`, which a person waits on.
    const byName = new Map(tools.schemas(app).map((x) => [x.name, x]));
    for (const name of tools.names(app)) {
      const schema = byName.get(name);
      out.push(describe(name, {
        mutates: tools.isMutating(name, app),
        description: (schema && schema.description) || '',
        provider: name === 'computer' ? PROVIDER.BRIDGE : PROVIDER.TOOL,
        trust: name === 'computer' ? TRUST.CONFIGURED : TRUST.BUILT_IN,
      }));
    }
  }
  // THE DESKTOP BRIDGE'S OWN OPERATIONS, named individually. `computer` is one
  // tool and eight quite different powers, and a person reading a capability
  // list deserves to see that `type` and `windows` are not the same risk.
  try {
    const mcp = require('../mcp');
    if (mcp.configured(cfg)) {
      const computer = require('../computer');
      for (const op of computer.NAMES) {
        const spec = computer.OPS[op];
        out.push(describe(`computer.${op}`, {
          mutates: !spec.reads,
          description: spec.what,
          provider: PROVIDER.BRIDGE,
          trust: TRUST.CONFIGURED,
        }));
      }
    }
  } catch { /* no bridge configured, which is the ordinary case */ }
  for (const capability of out) {
    if (capability.provider === PROVIDER.BRIDGE) {
      const bridge = app && app._desktop && app._desktop.bridge;
      capability.availability = bridge && bridge.state === 'CONNECTED' ? 'AVAILABLE' : 'OPTIONAL_UNAVAILABLE';
      capability.configured = require('../mcp').configured(cfg);
      capability.limitations = ['requires a live bridge handshake and existing permission grant'];
    }
    if (capability.name === 'python_run') {
      const python = require('../tools/exec').findPython(cfg);
      capability.category = 'Execution';
      capability.availability = python.ok ? 'AVAILABLE' : 'OPTIONAL_UNAVAILABLE';
      capability.requirements = ['Python interpreter on PATH or configured in python.exe'];
      capability.limitations = ['interpreter presence does not prove project dependencies are installed'];
    }
  }
  return out;
}

/**
 * DOES THIS NEED SOMEBODY TO SAY YES?
 *
 * The answer a caller acts on. `gate.js` still runs; this tells a surface what
 * to expect and lets the harness raise `approval.required` BEFORE the call
 * rather than discovering it inside one.
 */
function needsApproval(name, opts = {}) {
  return describe(name, opts).approval === APPROVAL.REQUIRED;
}

/** Grouped for display: what can this thing do, by kind of effect. */
function byEffect(app = null) {
  const groups = {};
  for (const c of all(app)) {
    if (!groups[c.sideEffect]) groups[c.sideEffect] = [];
    groups[c.sideEffect].push(c.name);
  }
  return groups;
}

module.exports = {
  SIDE_EFFECT, TRUST, APPROVAL, POLICY, RETRY, PROVIDER, OVERRIDES,
  describe, all, byEffect, needsApproval, effectFor, DEFAULT_TIMEOUT_MS,
};
