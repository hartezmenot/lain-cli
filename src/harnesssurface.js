'use strict';

/**
 * THE SURFACE ADAPTER — one projection of harness state, for every window.
 *
 * ------------------------------------------------------------------------
 * THE RULE THIS FILE ENFORCES BY EXISTING.
 *
 *     A SURFACE RENDERS. IT NEVER COMPUTES.
 *
 * The dashboard, a Telegram client and whatever comes after them all want the
 * same six facts: what is the task, what state is it in, what is running, what
 * has been proved, what evidence exists, and what just happened. The failure
 * mode is each of them assembling that itself — three readers, three notions of
 * "is it done", and no way to say which is wrong on the day they disagree.
 * src/events.js already argues this at length for the event channel; this is
 * the same argument for the state payload.
 *
 * So there is one function. `dash.js` calls it, a remote adapter calls it, and
 * the CLI reads the same `harness.snapshot()` underneath.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT CARRY.
 *
 * No message content, no file contents, no credentials, no artifact bodies.
 * The dashboard's existing rule is that the state payload carries names,
 * phases and counts and never secrets, and a new section is not an excuse to
 * relax it. An artifact is named and counted here; reading one is a separate,
 * authenticated request in whatever surface wants it.
 *
 * ------------------------------------------------------------------------
 * IT IS ABSENT RATHER THAN EMPTY WHEN THERE IS NO HARNESS.
 *
 * `null` means "no task has been opened in this session", which is a real and
 * common state. An empty object with zeroes in it would render as a task that
 * exists and has done nothing, which is a different and false claim.
 */

const timeline = require('./harness/timeline');

/** How much of the flight recorder a remote window is given. Bounded, like everything. */
const RECENT_EVENTS = 12;
/** And how many artifacts are named. The bodies are never in this payload. */
const RECENT_ARTIFACTS = 8;

/**
 * @param {object} app the App, or anything with a `_harness`
 * @returns {object|null} the projection, or null when no task has been opened
 */
function project(app) {
  const h = app && app._harness;
  if (!h) return null;
  const snap = h.snapshot();
  if (!snap || !snap.task) return null;
  const t = snap.task;
  const store = h.runtime.persist ? h.runtime.store : null;
  const artifacts = store ? store.index(t.id).slice(-RECENT_ARTIFACTS) : [];
  return {
    activity: snap.activity,
    task: {
      id: t.id,
      title: t.title,
      state: t.state,
      tone: t.tone,
      reason: t.reason,
      terminal: t.terminal,
      causedBy: t.causedBy,
      attempts: t.attempts,
      updatedAt: t.updatedAt,
    },
    // WHAT IS PROVED, AND `null` WHEN NOTHING IS. A surface that renders a
    // missing verification as "0 failed" is telling somebody their work passed.
    verification: t.verification
      ? {
        verdict: t.verification.verdict,
        passed: t.verification.passed,
        failed: t.verification.failed,
        inconclusive: t.verification.inconclusive,
        why: String(t.verification.why || '').slice(0, 300),
      }
      : null,
    processes: snap.processes.map((p) => ({
      name: p.name, status: p.status, health: p.health, port: p.port, why: String(p.healthWhy || '').slice(0, 120),
    })),
    evidence: {
      artifacts: t.artifacts,
      events: t.events,
      observations: t.observations,
      persisted: snap.persisted,
    },
    // NAMES AND SIZES ONLY. See the header on what this payload may not carry.
    recent: artifacts.map((a) => ({ id: a.id, kind: a.kind, name: a.name, bytes: a.bytes })),
    timeline: timeline.build(h, t.id, { limit: RECENT_EVENTS }).map((r) => ({ time: r.time, text: r.text })),
    tasks: snap.tasks.slice(0, 8).map((x) => ({ id: x.id, title: x.title, state: x.state })),
  };
}

/**
 * A ONE-LINE SUMMARY, for a surface with a status bar rather than a panel — a
 * notification, a terminal title, a phone lock screen.
 *
 * Written so the two words that matter are first: the state and whether
 * anything proved it.
 */
function line(app) {
  const p = project(app);
  if (!p) return null;
  const v = p.verification;
  const proof = v
    ? `${v.verdict} (${v.passed}✓ ${v.failed}✗ ${v.inconclusive}?)`
    : 'unproven';
  return `${p.task.state} · ${proof} · ${p.task.title}`.slice(0, 200);
}

module.exports = { project, line, RECENT_EVENTS, RECENT_ARTIFACTS };
