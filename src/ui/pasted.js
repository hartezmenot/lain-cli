'use strict';

/**
 * A PASTE IS AN ATTACHMENT, NOT A SPEECH.
 *
 * Someone pastes a 400-line stack trace, a config file, or a whole error log
 * into the prompt. It is one act — "here, look at this" — and the feed rendered
 * every line of it as though the person had said it, so a single paste buried
 * the entire conversation above it and pushed the model's answer off the screen.
 * The activity stream stopped being readable at exactly the moment it carried
 * the most information.
 *
 * So the VISIBLE representation of a paste is a marker:
 *
 *     [pasted text #1]
 *
 * and the numbers run in the order the pastes arrived, so two of them can be
 * told apart and referred to.
 *
 * ------------------------------------------------------------------------
 * THE PAYLOAD IS NOT LOST, AND THAT IS THE WHOLE DESIGN.
 *
 * This changes what is DRAWN and nothing else. The full text is still in
 * `session.messages`, still on the wire to the model, still carried on every
 * rendered row as `source` (see ui/feed.js) so a click can bring it back, and
 * still what `/copy` copies. A marker that also discarded the content would be
 * a data-loss bug wearing a tidiness argument.
 *
 * ------------------------------------------------------------------------
 * NUMBERING IS STABLE, AND IT IS KEYED ON THE TEXT.
 *
 * The feed is re-rendered from scratch on every frame — several times a second
 * while a turn runs. A counter that incremented per render would relabel the
 * same paste `#1`, `#2`, `#3`… as the screen repainted, which is worse than
 * printing the payload. So the registry maps CONTENT to a number: the same
 * paste is always the same number, for as long as the process lives.
 *
 * WHAT COUNTS AS A PASTE is deliberately conservative — a long message with
 * several lines. A short multi-line answer someone typed with Ctrl+J is not an
 * attachment and reads perfectly well in full, and hiding it behind a marker
 * would be the opposite of the fix.
 */

/** Lines a message must exceed before it can be an attachment rather than a sentence. */
const MIN_LINES = 6;
/**
 * Characters a message must exceed before the same applies.
 *
 * BELOW THE SESSION'S OWN FOLD, deliberately. src/session.js keeps 400
 * characters of a long user message (FOLD_USER_KEEP) when it compacts, so by
 * the time a real paste reaches the feed it has often already been cut to
 * exactly 400 — and a threshold of 400 then never fires on the very messages
 * this exists for. The bar has to sit under the fold to catch what survives it.
 */
const MIN_CHARS = 200;

/** text -> number, in arrival order. Process-lived, like the feed itself. */
const seen = new Map();

/**
 * PAST THIS MUCH TEXT, BULK ALONE IS ENOUGH — WHATEVER THE LINE COUNT.
 *
 * ------------------------------------------------------------------------
 * THE WALL OF TEXT, REPRODUCED. A user pastes a long structured instruction
 * whose newlines do not survive the trip — a terminal that does not bracket the
 * paste, a shell that joins the lines, a source that had none. It arrives as a
 * single 700-character line, so `lines > MIN_LINES` is false, so the whole
 * payload is drawn as though somebody had typed it:
 *
 *     ❯ corresponds to projected position ```text Validate: ```text position
 *       correct size correct … --- # COMPLETION REQUIREMENTS 1. Audit the
 *       actual DISCOVERY. 2. Implement deterministic capability readiness. 3.
 *       Prevent unrelated unknowns from blocking.
 *
 * — headings, fences and a numbered list flowed into one paragraph, filling the
 * pane and burying everything above it. That is the exact failure the marker
 * exists to prevent, arriving through the one door the marker did not cover.
 *
 * NOBODY COMPOSES SEVEN HUNDRED CHARACTERS AT A PROMPT. The both-conditions
 * rule stays for the middle ground — a 300-character sentence is prose and must
 * stay visible — and bulk alone decides only when the bulk is far past anything
 * a person types into an input box. It is deliberately NOT restricted to a
 * single line: two thousand characters in five paragraphs is an attachment too,
 * and the newline count is exactly the signal that proved unreliable.
 */
const MAX_TYPED = 600;

/**
 * Is this message an attachment rather than something the user said?
 *
 * BULK AND STRUCTURE, or bulk so far past what anybody types that structure
 * cannot be what is missing. A 500-character paragraph is prose; six short
 * lines are a list; seven hundred characters is a paste, however few newlines
 * survived the trip.
 */
function isPaste(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= MIN_CHARS) return false;
  if (s.split('\n').length > MIN_LINES) return true;
  return s.length > MAX_TYPED;
}

/**
 * THE KEY IS THE HEAD OF THE PAYLOAD, not the whole of it.
 *
 * One paste is seen in two forms: whole while it sits in the input line, and
 * cut to 400 characters once the session folds it (src/session.js). Keyed on
 * the full text those are two different strings, so the same paste was drawn as
 * `#1` while being typed and `#2` a moment later — a number that changes under
 * the reader is worse than no number.
 *
 * Folding keeps the START, so the head identifies the paste across both forms.
 */
const KEY_CHARS = 160;
const keyOf = (s) => String(s).slice(0, KEY_CHARS);

/** The marker for this payload, assigning it the next number if it is new. */
function label(text) {
  const k = keyOf(String(text == null ? '' : text));
  if (!seen.has(k)) seen.set(k, seen.size + 1);
  return `[pasted text #${seen.get(k)}]`;
}

/**
 * What the feed should DRAW for this message: the marker if it is an
 * attachment, the text itself otherwise.
 */
function compact(text) {
  return isPaste(text) ? label(text) : String(text == null ? '' : text);
}

/** How many distinct pastes have been seen. For the tests, and for /copy. */
function count() { return seen.size; }

/** Forget everything. A new session starts its numbering at one. */
function reset() { seen.clear(); }

module.exports = { isPaste, label, compact, count, reset, MIN_LINES, MIN_CHARS, MAX_TYPED };
