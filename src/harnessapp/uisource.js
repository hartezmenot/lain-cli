'use strict';

/**
 * FROM A THING ON SCREEN TO THE CODE THAT MADE IT — and back.
 *
 * ------------------------------------------------------------------------
 * THE PRODUCT MOMENT THIS SERVES.
 *
 *     "fix the Save button"
 *
 * There are three Save buttons. The old answer was for a model to guess, edit
 * the wrong one, and be corrected two turns later. The right answer is to say
 * so, show the candidates, let the person CLICK the actual one, and then open
 * the code that produced it.
 *
 * ------------------------------------------------------------------------
 * FOUR ANSWERS, AND ONE OF THEM IS "I DO NOT KNOW".
 *
 *   EXACT     one place, and the evidence is strong — an id, or a component
 *             file whose name matches and which contains the element's text.
 *   LIKELY    one best candidate, but the evidence is circumstantial.
 *   MULTIPLE  several places match equally. The person picks; nothing guesses.
 *   UNKNOWN   nothing correlates. SAID PLAINLY rather than answered with the
 *             least-bad match, because a confident wrong file costs more than
 *             an honest shrug: the person acts on it.
 *
 * FABRICATING A MAPPING IS THE ONE FORBIDDEN OUTCOME. Every candidate carries
 * the EVIDENCE that produced it — which token was searched for, in which file,
 * on which line — so a person can see why it was offered and dismiss it in a
 * second.
 *
 * ------------------------------------------------------------------------
 * IT IS A SEARCH OVER REAL FILES, NOT A BUILD-GRAPH.
 *
 * A source-map-accurate answer needs the bundler's own graph, and this project
 * has no bundler and refuses to assume one. What it has is: the element's id,
 * its classes, its tag, its text, and `locate.js` — which already sweeps the
 * project for a name and can tell a DEFINITION from a reference.
 *
 * That is enough for the overwhelmingly common cases (an id, a distinctive
 * class, a component named after what it renders) and honestly insufficient for
 * generated class names, which is why `UNKNOWN` exists and is returned.
 */

const path = require('path');
const locate = require('../locate');

/** How many candidates are worth showing. Past this it is not a shortlist. */
const MAX_CANDIDATES = 8;

/** Confidence, most certain first. */
const CONFIDENCE = { EXACT: 'EXACT', LIKELY: 'LIKELY', MULTIPLE: 'MULTIPLE', UNKNOWN: 'UNKNOWN' };

/**
 * CLASS NAMES A BUNDLER GENERATED, which correlate to nothing a person wrote.
 *
 * `css-1x2y3z`, `sc-fzXfMB`, `_button_1a2b3` — hashes emitted by CSS modules,
 * styled-components and the like. Searching for one finds either nothing or the
 * build output, and offering the build output as "the source" is exactly the
 * fabricated mapping this module must not produce.
 */
function generated(name) {
  const n = String(name || '');
  return /^(?:css|sc|jsx|emotion)-[a-zA-Z0-9]{5,}$/.test(n)
    || /^_[\w-]+_[a-z0-9]{5,}$/.test(n)
    || /^[a-z]{1,3}[0-9a-f]{6,}$/i.test(n);
}

/** The tokens worth searching for, strongest evidence first. */
function tokensFor(el) {
  const out = [];
  const id = String((el && el.id) || '').trim();
  if (id && !generated(id)) out.push({ token: id, kind: 'id', weight: 100 });

  const classes = Array.isArray(el && el.classes)
    ? el.classes
    : String((el && el.className) || '').split(/\s+/);
  for (const c of classes) {
    const name = String(c || '').trim();
    if (!name || generated(name)) continue;
    // A ONE- OR TWO-CHARACTER CLASS matches everywhere and means nothing.
    if (name.length < 3) continue;
    out.push({ token: name, kind: 'class', weight: 60 });
  }

  // THE VISIBLE TEXT is often the strongest evidence of all — "Pay now" appears
  // in the component that renders it and almost nowhere else. Bounded, and only
  // when it is short enough to be a label rather than a paragraph.
  const text = String((el && el.text) || '').trim();
  if (text && text.length <= 40 && /\S/.test(text)) {
    out.push({ token: text, kind: 'text', weight: 80 });
  }
  return out.slice(0, 6);
}

