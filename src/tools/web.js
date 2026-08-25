'use strict';

/**
 * web_fetch and web_search — the model's route to something it did not write.
 *
 * See src/research.js for what leaves the machine and who is told about it.
 * This file is the two schemas and the two result shapes, and it exists apart
 * from the mechanism for the reason every tool file here does: the WORDS a
 * model reads and the WORK a function does change for different reasons.
 *
 * BOTH RETURN EVIDENCE, AND SAY WHAT KIND. A page is what a stranger published,
 * not what is true, and a result list is what an engine ranked, not what is
 * relevant. Neither is a fact about this project, and the descriptions below
 * say so — because a model that treats a blog post as a measurement will write
 * a confident answer on top of it.
 */

const research = require('../research');

const NL = String.fromCharCode(10);

// ------------------------------------------------------------- web_fetch --

const fetchSchema = {
  name: 'web_fetch',
  description:
    'Read a web page as text — documentation, a changelog, a release note, an issue thread, a raw file. '
    + 'Use it whenever the answer depends on something outside this machine that may have changed since '
    + 'you were trained: an API signature, a flag, a version, a deprecation. Answering those from memory '
    + 'is the most expensive kind of wrong answer, because it reads exactly like a right one. '
    + 'Returns the page as plain text, bounded. '
    + 'WHAT IT IS NOT: this is what somebody published, not a fact about this project, and never evidence '
    + 'that your change works — for that, run something. It cannot log in, cannot POST, and cannot fetch '
    + 'anything behind authentication. For a file on this machine use read_file.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'the http or https URL to read' },
      max_chars: {
        type: 'number',
        description: `how much of the page to return (default ${research.MAX_CHARS})`,
      },
    },
    required: ['url'],
  },
};

async function runFetch(input, ctx) {
  const app = ctx && ctx.app;
  const r = await research.fetchUrl(input && input.url, {
    maxChars: Number(input && input.max_chars) || research.MAX_CHARS,
    signal: ctx && ctx.signal,
  });
  if (!r.ok) {
    research.note(app, `fetch failed · ${String(r.why).slice(0, 120)}`);
    return { output: r.why, isError: true, meta: { web: 'fetch' } };
  }
  research.note(app, `read · ${r.title || r.url}`);
  const head = [
    `${r.url}${r.status && r.status !== 200 ? `  [HTTP ${r.status}]` : ''}`,
    r.title ? `title: ${r.title}` : null,
    r.truncated ? `[truncated — the page is longer than the ${input && input.max_chars ? 'requested' : 'default'} limit]` : null,
    '',
  ].filter((x) => x !== null);
  return {
    output: head.join(NL) + r.text,
    meta: { web: 'fetch', url: r.url, status: r.status, truncated: r.truncated },
  };
}

// ------------------------------------------------------------ web_search --

const searchSchema = {
  name: 'web_search',
  description:
    'Search the web and get back titles, URLs and snippets. Use it to FIND the page you then read with '
    + 'web_fetch — an error message nobody here has seen before, a library\'s current recommended usage, '
    + 'whether a bug you are looking at is already known. '
    + 'A snippet is a fragment chosen by a search engine: it is a pointer, not an answer. Do not conclude '
    + 'anything from a snippet alone — fetch the page. '
    + 'This drives the Chromium LAIN itself runs, so it is only available while that browser is up, '
    + 'and that browser has to have a VISIBLE window: search engines serve an unrelated results page to '
    + 'a headless one. If this reports that the results had nothing to do with the query, that is why, '
    + 'and the fix is one only the user can make — say so rather than retrying.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'what to search for' },
      limit: { type: 'number', description: `how many results (default ${research.MAX_RESULTS})` },
    },
    required: ['query'],
  },
};

async function runSearch(input, ctx) {
  const app = ctx && ctx.app;
  let browser = null;
  try { browser = require('../browser').live(); } catch { browser = null; }
  const r = await research.search(browser, input && input.query, {
    limit: Number(input && input.limit) || research.MAX_RESULTS,
  });
  if (!r.ok) {
    research.note(app, `search failed · ${String(r.why).slice(0, 120)}`);
    return { output: r.why, isError: true, meta: { web: 'search' } };
  }
  research.note(app, `searched · ${r.query}`);
  if (!r.results.length) {
    // A REAL ANSWER, NOT A FAILURE. "Nothing came back" is information, and
    // reporting it as an error invites a retry of the same query.
    return {
      output: `No results for: ${r.query}${NL}That is what the engine returned, not a failure to look. `
        + 'Try different words, or a more specific site.',
      meta: { web: 'search', results: 0 },
    };
  }
  const rows = r.results.map((x, i) => `${i + 1}. ${x.title}${NL}   ${x.url}`
    + (x.snippet ? `${NL}   ${x.snippet}` : ''));
  return {
    output: `${r.results.length} result(s) for: ${r.query}${NL}${NL}${rows.join(NL + NL)}`
      + `${NL}${NL}These are titles and snippets chosen by a search engine. Read the page with web_fetch `
      + 'before relying on any of it.',
    meta: { web: 'search', results: r.results.length },
  };
}

module.exports = {
  // `mutates: false` — both of these READ. Nothing here changes a file, a
  // process or a page, which is what lets them run without a checkpoint.
  fetchTools: { web_fetch: { mutates: false, schema: fetchSchema, run: runFetch } },
  searchTools: { web_search: { mutates: false, schema: searchSchema, run: runSearch } },
};
