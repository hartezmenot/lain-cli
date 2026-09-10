'use strict';

/**
 * WHAT THE MODEL WROTE, RENDERED — instead of its markup shown raw.
 *
 * THE DEFECT, seen on a real screen. A model answers with headings, bullets and
 * a fenced code block, and the terminal shows:
 *
 *     ### What it does
 *     ```js
 *     return cache;
 *     ```
 *     - swallows the error
 *
 * The backticks, the hashes and the hyphens are INSTRUCTIONS TO A RENDERER, and
 * there was no renderer — so they were displayed as content. The result reads
 * like a log of somebody's markup rather than an answer, and the code is the
 * hardest part of it to find despite being the part with the answer in it.
 *
 * ------------------------------------------------------------------------
 * THIS IS PRESENTATION, AND THE ENTRIES STAY RAW.
 *
 * `pushModel` still stores exactly the lines the model wrote — that is the
 * canonical record, and a test pins it. This runs at DRAW time, where the width
 * is known, and returns painted rows. Nothing here changes what was said; it
 * changes how it is shown. The same separation the whole project runs on:
 * presentation must never become the data.
 * ------------------------------------------------------------------------
 *
 * DELIBERATELY SMALL. It handles the constructs a model actually uses in an
 * answer — fenced code, inline code, headings, bullets, numbered lists, bold,
 * quotes, rules — and passes everything else through untouched. A full
 * CommonMark implementation here would be a large dependency for a terminal
 * that cannot show most of what it parses, and every construct it got subtly
 * wrong would eat somebody's text.
 */

const T = require('./text');
const { P } = require('./paint');
const { wrap } = require('./doc');

/** Code is indented under a quiet gutter, so a block is findable at a glance. */
const CODE_GUTTER = '▏';

/**
 * FOLD A PREFORMATTED LINE AT A CHARACTER BOUNDARY — losslessly, and in place.
 *
 * THE RULE: a preformatted line is never broken on whitespace and never has a
 * run of spaces collapsed, because in code, a diagram, a tree or a diff hunk the
 * spacing IS the content. When a line will not fit, it is cut at the exact cell
 * the viewport ends at and continued on the next row, carrying its own leading
 * indent so the continuation stays under the block rather than under the margin.
 *
 * NOTHING IS LOST, which is the property that matters most: every character of
 * the source appears, in order, so selecting the block and copying it yields the
 * text that was actually written rather than a display-mutated version of it.
 * That is the whole argument against clipping with an ellipsis here.
 *
 * MEASURED IN CELLS, NOT CHARACTERS. A double-width glyph takes two columns, so
 * the cut is found by accumulating `T.width` one character at a time — slicing
 * by `length` is how a box-drawing figure ends up one column out on the row
 * after it.
 */
