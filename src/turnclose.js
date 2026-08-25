'use strict';

/**
 * CLOSING A TURN — the accounting, and what the session remembers of it.
 *
 * Split out of turn.js at the god-object guard. The seam is clean: everything
 * here happens AFTER the last step, touches no provider and no tool, and
 * decides nothing about what happens next. turn.js owns the loop; this owns
 * what is left behind when the loop ends.
 *
 * ------------------------------------------------------------------------
 * ACCOUNTING, NOT JUDGEMENT — the rule this file exists under.
 *
 * Counters live here: steps, tool calls, narration turns, usage, elapsed time.
 * Every one of them is worth having, and NOT ONE of them decides anything. The
 * mechanism that used to be here did: three narration-only turns set the
 * lifecycle to BLOCKED — a terminal state, rendered everywhere as failure —
 * because a counter reached three.
 *
 * A number cannot tell "stuck" from "thinking aloud through something hard",
 * and it was being asked to. So the counts are recorded and reported, and what
 * happens next is decided by the model or by the person, from the evidence.
 */

// Bounds on what a turn leaves behind in the saved session. A session is
// written to disk, so every field the UI reads is capped rather than trusted.
const MAX_KEPT_INPUT = 400;
const MAX_KEPT_TEXT = 1200;
const MAX_KEPT_ACTIONS = 40;

/**
 * Hand the turn's totals to the lifecycle and record what came back.
 *
 * TURN-WIDE TOTALS, not the final step's. Passing the last step's count is
 * precisely the V1 bug: a turn that ran ten tools and closed with "step 2 done,
 * continuing" was scored as a narration-only no-progress turn.
 */
function accountTo(life, record) {
  if (!life) { record.lifecycle = null; return record; }
  const v = life.observeTurn({
    toolCalls: record.toolCalls,
    text: record.text,
    mutated: record.mutations.length,
  });
  record.productive = Boolean(v.productive);
  // COUNTED, AND NOTHING ELSE. `if (v.blocked) record.stopReason = 'blocked'`
  // stood here and is gone; see the header.
  record.narrations = Number(v.narrations) || 0;
  if (record.providerFailure && record.providerFailure.kind === 'AUTH') {
    life.noteAuthFailure(record.providerFailure.provider, record.providerFailure.message);
  }
  record.lifecycle = life.summary();
  return record;
}

/**
 * WHAT THE SESSION REMEMBERS ABOUT THIS TURN.
 *
 * This projection used to keep only counters, so the workspace could show
 * "read_file" but never what was read, what was asked, or what the model said —
 * the transcript existed for one turn and was then thrown away.
 */
function remember(session, record) {
  record.endedAt = new Date().toISOString();
  session.usage.inputTokens += record.usage.inputTokens;
  session.usage.outputTokens += record.usage.outputTokens;
  session.usage.cacheReadTokens += record.usage.cacheReadTokens || 0;
  session.usage.cacheCreationTokens += record.usage.cacheCreationTokens || 0;
  session.usage.requests += record.usage.requests;
  session.turns.push({
    turnId: record.turnId, startedAt: record.startedAt, endedAt: record.endedAt,
    userInput: String(record.userInput || '').slice(0, MAX_KEPT_INPUT),
    // Kept because the FEED needs it, and the feed is rebuilt from the saved
    // session after a resume. Without it a reloaded conversation shows an
    // advisory continuation as a user request again.
    from: record.from || null,
    // WHAT EACH REQUEST OF THIS TURN COST, AND OF WHAT. Kept because the
    // question `/tokens` answers is always asked AFTER the turn ended, and
    // because a session saved and resumed should still be able to say where
    // its tokens went. Bounded by MAX_AUDITS when it was collected.
    audits: record.audits || [],
    text: String(record.text || '').slice(0, MAX_KEPT_TEXT),
    // Two scalars the record already counts and the saved session was losing:
    // how many model steps the turn took, and how many reads the evidence
    // ledger served instead of the filesystem. Both are what a benchmark (and
    // a `/tokens`-style after-action question) needs from a session that has
    // already ended, which is exactly what this projection is for.
    steps: record.steps || 0,
    evidenceReuse: record.evidenceReuse || 0,
    toolCalls: record.toolCalls, toolNames: record.toolNames,
    actions: record.actions.slice(-MAX_KEPT_ACTIONS),
    narration: record.narration.slice(-MAX_KEPT_ACTIONS),
    // WHAT THE USER SAID WHILE IT WAS WORKING. Without this the correction was
    // on screen for exactly as long as the turn ran: the model was handed it,
    // acted on it, and the finished transcript showed no sign that anything had
    // been said. Of everything in this projection it is the least recoverable —
    // a tool result can be produced again by running the tool, and a sentence
    // somebody typed an hour ago cannot be produced again by anything.
    steerTexts: (record.steerTexts || []).slice(-MAX_KEPT_ACTIONS),
    // WHAT IT THOUGHT, kept only so that a turn which said nothing is not a
    // blank pane once the live feed has gone. `ui/conversation.js` draws it
    // solely when there is no answer and no action — thinking is not speech.
    reasoning: String(record.reasoning || '').slice(0, MAX_KEPT_TEXT),
    errors: record.errors.slice(0, 5),
    mutations: record.mutations, stopReason: record.stopReason,
    usage: record.usage,
  });
  return record;
}