/** Does this file look like source a person wrote, rather than build output? */
function authored(rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  if (/(^|\/)(dist|build|out|coverage|\.next|node_modules|vendor|target)\//.test(p)) return false;
  if (/\.min\.(js|css)$/.test(p)) return false;
  if (/\.map$/.test(p)) return false;
  return true;
}

/**
 * FIND WHERE AN ELEMENT COMES FROM.
 *
 * `el` is the descriptor the Workshop's inspector already produces — tag, id,
 * classes, text, selector. Nothing here talks to a browser; the caller has
 * already looked.
 */
function fromElement(app, el, { limit = MAX_CANDIDATES } = {}) {
  const root = app.session.cwd || process.cwd();
  const tokens = tokensFor(el);
  if (!tokens.length) {
    return {
      confidence: CONFIDENCE.UNKNOWN,
      candidates: [],
      why: 'this element has no id, no usable class and no short text — nothing to search for',
      searched: [],
    };
  }

  /** rel -> {rel, score, hits:[{line, text, token, kind}]} */
  const byFile = new Map();
  const searched = [];

  for (const t of tokens) {
    let found;
    try { found = locate.sweep(root, t.token); } catch { found = null; }
    if (!found) continue;
    searched.push({ token: t.token, kind: t.kind, defs: found.defs.length, files: found.refsByFile.size });

    // A DEFINITION IS WORTH MORE THAN A MENTION. `locate.sweep` already knows
    // the difference — a `.row {` in a stylesheet or a `function Row(` in a
    // component is a definition; a reference is somebody using it.
    for (const d of found.defs) {
      if (!authored(d.file)) continue;
      const cur = byFile.get(d.file) || { rel: d.file, score: 0, hits: [] };
      cur.score += t.weight * 2;
      if (cur.hits.length < 5) cur.hits.push({ line: d.line, text: d.text, token: t.token, kind: t.kind, definition: true });
      byFile.set(d.file, cur);
    }
    for (const [file, n] of found.refsByFile) {
      if (!authored(file)) continue;
      const cur = byFile.get(file) || { rel: file, score: 0, hits: [] };
      // A FILE MENTIONING A TOKEN FORTY TIMES IS NOT FORTY TIMES AS LIKELY.
      // Diminishing returns keep one noisy file from burying a precise one.
      cur.score += t.weight * Math.min(3, n) * 0.25;
      byFile.set(file, cur);
    }
  }

  const candidates = [...byFile.values()]
    .map((c) => ({
      ...c,
      // A FILE NAMED AFTER THE THING is meaningful evidence on its own:
      // `CheckoutButton.tsx` for a checkout button.
      score: c.score + nameAffinity(c.rel, tokens),
      name: path.basename(c.rel),
    }))
    .sort((a, b) => b.score - a.score || a.rel.length - b.rel.length)
    .slice(0, limit);

  if (!candidates.length) {
    return {
      confidence: CONFIDENCE.UNKNOWN,
      candidates: [],
      why: `searched for ${tokens.map((t) => JSON.stringify(t.token)).join(', ')} and found nothing in this project`,
      searched,
    };
  }

  return { confidence: confidenceOf(candidates, tokens), candidates, why: '', searched };
}

/** A filename that contains one of the tokens is evidence, not coincidence. */
function nameAffinity(rel, tokens) {
  const base = path.basename(String(rel)).toLowerCase().replace(/\.[^.]+$/, '');
  let bonus = 0;
  for (const t of tokens) {
    const tok = String(t.token).toLowerCase().replace(/\s+/g, '');
    if (tok.length >= 4 && base.includes(tok)) bonus += 40;
  }
  return bonus;
}

/**
 * HOW SURE IS THIS?
 *
 * The rule is about SEPARATION, not absolute score: one candidate far ahead of
 * the next is a decision, and two candidates neck and neck is a question for
 * the person however high both score.
 */
function confidenceOf(candidates, tokens) {
  const hasId = tokens.some((t) => t.kind === 'id');
  const top = candidates[0];
  const next = candidates[1];
  const definitive = top.hits.some((h) => h.definition);

  if (!next) return definitive && hasId ? CONFIDENCE.EXACT : CONFIDENCE.LIKELY;
  const clear = top.score >= next.score * 1.8;
  if (clear && definitive && hasId) return CONFIDENCE.EXACT;
  if (clear) return CONFIDENCE.LIKELY;
  return CONFIDENCE.MULTIPLE;
}

/**
 * THE REVERSE — SOURCE → UI.
 *
 * Given a file and optionally a line, what would it render? The honest answer
 * is a SELECTOR to try, not a promise: only the running page can say whether
 * anything matches, and the Workshop is what asks it.
 *
 * So this returns selectors ranked by how specific they are, and the caller
 * highlights whichever the page actually has. When nothing can be derived it
 * says UNKNOWN rather than inventing `div`.
 */
function toSelectors(app, rel, { line = null, body = null } = {}) {
  const fs = require('fs');
  const src = require('./source');
  let text = body;
  if (text == null) {
    const at = src.locate(app, rel);
    if (!at.ok) return { confidence: CONFIDENCE.UNKNOWN, selectors: [], why: at.why };
    try { text = fs.readFileSync(at.abs, 'utf8'); } catch (e) {
      return { confidence: CONFIDENCE.UNKNOWN, selectors: [], why: (e && e.message) || String(e) };
    }
  }
  const lines = text.split('\n');
  // A LINE NARROWS IT ENORMOUSLY. `opacity: 0.2` on line 12 belongs to whatever
  // rule opened above it, and that rule's selector is the answer.
  const from = line == null ? 0 : Math.max(0, Number(line) - 1);
  const to = line == null ? lines.length : Math.min(lines.length, from + 1);
  const window = lines.slice(line == null ? 0 : Math.max(0, from - 40), to || 1).join('\n');

  const selectors = [];
  const push = (sel, why, weight) => {
    if (!sel || selectors.some((s) => s.selector === sel)) return;
    selectors.push({ selector: sel, why, weight });
  };

  // CSS: the nearest rule that opened before this line.
  const rules = [...window.matchAll(/(^|\})\s*([.#][\w-][\w .#:>-]*)\s*\{/g)].map((m) => m[2].trim());
  const last = rules[rules.length - 1];
  if (last && !generated(last.replace(/^[.#]/, ''))) push(last, 'the CSS rule this line is inside', 90);

  // Markup and components: an id beats a class beats a tag.
  const id = (window.match(/\bid=["']([\w-]+)["']/) || [])[1];
  if (id && !generated(id)) push(`#${id}`, 'an id in this file', 100);
  for (const m of window.matchAll(/\bclass(?:Name)?=["']([^"']+)["']/g)) {
    for (const c of m[1].split(/\s+/)) {
      if (c && !generated(c) && c.length >= 3) push(`.${c}`, 'a class in this file', 60);
    }
  }

  const ranked = selectors.sort((a, b) => b.weight - a.weight).slice(0, 6);
  if (!ranked.length) {
    return {
      confidence: CONFIDENCE.UNKNOWN,
      selectors: [],
      why: 'nothing in this file names an element — no id, no class, no CSS rule',
    };
  }
  return {
    confidence: ranked.length === 1 ? CONFIDENCE.LIKELY : CONFIDENCE.MULTIPLE,
    selectors: ranked,
    why: '',
  };
}

module.exports = { fromElement, toSelectors, tokensFor, generated, authored, confidenceOf, CONFIDENCE, MAX_CANDIDATES };
