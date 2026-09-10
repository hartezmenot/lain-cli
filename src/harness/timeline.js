'use strict';

/**
 * THE FLIGHT RECORDER, RENDERED — one ordered story of what happened.
 *
 * ------------------------------------------------------------------------
 * WHY A PROJECTION AND NOT A SECOND LOG.
 *
 * Nothing here records anything. The events already exist — on the bus while
 * the session lives, and in `.lain/tasks/<id>/events.jsonl` forever. This turns
 * them into lines a person reads, and that is the whole of its job.
 *
 * The temptation was a `Timeline` class that subscribed to the bus and built
 * its own list, and it is worth naming why that is wrong: it would be a third
 * copy of the same facts, with its own bounds and its own bugs, and on the day
 * it disagreed with the durable log there would be no way to say which was
 * right. A projection cannot disagree with its source.
 *
 * ------------------------------------------------------------------------
 * EVERY LINE NAMES A FACT, NOT A FEELING.
 *
 * "10:31:42 typecheck passed" is a line. "10:31:42 making good progress" is
 * not, and nothing in this file can produce one, because the input is a typed
 * event with a payload and there is nowhere for an impression to enter.
 */

const { EVENT } = require('../events');

/** How many lines a rendered timeline shows by default. */
const DEFAULT_LIMIT = 60;

