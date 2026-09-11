'use strict';
/**
 * ONE TURN.
 *
 * A turn is: the user said something, and the model works — taking as many
 * steps as it needs, calling whatever tools it chooses in whatever order — until
 * it stops asking for tools. The whole exchange is ONE turn with ONE record.
 *
 * TWO INVARIANTS THIS FILE EXISTS TO HOLD
 *
 * 1. THE TOOL PROTOCOL STAYS IN THE CONVERSATION. The assistant turn is pushed
 *    carrying its tool_calls, and every result is pushed as a `tool` message
 *    matched by id. Nothing is built in a local array and discarded. The next
 *    request therefore replays what this one actually did.
 *
 * 2. TOOL WORK IS COUNTED ACROSS THE WHOLE TURN, NOT THE LAST STEP. A turn that
 *    ran ten tools and closed with "Step 2 is complete, I'll continue with
 *    Step 3" did ten tools' worth of work. V1 scored that as a zero-tool
 *    narration turn and drove its progress tracker to a stop; three productive
 *    turns in a row could end with `continue` producing nothing. `record.toolCalls`
 *    is the turn total and is what any later liveness/lifecycle logic must read.
 *
 * A provider failure is REPORTED, never thrown: the generator always yields a
 * terminal `done` event, so the REPL always gets control back. Real programming
 * errors still throw, or we would lose the stack traces that matter.
 */

const provider = require('./provider');
const errors = require('./errors');
const toolRegistry = require('./tools');

/**
 * HOW MANY STEPS A TURN MAY TAKE BY DEFAULT: NO LIMIT. It was 30, and thirty
 * was an opinion — a turn ended as `STEP LIMIT` with the work unfinished
 * because a counter reached a number nobody chose for the task in hand.
 *
 * Every other ending is a fact about the world rather than about a variable.
 * The count survives as telemetry; only its authority is gone. A CONFIGURED
 * `maxSteps` is still honoured — that is a person capping their own spend. The
 * full argument is in config.js, where the default lives.
 */
const DEFAULT_MAX_STEPS = 0;
/**
 * THE RETRY SCHEDULE LIVES IN backoff.js — how many attempts, and how long
 * between them. It is a pure question with no reference to a turn, so it sits
 * outside this file; what stays here is the decision to USE it, which is the
 * loop's business. See that file for why the retry is not an LLM retry loop.
 */
const { MAX_RETRIES, backoffFor, sleep } = require('./backoff');
/** How far to fold when a provider refuses on message COUNT. See msgfold.js. */
const msgfold = require('./msgfold');
/** The ONE place that knows what a provider will accept. */
const providerLimits = require('./providerlimits');
/** Making the payload fit before it is sent. See contextfit.js. */
const contextfit = require('./contextfit');
/** Accounting and the session's record of a finished turn. See turnclose.js. */
const turnclose = require('./turnclose');

/**
 * The title the transient surface wears while compaction is speaking.
 *
 * ONE CONSTANT, because the surface is keyed by title: two spellings would open
 * two surfaces for one subject and the second would wipe the first's lines.
 */
const COMPACT_SURFACE = 'COMPACT';

/**
 * WHAT LAIN IS DOING RIGHT NOW.
 *
 * The turn loop is the only thing that knows this, so it is the only thing that
 * says it. Each phase is announced from the exact point in the loop where it
 * becomes true — never inferred afterwards, never guessed from a timer.
 *
 * This vocabulary already existed here as bare strings passed to `onStatus`,
 * and NOTHING EVER PASSED AN `onStatus`. The loop computed "what am I doing"
 * before every provider call and every tool, and threw it away — which is
 * exactly why the screen could go quiet for a minute with no way to tell a
 * working LAIN from a dead one.
 *
 *   WAITING_MODEL  the request is out and nothing has come back yet. This is
 *                  the long, silent one, and the reason this exists at all.
 *   RECEIVING      bytes are arriving; the model is producing.
 *   RUNNING_TOOL   a tool is executing on this machine.
 *   RETRYING       a transient provider failure; waiting before another attempt.
 *   ENDED          the loop is finished. Not a claim about success.
 */
const PHASE = Object.freeze({
  WAITING_MODEL: 'WAITING_MODEL',
  RECEIVING: 'RECEIVING',
  RUNNING_TOOL: 'RUNNING_TOOL',
  RETRYING: 'RETRYING',
  ENDED: 'ENDED',
});

