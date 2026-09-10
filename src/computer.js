'use strict';

/**
 * LAIN'S OWN COMPUTER OPERATIONS — the ownership correction, in one file.
 *
 * WHAT WAS WRONG. Every operation on the machine was `LAIN → Probe → capability`
 * and nothing else: the model named a FOREIGN operation string
 * (`input.mouse.click`), LAIN forwarded it, and a foreign result came back. So
 * the Probe was not a companion providing a bridge — it was the owner of
 * clicking, typing, focusing and seeing, and LAIN was a pipe. and of the
 * brief say that is backwards.
 *
 * WHAT LAIN OWNS NOW, and it is everything except the syscall:
 *
 *     the OPERATION      `click`, not `input.mouse.click` — one vocabulary
 *     the AIM            which window, and whether it is really in front
 *     the ORDER          permission, then aim, then verify, then act
 *     the LIFECYCLE      every stage named; see capability.STAGE
 *     the EVIDENCE       what is known, and what merely returned
 *     the REFUSAL        it declines rather than acting unaimed
 *
 * WHAT A TRANSPORT OWNS. One thing: performing the syscall. The desktop bridge
 * is the carrier now (the Probe transport was removed from LAIN CLI in
 * 2026-09), and it decides nothing about how or whether the operation happens.
 * That is what makes this "LAIN → capability, with a bridge underneath" rather
 * than "LAIN → Probe → capability".
 *
 * THE ASYMMETRY THAT DRIVES ALL OF IT, measured rather than assumed:
 *
 *     a KEYSTROKE goes to whatever holds the foreground at that instant
 *     a CLICK goes to whatever pixel is at that coordinate
 *
 * They therefore need different aiming and different verification, and merging
 * them into "input" is what let a click succeed while a keystroke went nowhere
 * and both reported ok. See keyboarddelivery.js, which owns the keyboard half
 * and is called from here rather than duplicated.
 *
 * SEEING IS NOT DOING. `screenshot` and `ocr` are reads: they need no foreground
 * and endanger nothing. Keeping them in the same tool as the input operations is
 * what lets a model take a picture, look at it, and act — without learning two
 * vocabularies for one machine.
 *
 * BUT A READ STILL NEEDS AIMING, which this file said for a long time that it
 * did not. "They need no aiming" was true about SAFETY and false about
 * USEFULNESS, and the gap produced a real failure: asked what a game window
 * showed, LAIN captured the entire desktop — its own panels included — and then
 * had to guess which of the text belonged to the target. Naming a `window` on a
 * read now resolves to that window's rectangle; see regionOf.
 */

const cap = require('./capability');
const kbd = require('./keyboarddelivery');

/**
 * THE OPERATIONS, in LAIN's words.
 *
 * Each names what it DOES, not which library performs it. `aim` decides what
 * must be true before it may run at all, and it is the whole of the safety
 * argument: FOCUS operations refuse without a verified foreground, SCREEN
 * operations say plainly that a coordinate is not a window, and NONE operations
 * are reads that endanger nothing.
 */
const OPS = Object.freeze({
  windows: { aim: 'NONE', reads: true, what: 'list the visible windows, with titles and rectangles' },
  focus: { aim: 'NONE', reads: false, what: 'bring a window to the foreground and VERIFY that it came' },
  screenshot: { aim: 'NONE', reads: true, what: 'capture the screen to a PNG file and return its path' },
  ocr: { aim: 'NONE', reads: true, what: 'read the text on the screen, or in a region of it' },
  move: { aim: 'SCREEN', reads: false, what: 'move the mouse to a screen coordinate' },
  click: { aim: 'SCREEN', reads: false, what: 'click at a screen coordinate' },
  type: { aim: 'FOCUS', reads: false, what: 'type text into the window named by `window`' },
  key: { aim: 'FOCUS', reads: false, what: 'press and release one key in the window named by `window`' },
  hold: { aim: 'FOCUS', reads: false, what: 'hold a key down for `ms` and release it, both edges reported' },
});

