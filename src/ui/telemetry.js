'use strict';

/**
 * THE NUMBERS ON THE LIVE ROW — what a turn has cost, and how long until it can go.
 *
 * Split out of ui/status.js when that file reached the god-object guard, on a seam
 * that was already there: everything left in status.js decides WHAT THE ROW SAYS,
 * and this is how its FIGURES are spelled. They change for different reasons — a
 * new state word touches the first and not the second.
 *
 * EVERY ONE OF THESE IS SHORT ON PURPOSE. They share a row with the one sentence
 * that says whether LAIN is alive, and that sentence must never be crowded out by
 * an accounting figure: `42.1K` rather than `42,118`, `00:23` rather than
 * `23 seconds remaining`.
 */

const T = require('./text');
const { P } = require('./paint');

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

module.exports = { tok, tokens, mmss, clockAt };
