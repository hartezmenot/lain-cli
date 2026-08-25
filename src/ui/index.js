'use strict';

/**
 * UI WIRING — the single place the App talks to the terminal UI.
 *
 * It exists so `app.js` stays the REPL shell and gains no drawing code, and so
 * commands never learn about regions or cursors: a command asks for a PANEL with
 * an adapter, or asks the UI to refresh, and that is all.
 *
 * Every value shown is read from state that already exists. Nothing here calls a
 * model, and there is no timer or polling loop — the UI redraws when the app
 * says something changed.
 */

const { Screen } = require('./layout');
const views = require('./views');
const panelMod = require('./panel');
const termtitle = require('../termtitle');

/** Bound on the in-flight feed, matching what a turn record itself keeps. */
const MAX_LIVE = 200;
/** How much of an actor's own words one entry carries for the dashboard. */
const MAX_DETAIL_LINES = 200;

class UI {
  constructor(app) {
    this.app = app;
    this.panel = new panelMod.InteractionPanel();
    this.screen = new Screen({ out: app.render.out, panel: this.panel });
    /**
     * THE STORY OF THE CURRENT TASK — what was said, by whom, and what was
     * done. This object owns the SCREEN; that one owns the CONTENT. See
     * ui/story.js, which also explains the two lifetimes involved.
     */
    this.story = new (require('./story').Story)();
    this.busy = false;
    this.enabled = false;
    this.running = null;      // the tool call in flight, for the ACTIVITY view
    this.startedAt = 0;       // when the current turn began, for elapsed time
    /**
     * THE LIVE EXECUTION PHASE, straight from the turn loop — the single source
     * of truth for "what is LAIN doing right now". Never inferred, never
     * guessed; `null` means nothing is running and the live row disappears.
     */
    this.phase = null;
    this.phaseSince = 0;
    this.interrupting = false;
    this._tick = null;
    // ---- THE ACTIVITY TIMELINE — see ui/activity.js ----------------------
    //
    // PRESENTATION ONLY. It is a pure function of (events, clock), nothing in
    // the turn loop awaits it, and `instant` collapses it to its final state
    // without changing a single fact it reports.
    //
    // ANIMATED ONLY WHEN THERE IS A SCREEN TO ANIMATE: a pipe gets `instant`,
    // which keeps `lain -p` output plain and keeps the tests reading the same
    // account either way.
    const still = !(process.stdout.isTTY || process.env.LAIN_FORCE_TUI === '1');
    this.activity = new (require('./activity').ActivitySurface)({ instant: still });
  }


  // The story's feeds, by their existing names, so no caller had to change.
  get liveActions() { return this.story.actions; }
  get liveNarration() { return this.story.narration; }
  get liveNotes() { return this.story.notes; }
  get liveUser() { return this.story.user; }
  get liveFrom() { return this.story.userFrom || null; }
  get outputs() { return this.story.outputs; }

  /**
   * WHAT THE OTHER ACTORS SAID, read from the SESSION — see session.js.
   *
   * It was held on this object and was therefore lost on `/resume`. The name
   * is unchanged so no caller had to move with it.
   */
  get extras() { return this.app.session.actors || []; }

  setLiveUser(text, from = null) { this.story.setUser(text, from); this.refresh(); }
  noteAction(a) {
    this.story.noteAction(a);
    // The real numbers land here — the timeline’s counters have been climbing
    // towards them, and this is what they land ON.
    this.activity.end(a);
    this._syncTicker();
    this.refresh();
  }

  // AN EDIT PERFORMS ITS CHANGE; A READ ONLY LOOKS THROUGH THE FILE. Both open
  // the same temporary window and close it themselves — see ui/diffreel.js for
  // why those are two different animations. Neither is ever waited on.
  showDiff(file, before, after) { this.activity.showDiff(file, before, after); this._syncTicker(); this.refresh(); }

  showRead(file, text) { this.activity.showRead(file, text); this._syncTicker(); this.refresh(); }