const NAMES = Object.freeze(Object.keys(OPS));

/**
 * WHERE TO LOOK — a window title resolved to the rectangle it occupies.
 *
 * ------------------------------------------------------------------------
 * THE REPORTED BEHAVIOUR THIS EXISTS TO END, in LAIN's own words during a live
 * investigation:
 *
 *     "OCR keeps reading the whole desktop — the game window is partly covered
 *      by LAIN panels. Memory correlation is the stronger evidence anyway, so
 *      let me narrow the scan scope to loaded modules…"
 *
 * Two failures in one sentence. The first is mechanical: `ocr` with no region
 * reads the entire screen, so the answer to "what does the game say" was the
 * game's text mixed with LAIN's own panels, a browser and whatever else was
 * open. The second is worse — having found the visual channel awkward, LAIN
 * talked itself out of visual evidence entirely and declared another source
 * "stronger" before comparing them. That is a conclusion reached from
 * inconvenience, and the design forbids exactly it.
 *
 * The mechanical half is fixable here, and this is the smallest change that
 * does it. `window.list` ALREADY returns rectangles — the aiming information
 * was there the whole time and nothing was asking for it. So: name a window,
 * get its bounds, look at those bounds. LAIN decides where to look; the
 * transport is handed a rectangle and performs the capture.
 *
 * NOTHING MOVES INTO THE TRANSPORT. The bridge is not taught what a game window
 * is or which text matters — it is asked for a region, which is a syscall
 * argument. The decision about WHERE to look stays with LAIN, which is the
 * whole ownership rule.
 *
 * @returns {{ok:boolean, region?:object, title?:string, why?:string}}
 */
async function regionOf(app, wanted) {
  const want = String(wanted || '').trim();
  if (!want) return { ok: false, why: 'no window was named' };
  const listed = await perform(app, 'windows', {}, { why: `find ${want} so the capture can be aimed at it` });
  if (listed.stage !== cap.STAGE.SUCCEEDED) {
    return { ok: false, why: `the windows could not be listed — ${listed.why || listed.stage}` };
  }
  const rows = (listed.result && (listed.result.windows || listed.result.list || listed.result)) || [];
  const all = Array.isArray(rows) ? rows : [];
  const needle = want.toLowerCase();
  // EXACT TITLE FIRST, then a contained match. A game called "Client" must not
  // lose to a browser tab whose title happens to mention it.
  const hit = all.find((w) => String((w && w.title) || '').toLowerCase() === needle)
    || all.find((w) => String((w && w.title) || '').toLowerCase().includes(needle));
  if (!hit) {
    const titles = all.map((w) => String((w && w.title) || '')).filter(Boolean).slice(0, 12);
    return {
      ok: false,
      why: `no window titled "${want}". Visible: ${titles.length ? titles.join(' | ') : 'none reported'}`,
    };
  }
  // The two rectangle shapes the transports use. A window with neither is a
  // real answer — it cannot be aimed at — and is reported rather than guessed.
  const r = hit.rect || hit.bounds || hit;
  const x = Number(r.x != null ? r.x : r.left);
  const y = Number(r.y != null ? r.y : r.top);
  const width = Number(r.width != null ? r.width : (Number(r.right) - x));
  const height = Number(r.height != null ? r.height : (Number(r.bottom) - y));
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return { ok: false, why: `"${hit.title}" reported no usable rectangle, so nothing can be aimed at it` };
  }
  return { ok: true, region: { x, y, width, height }, title: String(hit.title || want) };
}

/**
 * HOW EACH OPERATION IS SPELT ON EACH TRANSPORT.
 *
 * The two dialects exist because two different projects grew them; this is the
 * one place that knows both, so nothing above it ever sees a foreign name. A
 * `null` means that transport genuinely cannot do it — which is a real answer
 * and is reported as one, never silently substituted with something similar.
 */
