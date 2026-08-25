'use strict';

/**
 * THE SCREEN — one terminal UI with four regions.
 *
 *     HEADER              fixed
 *     WORKSPACE           scrollable, bounded
 *     INPUT               fixed
 *     INTERACTION PANEL   hidden -> compact -> expanded
 *
 * Not four windows. One alternate-screen buffer, redrawn from state.
 *
 * BOUNDED BY CONSTRUCTION. Only the rows that fit are ever drawn: a 10,000-line
 * diff or a huge expanded step is windowed to the workspace height, so long
 * content can never push the terminal endlessly downward or freeze the
 * interface. Scrolling moves the window, not the terminal.
 *
 * This is the TTY path only. When stdout is not a TTY the linear Renderer is
 * used instead — same content functions, different output strategy — which is
 * why piping LAIN still produces plain readable text.
 */

const views = require('./views');
// A credential may exist inside LAIN and may not be drawn. See src/redact.js
// and the note in `draw` for why the filter sits on the writer.
const redact = require('../redact');
const textselect = require('./textselect');
// Every width in this file is a VISIBLE width. The regions are drawn by padding
// content out to a frame, and `.length` counts colour escapes as cells.
const T = require('./text');

const MIN_ROWS = 8;
const MIN_COLS = 40;

/** Panes that pin the task banner above their content. See `bannerLines`. */
const BANNER_VIEWS = new Set(['activity', 'context']);

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const HIDE_CUR = '\x1b[?25l';
const SHOW_CUR = '\x1b[?25h';
const CLEAR = '\x1b[2J';

function at(row, col) { return `\x1b[${row};${col}H`; }

const EOL = '\x1b[K';   // erase-to-end-of-line

// A DRAWN ROW, ERASED TO ITS RIGHT instead of the whole screen being cleared
// first, which is what made every keystroke or streamed token blank the
// terminal for a moment — the reported flicker. Unneeded: `geometry()` fixes
// every region's row count, summing to `this.rows`, so every row repaints
// every frame regardless of content. A real RESIZE still clears — `_onResize`.
function L(s) { return s + EOL; }

/**
 * A LABELLED BOX RULE — `┌─ ACTIVITY ─────┐`.
 *
 * The regions used to be bare text separated by blank rows, so the screen read
 * as a stack of paragraphs rather than an interface, and the input row was the
 * only thing with a visible edge. A rule costs ONE row per region and makes the
 * boundary between "what LAIN is doing" and "where I type" unmistakable.
 *
 * `edges` false draws a plain rule with no corners, for regions that are
 * separated rather than enclosed.
 */
function rule(label, width, { left = '┌', right = '┐', fill = '─' } = {}) {
  const w = Math.max(4, width);
  if (!label) return left + fill.repeat(w - 2) + right;
  const text = ' ' + String(label) + ' ';
  const room = w - 3 - text.length;
  if (room < 0) return left + fill.repeat(w - 2) + right;
  return left + fill + text + fill.repeat(room) + right;
}

class Screen {
  constructor({ out = process.stdout, panel = null } = {}) {
    this.out = out;
    this.panel = panel;
    this.active = false;
    this.view = require('./tabs').VIEWS[0];   // ACTIVITY — see ui/tabs.js
    /** Last completed /audit and /health passes, for their panes. */
    this.report = { audit: null, health: null, work: null, brief: null };
    this.workspaceScroll = 0;             // rows scrolled from the TOP of content
    // DRAG-SELECTION OVER THE FEED — the same Selection the input box uses,
    // over a different buffer: the whole rendered feed as plain text, so a
    // selection survives scrolling. See ui/textselect.js.
    this.textSelection = new (require('../selection').Selection)();
    this.selectionLines = null;
    /**
     * THE VIEWPORT HAS THREE STATES, and only two of them were ever true here.
     *
     *   FOLLOW_LIVE          the newest content stays in view as it arrives.
     *   MANUAL_SCROLL        the user is reading history; new output must NOT
     *                        drag them back down — it never did, and that part
     *                        was already right.
     *   NEW_ACTIVITY_PENDING reading history WHILE something is being said.
     *
     * The third had no representation at all: a person scrolled up to re-read
     * something got no signal that the model had answered, and `↑ more` says
     * only that content exists above — which is the opposite direction and was
     * already true before anything happened. `_anchorSpoken` is the message
     * count as it stood when they scrolled away, so the difference is exactly
     * "what have I missed".
     */
    // ASKED OF ui/tabs.js, not asserted: a bare `true` bottom-anchored whatever
    // the first view happened to be, and not every pane is a feed — a document
    // pinned to its own end opens on its last line.
    this.stickToBottom = require('./tabs').followsLive(this.view);
    this._anchorSpoken = 0;
    this.expandedSteps = new Set();
    this.planCursor = -1;                 // which plan step Enter would expand
    this.diffFile = null;                 // the file the DIFF view is showing
    this.inputText = '';
    /** Caret position within `inputText`, and which line of it that lands on. */
    this.inputCursorAt = 0;
    this.inputCursorLine = 0;
    this.exitHint = '';                   // "press Ctrl+C again to exit", or ''
    this.status = views.STATE.READY;
    this.state = {};                      // last state snapshot given by the app
    this.completion = null;               // completion screen content, or null
    // THE FRAME PUT ON THE WIRE BY THE LAST DRAW — see the end of `draw`. Held
    // so an identical repaint can be skipped. It must be dropped whenever
    // anything clears the screen behind this file's back, or the comparison would
    // be against a screen that is no longer there.
    this._lastFrame = null;
    // A resize changes `this.rows` itself, which `L`'s per-row erase cannot cover.
    this._onResize = () => { this._lastFrame = null; if (this.active) this.out.write(CLEAR); this.draw(); };
  }

