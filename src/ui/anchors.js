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

/** How much of a long prompt the anchor shows before it trails off. */
const ANCHOR_MAX = 52;

/**
 * THE PROMPT AS ONE LINE — what the anchor previews.
 *
 * ------------------------------------------------------------------------
 * A PREVIEW IS NOT THE MESSAGE. A submitted prompt can be four paragraphs with a
 * forty-kilobyte paste in the middle of it; the anchor is exactly one row. So the
 * text is flattened for DISPLAY ONLY — and the word display is the whole of it:
 * the turn record, the conversation and what the model received are untouched.
 *
 *   newlines and runs of whitespace  ->  single spaces, so four paragraphs read
 *                                       as one sentence rather than as a row of
 *                                       fragments
 *   terminal control sequences       ->  removed, because a pasted log can carry
 *                                       them and they would move the caret
 *   a big paste                      ->  the marker it already shows in the
 *                                       composer, so the surrounding TYPED text
 *                                       survives instead of being buried
 *
 * WHY THE PASTE MARKER AND NOT THE PASTE. `fix this <40KB of traceback> focus on
 * auth` has two pieces of human intent in it and one wall. Flattening the wall to
 * its marker keeps both pieces; flattening the lot keeps neither.
 *
 * TRUNCATED BY VISIBLE WIDTH, not by `.length`: a double-width glyph takes two
 * columns, and a preview measured by characters is a preview that wraps — which
 * would make the anchor two rows, which it may never be.
 */
function preview(text, width = ANCHOR_MAX) {
  const T = require('./text');
  let t = T.strip(String(text == null ? '' : text));
  // ---- A WALL IS MARKED, NOT QUOTED ------------------------------------
  //
  // When the prompt is a paste, the first line is almost always the person's own
  // sentence and everything after it is the payload. Keeping the line and MARKING
  // the rest preserves the intent; flattening the lot preserves neither the intent
  // nor the payload, and spends the whole row on a stack trace.
  try {
    if (require('./pasted').isPaste(t)) {
      const lines = t.split(/\r?\n/);
      const first = lines.find((l) => l.trim()) || '';
      const rest = lines.slice(lines.indexOf(first) + 1).some((l) => l.trim());
      t = rest ? `${first.trim()} ${require('./composer').PLACEHOLDER}` : first.trim();
    }
  } catch { /* a preview that cannot mark a paste still previews the text */ }
  // NEWLINES AND RUNS OF WHITESPACE COLLAPSE: four paragraphs read as one
  // sentence rather than as a row of fragments.
  t = t.replace(/\s+/g, ' ').trim();
  // TRUNCATED BY VISIBLE WIDTH. `clip` appends the ellipsis itself, so adding one
  // here produced `……` — which is what happens when two layers both own the mark.
  return T.width(t) <= Math.max(8, Math.floor(width)) ? t : T.clip(t, Math.max(8, Math.floor(width)));
}

/**
 * THE SCROLL ANCHOR — `USER · fix the continuation bug…`, or null.
 *
 * ------------------------------------------------------------------------
 * THE PROBLEM IT SOLVES. A turn that runs for ten minutes produces enough rows
 * that the message which STARTED it scrolls off the top, and from then on the
 * screen shows an answer with no question on it. Worse, a person who has scrolled
 * back to read something has no quick way to return to the work in hand.
 *
 * So the top boundary of the conversation carries a compact representation of the
 * most recent thing the user said, and clicking it goes back to the real message.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT A TOOLBAR AND COSTS NO ROWS. It rides on the header's rule, which
 * already exists and already carries the scroll hint on its other end
 * (ui/layout.js `separator`). A permanent panel restating the prompt would be a
 * second copy of the conversation's own content, which is the duplication the
 * one-surface architecture exists to refuse.
 *
 * IT DOES NOT COMPETE WITH THE MESSAGE ITSELF. `null` while the block is on
 * screen — there is nothing to anchor to when you are looking at it.
 *
 * ------------------------------------------------------------------------
 * THE TARGET IS A ROW THE FEED ITSELF RECORDED, not a text search. `userAt` is
 * the side-channel `renderFeed` writes as it draws: drawn-line index to the
 * message that produced it. So the row this returns is a row the user really
 * saw, the label is that message's own text rather than something reconstructed
 * from painted output, and the two cannot disagree — they come from one index.
 * A search through the rendered lines for a prompt's words would find the wrong
 * one the moment a model quoted the user back at itself.
 */
function scrollAnchor(lines, scroll = 0, height = 0) {
  const rows = rowsIn(lines);
  if (!rows.length) return null;
  const row = rows[rows.length - 1];
  // ---- ALREADY IN VIEW: THERE IS NOTHING TO ANCHOR TO -------------------
  //
  // THE WINDOW, not just its top edge. The first version asked only whether the
  // row was above `scroll`, which is the wrong half for the row this cares
  // about: the NEWEST message is at the END of the feed, so it leaves the
  // viewport by falling off the BOTTOM when somebody scrolls back — it is never
  // above the top. Measured against the real Screen, that test returned null at
  // every scroll position and the anchor never appeared once.
  //
  // With no height given, nothing is assumed to be off-screen — a caller that
  // does not know its viewport cannot be told what is outside it.
  const rowsShown = Math.max(0, Math.floor(height));
  if (!rowsShown) return null;
  if (row >= scroll && row < scroll + rowsShown) return null;
  const text = String((lines.userAt && lines.userAt[row]) || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const kind = label(text);
  const body = preview(text, ANCHOR_MAX);
  // ---- THE MARK IS NAVIGATION, NOT CONTENT -----------------------------
  //
  // `USER DECISION · continue` on the header's rule read as a SECOND HEADER: a
  // label and a quotation, in the most prominent position on the screen, for
  // something whose only job is to be clickable. The submitted turn is in the
  // conversation; this is a way back to it.
  //
  // So what is drawn is `↑ user` — a direction and a word. The full text and the
  // kind still travel on the object for anything that wants them (a tooltip, a
  // test, a future surface); they are simply not what the rule says.
  // ---- THE MARK CARRIES THE REAL PROMPT --------------------------------
  //
  // It was `↑ user` — a direction and a word, which is de-emphasised to the point
  // of saying nothing: a person looking at it cannot tell WHICH turn it goes back
  // to, and on a long session that is the only thing they need from it.
  //
  // `USER · continue with the Toralink smoke test…` is one line, on its own quiet
  // ground, and it is the SUBMITTED TEXT — not the task name, not the objective,
  // not a model-written summary, not the current plan step. Those can all drift
  // from what was actually asked, and an anchor that lies about its destination is
  // worse than no anchor.
  return { row, kind, text, mark: `USER · ${body}`, label: `${kind} · ${body}` };
}

module.exports = { kindOf, label, rowsIn, scrollAnchor, preview, DECISION, MAX_WORDS, ANCHOR_MAX };