const DIALECT = Object.freeze({
  probe: {
    windows: 'window.list',
    focus: 'window.focus',
    screenshot: 'screen.capture',
    ocr: 'vision.ocr',
    move: 'input.mouse.move',
    click: 'input.mouse.click',
    type: 'input.keyboard.type',
    key: 'input.keyboard.tap',
    hold: 'input.keyboard.hold',
  },
  desktop: {
    windows: 'window.list',
    focus: 'window.focus',
    screenshot: 'screen.capture',
    ocr: null,                 // the bridge has no OCR. Saying so beats guessing.
    move: 'mouse.move',
    click: 'mouse.click',
    type: 'keyboard.type',
    key: 'keyboard.key',
    hold: null,                // no press/release pair, so no hold can be built
  },
});

/**
 * WHICH TRANSPORTS CAN BE AIMED AT A RECTANGLE.
 *
 * A CAPABILITY, DECLARED, because the alternative is the failure the design names
 * exactly: "do NOT silently substitute whole-desktop OCR". Passing a region to
 * a transport that ignores it produces a whole-desktop capture wearing the
 * label of a window capture — an answer about the wrong thing, indistinguishable
 * from the right one, which is worse than a refusal.
 *
 * `false` here is a real answer and is reported as a capability limitation. The
 * Probe's `vision.ocr` has taken a region all along (see paramsFor); the
 * desktop bridge's `screen.capture` has no region parameter at all, so aiming
 * it is declined rather than faked.
 */
const REGIONS = Object.freeze({
  probe: { screenshot: true, ocr: true },
  desktop: { screenshot: false, ocr: false },
});

/** The capability each operation needs, per dialect. One table, both spellings. */
function capabilityFor(op, kind) {
  const name = DIALECT[kind] && DIALECT[kind][op];
  return name ? cap.capabilityOf(name) : null;
}

/**
 * WHICH TRANSPORTS ARE AVAILABLE, best first.
 *
 * The desktop bridge is the carrier. (The Probe transport that used to be
 * preferred here — it could do strictly more, OCR and the press/release pair a
 * hold is built from — was removed from LAIN CLI with the Probe integration in
 * 2026-09. The dialect it spoke is still in DIALECT below: the keyboard
 * sequence and the capability fallback in the envelope speak it, and the day a
 * transport that can verify the foreground reappears, the FOCUS branch below
 * becomes live again without being rewritten.)
 *
 * Returns [] when nothing is connected — which the caller reports as
 * BRIDGE_LOST rather than as a failure of the operation.
 */
function transports(app) {
  const out = [];
  if (app && typeof app.desktop === 'function') {
    let bridge = null;
    try { bridge = app.desktop(); } catch { bridge = null; }
    if (bridge && bridge.bridge) {
      out.push({
        kind: 'desktop',
        call: (op, params, ms) => bridge.bridge.call(op, params, ms),
        raw: bridge.bridge,
      });
    }
  }
  return out;
}

/** The first transport that can perform this operation, or null with a reason. */
function pick(app, op) {
  const available = transports(app);
  if (!available.length) {
    return { ok: false, why: 'nothing is connected — start the desktop bridge with /mcp connect' };
  }
  for (const t of available) {
    if (DIALECT[t.kind][op]) return { ok: true, transport: t, name: DIALECT[t.kind][op] };
  }
  return {
    ok: false,
    why: `${available.map((t) => t.kind).join(' and ')} cannot ${op} — `
      + `it is not an operation ${available.length > 1 ? 'either has' : 'that one has'}`,
  };
}