function foldPre(line, room) {
  const s = String(line == null ? '' : line).replace(/	/g, '  ');
  const w = Math.max(4, Math.floor(room));
  if (T.width(s) <= w) return [s];
  const indent = ((/^ */.exec(s) || [''])[0]).slice(0, 8);
  const out = [];
  let i = 0;
  let first = true;
  while (i < s.length) {
    const lead = first ? '' : indent;
    const room2 = Math.max(1, w - T.width(lead));
    let used = 0;
    let j = i;
    while (j < s.length) {
      const cw = T.width(s[j]) || 1;
      if (used + cw > room2) break;
      used += cw;
      j += 1;
    }
    if (j === i) j = i + 1;            // never fail to advance
    out.push(lead + s.slice(i, j));
    i = j;
    first = false;
  }
  return out;
}
/** Any fence line, opening or closing — used when unwrapping a how-to block. */
const FENCE_ANY = /^\s*(?:```|~~~)/;
const BULLET = '•';
/** A newline, as a value — this file avoids a bare escape in a joiner. */
const NL = String.fromCharCode(10);

/**
 * THE TWO LINES OF A SUMMARY SOMEBODY IS ACTUALLY LOOKING FOR.
 *
 * A summary is read once, quickly, and what the reader wants out of it is the
 * command: how do I run this, how do I check it. Rendered as ordinary prose
 * those two lines are indistinguishable from the eight around them, so finding
 * `npm test` means reading the whole report — which is the exact opposite of
 * what a summary is for.
 *
 * So a `How to run: …` / `How to test: …` line is drawn as a CALLOUT: the label
 * in full weight, the command on `P.surface` — the same quiet ground a user
 * message sits on, one step lighter than the terminal. One glance finds it.
 *
 * NARROW ON PURPOSE. It is a line that NAMES itself as one of the two, with a
 * separator and something after it. A paragraph that happens to begin "How to
 * test the parser is a separate question" has no separator-plus-command shape
 * and is left completely alone.
 */
const HOWTO = /^\s*(how\s+to\s+(?:run|test)|to\s+run|to\s+test)\s*[:—–-]\s*(\S.*)?$/i;

/**
 * The line with its list marker and bold markers taken off, for matching only.
 *
 * A model writes this line as `**How to test:** npm test` about as often as it
 * writes it plain, and the colon lands INSIDE the emphasis — so a pattern that
 * expects `**` to close before the separator misses the commonest spelling of
 * the very thing it is looking for. Stripping first means one pattern covers
 * every spelling instead of the pattern growing a branch per spelling.
 */
function unmarked(line) {
  return String(line).replace(/^\s*[-*+•]\s+/, '').replace(/\*\*/g, '').replace(/`/g, '');
}

/**
 * HOW WIDE A HOW-TO FRAME MAY GET, and why there is a ceiling at all.
 *
 * ------------------------------------------------------------------------
 * THE CEILING WAS 56 AND IT WAS THE BUG.
 *
 * The reasoning behind it was sound and it was applied to the wrong half of the
 * problem: a frame stretched across a 200-column terminal to hold `npm test` is
 * a box with a field of nothing in it. True — and `want` below already prevents
 * that, because the frame is sized to its CONTENT and short content makes a
 * short frame. The ceiling therefore never did anything for the case it was
 * written for. What it actually did was clamp the frame for content LONGER than
 * 56 columns, which then had to be cut to fit:
 *
 *     | node bin/lain.js (start a Probe with /mcp probe, th... |
 *
 * and cut identically at 60, 100, 160 and 240 columns, because the ceiling made
 * the terminal's width irrelevant. Resizing to fullscreen could not help. The
 * one thing in a summary a person is scanning for was the one thing the summary
 * destroyed.
 *
 * SO THE CEILING IS GONE, and the pane is the only bound left. The reading-
 * measure argument that might justify keeping one belongs to PROSE, which is
 * read left to right in paragraphs; a command is SCANNED and COPIED, and
 * breaking it across rows to respect a measure serves nobody. `want` still
 * keeps a short command in a short frame, which is the whole of what the
 * original ceiling was reaching for.
 *
 * What this buys is the behaviour the defect report asked for by name: at 60
 * columns the command wraps and is complete; at 160 it fits on one row and is
 * complete. Widening the terminal reveals content instead of doing nothing.
 */
/** Never narrower than this, however narrow the pane. */
const HOWTO_MIN = 24;
/**
 * A wrapped continuation is indented, so a command that needed two rows reads
 * as one command rather than as two. The same hanging indent a bullet gets.
 */
const CONT = '  ';

/**
 * THE SOURCE LINES OF A HOW-TO BLOCK, with its structure intact.
 *
 * Explicit newlines are the model's own paragraphing and they survive. A fenced
 * block's fences are dropped — they are instructions to a renderer, and this is
 * the renderer — while every line inside it is kept exactly as written,
 * indentation included, because in a command block the indentation is meaning.
 */
function howtoLines(command) {
  const raw = String(command == null ? '' : command).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of raw) {
    if (FENCE_ANY.test(line)) continue;
    out.push(String(line).replace(/\s+$/, ''));
  }
  // Blank rows at either end are the seam of the block, not part of it.
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.length ? out : [''];
}

