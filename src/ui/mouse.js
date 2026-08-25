'use strict';

/**
 * THE MOUSE — where a click landed, and what that means.
 *
 * Split from ui/index.js because it is one question with one answer: given a
 * row and a column, which REGION was clicked and what does clicking there do.
 * The reader (input.js) decodes the bytes and knows nothing about the screen;
 * the screen records where it drew each region; this joins the two.
 *
 * IT READS `screen.rowMap`, WHICH `draw()` WROTE. Not `geometry()`. Those two
 * would be the same arithmetic in two places, and the day a row is added to the
 * frame the mouse would quietly start clicking the wrong thing — a defect that
 * shows up as "clicking is slightly off" and is very hard to trace. The map is
 * a record of what was actually drawn.
 *
 * WHAT A CLICK MAY DO. Move the caret, change tab, scroll, or choose the row it
 * landed on in an open panel. It may not submit, run, confirm or destroy
 * anything: a mis-click must never cost the user work. That is also why a click
 * outside an open modal does nothing at all rather than dismissing it.
 */

/**
 * The order comes from ui/tabs.js, so a click and a Tab can never land on
 * different panes — which is exactly what a second copy of this list allowed.
 */
const { VIEWS } = require('./tabs');

/**
 * Where in the tab strip each label sits, derived from the SAME list and the
 * same spacing the strip uses (`[1 context]` for the active one, ` 2 plan ` for
 * the rest). Returns the view under column `x`, or null.
 *
 * Column arithmetic rather than a stored table: the strip is drawn from this
 * list too, so there is one source for both.
 */
function tabAt(view, x) {
  // The strip opens with `┌─`, so labels start at column 3 (1-based).
  let col = 3;
  for (const name of VIEWS) {
    const label = name === view ? `[${VIEWS.indexOf(name) + 1} ${name}]` : ` ${VIEWS.indexOf(name) + 1} ${name} `;
    if (x >= col && x < col + label.length) return name;
    col += label.length;
  }
  return null;
}

/**
 * A click on the INPUT row becomes a caret position.
 *
 * The row draws `│ > ` and then a WINDOW onto the current line, which may be
 * scrolled sideways and may carry a leading `…`. `rowMap` records where that
 * window starts, so the inverse is exact rather than approximate — clicking a
 * character puts the caret on that character, including in a long line that has
 * scrolled and in a multi-line paste.
 */
function caretAt(screen, x, y = null) {
  const m = screen.rowMap || {};
  // WAS COLUMN-ONLY, and assumed the click landed on the line the caret was
  // already on. That held while the box was one row tall. Now that it grows to
  // show a multi-line prompt (), clicking the second line of three put the
  // caret somewhere on the first — so the one feature that lets you fix a
  // prompt without retyping it was wrong on every line but one.
  //
  // `rowMap.inputLines` is written by the loop that actually DREW those rows,
  // so this reads what is on screen rather than recomputing it and being free
  // to disagree with it.
  const rows = Array.isArray(m.inputLines) ? m.inputLines : [];
  const hit = (y !== null && rows.find((r) => r.row === y))
    || rows.find((r) => r.row === m.inputRow)
    || null;
  if (!hit) {
    // Nothing drawn yet, or a row the map does not know. The end of the buffer
    // is the safe answer: it is where typing continues, and it can never land
    // in the middle of a word nobody clicked on.
    return String(screen.inputText || '').length;
  }
  const offset = Math.max(0, x - (m.inputTextCol || 5));
  const within = Math.max(0, Math.min(hit.length, hit.start + offset));
  return hit.begins + within;
}

/**
 * The user message drawn on screen row `y`, or null.
 *
 * ui/feed.js records which drawn line each message landed on (`userAt`), so
 * this is a lookup rather than a second attempt to recognise a message from
 * the painted text — which would have to know about the marker, the padding
 * and the background colour, and would go wrong the day any of them changed.
 */
function recallAt(screen, y) {
  const lines = screen.lastFeedLines;
  if (!lines || !lines.userAt) return null;
  const at = require('./textselect').lineForRow(screen.rowMap, screen.rowMap.feedScroll || 0, y);
  return at == null ? null : (lines.userAt[at] || null);
}