/**
 * CAN LAIN ACTUALLY LOOK AT THE SCREEN RIGHT NOW?
 *
 * A different question from "is a bridge configured", and the one that decides
 * whether a UI change can be visually VERIFIED or merely made.
 *
 * ---- WHY IT MOVED HERE, from inspection.js -------------------------------
 *
 * It asked `app.desktop().bridge.status()` and nothing else, so on a machine
 * with a Probe running and no MCP bridge it answered "no desktop bridge is
 * configured, so nothing can look at the screen" — while `computer{op:
 * "screenshot"}` was working perfectly through the Probe. It was answering
 * about ONE transport in a program that has two, which is exactly the ownership
 * error is about: the question is LAIN's, and only LAIN knows both.
 *
 * It also had to learn about refusals. A granted, connected bridge whose SCREEN
 * channel the user has since denied cannot look at anything, and reporting
 * POSSIBLE there would be the "it says CONNECTED, why did nothing happen"
 * complaint in its original form.
 *
 * @returns {{ok:boolean, why:string, state:string, transport:string}}
 */
function visualReadiness(app) {
  const ledger = channelsOf(app);
  const shut = ledger && ledger.check('screenshot');
  if (shut && !shut.ok) {
    return { ok: false, state: shut.state, transport: '', why: `${shut.channel} ${shut.state} — ${shut.why}` };
  }
  const chosen = pick(app, 'screenshot');
  if (!chosen.ok) return { ok: false, state: 'NO TRANSPORT', transport: '', why: chosen.why };
  return { ok: true, state: 'CONNECTED', transport: chosen.transport.kind, why: '' };
}

/**
 * THE CHANNEL LEDGER FOR THIS SESSION, created on first use.
 *
 * On the app rather than in a module-level variable: two LAINs in one process
 * (the test harness runs several) must not share one user's refusals, and a
 * refusal must not outlive the session that was refused.
 */
function channelsOf(app) {
  if (!app) return null;
  if (!app._channels) app._channels = new (require('./channels').Channels)();
  return app._channels;
}

/**
 * PERFORM ONE OPERATION, and report what is actually known about it.
 *
 * A THIN WRAPPER, and deliberately the only public one: every path out of the
 * attempt below — refusal, bridge lost, focus lost, sent — lands here, so the
 * channel ledger is written in ONE place rather than at each of the eight
 * returns. A ninth return added tomorrow is recorded without its author having
 * to remember that the ledger exists.
 *
 * @returns {{stage, trail, result, why, transport}}
 */
