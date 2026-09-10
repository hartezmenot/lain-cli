'use strict';

/**
 * THE COMPOSER PROJECTION — what a big paste LOOKS LIKE while you are editing it.
 *
 * ------------------------------------------------------------------------
 * THE PROBLEM. Somebody pastes four hundred lines of a stack trace into the
 * prompt, types "fix this" in front of it, and the input box is now the screen.
 * The conversation they were reading is gone, the caret is somewhere in the
 * middle of a wall of someone else's log, and the one thing they wanted to
 * check before pressing Enter — that the sentence they typed is right — is off
 * the top.
 *
 * THE FIX, and its whole shape:
 *
 *     fix this <pasted text> and focus on the router
 *
 * One line. The typed words are exactly where they were typed, the paste is a
 * marker in the position it occupies, and the caret still moves through all of
 * it.
 *
 * ------------------------------------------------------------------------
 * IT IS A PROJECTION AND NOTHING ELSE. THIS IS THE WHOLE INVARIANT.
 *
 *     COMPOSER MODEL     the full original content, in the reader's buffer
 *            ↓
 *     projection         <pasted text>, drawn, thrown away every frame
 *            ↓ Enter
 *     turn record        the full original content
 *            ↓
 *     conversation       the full original content
 *            ↓
 *     the model          the full original content
 *
 * Nothing in this file mutates a buffer, and nothing that submits reads it.
 * `project()` is a pure function of (text, pastes) returning a STRING TO DRAW
 * plus two offset maps; the caller draws the string and throws it away. If this
 * file were deleted the program would show more text and behave identically.
 *
 * The failure it must never become is the destructive one: replacing the
 * pasted content in the buffer with the placeholder, so the model receives
 * `<pasted text>` and the transcript records a marker where ten thousand
 * characters used to be. That is data loss wearing a tidiness argument, and
 * tests/unit/composer.test.js mutation-tests this boundary for exactly that
 * reason.
 *
 * ------------------------------------------------------------------------
 * WHY SPANS ARE FOUND BY SEARCHING RATHER THAN TRACKED BY OFFSET.
 *
 * The obvious design is to record `{start, end}` when a paste arrives and move
 * those offsets as the buffer is edited. Every edit — insert, delete, cut,
 * undo, a selection replacement spanning a boundary — has to maintain them, and
 * the day one of them does not is the day a placeholder covers the wrong bytes.
 * That is a correctness bug in the one region where a mistake sends the wrong
 * text to the model.
 *
 * So the record is the PAYLOAD, and the span is found by looking for it. The
 * consequences are all in the right direction:
 *
 *   - editing INSIDE a pasted block stops it matching, so it renders in full —
 *     which is what somebody who has started editing it wants anyway.
 *   - typing around it, deleting before it, undoing, moving the caret: the
 *     paste is still in the buffer verbatim, so it is still found, at whatever
 *     offset it now occupies.
 *   - deleting it entirely: nothing is found, nothing is drawn.
 *
 * There is no state to get out of step, because there is no state.
 */

/**
 * THE CANONICAL WORDING, at the user's instruction.
 *
 * NOT `[pasted text #1]`, which is what the FEED used to draw. Numbers are for
 * telling two things apart, and in a composer you can see both of them at once
 * in the positions you put them: the one at the top is the one you pasted
 * first. A number there is bookkeeping nobody asked for.
 */
const PLACEHOLDER = '<pasted text>';

/**
 * IS THIS BLOCK BIG ENOUGH TO BE WORTH HIDING?
 *
 * Deliberately the EXISTING threshold (ui/pasted.js `isPaste`) rather than a
 * second one: bulk AND structure, or bulk so far past what anybody types that
 * structure cannot be what is missing. A pasted URL, filename, one-line command
 * or short sentence is ordinary text and behaves like ordinary text — the goal
 * is to stop a huge block destroying the composer, not to hide every paste.
 */
function collapsible(body) {
  return require('./pasted').isPaste(body);
}

