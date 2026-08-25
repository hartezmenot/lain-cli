'use strict';

/**
 * WIDTH MATHS THAT SURVIVES COLOUR.
 *
 * Every region of the screen is drawn by measuring a string and padding it out
 * to the frame — `'│ ' + line + ' '.repeat(inner - line.length) + ' │'`. With
 * `String.length` that arithmetic is a lie the moment a line carries an ANSI
 * escape: `\x1b[32m✓\x1b[0m` is ONE visible character and nine in memory, so a
 * coloured row loses its right-hand border and the frame tears open.
 *
 * That is why every workspace pane was plain text: the clipper could not see
 * colour, so colour was banned rather than measured. This module measures it,
 * and the ban goes away.
 *
 * THE RULE: nothing on screen is ever measured with `.length` again. `width()`
 * counts what the terminal will actually show; `clip()` truncates by visible
 * characters while copying the escapes through (they cost no cells); `pad()`
 * fills to a visible width. A clipped string that still had colour open is
 * closed with a reset, because a truncation must never leak its colour into the
 * rest of the row.
 *
 * Zero-width and double-width characters are NOT handled: LAIN draws box rules,
 * ASCII and a small fixed set of symbols, and a wcwidth table for the general
 * case would be a large dependency for a problem this UI does not have. If that
 * changes, it changes HERE, in one function, and every region inherits it.
 */

