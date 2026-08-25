'use strict';

/**
 * THE MODEL'S ROUTE TO THE PROBE — and it is a thin one on purpose.
 *
 *     model → this tool → probe connection → Probe's own gate → Probe engine → target
 *
 * LAIN reads no memory, attaches to no process, synthesises no input and
 * captures no screen. This forwards an operation to an external companion the
 * user started with `/mcp probe`, and everything dangerous about it is decided
 * on the far side.
 *
 * WHY ONE TOOL AND NOT SIXTY-FOUR. The Probe implements 64 operations. Putting
 * each one in the model's schema list would spend several thousand tokens of
 * every request in the session — including the ones about nothing but code —
 * and would hand the model sixty-four near-neighbours to choose between. So the
 * surface is one tool with an `op`, and `op:"capabilities"` asks the Probe what
 * it actually has. Discovery costs one call when the model needs it, instead of
 * a permanent tax on every request.
 *
 * IT ONLY EXISTS WHILE A PROBE IS CONNECTED. `tools/index.js` includes this
 * only while `probe.live()` returns one, so an ordinary coding session is never
 * told the machine can be instrumented — and cannot try. That is the same rule
 * `desktop` follows, for the same reason.
 *
 * LAIN HAS NO GATE OF ITS OWN, deliberately. The Probe prompts in its own
 * always-on-top window, per capability, at the moment it acts, and it is the
 * only thing that decides. Gating it a second time in LAIN would ask the user
 * twice for one decision, and prompts people learn to click through protect
 * nobody. A refusal comes back as a readable result flagged `denied`, and is
 * final for that request.
 *
 * WHAT LAIN DOES DO IS CHOOSE WHEN THE PROMPT HAPPENS — for keyboard input,
 * BEFORE the window is aimed rather than after. The prompt is a topmost window
 * and takes the foreground; asking for permission after focusing meant the
 * keystroke that followed the grant went to the Probe's own prompt. That is not
 * a second gate, it is an ordering, and it lives in keyboarddelivery.js.
 */

const probeMod = require('../probe');

/**
 * THE OPERATIONS THAT MOVED, and what they are called now.
 *
 * Derived from computer.js so the two cannot disagree: if a dialect entry
 * exists for the Probe, `computer` owns that operation and this tool does not.
 * Adding an op to the dialect therefore retires it here automatically, which
 * is the only arrangement that stays true without anybody remembering to.
 */
function MOVED_TO_COMPUTER(op) {
  const { DIALECT } = require('../computer');
  const probeDialect = (DIALECT && DIALECT.probe) || {};
  for (const [ours, theirs] of Object.entries(probeDialect)) {
    if (theirs && theirs === op) return ours;
  }
  return null;
}

const GROUPS = {
  probe: 'what this Probe can do, its status and health',
  process: 'find, attach to and inspect a running process',
  memory: 'read, scan and narrow candidate addresses',
  investigate: 'coordinated experiments that produce evidence, not raw data',
  code: 'disassembly, and which instruction writes an address',
  debug: 'breakpoints and watchpoints, disarmed on every exit path',
  pointer: 'module-anchored paths that survive a restart',
  finding: 'persist a discovery with its evidence, and read it back later',
  artifact: 'generate a standalone script from a Finding, and verify it',
  // `vision` and `input` are deliberately absent: screen and input are the
  // `computer` tool's, over this same connection. See MOVED_TO_COMPUTER.
  app: 'launch and close GUI applications',
  automation: 'scripted interaction with a target',
  python: 'run Python against the target, time-limited and killable',
  permission: 'what the Probe currently permits itself',
  session: 'the shared conversation surface',
};

