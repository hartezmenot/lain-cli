'use strict';

/**
 * THE INPUT — how tall it is, what is drawn in it, and where the caret goes.
 *
 * Split out of ui/layout.js, which had grown past the god-object guard. The
 * seam is a real one: that file owns the SCREEN — how the regions divide, what
 * each of them contains, and the order they are painted in. This owns ONE of
 * those regions, and it is the only one a person edits inside.
 *
 * ------------------------------------------------------------------------
 * THERE IS NO BOX ANY MORE. THE GROUND IS THE REGION.
 *
 * It was `┌───┐ │ > text │ └───┘`: a labelled border, a prompt symbol inside
 * it, and a summary row underneath describing what had been pasted. Four kinds
 * of chrome around one line of text, on a screen whose entire design argument
 * is that whitespace and contrast are enough structure.
 *
 * What is drawn now is a subtle grey fill across the full terminal width, one
 * space of padding, and the text. Nothing else:
 *
 *     ▓ Ask LAIN…                                                        ▓
 *
 * The contrast alone says "this is where you type", which is what §4 of the
 * correction asks for and what every text field outside a terminal does. It
 * also costs TWO FEWER ROWS than the border did, and those rows went to the
 * conversation.
 *
 * WITHOUT COLOUR IT STILL WORKS. `P.surface` degrades to plain text on a pipe,
 * under NO_COLOR, and in a monochrome terminal — and the input is still the
 * bottom-most region with the caret parked in it, which is the signal that was
 * always doing most of the work.
 *
 * ------------------------------------------------------------------------
 * THERE IS ONE GEOMETRY HERE AND EVERYTHING READS IT. `wrapInput` says which
 * rows the buffer occupies at this width; the height comes from that list, the
 * drawing walks it, the caret is placed from it, and `rowMap.inputLines` records
 * it so a mouse click can be inverted against exactly what was drawn. Four
 * answers from one list, rather than four calculations free to disagree about
 * where a character is — which is precisely how clicking the second line of a
 * three-line prompt came to put the caret on the first.
 *
 * AND THAT GEOMETRY IS OVER THE PROJECTION, NOT THE BUFFER. A big paste is
 * DRAWN as `<pasted text>` (ui/composer.js), so the rows, the caret and the
 * click map are all computed over the projected string and mapped back. The
 * buffer is untouched and is what gets sent.
 *
 * Nothing here decides anything about the work. It draws a line of text.
 */

const views = require('./views');
const composer = require('./composer');

/**
 * How many rows of a prompt the region may show at once.
 *
 * Enough that an ordinary paragraph is visible whole before it is sent, few
 * enough that a pasted file cannot swallow the conversation. Past this it
 * scrolls to follow the caret.
 *
 * IT IS RARELY REACHED NOW. The thing that used to hit this ceiling was a
 * paste, and a paste is one row.
 */
const MAX_INPUT_ROWS = 8;

/**
 * THE COMPOSER'S INNER PADDING — one column, inside the fill.
 *
 * THE OUTER MARGIN IS NOT THIS FILE'S BUSINESS. The content frame owns it and the
 * layout applies it (ui/views.js `contentBounds`), so the grey ground starts
 * exactly where the conversation starts. This is the padding INSIDE that ground:
 * the first character sits one cell in, which gives the fill a visible edge
 * instead of having text pressed against its boundary.
 *
 * ONE, NOT TWO. Two reads as a deliberate indent and puts what you are typing
 * visibly out of line with the prose above it; one reads as padding, which is
 * what it is.
 *
 * THE GROUND SPANS THE WHOLE FRAME either way — the fill is the region, and a fill
 * with a gutter of its own would be a box again.
 */
const PAD = 1;

/** Reverse video, and back. The one place this file knows an escape sequence. */
const REV = String.fromCharCode(27) + '[7m';
const OFF = String.fromCharCode(27) + '[27m';