async function perform(app, op, params = {}, opts = {}) {
  // ---- AIM A READ AT A WINDOW, IF ONE WAS NAMED -------------------------
  //
  // `screenshot` and `ocr` need no foreground and no permission to aim, so
  // they were treated as needing no aiming at all — and read the whole desktop.
  // Naming a window turns them into a region capture: the window is looked up,
  // its rectangle becomes the region, and the transport is handed a rectangle.
  //
  // A NAMED WINDOW THAT CANNOT BE FOUND IS A REFUSAL, NOT A FALLBACK. Silently
  // reading the whole desktop instead is how "what does the game show" came
  // back as LAIN's own panels — the answer looked like an answer and was about
  // something else entirely. See regionOf.
  if ((op === 'screenshot' || op === 'ocr') && opts.window && !params.region) {
    // CAN ANYTHING HERE ACTUALLY BE AIMED? Asked before the window is looked
    // up, so a transport that cannot take a rectangle says so plainly instead
    // of returning the whole desktop under a window's name.
    const chosen = pick(app, op);
    const capable = chosen.ok && REGIONS[chosen.transport.kind] && REGIONS[chosen.transport.kind][op];
    if (chosen.ok && !capable) {
      return {
        stage: cap.STAGE.NO_TARGET, trail: [kbd.step(cap.STAGE.REQUESTED, op)], result: null,
        transport: chosen.transport.kind,
        why: `${chosen.transport.kind} cannot aim ${op} at a window — it captures the whole screen `
          + 'and has no region parameter. Nothing was captured, because a whole-desktop capture '
          + `labelled "${opts.window}" would answer a different question. `
          + 'Ask for the whole screen deliberately by omitting `window`.',
      };
    }
    const aimed = await regionOf(app, opts.window);
    if (!aimed.ok) {
      return {
        stage: cap.STAGE.NO_TARGET, trail: [kbd.step(cap.STAGE.REQUESTED, op)], result: null,
        transport: null,
        why: `${op} was aimed at "${opts.window}" and ${aimed.why}. Nothing was captured — `
          + 'the whole desktop would have answered a different question. '
          + 'Use `computer{op:"windows"}` to see what is actually open.',
      };
    }
    params = { ...params, region: aimed.region };
    opts = { ...opts, aimedAt: aimed.title };
  }
  const outcome = await attempt(app, op, params, opts);
  if (opts.aimedAt) outcome.aimedAt = opts.aimedAt;
  const ledger = channelsOf(app);
  const channel = ledger && require('./channels').OP_CHANNEL[op];
  if (ledger && channel) {
    // ONLY THE USER CLOSES A CHANNEL. A transport that broke, a window that
    // could not be focused, an operation that failed — none of those are
    // decisions, and recording them as DENIED would suppress a retry that
    // might well work. REFUSED is the only stage that means somebody said no.
    if (outcome.stage === cap.STAGE.REFUSED && !outcome.channel) {
      // THE REASON, NOT THE WHOLE SENTENCE. The refusal text already ends with
      // its own advice ("Nothing was done. Do not ask again."), and storing that
      // produced a second-refusal message with two full stops in the middle and
      // the same instruction twice. The ledger keeps the FACT; the wording
      // around it belongs to whoever is reporting at the time.
      ledger.deny(channel, 'the user did not allow it');
    } else if (outcome.stage === cap.STAGE.SUCCEEDED || outcome.stage === cap.STAGE.SENT_UNCONFIRMED) {
      ledger.open(channel);
    }
  }
  return outcome;
}