const schema = {
  name: 'probe',
  description:
    'Investigate a RUNNING program through the LAIN Probe, an external companion the user has '
    + 'started. It can attach to a process, scan and narrow its memory, correlate a value with '
    + 'something the user does, find the instruction that writes an address, follow pointers, '
    + 'run Python against the target, and keep what it discovers as persistent Findings. '
    + 'To SEE the screen, move the mouse or press a key, use the `computer` tool instead: it '
    + 'drives this same Probe, and it is the only route that asks permission before aiming '
    + 'and reports whether the target really received the input. '
    + 'Call op:"capabilities" FIRST to see what this Probe offers — the names are not guessable '
    + "and change with its version — then params {\"of\":\"<name>\"} for that operation's exact "
    + 'parameters, rather than guessing argument names. '
    + 'The Probe asks the user for permission in its own window, per capability, at the moment it '
    + 'acts; a refusal is final for that request — do not ask again. '
    + 'It returns evidence and computed confidence, never conclusions: reason over what it reports.',
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        description:
          'The operation. "capabilities" lists what this Probe offers, grouped, with the exact '
          + "names to use — and with params {\"of\":\"investigate.behavior\"} it returns that "
          + "operation's parameter schema. Anything else is one of those names.",
      },
      params: {
        type: 'object',
        description: 'Operation arguments, e.g. { "pid": 1234 } or { "address": "0x1abc", "type": "float32" }.',
      },
      // KEPT SHORT DELIBERATELY. This schema rides on every request of the
      // session and the Probe's own suite budgets it; the long version of this
      // reasoning belongs in keyboarddelivery.js, which the model never reads.
      window: {
        type: 'string',
        description:
          'REQUIRED for keyboard ops: the TITLE of the window the keys are for. Without it '
          + 'NOTHING IS SENT — an unaimed keystroke lands wherever the user is looking. '
          + 'op:"input.keyboard.hold" params {key, ms} holds and releases a key. '
          + 'Keyboard results are SENT_UNCONFIRMED: the OS accepted it, nothing saw the target '
          + 'get it. To establish delivery, observe the target — its log, or a capture.',
      },
      why: {
        type: 'string',
        description: 'One short sentence explaining why this is needed. Shown to the user in the activity trail.',
      },
    },
    required: ['op'],
  },
};

/**
 * A HOLD IS LAIN'S, NOT THE PROBE'S.
 *
 * The Probe has `input.keyboard.press` and `input.keyboard.release` — two
 * edges, no lifecycle. A hold is the pair with a measured time between them and
 * a release that happens whatever else goes wrong, which is orchestration, and
 * orchestration is this side of the boundary. The name is in the Probe's
 * dialect so the model does not have to learn a second one.
 */
const HOLD_OP = 'input.keyboard.hold';

/**
 * EVERY KEYSTROKE GOES THROUGH THE SEQUENCE, and comes back as its trail.
 *
 * The trail is the answer to "why did the key not arrive": each stage that was
 * reached, in order, with what the Probe said at it. A model that is told only
 * "failed" will retry; a model that is told FOCUS_FAILED with the OS's reason
 * will focus the window or ask the user to.
 */
async function keyboard({ op, params, window, why, capability, probe }) {
  const kbd = require('../keyboarddelivery');
  const capMod = require('../capability');

  const outcome = op === HOLD_OP
    ? await kbd.hold({
      probe, window,
      key: params.key || params.keys || params.text,
      ms: params.ms || params.duration_ms || params.hold_ms,
      reason: why,
    })
    : await kbd.deliver({ probe, op, params, window, capability, reason: why });

  const sent = outcome.stage === capMod.STAGE.SENT_UNCONFIRMED;
  const e = capMod.envelope({
    op, stage: outcome.stage, capability, aim: 'FOCUS',
    why: outcome.why || '',
    result: sent ? (outcome.result == null ? { ok: true } : outcome.result) : null,
  });
  const lines = [e.text, '', 'WHAT ACTUALLY HAPPENED, in order:', ...kbd.trailLines(outcome.trail)];
  if (op === HOLD_OP && outcome.held) {
    lines.push('', `The key was DOWN for ${outcome.held}ms and then released. Both edges were `
      + 'accepted by the OS; neither has been observed arriving at the target.');
  }
  return {
    output: lines.join('\n').slice(0, 20000),
    isError: !sent,
    meta: { probe: op, state: outcome.stage, why: why || undefined },
  };
}

