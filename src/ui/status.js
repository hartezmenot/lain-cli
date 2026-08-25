'use strict';

/**
 * THE LLM STATUS STRIP — the row (or three) immediately above the INPUT box.
 *
 * WHY IT IS HERE AND NOT AT THE TOP. The live "Thinking…/Writing…" row used to
 * ride in the pinned task banner at the top of the workspace, where it cost the
 * most valuable rows on the screen and sat furthest from the thing the user is
 * actually looking at while they wait — the place they are about to type. Work
 * reads downward: what was asked is at the top, what is happening THIS SECOND is
 * at the bottom, directly above the caret.
 *
 * WHAT IT MAY SAY. Only facts the program already holds: the turn loop's phase,
 * the tool in flight and its subject, the retry countdown, the outcome of the
 * turn that just ended. There is no summarising of the model's reasoning here —
 * this is operational status, and it is deliberately NOT a place hidden
 * reasoning could be surfaced. Everything it shows also exists in the ACTIVITY
 * view in full; the strip is the compact restatement, never a replacement.
 *
 *     ⋯ ✓ Read src/app.js
 *     ⋯ ✓ Ran npm test
 *     ◐ RUNNING   npm test                                            12s
 *
 * The trailing rows are the last completed calls of THIS turn, so the strip
 * answers "and what did it just do?" without scrolling. On a short terminal only
 * the live row survives, because "is it still alive" outranks the history.
 */

const T = require('./text');
const { P, ACTOR, paintActor } = require('./paint');

/**
 * WHO IS ACTING, in its own column.
 *
 * With one model there was only ever one answer and the column would have been
 * noise. With an external reviewer in the loop there are five — LAIN deciding,
 * an EXTERNAL model reviewing, a TOOL running here, the MCP bridge touching the
 * desktop, and the USER — and "an external model's hypothesis read as LAIN's
 * own finding" is the confusion this exists to prevent. The column is the first
 * thing on the row because it is the first thing you need to know.
 */
const ACTOR_COL = 9;
/** Below this the actor is abbreviated; it is never dropped. */
const ACTOR_FULL_WIDTH = 56;

/** Which verb a tool call deserves in the strip. */
const VERB = {
  write_file: 'WRITING', edit_file: 'WRITING',
  read_file: 'READING', list_dir: 'READING',
  grep: 'SEARCHING', glob: 'SEARCHING',
  run_bash: 'RUNNING', run_powershell: 'RUNNING', run_cmd: 'RUNNING',
  plan_write: 'PLANNING', plan_step_done: 'PLANNING',
  // ASKING, not WAITING. Every other wait on this row is LAIN waiting on a
  // machine; this one is LAIN waiting on the PERSON, and it is the only state
  // where doing nothing leaves the turn parked forever.
  ask_user: 'ASKING USER',
  // AN MCP ACTION IS NOT "RUNNING". It is a request to another process that
  // has hands on this machine, and the difference is worth a word of its own:
  // `RUNNING npm test` and `RUNNING MCP input.mouse.click` are not the same
  // kind of event, and the second is the one somebody may want to stop.
  probe: 'RUNNING MCP', desktop: 'RUNNING MCP',
};

/** How much of a provider's own error text a single row will carry. */
const MAX_DETAIL = 160;

/**
 * A TOKEN COUNT, SHORT ENOUGH TO SHARE A ROW.
 *
 * Three significant figures is the resolution anybody acts on: the difference
 * between 42,118 and 42,131 changes nothing a person would do, and the seven
 * characters it costs are seven the detail beside it needed.
 */