/**
 * Wrap the selected part of one drawn row in reverse video.
 *
 * `vr.begins` is where this row starts in the PROJECTED string, so the
 * selection is CLIPPED to the row rather than recomputed for it — which is what
 * lets a run spanning four rows highlight correctly on all four.
 */
function highlight(text, vr, sel) {
  if (!sel || !vr) return text;
  const from = Math.max(0, sel.start - vr.begins);
  const to = Math.min(text.length, sel.end - vr.begins);
  if (to <= 0 || from >= text.length || to <= from) return text;
  return text.slice(0, from) + REV + text.slice(from, to) + OFF + text.slice(to);
}

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

/** How wide the text may be: the terminal, less the content frame's inset a side. */
function innerWidth(screen) {
  return Math.max(8, screen.cols - PAD * 2);
}

/**
 * THE STRING THAT IS ACTUALLY DRAWN, and the maps back to the buffer.
 *
 * Masked first (a credential is never drawn), then projected (a big paste is
 * one marker). Both are display transforms over `screen.inputText`, which is
 * untouched and is what gets sent.
 *
 * A SECRET IS NEVER PROJECTED. The mask has already replaced every character
 * with a dot, so there is nothing recognisable to collapse — and searching a
 * row of dots for a pasted payload would be looking for something that by
 * construction is not there.
 */
function shown(screen) {
  const raw = maskIf(screen, String(screen.inputText || ''));
  if (isSecret(screen)) return { text: raw, spans: [], toProjected: (i) => i, toBuffer: (j) => j };
  return composer.project(raw, screen.inputPastes || []);
}

/**
 * The prompt as the rows it occupies at the CURRENT width.
 *
 * Computed here rather than cached: the terminal can be resized between any
 * two draws, and a cached row count is a region that is the wrong height until
 * the next keystroke.
 */
function wrapped(screen) {
  return views.wrapInput(shown(screen).text, innerWidth(screen));
}

function shownRows(screen) {
  return Math.max(1, Math.min(
    wrapped(screen).length,
    MAX_INPUT_ROWS,
    Math.max(1, Math.floor((screen.rows - 8) / 3)),
  ));
}

/**
 * WHAT AN EMPTY REGION SAYS.
 *
 * The region used to be empty and carry a `> ` — a prompt symbol inside a
 * bordered area that was itself the prompt. With the border gone the grey says
 * where, the caret says exactly where, and this says what for.
 *
 * DRAWN, NEVER STORED. The buffer is genuinely empty: this is one dim string
 * painted where the first character will go, it is not in `inputText`, it is
 * not in `rowMap.inputLines`, and it disappears on the first keystroke. A
 * placeholder that could be submitted would be the worst possible bug in the
 * one region that sends things.
 */
const PLACEHOLDER = 'Ask LAIN…';

/**
 * ...AND WHAT IT SAYS WHEN A QUESTION IS OPEN.
 *
 * `ANSWER — type A-D`. This used to be a LABEL ON THE INPUT'S TOP BORDER, and
 * it earned its place there: the panel asking the question is drawn BELOW the
 * input, so without something on the input itself nothing on screen connected
 * "type a letter" to the line you type it on. A box reading INPUT sat under a
 * question whose own text said "type a number", and neither admitted the other
 * existed.
 *
 * There is no border to hang it on, and it does not need one — this is exactly
 * what a placeholder is for. The wording comes from ui/answer.js, the same
 * source as the panel's footer and its row labels, so the three can never
 * advertise different keys.
 *
 * ONLY WHILE THE LINE IS EMPTY, like any placeholder: once you have typed
 * something, what you have typed is the more useful thing to show.
 */
function promptFor(screen) {
  const p = screen && screen.panel;
  if (p && p.visible && p.acceptsTyped && !p.isCompletion) {
    try { return require('./answer').inputLabel(p.options, p.takes); } catch { /* fall through */ }
  }
  return PLACEHOLDER;
}

