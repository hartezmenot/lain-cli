'use strict';

/**
 * THE WORKSPACE TABS — the order, in ONE place.
 *
 * This list existed four times: the Tab cycle in ui/index.js, the strip drawn
 * by ui/layout.js, the click hit-test in ui/mouse.js, and the Alt+N bindings in
 * ui/keys.js. Four copies of an ordered list is four chances for the number
 * printed in the strip, the pane Tab lands on, and the pane a click selects to
 * disagree — and the disagreement shows up as "the tabs don't work", which is
 * indistinguishable from the navigation being broken.
 *
 * So: one array, and everything that needs an order asks it.
 *
 * THE ORDER IS THE WORKFLOW, and it is deliberate:
 *
 *     ACTIVITY  what LAIN is doing, and what it just did — the operational log
 *     CONTEXT   what is true about this project right now — the briefing
 *     PLAN      what is intended
 *     DIFF      what changed
 *     OUTPUT    what happened when it ran
 *     FILES     where it all lives
 *     MEMORY    what has been decided and must not be rediscovered
 *     DETAIL    the evidence behind CONTEXT, for when the summary is not enough
 *
 * ------------------------------------------------------------------------
 * WHY AUDIT AND HEALTH ARE NO LONGER HERE.
 *
 * They were never destinations anybody wanted to be in: they are evidence
 * GENERATORS wearing a pane, and reaching project state through them meant
 * navigating to a report about the project instead of just seeing the project.
 * Their engines are untouched and still reachable as `/audit` and `/health`,
 * and `/brief` consumes the same data. What changed is that nobody has to
 * visit them to learn what they found.
 *
 * ACTIVITY IS FIRST, AND CONTEXT IS NOT THE TRANSCRIPT.
 *
 * These are two different questions and they get two different panes:
 *
 *     ACTIVITY  answers "what is LAIN doing?" — the chronological operational
 *               stream. Tool calls, results, files read, commands run, edits,
 *               errors, retries, permission and rate-limit events. It is dense,
 *               it scrolls, and it is where the model's prose lives.
 *     CONTEXT   answers "what is true?" — project identity, how to run it, what
 *               state it is in, what changed, what to do next. It is stable
 *               information, not an event ticker.
 *
 * ACTIVITY LANDS FIRST because it is the one that must be visible without
 * asking: a reply the user cannot see is indistinguishable from an agent that
 * did nothing. CONTEXT led for a while, and to keep the reply on screen it grew
 * a second copy of the feed underneath its briefing — which made the landing
 * pane a worse ACTIVITY and a worse CONTEXT at the same time. One pane, one
 * question; the feed belongs to the pane whose question it answers.
 * ------------------------------------------------------------------------
 *
 * DIFF sits beside OUTPUT because "what did I change" and "what did that do"
 * are read together — checking a change against the test run that judged it is
 * one movement, and putting FILES between them made it two.
 */

/** The panes, in the order they are numbered, cycled, drawn and clicked. */
// TOKENS SITS AFTER DETAIL because it is an instrument rather than a place you
// work: you go there when the bill or the request size is the question. It is
// the ninth pane, not a replacement for MEMORY or DETAIL - both were inspected
// and both carry information nothing else does. MEMORY is the only view of what
// `/note` recorded, and DETAIL holds the rows behind CONTEXT's counts, which by
// construction appear nowhere else.
const VIEWS = Object.freeze(['activity', 'context', 'plan', 'diff', 'output', 'files', 'memory', 'detail', 'tokens']);

/**
 * DETAIL IS LAST ON PURPOSE, AND IT IS WHY CONTEXT CAN BE SHORT.
 *
 * The survey behind CONTEXT produces far more than belongs on a pane somebody
 * glances at: every finding with its explanation, every changed file, the
 * environment, and the list of things that were NOT measured. Rendering all of
 * it as "context" is how the one line that mattered ends up buried in true,
 * low-value discovery output.
 *
 * So the same survey is rendered twice (ui/contextview.js): CONTEXT carries
 * identity, the migration in flight, state and counts; DETAIL carries the rows
 * behind those counts. It sits at the far end of the strip because it is where
 * you go when the summary was not enough — not somewhere to pass through.
 *
 * The panes that read the project when opened, so entering one starts a pass.
 *
 * CONTEXT joined them: it now reports project state rather than replaying the
 * conversation, and that state has to be read from the tree like any other
 * report. The pass is asynchronous and the pane says "reading…" until the
 * first one lands, exactly as audit and health did.
 */
