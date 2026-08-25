'use strict';

/**
 * THE INPUT BOX — how tall it is, what is drawn in it, and where the caret goes.
 *
 * Split out of ui/layout.js, which had grown past the god-object guard. The
 * seam is a real one: that file owns the SCREEN — how the regions divide, what
 * each of them contains, and the order they are painted in. This owns ONE of
 * those regions, and it is the only one a person edits inside.
 *
 * THERE IS ONE GEOMETRY HERE AND EVERYTHING READS IT. `wrapInput` says which
 * rows the buffer occupies at this width; the height comes from that list, the
 * drawing walks it, the caret is placed from it, and `rowMap.inputLines` records
 * it so a mouse click can be inverted against exactly what was drawn. Four
 * answers from one list, rather than four calculations free to disagree about
 * where a character is — which is precisely how clicking the second line of a
 * three-line prompt came to put the caret on the first.
 *
 * Nothing here decides anything about the work. It draws a box.
 */

const views = require('./views');

/**
 * How many rows of a prompt the box may show at once.
 *
 * Enough that an ordinary paragraph is visible whole before it is sent, few
 * enough that a pasted file cannot swallow the conversation. Past this the box
 * scrolls to follow the caret.
 */
const MAX_INPUT_ROWS = 8;

/** Reverse video, and back. The one place this file knows an escape sequence. */
const REV = String.fromCharCode(27) + '[7m';
const OFF = String.fromCharCode(27) + '[27m';

/**
 * Wrap the selected part of one drawn row in reverse video.
 *
 * `vr.begins` is where this row starts in the BUFFER, so the selection is
 * CLIPPED to the row rather than recomputed for it — which is what lets a run
 * spanning four rows highlight correctly on all four.
 */
function highlight(text, vr, sel) {
  if (!sel || !vr) return text;
  const from = Math.max(0, sel.start - vr.begins);
  const to = Math.min(text.length, sel.end - vr.begins);
  if (to <= 0 || from >= text.length || to <= from) return text;
  return text.slice(0, from) + REV + text.slice(from, to) + OFF + text.slice(to);
}

/**
 * The prompt as the rows it occupies at the CURRENT width.
 *
 * Computed here rather than cached: the terminal can be resized between any
 * two draws, and a cached row count is a box that is the wrong height until
 * the next keystroke.
 */
/**
 * Is the open panel asking for something that must not be shown?
 *
 * The frame says so (`secret: true`) rather than this file guessing from a
 * title — a guess would mask the wrong prompt the first time somebody words a
 * question differently.
 */
function isSecret(screen) {
  const p = screen && screen.panel;
  return Boolean(p && p.visible && p.frame && p.frame.secret);
}

/** The text as it should be DRAWN: itself, or one dot per character. */
function maskIf(screen, text) {
  return isSecret(screen) ? '•'.repeat(String(text).length) : String(text);
}

function wrapped(screen) {
  const inner = Math.max(4, screen.cols - 4);
  return views.wrapInput(maskIf(screen, String(screen.inputText || '')), inner - 2);
}

function shownRows(screen) {
  return Math.max(1, Math.min(
    wrapped(screen).length,
    MAX_INPUT_ROWS,
    Math.max(1, Math.floor((screen.rows - 8) / 3)),
  ));
}

function summary(screen) {
  // MASKED HERE TOO. The summary quotes the first line of a large paste, which
  // for a pasted credential would print the secret in the one row added to
  // describe it.
  return views.pasteSummary(
    maskIf(screen, String(screen.inputText || '')), Math.max(20, screen.cols - 6), shownRows(screen),
  );
}

/**
 * Draw the box. Returns the rows to paint, and moves nothing else.
 *
 * @param {Screen} screen
 * @param {{row:number, inner:number, cols:number, textRows:number}} at
 */