/**
 * Draw the region. Returns the rows to paint, and moves nothing else.
 *
 * @param {Screen} screen
 * @param {{row:number, cols:number, textRows:number}} at
 */
function draw(screen, { row: startRow, cols, textRows: totalRows, col: startCol = 1 }) {
  const out = [];
  let row = startRow;
  const { P } = require('./paint');
  const width = Math.max(12, cols || screen.cols);
  const inner = Math.max(8, width - PAD * 2);
  // The cursor-position escape, built rather than written: a raw 0x1b in a
  // source file is what the architecture guard forbids, because it is invisible
  // in a diff and impossible to grep for.
  const ESC = String.fromCharCode(27);
  const at = (r, c) => ESC + '[' + r + ';' + c + 'H';
  const EOL = ESC + '[K';
  /**
   * One row of the region: the whole terminal width on the grey ground.
   *
   * THE GROUND COVERS THE PADDING AND THE EMPTY REMAINDER, not just the text.
   * A fill that stopped at the last character would be a ragged right edge
   * that moves as you type, which is the opposite of an anchor.
   */
  const ground = (body, visible) => P.surface(
    ' '.repeat(PAD) + body + ' '.repeat(Math.max(0, width - PAD - visible)),
  );

  const view = shown(screen);
  const wrappedRows = views.wrapInput(view.text, inner);
  const caret = views.caretRow(wrappedRows, view.toProjected(screen.inputCursorAt));
  // The window follows the caret, so a prompt taller than the region scrolls
  // rather than pinning to its top.
  let first = Math.max(0, Math.min(caret.row - Math.floor((totalRows - 1) / 2), wrappedRows.length - totalRows));
  if (first < 0) first = 0;

  const many = wrappedRows.length > totalRows;
  /**
   * ---- THE TEXT SITS IN THE MIDDLE OF THE REGION ------------------------
   *
   * The region has a floor of three rows, and a one-line prompt drawn on the
   * first of them put the caret hard against the top edge with two rows of
   * empty grey hanging underneath it — which reads as a box that has failed to
   * fill rather than as a composer with room to breathe:
   *
   *     text                          .....
   *     .....        instead of        text
   *     .....                         .....
   *
   * So the prompt is CENTRED in whatever rows it does not need. It is not a pad
   * of extra rows and it draws nothing of its own: the same fill spans the whole
   * region either way, and this only decides which of those rows the text lands
   * on. A prompt that fills the region, or overflows it, has nothing spare and
   * the offset is zero — so nothing moves while you are typing a long one.
   */
  const spare = Math.max(0, totalRows - Math.min(wrappedRows.length, totalRows));
  const topPad = Math.floor(spare / 2);
  // THE PLACEHOLDER ONLY WHEN THERE IS GENUINELY NOTHING, and never over a
  // masked credential prompt, where a grey word where the dots go would read as
  // text that is already there.
  const empty = !view.text.length && !isSecret(screen);
  /**
   * WHAT IS BEHIND THE MARKERS, on the caret's row, right-aligned.
   *
   * `<pasted text>` says a block is there; this says how much of it, which is
   * the one thing somebody wants before pressing Enter on ten thousand
   * characters. It rides on an existing row rather than taking one, because §5
   * is explicit that there is no second status bar under the input.
   */
  const behind = composer.hidden(view.spans, maskIf(screen, String(screen.inputText || '')));

  // WHERE THE REGION BEGINS, as well as where its caret is. The caret's row is
  // the middle one when the prompt is short (see `topPad`), so "the composer's
  // first row" is no longer derivable from `inputRow` by subtraction.
  screen.rowMap.inputStartRow = startRow;
  screen.rowMap.inputRegionRows = totalRows;
  screen.rowMap.inputLines = [];
  for (let i = 0; i < totalRows; i++) {
    // WHICH WRAPPED ROW THIS TERMINAL ROW SHOWS, or none: the rows above and
    // below a centred prompt are fill and carry no text.
    const vi = i - topPad;
    const vr = vi >= 0 && vi < totalRows ? wrappedRows[first + vi] : undefined;
    // ONLY THE CARET'S ROW CARRIES A MARKER, and only when there is something
    // to mark: how far through a scrolled prompt you are, or what the
    // placeholders are standing in for.
    const onCaret = vr ? first + vi === caret.row : false;
    const tag = onCaret
      ? (many ? `  [${caret.row + 1}/${wrappedRows.length}]` : '') + (behind ? `  ${behind}` : '')
      : '';
    // TABS ARE EXPANDED BEFORE THE ROW IS MEASURED OR DRAWN.
    //
    // Seen on screen: the region's right-hand edge landing at a different
    // column on every row of a pasted markdown prompt. A tab is counted as one
    // character by `.length` and advances the terminal up to eight, so a row
    // containing one is padded too far. See ui/text.js — the diff window had
    // the identical defect, from the identical cause.
    const text = vr ? views.clip(require('./text').detab(vr.text), Math.max(4, inner - tag.length)) : '';
    const placeholder = views.clip(promptFor(screen), inner);
    // THE SELECTION, IN REVERSE VIDEO. A selection nobody can see is one that
    // deletes text without warning the next time anything is typed. Applied to
    // the drawn slice of THIS row, so a run spanning several rows highlights
    // correctly on each of them.
    const body = empty && vi === 0
      ? P.meta(placeholder)
      : highlight(text, vr, screen.inputSelection) + (tag ? P.meta(tag) : '');
    if (vr) {
      // ---- THE CLICK MAP IS IN *BUFFER* COORDINATES ---------------------
      //
      // `vr.begins` is where this row starts in the PROJECTED string; a click
      // has to end up at the corresponding place in the real buffer, or a
      // prompt with a collapsed paste in it would put the caret in the wrong
      // half of what the user typed. Mapped here, once, where both coordinate
      // systems are in hand. See ui/composer.js `toBuffer`.
      screen.rowMap.inputLines.push({
        row,
        line: vr.line,
        begins: view.toBuffer(vr.begins),
        length: view.toBuffer(vr.begins + vr.text.length) - view.toBuffer(vr.begins),
        start: 0,
      });
      if (onCaret) {
        // THE FIRST CHARACTER SITS AT THE CONTENT FRAME'S INSET, then text — the
        // same column the conversation above it begins on. See PAD.
        screen.cursorCol = startCol + PAD + Math.min(caret.col, Math.max(0, inner));
        screen.cursorRow = row;
        screen.rowMap.inputRow = row;
        screen.rowMap.inputTextCol = startCol + PAD;
        screen.rowMap.inputStart = 0;
        screen.rowMap.inputLineStart = view.toBuffer(vr.begins);
      }
    }
    // MEASURED ON THE PLAIN WIDTH. Reverse-video and colour codes carry no
    // columns, and measuring them would tear the right-hand edge off the fill.
    const visible = PAD + (empty && vi === 0 ? placeholder.length : text.length + tag.length);
    out.push(at(row++, startCol) + ground(body, visible) + EOL);
  }
  return out;
}

/**
 * ------------------------------------------------------------------------
 * `summary()` STOOD HERE — the extra row under the box reading
 * `⎘ 1,200 lines · 41.2 KB · "Traceback (most recent call last):"`.
 *
 * It existed because the box drew the whole paste and a person could not tell
 * how much of it there was. The composer collapses the paste instead, so the
 * question is answered where it is asked — on the caret's own row, as
 * `41.2 KB` beside the marker standing in for it — and a region that is one
 * region does not need a second row describing itself.
 * ------------------------------------------------------------------------
 */

module.exports = { draw, wrapped, shownRows, shown, innerWidth, promptFor, MAX_INPUT_ROWS, PAD, PLACEHOLDER };
