'use strict';

/**
 * LOOKING THINGS UP — and the two ways it lies if nobody checks.
 *
 * ------------------------------------------------------------------------
 * THE GAP THIS CLOSES. Every tool LAIN had read this machine: the filesystem,
 * the shell, the symbol index, the test runner. A question whose answer lives
 * in a changelog or an API reference could only be answered FROM MEMORY, which
 * for a model means answered from a training cut-off with the confidence of
 * something read. `web_fetch` and `web_search` are the way out of that.
 *
 * ------------------------------------------------------------------------
 * BOTH FAILURE MODES BELOW WERE MEASURED, not imagined, on real pages:
 *
 *   THE PAGE IS MOSTLY NOT THE PAGE. The Node.js `fs` documentation returns
 *   10,576 characters of contents listing before its first sentence, and the
 *   page then truncates — so the navigation was not noise, it was pushing the
 *   ANSWER out of the window.
 *
 *   THE ENGINE SUBSTITUTES A DIFFERENT PAGE. Bing served a headless browser
 *   four Louisiana court cases in answer to "ERR_REQUIRE_ESM node", and served
 *   the same query from a visible window Stack Overflow as the first result.
 *   The degraded page is well-formed and parses perfectly. Nothing in the
 *   markup says the answer is wrong, which is exactly why it needs a test: a
 *   search that FAILS is retried, and a search that LIES is believed.
 */

const assert = require('assert');
const { test } = require('../helpers');

const research = require('../../src/research');
const redact = require('../../src/redact');

const NL = String.fromCharCode(10);

