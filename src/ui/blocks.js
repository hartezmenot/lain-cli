'use strict';

/**
 * SEMANTIC BLOCKS — one visual language for everything LAIN does.
 *
 * THE PROBLEM. The feed renders six kinds of entry at roughly one visual
 * weight, in one column, one after another. What LAIN SAID, what it DID, what a
 * tool RETURNED and what an external model ANSWERED all arrive as prose in the
 * same place, so telling them apart means reading them. At length that becomes
 * a wall: the answer you came for is somewhere inside the machinery that
 * produced it.
 *
 * ------------------------------------------------------------------------
 * THE GUTTER IS THE WHOLE IDEA.
 *
 *     LAIN
 *     I think the reconnect handler is dropping sockets.
 *
 *     │ ACTION
 *     │ Ask external models for a second opinion
 *     │
 *     │ TOOL   browser → ChatGPT
 *     │ responded · 1.2 KB
 *
 * Ordinary explanation keeps the left margin and stays exactly as readable as
 * it was. Everything that is MACHINERY moves behind a quoted vertical line, so
 * a glance down the left edge separates "what it said" from "what it did"
 * without reading a word. That is the entire mechanism, and it is why this is a
 * primitive rather than markup sprinkled at each call site.
 * ------------------------------------------------------------------------
 *
 * REUSABLE, NOT ONE-OFF. Every block below returns `string[]` — the same shape
 * the feed, the panes and doc.js already speak — so a block drops into any of
 * them unchanged. The external workflow and the ordinary workflow therefore
 * share one visual language because they call the same functions, not because
 * two renderers were kept in step by hand.
 */

const T = require('./text');
const { P } = require('./paint');
const { wrap } = require('./doc');

/** The quoted line. One glyph, one meaning: this is agent activity. */
const GUTTER = '│';
/** Answer cards inside a block. The UI already draws boxes; this matches them. */
const BOX = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };

const INDENT = '  ';
/** Below this there is no room for a gutter AND readable text. */
const MIN_WIDTH = 24;

/** Prefix every row with the gutter, quietly. */
function quote(rows, { width = 80 } = {}) {
  const g = P.meta(`${GUTTER} `);
  return rows.map((r) => (r === '' ? P.meta(GUTTER) : g + r));
}

/**
 * The body of a block: a heading, then wrapped rows, all behind the gutter.
 *
 * `tone` colours the HEADING only. The heading is what a reader scans for; the
 * body is what they read once they have found it, and colouring both makes
 * neither stand out.
 */
function block(heading, rows, { width = 80, tone = null, right = null } = {}) {
  const w = Math.max(MIN_WIDTH, width);
  const inner = w - INDENT.length - 2;
  const paint = tone || P.key;
  const head = right
    ? `${paint(heading)}   ${P.meta(right)}`
    : paint(heading);
  const body = [];
  for (const r of rows) {
    if (r == null) continue;
    if (r === '') { body.push(''); continue; }
    // Already-rendered rows (a diff, a tool result) pass through; plain text
    // wraps. Detected by whether the row carries its own colour.
    if (T.hasAnsi(r)) { body.push(r); continue; }
    for (const line of wrap(r, inner)) body.push(line);
  }
  return quote([head, ...body], { width: w }).map((l) => INDENT + l);
}

// ------------------------------------------------------------- primitives ---

/** Something LAIN decided to do, said as an intention. */
function actionBlock(text, { width = 80, detail = null } = {}) {
  return block('ACTION', [text, ...(detail ? ['', detail] : [])], { width, tone: P.info });
}

/**
 * A tool call, with its outcome ON THE SAME BLOCK.
 *
 * Grouping them is the point: a call and its result rendered as two separate
 * entries several rows apart is how a reader loses which result belongs to
 * which call.
 */
function toolBlock(name, { width = 80, status = null, detail = null, ok = null } = {}) {
  const mark = ok === true ? P.ok('✓') : ok === false ? P.bad('✕') : P.meta('·');
  const rows = [`${mark} ${P.cmd(name)}`];
  if (status) rows.push(P.meta(status));
  if (detail) rows.push('', detail);
  return block('TOOL', rows, { width, tone: P.meta });
}

