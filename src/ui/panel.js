'use strict';

/**
 * THE INTERACTION PANEL — one subsystem, many adapters.
 *
 * `/config`, `/models`, model→routes, `/provider`, `/effort`, `/oauth`,
 * `ask_user`, confirmations, help and every picker all run through THIS panel.
 * The alternative — a mini-renderer per command — is exactly the duplication
 * that made V1 unmaintainable, so it is structurally prevented: a command
 * supplies DATA (an adapter), never drawing code.
 *
 * The panel is a pure state machine over `{ items, cursor, scroll }`. It does no
 * I/O and holds no terminal knowledge, so it is fully testable without a TTY and
 * costs nothing to render — every value it shows already exists in program state.
 *
 * SIZES: HIDDEN (height 0) · COMPACT (small selectors) · EXPANDED (lists,
 * config, MCQ). The workspace shrinks; it is never destroyed.
 */

const { P } = require('./paint');

const MODE = Object.freeze({ HIDDEN: 'hidden', COMPACT: 'compact', EXPANDED: 'expanded' });

/**
 * WHAT the panel is currently for. `MODE` above is how TALL it is; this is what
 * it MEANS, and it is what decides where a keystroke goes. It is derived from
 * the open frame rather than stored separately, so there is exactly one place
 * that knows the panel is open and it cannot disagree with itself.
 *
 * The two COMPLETION kinds are transient: they track what is being typed and
 * close on their own. Every other kind is modal — it was opened by a caller that
 * is awaiting a value, and typing must not disturb it.
 */
const KIND = Object.freeze({
  IDLE: 'IDLE',
  COMMAND_PALETTE: 'COMMAND_PALETTE',
  FILE_COMPLETION: 'FILE_COMPLETION',
  MODEL_SELECTION: 'MODEL_SELECTION',
  EFFORT_SELECTION: 'EFFORT_SELECTION',
  PROVIDER_SELECTION: 'PROVIDER_SELECTION',
  CONFIG: 'CONFIG',
  ASK_USER: 'ASK_USER',
  CONFIRM: 'CONFIRM',
  FILE_PICKER: 'FILE_PICKER',
  // `STEP_PICKER` STOOD HERE — the "which plan step to expand" picker the PLAN
  // pane opened on an empty Enter. There is no pane and `/plan` prints every
  // step with its note and files, so nothing is being asked which. See
  // ui/adapters.js where its adapter was.
  /**
   * WHAT A COMMAND SAID — `/status`, `/dash`, a compaction notice.
   *
   * Nothing awaits a value here and no row is selectable: it is text being
   * shown, and Esc closes it. It lives in THIS panel rather than in a region of
   * its own because `/` and `/model` already open here, and a second window in
   * the same corner of the screen is a duplicate surface — one was built that
   * way first, and removed for exactly this reason.
   */
  OUTPUT: 'OUTPUT',
  /**
   * SOMETHING WORTH KNOWING WHILE THE WORK CARRIES ON — see looping.js.
   *
   * The only kind that is neither modal nor transient. Nothing awaits it, and
   * unlike OUTPUT it is raised by LAIN mid-turn rather than by a command the
   * user just ran — so the keyboard cannot be taken from them: Enter still
   * sends, the arrows still move the caret, Tab still switches panes. Only Esc
   * and the letters the frame declares do anything to it.
   *
   * It is also the only kind CLOSED BY ITS CONDITION GOING AWAY. That is the
   * point of it: an advisory about a problem that has since resolved is a
   * message you must clear for no reason, and a surface which makes you clear
   * stale warnings is one you stop reading.
   */
  ADVISORY: 'ADVISORY',
});

/** Completion kinds follow the input; everything else owns the keyboard. */
const COMPLETION_KINDS = new Set([KIND.COMMAND_PALETTE, KIND.FILE_COMPLETION]);

/**
 * Kinds with NO CALLER WAITING BEHIND THEM.
 *
 * Both are things being shown rather than asked, so either may be replaced by a
 * real question, closed by an Escape aimed at something more urgent, or — for
 * ADVISORY — retracted by whatever raised it. A frame with a caller is never
 * treated this way: closing one answers somebody's question with silence.
 */
