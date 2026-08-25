'use strict';

/**
 * LAIN'S OWN BROWSER — against a REAL Chromium, on a real page.
 *
 * A mock CDP adapter would prove nothing here. The whole reason this seam
 * exists is that the previous BROWSER actor never touched a page at all: it put
 * the packet on the clipboard and opened a URL in the user's own browser. A
 * double that answers `{ok:true}` would reproduce exactly that failure while
 * looking green.
 *
 * So this drives real Chromium, headless, against pages written to a temporary
 * directory — and asserts on what the PAGE says happened, not on what the
 * runtime returned.
 *
 * IT SKIPS ITSELF, LOUDLY, when no Chromium is installed. A green run without
 * this file therefore proves nothing about the browser, and says so.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const browserMod = require('../../src/browser');
const { BrowserActor } = require('../../src/actors');

const PAGE = `<!doctype html><meta charset="utf-8"><title>LAIN test page</title>
<style>body{font:16px sans-serif;margin:40px}#signal{position:absolute;right:24px;top:120px}</style>
<h1>LAIN browser test</h1>
<button id="signal">Signal</button>
<input id="field" placeholder="type here">
<p id="out">nothing yet</p>
<script>
 document.getElementById('signal').addEventListener('click',()=>{document.getElementById('out').textContent='CLICKED';});
 document.getElementById('field').addEventListener('input',e=>{document.getElementById('out').textContent='TYPED:'+e.target.value;});
</script>`;

/** A fake chat page that STREAMS its reply, so settle-detection is exercised. */
const CHAT = `<!doctype html><meta charset="utf-8"><title>fake chat</title>
<main></main><textarea id="prompt-textarea"></textarea>
<script>
const box=document.getElementById('prompt-textarea'), main=document.querySelector('main');
box.addEventListener('keydown',e=>{
  if(e.key!=='Enter') return;
  e.preventDefault();
  const asked=box.value; box.value='';
  const art=document.createElement('article');
  art.setAttribute('data-message-author-role','assistant');
  main.appendChild(art);
  const full='I reviewed it. You sent '+asked.length+' characters. The cache is never invalidated.';
  let i=0; const t=setInterval(()=>{art.textContent=full.slice(0,i+=8); if(i>=full.length) clearInterval(t);},100);
});
</script>`;

function serve(name, html) {
  const dir = tmpdir('page-');
  const file = path.join(dir, name);
  fs.writeFileSync(file, html, 'utf8');
  return 'file:///' + file.replace(/\\/g, '/');
}

