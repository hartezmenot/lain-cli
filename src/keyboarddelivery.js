'use strict';

/**
 * GETTING A KEYSTROKE TO THE WINDOW IT WAS MEANT FOR — LAIN's half of it.
 *
 * THE OBSERVED FAILURE, in a live session: LAIN asked for keyboard input, the
 * Probe focused the game and reported success, LAIN reported that `W` was held
 * — and the game did nothing. Nothing in that chain was lying; every link
 * reported what it knew, and what it knew was not delivery.
 *
 * THE MECHANISM, traced through lain-probe:
 *
 *   1. A keystroke is `SendInput` with a virtual-key code and NO window. It
 *      lands on whatever holds the foreground at that instant.
 *   2. The Probe asks for permission in its OWN always-on-top window, at the
 *      moment the privileged call is made — which is AFTER anything LAIN did
 *      to aim it.
 *   3. So: focus the game, send the key, the Probe's prompt appears and takes
 *      the foreground, the user clicks Allow, and the keystroke that follows
 *      goes to the Probe. Focusing first cannot help, because the thing that
 *      steals the foreground happens after it.
 *
 * THE FIX IS AN ORDER, and it is the only thing this file contains:
 *
 *      ask for permission FIRST, and let the prompt steal whatever it steals
 *                        ↓
 *      focus the intended window
 *                        ↓
 *      verify it is REALLY the foreground — a second, independent check
 *                        ↓
 *      only then inject
 *                        ↓
 *      report SENT_UNCONFIRMED, because acceptance is not receipt
 *
 * THE BOUNDARY (and it is not negotiable): the Probe owns the Win32 calls, the
 * permission UI and the prompt. LAIN owns the ORDER, the aiming, the
 * verification and what the model is told about it. Nothing here synthesises
 * input, and nothing here decides that something is allowed — it asks, and it
 * refuses to proceed when the answer is no.
 *
 * TESTABLE WITHOUT A MACHINE. Everything talks to an object with `.call(op,
 * params, ms)`, so the whole sequence can be driven by a double at unit tier —
 * and a double is never evidence that a key arrived anywhere. That verdict
 * comes only from a target that logs what it received; see
 * tools/keywitness.js, tests/live/wininput.test.js and tests/live/mcp-input.test.js.
 */

const cap = require('./capability');
const heldKeys = require('./heldkeys');

/** A hold is a lifecycle, and an unreleased key is a broken keyboard. */
const MAX_HOLD_MS = 30_000;
const DEFAULT_HOLD_MS = 1000;

/** How long any one Probe call may take before it is a failure, not a wait. */
const CALL_MS = 20_000;
/** A permission prompt waits for a person to read it and decide. */
const PERMISSION_MS = 180_000;

/**
 * AIMING NEEDS ITS OWN PERMISSION, and finding that out cost a live run.
 *
 * `window.focus` is implemented in the Probe's VISION engine, so it is gated
 * behind `screen.capture` — measured 2026-08-21, with `keyboard.press` already
 * granted:
 *
 *     FOCUS_FAILED  could not focus LAIN KEY WITNESS:
 *                   permission to screen.capture is not granted
 *
 * A keystroke may not be sent without a verified foreground, and the foreground
 * cannot be verified without this. So the two are one decision in practice and
 * are asked for together, BEFORE anything is aimed — otherwise the second
 * prompt appears in the middle of the sequence, takes the foreground, and
 * recreates the exact bug this file exists to fix.
 *
 * Asking for it is not the same as taking it: the Probe still decides, the user
 * still answers, and a refusal still stops everything.
 */
const AIM_CAPABILITY = 'screen.capture';

/**
 * ONE STEP OF THE SEQUENCE, as it is recorded.
 *
 * The trail is the evidence. "It didn't work" is not a state; every attempt
 * ends on a named stage with the calls that got it there, so the answer to
 * "why did the key not arrive" is read rather than guessed.
 */
function step(stage, detail, extra = {}) {
  return { stage, detail: String(detail || ''), at: new Date().toISOString(), ...extra };
}