/** Timeouts: an investigation waits for a person, so it cannot use the default. */
const SLOW = /^(investigate\.|automation\.|python\.|artifact\.|code\.find|debug\.|app\.launch)/;
function timeoutFor(op) {
  return SLOW.test(op) ? 300_000 : probeMod.CALL_TIMEOUT_MS;
}

/**
 * Discovery, answered from the Probe rather than from a list kept here.
 *
 * A second list in LAIN would go stale the moment the Probe grew a tool, and
 * would name operations that do not exist or omit ones that do.
 */
async function capabilities(probe, params) {
  // ASKED FOR BY NAME, not dumped by default.
  //
  // `of` returns the full parameter schema for one operation or one group.
  // Without it a model knows what exists and guesses how to call it - measured
  // against a real model, four of its first seven calls failed on invented
  // argument names. With it, the schema costs one call when it is needed
  // instead of sixty-four schemas on every request.
  const of = params && typeof params.of === 'string' ? params.of.trim() : '';
  if (of) {
    const d = await probe.call('probe.tools', { describe: of }, 20_000);
    if (!d.ok) return { output: `could not describe ${of}: ${d.error}`, isError: true };
    return { output: JSON.stringify(d.result).slice(0, 20000), meta: { probe: 'capabilities', of } };
  }
  const r = await probe.call('probe.tools', { implemented_only: true }, 20_000);
  if (!r.ok) return { output: `could not read the Probe's capabilities: ${r.error}`, isError: true };
  const tools = (r.result && r.result.tools) || [];
  const byGroup = new Map();
  for (const t of tools) {
    const name = String(t.name || '');
    const group = name.split('.')[0] || 'other';
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(t);
  }
  const lines = [`${tools.length} operations, in ${byGroup.size} groups. `
    + 'Call any of them as probe(op: "<name>", params: {...}). '
    + 'For the exact parameters of one, call probe(op: "capabilities", params: {of: "<name>"}) '
    + 'first — guessing argument names wastes a call.'];
  for (const [group, items] of [...byGroup.entries()].sort()) {
    const hint = GROUPS[group] ? ` — ${GROUPS[group]}` : '';
    lines.push('');
    lines.push(`## ${group}${hint}`);
    for (const t of items.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      lines.push(`  ${t.name}${t.summary ? '  ' + t.summary : ''}`);
    }
    // DISCOVERY HAS TO INCLUDE IT OR IT DOES NOT EXIST. The hold is LAIN's own
    // composite over the Probe's two edges, so `probe.tools` cannot know about
    // it — and an operation only the schema mentions is one the model, having
    // just been told to trust this list, will not use. Listed where it belongs,
    // in the group whose primitives it is made of.
    if (group === 'input') {
      lines.push(`  ${HOLD_OP}  hold a key down for a time and release it (LAIN: press + wait + release)`);
    }
  }
  return { output: lines.join('\n').slice(0, 20000), meta: { probe: 'capabilities' } };
}