  /**
   * Terminal size. A pipe reports no dimensions, so COLUMNS/LINES are honoured
   * as the fallback — the usual convention, and what makes the forced-TUI mode
   * genuinely testable at real geometries instead of silently always 80x24.
   */
  get cols() {
    return Math.max(MIN_COLS, this.out.columns || Number(process.env.COLUMNS) || 80);
  }

  get rows() {
    return Math.max(MIN_ROWS, this.out.rows || Number(process.env.LINES) || 24);
  }

  /**
   * Enter the full-screen UI.
   *
   * LAIN_FORCE_TUI=1 runs the REAL draw path when stdout is a pipe. That is how
   * the smoke suite exercises the actual regions through the actual binary —
   * a child process never gets a TTY, and asserting on a fake Screen object
   * would only prove the fake works. Only the isTTY check is bypassed;
   * everything drawn is the production path.
   */
  enter() {
    const forced = process.env.LAIN_FORCE_TUI === '1';
    if (this.active || (!this.out.isTTY && !forced)) return false;
    this.active = true;
    // THE CURSOR STAYS VISIBLE —.
    //
    // It was hidden here and never shown again, so for the whole session the
    // terminal's blinking block did not exist. The caret POSITION was computed
    // correctly and parked correctly at the end of every draw — at an
    // invisible cursor. A person typing had no indicator of where the
    // characters were going, which is the single strongest signal a terminal
    // can give.
    //
    // Hiding it was right when the caret could not be placed accurately: a
    // block sitting in the wrong place is worse than no block. That was fixed
    // (see the end of `draw`), and this is the other half of that fix.
    this._lastFrame = null;
    this.out.write(ALT_ON + CLEAR);
    this.out.on('resize', this._onResize);
    return true;
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    try { this.out.removeListener('resize', this._onResize); } catch { /* detached */ }
    this._lastFrame = null;
    this.out.write(SHOW_CUR + ALT_OFF);
  }

  setView(name) {
    const changed = this.view !== name;
    this.view = name;
    this.workspaceScroll = 0;
    this.stickToBottom = require('./tabs').followsLive(name);
    // Re-entering DIFF returns to the file list rather than to whichever file
    // happened to be open, which is what "Ctrl+3 — back to this list" promises.
    if (changed && name === 'diff') this.diffFile = null;
    this.draw();
  }

  toggleStep(n) {
    if (this.expandedSteps.has(n)) this.expandedSteps.delete(n);
    else this.expandedSteps.add(n);
    this.draw();
  }

  /** Region heights — see ui/geometry.js. */
  geometry() { return require('./geometry').regions(this); }

  /** The conversation, and the content of the current pane — ui/panesource.js. */
  liveLines(width) { return require('./panesource').liveLines(this, width); }

  workspaceLines(width, height = 20) { return require('./panesource').workspaceLines(this, width, height); }

  /**
   * What the LLM status strip shows, straight from the snapshot the UI built.
   * The screen derives nothing here — it draws what the app already knows.
   */
  statusState() {
    return (this.state && this.state.llm) || { phase: null };
  }

