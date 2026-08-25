'use strict';

/**
 * WHAT THE USER SAID, AS SOMETHING YOU CAN NAVIGATE BACK TO.
 *
 * ------------------------------------------------------------------------
 * THREE KINDS OF THING GET TYPED AT A CODING AGENT, and they are not the same:
 *
 *   A MESSAGE    "the runner stops after the third file, find out why"
 *   A DECISION   "proceed"  ·  "yes"  ·  "option B"  ·  "stop"
 *   A REQUEST    four hundred lines of log pasted in
 *
 * All three used to be drawn identically — a block of the user's own text on
 * its own ground — which reads correctly for the first and badly for the other
 * two. A one-word decision is the most consequential thing in a long session
 * and looks like the least; and a paste is one act ("here, look at this") drawn
 * as though the person had said four hundred lines.
 *
 * So the LABEL above the block says which of the three it is. That is the whole
 * of the change: `USER DECISION` over `proceed` is findable when scrolling back
 * through an hour of work, and `USER REQUEST` over `[pasted text #1]` says that
 * the marker stands for something rather than being what was typed.
 *
 * ------------------------------------------------------------------------
 * IT IS AN ANCHOR, NOT A COPY. The block is drawn WHERE THE MESSAGE WAS SAID,
 * in the one feed that is the conversation — there is no second list of
 * decisions to drift out of step with it. Every row of it carries the FULL
 * original text (ui/feed.js `userBlock`), so a click puts the whole message
 * back on the input line even when what is drawn is a marker, and Alt+↑/↓ jumps
 * the feed from one anchor to the next (ui/layout.js `jumpToAnchor`).
 *
 * The compaction of a paste to `[pasted text #N]` belongs to ui/pasted.js and
 * is unchanged; this only names what the block IS.
 */

/**
 * The words that are a decision rather than a message.
 *
 * A closed list, and short: the point is to catch the answer to a question
 * LAIN asked, not to guess at intent. Anything longer than a few words is a
 * message, whatever it contains — "proceed with the second option but keep the
 * old loader around" is instruction, not assent.
 */
const DECISION = new RegExp(
  '^(?:'
  + 'y|n|yes|no|yeah|yep|nope|ok|okay|sure|go|go\\s+ahead|do\\s+it|proceed|continue|carry\\s+on|'
  + 'approved|approve|accept|confirm|confirmed|'
  + 'stop|cancel|abort|halt|undo|revert|retry|again|skip|'
  + 'option\\s+[a-z0-9]|[a-z]|[0-9]{1,2}'
  + ')$', 'i');

/** Words a decision may be padded with without becoming a message. */
const POLITE = /^(?:please|just|now|then|ok|okay|right|thanks|thank\s+you)\b/i;

/** At most this many words, or it is a message. */
const MAX_WORDS = 4;

/**
 * Which of the three this text is.
 *
 * PASTE FIRST, because a paste is decided by bulk and structure (ui/pasted.js)
 * and a four-hundred-line payload could never be mistaken for a decision.
 */
function kindOf(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return 'MESSAGE';
  if (require('./pasted').isPaste(s)) return 'REQUEST';
  let t = s.trim().replace(/[.!,;:]+$/, '');
  // Strip one leading politeness — "please proceed" is still a decision.
  const p = POLITE.exec(t);
  if (p && t.length > p[0].length) t = t.slice(p[0].length).trim().replace(/^[,;:]\s*/, '');
  if (!t) return 'MESSAGE';
  if (t.split(/\s+/).length > MAX_WORDS) return 'MESSAGE';
  return DECISION.test(t) ? 'DECISION' : 'MESSAGE';
}

/** The label drawn above the block. */
function label(text) {
  const k = kindOf(text);
  return k === 'DECISION' ? 'USER DECISION' : k === 'REQUEST' ? 'USER REQUEST' : 'USER';
}

/**
 * WHERE THE ANCHORS ARE in a rendered feed, as row indices.
 *
 * `userAt` maps every drawn row of a user block to its message, so a
 * three-line prompt is three entries. Only the FIRST row of each block is an
 * anchor — jumping to the middle of a message is not jumping to the message.
 */
function rowsIn(lines) {
  if (!lines || !lines.userAt) return [];
  const rows = Object.keys(lines.userAt).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return rows.filter((r, i) => i === 0 || rows[i - 1] !== r - 1);
}

module.exports = { kindOf, label, rowsIn, DECISION, MAX_WORDS };