module.exports = async function () {
  // ----------------------------------------------------------- the URL ----

  await test('WEB: only http and https, and the refusal says where to go instead', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x']) {
      const r = research.normalizeUrl(bad);
      assert.strictEqual(r.ok, false, `${bad} must not be fetchable`);
    }
    assert.match(research.normalizeUrl('file:///c:/x').why, /read_file/,
      'a local path has a tool of its own, and the refusal must name it');
    assert.strictEqual(research.normalizeUrl('https://example.com/a').ok, true);
    assert.strictEqual(research.normalizeUrl('  http://example.com  ').ok, true, 'trimmed');
    assert.strictEqual(research.normalizeUrl('').ok, false);
  });

  await test('WEB: a credential cannot leave in a URL or a query', () => {
    const SENT = 'LAIN_SECRET_SENTINEL_DO_NOT_RENDER_9f3a';
    redact.clear();
    redact.register(SENT);
    try {
      const r = research.normalizeUrl(`https://example.com/?token=${SENT}`);
      assert.strictEqual(r.ok, true);
      assert.ok(!r.url.includes(SENT),
        'a URL is OUTBOUND — a key in one is a key sent to a stranger, and it cannot be recalled');
    } finally { redact.clear(); }
  });

  // -------------------------------------------------------- the page ------

  await test('WEB: a page becomes readable text, and the script bodies do not come with it', () => {
    const html = '<html><head><title>Docs</title><style>a{color:red}</style></head>'
      + '<body><script>var secret = 1; alert("x")</script>'
      + '<h1>Heading</h1><p>First paragraph.</p><p>Second &amp; last.</p>'
      + '<ul><li>one</li><li>two</li></ul></body></html>';
    const text = research.htmlToText(html);
    assert.ok(!/alert|var secret/.test(text), 'a stripped <script> tag must not leave its source behind');
    assert.ok(!/color:red/.test(text), 'nor a <style> its rules');
    assert.match(text, /First paragraph\./);
    assert.match(text, /Second & last\./, 'entities are decoded');
    assert.match(text, /- one/, 'a list stays a list');
    // BLOCK TAGS BECOME NEWLINES BEFORE TAGS ARE STRIPPED, or the whole page
    // collapses into one paragraph and a list of options reads as a sentence.
    assert.ok(text.includes(NL), 'the structure of the page must survive the conversion');
    assert.strictEqual(research.titleOf(html), 'Docs');
  });

  await test('WEB: a long run of navigation links is collapsed, and SAYS it was', () => {
    // 40 short bullet lines with no sentence in them: a sidebar, whatever
    // markup produced it. The real measurement is in the header of this file.
    const nav = Array.from({ length: 40 }, (_, i) => `- Section ${i}`).join(NL);
    const out = research.dropNavRuns(`${nav}${NL}The actual answer is here.`);
    assert.match(out, /\[40 navigation links omitted\]/,
      'nothing may vanish silently — an absence the reader cannot see is worse than the noise');
    assert.match(out, /The actual answer is here\./, 'and the prose must survive');
    assert.ok(out.length < 200, `the run must actually be collapsed, got ${out.length} chars`);
  });

  await test('WEB: a SHORT list is left alone, and so is a list of real sentences', () => {
    // The line this must not cross. A page whose content IS a list must not be
    // emptied by a filter aimed at sidebars.
    const short = ['- alpha', '- beta', '- gamma'].join(NL);
    assert.strictEqual(research.dropNavRuns(short), short, 'three items is a list, not a navbar');

    const sentences = Array.from({ length: 40 }, (_, i) => `- Item ${i} does something specific.`).join(NL);
    assert.ok(!/omitted/.test(research.dropNavRuns(sentences)),
      'entries that end like sentences are content, however many there are');
  });

  // ------------------------------------------------------ the substitution --

  await test('WEB: results that have nothing to do with the query are DISCARDED, not passed on', () => {
    // MEASURED. This is the exact result set Bing served a headless browser for
    // this exact query, and it parsed perfectly.
    const louisiana = [
      { title: 'STATE OF LOUISIANA VS. SULLIVAN WALTER :: 2025', snippet: 'court of appeal', url: 'https://law.justia.com/cases/louisiana/x' },
      { title: 'Man wrongfully convicted at 17 wins compensation', snippet: 'wwltv', url: 'https://www.wwltv.com/article/news/local/y' },
    ];
    assert.strictEqual(research.anyRelevant('ERR_REQUIRE_ESM node', louisiana), false,
      'a substituted results page must be detectable, because nothing in its markup admits to it');

    const real = [
      { title: 'How would you fix an ERR_REQUIRE_ESM error?', snippet: '', url: 'https://stackoverflow.com/questions/71804844/x' },
    ];
    assert.strictEqual(research.anyRelevant('ERR_REQUIRE_ESM node', real), true);
  });

  await test('WEB: the relevance check is the WEAKEST one that works — one word is enough', () => {
    // A strong check would throw away good results. A page that answers the
    // question without repeating its words is common and must survive; a page
    // about something else entirely is what is being caught.
    const oneWord = [
      { title: 'Deleting directories in Node', snippet: 'use the recursive option', url: 'https://example.com/a' },
    ];
    assert.strictEqual(research.anyRelevant('node fs.rm recursive force', oneWord), true,
      'matching a single significant word is enough to be kept');
    const words = research.keywords('how does the ERR_REQUIRE_ESM work');
    assert.ok(words.includes('err_require_esm'), 'the word that identifies the question must be kept');
    for (const noise of ['how', 'does', 'the']) {
      assert.ok(!words.includes(noise),
        `"${noise}" appears on every page ever written — matching on it would pass any result set`);
    }
  });

  await test('WEB: searching without a browser says so, and names how to start one', () => {
    return research.search(null, 'anything').then((r) => {
      assert.strictEqual(r.ok, false);
      assert.match(r.why, /\/external browser/, 'the way to make it work must be named');
    });
  });

  // ------------------------------------------------------------- the tools --

  await test('WEB: web_fetch is always offered; web_search follows the browser', () => {
    const names = require('../../src/tools').names();
    assert.ok(names.includes('web_fetch'),
      'a plain GET needs no browser and works headless, in CI and over SSH');
    // The rule `browser` and `probe` already follow: a model told it can do
    // something it cannot will try, and spend a step finding out.
    let live = null;
    try { live = require('../../src/browser').live(); } catch { live = null; }
    assert.strictEqual(names.includes('web_search'), Boolean(live),
      'web_search must be offered exactly when the Chromium it drives is running');
  });

  await test('WEB: neither tool MUTATES, so neither needs a checkpoint', () => {
    const web = require('../../src/tools/web');
    assert.strictEqual(web.fetchTools.web_fetch.mutates, false);
    assert.strictEqual(web.searchTools.web_search.mutates, false);
  });

  await test('WEB: the model is told what a page IS, and what it is not', () => {
    const web = require('../../src/tools/web');
    const fetchDesc = web.fetchTools.web_fetch.schema.description;
    const searchDesc = web.searchTools.web_search.schema.description;
    // The whole risk of this feature in one sentence: a model that treats a
    // blog post as a measurement writes a confident answer on top of it.
    assert.match(fetchDesc, /not a fact about this project/i);
    assert.match(fetchDesc, /never evidence that your change works/i);
    assert.match(searchDesc, /pointer, not an answer/i);
    assert.match(searchDesc, /VISIBLE window/,
      'the headless failure is not discoverable from the result, so it must be in the description');
  });

  await test('WEB: a fetch failure is reported as itself, and starts no turn of guessing', async () => {
    // A stub, so no socket is opened by the unit tier.
    const r = await research.fetchUrl('https://example.com/x', {
      fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND example.com'); },
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /ENOTFOUND/, 'the real reason, not a paraphrase of it');
  });

  await test('WEB: something that is not text is refused before it is decoded', async () => {
    const r = await research.fetchUrl('https://example.com/a.pdf', {
      fetchImpl: async () => ({
        status: 200, url: 'https://example.com/a.pdf',
        headers: { get: () => 'application/pdf' },
        text: async () => 'PDF-1.7 binary noise',
      }),
    });
    assert.strictEqual(r.ok, false, 'megabytes of binary in a context window is an expensive way to learn this');
    assert.match(r.why, /not readable as text/);
    assert.match(r.why, /run_bash/, 'and the tool that CAN get the bytes is named');
  });
};
