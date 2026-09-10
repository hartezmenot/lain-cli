'use strict';

/**
 * THE SCREEN — ONE SURFACE, four regions.
 *
 *     HEADER              two rows: who/where/what model/how much context
 *     CONVERSATION        scrollable, bounded — the primary content
 *     LIVE ACTIVITY       one row, directly above the input
 *     INPUT               fixed, always on the floor
 *
 * Plus two regions that cost nothing when there is nothing to say: the pending
 * steer (ui/pending.js) and background work (ui/jobsview.js), and the
 * INTERACTION PANEL, which opens under the input and closes again.
 *
 * ------------------------------------------------------------------------
 * THERE IS NO TAB BAR, NO PANE ORDER AND NO `view`.
 *
 * There used to be nine panes — activity, context, plan, diff, output, files,
 * memory, detail, tokens — with a numbered strip, Alt+N bindings, a click
 * hit-test, per-pane scroll state, per-pane report caches and per-pane crashes.
 * Nine surfaces is nine places a person has to decide they are in the wrong
 * one, and every one of them was reachable as a command anyway.
 *
 * So: ONE surface. `/changes`, `/plan`, `/token`, `/brief`, `/note`, `/jobs`,
 * `/bg` and `/ps` are how the other eight are reached, and they open in the
 * panel under the input rather than replacing the conversation. Nothing in this
 * file switches anything; `workspaceLines` has one answer.
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
const { P } = require('./paint');

const MIN_ROWS = 8;
const MIN_COLS = 40;

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
 * THE ONE RULE ON THE SCREEN — the line under the header.
 *
 * It is the boundary between metadata and content, and it is the only piece of
 * chrome the surface keeps. It earns its row by carrying the scroll hint
 * (`↓ 3 new · End`) on its right-hand end, which is the one thing the removed
 * tab strip said that nothing else could.
 *
 * Bare `─`, dim: no corners, no label, no box. A border round the conversation
 * would say the conversation is a widget, and it is not — it is the page.
 */
function separator(width, right = '', left = '') {
  const w = Math.max(4, width);
  const tail = right ? ` ${right} ` : '';
  // ---- AND THE SCROLL ANCHOR ON ITS LEFT-HAND END ----------------------
  //
  // `USER · fix the continuation bug…`, when the message that started the turn
  // in hand has scrolled off the top. It is a place to click back to, not a
  // heading — see ui/anchors.js `scrollAnchor` for why it rides here rather
  // than taking a row of its own, and why it disappears the moment the real
  // message is on screen.
  //
  // DROPPED BEFORE THE HINT IS, on a terminal too narrow for both: the hint is
  // news about content you have not seen, and the anchor is a convenience for
  // reaching content you have. Two dashes are kept either side so the rule
  // still reads as a rule.
  const room = w - T.width(tail) - 4;
  const head = left && T.width(left) + 2 <= room ? ` ${left} ` : '';
  const dashes = Math.max(0, w - T.width(tail));
  // ---- THE ANCHOR IS A PINNED ONE-LINE PROMPT PREVIEW ------------------
  //
  // It went through two wrong shapes before this one. `USER DECISION · continue`
  // in bold read as a SECOND HEADER. `↑ user` was quiet enough but said nothing —
  // a person could not tell which turn it went back to, which on a long session is
  // the only thing they need from it.
  //
  // What it is now: the real submitted text, one line, on its own subtle grey
  // ground — the same ground a user message sits on in the conversation, because it
  // IS one. `USER` keeps a little more weight than the preview after it, so the row
  // reads as a label and a quotation rather than as a sentence.
  //
  // ON THE GROUND, NOT THE RULE. Where the anchor is drawn the rule stops: a line
  // running through a filled row would be a line drawn over a label. The dashes
  // pick up after it and carry on to the hint.
  if (!head) return P.meta('─'.repeat(dashes) + tail);
  // `USER · <preview>` arrives as one string (ui/anchors.js `mark`); the label and
  // the quotation are painted apart so the row reads as a label and a quotation.
  const cut = left.indexOf(' · ');
  const who = cut < 0 ? left : left.slice(0, cut);
  const said = cut < 0 ? '' : left.slice(cut + 3);
  const shown = ` ${left} `;
  const painted = P.surface(
    ' ' + P.key(who) + (said ? P.meta(' · ') + P.plain(said) : '') + ' ',
  );
  return painted + P.meta('─'.repeat(Math.max(0, dashes - T.width(shown))) + tail);
}

