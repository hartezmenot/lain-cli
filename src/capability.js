'use strict';

/**
 * WHAT IS ACTUALLY POSSIBLE RIGHT NOW — one vocabulary for the whole path.
 *
 *     model → tool → LAIN → bridge/Probe → capability gate → target → the OS
 *
 * Every stage of that path had its own words for the same facts, and none of
 * them met. `mcp.js` calls the operation names it will accept "capabilities".
 * `probe.js` calls the Probe's 73 tool names "capabilities". The Probe calls
 * `mouse.click` a capability, and reports separately whether a TARGET is
 * authorised. So three different things were called the same word, and the one
 * question a person actually asks —
 *
 *     "it says CONNECTED; why did the click not happen?"
 *
 * — could not be answered from any of them. This file is the single place that
 * knows the difference between:
 *
 *     THE OPERATION EXISTS        the bridge implements it
 *     THE CAPABILITY IS GRANTED   the user has allowed that KIND of action
 *     A TARGET IS AUTHORISED      there is a process this may be aimed at
 *     THE ACTION SUCCEEDED        and here is what came back
 *
 * WHAT THIS FILE DOES NOT DO. It does not gate anything. The Probe prompts in
 * its own window, per capability, at the moment it acts, and the desktop bridge
 * is gated in permissions.js; a second gate here would ask the user twice for
 * one decision, and prompts people learn to click through protect nobody. This
 * READS the state and NAMES it. Nothing here synthesises input, captures a
 * screen, or decides that something is allowed.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS WAS BUILT FROM, traced against the real Probe on 2026-08-20:
 *
 *   permission.state    15 capabilities, every one `granted: false`
 *   target.status       { authorized: false, reason: "NO_AUTHORIZED_TARGET" }
 *   input.mouse.click   params: x, y, button, restore, double
 *
 * The click takes SCREEN COORDINATES. It has no window parameter, nothing
 * focuses the authorised process before it fires, and nothing afterwards
 * establishes which window received it. `window.focus` exists — and reports
 * whether Windows actually allowed the focus — and nothing was calling it.
 *
 * That is the whole of "permission was granted and it hit the wrong thing":
 * not a broken grant, an UNAIMED ACTION. LAIN cannot fix that by aiming it —
 * aiming is the Probe's job — but it must never again let a model believe an
 * action reached a target that nothing ever confirmed.
 */

/**
 * THE STATES ONE ATTEMPT CAN BE IN. Exhaustive on purpose: every path out of
 * an attempted operation ends on exactly one of these, and "it just didn't
 * work" is not one of them.
 */
const STAGE = Object.freeze({
  /** The model asked. Nothing has happened yet. */
  REQUESTED: 'REQUESTED',
  /** No bridge/Probe is connected, so nothing can be attempted. */
  BRIDGE_LOST: 'BRIDGE_LOST',
  /** The user has not allowed this kind of action; they are being asked. */
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  /** The user said no. Final for this request. */
  REFUSED: 'REFUSED',
  /** The action is aimed at a process and no process is authorised. */
  NO_TARGET: 'NO_TARGET',
  /** There WAS an authorised target and it is gone. */
  TARGET_LOST: 'TARGET_LOST',
  /** Allowed, not yet run. */
  GRANTED: 'GRANTED',
  /**
   * THE THREE STAGES OF AIMING, which used to be one silent gap.
   *
   * A keystroke goes wherever the foreground is, so "before it was sent" is
   * not one moment but three, and the reported failure happened in the middle
   * of them: the window was brought up, something else took the foreground,
   * and the key went to that. Naming them separately is what lets the trail
   * say WHICH of the three did not hold.
   */
  FOCUSING: 'FOCUSING',
  FOCUSED: 'FOCUSED',
  INJECTING: 'INJECTING',
  /**
   * A WITNESS SAW THE TARGET RECEIVE IT.
   *
   * The ONLY stage that may be reported on the strength of the target's own
   * account — its log, a value it wrote, a change observed in it. Never on the
   * strength of an API return value, and never on the strength of the Probe
   * saying the injection was accepted; that is SENT_UNCONFIRMED, below, and
   * the difference between the two is the entire point of this vocabulary.
   */
  DELIVERED: 'DELIVERED',
  /** In flight on the far side. */
  EXECUTING: 'EXECUTING',
  /** It ran, and the far side reported success. */
  SUCCEEDED: 'SUCCEEDED',
  /** It ran, or could not run, and the far side reported why. */
  FAILED: 'FAILED',
  /**
   * The intended window could not be brought to the foreground, so NOTHING
   * WAS SENT. Windows refuses foreground changes in several situations and
   * reports success anyway, so this is the verified answer, not the API's.
   */
  FOCUS_FAILED: 'FOCUS_FAILED',
  /**
   * The OS accepted the injection and NOBODY OBSERVED THE TARGET RECEIVE IT.
   *
   * This is the state the audit of 2026-08-21 was missing, and its absence is
   * the whole reported bug: `SendInput` returning a count means Windows queued
   * the events, not that the intended application got them. Measured on this
   * machine, with focus verified: the mouse click was received by the target
   * and the keystrokes were not — one SUCCEEDED and one silently did nothing,
   * and both had reported ok.
   */
  SENT_UNCONFIRMED: 'SENT_UNCONFIRMED',
});

