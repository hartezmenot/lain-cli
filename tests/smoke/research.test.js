'use strict';

/**
 * LOOKING SOMETHING UP, THROUGH THE REAL BINARY.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS PROVES THAT A UNIT TEST CANNOT. tests/unit/research.test.js calls
 * the functions; this proves the whole chain exists — that the tool is in the
 * registry the model is actually offered, that a call reaches it, that the page
 * comes back through the tool boundary into `session.messages` where the model
 * can read it, and that the lookup is DRAWN in the conversation where a person
 * can see that their machine talked to a stranger on their behalf.
 *
 * ------------------------------------------------------------------------
 * HERMETIC ON PURPOSE. The page is served by a local HTTP server this file
 * starts, so the tier stays runnable offline, in CI, and on a machine behind a
 * proxy — and so that what the page CONTAINS is a fixed thing the assertions
 * can be exact about. Reaching the real internet from a test suite makes it
 * fail for reasons that have nothing to do with the code.
 *
 * The network path itself — a real fetch of a real documentation site — was
 * verified live by hand and is recorded in src/research.js. (A search through
 * a real Chromium was once recorded alongside it, in src/searchextract.js;
 * that actor went with the browser in 2026-09, and web search went with it —
 * what remains is plain fetching, which this tier asserts end to end.) It is
 * deliberately not asserted here.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes } = require('../helpers');

const NL = String.fromCharCode(10);
const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * A page shaped like the ones this feature exists for: a real answer buried
 * under a navigation sidebar, with a script tag that must not survive.
 */
function pageHtml() {
  const nav = Array.from({ length: 40 }, (_, i) => `<li><a href="/s${i}">Section ${i}</a></li>`).join('');
  return '<!doctype html><html><head><title>Widget API</title>'
    + '<style>.x{color:red}</style></head><body>'
    + '<script>var TRACKING_PIXEL = "must-not-appear";</script>'
    + `<ul>${nav}</ul>`
    + '<h1>Widget API</h1>'
    + '<p>The widget.render() method takes an options object.</p>'
    + '<p>Since version 4.2 the legacy callback argument is removed.</p>'
    + '</body></html>';
}

/** A server that serves that page, and a JSON endpoint, and a PDF. */
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api.json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: '4.2.0', deprecated: ['callback'] }));
        return;
      }
      if (req.url.startsWith('/manual.pdf')) {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end('%PDF-1.7 binary noise');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageHtml());
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

module.exports = async function () {
  await test('RESEARCH LIVE: the model reads a page, and the answer reaches it', async () => {
    const srv = await serve();
    try {
      const cwd = tmpdir('research-');
      const configDir = path.join(cwd, 'cfg');
      const r = await runCli([], {
        cwd, configDir,
        env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '40' },
        stdinSteps: ['does the widget API still take a callback?\n', '/exit\n'],
        stepDelayMs: 7000,
        script: [
          {
            text: 'Checking the current documentation.',
            tool_calls: [{ name: 'web_fetch', input: { url: `${srv.base}/widget.html` } }],
          },
          {
            text: 'Issue\nThe callback argument was removed in 4.2.\n\nVerified\n'
              + '- the published documentation says so directly',
          },
        ],
        timeoutMs: 90000,
      });
      assert.strictEqual(r.code, 0);

      const dir = path.join(configDir, 'sessions');
      const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).pop();
      const session = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

      // ---- THE PAGE REALLY REACHED THE MODEL ---------------------------
      const tool = session.messages.find((m) => m.role === 'tool');
      assert.ok(tool, 'the tool must have run and reported back');
      assertIncludes(tool.content, 'Since version 4.2 the legacy callback argument is removed',
        'the sentence that answers the question must reach the model');
      assertIncludes(tool.content, 'title: Widget API');

      // ---- AND THE PARTS THAT ARE NOT THE PAGE DID NOT ------------------
      assertNotIncludes(tool.content, 'TRACKING_PIXEL',
        'a stripped script tag must not leave its source in the model\'s context');
      assertNotIncludes(tool.content, 'color:red', 'nor a style its rules');
      assertIncludes(tool.content, '[40 navigation links omitted]',
        'the sidebar must be collapsed, and must SAY it was collapsed');
      assertNotIncludes(tool.content, 'Section 37',
        'forty links of chrome are what push the answer out of the window');

      // ---- THE PERSON CAN SEE THAT THEIR MACHINE TALKED TO A STRANGER ---
      const web = (session.actors || []).filter((a) => a.kind === 'web');
      assert.strictEqual(web.length, 1, `exactly one lookup, announced once: ${JSON.stringify(session.actors)}`);
      assertIncludes(web[0].text, 'Widget API', 'and it says what was read');

      const frame = String(r.out).split('\x1b[?25l').pop() || '';
      // ANY COLUMN: the content frame moved every region off column 1.
      const rows = frame.split(/\x1b\[\d+;\d+H/).slice(1).map(plain).map((x) => x.replace(/\s+$/, ''));
      const feed = rows.join(NL);
      assertIncludes(feed, 'Widget API', 'the lookup must be drawn in the conversation');
      // AND IT MUST NOT READ AS SOMETHING THE MODEL SAID. An actor line drawn
      // with `pushModel` gets no label and no indent — indistinguishable from
      // the assistant's own prose, which is how "read · Widget API" ended up
      // looking like a sentence LAIN had written.
      assertIncludes(feed, 'NOTE', 'a lookup is the PROGRAM speaking, and is labelled as such');
      // The action row names what was fetched, not the tool that fetched it.
      assertIncludes(feed, '127.0.0.1', 'the row says what was looked up');
    } finally {
      srv.server.close();
    }
  });

  await test('RESEARCH LIVE: something that is not text is refused before it is decoded', async () => {
    const srv = await serve();
    try {
      const cwd = tmpdir('research-');
      const configDir = path.join(cwd, 'cfg');
      const r = await runCli([], {
        cwd, configDir,
        env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '40' },
        stdinSteps: ['read the manual\n', '/exit\n'],
        stepDelayMs: 6000,
        script: [
          { text: 'Fetching it.', tool_calls: [{ name: 'web_fetch', input: { url: `${srv.base}/manual.pdf` } }] },
          { text: 'That is a PDF and cannot be read as text.' },
        ],
        timeoutMs: 90000,
      });
      assert.strictEqual(r.code, 0);
      const dir = path.join(configDir, 'sessions');
      const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).pop();
      const session = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const tool = session.messages.find((m) => m.role === 'tool');
      assert.ok(tool, 'the refusal must still come back through the tool boundary');
      assertIncludes(tool.content, 'not readable as text');
      assertIncludes(tool.content, 'run_bash', 'and the tool that CAN get the bytes must be named');
      assertNotIncludes(tool.content, 'binary noise', 'the bytes themselves must not be decoded into the context');
    } finally {
      srv.server.close();
    }
  });
};