function tok(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const k = v / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`;
  }
  const m = v / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/**
 * ------------------------------------------------------------------------
 * WHAT THIS SESSION HAS COST — and what took the second progress bar's place.
 *
 * THE BAR THAT WAS HERE WAS THE SAME BAR AS THE ONE AT THE TOP. `STEP 3/5
 * ████░░ 60%` was drawn by the task banner and again in this row's right-hand
 * column: one fact, two indicators, on one screen, and neither of them the
 * thing a person watching a long turn actually wants to know. The banner keeps
 * it — it belongs beside the objective it measures. This corner answers the
 * question the banner cannot: what is this costing.
 *
 * FOUR FIGURES, AND ONE OF THEM IS SOMETIMES ABSENT ON PURPOSE:
 *
 *   ↑  input tokens, session total
 *   ⚡ cache reads, session total — the diagnostic that says whether caching is
 *      working at all, which is invisible without it
 *   ↓  output tokens, session total
 *   +  the input side of the request that is OPEN RIGHT NOW
 *
 * THE `+` IS THE ONLY LIVE NUMBER IN THE ROW, and it is separate from the total
 * rather than added into it because it is not in the total yet: the receipt has
 * not arrived. Folding it in would make the figure DROP when the request
 * finished and the measured value replaced the reading.
 *
 * `+…` MEANS "A REQUEST IS OPEN AND ITS COST IS NOT KNOWN YET". Most
 * OpenAI-shaped gateways state usage only in the final chunk, so there is
 * genuinely nothing to show — and an ellipsis says that, where a `+0` would be
 * a measurement nobody made. §10: never fake a live number.
 *
 * THERE IS NO LIVE OUTPUT FIGURE AT ALL, on any provider LAIN speaks to. Output
 * tokens are stated once, at the end. `↓` is therefore always a completed
 * total, and the row never pretends otherwise.
 */
function tokens(s) {
  const u = s && s.usage;
  const live = s && s.liveUsage;
  const open = Boolean(s && s.requestOpen);
  const total = u ? (u.inputTokens || 0) + (u.outputTokens || 0)
    + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0) : 0;
  if (!total && !live && !open) return '';
  const parts = [];
  if (u && (u.inputTokens || total)) parts.push(`↑${tok(u.inputTokens)}`);
  if (u && u.cacheReadTokens) parts.push(`⚡${tok(u.cacheReadTokens)}`);
  if (u && (u.outputTokens || total)) parts.push(`↓${tok(u.outputTokens)}`);
  if (open) {
    const inFlight = live ? (live.inputTokens || 0) + (live.cacheReadTokens || 0)
      + (live.cacheCreationTokens || 0) : 0;
    parts.push(inFlight ? `+${tok(inFlight)}` : '+…');
  }
  return parts.join(' ');
}

const SPIN = ['◐', '◓', '◑', '◒'];

/**
 * Why a turn ended, in the words the strip uses. The same reasons Context
 * names — see turnevents.WHY — said shorter, because this row has one line and
 * the conversation has room to explain.
 */
/**
 * AND IN ONE WORD. Every reason but `aborted` used to rest on `INTERRUPTED`,
 * which tells somebody they stopped a turn they never touched, and hides a
 * provider outage behind a word that sounds like a keystroke. the design asks for these
 * states to be DISTINGUISHABLE; the sentences beside them already were, and it
 * was only the word that had been merged.
 *
 * A MISSING CREDENTIAL BORROWS THE FAILURE VOCABULARY below rather than
 * inventing a second spelling of the same fact.
 */
/**
 * `blocked` IS NO LONGER PRODUCED, and is kept deliberately.
 *
 * Nothing writes `stopReason = 'blocked'` any more: it came from a counter that
 * declared a task failed after three narration-only turns, and that authority
 * was removed. But `stopReason` is PERSISTED in `session.turns`, so a session
 * saved before the change still carries the word and `/resume` will render it.
 * Deleting the entry would show a blank state for a turn that really did end
 * that way.
 *
 * It is a reader for old data, not a live state. If anything starts producing
 * it again, something has re-grown the authority to judge the model.
 */
const STOPPED_WORD = {
  aborted: 'STOPPED',
  'max-steps': 'STEP LIMIT',
  blocked: 'BLOCKED',
  provider: 'FAILED',
  'no-credential': 'NOT AUTHENTICATED',
};

const STOPPED_BECAUSE = {
  // YOUR limit, not LAIN's — the default is no limit at all.
  'max-steps': 'the step limit you configured was reached',
  aborted: 'you stopped it',
  provider: 'the provider stopped answering',
  blocked: 'no new evidence',
  'no-credential': 'no usable credential',
};

/** `00:23` — a countdown a person can watch tick. */
function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** `12:50:00` in the user's own clock — the answer to "when can I work again?". */
function clockAt(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * The live state as { word, detail, colour } — or null when nothing is running
 * and nothing has happened yet.
 *
 * ONE function decides what LAIN is doing, so the strip, the header word and any
 * future surface cannot disagree about it.
 */
function liveState(s = {}, now = Date.now()) {
  const {
    phase, phaseSince = 0, interrupting, interrupted, failed, retryCancelled,
    steerQueued, lastTurn, pendingCompletion, awaitingUser, lastCheckFailed,
    waitingUntil, waitingLabel,
  } = s;
  const age = phaseSince ? now - phaseSince : 0;
  const secs = age >= 1500 ? `${Math.round(age / 1000)}s` : '';

  // ---- A DELIBERATE WAIT OUTRANKS EVERYTHING ------------------------------
  //
  // Above the failure row and above DONE, because it is the most specific true
  // statement available: LAIN is not broken and is not finished, it is waiting
  // for a rate limit to clear and it knows exactly when. Four hours of a silent
  // screen is indistinguishable from a dead one, which is the whole reason this
  // state has a clock on it.
  if (waitingUntil && waitingUntil > now) {
    const rl = require('../ratelimit');
    return {
      actor: 'NET',
      word: 'WAITING FOR LIMIT RESET',
      detail: `${rl.human(waitingUntil - now)} · ${waitingLabel || 'the provider is rate limited'} · Esc to stop waiting`,
      colour: 'warn',
    };
  }

  // THE ACTOR IS DECLARED BY WHOEVER STARTED THE WORK, never guessed here. The
  // turn loop announces LAIN's own phases; the relay announces EXTERNAL; the
  // desktop bridge announces MCP. An unlabelled phase is LAIN's, which is what
  // every existing caller means.
  const actorOf = (p) => (p && p.actor && ACTOR[p.actor] ? p.actor : 'LAIN');

  if (interrupting) return { actor: 'LAIN', word: 'INTERRUPTING', detail: 'cancelling the turn', colour: 'warn', spin: true };
  // AN EXTERNAL MODEL IS A DIFFERENT KIND OF WAIT and says so in its own words:
  // it is not this machine working and it is not LAIN's own model thinking.
  if (phase && phase.phase === 'EXTERNAL') {
    return {
      actor: 'EXTERNAL',
      word: phase.word || 'REVIEWING',
      detail: phase.detail || 'the investigation packet',
      colour: 'external', spin: true, age: secs,
    };
  }
  if (phase && phase.phase === 'MCP') {
    return {
      actor: 'MCP',
      word: phase.word || 'DESKTOP',
      detail: phase.detail || phase.target || '',
      colour: 'warn', spin: true, age: secs,
    };
  }
  if (phase && phase.phase === 'RETRYING') {
    // THE RATE-LIMIT WAIT, stated three ways because each answers a different
    // question: what is wrong, when it ends, and how to stop waiting.
    // THE DEADLINE WINS OVER THE DURATION.
    //
    // The countdown was `waitMs - (now - phaseSince)`, which is right only while
    // those two agree. `resumeAt` is the absolute moment the wait ends, so it
    // cannot drift if a redraw is late or the phase timestamp is refreshed, and
    // it is the field that answers the question actually being asked — when can
    // I work again. The duration stays as the fallback for a caller that sends
    // only that.
    const at = phase.resumeAt || (phaseSince ? phaseSince + (phase.waitMs || 0) : now);
    const left = phase.resumeAt
      ? Math.max(0, phase.resumeAt - now)
      : Math.max(0, (phase.waitMs || 0) - age);
    // WHAT IS BEING RETRIED, in the same vocabulary a finished failure uses.
    // `RETRYING` alone said that something was wrong and not what — so a
    // gateway restarting and a model refusing looked identical while they
    // were happening, which is precisely when the difference is useful.
    const f = failureRow({ kind: phase.kind, status: phase.status, message: phase.reason });
    const word = phase.rateLimited ? 'RATE LIMITED' : (phase.kind ? f.word : 'RETRYING');
    // WHAT SURVIVES A NARROW TERMINAL, in order. Clipping the sentence from the
    // right threw away "Esc to cancel" first — the one part that tells the user
    // they are not trapped — so the parts are dropped by IMPORTANCE instead:
    // the attempt count goes first, then the absolute time, and the countdown
    // and the way out are the last two standing.
    const parts = [
      // THE STATUS CODE FIRST AMONG THE DETAILS. `502` is the single most
      // useful thing to know while waiting, and it is what a person needs in
      // order to decide whether waiting is the right response at all.
      // A SMALLER `drop` IS SHED FIRST, and the status code was at 0 — the very
      // first thing thrown away, directly against the sentence above it. What a
      // person waiting actually needs, in order: how long is left, how to stop
      // waiting, why this is happening, when it ends, which attempt this is.
      ...(phase.status ? [{ text: String(phase.status), short: String(phase.status), drop: 2 }] : []),
      { text: `retrying at ${clockAt(at)}`, short: `at ${clockAt(at).slice(0, 5)}`, drop: 1 },
      { text: `${mmss(left)} remaining`, short: mmss(left), drop: 4 },
      { text: `attempt ${phase.attempt}/${phase.of}`, short: `${phase.attempt}/${phase.of}`, drop: 0 },
      { text: 'Esc to cancel', short: 'Esc ✕', drop: 3 },
    ];
    const net = word === 'NETWORK' || word === 'RATE LIMITED';
    return { actor: net ? 'NET' : 'LAIN', word, parts, colour: 'warn', spin: true };
  }
  if (phase) {
    switch (phase.phase) {
      case 'WAITING_MODEL':
        return { actor: actorOf(phase), word: 'THINKING', detail: 'waiting for the model' + (steerQueued ? ' · steer queued' : ''), colour: 'info', spin: true, age: secs };
      case 'RECEIVING':
        return { actor: actorOf(phase), word: 'RECEIVING', detail: 'model response', colour: 'info', spin: true, age: secs };
      case 'RUNNING_TOOL': {
        const word = VERB[phase.tool] || 'RUNNING';
        // A tool runs on THIS machine. That is a different actor from the model
        // that asked for it, and the difference is the whole point of the column.
        //
        // AND A BRIDGE CALL IS NEITHER. It is another process with hands on this
        // machine, acting on LAIN's behalf — the one row where a person may want
        // to reach for STOP, and it was wearing the same label as a file read.
        const who = (phase.tool === 'probe' || phase.tool === 'desktop') ? 'MCP' : 'TOOL';
        return { actor: who, word, detail: phase.target || phase.tool || '', colour: 'info', spin: true, age: secs, path: true };
      }
      default: break;
    }
  }
  if (retryCancelled) return { actor: 'USER', word: 'RETRY CANCELLED', detail: 'the wait was stopped; the task is intact', colour: 'warn' };
  if (interrupted) return { actor: 'USER', word: 'INTERRUPTED', detail: 'you stopped the turn; nothing was lost', colour: 'warn' };
  if (failed) {
    // NETWORK IS NOT LAIN. Attributing a gateway timeout to LAIN puts the
    // blame — and the debugging — in the wrong place.
    const f = failureRow(failed);
    const net = f.word === 'NETWORK' || f.word === 'RATE LIMITED';
    return { actor: net ? 'NET' : 'LAIN', word: f.word, detail: f.detail, colour: 'bad' };
  }
  if (steerQueued) return { actor: 'USER', word: 'STEERING', detail: 'queued for the next model turn', colour: 'warn' };
  // A FINISHED PLAN IS NOT A FINISHED TASK, and the strip must not imply it is.
  // This sits ABOVE the DONE branch on purpose: with work still outstanding,
  // "DONE · 3 tool calls" is the single most misleading thing the strip could
  // say, and it is exactly what it used to say.
  // A QUESTION ADDRESSED TO THE PERSON RESTS HERE, above DONE and above
  // VERIFYING. The model asked for a key press and the turn ended; reporting
  // that as DONE tells somebody their investigation finished when it is in
  // fact waiting for them.
  if (awaitingUser) {
    return { actor: 'LAIN', word: 'WAITING FOR YOU', detail: String(awaitingUser), colour: 'warn' };
  }
  if (pendingCompletion) {
    return { actor: 'LAIN', word: 'VERIFYING', detail: String(pendingCompletion), colour: 'warn' };
  }
  if (lastTurn) {
    const bits = [];
    if (lastTurn.toolCalls) bits.push(`${lastTurn.toolCalls} tool call${lastTurn.toolCalls === 1 ? '' : 's'}`);
    if (lastTurn.filesChanged) bits.push(`${lastTurn.filesChanged} file${lastTurn.filesChanged === 1 ? '' : 's'} changed`);
    // A TURN THAT WAS CUT SHORT IS NOT DONE. The counts are still true and
    // still shown — the work happened — but the word in front of them decides
    // whether a person goes and looks, and `DONE` sent them away.
    const cut = lastTurn.stopReason && lastTurn.stopReason !== 'end';
    if (cut) {
      // A DEAD PROVIDER IS NOT LAIN, resting or otherwise —. It keeps the
      // NET actor here for the same reason the live row gives it one.
      const net = lastTurn.stopReason === 'provider';
      return {
        actor: net ? 'NET' : 'LAIN',
        word: STOPPED_WORD[lastTurn.stopReason] || 'INTERRUPTED',
        detail: [STOPPED_BECAUSE[lastTurn.stopReason] || lastTurn.stopReason, ...bits].join(' · '),
        colour: net || lastTurn.stopReason === 'no-credential' ? 'bad' : 'warn',
      };
    }
    // ---- A FAILING CHECK OUTRANKS A FINISHED TURN --------------------------
    //
    // The turn ended normally and the counts are true, but the last thing LAIN
    // actually RAN came back non-zero. `✓ DONE` there is the most expensive
    // thing this strip can say: it is the one line a person reads instead of
    // reading the conversation, and it sends them away from a broken tree.
    //
    // Found by driving the real CLI, not by a test: the body already printed
    // "the last check was still failing when that was written" while the strip
    // above it said `✓ LAIN DONE`. The evidence was right and the summary of it
    // was wrong, which is worse than not summarising at all.
    if (lastCheckFailed) {
      const why = `${lastCheckFailed.command}`
        + (lastCheckFailed.exitCode != null ? ` exited ${lastCheckFailed.exitCode}` : ' failed');
      return {
        actor: 'LAIN',
        word: 'NOT VERIFIED',
        detail: [why, ...bits].join(' · '),
        colour: 'warn',
      };
    }
    return { actor: 'LAIN', word: 'DONE', detail: bits.join(' · '), colour: 'ok', tick: true };
  }
  return { actor: 'LAIN', word: 'READY', detail: '', colour: 'meta' };
}

/**
 * The strip, as `rows` lines of exactly `width` cells.
 *
 * @param {object} s      the live state (see liveState) plus `recent` actions
 * @param {number} width
 * @param {number} rows   how many rows the geometry gave us (1..3)
 */
/**
 * WHAT KIND OF FAILURE THIS WAS, in one word and one sentence —.
 *
 * A 502 from a gateway, a refused credential and a model that would not
 * answer are three different problems with three different fixes, and they
 * all used to be drawn as `ERROR — the provider did not answer`. That is the
 * right sentence for one of them and a misdiagnosis for the other two: it
 * sends somebody to check their API key when the network is down.
 *
 * NETWORK is separated deliberately from everything else. It is the failure
 * that is NOT about LAIN, the model, the task or the tools, and the one the
 * user can most often simply wait out.
 */
const FAILURE = Object.freeze({
  UNAVAILABLE: { word: 'NETWORK', say: 'the provider could not be reached' },
  TIMEOUT: { word: 'NETWORK', say: 'the provider did not answer in time' },
  RATE_LIMITED: { word: 'RATE LIMITED', say: 'the provider is refusing for now' },
  AUTH: { word: 'NOT AUTHENTICATED', say: 'the credential was rejected' },
  CONTEXT_LIMIT: { word: 'CONTEXT FULL', say: 'the conversation is too long for this model' },
  BAD_REQUEST: { word: 'MODEL REFUSED', say: 'the provider rejected the request' },
  UNKNOWN: { word: 'ERROR', say: 'the provider did not answer' },
});

/** The failure as a word and a detail line. Accepts a string, for old callers. */
function failureRow(failed) {
  if (typeof failed === 'string') return { word: 'ERROR', detail: failed };
  // TOO MANY MESSAGES IS NOT A FULL WINDOW, and the fix is not the same. The
  // generic sentence — "the conversation is too long for this model" — sends
  // somebody to shorten their prompt when what the provider refused was the
  // NUMBER of messages, which no amount of shortening changes. Naming the cap
  // and the command that acts on it is the difference between a dead session
  // and one keystroke.
  if (failed && failed.kind === 'CONTEXT_LIMIT' && failed.limitKind === 'MESSAGES') {
    const cap = failed.maxMessages ? `${failed.maxMessages}` : 'its';
    return {
      word: 'TOO MANY MESSAGES',
      detail: `the conversation is past this provider's ${cap}-message limit — `
        + '/compact folds the oldest into one summary and keeps what you asked for',
    };
  }
  const f = (failed && FAILURE[failed.kind]) || FAILURE.UNKNOWN;
  // THE STATUS CODE IS THE MOST USEFUL FACT ABOUT A NETWORK FAILURE, and it
  // is the one thing the generic sentence never carried.
  const code = failed && failed.status ? `${failed.status} ` : '';
  // ONE LINE, NOT A JSON BODY. A provider that answers with a whole error
  // object put four wrapped lines of braces into a row that has one, and the
  // useful sentence was buried in the middle of it.
  const raw = String((failed && failed.message) || f.say);
  const why = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
  return { word: f.word, detail: `${code}${why}` };
}

