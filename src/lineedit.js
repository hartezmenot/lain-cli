'use strict';

/**
 * THE LINE EDITOR — what an edit DOES to the buffer.
 *
 * Split out of input.js, which had reached the god-object guard. The seam is a
 * real one and it is the seam that file is built around: input.js turns a byte
 * stream into named edits (paste brackets, escape sequences, partial reports),
 * and this decides what each named edit means to a string and a caret.
 *
 * Nothing here touches the terminal, reads stdin or knows about escape codes.
 * It is a string, an offset and a selection — which is why the whole editor is
 * testable without a TTY.
 *
 * FREE FUNCTIONS OVER THE READER, not methods: the architecture guard requires
 * an extracted helper never to use `this`, and an editor that reached back
 * through `this` could quietly begin depending on call order.
 */

/**
 * The keys that belong to the LINE EDITOR, in one place.
 *
 * ←/→ and Home/End move the caret; ↑/↓ walk the lines of a multi-line buffer
 * when there is one and otherwise recall history. Returns true when the key
 * was consumed, so the REPL can route what is left to the workspace.
 */
function editKey(r, key) {
  switch (key) {
    case 'left': r.moveCursor(-1); return true;
    case 'right': r.moveCursor(1); return true;
    case 'home': r.cursorHome(); return true;
    case 'end': r.cursorEnd(); return true;
    case 'up': if (!r.moveCursorLine(-1)) r.recallPrev(); return true;
    case 'down': if (!r.moveCursorLine(1)) r.recallNext(); return true;

    // ---- WHOLE-BUFFER HOME/END — Ctrl+Home, Ctrl+End -----------------------
    // Plain Home/End are LINE-aware (see cursorHome/cursorEnd) because a
    // pasted block is many lines in a one-row box; these reach past that, to
    // the very start or end of the buffer, which a multi-line prompt has no
    // other way to jump to.
    case 'ctrl-home': r.moveCursorTo(0); return true;
    case 'ctrl-end': r.moveCursorTo(r.line.length); return true;

    // ---- FORWARD DELETE ---------------------------------------------------
    // Backspace already worked; this did nothing at all. `ESC[3~` is a
    // well-formed CSI sequence, so it was CONSUMED rather than typed — and a
    // consumed key with no handler is a key that silently does not exist.
    case 'delete': r.deleteForward(); return true;
    // Ctrl+Delete: the same, one word at a time — Ctrl+Backspace's mirror.
    case 'ctrl-delete': r.deleteWordForward(); return true;

    // ---- WORD MOVEMENT ----------------------------------------------------
    case 'word-left': r.moveCursorTo(r.wordBoundary(-1)); return true;
    case 'word-right': r.moveCursorTo(r.wordBoundary(1)); return true;

    // ---- SELECT ALL — Ctrl+A ------------------------------------------------
    case 'ctrl-a': return selectAll(r);

    // ---- UNDO / REDO — Ctrl+Z / Ctrl+Y --------------------------------------
    // Named here, not in input.js, only because every OTHER named edit is —
    // the stacks and the mechanics live on the reader; see input.js's own
    // "UNDO / REDO" section for why.
    case 'ctrl-z': return r.undo();
    case 'ctrl-y': return r.redo();

    // ---- SELECTION FROM THE KEYBOARD --------------------------------------
    // Each of these EXTENDS whatever selection exists rather than starting a
    // new one, which is what makes Shift+← held down select a growing run
    // instead of the same single character over and over.
    case 'shift-left': r.extendSelection(r.cursor - 1); return true;
    case 'shift-right': r.extendSelection(r.cursor + 1); return true;
    case 'shift-home': r.extendSelection(r.lineStart()); return true;
    case 'shift-end': r.extendSelection(r.lineEnd()); return true;
    case 'shift-word-left': r.extendSelection(r.wordBoundary(-1)); return true;
    case 'shift-word-right': r.extendSelection(r.wordBoundary(1)); return true;
    case 'shift-up': case 'shift-down': {
      // Where ↑/↓ WOULD land, then select to there — so selecting by line
      // uses the one implementation that already knows about the lines.
      const from = r.cursor;
      if (!r.moveCursorLine(key === 'shift-up' ? -1 : 1)) return true;
      const to = r.cursor;
      r.cursor = from;
      r.extendSelection(to);
      return true;
    }
    default: return false;
  }
}

/** The offset of the start of the line the caret is on. */
function lineStart(r) {
  const nl = r.line.lastIndexOf('\n', Math.max(0, r.cursor - 1));
  return nl < 0 ? 0 : nl + 1;
}

