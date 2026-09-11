'use strict';

/**
 * WHERE A CHAT TURN GOES WHEN THE CHAT SOURCE IS NOT LAIN.
 *
 * ------------------------------------------------------------------------
 * ONE ENGINEERING SESSION, TWO KINDS OF TURN.
 *
 * A person asks why checkout is failing, asks to see the architecture, says
 * "implement the fix and run the tests", then asks why router.js changed. That
 * is FOUR turns in ONE session, on one project, with one history — and only the
 * third of them is coding. Nobody should have to start a new session because
 * the next sentence changed register.
 *
 * So this is not a second session type, not a second conversation, and — the
 * part that matters most for the code — NOT A SECOND TURN LOOP.
 *
 * ------------------------------------------------------------------------
 * IT IS AN ALTERNATIVE SOURCE OF THE SAME EVENT STREAM.
 *
 * `run` is an async generator yielding the vocabulary `turn.js` already yields —
 * `text`, `notice`, `provider_failure`, `done` — so app.js consumes it with the
 * loop it already has, and every consumer downstream is untouched: the live
 * feed, the status strip, the transcript, the turn record, the session save, the
 * elapsed clock, the interruption path.
 *
 * Writing a parallel loop here would have meant a second implementation of "what
 * a turn leaves behind", and the day the two disagreed the screen and the saved
 * session would say different things about the same exchange. `turnclose.close`
 * is called at the end for exactly that reason: one closer, one record shape.
 *
 * ------------------------------------------------------------------------
 * IT IS A NARROW DOOR, DELIBERATELY.
 *
 * `routes` says yes only when BOTH hold:
 *
 *   · a WEB chat source is selected — with LAIN selected nothing changes at all,
 *     which keeps the existing CLI behaviour bit-for-bit intact, and
 *   · the deterministic router puts this turn in the CHAT lane.
 *
 * A CODING turn NEVER comes through here, whatever source is selected. That is
 * the boundary the whole design turns on: ChatGPT.com and Gemini.google.com are
 * CONSULTED, and LAIN's own runtime remains the only thing that reads this
 * filesystem, runs a command, writes a file or settles a task.
 *
 * ------------------------------------------------------------------------
 * A WEB REPLY IS UNTRUSTED TEXT.
 *
 * It arrives as an assistant message and carries no authority: no tool is
 * offered to it, gate.js is not consulted on its behalf, and it cannot settle a
 * task. A reply that claims to have ACTED is flagged rather than passed through
 * — see contract.overclaims — because a fabricated tool result read as a real
 * one is the worst failure a two-model loop has.
 */

const registry = require('./modelsource/registry');
const lane = require('./modelsource/lane');
const contextPolicy = require('./modelsource/context');
const bindingMod = require('./modelsource/binding');
const { STATUS, overclaims } = require('./modelsource/contract');
const { newRecord } = require('./turnrecord');
const turnclose = require('./turnclose');

/**
 * SHOULD THIS TURN GO TO A WEB CHAT SOURCE?
 *
 * Pure, cheap and free of side effects, so it can be asked from anywhere —
 * including a status view that wants to say where the NEXT turn would go
 * without running one.
 */
function routes(app, verdict) {
  if (!app || !app.session) return { yes: false, why: 'no session' };
  if (!registry.usingWeb(app)) return { yes: false, why: "the chat source is LAIN's own runtime" };
  const l = lane.forVerdict(verdict);
  if (l.lane !== lane.LANE.CHAT) {
    return { yes: false, why: `this is a ${l.mode} turn — LAIN's coding runtime owns it`, lane: l };
  }
  return { yes: true, why: '', lane: l };
}

/**
 * ONE CHAT TURN, ANSWERED BY THE SELECTED WEB SOURCE.
 *
 * Yields the same events a coding turn yields. The caller does not know or care
 * which produced them, which is the point.
 */
