'use strict';

/**
 * THE WEB MODEL BROWSER — one authenticated page per source, kept alive.
 *
 * ------------------------------------------------------------------------
 * IT REUSES THE HARNESS'S WIRE AND NONE OF ITS POLICY.
 *
 * `harness/cdp.js` is the DevTools transport and `harness/browser.js` is one
 * page and what can be asked of it. Both are neutral, both are already proven,
 * and re-implementing either here would be a second browser truth in a tree
 * whose whole architecture is built on there being one of each thing.
 *
 * What is NOT reused is `harness/browserharness.js`: that owns headless launch
 * into a throwaway profile, task ownership and verification verdicts, and every
 * one of those is wrong for this. See webprofile.js for the full argument.
 *
 * ------------------------------------------------------------------------
 * HEADFUL, AND THAT IS THE POINT.
 *
 * A person has to be able to see this window: they log in through it, answer
 * the MFA prompt in it, and solve the CAPTCHA the site shows them. A headless
 * browser cannot be logged into by a human, and automating a login is exactly
 * what this design refuses to do.
 *
 * ------------------------------------------------------------------------
 * PERFORMANCE IS A CORRECTNESS PROPERTY HERE.
 *
 * Website access is inherently slower than an API call, so the page is kept
 * open between turns and the browser between sources: reconnecting costs
 * seconds, reloading the site costs more, and re-authenticating costs a person's
 * attention. `page()` returns the live session when there is one, and only
 * launches when there is not.
 */

const fs = require('fs');
const path = require('path');
const cdp = require('../harness/cdp');
const browser = require('../harness/browser');
const webprofile = require('./webprofile');

/** How long a freshly launched browser gets to announce its debug port. */
const LAUNCH_TIMEOUT_MS = 25_000;
/** A site that has not loaded by now has a problem worth naming. */
const NAV_TIMEOUT_MS = 45_000;

/**
 * ONE BROWSER, ONE PAGE PER SOURCE.
 *
 * Per-App, never module scope — the same rule every other piece of session-ish
 * state in this tree follows, and for the same reason: two LAINs in one process
 * must not share a logged-in page.
 */
class WebModelBrowser {
  constructor({ bus = null, headless = false } = {}) {
    this.bus = bus;
    // Overridable ONLY so the conformance suite can prove the launch arguments;
    // a headless web-model browser cannot be logged into and is never the
    // production choice. See the header.
    this.headless = headless === true;
    /** sourceId -> { session, processId, profile, port } */
    this._pages = new Map();
    this._opening = new Map();
    this.lastWhy = '';
  }

  /**
   * CAN THIS RUN AT ALL, AND IF NOT, WHY NOT?
   *
   * Cheap and side-effect free: it stats some files and checks the runtime.
   * Deliberately does NOT probe port 9222 the way the harness does — attaching
   * to whatever browser happens to be listening would attach to the person's
   * ordinary browsing session, which is the one thing this must not do.
   */
  availability() {
    const client = cdp.clientAvailable();
    if (!client.ok) return { available: false, why: client.why };
    const found = browser.findBrowser();
    if (!found.ok) {
      return {
        available: false,
        why: `no Chromium-family browser was found (looked in ${found.tried.length} places, including ${found.tried[0]})`,
      };
    }
    return { available: true, why: `launchable: ${found.path}`, browserPath: found.path };
  }

  /** The live page for a source, or null. Never launches. */
  existing(sourceId) {
    const held = this._pages.get(String(sourceId));
    return held && held.session && held.session.open ? held.session : null;
  }

  /**
   * GET THE PAGE, launching the authenticated browser if it is not up.
   *
   * Concurrent callers share one launch. Two turns racing to open ChatGPT would
   * otherwise start two browsers on one profile directory, and Chromium's answer
   * to that is a lock error on the second — which surfaces as a mystery.
   */
  page(sourceId, { launch = true, signal = null } = {}) {
    const key = String(sourceId);
    const live = this.existing(key);
    if (live) return Promise.resolve({ ok: true, session: live });
    if (!launch) return Promise.resolve({ ok: false, why: 'the browser for this source is not open' });
    if (this._opening.has(key)) return this._opening.get(key);
    const opening = this._open(key, signal).finally(() => this._opening.delete(key));
    this._opening.set(key, opening);
    return opening;
  }

