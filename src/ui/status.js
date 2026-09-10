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
// THE FIGURES ON THE ROW live next door — see ui/telemetry.js. Re-exported below,
// because /copy and the tests have always imported them from here.
const { tok, tokens, mmss, clockAt } = require('./telemetry');

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
  // `RUNNING npm test` and `RUNNING MCP click` are not the same kind of event,
  // and the second is the one somebody may want to stop.
  computer: 'RUNNING MCP',
  // ---- THE HARNESS TOOLS GET THE WORDS THE HARNESS ALREADY USES --------
  //
  // All four fell through to the generic `RUNNING`, which is the one word
  // that loses what makes them worth watching. `RUNNING npm test` and
  // `RUNNING unit tests pass` are not the same kind of event: the first is a
  // command, the second is LAIN trying to PROVE something, and the harness
  // already distinguishes them (harness/state.js VERIFYING is a task state
  // that only evidence can leave). The strip was the one surface still
  // flattening them.
  //
  // These are not new vocabulary. VERIFYING is what the strip already says
  // for a pending completion, and OBSERVING is the observation router's own
  // word (harness/observation.js) for looking at what is true rather than at
  // what the source says.
  verify_task: 'VERIFYING',
  observe: 'OBSERVING',
  // A SERVICE IS STARTED, NOT RUN. `run_bash` returns when the command ends;
  // this one returns while the thing keeps running, and a person reading the
  // row needs to know something was left alive on their machine.
  service_start: 'STARTING',
  // AND CHECKING ONE IS A QUESTION, not an execution — it is the step that
  // replaced `sleep 5 && hope`.
  service_check: 'CHECKING',
};

