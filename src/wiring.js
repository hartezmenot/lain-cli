'use strict';

/**
 * HOW THE PARTS ARE WIRED — typed, persistent, and not recoverable from imports.
 *
 * ------------------------------------------------------------------------
 * WHY THE IMPORT GRAPH IS NOT ENOUGH, which is the whole argument for this file.
 *
 * `projectindex.js` already knows every `require` in the tree, and that answers
 * exactly one question: which file would fail to load without which other file.
 * It cannot answer any of these, and these are the questions people ask:
 *
 *     what WAKES the turn loop?              nothing imports a wake-up
 *     who READS the credential store?        a reader may import nothing
 *     what BLOCKS on the model request?      blocking is not a symbol
 *     what RECOVERS a dead session?          recovery is a relationship
 *                                            between two components that may
 *                                            never mention each other
 *     the frontend talks to the backend      over HTTP. There is no import.
 *
 * Every one of those is a real edge in the running system and INVISIBLE to a
 * parser. A model asked "what happens when a job finishes" therefore reads its
 * way across the tree, guessing, at ~65,000 input tokens a request — to
 * rediscover something that was known and could have been written down once.
 *
 * ------------------------------------------------------------------------
 * TYPED, BECAUSE AN UNTYPED EDGE IS A RUMOUR. "A relates to B" is not worth
 * storing. `RUST_GATE --WAKES--> TURN_ENGINE` is a fact somebody can act on,
 * and it is queryable in the direction that matters: given a component, what
 * wakes it, what blocks on it, what would recover it.
 *
 * ------------------------------------------------------------------------
 * IT REFERS TO ARCHITECTURE NODES, NOT TO FILES. An edge between two files dies
 * with the files. An edge between two COMPONENTS survives them, which is the
 * same invariant architecture.js exists for — see the note there about a lost
 * `guardian.rs`. An endpoint that names no node is still allowed (an external
 * system has no node), and is marked as external rather than silently dropped.
 *
 * ------------------------------------------------------------------------
 * SMALL AND QUERYABLE, on purpose. Nothing here ships the whole graph into a
 * prompt: a caller asks about one node and gets that node's edges. A hundred
 * components produce a graph that renders in a dozen lines per query, and the
 * cost of the answer does not grow with the project.
 */

const lainstore = require('./lainstore');

/**
 * THE VERBS. A closed list — an open one degenerates into prose, and prose is
 * what this replaces. Each is a different question somebody actually asks.
 */
const REL = Object.freeze({
  /** Invokes it directly, in-process. */
  CALLS: 'CALLS',
  /** Cannot function without it. The structural edge; the import graph's kind. */
  DEPENDS_ON: 'DEPENDS_ON',
  /** Transmits to it across a boundary — HTTP, socket, pipe, queue. */
  SENDS: 'SENDS',
  /** Accepts transmissions from it. The other half of SENDS, stored explicitly
   *  because the receiver often does not know the sender exists. */
  RECEIVES: 'RECEIVES',
  /** Is the authority for it. Exactly one owner is the point of saying it. */
  OWNS: 'OWNS',
  READS: 'READS',
  WRITES: 'WRITES',
  /** Produces an event others may consume. */
  EMITS: 'EMITS',
  CONSUMES: 'CONSUMES',
  /** Causes it to start doing something it was not doing. */
  WAKES: 'WAKES',
  /** Waits on it, and cannot proceed until it answers. */
  BLOCKS: 'BLOCKS',
  /** Restores it after a failure. */
  RECOVERS: 'RECOVERS',
});

const VERBS = new Set(Object.values(REL));

/** Verbs whose reverse direction is a different, equally real verb. */
const MIRROR = Object.freeze({
  SENDS: 'RECEIVES',
  RECEIVES: 'SENDS',
  EMITS: 'CONSUMES',
  CONSUMES: 'EMITS',
});

/** How an edge reads in a sentence, from the subject's side. */
const PHRASE = Object.freeze({
  CALLS: 'calls',
  DEPENDS_ON: 'depends on',
  SENDS: 'sends to',
  RECEIVES: 'receives from',
  OWNS: 'owns',
  READS: 'reads',
  WRITES: 'writes',
  EMITS: 'emits to',
  CONSUMES: 'consumes from',
  WAKES: 'wakes',
  BLOCKS: 'blocks on',
  RECOVERS: 'recovers',
});

