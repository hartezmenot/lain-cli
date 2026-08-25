'use strict';

/**
 * LOOKING THINGS UP — the one place LAIN reads something it did not write.
 *
 * ------------------------------------------------------------------------
 * THE GAP THIS CLOSES. LAIN could read this machine and nothing else. Every
 * tool in the registry was the filesystem, the shell, the symbol index or the
 * test runner, so a question whose answer lives in a changelog, an issue
 * thread, a vendor's API reference or a release note could only be ANSWERED
 * FROM MEMORY — which for a model means answered from a training cut-off, with
 * the confidence of something read rather than the honesty of something
 * remembered. That is the single most expensive kind of wrong answer a coding
 * agent produces, because it is indistinguishable on the page from a right one.
 *
 * ------------------------------------------------------------------------
 * THE TWO WAYS OUT, AND WHY THEY ARE DIFFERENT MECHANISMS.
 *
 *   FETCH   is a plain HTTP GET. No browser, no JavaScript, no profile, no
 *           cookies. It works headless, in CI, over SSH, and it is what
 *           documentation actually needs — a docs page is HTML that says the
 *           same thing to a socket as it says to Chrome.
 *
 *   SEARCH  drives LAIN'S OWN CHROMIUM, the same one `/external browser`
 *           starts and the `browser` tool uses. Search engines are the one
 *           corner of the web that is actively hostile to a bare socket: a
 *           plain GET gets a consent wall, a bot check, or markup that changes
 *           weekly. A real browser is not a workaround for that, it is the
 *           honest way to do it — and LAIN already owns one.
 *
 * So SEARCH follows the runtime, exactly like `browser` and `probe`: it is
 * offered to the model only while the Chromium is actually running, because a
 * model told it can search will search.
 *
 * ------------------------------------------------------------------------
 * WHAT LEAVES THE MACHINE, AND WHO SEES IT GO.
 *
 * A URL and a query are OUTBOUND. They are smaller than the `/external` packet
 * — which carries the project path, the changed files and the last command —
 * but they are composed by a model out of whatever it is currently looking at,
 * and "search for the error I just read" is one step away from putting a chunk
 * of somebody's source into a query string.
 *
 * Two rules, and they are the same two `/external` follows:
 *
 *   REDACTED FIRST. Every query and every URL goes through src/redact.js
 *   before it is used. A credential cannot leave in a search box.
 *
 *   ANNOUNCED, ALWAYS. Each lookup writes one line to the conversation, on the
 *   same channel the external consultation uses. Research that happens
 *   invisibly is research nobody can object to, and the whole design of this
 *   program is that the user can see what it is doing on their behalf.
 *
 * WHAT IS DELIBERATELY NOT HERE: no credential store, no logging in, no
 * paywalled or authenticated fetching, no POST, and nothing that would let a
 * page decide what LAIN does next. This reads. It does not act.
 */

const redact = require('./redact');

/** A page is evidence, not a corpus. Bounded like every other input. */
const MAX_CHARS = 40_000;
const MAX_BYTES = 5_000_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 10;

/**
 * WHAT LAIN SAYS IT IS. A real product name and a contact URL, because a server
 * deciding whether to serve a robot deserves to know which one, and a program
 * that disguises itself as a browser it is not is lying to the machine it is
 * asking for a favour.
 */
const UA = 'LAIN/2 (+https://github.com/lain-cli) coding-agent';

// ------------------------------------------------------------------ fetch --

/** http and https, and nothing else — no file:, no data:, no javascript:. */
function normalizeUrl(raw) {
  const text = redact.text(String(raw || '').trim());
  if (!text) return { ok: false, why: 'no url given' };
  let u;
  try { u = new URL(text); } catch { return { ok: false, why: `not a URL: ${text.slice(0, 120)}` }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return {
      ok: false,
      why: `${u.protocol} is not fetchable. This reads http and https pages; for a file on this machine use read_file.`,
    };
  }
  return { ok: true, url: u.toString() };
}

/**
 * HTML TO SOMETHING WORTH READING.
 *
 * Deliberately small and deliberately not a parser. The goal is the PROSE — a
 * docs page, a changelog, an issue thread — and the things that destroy it are
 * few and easy to name: script and style bodies, navigation chrome, and the
 * whitespace that HTML is written in but not read in. A real DOM library would
 * be a dependency and a second thing to keep, for an output that is fed to a
 * model rather than rendered.
 *
 * Block-level tags become newlines BEFORE tags are stripped, or a page collapses
 * into one enormous paragraph and a list of five options reads as a sentence.
 */
