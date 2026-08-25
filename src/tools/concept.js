'use strict';

/**
 * THE DURABLE LAYER — four tools over `<project>/.lain/`, the directory that
 * survives everything a conversation does not.
 *
 * ------------------------------------------------------------------------
 * WHY THESE ARE A FAMILY, and why none of them is a file tool.
 *
 * A conversation is compacted, cleared, resumed and switched between models,
 * and every one of those operations is RIGHT to lose most of what it drops —
 * that material was the transcript of work, not the work. But four kinds of
 * knowledge must cross that boundary or every new context re-derives them:
 *
 *     what the project's WORDS mean          concept   (dictionary.js)
 *     what the project was MEANT to be       architecture (architecture.js)
 *     how the parts are WIRED together       wiring    (wiring.js)
 *     what THIS TURN found, and what is
 *      durably TRUE because something
 *      checked it                           scratch   (scratch.js)
 *
 * Each has a module of its own under src/; what lives here is only the
 * model-facing door. The names are the ones the modules' own empty-state
 * answers advertise (`concept{op:"define"}` and its siblings), so a model
 * told to "define one with concept" by a listing finds a tool of exactly
 * that name.
 *
 * ------------------------------------------------------------------------
 * NOTHING HERE MUTATES THE PROJECT. The writes go to `.lain/` — LAIN's own
 * state about the project, atomically, via lainstore — the same rule the
 * `understand` tool already follows when projectsync persists the index.
 * There is no user source to snapshot or undo, so `mutates` is false for
 * all four and the permission gate is not asked a question it has no
 * answer for.
 *
 * ------------------------------------------------------------------------
 * THE OBSERVED AXIS IS NEVER WRITABLE FROM HERE. `architecture` reads
 * intent and runs the reconciler against the disk, but only reconcile.js
 * may write what the disk said — a model that could write its own
 * observation could report a missing file as present, and the whole value
 * of the two-axis design (architecture.js) is that it cannot.
 */

const path = require('path');

const dictionary = require('../dictionary');
const architecture = require('../architecture');
const reconcile = require('../reconcile');
const wiring = require('../wiring');
const scratch = require('../scratch');

/** One line per search hit, not the whole entry — the listing is for choosing. */
function termLines(entries, { max = 12 } = {}) {
  if (!entries.length) return '';
  return entries.slice(0, max)
    .map((e) => `${e.term} (${e.kind}) — ${String(e.purpose || '').split(/(?<=\.)\s/)[0]}`)
    .join('\n');
}

const tools = {};

// ---------------------------------------------------------------------------
// concept — the project's own words
// ---------------------------------------------------------------------------

tools.concept = {
  mutates: false,
  schema: {
    name: 'concept',
    description:
      'The project\'s OWN vocabulary — what its words mean here, kept where the next model finds them. '
      + 'Use it when you meet a word that means something specific in this codebase (a module name, a state, '
      + 'a rule it holds itself to): look it up instead of inferring, and DEFINE it when you have established '
      + 'what it means, so a later context — after compaction, a model switch, a new session — does not have '
      + 'to re-derive it. Definitions persist in .lain/ and survive everything the conversation does not.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['define', 'forget', 'terms'],
          description: 'define: record or refine a term (merges — only supplied fields move). '
            + 'forget: remove one. terms: list all, or search by concept (the query also matches '
            + 'purpose and invariant text, not just names).',
        },
        term: { type: 'string', description: 'the word, e.g. "steer"' },
        kind: {
          type: 'string',
          description: 'component | state | interaction | rule | artifact | process | term',
        },
        purpose: { type: 'string', description: 'one sentence: what it is FOR. Required to define.' },
        owns: { type: 'string', description: 'what it is the authority for' },
        invariant: { type: 'string', description: 'what must never stop being true — the line a change can break silently' },
        location: { type: 'string', description: 'project-relative path or symbol, if it lives somewhere' },
        see: { type: 'array', items: { type: 'string' }, description: 'related terms' },
        query: { type: 'string', description: 'for op "terms": a concept to search for' },
      },
      required: ['op'],
    },
  },
  async run(input, ctx) {
    const root = path.resolve(ctx.cwd || process.cwd());
    const op = String(input.op || '');

    if (op === 'define') {
      const dict = dictionary.load(root);
      const r = dictionary.define(dict, input);
      if (!r.ok) return { output: r.error, isError: true };
      if (!dictionary.save(root, dict)) {
        return { output: 'the definition could not be written to .lain/ — the project may be read-only', isError: true };
      }
      return { output: `${r.created ? 'Defined' : 'Refined'} "${r.entry.term}".\n${dictionary.render(r.entry)}` };
    }

    if (op === 'forget') {
      const term = String(input.term || '').trim();
      if (!term) return { output: 'forget needs the term to remove', isError: true };
      const dict = dictionary.load(root);
      const r = dictionary.forget(dict, term);
      if (!r.ok) return { output: r.error, isError: true };
      dictionary.save(root, dict);
      return { output: `Removed "${term}".` };
    }

    if (op === 'terms') {
      const dict = dictionary.load(root);
      const q = String(input.query || '').trim();
      if (!q) return { output: dictionary.list(dict) };
      const hits = dictionary.search(dict, q);
      if (!hits.length) {
        return { output: `Nothing recorded about "${q}". If you have established what it means here, define it.` };
      }
      return { output: termLines(hits) + '\n\nAsk again with the exact term to see the full entry.' };
    }

    return { output: `unknown op "${op}" — define, forget or terms`, isError: true };
  },
};