function empty() { return { edges: [], updatedAt: 0 }; }

function keyOf(e) { return `${e.from}\u0001${e.rel}\u0001${e.to}`; }

function load(root) {
  const body = lainstore.read(root, 'wiring', null);
  if (!body || !Array.isArray(body.edges)) return empty();
  const seen = new Set();
  const edges = [];
  for (const e of body.edges) {
    if (!e || typeof e !== 'object') continue;
    const from = String(e.from || '').trim();
    const to = String(e.to || '').trim();
    const rel = String(e.rel || '').toUpperCase();
    if (!from || !to || !VERBS.has(rel)) continue;
    const edge = {
      from, to, rel,
      via: String(e.via || ''),
      note: String(e.note || ''),
      at: Number(e.at) || 0,
    };
    const k = keyOf(edge);
    if (seen.has(k)) continue;      // a duplicated edge is one edge
    seen.add(k);
    edges.push(edge);
  }
  return { edges, updatedAt: Number(body.updatedAt) || 0 };
}

function save(root, graph) {
  graph.updatedAt = Date.now();
  return lainstore.write(root, 'wiring', { edges: graph.edges, updatedAt: graph.updatedAt });
}

/**
 * RECORD AN EDGE.
 *
 * `via` is the mechanism — "HTTP /api/session", "unix socket", "supervisor
 * event" — and it is the field that makes an edge useful rather than merely
 * true. Two components that SEND to each other over three different channels
 * are three facts, and collapsing them loses the one somebody is debugging.
 */
function connect(graph, { from, to, rel, via = '', note = '', at = Date.now() } = {}) {
  const f = String(from || '').trim();
  const t = String(to || '').trim();
  const r = String(rel || '').toUpperCase();
  if (!f || !t) return { ok: false, error: 'an edge needs both ends' };
  if (f === t) return { ok: false, error: 'a component cannot be wired to itself' };
  if (!VERBS.has(r)) {
    return { ok: false, error: `unknown relationship "${rel}" — one of ${[...VERBS].join(', ')}` };
  }
  const edge = { from: f, to: t, rel: r, via: String(via), note: String(note), at };
  const k = keyOf(edge);
  const at0 = graph.edges.findIndex((e) => keyOf(e) === k);
  if (at0 >= 0) {
    // MERGED, NOT DUPLICATED. Re-declaring an edge with a `via` it did not have
    // is somebody adding detail, not somebody adding an edge.
    const prev = graph.edges[at0];
    graph.edges[at0] = { ...prev, via: edge.via || prev.via, note: edge.note || prev.note, at };
    return { ok: true, edge: graph.edges[at0], created: false };
  }
  graph.edges.push(edge);
  return { ok: true, edge, created: true };
}

function disconnect(graph, { from, to, rel } = {}) {
  const before = graph.edges.length;
  const r = rel ? String(rel).toUpperCase() : '';
  graph.edges = graph.edges.filter((e) => !(
    (!from || e.from === from) && (!to || e.to === to) && (!r || e.rel === r)
  ));
  return { ok: true, removed: before - graph.edges.length };
}

/** Every edge leaving a node. */
function outgoing(graph, id, rel = '') {
  const r = rel ? String(rel).toUpperCase() : '';
  return graph.edges.filter((e) => e.from === id && (!r || e.rel === r));
}

/** Every edge arriving at a node. */
function incoming(graph, id, rel = '') {
  const r = rel ? String(rel).toUpperCase() : '';
  return graph.edges.filter((e) => e.to === id && (!r || e.rel === r));
}

/** Everything either side of a node. */
function around(graph, id) {
  return { out: outgoing(graph, id), in: incoming(graph, id) };
}

/**
 * A PATH BETWEEN TWO COMPONENTS, if there is one.
 *
 * Breadth-first, so the answer is the SHORTEST chain — which is the one a
 * person means by "how does the user's keystroke reach the model". Direction
 * matters: a path is a route traffic could actually take.
 */
