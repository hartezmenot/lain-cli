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
 *     HEADER            one row of metadata, plus a rule; the rule goes first
 *     CONVERSATION      keeps at least one row; gives up the rest
 *     PENDING INPUT     only when something is waiting; shed before the strip
 *     BACKGROUND        only when something is running; shed before pending
 *     LIVE ACTIVITY     exactly one row — it is never a panel
 *     INPUT             never sacrificed
 *     PANEL             bounded by its own contents
 *
 * ------------------------------------------------------------------------
 * WHAT THIS FUNCTION USED TO SPEND, AND WHERE THOSE ROWS WENT.
 *
 * At 80x24 the fixed chrome was: a four-row framed header, a tab strip, a
 * two-row pinned task banner and a three-row status strip — TEN of the
 * twenty-four rows, before the input box. The conversation, which is the
 * thing every other region exists to serve, got eleven.
 *
 * The frame, the strip and the banner are gone. The status strip is ONE row
 * (§9: current activity only, never event history). At the same 80x24 the
 * chrome is now two rows plus a one-row live state, and the conversation
 * gets seventeen.
 */

/**
 * Region heights. The header's rule goes before anything else; the INPUT is
 * never sacrificed, and the conversation keeps at least one row so the layout
 * degrades instead of crashing on a short terminal.
 */