function hhmmss(at) {
  const d = new Date(Number(at) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * ONE EVENT, ONE SENTENCE.
 *
 * A closed switch rather than a generic formatter, because a generic one
 * produces `task.state {from: RUNNING, to: VERIFYING}` — technically complete
 * and unreadable, which is how a timeline stops being looked at.
 *
 * An event with no case falls through to its type and its most useful field.
 * That is deliberate: a new event name should appear on the timeline
 * immediately, looking slightly raw, rather than being silently invisible until
 * somebody remembers to add a case here.
 */
function line(ev) {
  const t = ev.type;
  switch (t) {
    case EVENT.TASK_CREATED: return `task created — ${ev.title || ''}`;
    case EVENT.TASK_STARTED: return `task started${ev.why ? ` — ${ev.why}` : ''}`;
    case EVENT.TASK_STATE: return `${ev.from} → ${ev.to}${ev.why ? ` — ${ev.why}` : ''}`;
    case EVENT.TASK_PAUSED: return `${ev.kind === 'paused' ? 'paused' : 'blocked'}${ev.why ? ` — ${ev.why}` : ''}`;
    case EVENT.TASK_RESUMED: return `resumed${ev.why ? ` — ${ev.why}` : ''}`;
    case EVENT.TASK_CANCELLED: return `cancelled${ev.why ? ` — ${ev.why}` : ''}`;
    case EVENT.TASK_COMPLETED: return `task completed${ev.why ? ` — ${ev.why}` : ''}`;
    case EVENT.TASK_FAILED: return `task failed${ev.why ? ` — ${ev.why}` : ''}`;
    case EVENT.TASK_PROGRESS: return `same task continued${ev.objective ? ` — ${ev.objective}` : ''}`;

    case EVENT.TOOL_STARTED: return `${ev.tool}${ev.target ? ` ${ev.target}` : ''}`;
    case EVENT.TOOL_COMPLETED: return `${ev.tool} ${ev.isError ? 'failed' : 'done'}${ev.target ? ` — ${ev.target}` : ''}`;
    case EVENT.TOOL_FAILED: return `${ev.tool} failed${ev.why ? ` — ${ev.why}` : ''}`;
    case EVENT.MODEL_TOOL_CALL: return `model called ${ev.tool}${ev.target ? ` ${ev.target}` : ''}`;

    case EVENT.JOB_STARTED: return `background job started — ${ev.command || ev.jobId || ''}`;
    case EVENT.JOB_COMPLETED: return `background job ${ev.state || 'finished'}${ev.command ? ` — ${ev.command}` : ''}`;

    case EVENT.PROCESS_STARTED: return `process ${ev.name} started${ev.port > 0 ? ` on :${ev.port}` : ''}`;
    case EVENT.PROCESS_STOPPED: return `process ${ev.name} stopped`;
    case EVENT.PROCESS_FAILED: return `process ${ev.name} FAILED — ${ev.why || ''}`;
    case EVENT.PROCESS_HEALTH: return `process ${ev.name} is ${ev.health} — ${ev.why || ''}`;

    case EVENT.BROWSER_STARTED: return `browser attached${ev.port ? ` on :${ev.port}` : ''}${ev.browser ? ` (${ev.browser})` : ''}`;
    case EVENT.BROWSER_OBSERVED: return `browser observed ${ev.what}${ev.url ? ` at ${ev.url}` : ''}${ev.failures ? ` — ${ev.failures} failed assertion(s)` : ''}`;
    case EVENT.BROWSER_ERROR: return `browser error — ${ev.why || ''}`;
    case EVENT.BROWSER_CLOSED: return 'browser closed';

    case EVENT.VERIFICATION_STARTED: return 'verification started';
    case EVENT.VERIFICATION_PASSED: return `verification PASSED — ${ev.passed} requirement(s)`;
    case EVENT.VERIFICATION_FAILED: return `verification FAILED — ${ev.why || `${ev.failed} failed`}`;
    case EVENT.VERIFICATION_INCONCLUSIVE: return `verification INCONCLUSIVE — ${ev.why || `${ev.inconclusive} missing`}`;

    case EVENT.OBSERVATION_MADE: return `observed ${ev.goal} via ${ev.source} — ${ev.summary || (ev.ok ? 'answered' : 'no answer')}`;
    case EVENT.ARTIFACT_CREATED: return `artifact kept — ${ev.kind}/${ev.name} (${ev.bytes} bytes)`;

    case EVENT.APPROVAL_REQUIRED: return `approval required — ${ev.what || ''}`;
    case EVENT.APPROVAL_RESOLVED: return `approval ${ev.granted ? 'granted' : 'refused'} — ${ev.what || ''}`;
    case EVENT.RECOVERY_STARTED: return `recovery started — ${ev.why || ''}`;
    case EVENT.HOOK_RAN: return `hook ${ev.hook} at ${ev.point}${ev.ok ? '' : ` FAILED — ${ev.error}`} (${ev.ms}ms)`;

    case EVENT.AGENT_STARTED: return `agent ${ev.agent} started${ev.scope ? ` — ${ev.scope}` : ''}`;
    case EVENT.AGENT_COMPLETED: return `agent ${ev.agent} finished${ev.outcome ? ` — ${ev.outcome}` : ''}`;
    case EVENT.AGENT_FAILED: return `agent ${ev.agent} FAILED${ev.why ? ` — ${ev.why}` : ''}`;

    case EVENT.QUESTION_PRESENTED: return `asked the person — ${ev.question || ''}`;
    case EVENT.QUESTION_RESOLVED: return `answered — ${ev.answer || ''}`;
    case EVENT.WAITING_FOR_USER: return `waiting for the person — ${ev.reason || ''}`;
    default: {
      const detail = ev.why || ev.summary || ev.name || ev.tool || '';
      return `${t}${detail ? ` — ${detail}` : ''}`;
    }
  }
}

/**
 * BUILD THE TIMELINE for a task.
 *
 * Prefers the durable log, which is complete, and falls back to the bus, which
 * is bounded at 200 and is all there is before anything has been persisted.
 */
function build(harness, taskId = null, { limit = DEFAULT_LIMIT } = {}) {
  const id = taskId || (harness.runtime && harness.runtime.activeId);
  let events = [];
  if (id && harness.runtime && harness.runtime.persist) {
    events = harness.runtime.store.events(id, 2000);
  }
  if (!events.length && harness.bus) events = harness.bus.recent(200);
  const n = Math.max(1, Number(limit) || DEFAULT_LIMIT);
  return events.slice(-n).map((ev) => ({ at: ev.at, time: hhmmss(ev.at), type: ev.type, text: line(ev) }));
}

/** The same thing as plain text — what `/harness timeline` prints and what a report embeds. */
function render(rows) {
  return rows.map((r) => `${r.time}  ${r.text}`).join('\n');
}

module.exports = { build, render, line, hhmmss, DEFAULT_LIMIT };