async function* run(app, text, verdict, { from = null, signal = null } = {}) {
  const session = app.session;
  const source = registry.selected(app);
  const model = source.selectedModel();
  const record = newRecord(session.id, text, model);
  record.from = from || null;
  // WHICH LANE, AND WHO ANSWERED, ON THE RECORD. A frontend rendering the
  // history must be able to tell a chat turn from a coding one without
  // re-classifying the text — re-deriving it later is how two readings of one
  // turn come to disagree.
  record.lane = lane.LANE.CHAT;
  record.chatSource = source.id;

  // THE USER'S WORDS ENTER THE ONE HISTORY FIRST, exactly as turn.js records
  // them, so a resumed session replays the exchange in order.
  session.messages.push({ role: 'user', content: String(text), ts: new Date().toISOString() });

  // THE RUNTIME LEARNS THIS TURN EXISTS, and `turnclose.close` below is its
  // pairing call. turn.js does exactly this before its first request; skipping
  // it here would send guardian.rs a `turn_end` for a turn it was never told
  // about, and leave the session's handover boundary open. Free with no
  // supervisor running, and never awaited.
  require('./guardian').turnBegin(session.id, {
    turnId: record.turnId, model: model || '', provider: source.id, connectionId: source.id,
  });

  if (!model) {
    // NOT A SILENT FALLBACK TO LAIN. Quietly answering from a different source
    // than the one selected would attribute an answer to a model that never saw
    // the question, and provenance would say so untruthfully.
    record.stopReason = 'no-credential';
    const why = `No model is selected for ${source.label}. /source models to see what this account has, then /source use <model>.`;
    record.errors.push({ kind: 'NO_MODEL', message: why });
    yield { type: 'notice', level: 'warn', message: why };
    turnclose.close(session, session.lifecycle || null, record);
    yield { type: 'done', record };
    return;
  }

  // ---- WHAT ACTUALLY LEAVES THE MACHINE --------------------------------
  //
  // Bounded and redacted at the build, so the bytes previewed are the bytes
  // sent. A thread this session already owns means the site is holding the
  // earlier exchange, and none of it is re-sent — see context.js.
  const bound = bindingMod.resolve(session, source.id);
  const built = contextPolicy.build(app, text, { continuing: bound.ok });
  if (!built.ok) {
    record.stopReason = 'end';
    yield { type: 'notice', level: 'warn', message: built.why };
    turnclose.close(session, session.lifecycle || null, record);
    yield { type: 'done', record };
    return;
  }
  // KEPT ON THE RECORD, NOT PRINTED. "What did LAIN send to ChatGPT" has to be
  // answerable afterwards, and this is the answer.
  record.sentChars = built.chars;
  record.sentIncludes = built.included;
  // ONE MODEL INTERACTION, and a chat turn has exactly one — there is no tool
  // loop to take a second step. Recorded so `/token` and the turn summary
  // describe this turn truthfully rather than as a turn that did nothing.
  record.steps = 1;

  const res = await source.send({ prompt: built.text, modelId: model, signal });
  record.provenance = res.provenance;
  // A REQUEST IS COUNTED WHEN THE PROMPT ACTUALLY LEFT. Signed out or
  // unavailable means it never reached a composer and never touched the
  // account's quota; counting those would inflate the one figure a person uses
  // to reason about what they have spent. A rate limit DID leave — the site
  // refused after receiving it — so it counts.
  if (res.status === STATUS.COMPLETED || res.status === STATUS.RATE_LIMITED) record.usage.requests += 1;
  if (res.usage) {
    record.usage.inputTokens += res.usage.inputTokens || 0;
    record.usage.outputTokens += res.usage.outputTokens || 0;
  }

  if (res.status !== STATUS.COMPLETED) {
    const ending = ENDING[res.status] || { stop: 'provider', level: 'warn' };
    record.stopReason = ending.stop;
    record.errors.push({ kind: res.status, message: res.error || 'no reason given' });
    if (ending.stop === 'provider') {
      // THE SAME SHAPE A PROVIDER FAILURE HAS, so the header and the status
      // strip classify it with the machinery they already have rather than with
      // a second vocabulary that means the same thing.
      record.providerFailure = {
        provider: source.id,
        connectionId: source.id,
        kind: res.status,
        message: res.error || 'no reason given',
        retryAfterMs: res.retryAfterMs || undefined,
      };
      yield {
        type: 'provider_failure',
        provider: source.label,
        connectionId: source.label,
        kind: res.status,
        message: sentence(source, res),
        // `skipped` IS A FACT ABOUT THE PROMPT, not a presentation choice, and
        // render.js draws the two differently for exactly that reason: it adds
        // "No request was sent." A source that is not signed in or not available
        // never reached the composer, so the question is still the person's to
        // ask elsewhere. A rate limit is NOT skipped — the prompt did leave, and
        // saying otherwise would tell somebody their message is not in that
        // thread when it is.
        skipped: res.status === STATUS.AUTH_REQUIRED || res.status === STATUS.UNAVAILABLE,
        hint: HINT[res.status] || '',
      };
    } else {
      yield { type: 'notice', level: ending.level, message: sentence(source, res) };
    }
    turnclose.close(session, session.lifecycle || null, record);
    yield { type: 'done', record };
    return;
  }

  record.text = res.text;
  record.narration.push({ step: 0, text: res.text, at: Date.now() });
  record.stopReason = 'end';
  // THE REPLY ENTERS THE ONE HISTORY, MARKED WITH WHO SAID IT. `provenance` was
  // stamped when the request was made and travels with the message for the life
  // of the session — never reconstructed later from whatever a picker shows then.
  session.messages.push({
    role: 'assistant',
    content: res.text,
    ts: new Date().toISOString(),
    provenance: res.provenance,
  });
  yield { type: 'text', chunk: res.text };

  const claim = overclaims(res.text);
  if (claim) {
    // FLAGGED, NOT SWALLOWED AND NOT EDITED OUT. It has no tools here and it was
    // told so; a person needs to know the sentence they are reading is false
    // about itself before they act on the rest of the reply.
    const why = `${source.label} claimed to have acted ("${claim}") — it has no filesystem, no shell and no tools here.`;
    record.errors.push({ kind: 'OVERCLAIM', message: why });
    yield { type: 'notice', level: 'warn', message: why };
  }

  turnclose.close(session, session.lifecycle || null, record);
  yield { type: 'done', record };
}

