'use strict';

/**
 * THE ONE PLACE A CLIENT READS RUNTIME TRUTH FROM.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS BEFORE ANY SECOND CLIENT DOES.
 *
 * LAIN is about to have more than one surface — the terminal it has, `/dash` in
 * a browser, and a notifier somewhere else — and the failure that produces is
 * well known and boring: each surface grows its own idea of what is happening.
 * The terminal reads `app.jobs`, the dashboard polls a session file, the
 * notifier keeps a counter, and on the day they disagree there is no way to say
 * which one is wrong, because none of them is the record.
 *
 * So the record is the supervisor, and this is the ONLY projection of it. A
 * client renders what this returns. It does not reach past it, and it does not
 * keep a second copy to compare against.
 *
 * ------------------------------------------------------------------------
 * READ-ONLY, AND THAT IS A BOUNDARY RATHER THAN AN OMISSION.
 *
 * There is deliberately no `send`, no `cancel`, no `continue` here. A surface
 * that can be reached from outside the machine — a chat bot, a web page — is a
 * surface an attacker can reach, and the first version of such a thing should be
 * able to say what is happening without being able to make anything happen. The
 * verbs come later, individually, each with its own argument about authority;
 * they do not arrive as a side effect of adding a notifier.
 *
 * ------------------------------------------------------------------------
 * NOTHING HERE STARTS A SUPERVISOR, and nothing here decides anything. Every
 * function returns what the runtime said, or an honest empty answer when there
 * is no runtime to ask — the same rule guardian.js follows, for the same reason.
 *
 * ------------------------------------------------------------------------
 * WHAT A CLIENT IS EXPECTED TO DO WITH IT.
 *
 *     const feed = require('./runtimefeed');
 *     let seq = 0;
 *     for (;;) {
 *       const batch = await feed.since(seq);
 *       for (const e of batch.events) notify(feed.headline(e));
 *       seq = batch.seq;
 *     }
 *
 * `seq` is the entire protocol. It is monotonic, it survives a client restart
 * because the client stores it, and a client that has been away for an hour asks
 * once and is told what it missed — which is the same reconnect shape the job
 * event log already uses, because it is the same problem.
 */

const guardian = require('./guardian');
const supervisor = require('./supervisor');

/** How many events one poll will carry. A batch, not a backlog dump. */
const MAX_EVENTS = 200;

/**
 * ------------------------------------------------------------------------
 * WHICH EVENTS ARE WORTH WAKING SOMEBODY FOR.
 *
 * Not the same question as which are worth RECORDING, and keeping the two apart
 * is the point of this table. A phase change is worth recording and would be an
 * absurd thing to send to a person's phone; a two-hour job reaching its deadline
 * is the whole reason a notifier would exist.
 *
 * The rule: an event is notable when a PERSON has something to decide. Every row
 * below is a decision — wait or switch, look or ignore, answer or leave it.
 */
const NOTABLE = new Set([
  'JOB_COMPLETED',
  'JOB_ERROR',
  'JOB_DEADLINE_REACHED',
  'TURN_INTERRUPTED',
  'INPUT_HELD',
  'HANDOVER_CREATED',
  'MODEL_SWITCHED',
  'PROVIDER_RECOVERED',
  'RATE_LIMITED',
]);

/**
 * ONE LINE A PERSON CAN READ, from one event.
 *
 * Deliberately flat and factual. This is a runtime, not a model: it says a job
 * exited 1 after forty-three minutes and does not say what went wrong, because
 * it does not know and guessing is how a notification becomes misleading. The
 * reasoning belongs to whoever reads it — see jobs.rs on the same distinction.
 */
function headline(e) {
  if (!e || !e.kind) return '';
  const job = e.job_id ? ` ${e.job_id}` : '';
  switch (e.kind) {
    case 'JOB_COMPLETED':
      return `job${job} finished${e.exit_code === 0 ? '' : ` — exit ${e.exit_code}`}`;
    case 'JOB_ERROR':
      return `job${job} failed — exit ${e.exit_code === undefined ? 'unknown' : e.exit_code}`;
    case 'JOB_DEADLINE_REACHED':
      // THE DEADLINE IS NOT THE OUTCOME. The window ended; whether the work
      // finished is a separate fact and the two must not be merged into one
      // sentence, or a person reads "2 hours are up" as "it is done".
      return `job${job} reached its deadline — it may still be running; the log is on disk`;
    case 'TURN_INTERRUPTED':
      return `a turn did not finish${e.reason ? ` — ${e.reason}` : ''}`;
    case 'INPUT_HELD':
      return `LAIN is holding what you typed${e.reason ? ` — ${e.reason}` : ''}`;
    case 'HANDOVER_CREATED':
      return `a handover is needed${e.reason ? ` — ${e.reason}` : ''}`;
    case 'MODEL_SWITCHED':
      return `the model changed${e.from && e.to ? ` — ${e.from} to ${e.to}` : ''}`;
    case 'RATE_LIMITED':
      return `a route is rate limited${e.reason ? ` — ${e.reason}` : ''}`;
    case 'PROVIDER_RECOVERED':
      return 'a rate limit has lifted';
    default:
      return e.kind.toLowerCase().replace(/_/g, ' ');
  }
}