  /**
   * The real +/- for the edit that just finished, read from the checkpoint.
   * They arrive a moment after the tool result — see turnevents.js noteEdit.
   */
  noteEditCounts(added, removed) {
    this.activity.counts(added, removed);
    // ONLY THE CARD. The durable counts come from the CHECKPOINT, onto the turn
    // record, at the moment the call finishes — see describe.js `editSize`.
    // Patching the live copy here as well put the same numbers on screen twice
    // from two sources, and the live one lost them the instant the turn ended.
    this._syncTicker();
  }
  /**
   * PROSE THE MODEL PRODUCED, ON SCREEN AS SOON AS IT IS A COMPLETE THOUGHT.
   *
   * This did NOT redraw, and prose was only flushed at the next tool result —
   * which is why a working session could show nothing but search/read/search.
   * The ticker call puts the clock on 60Hz while the paragraph RESOLVES
   * (ui/reveal.js); on the slow tick a sentence arrives in four visible steps.
   */
  noteNarration(text) { this.story.noteNarration(text); this._syncTicker(); this.refresh(); }

  /** A liveness warning, a block, a notice — the program speaking, quietly. */
  noteSystem(text, level = 'info') { this.story.noteSystem(text, level); this.refresh(); }

  /**
   * One line from an actor that is not LAIN's own turn — the external reviewer,
   * or the desktop bridge.
   *
   * `afterTurns` is stamped here, from the turn count as it stands right now.
   * That is what lets Context replay the story IN ORDER: without it every
   * review was appended after ALL turns, so round 1 of a relay drew BELOW the
   * LAIN turn that acted on it and the conversation read backwards.
   */
  /**
   * @param {string[]} [o.detail]  the FULL text this line summarises.
   *
   * WHY A SUMMARY AND A DETAIL, rather than one line per line. `extras` is what
   * ui/conversation.js draws, one row per entry — so pushing an external
   * reply through here line by line put the whole of somebody else's prose into
   * the conversation. The entry now says what happened; `detail` carries what
   * was said, for the dashboard and for the saved session, and the feed draws
   * only `text`. See externalrequest.dispatch.
   */
  noteActor(kind, text, { detail = null } = {}) {
    const t = String(text || '').trim();
    if (!t) return;
    const list = this.app.session.actors;
    if (!Array.isArray(list) || list.length >= MAX_LIVE) return;
    const e = { kind, text: t, afterTurns: (this.app.session.turns || []).length };
    if (Array.isArray(detail) && detail.length) e.detail = detail.slice(0, MAX_DETAIL_LINES);
    list.push(e);
    this.refresh();
  }

  noteOutput(command, output, exitCode) { this.story.noteOutput(command, output, exitCode); this.refresh(); }

  /** A genuinely new task: the previous task's story is no longer the news. */
  // ---- THE TURN'S STATE MACHINE lives in ui/turnstate.js -----------------
  //
  // Five ways for a turn to end and none of them allowed to be silent. Moved
  // out when this file reached the architecture guard; see that file's header
  // for why it is a real seam rather than a place to put lines.
  clearExtras() { return require('./turnstate').clearExtras(this); }
  beginTurn() { return require('./turnstate').beginTurn(this); }
  endTurn() { return require('./turnstate').endTurn(this); }
  setRunning(name, target) { return require('./turnstate').setRunning(this, name, target); }
  setPhase(next) { return require('./turnstate').setPhase(this, next); }
  setInterrupting(on) { return require('./turnstate').setInterrupting(this, on); }
  setInterrupted(on) { return require('./turnstate').setInterrupted(this, on); }
  setFailed(on) { return require('./turnstate').setFailed(this, on); }

