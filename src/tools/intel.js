'use strict';

/**
 * PROJECT INTELLIGENCE — the questions a model should not have to read its way to.
 *
 * ------------------------------------------------------------------------
 * WHY THESE TWO ARE A FAMILY, and why they left search.js.
 *
 * `grep`, `glob`, `symbols` and `dependents` are PRIMITIVES: each answers one
 * narrow question and leaves the composing to the caller. These two do the
 * composing, and that is a different job:
 *
 *     understand   what is this project?      -> served from `.lain/`
 *     locate       where is this, and what    -> one walk, four answers
 *                  touches it?
 *
 * The measured reason they exist at all: a request in this codebase carries
 * ~65,000 input tokens and returns a ~36-token tool call. A model that has to
 * chain `symbols` -> `read_symbol` -> `dependents` pays that four times to
 * learn four facts one pass already knows. Composing in the runtime turns four
 * requests into one.
 *
 * BOTH REFRESH AGAINST THE DISK BEFORE THEY ANSWER, and neither replaces the
 * primitives — when the curated answer is not enough, `read_symbol`, `grep` and
 * `read_file` are still there, and the output says so where a cap bit.
 */

const path = require('path');

const tools = {};

/**
 * ONE CALL FOR THE WHOLE QUESTION.
 *
 * ---- THE ROUND TRIPS THIS REPLACES -------------------------------------
 *
 * `symbols` says where a name is. `read_symbol` says what it does. `dependents`
 * says what breaks if it changes. Each of those is a separate model request,
 * and a request in this codebase carries about 65,000 input tokens to return a
 * 36-token tool call. Four hops to learn four facts that one pass over the tree
 * already knows is the shape of the measured incident: 815 requests, 59.2M
 * input, 202K output.
 *
 * So the composition happens in the runtime. This is not a new index and not a
 * replacement for the tools above - it USES them (the same walk, the same
 * definition classification, the same import matching, plus codemodel for the
 * body) and returns the four answers together. It also costs ONE traversal
 * where asking `symbols` and `dependents` separately costs two.
 *
 * THE OTHER TOOLS REMAIN. This is the cheapest sufficient answer, not a wall:
 * when it is not enough, `read_symbol`, `grep` and `read_file` are still there
 * and the output says so where a cap bit.
 */
tools.locate = {
  mutates: false,
  schema: {
    name: 'locate',
    description:
      'START HERE for "where is X" and "what would break if I change X". One call returns, together: '
      + 'where a name is DECLARED, its DEFINITION, how many times it is REFERENCED and in which files, '
      + 'and which files IMPORT the file it lives in. Give it an identifier, or a project-relative path '
      + 'to ask what a FILE defines and what depends on it. '
      + 'Prefer this over chaining symbols -> read_symbol -> dependents: it answers all of them in one pass '
      + 'over the files on disk, and there is no index to go stale. '
      + 'LEXICAL, not a parser: it cannot tell two things with the same name apart, cannot follow an alias '
      + 'or a re-export, and counts a mention in a comment as a use. Confirm anything you are about to rewrite.',
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'an identifier, e.g. "saveSettings", or a path, e.g. "src/web/settings.js"' },
        include: { type: 'string', description: 'glob limiting which files are searched, e.g. "src/**/*.ts"' },
      },
      required: ['what'],
    },
  },
  async run(input, ctx) {
    const what = String(input.what == null ? '' : input.what).trim();
    if (!what) return { output: 'locate needs a name or a path', isError: true };
    const root = path.resolve(ctx.cwd || process.cwd());
    const r = require('../locate').locate(root, what, { include: input.include || null });
    return { output: r.text, isError: !r.ok, meta: r.meta };
  },
};

/**
 * WHAT IS THIS PROJECT? - answered from `.lain/`, not by reading it again.
 *
 * ---- THE FOUR REQUESTS THIS REPLACES -----------------------------------
 *
 * A model opening an unfamiliar tree reads the README, lists the directories,
 * greps for an entry point and opens a handful of files - four or more requests
 * at ~65,000 input tokens each, to learn things an index already holds.
 *
 * This returns a PROJECTION of that index: counts, the modules with the most
 * declarations, and what changed since last time. Never the index itself -
 * shipping the whole thing into a prompt would recreate the cost it removes.
 *
 * IT IS REFRESHED AGAINST THE DISK BEFORE IT ANSWERS. See projectindex.js: a
 * stat pass, and a re-scan of whatever moved. V1 kept an index that aged
 * silently and answered confidently from stale data; this one cannot, because
 * there is no accessor that returns what was written last time.
 */