/** One SGR sequence — the only escape LAIN ever emits into drawn content. */
const SGR = /\x1b\[[0-9;]*m/;
const SGR_G = /\x1b\[[0-9;]*m/g;
const SGR_HEAD = /^\x1b\[[0-9;]*m/;
const RESET = '\x1b[0m';

/** The string as the terminal will show it, with all colour removed. */
function strip(s) {
  return String(s == null ? '' : s).replace(SGR_G, '');
}

/** How many cells this string occupies. THE measurement, used everywhere. */
function width(s) {
  return strip(s).length;
}

/** Does this string carry colour? Cheap enough to gate the slow path on. */
function hasAnsi(s) {
  return SGR.test(String(s == null ? '' : s));
}

/**
 * Truncate to `w` VISIBLE characters, ellipsis included, colour preserved.
 *
 * Escapes are copied through and cost nothing, so a coloured line clips at the
 * same place its plain equivalent would.
 */
function clip(s, w) {
  const t = String(s == null ? '' : s);
  if (w <= 1) return '';
  if (!hasAnsi(t)) return t.length <= w ? t : t.slice(0, w - 1) + '…';
  if (width(t) <= w) return t;
  let out = '';
  let seen = 0;
  let i = 0;
  while (i < t.length) {
    const m = SGR_HEAD.exec(t.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    if (seen >= w - 1) break;
    out += t[i];
    seen += 1;
    i += 1;
  }
  // The truncation may have cut before the closing reset. Leaving colour open
  // would bleed it across the rest of the drawn row.
  return out + '…' + RESET;
}

/**
 * A TAB IS NOT A CHARACTER, AND IT MUST NEVER REACH A PAINTED REGION.
 *
 * ------------------------------------------------------------------------
 * SEEN ON SCREEN, as black rectangles punched through the diff window's grey
 * surface. `read_file` emits `  1990\t    def implement(…)`, that tab was drawn
 * verbatim, and a terminal handling a tab does not WRITE anything — it moves
 * the cursor to the next tab stop. The cells it skips keep whatever background
 * was already there, which is the terminal's default and not the one this row
 * had opened. So the surface simply is not painted across the gap.
 *
 * IT BREAKS THE ARITHMETIC TOO, which is the half that would have gone on
 * hurting quietly. `width()` counts a tab as one cell; the terminal advances up
 * to eight. Every row containing one is measured short, so it is padded too far
 * and its right-hand border lands past the frame — the same tearing this whole
 * module exists to prevent, from an input nobody thought to expand.
 *
 * Expanded HERE rather than at each call site, because "how wide is this
 * string" and "what does the terminal do with it" have to be answered by one
 * function or they disagree.
 */
function detab(s, stop = 8) {
  const t = String(s == null ? '' : s);
  if (!t.includes('\t')) return t;
  let out = '';
  let col = 0;
  let i = 0;
  while (i < t.length) {
    // A WHOLE ESCAPE SEQUENCE OCCUPIES NO COLUMNS — not just its first byte.
    // Skipping only the ESC left `[2m` counted as three visible characters, so
    // a tab after any colour change landed at the wrong stop. Every other
    // function here already measures this way (`strip`); this one has to agree
    // with them or two parts of the same row disagree about where column eight
    // is.
    const esc = SGR_HEAD.exec(t.slice(i));
    if (esc) { out += esc[0]; i += esc[0].length; continue; }
    if (t[i] === '\t') {
      const n = stop - (col % stop);
      out += ' '.repeat(n);
      col += n;
      i += 1;
      continue;
    }
    out += t[i];
    col += 1;
    i += 1;
  }
  return out;
}

/** Fill to `w` visible characters. Never truncates — see `fit` for that. */
function pad(s, w) {
  const t = String(s == null ? '' : s);
  const n = width(t);
  return n >= w ? t : t + ' '.repeat(w - n);
}

/** Right-align to `w` visible characters. */
function padStart(s, w) {
  const t = String(s == null ? '' : s);
  const n = width(t);
  return n >= w ? t : ' '.repeat(w - n) + t;
}

/** Clip AND pad: exactly `w` visible characters, whatever came in. */
function fit(s, w) {
  return pad(clip(s, w), w);
}

/** Centre within `w`, measuring visibly. */
function center(s, w) {
  const t = clip(s, w);
  const n = width(t);
  return ' '.repeat(Math.max(0, Math.floor((w - n) / 2))) + t;
}

/**
 * Shorten a path from the LEFT, keeping the end — the part that identifies the
 * project. `C:\Users\x\Documents\proj\src\a.js` → `…\proj\src\a.js`. Trimming
 * the tail instead would hide the filename, which is the only part that matters.
 */
function shortPath(p, w) {
  const s = String(p || '');
  if (s.length <= w) return s;
  const sep = s.includes('\\') ? '\\' : '/';
  const parts = s.split(sep);
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i > 0; i--) {
    const next = parts[i] + sep + out;
    // The result gets an ellipsis AND a separator in front of it — two
    // characters, not one. Budgeting for one accepted a segment that then
    // pushed the string one over the width, and the clip took it off the END:
    // the filename, which is the only part this function exists to keep.
    if (next.length + 2 > w) break;
    out = next;
  }
  return clip('…' + sep + out, w);
}

/** The folder name — what the user calls the project. */
function projectName(cwd) {
  const s = String(cwd || '').replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/**
 * A LABELLED FRAME around a block of lines.
 *
 * `┌─ PROJECT HEALTH — scalpbot ─────┐` … `└──────┘`. A report that fills a pane
 * needs an edge, or it reads as text that happens to be on the screen rather
 * than a thing you are looking at. Every row is fitted to the same inner width,
 * so the right-hand border is straight whatever the content did — including
 * content that carries colour.
 */
function box(title, lines, w) {
  const width_ = Math.max(20, w);
  const inner = width_ - 4;
  const head = title ? ' ' + String(title) + ' ' : '';
  const room = width_ - 3 - width(head);
  const out = [room >= 0 ? '┌─' + head + '─'.repeat(room) + '┐' : '┌' + '─'.repeat(width_ - 2) + '┐'];
  for (const l of lines) out.push('│ ' + fit(l, inner) + ' │');
  out.push('└' + '─'.repeat(width_ - 2) + '┘');
  return out;
}

module.exports = {
  strip, width, hasAnsi, detab, clip, pad, padStart, fit, center, shortPath, projectName, box, RESET,
};