  /**
   * THE REDRAW TICKER — the one timer in the program, and it fabricates nothing.
   *
   * It exists because a genuinely slow provider produces no events for minutes:
   * without a redraw the elapsed count freezes and the screen becomes
   * indistinguishable from a dead one, which is precisely the failure this work
   * is here to fix.
   *
   * What keeps it honest:
   *   - It runs ONLY while a real phase is in flight, and stops the instant the
   *     turn ends. It cannot animate when nothing is happening.
   *   - It redraws EXISTING state. It never advances progress, never invents a
   *     step, never contacts a provider and costs zero tokens.
   *   - It is unref'd, so it can never hold the process open.
   */
  /**
   * WAIT OUT A RATE LIMIT, VISIBLY, AND CARRY ON BY ITSELF.
   *
   * The strip shows `WAITING FOR LIMIT RESET  3h 59m` where THINKING and
   * RUNNING appear, counting down — because a LAIN that is deliberately waiting
   * and a LAIN that has died look identical otherwise, and here the difference
   * lasts hours rather than seconds.
   *
   * NOT A BUSY LOOP. One timer that resolves at the deadline; the redraw ticker
   * that already exists paints the clock. Nothing is polled and no request is
   * made while it waits.
   *
   * ESCAPE OR CTRL+C ENDS IT, through the same abort signal everything else is
   * cancelled by rather than a second mechanism. A four-hour wait is a decision
   * somebody may reverse ten minutes later, and a wait you cannot leave is a
   * hang with a countdown on it.
   *
   * @returns {Promise<boolean>} true if it waited to the end, false if abandoned
   */
  waitForReset(resumeAt, o = {}) { return require('./waiting').waitForReset(this, resumeAt, o); }

  /**
   * THE REDRAW CLOCK, and it has two speeds.
   *
   * A spinner and an elapsed count need four frames a second; a timeline being
   * played back needs more than that to move smoothly. So the ticker runs at
   * FRAME_MS while anything is animating and drops back to TICK_MS when the
   * only thing changing is a number.
   *
   * IT ALSO RUNS AFTER THE TURN. Playback is deliberately behind reality, so
   * when the work finishes there is usually still a timeline to finish showing
   * and a diff window to close. Stopping the clock the moment the phase cleared
   * would freeze the last few operations mid-animation — which is exactly the
   * "everything appeared at once and then stopped" behaviour this replaces.
   *
   * COSTS NOTHING WHEN NOTHING MOVES: an identical frame is not written
   * (ui/layout.js), so a faster clock over a still screen is a string compare.
   */
  _syncTicker() { return require('./activity').syncTicker(this); }

  /**
   * THE STATE THE STATUS STRIP DRAWS — collected in one place, derived nowhere
   * else. Everything in it already exists on this object or in the session; the
   * strip is a rendering of facts, not a second record of them.
   */
  // ---- WHAT THE SCREEN IS TOLD lives in ui/projection.js ----------------------
  //
  // Pure projection: it reads the app and returns a plain object. Kept out of
  // this file so the methods that CHANGE state and the functions that merely
  // describe it are not interleaved. These four are the whole surface.
  statusState() { return require('./projection').statusState(this); }
  snapshot() { return require('./projection').frameState(this); }
  lastSessionToken() { return require('./projection').lastSessionToken(this); }
  readiness(pc) { return require('./projection').readiness(this, pc); }
  changedCount() { return require('./projection').changedCount(this); }
  _title(s) { return require('./projection').title(this, s); }


  /**
   * ESCAPE DURING A RETRY WAIT — stop waiting, keep everything else.
   *
   * A rate-limit wait is the one state where the user is being asked to sit
   * still with no way out short of Ctrl+C, and Ctrl+C is a bigger hammer than
   * "I don't want to wait for this". The turn is aborted the same way, but the
   * resting state says RETRY CANCELLED rather than INTERRUPTED, because those
   * are two different things that happened.
   */
  cancelRetry() { return require('./waiting').cancelRetry(this); }

  /**
   * ESCAPE OUT OF A LONG RATE-LIMIT WAIT — `waitForReset`'s sibling to
   * `cancelRetry` above, and the same mechanism: the abort signal
   * `app.js`'s `handleRateLimit` keeps alive for exactly the duration of the
   * wait. `waitForReset` itself reports "stopped waiting" once this resolves
   * its promise with `false` — this only needs to fire the signal.
   */
  cancelWait() { return require('./waiting').cancelWait(this); }