/**
 * `HOW TO RUN` / `HOW TO TEST`, as a LABELLED FRAME THAT NEVER LOSES A CHARACTER.
 *
 * ------------------------------------------------------------------------
 * IT WAS A COLOURED SURFACE, AND COLOUR IS NOT ALWAYS THERE.
 *
 * The command sat on `P.surface` with the label beside it — which reads well on
 * a colour terminal and vanishes completely without one. `NO_COLOR`, a pipe, a
 * captured log, a terminal set to a flat theme: in every one of those the two
 * most-wanted lines of a summary went back to looking like the eight around
 * them, which is the exact failure the callout exists to prevent.
 *
 * A frame is STRUCTURAL. It survives monochrome, it survives `strip`, and it is
 * the shape the brief asks for by name. The colour stays on top of it, so
 * nothing is lost where colour is available.
 *
 *     ┌─ HOW TO RUN ─────────────────────────┐
 *     │ npm start                            │
 *     └──────────────────────────────────────┘
 *
 * ------------------------------------------------------------------------
 * IT WRAPS. IT DOES NOT CUT. This is the whole of the change, and it is a
 * correctness property rather than a preference: every other construct this
 * file renders — prose, bullets, numbered items, quotes, fenced code — already
 * reflows to the width it is given, and this one alone truncated. A box whose
 * job is to carry the command somebody is about to type is the last place in
 * the interface that may end a line with an ellipsis.
 *
 * `T.fit` is still what pads each row, and it can still clip — but every row
 * handed to it has already been wrapped to `inner`, so clipping is now
 * unreachable and `fit` only ever pads. tests/unit/howtobox.test.js pins that
 * by asserting the SOURCE text is recoverable from the drawn rows.
 *
 * SIZED TO ITS CONTENT, BOUNDED BY THE PANE. Short content still makes a short
 * frame — the original aesthetic argument, which was never in dispute — and
 * long content grows the frame up to the pane and then wraps inside it.
 */
function howtoBox(label, command, cols) {
  const title = String(label).replace(/\s+/g, ' ').toUpperCase();
  const source = howtoLines(command);
  const longest = source.reduce((n, l) => Math.max(n, T.width(l)), 0);
  // WIDE ENOUGH FOR THE CONTENT, NEVER WIDER THAN THE PANE. `cols` is the live
  // viewport width, handed down from ui/layout.js on every compose, so a resize
  // reaches this arithmetic without anything having to be invalidated.
  // THE CONTINUATION INDENT IS RESERVED IN THE SIZING TOO, or the frame asks
  // for exactly the width its content needs, the body then wraps two columns
  // short of it, and a command that would have fitted on one row is broken for
  // nothing — with a strip of empty frame beside it saying it had the room.
  const want = Math.max(T.width(title) + 6, longest + 4 + CONT.length);
  const w = Math.max(HOWTO_MIN, Math.min(cols, want));
  const inner = w - 4;

  const body = [];
  for (const line of source) {
    const lead = (/^[ \t]*/.exec(line) || [''])[0].replace(/\t/g, '  ').slice(0, 8);
    const text = line.slice((/^[ \t]*/.exec(line) || [''])[0].length);
    if (!text) { body.push(''); continue; }
    // ROOM RESERVED FOR THE CONTINUATION INDENT ON EVERY PART, including the
    // first. A continuation wrapped to the same width as its opening row would
    // be `inner + CONT` wide once indented, which overflows the frame — and an
    // overflowing row is torn open by the border, which is a worse failure than
    // the one being fixed.
    const room = Math.max(8, inner - lead.length - CONT.length);
    const parts = wrap(text, room);
    body.push(lead + parts[0]);
    for (const p of parts.slice(1)) body.push(lead + CONT + p);
  }

  const rows = T.box(title, body, w);
  return [
    '',
    P.meta(rows[0]),
    // The command itself keeps full weight inside quiet rules — it is the one
    // thing in a summary somebody is scanning for.
    ...body.map((b) => P.meta('│ ') + P.cmd(T.fit(b, inner)) + P.meta(' │')),
    P.meta(rows[rows.length - 1]),
    '',
  ];
}

