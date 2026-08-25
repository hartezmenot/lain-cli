'use strict';

/**
 * THE COMPANION RELAY — LAIN's events, pushed to a window that renders them.
 *
 *     LAIN (owns the events)  →  this  →  the Probe window (draws them)
 *
 * in one file. The Probe used to receive exactly one
 * thing from LAIN — the model's final prose, through `session.say` — so a
 * companion that wanted to show "what is LAIN doing right now" had to guess it
 * from wording. That is a second state machine, and a second state machine
 * disagrees with the first one.
 *
 * WHAT THIS IS. A subscriber. It reads the bus LAIN already owns (events.js)
 * and forwards each fact. It computes nothing, decides nothing, keeps no task
 * state of its own, and cannot answer, cancel or steer anything — a companion
 * RENDERS.
 *
 * WHAT IT WILL NOT DO:
 *
 *   · never fail a turn. A window is a convenience; the work is not. Every
 *     send is fire-and-forget and every error is swallowed at this boundary.
 *   · never queue without bound. A Probe that stops answering must not grow a
 *     backlog in LAIN's memory — see MAX_INFLIGHT.
 *   · never send prose it invented. Every line is built from fields the event
 *     already carries.
 *
 * OLDER PROBES STILL WORK. `session.event` is preferred, because a structured
 * payload is the whole point; a Probe that does not implement it gets the same
 * fact as one readable line through `session.say`, which every version has.
 * That fallback is decided ONCE per connection, not per event.
 */

const { EVENT, busOf } = require('./events');

/** In-flight sends allowed at once. A stalled window must not become a queue. */
const MAX_INFLIGHT = 8;

/**
 * ONE LINE A PERSON READS, for the `session.say` fallback.
 *
 * Built only from fields the event carries. Nothing here re-words, summarises
 * or interprets — a companion showing something LAIN never said is the drift
 * this whole contract exists to remove.
 */
function line(ev) {
  switch (ev.type) {
    case EVENT.TASK_STARTED: return `TASK  ${ev.objective || ev.message || ''}`;
    case EVENT.TASK_PROGRESS: return `··· ${ev.message || 'carrying on'}`;
    case EVENT.MODEL_THINKING: return 'THINKING';
    case EVENT.MODEL_TOOL_CALL: return `CALL  ${ev.tool}${ev.target ? ` ${ev.target}` : ''}`;
    case EVENT.TOOL_STARTED: return `RUN   ${ev.tool}${ev.target ? ` ${ev.target}` : ''}`;
    case EVENT.TOOL_COMPLETED:
      return `${ev.ok ? 'OK   ' : 'FAIL '} ${ev.tool}${ev.summary ? ` — ${ev.summary}` : ''}`;
    case EVENT.QUESTION_PRESENTED: return `ASKING (${ev.kind})  ${ev.question || ''}`;
    case EVENT.QUESTION_RESOLVED:
      return ev.dismissed ? 'question dismissed' : `answered: ${ev.answer || ''}`;
    case EVENT.JOB_STARTED: return `JOB ${ev.id} started: ${ev.command || ''}`;
    case EVENT.JOB_COMPLETED:
      return `JOB ${ev.id} ${ev.state}${ev.exitCode == null ? '' : ` (exit ${ev.exitCode})`}`;
    case EVENT.VISUAL_PRESENTED:
      return `LOOK  round ${ev.round}/${ev.of} — ${(ev.candidates || []).length} candidate(s)`;
    case EVENT.VISUAL_JUDGED:
      return `JUDGED ${ev.chose || 'none'}${ev.accepted ? ' (accepted)' : ''}`;
    case EVENT.WAITING_FOR_USER: return `WAITING FOR YOU — ${ev.reason || ''}`;
    case EVENT.TASK_COMPLETED: return `DONE  ${ev.toolCalls || 0} tool call(s)`;
    case EVENT.TASK_FAILED: return `FAILED — ${ev.stopReason || 'the provider did not answer'}`;
    default: return ev.type;
  }
}

/**
 * Attach the relay to a Probe. Returns an unsubscribe function.
 *
 * Idempotent per Probe: `/mcp probe` can be run twice, and a second relay would
 * double every line in the window.
 */
function attach(app, probe) {
  if (!app || !probe || probe._companion) return () => {};

  const state = { inflight: 0, structured: null, dropped: 0 };
  probe._companion = state;

  const off = busOf(app).on((ev) => {
    // BOUNDED. A window that has stopped answering gets no backlog; the events
    // it missed are still in the bus, which is where a reconnecting companion
    // reads them from.
    if (state.inflight >= MAX_INFLIGHT) { state.dropped++; return; }
    state.inflight++;
    Promise.resolve(send(probe, state, ev))
      .catch(() => {})
      .then(() => { state.inflight--; });
  });

  probe._companionOff = () => { off(); probe._companion = null; };
  return probe._companionOff;
}

/**
 * Send one event, preferring the structured channel.
 *
 * The choice is made ONCE and remembered on the connection: asking every time
 * would spend a failed round trip per event against an older Probe, which is
 * the opposite of what a status channel should cost.
 */
async function send(probe, state, ev) {
  if (typeof probe.call !== 'function') return;
  if (state.structured !== false) {
    const r = await probe.call('session.event', { event: ev }, 8000).catch(() => null);
    if (r && r.ok) { state.structured = true; return; }
    // An older Probe answers "unknown operation" — that is not a failure to
    // report, it is a version, and the fallback below is the whole point.
    state.structured = false;
  }
  if (typeof probe.say === 'function') {
    await Promise.resolve(probe.say(line(ev), 'system')).catch(() => {});
  }
}

module.exports = { attach, line, MAX_INFLIGHT };