/** Stages that mean the attempt is over and nothing reached the machine. */
const DEAD = Object.freeze([STAGE.BRIDGE_LOST, STAGE.REFUSED, STAGE.NO_TARGET, STAGE.TARGET_LOST]);

/**
 * WHICH CAPABILITY AN OPERATION NEEDS.
 *
 * Both dialects, in one table, because they are two spellings of one idea and
 * keeping them apart is what let "capabilities" mean three things. The Probe's
 * names are dotted and fine-grained (`mouse.click`); the desktop bridge's are
 * coarse (`mouse`). An operation absent from here needs no capability — which
 * is a real answer, not a gap: `probe.tools`, `target.list` and `window.list`
 * genuinely require none.
 */
const CAPABILITY_OF = Object.freeze({
  // ---- the Probe's dialect ----
  'input.mouse.move': 'mouse.move',
  'input.mouse.click': 'mouse.click',
  'input.mouse.drag': 'mouse.click',
  'input.mouse.position': 'mouse.read',
  'input.keyboard.press': 'keyboard.press',
  'input.keyboard.release': 'keyboard.release',
  'input.keyboard.tap': 'keyboard.press',
  // A HOLD IS LAIN'S COMPOSITE of press + release (see tools/probe.js). It
  // needs the same capability and follows the same focus rules as either edge,
  // so it belongs in both tables rather than in a special case.
  'input.keyboard.hold': 'keyboard.press',
  'input.keyboard.type': 'keyboard.press',
  'vision.screen.capture': 'screen.capture',
  'screen.capture': 'screen.capture',
  'screen.ocr': 'screen.ocr',
  'process.attach': 'process.attach',
  'process.terminate': 'process.terminate',
  'memory.read': 'memory.read',
  'memory.write': 'memory.write',
  'memory.scan': 'memory.read',
  'debug.attach': 'debug.attach',
  'debug.breakpoint': 'debug.breakpoint',
  'debug.watchpoint': 'debug.breakpoint',
  'python.run': 'python.execute',
  'python.execute': 'python.execute',
  // ---- the desktop bridge's dialect ----
  'mouse.move': 'mouse',
  'mouse.click': 'mouse',
  'keyboard.type': 'keyboard',
  'keyboard.key': 'keyboard',
  'window.list': 'window',
  'window.focus': 'window',
});

function capabilityOf(op) { return CAPABILITY_OF[String(op || '')] || null; }

/**
 * OPERATIONS THAT ADDRESS THE SCREEN, NOT A WINDOW.
 *
 * The distinction that the reported failure turns on. A click at (900, 400)
 * goes wherever (900, 400) is — to the frontmost window, the desktop, or the
 * thing that moved there while the model was thinking. Calling that "clicking
 * on the target" is the lie this set exists to prevent.
 */
