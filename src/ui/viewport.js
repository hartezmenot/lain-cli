'use strict';

/**
 * THE INPUT VIEWPORT — pure geometry for the input row.
 *
 * Split from views.js because it is the one piece of presentation with no
 * knowledge of LAIN at all: given a buffer, a caret and a width it says what to
 * draw and where the caret lands. That makes it testable without a terminal,
 * a session or a screen.
 */
/**
 * THE BUFFER AS THE ROWS IT ACTUALLY OCCUPIES —.
 *
 * WHAT THIS REPLACES. The box drew ONE row per buffer line and scrolled that
 * row sideways to follow the caret, marking the cut with `…`. It worked, and it
 * meant that typing a long sentence pushed its own beginning off the left-hand
 * edge: you could not read the prompt you were about to send. the design is explicit —
 * "it must NOT simply extend horizontally until the beginning of the prompt
 * disappears. Long lines must wrap."
 *
 * So a long line becomes SEVERAL VISUAL ROWS. Everything downstream reads this
 * one list: how tall the box is, what is drawn in it, where the caret goes, and
 * which buffer position a click lands on. One geometry, computed once, rather
 * than four calculations free to disagree about where a character is.
 *
 * WRAPS AT A WORD when there is one to wrap at, and mid-word when a single
 * token is longer than the box — a URL must not be able to blank a row.
 *
 * Pure, so all of it is testable without a terminal.
 *
 * @returns {Array<{line, start, text, begins, last}>}
 *   line   which buffer line this row belongs to (0-based)
 *   start  the column of that line where this row begins
 *   text   what to draw
 *   begins the BUFFER index this row begins at — what inverts a click
 *   last   true when this row ends its buffer line (the caret may sit past it)
 */
function wrapInput(buffer, width) {
  const buf = String(buffer == null ? '' : buffer);
  // One column is reserved for the caret: at the end of a row it sits AFTER the
  // last character and needs somewhere to be drawn.
  const room = Math.max(4, Number(width) || 4) - 1;
  const rows = [];
  let at = 0;

  for (const [line, text] of buf.split('\n').entries()) {
    let col = 0;
    do {
      if (text.length - col <= room) {
        rows.push({ line, start: col, text: text.slice(col), begins: at + col, last: true });
        break;
      }
      // The last space inside the room, so a word is not split when it need not
      // be. `+ 1` so the break is looked for INCLUDING the column just past the
      // window — a space exactly there is a clean break, not a wrap.
      const window = text.slice(col, col + room + 1);
      const space = window.lastIndexOf(' ');
      // A SINGLE TOKEN LONGER THAN THE BOX is cut mid-word. The alternative is
      // a blank row followed by the same problem, which is worse than a cut.
      const take = space > 0 ? space : room;
      rows.push({ line, start: col, text: text.slice(col, col + take), begins: at + col, last: false });
      // A space AT the break is consumed by it: leading a wrapped row with a
      // space is a visible indent nobody typed.
      col += take + (space > 0 ? 1 : 0);
    } while (true);
    at += text.length + 1;
  }
  return rows;
}

/**
 * Which visual row the caret is on, and which column of it.
 *
 * The caret can sit one past the end of a row, which is where it is after
 * typing the last character — so a position at a row's end belongs to THAT row
 * when the row ends its line, and to the NEXT one when the line continues.
 * Getting this wrong puts the block on the row above the letters being typed.
 */
function caretRow(rows, cursor) {
  const caret = Math.max(0, Number(cursor) || 0);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const end = r.begins + r.text.length;
    if (caret < end) return { row: i, col: caret - r.begins };
    if (caret === end && (r.last || i === rows.length - 1)) return { row: i, col: caret - r.begins };
  }
  const last = rows[rows.length - 1] || { begins: 0, text: '' };
  return { row: Math.max(0, rows.length - 1), col: last.text.length };
}

