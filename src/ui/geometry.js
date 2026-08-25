'use strict';

/**
 * REGION HEIGHTS — how the terminal's rows are divided, and in what order they
 * are given up when there are not enough of them.
 *
 * Split out of ui/layout.js, which had reached the god-object guard. The seam
 * is a real one: everything here is arithmetic over the CURRENT screen state
 * and returns a plain object. It draws nothing and mutates nothing, which is
 * what makes "the INPUT is never sacrificed" checkable at a glance instead of
 * being a convention buried among the methods that paint.
 *
 * FREE FUNCTIONS OVER `screen`, not methods — the same rule ui/projection.js
 * follows, and for the same reason: a helper that reaches back through `this`
 * can quietly start depending on call order.
 *
 * THE HIERARCHY, top to bottom, and the order of sacrifice:
 *
 *     HEADER            frame first, then down to two rows
 *     WORKSPACE         keeps at least one row; gives up the rest
 *     PENDING INPUT     only when something is waiting; shed before the strip
 *     STATUS STRIP      down to one row — "is it still alive" outranks the trail
 *     INPUT             never sacrificed
 *     PANEL             bounded by its own contents
 */

/**
 * Region heights. The header shrinks before anything else, then secondary
 * status; the INPUT is never sacrificed, and the workspace keeps at least one
 * row so the layout degrades instead of crashing on a short terminal.
 */
function regions(screen) {
  const rows = screen.rows;
  const panel = panelRows(screen, rows);
  // The header is a BOX on a normal terminal: a rule, its content, a closing
  // rule. On a short one the frame is the first thing dropped — a border is
  // decoration, and the design is explicit that status and progress outrank it.
  // FOUR ROWS FRAMED, NOT FIVE: a rule, the two content rows, a closing rule.
  // The third content row repeated the objective the TASK banner already pins
  // two rows below it (see views.header) — chrome saying the same sentence
  // twice above a conversation with no room left. The row belongs to the
  // conversation, which is the surface everything else exists to serve.
  const framed = rows >= 18;
  let headerRows = rows < 16 ? 2 : (framed ? 4 : 3);
  // A multi-line buffer earns ONE extra row saying what was pasted. On a short
  // terminal it does not: the workspace is already down to a handful of rows
  // there, and the paste is still reachable line by line with the caret.
  // THE BOX GROWS WITH WHAT IS IN IT —. A three-row box showing one line
  // of a five-line prompt with a `[3/5]` marker is a prompt you cannot read
  // before sending it, which is most of what "no multiline input" meant even
  // once a newline could be typed.
  //
  // BOUNDED, and hard. The workspace is the surface everything else exists to
  // serve, so the box may take at most a third of a tall terminal and never
  // more than the box allows. Past that it scrolls to follow the caret
  // exactly as one row always did — see views.inputViewport.
  // THE ROWS THE PROMPT ACTUALLY OCCUPIES, wrapped — not how many newlines
  // it contains. A single long sentence is several rows and the box has to
  // grow for it, which is the whole of "long lines must wrap" (): a box
  // that stayed three rows tall would simply have clipped them instead.
  const bufferLines = Math.max(1, screen._wrapped().length);
  const roomForInput = Math.max(1, Math.floor((rows - 8) / 3));
  const textRows = Math.max(1, Math.min(bufferLines, require('./inputbox').MAX_INPUT_ROWS, roomForInput));
  const inputRows = 2 + textRows + (rows >= 16 && screen._pasteSummary() ? 1 : 0);
  // THE LLM STATUS STRIP, immediately above the INPUT box. One row is the
  // live state and is the last thing sacrificed; the extra rows are the trail
  // of what the turn just did, and a short terminal simply does without them.
  // ONE row always, because "is it still alive" outranks everything else on
  // screen — at 40x9 the strip is the only thing left saying so. The extra
  // rows are the trail of completed calls and are a luxury of a tall terminal.
  let statusRows = rows >= 26 ? 3 : rows >= 16 ? 2 : 1;
  // WHAT IS GIVEN UP FIRST, in order: the header's frame, then the status
  // trail one row at a time, then the strip itself. The workspace keeps at
  // least one row and the INPUT is never touched. A strip that refused to
  // shrink pushed the total past the height of the terminal on a short one,
  // which is a region drawn off the bottom of the screen.
  // PENDING USER INPUT sits between the conversation and the strip —. It
  // costs nothing when nothing is waiting, and it is given up BEFORE the
  // status trail on a cramped terminal: "is it still alive" outranks "and
  // here is what you typed", which the input box is still showing anyway.
  let pendingRows = require('./pending').rows(screen.state && screen.state.llm,
    Math.max(0, rows - headerRows - inputRows - panel - statusRows - 1));
  // BACKGROUND WORK sits beside it, for the same reason and on the same terms:
  // it costs nothing when nothing is running, and it is given up before the
  // conversation is. See ui/jobsview.js.
  let jobRows = require('./jobsview').rows(screen.state && screen.state.llm,
    Math.max(0, rows - headerRows - inputRows - panel - statusRows - pendingRows - 1));
  const left = () => rows - headerRows - inputRows - panel - statusRows - pendingRows - jobRows;
  if (left() < 1) headerRows = 2;
  // GIVEN UP FIRST. A steer you have typed and not yet sent is more urgent than
  // a status you can get from `/jobs`, so this yields before pending does.
  while (jobRows > 0 && left() < 1) jobRows -= 1;
  while (pendingRows > 0 && left() < 1) pendingRows -= 1;
  while (statusRows > 0 && left() < 1) statusRows -= 1;
  const workspace = Math.max(1, left());
  return {
    headerRows, workspace, statusRows, inputRows, panelRows: panel, pendingRows, jobRows,
    compactHeader: headerRows <= 2,
    framed: framed && headerRows >= 4,
  };
}

function panelRows(screen, rows) {
  if (!screen.panel || !screen.panel.visible) return 0;
  // A completion palette is a HINT beside the input, not a screen. It takes
  // only what its own contents need, so typing `/` never buries the work you
  // are looking at. Modal pickers (models, config, a question) may take more.
  const n = screen.panel.items.length;
  // COMMAND OUTPUT TAKES WHAT IT NEEDS AND NO MORE. A picker is a list you
  // are about to hunt through, so a generous fixed height serves it; output
  // is a fixed number of lines that are already all there, and giving a
  // two-line answer from `/effort` half the terminal is a box mostly full of
  // nothing sitting on top of the conversation. Capped like everything else,
  // and it SCROLLS past the cap (see InteractionPanel.move).
  const isOutput = screen.panel.kind === require('./panel').KIND.OUTPUT;
  const wanted = screen.panel.isCompletion || screen.panel.mode === 'compact'
    ? Math.min(12, Math.max(7, n + 6))
    : isOutput
      ? Math.min(18, Math.max(7, n + 6))
      : Math.min(18, Math.max(8, Math.floor(rows * 0.5)));
  // Never let the panel starve the workspace and input entirely.
  return Math.min(wanted, Math.max(0, rows - 6));
}

module.exports = { regions, panelRows };
