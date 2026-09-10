'use strict';

/**
 * THE HORIZONTAL FRAME — its own module, because everything consumes it.
 *
 * ui/geometry.js divides the terminal's ROWS; this divides its COLUMNS. They are
 * the same concern and would sit together, except that geometry.js reaches for
 * ui/inputbox.js to ask how tall a prompt is, and inputbox.js reads this — so a
 * shared home would be a require cycle, and a cycle that hands a half-built
 * module to whichever file got there first.
 *
 * So it lives alone, depends on nothing, and is re-exported by ui/views.js for
 * every caller that already imports that.
 */

/**
 * THE ONE CONTENT FRAME — every primary region is laid out inside this rectangle.
 *
 * ------------------------------------------------------------------------
 * WHAT WAS WRONG, AND IT WAS VISIBLE IN A SCREENSHOT. The left and right
 * whitespace did not match. The feed carried a two-column indent of its own and
 * was drawn at column 1; the live row had a different one; the composer had a
 * third; the command menu had none at all and spanned the whole terminal. Four
 * renderers each deciding their own horizontal margins is four chances for them
 * to disagree, and they did.
 *
 * SO THERE IS ONE ANSWER AND EVERY REGION READS IT. The gutters are SYMMETRIC by
 * construction — `left` and `right` are the same number, computed once — and the
 * layout positions every region at `1 + left` and renders it at `width`. A region
 * cannot drift, because no region is allowed to work out where it starts.
 *
 *     cols
 *       └─ gutter ─┬──────────── width ────────────┬─ gutter ─┘
 *                  │  conversation                 │
 *                  │  live activity                │
 *                  │  composer (grey fill)         │
 *                  │  command menu (no wider)      │
 *
 * ------------------------------------------------------------------------
 * RESPONSIVE, AND RESTRAINED. A fixed margin that looks right at 80 columns is
 * mean at 200 and ruinous at 40, so it scales — but gently, because the gutter is
 * breathing room and not a design feature:
 *
 *     under 48 columns    1    fitting the words in outranks the margin
 *     48 to 99            2
 *     100 to 159          3
 *     160 and wider       4
 *
 * NEVER ASYMMETRIC, at any width, odd or even: both gutters are the same value,
 * so the content rectangle is centred by arithmetic rather than by adjustment.
 */
const GUTTERS = Object.freeze([
  [48, 1],
  [100, 2],
  [160, 3],
]);

/** The widest gutter, for a terminal wider than every threshold. */
const GUTTER_MAX = 4;

/** Content narrower than this is not worth a margin. */
const MIN_CONTENT = 12;

function contentBounds(cols) {
  const w = Math.max(MIN_CONTENT, Math.floor(Number(cols) || 80));
  let g = GUTTER_MAX;
  for (const [upTo, val] of GUTTERS) {
    if (w < upTo) { g = val; break; }
  }
  // A GUTTER MAY NEVER EAT THE CONTENT. On a terminal too narrow to afford the
  // one its width asks for, it shrinks — symmetrically, which is the invariant.
  const room = Math.floor((w - MIN_CONTENT) / 2);
  const gut = Math.max(0, Math.min(g, room));
  return { left: gut, right: gut, width: w - gut * 2, cols: w };
}

/**
 * HOW WIDE PROSE MAY BE — narrower than the frame on a very wide terminal.
 *
 * A paragraph stretched across two hundred columns is measurably harder to read
 * than the same paragraph at ninety, and on a modern desktop terminal the frame
 * alone is not enough to prevent it. So PROSE gets a measure and everything
 * STRUCTURED does not: a table, a diff hunk, an ASCII diagram and a line of code
 * mean something by their width, and squeezing them into a reading measure breaks
 * the thing the width was carrying.
 *
 * IT SCALES MILDLY rather than clamping to a number. A hard 80 would waste half
 * of a 200-column terminal and would be the arbitrary cap this is meant to avoid;
 * growing with the square root of the excess keeps a wide terminal feeling wide
 * while stopping the line length running away:
 *
 *     80 cols   ->  76     the frame, untouched
 *     120       ->  116    still the frame
 *     160       ->  138
 *     200       ->  146
 *     280       ->  158
 *
 * Below the measure it is simply the frame, so nothing changes for the terminal
 * sizes most work happens in.
 */
const PROSE_SOFT = 120;

function proseWidth(width) {
  const w = Math.max(MIN_CONTENT, Math.floor(Number(width) || 80));
  if (w <= PROSE_SOFT) return w;
  return Math.min(w, PROSE_SOFT + Math.round(Math.sqrt(w - PROSE_SOFT) * 4));
}

module.exports = { contentBounds, proseWidth, GUTTER_MAX, PROSE_SOFT, MIN_CONTENT };