/**
 * CLOSE A TURN — the only thing any ending needs to call.
 *
 * ---- WHY THIS IS ONE FUNCTION AND NOT TWO CALLS ------------------------
 *
 * `runTurn` has five endings: the model stops asking, the user interrupts, the
 * provider fails, there is no credential, the breaker is open. Two of them used
 * to `yield { type: 'done' }` and return WITHOUT recording anything.
 *
 * That is a blank screen. The Context pane is drawn from the live story while a
 * turn runs and from `session.turns` once it has finished; `ui.story.endTurn()`
 * clears the live half unconditionally. An ending that never wrote the
 * persisted half leaves both empty in the same frame — a task banner over
 * nothing, with the user's own sentence gone from a program that is otherwise
 * working perfectly.
 *
 * One call, at every ending, so the next ending somebody adds is a single line
 * that is hard to write incorrectly — and tests/unit/transcript.test.js checks
 * structurally that no `yield done` exists without it.
 */
function close(session, life, record) {
  accountTo(life, record);
  remember(session, record);
  settleScratch(session, record);
  tellRuntime(session, record);
  return record;
}

/**
 * THE RUNTIME LEARNS THE TURN IS OVER — and how it ended, and what it cost.
 *
 * turnBegin (turn.js) declared this turn to the Guardian with the pid that owns
 * it; this is the pairing call, and without it the runtime's handover boundary
 * NEVER closes: guardian.rs holds a session in needs-handover until it sees a
 * `turn_end`, which is exactly the evidence this sends.
 *
 * `OUTCOME` IS A WORD MAP, NOT A JUDGEMENT — and the distinction is load-bearing.
 * guardian.rs decides what an ending MEANS (whether the next sentence is held);
 * all that happens here is vocabulary: turnrecord says `end`, the runtime's
 * contract says `completed`, and `rate-limited`/`rate_limited` differ by a
 * hyphen. Every other stop reason is already the runtime's own word and passes
 * through unread — including the ones the runtime treats as failure, which is
 * the runtime's call to make.
 *
 * The usage note is the FINAL receipt. The live input figures were sent as they
 * arrived (turnevents.js) and REPLACE on the far side; this one ACCUMULATES,
 * once per turn, and is the only note that carries output tokens — a figure no
 * provider states before the end.
 *
 * Fire-and-forget like every observation: a wedged or missing supervisor costs
 * this call nothing, and `tell` drops it rather than throwing.
 */
const OUTCOME = {
  end: 'completed',
  'rate-limited': 'rate_limited',
};

function tellRuntime(session, record) {
  if (!session) return;
  try {
    const guardian = require('./guardian');
    const failure = record.providerFailure || {};
    guardian.turnEnd(session.id, {
      outcome: OUTCOME[record.stopReason] || String(record.stopReason || 'completed'),
      kind: String(failure.kind || ''),
      reason: String(failure.message || ''),
    });
    // NO USAGE NOTE HERE, by design: every request's own receipt rides its
    // `request_end` (turn.js), and the runtime accumulates per request — a
    // turn-total note here would count every token twice. Live input figures
    // still arrive as readings (turnevents.js) and REPLACE, never add.
  } catch { /* an observation must never take the closing path with it */ }
}

/**
 * A COMPLETED TURN'S SCRATCH IS SPENT; every other ending keeps it.
 *
 * scratch.open (turn.js) records findings as the turn finds them so that an
 * interrupted turn leaves its evidence behind for whoever resumes. Only the
 * 'end' stop reason is completion — the model stopped asking for tools — so
 * only that ending deletes the scratch. Aborted, provider-dead, rate-limited
 * and step-bounded turns all keep it, which is the property the open exists
 * to provide. Anything durable was promoted (with evidence) into
 * .lain/memory long before this runs.
 *
 * 'no-credential' is the one other ending that spends the scratch: that turn
 * never sent a request and never ran a tool, so there is nothing to preserve
 * and an orphan would be pure noise.
 */
function settleScratch(session, record) {
  if (!session) return;
  if (record.stopReason !== 'end' && record.stopReason !== 'no-credential') return;
  try { require('./scratch').close(session.cwd, session.id); } catch { /* read-only project */ }
}

/**
 * THE FAILURE RECORD FOR A TURN THAT NEVER SENT A REQUEST.
 *
 * The availability gate refuses before any socket, so there is no classified
 * error to describe the refusal — this builds the equivalent from what the gate
 * knows.
 *
 * WHY IT DISTINGUISHES A RATE LIMIT. "Skipped because unreachable" and "skipped
 * because rate limited" look identical from the gate and are not the same
 * situation: only the second one has a stated time and a very likely
 * alternative, which is the same model on another connection. Reporting it as
 * RATE_LIMITED is what puts the failover offer in front of the user instead of
 * a generic provider failure. See failover.js and ratelimit.handle.
 */
function skipped(pc, connectionId, gate, limited) {
  return {
    provider: pc.provider,
    connectionId,
    kind: limited ? require('./errors').KIND.RATE_LIMITED : gate.status,
    message: gate.reason,
    skipped: true,
    retryAfterMs: gate.retryAfterMs || 0,
    resumeAt: gate.resumeAt || (gate.retryAfterMs ? Date.now() + gate.retryAfterMs : 0),
  };
}

module.exports = { accountTo, remember, close, skipped, MAX_KEPT_INPUT, MAX_KEPT_TEXT, MAX_KEPT_ACTIONS };