  /**
   * Enter the full-screen UI. Returns false when stdout is not a TTY.
   *
   * ------------------------------------------------------------------------
   * THE PANE THAT IS OPEN AT STARTUP STARTS ITS PASS LIKE ANY OTHER.
   *
   * `ensureReport` was reached only by NAVIGATION — Tab, Alt+N, a click. The
   * first view is set in the Screen constructor and shown by the first draw,
   * which goes through none of those. So CONTEXT, the pane LAIN opens ON, was
   * the one pane whose survey never began: it sat on "reading the tree…" for
   * the whole session unless the user happened to tab away and come back, and
   * a person who never touched the tabs simply never saw a project briefing.
   *
   * BEFORE `refresh`, not after, so the first frame already carries the cheap
   * facts (ui/reports.js quickFacts) rather than painting a placeholder and
   * replacing it a moment later.
   *
   * THE BRIEFING IS WARMED WHETHER OR NOT ITS PANE IS OPEN. LAIN lands on
   * ACTIVITY, so starting only the open pane's pass would leave CONTEXT cold
   * until somebody tabbed to it — and the first thing they would see is the
   * placeholder, which is the same defect moved one keypress away. The survey
   * is cheap, asynchronous and wanted regardless, so it begins with the session
   * and CONTEXT is populated before anyone asks for it.
   * ------------------------------------------------------------------------
   */
  enable() {
    if (!this.screen.enter()) return false;
    this.enabled = true;
    this.app.render.attachScreen(this.screen);
    this.ensureReport(this.screen.view);
    if (this.screen.view !== 'context') this.ensureReport('context');
    this.refresh();
    return true;
  }

  disable() {
    if (!this.enabled) return;
    // THE LAST FRAME IS THE SETTLED ACCOUNT. Playback is deliberately behind
    // reality, which is right while there is a screen to watch it on; at
    // teardown there is not, and a session must not end on a half-entered card
    // for an operation that finished seconds ago. See ui/activity.js `drain`.
    this.activity.drain();
    this.refresh();
    this.enabled = false;
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    termtitle.restore();
    this.screen.leave();
  }

  refresh() {
    if (!this.enabled) return;
    const s = this.snapshot();
    this._title(s);
    this.screen.status = views.statusOf({
      lifecycle: s.lifecycle,
      busy: this.busy,
      // ANY modal panel is LAIN waiting on a person, not LAIN working — it was
      // matched on the ask_user title alone, so browsing models or config
      // reported WORKING while nothing was running.
      //
      // A PASSIVE PANEL IS NOT A WAIT. `visible` was the whole test, so a box
      // with no caller behind it — command output, an auto-compaction notice,
      // the loop advisory — put WAITING FOR YOU in the header while the turn
      // was still running. Claiming LAIN is waiting on you when it is not is
      // the same class of untruth as DONE over unfinished work, and this is the
      // header word a person actually acts on.
      awaitingUser: this.panel.visible && !this.panel.isCompletion && !this.panel.isPassive,
      providerStatus: s.providerStatus,
      // The live phase is the most specific true thing available, so it decides
      // the header word: THINKING and RUNNING are both "working", and telling
      // them apart is the difference between waiting on a server and waiting on
      // this machine.
      phase: this.phase,
      interrupting: this.interrupting,
      interrupted: this.interrupted,
      failed: this.failed,
      // Plan at 100% with the task still open — see App.maybeComplete.
      pendingCompletion: this.app.pendingCompletion || null,
    });
    this.screen.draw(s);
  }

  setBusy(on) { this.busy = Boolean(on); this.refresh(); }
  /**
   * The input row's content AND where the caret is in it.
   *
   * The caret travels with the text because the viewport is computed from both:
   * showing the start of a line the user is typing off the end of is exactly
   * the bug this exists to prevent.
   */
  setInput(text, cursor = null) {
    const s = String(text || '');
    this.screen.inputText = s;
    this.screen.inputCursorAt = cursor == null ? s.length : Math.max(0, Math.min(s.length, cursor));
    const upto = s.slice(0, this.screen.inputCursorAt);
    this.screen.inputCursorLine = upto.split('\n').length - 1;
    // THE SELECTION TRAVELS WITH THE TEXT. The reader owns it; the screen only
    // draws it, and reading it here means there is one place it is copied.
    const reader = this.app.input;
    this.screen.inputSelection = reader && typeof reader.range === 'function' ? reader.range() : null;
    this.refresh();
  }

