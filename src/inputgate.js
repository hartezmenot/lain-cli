'use strict';

/**
 * WHAT HAPPENS TO A SENTENCE BEFORE IT REACHES A MODEL.
 *
 * ------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS FOR, in the order it actually happens.
 *
 *     the model is working
 *     the provider 502s / a limit lands / the socket dies / Node is killed
 *     the person types:  continue
 *     Node sends:        continue
 *     the next model receives one word with no antecedent
 *     and does the only sane thing — it re-reads the README, re-lists the
 *     tree, re-opens the files the dead model had already read, and rebuilds
 *     by hand a picture that was on disk the whole time.
 *
 * Measured on this repository that is a six-figure input request, spent on
 * facts LAIN already held and could have stated in forty lines.
 *
 * `continue` is INTENT. It is not context. The two are different things and
 * only one of them is missing.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS FILE IS, AND IS NOT.
 *
 * It is NOT the decision. Whether a sentence may be sent is answered by the
 * Guardian, in the process that is still running when this one is not — see
 * rust/lain-supervisor/src/guardian.rs. Asking here would put the answer back in
 * the memory that just died.
 *
 * This is the RECOVERY: what LAIN does with a `no`. Three steps, and they are in
 * this order because each one is cheaper than re-deriving what the next needs.
 *
 *   1. LOOK, don't ask. Refresh what the runtime observed while nothing was
 *      reasoning — finished jobs, closed routes — because those are the facts a
 *      replacement model would otherwise spend a turn rediscovering.
 *   2. TAKE the held sentences. Every one of them, oldest first: a person who
 *      typed three things at a dead model meant all three, and delivering only
 *      the last is the steer-loss bug wearing a different hat.
 *   3. SEND them WITH the packet, as one ordinary turn. Not a synthesised
 *      instruction, not a summary — the person's own words, against a briefing
 *      built from what LAIN saw rather than from what the previous model said.
 *
 * ------------------------------------------------------------------------
 * IT NEVER COMPOSES A SENTENCE FOR THE USER. The message that reaches the model
 * is exactly what was typed. Everything LAIN has to add rides in the system
 * prompt, where handover.js already puts it — so a person reading the transcript
 * back sees what they said, and not LAIN's paraphrase of it.
 *
 * PLAIN FUNCTIONS OVER `app`, no `this` — the same shape providerhealth.js and
 * steerqueue.js follow, and for the reason stated there.
 */

const guardian = require('./guardian');

/** How much of a hold reason a one-line notice will carry. */
const MAX_REASON = 160;

/**
 * The word a person sees. The reason arrives from Rust as `KIND: detail`, and
 * the KIND is the part that tells them whether to wait, switch, or carry on.
 */
const SAY = {
  RATE_LIMITED: 'the route was rate limited',
  PROVIDER_FAILED: 'the last turn did not finish',
  TURN_LOST: 'the process running the last turn is gone',
  HANDOVER_PENDING: 'the model changed mid-task',
};

function kindOf(reason) {
  const m = /^([A-Z_]+):/.exec(String(reason || ''));
  return m ? m[1] : '';
}

/**
 * MAY THIS GO STRAIGHT THROUGH?
 *
 * Returns `{ held:false }` when it may — which is the overwhelmingly common
 * answer and costs one local socket round trip, or nothing at all when no
 * supervisor is running.
 *
 * Returns `{ held:true, result }` when it did not, having already recovered:
 * `result` is the turn record of the continuation that was run instead.
 */
async function admit(app, text, { from = null } = {}) {
  const session = app && app.session;
  const id = session && session.id;
  if (!id) return { held: false };

  const verdict = await guardian.offer(id, text, { kind: from || 'user' });
  if (verdict.deliver) return { held: false };

  return { held: true, result: await recover(app, verdict) };
}

/**
 * THE `no` PATH.
 *
 * Separate from `admit` because it is the part with steps in it, and because a
 * test that wants to exercise recovery should not have to arrange a hold first.
 */