/**
 * THE FILE A FEED ROW NAMES, or null.
 *
 * Same shape as `recallAt` and for the same reason: the click handler must not
 * re-parse painted text to find out what it landed on. `fileAt` is built where
 * the row is drawn (ui/feed.js) and rebased where the pane is assembled
 * (ui/conversation.js).
 */
function fileAt(screen, y) {
  const lines = screen.lastFeedLines;
  if (!lines || !lines.fileAt) return null;
  const at = require('./textselect').lineForRow(screen.rowMap, screen.rowMap.feedScroll || 0, y);
  return at == null ? null : (lines.fileAt[at] || null);
}

/**
 * OPEN WHAT WAS CLICKED.
 *
 * ------------------------------------------------------------------------
 * THE GAP THIS CLOSES. The feed is full of rows that name things —
 * `Read src/loader.js`, `Patched src/parser.js` — and clicking one did
 * nothing at all. `recallAt` resolved USER rows only, so the whole account of
 * what LAIN did was inert: a list of filenames that looked like an index and
 * behaved like a paragraph.
 *
 * WHAT IT OPENS INTO IS NOT NEW. `ui.showRead` is the same temporary window the
 * read tool already opens when LAIN reads a file for itself — it animates in,
 * it dismisses itself, and it is already the established way this program shows
 * a file. Inventing a second viewer for the same content would be two things to
 * keep in step.
 *
 * BOUNDED, because a click is not a reason to load a hundred megabytes into a
 * pane, and SILENT ON FAILURE for a file that has since been deleted or moved:
 * a click that opens nothing is a click that did nothing, which is exactly what
 * it did before. It must never be able to take the session with it.
 */
const MAX_PEEK_BYTES = 400_000;