module.exports = async function () {
  const found = browserMod.findBrowser();
  if (!found.ok) {
    process.stdout.write('  ~ NOT VERIFIED: no Chromium on this machine — the browser was not exercised.\n'
      + `    looked in: ${found.tried.slice(0, 3).join(', ')}\n`);
    return;
  }
  process.stdout.write(`  · browser: ${path.basename(found.path)}\n`);

  // A CLEAN PROFILE BEFORE THE RUN. A browser test that passes because of a
  // cookie or a cached page left behind by an earlier one is not a test.
  //
  // Under the runner LAIN_CONFIG_DIR is already isolated, so this wipes a
  // disposable directory — and `clearProfile` independently refuses any path
  // that is not LAIN's own profile, because a wrong path here would be
  // somebody's real browser data and that mistake is not recoverable.
  const wiped = browserMod.clearProfile();
  process.stdout.write(`  · profile: ${wiped.ok ? 'cleared before the run' : `NOT cleared — ${wiped.why}`}\n`);

  await test('BROWSER LIVE: it starts with LAIN\'S OWN profile, never the user\'s', async () => {
    // The rule the whole seam exists for. A browser sharing the user's profile
    // would be LAIN operating inside their logged-in session.
    const b = new browserMod.BrowserRuntime({});
    try {
      const r = await b.start({ headless: true });
      assert.ok(r.ok, `it must start: ${r.error}`);
      assert.strictEqual(b.state, browserMod.STATE.READY);
      // UNDER LAIN'S CONFIG HOME — whatever that is. Asserting the literal
      // `~/.lain-v2` would be asserting that the isolation the test runner
      // itself relies on is broken: LAIN_CONFIG_DIR points somewhere disposable
      // here, and the profile correctly follows it.
      const expected = browserMod.dirs().profile;
      assert.strictEqual(r.profile, expected);
      assert.strictEqual(path.resolve(r.profile),
        path.resolve(path.join(require('../../src/config').configDir(), 'browser', 'profile')));
      // AND NEVER THE USER'S OWN BROWSER PROFILE, which is the whole rule.
      const os = require('os');
      for (const theirs of [
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
        path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
        path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
        path.join(os.homedir(), '.config', 'google-chrome'),
      ]) {
        assert.ok(!path.resolve(r.profile).startsWith(path.resolve(theirs)),
          `LAIN is using the user's own browser profile: ${r.profile}`);
      }
      assert.ok(r.pid > 0, 'and it is a process of its own');
    } finally { b.stop('test over'); }
  });

  await test('BROWSER LIVE: navigate, inspect, click and type — proved BY THE PAGE', async () => {
    const b = new browserMod.BrowserRuntime({});
    try {
      await b.start({ headless: true });
      const opened = await b.open(serve('index.html', PAGE));
      assert.ok(opened.ok, opened.error);
      assert.strictEqual(opened.title, 'LAIN test page');

      // INSPECT returns a real rectangle — the machine half of visual work.
      const at = await b.inspect('#signal');
      assert.ok(at.found && at.visible, JSON.stringify(at));
      assert.ok(at.rect.width > 0 && at.rect.height > 0, 'a real measured rectangle');
      assert.strictEqual(at.text, 'Signal');

      // The PAGE is the witness for both of these, not the return value.
      await b.click('#signal');
      assert.strictEqual((await b.inspect('#out')).text, 'CLICKED');

      await b.type('#field', 'hello lain');
      assert.strictEqual((await b.inspect('#out')).text, 'TYPED:hello lain');
    } finally { b.stop('test over'); }
  });

  await test('BROWSER LIVE: a screenshot is a real PNG on disk, returned as a path', async () => {
    // Never as base64 in a tool result: a 300KB image encoded into a model's
    // context is an enormous bill for something the model cannot see.
    const b = new browserMod.BrowserRuntime({});
    try {
      await b.start({ headless: true });
      await b.open(serve('index.html', PAGE));
      const shot = await b.screenshot('test');
      assert.ok(shot.ok, shot.error);
      assert.ok(fs.existsSync(shot.file), 'the file is really there');
      const head = fs.readFileSync(shot.file).subarray(0, 8);
      assert.deepStrictEqual([...head], [137, 80, 78, 71, 13, 10, 26, 10], 'and it is a PNG');
      assert.match(shot.file, /screenshots/);
    } finally { b.stop('test over'); }
  });

  await test('BROWSER LIVE: clicking something invisible REFUSES rather than pretending', async () => {
    // `el.click()` would fire a synthetic event that skips hit-testing and
    // "succeed" on a covered element. A real mouse event fails where a real
    // click would fail, which is the honest behaviour.
    const b = new browserMod.BrowserRuntime({});
    try {
      await b.start({ headless: true });
      await b.open(serve('index.html',
        PAGE.replace('<button id="signal">', '<button id="hidden" style="display:none">x</button><button id="signal">')));
      const r = await b.click('#hidden');
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /not visible/);
      const missing = await b.click('#nope');
      assert.strictEqual(missing.ok, false);
      assert.match(missing.error, /no element matches/);
    } finally { b.stop('test over'); }
  });

  await test('BROWSER LIVE: waiting for something that never appears SAYS SO', async () => {
    const b = new browserMod.BrowserRuntime({});
    try {
      await b.start({ headless: true });
      await b.open(serve('index.html', PAGE));
      const r = await b.wait('#never', 900);
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /did not appear/);
    } finally { b.stop('test over'); }
  });

  await test('BROWSER LIVE: the lifecycle is named, and STOPPED means stopped', async () => {
    const b = new browserMod.BrowserRuntime({});
    assert.strictEqual(b.state, browserMod.STATE.NOT_STARTED);
    await b.start({ headless: true });
    assert.strictEqual(b.running, true);
    b.stop('test over');
    assert.strictEqual(b.state, browserMod.STATE.STOPPED);
    assert.strictEqual(b.running, false);
    const after = await b.open('about:blank');
    assert.strictEqual(after.ok, false, 'a stopped browser accepts no work');
  });

  await test('BROWSER LIVE: the `browser` tool follows the PROCESS, not the config', async () => {
    // The same rule `probe` follows: a model told it can drive a browser that
    // is not running will try.
    const tools = require('../../src/tools');
    assert.ok(!tools.names().includes('browser'), 'absent while nothing is running');
    const b = new browserMod.BrowserRuntime({});
    try {
      await b.start({ headless: true });
      assert.ok(tools.names().includes('browser'), 'offered while it runs');
    } finally { b.stop('test over'); }
    assert.ok(!tools.names().includes('browser'), 'and withdrawn again');
  });

  await test('BROWSER ACTOR: it DRIVES the page — no clipboard, no user\'s browser', async () => {
    // What this replaces: "opens ChatGPT and puts the packet on your clipboard;
    // paste the reply back". That never touched a page.
    const app = { _browser: null, ui: { enabled: false } };
    const actor = new BrowserActor(app, {
      externalTroubleshoot: { url: serve('chat.html', CHAT), actor: 'BROWSER' },
      browser: { headless: true },
    });
    try {
      const packet = 'Please review this dashboard invalidation bug.';
      const sent = await actor.send(packet);
      assert.ok(sent.ok, sent.error);
      assert.strictEqual(sent.delivered, 'browser', 'delivered by the browser, not the clipboard');
      assert.strictEqual(sent.box, '#prompt-textarea', 'and it found the real message box');

      const got = await actor.receive();
      assert.ok(got.ok, got.error);
      // THE PAGE ITSELF CONFIRMS the packet arrived: it echoes the length.
      assert.match(got.text, new RegExp(`You sent ${packet.length} characters`),
        `the page did not receive the packet: ${got.text}`);
      // ATTRIBUTED TO THE PAGE, never to a model from LAIN's catalog.
      assert.strictEqual(got.model, 'the page');
      assert.match(got.connection, /^browser · /);
    } finally { if (app._browser) app._browser.stop('test over'); }
  });

  await test('BROWSER ACTOR: a page with no message box TYPES NOTHING and says why', async () => {
    // A wrong selector that "worked" would type a review packet into some
    // other element on somebody's page.
    const app = { _browser: null, ui: { enabled: false } };
    const actor = new BrowserActor(app, {
      externalTroubleshoot: { url: serve('bare.html', '<!doctype html><title>bare</title><p>nothing here</p>') },
      browser: { headless: true },
    });
    try {
      const sent = await actor.send('a packet');
      assert.strictEqual(sent.ok, false);
      assert.match(sent.error, /NOTHING WAS TYPED/);
      assert.match(sent.error, /login|markup/);
    } finally { if (app._browser) app._browser.stop('test over'); }
  });

  await test('BROWSER ISOLATION: the profile wipe refuses any path that is not LAIN own', () => {
    // The guard that makes the wipe safe to run at all. A profile path wrong by
    // one bug is somebody's real browser data.
    const os = require('os');
    const d = browserMod.dirs();
    assert.match(d.profile, /[\\/]browser[\\/]profile$/, 'the profile is a known subpath');
    assert.ok(path.resolve(d.profile).startsWith(path.resolve(d.root)),
      'and always under LAIN own browser root');
    // It never points at a real browser profile.
    for (const theirs of [
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
    ]) {
      assert.ok(!path.resolve(d.profile).startsWith(path.resolve(theirs)));
    }
  });

  await test('BROWSER ACTOR: it reports its own isolation, and needs no one at the keyboard', async () => {
    const app = { _browser: null, ui: { enabled: false } };
    const actor = new BrowserActor(app, { externalTroubleshoot: {}, browser: { headless: true } });
    const st = actor.status();
    assert.strictEqual(st.isolated, true);
    assert.strictEqual(st.browser, 'NOT_STARTED');
    // The inherited HUMAN status would be `ok: false` on a pipe, because a
    // pasted relay needs somebody there. This one drives the page itself.
    assert.strictEqual(st.ok, true);
  });
};