  /**
   * The summary row for a buffer too big to show, or null. See viewport.js.
   *
   * `shown` is how many lines the box can actually draw — the summary describes
   * only what is HIDDEN, so it never spends a row restating three visible lines.
   * Computed the same way `geometry` computes the box height, and deliberately
   * without consulting the summary: asking whether the summary exists in order
   * to decide whether the summary exists is the circle this argument breaks.
   */

  // THE INPUT REGION lives in ui/inputbox.js — see its header. These stay as
  // methods because the geometry, the draw and the mouse map all ask the
  // screen, and moving the callers would have been a bigger change than
  // moving the answer.
  _wrapped() { return require('./inputbox').wrapped(this); }
  _shownInputRows() { return require('./inputbox').shownRows(this); }
  _pasteSummary() { return require('./inputbox').summary(this); }

  /**
   * The tab strip, with a live count beside the views that have something in
   * them — a tab that never says anything is just a label.
   */
  /**
   * The view selector, the viewport state and the scroll hint.
   *
   * All three are pure functions of state and live in views.js, whose whole job
   * is state -> lines. They stay reachable as methods because that is how the
   * Screen's callers and its tests address them.
   */
  tabsLine(width, scroll = null) { return views.tabsLine(this.view, width, scroll); }

  viewportState(spoken = 0) {
    return views.viewportState({ stickToBottom: this.stickToBottom, spoken, anchorSpoken: this._anchorSpoken });
  }

  scrollHint(lines, bodyRows) {
    return views.scrollHint(lines, bodyRows, {
      stickToBottom: this.stickToBottom, scroll: this.workspaceScroll, anchorSpoken: this._anchorSpoken,
    });
  }

  /**
   * The PINNED task banner over CONTEXT: the objective and, once there is a
   * plan, the progress. It never scrolls, so "what am I doing and how far along
   * am I?" is answered without reading anything. Returns [] for every other
   * view and when there is no task yet (the launch screen owns that case).
   *
   * IT SAYS CONTEXT AND IT MEANS CONTEXT — this said "the activity view" while
   * testing for `context`, left from when CONTEXT was the transcript. The
   * banner owns the objective, so ui/contextview.js must not print one too.
   *
   * `bodyRows` is the space the whole workspace body has; the banner is capped
   * to leave at least one row for the feed, and goes COMPACT when the terminal
   * is narrow or short so the progress line survives instead of the feed.
   */
  bannerLines(cols, bodyRows) {
    // ACTIVITY AND CONTEXT BOTH PIN IT, and ACTIVITY is why.
    //
    // ui/conversation.js deliberately does NOT redraw the first user message
    // when it is the task objective, because this banner is showing it. While
    // the banner was drawn only on CONTEXT, that made the objective vanish
    // entirely from ACTIVITY: the feed suppressed it in favour of a banner that
    // was not there. Two panes make the same assumption, so both get the banner.
    if (!BANNER_VIEWS.has(this.view) || this.completion) return [];
    const s = this.state;
    if (!s || !s.session || !s.session.task) return [];
    const compact = cols < 54 || bodyRows < 9;
    // No `live` here any more — the status strip above the INPUT owns it.
    const b = views.taskBanner({ session: s.session, width: cols, compact });
    return b.slice(0, Math.max(0, bodyRows - 1));
  }

  // Thin delegations to ui/textselect.js, which owns the arithmetic; the Screen
  // supplies only which lines were painted and where they landed.
  selectFrom(x, y) { return textselect.beginAt(this, x, y); }
  selectTo(x, y) { return textselect.extendTo(this, x, y); }
  selectedText() { return textselect.selectedText(this); }
  hasSelection() { return this.textSelection.active(); }

  clearSelection() {
    const had = this.textSelection.clear();
    this.selectionLines = null;
    return had;
  }

  scrollWorkspace(delta) {
    const { workspace } = this.geometry();
    const bodyRows = Math.max(0, workspace - 1);
    const feedRows = Math.max(1, bodyRows - this.bannerLines(this.cols, bodyRows).length);
    const lines = this.workspaceLines(this.cols, feedRows);
    const maxScroll = Math.max(0, lines.length - feedRows);
    this.workspaceScroll = Math.max(0, Math.min(this.workspaceScroll + delta, maxScroll));
    this.stickToBottom = this.workspaceScroll >= maxScroll;
    this.draw();
  }