/**
 * IS THIS CAPABILITY ALREADY GRANTED? Read from the Probe, never assumed.
 *
 * @returns {boolean|null} null when this Probe cannot say, which is not "no".
 */
async function granted(probe, capability) {
  if (!capability) return true;
  try {
    const r = await probe.call('permission.state', {}, CALL_MS);
    const caps = r && r.ok && r.result && r.result.capabilities;
    if (!caps || typeof caps !== 'object') return null;
    const entry = caps[capability];
    if (!entry) return null;
    return Boolean(entry.granted);
  } catch { return null; }
}

/**
 * ASK FOR THE CAPABILITY, BEFORE ANYTHING IS AIMED.
 *
 * This is the whole fix for "the user has to click Allow and then click the
 * game again". The prompt is a topmost window and it WILL take the foreground;
 * the answer is not to fight it but to let it happen while nothing is aimed
 * yet, and to aim afterwards.
 *
 * @returns {{ok:boolean, why:string, asked:boolean}}
 */
async function ensurePermission(probe, capability, reason) {
  if (!capability) return { ok: true, why: '', asked: false };
  const have = await granted(probe, capability);
  if (have === true) return { ok: true, why: 'already granted', asked: false };

  let r;
  try {
    r = await probe.call('permission.request', {
      capability,
      reason: String(reason || 'to send keyboard input to the window being worked on'),
    }, PERMISSION_MS);
  } catch (e) {
    return { ok: false, why: `the permission request failed: ${e && e.message}`, asked: true };
  }
  if (!r || !r.ok) {
    // AN OLDER PROBE MAY NOT HAVE permission.request. That is not a denial and
    // must not be reported as one: carry on and let the Probe's own gate ask
    // at the moment it acts, exactly as it did before.
    const why = String((r && r.error) || 'no answer');
    if (/unknown|not implemented|no such/i.test(why)) {
      return { ok: true, why: 'this Probe has no permission.request — its own gate will ask', asked: false };
    }
    return { ok: false, why, asked: true };
  }
  const ok = Boolean(r.result && r.result.granted);
  return {
    ok,
    why: ok ? 'the user allowed it' : String((r.result && r.result.summary) || 'the user did not allow it'),
    asked: true,
  };
}

/**
 * FOCUS THE WINDOW AND ESTABLISH THAT IT REALLY IS THE FOREGROUND.
 *
 * `window.focus` calls SetForegroundWindow and then reads GetForegroundWindow
 * back, so its `focused` is a VERIFIED answer rather than the API's — Windows
 * refuses foreground changes in several situations and reports success anyway.
 *
 * It is called TWICE on purpose. The first brings the window up; the second,
 * immediately before injection, is the independent check the design asks for,
 * and it is what catches anything that took the foreground in between — a
 * prompt, a notification, the user clicking something.
 *
 * @returns {{ok:boolean, title:string, why:string}}
 */
async function focusVerified(probe, window) {
  let r;
  // PERMISSION_MS, NOT CALL_MS. This call can put a prompt on screen and wait
  // for a person; at 20s it timed out as 'no answer within 20s' and looked
  // like a hung Probe rather than a question nobody had answered yet.
  try { r = await probe.call('window.focus', { window }, PERMISSION_MS); }
  catch (e) { return { ok: false, title: '', why: `window.focus failed: ${e && e.message}` }; }
  const res = (r && r.result) || {};
  if (!r || !r.ok) return { ok: false, title: '', why: String((r && r.error) || 'window.focus failed') };
  return {
    ok: res.focused === true,
    title: String(res.title || window || ''),
    why: res.focused === true ? '' : String(res.note || res.summary || 'the OS refused the foreground change'),
  };
}

