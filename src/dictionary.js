'use strict';

/**
 * THE PROJECT'S OWN WORDS — what they mean, kept where the next model finds them.
 *
 * ------------------------------------------------------------------------
 * THE COST THIS REMOVES, and it is measured rather than assumed.
 *
 * Every project invents vocabulary. In this one: `steer`, `handover`, `gate`,
 * `guardian`, `evidence`, `probe`, `capability`. None of those words means here
 * what it means anywhere else. A model that has just taken over — a compaction,
 * a model switch, a crashed session, a new day — meets `steer` in a file and has
 * exactly two options: infer it from surrounding code (a guess, and guesses about
 * vocabulary compound), or read enough of the tree to be sure (several requests,
 * each carrying the whole context).
 *
 * A definition is forty words. Written once, it removes that choice for every
 * model that ever opens the project again.
 *
 * ------------------------------------------------------------------------
 * WRITTEN FOR A STRANGER, and the fields enforce it.
 *
 *     TERM        the word as it actually appears in the code
 *     TYPE        what KIND of thing it is — a component, a state, an
 *                 interaction, a rule. Without this, "gate" reads as a noun
 *                 when it is a verb, and the reader starts wrong.
 *     PURPOSE     what it is FOR. One sentence, no jargon that needs its own
 *                 entry to decode.
 *     LOCATION    where it lives, when it has a place.
 *     OWNS        what it is the authority for — the field that stops two
 *                 components quietly claiming the same responsibility.
 *     INVARIANT   what must never stop being true. The most valuable line in
 *                 an entry: it is the thing a change can break silently.
 *     LIFECYCLE   the states it moves through, in order, when it has any.
 *     SEE         related terms.
 *
 * NOTHING IS MANDATORY EXCEPT TERM AND PURPOSE. A dictionary that demands a
 * complete entry gets no entries: the practical failure mode is not a sloppy
 * definition, it is an empty file because writing one felt like a project. A
 * definition may be refined later, and `at`/`by` record when it last was.
 *
 * ------------------------------------------------------------------------
 * SEARCHABLE BY CONCEPT, not only by exact word. Somebody asks about
 * "interruption" and the entry is called `steer`; a dictionary that only
 * answers exact lookups would have nothing to say. So the search reads the
 * purpose and invariant text too, and returns candidates.
 *
 * ------------------------------------------------------------------------
 * NOT NOTES, AND NOT A TRANSCRIPT. An entry is a DEFINITION — durable, about
 * the project, useful to somebody who was not here. "We decided to try X" is a
 * concern (memory.js) and belongs there; `.lain/` holds what the project IS.
 */

const lainstore = require('./lainstore');

/**
 * WHAT KIND OF WORD THIS IS. Loose, because a project's vocabulary is its own,
 * but named — an unlabelled definition makes a reader guess the part of speech
 * before they can use it.
 */
const KIND = Object.freeze({
  /** A part of the system that exists and can be pointed at. */
  COMPONENT: 'Architecture component',
  /** A named state something can be in. */
  STATE: 'State',
  /** Something a person or a model does. */
  INTERACTION: 'Interaction concept',
  /** A rule the system holds itself to. */
  RULE: 'Rule',
  /** A named piece of data that moves between components. */
  ARTIFACT: 'Artifact',
  /** A process or sequence with a beginning and an end. */
  PROCESS: 'Process',
  /** Anything else. Better than a forced fit. */
  TERM: 'Term',
});

const KINDS = new Set(Object.values(KIND));

function empty() { return { terms: {}, updatedAt: 0 }; }

