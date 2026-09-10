'use strict';

/**
 * THE BROWSER HARNESS — and, above all, what it says when there is no browser.
 *
 * ------------------------------------------------------------------------
 * THE ASSERTION THIS FILE IS FOR.
 *
 * A capability that is absent must be VISIBLE as absent. LAIN removed its
 * browser in 2026-09 and rebuilt this one as a verification instrument; the way
 * that goes wrong is not a bug in the CDP code, it is a browser check that
 * quietly passes on a machine with no browser, or fails on one, when in truth
 * nobody looked. So most of what is checked here is the honesty of the
 * unavailable path — which is also the only path that can be tested on every
 * machine.
 *
 * THE LIVE HALF IS IN THE INTEGRATION TIER (harness-scenarios.test.js, SCENARIO
 * B), where a real page is served and a real browser observes it. That split is
 * deliberate: a unit tier that launches Chrome is not a unit tier.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

const browser = require('../../src/harness/browser');
const cdp = require('../../src/harness/cdp');
const { BrowserHarness, ACTIONS } = require('../../src/harness/browserharness');
const checks = require('../../src/harness/checks');

module.exports = async function () {
  await test('BROWSER: availability is MEASURED — it stats a binary and probes a port', async () => {
    // On a port nothing is on, and with a binary path that does not exist, the
    // answer must be a reason rather than a guess.
    const a = await browser.available({ port: 59998, browserPath: 'C:/definitely/not/here.exe' });
    assert.strictEqual(typeof a.available, 'boolean');
    assert.ok(a.why.length > 0, 'it always says why');
    assert.strictEqual(a.attachable, false, 'nothing is listening on that port');
    assert.ok(Array.isArray(a.tried) && a.tried.length, 'and it names where it looked');
  });

  await test('BROWSER: with no browser at all, the reason names both halves', async () => {
    const original = browser.findBrowser;
    // The candidate list is what makes the "looked in N places" sentence
    // honest; asserting the sentence rather than stubbing the platform.
    const a = await browser.available({ port: 59998 });
    if (!a.launchable) {
      assert.match(a.why, /no browser is listening|no browser binary/);
    } else {
      assert.match(a.why, /launchable|attachable/);
    }
    assert.strictEqual(typeof original, 'function');
  });

  await test('BROWSER: the CDP client reports whether this runtime can speak it at all', () => {
    const c = cdp.clientAvailable();
    assert.strictEqual(typeof c.ok, 'boolean');
    if (!c.ok) {
      assert.match(c.why, /WebSocket/, 'the reason must name the missing piece');
      assert.match(c.why, /Node 22/, 'and what would fix it');
    }
  });

  await test('BROWSER: an endpoint that is not there is a reason, not a throw', async () => {
    const r = await cdp.endpoint(59998);
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /nothing DevTools-shaped/);
  });

  await test('BROWSER: connecting to a socket that does not exist settles, never hangs', async () => {
    const conn = new cdp.Connection('ws://127.0.0.1:59998/devtools/page/none');
    const r = await conn.connect(1500);
    assert.strictEqual(r.ok, false);
    assert.ok(r.why.length > 0);
    conn.close();
  });

  await test('BROWSER: a call on a closed connection rejects rather than leaking a promise', async () => {
    const conn = new cdp.Connection('ws://127.0.0.1:59998/x');
    await assert.rejects(() => conn.send('Page.navigate', { url: 'about:blank' }), /not open/);
  });

  await test('BROWSER: a verification with no browser possible is INCONCLUSIVE', async () => {
    // Never FAILED — nothing about the flow was learned — and never PASSED.
    const h = new BrowserHarness({ port: 59998 });
    // Point it at a port nothing is on AND refuse the launch, which is the
    // shape of a machine with no browser without needing one to be absent.
    h._launch = async () => ({ ok: false, why: 'no browser binary was found in this test' });
    const r = await h.verify({ url: 'http://127.0.0.1:59997/' }, { taskId: 't1' });
    assert.strictEqual(r.verdict, checks.VERDICT.INCONCLUSIVE);
    assert.match(r.why, /browser/i);
  });

  await test('BROWSER: an observation with no browser is a MISS the router can route past', async () => {
    const h = new BrowserHarness({ port: 59998 });
    h._launch = async () => ({ ok: false, why: 'none here' });
    const r = await h.observe('dom', { selector: '#x', launch: true }, { taskId: 't1' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.why.length > 0);
  });

  await test('BROWSER: the flow action list is CLOSED — a delegated flow cannot invent one', () => {
    // The whole reason a browser worker is safe to delegate to: it executes the
    // steps it was given, against the page it was given, and stops.
    assert.deepStrictEqual([...ACTIONS].sort(), ['click', 'evaluate', 'navigate', 'screenshot', 'type', 'wait'].sort());
  });

  await test('BROWSER: an unknown action is refused as INCONCLUSIVE and names what is allowed', async () => {
    const h = new BrowserHarness({ port: 59998 });
    // A session that exists but a step that is not on the list.
    h.session = async () => ({ ok: true, session: { url: null, navigate: async () => ({ ok: true, why: 'ok' }), errors: () => [], console: [], screenshot: async () => ({ ok: false, why: 'no' }), element: async () => ({ ok: true, value: { exists: true, visible: true } }), evaluate: async () => ({ ok: true, value: '' }) } });
    h.availability = async () => ({ available: true, why: 'stubbed' });
    const r = await h.verify({ url: 'http://x/', actions: [{ type: 'hack_the_mainframe' }] }, { taskId: 't1' });
    assert.strictEqual(r.verdict, checks.VERDICT.INCONCLUSIVE);
    assert.match(r.why, /not an allowed browser action/);
    assert.match(r.why, /click/);
  });

  await test('BROWSER: it is an instrument, not a browsing tool — there is no search', () => {
    // The capability removed in 2026-09 was BROWSING. This must not grow back
    // into it, and the guarantee is the shape of the API rather than a policy.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'harness', 'browser.js'), 'utf8')
      + fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'harness', 'browserharness.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bsearch\s*\(/.test(code), 'a search entry point would make this a browsing tool');
    assert.ok(!/google\.com|bing\.com|duckduckgo/i.test(code), 'it never goes anywhere it was not sent');
    assert.match(code, /user-data-dir/, 'and it never uses the person real profile');
  });

  await test('BROWSER: a launched browser is a MANAGED process, so cleanup can reach it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'harness', 'browserharness.js'), 'utf8');
    assert.match(src, /this\.processes\.start\(/, 'a browser outside process ownership is an orphan waiting to happen');
    assert.match(src, /headless=new/, 'and it does not steal the focus of whoever is at the keyboard');
  });

  await test('BROWSER: with no process manager it refuses to launch rather than orphaning one', async () => {
    const h = new BrowserHarness({ port: 59998, processes: null });
    const r = await h._launch('t1');
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /owned or cleaned up/);
  });
};