/**
 * THE LINES A BARE `How to run:` LABEL OWNS, and where the block ends.
 *
 * Two shapes, and only two, because both are things a model actually writes and
 * neither requires guessing at intent:
 *
 *   A FENCE      everything between the fences, verbatim. The fences are
 *                markup and are dropped; what is inside them is the content.
 *   AN INDENT    consecutive indented lines, which is how a command block is
 *                written without a fence. Stops at the first line that is not
 *                indented, so the paragraph after the block is not swallowed.
 *
 * A blank line between the label and the block is allowed — models put one
 * there — but a blank line does not by itself continue an indented run, or the
 * block would reach across the gap into whatever followed it.
 *
 * @returns {{lines: string[], next: number}} the body, and the index to resume at
 */
function howtoBlock(src, at) {
  let j = at + 1;
  while (j < src.length && !String(src[j] == null ? '' : src[j]).trim()) j++;
  if (j >= src.length) return { lines: [], next: at + 1 };

  const first = String(src[j]);
  if (FENCE_ANY.test(first)) {
    const body = [];
    let k = j + 1;
    for (; k < src.length; k++) {
      const l = String(src[k] == null ? '' : src[k]);
      if (FENCE_ANY.test(l)) { k++; break; }
      body.push(l);
    }
    return { lines: body, next: k };
  }

  if (/^\s{2,}\S/.test(first)) {
    const body = [];
    let k = j;
    for (; k < src.length; k++) {
      const l = String(src[k] == null ? '' : src[k]);
      if (!/^\s{2,}\S/.test(l)) break;
      // The block's own indentation is relative to itself: two spaces in front
      // of every line is the marker that made it a block, not part of it.
      body.push(l.replace(/^\s{2}/, ''));
    }
    return { lines: body, next: k };
  }

  return { lines: [], next: at + 1 };
}

/**
 * THE CLOSING REPORT'S OWN SECTION LABELS, drawn as labels.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, on a real summary. src/prompt.js asks for the report in a named
 * schema — Issue, Fix, Changed, Verification, How to run, How to test — and a
 * model that writes those as bare words on their own line
 *
 *     Issue
 *     The flag parses but is never dispatched.
 *     Fix
 *     Dispatch it in run().
 *
 * got four paragraphs. `Issue` has no `#` in front of it, so the heading rule
 * never saw it, and the one structure a summary actually has was drawn as
 * prose. The reader is left scanning for the sections instead of finding them.
 *
 * ------------------------------------------------------------------------
 * ONLY THE SCHEMA, AND THAT IS THE WHOLE OF THE CAUTION. A rule that promoted
 * any short line to a heading would turn `Done.` and `npm test` and every
 * one-word answer into a section label, which is a worse screen than the one
 * this fixes. So the list is CLOSED, it is the list ui/classify.js already
 * keeps for deciding that a message IS the summary, and it is read from there
 * rather than copied — the renderer and the classifier cannot disagree about
 * what a heading is.
 *
 * AND IT MUST BE THE WHOLE LINE. `Fix the parser` is a sentence; `Fix` alone,
 * or `Fix:` with nothing after it, is a label. A line with content after the
 * colon — `How to run: npm start` — is the callout above, which is checked
 * first and is a different shape.
 */
const { SCHEMA_HEADING } = require('./classify');

