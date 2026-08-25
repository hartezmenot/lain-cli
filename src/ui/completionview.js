'use strict';

/**
 * THE TASK-COMPLETE OVERLAY — what is shown when work finishes.
 *
 * Split out of ui/index.js, which reached the god-object guard. The seam is the
 * one every other surface in ui/ follows: that file owns the SCREEN and hands
 * each distinct surface to the module that owns it (ui/story.js, ui/reports.js,
 * ui/menus.js, ui/waiting.js).
 *
 * THE CURSOR IS STATE, NOT A RE-DERIVATION. Up and Down move the highlight and
 * then ask for the report to be drawn again at the new position — the report is
 * never recomputed from anything else, so what the arrows moved and what the
 * screen shows cannot come apart. That is why the redraw is its own function
 * rather than something `showCompletion` does once.
 *
 * WHAT IT CONTAINS is decided by ui/views.js `completion`, from task, evidence
 * and checkpoint state — never from narration, and never from anything the
 * model said about its own work.
 */

const views = require('./views');

/** Open the overlay, with the highlight on the first choice. */
function show(ui, verification = []) {
  ui.screen.completionVerification = verification;
  ui.screen.completionCursor = 0;
  render(ui);
}

/** Redraw the report with the CURRENT cursor. */
function render(ui) {
  ui.screen.completion = views.completion({
    session: ui.app.session,
    checkpoints: ui.app.checkpoints,
    cwd: ui.app.session.cwd,
    verification: ui.screen.completionVerification || [],
    width: ui.screen.cols,
    cursor: ui.screen.completionCursor || 0,
  });
  ui.refresh();
}

/** Take it away, and give the workspace its rows back. */
function dismiss(ui) {
  ui.screen.completion = null;
  ui.screen.completionCursor = 0;
  ui.refresh();
}

module.exports = { show, render, dismiss };