const PASSIVE_KINDS = new Set([KIND.OUTPUT, KIND.ADVISORY]);

/** An adapter is `{ title, mode, kind, items, footer?, onSelect?, onBack? }`. */
class InteractionPanel {
  constructor() {
    this.stack = [];      // adapter frames; supports drill-down + back
    this.cursor = 0;
    this.scroll = 0;
    this.result = null;   // resolved value for await-style callers
    /** Why the last typed answer was refused, drawn under the question. */
    this.error = null;
    this._resolve = null;
  }

  get visible() { return this.stack.length > 0; }
  get frame() { return this.stack[this.stack.length - 1] || null; }
  get mode() { return this.frame ? (this.frame.mode || MODE.EXPANDED) : MODE.HIDDEN; }
  get items() { return this.frame ? this.frame.items || [] : []; }

  /** What the panel is for right now. IDLE when it is closed. */
  get kind() { return this.frame ? (this.frame.kind || KIND.CONFIRM) : KIND.IDLE; }

  /**
   * WHAT THE OPEN FRAME TAKES FROM THE KEYBOARD — null when it takes nothing.
   *
   * A question is the one panel where the answer may not be on the list, so it
   * reads the input line as well as the cursor. Everything else ignores typing
   * entirely and is unchanged. Derived from the frame, like `kind`, so there is
   * no second flag to fall out of step with what is drawn.
   */
  get takes() { return this.frame ? (this.frame.takes || null) : null; }

  /** True when a typed line is an answer to this panel rather than a prompt. */
  get acceptsTyped() { return typeof (this.frame && this.frame.onTyped) === 'function'; }

  /** The choices the open question is offering, for the surfaces that describe it. */
  get options() { return (this.frame && this.frame.options) || []; }

  /**
   * ENTER, WITH TEXT ON THE LINE.
   *
   * The bug this replaces: Enter went straight to `select()`, which resolves
   * the HIGHLIGHTED row — so a typed `2` against the options 1-4 answered
   * "1" and the typing was discarded without a word. Now the frame is asked
   * what the line means first, and only an EMPTY line falls through to the
   * cursor.
   *
   * @returns {boolean} true when the line was consumed as an answer.
   */
  submitTyped(text) {
    const f = this.frame;
    if (!f || typeof f.onTyped !== 'function') return false;
    this.error = null;
    const outcome = f.onTyped(String(text == null ? '' : text), { panel: this });
    if (outcome && outcome.push) { this.push(outcome.push); return true; }
    if (outcome && outcome.close !== undefined) { this.close(outcome.close); return true; }
    // REFUSED, AND THE QUESTION STAYS OPEN.
    //
    // A NUMBER question that quietly accepts "about forty" has not been
    // answered — it has been answered WRONGLY, and the model will act on it. So
    // the frame may say no, the reason is drawn under the question, and the
    // line is still there to correct. The alternative is a validator that
    // silently drops what somebody typed, which is the original bug wearing a
    // different hat.
    if (outcome && outcome.reject) { this.error = String(outcome.reject); return true; }
    return false;
  }

  /** Why the last answer was refused, or null. Cleared by the next attempt. */
  get lastError() { return this.error || null; }

  /** True when typing should keep driving this panel rather than be blocked. */
  get isCompletion() { return COMPLETION_KINDS.has(this.kind); }

  /** True when the panel is showing something rather than asking something. */
  get isPassive() { return PASSIVE_KINDS.has(this.kind); }

  /**
   * True for the one panel that must not take the keyboard.
   *
   * Checked by the key router and by the input reader before either hands a
   * keystroke to the panel — an advisory raised mid-turn must never be the
   * reason an Enter did not send.
   */
  get isAdvisory() { return this.kind === KIND.ADVISORY; }

