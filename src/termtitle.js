'use strict';

/**
 * THE TERMINAL TAB TITLE.
 *
 * ------------------------------------------------------------------------
 * WHAT THE TITLE SAYS, AND WHY IT IS A SYMBOL RATHER THAN A WORD.
 *
 * A window title is read out of the corner of an eye, from ANOTHER window,
 * usually in a taskbar that truncates it. The two things worth knowing there
 * are WHICH PROJECT and WHETHER IT IS STILL GOING. The detailed state — what
 * is being read, what is being verified — is a sentence, and a sentence belongs
 * on the live row above the caret where there is room for it.
 *
 *     lain-v2        nothing is happening
 *     SPIN lain-v2   work is in flight; the glyph turns while it lasts
 *     TICK lain-v2   the last thing finished, and did so cleanly
 *     PAUSE lain-v2  stopped: interrupted, rate limited, blocked, waiting
 *     CROSS lain-v2  it failed
 *
 * FIVE STATES, ONE PROJECTION, ONE PRECEDENCE. Every one of them is derived
 * from ui/status.js `liveState` — the same function the status row is drawn
 * from — so the title and the screen cannot disagree about what is happening.
 * Nothing else in the program is allowed to set a title.
 *
 * ------------------------------------------------------------------------
 * THE SPINNER TURNS; IT DOES NOT DECIDE.
 *
 * The frame is `Date.now()` over a fixed period, so a redraw picks the glyph up
 * where the last one left it. That is the whole of the animation: there is no
 * timer in this file driving it, and no state anywhere that says "still
 * working" because a spinner is mid-cycle. It advances only because a redraw
 * happened, and redraws happen while the turn loop has a phase — which is the
 * authoritative fact. The moment that stops, the next redraw writes a title
 * with no glyph in it at all.
 *
 * RATE LIMITING IS NOT WORK. A retry wait has `spin: true` in the live state,
 * because on the status row it is genuinely a live countdown you can watch. In
 * a title it is not: a glyph spinning for four hours while the provider refuses
 * every request is the single most misleading thing this could show. So PAUSED
 * is tested BEFORE working, and a rate limit gets the pause glyph.
 *
 * ------------------------------------------------------------------------
 * THE PRODUCT NAME IS NOT IN IT, at the user's explicit instruction.
 *
 * This module has argued both sides. It originally dropped V1's `LAIN:` prefix
 * on the grounds that four tabs all saying LAIN spends the readable part of a
 * tab on something the user already knows; it was asked to put it back, twice,
 * and did; it is now asked to remove it again. The reasoning that settles it is
 * the same one the whole surface follows — which program is running is answered
 * by looking at the window. The name survives in exactly one place: a session
 * with no project at all, where the title would otherwise be empty.
 *
 * MECHANICS. OSC 0 sets the icon name AND the window title, OSC 2 sets the
 * window title only. Both are sent, because terminals disagree about which one
 * a TAB reads — Windows Terminal follows OSC 0/2 on the active pane, most
 * xterm-alikes read OSC 2. The terminator is BEL rather than ST: it is the form
 * every terminal in circulation accepts. Neither sequence moves the cursor or
 * consumes a cell, so writing one mid-frame cannot disturb the drawn UI.
 *
 * This is a side effect on someone else's window, so it is written only to a
 * real TTY, never under a dumb TERM, and `restore()` hands the tab back on the
 * way out. Nothing here throws: a terminal that ignores the sequence prints
 * nothing, and a stdout that rejects the write is not worth ending a session
 * over.
 */

let installed = false;
let last = '';
let writer = null;

/** Let the terminal UI route OSC around its own stdout capture layer. */
function setWriter(fn = null) { writer = typeof fn === 'function' ? fn : null; }

function write(s) {
  const out = writer || ((text) => process.stdout.write(text));
  out(s);
}