const SCREEN_SCOPED = new Set([
  'input.mouse.move', 'input.mouse.click', 'input.mouse.drag', 'input.mouse.position',
  'mouse.move', 'mouse.click',
  'screen.capture', 'vision.screen.capture', 'screen.ocr',
]);

/**
 * OPERATIONS THAT GO TO WHATEVER HAS KEYBOARD FOCUS.
 *
 * Same problem, worse consequences: a coordinate at least says where it went,
 * and typing says nothing at all. Text typed at the wrong window is text typed
 * into somebody's document.
 */
const FOCUS_SCOPED = new Set([
  'input.keyboard.type', 'input.keyboard.tap', 'input.keyboard.press', 'input.keyboard.release',
  'input.keyboard.hold',
  'keyboard.type', 'keyboard.key',
]);

/** Operations that act ON an authorised process and are meaningless without one. */
const TARGET_SCOPED = new Set([
  'process.attach', 'process.terminate',
  'memory.read', 'memory.write', 'memory.scan',
  'debug.attach', 'debug.breakpoint', 'debug.watchpoint',
]);

/**
 * DOES THIS OPERATION GO WHEREVER THE FOREGROUND IS?
 *
 * Traced through lain-probe on 2026-08-21, and the answer decides everything:
 *
 *   input.keyboard.*  SendInput with a virtual-key code and NO window. It
 *                     lands on whatever holds focus at that instant.
 *   input.mouse.*     SendInput at ABSOLUTE SCREEN COORDINATES. It lands on
 *                     whatever pixel is there, focus or no focus.
 *
 * That asymmetry is the reported bug in one line. The Probe's own permission
 * prompt is a topmost window: granting keyboard permission puts the PROBE in
 * the foreground, and the keystroke that follows the grant goes to the Probe.
 * The mouse, addressed by coordinate, is unaffected and lands on the target —
 * which is why clicking appeared to work while typing did not.
 *
 * So a focus-following operation MUST NOT BE SENT until the intended window is
 * verified foreground. Not as advice: an unaimed keystroke goes into whatever
 * the person is looking at, which may be their editor.
 */
function needsFocus(op) { return FOCUS_SCOPED.has(String(op || '')); }

function aim(op) {
  const o = String(op || '');
  if (SCREEN_SCOPED.has(o)) return 'SCREEN';
  if (FOCUS_SCOPED.has(o)) return 'FOCUS';
  if (TARGET_SCOPED.has(o)) return 'TARGET';
  return 'NONE';
}

/**
 * WHAT IS TRUE BEFORE THE CALL IS MADE.
 *
 * Advisory, never a veto — see the file header. It answers "is there any point
 * attempting this, and what should the model be told either way", so a failure
 * arrives as a named state instead of as a sentence the model has to guess at.
 *
 * @param {object} o
 *   op          the operation about to be called
 *   connected   is the bridge/Probe actually connected
 *   granted     map of capability → boolean, as the far side reports it
 *   target      the far side's target status, or null if it has no such concept
 * @returns {{stage, capability, aim, why, blocking}}
 *   `blocking` is ADVICE — that this cannot succeed as asked — never enforcement.
 */
function preflight({ op, connected = false, granted = null, target = null } = {}) {
  const capability = capabilityOf(op);
  const at = aim(op);
  if (!connected) {
    return { stage: STAGE.BRIDGE_LOST, capability, aim: at, blocking: true,
      why: 'nothing is connected, so nothing was attempted' };
  }
  // A TARGET-SCOPED OPERATION WITH NO TARGET cannot do anything but fail, and
  // saying so before the call is the difference between a named state and a
  // sentence from a foreign process.
  if (at === 'TARGET' && target && target.authorized === false) {
    return { stage: STAGE.NO_TARGET, capability, aim: at, blocking: true,
      why: target.reason === 'NO_AUTHORIZED_TARGET'
        ? 'no process is authorised — the person at the machine chooses one'
        : String(target.reason || 'no authorised target') };
  }
  if (capability && granted && granted[capability] === false) {
    return { stage: STAGE.PERMISSION_REQUIRED, capability, aim: at, blocking: false,
      why: `the user has not allowed ${capability}; they will be asked when it is attempted` };
  }
  return { stage: STAGE.GRANTED, capability, aim: at, blocking: false, why: '' };
}

