'use strict';

/**
 * MOVING THE VIEWPORT — the two jumps, and nothing that draws.
 *
 * Split out of ui/layout.js when that file reached the god-object guard, on a seam
 * that was already there: everything left in layout.js PAINTS or POSITIONS, and
 * this decides where the conversation should be looking. It is the same shape
 * ui/textselect.js and ui/geometry.js take — free functions over `screen`, so
 * nothing can quietly start depending on call order through `this`.
 *
 * BOTH REPORT WHETHER THEY MOVED. That is not politeness: a key that reports a
 * jump it did not make is the defect `jumpToAnchor` carries a long comment about,
 * and the only way a caller can fall through to something else is to be told.
 */

/**
 * GO BACK TO ONE EXACT FEED ROW — what clicking the scroll anchor does.
 *
 * Clamped the same way every other scroll is, against the array the row came
 * from, and it reports whether anything moved so a click on an anchor that is
 * already in view falls through instead of silently claiming to have acted.
 * See `jumpToAnchor` below for the bug that taught this file to return false.
 */
function jumpToRow(screen, row) {
  const target = Number(row);
  if (!Number.isFinite(target) || target < 0) return false;
  const feedRows = Math.max(1, screen.geometry().workspace);
  const total = (screen.lastFeedLines && screen.lastFeedLines.length) || 0;
  const maxScroll = Math.max(0, total - feedRows);
  const to = Math.max(0, Math.min(target, maxScroll));
  if (to === screen.workspaceScroll) return false;
  screen.workspaceScroll = to;
  screen.stickToBottom = to >= maxScroll;
  screen.draw();
  return true;
}

function jumpToAnchor(screen, dir) {
  const anchors = require('./anchors').rowsIn(screen.lastFeedLines);
  if (!anchors.length) return false;
  const at = screen.workspaceScroll;
  const target = dir < 0
    ? anchors.filter((r) => r < at).pop()
    : anchors.find((r) => r > at);
  if (target == null) return false;
  // ---- CLAMPED THE SAME WAY EVERY OTHER SCROLL IS ----------------------
  //
  // THE DEFECT, and it made the newest message the one you could not reach.
  // The last anchor sits near the END of the feed, which is BELOW the
  // greatest scroll position that leaves a full window of rows on screen. So
  // `workspaceScroll = target` was silently clamped back by `draw`, the view
  // did not move — and this returned `true` anyway, so Alt+Down reported a
  // jump that had not happened, for ever, at the bottom of every long
  // conversation.
  //
  // Measured: eight anchors at rows 1..57, seven reachable, the eighth
  // claiming success on every press while the scroll stayed at 49.
  //
  // Clamped against THE SAME ARRAY THE ANCHORS CAME FROM. `lastFeedLines` is
  // what `rowsIn` indexed, so its length is the only bound that is guaranteed
  // to agree with the row numbers being jumped to — recomputing the feed here
  // would clamp against a different list than the one the targets came from.
  const feedRows = Math.max(1, screen.geometry().workspace);
  const total = (screen.lastFeedLines && screen.lastFeedLines.length) || 0;
  const maxScroll = Math.max(0, total - feedRows);
  const to = Math.max(0, Math.min(target, maxScroll));
  // ALREADY THERE IS NOT A JUMP. An anchor past the end is on screen at the
  // bottom of the feed; saying "moved" about a screen that did not change is
  // what made this look broken rather than finished.
  if (to === at) return false;
  screen.stickToBottom = to >= maxScroll;
  screen.workspaceScroll = to;
  screen.draw();
  return true;
}

module.exports = { jumpToRow, jumpToAnchor };