/**
 * THE SEQUENCE, in full, for one focus-following operation.
 *
 * @param {object} o
 *   probe       anything with `.call(op, params, ms) -> {ok, result, error}`
 *   op          the Probe operation to run once the window is verified
 *   params      its arguments
 *   window      the TITLE of the window the keys are meant for. Without one
 *               there is nothing to aim at and nothing is sent.
 *   capability  the capability the operation needs, e.g. `keyboard.press`
 *   reason      shown to the user in the permission prompt
 * @returns {{stage, trail, result, why, title}}
 */
async function deliver({ probe, op, params = {}, window = '', capability = null, reason = '' } = {}) {
  const trail = [step(cap.STAGE.REQUESTED, `${op} → ${window || 'no window named'}`)];
  const stop = (stage, why) => { trail.push(step(stage, why)); return { stage, trail, result: null, why, title: '' }; };

  if (!probe) return stop(cap.STAGE.BRIDGE_LOST, 'nothing is connected, so nothing was attempted');

  // NEVER SEND A KEYSTROKE AT NOTHING. Without a named window there is no
  // foreground to verify, and an unaimed keystroke goes into whatever the
  // person is looking at — which may be their own work.
  if (!String(window).trim()) {
    return stop(cap.STAGE.FOCUS_FAILED,
      'no window was named, so there was nothing to aim at and nothing to verify. NOTHING WAS SENT. '
      + 'Name the window this input is for.');
  }

  // 1. PERMISSION FIRST — for BOTH decisions, before anything is aimed.
  //
  // The key needs `keyboard.press`; AIMING the key needs `screen.capture`,
  // because window.focus lives in the Probe's vision engine. Asking for them
  // one at a time puts the second prompt in the middle of the sequence, where
  // it takes the foreground and undoes the aim. See AIM_CAPABILITY.
  for (const want of [capability, AIM_CAPABILITY]) {
    if (!want) continue;
    const perm = await ensurePermission(probe, want, reason);
    trail.push(step(cap.STAGE.PERMISSION_REQUIRED,
      perm.asked ? `asked for ${want}: ${perm.why}` : `${want}: ${perm.why || 'no permission needed'}`,
      { granted: perm.ok }));
    if (!perm.ok) {
      return stop(cap.STAGE.REFUSED,
        `${want} — ${perm.why}. Nothing was sent. Do not ask again for this.`);
    }
  }

  // 2. AIM.
  trail.push(step(cap.STAGE.FOCUSING, `bringing ${window} to the foreground`));
  const first = await focusVerified(probe, window);
  if (!first.ok) {
    return stop(cap.STAGE.FOCUS_FAILED,
      `could not focus ${window}: ${first.why}. NOTHING WAS SENT — a keystroke now would go to `
      + "whatever is in front, possibly the user's own work.");
  }
  trail.push(step(cap.STAGE.FOCUSED, first.title));

  // 3. VERIFY AGAIN, IMMEDIATELY BEFORE INJECTION. This is the check that
  //    catches a prompt, a notification or a click that arrived in between.
  const again = await focusVerified(probe, window);
  if (!again.ok) {
    return stop(cap.STAGE.FOCUS_FAILED,
      `${window} was focused and then lost the foreground before the key could be sent (${again.why}). `
      + 'NOTHING WAS SENT.');
  }

  // 4. INJECT.
  trail.push(step(cap.STAGE.INJECTING, `${op} into ${again.title}`));
  let r;
  try { r = await probe.call(op, params, CALL_MS); }
  catch (e) { return stop(cap.STAGE.FAILED, `${op} failed: ${e && e.message}`); }
  if (!r || !r.ok) {
    if (r && r.denied) return stop(cap.STAGE.REFUSED, `the user did not allow ${r.capability || capability}. Nothing was done.`);
    return stop(cap.STAGE.FAILED, `${op} failed: ${(r && r.error) || 'no answer'}`);
  }

  // 5. SENT — AND NOT DELIVERED. The OS accepted it; nobody watched the target
  //    receive it. Only a witness that saw the event arrive may say DELIVERED,
  //    and no witness is involved here.
  trail.push(step(cap.STAGE.SENT_UNCONFIRMED, `${op} was accepted by the OS with ${again.title} in front`));
  return { stage: cap.STAGE.SENT_UNCONFIRMED, trail, result: r.result, why: '', title: again.title };
}