// ---------------------------------------------------------------------------
// architecture — what was MEANT, reconciled against what is there
// ---------------------------------------------------------------------------

tools.architecture = {
  mutates: false,
  schema: {
    name: 'architecture',
    description:
      'The INTENDED architecture: what this project is meant to be, node by node, kept separately from what '
      + 'the disk says. A node may be PLANNED before any code exists, and a node whose file has VANISHED is '
      + 'more valuable than one that was never recorded — its purpose, place and last verification survive in '
      + '.lain/. Declare components as you establish them, VERIFY with the evidence that checked them, and '
      + 'read the tree (reconciled live against the disk) to orient yourself or to recover what was lost.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['declare', 'verify', 'show', 'find', 'seed'],
          description: 'declare: record or advance a node (merges). verify: mark VERIFIED — must say how '
            + 'and what the check said; fingerprints the location and refuses to verify what is not there. '
            + 'show: the tree (or one node in full), reconciled against the disk first. '
            + 'find: locate nodes by name or id. '
            + 'seed: create CANDIDATE nodes from files the index has actually seen — locations only, '
            + 'no guessed purpose, marked origin:seed; declare intent onto them afterwards.',
        },
        name: { type: 'string', description: 'the node\'s name, e.g. "Context Authority"' },
        id: { type: 'string', description: 'stable id; derived from the name when omitted' },
        parent: { type: 'string', description: 'parent node id — declare the parent first' },
        type: { type: 'string', description: 'system | layer | component | module | service | worker | surface | store | concept' },
        status: { type: 'string', description: 'PLANNED | PARTIAL | IMPLEMENTED | VERIFIED' },
        purpose: { type: 'string', description: 'what it is for' },
        owner: { type: 'string', description: 'who owns it' },
        location: { type: 'string', description: 'project-relative path — omit for a design-only node' },
        node: { type: 'string', description: 'for verify/find/show: the node id or name' },
        how: { type: 'string', description: 'for verify: HOW it was checked — a command, a test, a read' },
        result: { type: 'string', description: 'for verify: WHAT the check said' },
        detail: { type: 'boolean', description: 'for show: include purpose, owner and verification per node' },
      },
      required: ['op'],
    },
  },
  async run(input, ctx) {
    const root = path.resolve(ctx.cwd || process.cwd());
    const op = String(input.op || '');

    if (op === 'declare') {
      const model = architecture.load(root);
      const r = architecture.declare(model, input);
      if (!r.ok) return { output: r.error, isError: true };
      if (!architecture.save(root, model)) {
        return { output: 'the node could not be written to .lain/ — the project may be read-only', isError: true };
      }
      return { output: `${r.created ? 'Declared' : 'Updated'} ${r.node.name} (${r.node.id}) `
        + `as ${r.node.status}${r.node.location ? ` at ${r.node.location}` : ' — design only'}.` };
    }

    if (op === 'verify') {
      const model = architecture.load(root);
      const q = String(input.node || input.id || input.name || '').trim();
      const found = architecture.find(model, q);
      if (!found.matches.length) return { output: `no node matches "${q}" — declare it first`, isError: true };
      if (found.matches.length > 1) {
        return { output: `ambiguous — ${found.matches.map((n) => n.id).join(', ')}`, isError: true };
      }
      const r = reconcile.record(root, model, found.matches[0].id, {
        how: input.how, result: input.result, by: 'model',
      });
      // SAVED EITHER WAY. A refused verification still produced a real
      // observation — "nothing at that location" is the disk's word, recorded
      // by the reconciler, and losing it because the call failed would make
      // the next reader repeat the whole exchange to learn it again.
      architecture.save(root, model);
      if (!r.ok) return { output: r.error, isError: true };
      return { output: `Verified ${r.node.name}: ${r.node.verification.how} — ${r.node.verification.result}` };
    }

    if (op === 'find') {
      const model = architecture.load(root);
      const q = String(input.node || input.query || '').trim();
      if (!q) return { output: 'find needs something to look for', isError: true };
      const found = architecture.find(model, q);
      if (!found.matches.length) return { output: `no node matches "${q}".` };
      return { output: found.matches.map((n) => `${n.id} — ${n.name} [${n.status}]`).join('\n') };
    }

    if (op === 'seed') {
      // DETERMINISTIC CANDIDATES ONLY — files the index has actually seen, no
      // guessed purpose, every node marked origin:'seed'. See architecture.seed.
      const model = architecture.load(root);
      let files = [];
      try {
        const sync = await require('../projectsync').open(root);
        files = Object.keys(sync.refresh.index.files || {}).map((p) => ({ path: p }));
      } catch { /* no index buildable: nothing honest to seed */ }
      if (!files.length) {
        return { output: 'the project index could not be built, so there is nothing observed to seed from.', isError: true };
      }
      const r = architecture.seed(model, files);
      architecture.save(root, model);
      return { output: `Seeded ${r.added} candidate node(s) from files the index observed`
        + `${r.skipped ? ` (${r.skipped} already had locations)` : ''}${r.capped ? ' — capped; seed again after declaring' : ''}.\n`
        + 'They are CANDIDATES: locations verified against disk, purpose deliberately empty, origin:seed. '
        + 'Declare intent (purpose, status, wiring) onto them; do not treat a seed as an architecture.' };
    }

    if (op === 'show') {
      const model = architecture.load(root);
      const q = String(input.node || '').trim();
      // RECONCILED BEFORE SHOWN, always: `observed` is a fact about the disk
      // and ages in an hour. The read is the reconciler's caller — the model
      // never writes what the disk said, it only triggers the looking.
      const { report } = reconcile.run(root, { model });
      if (q) {
        const found = architecture.find(model, q);
        if (!found.matches.length) return { output: `no node matches "${q}".` };
        if (found.matches.length > 1) {
          return { output: `ambiguous — ${found.matches.map((n) => n.id).join(', ')}`, isError: true };
        }
        return { output: architecture.describe(model, found.matches[0]) };
      }
      const dangling = wiring.dangling(wiring.load(root), model);
      const out = [architecture.render(model, { detail: Boolean(input.detail) }), '', reconcile.say(model, report)];
      if (dangling.length) {
        out.push('', `wiring names ${dangling.length} node(s) no architecture declares: ${dangling.join(', ')}`);
      }
      return { output: out.join('\n') };
    }

    return { output: `unknown op "${op}" — declare, verify, show or find`, isError: true };
  },
};