/** How much of a provider's own error text a single row will carry. */
const MAX_DETAIL = 160;

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
        // (This used to test the retired `probe` and `desktop` names; `computer`
        // replaced both.)
        const who = phase.tool === 'computer' ? 'MCP' : 'TOOL';
        return { actor: who, word, detail: phase.target || phase.tool || '', colour: 'info', spin: true, age: secs, path: true };
      }
      default: break;
    }
  }
  // ---- AN OPERATION IS THE PRESENT; A RESTING STATE IS THE PAST ---------
  //
  // HERE, AND THE POSITION IS THE WHOLE DESIGN. Everything ABOVE is LAIN working
  // right now - a phase in flight, a wait with a deadline it can name - and an
  // operation must never displace one of those. Everything BELOW is a RESTING
  // state: `INTERRUPTED`, a failure from the turn that just ended, `DONE`,
  // `READY`. Those describe what already happened, and the moment LAIN starts
  // doing something new they stop being the most specific true statement
  // available.
  //
  // IT WAS AT THE BOTTOM FIRST, AND THAT MADE IT USELESS EXACTLY WHERE IT
  // MATTERS. Measured by driving the real binary through a refused credential
  // and then `continue`: the recovery ran, three operations were noted, and not
  // one of them ever reached the screen - because `failed` was still holding the
  // row with the PREVIOUS turn's 401. The one situation the recovery sequence
  // exists for was the one situation it could not be seen in.
  //
  // THE TWO PRESENT-TENSE STATES BELOW KEEP THEIR PRECEDENCE. Waiting on a
  // person and verifying a task are both happening NOW, so they are guarded for
  // explicitly rather than left to the order of the lines.
  if (s.op && s.op.text && !awaitingUser && !pendingCompletion && !steerQueued) {
    return {
      actor: 'LAIN',
      word: s.op.text,
      detail: '',
      colour: s.op.level === 'warn' ? 'warn' : 'meta',
      // NO SPINNER. A note is not work in flight, and a glyph that turns would
      // make the window title claim LAIN was busy - see ui/workclock.js on why
      // nothing decorative may drive a state.
      op: true,
    };
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
 * WHY A TURN STOPPED lives in ui/failure.js — the words, not the drawing. See its
 * header. Re-exported so every existing caller keeps one import.
 */
const { failureRow, FAILURE } = require('./failure');

/**
 * THE STATES THE PAUSE MARK BELONGS TO.
 *
 * READ OFF THE SAME LIST THE WINDOW TITLE USES, not written out again here:
 * src/termtitle.js already decides which words mean "LAIN cannot progress", and
 * two lists would be two chances for the row and the taskbar to disagree about a
 * rate limit. This is that list, asked for once.
 */
/**
 * IN-PROGRESS STATES THAT ARE NOT `info` COLOURED.
 *
 * Most work-in-progress is `info`, but a few states are deliberately `warn`
 * because they are not finished — verification running, a steer queued. Those are
 * still WORK and are SPOKEN: `Verifying the contract` is the same kind of sentence
 * as `Thinking`. What shouts is a VERDICT — DONE, READY, NOT VERIFIED, a failure.
 */
const ACTIVE_WORDS = new Set(['VERIFYING', 'STEERING', 'INTERRUPTING']);

const PAUSED_MARK = (() => {
  try { return require('../termtitle').PAUSED_WORDS; } catch { return new Set(); }
})();

function sentence(word) {
  const w = String(word || '');
  if (!w) return w;
  return w.split(' ').map((part, i) => {
    if (i === 0) return part.charAt(0) + part.slice(1).toLowerCase();
    return acronym(part) ? part : part.toLowerCase();
  }).join(' ');
}

/**
 * IS THIS SHORT CAPITALISED TOKEN AN ACRONYM, or just a shouted word?
 *
 * `WAITING FOR LIMIT RESET` became `Waiting FOR limit reset` under a rule that
 * preserved any all-caps token of three characters or fewer — which is right for
 * `MCP` and wrong for `FOR`. A vowel is the tell: an acronym LAIN's vocabulary
 * chose is a run of consonants (MCP) or digits (429), and an English word that
 * short is almost always a vowel carrier.
 *
 * Conservative on purpose: anything longer than four characters is a word.
 */
function acronym(part) {
  if (part.length > 4 || part !== part.toUpperCase()) return false;
  return !/[AEIOU]/.test(part);
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
      const line = `${mark} ${label(who)}${P.meta(verb)} ${a.target ? P.path(a.target) : P.meta(a.name)}`;
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
  // ---- THE MARK SAYS WHICH OF FIVE THINGS THIS ROW IS -------------------
  //
  // ONE VOCABULARY WITH THE WINDOW TITLE, which is the point: the glyph in the
  // taskbar and the glyph above the caret are the same five symbols for the same
  // five states, so a glance at either answers the same question. See
  // src/termtitle.js, where these are the title's own marks.
  //
  //     ◐ ◓ ◑ ◒   working      the spinner, advanced by the clock
  //     ✓         settled      the turn finished and was accepted
  //     ✕         failed       terminal, and red
  //     Ⅱ         paused       rate limited, interrupted, waiting on you
  //     ›         operation    LAIN's own housekeeping, transient
  //     ·         resting      nothing is happening
  //
  // IT USED TO BE `·` FOR ALL FOUR OF THE LAST ONES, so a rate limit, a failure
  // and an idle prompt opened with the same character and the word alone carried
  // the difference.
  // ---- PAUSED IS CHECKED BEFORE SPIN, because a wait is not work -------
  //
  // The RETRYING state carries `spin: true` - it is alive and counting down -
  // and with spin tested first the row showed a TURNING SPINNER through a rate
  // limit. That is the single most misleading thing this row can say: the
  // provider has refused and nothing is being done, and the screen claims
  // progress. src/termtitle.js already tests PAUSED before spin for exactly this
  // reason, so the row and the taskbar would also have disagreed.
  const paused = PAUSED_MARK.has(String(st.word || '').toUpperCase());
  const spin = st.colour === 'bad' ? '✕'
    : paused ? 'Ⅱ'
      : st.spin ? SPIN[Math.floor(now / 250) % SPIN.length]
        : st.tick ? '✓'
          : st.op ? '›' : '·';
  const paint = P[st.colour] || P.plain;
  /**
   * ---- THE STATE, IN SENTENCE CASE --------------------------------------
   *
   * `THINKING` in capitals is as loud as the user's own prompt and louder than
   * the answer underneath it, for a word that changes every few seconds and is
   * the least durable thing on the screen. Activity must read QUIETER than the
   * conversation: see the hierarchy — final result, then prompt, then activity,
   * then tool detail.
   *
   * VERDICTS KEEP THEIR CAPITALS, because they are not activity. `DONE`,
   * `FAILED`, `RATE LIMITED`, `INTERRUPTED` and the rest are the settled outcome
   * of a turn, they change once, and they are what somebody glances down for.
   * So the rule is by COLOUR, which is already the severity: anything `info` is
   * work in progress and is spoken softly; anything else has something to say.
   */
  // ---- WHICH WORDS ARE SHOUTED, AND WHICH ARE SPOKEN -------------------
  //
  // TRANSIENT states are spoken: `Thinking`, `Receiving`, `Rate limited`,
  // `Interrupted`. They change every few seconds or describe a condition that is
  // about to pass, they are the least durable thing on the screen, and in capitals
  // they were as loud as the user's own prompt.
  //
  // VERDICTS KEEP THEIR CAPITALS: `DONE`, `FAILED`, `NOT VERIFIED`, `READY`. Those
  // change once, they are the settled outcome of a turn, and they are what
  // somebody glances down for — the one thing on this row worth shouting.
  // A FAILURE ALWAYS SHOUTS, whatever its word is. `NETWORK` is on the paused
  // list because a dropped connection is something the TITLE waits through — but
  // when it arrives as the reason a turn ENDED, it is a verdict.
  const quiet = st.colour !== 'bad' && (st.colour === 'info' || st.op || paused
    || ACTIVE_WORDS.has(String(st.word || '').toUpperCase()));
  const word = paint(quiet ? sentence(st.word) : st.word);
  /**
   * ---- WHO, ONLY WHEN IT IS NOT LAIN ---------------------------------------
   *
   * The row read `◐ LAIN     THINKING  waiting for the model` — the product name
   * in the second column of a row inside the product, one line below a header
   * that already says LAIN, competing with the only two things on the row that
   * carry information. One identity is enough.
   *
   * IT IS KEPT FOR EVERY OTHER ACTOR, and that is the whole reason the column
   * exists: `NET`, `TOOL`, `MCP` and `EXTERNAL` answer "who is doing this", and
   * an external model's hypothesis read as LAIN's own finding is the confusion
   * the relay must not create. LAIN is the default and the default needs no
   * label; anything else is news and keeps one.
   */
  // LAIN AND `TOOL` ARE BOTH LAIN. A tool call is LAIN running a tool, so the
  // verb beside it (`Reading`, `Running`) already says what kind of thing it is
  // and the column said nothing the row did not. What stays labelled is every
  // actor that is NOT this program: the network, the desktop bridge, a second
  // model, and the person at the keyboard.
  const actor = st.actor || 'LAIN';
  const who = actor === 'LAIN' || actor === 'TOOL' ? '' : label(actor);
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
  // ---- THE RIGHT-HAND COLUMN: WHAT IT COSTS, AND HOW LONG IT HAS TAKEN --
  //
  // THE CLOCK IS THE TASK'S, NOT THE PHASE'S.
  //
  // This used to be `st.age` — the age of the CURRENT PHASE, from `phaseSince`.
  // So a turn that read four files, thought, wrote two, ran the suite and
  // verified drew six small numbers in sequence, each one starting again at
  // zero, and the screen never once answered how long the person had been
  // waiting. See ui/workclock.js: one `HH:MM:SS` for the whole submission, and
  // it does not count the minutes a rate limit spent refusing us.
  //
  // `st.age` is still carried by `liveState` for callers that want the age of a
  // single step — it is simply no longer what the live row shows.
  const clock = s.clock && s.clock.shown ? s.clock.text : '';
  const rightPlain = [prog, clock].filter(Boolean).join('  ');
  // A PAUSED CLOCK IS DIMMER THAN A RUNNING ONE, so a frozen figure reads as
  // deliberately held rather than as a screen that has stopped updating.
  const paintClock = s.clock && s.clock.paused ? P.warn : P.meta;
  const right = prog
    ? P.meta(prog) + (clock ? '  ' + paintClock(clock) : '')
    : (clock ? paintClock(clock) : '');
  // NO LEADING PAD. The content frame owns the outer margin and the layout draws
  // this region inside it (ui/views.js `contentBounds`), so two columns of our
  // own would be counted twice — and would put the live row out of line with the
  // conversation above it, which is the asymmetry the frame exists to end.
  const left = `${paint(spin)} ${who}${word}${text ? '  ' + detail : ''}`;
  const room = w - rightPlain.length - 2;
  const line = rightPlain
    ? T.pad(T.clip(left, room), room) + '  ' + right
    : T.fit(left, w);
  out.push(T.fit(line, w));
  return out;
}

module.exports = { statusStrip, liveState, failureRow, FAILURE, mmss, clockAt, tok, tokens, VERB, ACTOR_COL, ACTOR_FULL_WIDTH };
