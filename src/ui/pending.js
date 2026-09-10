'use strict';

/**
 * PENDING USER INPUT — what you said while LAIN was still working.
 *
 *     ┌ CONTEXT ────────────────┐
 *     │ LAIN  reading render.js │
 *     ├ PENDING USER INPUT ─────┤
 *     │ > also check the backend│
 *     ├ INPUT ──────────────────┤
 *     │ > _                     │
 *     └─────────────────────────┘
 *
 * . Typing at a working LAIN used to mean one of two bad things:
 * interrupt it and lose the step in flight, or wait — and the text you typed
 * meanwhile queued up as a WHOLE NEW TASK that started once the current one
 * ended, which is almost never what "also check the backend" meant.
 *
 * WHY IT IS A REGION AND NOT A LINE IN THE CONVERSATION. It has not happened
 * yet. Putting it in Context would claim the model has been told, and the model
 * has not — it is mid-step, and interrupting a tool call to inject a sentence is
 * the unsafe thing this exists to avoid. So it sits in its own place, visibly
 * WAITING, and moves into Context as an ordinary user message at the first
 * moment the turn can take it (turn.js drains between steps, before it builds
 * the next request).
 *
 * ORDER IS PRESERVED and nothing is merged: two sentences typed a minute apart
 * are two messages, in the order they were typed. Merging them would put words
 * in somebody's mouth.
 *
 * IT COSTS NOTHING WHEN EMPTY. No pending text, no rows — the region does not
 * reserve space against the conversation for something that is not there.
 */

const T = require('./text');
const { P } = require('./paint');

/** At most this many are drawn; the rest are counted. */
const MAX_SHOWN = 3;

/**
 * The pending list as `{ text, now }`, however the snapshot carries it.
 *
 * TOLERANT OF BOTH SHAPES. The queue used to hold bare strings and now holds
 * `{ text, mode }`; a plain `String(entry)` over the new shape would render
 * `[object Object]` into the region — the kind of break that reaches a
 * screenshot before it reaches a test. A resumed session, or any caller that
 * has not moved, can still hand it strings.
 */
function itemsOf(state) {
  const raw = (state && state.pending) || [];
  return raw
    .map((s) => (s && typeof s === 'object'
      ? { text: String(s.text || '').trim(), now: s.mode === 'NOW' }
      : { text: String(s || '').trim(), now: false }))
    .filter((s) => s.text);
}

/**
 * THE WHOLE SHAPE IN ONE PLACE: how many lines are drawn, how many are only
 * counted, and how many rows that adds up to.
 *
 * It is one function because the three answers have to agree. Computed apart,
 * `rows` asked for three on a two-row terminal — the count line was left out
 * of the arithmetic and included in the drawing — and a region that asks for
 * more rows than it was given is drawn over whatever is beneath it.
 *
 * `room` bounds it, because the conversation is the surface everything else
 * exists to serve: on a short terminal a long queue is summarised rather than
 * drawn, and below two rows it is not drawn at all — the input box is still
 * showing what you typed, so nothing is lost by standing down.
 */
function plan(state, room = 99) {
  const items = itemsOf(state);
  if (!items.length || room < 2) return { shown: 0, hidden: 0, rows: 0 };
  let shown = Math.min(items.length, MAX_SHOWN, room - 1);
  // A count line is needed the moment anything is left out, and it needs a row
  // of its own — so making space for it can cost one of the lines it counts.
  if (items.length > shown && 1 + shown + 1 > room) shown = room - 2;
  if (shown < 1) return { shown: 0, hidden: 0, rows: 0 };
  const hidden = items.length - shown;
  return { shown, hidden, rows: 1 + shown + (hidden > 0 ? 1 : 0) };
}

/** How many rows the region wants. Zero when nothing is waiting. */
function rows(state, room = 99) { return plan(state, room).rows; }

/** How many of them a given height can actually show. */
function shownCount(state, height) { return plan(state, height).shown; }

/**
 * The region as exactly `height` lines of `width` cells.
 *
 * A WAITING MARKER ON EVERY LINE, not just the first. Three queued sentences
 * with one marker read as one three-line sentence, and the difference between
 * one steer and three is the difference between what you meant and what the
 * model gets.
 */
function draw(state, width = 80, height = 0) {
  if (height <= 0) return [];
  const out = [];
  const items = itemsOf(state);
  const shown = shownCount(state, height);
  // WHAT THE HEADING PROMISES DEPENDS ON WHEN IT WILL BE DELIVERED. "Pending"
  // over something that is about to land at the next step is the wrong word,
  // and the difference is the whole reason the second Enter exists.
  const anyNow = items.some((s) => s.now);
  // A LABEL, NOT A RULE — see ui/jobsview.js for why the surface keeps exactly
  // one horizontal line and it belongs to the header.
  const label = anyNow ? 'Steering now' : 'Waiting to send';
  out.push(T.fit(P.meta(label), width));
  for (let i = 0; i < shown; i++) {
    // The text is the USER's, painted as the user — it is not LAIN speaking and
    // it is not something that has happened.
    //
    // The marker says WHICH of the two it is, per line, because promoting takes
    // everything waiting and a mixed list would otherwise be unreadable:
    //   ▸ waiting for the work in flight to finish
    //   ⚑ going to the model at the next step
    const marker = items[i].now ? P.warn('⚑ ') : P.meta('▸ ');
    out.push(T.fit('  ' + marker + T.clip(items[i].text, Math.max(4, width - 4)), width));
  }
  const hidden = items.length - shown;
  if (hidden > 0 && out.length < height) {
    out.push(T.fit('  ' + P.meta(`… and ${hidden} more waiting`), width));
  }
  while (out.length < height) out.push(T.fit('', width));
  return out.slice(0, height);
}

module.exports = { rows, draw, itemsOf, shownCount, plan, MAX_SHOWN };
