'use strict';

/**
 * web_fetch — the model's route to something it did not write.
 *
 * See src/research.js for what leaves the machine and who is told about it.
 * This file is the schema and the result shape, and it exists apart from the
 * mechanism for the reason every tool file here does: the WORDS a model reads
 * and the WORK a function does change for different reasons.
 *
 * IT RETURNS EVIDENCE, AND SAYS WHAT KIND. A page is what a stranger
 * published, not what is true, and the description below says so — because a
 * model that treats a blog post as a measurement will write a confident
 * answer on top of it.
 *
 * (A `web_search` tool lived here too, driving the Chromium LAIN owned; the
 * browser and the tool were removed together in 2026-09 per the browser
 * ownership removal. The plain fetch survives — it needs no browser, no
 * profile, no cookies, and it is what documentation actually needs.)
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

module.exports = {
  // `mutates: false` — this READS. Nothing here changes a file, a process or a
  // page, which is what lets it run without a checkpoint.
  fetchTools: { web_fetch: { mutates: false, schema: fetchSchema, run: runFetch } },
};
