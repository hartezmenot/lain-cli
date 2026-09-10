'use strict';

/**
 * IS THIS BLOCK AN ATTACHMENT, OR SOMETHING SOMEBODY TYPED?
 *
 * ------------------------------------------------------------------------
 * THIS FILE USED TO COLLAPSE PASTES IN THE CONVERSATION, and it no longer does.
 *
 * Someone pastes a 400-line stack trace into the prompt. It is one act — "here,
 * look at this" — and the feed rendered every line of it as though the person
 * had said it, so a single paste buried the conversation above it. The fix was
 * to draw `[pasted text #1]` in the feed instead, with a content-keyed registry
 * assigning stable numbers.
 *
 * That put the collapse in the wrong place. The TRANSCRIPT is the record: it is
 * what a person reads back, reviews, scrolls, exports and hands over, and the
 * one thing they need after sending ten thousand characters is to see that the
 * right ten thousand characters went. A marker there answers a question nobody
 * asked with a placeholder for the one they did.
 *
 * Where the wall of text genuinely destroys something is the COMPOSER, before
 * Enter — so that is where the collapse lives now (ui/composer.js), and the
 * conversation shows what was actually sent.
 *
 * WHAT SURVIVES IS THE THRESHOLD, and it is the reason this is still a file.
 * "Is this bulk an attachment or a sentence" is a judgement with real evidence
 * behind it — two thresholds and a documented wall-of-text incident — and it is
 * asked in two unrelated places: the composer, deciding what to draw as
 * `<pasted text>`, and ui/anchors.js, classifying a message so Alt+↑ can jump
 * to it. One answer, one owner.
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
 * ------------------------------------------------------------------------
 * `label`, `compact`, `count`, `reset` AND THE CONTENT-KEYED REGISTRY STOOD
 * HERE, and all of them existed to serve the numbering in `[pasted text #N]`.
 *
 * The registry was necessary because the feed is re-rendered from scratch
 * several times a second, so a counter that incremented per render would
 * relabel the same paste `#1`, `#2`, `#3`… as the screen repainted. It was
 * keyed on the HEAD of the payload rather than the whole of it, because one
 * paste is seen in two forms — whole in the input line, and cut to 400
 * characters once src/session.js folds it — and keyed on the full text those
 * are two different strings.
 *
 * All of that is machinery in service of a number, and the number is gone with
 * the marker. The composer draws `<pasted text>`, unnumbered: you can see every
 * block at once, in the positions you put them, so there is nothing to tell
 * apart.
 * ------------------------------------------------------------------------
 */

module.exports = { isPaste, MIN_LINES, MIN_CHARS, MAX_TYPED };