  /**
   * Swap the CONTENT of the open panel without closing it — what a completion
   * menu does on every keystroke. The awaiting promise is untouched, so a filter
   * keystroke can never resolve or orphan the caller.
   */
  replace(adapter) {
    if (!this.stack.length) return this.open(adapter);
    this.stack[this.stack.length - 1] = adapter;
    const n = (adapter.items || []).length;
    // A NEW adapter may say where the cursor belongs, exactly as `open` does.
    // Without this, narrowing 934 models to 50 left the cursor at whatever index
    // it held and it was merely clamped — landing on the LAST match, so typing
    // a filter scrolled you to the bottom of your own search.
    if (Number(adapter.cursor) >= 0) this.cursor = Number(adapter.cursor);
    if (this.cursor >= n) this.cursor = Math.max(0, n - 1);
    // Land on something selectable rather than on a heading.
    const items = adapter.items || [];
    if (items[this.cursor] && items[this.cursor].selectable === false) {
      const i = items.findIndex((x) => x.selectable !== false);
      this.cursor = i < 0 ? 0 : i;
    }
    this.scroll = 0;
    return undefined;
  }

  /** The currently highlighted item, or null. */
  get current() {
    const it = this.items[this.cursor];
    return it && it.selectable !== false ? it : null;
  }

  /** Open a panel. Returns a promise that settles when the user picks or cancels. */
  open(adapter) {
    this.stack = [adapter];
    this.error = null;
    // An adapter may say where the cursor belongs — a list of 1,151 models is
    // far more useful opened ON the current one than at the alphabetical top.
    this.cursor = Number(adapter && adapter.cursor) > 0 ? Number(adapter.cursor) : 0;
    // Land on something CHOOSABLE. A question, a heading or a blank spacer is
    // often row 0, and opening with the marker parked on it makes the panel
    // look like nothing is selected.
    const items = (adapter && adapter.items) || [];
    if (items[this.cursor] && items[this.cursor].selectable === false) {
      const i = items.findIndex((x) => x && x.selectable !== false);
      this.cursor = i < 0 ? 0 : i;
    }
    this.scroll = 0;
    this.result = null;
    return new Promise((resolve) => { this._resolve = resolve; });
  }

  /** Drill down (model → its routes) while keeping the parent for `←`. */
  push(adapter) {
    // REMEMBER WHERE THE CURSOR WAS. Going one level in and back out must
    // return you to the row you left, not to the top: for the ask_user MCQ,
    // where `Esc` opens the explanations and `Esc` comes back, losing the
    // highlighted choice means reading the whole question again to find where
    // you were.
    const from = this.frame;
    if (from) from._cursor = this.cursor;
    this.stack.push(adapter);
    this.cursor = Number(adapter && adapter.cursor) > 0 ? Number(adapter.cursor) : 0;
    this.scroll = 0;
  }

  back() {
    if (this.stack.length <= 1) return this.close(null);
    this.stack.pop();
    const f = this.frame;
    this.cursor = f && Number.isFinite(f._cursor) ? f._cursor : 0;
    this.scroll = 0;
    return undefined;
  }

  /**
   * ESCAPE. The frame decides what backing out MEANS.
   *
   * For nearly everything it means "close, having chosen nothing", which is
   * what it has always done. The ask_user MCQ is the exception the design asks
   * for: there Escape opens the DETAILED explanation of the choices, and
   * Escape again returns to the choices with the question and the highlighted
   * option both intact. A question must not be cancellable by the key a person
   * presses to ask for more information about it.
   *
   * @returns {boolean} true when the frame handled it; false to close as usual.
   */
  escape() {
    const f = this.frame;
    if (!f || typeof f.onEscape !== 'function') return false;
    const outcome = f.onEscape({ panel: this });
    if (outcome && outcome.push) { this.push(outcome.push); return true; }
    if (outcome && outcome.back) { this.back(); return true; }
    return false;
  }

  close(value = null) {
    this.stack = [];
    this.error = null;
    this.cursor = 0;
    this.scroll = 0;
    this.result = value;
    if (this._resolve) { const r = this._resolve; this._resolve = null; r(value); }
    return value;
  }

  /** Is there anything here to put a cursor ON? */
  get selectable() {
    return this.items.some((it) => it && it.selectable !== false);
  }