/**
 * WHAT THE MODEL IS TOLD AFTERWARDS — evidence, never a bare `ok`.
 *
 * `{"success": true}` is the shape that made this necessary: it says an
 * operation returned, and nothing whatever about whether the machine did
 * anything, or to what. The model then has to guess, and a model that guesses
 * an input landed will build its next five steps on top of the guess.
 *
 * Everything here is either something the far side reported or something LAIN
 * knows for certain. Nothing is inferred. When aim is SCREEN or FOCUS, the
 * unverified-target line is ALWAYS present — that is not a caveat, it is the
 * single most important fact about what just happened.
 *
 * @returns {{state, text, evidence}}
 */
function envelope({ op, stage, capability, aim: at, result = null, error = null, target = null, why = '' }) {
  const evidence = {
    action: op,
    state: stage,
    capability: capability || null,
    aim: at || 'NONE',
    at: new Date().toISOString(),
  };
  if (target && target.authorized) evidence.target = target.selected || target.summary || 'authorised';
  else if (at === 'TARGET') evidence.target = null;
  if (result !== null && result !== undefined) evidence.result = result;
  if (error) evidence.error = String(error);

  const lines = [`${op} — ${stage}`];
  if (why) lines.push(why);
  if (capability) lines.push(`capability: ${capability}`);

  // THE OUTCOME OUTRANKS THE AIM. Both matter, but a refusal to send and an
  // unconfirmed delivery are statements about what HAPPENED, and describing the
  // aim of an action that was never sent reads as though it was sent.
  if (stage === STAGE.FOCUS_FAILED) {
    lines.push('NOTHING WAS SENT. The intended window could not be brought to the foreground, '
      + 'and a keystroke sent now would go to whatever is in front — possibly the user\'s own work.');
    evidence.injection = { requested: true, accepted: false };
    evidence.delivery = { verified: false, reason: 'FOCUS_FAILED' };
    return { state: stage, text: lines.join('\n'), evidence };
  }
  if (stage === STAGE.SENT_UNCONFIRMED) {
    // THE HONEST DEFAULT FOR INJECTED INPUT, and the state whose absence was the
    // whole reported bug. Measured through lain-probe on 2026-08-21 with focus
    // verified: the mouse click reached the target, the keystrokes did not, and
    // BOTH had reported ok.
    lines.push('The OS accepted this input. NOBODY OBSERVED THE TARGET RECEIVE IT — an accepted '
      + 'injection is not a delivered keystroke. Confirm by observing the target change '
      + '(its own log, a value it wrote, a capture) before relying on it.');
    evidence.injection = { requested: true, accepted: true };
    evidence.delivery = { verified: false, reason: 'TARGET_RECEIPT_NOT_OBSERVED' };
    if (result !== null && result !== undefined) {
      evidence.result = result;
      lines.push((typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 16000));
    }
    return { state: stage, text: lines.join('\n'), evidence };
  }

  // THE AIM, SAID PLAINLY, on every input operation.
  if (at === 'SCREEN') {
    lines.push('aim: SCREEN COORDINATES. This addressed a point on the screen, not a window. '
      + 'Nothing has confirmed which window received it — focus the intended window first '
      + '(window.focus reports whether the OS actually allowed it) and verify afterwards.');
    evidence.verification = { status: 'unconfirmed', reason: 'coordinate-addressed; no window was confirmed to receive it' };
  } else if (at === 'FOCUS') {
    lines.push('aim: WHATEVER HAS KEYBOARD FOCUS. This did not name a window. '
      + 'If the intended window was not frontmost, the text went somewhere else — '
      + 'focus it first and verify afterwards.');
    evidence.verification = { status: 'unconfirmed', reason: 'focus-addressed; no window was confirmed to receive it' };
  } else if (stage === STAGE.SENT_UNCONFIRMED) {
    // THE HONEST DEFAULT FOR INJECTED INPUT. The OS accepted it; nobody saw it
    // arrive. Saying SUCCEEDED here is the false success the audit found.
    lines.push('The OS accepted this input. NOBODY OBSERVED THE TARGET RECEIVE IT — '
      + 'an accepted injection is not a delivered keystroke. Verify by observing the '
      + 'target change (a screenshot, its own log, a value it wrote) before relying on it.');
    evidence.injection = { requested: true, accepted: true };
    evidence.delivery = { verified: false, reason: 'TARGET_RECEIPT_NOT_OBSERVED' };
  } else if (stage === STAGE.FOCUS_FAILED) {
    lines.push('NOTHING WAS SENT. The intended window could not be brought to the '
      + 'foreground, and a keystroke sent now would go to whatever is in front — '
      + 'possibly the user\'s own work.');
    evidence.injection = { requested: true, accepted: false };
    evidence.delivery = { verified: false, reason: 'FOCUS_FAILED' };
  } else if (stage === STAGE.SUCCEEDED) {
    evidence.verification = { status: 'reported', reason: 'the far side reported success' };
  }

  if (error) lines.push(`reason: ${error}`);
  if (result !== null && result !== undefined) {
    const body = typeof result === 'string' ? result : JSON.stringify(result);
    lines.push(body.slice(0, 16000));
  }
  return { state: stage, text: lines.join('\n'), evidence };
}

