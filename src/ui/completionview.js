'use strict';

/**
 * THE TASK-COMPLETE OVERLAY — what is shown when work finishes.
 *
 * Split out of ui/index.js, which reached the god-object guard. The seam is the
 * one every other surface in ui/ follows: that file owns the SCREEN and hands
 * each distinct surface to the module that owns it (ui/story.js, ui/reports.js,
 * ui/menus.js, ui/waiting.js).
 *
 * ------------------------------------------------------------------------
 * THERE IS NO CURSOR ANY MORE, and that is the whole of what changed here.
 *
 * The report used to offer a CHOICE — `❯ diff` or `❯ keep working` — with Up and
 * Down moving a highlight and Enter taking it. The first branch switched to the
 * DIFF pane; with one surface there is nowhere to switch to, so both branches
 * meant the same thing: put the report away.
 *
 * So the report names `/changes` instead — a command that exists, typed when you
 * want it — and every key dismisses it (ui/keys.js). `render` stays a function
 * of its own because `show` and a later redraw must produce the same report.
 *
 * WHAT IT CONTAINS is decided by ui/views.js `completion`, from task, evidence
 * and checkpoint state — never from narration, and never from anything the
 * model said about its own work.
 */

const views = require('./views');

/** Open the overlay. */
function show(ui, verification = []) {
  ui.screen.completionVerification = verification;
  render(ui);
}

/** Compose the report and put it on the screen. */
function render(ui) {
  ui.screen.completion = views.completion({
    session: ui.app.session,
    checkpoints: ui.app.checkpoints,
    cwd: ui.app.session.cwd,
    verification: ui.screen.completionVerification || [],
    width: ui.screen.cols,
  });
  ui.refresh();
}

/** Take it away, and give the workspace its rows back. */
function dismiss(ui) {
  ui.screen.completion = null;
  ui.refresh();
}

module.exports = { show, render, dismiss };