  move(delta, viewportRows = 10) {
    const n = this.items.length;
    if (!n) return;
    // ---- NOTHING TO SELECT MEANS THE ARROWS SCROLL --------------------------
    //
    // A panel of pure text — command output — has no selectable row, so the
    // loop below finds nothing, leaves the cursor at 0, and the view never
    // moves. `/status` produced twelve rows into a ten-row panel and the footer
    // said "(1-10 of 12)" while NO KEYSTROKE COULD REACH the other two. A
    // scrollable panel whose content cannot be scrolled is worse than a
    // truncated one, because it tells you what you are missing.
    if (!this.selectable) { this.scrollBy(delta, viewportRows); return; }
    // Skip non-selectable rows (headings/separators) in the direction of travel.
    let next = this.cursor;
    for (let i = 0; i < n; i++) {
      next = (next + delta + n) % n;
      if (this.items[next] && this.items[next].selectable !== false) break;
    }
    this.cursor = next;
    this._clampScroll(viewportRows);
  }

  _clampScroll(viewportRows, total = this.items.length) {
    const rows = Math.max(1, viewportRows);
    // THE CURSOR ONLY DRAGS THE VIEW WHEN THERE IS A CURSOR. With nothing
    // selectable the cursor sits at 0 forever, and following it here would haul
    // the view back to the top on the very next redraw — undoing the scroll
    // that `move` had just performed.
    if (this.selectable) {
      if (this.cursor < this.scroll) this.scroll = this.cursor;
      if (this.cursor >= this.scroll + rows) this.scroll = this.cursor - rows + 1;
    }
    const maxScroll = Math.max(0, total - rows);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    if (this.scroll < 0) this.scroll = 0;
  }

  scrollBy(delta, viewportRows = 10) {
    this.scroll = Math.max(0, Math.min(this.scroll + delta, Math.max(0, this.items.length - viewportRows)));
  }

  /**
   * Enter (or `→`). The adapter decides: resolve, drill down, or do nothing.
   *
   * WHICH KEY was pressed is passed through, because for some lists the two
   * mean different things — on the model list Enter is "use this" and `→` is
   * "show me its routes first". The panel does not interpret that; it only
   * reports it.
   */
  select({ key = 'enter' } = {}) {
    const f = this.frame;
    if (!f) return undefined;
    const item = this.items[this.cursor];
    if (!item || item.selectable === false) return undefined;
    if (typeof f.onSelect !== 'function') return this.close(item.value !== undefined ? item.value : item);
    const outcome = f.onSelect(item, { key, panel: this });
    if (outcome && outcome.push) { this.push(outcome.push); return undefined; }
    if (outcome && outcome.close !== undefined) return this.close(outcome.close);
    // The same refusal submitTyped allows: Enter on a MULTI_SELECT with nothing
    // marked is not an empty answer, it is a question that has not been
    // answered yet, and saying so beats resolving to "".
    if (outcome && outcome.reject) { this.error = String(outcome.reject); return undefined; }
    return undefined;
  }

  /**
   * A SINGLE TYPED LETTER THE OPEN PANEL CLAIMS — `D` for details on the
   * session browser being the first of them.
   *
   * A printable character is inserted into the input line and emits an `edit`,
   * never a `key`, so a panel that advertises "D details" in its footer cannot
   * receive one through handleKey. That is exactly how the completion overlay
   * came to advertise [D] and [R] and do nothing with either — a screen
   * offering shortcuts the input reader is structurally incapable of
   * delivering.
   *
   * So a letter is a shortcut ONLY when the open frame declares it, and only
   * for a MODAL panel: a completion menu is following what is being typed and
   * must never have letters stolen from it. Everything else falls through and
   * is typed, unchanged.
   *
   * @returns {boolean} true when the letter was claimed and acted on.
   */
  shortcut(letter) {
    const f = this.frame;
    if (!f || this.isCompletion) return false;
    const key = String(letter || '').toLowerCase();
    const fn = f.shortcuts && f.shortcuts[key];
    if (typeof fn !== 'function') return false;
    const outcome = fn(this.items[this.cursor] || null, { panel: this });
    if (outcome && outcome.push) { this.push(outcome.push); return true; }
    if (outcome && outcome.close !== undefined) { this.close(outcome.close); return true; }
    return outcome !== undefined;
  }