  /**
   * The transient "press Ctrl+C again to exit" hint, drawn on the input frame.
   * A no-op when nothing changed, so the ordinary keystroke path never pays for
   * a redraw it does not need.
   */
  setExitHint(text) {
    const t = String(text || '');
    if (this.screen.exitHint === t) return;
    this.screen.exitHint = t;
    this.refresh();
  }

  /** Record command output for the OUTPUT view. Bounded — never unbounded growth. */

  showCompletion(verification = []) { return require('./completionview').show(this, verification); }

  /** Redraw the report with the CURRENT cursor — Up/Down never re-derive it. */
  _renderCompletion() { return require('./completionview').render(this); }

  dismissCompletion() { return require('./completionview').dismiss(this); }

  /**
   * Open the interaction panel with an adapter and await the user's answer.
   * THE single entry point for every interactive surface.
   */
  async ask(adapter) {
    if (!this.enabled) return null;      // non-TTY callers print text instead
    const p = this.panel.open(adapter);
    this.refresh();
    const value = await p;
    this.refresh();
    return value;
  }

  /** What the panel is currently for — IDLE when nothing is open. */
  get mode() { return this.panel.kind; }

  /**
   * The `ask_user` back end. Renders the choices through THIS panel and returns
   * the chosen string — which is why it lives here rather than in the REPL.
   *
   * "Other…" is a ROW that leads to a text-entry state of this same panel — it
   * used to close the panel and print a dim line into the transcript, which is
   * exactly the "is that editable or is it just text?" confusion this fixes.
   * Either way the answer comes back through the ONE `ask()` promise, so a
   * reply can never start a task, mutate the plan or reset a step.
   */
  async askUser({ question, options = [], input = null }) {
    if (!this.enabled) return null;            // non-interactive: the tool says so
    // ---- END OF INPUT IS A STATE, NOT AN EVENT ---------------------------
    //
    // repl.js cancels an OPEN question when stdin closes, because nothing will
    // ever answer it. That covers the question that already exists and misses
    // the one asked a moment later — and "a moment later" is every piped run,
    // where the whole script is written and closed before the first turn has
    // reached its first tool.
    //
    // It surfaced when an await was added in front of `submit` (the input
    // gateway): the ask began arriving AFTER the close, and LAIN sat on an open
    // panel until the harness killed it — a hang whose cause was three files
    // away from where it appeared. A closed stdin has no answers left in it at
    // any later moment either, so the state is checked rather than the moment.
    if (this.app && this.app.inputClosed) return null;
    const A = require('./answer');
    // "Other…" BELONGS ONLY TO A LIST OF CHOICES. On a number question it is
    // an option that cannot be typed; on a yes/no it is a third answer to a
    // two-answer question; on free text it is the thing you are already doing.
    // Appending it everywhere is how a surface comes to offer what it cannot
    // take — see ui/answer.js.
    const kind = A.kindOf(input, options);
    const choices = kind === A.KIND.CHOICE && options.length ? [...options, A.OTHER] : options;
    // A COMPANION HAS TO KNOW A QUESTION IS OPEN. It is the one state where
    // nothing will happen until a person acts, and a window that cannot show it
    // leaves the user waiting on a LAIN that is waiting on them. See events.js.
    const { EVENT, busOf } = require('../events');
    busOf(this.app).emit(EVENT.QUESTION_PRESENTED, { question, kind, options: choices });
    const answer = await this.ask(panelMod.askAdapter({ question, options: choices, input }));
    busOf(this.app).emit(EVENT.QUESTION_RESOLVED, {
      question,
      kind,
      answer: answer == null ? '' : String(answer),
      dismissed: answer == null,
    });
    return answer;
  }

