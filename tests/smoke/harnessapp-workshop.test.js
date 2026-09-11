'use strict';

/**
 * THE FRONTEND WORKSHOP, DRIVEN THROUGH THE HARNESS APPLICATION.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT A WORKSHOP UNIT TEST.
 *
 * `src/workshop` could be exercised directly, and that would prove the module.
 * It would not prove the PRODUCT: that a person opening the application can
 * start a dev server, see the page, select an element, capture a before, change
 * the source, verify three viewports and get evidence — without touching a
 * terminal.
 *
 * So everything below goes over the application's own HTTP API, exactly as the
 * page does. A real dev server, a real Chromium, a real screenshot, a real
 * artifact on disk.
 *
 * ------------------------------------------------------------------------
 * THE FIXTURE IS BUILT HERE AND IS DELIBERATELY BROKEN.
 *
 * A page with a left-aligned button that should be centred. Not an external
 * site — a real project with a `package.json`, a dev script that declares its
 * port, and a stylesheet this test edits mid-run. That is what makes the
 * before/after measurable: the button's x moves, and the number is the proof.
 *
 * ------------------------------------------------------------------------
 * IT SKIPS ITSELF WHEN THERE IS NO BROWSER, and says so. A machine without
 * Chromium cannot prove this, and a test that quietly passed there would be
 * reporting a capability nobody has.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');

/** A real, minimal frontend project whose button is in the wrong place. */
function fixture() {
  const dir = tmpdir('wsproj-');
  const port = 4600 + Math.floor(Math.random() * 300);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'wsfixture', private: true, scripts: { dev: `node server.js --port ${port}` },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'server.js'),
    'const http=require("http"),fs=require("fs"),path=require("path");\n'
    // THE PORT COMES FROM THE ENVIRONMENT `ensure` SETS, and that is the point.
    // A first attempt parsed argv with `argv.find(a=>/^--port/)` and then split
    // it — but `--port` and its value are SEPARATE argv entries, so the parse
    // always yielded NaN and the server silently listened on its fallback while
    // the harness waited on the declared port. The fixture was wrong, not the
    // Workshop; devserver.ensure forces PORT, so reading it is exact.
    + 'const a=process.argv.indexOf("--port");\n'
    + 'const port=Number(process.env.PORT)||Number(a>0?process.argv[a+1]:0)||0;\n'
    + 'http.createServer((q,s)=>{const f=q.url==="/"?"index.html":q.url.replace(/^\\//,"").split("?")[0];\n'
    + 'const p=path.join(__dirname,f);if(!fs.existsSync(p)){s.writeHead(404);return s.end("no");}\n'
    + 's.writeHead(200,{"content-type":f.endsWith(".css")?"text/css":"text/html"});s.end(fs.readFileSync(p));\n'
    + '}).listen(port,"127.0.0.1");\n');
  fs.writeFileSync(path.join(dir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Checkout</title>'
    + '<link rel="stylesheet" href="checkout.css"></head><body><main class="page">'
    + '<h1>Checkout</h1><div class="row"><button id="pay" class="pay">Pay now</button></div>'
    + '</main></body></html>\n');
  fs.writeFileSync(path.join(dir, 'checkout.css'),
    'body{margin:0;font-family:system-ui;background:#fff;color:#111}\n'
    + '.page{padding:24px}\n'
    + '.row{display:block;margin-top:20px}\n'
    + '.pay{padding:10px 18px;background:#2b6cb0;color:#fff;border:0;border-radius:6px;font-size:16px}\n');
  return dir;
}

