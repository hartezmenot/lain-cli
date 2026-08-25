'use strict';

/**
 * WHAT IS RUNNING THAT YOU ARE NOT LOOKING AT — one compact region.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS A REGION AND NOT PROSE IN THE FEED.
 *
 * A background job produces exactly what a foreground one does: reads,
 * searches, commands, edits. Putting that in the ACTIVITY feed would double the
 * stream a person is trying to read and interleave two accounts with no way to
 * tell which sentence belonged to which piece of work. And it would keep
 * moving: the feed scrolls, so "what is #2 doing" would be a question you
 * answer by scrolling to find out where it got to.
 *
 * So a job's *account* stays in its own session and its *status* gets one row,
 * in a fixed place, above the input — beside the pending-steer region, which is
 * the same idea for the same reason and is drawn by the same mechanism
 * (ui/pending.js). One row per job, the newest at the bottom, nothing that
 * moves except the words on it.
 *
 * ------------------------------------------------------------------------
 * IT NEVER TOUCHES THE INPUT LINE. The region is composed into the frame like
 * every other region; the input box is drawn after it and the caret is parked
 * last (ui/layout.js). A job finishing while you are half way through typing
 * changes one row three lines up and nothing else — no scrollback, no reflow of
 * what you have typed, and no redraw of anything that did not change, because
 * an identical frame is never written.
 *
 * ------------------------------------------------------------------------
 * THE PRIMARY JOB IS NOT LISTED. It is the conversation: the header says what
 * it is doing, the status strip says how long, and the feed IS its output.
 * Repeating it here would be a fourth copy of the one thing already hardest to
 * miss. Only work you are NOT looking at earns a row.
 *
 * FINISHED JOBS LINGER, BRIEFLY. A job that completes while you are reading
 * something else has to be able to say so — but a permanent row for finished
 * work would turn the region into a log. It holds for `KEEP_DONE_MS` and goes.
 * `/jobs` still has all of it.
 */

const T = require('./text');
const { P } = require('./paint');

/** How many job rows the region will ever draw. Past this it counts. */
const MAX_SHOWN = 4;
/** How long a finished job keeps its row so its ending can be seen. */
const KEEP_DONE_MS = 20_000;

/** The jobs worth a row: background work, plus anything that just ended. */
function itemsOf(state, now = Date.now()) {
  const all = (state && state.jobs) || [];
  return all.filter((j) => {
    if (!j || j.primary) return false;               // the conversation is not a row
    if (!j.endedAt) return true;                     // still going
    return now - j.endedAt < KEEP_DONE_MS;           // just ended, briefly
  });
}

/**
 * THE WHOLE SHAPE IN ONE PLACE: how many rows are drawn, how many are only
 * counted, and what that adds up to.
 *
 * One function because the three answers have to agree — the same argument
 * ui/pending.js makes, and the same failure if they are computed apart: a
 * region that asks for more rows than it draws is drawn over whatever is
 * beneath it.
 */
function plan(state, room = 99, now = Date.now()) {
  const items = itemsOf(state, now);
  if (!items.length || room < 2) return { shown: 0, hidden: 0, rows: 0 };
  let shown = Math.min(items.length, MAX_SHOWN, room - 1);
  if (items.length > shown && 1 + shown + 1 > room) shown = room - 2;
  if (shown < 1) return { shown: 0, hidden: 0, rows: 0 };
  const hidden = items.length - shown;
  // A PARKED JOB COSTS A SECOND ROW for its question. Counted here rather than
  // discovered while drawing: a region that draws more rows than it reserved is
  // a region drawn over whatever is beneath it. See ui/pending.js on why the
  // count and the draw must be one function.
  const asking = items.slice(-shown).filter((j) => j.needsInput && j.question).length;
  const want = 1 + shown + asking + (hidden > 0 ? 1 : 0);
  return { shown, hidden, rows: Math.min(want, Math.max(0, room)) };
}

/** How many rows the region wants. Zero when nothing is running. */
function rows(state, room = 99, now = Date.now()) { return plan(state, room, now).rows; }

function secs(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** One job, as one row: what it is, what state, and what it is doing now. */
function line(j, width) {
  // NEEDS INPUT IS THE LOUDEST NON-FAILURE STATE, because it is the only one
  // that will not clear on its own. A job merely waiting on a slow tool needs
  // nothing from anybody; this one is stopped until somebody answers.
  const mark = j.state === 'SUCCEEDED' ? P.ok('✓')
    : j.state === 'FAILED' ? P.bad('✗')
      : j.state === 'CANCELLED' ? P.meta('■')
        : j.needsInput ? P.warn('?') : j.waiting ? P.warn('◒') : P.info('●');
  const state = j.state === 'SUCCEEDED' ? P.ok('COMPLETED')
    : j.state === 'FAILED' ? P.bad('FAILED')
      : j.state === 'CANCELLED' ? P.meta('CANCELLED')
        : j.needsInput ? P.warn('NEEDS INPUT') : j.waiting ? P.warn('WAITING') : P.info('RUNNING');
  const head = `  ${mark} ${P.meta('#' + j.id)} `;
  // The request is what it IS; the activity is what it is doing about it. The
  // second only earns room once the first has had enough.
  const room = Math.max(10, width - 34);
  const what = T.clip(String(j.request || '').replace(/\s+/g, ' '), Math.max(8, Math.floor(room * 0.55)));
  const doing = j.done ? (j.error || '') : String(j.activity || '');
  const tail = doing ? P.meta('  ' + T.clip(doing.replace(/\s+/g, ' '), Math.max(6, room - what.length))) : '';
  return T.fit(`${head}${state}  ${P.plain(what)}${tail}  ${P.meta(secs(j.elapsedMs))}`, width);
}

/**
 * The region as exactly `height` rows of `width` cells.
 *
 * Padded to the height it was given, because a region that returns fewer rows
 * than the layout reserved leaves whatever was there before showing through.
 */
function draw(state, width = 80, height = 0, now = Date.now()) {
  if (height <= 0) return [];
  const { shown, hidden } = plan(state, height, now);
  if (!shown) return new Array(height).fill(T.fit('', width));
  const items = itemsOf(state, now);
  const label = ' BACKGROUND ';
  const out = [T.fit(P.meta('─'.repeat(2) + label + '─'.repeat(Math.max(0, width - 2 - label.length))), width)];
  // NEWEST LAST, so a job that has just started appears next to the input where
  // the eye already is, and the list does not reorder itself as jobs finish.
  for (const j of items.slice(-shown)) {
    out.push(line(j, width));
    // THE QUESTION GETS ITS OWN ROW when there is one. A row that says a job is
    // blocked without saying what on is a row that sends you to another command
    // to find out — and this region exists so a glance is enough.
    if (j.needsInput && j.question && out.length < height) {
      out.push(T.fit(P.meta('       ') + P.plain(T.clip(String(j.question), Math.max(10, width - 10))), width));
    }
  }
  if (hidden > 0) out.push(T.fit(P.meta(`    … and ${hidden} more · /jobs`), width));
  while (out.length < height) out.push(T.fit('', width));
  return out.slice(0, height);
}

module.exports = { rows, draw, plan, itemsOf, line, MAX_SHOWN, KEEP_DONE_MS };