  /**
   * ENTER WITH TEXT ON THE LINE, WHILE A QUESTION IS OPEN.
   *
   * THERE IS STILL ONE EDITOR. The text comes from the same InputReader that
   * every prompt comes from, with its caret, its paste handling and its
   * history — this only decides that THIS line is an answer rather than a new
   * task, hands it to the frame, and clears the box. Nothing here re-implements
   * typing, which is the second input architecture the design forbids.
   *
   * Remembered in history on the way past: an answer is a line the user wrote,
   * and having to retype it after a mistake is the same insult as losing it.
   *
   * A SLASH COMMAND IS NOT AN ANSWER. Once a typed line resolves the question,
   * every line does — including `/copy`, which is how you get the question out
   * of the box and into somewhere else, and which you most want at exactly this
   * moment. So a registered command runs and the question stays open behind it.
   * `looksLikeCommand` requires a name that is actually in the registry, so an
   * answer that begins with a slash (`/usr/local/bin`) is still an answer.
   *
   * @returns {boolean} true when the line was consumed as an answer.
   */
  submitTypedAnswer() {
    if (!this.enabled || !this.panel.visible || !this.panel.acceptsTyped) return false;
    const input = this.app.input;
    const text = input ? String(input.line || '') : '';
    if (!text.trim()) return false;            // an empty line means the highlighted row
    const commands = require('../commands');
    if (commands.looksLikeCommand(text)) {
      if (input) { input.remember(text); input.setLine(''); }
      this.setInput('');
      this.refresh();
      Promise.resolve(commands.run(this.app, text)).catch((e) => {
        this.app.render.notice('error', `${text}: ${e && e.message}`);
      });
      return true;
    }
    // A SECRET IS NOT REMEMBERED. `remember` makes the line recallable with ↑,
    // which for an API key means one keypress from plain text after it was
    // carefully masked while typed. Same flag the box masks on — see
    // ui/inputbox.js and apicommand.js `credentialAdapter`.
    const secret = Boolean(this.panel.frame && this.panel.frame.secret);
    if (!this.panel.submitTyped(text)) return false;
    if (input) { if (!secret) input.remember(text); input.setLine(''); }
    this.setInput('');
    this.refresh();
    return true;
  }

  /**
   * Install (or clear) the model browser's live filter.
   *
   * The COMMAND owns what filtering means — it has the catalog and the adapter;
   * the UI only knows that keystrokes should reach it while that panel is open.
   */
  setModelFilter(fn) { this._modelFilter = typeof fn === 'function' ? fn : null; }

  // ------------------------------------------------- as-you-type menus ------
  //
  // The `/` and `@` menus live in ui/menus.js — a menu is a view of the INPUT
  // LINE, which is a different concern from the panel, the screen and the
  // keyboard this object owns, and keeping both here pushed the file past the
  // god-object guard. These are the seams, not wrappers with logic in them.

  static atToken(text) { return require('./menus').atToken(text); }
  updateMenus(text, meta) { return require('./menus').updateMenus(this, text, meta); }
  completionKey(key) { return require('./menus').completionKey(this, key); }
  showMenu(adapter) { return require('./menus').showMenu(this, adapter); }
  closeMenu() { return require('./menus').closeMenu(this); }