/** The offset of the end of the line the caret is on. */
function lineEnd(r) {
  const nl = r.line.indexOf('\n', r.cursor);
  return nl < 0 ? r.line.length : nl;
}

/**
 * Where the caret lands moving one WORD in `dir` (-1 back, +1 forward).
 *
 * THE SAME RULE `deleteWord` USES, deliberately: skip the whitespace, then
 * take the run — word characters or punctuation, never a mixture. Moving over
 * a word and deleting a word must agree about where the word ends, so there
 * is one definition of it in this file and both callers read it.
 */
function wordBoundary(r, dir) {
  const isWord = (c) => /[A-Za-z0-9_]/.test(c);
  const n = r.line.length;
  let i = r.cursor;
  if (dir < 0) {
    while (i > 0 && /\s/.test(r.line[i - 1])) i -= 1;
    if (i > 0) {
      const cls = isWord(r.line[i - 1]);
      while (i > 0 && !/\s/.test(r.line[i - 1]) && isWord(r.line[i - 1]) === cls) i -= 1;
    }
    return i;
  }
  while (i < n && /\s/.test(r.line[i])) i += 1;
  if (i < n) {
    const cls = isWord(r.line[i]);
    while (i < n && !/\s/.test(r.line[i]) && isWord(r.line[i]) === cls) i += 1;
  }
  return i;
}

/** Put the caret at an absolute offset, ending any selection. */
function moveCursorTo(r, at) {
  return r.moveCursor(Math.max(0, Math.min(r.line.length, at)) - r.cursor);
}

/**
 * Grow the selection to `at` and take the caret with it.
 *
 * ANCHORED ONCE. Without the `hasSelection` guard every Shift+arrow would
 * drop a fresh anchor at the caret and then move one place — a selection
 * permanently one character long however long the key is held.
 */
function extendSelection(r, at) {
  const to = Math.max(0, Math.min(r.line.length, at));
  if (!r.hasSelection()) r.selectFrom(r.cursor);
  r.cursor = to;
  r.selectTo(to);
  r.emit('edit', r.line);
  return true;
}

/**
 * DELETE FORWARD — the selection if there is one, otherwise the character
 * after the caret. A newline goes like any other character, which is what
 * joins two lines of a multi-line prompt.
 */
function deleteForward(r) {
  if (r.deleteSelection()) return true;    // takes its own undo snapshot
  if (r.cursor >= r.line.length) return false;
  r._pushUndo('delete-fwd');
  r.line = r.line.slice(0, r.cursor) + r.line.slice(r.cursor + 1);
  if (r.line === '') r.pastedInLine = false;
  r.emit('edit', r.line);
  return true;
}

/**
 * DELETE THE NEXT WORD — Ctrl+Delete, the mirror of Ctrl+Backspace
 * (`deleteWord` in input.js). Same rule, run the other direction: eat the
 * whitespace right after the caret, then the run that follows it — word
 * characters or punctuation, never mixed.
 */
function deleteWordForward(r) {
  if (r.deleteSelection()) return true;
  const to = wordBoundary(r, 1);
  if (to === r.cursor) return false;
  r._pushUndo('delete-word');
  r.line = r.line.slice(0, r.cursor) + r.line.slice(to);
  if (r.line === '') r.pastedInLine = false;
  r.emit('edit', r.line);
  return true;
}

/** Ctrl+A — select the whole buffer, caret landing at the end. */
function selectAll(r) {
  if (!r.line.length) return true;         // nothing to select, and nothing to break
  r.selectFrom(0);                          // also breaks any coalescing run — see input.js
  r.cursor = r.line.length;
  r.selectTo(r.line.length);
  return true;
}

/** Home / End — to the start or the end of the CURRENT line (paste is multi-line). */
function cursorHome(r) {
  r._undoBreak();
  const nl = r.line.lastIndexOf('\n', Math.max(0, r.cursor - 1));
  r.cursor = nl < 0 ? 0 : nl + 1;
  r.emit('edit', r.line);
}

function cursorEnd(r) {
  r._undoBreak();
  const nl = r.line.indexOf('\n', r.cursor);
  r.cursor = nl < 0 ? r.line.length : nl;
  r.emit('edit', r.line);
}

module.exports = {
  editKey, lineStart, lineEnd, wordBoundary, moveCursorTo, extendSelection,
  deleteForward, deleteWordForward, cursorHome, cursorEnd, selectAll,
};