function regions(screen) {
  const rows = screen.rows;
  const panel = panelRows(screen, rows);
  // ONE ROW OF METADATA plus the rule under it. On a terminal too short for
  // both, the rule is what goes: it is a boundary, and a boundary is the most
  // decorative thing left on the screen.
  let headerRows = rows < 14 ? 1 : 2;
  // ---- THE INPUT IS EXACTLY THE ROWS ITS TEXT OCCUPIES -----------------
  //
  // It was `2 + textRows + (pasteSummary ? 1 : 0)`: a top border carrying a
  // label, a bottom border, and sometimes a row describing what had been
  // pasted. Three rows of chrome around one line of text.
  //
  // The border is gone — the grey ground is the region now (ui/inputbox.js) —
  // and the paste summary went with the box that needed it, because a big
  // paste is drawn as one marker rather than as its own rows. So an ordinary
  // prompt is ONE row and the two it used to spend went to the conversation.
  //
  // THE REGION GROWS WITH WHAT IS IN IT, and is bounded hard. A three-row
  // window onto a five-line prompt with a `[3/5]` marker is a prompt you
  // cannot read before sending it; a prompt that could take the whole terminal
  // is a conversation you cannot see while writing about it. Past the cap it
  // scrolls to follow the caret.
  //
  // THE ROWS THE PROMPT ACTUALLY OCCUPIES, wrapped — not how many newlines it
  // contains. A single long sentence is several rows and the region has to
  // grow for it, which is the whole of "long lines must wrap".
  const bufferLines = Math.max(1, screen._wrapped().length);
  const roomForInput = Math.max(1, Math.floor((rows - 8) / 3));
  // ---- A TWO-ROW FLOOR, SO THE COMPOSER IS NOT A STRIP ------------------
  //
  // One row of grey with one row of text in it is correct arithmetic and a
  // cramped place to type: the caret sits on the last line of the terminal with
  // the live row directly above it, and there is no air anywhere. Two rows give
  // the region a shape you can see without drawing a single border around it,
  // which is the whole bet of a borderless composer — hierarchy out of
  // background contrast and whitespace.
  //
  // IT IS A FLOOR, NOT A SIZE. The region still grows with what is in it, still
  // stops at MAX_INPUT_ROWS, and still yields to `roomForInput` on a short
  // terminal — a 9-row window gets one row back, because there the argument for
  // air loses to the argument for seeing the conversation at all.
  // ---- THREE ROWS, SO THE TEXT CAN SIT IN THE MIDDLE OF THEM ------------
  //
  // It was two, which is better than one and still not a region: a prompt drawn
  // on the first of two rows has all of its air on one side. Three gives the
  // text a row above and a row below it (ui/inputbox.js centres it there), which
  // is what makes a borderless composer read as a place rather than as a strip
  // that failed to fill.
  //
  // A LADDER, NOT A CONSTANT. A terminal with room gets three; a cramped one gets
  // two; a very short one gets one, because there the argument for air loses to
  // the argument for seeing the conversation at all.
  const MIN_TEXT_ROWS = rows >= 20 ? 3 : rows >= 14 ? 2 : 1;
  const textRows = Math.max(
    Math.min(MIN_TEXT_ROWS, roomForInput),
    Math.min(bufferLines, require('./inputbox').MAX_INPUT_ROWS, roomForInput),
  );
  // ---- THE EXIT HINT EARNS A ROW, AND ONLY WHILE IT IS ARMED -----------
  //
  // "Press Ctrl+C again to exit" used to be a LABEL ON THE INPUT'S TOP BORDER,
  // which is how it cost nothing. There is no border to hang it on, and it is
  // the one transient message that must be visible at every terminal size —
  // a person pressing Ctrl+C is asking a question and this is the answer.
  //
  // So it takes a row for the two seconds it is armed, like ui/pending.js and
  // ui/jobsview.js take theirs: nothing when there is nothing to say.
  const hintRows = screen.exitHint ? 1 : 0;
  const inputRows = textRows + hintRows;
  // ---- THE LIVE ACTIVITY ROW — ONE ROW, AT EVERY SIZE ------------------
  //
  // It was three on a tall terminal: the live state, plus a trail of the last
  // two completed calls of the turn. §9 is explicit — current activity only,
  // no event history — and the trail was history. It was also a THIRD copy of
  // information the conversation already carries in full and in order, which
  // is what made the bottom of the screen read as a second, worse feed.
  //
  // One row is not a reduced version of three. It is the whole design: a
  // person watching a long turn needs one true sentence about what is
  // happening this second, next to the caret, and the account of what already
  // happened is the region above it.
  let statusRows = 1;
  // WHAT IS GIVEN UP FIRST, in order: the header's rule, then background, then
  // pending, then the live row itself. The conversation keeps at least one row
  // and the INPUT is never touched. A region that refused to shrink pushed the
  // total past the height of the terminal on a short one, which is a region
  // drawn off the bottom of the screen.
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
  if (left() < 1) headerRows = 1;
  // GIVEN UP FIRST. A steer you have typed and not yet sent is more urgent than
  // a status you can get from `/bg`, so this yields before pending does.
  while (jobRows > 0 && left() < 1) jobRows -= 1;
  while (pendingRows > 0 && left() < 1) pendingRows -= 1;
  while (statusRows > 0 && left() < 1) statusRows -= 1;
  const workspace = Math.max(1, left());
  return {
    headerRows, workspace, statusRows, inputRows, textRows, hintRows, panelRows: panel, pendingRows, jobRows,
    // KEPT AS A NAME, not as a second layout. Nothing branches on them any
    // more — the header has one shape — but callers and tests read the object
    // and a missing key reads as `undefined` rather than as "no frame".
    compactHeader: headerRows <= 1,
    framed: false,
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
  // ---- COMMAND OUTPUT MAY TAKE MORE THAN A PICKER --------------------
  //
  // The ceiling was 18 rows, which is about twelve of body once the border,
  // the title, the separator and the footer are taken. That was right when
  // every command printed a handful of lines and the WORKSPACE behind the
  // panel was where documents lived.
  //
  // With one surface the panel IS where a document is read — `/token`,
  // `/brief`, `/ps`, `/help` — and twelve rows put the second half of every
  // one of them below a fold nobody knows is there. Measured on `/token`: 31
  // rows of content, 12 shown, and the line that says whether caching worked
  // at all sat one row past the edge.
  //
  // STILL BOUNDED, and by the same two things it always was: what the content
  // actually needs, and never more than the terminal can spare (the `rows - 6`
  // floor below). It scrolls past this exactly as it did.
  //
  // ---- THE CHROME IS FOUR ROWS NOW, NOT SIX -------------------------------
  //
  // The panel was a box: top border, title, separator, separator, footer, bottom
  // border. It is a list with a title, a blank row, a blank row and a footer
  // (ui/panel.js `render`), so what the content needs is `n + 4`. Asking for six
  // would leave two empty rows under every short menu — which is the dialog's
  // padding outliving the dialog.
  const CHROME = 4;
  const wanted = screen.panel.isCompletion || screen.panel.mode === 'compact'
    ? Math.min(12, Math.max(5, n + CHROME))
    : isOutput
      ? Math.min(Math.max(18, Math.floor(rows * 0.6)), Math.max(5, n + CHROME))
      : Math.min(18, Math.max(6, Math.floor(rows * 0.5)));
  // Never let the panel starve the workspace and input entirely.
  return Math.min(wanted, Math.max(0, rows - 6));
}

module.exports = { regions, panelRows };