async function recover(app, verdict) {
  const id = app.session.id;
  const kind = kindOf(verdict.reason);
  const said = SAY[kind] || 'the runtime is recovering';

  // ---- 1. SAY SO ---------------------------------------------------------
  //
  // Before anything slow. A person who has just watched a turn die and typed a
  // sentence must not then watch a second silence while LAIN reads job state —
  // the whole complaint that produced this file was about not knowing whether
  // anything had been heard.
  //
  // TWO DOORS, ONE RECOVERY. A sentence typed at this terminal and a `/continue`
  // sent from a phone arrive here identically — the second simply has no failure
  // to report, so it says where it came from instead of what went wrong. That
  // difference is a NOTICE and nothing else: every step below is the same one.
  // ---- IT IS AN OPERATION, NOT A SENTENCE LAIN SAID --------------------
  //
  // THIS USED TO BE A `notice`, WHICH PUT IT IN THE CONVERSATION:
  //
  //     held — the last turn did not finish. Recovering with what LAIN
  //     observed rather than sending that on its own.
  //
  // — a paragraph of recovery machinery, drawn exactly like something the model
  // had answered, still sitting between two real exchanges an hour later. It is
  // not a message and nobody comes back for it.
  //
  // The FACT is unchanged and is still recorded: `app._handover` carries the
  // reason into the packet the model reads, the Guardian has the verdict, and
  // `/lain` and LAIN_DEBUG still print the detail. What changed is that the
  // person at the keyboard gets one transient row saying what is being done —
  // see ui/operation.js, and §5 for why these three lines were the example.
  const op = require('./ui/operation');
  op.say(app, verdict.queued ? 'Picked up from remote control' : 'Recovering interrupted turn');
  if (process.env.LAIN_DEBUG) {
    app.render.notice('info', `[gate] ${String(verdict.reason || '').slice(0, MAX_REASON)}`);
  }

  // ---- 2. LOOK -----------------------------------------------------------
  //
  // AWAITED, which is the only place in LAIN that awaits these. Ordinarily they
  // are fire-and-forget because a turn must not wait on a socket; here the whole
  // purpose is to build a briefing, and a briefing assembled from a cache that
  // has not refreshed yet is the previous model's picture with a new heading.
  //
  // Bounded inside runtimefacts.refresh, because a wedged supervisor must cost a
  // recovery some latency and never the recovery itself.
  op.say(app, 'Restoring what LAIN observed');
  await require('./runtimefacts').refresh(app);

  // ---- 3. TAKE -----------------------------------------------------------
  //
  // `keepHandover` — the boundary is NOT closed here. The packet has not been
  // built yet, let alone sent; clearing the flag now would mean a crash between
  // this line and the request produced a session that had forgotten it was
  // recovering, with the user's sentence already out of the queue.
  const { taken } = await guardian.deliver(id, { keepHandover: true });
  const rows = taken.length ? taken : [];
  const intent = rows.map((h) => h.text).filter(Boolean).join('\n');

  if (!intent) {
    // NOTHING CAME BACK. Either no supervisor answered or another client took
    // the queue first. Refusing to act would eat the sentence, which is the one
    // outcome this file exists to prevent — so the ordinary path runs, exactly
    // as it would have with no Guardian at all.
    return null;
  }

  // ---- 4. SEND -----------------------------------------------------------
  //
  // `_handover` is read by systemPrompt on the way into prompt.build and is what
  // makes this turn carry the packet. It is set for ONE turn and cleared in the
  // `finally` below whatever happens, because a flag that survives its turn
  // would make every later request a recovery.
  //
  // SAME TASK. This is the work that was already in hand — a new objective here
  // would replace the very thing the packet is about.
  // ---- A PACKET ONLY WHERE ONE IS OWED -----------------------------------
  //
  // A conversation that is perfectly healthy — the CLI was simply not at the
  // prompt when the message arrived — needs no briefing, and attaching one
  // would spend tokens explaining a boundary nobody crossed. The FLAG is what
  // decides, and the flag is the runtime's.
  app._handover = verdict.reason
    ? {
      reason: String(verdict.reason || ''),
      kind,
      state: verdict.state || null,
      input: rows.map((h) => ({ text: h.text, at: h.at, reason: h.reason })),
    }
    : null;
  op.say(app, 'Continuing from verified state');
  try {
    return await app.submit(intent, { sameTask: true, from: 'handover' });
  } finally {
    // ONE TURN'S LIFETIME. A flag that outlived its turn would make every later
    // request a recovery.
    app._handover = null;
    // ---- AND NOTHING HERE CLOSES THE BOUNDARY ------------------------------
    //
    // The first draft did: it read `record.stopReason` and called
    // `handover_done` when the recovery turn had ended cleanly. It worked, and
    // it was the wrong shape — a second party deciding the lifetime of a flag
    // the Guardian owns, which is the duplicate authority §23 forbids. An
    // architecture test caught it as exactly that.
    //
    // `turn_end` closes it now, in guardian.rs, on the evidence it already has:
    // a turn that finished. That is also strictly better, because it sees an
    // ORDINARY turn succeeding and this could only ever see a recovery one.
  }
}

/**
 * INPUT THAT ARRIVED WITH NOBODY AT THE PROMPT.
 *
 * ------------------------------------------------------------------------
 * THE SECOND DOOR, AND IT OPENS ONTO THE SAME ROOM.
 *
 * A message from Telegram has no caller holding it: `admit` answers a question
 * that a waiting `handle` asked, and there is no `handle` here. So the runtime
 * writes remote intent into the SAME held queue a refused sentence lands in,
 * and this drains it through `recover` — the same refresh, the same take, the
 * same submit, the same packet when one is owed.
 *
 * There is exactly one continuation in LAIN. This is a door onto it, not a
 * second implementation of it, and that is the whole reason the queue is in the
 * runtime rather than in either surface.
 *
 * CALLED ONLY WHEN NOTHING IS IN FLIGHT. Draining into a running turn would be a
 * steer the user did not aim at this turn, and would race the transcript against
 * itself. (The /rc-era watcher that called this from a timer was removed with
 * /rc; the door stays — the Harness that inherits remote control will open it
 * rather than build a second recovery.)
 *
 * @returns {Promise<object|null>} the turn record, or null when nothing waited.
 */
async function drainQueued(app) {
  const session = app && app.session;
  const id = session && session.id;
  if (!id) return null;
  const state = await guardian.pending(id);
  const held = (state && state.held) || [];
  if (!held.length) return null;

  // THE RUNTIME'S OWN REASON, unread and unedited. Whether this becomes a plain
  // turn or a recovery is decided by `handover_pending` at THIS moment — not at
  // the moment the message was sent, which may have been an hour ago and a rate
  // limit ago.
  const s = (state && state.state) || {};
  return recover(app, {
    reason: s.needs_handover ? String(s.handover_reason || '') : '',
    state: s,
    queued: true,
  });
}

module.exports = { admit, recover, drainQueued, kindOf, SAY };