  /**
   * JUMP TO THE PREVIOUS OR NEXT THING THE USER SAID.
   *
   * An hour of work is a great many rows, and the thing somebody scrolls back
   * for is almost always one of their own messages — the instruction they gave,
   * the decision they made, the log they pasted. Page-by-page is the wrong
   * granularity for that: it is a search through the machine's output for the
   * one line that came from the person.
   *
   * The anchors are read from the feed that was ACTUALLY DRAWN (`userAt`, see
   * ui/feed.js), so a jump can only ever land on a row the user really saw, and
   * there is no second index of messages to fall out of step with the feed.
   *
   * Returns false when there is nowhere to go, so the key falls through rather
   * than silently doing nothing.
   */
  jumpToAnchor(dir) {
    const anchors = require('./anchors').rowsIn(this.lastFeedLines);
    if (!anchors.length) return false;
    const at = this.workspaceScroll;
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
    const feedRows = Math.max(1, this.geometry().workspace - 1);
    const total = (this.lastFeedLines && this.lastFeedLines.length) || 0;
    const maxScroll = Math.max(0, total - feedRows);
    const to = Math.max(0, Math.min(target, maxScroll));
    // ALREADY THERE IS NOT A JUMP. An anchor past the end is on screen at the
    // bottom of the feed; saying "moved" about a screen that did not change is
    // what made this look broken rather than finished.
    if (to === at) return false;
    this.stickToBottom = to >= maxScroll;
    this.workspaceScroll = to;
    this.draw();
    return true;
  }

  /**
   * The input box's top border, carrying the exit hint when one is set.
   * `┌─ Press Ctrl+C again to exit. ───┐` — a labelled border, not a modal, so it
   * costs no rows and shows at every terminal size. `inner` is the input width.
   */
  /**
   * The input box's top border, which is also the region's LABEL.
   *
   * The interaction region must always be identifiable at a glance, so the
   * border says what it currently is: plain input, a command palette, a file
   * picker, or — when the exit confirmation is armed — the hint, which
   * outranks the label because it is transient and time-limited.
   */
  _inputTop(inner) {
    const span = inner + 2;                       // dashes in the plain border
    const text = this.exitHint || this._inputLabel();
    if (!text) return '┌' + '─'.repeat(span) + '┐';
    const label = ' ' + views.clip(text, Math.max(0, inner - 2)) + ' ';
    const dashes = Math.max(0, span - 1 - label.length);
    return '┌─' + label + '─'.repeat(dashes) + '┐';
  }

  _inputLabel() {
    const p = this.panel;
    if (p && p.visible && p.isCompletion) {
      return p.kind === 'COMMAND_PALETTE' ? 'COMMANDS' : 'FILES';
    }
    // A QUESTION IS OPEN, SO THIS LINE IS THE ANSWER — and the border is where
    // that gets said. Under the old label a box reading INPUT sat below a
    // question whose own text said "type a number", and nothing on screen
    // connected the two or admitted that typing there did nothing. The wording
    // comes from ui/answer.js, the same source as the panel's footer and its
    // row labels, so the three can never advertise different keys.
    if (p && p.visible && p.acceptsTyped) {
      return require('./answer').inputLabel(p.options, p.takes);
    }
    return 'INPUT';
  }

