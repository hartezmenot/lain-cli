'use strict';

/**
 * THE UNDO STACK — what an edit LEAVES BEHIND.
 *
 * Split out of input.js, which had grown past the god-object guard, the same
 * way selection.js and lineedit.js already were. The seam is the same kind:
 * this touches no terminal, decodes no bytes and knows nothing about keys —
 * it is two stacks of `{line, cursor, selAnchor, selHead}` snapshots and the
 * rule for when a new one is taken instead of merged into the last.
 *
 * COALESCING. A RUN of the same kind of edit — ordinary typing, or single-
 * character deletes in the same direction — shares the ONE snapshot taken at
 * the start of the run, which is what makes "type five characters, Ctrl+Z
 * once" undo all five rather than one. Anything else (a paste, a word-delete,
 * a selection replaced) always takes its own snapshot, because it is one
 * action a person did, however much text it moved. See COALESCE_KINDS.
 *
 * THE CALLER DECIDES WHEN A RUN BREAKS, by calling `break()` — an arrow key, a
 * new selection starting, anything that is not itself an edit. Without that,
 * typing, moving the caret away, and typing again would read back as one
 * continuous insert, because both runs share the same `kind` string.
 */

/** Edit kinds that COALESCE: a run of them shares one undo step, not one each. */
const COALESCE_KINDS = new Set(['insert', 'delete-back', 'delete-fwd']);

class UndoStack {
  constructor({ max = 100 } = {}) {
    this.max = max;
    this.undo = [];
    this.redo = [];
    this.kind = null;
  }

  /**
   * Record the state an edit of `kind` is about to leave behind — unless it is
   * a continuation of the same kind of run already in progress.
   *
   * @param {object} snapshot  `{line, cursor, selAnchor, selHead}` BEFORE the edit
   */
  push(snapshot, kind) {
    // A REAL EDIT CUTS OFF REDO — once something new has been done, "redo" no
    // longer has a future to replay, the same rule every editor uses.
    this.redo.length = 0;
    if (this.undo.length && this.kind === kind && COALESCE_KINDS.has(kind)) return;
    this.undo.push(snapshot);
    if (this.undo.length > this.max) this.undo.shift();
    this.kind = kind;
  }

  /** Break a coalescing run without touching either stack. */
  break() { this.kind = null; }

  /** Forget everything — the line was replaced wholesale, not edited. */
  reset() { this.undo.length = 0; this.redo.length = 0; this.kind = null; }

  /** @returns {object|null} the snapshot to restore, or null if there is none. */
  popUndo(current) {
    if (!this.undo.length) return null;
    const prev = this.undo.pop();
    this.redo.push(current);
    this.kind = null; // whatever comes next starts a fresh run
    return prev;
  }

  /** @returns {object|null} the snapshot to restore, or null if there is none. */
  popRedo(current) {
    if (!this.redo.length) return null;
    const next = this.redo.pop();
    this.undo.push(current);
    this.kind = null;
    return next;
  }
}

module.exports = { UndoStack, COALESCE_KINDS };