  /**
   * Render to lines. `rows` is the height the layout allotted; the panel windows
   * its own content so a 2,000-row list can never push the terminal around.
   */
  /**
   * Render to lines. `rows` is the height the layout allotted; the panel windows
   * its own content so a 2,000-row list can never push the terminal around.
   *
   * ------------------------------------------------------------------------
   * THE BOX IS GONE, AND IT WAS THE WORST THING ON THE SCREEN.
   *
   * It used to be drawn like this, at the full width of the terminal:
   *
   *     +------------------------------------------------------------+
   *     | COMMANDS                                                   |
   *     +------------------------------------------------------------+
   *     | > /exit        Save the session and leave                  |
   *     | ...                                                        |
   *     +------------------------------------------------------------+
   *     | ^v select - Enter confirm - Esc cancel        (1-6 of 58)   |
   *     +------------------------------------------------------------+
   *
   * Six rows of chrome, three of them heavy full-width rules, a boxed shouting
   * title, and a selection highlight stretching to a wall two hundred columns
   * away from the six characters it was about. That is an ncurses dialog, and it
   * is what made a surface that is otherwise a quiet conversation read as a TUI
   * dashboard.
   *
   * WHAT REPLACED IT, and every part of it is a subtraction:
   *
   *     Commands
   *
   *       > /exit      Save the session and leave
   *         /status    Session, provider and tool state
   *
   *       ^v select - Tab complete - Enter run - Esc cancel   (1-6 of 58)
   *
   *   NO FRAME.            Whitespace and one indent separate it from the
   *                        conversation. A list under the line you are filtering
   *                        with does not need a border to be understood as a list.
   *   A TITLE, NOT A BANNER. Sentence case, dim, on its own row.
   *   NO RULES AT ALL.     The blank rows do the work the three rules did.
   *   A CONTAINED SELECTION. The highlight is as wide as the menu's own content
   *                        and no wider — see `menuWidth`.
   *   THE SAME BOUNDED WINDOW. `(1-6 of 58)` is unchanged; it was the one part
   *                        of the old footer that was pulling its weight.
   */
  render(width = 80, rows = 12) {
    const f = this.frame;
    if (!f) return [];
    const out = [];
    // ---- THE MENU IS AS WIDE AS ITS CONTENTS, NOT AS WIDE AS THE TERMINAL ---
    //
    // On a 200-column terminal a command list needs about fifty of them. Letting
    // it take the frame meant a highlight, a title rule and a footer rule all
    // spanning the screen for the sake of `/exit  Save the session and leave`.
    const inner = this.menuWidth(width);
    const INDENT = '  ';
    const title = String(f.title || '');
    if (title) {
      // SENTENCE CASE. `COMMANDS` in capitals inside a box was the loudest thing
      // on a screen whose subject is a conversation.
      out.push(P.meta(INDENT + title.charAt(0) + title.slice(1).toLowerCase()));
      out.push('');
    }

    // Chrome is the title, its blank row, a blank row and the footer — four,
    // where the box spent six. The body gets the rest, so the panel returns
    // EXACTLY the height the layout allotted.
    const chrome = (title ? 2 : 0) + FOOTER_ROWS;
    const bodyRows = Math.max(1, rows - chrome);
    // ---- WRAP, OR CLIP ------------------------------------------------------
    //
    // A LIST OF OPTIONS CLIPS: one row per choice is what makes it scannable,
    // and a model id that runs long is still recognisable from its start.
    //
    // TEXT WRAPS. Command output is prose and paths, and clipping it cut words
    // in half - "Chat history exceeds the 800-mes..." told you a limit had been
    // hit and then took away the number. A frame says which it is (see
    // `outputAdapter`), because only the frame knows whether its rows are
    // choices or sentences.
    const shown = f.wrap ? wrapItems(this.items, inner) : this.items;
    this._clampScroll(bodyRows, shown.length);
    const slice = shown.slice(this.scroll, this.scroll + bodyRows);
    for (let i = 0; i < bodyRows; i++) {
      const item = slice[i];
      if (!item) { out.push(''); continue; }
      const idx = this.scroll + i;
      const sel = idx === this.cursor && item.selectable !== false;
      // `>` ONLY ON THE SELECTED ROW, and the others are not indented to make
      // room for a marker they do not have - they are, because a list whose rows
      // shift sideways as the cursor moves is a list that twitches.
      const marker = item.selectable === false ? '  ' : (sel ? '❯ ' : '  ');
      const text = marker + String(item.label == null ? '' : item.label);
      // ---- COLOUR IS APPLIED AFTER PADDING ---------------------------------
      //
      // `pad` and `clip` count characters, and an escape sequence is characters
      // that occupy no columns - so painting the label first makes every
      // coloured row short by the length of its own colour codes. Painting the
      // finished, padded string keeps the arithmetic honest.
      //
      // A row says its own TONE (`ok`, `warn`, `bad`) rather than its colour, so
      // the palette stays in one place and a route that is rate limited looks
      // the same here as it does in the live row.
      const body = pad(clip(text, inner), inner);
      const tint = item.tone && P[item.tone] ? P[item.tone] : null;
      // ---- THE ROW ENTER WILL CHOOSE, UNMISTAKABLY -------------------------
      //
      // BOTH CUES, ALWAYS. The marker survives monochrome, a pipe and a captured
      // log; the surface is what makes it win at a glance when colour is there.
      // Neither alone was enough - a list where some rows carry a tone puts a
      // coloured unselected row beside a plain selected one, and the brightest
      // thing on screen is then not the thing Enter will take.
      //
      // AND THE HIGHLIGHT STOPS AT THE MENU. It used to run to the terminal's
      // edge, which on a wide screen is a grey bar pointing at nothing.
      // ---- THE COMMAND IS THE ACCENT; ITS DESCRIPTION IS NOT ------------
      //
      // A row reads `/status      Session, provider and tool state` — a token you
      // are about to TYPE, and a sentence explaining it. At one weight the eye has
      // to read the whole row to find the half it came for. The token wears the
      // accent every command and path in LAIN wears (ui/paint.js `cmd`) and the
      // description is dim, so a list of sixty is scannable down its left edge.
      //
      // SPLIT ON THE GAP, which is how the rows are BUILT (two or more spaces
      // between the command and its description), not on a guess about lengths. A
      // row with no gap is one thing and is painted as one.
      //
      // AFTER PADDING, ALWAYS — see the note above. And a row with a TONE keeps it
      // whole: `rate limited` in yellow is about the entire row, not its first word.
      const painted = tint ? tint(body) : accentRow(body);
      out.push(INDENT + (sel ? P.surface(painted) : painted));
    }
    // THE REFUSAL, WHERE THE ANSWER WOULD HAVE GONE. Drawn in the last body row
    // rather than the footer: the footer says what the keys DO, and it must not
    // start flickering between instructions and complaints.
    if (this.error) {
      out[out.length - 1] = INDENT + P.bad(pad(clip('✗ ' + this.error, inner), inner));
    }
    const more = this.items.length > bodyRows
      ? `  (${this.scroll + 1}-${Math.min(this.scroll + bodyRows, this.items.length)} of ${this.items.length})`
      : '';
    out.push('');
    out.push(P.meta(INDENT + clip((f.footer || defaultFooter(this.stack.length)) + more, inner)));
    return out;
  }