/**
 * THE CAPABILITY PICTURE, for the status surfaces.
 *
 * `CONNECTED` on its own is what sent people looking in the wrong place: it is
 * true, and it is compatible with every capability being ungranted and no
 * target being authorised. This asks the far side for both and returns them
 * normalised, so a status screen can show WHERE the path is broken rather than
 * only that it is.
 *
 * Best effort by design: an older Probe without `permission.state` or
 * `target.status` reports UNKNOWN for that axis, which is the honest answer and
 * is distinguishable from "none granted".
 */
async function readState(probe) {
  const out = {
    connected: false, operations: [], capabilities: null, target: null,
    permissionSource: null, notes: [],
  };
  if (!probe || probe.state !== 'CONNECTED') {
    out.notes.push(probe ? `the Probe is ${probe.state}` : 'no Probe in this session');
    return out;
  }
  out.connected = true;
  out.operations = Array.isArray(probe.capabilities) ? probe.capabilities.slice() : [];

  const perms = await safeCall(probe, 'permission.state');
  if (perms && perms.capabilities && typeof perms.capabilities === 'object') {
    out.capabilities = {};
    for (const [k, v] of Object.entries(perms.capabilities)) {
      out.capabilities[k] = { granted: Boolean(v && v.granted), why: (v && v.why) || '' };
    }
    out.permissionSource = perms.prompter ? 'the Probe window prompts, per capability' : 'the Probe decides';
    if (Array.isArray(perms.active) && perms.active.length) out.active = perms.active.slice();
  } else {
    out.notes.push('this Probe does not report permission state — capability status is UNKNOWN');
  }

  const tgt = await safeCall(probe, 'target.status');
  if (tgt && typeof tgt.authorized === 'boolean') {
    out.target = {
      authorized: tgt.authorized,
      reason: tgt.reason || null,
      selected: tgt.selected || null,
      attached: Boolean(tgt.attached),
      policy: (tgt.policy && tgt.policy.summary) || null,
      note: tgt.note || null,
    };
  } else {
    out.notes.push('this Probe does not report target status — target availability is UNKNOWN');
  }
  return out;
}

/** One call that can never throw and never blocks a status screen for long. */
async function safeCall(probe, op, ms = 8000) {
  try {
    const r = await probe.call(op, {}, ms);
    return r && r.ok ? r.result : null;
  } catch { return null; }
}

module.exports = {
  STAGE, DEAD, CAPABILITY_OF, SCREEN_SCOPED, FOCUS_SCOPED, TARGET_SCOPED,
  capabilityOf, aim, needsFocus, preflight, envelope, readState,
};