/** How each non-completed status ends the turn, in turnrecord's own vocabulary. */
const ENDING = Object.freeze({
  [STATUS.CANCELLED]: { stop: 'aborted', level: 'info' },
  [STATUS.AUTH_REQUIRED]: { stop: 'provider', level: 'warn' },
  // `provider` rather than `rate-limited`, and the difference is not cosmetic.
  // app.js's `rate-limited` branch is about LAIN'S OWN ROUTES: it offers to wait
  // out a limit measured in hours and then RESUMES THE TURN ITSELF, scheduled
  // against `resumeAt`. A website account's cap states a retry time only
  // sometimes, and resuming automatically would re-send somebody's question into
  // their own ChatGPT thread without being asked. The classification stays
  // RATE_LIMITED on `providerFailure.kind`, so the strip still shows a PAUSE
  // rather than a spinner; what is withheld is the automatic resume.
  [STATUS.RATE_LIMITED]: { stop: 'provider', level: 'warn' },
  [STATUS.UNAVAILABLE]: { stop: 'provider', level: 'warn' },
  [STATUS.FAILED]: { stop: 'provider', level: 'warn' },
});

/** What the person is told to do about it. Empty when there is nothing to do. */
const HINT = Object.freeze({
  [STATUS.AUTH_REQUIRED]: 'Sign in in the browser window LAIN opened, then ask again.',
  [STATUS.RATE_LIMITED]: '/source lain to carry on with a runtime model.',
  [STATUS.UNAVAILABLE]: '/source models to choose another, or /source lain.',
});

/** One sentence about a send that produced no answer. */
function sentence(source, res) {
  if (res.status === STATUS.AUTH_REQUIRED) {
    return `${source.label} needs you to sign in${res.error ? ` — ${res.error}` : ''}`;
  }
  if (res.status === STATUS.RATE_LIMITED) {
    // NO INVENTED RETRY TIME. `retryAfterMs` is null unless the site stated one,
    // and this sentence simply has no clause when it is.
    const when = res.retryAfterMs ? ` — try again in about ${Math.max(1, Math.round(res.retryAfterMs / 60000))} minute(s)` : '';
    return `${source.label} is rate limited on this account${when}`;
  }
  if (res.status === STATUS.CANCELLED) return `${source.label} was stopped`;
  if (res.status === STATUS.UNAVAILABLE) return `${source.label} is unavailable — ${res.error || 'no reason given'}`;
  return `${source.label} did not answer — ${res.error || 'no reason given'}`;
}

module.exports = { run, routes, sentence, ENDING, HINT };
