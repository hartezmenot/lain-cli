'use strict';

/**
 * WHAT A TURN RECORD IS — the shape, and the bounds on it.
 *
 * Split out of turn.js when that file reached the architecture guard, and the
 * seam is real rather than convenient. turn.js RUNS a turn: it drives the
 * provider, dispatches tools, handles refusals, retries and cancellation.
 * This declares the object that run writes into, and the two numbers that stop
 * it growing without limit. They change for different reasons — a new tool or a
 * new failure mode touches the loop and not this; a new thing worth REMEMBERING
 * about a turn touches this and not the loop.
 *
 * turnclose.js is the third piece of the same story and was already separate:
 * this is the record's beginning, that is its ending, and turn.js is what
 * happens in between.
 */

/**
 * TURN IDS ARE UNIQUE WITHIN A PROCESS, and the counter is why.
 *
 * A timestamp alone is not enough: two turns can start inside the same
 * millisecond — a steer promoted the instant a turn ends, an advisory brief
 * submitted the moment a consultation returns — and two records with one id is
 * a transcript that cannot be read back in order.
 */
let turnSeq = 0;

/**
 * HOW MANY ACTIONS AND HOW MUCH NARRATION ONE TURN KEEPS.
 *
 * A bound rather than a budget: nothing is dropped that a person would miss in
 * a normal turn, and a runaway loop cannot make the record unbounded. The
 * bounds on what a turn leaves behind AFTER it ends live with the projection
 * that applies them — see turnclose.js.
 */
const MAX_ACTIONS = 200;

/**
 * HOW MANY PER-REQUEST TOKEN BREAKDOWNS ONE TURN KEEPS.
 *
 * A diagnostic, not a log. The question it answers is "why was that request
 * so large", which is always about the recent ones — and a turn that takes
 * forty steps must not accumulate forty breakdowns in memory to answer it.
 */
const MAX_AUDITS = 12;

/** How much thinking is kept. It is only ever shown when the model said nothing. */
const MAX_REASONING = 4000;

/** What one turn did. Handed to the REPL and appended to the session. */
function newRecord(sessionId, userInput, model) {
  turnSeq += 1;
  return {
    turnId: `t${turnSeq}-${Date.now().toString(36)}`,
    sessionId,
    userInput,
    model,
    /**
     * WHO ASKED FOR THIS TURN. Null for the person at the keyboard, which is
     * almost always. Set when LAIN continues its OWN work — the turn an
     * external consultation hands back, a rate-limit resume — because the feed
     * has to tell those apart: a continuation drawn as `USER REQUEST` claims
     * somebody typed something they never typed. See ui/phrasing.js.
     */
    from: null,
    startedAt: new Date().toISOString(),
    steps: 0,
    toolCalls: 0,          // TURN-WIDE. never per-step.
    toolNames: [],
    /**
     * What actually happened, in order, for the ACTIVITY view.
     * `[{ name, target, ok, ms, reused }]`, bounded — the UI needs to show
     * "read src/auth/login.js" rather than a bare tool name, and deriving that
     * later from the message log would mean re-parsing arguments the turn
     * already had in hand.
     */
    actions: [],
    /** `[{ step, text }]` — the model's prose, in the order it was said. */
    narration: [],
    evidenceReuse: 0,      // reads served from the ledger instead of re-read
    compactions: 0,        // times the conversation had to be trimmed to fit
    mutations: [],         // absolute paths actually changed
    errors: [],            // [{ kind, message }]
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0 },
    text: '',              // assistant prose across the turn
    stopReason: null,      // 'end' | 'max-steps' | 'aborted' | 'provider' | 'no-credential'
    providerFailure: null,
    /** Per-request token breakdowns. See src/tokenaudit.js. */
    audits: [],
  };
}

module.exports = { newRecord, MAX_ACTIONS, MAX_REASONING, MAX_AUDITS };