/** ```lang … ``` — the fence, with an optional language after it. */
const FENCE = /^\s*(?:```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING = /^\s*(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.+)$/;
const NUMBERED = /^(\s*)(\d{1,3})[.)]\s+(.+)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

/**
 * INLINE MARKUP, applied to one line of prose.
 *
 * SCANNED, NOT PLACEHOLDER-SUBSTITUTED. The first version of this pulled code
 * spans out, left a sentinel behind, and put them back by matching it. Two
 * things went wrong at once and both are instructive: the sentinel was written
 * into the source as a raw NUL byte — invisible corruption of the kind this
 * project has a guard for — and any ordinary sentence containing the
 * placeholder's shape would have been rewritten into somebody else's code span.
 * A renderer silently eating text is the one thing it must never do.
 *
 * Scanning once and emitting as we go has no placeholder to collide with, and
 * every character either passes through or is deliberately consumed by a rule.
 * An unpaired marker is literal text, not the start of anything.
 */
function inline(text) {
  const s = String(text == null ? '' : text);
  let out = '';
  let i = 0;
  while (i < s.length) {
    // Code first, so `**kwargs` INSIDE a span keeps its asterisks.
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) { out += P.cmd(s.slice(i + 1, end)); i = end + 1; continue; }
    }
    if (s[i] === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) { out += P.key(s.slice(i + 2, end)); i = end + 2; continue; }
    }
    if (s[i] === '*' && s[i + 1] !== '*') {
      const end = s.indexOf('*', i + 1);
      const body = end > i + 1 ? s.slice(i + 1, end) : '';
      // Emphasis wraps something, and does not straddle spaces — `2 * 3 * 4`
      // is arithmetic and must survive exactly as written.
      if (body && !/^\s/.test(body) && !/\s$/.test(body)) {
        out += P.key(body);
        i = end + 1;
        continue;
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/**
 * Render model prose into painted rows.
 *
 * @param {string[]} lines  the raw lines, as the model wrote them
 * @param {number} width    columns available for the text itself
 * @returns {string[]} painted rows, ready to draw — never re-wrapped by callers
 */
/**
 * HOW WIDE PROSE MAY BE HERE - narrower than the frame on a very wide terminal.
 *
 * THE DISTINCTION THIS FILE HAS TO MAKE. A paragraph, a heading, a quote and a
 * bullet are PROSE: their width is a reading decision, and two hundred columns of
 * it is measurably harder to read than ninety. A fence, an indented block, a
 * how-to box and a rule are STRUCTURE: their width is part of what they mean, and
 * squeezing them into a reading measure breaks the thing the width was carrying.
 *
 * So every WRAPPING branch below asks for `measure` and every PREFORMATTED one
 * keeps `cols`. See ui/views.js `proseWidth` for the curve, and why it is not a
 * hard eighty columns.
 */
function render(lines, width) {
  const cols = Math.max(20, Number(width) || 80);
  const measure = require('./views').proseWidth(cols);
  const out = [];
  let inCode = false;

  const push = (row) => {
    // Never two blank rows running: a model that separates every line with a
    // blank one would otherwise double-space the whole answer.
    const blank = !String(row).trim();
    if (blank && !out.length) return;
    if (blank && !String(out[out.length - 1] || '').trim()) return;
    out.push(row);
  };

  // INDEXED, because a `How to run:` label can own the BLOCK written under it
  // and the branch that draws it has to be able to consume those rows. Nothing
  // else in this loop looks ahead; see `howtoBlock`.
  const src = Array.from(lines || []);
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const line = String(raw == null ? '' : raw);

    // ---- FENCED CODE ----------------------------------------------------
    const fence = FENCE.exec(line);
    if (fence) {
      if (!inCode) {
        inCode = true;
        push('');
        if (fence[1]) push(`  ${P.meta(CODE_GUTTER)} ${P.meta(fence[1])}`);
      } else {
        inCode = false;
        push('');
      }
      continue;                              // the fence itself is never drawn
    }
    if (inCode) {
      // CODE IS NOT REFLOWED. Its indentation is its meaning, so it is kept and
      // a line too long for the pane folds losslessly rather than being clipped.
      //
      // ---- AND THE FOLD IS NOT `wrap`, WHICH IS WHAT IT USED TO BE --------
      //
      // `wrap` is the PROSE wrapper: it breaks on whitespace and joins what it
      // keeps, so a run of spaces inside a line is collapsed and a continuation
      // starts at column zero of the block. That is correct for a sentence and
      // destroys a diagram — measured at 50 columns,
      //
      //     const veryLongVariableName = someFunction(argumentOne, argumentTwo,
      //     argumentThree, four);
      //
      // which has lost the alignment of everything after the break. The comment
      // above already said code is not reflowed; the implementation reflowed it.
      // See `foldPre`: a character-boundary fold that keeps every space and
      // carries the line's own indent onto each continuation.
      const room = Math.max(12, cols - 4);
      for (const p of foldPre(line, room)) push(`  ${P.meta(CODE_GUTTER)} ${P.cmd(p)}`);
      continue;
    }

    // ---- PREFORMATTED BY INDENTATION ------------------------------------
    //
    // Four spaces is markdown's own spelling of a code block, and it is how a
    // model writes an architecture diagram or a directory tree without reaching
    // for a fence:
    //
    //           A
    //           |
    //           v
    //           B ----> C
    //
    // It used to fall through to the prose branch, which preserved the leading
    // indent and then reflowed the rest on whitespace — so the moment a row was
    // wider than the viewport the figure came apart, and `inline()` was free to
    // read an asterisk in it as emphasis. STRUCTURE IS MEANING HERE, so it is
    // drawn verbatim: no markup processing, no reflow, every space kept.
    //
    // DRAWN PLAIN, not behind the code gutter. A gutter would reframe ordinary
    // indented prose as a code block, which is a louder change than this needs
    // to be — the only thing being fixed is that the spacing survives.
    if (/^ {4}/.test(line) && line.trim()) {
      for (const p of foldPre(line, Math.max(12, cols))) push(p);
      continue;
    }

    if (!line.trim()) { push(''); continue; }

    // ---- HOW TO RUN / HOW TO TEST, as a callout -------------------------
    //
    // The command goes on the reading surface because it is the one thing in a
    // summary a person is scanning for. The label keeps full weight next to it
    // so the pair reads as a unit.
    const how = HOWTO.exec(unmarked(line));
    if (how) {
      // ---- THE COMMAND MAY BE ON THIS LINE, OR IN A BLOCK UNDER IT --------
      //
      // `How to run: npm start` is the form src/prompt.js asks for and is the
      // common case. But a task with two commands, or a command plus the step
      // that has to happen first, does not fit on one line — and a model
      // writing that honestly produces
      //
      //     How to run:
      //     ```
      //     node bin/lain.js
      //     /mcp probe
      //     ```
      //
      // which used to render as a bare label followed by loose prose, with the
      // structure that made it readable thrown away. Both forms now reach the
      // same frame. NOTHING IS INFERRED: the block is taken only when the model
      // actually wrote one, and prose is never chopped into steps by guesswork.
      const block = howtoBlock(src, i);
      const body = how[2] ? [how[2], ...block.lines] : block.lines;
      if (body.length) {
        for (const row of howtoBox(how[1], body.join(NL), cols)) push(row);
        i = block.next - 1;
        continue;
      }
      // A LABEL WITH NOTHING UNDER IT is not a callout — it is a heading the
      // model left empty, and the schema rule below draws it as one.
    }

    // ---- THE SUMMARY SCHEMA, AS SECTION LABELS ---------------------------
    //
    // After HOWTO, which is the same words carrying a command and is drawn as
    // a frame instead. See SCHEMA_HEADING above for why this list is closed.
    const sec = SCHEMA_HEADING.exec(line);
    if (sec) {
      push('');
      // ---- ITS OWN CASE, NOT SHOUTED ----------------------------------
      //
      // `### Summary` became `SUMMARY` while `### Tests` — which is not on the
      // schema list — stayed `Tests`, so a final answer with both had two heading
      // weights in it for no reason a reader could infer. A heading is made a
      // heading by being bold; upper-casing it on top of that is a second claim.
      push(P.head(String(sec[1])));
      continue;
    }

    // ---- HEADINGS -------------------------------------------------------
    const h = HEADING.exec(line);
    if (h) {
      push('');
      const paint = h[1].length <= 2 ? P.head : P.key;
      for (const p of wrap(inline(h[2]), measure)) push(paint(p));
      continue;
    }

    if (RULE.test(line)) { push(P.meta('─'.repeat(Math.min(cols, 48)))); continue; }

    // ---- QUOTES ---------------------------------------------------------
    const q = QUOTE.exec(line);
    if (q) {
      for (const p of wrap(inline(q[1]), Math.max(12, measure - 2))) push(`${P.meta('│')} ${p}`);
      continue;
    }

    // ---- LISTS, with a hanging indent so wrapped text lines up ----------
    const b = BULLET_RE.exec(line);
    if (b) {
      const lead = `${b[1]}${BULLET} `;
      const parts = wrap(inline(b[2]), Math.max(12, measure - T.width(lead)));
      push(`${P.meta(b[1] + BULLET)} ${parts[0]}`);
      for (const p of parts.slice(1)) push(' '.repeat(T.width(lead)) + p);
      continue;
    }
    const n = NUMBERED.exec(line);
    if (n) {
      const lead = `${n[1]}${n[2]}. `;
      const parts = wrap(inline(n[3]), Math.max(12, measure - T.width(lead)));
      push(P.meta(lead) + parts[0]);
      for (const p of parts.slice(1)) push(' '.repeat(T.width(lead)) + p);
      continue;
    }

    // ---- ORDINARY PROSE -------------------------------------------------
    //
    // Its own leading indentation is preserved, because a model that indents a
    // continuation means something by it.
    const leading = (/^[ \t]*/.exec(line) || [''])[0];
    const indent = leading.replace(/\t/g, '  ').slice(0, 12);
    for (const p of wrap(inline(line.slice(leading.length)), Math.max(12, measure - indent.length))) {
      push(indent + p);
    }
  }

  while (out.length && !String(out[out.length - 1]).trim()) out.pop();
  return out;
}