/**
 * WHAT HAS HAPPENED SINCE `seq`.
 *
 * TWO LOGS, ONE ORDER. Execution events live with the jobs and runtime events
 * live with the Guardian — separate files because they have different retention
 * (see guardian.rs), and a client should not have to know that. They are merged
 * here by time, and each keeps its own sequence so a resume is exact rather than
 * approximate.
 *
 * `seq` is therefore a PAIR wearing one name. A client stores whatever it was
 * handed and gives it back; it is never expected to take it apart.
 */
async function since(seq = 0, { limit = MAX_EVENTS } = {}) {
  const cursor = normalise(seq);
  if (!guardian.running()) {
    return { events: [], seq: cursor, available: false };
  }
  const [runtime, jobs] = await Promise.all([
    guardian.events({ after: cursor.runtime, limit }).catch(() => []),
    supervisor.events({ after: cursor.jobs, limit }).then((r) => (r && r.ok && Array.isArray(r.events) ? r.events : [])).catch(() => []),
  ]);
  const rows = [];
  for (const e of runtime) rows.push({ ...e, stream: 'runtime' });
  for (const e of jobs) rows.push({ ...e, stream: 'jobs' });
  // BY TIME, THEN BY STREAM, so a merge is stable. Two events in the same second
  // from two logs have no true order and inventing one that changes between
  // polls would make a client show them twice in different arrangements.
  rows.sort((a, b) => (a.at || 0) - (b.at || 0) || String(a.stream).localeCompare(String(b.stream)));
  const next = {
    runtime: runtime.reduce((m, e) => Math.max(m, e.seq || 0), cursor.runtime),
    jobs: jobs.reduce((m, e) => Math.max(m, e.seq || 0), cursor.jobs),
  };
  return {
    events: rows.slice(0, limit),
    seq: next,
    available: true,
    notable: rows.filter((e) => NOTABLE.has(e.kind)),
  };
}

/** A cursor a client handed back, in whatever shape it kept it. */
function normalise(seq) {
  if (typeof seq === 'number') return { runtime: Math.max(0, seq), jobs: Math.max(0, seq) };
  const s = seq || {};
  return {
    runtime: Math.max(0, Math.floor(Number(s.runtime) || 0)),
    jobs: Math.max(0, Math.floor(Number(s.jobs) || 0)),
  };
}

/**
 * EVERYTHING THIS MACHINE'S RUNTIME CURRENTLY KNOWS.
 *
 * NAMED `state`, NOT `snapshot`. There is exactly one snapshot in this program —
 * checkpoint.js, which copies BYTES so `/undo` can put them back — and an
 * architecture guard enforces that there is only one. A second thing wearing the
 * word would break nothing on the day and would make "restore the snapshot"
 * ambiguous forever after. ui/projection.js made the same choice, for the same
 * reason, and calls its version `frameState`.
 *
 * The state a surface renders when it opens, before it starts following events.
 * Three questions, from the three stores that own them, and no fourth copy:
 *
 *   sessions   what each conversation is doing, and what it has cost
 *   jobs       what is running beside them, and for how much longer
 *   providers  which routes are shut, and until when
 */
async function state() {
  if (!guardian.running()) {
    return { available: false, sessions: [], jobs: [], providers: [] };
  }
  const [sessions, jobs, providers] = await Promise.all([
    guardian.list().catch(() => []),
    supervisor.list({}).then((r) => (r && r.ok && Array.isArray(r.jobs) ? r.jobs : [])).catch(() => []),
    supervisor.providers().then((r) => (r && r.ok && Array.isArray(r.providers) ? r.providers : [])).catch(() => []),
  ]);
  return { available: true, sessions, jobs, providers };
}

/**
 * IS ANYTHING WAITING FOR A PERSON?
 *
 * The single question a notifier actually asks, answered without it having to
 * understand any of the shapes above. True when a session is holding input, owes
 * a handover, or has a turn whose owner is gone.
 */
function needsAttention(state) {
  const rows = (state && state.sessions) || [];
  return rows.filter((s) => s && (s.needs_handover || s.held_count > 0 || s.effective_state === 'LOST'));
}

module.exports = { since, state, headline, needsAttention, normalise, NOTABLE, MAX_EVENTS };
