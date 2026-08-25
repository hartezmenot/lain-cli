'use strict';

/**
 * A STRUCTURED DOCUMENT, not a string with newlines in it.
 *
 * THE PROBLEM THIS EXISTS TO FIX. Every pane in this UI built its output by
 * pushing strings onto an array. That works while the content is a list, and
 * falls apart the moment the content has SHAPE — a heading with fields under
 * it, a fact with a counter-example, a section that should be aligned. What
 * comes out is a paragraph:
 *
 *     The operational contract says the shell is PowerShell and the CWD is the
 *     project root and line numbers are 1-based and PID is decimal and
 *     addresses are hexadecimal…
 *
 * — which contains everything and shows nothing. A reader has to parse prose to
 * recover structure the program already had and threw away.
 *
 * Adding `\n` to that does not fix it. The renderer has to KNOW there are
 * sections, fields and lists, because only then can it align values into a
 * column, wrap a long value under its own label, keep a heading with the block
 * it introduces, and decide what to do when the terminal is narrow.
 *
 * So a view builds a DOCUMENT — headings, fields, bullets, notes — and this
 * renders it to lines at whatever width there is.
 *
 * ------------------------------------------------------------------------
 * WHITESPACE IS INFORMATION, AND SO IS ALIGNMENT.
 *
 * Fields align to the widest label IN THEIR OWN GROUP rather than across the
 * whole document. A global column would be as wide as the longest label
 * anywhere — one 30-character label in one section pushing every value in every
 * other section far to the right, which is how "aligned" turns into "sparse and
 * hard to read".
 * ------------------------------------------------------------------------
 *
 * NOTHING IMPORTANT IS EVER CLIPPED. A value too long for the width WRAPS,
 * under a hanging indent, so a path or a command stays complete and copyable.
 * Clipping is for decoration; this is the content.
 */

const T = require('./text');
const { P } = require('./paint');

/** Below this, a label column costs more than it buys and fields stack. */
const MIN_FIELD_WIDTH = 34;
/** A label wider than this is a sentence; its value goes on the next line. */
const MAX_LABEL = 22;
const INDENT = '  ';

/**
 * THE SPACING SCALE — the fix for "tiny gaps that are not separation".
 *
 * One blank row between everything reads as one dense block with holes in it.
 * The eye groups by PROXIMITY, so a gap only separates when it is bigger than
 * the gaps inside the thing it is separating. Two rows before a major section
 * and one before a subsection is the smallest scale where that is true in a
 * terminal.
 *
 * Applied at the CONTAINER level. Nothing here pads individual text nodes,
 * which is what produces noise instead of hierarchy.
 */
const GAP = Object.freeze({ SECTION: 2, SUBSECTION: 1, TITLE: 1 });

/** Below this a two-column layout is worse than a stacked one. */
const COLUMN_BREAKPOINT = 76;

// ------------------------------------------------------------- wrapping ----

/**
 * Break text to a width, on word boundaries, ANSI-aware.
 *
 * Measured with `T.width` rather than `.length` so a coloured value does not
 * wrap early by the length of its escape sequences. A single word longer than
 * the width is broken rather than allowed to overflow — a 90-character path in
 * a 40-column pane has to go somewhere.
 */
/**
 * Take exactly `width` display columns off the front of `s`, LOSSLESSLY.
 *
 * NOT `T.clip`, which is a TRUNCATOR: it appends an ellipsis and is meant for
 * text that is being cut short on purpose. Using it to break a long word did
 * two things wrong at once — it wrote `…` into the middle of a path, and the
 * returned string was then longer than the text it represented, so advancing by
 * its length skipped real characters. `C:\Users\...\src\ui` came back as
 * `C:\Users\Hartezmeno…\Documents\lain-v2\…rc\ui`: an ellipsis in the middle
 * and a missing `s`. A path a reader cannot copy is a path that is not there.
 */
function hardSlice(s, width) {
  let taken = '';
  let used = 0;
  let i = 0;
  while (i < s.length && used < width) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { taken += m[0]; i += m[0].length; continue; }   // escapes cost no columns
    }
    taken += s[i];
    used += 1;
    i += 1;
  }
  return taken;
}