/**
 * THE PART OF THE PAGE THAT IS THE PAGE.
 *
 * Verified against the real Node.js docs, which returned the title and then a
 * hundred sidebar links before reaching a sentence — the model would have spent
 * its budget on a table of contents. Most documentation marks its content, so
 * ask for the mark; a page that does not have one gives back the whole body,
 * which is what happened before this existed.
 *
 * Ordered by how specific the mark is. `<main>` and `<article>` are the
 * standard ones; `#apicontent` and `.markdown-body` are what two of the three
 * sites a coding agent reads most actually use.
 */
const CONTENT = [
  /<main\b[^>]*>([\s\S]*?)<\/main>/i,
  /<article\b[^>]*>([\s\S]*?)<\/article>/i,
  /<div[^>]*\bid=["']?(?:apicontent|content|main-content)\b[^>]*>([\s\S]*)<\/div>/i,
  /<div[^>]*\bclass=["'][^"']*\b(?:markdown-body|article-body)\b[^"']*["'][^>]*>([\s\S]*)<\/div>/i,
];

function mainRegion(html) {
  const s = String(html || '');
  for (const re of CONTENT) {
    const m = re.exec(s);
    // A mark that captures almost nothing is a mark on the wrong element — a
    // page whose <main> holds one heading is worse than the page.
    if (m && m[1] && m[1].length > 400) return m[1];
  }
  return s;
}

function htmlToText(html) {
  let s = mainRegion(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // The bodies, not just the tags: a stripped <script> leaves its source behind.
  s = s.replace(/<(script|style|noscript|svg|canvas|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote|table)\s*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<h([1-6])\b[^>]*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCharCode(Number(d)); } catch { return ' '; } });
  // Whitespace last, so the newlines introduced above survive.
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return dropNavRuns(s.trim());
}

/**
 * NAVIGATION IS NOT THE PAGE, AND IT IS MOST OF THE BYTES.
 *
 * MEASURED, not guessed. The Node.js `fs` documentation returns 10,576
 * characters of contents listing before its first sentence — a quarter of the
 * budget spent on a table of contents whose every entry appears again below as
 * a heading with the prose under it. The page then truncates, so the chrome was
 * not merely noise: it was pushing the ANSWER out of the window.
 *
 * WHY THIS IS A TEXT FILTER AND NOT A SELECTOR. `mainRegion` above tries the
 * marks a page can carry, and Node's carries none of them — unquoted `id=`
 * attributes, no `<main>`, no `<article>`. Chasing per-site ids is how a
 * scraper rots: it works on the three sites it was written against and fails
 * silently everywhere else. A long run of SHORT BULLET LINES WITH NO SENTENCE
 * IN THEM is what a navigation list becomes after conversion, whatever markup
 * produced it, so that is what this looks for.
 *
 * WHAT IT CAN GET WRONG, and what is done about it: a genuinely long list of
 * short items — a changelog of one-line entries, an option index — looks the
 * same. So the threshold is high, and NOTHING VANISHES SILENTLY: the run is
 * replaced by a line saying how many entries were dropped, which is a fact the
 * reader can act on rather than an absence they cannot see.
 */
const NAV_RUN = 25;
const NAV_LINE = 90;

function dropNavRuns(text) {
  const lines = String(text).split('\n');
  const out = [];
  let run = [];
  const isNav = (l) => {
    const t = l.trim();
    if (!t.startsWith('- ')) return false;
    const body = t.slice(2).trim();
    // A sentence has an end. A link label does not.
    return body.length > 0 && body.length <= NAV_LINE && !/[.!?:;]$/.test(body);
  };
  const flush = () => {
    if (run.length > NAV_RUN) out.push(`[${run.length} navigation links omitted]`);
    else out.push(...run);
    run = [];
  };
  for (const line of lines) {
    if (isNav(line)) { run.push(line); continue; }
    // A blank line inside a run is how the converter separates list items, so
    // it does not end the run — anything else does.
    if (!line.trim() && run.length) continue;
    flush();
    out.push(line);
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? htmlToText(m[1]).slice(0, 200) : null;
}

/**
 * GET a page and return what it says.
 *
 * @returns {{ok, url, status, title, text, truncated, contentType}} or {ok:false, why}
 */
async function fetchUrl(raw, { maxChars = MAX_CHARS, signal = null, fetchImpl = null } = {}) {
  const norm = normalizeUrl(raw);
  if (!norm.ok) return norm;
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, why: 'this Node build has no fetch' };

  // The caller's cancellation AND a deadline of our own. A server that accepts
  // the connection and then says nothing is the common shape of a bad host, and
  // it must not hold a turn open.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) return { ok: false, why: 'cancelled' };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await doFetch(norm.url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'user-agent': UA, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
    });
    const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
    // A PDF, an image or a tarball is not something a model can read, and
    // decoding megabytes of it into a context window is an expensive way to
    // learn that. Say what it is instead.
    if (/^(image|audio|video)\//.test(type) || /application\/(pdf|zip|octet-stream)/.test(type)) {
      return {
        ok: false,
        why: `${norm.url} is ${type.split(';')[0]}, which is not readable as text. `
          + 'Download it with run_bash if you need the bytes.',
        status: res.status,
      };
    }
    const body = await res.text();
    if (body.length > MAX_BYTES) {
      return { ok: false, why: `${norm.url} returned ${body.length} bytes, past the ${MAX_BYTES} limit` };
    }
    const isHtml = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body);
    const text = isHtml ? htmlToText(body) : body.trim();
    const cut = text.length > maxChars;
    return {
      ok: true,
      url: res.url || norm.url,
      status: res.status,
      contentType: type.split(';')[0] || null,
      title: isHtml ? titleOf(body) : null,
      // REDACTED ON THE WAY IN AS WELL AS ON THE WAY OUT. A page can contain a
      // string that looks exactly like this user's key — a pasted log in an
      // issue thread, say — and it must not be reintroduced into the session
      // through the one door that reads text nobody here wrote.
      text: redact.text(cut ? text.slice(0, maxChars) : text),
      truncated: cut,
    };
  } catch (e) {
    const why = ac.signal.aborted && !(signal && signal.aborted)
      ? `no answer within ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`
      : (e && e.message) || String(e);
    return { ok: false, why: `${norm.url} — ${why}` };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ----------------------------------------------------------------- search --

/**
 * WHERE A QUERY GOES — and this was decided by measurement, not by preference.
 *
 * DuckDuckGo was the first choice, for the obvious reason. It does not work
 * here, and the way it fails is worth writing down so nobody spends the
 * afternoon rediscovering it:
 *
 *   duckduckgo.com/?q=…        loads, titles itself with the query, and never
 *                              renders a result. 32 anchors, all of them
 *                              chrome, unchanged after five seconds. The
 *                              results are drawn by script that declines to run
 *                              for a headless browser.
 *   html.duckduckgo.com/html/  "Unfortunately, bots use DuckDuckGo too."
 *   lite.duckduckgo.com/lite/  the same challenge.
 *
 * Bing serves a real results page to the same browser: ten headed results in
 * the DOM within a second and a half. So Bing it is, and the extractor below
 * stays deliberately generic — this constant is the only thing that has to
 * change if that stops being true.
 */
function searchUrl(query) {
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
}

/** The mark that says results have actually rendered, not just the page. */
const RESULT_SELECTOR = 'h2 a[href], [data-testid="result"] a[href]';

/**
 * The expression that reads a results page lives in src/searchextract.js —
 * alone, because it is the one part of this that talks to somebody else's
 * markup and will therefore break without warning one day. Its header records
 * what was measured against real pages.
 */
const { EXTRACT } = require('./searchextract');

/**
 * Search, through the Chromium LAIN owns.
 *
 * @param {object} browser  a live BrowserRuntime (see src/browser.js `live`)
 * @returns {{ok, query, url, results:[{title,url,snippet}]}} or {ok:false, why}
 */
async function search(browser, rawQuery, { limit = MAX_RESULTS } = {}) {
  const query = redact.text(String(rawQuery || '').trim());
  if (!query) return { ok: false, why: 'no query given' };
  if (!browser) {
    return {
      ok: false,
      why: 'no browser is running. Searching drives LAIN\'s own Chromium — start it with /external browser.',
    };
  }
  const url = searchUrl(query);
  const opened = await browser.open(url);
  if (!opened || opened.ok === false) {
    return { ok: false, why: `could not open the results page: ${(opened && opened.error) || 'unknown'}`, query };
  }
  // Give the results a moment to render. `wait` reports honestly when a
  // selector never arrives, and a results page that renders nothing is a real
  // answer rather than a reason to fail.
  // WAIT FOR A RESULT, NOT FOR AN ANCHOR. Waiting on `a[href]` returned
  // immediately — the page's own navigation is anchors — so the extractor ran
  // before a single result existed and came back with the site's footer links.
  // That is the difference between "the search found nothing" and "we looked
  // too early", and they must not be reported as the same thing.
  try { await browser.wait(RESULT_SELECTOR, 10000); } catch { /* the evaluate below decides */ }

  // `evaluate` rather than a raw `session.send`: the CDP result is three
  // `result`s deep and this reader got it wrong the first time, which reported
  // a page it had MISREAD as a page that could not be read. See browser.js.
  let got;
  try { got = await browser.evaluate(EXTRACT); }
  catch (e) { got = { ok: false, error: (e && e.message) || String(e) }; }
  if (!got.ok) return { ok: false, why: `the results page could not be read: ${got.error}`, query, url };
  const raw = got.value;
  if (!Array.isArray(raw)) return { ok: false, why: 'the results page returned nothing readable', query, url };

  // The engine's own domains are navigation, never a result.
  const results = raw
    .filter((x) => x && x.url && !/(?:bing|duckduckgo|microsoft|msn)\.com/i.test(x.url))
    .slice(0, Math.max(1, Math.min(MAX_RESULTS, limit)))
    .map((x) => ({
      title: redact.text(String(x.title || '').slice(0, 300)),
      url: redact.text(String(x.url || '').slice(0, 500)),
      snippet: redact.text(String(x.snippet || '').slice(0, 400)),
    }));
  // ---- DID THE ENGINE ACTUALLY ANSWER THE QUESTION? ---------------------
  //
  // THE FAILURE THIS CATCHES, and it is the reason this function is not
  // simply "scrape the page". Measured, on this machine, against Bing:
  //
  //   headless   "ERR_REQUIRE_ESM node"  ->  four Louisiana court cases
  //   headed     the same query          ->  Stack Overflow, first result
  //
  // The engine recognises an automated browser and serves it a degraded page.
  // Nothing about that page says so: it is a well-formed results list with real
  // titles and real URLs, and it parses perfectly. Passed on unchecked, a model
  // reads four unrelated articles as the answer to its question and writes
  // something confident on top of them — which is worse than no search at all,
  // because a search that fails is retried and a search that lies is believed.
  //
  // The check is deliberately weak, because a strong one would throw away good
  // results: does ANY result mention ANY significant word of the query, in its
  // title, its snippet or its URL? A real result set passes that trivially. A
  // substituted one fails it completely.
  if (results.length && !anyRelevant(query, results)) {
    return {
      ok: false,
      query,
      url,
      why: 'the search engine returned results that have nothing to do with the query, which is what it '
        + 'does when it decides it is talking to a robot. This usually means the browser is running '
        + 'headless — start it with a visible window (/external browser) and try again. '
        + 'The results were discarded rather than reported, because unrelated results that parse '
        + 'correctly are worse than none.',
    };
  }
  return { ok: true, query, url, results };
}

/** Words too common to mean anything when matching a query to a result. */
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'how', 'why', 'what', 'does', 'not',
  'from', 'this', 'that', 'when', 'where', 'error', 'you', 'your', 'can', 'are', 'was', 'has']);