function openFile(ui, rel) {
  if (!rel || !ui.app || typeof ui.showRead !== 'function') return false;
  const path = require('path');
  const fs = require('fs');
  const base = (ui.app.session && ui.app.session.cwd) || ui.app.cwd || process.cwd();
  const abs = path.isAbsolute(rel) ? rel : path.resolve(base, rel);
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return false;
    const text = st.size > MAX_PEEK_BYTES
      ? fs.readFileSync(abs, 'utf8').slice(0, MAX_PEEK_BYTES)
      : fs.readFileSync(abs, 'utf8');
    ui.showRead(rel, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Act on one decoded mouse event.
 *
 * @param {UI} ui
 * @param {{kind:string, x:number, y:number}} ev
 * @returns {boolean} true when the event was consumed.
 */
function handleMouse(ui, ev) {
  if (!ui.enabled || !ev) return false;
  const screen = ui.screen;
  const m = screen.rowMap;
  if (!m) return false;                       // nothing drawn yet
  const { kind, x, y } = ev;

  // THE INPUT BOX IS THREE ROWS, not one. `inputRow` is where the text sits;
  // the border above and below it belong to the same region as far as a person
  // aiming a wheel is concerned, and requiring pixel accuracy on a one-row
  // target is the same as not offering the feature.
  const overInput = (map, row) => Number.isFinite(map.inputRow)
    && row >= map.inputRow - 1 && row <= map.inputRow + 1;

  // ---- WHEEL ------------------------------------------------------------
  //
  // The wheel acts on WHATEVER IS UNDER IT, and the three things it can be
  // over want three different behaviours:
  //
  //   an open panel   scroll its list
  //   the INPUT box   walk back through what you have typed
  //   anything else   scroll the workspace
  //
  // The middle one was missing: the wheel over the input line scrolled the
  // conversation instead, which is the one place a person is not looking when
  // they reach for their own last prompt. ↑ and ↓ already recall history when
  // the caret is on a single line; this is the same action, from the mouse, in
  // the region that owns it — and it is deliberately NOT coupled to the
  // Context viewport, which keeps its own position while you browse.
  if (kind === 'wheel-up' || kind === 'wheel-down') {
    const delta = kind === 'wheel-up' ? -3 : 3;
    if (ui.panel.visible && m.panelRows > 0 && y >= m.panelStart) {
      ui.panel.scrollBy(delta, Math.max(1, m.panelRows - 6));
      ui.refresh();
      return true;
    }
    const reader = ui.app && ui.app.input;
    if (overInput(m, y) && reader && typeof reader.recallPrev === 'function') {
      if (kind === 'wheel-up') reader.recallPrev();
      else reader.recallNext();
      ui.refresh();
      return true;
    }
    screen.scrollWorkspace(delta);
    return true;
  }

  // ---- DRAGGING INSIDE THE INPUT BOX SELECTS TEXT — ------------------
  //
  // A drag is reported only while a button is held (`?1002h`), so these two
  // kinds arrive ONLY during one. The anchor was set by the press that began
  // it; every motion moves the head; the release simply ends it, and the
  // selection stays until something edits or moves the caret.
  //
  // SHIFT+DRAG STILL BELONGS TO THE TERMINAL. That is how a person copies an
  // error message out of the scrollback, and no application mouse mode should
  // take it — terminals bypass us for it, so it simply never arrives here.
  if (kind === 'drag' || kind === 'release') {
    // ---- A DRAG THAT STARTED IN THE FEED BELONGS TO THE FEED -------------
    //
    // Checked FIRST, because the input box's handler below returns early on
    // anything it does not recognise and would swallow the motion.
    if (screen.textSelection && screen.textSelection.anchor !== null && ui._selectingFeed) {
      if (kind === 'drag') {
        screen.selectTo(x, y);
        ui.refresh();
        return true;
      }
      // RELEASE COPIES. One gesture — highlight, let go, it is on the
      // clipboard — because the alternative is a selection that looks copied
      // and is not, and then a second command to discover it never was.
      ui._selectingFeed = false;
      const text = screen.selectedText();
      // A CLICK, NOT A DRAG: nothing was selected, and the press landed on a
      // message. Put it back on the input line. See `recallAt`.
      if (!text && ui._recallSaid && ui.app && ui.app.input
        && typeof ui.app.input.setLine === 'function') {
        ui.app.input.setLine(ui._recallSaid);
        ui._recallSaid = null;
        if (screen.clearSelection) screen.clearSelection();
        ui.refresh();
        return true;
      }
      // ---- A ROW THAT NAMES A FILE OPENS IT --------------------------
      //
      // Checked AFTER the recall, because a user block is the more specific
      // target: a message that happens to mention a filename is still a
      // message, and putting it back on the input line is what a click on it
      // has always meant.
      if (!text && ui._openFile) {
        const opened = openFile(ui, ui._openFile);
        ui._openFile = null;
        ui._recallSaid = null;
        if (opened) {
          if (screen.clearSelection) screen.clearSelection();
          ui.refresh();
          return true;
        }
      }
      ui._openFile = null;
      ui._recallSaid = null;
      if (text) {
        let ok = false;
        try { ok = require('../copy').toClipboard(text); } catch { ok = false; }
        const lines = text.split('\n').length;
        ui.app.render.notice(ok ? 'info' : 'warn', ok
          ? `Copied ${lines} line(s) — ${text.length} characters.`
          : 'Could not reach the clipboard on this system; the text is still selected.');
      }
      ui.refresh();
      return true;
    }
    const reader = ui.app && ui.app.input;
    if (!reader || typeof reader.selectTo !== 'function') return true;
    const rows = Array.isArray(m.inputLines) ? m.inputLines : [];
    if (!rows.length || reader.selAnchor === null) return true;
    if (kind === 'drag') {
      // CLAMPED TO THE BOX. Dragging up out of it should extend to the start
      // of the prompt rather than doing nothing, which is what an editor does
      // when you drag past the top of the text.
      const above = y < rows[0].row;
      const below = y > rows[rows.length - 1].row;
      const at = above ? 0
        : below ? String(screen.inputText || '').length
          : caretAt(screen, x, y);
      reader.selectTo(at);
      reader.cursor = at;
      ui.refresh();
    }
    return true;
  }

  if (kind !== 'press') return false;

  // ---- AN OPEN PANEL OWNS ITS OWN ROWS ----------------------------------
  //
  // Clicking a row MOVES THE CURSOR to it; it does not choose it. A modal is
  // asking a question, and a stray click must not answer one. Enter still
  // confirms, which keeps the deliberate act deliberate.
  if (ui.panel.visible && m.panelRows > 0 && y >= m.panelStart) {
    const bodyTop = m.panelStart + 3;                 // border, title, separator
    const idx = screen.panel.scroll + (y - bodyTop);
    const item = screen.panel.items[idx];
    if (item && item.selectable !== false) {
      screen.panel.cursor = idx;
      ui.refresh();
      return true;
    }
    return true;                                       // inside the panel: swallow
  }
  // A click OUTSIDE an open modal does nothing at all. Dismissing on an
  // outside click would cancel a question the user may simply have clicked past.
  if (ui.panel.visible && !ui.panel.isCompletion) return true;

  // ---- THE TAB STRIP -----------------------------------------------------
  if (y === m.tabs) {
    const name = tabAt(screen.view, x);
    if (!name) return true;
    screen.setView(name);
    ui.ensureReport(name);
    return true;
  }

  // ---- THE INPUT ROWS ----------------------------------------------------
  //
  // ANY of the box's text rows, not only the one the caret happens to be on.
  // With a growing box that is the difference between "click anywhere in your
  // prompt to fix it" and "click on one line of it".
  const onText = Array.isArray(m.inputLines) && m.inputLines.some((r) => r.row === y);
  if (onText || y === m.inputRow) {
    const app = ui.app;
    if (!app.input) return true;
    const at = caretAt(screen, x, y);
    app.input.cursor = at;
    // THE ANCHOR FOR A DRAG THAT MAY FOLLOW. A press with no drag after it is
    // an empty selection, which `hasSelection` reports as none — so a plain
    // click still just moves the caret.
    if (typeof app.input.selectFrom === 'function') app.input.selectFrom(at);
    // Through the reader's own event, so the screen updates by the one path
    // every other edit uses.
    app.input.emit('edit', app.input.line);
    return true;
  }

  // ---- CLICKING WHAT YOU SAID PUTS IT BACK ON THE INPUT LINE -------------
  //
  // A user message in the feed is drawn as a block on its own ground (see
  // ui/feed.js `userBlock`), and a block that looks like a control should
  // behave like one: click it and the message is on the input line again, ready
  // to be edited and sent. That is the fastest path to "almost that, but…",
  // which otherwise means retyping a paragraph or hunting for it with ↑.
  //
  // ARMED ON THE PRESS, FIRED ON THE RELEASE, and only when nothing was
  // selected in between. Acting on the press would have cost the other gesture
  // that starts the same way: dragging ACROSS your own message to copy a
  // sentence out of it. A press that turns into a drag is a selection and this
  // never fires; a press that lifts where it landed is a click.
  ui._recallSaid = recallAt(screen, y);
  // ARMED THE SAME WAY, for the same reason: a press that turns into a drag
  // is a selection, not a click, and must not open anything.
  ui._openFile = fileAt(screen, y);

  // ---- A PRESS IN THE FEED BEGINS A TEXT SELECTION -----------------------
  //
  // The feed used to swallow clicks entirely, which is why there was no way to
  // get a sentence out of the conversation except by scrolling the terminal's
  // own scrollback — and the workspace is not IN the scrollback: it is
  // repainted in place, so most of what a user wants to copy was never on the
  // glass. See ui/textselect.js.
  //
  // A plain press with no drag after it selects nothing (an empty selection is
  // no selection), so clicking in the feed to dismiss a highlight still works.
  if (screen.selectFrom && screen.selectFrom(x, y)) {
    ui._selectingFeed = true;
    ui.refresh();
    return true;
  }

  // Everywhere else — the header, the status strip — a click is not an action.
  // Consumed so it is never typed as stray bytes. A press that lands off the
  // text also drops any highlight, the way clicking away does everywhere else.
  if (screen.clearSelection && screen.clearSelection()) ui.refresh();
  return true;
}

module.exports = { handleMouse, tabAt, caretAt, VIEWS };