  /**
   * Enter on an empty input line, with the workspace showing a list.
   *
   * This is how a view becomes navigable without giving the workspace its own
   * cursor and its own key handling: the selection runs through the ONE panel,
   * and the view simply renders whatever was chosen.
   */
  async workspaceSelect() {
    if (!this.enabled || this.panel.visible) return false;
    const app = this.app;
    const screen = this.screen;

    if (screen.view === 'diff' || screen.view === 'files') {
      // Inside an open diff, Enter goes back to the list rather than nowhere.
      if (screen.view === 'diff' && screen.diffFile) { screen.diffFile = null; this.refresh(); return true; }
      const files = require('./panes').changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd });
      if (!files.length) return false;
      const picked = await this.ask(panelMod.changedFilesAdapter({ files }));
      if (picked) { screen.diffFile = picked; screen.setView('diff'); }
      return true;
    }

    if (screen.view === 'plan') {
      const plan = app.session.plan;
      if (!plan || !plan.steps.length) return false;
      const picked = await this.ask(panelMod.planStepsAdapter({ steps: plan.steps, expanded: screen.expandedSteps }));
      if (picked != null) { screen.toggleStep(picked); screen.planCursor = picked; }
      return true;
    }
    return false;
  }

  /**
   * A SINGLE LETTER TYPED WHILE THE COMPLETION OVERLAY IS UP.
   *
   * The overlay used to advertise "[D] diff" and "[R] keep working" as
   * printable letters, and NEITHER worked: a printable character is inserted
   * into the input line and emits an `edit`, never a `key`, so they could
   * never reach handleKey at all — the screen was offering shortcuts the
   * input reader is structurally incapable of delivering. Both are gone now,
   * replaced by Up/Down/Enter (see ui/keys.js), which arrive as real `key`
   * events and need no bridge like this one.
   *
   * What is left here is general, not specific to those two letters: only
   * while the overlay is showing, only for a line that is exactly one
   * character, and only for a letter the overlay's `handleKey` actually
   * claims. Anything else falls through and is typed, which also dismisses
   * the report because you have started composing. Nothing about ordinary
   * typing changes.
   */
  completionShortcut(text) {
    if (!this.enabled || !this.screen.completion) return false;
    const k = String(text || '');
    if (k.length !== 1) return false;
    return this.handleKey(k.toLowerCase());
  }

  /**
   * The same problem, one layer down: a letter an OPEN PANEL advertises.
   *
   * The session browser's footer says "D details", and D is a printable
   * character — so without this it is typed into the input line and the footer
   * is a promise the input reader cannot keep. The PANEL decides whether the
   * letter is claimed (see InteractionPanel.shortcut); a completion menu never
   * claims one, so typing to filter the model browser is untouched.
   */
  panelShortcut(text) {
    if (!this.enabled || !this.panel.visible) return false;
    const k = String(text || '');
    if (k.length !== 1) return false;
    // ---- AN ADVISORY NEVER TAKES A LETTER OUT OF A SENTENCE ---------------
    //
    // Every other panel is modal: there is nothing else the keyboard could be
    // for, so claiming a letter costs nothing. The loop advisory is raised by
    // LAIN, unasked, over a live input line — and one of the things it SUGGESTS
    // is that you type a correction. If it claimed letters unconditionally,
    // "look at the other file" would lose its `l` to [L] the moment it appeared,
    // which is the footer-that-lies bug this method exists to prevent, inverted.
    //
    // So its letters are live only while the line is EMPTY. Start typing and
    // they are yours again, no mode to leave and nothing to undo.
    if (this.panel.isAdvisory) {
      const line = this.app.input ? String(this.app.input.line || '') : '';
      if (line.length) return false;
    }
    if (!this.panel.shortcut(k)) return false;
    this.refresh();
    return true;
  }

  /** Cycle the workspace views. Tab is the key every terminal agrees on. */
  nextView(delta = 1) {
    // THE ORDER LIVES IN ui/tabs.js. It used to be spelled out here, in the
    // strip, in the click hit-test and in the Alt+N bindings — four copies of
    // one ordered list, free to disagree about which pane is number 4.
    const next = require('./tabs').step(this.screen.view, delta);
    this.screen.setView(next);
    this.ensureReport(next);
    return true;
  }

  /** The AUDIT/HEALTH panes read real state when opened. See ui/reports.js. */
  ensureReport(view) { return require('./reports').ensureReport(this, view); }

  /**
   * WHICH KEY DOES WHAT lives in ui/keys.js — the routing of a keystroke is
   * a different job from owning the panel, the screen and the redraw, and
   * keeping both here pushed this file past the god-object guard. This is
   * the seam, not a wrapper with logic in it.
   */
  handleKey(key) { return require('./keys').handleKey(this, key); }

  /**
   * WHERE A CLICK LANDED lives in ui/mouse.js, for the same reason keys live in
   * ui/keys.js: it is hit-testing against what was DRAWN, not state this object
   * owns.
   */
  handleMouse(ev) { return require('./mouse').handleMouse(this, ev); }

}

module.exports = { UI, views, panel: panelMod };