/** Where a long token can be broken so the pieces still read as one thing. */
const BREAK_AFTER = /[\\/\-_.,:;]/;

/**
 * Break text to a width, on word boundaries, ANSI-aware.
 *
 * Measured with `T.width` rather than `.length` so a coloured value does not
 * wrap early by the length of its escape sequences.
 *
 * A single word longer than the width is broken rather than allowed to
 * overflow, and the break prefers a path or identifier separator near the end
 * of the line so `src/ui/doc.js` splits between segments instead of mid-word.
 * Every character survives: joining the pieces reproduces the input exactly.
 */
function wrap(text, width) {
  const s = String(text == null ? '' : text);
  if (width <= 0) return [s];
  if (T.width(s) <= width) return [s];
  const out = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
    if (!word) continue;
    const candidate = line ? `${line} ${word}` : word;
    if (T.width(candidate) <= width) { line = candidate; continue; }
    if (line) { out.push(line); line = ''; }
    let rest = word;
    while (T.width(rest) > width) {
      let piece = hardSlice(rest, width);
      // Prefer a separator in the last third, so a path breaks at a boundary.
      const floor = Math.floor(piece.length * 0.66);
      for (let k = piece.length - 1; k > floor; k--) {
        if (BREAK_AFTER.test(piece[k])) { piece = piece.slice(0, k + 1); break; }
      }
      out.push(piece);
      rest = rest.slice(piece.length);
      if (!piece.length) break;                 // cannot advance; stop rather than loop
    }
    line = rest;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/**
 * HOW MANY WRAPPED ROWS ONE SOURCE LINE MAY OCCUPY.
 *
 * Generous enough that a real log line, a stack frame or a deep path is drawn
 * whole, and bounded so a minified bundle printed to stdout - one line of forty
 * thousand characters - cannot turn a scrollable pane into a wall. What is past
 * the bound is COUNTED and said by the caller, never silently cut.
 *
 * ONE OWNER, because the OUTPUT pane and the transcript tail were about to
 * declare this separately with the same value and the same reasoning, which is
 * exactly how two bounds come to disagree.
 */
const MAX_WRAPPED_ROWS = 12;

/**
 * WRAP A LINE WITHOUT DESTROYING WHAT ITS INDENTATION MEANT.
 *
 * ------------------------------------------------------------------------
 * WHY `wrap` ALONE IS THE WRONG TOOL FOR OUTPUT, and this was caught before it
 * shipped rather than after.
 *
 * `wrap` splits on whitespace and rejoins with single spaces, which is exactly
 * right for PROSE and quietly wrong for anything whose layout is information:
 *
 *     '    ok 12 - parses the header'   ->  'ok 12 - parses the header'
 *
 * A short line escapes it (there is nothing to rejoin) and a long one does not,
 * so the damage appears only on the lines that most need reading - a nested
 * test result, a stack frame, a tree listing. Replacing a truncation defect
 * with an indentation defect is not a fix.
 *
 * So the leading whitespace is taken off, held, and put back: the first row
 * keeps the line's own indent, and every continuation gets that indent plus
 * `cont` so it is visibly more of the same line rather than a new one.
 *
 * @param {string} text   one source line
 * @param {number} width  columns available for the whole row, indent included
 * @param {string} cont   what marks a continuation. Two spaces by default.
 * @returns {string[]} at least one row; never fewer characters than it was given
 */
function wrapIndented(text, width, cont = '  ') {
  const line = String(text == null ? '' : text);
  const lead = (/^[ 	]*/.exec(line) || [''])[0].replace(/	/g, '  ');
  const body = line.slice((/^[ 	]*/.exec(line) || [''])[0].length);
  if (!body) return [''];
  // ---- A LINE THAT ALREADY FITS IS NOT WRAPPED ---------------------------
  //
  // Room has to be reserved for the continuation marker — a continuation
  // wrapped to the full width overflows once it is indented, and an
  // overflowing row tears open whatever frame it sits in. But reserving it
  // UNCONDITIONALLY splits a line that fitted perfectly well, which is a
  // truncation defect wearing different clothes: it cost
  //
  //     Plan finished, but the task is not complete - 1 file(s) changed but
  //     nothing has been run to        <- broken here, for no reason at all
  //       check
  //
  // two extra rows and a sentence a person has to reassemble. So the fit is
  // tried at the FULL width first; the reservation applies only once the text
  // has actually earned a second row.
  const full = wrap(body, Math.max(8, width - lead.length));
  if (full.length <= 1) return [lead + full[0]];
  const parts = wrap(body, Math.max(8, width - lead.length - cont.length));
  return [lead + parts[0], ...parts.slice(1).map((p) => lead + cont + p)];
}

// ------------------------------------------------------------- the model ---

/**
 * The block kinds. Deliberately few: every one earns its place by rendering
 * differently, and a kind that renders like another is that other one.
 */
const K = Object.freeze({
  TITLE: 'title',
  SUBTITLE: 'subtitle',
  SECTION: 'section',
  SUBSECTION: 'subsection',
  NUMBER: 'number',
  COLUMNS: 'columns',
  FIELD: 'field',
  BULLET: 'bullet',
  TEXT: 'text',
  NOTE: 'note',
  BLANK: 'blank',
  RULE: 'rule',
  RAW: 'raw',
});

class Doc {
  constructor() { this.blocks = []; }

  /** The pane's name. Drawn once, at the top, with a rule under it. */
  title(text, right = null) { this.blocks.push({ k: K.TITLE, text, right }); return this; }

  /** The one-line description under the title. */
  subtitle(text) { this.blocks.push({ k: K.SUBTITLE, text }); return this; }

  /** A major group heading. Carries TWO blank rows above it — see GAP. */
  section(text, right = null) { this.blocks.push({ k: K.SECTION, text, right }); return this; }

  /** A heading inside a section. One blank row above, so it reads as nested. */
  subsection(text) { this.blocks.push({ k: K.SUBSECTION, text }); return this; }

  /**
   * A NUMBERED item — for things where the ORDER is the information.
   *
   * Separate from bullet() on purpose: flattening an ordered procedure into
   * bullets loses the one thing it was trying to say.
   */
  number(n, text, { tone = null } = {}) {
    this.blocks.push({ k: K.NUMBER, n, text: String(text), tone });
    return this;
  }

  /**
   * Two columns side by side, STACKED when the terminal is too narrow.
   *
   * Squeezing two columns into sixty characters is harder to read than putting
   * one under the other, so below the breakpoint they stack. Each side is
   * `{ heading, rows }`.
   */
  columns(left, right, { breakpoint = COLUMN_BREAKPOINT } = {}) {
    this.blocks.push({ k: K.COLUMNS, left, right, breakpoint });
    return this;
  }

  /**
   * An aligned label/value row — the workhorse.
   *
   * `tone` colours only the VALUE, because the label is structure and the value
   * is the fact. `note` is a quiet second line under it, for a counter-example
   * or an explanation.
   */
  field(label, value, { tone = null, note = null } = {}) {
    this.blocks.push({ k: K.FIELD, label: String(label), value: value == null ? '' : String(value), tone, note });
    return this;
  }

  bullet(text, { mark = '•', tone = null } = {}) {
    this.blocks.push({ k: K.BULLET, text: String(text), mark, tone });
    return this;
  }

  /** A wrapped paragraph. For prose that genuinely IS prose. */
  text(t) { this.blocks.push({ k: K.TEXT, text: String(t == null ? '' : t) }); return this; }

  /** Quiet, indented, secondary. */
  note(t) { this.blocks.push({ k: K.NOTE, text: String(t == null ? '' : t) }); return this; }

  blank() { this.blocks.push({ k: K.BLANK }); return this; }
  rule() { this.blocks.push({ k: K.RULE }); return this; }

  /** Lines that are already rendered — a diff, a feed, a captured output. */
  raw(lines) {
    for (const l of (Array.isArray(lines) ? lines : [lines])) this.blocks.push({ k: K.RAW, text: String(l == null ? '' : l) });
    return this;
  }

  /** True when nothing but structure was added — used to show an empty state. */
  get empty() {
    return !this.blocks.some((b) => b.k === K.FIELD || b.k === K.BULLET || b.k === K.TEXT || b.k === K.RAW);
  }

  render(width = 80) { return render(this, width); }
}

function doc() { return new Doc(); }

// ------------------------------------------------------------- rendering ---

/**
 * How wide the label column should be for one run of fields.
 *
 * The widest label in the group, capped — and abandoned entirely when the pane
 * is too narrow to give a value useful room after it, in which case fields
 * stack instead. A two-column layout in thirty columns is one column with a gap
 * down the middle.
 */
function labelWidth(group, width) {
  if (width < MIN_FIELD_WIDTH) return 0;
  let w = 0;
  for (const f of group) w = Math.max(w, T.width(f.label));
  return Math.min(w, MAX_LABEL);
}

/** The runs of consecutive FIELD blocks, so each aligns on its own. */
function fieldGroups(blocks) {
  const groups = new Map();
  let run = [];
  const flush = () => {
    for (const b of run) groups.set(b, run);
    run = [];
  };
  for (const b of blocks) {
    if (b.k === K.FIELD) { run.push(b); continue; }
    if (run.length) flush();
  }
  if (run.length) flush();
  return groups;
}

/**
 * TWO COLUMNS, OR ONE — decided by the width actually available.
 *
 * Squeezing two columns into a narrow terminal makes both harder to read than
 * either would be alone, so below the breakpoint they STACK. That is the whole
 * responsive rule: the layout changes, the content does not shrink.
 */
function renderColumns(b, cols) {
  const out = [];
  const left = b.left || { heading: '', rows: [] };
  const right = b.right || { heading: '', rows: [] };

  if (cols < (b.breakpoint || COLUMN_BREAKPOINT)) {
    // STACKED. Each side keeps its heading, with a blank row between them so
    // they still read as two groups rather than one longer list.
    for (const side of [left, right]) {
      if (side.heading) out.push(P.key(String(side.heading).toUpperCase()));
      for (const r of side.rows) out.push(INDENT + r);
      out.push('');
    }
    while (out.length && !String(out[out.length - 1]).trim()) out.pop();
    return out;
  }

  const half = Math.floor((cols - INDENT.length) / 2);
  const pad = (text) => text + ' '.repeat(Math.max(0, half - T.width(text)));
  if (left.heading || right.heading) {
    out.push(INDENT + pad(P.key(String(left.heading || '').toUpperCase()))
      + P.key(String(right.heading || '').toUpperCase()));
  }
  const n = Math.max(left.rows.length, right.rows.length);
  for (let i = 0; i < n; i++) {
    const l = left.rows[i] || '';
    const r = right.rows[i] || '';
    // Truncation would lose content, so a row too wide for its half simply
    // runs on — the column is a convenience, the text is the point.
    out.push(INDENT + pad(l) + r);
  }
  return out;
}

function render(d, width) {
  const cols = Math.max(20, Number(width) || 80);
  const out = [];
  const groups = fieldGroups(d.blocks);
  // ---- THE SPACING ENGINE ------------------------------------------------
  //
  // `gap(n)` asks for AT LEAST n blank rows before the next content. It is
  // the whole fix for "the gaps are there but they do not separate": a
  // section asks for two, a subsection for one, and the engine tops up
  // whatever is already there rather than blindly appending. Nothing is
  // emitted at the very top, and a run never grows past what was asked for.
  let blanks = 99;                         // suppress any leading blank rows
  let wrote = false;

  const push = (line) => {
    if (!String(line).trim()) { blanks += 1; return; }
    // A gap only exists BETWEEN things. Before the first row there is nothing
    // to separate, and emitting one there just pushes the title off the top.
    for (let i = 0; wrote && i < Math.min(blanks, 2); i++) out.push('');
    blanks = 0;
    wrote = true;
    out.push(line);
  };
  const gap = (n) => { if (wrote) blanks = Math.max(blanks, n); };

  for (const b of d.blocks) {
    switch (b.k) {
      case K.TITLE: {
        const left = P.head(String(b.text).toUpperCase());
        if (b.right) {
          const room = cols - T.width(left) - T.width(String(b.right)) - 2;
          push(room > 1 ? `${left}${' '.repeat(room)}  ${P.meta(b.right)}` : left);
        } else push(left);
        push(P.meta('═'.repeat(cols)));
        break;
      }
      case K.SUBTITLE:
        for (const l of wrap(b.text, cols)) push(P.meta(l));
        break;
      case K.SECTION: {
        gap(GAP.SECTION);
        const left = P.head(String(b.text).toUpperCase());
        push(b.right ? `${left}  ${P.meta(b.right)}` : left);
        break;
      }
      case K.SUBSECTION: {
        gap(GAP.SUBSECTION);
        push(P.key(String(b.text)));
        break;
      }
      case K.NUMBER: {
        // The number is the information, so it keeps full weight while the
        // text stays normal — the opposite of making everything bold.
        const lead = `${INDENT}${b.n}. `;
        const parts = wrap(b.text, Math.max(12, cols - T.width(lead)));
        push(INDENT + P.key(`${b.n}.`) + ' ' + (b.tone || P.plain)(parts[0]));
        for (const l of parts.slice(1)) push(' '.repeat(T.width(lead)) + (b.tone || P.plain)(l));
        break;
      }
      case K.COLUMNS: {
        gap(GAP.SUBSECTION);
        for (const row of renderColumns(b, cols)) push(row);
        break;
      }
      case K.FIELD: {
        const lw = labelWidth(groups.get(b) || [b], cols);
        const tone = b.tone || P.plain;
        if (!lw || T.width(b.label) > lw) {
          // STACKED. The label on its own line, the value indented under it —
          // what a narrow pane, or an unusually long label, leaves room for.
          push(INDENT + P.meta(b.label));
          for (const l of wrap(b.value, cols - INDENT.length * 2)) push(INDENT + INDENT + tone(l));
        } else {
          const gap = lw - T.width(b.label) + 2;
          const head = INDENT + P.meta(b.label) + ' '.repeat(gap);
          const room = cols - INDENT.length - lw - 2;
          const parts = wrap(b.value, Math.max(8, room));
          push(head + tone(parts[0]));
          // A wrapped value hangs under its own value column, never under the
          // label, so the column stays readable top to bottom.
          for (const l of parts.slice(1)) push(' '.repeat(INDENT.length + lw + 2) + tone(l));
        }
        if (b.note) {
          for (const l of wrap(b.note, cols - INDENT.length * 2)) push(INDENT + INDENT + P.meta(l));
        }
        break;
      }
      case K.BULLET: {
        const tone = b.tone || P.plain;
        const lead = `${INDENT}${b.mark} `;
        const parts = wrap(b.text, cols - T.width(lead));
        push(lead + tone(parts[0]));
        for (const l of parts.slice(1)) push(' '.repeat(T.width(lead)) + tone(l));
        break;
      }
      case K.TEXT:
        for (const l of wrap(b.text, cols - INDENT.length)) push(INDENT + l);
        break;
      case K.NOTE:
        for (const l of wrap(b.text, cols - INDENT.length * 2)) push(INDENT + INDENT + P.meta(l));
        break;
      case K.RULE:
        push(P.meta('─'.repeat(cols)));
        break;
      case K.BLANK:
        gap(1);
        break;
      case K.RAW:
      default:
        if (String(b.text).trim()) push(b.text);
        else blanks += 1;
        break;
    }
  }
  // A trailing blank is padding nobody asked for.
  while (out.length && !String(out[out.length - 1]).trim()) out.pop();
  return out;
}

module.exports = {
  doc, Doc, render, wrap, wrapIndented, hardSlice, renderColumns, MAX_WRAPPED_ROWS,
  K, GAP, MIN_FIELD_WIDTH, MAX_LABEL, COLUMN_BREAKPOINT,
};