/** The attempt itself. Every exit is a named stage; see capability.STAGE. */
async function attempt(app, op, params = {}, { window = '', why = '' } = {}) {
  const spec = OPS[op];
  if (!spec) {
    return { stage: cap.STAGE.FAILED, trail: [], result: null, why: `there is no operation "${op}"` };
  }

  // ---- A CLOSED CHANNEL IS ANSWERED HERE, WITHOUT ASKING ANYONE -----------
  //
  // The user's decision is already on record, so contacting the transport
  // would put a permission prompt back on their screen for a question they
  // have answered — and prompts that reappear are prompts people learn to
  // dismiss without reading. It is also the difference between one refusal and
  // a model spending a request per attempt rediscovering the same no.
  //
  // The reply carries the FALLBACK, so what comes back is a changed plan
  // rather than a failure: KEYBOARD closed means "ask the user to press it",
  // not "this task cannot continue". See channels.js and.
  const ledger = channelsOf(app);
  if (ledger) {
    const allowed = ledger.check(op);
    if (!allowed.ok) {
      return {
        stage: cap.STAGE.REFUSED,
        trail: [kbd.step(cap.STAGE.REQUESTED, op), kbd.step(cap.STAGE.REFUSED, `${allowed.channel} ${allowed.state}`)],
        result: null,
        channel: allowed.channel,
        transport: null,
        why: `${allowed.channel} ${allowed.state} — ${allowed.why}. Nothing was attempted, and asking `
          + `again will not change it. Instead: ${allowed.fallback}.`,
      };
    }
  }

  const chosen = pick(app, op);
  if (!chosen.ok) {
    return {
      stage: cap.STAGE.BRIDGE_LOST,
      trail: [kbd.step(cap.STAGE.REQUESTED, op)],
      result: null,
      why: chosen.why,
    };
  }
  const { transport, name } = chosen;

  // ---- THE KEYBOARD HALF IS keyboarddelivery.js, not a copy of it ----------
  //
  // Permission first, then aim, then re-verify, then inject — and nothing sent
  // if the foreground could not be held. That sequence was measured into
  // existence and there must be exactly one of it.
  if (spec.aim === 'FOCUS') {
    const kbdOp = DIALECT.probe[op];      // the sequence speaks the Probe dialect
    if (transport.kind !== 'probe') {
      return {
        stage: cap.STAGE.FAILED,
        trail: [kbd.step(cap.STAGE.REQUESTED, op)],
        result: null,
        why: 'keyboard input needs a transport that can verify the foreground before each '
          + 'keystroke: the desktop bridge cannot, and an unverified keystroke goes wherever '
          + 'the user is looking.',
      };
    }
    if (op === 'hold') {
      return kbd.hold({
        probe: transport.raw, key: params.key, ms: params.ms, window, reason: why,
      });
    }
    return kbd.deliver({
      probe: transport.raw,
      op: kbdOp,
      params,
      window,
      capability: capabilityFor(op, 'probe'),
      reason: why,
    });
  }

  // ---- FOCUS IS ITS OWN OPERATION, and its answer is VERIFIED --------------
  if (op === 'focus') {
    const trail = [kbd.step(cap.STAGE.REQUESTED, window || params.window || '')];
    const want = String(window || params.window || '').trim();
    if (!want) {
      return { stage: cap.STAGE.FAILED, trail, result: null, why: 'focus needs a window title' };
    }
    trail.push(kbd.step(cap.STAGE.FOCUSING, want));
    const r = await transport.call(name, { window: want }, kbd.PERMISSION_MS).catch((e) => ({ ok: false, error: e.message }));
    const ok = Boolean(r && r.ok && r.result && r.result.focused === true);
    trail.push(kbd.step(ok ? cap.STAGE.FOCUSED : cap.STAGE.FOCUS_FAILED,
      (r && r.result && (r.result.title || r.result.note)) || (r && r.error) || ''));
    return {
      stage: ok ? cap.STAGE.SUCCEEDED : cap.STAGE.FOCUS_FAILED,
      trail,
      result: r && r.result,
      why: ok ? '' : `the OS did not put ${want} in front — ${(r && r.result && r.result.note) || (r && r.error) || 'it refused'}`,
      transport: transport.kind,
    };
  }

  // ---- EVERYTHING ELSE: a read, or a coordinate-addressed action -----------
  const trail = [kbd.step(cap.STAGE.REQUESTED, `${op} via ${transport.kind}`)];
  trail.push(kbd.step(cap.STAGE.EXECUTING, name));
  const r = await transport.call(name, params, kbd.PERMISSION_MS).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) {
    if (r && r.denied) {
      trail.push(kbd.step(cap.STAGE.REFUSED, r.error || 'the user said no'));
      return { stage: cap.STAGE.REFUSED, trail, result: null, transport: transport.kind,
        why: `the user did not allow ${r.capability || op}. Nothing was done. Do not ask again.` };
    }
    trail.push(kbd.step(cap.STAGE.FAILED, (r && r.error) || 'no answer'));
    return { stage: cap.STAGE.FAILED, trail, result: null, transport: transport.kind,
      why: `${op} failed: ${(r && r.error) || 'no answer'}` };
  }

  // A READ SUCCEEDS OR IT DOES NOT — there is nothing unconfirmed about the
  // text that came back. AN INJECTED CLICK IS DIFFERENT: the OS accepted a
  // coordinate, and nothing observed which window was under it.
  const stage = spec.reads ? cap.STAGE.SUCCEEDED : cap.STAGE.SENT_UNCONFIRMED;
  trail.push(kbd.step(stage, name));
  return { stage, trail, result: r.result, why: '', transport: transport.kind };
}

module.exports = { OPS, NAMES, DIALECT, REGIONS, transports, pick, perform, capabilityFor, channelsOf, visualReadiness, regionOf };
