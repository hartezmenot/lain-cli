'use strict';

/**
 * THE STORY OF THE CURRENT TASK — what was said, by whom, and what was done.
 *
 * Split out of ui/index.js, which had grown past the god-object guard. The seam
 * is the one this batch is built around: that file owns the SCREEN — panels,
 * keys, regions, redraws — and this owns the CONTENT those regions render. They
 * are different jobs and they change for different reasons.
 *
 * Everything here is bounded, and everything here is a record of something that
 * ALREADY HAPPENED. Nothing in this file calls a model, contacts a provider, or
 * decides anything about the turn.
 *
 * THE TWO LIFETIMES, which is the whole reason this is a class and not a list:
 *
 *   PER TURN   the calls and the prose of the turn in flight. `session.turns`
 *              only gains its entry when a turn ENDS, so without these the feed
 *              is empty for the entire time the work is happening. Handed back
 *              to the persisted record at endTurn().
 *
 *   PER TASK   what the other actors said. An external review and a desktop
 *              action happen BETWEEN turns; they belong to no turn record, and
 *              clearing them at endTurn would erase round 1 of a relay the
 *              moment LAIN acted on it.
 *
 * THE SECOND OF THOSE HAS MOVED to `session.actors`, and the move is the point:
 * held here it was lost on `/resume`, so a session came back with its
 * transcript, its objective and its changed files while the external review
 * that produced half of them was simply gone. It is part of the task's story,
 * not part of the screen, so the session owns it and it is written to disk with
 * everything else. The UI still reads it under the same name — see ui/index.js.
 */

/** Bound on each feed, matching what a turn record itself keeps. */
const MAX = 200;

class Story {
  constructor() {
    /** Finished calls of the turn in flight. */
    this.actions = [];
    /** Prose the model produced this turn, interleaved with the calls. */
    this.narration = [];
    /** The message this turn is about, shown from the instant it is submitted. */
    this.user = null;
    /** Bounded shell and test output for the OUTPUT surface. */
    this.outputs = [];
    /**
     * What the PROGRAM said this turn — a liveness warning, a block, a notice.
     *
     * Anchored the same way narration is, so it renders where it happened
     * rather than in a block underneath the whole conversation. Cleared with
     * the turn: these are advice to the model about the turn in flight, and a
     * warning about a loop that has already ended is not news. The one note
     * that OUTLIVES its turn — an interruption — is written to session.actors
     * instead, because that is a durable fact about the task.
     */
    this.notes = [];
  }

  /** A new turn: whatever the last one was doing is no longer the news. */
  beginTurn() {
    this.actions = [];
    this.narration = [];
    this.notes = [];
  }

  /**
   * The turn is over: hand the feed back to the persisted record.
   *
   * `runTurn` appends the turn to `session.turns` before it yields `done`, so
   * there is no frame in which both are absent — and keeping both would render
   * every call of the turn twice. `extras` deliberately survives.
   */
  endTurn() {
    this.actions = [];
    this.narration = [];
    this.notes = [];
    this.user = null;
  }

  /** A genuinely new task: the previous task's story is no longer the news. */
  newTask() {
    this.user = null;
  }

  /**
   * @param {string} text  what is being worked on right now
   * @param {?string} from WHO ASKED. Null for the person at the keyboard, which
   *   is almost always. Set when LAIN continues its own work — the turn an
   *   external consultation hands back, a rate-limit resume — so the feed can
   *   draw a continuation as a continuation instead of claiming the user typed
   *   six hundred characters they never typed.
   */
  setUser(text, from = null) {
    this.user = String(text || '').trim() || null;
    this.userFrom = this.user ? (from || null) : null;
  }

  noteAction(a) {
    if (this.actions.length < MAX) this.actions.push(a);
  }

  /**
   * `at` IS WHEN IT ARRIVED, and the presentation layer needs it.
   *
   * A paragraph is resolved on screen from the moment it was said (see
   * ui/reveal.js), so the clock reading has to be taken HERE — at the one
   * instant it is true — rather than inferred later from a position in a list.
   * It is a display stamp and nothing else: the text, the order and the anchor
   * are unchanged, and a record without one is simply drawn settled.
   */
  noteNarration(text, at = Date.now()) {
    const t = String(text || '').trim();
    if (t && this.narration.length < MAX) {
      this.narration.push({ text: t, after: this.actions.length, at });
    }
  }

  /** One line from the program itself, placed where it was said. */
  noteSystem(text, level = 'info') {
    const t = String(text || '').trim();
    if (t && this.notes.length < MAX) this.notes.push({ text: t, level, after: this.actions.length });
  }

  /** Command output, for the OUTPUT surface. Bounded — never unbounded growth. */
  noteOutput(command, output, exitCode) {
    this.outputs.push({ command, output: String(output || '').slice(0, 20000), exitCode });
    if (this.outputs.length > 20) this.outputs.shift();
  }
}

module.exports = { Story, MAX };