/**
 * THE RECORD ITSELF — its shape and its bounds — lives in turnrecord.js. This
 * file RUNS a turn; that one declares what a run writes into. See its header
 * for why the two are apart.
 */
const { newRecord, MAX_ACTIONS, MAX_REASONING, MAX_AUDITS } = require('./turnrecord');

// NAMING A CALL FOR A PERSON lives in describe.js — pure string work over the
// arguments, kept out of the loop that runs them. Re-exported below, because
// turnevents.js and the tests have always imported it from here.
const { describeTarget, firstLine, actionRecord, editSize, EMPTY_ANSWER } = require('./describe');
const reqtrace = require('./reqtrace');
const askgate = require('./askgate');

/** Announce the phase. A no-op when nobody listens, so headless runs pay nothing. */
function status(opts, phase, detail = {}) {
  if (opts && opts.onStatus) opts.onStatus({ phase, ...detail });
}

/**
 * @param {Session} session   MUTATED — the tool protocol is appended to it
 * @param {string}  userInput
 * @param {object}  opts  cfg, systemPrompt, signal, maxSteps, onStatus
 */

async function* runTurn(session, userInput, opts = {}) {
  const cfg = opts.cfg || {};
  const pc = provider.resolve(cfg);
  const record = newRecord(session.id, userInput, pc.model);
  // See `from` in turnrecord.js for why a turn has to know who asked for it.
  record.from = opts.from || null;
  const signal = opts.signal;
  // 0 = UNBOUNDED, and it is the default. A number here came from the caller or
  // from the user's config — see DEFAULT_MAX_STEPS for why LAIN no longer picks
  // one. `Math.max(0, …)` rather than `Math.max(1, …)`, because clamping zero
  // up to one would turn "no limit" into "one step" and stop every turn dead.
  const maxSteps = Math.max(0, Number(opts.maxSteps) || Number(cfg.maxSteps) || DEFAULT_MAX_STEPS);
  // Configurable, and bounded either way: a retry budget a config file can set
  // to a thousand is a spiral with a settings key.
  const maxRetries = Math.max(0, Math.min(10,
    Number(opts.maxConnectionRetries) || Number(cfg.maxConnectionRetries) || MAX_RETRIES));

  session.messages.push({ role: 'user', content: userInput, ts: new Date().toISOString() });

  // THE TURN'S SCRATCH — findings recorded during the turn survive its death; turnclose settles it.
  require('./scratch').open(session.cwd, session.id, { goal: userInput });

  // No credential is a setup instruction and must cost zero requests.
  const hint = provider.credentialHint(pc, cfg);
  if (hint) {
    record.stopReason = 'no-credential';
    record.errors.push({ kind: 'NO_CREDENTIAL', message: hint });
    yield { type: 'notice', level: 'warn', message: hint };
    // RECORDED BEFORE `done`, like every ending — see turnclose.close for what
    // a skipped one does to the screen. `opts.lifecycle` rather than `life`:
    // this exit happens before that binding exists.
    turnclose.close(session, opts.lifecycle || null, record);
    yield { type: 'done', record };
    return;
  }

  // The vocabulary follows the App: `computer` appears only while a transport
  // is connected, so the reader must forward the App it is working for.
  const schemas = opts.tools === false ? [] : toolRegistry.schemas(opts.app);
  // `ask` lets ask_user reach the interaction panel. Absent on non-interactive
  // runs, where the tool says so rather than hanging.
  // `app` is here for ONE tool: `computer`, which must reach the permission gate
  // to ask the user before anything touches the screen, the mouse or the
  // keyboard. No other tool reads it, and a turn run without an app simply has
  // no reach into the machine at all.
  const toolCtx = { cwd: session.cwd, signal, session, ask: opts.ask || null, app: opts.app || null };
  const life = opts.lifecycle || null;
  const avail = opts.availability || null;
  const connId = pc.connectionId || pc.provider || 'unknown';
  let retries = 0;
  let foldedOnce = false;
  session.contextAuthority.touch({ reason: 'turn-started' });
  // THE RUNTIME LEARNS THE TURN EXISTS — owner_pid is how guardian.rs detects a dead owner. turnclose ends it.
  require('./guardian').turnBegin(session.id, { turnId: record.turnId, model: pc.model, provider: pc.provider, connectionId: connId });

  // CIRCUIT BREAKER, checked BEFORE any socket. A route already known to be
  // down — or that the user disabled or put in maintenance — is skipped
  // instantly, costing zero requests and zero waiting.
  if (avail) {
    const gate = avail.shouldAttempt(connId);
    if (!gate.allow) {
      const secs = Math.ceil((gate.retryAfterMs || 0) / 1000);
      // Skipped for a limit is still a limit, and it has a way out — see turnclose.skipped.
      const limited = Boolean(gate.rateLimited);
      record.stopReason = limited ? 'rate-limited' : 'provider';
      record.providerFailure = turnclose.skipped(pc, connId, gate, limited);
      yield {
        type: 'provider_failure', provider: pc.provider, connectionId: connId,
        kind: gate.status, message: gate.reason, skipped: true,
        hint: secs > 0
          ? `Not retrying automatically for ${secs}s. /provider retry ${connId} to try now.`
          : `/provider enable ${connId} to turn it back on.`,
      };
      // RECORDED BEFORE `done`, for the same reason. See turnclose.close.
      turnclose.close(session, life, record);
      yield { type: 'done', record };
      return;
    }
  }

  // WHICH LOOP THE USER HAS BEEN TOLD ABOUT — a fingerprint, or null.
  //
  // Held for the turn so the advisory is raised ONCE per loop and RETRACTED the
  // moment the model does something new. Re-raising it every step would make it
  // flicker; never clearing it would leave a warning about a solved problem on
  // screen. See looping.js.
  let toldAbout = null;
  // UNBOUNDED UNLESS THE USER ASKED FOR A BOUND. The turn ends when the model
  // stops asking for tools, when the user stops it, or when the provider or the
  // transport makes it impossible — see DEFAULT_MAX_STEPS. A step count is not
  // one of those things.
  for (let step = 0; !maxSteps || step < maxSteps; step++) {
    if (signal && signal.aborted) { record.stopReason = 'aborted'; break; }
    record.steps = step + 1;

    // A STEER IS DELIVERED HERE — between steps, immediately before the next
    // request is built. That is the "next safe model interaction": the previous
    // step's tool results are already in the conversation, nothing is half
    // written, and the model sees the correction as the most recent thing said
    // to it. It does NOT start a second turn, does not touch the plan, and
    // cannot arrive in the middle of a tool call.
    if (typeof opts.steer === 'function') {
      for (const s of opts.steer() || []) {
        const text = String(s || '').trim();
        if (!text) continue;
        session.messages.push({ role: 'user', content: `⚑ USER STEER: ${text}`, ts: new Date().toISOString(), _steer: true });
        record.steers = (record.steers || 0) + 1;
        // THE WORDS, AND WHERE THEY LANDED — not merely how many there were.
        // Only the COUNT used to be kept, so the correction vanished from the
        // finished transcript the moment the turn ended — and a user's steer is
        // the one thing that cannot be recovered by re-reading the repository.
        // `step` puts it back in the right place when the turn is replayed.
        (record.steerTexts = record.steerTexts || []).push({ step, text });
        yield { type: 'notice', level: 'info', message: `⚑ USER STEER delivered to the model: ${text}` };
      }
    }

    // ---- WILL THIS PROVIDER ACCEPT WHAT IS ABOUT TO BE SENT? --------------
    //
    // Immediately before the send, because that is the only moment the real
    // size is known, and it costs no request — it is local string work.
    //
    // The measuring and folding live in contextfit.js: a payload has to pass a
    // character budget AND a message-count cap, which are unrelated quantities,
    // and this file had grown past the god-object guard carrying both. What
    // stays here is the decision to ASK, which is the loop's business.
    const fitted = contextfit.fit(session, pc, {
      systemPrompt: opts.systemPrompt,
      // THE HALF THAT CHANGES EVERY TURN, kept out of the cached prefix. See
      // promptparts.js; absent for a caller that does not split, which then
      // behaves exactly as before.
      live: opts.live || '',
      cfg,
      surface: COMPACT_SURFACE,
      // The schemas are part of the payload and a tenth of it; accounting that
      // left them out would understate every request by about 10,000 tokens.
      tools: schemas,
    });
    const wire = fitted.wire;
    record.compactions += fitted.compactions;
    // WHAT THIS REQUEST COST, AND OF WHAT. Kept on the record rather than
    // printed, so the turn stays quiet and `/tokens` can answer later. Only
    // the most recent few are held: this is a diagnostic, not a log.
    if (fitted.audit) {
      record.audits = record.audits || [];
      record.audits.push(fitted.audit);
      if (record.audits.length > MAX_AUDITS) record.audits.shift();
    }
    for (const n of fitted.notices) yield n;

    let text = '';
    let calls = [];
    let usage = null;
    let failure = null;

    // ANNOUNCED BEFORE THE AWAIT, not after it. The request below can take a
    // minute; saying "waiting" once it returns would be a report, not a status.
    status(opts, PHASE.WAITING_MODEL, { step: step + 1 });

    // THE REQUEST BOUNDARY: the runtime admits BEFORE the wire; a denial means
    // the provider is never called. Retries re-enter here, so every real
    // provider attempt gets its own request lifecycle. See guardian.js.
    const gate = await require('./guardian').requestBegin(session.id,
      { turnId: record.turnId, model: pc.model, provider: pc.provider, connectionId: connId });
    // ABORT, RECHECKED AFTER THE AWAIT — it is the window a cancel lands in
    // (measured: a cancelled job's suspended turn walked past it into the wire
    // and ate a later test's provider step). A cancelled turn issues NOTHING.
    if (signal && signal.aborted) { record.stopReason = 'aborted'; break; }
    if (gate && gate.allow === false) {
      const word = /^([A-Z_]+):/.exec(String(gate.reason || '')) || [];
      failure = { kind: word[1] || 'RUNTIME_REFUSED', retriable: false, layer: 'runtime',
        message: String(gate.reason || 'the runtime refused this request') };
    }

    try {
      if (!failure) {
      record.usage.requests += 1;
    const trace = reqtrace.forStep(record.turnId, step + 1, {});
      for await (const ev of provider.chat(pc, wire, { tools: schemas, signal, trace })) {
        if (signal && signal.aborted) break;
        if (!ev) continue;
        if (ev.type === 'text') {
        // The FIRST byte is the moment waiting becomes receiving — announced
        // once per step, not per chunk (400 redraws/s is a storm, not status).
          if (!text) status(opts, PHASE.RECEIVING, { step: step + 1 });
          text += ev.chunk || '';
          yield { type: 'text', chunk: ev.chunk || '' };
        } else if (ev.type === 'reasoning') {
          // THINKING ALOUD, kept out of `text` (the ANSWER, which feeds the
          // completion check and transcript); bounded, drawn only when nothing
          // was said. See ui/conversation.js.
          if (!text) status(opts, PHASE.RECEIVING, { step: step + 1 });
          const think = String(ev.chunk || '');
          record.reasoningChars = (record.reasoningChars || 0) + think.length;
          if ((record.reasoning || '').length < MAX_REASONING) record.reasoning = (record.reasoning || '') + think;
          yield { type: 'reasoning', chunk: think };
        } else if (ev.type === 'tool_calls') calls = Array.isArray(ev.calls) ? ev.calls : [];
        else if (ev.type === 'usage') usage = ev;
        // ---- WHAT THE OPEN REQUEST HAS COST SO FAR --------------------------
        //
        // PASSED THROUGH, NOT ACCUMULATED: `usage` is the receipt and is ADDED
        // to record.usage; this is a reading of an unfinished request, and
        // adding it would double-count the input the moment the receipt lands.
        // It exists so the screen can show a number already known. See
        // provider.js at `message_start`, and ui/status.js.
        else if (ev.type === 'usage_live') yield { type: 'usage_live', ...ev };
      }
      }
    } catch (e) {
      if (!errors.isProviderFailure(e) && !(signal && signal.aborted)) throw e; // a real bug keeps its stack
      // `explain` carries the SENTENCE naming the layer, so no screen downstream
      // can show a provider's 429 as though LAIN had malfunctioned.
      failure = errors.explain(e);
    } finally {
      // ONE END PER REAL ATTEMPT, carrying that attempt's receipt; the runtime
      // accumulates per request, so no turn-total usage note is sent anywhere.
      if (gate && gate.request_id) require('./guardian').requestEnd(session.id, gate.request_id, { usage });
    }

    // LAZY HEALTH: availability is learned from requests that were happening
    // anyway. There is no ping loop, so /provider status never generates traffic.
    if (avail) { if (failure) avail.noteFailure(connId, failure); else avail.noteSuccess(connId); }

    if (failure) {
      // ---- TOO MANY MESSAGES IS A DIFFERENT REFUSAL, AND HAS A FIX -------
      //
      // Reported live on 2026-08-22: omniroute answered 413
      // `chat_history_too_large / message_limit` — "Chat history exceeds the
      // 800-message limit; compact the conversation and retry." LAIN compacted,
      // truthfully said "Nothing to elide — 291k chars", and was refused again
      // on every following request. Compaction only ever shortened BODIES, and
      // a thousand short messages are still a thousand messages, so the one
      // tool built to rescue the session had no lever on the limit it hit.
      //
      // THIS IS NOT THE TRANSPORT RETRY and must never be folded into it. The
      // request is not re-sent unchanged: the conversation is made SMALLER
      // first, and only if that actually removed messages is anything sent
      // again. It happens ONCE per step — a second identical refusal means the
      // fold could not reach far enough, and trying again would be the
      // token-burning loop the design forbids.
      if (failure.kind === errors.KIND.CONTEXT_LIMIT
          && failure.limitKind === errors.LIMIT.MESSAGES
          && !foldedOnce && !text.trim()) {
        foldedOnce = true;
        // ---- WHAT THE REFUSAL TAUGHT US IS WORTH KEEPING ------------------
        //
        // A 413 that names its own cap is the provider stating a fact about
        // itself, and it is the ONLY source of that fact that cannot be out of
        // date. Remembered here, every later request in this process is checked
        // against the real number before it is built — so a route whose limit
        // LAIN did not know is learned once, from one refusal, instead of
        // being rediscovered on every long conversation. See providerlimits.
        providerLimits.learn(pc, { messages: Number(failure.maxMessages) || 0 });
        // SAY IT IS HAPPENING BEFORE IT HAPPENS. Folding a very long history is
        // the one compaction that takes long enough to see, and a screen that
        // goes quiet after a refusal — then reports a finished fold — showed the
        // user nothing at the moment they were most likely to think LAIN had
        // died. `working` is cleared by whatever notice follows.
        yield { type: 'notice', level: 'info', surface: COMPACT_SURFACE, working: true,
          message: `over this provider's ${failure.maxMessages || 'message'} limit — folding the oldest exchanges…` };
        // HOW FAR TO FOLD lives in msgfold.js — including what to do when the
        // provider's count and LAIN's disagree, which is the case that used to
        // make this whole branch a no-op.
        const stated = Number(failure.maxMessages) || 0;
        const cap = msgfold.capFor(session.messages.length, stated);
        const authority = session.contextAuthority;
        const recoveryId = authority.beginCompaction({ reason: `provider-message-limit:${stated}` });
        const fold = recoveryId
          ? session.compact({ maxMessages: cap, force: true })
          : { folded: 0, beforeMessages: session.messages.length, afterMessages: session.messages.length };
        if (recoveryId) authority.finishCompaction(recoveryId);
        if (recoveryId && fold.folded > 0) {
          record.compactions += 1;
          // ---- INTO THE SAME BOX, AND THE BOX THEN CLOSES ITSELF -----------
          //
          // This was a `note`, which is a CONVERSATION line — so the fold
          // announced itself on the bottom surface and then reported its result
          // into the transcript, where "folded 214 messages" sat permanently
          // between two things the user actually said. The surface it opened
          // was never released either, because only a `notice` addressed to the
          // same surface clears `working`, so the box hung on "working…" for
          // the rest of the session.
          //
          // One subject, one box: the announcement and the result are the same
          // event, so the result replaces the announcement and auto-closes with
          // it. Nobody has to press Esc to dismiss LAIN's own housekeeping.
          yield {
            type: 'notice',
            level: 'info',
            surface: COMPACT_SURFACE,
            message: msgfold.foldedMessage(fold, stated, cap),
          };
          // THE SAME STEP, not the next one. `continue` alone would let the
          // loop increment and spend a step of the budget on a request that
          // was never answered — the conversation got smaller, the work did
          // not advance. Same reason the transient retry does it.
          step -= 1;
          continue;
        }
        // NOTHING COULD BE FOLDED — and the busy surface must be released even
        // so. See msgfold.stuckMessage for what that silence used to cost.
        yield {
          type: 'notice',
          level: 'warn',
          surface: COMPACT_SURFACE,
          message: msgfold.stuckMessage(session.messages.length),
        };
        // And it does NOT retry into the same wall: everything left is work,
        // and dropping it would lose the task rather than the history.
      }
      // Retry the SAME step for a transient failure, with a bounded budget.
      // Anything already streamed is kept.
      // NOTHING STREAMED YET is the condition, and it is about correctness:
      // once bytes of an answer have arrived, re-sending would duplicate them.
      // ---- A LIMIT MEASURED IN HOURS IS A DECISION, NOT A RETRY ------------
      //
      // The retry below is right for a limit that clears in seconds. A real
      // router handed LAIN "retry in 4 hours" — sitting in that retry is a
      // LAIN that looks alive and spends its budget before the limit clears.
      // The turn ENDS instead, carrying when it clears; app.js asks the only
      // two useful questions (wait, or change model). See ratelimit.js.
      const rl = require('./ratelimit');
      if (rl.worthAsking(failure) && !text.trim()) {
        record.stopReason = 'rate-limited';
        record.providerFailure = {
          provider: pc.provider,
          connectionId: connId,
          kind: failure.kind,
          message: failure.message,
          retryAfterMs: failure.retryAfterMs,
          resumeAt: Date.now() + failure.retryAfterMs,
        };
        break;
      }

      if (failure.retriable && retries < maxRetries && !text.trim()) {
        retries += 1;
        // ONE POLICY, in backoff.js: MAX(schedule, trustworthy provider hint),
        // so a provider can make LAIN wait longer but never shorter. The
        // hardcoded 20s rate-limit branch that used to live here is gone.
        const waitMs = backoffFor(retries, failure.retryAfterMs);
        // A 20-second rate-limit wait with a silent screen is indistinguishable
        // from a hang, so the wait says what it is and how long it will be.
        // WHEN, not just how long. A duration answers "how long do I wait";
        // an absolute time answers "can I go and do something else" — and the
        // second is the question a person actually has. Both are sent, because
        // the countdown is what makes a long wait legible while it happens.
        const resumeAt = Date.now() + waitMs;
        status(opts, PHASE.RETRYING, {
          attempt: retries, of: maxRetries, waitMs, resumeAt,
          rateLimited: failure.kind === errors.KIND.RATE_LIMITED,
          // WHAT FAILED, not merely that something did. A gateway timeout and
          // a refused model are different problems with different fixes, and
          // a screen that calls both "retrying" makes the user debug the
          // wrong half. See ui/status.js.
          kind: failure.kind,
          status: failure.status || null,
          reason: failure.message,
        });
        // ---- TRANSIENT, AND COMPACT ---------------------------------------
        //
        // It was DURABLE and carried the provider's whole body — `WARN omniroute:
        // 503 … {"error":{…}} retry 4/5 at 16:17:24 (6s)` — every field of which the
        // live row already draws, and replaces when the wait ends. `transient` sends
        // it to the operation row on a TUI and to one dim line on a pipe, which has
        // no such row and must not fall silent for sixty seconds. The raw payload
        // stays on `record.errors` for /status. See turnevents.js.
        yield {
          type: 'notice',
          level: 'warn',
          transient: true,
          message: `${errors.retryWord(failure)} · ${errors.shortReason(failure)} · retry in `
            + `${Math.round(waitMs / 1000)}s · ${retries}/${maxRetries}`,
        };
        await sleep(waitMs, signal, opts.timers || null);  // timers: test seam, see backoff.js
        // Escape (or Ctrl+C) during the wait aborts the signal. Say that the
        // wait ended because it was cancelled, not because the provider came
        // back — the two look identical from here otherwise.
        if (signal && signal.aborted) { record.stopReason = 'aborted'; break; }
        // AND THE END OF THE WAIT IS A TRANSIENT TOO: on a TUI `Ⅱ Rate limited`
        // simply becomes `◐ Receiving` and this row is superseded; on a pipe it is
        // the one line that says the gap is over. Either way a recovery the user
        // need not act on leaves no trace in the conversation.
        yield { type: 'notice', level: 'info', transient: true, message: 'Resuming' };
        step -= 1;
        continue;
      }
      // THE WHOLE CLASSIFICATION, not a hand-listed subset of it: a field
      // enumerated here is one somebody has to remember to add, and spreading
      // it cannot forget. Context reads `limitKind`/`layer` to draw failures.
      record.errors.push({ ...failure, status: failure.status || null });
      record.providerFailure = { provider: pc.provider, ...failure };
      record.stopReason = 'provider';
      yield { type: 'provider_failure', provider: pc.provider, ...failure };
      break;
    }

    if (usage) {
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']) record.usage[k] += usage[k] || 0;
    }
    if (text.trim()) {
      record.text += (record.text ? '\n' : '') + text.trim();
      // Keep WHICH step said it. The activity view interleaves prose with the
      // calls that followed it, which is the difference between a narrative and
      // two stacked lists.
      //
      // `at` IS A DISPLAY STAMP, and it is here so a paragraph does not TELEPORT
      // when the turn ends. Prose is presented from the moment it was said (see
      // ui/reveal.js), and the live copy of it — ui/story.js `noteNarration` —
      // is cleared the instant `endTurn` hands the feed back to this record. A
      // paragraph still resolving at that moment therefore lost the one thing
      // the presentation is a function of, and snapped to full: half a second of
      // motion followed by the rest of the answer appearing at once, which is
      // the "magician effect" the brief names.
      //
      // Carrying the stamp across the handover is the whole of the fix: the
      // record now says WHEN as well as WHAT, so the same pure function keeps
      // returning the same frames either side of the boundary. It changes
      // nothing else — the text, the step and the order are untouched, and a
      // record without a stamp (every session saved before this) is drawn
      // settled, which is what it is.
      if (record.narration.length < MAX_ACTIONS) {
        record.narration.push({ step, text: text.trim(), at: Date.now() });
      }
    }

    // Normalize ids BEFORE persisting: an empty or duplicate id leaves a
    // tool_result nothing can be matched to, which every provider rejects.
    const seen = new Set();
    const normalized = calls.filter(Boolean).map((c, i) => {
      let id = String(c.id || '');
      if (!id || seen.has(id)) id = `call_${step}_${i}`;
      seen.add(id);
      let input = c.input;
      if (typeof input === 'string') { try { input = input.trim() ? JSON.parse(input) : {}; } catch { input = {}; } }
      if (!input || typeof input !== 'object') input = {};
      return { id, name: String(c.name || ''), input };
    }).filter((c) => c.name);

    if (text.trim() || normalized.length) {
      const asst = { role: 'assistant', content: text.trim(), ts: new Date().toISOString() };
      if (normalized.length) {
        asst.tool_calls = normalized.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.input) }));
      }
      session.messages.push(asst);
    }

    if (signal && signal.aborted) {
      for (const c of normalized) {
        session.messages.push({ role: 'tool', tool_call_id: c.id, content: 'interrupted by the user before this ran', isError: true });
      }
      record.stopReason = 'aborted';
      break;
    }

    // No tool calls this step: the model is finished with this turn. This is a
    // normal ending, NOT evidence about whether the turn was productive —
    // record.toolCalls already holds the turn-wide truth.
    if (!normalized.length) {
      record.stopReason = record.stopReason || 'end';
      // A TURN THAT SAID NOTHING MUST NOT LOOK LIKE ONE THAT DID — see
      // describe.EMPTY_ANSWER. Only when all three are empty: a model that
      // reasoned has that on screen already.
      if (!record.text.trim() && !record.toolCalls && !record.reasoningChars) {
        yield { type: 'notice', level: 'warn', message: EMPTY_ANSWER };
      }
      break;
    }

    const gated = askgate.cut(normalized);   // a question ends the step — askgate.js
    for (const c of gated.run) {
      if (signal && signal.aborted) {
        session.messages.push({ role: 'tool', tool_call_id: c.id, content: 'interrupted by the user before this ran', isError: true });
        continue;
      }
      yield { type: 'tool_start', id: c.id, name: c.name, input: c.input };
      status(opts, PHASE.RUNNING_TOOL, { tool: c.name, target: describeTarget(c.name, c.input) });

      // The evidence ledger may serve a compact note INSTEAD of re-reading an
      // unchanged large file. It never blocks: a targeted read is always run,
      // and a changed file is always re-read. See evidence.js.
      // REVERSIBILITY: capture prior bytes BEFORE a mutating call. This gates
      // nothing and asks nothing — the model edits freely; LAIN keeps the way back.
      let checkpoint = null;
      if (opts.checkpoints && toolRegistry.isMutating(c.name) && c.input && c.input.path) {
        const abs = require('path').isAbsolute(c.input.path)
          ? c.input.path : require('path').resolve(session.cwd, c.input.path);
        checkpoint = opts.checkpoints.capture(record.turnId, [abs]);
      }

      const ledger = opts.evidence || null;
      const substitute = ledger ? ledger.check(c.name, c.input) : null;
      const startedMs = Date.now();
      const result = substitute || await toolRegistry.execute(c.name, c.input, toolCtx);
      // Fingerprint what the call LEFT behind, so a later undo can tell "still
      // as LAIN wrote it" from "changed by something else since".
      if (checkpoint) opts.checkpoints.settle(checkpoint);
      if (ledger) ledger.observe(c.name, c.input, result);
      if (substitute) record.evidenceReuse += 1;

      // One bounded line per call, for the ACTIVITY view — see describe.js.
      if (record.actions.length < MAX_ACTIONS) {
        // See describe.js `editSize`: the RECORD carries the +/- counts, not the feed.
        const size = editSize(opts.checkpoints, checkpoint);
        record.actions.push(actionRecord(c, result, { step, ms: Date.now() - startedMs, reused: Boolean(substitute), ...size }));
      }

      // LIVENESS, fed from the real path — OBSERVED HERE, ANSWERED BY THE USER.
      //
      // It used to push a `role: 'user'` message telling the model it was
      // repeating and then block the turn. Now it yields an advisory the person
      // may act on or ignore; the turn is not affected either way. looping.js
      // has the whole account.
      let advise = null;
      if (life) {
        const v = life.observeTool({
          name: c.name, input: c.input, output: result.output,
          isError: Boolean(result.isError), mutated: result.mutated || [],
          // The exit code is what turns "a command ran" into "the check passed
          // or failed" — completion consults it.
          exitCode: result.exitCode == null ? null : result.exitCode,
        });
        const say = require('./looping').verdict(v, life.quiet, v.key);
        if (say.show && toldAbout !== v.key) {
          toldAbout = v.key;
          advise = { type: 'looping', name: c.name, target: describeTarget(c.name, c.input), count: say.count, key: v.key };
        } else if (!say.show && toldAbout) {
          toldAbout = null;
          advise = { type: 'looping_clear' };
        }
      }

      record.toolCalls += 1;                       // TURN-WIDE accumulation
      if (!record.toolNames.includes(c.name)) record.toolNames.push(c.name);
      for (const m of result.mutated || []) if (!record.mutations.includes(m)) record.mutations.push(m);
      if (result.isError) record.errors.push({ kind: 'TOOL', message: `${c.name}: ${String(result.output).slice(0, 200)}` });

      // Every call gets a result message. An unanswered tool_call is a 400
      // everywhere, and a silent one makes the model believe it succeeded.
      session.messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: String(result.output == null ? '' : result.output),
        isError: Boolean(result.isError),
        ts: new Date().toISOString(),
      });

      // `input` travels with the result so a consumer can label it without
      // having to remember what it saw at tool_start.
      yield { type: 'tool_result', id: c.id, name: c.name, input: c.input, output: result.output, isError: Boolean(result.isError), exitCode: result.exitCode == null ? null : result.exitCode, meta: result.meta || null };

      // AFTER the result, so the advisory is about a call that has finished —
      // and NOTHING is awaited here: the next step runs whether or not anybody
      // is looking at it.
      if (advise) yield advise;
    }
    askgate.answerDeferred(session, gated.deferred);

    session.contextAuthority.touch({
      reason: `step-result:${record.turnId}:${step}`,
    });

    // ONLY WHEN THE USER SET A BOUND. With `maxSteps` unset this never fires,
    // and the loop above never ends on a count — so `max-steps` now means "the
    // limit YOU configured was reached", which is a different sentence from the
    // one it used to mean.
    if (maxSteps && step === maxSteps - 1) record.stopReason = 'max-steps';
  }

  // THE TURN IS OVER: account for it, and remember it. Both live in
  // turnclose.js, which contacts no provider and decides nothing.
  turnclose.close(session, life, record);

  status(opts, PHASE.ENDED, { stopReason: record.stopReason });
  yield { type: 'done', record };
}

module.exports = { runTurn, PHASE, DEFAULT_MAX_STEPS, newRecord, describeTarget, MAX_ACTIONS };