function req(port, method, p, body, session) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: p, method, timeout: 240000,
      headers: Object.assign({},
        data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
        session ? { 'x-lain-session': session } : {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* raw */ } resolve({ code: res.statusCode, json: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ code: 0, json: null, raw: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}

module.exports = async function () {
  await test('WORKSHOP LIVE: open, inspect, edit, verify and evidence — through the application', async () => {
    const browser = require(path.join(ROOT, 'src', 'harness', 'browser'));
    const found = browser.findBrowser();
    if (!found.ok) {
      // SAID OUT LOUD. A silent skip here would let a green run imply the
      // Workshop was proved on a machine that cannot run it.
      process.stdout.write('    (skipped: no Chromium-family browser on this machine)\n');
      return;
    }

    const proj = fixture();
    const { App } = require(path.join(ROOT, 'src', 'app'));
    const server = require(path.join(ROOT, 'src', 'harnessapp', 'server'));
    const app = new App({
      out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false },
      interactive: false, cwd: proj,
    });
    // A REAL TASK, so captures are filed as Harness artifacts rather than
    // existing only as data in a reply.
    const H = require(path.join(ROOT, 'src', 'harnesslink')).harnessFor(app);
    H.begin({ title: 'centre the pay button', objective: 'centre the pay button and verify mobile' });

    const s = await server.start(app, { port: 0 });
    assert.ok(s.ok, `the application did not start: ${s.why}`);
    const P = s.port;
    try {
      const tok = (await req(P, 'POST', '/api/login', { password: s.startupPassword })).json.session;
      assert.ok(tok, 'the startup password must grant a session');

      // ---- OPEN: dev server + project-bound preview browser ---------------
      const open = await req(P, 'POST', '/api/workshop/open', {}, tok);
      assert.ok(open.json && open.json.ok, `workshop open failed: ${open.json && open.json.why}`);
      assert.match(String(open.json.url), /^http:\/\/127\.0\.0\.1:\d+/, 'it previews the local dev server');

      // ---- BEFORE, filed as a Harness artifact ---------------------------
      const before = await req(P, 'POST', '/api/workshop/capture', { as: 'before' }, tok);
      assert.ok(before.json.ok && before.json.shot.bytes > 0, 'a before screenshot was captured');
      assert.ok(before.json.shot.path, 'and filed as an artifact on disk');
      assert.ok(fs.existsSync(before.json.shot.path), 'the artifact really exists');

      // ---- DOM AND ACCESSIBILITY -----------------------------------------
      const el1 = await req(P, 'POST', '/api/workshop/element', { selector: '#pay' }, tok);
      assert.ok(el1.json.ok, `element inspection failed: ${el1.json && el1.json.why}`);
      const e1 = el1.json.element;
      assert.strictEqual(e1.tag, 'button');
      assert.strictEqual(e1.name, 'Pay now');
      assert.ok(e1.rect.w > 0 && e1.rect.h > 0, 'it has a real box');
      const xBefore = e1.rect.x;

      const ax = await req(P, 'POST', '/api/workshop/ax', { selector: '#pay' }, tok);
      assert.ok(ax.json.ok, 'the accessibility tree is readable');
      assert.ok((ax.json.nodes || []).some((n) => n.role === 'button' && /Pay now/.test(n.name || '')),
        'and it reports the control a person would actually be told about');

      // ---- THE FIX, on real source ---------------------------------------
      const css = path.join(proj, 'checkout.css');
      fs.writeFileSync(css, fs.readFileSync(css, 'utf8')
        .replace('.row{display:block;margin-top:20px}',
          '.row{display:flex;justify-content:center;align-items:center;margin-top:20px}'));
      const reload = await req(P, 'POST', '/api/workshop/reload', {}, tok);
      assert.ok(reload.json.ok, 'the preview reloads the changed source');

      // ---- THE PROOF IS A NUMBER, not a screenshot somebody looked at -----
      const el2 = await req(P, 'POST', '/api/workshop/element', { selector: '#pay' }, tok);
      const e2 = el2.json.element;
      assert.ok(e2.rect.x > xBefore + 50,
        `the button did not move: x was ${xBefore}, is ${e2.rect.x}`);
      assert.strictEqual(e2.parent.justify, 'center', 'and its parent now centres it');

      // ---- AFTER, paired with the before ---------------------------------
      const after = await req(P, 'POST', '/api/workshop/capture', { as: 'after' }, tok);
      assert.ok(after.json.ok && after.json.before, 'the after is paired with the before');

      // ---- RESPONSIVE VERIFICATION, three viewports ----------------------
      const v = await req(P, 'POST', '/api/workshop/verify', { viewports: ['desktop', 'tablet', 'mobile'] }, tok);
      assert.ok(v.json.ok, `verification did not pass: ${JSON.stringify(v.json.results || v.json.why)}`);
      const seen = (v.json.results || []).map((r) => r.viewport);
      assert.deepStrictEqual(seen, ['desktop', 'tablet', 'mobile'], 'every viewport was actually visited');
      for (const r of v.json.results) {
        assert.ok(r.width > 0, `${r.viewport} was applied at a real width`);
        assert.deepStrictEqual(
          r.checks.map((c) => c.name).sort(),
          ['no console errors', 'no failed requests', 'no horizontal overflow'],
          'the named checks are the ones that ran',
        );
      }
      // AND IT SAYS WHAT IT IS. Evidence, not a verdict about the task.
      assert.match(String(v.json.note || ''), /settled by the harness, not here/i);

      // ---- THE APPLICATION'S OWN VIEW OF ALL THIS ------------------------
      const st = await req(P, 'GET', '/api/state', undefined, tok);
      const W = st.json.state.workshop;
      assert.strictEqual(W.open, true);
      assert.ok(W.observations && W.observations.console, 'console is reported as a summary');
      assert.strictEqual(W.observations.console.errors, 0, 'the fixture page is clean');
      assert.ok(W.observations.network.total > 0, 'and its requests were observed');

      await req(P, 'POST', '/api/workshop/close', {}, tok);
    } finally {
      server.stop();
      await require(path.join(ROOT, 'src', 'harnesslink')).shutdown(app);
    }
  });
};
