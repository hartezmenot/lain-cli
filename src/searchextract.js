'use strict';

/**
 * THE EXPRESSION THAT RUNS INSIDE A SEARCH RESULTS PAGE.
 *
 * Alone in its own file because it is the one genuinely BRITTLE thing in the
 * research path — everything else here talks to a socket or to a protocol, and
 * this talks to somebody else's markup, which changes without telling anyone.
 * Isolating it means the day it breaks there is exactly one file to read, and
 * the header below already says what was true when it was written.
 *
 * ------------------------------------------------------------------------
 * WHAT WAS MEASURED, on a real headless Chromium against real pages:
 *
 *   DuckDuckGo renders NO results at all for a headless browser. The page
 *   loads, titles itself with the query, and produces thirty-two anchors of
 *   pure navigation, unchanged after five seconds. Its `html.` and `lite.`
 *   endpoints answer with a bot challenge instead. So it is not usable here,
 *   and the first version of this returned DuckDuckGo's own footer links —
 *   three results, all of them links to DuckDuckGo's mobile apps.
 *
 *   Bing renders ten results within a second and a half, and two things about
 *   them break a naive extractor:
 *
 *     EVERY RESULT LINK IS A REDIRECT. `bing.com/ck/a?…&u=a1<base64url>`, so a
 *     same-host filter deletes every result, and a URL that survives the filter
 *     is still useless to the model. The real destination is base64url inside
 *     `u`, after a two-character `a1` prefix.
 *
 *     `innerText` IS EMPTY. It is defined in terms of RENDERED text, and a
 *     headless browser with no layout pass has none. `textContent` is the
 *     property that answers. This cost an extraction that returned six results
 *     with six empty titles.
 *
 * ------------------------------------------------------------------------
 * AND THE MOST IMPORTANT MEASUREMENT OF ALL, which is not about markup:
 *
 *   headless   "ERR_REQUIRE_ESM node"  ->  four Louisiana court cases
 *   headed     the same query          ->  Stack Overflow, first result
 *
 * Bing recognises an automated browser and serves it a DIFFERENT, unrelated
 * results page. It is well-formed, it has real titles and real URLs, and it
 * parses perfectly — there is nothing in the markup that says the answer is
 * wrong. So no amount of care in this file can detect it; research.js checks
 * whether the results have anything to do with the query, and that is the only
 * thing standing between a model and four articles about a wrongful conviction
 * presented as the answer to a Node.js question.
 *
 * ------------------------------------------------------------------------
 * THE ORDER OF PREFERENCE for a result's URL, and it is a fallback chain
 * because each step can fail on a page nobody has seen yet:
 *
 *   1. the anchor's own href, when it points somewhere off this site
 *   2. the engine's redirect, decoded
 *   3. the visible citation, which is what the page SHOWS as the destination
 *
 * A result with no usable URL is dropped rather than guessed at. A search
 * result the model cannot open is not a result.
 */

/** Containers a results page is likely to use, most specific first. */
const CONTAINERS = [
  'li.b_algo',
  '[data-testid="result"]',
  'ol#b_results > li',
  'div.g',
  'article',
];

/**
 * The expression, as a string, evaluated in the page.
 *
 * Written as joined lines rather than a template literal so that nothing in it
 * depends on this file's own escaping — a backslash lost between here and the
 * browser is a silent behaviour change, and this project has been bitten by
 * exactly that more than once.
 *
 * AND FOR THE SAME REASON THERE IS NOT ONE REGEX IN IT. Every backslash here has
 * to survive being written in this file, read by Node, and parsed again by a
 * different engine inside the page — so a whitespace class has to be spelled
 * with TWO backslashes in this source, which reads exactly like the corruption
 * the architecture guard exists to catch. It caught this one. Rather than teach
 * the guard an exception, since every exception is a place the next real
 * corruption can hide, the expression asks its questions without regexes:
 * `indexOf` for prefixes, `split`/`join` for replacement, and an explicit
 * character list for whitespace. Two lines longer, and it cannot be silently
 * broken.
 */