/** What came back. Grouped under its own heading so it is findable. */
function resultBlock(text, { width = 80, tone = null, title = 'RESULT' } = {}) {
  const rows = Array.isArray(text) ? text : String(text == null ? '' : text).split('\n');
  return block(title, rows, { width, tone: tone || P.key });
}

/**
 * Context being carried forward — a summary, a previous answer, a packet.
 *
 * Quoted for the same reason a reply is quoted in mail: it is material from
 * somewhere else, and the boundary is the useful part.
 */
function contextBlock(text, { width = 80, title = 'CONTEXT' } = {}) {
  const rows = Array.isArray(text) ? text : String(text == null ? '' : text).split('\n');
  return block(title, rows, { width, tone: P.meta });
}

/** A structured summary. Takes a doc.js document so it keeps its shape. */
function summaryBlock(docOrLines, { width = 80, title = 'SUMMARY' } = {}) {
  const inner = Math.max(MIN_WIDTH, width) - INDENT.length - 2;
  const rows = Array.isArray(docOrLines) ? docOrLines : docOrLines.render(inner);
  return block(title, rows, { width, tone: P.key });
}

/** One provider's answer, as a card. */
function answerCard(label, text, { width = 80, tone = null } = {}) {
  const inner = Math.max(MIN_WIDTH, width) - INDENT.length - 6;
  const paint = tone || P.info;
  const top = P.meta(BOX.tl + BOX.h.repeat(inner) + BOX.tr);
  const bottom = P.meta(BOX.bl + BOX.h.repeat(inner) + BOX.br);
  const v = P.meta(BOX.v);
  const rows = [top, `${v} ${paint(T.pad(label, inner - 2))} ${v}`];
  for (const line of wrap(String(text || '').replace(/\s+/g, ' '), inner - 2)) {
    rows.push(`${v} ${T.pad(line, inner - 2)} ${v}`);
  }
  rows.push(bottom);
  return rows;
}

/**
 * THE EXTERNAL REVIEW — both answers, side by side in the reading order, and
 * the question that is waiting.
 *
 * The choice itself is made through the panel (ui/answer.js), NOT by typing.
 * This draws what is being chosen between; it never asks.
 */
function externalChoiceBlock(options, { width = 80, question = null } = {}) {
  const rows = [];
  for (const o of options) {
    if (o.id === 'BOTH') continue;                 // offered by the panel, not drawn as a card
    rows.push(...answerCard(o.provider.toUpperCase(), o.text, { width }));
    rows.push('');
  }
  if (question) rows.push(P.key(question));
  return block('EXTERNAL REVIEW', rows, { width, tone: P.external, right: `${options.filter((o) => o.id !== 'BOTH').length} answered` });
}

/**
 * WHAT WAS CHOSEN, AND WHAT HAPPENS TO IT.
 *
 * Shown explicitly because the alternative feels like the system quietly
 * rewriting the user's input: an answer is selected and the next thing that
 * happens is LAIN working on something nobody typed. Saying "this became your
 * input" removes that entirely.
 */
function selectedBlock(provider, { width = 80, becameInput = true } = {}) {
  const rows = [P.ok(`${provider} answer`)];
  if (becameInput) {
    rows.push('');
    rows.push(P.meta('→ inserted as USER INPUT'));
    rows.push(P.meta('→ LAIN continues from it'));
  }
  return block('SELECTED', rows, { width, tone: P.ok });
}

/** A failure, named. Never folded into a result. */
function failureBlock(what, reason, { width = 80 } = {}) {
  return block('FAILED', [P.bad(what), reason ? P.meta(reason) : null].filter(Boolean),
    { width, tone: P.bad });
}

module.exports = {
  block, quote, actionBlock, toolBlock, resultBlock, contextBlock, summaryBlock,
  externalChoiceBlock, selectedBlock, failureBlock, answerCard,
  GUTTER, MIN_WIDTH,
};
