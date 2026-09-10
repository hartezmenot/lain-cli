'use strict';

/**
 * WHICH KEY DOES WHAT — the keyboard, in one place.
 *
 * Split out of ui/index.js, which had grown past the god-object guard again.
 * The seam matches the one ui/menus.js already draws: that file owns the OBJECT
 * — the panel, the screen, the story, the redraw — and this owns the routing of
 * a keystroke through it. They change for different reasons: a new pane is a
 * change here and nowhere else; a new piece of drawn state is a change there
 * and nowhere else.
 *
 * THE ORDER IS THE DESIGN, and it is why this is one function rather than a
 * table. A key means different things depending on what is on screen, and the
 * precedence has been wrong in both directions before:
 *
 *   1. AN OPEN PANEL OWNS THE KEYBOARD. That is what modal means. Tab used to
 *      fall through to the workspace, so a question awaiting an answer could be
 *      tabbed away from while it stayed open behind the pane.
 *   2. THE COMPLETION OVERLAY is next, and every key it NAMES works — it used
 *      to advertise [D] and [R] and do nothing with either. A key it does not
 *      name dismisses it and falls through, because wanting to look at
 *      something else is an answer too.
 *   3. ESCAPE STOPS A RETRY WAIT before Escape means anything else. It is the
 *      one state the UI can put the user in with no way out but Ctrl+C.
 *   4. Everything else is workspace navigation.
 *
 * A completion MENU is deliberately not modal: there Tab means "accept", and
 * the arrows belong to the line being typed. Those cases return false and
 * app.js handles them.
 */

/**
 * @param {UI} ui
 * @param {string} key   a named key from input.js — never a printable character
 * @returns {boolean}    true when the key was consumed by the UI
 */
function handleKey(ui, key) {
  return ROUTE.call(ui, key);
}