const EXTRACT = [
  '(function () {',
  '  var strip = function (h) { return h.indexOf("www.") === 0 ? h.slice(4) : h; };',
  '  var here = strip(location.hostname);',
  '  var containers = ' + JSON.stringify(CONTAINERS) + ';',
  // An explicit character list rather than a whitespace class — see the header.
  '  var WS = [" ", String.fromCharCode(9), String.fromCharCode(10), String.fromCharCode(13), String.fromCharCode(160)];',
  '  var text = function (el) {',
  '    var t = el ? String(el.textContent || "") : "";',
  '    for (var w = 0; w < WS.length; w++) { t = t.split(WS[w]).join(" "); }',
  '    return t.split(" ").filter(function (x) { return x.length; }).join(" ");',
  '  };',
  // The engine's own redirect, unwrapped. `a1` is Bing's marker for a
  // base64url payload; anything else is left alone rather than mangled.
  '  var unwrap = function (href) {',
  '    try {',
  '      var u = new URL(href, location.href);',
  '      var p = u.searchParams.get("u") || u.searchParams.get("url") || u.searchParams.get("q");',
  '      if (!p) return null;',
  '      if (p.slice(0, 2) === "a1") {',
  '        return atob(p.slice(2).split("-").join("+").split("_").join("/"));',
  '      }',
  '      if (p.indexOf("http") === 0) return p;',
  '      return null;',
  '    } catch (e) { return null; }',
  '  };',
  '  var offsite = function (raw) {',
  '    try {',
  '      var u = new URL(raw, location.href);',
  '      if (u.protocol !== "http:" && u.protocol !== "https:") return null;',
  '      var h = strip(u.hostname);',
  '      if (h === here || h.indexOf("." + here) === h.length - here.length - 1) return null;',
  '      return u.toString();',
  '    } catch (e) { return null; }',
  '  };',
  '  var blocks = [];',
  '  for (var i = 0; i < containers.length && !blocks.length; i++) {',
  '    blocks = Array.prototype.slice.call(document.querySelectorAll(containers[i]));',
  '  }',
  // NO CONTAINER MATCHED — an engine this file has never seen. Fall back to
  // every heading anchor on the page, which is the shape a results list has
  // whatever it calls its wrapper.
  '  if (!blocks.length) {',
  '    blocks = Array.prototype.slice.call(document.querySelectorAll("h2, h3")).map(function (h) {',
  '      return h.parentElement || h;',
  '    });',
  '  }',
  '  var seen = {};',
  '  var out = [];',
  '  for (var j = 0; j < blocks.length && out.length < 40; j++) {',
  '    var block = blocks[j];',
  // ---- IN ORDER, NOT AS ONE COMMA LIST -------------------------------
  //
  // `querySelector("h2 a, a")` returns the first element in DOCUMENT order
  // matching ANY of the selectors — not the first selector's match. Bing puts
  // its breadcrumb link ABOVE the heading inside each result, so the comma
  // form picked the citation every time and every title came back reading
  // "nodejs.orghttps://nodejs.org". Asking in order is the fix.
  '    var a = null;',
  '    var picks = ["h2 a[href]", "h3 a[href]", "a[href]"];',
  '    for (var p = 0; p < picks.length && !a; p++) { a = block.querySelector(picks[p]); }',
  '    if (!a) continue;',
  '    var href = a.getAttribute("href") || "";',
  '    var url = offsite(href);',
  '    if (!url) { var d = unwrap(href); url = d ? offsite(d) || d : null; }',
  '    if (!url) {',
  '      var c = text(block.querySelector("cite"));',
  '      if (c.indexOf("http://") === 0 || c.indexOf("https://") === 0) { url = c.split(" ")[0]; }',
  '    }',
  '    if (!url) continue;',
  '    var key = url.split("#")[0];',
  '    if (seen[key]) continue;',
  '    seen[key] = 1;',
  // textContent, NOT innerText — see the header.
  '    var title = text(a);',
  '    if (title.length < 3) continue;',
  '    var snippet = text(block);',
  '    if (snippet.indexOf(title) === 0) snippet = snippet.slice(title.length).trim();',
  '    out.push({ title: title.slice(0, 300), url: url.slice(0, 500), snippet: snippet.slice(0, 400) });',
  '  }',
  '  return out;',
  '})()',
].join('\n');

module.exports = { EXTRACT, CONTAINERS };
