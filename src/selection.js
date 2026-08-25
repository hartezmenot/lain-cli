'use strict';

/**
 * THE INPUT SELECTION — an anchor, a head, and what that means.
 *
 * Split out of input.js, which had grown past the god-object guard. The seam is
 * a real one: that file decodes a byte stream into edits, and this answers one
 * question about the buffer those edits produce — which part of it is selected.
 * It touches no terminal, reads no bytes and knows nothing about keys.
 *
 * WHY THE APPLICATION OWNS A SELECTION AT ALL. The terminal has one, and it is
 * read-only: you can copy text out of the scrollback with it and you cannot
 * change anything. The input box needs one that can be REPLACED, deleted and
 * cut, and that means the application has to track it. See input.js for the
 * cost of that (native selection moves to Shift+drag) and why it is worth it.
 *
 * ANCHOR AND HEAD, NOT START AND END, because a drag has a direction: the
 * anchor is where the button went down and stays put, the head follows the
 * pointer, and dragging backwards past the anchor is an ordinary thing to do.
 * `range()` puts them in buffer order, and it is what everything else reads.
 *
 * AN EMPTY SELECTION IS NO SELECTION. A plain click sets an anchor in case a
 * drag follows; if none does, `active()` is false and the click was simply a
 * caret move. Nothing else has to know the difference.
 */

class Selection {
  constructor() {
    this.anchor = null;
    this.head = null;
  }

  /** Begin one at `at`. Nothing is selected until the head moves away. */
  from(at, max) {
    this.anchor = clamp(at, max);
    this.head = this.anchor;
    return this.anchor;
  }

  /** Move the head. Returns false when there is no selection in progress. */
  to(at, max) {
    if (this.anchor === null) return false;
    this.head = clamp(at, max);
    return true;
  }

  clear() {
    const had = this.active();
    this.anchor = null;
    this.head = null;
    return had;
  }

  active() {
    return this.anchor !== null && this.head !== null && this.head !== this.anchor;
  }

  /** `{start, end}` in buffer order, or null. */
  range() {
    if (!this.active()) return null;
    return { start: Math.min(this.anchor, this.head), end: Math.max(this.anchor, this.head) };
  }
}

function clamp(at, max) {
  const n = Number(at);
  const top = Number.isFinite(max) ? max : Infinity;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(top, n));
}

/**
 * THE CLIPBOARD KEYS, and what a selection changes about them.
 *
 *   Ctrl+C  copies the selection — or INTERRUPTS, when nothing is selected.
 *   Ctrl+X  cuts it.
 *   Ctrl+V  asks the app for the clipboard; the reader cannot read one.
 *
 * CONDITIONING Ctrl+C looks risky and is not. A selection is something the
 * user made a moment ago with the mouse, so the intent is unambiguous, and
 * Escape clears it and hands the key straight back. The alternative — no way
 * to copy out of the input box at all — is what would make application mouse
 * mode (see input.js) a net loss instead of a gain.
 *
 * NOTHING HERE READS OR WRITES A CLIPBOARD. It emits an intention; the app
 * owns the system clipboard, because the app is what already has copy.js.
 *
 * @returns {boolean} true when the key was claimed.
 */
function clipboardKey(reader, ch) {
  const CTRL_C = String.fromCharCode(3);
  const CTRL_X = String.fromCharCode(24);
  const CTRL_V = String.fromCharCode(22);
  if (ch === CTRL_C) {
    if (!reader.hasSelection()) return false;    // it still means interrupt
    reader.emit('clipboard', { action: 'copy', text: reader.selectedText() });
    return true;
  }
  if (ch === CTRL_X) {
    if (reader.hasSelection()) {
      reader.emit('clipboard', { action: 'cut', text: reader.selectedText() });
      reader.deleteSelection();
    }
    return true;
  }
  if (ch === CTRL_V) {
    // Most terminals paste by writing the bytes themselves (bracketed, which
    // the reader already handles). This is for the ones that send the key.
    reader.emit('clipboard', { action: 'paste' });
    return true;
  }
  return false;
}

module.exports = { Selection, clipboardKey };