/** Bound to the UI so the body reads exactly as it did as a method. */
function ROUTE(key) {
  if (!this.enabled) return false;
  const g = this.screen.geometry();

  // ---- ESCAPE OUT OF A RETRY WAIT OUTRANKS EVERY PANEL --------------------
  //
  // RETRYING is the one state the program puts the user into with no way out
  // but Ctrl+C, so Escape has to leave it cleanly. That was true until command
  // output began opening a panel: a `/status` panel left up while a provider
  // failed would swallow the Escape as "close the panel" and leave LAIN stuck
  // waiting, with the key that was supposed to free it consumed by a box of
  // text. A panel showing something is never more urgent than a wait the user
  // is trying to abandon.
  //
  // A panel with a CALLER behind it is different and is left alone below —
  // Escape there is an answer to a question, not an escape from a wait.
  if (key === 'escape' && this.phase && this.phase.phase === 'RETRYING'
      && (!this.panel.visible || this.panel.isPassive)) {
    if (this.panel.visible) this.panel.close(null);
    return this.cancelRetry();
  }

  // ---- ESCAPE OUT OF A LONG RATE-LIMIT WAIT, THE SAME WAY ------------------
  //
  // `waitingUntil` is RETRYING's sibling, not RETRYING itself: a rate limit
  // long enough to ask about (see ratelimit.js) ends the turn and asks WAIT or
  // CHANGE MODEL, and choosing WAIT opens this second, separate wait — the
  // status strip says so ("Esc to stop waiting"), and until now nothing here
  // read this field at all, so that line was a promise the input reader could
  // not keep: Escape did nothing, and neither did Ctrl+C, because the signal
  // `waitForReset` listens on did not exist yet at the point it started
  // listening (see app.js's `handleRateLimit`). Same priority as RETRYING,
  // for the same reason: a panel showing something is never more urgent than
  // a wait with no other way out.
  if (key === 'escape' && this.waitingUntil && (!this.panel.visible || this.panel.isPassive)) {
    if (this.panel.visible) this.panel.close(null);
    return this.cancelWait();
  }

  // ---- ESCAPE TAKES BACK A STEER YOU HAVE NOT SENT YET --------------------
  //
  // A pending steer is text you typed and LAIN has not handed over. Escape
  // means "not that" — so it comes BACK to the input line, exactly as typed,
  // for editing. Discarding it would lose a correction somebody was halfway
  // through wording, which is the worst thing to lose to a stray keypress.
  //
  // Above the panel handler, because with nothing modal open the pending region
  // is the only thing Escape could be about; below the retry cancel, because
  // being stuck in a wait is the more urgent thing to escape from.
  if (key === 'escape' && !this.panel.visible && this.app.steerQueue && this.app.steerQueue.length) {
    const text = this.app.takeBackSteer();
    if (text != null) {
      // Onto the line THROUGH THE READER, so it arrives as an ordinary edit
      // with a caret at the end — the same path a paste takes. Setting the
      // screen's copy alone would show the text without letting you edit it.
      if (this.app.input) this.app.input.setLine(text);
      else this.setInput(text);
      this.refresh();
      return true;
    }
  }

  // ---- AN ADVISORY IS NOT A PANEL YOU ARE IN ------------------------------
  //
  // Everything below this point assumes an open panel is where the keyboard
  // belongs, which is right for every panel somebody opened on purpose and
  // wrong for the one LAIN raises by itself while the model is working. If it
  // took the keyboard unconditionally, "it has been doing the same thing for
  // a while" would arrive mid-sentence and swallow the Enter that sends the
  // correction it is advising you to make — turning a note into an
  // interruption.
  //
  // So Up/Down/Enter belong to it ONLY while the input line is EMPTY — the
  // same gate ui/index.js's panelShortcut used for the letters this replaced.
  // The moment there is a character typed, this block does nothing and every
  // one of those keys falls straight through to the input, unchanged, exactly
  // as though nothing were showing. Escape always closes it, typed or not,
  // because that is the one key that means "not now" and it is advertised in
  // the footer regardless.
  if (this.panel.visible && this.panel.isAdvisory) {
    if (key === 'escape') {
      this.panel.close(null);
      this.refresh();
      return true;
    }
    const lineEmpty = !(this.app.input && String(this.app.input.line || '').length);
    if (lineEmpty && (key === 'up' || key === 'down')) {
      this.panel.move(key === 'up' ? -1 : 1, 10);
      this.refresh();
      return true;
    }
    if (lineEmpty && key === 'enter') {
      this.panel.select({ key: 'enter' });
      this.refresh();
      return true;
    }
    return false;
  }

  if (this.panel.visible) {
    const rows = Math.max(1, g.panelRows - 6);
    switch (key) {
      case 'up': this.panel.move(-1, rows); this.refresh(); return true;
      case 'down': this.panel.move(1, rows); this.refresh(); return true;
      case 'pageup': this.panel.scrollBy(-rows, rows); this.refresh(); return true;
      case 'pagedown': this.panel.scrollBy(rows, rows); this.refresh(); return true;
      // ENTER PREFERS WHAT YOU TYPED.
      //
      // This used to be `select()` unconditionally, which resolves the
      // HIGHLIGHTED row — so against the options 1-4 a typed `2` answered
      // "1", and the typing vanished with nothing said. A question is the
      // one panel whose answer may not be on the list, so the line is asked
      // about first; an EMPTY line still means "the row I am on", which is
      // what the arrows are for. Every other panel is untouched.
      case 'enter':
        if (this.submitTypedAnswer()) return true;
        this.panel.select({ key: 'enter' }); this.refresh(); return true;
      // → is "go deeper" in a drill-down: on the model list it opens the
      // routes for a model Enter would have committed outright. In a
      // completion menu → accepts, which app.js owns.
      case 'right': if (this.panel.isCompletion) return false; this.panel.select({ key: 'right' }); this.refresh(); return true;
      // ← is "back" in a drill-down, but in a completion menu it is just a
      // cursor key. Completion handles both in app.js.
      // ← is BACK: one level up in a drill-down, and out of the picker when
      // there is no level to go up to. Backspace is left alone to edit text,
      // so neither key does two jobs.
      case 'left':
        if (this.panel.isCompletion) return false;
        if (this.panel.stack.length > 1) this.panel.back();
        else this.panel.close(null);
        this.refresh();
        return true;
      // ESCAPE ASKS THE FRAME FIRST. On the ask_user MCQ it opens the detailed
      // explanations, and from there it returns to the choices with the
      // question and the highlighted option intact; everywhere else it still
      // closes having chosen nothing. See InteractionPanel.escape.
      case 'escape':
        if (!this.panel.escape()) this.panel.close(null);
        this.refresh();
        return true;
      // A MODAL PANEL OWNS TAB. It fell through to the workspace, so a
      // question waiting for an answer could be tabbed away from while it
      // stayed open behind the pane — the invisible modal state again, from
      // the other direction. A completion MENU is not modal and still lets
      // Tab through, because there Tab means "accept".
      case 'tab': case 'shift-tab':
        if (this.panel.isCompletion) return false;
        this.refresh();
        return true;
      default: return false;
    }
  }

  if (this.screen.completion) {
    // THE TASK-COMPLETE OVERLAY IS A REPORT, NOT A PLACE.
    //
    // It used to offer a CHOICE — `diff` or `keep working` — navigated with
    // Up/Down and taken with Enter, and the first branch switched panes. With
    // one surface there is nowhere to switch to, so both branches meant the
    // same thing: put the report away.
    //
    // So every key dismisses it. Esc because that is what Esc does; a
    // navigation or editing key because pressing one is an explicit request to
    // look at something else; and a printable character because you have
    // started composing. What changed is `/changes`, which the report names.
    if (key === 'escape' || key === 'enter') { this.dismissCompletion(); return true; }
    this.dismissCompletion();
    return false;
  }

  // ESCAPE STOPS A RETRY WAIT, before Escape means anything else. It is the
  // one state the UI puts the user in with no way out but Ctrl+C, and the
  // brief is explicit that Escape must leave cleanly rather than leaving LAIN
  // stuck in RETRYING.
  if (key === 'escape' && this.phase && this.phase.phase === 'RETRYING') return this.cancelRetry();

  switch (key) {
    case 'pageup': this.screen.scrollWorkspace(-(g.workspace - 2)); return true;
    case 'pagedown': this.screen.scrollWorkspace(g.workspace - 2); return true;
    // ALT+↑ / ALT+↓ — the previous or next thing the USER said. Paging is the
    // wrong granularity for scrolling back through an hour of work: what
    // somebody is looking for is their own instruction, their own decision, or
    // the log they pasted. See ui/anchors.js and ui/layout.js `jumpToAnchor`.
    case 'alt-up': return this.screen.jumpToAnchor(-1);
    case 'alt-down': return this.screen.jumpToAnchor(1);
    // HOME/END BELONG TO WHATEVER YOU ARE EDITING. With text on the input
    // line they move the caret within it — the reason they exist on a
    // keyboard — and only with an empty line do they jump the workspace to
    // the top or back to the bottom. Tab and Enter already split this way.
    case 'home':
      if (this.screen.inputText) return false;
      this.screen.workspaceScroll = 0; this.screen.stickToBottom = false; this.refresh(); return true;
    case 'end':
      if (this.screen.inputText) return false;
      this.screen.stickToBottom = true; this.refresh(); return true;
    // ---- ALT+1..9 AND CTRL+1..9 ARE NO LONGER BOUND ---------------------
    //
    // They selected one of nine panes by its number in the strip. The strip is
    // gone and so are the panes, so a binding here would be a key that changes
    // nothing — which is worse than an unbound key, because the user cannot
    // tell it from a key that is broken.
    //
    // Tab and Shift+Tab are unbound in src/repl.js for the same reason.
    // Esc used to back out of an opened diff first. There is no diff pane to
    // be inside any more, so Esc falls through to whatever else claims it.
    default: return false;
  }
}

module.exports = { handleKey };