class Screen {
  constructor({ out = process.stdout, panel = null } = {}) {
    this.out = out;
    this.panel = panel;
    this.active = false;
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
    // THE CONVERSATION FOLLOWS LIVE. There is one surface and it is a running
    // account, so new output scrolls itself into view unless the user has
    // scrolled away — which is the only thing that clears this.
    //
    // It does NOT pad above its content. A transcript with three lines in it
    // starts at the TOP of the region and grows down, the way reading works;
    // gluing it to the floor put the first thing the user said at the bottom of
    // an otherwise empty screen and moved every line up on each new one.
    this.stickToBottom = true;
    this._anchorSpoken = 0;
    this.inputText = '';
    /**
     * THE PAYLOADS IN `inputText` THAT ARRIVED AS PASTES — drawing only.
     *
     * Set from the reader by `UI.setInput`. `inputText` is always the whole
     * truth and is what gets sent; this list only lets the box draw a huge
     * block as `<pasted text>` instead of as four hundred rows. See
     * ui/composer.js.
     */
    this.inputPastes = [];
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

  /**
   * The viewport state and the scroll hint — pure functions of state, living in
   * views.js, whose whole job is state -> lines. They stay reachable as methods
   * because that is how the Screen's callers and its tests address them.
   *
   * `tabsLine` used to sit here too. It is gone with the tabs.
   */
  viewportState(spoken = 0) {
    return views.viewportState({ stickToBottom: this.stickToBottom, spoken, anchorSpoken: this._anchorSpoken });
  }

  scrollHint(lines, bodyRows) {
    return views.scrollHint(lines, bodyRows, {
      stickToBottom: this.stickToBottom, scroll: this.workspaceScroll, anchorSpoken: this._anchorSpoken,
    });
  }

  // ------------------------------------------------------------------------
  // THE PINNED TASK BANNER IS GONE, and this is where it was.
  //
  // It drew the objective and a `STEP 3/5 ████░░ 60%` bar above the feed, on
  // two of the nine panes, permanently. Against §11's test — does this answer
  // "where am I", "what model", "how much context", "what is LAIN doing",
  // "what was said", "where do I type"? — it answers none of them: the
  // objective IS the first thing the user said, so the conversation says it,
  // and the progress bar is `/plan`.
  //
  // ui/conversation.js used to SUPPRESS the first user message because this
  // banner was showing it. That suppression is gone with the banner; the feed
  // draws every message, including the first.
  // ------------------------------------------------------------------------

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
    const feedRows = Math.max(1, workspace);
    // THE SAME WIDTH THE FRAME IS DRAWN AT, or the scroll would be computed
    // against a feed of a different length than the one on screen. See
    // views.content.
    const lines = this.workspaceLines(views.contentBounds(this.cols).width, feedRows);
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
  /**
   * MOVING THE VIEWPORT lives in ui/navigate.js — see its header. These stay
   * reachable as methods because that is how the Screen's callers and its tests
   * address them.
   */
  jumpToRow(row) { return require('./navigate').jumpToRow(this, row); }

  jumpToAnchor(dir) { return require('./navigate').jumpToAnchor(this, dir); }

  /**
   * ------------------------------------------------------------------------
   * `_inputTop` AND `_inputLabel` STOOD HERE, and both are gone with the box.
   *
   * The input was `┌─ INPUT ────┐ … └────┘`, and the top border doubled as a
   * label saying what the region currently was: plain input, `COMMANDS`,
   * `FILES`, the wording for an open question, or the exit hint.
   *
   * Each of those has a better home now:
   *
   *   INPUT        was a word restating what the caret already says. Gone.
   *   COMMANDS,    the picker opens directly under the input and draws its own
   *   FILES        title (ui/panel.js). The label was a second one.
   *   the answer   likewise — the panel asking the question carries it.
   *   the hint     `Press Ctrl+C again to exit` is the one that had nowhere
   *                else to go, and it takes a row of its own for the two
   *                seconds it is armed. See ui/geometry.js `hintRows`.
   * ------------------------------------------------------------------------
   */

  /** Redraw everything from state. Deterministic; costs no model tokens. */
  draw(state = null) {
    if (state) this.state = state;
    if (!this.active) return;
    const cols = this.cols;
    const rows = this.rows;
    const g = this.geometry();
    const buf = [];
    // ---- THE ONE CONTENT FRAME -------------------------------------------
    //
    // Computed ONCE, here, and handed to every region. No renderer below works
    // out its own horizontal margins: each is composed at `box.width` and drawn
    // at `box.left + 1`, so the left and right gutters are the same number by
    // construction rather than by four files agreeing. See views.contentBounds,
    // and the screenshot that produced it — the whitespace did not match.
    const box = views.contentBounds(cols);
    const col0 = box.left + 1;
    // WHERE CONTENT LANDED, for the click and selection arithmetic. Recorded as
    // it is drawn, like every other entry in `rowMap`, so hit-testing can never
    // be reading a different frame from the one on screen.
    this._box = box;

    // ---- HEADER — ONE ROW OF METADATA, NO BOX --------------------------
    //
    // `LAIN   lain-v2   claude-opus-5   42k/128k`, dim, and that is all of it.
    //
    // It used to be a four-row `┌─ L A I N ─┐` frame carrying the project, the
    // path, the model, the ROUTE, the effort, a status word and a coloured dot
    // — seven fields and a border, above a conversation that had no rows left.
    // The route went with the tabs (see views.header); the status word moved to
    // the one place that owns it, the live row above the input.
    const head = views.header({
      cwd: this.state.cwd,
      model: this.state.model,
      provider: this.state.provider,
      connection: this.state.connection,
      output: this.state.output,
      width: box.width,
    });
    let row = 1;
    buf.push(L(at(row++, col0) + views.clip(head[0] || '', box.width)));
    // THE RULE UNDER IT IS DRAWN LAST, because the scroll hint it carries is
    // not known until the feed has been laid out. Every row in `buf` addresses
    // itself (`at(row, 1)`), so composing one out of order costs nothing.
    const ruleRow = g.headerRows > 1 ? row++ : 0;

    // ---- CONVERSATION (scrollable, bounded) ----
    //
    // It gets EVERY row the fixed regions did not take. There is no tab strip
    // above it and no pinned banner inside it — the two rows those cost went
    // back to the content they were sitting on top of.
    const feedRows = Math.max(0, g.workspace);
    // ---- THE INVISIBLE CONTENT FRAME -----------------------------------
    //
    // The conversation is built NARROWER than the terminal so there is a right
    // gutter to match the left one the feed's own indent already provides. It is
    // still drawn at column 1 — the inset is in the LINES, not in where they are
    // placed — which is what keeps ui/textselect.js and ui/mouse.js reading one
    // arithmetic for window row to feed line. See views.content.
    const lines = this.workspaceLines(box.width, feedRows);
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

    // ---- THE FRAME, RECORDED WITH THE REST OF THE GEOMETRY ---------------
    //
    // Every region is drawn at `contentCol` and composed at `contentWidth`. Kept
    // here so a click, a selection or a test reads the frame the draw ACTUALLY
    // used rather than recomputing it — the same rule the rest of `rowMap`
    // follows, and the reason a second copy of this arithmetic is not allowed.
    this.rowMap = { cols, contentCol: col0, contentWidth: box.width, gutter: box.left };
    // THE RULE, NOW THAT THE HINT IS KNOWN. `↓ 3 new · End` is the one thing
    // the tab strip said that no other region can: it is news about content
    // the user has not seen, and it belongs on the boundary of the region
    // that content is in.
    // ---- THE SCROLL ANCHOR, NOW THAT THE FEED HAS BEEN LAID OUT --------
    //
    // It needs the drawn feed and the settled scroll position, both of which
    // exist only at this point — which is the same reason the rule is composed
    // last. Recorded on the rowMap so a click can find it without re-deriving
    // anything. See ui/anchors.js and ui/mouse.js.
    const anchor = require('./anchors').scrollAnchor(lines, this.workspaceScroll, feedRows);
    this.rowMap.anchorRow = anchor ? ruleRow : 0;
    this.rowMap.anchorTarget = anchor ? anchor.row : -1;
    if (ruleRow) {
      buf.push(L(at(ruleRow, col0) + views.clip(
        separator(box.width, this.scrollHint(lines, feedRows), anchor ? anchor.mark : ''), box.width,
      )));
    }
    const window = lines.slice(this.workspaceScroll, this.workspaceScroll + feedRows);
    // NO PADDING ABOVE. The conversation starts at the TOP of its region and
    // grows down, which is how reading works and what leaves the calm empty
    // space between the last thing said and the input box. Padding it upward
    // glued the first message to the floor and shifted every line on every new
    // one — see the constructor.
    const feedPad = 0;
    this.rowMap.feedStart = row;
    this.rowMap.feedRows = feedRows;
    // Kept at zero so ui/textselect.js and ui/mouse.js keep ONE arithmetic for
    // window row -> feed line, rather than two that differ by a constant.
    this.rowMap.feedPad = feedPad;
    // Selection maps window row -> lines[scroll + i - pad].
    this.rowMap.feedScroll = this.workspaceScroll;

    const painted = textselect.paintRows(window, {
      lines, sel: this.textSelection && this.textSelection.range(), feedPad,
      scroll: this.rowMap.feedScroll, cols: box.width,
    });
    // THE COLUMN THE FEED STARTS ON, for ui/textselect.js: a click at screen
    // column x is column `x - feedCol` of the line under it, and the frame moved
    // that origin off column 1. Recorded rather than recomputed, for the reason
    // the header of this block gives.
    this.rowMap.feedCol = col0;
    for (let i = 0; i < feedRows; i++) {
      buf.push(L(at(row++, col0) + views.clip(painted[i] || '', box.width)));
    }

    // ---- PENDING USER INPUT (only when something is waiting) ----
    // Above the strip rather than below it, so "the strip is immediately above
    // the input" stays true — the strip is the row that says whether anything
    // is alive at all, and it belongs beside the caret.
    this.rowMap.pendingStart = row;
    this.rowMap.pendingRows = g.pendingRows || 0;
    if (g.pendingRows > 0) {
      const plines = require('./pending').draw(this.statusState(), box.width, g.pendingRows);
      for (let i = 0; i < g.pendingRows; i++) buf.push(L(at(row++, col0) + views.clip(plines[i] || '', box.width)));
    }
    // ---- WHAT IS RUNNING THAT YOU ARE NOT LOOKING AT --------------------
    //
    // Composed like every other region, and drawn BEFORE the input box, so a
    // job finishing while somebody is typing changes one row above the line
    // they are on and nothing else. See ui/jobsview.js.
    this.rowMap.jobsStart = row;
    this.rowMap.jobRows = g.jobRows || 0;
    if (g.jobRows > 0) {
      const jlines = require('./jobsview').draw(this.statusState(), box.width, g.jobRows);
      for (let i = 0; i < g.jobRows; i++) buf.push(L(at(row++, col0) + views.clip(jlines[i] || '', box.width)));
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
      const strip = require('./status').statusStrip(this.statusState(), box.width, g.statusRows);
      for (let i = 0; i < g.statusRows; i++) buf.push(L(at(row++, col0) + views.clip(strip[i] || '', box.width)));
    }

    // ---- INPUT (fixed, LAST, always on the floor) ----
    //
    // A SUBTLE GREY GROUND ACROSS THE FULL WIDTH, and no border at all. The
    // contrast is the region; see ui/inputbox.js for why that is enough and
    // what the two rows of frame were costing.
    //
    // THE EXIT HINT GETS THE ONE ROW ABOVE IT while it is armed. It used to
    // ride on the top border for free; with no border it is the single
    // transient message important enough to spend a row on, because a person
    // who has just pressed Ctrl+C is asking a question.
    if (g.hintRows > 0) {
      buf.push(L(at(row++, col0) + views.clip(P.warn(this.exitHint), box.width)));
    }
    buf.push(...require('./inputbox').draw(this, { row, cols: box.width, textRows: g.textRows, col: col0 }));
    row += g.textRows;

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
      // ---- AND THE PANEL IS INSIDE THE FRAME TOO ---------------------------
      //
      // It used to be rendered at the full terminal width and drawn at column 1
      // — so on a wide terminal the command menu was a box stretching wall to
      // wall over a conversation that was not, which is the single thing that
      // made the surface read as a TUI dashboard. It is the only region that may
      // be NARROWER than the frame (see ui/panel.js `render`), never wider.
      this.rowMap.panelCol = col0;
      const plines = this.panel.render(box.width, g.panelRows);
      for (let i = 0; i < g.panelRows; i++) {
        buf.push(L(at(row++, col0) + views.clip(plines[i] || '', box.width)));
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