/** Case-insensitive, punctuation-insensitive, so `ask_user` finds `ask user`. */
function keyOf(term) {
  return String(term || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function blank(term) {
  return {
    term: String(term),
    kind: KIND.TERM,
    purpose: '',
    location: '',
    owns: '',
    invariant: '',
    lifecycle: [],
    see: [],
    /** Architecture node ids this term explains, when it explains one. */
    nodes: [],
    at: 0,
    by: '',
  };
}

function load(root) {
  const body = lainstore.read(root, 'concepts', null);
  if (!body || !body.terms || typeof body.terms !== 'object') return empty();
  const terms = {};
  for (const [k, t] of Object.entries(body.terms)) {
    if (!t || typeof t !== 'object' || !t.term) continue;
    const base = blank(t.term);
    terms[k] = {
      ...base,
      ...t,
      lifecycle: Array.isArray(t.lifecycle) ? t.lifecycle.map(String) : [],
      see: Array.isArray(t.see) ? t.see.map(String) : [],
      nodes: Array.isArray(t.nodes) ? t.nodes.map(String) : [],
    };
  }
  return { terms, updatedAt: Number(body.updatedAt) || 0 };
}

function save(root, dict) {
  dict.updatedAt = Date.now();
  return lainstore.write(root, 'concepts', { terms: dict.terms, updatedAt: dict.updatedAt });
}

/**
 * DEFINE A TERM, or refine the one that is there.
 *
 * MERGES. The same rule architecture.declare follows and for the same reason: a
 * model adding a lifecycle must not thereby delete an invariant somebody wrote
 * last month. Only supplied fields move.
 */
function define(dict, spec) {
  const term = String((spec && spec.term) || '').trim();
  if (!term) return { ok: false, error: 'a definition needs a term' };
  const key = keyOf(term);
  if (!key) return { ok: false, error: `"${term}" has no letters or digits in it` };
  const existing = dict.terms[key];
  const entry = existing ? { ...existing } : blank(term);

  if (spec.kind != null) {
    const k = String(spec.kind);
    // ACCEPTED BY LABEL OR BY SHORT NAME. `COMPONENT` and
    // `Architecture component` are the same request, and refusing one of them
    // is a papercut that costs entries.
    const match = KINDS.has(k) ? k : KIND[k.toUpperCase().replace(/[^A-Z]/g, '_')];
    if (!match) return { ok: false, error: `unknown kind "${spec.kind}" — one of ${Object.keys(KIND).join(', ')}` };
    entry.kind = match;
  }
  if (spec.purpose != null) entry.purpose = String(spec.purpose).trim();
  if (spec.location != null) entry.location = String(spec.location).replace(/\\/g, '/');
  if (spec.owns != null) entry.owns = String(spec.owns).trim();
  if (spec.invariant != null) entry.invariant = String(spec.invariant).trim();
  if (Array.isArray(spec.lifecycle)) entry.lifecycle = spec.lifecycle.map(String).filter(Boolean);
  if (Array.isArray(spec.see)) entry.see = spec.see.map(String).filter(Boolean);
  if (Array.isArray(spec.nodes)) entry.nodes = spec.nodes.map(String).filter(Boolean);
  entry.term = term;
  if (!entry.purpose) {
    return { ok: false, error: 'a definition without a purpose is a word with no meaning attached — say what it is FOR' };
  }
  entry.at = Date.now();
  entry.by = String(spec.by || entry.by || 'lain');
  dict.terms[key] = entry;
  return { ok: true, entry, created: !existing };
}

function forget(dict, term) {
  const key = keyOf(term);
  if (!dict.terms[key]) return { ok: false, error: `"${term}" is not defined` };
  delete dict.terms[key];
  return { ok: true };
}

/** Exact lookup. */
function get(dict, term) { return dict.terms[keyOf(term)] || null; }

/**
 * SEARCH BY CONCEPT.
 *
 * Exact match first, then terms that contain the query, then entries whose
 * PURPOSE or INVARIANT text mentions it. That last tier is what makes this a
 * concept map rather than a glossary: somebody asks about "interruption" and
 * gets `steer`, whose purpose sentence contains the word.
 */
function search(dict, query, { max = 8 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const key = keyOf(q);
  const exact = dict.terms[key];
  const out = [];
  const push = (e) => { if (e && !out.includes(e)) out.push(e); };
  push(exact);
  for (const e of Object.values(dict.terms)) {
    if (out.length >= max) break;
    if (e.term.toLowerCase().includes(q)) push(e);
  }
  for (const e of Object.values(dict.terms)) {
    if (out.length >= max) break;
    const hay = `${e.purpose} ${e.invariant} ${e.owns} ${e.see.join(' ')}`.toLowerCase();
    if (hay.includes(q)) push(e);
  }
  return out.slice(0, max);
}

/** Every term that explains a given architecture node. */
function forNode(dict, nodeId) {
  return Object.values(dict.terms).filter((e) => e.nodes.includes(nodeId));
}

/** One entry, in the shape the header of this file describes. */
function render(entry) {
  if (!entry) return '';
  const out = [`TERM: ${entry.term}`, `TYPE: ${entry.kind}`];
  if (entry.location) out.push(`LOCATION: ${entry.location}`);
  out.push(`PURPOSE: ${entry.purpose}`);
  if (entry.owns) out.push(`OWNS: ${entry.owns}`);
  if (entry.invariant) out.push(`INVARIANT: ${entry.invariant}`);
  if (entry.lifecycle.length) out.push(`LIFECYCLE: ${entry.lifecycle.join(' -> ')}`);
  if (entry.see.length) out.push(`SEE: ${entry.see.join(', ')}`);
  return out.join('\n');
}

/**
 * THE WHOLE VOCABULARY, one line each.
 *
 * Grouped by kind, because "what components are there" and "what states are
 * there" are different questions and a flat alphabetical list answers neither.
 * Capped: the full text of every entry is not what a listing is for.
 */
function list(dict, { max = 60 } = {}) {
  const entries = Object.values(dict.terms);
  if (!entries.length) {
    return 'No vocabulary has been recorded for this project yet.\n'
      + 'Define one with concept{op:"define"} — a definition is what lets the NEXT model '
      + 'read this code without inferring what its words mean.';
  }
  const byKind = new Map();
  for (const e of entries) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind).push(e);
  }
  const lines = [`VOCABULARY — ${entries.length} term(s)`];
  let shown = 0;
  for (const kind of [...byKind.keys()].sort()) {
    const rows = byKind.get(kind).sort((a, b) => (a.term < b.term ? -1 : 1));
    lines.push('', kind.toUpperCase());
    for (const e of rows) {
      if (shown >= max) { lines.push('  [more — ask for one by name]'); return lines.join('\n'); }
      const one = e.purpose.split(/(?<=\.)\s/)[0];
      lines.push(`  ${e.term.padEnd(18)} ${one.length > 88 ? `${one.slice(0, 85)}...` : one}`);
      shown += 1;
    }
  }
  return lines.join('\n');
}

module.exports = { KIND, KINDS, empty, blank, load, save, keyOf, define, forget, get, search, forNode, render, list };