/** The words of a query worth looking for in an answer. */
function keywords(query) {
  return String(query || '').toLowerCase().split(/[^a-z0-9_.]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Does any result mention any keyword? One is enough — see the caller for why
 * this is deliberately the weakest check that still catches a substituted page.
 */
function anyRelevant(query, results) {
  const words = keywords(query);
  if (!words.length) return true;
  return results.some((r) => {
    const hay = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });
}

// ---------------------------------------------------------------- telling --

/**
 * ONE LINE IN THE CONVERSATION PER LOOKUP.
 *
 * The same channel and the same register as the external consultation event:
 * what happened, in a sentence, on the actor channel the feed draws — never the
 * page's own words, which are what the tool result already carries to the
 * model. Research nobody can see is research nobody can object to.
 */
function note(app, text) {
  try {
    if (app && app.ui && app.ui.enabled) app.ui.noteActor('web', String(text).slice(0, 200));
  } catch { /* the lookup still happened; the line is a courtesy */ }
}

module.exports = {
  fetchUrl, search, note, htmlToText, mainRegion, dropNavRuns, titleOf, normalizeUrl, searchUrl,
  keywords, anyRelevant,
  MAX_CHARS, MAX_RESULTS, FETCH_TIMEOUT_MS, UA, EXTRACT, RESULT_SELECTOR,
};