async function run(input, ctx) {
  const app = ctx && ctx.app;
  const probe = app && app._probe;
  if (!probe) {
    return {
      output: 'no Probe is attached to this session. The user starts one with /mcp probe. '
        + 'Nothing was done; do not describe an investigation that did not happen.',
      isError: true,
    };
  }
  if (probe.state !== probeMod.STATE.CONNECTED) {
    return {
      output: `the Probe is ${probe.state}${probe.reason ? ` — ${probe.reason}` : ''}. `
        + 'Nothing was done.',
      isError: true,
    };
  }

  const op = String(input.op || '').trim();
  if (!op) return { output: 'probe needs an "op". Call op:"capabilities" to see what is available.', isError: true };

  const why = String(input.why || '').slice(0, 160);

  if (op === 'capabilities') {
    return capabilities(probe, input.params && typeof input.params === 'object'
      ? input.params : {});
  }

  // ---- SCREEN AND INPUT BELONG TO `computer`, NOT HERE -------------------
  //
  // The Probe can do these and still does — `computer` reaches them through
  // this very connection (see computer.js DIALECT). What it may no longer do
  // is offer them to the MODEL as a second spelling. A model with a Probe up
  // was being handed both `computer{op:"key"}` and `probe{op:"input.keyboard
  // .tap"}` for one keystroke, and the two are not interchangeable: only the
  // first carries the permission-before-aiming order, the foreground
  // re-verification and the SENT_UNCONFIRMED distinction.
  //
  // REDIRECTED, NOT SILENTLY DROPPED. The model is told the operation exists
  // and where it moved, so this costs it one call and never a capability.
  const moved = MOVED_TO_COMPUTER(op);
  if (moved) {
    return {
      output: `${op} is not called through the probe tool — screen and input are LAIN's own, `
        + `not the Probe's. Use the computer tool: op:"${moved}". It reaches this same Probe, `
        + 'and only it asks for permission before aiming and reports whether the target really '
        + 'received the input. Nothing was done.',
      isError: true,
      meta: { probe: op, movedTo: moved },
    };
  }

  const params = input.params && typeof input.params === 'object' ? input.params : {};

  // WHAT IS TRUE BEFORE THE CALL, for the operations where it can be false.
  //
  // Only for operations that need a capability or are aimed at something —
  // roughly a dozen of the Probe's seventy-three. An investigation call pays
  // nothing for this, and an input call pays two cheap reads for the difference
  // between a named state and a sentence from a foreign process.
  const cap = require('../capability');
  const aimed = cap.aim(op) !== 'NONE' || cap.capabilityOf(op);
  const pre = aimed ? await preflight(probe, op) : null;
  if (pre && pre.blocking) {
    // NOT ATTEMPTED, AND SAID SO. Advisory in capability.js, refused here,
    // because sending an operation that cannot succeed produces an error from
    // the far side that reads like a malfunction rather than like a missing
    // authorisation. Nothing is gated that the far side would have allowed.
    const e = cap.envelope({ op, stage: pre.stage, capability: pre.capability, aim: pre.aim, why: pre.why, target: pre.target });
    return { output: e.text + '\nNothing was done.', isError: true, meta: { probe: op, state: e.state } };
  }

  // ---- FOCUS BEFORE A KEYSTROKE, VERIFIED, OR NOTHING IS SENT ------------
  //
  // Audited against the real Probe on 2026-08-21 with a target process that
  // logged what it actually received:
  //
  //     window.focus        SUCCEEDED (foreground really changed)
  //     input.mouse.click   target receipt VERIFIED
  //     input.keyboard.tap  target receipt NOT VERIFIED
  //
  // Both reported ok. The asymmetry is structural: the mouse is addressed by
  // absolute screen coordinate and lands on whatever pixel is there, while a
  // keystroke goes to whatever holds focus — and the Probe's own permission
  // prompt is a topmost window, so granting keyboard permission puts the PROBE
  // in front and the keystroke that follows lands on it. That is the reported
  // "input only affects the Probe's own window", exactly.
  //
  // THE ORDER LIVES IN keyboarddelivery.js. It was inline here and it was in
  // the WRONG ORDER: focus, then send, then the Probe's prompt appears and
  // takes the foreground, then the user clicks Allow, and the key that follows
  // goes to the Probe. Asking for permission BEFORE aiming is the fix, and the
  // sequence is long enough — permission, focus, re-verify, inject — to deserve
  // its own file and its own tests. See that file's header for the trace.
  if (cap.needsFocus(op)) {
    const want = String(params.window || input.window || '').trim();
    // `window` is LAIN's, not the Probe's: passing it on would be an unknown
    // argument to an operation that never had one.
    delete params.window;
    return keyboard({ op, params, window: want, why, capability: pre && pre.capability, probe });
  }

  const r = await probe.call(op, params, timeoutFor(op));

  if (!r.ok) {
    // A DENIAL IS A RESULT, and it is final. Saying so in the text the model
    // reads is what stops a second ask; a denial that can be worn down is not
    // a denial.
    if (r.denied) {
      return {
        output: `the user did not allow ${r.capability || 'that capability'} (${r.error}). `
          + 'Nothing was done. Do not ask again for this; continue without it or say what you '
          + 'cannot do.',
        isError: true,
      };
    }
    // Carry the detail, not just the sentence. A failing script's exit code,
    // stderr and exception are the whole reason the model can fix it.
    const detail = r.result ? ' ' + JSON.stringify(r.result).slice(0, 4000) : '';
    return { output: `${op} failed: ${r.error}${detail}`, isError: true };
  }

  const value = r.result;

  // AN AIMED ACTION COMES BACK AS EVIDENCE, never as `{"ok":true}`.
  //
  // The model must never have to guess whether an input happened, or to what.
  // For a coordinate- or focus-addressed action the envelope says so in the
  // result itself — that the action was NOT confirmed to have reached any
  // particular window — because a model told only "success" will build its next
  // five steps on the assumption that it landed where it aimed.
  if (aimed) {
    // AN ACCEPTED INJECTION IS NOT A DELIVERED KEYSTROKE, and the two had one
    // word between them. `SendInput` returning a count means Windows queued the
    // events; whether the intended application received them is a separate fact
    // that nothing here observed. Every synthesised input therefore returns
    // SENT_UNCONFIRMED — never SUCCEEDED — so the model has to go and look
    // rather than build its next five steps on a number from an API. See
    // capability.js for the measurement this comes from.
    const stage = cap.aim(op) === 'NONE' ? cap.STAGE.SUCCEEDED : cap.STAGE.SENT_UNCONFIRMED;
    const e = cap.envelope({
      op, stage, capability: pre && pre.capability, aim: cap.aim(op),
      result: value == null ? { ok: true } : value, target: pre && pre.target,
    });
    return { output: e.text.slice(0, 20000), meta: { probe: op, state: e.state, why: why || undefined } };
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value == null ? { ok: true } : value);
  return {
    output: (text + bothBases(value)).slice(0, 20000),
    meta: { probe: op, why: why || undefined },
  };
}