function statusStrip(s = {}, width = 80, rows = 1, now = Date.now()) {
  const w = Math.max(20, width);
  const out = [];
  const st = liveState(s, now);

  // THE TRAIL — the last completed calls of this turn, oldest first, so the eye
  // travels down into the live row. Dropped first when the terminal is short.
  // The actor column, sized once so the trail and the live row line up.
  const full = w >= ACTOR_FULL_WIDTH;
  const col = full ? ACTOR_COL : 5;
  const label = (id) => {
    const a = ACTOR[id] || ACTOR.LAIN;
    return paintActor(id, T.pad(full ? a.id : a.short, col - 1)) + ' ';
  };

  // THE TRAIL BELONGS TO A TURN IN FLIGHT, and it ends when the turn does.
  //
  // no stale text glued to the bottom, and no duplicated
  // state. While work is running these rows are momentum — you can see it
  // moving. Once it has stopped they are a RECORD, and the Context pane above
  // already holds the same calls, in order, with their results. Worse, the last
  // row of a finished turn was often `asking user <question>` — a question
  // that has been answered, still advertised at the bottom of the screen, which
  // is precisely the "PRESS 2 remaining after the question disappeared" example.
  //
  // The rows are still RESERVED (blank) rather than removed, so the workspace
  // does not jump by three lines every time a turn ends.
  const working = Boolean(st.spin);
  const recent = working && Array.isArray(s.recent) ? s.recent : [];
  const trailRows = Math.max(0, rows - 1);
  if (trailRows > 0) {
    for (const a of recent.slice(-trailRows)) {
      const mark = a.ok === false ? P.bad('✗') : P.ok('✓');
      const verb = (VERB[a.name] || 'RAN').toLowerCase();
      const who = a.actor && ACTOR[a.actor] ? a.actor : 'TOOL';
      const line = `  ${mark} ${label(who)}${P.meta(verb)} ${a.target ? P.path(a.target) : P.meta(a.name)}`;
      out.push(T.fit(line, w));
    }
    while (out.length < trailRows) out.unshift(' '.repeat(w));
  }

  // ---- WHAT RIDES ON THE LIVE ROW, AND WHAT NO LONGER DOES ----------------
  //
  // A PROGRESS BAR USED TO BE HERE, and it was the SAME BAR the task banner
  // draws at the top of the workspace — `STEP 3/5 ████░░ 60%` in both places,
  // one fact rendered twice, the two of them competing for the corner where
  // something else needed to be. Two indicators for one measurement is not
  // redundancy, it is a screen that has to be reconciled before it can be read.
  //
  // The banner keeps it: progress belongs beside the objective it measures, and
  // it is stable — it changes when a step completes, which is minutes apart.
  // This row is the one that moves every second, and it now answers the
  // question a person watching a long turn actually has and could not ask
  // anywhere: what is this costing. See `tokens` above.
  //
  // NARROW TERMINALS SHED IT ENTIRELY rather than abbreviating it into
  // something unreadable — the live row's job is to prove LAIN is alive, and
  // that must never be crowded out by an accounting figure.
  const prog = w >= 56 ? tokens(s) : '';
  const spin = st.spin ? SPIN[Math.floor(now / 250) % SPIN.length] : st.tick ? '✓' : '·';
  const paint = P[st.colour] || P.plain;
  const word = paint(st.word);
  const who = label(st.actor || 'LAIN');
  // A multi-part detail is fitted by dropping the least important part, never
  // by clipping the sentence — see the RETRYING branch above.
  let text = st.detail || '';
  if (st.parts) {
    const room = w - 6 - col - st.word.length;
    const join = (list, key) => list.map((p) => p[key] || p.text).join(' · ');
    const shed = (list) => {
      const worst = list.reduce((a, b) => (a.drop < b.drop ? a : b));
      return list.filter((p) => p !== worst);
    };
    // A LADDER, NOT A SWITCH. This used to be "whole sentences, or else
    // abbreviate every one of them", so a single part too many turned
    //
    //   429 · retrying at 09:04:12 · 00:04 remaining · attempt 1/5 · Esc to cancel
    //
    // into `429 · at 09:04 · 00:04 · 1/5 · Esc ✕` — five cryptic fragments with
    // thirty columns still empty beside them. Shedding the LEAST IMPORTANT part
    // and leaving the rest readable is the better trade, so that comes first,
    // down to half of them; below that the abbreviations do say more than two
    // full sentences would, and the old ladder takes over.
    let keep = st.parts.slice();
    const floor = Math.ceil(st.parts.length / 2);
    while (keep.length > floor && join(keep, 'text').length > room) keep = shed(keep);
    let key = 'text';
    if (join(keep, key).length > room) { keep = st.parts.slice(); key = 'short'; }
    while (keep.length > 1 && join(keep, key).length > room) keep = shed(keep);
    text = join(keep, key);
  }
  const detail = st.path ? P.path(text) : P.meta(text);
  // The right-hand column: how far along, then how long this step has taken.
  const rightPlain = [prog, st.age || ''].filter(Boolean).join('  ');
  const right = prog
    ? P.meta(prog) + (st.age ? '  ' + P.meta(st.age) : '')
    : (st.age ? P.meta(st.age) : '');
  const left = `  ${paint(spin)} ${who}${word}${text ? '  ' + detail : ''}`;
  const room = w - rightPlain.length - 2;
  const line = rightPlain
    ? T.pad(T.clip(left, room), room) + '  ' + right
    : T.fit(left, w);
  out.push(T.fit(line, w));
  return out;
}

module.exports = { statusStrip, liveState, failureRow, FAILURE, mmss, clockAt, tok, tokens, VERB, ACTOR_COL, ACTOR_FULL_WIDTH };