function draw(screen, { row: startRow, inner, textRows: totalRows }) {
  const out = [];
  let row = startRow;
  const g = { inputRows: totalRows };
  // The cursor-position escape, built rather than written: a raw 0x1b in a
  // source file is what the architecture guard forbids, because it is invisible
  // in a diff and impossible to grep for.
  const ESC = String.fromCharCode(27);
  const at = (r, c) => ESC + '[' + r + ';' + c + 'H';
  // Erase-to-end-of-line. Every row here is already padded to `inner`, so this
  // is defence in depth rather than load-bearing — but it costs one constant
  // per row and keeps this box drawn the same way as the rest of the screen
  // (see the header comment on `L` in ui/layout.js for why the screen no
  // longer opens each frame with a full-screen clear).
  const EOL = ESC + '[K';
  // THE BOX SHOWS THE PROMPT AS IT WILL BE SENT, wrapped —.
  //
  // It drew one row per BUFFER LINE and scrolled that row sideways to follow
  // the caret. Typing a long sentence therefore pushed its own beginning off
  // the left-hand edge: you could not read what you were about to send. Long
  // lines now WRAP, and the box grows to the rows they occupy.
  //
  // ONE GEOMETRY. `wrapInput` says which rows the buffer occupies; this draws
  // a window of them, `caretRow` says where the block goes, and `rowMap`
  // records the same list for the click that has to be inverted. Four answers
  // computed from one list rather than four calculations free to disagree.
  // ---- A SECRET IS NEVER DRAWN ----------------------------------------
  //
  // `/api` asks for a credential on this line, and the line is echoed like any
  // other — so the key sat in plain text on screen, in any screenshot of it,
  // and in anything `/copy` took off the screen. It is masked HERE, at the one
  // place the buffer becomes rows, so wrapping, the caret, the click map and
  // the paste summary all operate on the same string and cannot disagree about
  // where a character is.
  //
  // SAME LENGTH, so none of that arithmetic changes: one dot per character.
  // The buffer itself is untouched — what is SENT is the real credential, and
  // only the DRAWING is masked, which is the same separation every other
  // presentation decision in this program is built on.
  const raw = maskIf(screen, String(screen.inputText || ''));
  const summaryRow = summary(screen);
  const textRows = Math.max(1, g.inputRows - 2 - (summaryRow ? 1 : 0));
  if (summaryRow) {
    const { C } = require('../render');
    const summary = views.clip(summaryRow, inner);
    // Padded on the PLAIN string, then coloured: colour codes carry no width,
    // and measuring them would tear the right-hand border off the box.
    out.push(at(row++, 1) + '│ ' + C.dim(summary) + ' '.repeat(Math.max(0, inner - summary.length)) + ' │' + EOL);
  }

  const wrapped = views.wrapInput(raw, inner - 2);
  const caret = views.caretRow(wrapped, screen.inputCursorAt);
  // The window follows the caret, so a prompt taller than the box scrolls
  // rather than pinning to its top.
  let first = Math.max(0, Math.min(caret.row - Math.floor((textRows - 1) / 2), wrapped.length - textRows));
  if (first < 0) first = 0;

  const many = wrapped.length > textRows;
  screen.rowMap.inputLines = [];
  for (let i = 0; i < textRows; i++) {
    const vr = wrapped[first + i];
    // The `> ` prompt belongs to the FIRST row of the buffer; continuation
    // rows are indented to line up under it, so the block reads as one thing.
    const lead = vr && vr.begins === 0 ? '> ' : '  ';
    // ONLY THE CARET'S ROW CARRIES THE MARKER, and only when there is
    // something off screen to mark.
    const tag = many && first + i === caret.row ? `  [${caret.row + 1}/${wrapped.length}]` : '';
    // TABS ARE EXPANDED BEFORE THE ROW IS MEASURED OR DRAWN.
    //
    // Seen on screen: the box's right-hand border landing at a different column
    // on every row of a pasted markdown prompt. A tab is counted as one
    // character by `.length` below and advances the terminal up to eight, so a
    // row containing one is padded too far and its border is pushed out. See
    // ui/text.js — the diff window had the identical defect, from the identical
    // cause.
    const text = vr ? views.clip(require('./text').detab(vr.text), Math.max(4, inner - lead.length - tag.length)) : '';
    // THE SELECTION, IN REVERSE VIDEO —. A selection nobody can see is one
    // that deletes text without warning the next time anything is typed.
    // Applied to the drawn slice of THIS row, so a run spanning several rows
    // highlights correctly on each of them.
    const shown = lead + highlight(text, vr, screen.inputSelection) + tag;
    if (vr) {
      screen.rowMap.inputLines.push({
        row, line: vr.line, begins: vr.begins, length: vr.text.length, start: 0,
      });
      if (first + i === caret.row) {
        // COLUMN 5 IS THE FIRST CHARACTER: `│ ` + `> ` + text.
        screen.cursorCol = 5 + Math.min(caret.col, Math.max(0, inner - lead.length));
        screen.cursorRow = row;
        screen.rowMap.inputRow = row;
        screen.rowMap.inputTextCol = 5;
        screen.rowMap.inputStart = 0;
        screen.rowMap.inputLineStart = vr.begins;
      }
    }
    // PADDED ON THE PLAIN WIDTH. Reverse-video codes carry no columns, and
    // measuring them would tear the right-hand border off the box.
    const width = lead.length + text.length + tag.length;
    out.push(at(row++, 1) + '│ ' + shown + ' '.repeat(Math.max(0, inner - width)) + ' │' + EOL);
  }
  out.push(at(row++, 1) + '└' + '─'.repeat(inner + 2) + '┘' + EOL);
  return out;
}

module.exports = { draw, wrapped, shownRows, summary, MAX_INPUT_ROWS };