function enabled() {
  // LAIN_FORCE_TUI runs the real draw path over a pipe so the suite can assert
  // on what the real binary actually emits. The title is part of that: without
  // this, the one thing a test could check about it was that a pure function
  // composed a string, which is not the same as the bytes reaching a terminal.
  if (!process.stdout || (!process.stdout.isTTY && process.env.LAIN_FORCE_TUI !== '1')) return false;
  if (process.env.LAIN_NO_TITLE) return false;
  if (String(process.env.TERM || '').toLowerCase() === 'dumb') return false;
  return true;
}

/** Collapse whitespace, drop control characters, clip to a tab's worth. */
function clean(s, max = 72) {
  const t = String(s == null ? '' : s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * THE FIVE TITLE STATES. One vocabulary, so a caller cannot invent a sixth.
 */
const STATE = Object.freeze({
  IDLE: 'idle',
  WORKING: 'working',
  SUCCESS: 'success',
  PAUSED: 'paused',
  ERROR: 'error',
});

/**
 * The glyphs.
 *
 * CHOSEN FOR WINDOWS TERMINAL AND CONHOST, which is where this actually runs.
 * The spinner is the same four-glyph cycle ui/status.js uses on the live row,
 * so the two indicators move together rather than at different rates.
 *
 * PAUSE IS `Ⅱ` (U+2161, ROMAN NUMERAL TWO) rather than `⏸` (U+23F8). The second
 * is the more obviously correct character and the wrong one to use: it is in an
 * emoji block, so a terminal that has an emoji font renders it double-width and
 * one that does not renders a replacement box. The Roman numeral is a plain BMP
 * glyph present in every console font in circulation and reads as a pause bar.
 */
const SPIN = ['◐', '◓', '◑', '◒'];
const SPIN_MS = 250;
const TICK = '✓';
const PAUSE = 'Ⅱ';
const CROSS = '✕';

/** How long the success glyph holds before the title goes quiet again. */
const SUCCESS_MS = 4000;

/**
 * STATES IN WHICH LAIN IS STOPPED RATHER THAN WORKING.
 *
 * Written out rather than derived from the live row's colour, because `warn`
 * covers both "stopped" and several things that are neither — and a title that
 * showed a pause bar for a queued steer would be saying the session had halted
 * when it had not.
 *
 * `ASKING USER` and `WAITING FOR YOU` are here for the reason they are the most
 * important of the lot: they are the only states that will not clear on their
 * own. Everything else resolves eventually; these two wait for a person, and a
 * person looking at a taskbar is exactly who needs to be told.
 */
const PAUSED_WORDS = new Set([
  'WAITING FOR LIMIT RESET', 'RATE LIMITED', 'RETRYING', 'NETWORK',
  'INTERRUPTING', 'INTERRUPTED', 'RETRY CANCELLED',
  'STOPPED', 'STEP LIMIT', 'BLOCKED',
  'WAITING FOR YOU', 'ASKING USER',
]);

/**
 * Classify the live row's state into one of the five, in PRECEDENCE ORDER.
 *
 *     ERROR  >  PAUSED  >  WORKING  >  SUCCESS  >  IDLE
 *
 * ONE PROJECTION, so nothing else can overwrite the title behind it and no two
 * events can fight over the same window. `liveState` has already resolved the
 * competing facts into a single answer; this only decides which glyph that
 * answer deserves.
 *
 * @param {object} live  the result of ui/status.js `liveState`
 */
function stateOf(live) {
  if (!live || !live.word) return STATE.IDLE;
  const word = String(live.word).toUpperCase();
  // A GENUINE FAILURE. `bad` is the live row's own colour for the states that
  // are over and went wrong — ERROR, FAILED, NOT AUTHENTICATED, CONTEXT FULL.
  if (live.colour === 'bad') return STATE.ERROR;
  // STOPPED, INCLUDING A RATE LIMIT — checked before `spin`, see the header.
  if (PAUSED_WORDS.has(word)) return STATE.PAUSED;
  if (live.spin) return STATE.WORKING;
  // SUCCESS IS THE TURN RECORD SAYING SO, never "output stopped arriving".
  // `tick` is set on exactly one branch of liveState: a turn that ended with
  // `stopReason === 'end'` and no failing check behind it.
  if (live.tick) return STATE.SUCCESS;
  return STATE.IDLE;
}

/** The glyph for a state, at this moment. '' for idle. */
function glyph(state, now = Date.now()) {
  if (state === STATE.WORKING) return SPIN[Math.floor(now / SPIN_MS) % SPIN.length];
  if (state === STATE.SUCCESS) return TICK;
  if (state === STATE.PAUSED) return PAUSE;
  if (state === STATE.ERROR) return CROSS;
  return '';
}

/**
 * Compose the title.
 *
 *   lain-v2      idle
 *   ◐ lain-v2    working
 *   ✓ lain-v2    the last turn finished cleanly
 *   Ⅱ lain-v2    stopped — interrupted, rate limited, blocked, waiting on you
 *   ✕ lain-v2    it failed
 *   LAIN         no project at all; the one place the name still appears
 */
function compose({ folder = '', state = STATE.IDLE, now = Date.now() } = {}) {
  const name = clean(folder, 28) || 'LAIN';
  const g = glyph(state, now);
  return g ? `${g} ${name}` : name;
}

/** Write a title. Identical repeats are dropped — this runs on every redraw. */
function set(text) {
  const title = clean(text, 100);
  if (!title || title === last) return false;
  if (!enabled()) { last = title; return false; }
  try {
    write(`\x1b]0;${title}\x07\x1b]2;${title}\x07`);
    installed = true;
    last = title;
    return true;
  } catch { return false; }
}

/**
 * compose + set, plus the ONE thing the title does that the screen does not:
 * it lets a success go quiet by itself.
 *
 * ------------------------------------------------------------------------
 * WHY THE TICK NEEDS A TIMER AND THE SPINNER DOES NOT.
 *
 * The spinner advances because REDRAWS happen, and redraws happen while the
 * turn loop has a phase. When the turn ends, the redraws stop — which is
 * exactly right for the spinner (it disappears) and leaves `✓` on the window
 * for the rest of the session, because nothing is left to come along and
 * replace it.
 *
 * So SUCCESS, alone among the five, arms a single shot: write the tick now,
 * and if nothing has happened by `SUCCESS_MS`, write the folder on its own.
 * One `setTimeout`, unref'd, replaced rather than stacked, and cancelled the
 * moment any other state arrives — a person who starts typing again gets the
 * new state, not a stale tick being cleaned up behind them.
 *
 * IT IS NOT A POLL. It fires once, it fires only after a success, and the
 * thing it writes is a fact that is already true (the work finished; nothing
 * is happening now). Nothing about the underlying state is decided here.
 */
let successTimer = null;

function update(parts = {}) {
  if (successTimer) { clearTimeout(successTimer); successTimer = null; }
  const written = set(compose(parts));
  if (parts.state === STATE.SUCCESS) {
    const folder = parts.folder;
    successTimer = setTimeout(() => {
      successTimer = null;
      // Composed fresh rather than remembered: `set` drops an identical repeat,
      // so if something else has since written the same idle title this costs
      // nothing at all.
      try { set(compose({ folder, state: STATE.IDLE })); } catch { /* chrome */ }
    }, SUCCESS_MS);
    if (successTimer.unref) successTimer.unref();
  }
  return written;
}

/**
 * Hand the tab back.
 *
 * There is no reliable "restore the previous title" sequence — XTPOPTITLE is
 * not universal, and pushing a title we never popped leaks stack entries — so
 * the honest close is to clear ours and let the shell re-title on its next
 * prompt.
 */
function restore() {
  // A PENDING TICK MUST NOT WRITE ONTO A TAB WE HAVE ALREADY HANDED BACK.
  if (successTimer) { clearTimeout(successTimer); successTimer = null; }
  if (!installed) return false;
  try {
    write('\x1b]0;\x07\x1b]2;\x07');
    installed = false;
    last = '';
    return true;
  } catch { return false; }
}

module.exports = { set, update, compose, stateOf, glyph, clean, restore, enabled, setWriter, STATE, SPIN, SPIN_MS, TICK, PAUSE, CROSS, SUCCESS_MS, PAUSED_WORDS };