// ---------------------------------------------------------------------------
// wiring — how the parts are connected, beyond what imports can say
// ---------------------------------------------------------------------------

tools.wiring = {
  mutates: false,
  schema: {
    name: 'wiring',
    description:
      'Typed relationships between architecture nodes — the edges an import graph cannot express: what WAKES '
      + 'what, what BLOCKS on what, what SENDS to what across a boundary, what RECOVERS what. Record an edge '
      + 'when you have established one ("X wakes the turn loop"), and view a component\'s wiring before changing '
      + 'it — knowing what it calls tells you nothing about what calls it.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['connect', 'disconnect', 'view'],
          description: 'connect: record an edge (re-declaring merges detail). disconnect: remove edges '
            + 'matching the given ends. view: one node\'s edges both directions, or the whole graph grouped '
            + 'by relationship.',
        },
        from: { type: 'string', description: 'architecture node id of the subject' },
        to: { type: 'string', description: 'architecture node id of the object' },
        rel: {
          type: 'string',
          description: 'CALLS | DEPENDS_ON | SENDS | RECEIVES | OWNS | READS | WRITES | EMITS | CONSUMES | WAKES | BLOCKS | RECOVERS',
        },
        via: { type: 'string', description: 'the transport or mechanism — HTTP, a socket, an event name' },
        note: { type: 'string', description: 'one line of why or when' },
        node: { type: 'string', description: 'for view: the node whose wiring to show' },
      },
      required: ['op'],
    },
  },
  async run(input, ctx) {
    const root = path.resolve(ctx.cwd || process.cwd());
    const graph = wiring.load(root);
    const model = architecture.load(root);
    const op = String(input.op || '');

    if (op === 'connect') {
      const r = wiring.connect(graph, input);
      if (!r.ok) return { output: r.error, isError: true };
      if (!wiring.save(root, graph)) {
        return { output: 'the edge could not be written to .lain/ — the project may be read-only', isError: true };
      }
      return { output: `${r.created ? 'Wired' : 'Merged'}: ${wiring.sayEdge(r.edge, { model })}` };
    }

    if (op === 'disconnect') {
      const r = wiring.disconnect(graph, input);
      wiring.save(root, graph);
      return { output: r.removed ? `Removed ${r.removed} edge(s).` : 'No edge matched.' };
    }

    if (op === 'view') {
      const q = String(input.node || '').trim();
      if (!q) return { output: wiring.summary(graph, { model }) };
      const found = architecture.find(model, q);
      const id = found.matches.length ? found.matches[0].id : q;
      return { output: wiring.render(graph, id, { model }) };
    }

    return { output: `unknown op "${op}" — connect, disconnect or view`, isError: true };
  },
};