/**
 * THE INPUT VIEWPORT — what to show of a line too long to fit, and where the
 * caret sits within that.
 *
 * The input row drew `clip('> ' + text, width)`, which always shows the START
 * of the line. Type past the right edge of a 96-column terminal and the caret,
 * and every character after it, was simply not on screen: you were editing
 * blind. A long prompt could not be reviewed or corrected without deleting it.
 *
 * This scrolls the window to follow the caret, the way any editor does, and
 * marks either side with `…` so it is obvious text continues beyond the frame.
 * A multi-line buffer (a paste) shows the line the caret is ON — which is the
 * vertical scroll, for a box one row tall.
 *
 * Pure, so it is testable without a terminal.
 *
 * @returns {{text, cursorCol, line, lines, scrolled, start, lineStart}}
 *   text      what to draw
 *   cursorCol which column of `text` the caret is in (0-based)
 *   line      which line of the buffer the caret is on (0-based)
 *   lines     how many lines the buffer holds
 *   start     which column of that LINE the drawn window begins at
 *   lineStart the buffer index at which that line begins
 *
 * `start` and `lineStart` exist so the mapping can be INVERTED: a mouse click
 * arrives as a drawn column and has to become a buffer index. Doing that
 * arithmetic anywhere else would be a second copy of this geometry, free to
 * disagree with the caret this function places. See ui/mouse.js.
 */
function inputViewport(buffer, cursor, width) {
  const buf = String(buffer == null ? '' : buffer);
  const caret = Math.max(0, Math.min(buf.length, Number(cursor) || 0));
  const all = buf.split('\n');
  // Which line the caret is on, and where within it.
  let line = 0;
  let seen = 0;
  for (; line < all.length; line++) {
    if (caret <= seen + all[line].length) break;
    seen += all[line].length + 1;
  }
  if (line >= all.length) line = all.length - 1;
  const text = all[line] || '';
  const col = caret - seen;

  // One column is reserved for the caret itself: at the end of a line it sits
  // AFTER the last character, which needs somewhere to be drawn. Without this a
  // caret at the end of a full line renders one column outside the frame.
  const room = Math.max(4, width) - 1;
  if (text.length <= room) {
    return { text, cursorCol: Math.min(col, room), line, lines: all.length, scrolled: false, start: 0, lineStart: seen };
  }

  // Keep the caret inside the window with a little context ahead of it, so the
  // next characters typed are already visible rather than each one shoving the
  // view along by one.
  const pad = Math.min(8, Math.floor(room / 4));
  let start = Math.max(0, col - room + pad);
  start = Math.min(start, Math.max(0, text.length - room));
  let slice = text.slice(start, start + room);
  let cursorCol = col - start;

  // Ellipses replace a character each, never overlay one, so the column the
  // caret is drawn in stays truthful.
  if (start > 0) { slice = '…' + slice.slice(1); }
  if (start + room < text.length) { slice = slice.slice(0, -1) + '…'; }
  cursorCol = Math.max(0, Math.min(slice.length, cursorCol));
  return { text: slice, cursorCol, line, lines: all.length, scrolled: true, start, lineStart: seen };
}

/**
 * ------------------------------------------------------------------------
 * `pasteSummary` STOOD HERE — the extra row under the input box reading
 * `⎘ 1,200 lines · 41.2 KB · "Traceback (most recent call last):"`.
 *
 * It existed because the box DREW THE WHOLE PASTE and a person could not tell
 * how much of it there was, or how much was off screen. The composer collapses
 * the paste instead (ui/composer.js), so there is no wall to describe: the
 * marker says a block is there and the size rides beside it on the caret's own
 * row. A region that is one region does not need a second row about itself,
 * which is what §5 of the correction asks for.
 * ------------------------------------------------------------------------
 */

/**
 * How many lines the buffer holds. One for an empty buffer, because the box
 * still has a row to draw and a caret to put in it.
 *
 * Here rather than in the layout because this file already owns every other
 * question about how a buffer occupies the input region.
 */
function lineCount(buffer) {
  const s = String(buffer == null ? '' : buffer);
  if (!s) return 1;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

module.exports = { inputViewport, lineCount, wrapInput, caretRow };