/**
 * THE SAME NUMBERS, IN THE OTHER BASE — appended, never substituted.
 *
 * A Probe result is JSON and stays JSON: the payload above is untouched, so
 * anything parsing it sees exactly what it saw before. What is added is a short
 * human reading of the fields where the second base genuinely helps.
 *
 * A PID is natural in decimal because that is what every process list shows; an
 * address is natural in hexadecimal because that is what a disassembler and a
 * map file show. Having only one of the two means converting by hand in the
 * middle of thinking about something else — and doing it wrong on a 64-bit
 * value, which is exactly where it matters.
 *
 * Only named fields are annotated (see numfmt.FIELD). Adding `(0x3)` to a count
 * of 3 would bury the two values that matter under a wall of noise.
 */
function bothBases(value) {
  if (!value || typeof value !== 'object') return '';
  let rows;
  try { rows = require('../numfmt').lines(value); } catch { rows = []; }
  if (!rows.length) return '';
  return `\n\nDEC / HEX — the same values from the payload above, in both bases:\n${rows.join('\n')}`;
}

/**
 * The capability and target state, read from the Probe and cached briefly.
 *
 * Two extra round trips per aimed call would be two per click in an automation
 * loop. The window is short enough that a permission granted or a target
 * authorised mid-task is picked up on the next action, and long enough that a
 * burst of input costs one read.
 */