  /**
   * HOW WIDE THE MENU IS: what its contents need, bounded by the frame.
   *
   * A list of six commands does not become more readable by being stretched to
   * two hundred columns, and the selection highlight is the part that makes that
   * obvious. So the width is the longest row it will actually draw, plus the
   * marker and a little air - and never more than the content frame it sits in,
   * which the layout has already decided.
   *
   * A FLOOR, so a one-word list is not a sliver; a CEILING, so a pasted sentence
   * in an item cannot drag the menu back out to the wall.
   */
  menuWidth(width) {
    const frame = Math.max(10, Math.floor(Number(width) || 80) - 2);
    let longest = 0;
    for (const it of this.items) {
      const n = String((it && it.label) || '').length;
      if (n > longest) longest = n;
    }
    const footer = String((this.frame && this.frame.footer) || defaultFooter(this.stack.length)).length + 18;
    const wanted = Math.max(longest + 2, footer, MENU_MIN);
    return Math.max(MENU_MIN, Math.min(frame, Math.min(wanted, MENU_MAX)));
  }
}

/**
 * A ROW'S COMMAND TOKEN, ACCENTED; THE REST OF IT, DIM.
 *
 * The marker (`> ` or two spaces) is left alone - it is the selection cue and
 * must survive monochrome. Everything up to the first two-space gap after it is
 * the token; everything after is explanation.
 *
 * A ROW THAT IS NOT SHAPED LIKE THAT is returned untouched rather than guessed
 * at: a model id, a file path, a sentence of command output, a blank row.
 */