  async _open(sourceId, signal) {
    const avail = this.availability();
    if (!avail.available) { this.lastWhy = avail.why; return { ok: false, why: avail.why }; }
    if (signal && signal.aborted) return { ok: false, why: 'cancelled before the browser opened' };

    let profile;
    try { profile = webprofile.ensure(sourceId); } catch (e) {
      const why = `could not prepare the saved-login profile: ${(e && e.message) || e}`;
      this.lastWhy = why;
      return { ok: false, why };
    }

    const started = await this._launch(sourceId, profile, avail.browserPath, signal);
    if (!started.ok) { this.lastWhy = started.why; return started; }
    // ---- OWNED BEFORE IT CAN BE LOST -------------------------------------
    //
    // Recorded the instant the process exists, and BEFORE the first thing that
    // can fail after it. Registering only on full success left a real leak: a
    // browser that launched and then would not hand over a page was never in
    // `_pages`, so `close()` had nothing to kill and a headful window stayed on
    // screen with no owner. This is the same ownership rule the process manager
    // enforces for every other spawned thing in the tree.
    this._pages.set(sourceId, { session: null, processId: started.processId, profile, port: started.port, child: started.child });

    const tab = await cdp.newTab(started.base, 'about:blank');
    if (!tab.ok || !tab.target || !tab.target.webSocketDebuggerUrl) {
      const why = 'the browser opened but would not give LAIN a page to drive';
      this.lastWhy = why;
      await this.close(sourceId);
      return { ok: false, why };
    }
    const conn = new cdp.Connection(tab.target.webSocketDebuggerUrl);
    const opened = await conn.connect();
    if (!opened.ok) { this.lastWhy = opened.why; await this.close(sourceId); return { ok: false, why: opened.why }; }

    const session = new browser.BrowserSession(conn, { base: started.base });
    session.targetId = tab.target.id || null;
    // Page + Runtime only. Network and Log capture would accumulate the site's
    // own traffic — headers, cookies, request bodies — in memory belonging to a
    // process that writes transcripts, and none of it is needed to read a reply
    // off a page. Not collecting it is cheaper than redacting it.
    try { await conn.send('Page.enable'); } catch { /* navigation still works */ }
    try { await conn.send('Runtime.enable'); } catch { /* evaluate still works */ }
    this._pages.set(sourceId, { session, processId: started.processId, profile, port: started.port, child: started.child });
    return { ok: true, session };
  }

  /**
   * LAUNCH IT, HEADFUL, ON THE PERSISTENT PROFILE.
   *
   * NOT THROUGH THE HARNESS PROCESS MANAGER, and that is a deliberate
   * difference rather than an omission. A managed process is owned by a TASK and
   * dies with it; this browser holds a person's login and must outlive every
   * task in the session — taking it down when a verification finishes would log
   * them out of ChatGPT for the crime of running the tests. It is closed by
   * `close()`, by `/source disconnect`, and by process exit.
   */
  async _launch(sourceId, profile, browserPath, signal) {
    // ---- SHARED LAUNCHER, UNCHANGED PROFILE DESIGN -----------------------
    //
    // §17 is explicit that the authenticated ChatGPT/Gemini profile design does
    // not change, and it does not: `modelsource/webprofile.js` still owns the
    // directory, it is still persistent, and it is still keyed by source. What
    // moved is only HOW the process is started.
    //
    // The two properties this purpose depends on are traits in env/purpose.js
    // rather than flags repeated here:
    //   · lifetime 'session' — spawned detached, NOT through the
    //     ProcessManager, because a managed process dies with a task and that
    //     would log the person out of ChatGPT for the crime of running tests.
    //   · extensions ON — a person's password manager is genuinely part of
    //     their login flow, and this is THEIR browser window.
    //
    // The runtime also asserts, at launch, that this profile does not overlap
    // the Workshop or verification roots — so the leak this file was written to
    // prevent is now checked rather than only described.
    const rt = require('../env/chromium');
    const runtime = new rt.ChromiumRuntime({ processes: null, events: this.events || null });
    const got = await runtime.launch(rt.PURPOSE.WEBMODEL, {
      sourceId, headless: this.headless, signal,
    });
    if (!got.ok) return { ok: false, why: got.why, detail: got.detail || '', code: got.code || '' };
    const inst = got.instance;
    return { ok: true, base: inst.base, port: inst.port, processId: inst.child ? inst.child.pid : null, child: inst.child, instance: inst };
  }

  _kill(child) {
    try { if (child && child.pid) child.kill(); } catch { /* already gone */ }
  }

  /**
   * GO SOMEWHERE, and say plainly when the page did not arrive.
   *
   * Only ever called with a URL the ADAPTER declared — never with one read off
   * the page. A source that followed a link the site handed it would be a
   * browsing capability, which is precisely what this project removed.
   */
  async navigate(sourceId, url, timeoutMs = NAV_TIMEOUT_MS) {
    const got = await this.page(sourceId);
    if (!got.ok) return got;
    return got.session.navigate(String(url), timeoutMs);
  }

  /** Close one source's page and the browser behind it. The login SURVIVES. */
  async close(sourceId) {
    const key = String(sourceId);
    const held = this._pages.get(key);
    this._pages.delete(key);
    if (!held) return { ok: true };
    try {
      if (held.session) {
        if (held.session.targetId && held.session.open) {
          try { await held.session.conn.send('Target.closeTarget', { targetId: held.session.targetId }, 1500); } catch { /* the socket close still follows */ }
        }
        held.session.close('the web model source was disconnected');
      }
    } catch { /* closing is best effort; the kill below is what frees the port */ }
    this._kill(held.child);
    return { ok: true };
  }

  /** Everything, on shutdown. */
  async closeAll() {
    for (const key of [...this._pages.keys()]) {
      // eslint-disable-next-line no-await-in-loop -- closing is bounded and rare
      await this.close(key);
    }
    return { ok: true };
  }
}

/**
 * THE ONE PER APP. Held on the App because a browser holding a login is
 * session-scoped state, and module scope is where two Apps start sharing it.
 */
function forApp(app) {
  if (!app) return new WebModelBrowser();
  if (!app._webModelBrowser) {
    app._webModelBrowser = new WebModelBrowser({
      bus: app.events || null,
      headless: process.env.LAIN_WEBMODEL_HEADLESS === '1',
    });
  }
  return app._webModelBrowser;
}

module.exports = { WebModelBrowser, forApp, LAUNCH_TIMEOUT_MS, NAV_TIMEOUT_MS };