function path(graph, from, to, { maxHops = 8 } = {}) {
  if (from === to) return [];
  const queue = [[from, []]];
  const seen = new Set([from]);
  while (queue.length) {
    const [at, trail] = queue.shift();
    if (trail.length >= maxHops) continue;
    for (const e of outgoing(graph, at)) {
      if (e.to === to) return [...trail, e];
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push([e.to, [...trail, e]]);
    }
  }
  return null;
}

/**
 * WHICH NODES EXIST ONLY AS ENDPOINTS. An edge may name something the
 * architecture has no node for — an external service, a provider, the user —
 * and that is legitimate. Reported so a reader can tell a deliberate external
 * endpoint from a typo in a node id.
 */
function dangling(graph, model) {
  const known = new Set(Object.keys((model && model.nodes) || {}));
  const out = new Set();
  for (const e of graph.edges) {
    if (!known.has(e.from)) out.add(e.from);
    if (!known.has(e.to)) out.add(e.to);
  }
  return [...out].sort();
}

/** How a single edge reads. */
function sayEdge(e, { model = null, reverse = false } = {}) {
  const nameOf = (id) => {
    const n = model && model.nodes && model.nodes[id];
    return n ? n.name : id;
  };
  const verb = reverse && MIRROR[e.rel] ? PHRASE[MIRROR[e.rel]] : PHRASE[e.rel] || e.rel.toLowerCase();
  const subject = reverse ? nameOf(e.to) : nameOf(e.from);
  const object = reverse ? nameOf(e.from) : nameOf(e.to);
  const via = e.via ? `  (${e.via})` : '';
  const note = e.note ? `  — ${e.note}` : '';
  return `${subject} ${verb} ${object}${via}${note}`;
}

/**
 * ONE NODE'S WIRING, as a person reads it.
 *
 * Both directions, because half a picture is the thing that sends somebody
 * reading source: knowing what a component calls tells you nothing about what
 * calls it, and "what breaks if I change this" is the second question.
 */
function render(graph, id, { model = null } = {}) {
  const { out, in: incom } = around(graph, id);
  if (!out.length && !incom.length) {
    return `Nothing is recorded about how ${id} is wired.`;
  }
  const lines = [];
  if (out.length) {
    lines.push('OUTWARD');
    for (const e of out) lines.push(`  ${sayEdge(e, { model })}`);
  }
  if (incom.length) {
    if (lines.length) lines.push('');
    lines.push('INWARD');
    for (const e of incom) lines.push(`  ${sayEdge(e, { model })}`);
  }
  return lines.join('\n');
}

/**
 * THE WHOLE GRAPH AS A FLOW, when it is small enough to be worth drawing.
 *
 * Grouped by verb rather than by node, because the useful reading of a whole
 * graph is "what talks to what over HTTP" — a per-node dump of a whole graph is
 * the context cost this module exists to avoid, so it is capped and says so.
 */
function summary(graph, { model = null, max = 40 } = {}) {
  if (!graph.edges.length) {
    return 'No wiring has been recorded for this project yet.\n'
      + 'Record one with wiring{op:"connect"} — an import graph cannot express WAKES, BLOCKS or SENDS.';
  }
  const byRel = new Map();
  for (const e of graph.edges) {
    if (!byRel.has(e.rel)) byRel.set(e.rel, []);
    byRel.get(e.rel).push(e);
  }
  const lines = [`WIRING — ${graph.edges.length} relationship(s)`];
  let shown = 0;
  for (const rel of Object.values(REL)) {
    const rows = byRel.get(rel);
    if (!rows || !rows.length) continue;
    lines.push('', `${rel} (${rows.length})`);
    for (const e of rows) {
      if (shown >= max) { lines.push('  [more — ask about one component]'); return lines.join('\n'); }
      lines.push(`  ${sayEdge(e, { model })}`);
      shown += 1;
    }
  }
  return lines.join('\n');
}

module.exports = {
  REL, VERBS, MIRROR, PHRASE,
  empty, load, save, connect, disconnect,
  outgoing, incoming, around, path, dangling,
  sayEdge, render, summary,
};