function accentRow(body) {
  const m = /^(  |❯ )(\S+)(\s{2,})([\s\S]*)$/.exec(body);
  if (!m) return body;
  return m[1] + P.cmd(m[2]) + P.meta(m[3] + m[4]);
}

/**
 * HOW MANY ROWS ARE NOT CONTENT: a blank row and the footer.
 *
 * The box spent SIX — two borders, the title, two separators and the footer. Named
 * so ui/geometry.js sizes the region from the same number, and so a test can ask
 * rather than hardcode it.
 */
const FOOTER_ROWS = 2;

/** A menu narrower than this is a sliver; wider than this is a wall. */
const MENU_MIN = 32;
const MENU_MAX = 84;

function defaultFooter(depth) {
  return depth > 1
    ? '↑↓ select · Enter open · ← back · Esc close'
    : '↑↓ select · Enter confirm · Esc cancel';
}

function pad(s, width) {
  const t = String(s == null ? '' : s);
  return t.length >= width ? t.slice(0, width) : t + ' '.repeat(width - t.length);
}

/**
 * Expand items into DISPLAY ROWS, wrapping each label to the panel width.
 *
 * Continuation rows are never selectable: a wrapped sentence is one thing, and
 * letting a cursor land on its second half would make a list of two options
 * behave like a list of five.
 *
 * Indented by two so a wrapped line reads as belonging to the one above it,
 * and split on whitespace so words survive - the whole point is that clipping
 * cut them in half.
 */
function wrapItems(items, inner) {
  const width = Math.max(8, inner - 2);   // the marker column
  const out = [];
  // NOT NAMED "continuation": that word belongs to task.js, which owns whether
  // an INPUT continues the previous task, and an architecture guard keeps it to
  // one file. This is two spaces of indent on a wrapped row.
  const HANG = '  ';
  for (const item of items || []) {
    const text = String((item && item.label) == null ? '' : item.label).replace(/\s+$/, '');
    if (!text.trim()) { out.push({ ...item, label: '', selectable: false }); continue; }

    // THE LIMIT IS DECIDED PER ROW, BEFORE THE ROW IS BUILT. The first attempt
    // flipped "am I a wrapped row?" inside the flush, so a line was measured
    // against one width and drawn at another, and words were cut in half at the
    // difference.
    const words = text.split(/\s+/).filter(Boolean);
    let row = 0;
    let line = '';
    const limit = () => Math.max(4, width - (row === 0 ? 0 : HANG.length));
    const flush = () => {
      out.push({ ...item, label: (row === 0 ? '' : HANG) + line, selectable: false });
      row += 1;
      line = '';
    };
    for (let w of words) {
      // A SINGLE WORD LONGER THAN THE PANEL still has to go somewhere — a long
      // path, a token, a URL. It is hard-split rather than dropped or allowed
      // to run through the border.
      while (w.length > limit()) {
        if (line) flush();
        line = w.slice(0, limit());
        w = w.slice(limit());
        flush();
      }
      if (!w) continue;
      if (line && (line.length + 1 + w.length) > limit()) flush();
      line = line ? `${line} ${w}` : w;
    }
    if (line) flush();
  }
  return out;
}

function clip(s, width) {
  const t = String(s == null ? '' : s);
  return t.length <= width ? t : t.slice(0, Math.max(0, width - 1)) + '…';
}

module.exports = {
  FOOTER_ROWS,
  MODE, KIND, COMPLETION_KINDS, PASSIVE_KINDS, InteractionPanel,
  pad, clip,
};


// THE ADAPTERS LIVE IN ui/adapters.js — see its header for why. Required HERE,
// at the bottom, so this file's own exports already exist when that one
// destructures KIND/MODE/pad/clip from it. Re-exported so every existing caller
// keeps its single import.
Object.assign(module.exports, require('./adapters'));