/**
 * Does this text carry markup worth rendering? Cheap, so a plain answer skips.
 *
 * ------------------------------------------------------------------------
 * A `How to run:` LINE IS STRUCTURE, and it was not counted as any.
 *
 * The gate looked for fences, hashes, list markers and backticks. A short
 * summary that ends
 *
 *     Done.
 *
 *     How to run: npm start
 *     How to test: npm test
 *
 * has none of those — so this said no, the whole message took the plain path,
 * and the two lines the callout exists for were drawn as ordinary prose. Found
 * by testing the callout ON ITS OWN: every earlier test of it sat inside an
 * answer that happened to carry a list, and the list is what opened the gate.
 */
function looksMarked(text) {
  const s = String(text == null ? '' : text);
  return /(?:^|\n)\s*(?:```|~~~|#{1,6}\s|[-*+]\s|\d{1,3}[.)]\s|>\s)/.test(s)
    || /`[^`\n]+`/.test(s)
    || /\*\*[^*\n]+\*\*/.test(s)
    // A BARE SCHEMA HEADING IS STRUCTURE TOO, and by exactly the argument
    // above: `Issue` / `Fix` / `Changed` on their own lines carry no markup at
    // all, so a summary written that way took the plain path and lost the one
    // structure it had. Two of them, for the same reason ui/classify.js wants
    // two — one alone is a fragment, and a report is a structure.
    || s.split('\n').some((line) => HOWTO.test(unmarked(line)))
    || s.split('\n').filter((line) => SCHEMA_HEADING.test(line)).length >= 2;
}

module.exports = { render, inline, looksMarked, foldPre, CODE_GUTTER, BULLET, HOWTO };