  /** Redraw everything from state. Deterministic; costs no model tokens. */
  draw(state = null) {
    if (state) this.state = state;
    if (!this.active) return;
    const cols = this.cols;
    const rows = this.rows;
    const g = this.geometry();
    const buf = [];

    // ---- HEADER (fixed) ----
    const head = views.header({
      cwd: this.state.cwd,
      session: this.state.session,
      model: this.state.model,
      provider: this.state.provider,
      connection: this.state.connection,
      effort: this.state.effort,
      plan: this.state.plan,
      status: this.status,
      // Inside a frame the content lives between `│ ` and ` │`, so it must be
      // laid out to the INNER width — given the full width it right-aligned the
      // status into the border and the state word was clipped away, which is
      // the one thing on that row that must never be lost.
      width: g.framed ? cols - 4 : cols,
      compact: g.compactHeader,
      stats: this.state.stats,
      framed: g.framed,
    });
    let row = 1;
    if (g.framed) {
      // ┌─ LAIN ────────────┐ … │ content │ … └────────────────────┘
      const inner = cols - 4;
      buf.push(L(at(row++, 1) + views.clip(rule('L A I N', cols), cols)));
      for (let i = 0; i < g.headerRows - 2; i++) {
        const t = views.clip(head[i] || '', inner);
        buf.push(L(at(row++, 1) + '│ ' + t + ' '.repeat(Math.max(0, inner - T.width(t))) + ' │'));
      }
      buf.push(L(at(row++, 1) + '└' + '─'.repeat(Math.max(0, cols - 2)) + '┘'));
    } else {
      for (let i = 0; i < g.headerRows; i++) {
        buf.push(L(at(row++, 1) + views.clip(head[i] || '', cols)));
      }
    }

    // ---- WORKSPACE (scrollable, bounded) ----
    // A PINNED banner (activity view) sits between the tab strip and the feed:
    // the task and its progress stay put while the log below them scrolls.
    const bodyRows = Math.max(0, g.workspace - 1);
    const banner = this.bannerLines(cols, bodyRows);
    const feedRows = Math.max(0, bodyRows - banner.length);
    const lines = this.workspaceLines(cols, feedRows);
    // HELD FOR THE SELECTION, which needs the whole feed rather than the rows
    // on screen — that is what lets a drag survive scrolling. Kept from the
    // frame that was actually painted, so an offset always refers to text the
    // user really saw.
    this.lastFeedLines = lines;
    // WHERE EACH REGION ACTUALLY LANDED.
    //
    // Recorded as the frame is drawn rather than re-derived from geometry(),
    // because hit-testing a click against a SECOND copy of this arithmetic is
    // exactly the kind of duplicate that drifts: the day a row is added here,
    // the mouse would quietly start clicking the wrong thing. See ui/mouse.js.

    // THE SCROLL POSITION IS SETTLED BEFORE ANYTHING DESCRIBES IT.
    //
    // It was described first and settled afterwards, so on every frame where
    // the feed had grown the strip drew `↕ more` — "you are somewhere in the
    // middle" — about a view that was pinned to the bottom by the time it was
    // painted. During a working turn that is every other frame, and an
    // indicator flickering between two states is a good way to make a moving
    // screen look like a stuck one.
    //
    // FOLLOWING ALSO MEANS NOTHING IS UNREAD: the anchor moves with the view
    // while the view is at the bottom, so `↓ N new` counts from the moment the
    // user scrolled away rather than from whenever they last pressed End.
    const maxScroll = Math.max(0, lines.length - feedRows);
    if (this.stickToBottom) {
      this.workspaceScroll = maxScroll;
      this._anchorSpoken = Number(lines.spoken) || 0;
    }
    if (this.workspaceScroll > maxScroll) this.workspaceScroll = maxScroll;

    this.rowMap = { tabs: row, cols };
    buf.push(L(at(row, 1) + views.clip(this.tabsLine(cols, this.scrollHint(lines, feedRows)), cols)));
    row++;
    this.rowMap.bannerStart = row;
    this.rowMap.bannerRows = banner.length;
    for (const bl of banner) buf.push(L(at(row++, 1) + views.clip(bl, cols)));
    let window = lines.slice(this.workspaceScroll, this.workspaceScroll + feedRows);
    // A CONVERSATION GROWS UPWARD FROM THE INPUT; A REPORT DOES NOT.
    //
    // With less to say than there are rows, a feed drawn from the TOP leaves a
    // field of blank rows between the last thing said and the caret. Every chat
    // puts the newest message nearest the box you type in; padding ABOVE rather
    // than below is the whole of that. WHICH panes do this lives in ui/tabs.js
    // — see growsUpward, and what it cost to write the rule down twice.
    let feedPad = 0;
    // PADDING ABOVE IS A SEPARATE QUESTION FROM FOLLOWING NEW OUTPUT — see
    // ui/tabs.js. ACTIVITY follows and does NOT pad: the conversation starts at
    // the top of the pane and grows down.
    if (require('./tabs').growsUpward(this.view)
      && this.stickToBottom && window.length < feedRows) {
      feedPad = feedRows - window.length;
      window = new Array(feedPad).fill('').concat(window);
    }
    this.rowMap.feedStart = row;
    this.rowMap.feedRows = feedRows;
    // HOW MANY BLANK ROWS SIT ABOVE THE TEXT. Hit-testing a click needs it:
    // without it the row-to-line map is off by exactly the padding, and a drag
    // selects text a few lines from the one under the pointer.
    this.rowMap.feedPad = feedPad;
    // Selection maps window row -> lines[scroll + i - pad].
    this.rowMap.feedScroll = this.workspaceScroll;

    const painted = textselect.paintRows(window, {
      lines, sel: this.textSelection && this.textSelection.range(), feedPad,
      scroll: this.rowMap.feedScroll, cols,
    });
    for (let i = 0; i < feedRows; i++) {
      buf.push(L(at(row++, 1) + views.clip(painted[i] || '', cols)));
    }

    // ---- PENDING USER INPUT (only when something is waiting) ----
    // Above the strip rather than below it, so "the strip is immediately above
    // the input" stays true — the strip is the row that says whether anything
    // is alive at all, and it belongs beside the caret.
    this.rowMap.pendingStart = row;
    this.rowMap.pendingRows = g.pendingRows || 0;
    if (g.pendingRows > 0) {
      const plines = require('./pending').draw(this.statusState(), cols, g.pendingRows);
      for (let i = 0; i < g.pendingRows; i++) buf.push(L(at(row++, 1) + views.clip(plines[i] || '', cols)));
    }
    // ---- WHAT IS RUNNING THAT YOU ARE NOT LOOKING AT --------------------
    //
    // Composed like every other region, and drawn BEFORE the input box, so a
    // job finishing while somebody is typing changes one row above the line
    // they are on and nothing else. See ui/jobsview.js.
    this.rowMap.jobsStart = row;
    this.rowMap.jobRows = g.jobRows || 0;
    if (g.jobRows > 0) {
      const jlines = require('./jobsview').draw(this.statusState(), cols, g.jobRows);
      for (let i = 0; i < g.jobRows; i++) buf.push(L(at(row++, 1) + views.clip(jlines[i] || '', cols)));
    }

    // ---- INTERACTION PANEL (hidden / compact / expanded) ----
    //
    // ABOVE THE INPUT, AND THIS ORDER IS THE POINT.
    //
    // The panel used to be drawn BELOW the input box, anchored to the bottom of
    // the terminal with the editor riding up on top of it. Every `/model`,
    // `/status`, `/dash`, completion menu and ask_user question therefore MOVED
    // THE PLACE YOU TYPE — by four rows, or by eighteen — and moved it back when
    // the panel closed. The one element that must never move was the one element
    // that moved most.
    //
    // The vertical hierarchy is now fixed and unconditional:
    //
    //     CONTEXT / MAIN VIEW      scrolls, gives up rows first
    //     PENDING USER INPUT       only when something is waiting
    //     PANEL / OUTPUT SURFACE   grows and shrinks HERE
    //     STATUS STRIP             one row that says whether anything is alive
    //     INPUT EDITOR             the permanent bottom anchor
    //
    // A panel opening costs the CONVERSATION rows, which is the right thing to
    // spend: the conversation scrolls and the bottom cluster does not.

    // ---- LLM STATUS (fixed, directly above the input) ----
    // Moved DOWN from the task banner deliberately: what is happening this
    // second belongs beside the caret, not at the top of the screen where it
    // spent the rows the work itself needs. See ui/status.js.
    this.rowMap.statusStart = row;
    this.rowMap.statusRows = g.statusRows;
    if (g.statusRows > 0) {
      const strip = require('./status').statusStrip(this.statusState(), cols, g.statusRows);
      for (let i = 0; i < g.statusRows; i++) buf.push(L(at(row++, 1) + views.clip(strip[i] || '', cols)));
    }

    // ---- INPUT (fixed, LAST, always on the floor) ----
    // When the exit confirmation is armed the top border carries the hint, so it
    // is always visible beside the input without a modal or an extra row.
    const inner = Math.max(4, cols - 4);
    buf.push(L(at(row++, 1) + views.clip(this._inputTop(inner), cols)));
    buf.push(...require('./inputbox').draw(this, { row, inner, cols, textRows: g.inputRows }));
    row += g.inputRows - 1;

    // ---- THE PANEL, DIRECTLY BELOW THE INPUT --------------------------------
    //
    // EVERY panel: the `/` palette, `@` files, the model picker, `/status`
    // output, an ask_user question. One rule, no exceptions, because the
    // exceptions are what made this confusing.
    //
    // WHY BELOW, having briefly been above. The reading that put panels above
    // the input was "the input must never move", enforced as a fixed terminal
    // row. That is not what the arrangement is for. The thing that must not
    // move is the BOTTOM CLUSTER — the line you type on and whatever it opened,
    // together, pinned to the floor — and a panel drawn above the input
    // separates the two: the model list appeared in the middle of the screen
    // with the status strip between it and the caret it belonged to, and the
    // conversation lurched on every `/`.
    //
    // So the cluster is INPUT then PANEL, anchored to the bottom, and the
    // CONVERSATION above gives up the rows. The list you are choosing from sits
    // directly under the line you are filtering it with, which is where it has
    // to be to read as one thing.
    this.rowMap.panelStart = row;
    this.rowMap.panelRows = g.panelRows;
    if (g.panelRows > 0 && this.panel && this.panel.visible) {
      const plines = this.panel.render(cols, g.panelRows);
      for (let i = 0; i < g.panelRows; i++) {
        buf.push(L(at(row++, 1) + views.clip(plines[i] || '', cols)));
      }
    }

    // PARK THE CURSOR WHERE THE CARET ACTUALLY IS.
    //
    // This used to recompute the position — row `rows - panelRows - 2`, column
    // `4 + shown.length` — and it was wrong in three ways at once, at EVERY
    // terminal size: it landed one row ABOVE the text, on the input box's top
    // border; it ignored the paste-summary row when there was one; and it put
    // the column at the end of the DRAWN string rather than at the caret, so
    // pressing ← left the blinking cursor sitting at the end of the line.
    //
    // The blinking block is the strongest signal a terminal has for "you are
    // typing HERE", and it was never where the typing went. `cursorRow` and
    // `cursorCol` were already computed correctly a few lines above, by the
    // viewport that knows about horizontal scrolling and about the `> ` prompt;
    // they are simply used now, so there is one answer rather than two.
    // HIDDEN FOR THE DURATION OF THE PAINT, shown at the end, ON the caret.
    //
    // A visible cursor is dragged across every row as the frame is written,
    // which on a slow terminal is a flicker down the screen. Bracketing the
    // paint keeps the block still: it disappears, the frame is written, and it
    // reappears exactly where the typing goes.
    const park = at(Math.max(1, this.cursorRow), Math.max(1, Math.min(cols, this.cursorCol))) + SHOW_CUR;

    // ---- AN UNCHANGED FRAME IS NOT WRITTEN AGAIN -------------------------
    //
    // While a turn runs the UI repaints on a 250ms timer (ui/index.js), and a
    // great many of those frames are byte-for-byte what is already on screen:
    // waiting on a slow tool call, a long provider request, a rate-limit pause.
    // Re-sending the whole screen four times a second in that state is pure
    // churn, and on a slow or remote terminal it is what makes the lower
    // regions — the status strip and the input box especially — shimmer while
    // nothing about them has changed.
    //
    // THIS IS NOT A REDUCED REFRESH RATE. The frame is still composed in full,
    // at the same cadence, from the same state, and any frame that differs by
    // even one character is written immediately and completely. What is
    // suppressed is only the writing of a frame identical to the one already
    // displayed, which by definition cannot change what the user sees.
    //
    // WHOLE FRAMES, NOT CHANGED ROWS. Every element of `buf` is a complete
    // self-addressed row, so writing just the differing ones would work on a
    // real terminal — but the emitted stream is also what the smoke tier reads
    // back to assert on (tests/helpers.js `frames`), and a stream of partial
    // frames would no longer describe what is on screen. Frame-level is the
    // whole of the win here anyway: the repaints worth removing are the ones
    // where NOTHING moved.
    //
    // THE CARET IS RE-PARKED EVEN THEN: it is the one piece of terminal state a
    // keystroke can move without a repaint.
    // ---- THE OTHER DOOR OUT, AND THE SAME FILTER ON IT -------------------
    //
    // src/render.js `write` is the only LINEAR writer; this is the only FRAME
    // writer. Between them they are every byte that becomes a screen, which is
    // why a credential is caught at these two points rather than at each of the
    // panes, pickers, status rows and error lines that compose one. A pane
    // added tomorrow inherits the promise by being drawn. See src/redact.js.
    //
    // BEFORE the identical-frame comparison, so the cache holds what was
    // actually written and a redaction can never be skipped by it.
    const frame = redact.text(buf.join(''));
    if (frame === this._lastFrame) { this.out.write(park); return; }
    this._lastFrame = frame;
    this.out.write(HIDE_CUR + frame + park);
  }
}

module.exports = { Screen, MIN_ROWS, MIN_COLS };