// ---------------------------------------------------------------------------
// scratch — this turn's findings, and the door into durable memory
// ---------------------------------------------------------------------------

tools.scratch = {
  mutates: false,
  schema: {
    name: 'scratch',
    description:
      'Working notes for the CURRENT turn, and the door into durable memory. A note is a short named '
      + 'finding — "the socket listens on 127.0.0.1 only" — recorded as you find it, worth nothing next '
      + 'week. Notes survive interruption, crash and model switch (a replacement model reads them instead '
      + 'of starting from nothing) and are deleted when the turn completes. PROMOTE a finding to a durable '
      + 'fact only when you can name the evidence that established it — a command, a test, a file you read; '
      + 'promotion without evidence is refused.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['note', 'findings', 'promote', 'facts'],
          description: 'note: record a finding for this turn. findings: what this session has noted. '
            + 'promote: make a finding durable — requires the evidence that established it. '
            + 'facts: what this project remembers, newest last.',
        },
        text: { type: 'string', description: 'the finding or fact — one line, self-contained' },
        kind: { type: 'string', description: 'finding | lead | risk | measurement' },
        evidence: { type: 'string', description: 'for promote: what ESTABLISHED it — a command that ran, a test that passed, a file that was read' },
      },
      required: ['op'],
    },
  },
  async run(input, ctx) {
    const root = path.resolve(ctx.cwd || process.cwd());
    const session = (ctx && ctx.session && ctx.session.id) || 'unknown';
    const op = String(input.op || '');

    if (op === 'note') {
      const r = scratch.note(root, session, { text: input.text, by: 'model', kind: input.kind });
      if (!r.ok) return { output: r.error || 'the note could not be recorded', isError: true };
      return { output: `Noted (${r.count} this session).` };
    }

    if (op === 'findings') {
      const notes = scratch.notes(root, session);
      if (!notes.length) return { output: 'Nothing noted this session yet.' };
      return { output: notes.map((n) => `- ${n.text}  [${n.by || n.kind}]`).join('\n') };
    }

    if (op === 'promote') {
      const r = scratch.promote(root, session, { text: input.text, evidence: input.evidence, by: 'model' });
      if (!r.ok) return { output: r.error, isError: true };
      return { output: 'Promoted to a durable fact — it now survives compaction, clears and restarts.' };
    }

    if (op === 'facts') {
      const facts = scratch.remembered(root);
      if (!facts.length) return { output: 'Nothing has been promoted to memory for this project yet.' };
      return { output: facts.map((f) => `- ${f.text}  [${f.evidence}]`).join('\n') };
    }

    return { output: `unknown op "${op}" — note, findings, promote or facts`, isError: true };
  },
};

module.exports = { tools };