const REPORT_VIEWS = Object.freeze(['context', 'detail']);

/**
 * WHICH PANES GROW UPWARD FROM THE INPUT BOX.
 *
 * A running ACCOUNT — the conversation, the output of a command — puts its
 * newest line nearest the box you type in, and pads ABOVE when there is less to
 * say than there are rows. Every chat works that way and it costs nothing.
 *
 * A DOCUMENT does the opposite. A report is read from its first line down, so
 * it starts at the top and the empty rows fall underneath it.
 *
 * ------------------------------------------------------------------------
 * THIS LIST SAID `context` UNTIL NOW, AND THE PANE LOOKED BROKEN FOR IT.
 *
 * It was right once: CONTEXT used to BE the transcript. When the conversation
 * moved to ACTIVITY and CONTEXT became a report about the project, the two
 * places that spell this rule out — the Screen constructor and `setView` —
 * were not updated. So the project briefing was bottom-anchored like a chat:
 * its heading sat just above the input box with the entire pane empty above
 * it, and the one thing the pane exists to say was pushed off the part of the
 * screen anybody looks at.
 *
 * It is a LIST HERE, next to the pane order, for the same reason that order is
 * — it was written out twice and the two copies disagreed the moment a pane
 * changed what it was for.
 * ------------------------------------------------------------------------
 */
const FEED_VIEWS = Object.freeze(['activity', 'output']);

/**
 * WHICH PANES PAD *ABOVE* THEIR CONTENT — and why ACTIVITY no longer does.
 *
 * ------------------------------------------------------------------------
 * TWO RULES WERE WEARING ONE FLAG.
 *
 *   FOLLOW LIVE   new output scrolls into view instead of being missed.
 *   GROW UPWARD   with less content than rows, pad ABOVE so the last line
 *                 sits against the input box.
 *
 * Both were `stickToBottom`, so a pane could not have one without the other.
 * ACTIVITY wants the first and not the second: a conversation that has said
 * three things should start at the TOP of the pane and grow downward, the way
 * a transcript reads and the way this pane always used to behave. Gluing it to
 * the floor put the first thing the user said at the bottom of an otherwise
 * empty region, moved every existing line up by one on each new line, and made
 * a short answer look like a screen that had scrolled away.
 *
 * OUTPUT keeps growing upward: it is a running account of a command, nobody
 * reads it from the top, and the newest line is the whole point.
 * ------------------------------------------------------------------------
 */
const UPWARD_VIEWS = Object.freeze(['output']);

/** Does this pane pad above its content, or start at the top and grow down? */
function growsUpward(view) {
  return UPWARD_VIEWS.includes(view);
}

/** Does new output scroll itself into view on this pane? */
function followsLive(view) {
  return FEED_VIEWS.includes(view);
}

/** 1-based number shown in the strip and bound to Alt+N. */
function numberOf(view) {
  const i = VIEWS.indexOf(view);
  return i < 0 ? 0 : i + 1;
}

/** The view Alt+N selects, or null. The strip's numbers and these are one list. */
function byNumber(n) {
  return VIEWS[Number(n) - 1] || null;
}

/**
 * The next view in the cycle. `delta` is +1 for Tab and -1 for Shift+Tab, and
 * it wraps in both directions — from the last pane forward to CONTEXT, and from
 * CONTEXT backward to the last pane.
 */
function step(view, delta = 1) {
  const i = VIEWS.indexOf(view);
  const from = i < 0 ? 0 : i;
  return VIEWS[((from + delta) % VIEWS.length + VIEWS.length) % VIEWS.length];
}

module.exports = { VIEWS, REPORT_VIEWS, FEED_VIEWS, UPWARD_VIEWS, growsUpward, followsLive, numberOf, byNumber, step };