/**
 * A HOLD IS A LIFECYCLE, NOT A CALL.
 *
 *      KEY_DOWN  →  held for a measured time  →  KEY_UP
 *
 * "LAIN says W is being held and the game does nothing" is the report this
 * exists for, and the shape of the answer is that BOTH EDGES ARE SEPARATE
 * FACTS. A down that was accepted and an up that was accepted are two pieces
 * of evidence; neither is receipt, and a hold with only one of them is a
 * broken keyboard rather than a partial success.
 *
 * THE RELEASE IS GUARANTEED. It runs from a `finally`, so an error, a timeout
 * or an abort in the middle still lifts the key — a key left down by a crashed
 * automation is the user's machine typing `wwwwwww` into whatever they open
 * next, and that is not an acceptable failure mode for any reason.
 */
async function hold({ probe, key, ms = DEFAULT_HOLD_MS, window = '', reason = '' } = {}) {
  const held = Math.max(1, Math.min(Number(ms) || DEFAULT_HOLD_MS, MAX_HOLD_MS));

  const down = await deliver({
    probe,
    op: 'input.keyboard.press',
    params: { key },
    window,
    capability: 'keyboard.press',
    reason: reason || `to hold ${key} in ${window}`,
  });
  if (down.stage !== cap.STAGE.SENT_UNCONFIRMED) {
    // NOTHING WENT DOWN, so there is nothing to lift and nothing to claim.
    return { stage: down.stage, held: 0, down, up: null, trail: down.trail, why: down.why };
  }

  // ---- IT IS DOWN NOW, AND SOMETHING OUTSIDE THIS CALL MUST KNOW ----------
  //
  // The `finally` below lifts it whatever happens INSIDE this function. What it
  // cannot survive is the process ending mid-hold — Ctrl+C, an uncaught throw,
  // the user quitting — because there is no frame left to unwind. The registry
  // lives above the call and is flushed on the way out. See heldkeys.js.
  const release = () => probe.call('input.keyboard.release', { key }, CALL_MS);
  heldKeys.down(key, release, reason || `held in ${window}`);

  let up = null;
  try {
    await new Promise((resolve) => { setTimeout(resolve, held); });
  } finally {
    // THE KEY COMES UP WHATEVER HAPPENED. Not aimed, not permission-checked,
    // not conditional: the down already established both, and refusing to lift
    // a key because a check failed would leave it down for ever.
    try {
      const r = await release();
      up = { ok: Boolean(r && r.ok), error: (r && r.error) || null };
    } catch (e) { up = { ok: false, error: e && e.message }; }
    // DEREGISTERED ONLY ON A CONFIRMED LIFT. If the release failed the key may
    // genuinely still be down, and that is precisely the case where the exit
    // path must try again rather than assume the best.
    if (up && up.ok) heldKeys.up(key);
  }

  const trail = [
    ...down.trail,
    step(cap.STAGE.INJECTING, `held ${key} for ${held}ms`),
    step(up && up.ok ? cap.STAGE.SENT_UNCONFIRMED : cap.STAGE.FAILED,
      up && up.ok ? `${key} released` : `${key} could NOT be released: ${up && up.error}`),
  ];
  return {
    stage: up && up.ok ? cap.STAGE.SENT_UNCONFIRMED : cap.STAGE.FAILED,
    held, down, up, trail,
    why: up && up.ok ? '' : 'the key was pressed and the release failed — it may still be down',
  };
}

/** The trail as lines a person reads. The stage first, because that is the answer. */
function trailLines(trail = []) {
  return trail.map((t) => `  ${t.stage.padEnd(20)} ${t.detail}`);
}

module.exports = {
  MAX_HOLD_MS, DEFAULT_HOLD_MS, CALL_MS, PERMISSION_MS, AIM_CAPABILITY,
  deliver, hold, ensurePermission, focusVerified, granted, trailLines, step,
};
