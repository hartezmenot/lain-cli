'use strict';

/**
 * ONE CLOCK FOR THE WHOLE TASK — `00:07:31`, and it means elapsed WORK.
 *
 * ------------------------------------------------------------------------
 * WHAT IT REPLACED, AND WHY THAT WAS WRONG.
 *
 * The live row used to carry `ui.phaseSince` as `12s` — the age of the CURRENT
 * PHASE. So a turn that read four files, thought, wrote two, ran the suite and
 * verified showed six different small numbers in sequence, every one of them
 * starting again at zero, and at no point did the screen answer the question a
 * person watching actually has: HOW LONG HAVE I BEEN WAITING FOR THIS?
 *
 * A phase age is a diagnostic about one step. This is the cost of the task.
 *
 * ------------------------------------------------------------------------
 * THE TWO RULES THAT MAKE IT HONEST:
 *
 *   IT DOES NOT RESET between model calls, tool calls, reads, writes, tests,
 *     verification, or a retry that belongs to the same task. One submission,
 *     one clock, until that task really ends.
 *
 *   IT DOES NOT COUNT TIME LAIN COULD NOT WORK. A provider rate limit, a
 *     retry-after wait, an interruption, a question waiting on the user — the
 *     clock PAUSES and holds its value. Counting four minutes of 429 backoff
 *     as four minutes of work is a lie about what the machine did, and it is
 *     the specific lie that makes an elapsed figure useless for judging
 *     whether something is slow or merely blocked.
 *
 * ------------------------------------------------------------------------
 * IT IS AN ACCUMULATOR, NOT A SUBTRACTION. `elapsed` is
 *
 *     accumulated + (running ? now - since : 0)
 *
 * so the value is a function of WALL TIME and cannot be advanced by drawing a
 * frame. Redrawing twice in one millisecond reads the same number twice; a
 * session that stops redrawing for a minute and starts again has that minute
 * in it, because the minute really passed with work in flight. Nothing here
 * counts ticks, and nothing here can be made to run faster by animating.
 *
 * ------------------------------------------------------------------------
 * WHO DRIVES IT. Exactly one caller, ui/projection.js `clock`, from the SAME
 * `liveState` classification that decides the window-title glyph — so the clock
 * cannot be paused while the screen says RECEIVING, or running while the screen
 * says RATE LIMITED. Start and settle come from the turn lifecycle
 * (ui/turnstate.js `beginTurn` / `endTurn`), which is the only thing that knows
 * a submission happened.
 *
 * ------------------------------------------------------------------------
 * EVERY FUNCTION HERE IS TOTAL. `elapsed(null)` is 0 and `start(null)` is a
 * no-op — a surface assembled without a clock (a test double, a headless
 * projection) must not be able to take down the turn lifecycle over a figure
 * that is decoration.
 */

const STATE = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED',
});

/** A clock that has never been started. */
function create() {
  return { state: STATE.IDLE, accumulated: 0, since: 0, startedAt: 0 };
}

/**
 * THE USER PRESSED ENTER. This is the only thing that zeroes the value.
 *
 * Deliberately unconditional: a second submission is a second task, and a task
 * that inherits the previous one's minutes is reporting someone else's wait.
 */
function start(c, now = Date.now()) {
  if (!c) return c;
  c.state = STATE.RUNNING;
  c.accumulated = 0;
  c.since = now;
  c.startedAt = now;
  return c;
}

/** Work cannot progress. The value is banked and held. */
function pause(c, now = Date.now()) {
  if (!c || c.state !== STATE.RUNNING) return c;
  c.accumulated += Math.max(0, now - c.since);
  c.since = 0;
  c.state = STATE.PAUSED;
  return c;
}

/** Work can progress again. Counting continues FROM THE BANKED VALUE. */
function resume(c, now = Date.now()) {
  if (!c || c.state !== STATE.PAUSED) return c;
  c.since = now;
  c.state = STATE.RUNNING;
  return c;
}

/**
 * The task reached a terminal state. Banks whatever was running and stops.
 *
 * A STOPPED clock keeps its value — `✓ DONE  00:12:08` is the receipt, and a
 * receipt that blanks itself the moment the work finishes answers nothing.
 */
function settle(c, now = Date.now()) {
  if (!c) return c;
  if (c.state === STATE.RUNNING) c.accumulated += Math.max(0, now - c.since);
  c.since = 0;
  c.state = c.state === STATE.IDLE ? STATE.IDLE : STATE.STOPPED;
  return c;
}

/** Elapsed WORK milliseconds. Pure. */
function elapsed(c, now = Date.now()) {
  if (!c) return 0;
  const live = c.state === STATE.RUNNING ? Math.max(0, now - c.since) : 0;
  return Math.max(0, c.accumulated) + live;
}

/**
 * `HH:MM:SS`, always — never `7:31`, never `1h 14m`.
 *
 * ONE SHAPE SO THE COLUMN NEVER MOVES. A figure beside a spinner that changes
 * width as it grows makes the row twitch at four frames a second, and the
 * leading zeroes cost two characters to prevent that. Past a day it keeps
 * counting hours rather than rolling over, because `01:14:09` on the second day
 * of a run would be a false reading.
 */
function hhmmss(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * WHAT THE STRIP IS HANDED: the value, and whether it is still moving.
 *
 * A READING rather than the clock itself, for the reason every other projection
 * is one — a drawing layer holding the live object can reach back and change it,
 * and a redraw must never be able to.
 *
 * DELIBERATELY NOT THE OTHER WORD FOR THIS. There is exactly ONE byte-snapshot
 * system in LAIN — the one `/undo` restores from (src/checkpoint.js) — and an
 * architecture guard enforces that by looking for a second declaration of it.
 * The guard caught this function under its first name, and it was right to: in
 * this tree that word means bytes on disk that can be put back, and a reading
 * off a clock is not that.
 */
function reading(c, now = Date.now()) {
  const ms = elapsed(c, now);
  return {
    ms,
    text: hhmmss(ms),
    state: (c && c.state) || STATE.IDLE,
    running: Boolean(c && c.state === STATE.RUNNING),
    paused: Boolean(c && c.state === STATE.PAUSED),
    // NOTHING TO SHOW YET is different from zero seconds of work. A clock that
    // was never started must not put `00:00:00` beside an idle prompt.
    shown: Boolean(c && c.state !== STATE.IDLE),
  };
}

/**
 * ADVANCE THE CLOCK FROM THE AUTHORITATIVE STATE WORD.
 *
 * `state` is a termtitle STATE — the same five-way classification of the same
 * `liveState` that decides the window-title glyph. See the header.
 *
 * IDLE DOES NOT STOP A RUNNING CLOCK, and that is the whole of the flicker
 * defence §4 asks for. There is a real gap between the user pressing Enter and
 * the turn loop announcing its first phase, and during it `liveState` has
 * nothing to report. Treating that as "the task ended" would stop the clock one
 * frame after starting it, every single turn. Only a TERMINAL word — settled
 * success or a failure — stops it, and so does the turn lifecycle ending.
 */
function apply(c, state, now = Date.now()) {
  if (!c) return c;
  switch (state) {
    case 'working': return resume(c, now);
    case 'paused': return pause(c, now);
    case 'success':
    case 'error': return settle(c, now);
    default: return c;   // idle — see the header
  }
}

module.exports = { STATE, create, start, pause, resume, settle, elapsed, hhmmss, reading, apply };