tools.understand = {
  mutates: false,
  schema: {
    name: 'understand',
    description:
      'What this project IS: how many files, which modules carry the most code, and what changed '
      + 'since the last session. Read this BEFORE listing directories or opening files to orient '
      + 'yourself - it is served from a persistent index and costs one stat pass over the tree, '
      + 'where reading your way in costs several requests. '
      + 'Follow it with `locate <name|path>` for anything specific. '
      + 'It is a summary, not the whole index, and it describes STRUCTURE, not behaviour.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(input, ctx) {
    const root = path.resolve(ctx.cwd || process.cwd());
    const pi = require('../projectindex');
    // ---- THE WORKER READS, THE RUNTIME REMEMBERS -------------------------
    //
    // `projectsync` refreshes `<project>/.lain` and tells the runtime what it
    // found, so the answer can say "unchanged since the last session" - which
    // is a fact only the runtime holds. The index alone can say that nothing
    // moved since the last stat, which is a weaker and different claim.
    let sync;
    try { sync = await require('../projectsync').open(root); } catch (e) {
      return { output: `the project index could not be built: ${(e && e.message) || e}`, isError: true };
    }
    const r = sync.refresh;
    const changed = r.changed + r.added;
    const note = [];
    if (!r.persisted) {
      // SAID, NOT SWALLOWED. A project that cannot be written to still works;
      // it simply pays the scan every time, and the reader should know why.
      note.push('', 'The index could not be written to .lain/ - this directory may be read-only. '
        + 'Everything still works; it is rebuilt each session instead of reused.');
    }
    if (r.truncated) {
      note.push('', 'The refresh ran out of its time budget, so some files are described by an '
        + 'older entry. Ask again to continue indexing.');
    }
    const NL = String.fromCharCode(10);
    // ---- WHAT THE PROJECT ITSELF HAS RECORDED -------------------------------
    //
    // The durable layer (.lain) is part of orientation when it has content:
    // counts only, never the documents — the point of `understand` is to say
    // what EXISTS cheaply, and a reader who needs the architecture branch asks
    // `architecture show`; one who needs a word asks `concept`. An empty layer
    // says so in one line rather than silence, so the model knows the door is
    // there and simply unpopulated (seed exists for exactly that).
    const lain = [];
    try {
      const lainstore = require('../lainstore');
      const architecture = require('../architecture');
      const dictionary = require('../dictionary');
      const wiring = require('../wiring');
      const scratch = require('../scratch');
      if (lainstore.has(root, 'architecture') || lainstore.has(root, 'concepts')) {
        const t = architecture.tally(architecture.load(root));
        const terms = Object.keys(dictionary.load(root).terms).length;
        const edges = wiring.load(root).edges.length;
        const facts = scratch.facts(root).length;
        lain.push(`${NL}Project records (.lain): ${t.nodes} architecture node(s)`
          + `${t.missing || t.damaged || t.drifted ? `, ${t.missing + t.damaged + t.drifted} MISSING/DAMAGED/DRIFTED — architecture show lists them` : ''}`
          + `, ${terms} concept(s), ${edges} wiring edge(s), ${facts} verified fact(s).`
          + (facts ? ' The facts are load-bearing: do not re-derive what they state.' : ''));
      }
    } catch { /* orientation never fails for want of the durable layer */ }
    return {
      output: pi.orientation(r.index)
        + `${NL}${NL}${require('../projectsync').say(sync.verdict, r)} (${r.ms}ms)`
        + note.join(NL)
        + lain.join(''),
      meta: {
        indexed: r.scanned, reused: r.reused, rescanned: changed, ms: r.ms,
        // THE RUNTIME'S WORD, carried so a caller can tell "I have never seen
        // this project" from "it has not moved since you left".
        verdict: sync.verdict,
      },
    };
  },
};

module.exports = { tools };