const PRE_TTL_MS = 3000;
let _pre = { at: 0, granted: null, target: null };

async function preflight(probe, op) {
  const cap = require('../capability');
  const now = Date.now();
  if (now - _pre.at > PRE_TTL_MS) {
    const snap = await cap.readState(probe);
    _pre = {
      at: now,
      granted: snap.capabilities
        ? Object.fromEntries(Object.entries(snap.capabilities).map(([k, v]) => [k, v.granted]))
        : null,
      target: snap.target,
    };
  }
  const r = cap.preflight({
    op, connected: probe.state === require('../probe').STATE.CONNECTED,
    granted: _pre.granted, target: _pre.target,
  });
  r.target = _pre.target;
  return r;
}

/** Testing seam: forget what was read, so a test is never served a stale grant. */
function _forgetPreflight() { _pre = { at: 0, granted: null, target: null }; }

/**
 * THE EXPLICIT DOOR BACK OUT — one named operation, never a silent fallback.
 *
 * While the environment is PROBE, the CLI tools are withdrawn (environment.js
 * checkToolAllowed, enforced in tools/index.js). This is the one deliberate way
 * an investigation asks for a shell-level operation the Probe has no
 * operation for — fetching an executable, reading a log the target wrote, a
 * tasklist. The model must NAME the bridge, so the cost of leaving the Probe's
 * vocabulary is one deliberate call with a stated reason, and the trail keeps
 * the provenance of what ran outside.
 *
 * WHY FORWARD TO THE SHELL TOOLS rather than reimplementing a spawn: one shell
 * implementation, already annotated with the failure classification and the
 * cwd resolution — this composes it instead of growing a second one.
 */
const BRIDGE_SHELLS = {
  bash: 'run_bash', powershell: 'run_powershell', cmd: 'run_cmd',
};

async function bridgeCli(input, ctx) {
  const shellName = String(input.shell || 'bash').toLowerCase();
  const toolName = BRIDGE_SHELLS[shellName];
  if (!toolName) {
    return {
      output: `probe.bridge_cli runs bash, powershell or cmd — got "${shellName}".`,
      isError: true,
    };
  }
  const command = String(input.command || '').trim();
  if (!command) return { output: 'probe.bridge_cli needs a command.', isError: true };
  // THE ENVIRONMENT SAYS WHAT THIS WAS, ON THE TRAIL: a shell command that ran
  // by explicit bridge during a PROBE task, not a silent CLI fallback.
  // Counted as the metric the acceptance criteria name: a CLI-level operation
  // that had to run outside the Probe. Not a failure — a measurement.
  require('../environment').note(ctx && ctx.app, 'cli_fallbacks');
  const r = await require('./shell').tools[toolName].run(input, ctx);
  const note = `\n\n[via probe.bridge_cli — a shell command during a PROBE task; `
    + `the Probe did not run this, the machine's shell did]`;
  return { ...r, output: `${String(r.output || '')}${note}`.slice(0, 20000) };
}

const bridgeSchema = {
  name: 'probe.bridge_cli',
  description:
    'Run ONE shell command during a Probe investigation, when the Probe itself has no operation for it '
    + '(fetching an executable, reading a log, a tasklist). Everything about the LIVE TARGET still goes '
    + 'through the probe tool. This is explicit on purpose: name it only for the genuinely CLI-level step, '
    + 'and say in `why` what it is for.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'the command line to execute' },
      shell: { type: 'string', description: 'bash (default), powershell or cmd' },
      cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
      why: { type: 'string', description: 'one short sentence: why the investigation needs this shell command' },
    },
    required: ['command'],
  },
};

module.exports = {
  tools: {
    probe: { mutates: true, schema, run },
    probe_bridge_cli: { mutates: true, schema: bridgeSchema, run: bridgeCli },
  },
  _forgetPreflight,
};