/**
 * WHERE EACH RECORDED PASTE CURRENTLY SITS IN `text`.
 *
 * In ARRIVAL order for the search (so the first-pasted block claims its
 * occurrence first when two pastes are identical), returned in POSITION order
 * (so the maps below can walk them left to right). Overlapping claims are
 * impossible by construction: a candidate that overlaps something already
 * claimed keeps looking further along the buffer.
 *
 * @param {string} text          the buffer as it stands
 * @param {string[]} pastes      the payloads, oldest first
 * @returns {{from:number,to:number}[]} ascending, non-overlapping
 */
function spans(text, pastes = []) {
  const s = String(text == null ? '' : text);
  const taken = [];
  for (const raw of Array.isArray(pastes) ? pastes : []) {
    const body = String(raw == null ? '' : raw);
    if (!body || !collapsible(body)) continue;
    let at = 0;
    for (;;) {
      const i = s.indexOf(body, at);
      if (i < 0) break;
      const to = i + body.length;
      if (!taken.some((t) => i < t.to && to > t.from)) { taken.push({ from: i, to }); break; }
      at = i + 1;
    }
  }
  return taken.sort((a, b) => a.from - b.from);
}

/**
 * The buffer as it should be DRAWN, with two maps between the coordinate
 * systems.
 *
 * `toProjected(i)` — a buffer offset (the caret) to a drawn offset.
 *   A caret INSIDE a collapsed block lands at the END of its placeholder:
 *   the block is one object as far as the composer is concerned, and putting
 *   the caret in the middle of the word "pasted" would be pointing at a
 *   character that does not exist in what the user typed.
 *
 * `toBuffer(j)` — a drawn offset (a mouse click) back to a buffer offset.
 *   A click INSIDE a placeholder lands at the START of the real block, so
 *   the caret ends up immediately before the pasted content rather than
 *   somewhere arbitrary within it.
 *
 * With nothing to collapse this is the identity, and it costs one array
 * allocation — which is what keeps the ordinary case (no paste at all, which is
 * almost every keystroke) free.
 */
function project(text, pastes = []) {
  const s = String(text == null ? '' : text);
  const found = spans(s, pastes);
  if (!found.length) {
    return { text: s, spans: [], toProjected: (i) => i, toBuffer: (j) => j };
  }

  let out = '';
  let at = 0;
  /** Each span in BOTH coordinate systems, so neither map has to re-derive it. */
  const marks = [];
  for (const sp of found) {
    out += s.slice(at, sp.from);
    marks.push({ from: sp.from, to: sp.to, pFrom: out.length, pTo: out.length + PLACEHOLDER.length });
    out += PLACEHOLDER;
    at = sp.to;
  }
  out += s.slice(at);

  const toProjected = (i) => {
    const n = Math.max(0, Math.min(s.length, Number(i) || 0));
    let delta = 0;
    for (const m of marks) {
      if (n <= m.from) break;
      if (n < m.to) return m.pTo;
      delta += (m.to - m.from) - PLACEHOLDER.length;
    }
    return n - delta;
  };

  const toBuffer = (j) => {
    const n = Math.max(0, Math.min(out.length, Number(j) || 0));
    for (const m of marks) {
      if (n <= m.pFrom) return n + (m.from - m.pFrom);
      if (n < m.pTo) return m.from;
    }
    const last = marks[marks.length - 1];
    return n + (last.to - last.pTo);
  };

  return { text: out, spans: marks, toProjected, toBuffer };
}

/**
 * WHAT THE COMPOSER IS HIDING, as one short phrase, or ''.
 *
 * `2 pasted blocks · 41.2 KB`. It rides on the drawn row rather than taking a
 * row of its own — §5 is explicit that the input is one region with no second
 * status bar under it — and it exists because the placeholder alone does not
 * say how much is behind it, which is the one thing somebody wants to know
 * before pressing Enter on ten thousand characters.
 */
function hidden(marks, text) {
  if (!marks || !marks.length) return '';
  const s = String(text == null ? '' : text);
  let bytes = 0;
  for (const m of marks) bytes += Buffer.byteLength(s.slice(m.from, m.to), 'utf8');
  const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  return marks.length === 1 ? size : `${marks.length} blocks · ${size}`;
}

module.exports = { project, spans, hidden, collapsible, PLACEHOLDER };
