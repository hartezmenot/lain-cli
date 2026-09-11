'use strict';

/**
 * HOW A USER MESSAGE IS DRAWN — one concern, taken out of ui/feed.js.
 *
 * ------------------------------------------------------------------------
 * WHY IT MOVED, AND IT WAS THE GUARD'S IDEA.
 *
 * `feed.js` sat at 698 lines against a 700-line ceiling, so any real change to
 * it tripped the god-object guard — which is exactly what that guard is for. It
 * says "split it before it becomes repl.js", and this is the seam it was
 * pointing at: everything here answers ONE question — what does a person's own
 * message look like on the screen — and nothing else in that file asks it.
 *
 * feed.js still decides WHICH entries exist and groups the runs. This decides
 * how one run of them is turned into rows.
 *
 * ------------------------------------------------------------------------
 * A STRUCTURED PROMPT IS A DOCUMENT, NOT A PARAGRAPH.
 *
 * THE DEFECT: the user branch only ever called `wrap`, the PROSE wrapper, while
 * a model answer had gone through ui/markdown.js since it was written. So a
 * brief with headings, separators, bullets and numbered lists was word-wrapped
 * into one continuous block — the separator joined to the heading, the heading
 * joined to the paragraph after it:
 *
 *     0. ABSOLUTE PROJECT BOUNDARY ===== DO NOT modify LAIN. DO NOT...
 *     - easy provider management - Import Models - automatic model discovery
 *
 * Everything the person had done to make it readable was thrown away, and the
 * longer and better-structured the prompt, the worse it looked.
 *
 * THE SAME RENDERER, NOT A SECOND ONE. `markdown.render` is what the model
 * branch calls, at the same width, under the same rules — so a numbered list
 * means the same thing whoever typed it. `looksMarked` keeps an ordinary
 * one-line message on the cheap path, exactly as it does there.
 *
 * ------------------------------------------------------------------------
 * PRESENTATION ONLY. The ENTRIES are untouched and `source` below is still the
 * raw text — which is what `/copy`, `/copy context` and the click handler read.
 * Nothing here renumbers, rewrites, merges or drops a line of what was typed.
 */

const T = require('./text');

/** views.js holds the shared text helpers; required lazily to avoid a cycle. */
const V = () => require('./views');

/**
 * THE ROWS FOR ONE RUN OF USER ENTRIES.
 *
 * SPLIT INTO LINES FIRST. `markdown.render` takes ONE LINE PER ELEMENT — the
 * model branch gets that for free because its entries arrive per line as the
 * answer streams. A user message is ONE entry holding the whole document, so
 * passing the run straight in handed the renderer a single line containing
 * every newline, and it word-wrapped the lot: the original defect, reproduced
 * one layer further in.
 */
function userRows(run, room) {
  const md = require('./markdown');
  const NL = String.fromCharCode(10);
  const raw = run.join(NL);
  const rows = md.looksMarked(raw)
    ? md.render(raw.split(NL), room)
    : run.flatMap((t) => V().wrap(t, room));
  return { raw, rows };
}

/**
 * WHAT THE USER SAID IS A BLOCK, NOT A LINE.
 *
 * Painted across the full width on its own ground, so the eye finds the thing
 * that started each exchange by SHAPE rather than by reading — the same reason
 * a diff gets its own surface. Rows a person can click to bring back are worth
 * looking clickable.
 *
 * `out.userAt` maps the index of a drawn line to the message it came from, so a
 * click in the feed can put that message back on the input line without
 * re-deriving anything from the painted text. See ui/mouse.js.
 */
function userBlock(out, text, rows, width, P) {
  const w = Math.max(8, width);
  let first = true;
  for (const row of rows) {
    const body = (first ? '❯ ' : '  ') + row;
    out.userAt[out.length] = text;
    // NO BASE GUTTER HERE. The content frame owns the outer margin and the
    // layout positions this whole region inside it (ui/views.js
    // `contentBounds`), so a two-column indent of our own would be counted
    // twice. `body` still carries the `❯ ` marker and the alignment under it,
    // which is structure rather than margin.
    out.push(P.surface(T.pad(body, w)));
    first = false;
  }
}

module.exports = { userBlock, userRows };
