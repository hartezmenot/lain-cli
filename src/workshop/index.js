'use strict';

/**
 * THE FRONTEND WORKSHOP — LAIN can see, drive and verify the frontend it edits.
 *
 * ------------------------------------------------------------------------
 * WHAT IT ADDS OVER THE BROWSER HARNESS, because "we already have CDP" is not
 * the same claim and it was worth being precise about.
 *
 * harness/browserharness.js runs a CONTRACT: a headless browser in a throwaway
 * profile executes a fixed list of actions and returns PASSED / FAILED /
 * INCONCLUSIVE. It is a judge. It has no notion of a preview somebody looks at,
 * of an element they point to, of a viewport they switch, or of a before that
 * gets compared with an after. Everything in this file is that missing half.
 *
 * They share the wire (harness/cdp.js) and the page primitives
 * (harness/browser.js BrowserSession) and NOTHING about identity or lifecycle —
 * see workshop/profile.js, which states the three-browser rule and asserts it.
 *
 * ------------------------------------------------------------------------
 * ONE SESSION PER PROJECT, HELD OPEN.
 *
 * A preview that closed when a task ended would lose its route, its scroll
 * position, its dev login and its console history every time LAIN finished
 * something — which is most of what makes a preview useful. So the Workshop
 * lives as long as the project is open, and the process it may have started is
 * owned by the ProcessManager exactly like any other managed service.
 *
 * ------------------------------------------------------------------------
 * IT SETTLES NOTHING.
 *
 * `verify()` gathers evidence and returns a report. It does not mark a task
 * complete, does not write a verdict and does not touch lifecycle state —
 * harness/verify.js and completion.js remain the only authorities that settle
 * anything, and they consume this as evidence like any other observation. A
 * Workshop that could declare a task done would be a second verification
 * system, which is the one thing this tree does not permit.
 */

const path = require('path');
const cdp = require('../harness/cdp');
const browser = require('../harness/browser');
const wprofile = require('./profile');
const devserver = require('./devserver');
const inspect = require('./inspect');
const viewport = require('./viewport');
const { EVENT } = require('../events');

/** A preview that has not loaded by now has a problem worth naming. */
const NAV_TIMEOUT_MS = 30_000;
/** How long a freshly launched preview browser gets to open its debug port. */
const LAUNCH_TIMEOUT_MS = 25_000;

/**
 * ONE WORKSHOP PER APP. Per-App and never module scope — the rule every other
 * piece of session-ish state in this tree follows, and for the same reason.
 */
class Workshop {
  constructor({ app = null } = {}) {
    this.app = app;
    /** projectPath -> { session, child, profile, url, processId } */
    this._open = new Map();
    this._opening = new Map();
    /** Screenshots taken as BEFORE, by project. See `capture`. */
    this._before = new Map();
    this.lastWhy = '';
  }

  /**
   * THE PROCESS AND ARTIFACT AUTHORITIES, and they are CREATED if absent.
   *
   * harnesslink.existing() deliberately never constructs a harness — it is for readers
   * that must not cause one. The Workshop is not a reader: opening a preview
   * genuinely needs a process manager to own the dev server and an artifact
   * store to file the screenshots, and refusing to create one would make the
   * Workshop work only in sessions that had already run a tool. Found by
   * driving it: the first real run refused with "no process manager".
   */
  get processes() {
    const h = this.app && require('../harnesslink').harnessFor(this.app);
    return (h && h.processes) || null;
  }

  get runtime() {
    const h = this.app && require('../harnesslink').harnessFor(this.app);
    return (h && h.runtime) || null;
  }

  _emit(name, payload) {
    try {
      const bus = this.app && this.app.events;
      if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
    } catch { /* a companion channel may never take the work with it */ }
  }

  /** Can a Workshop run here at all, and if not, why not? Cheap, no launch. */
  /**
   * CAN A PREVIEW OPEN, AND IN WHICH BROWSER?
   *
   * Through env/chromium.js rather than `browser.findBrowser()`, so the
   * Workshop reports the SAME browser it will actually launch — the
   * Harness-owned build when one is installed, a labelled borrow when it is
   * not. Asking the raw finder here would have said "launchable: your Chrome"
   * while the launcher went and started the managed build.
   *
   * ENVIRONMENT IS PART OF THE ANSWER. §8: iterative frontend work stays on
   * the HOST with a Harness-owned Chromium, because that is the fast loop;
   * release verification is what goes to a VM. So this reports where the
   * preview would open, and it is the host unless a task says otherwise.
   */
  availability({ environment = 'host' } = {}) {
    const client = cdp.clientAvailable();
    if (!client.ok) return { available: false, why: client.why, environment };
    const rt = require('../env/chromium');
    const found = rt.resolve({ policy: new rt.ChromiumRuntime().policy() });
    if (!found.ok) {
      return { available: false, why: found.why, remedy: found.remedy || '', environment };
    }
    return {
      available: true,
      why: `launchable: ${found.path}`,
      browserPath: found.path,
      // WHICH BROWSER, SAID PLAINLY. A person looking at a preview should be
      // able to tell whether it is the pinned build or their own Chrome.
      version: found.version || '',
      owned: found.owned,
      managed: found.managed,
      source: found.source,
      environment,
    };
  }

  /** The live preview for a project, or null. Never launches. */
  existing(projectPath) {
    const held = this._open.get(path.resolve(projectPath));
    return held && held.session && held.session.open ? held : null;
  }

  /**
   * OPEN THE PREVIEW: get a dev server, get a browser, point one at the other.
   *
   * Concurrent callers share one open. Two of these racing would start two
   * browsers on one profile directory, and Chromium answers that with a lock
   * error on the second — which surfaces as a mystery.
   */
  open(projectPath, opts = {}) {
    const key = path.resolve(projectPath);
    const live = this.existing(key);
    if (live) return Promise.resolve({ ok: true, url: live.url, port: live.port, adopted: live.adopted, reused: true });
    if (this._opening.has(key)) return this._opening.get(key);
    const work = this._open_(key, opts).finally(() => this._opening.delete(key));
    this._opening.set(key, work);
    return work;
  }

  async _open_(key, { taskId = null, headless = false } = {}) {
    const avail = this.availability();
    if (!avail.available) { this.lastWhy = avail.why; return { ok: false, why: avail.why }; }

    // ---- 1. A URL TO PREVIEW, through the existing process authority ----
    this._emit(EVENT.BROWSER_STARTED, { taskId: String(taskId || ''), what: 'workshop' });
    const serve = await devserver.ensure(key, { processes: this.processes, taskId });
    if (!serve.ok) { this.lastWhy = serve.why; return { ok: false, why: serve.why }; }

    // ---- 2. A BROWSER, on this PROJECT'S OWN profile --------------------
    let profile;
    try { profile = wprofile.ensure(key); } catch (e) {
      return { ok: false, why: `could not prepare the preview profile: ${(e && e.message) || e}` };
    }
    const launched = await this._launch(key, headless);
    if (!launched.ok) { this.lastWhy = launched.why; return launched; }
    // OWNED BEFORE ANYTHING ELSE CAN FAIL. Registering only on full success is
    // how a browser that started and then would not hand over a page becomes an
    // orphan window with nothing holding it.
    this._open.set(key, {
      session: null, child: launched.child, profile, url: serve.url, port: serve.port,
      processId: serve.processId, adopted: serve.adopted,
    });

    const tab = await cdp.newTab(launched.base, 'about:blank');
    if (!tab.ok || !tab.target || !tab.target.webSocketDebuggerUrl) {
      await this.close(key);
      return { ok: false, why: 'the preview browser would not give LAIN a page to drive' };
    }
    const conn = new cdp.Connection(tab.target.webSocketDebuggerUrl);
    const opened = await conn.connect();
    if (!opened.ok) { await this.close(key); return { ok: false, why: opened.why }; }

    const session = new browser.BrowserSession(conn, { base: launched.base });
    session.targetId = tab.target.id || null;
    // Page, Runtime, Log, Network, DOM — the same set the verification browser
    // enables, because the console and network observations are the same
    // observations. `enable` absorbs a domain a build refuses.
    await session.enable();
    const held = this._open.get(key);
    held.session = session;

    const nav = await session.navigate(serve.url, NAV_TIMEOUT_MS);
    if (!nav.ok) {
      // A PREVIEW THAT WILL NOT LOAD IS STILL AN OPEN WORKSHOP. The browser and
      // the server are up; saying so lets a person retry or read the console
      // rather than starting the whole thing again.
      return { ok: true, url: serve.url, port: serve.port, adopted: serve.adopted, loaded: false, why: nav.why };
    }
    this._emit(EVENT.BROWSER_OBSERVED, { taskId: String(taskId || ''), what: 'preview', url: serve.url });
    return { ok: true, url: serve.url, port: serve.port, adopted: serve.adopted, loaded: true, why: serve.why };
  }

  /**
   * LAUNCH THE PREVIEW BROWSER.
   *
   * NOT through the ProcessManager, and that is a deliberate difference rather
   * than an omission: a managed process is owned by a TASK and dies with it,
   * and this browser must outlive every task in the project — closing the
   * person's preview because a verification finished is the behaviour this
   * whole module exists to avoid. The DEV SERVER is managed, because that
   * genuinely is a project service. This is closed by `close()` and by exit.
   */
  async _launch(projectPath, headless) {
    // ---- THE LAUNCH IS env/chromium.js's, AND THE LIFETIME IS STILL OURS --
    //
    // This was fifty lines duplicated from browserharness.js and
    // webbrowser.js, drifted apart on details nobody had decided (this copy
    // deleted the stale DevToolsActivePort file; one of the others did not).
    // The launcher is shared now; what stays different is the PURPOSE, and
    // env/purpose.js holds those differences as data:
    //
    //   WORKSHOP is project-bound and lives as long as the person is working
    //   on the project. That is why `traits.lifetime` is 'project' and the
    //   runtime spawns it detached rather than handing it to the
    //   ProcessManager — a managed process dies with a TASK, and closing
    //   somebody's preview because a verification finished is the exact
    //   behaviour this module exists to avoid.
    const rt = require('../env/chromium');
    const runtime = new rt.ChromiumRuntime({ processes: null, events: this.bus });
    const got = await runtime.launch(rt.PURPOSE.WORKSHOP, {
      projectPath,
      headless,
    });
    if (!got.ok) return { ok: false, why: got.why, detail: got.detail || '', code: got.code || '' };
    const inst = got.instance;
    // WHICH BROWSER THE PREVIEW IS, for the status surface and for evidence.
    this.lastBrowser = { version: inst.version, owned: inst.owned, managed: inst.managed, source: inst.source };
    return { ok: true, base: inst.base, port: inst.port, child: inst.child, instance: inst };
  }

  // ------------------------------------------------------------ observing --

  /** The page, or a stated reason there is not one. Every reader goes through it. */
  _page(projectPath) {
    const held = this.existing(projectPath);
    if (!held) return { ok: false, why: 'the workshop is not open for this project' };
    return { ok: true, session: held.session, held };
  }

  async element(projectPath, selector) {
    const p = this._page(projectPath);
    return p.ok ? inspect.element(p.session, selector) : p;
  }

  async pick(projectPath) {
    const p = this._page(projectPath);
    return p.ok ? inspect.pick(p.session) : p;
  }

  async picked(projectPath) {
    const p = this._page(projectPath);
    return p.ok ? inspect.picked(p.session) : p;
  }

  async unpick(projectPath) {
    const p = this._page(projectPath);
    return p.ok ? inspect.unpick(p.session) : p;
  }

  async axTree(projectPath, selector = null) {
    const p = this._page(projectPath);
    return p.ok ? inspect.axTree(p.session, selector) : p;
  }

  /** Console and network, summarised. Cheap: both are accumulated already. */
  observations(projectPath) {
    const p = this._page(projectPath);
    if (!p.ok) return p;
    return {
      ok: true,
      url: p.session.url || p.held.url,
      viewport: p.session.viewport || 'desktop',
      console: inspect.consoleReport(p.session),
      network: inspect.networkReport(p.session),
    };
  }

  // ------------------------------------------------------------- driving --

  async navigate(projectPath, url) {
    const p = this._page(projectPath);
    if (!p.ok) return p;
    // ONLY WITHIN THE PREVIEW'S OWN ORIGIN. A Workshop that followed a link to
    // the public web would be the browsing capability this project removed, and
    // it would do it in a browser holding the project's dev session.
    const target = String(url || '');
    const base = p.held.url;
    const abs = target.startsWith('http') ? target : new URL(target, base).href;
    if (!abs.startsWith(new URL(base).origin)) {
      return { ok: false, why: 'the workshop previews this project, not the web' };
    }
    return p.session.navigate(abs, NAV_TIMEOUT_MS);
  }

  async click(projectPath, selector) {
    const p = this._page(projectPath);
    return p.ok ? p.session.click(String(selector)) : p;
  }

  async type(projectPath, selector, text) {
    const p = this._page(projectPath);
    return p.ok ? p.session.type(String(selector), String(text == null ? '' : text)) : p;
  }

  async reload(projectPath) {
    const p = this._page(projectPath);
    if (!p.ok) return p;
    try { await p.session.conn.send('Page.reload', { ignoreCache: false }); } catch (e) {
      return { ok: false, why: String((e && e.message) || e) };
    }
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, why: 'reloaded' };
  }

  async viewport(projectPath, name, opts = {}) {
    const p = this._page(projectPath);
    return p.ok ? viewport.apply(p.session, name, opts) : p;
  }

  /**
   * FORGET WHAT EARLIER LOADS SAID.
   *
   * The buffers are the BrowserSession own arrays (harness/browser.js), which
   * it fills from CDP events. Emptying them in place is what keeps one reader
   * of them; a second buffer here would be a second answer to "what did the
   * console say".
   */
  _resetLogs(session) {
    if (!session) return;
    if (Array.isArray(session.console)) session.console.length = 0;
    if (Array.isArray(session.network)) session.network.length = 0;
    if (Array.isArray(session.pageErrors)) session.pageErrors.length = 0;
  }

  // ------------------------------------------------------------ evidence --

  /**
   * A SCREENSHOT, KEPT AS A HARNESS ARTIFACT.
   *
   * `runtime.keep` is the existing artifact store — the same one verification
   * screenshots and console dumps go to — so a Workshop capture is evidence of
   * exactly the same kind, findable in the same place, cleaned up by the same
   * rules. A second image store would be a second thing to find and a second
   * thing to forget to clean.
   *
   * `as: 'before'` REMEMBERS it for the comparison. That is the whole of the
   * before/after mechanism: two artifacts and a note saying which was which.
   */
  async capture(projectPath, { as = null, taskId = null, name = null } = {}) {
    const p = this._page(projectPath);
    if (!p.ok) return p;
    const shot = await p.session.screenshot();
    if (!shot.ok) return shot;
    const vp = p.session.viewport || 'desktop';
    const label = String(name || `${as || 'shot'}-${vp}.png`);
    let kept = null;
    const rt = this.runtime;
    if (rt && taskId) {
      try { kept = rt.keep(taskId, { kind: 'screenshot', name: label, body: shot.buffer }); } catch { kept = null; }
    }
    const record = {
      ok: true,
      viewport: vp,
      url: p.session.url || p.held.url,
      at: Date.now(),
      bytes: shot.buffer.length,
      path: kept ? kept.path : null,
      // THE IMAGE ITSELF, for the frontend to draw immediately. Not persisted
      // here — the artifact above is the durable copy.
      dataUrl: `data:image/png;base64,${shot.buffer.toString('base64')}`,
    };
    if (as === 'before') this._before.set(`${path.resolve(projectPath)}:${vp}`, record);
    return record;
  }

  /** The BEFORE for this project and viewport, or null. */
  before(projectPath, vp = 'desktop') {
    return this._before.get(`${path.resolve(projectPath)}:${vp}`) || null;
  }

  /**
   * VERIFY THE FRONTEND AT ONE OR MORE VIEWPORTS.
   *
   * ------------------------------------------------------------------------
   * IT RETURNS EVIDENCE, NOT A VERDICT ABOUT THE TASK.
   *
   * Each viewport contributes four observations that are individually decidable
   * — the page loaded, no console errors, no failed requests, no sideways
   * overflow — plus a screenshot. `harness/verify.js` and completion.js remain
   * the only things that settle a task; this is what they settle FROM.
   *
   * A FILE CHANGING IS NOT EVIDENCE OF ANYTHING, which is why nothing here
   * consults the diff.
   */
  async verify(projectPath, { viewports = ['desktop', 'mobile'], taskId = null, selector = null } = {}) {
    const p = this._page(projectPath);
    if (!p.ok) return { ok: false, why: p.why };
    const results = [];
    for (const name of viewports) {
      // ---- EACH VIEWPORT IS JUDGED ON ITS OWN PAGE LOAD ----------------
      //
      // The session ACCUMULATES console and network entries from the moment it
      // opens — which is right for a live preview and wrong for a verdict.
      // Measured: desktop reported 5 console errors and mobile then reported 7,
      // because mobile inherited desktops and added its own. Every viewport
      // after the first would look worse than it is, and a repair could never
      // show a clean run.
      //
      // Cleared immediately BEFORE the reload that  performs, so
      // what each check counts is what THIS load produced.
      this._resetLogs(p.session);
      // eslint-disable-next-line no-await-in-loop -- a viewport sweep is
      // ordered by definition: each one reloads the page under new metrics.
      const applied = await this.viewport(projectPath, name);
      // A moment for the reloaded page to emit what it is going to emit. Without
      // it a fast page is judged before its own error has been logged.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 500));
      if (!applied.ok) { results.push({ viewport: name, ok: false, why: applied.why }); continue; }
      // eslint-disable-next-line no-await-in-loop
      const over = await viewport.overflow(p.session);
      const obs = this.observations(projectPath);
      // eslint-disable-next-line no-await-in-loop
      const shot = await this.capture(projectPath, { as: 'after', taskId, name: `verify-${name}.png` });
      let el = null;
      if (selector) {
        // eslint-disable-next-line no-await-in-loop
        const got = await this.element(projectPath, selector);
        el = got.ok ? got.element : { missing: got.why };
      }
      const checks = [
        { name: 'no console errors', ok: obs.ok ? obs.console.errors === 0 : false, detail: obs.ok ? `${obs.console.errors} error(s)` : obs.why },
        { name: 'no failed requests', ok: obs.ok ? obs.network.failed === 0 : false, detail: obs.ok ? `${obs.network.failed} failed` : obs.why },
        { name: 'no horizontal overflow', ok: over.ok ? !over.overflowing : false, detail: over.ok ? (over.overflowing ? `overflows by ${over.by}px — widest: ${over.worst}` : 'fits') : over.why },
      ];
      results.push({
        viewport: name,
        ok: checks.every((c) => c.ok),
        width: applied.width,
        checks,
        element: el,
        screenshot: shot.ok ? { path: shot.path, dataUrl: shot.dataUrl } : null,
      });
    }
    // Hand the window back, so the preview a person looks at afterwards is the
    // one they were working in rather than the last viewport tested.
    await viewport.clear(p.session);
    return {
      ok: results.length > 0 && results.every((r) => r.ok),
      results,
      // SAID PLAINLY, because it is the boundary this module lives inside.
      note: 'workshop observations — the task is settled by the harness, not here',
    };
  }

  // ------------------------------------------------------------ lifecycle --

  /** What a status view may know. Cheap, and never launches anything. */
  status(projectPath) {
    const key = path.resolve(projectPath || (this.app && this.app.session && this.app.session.cwd) || process.cwd());
    const held = this.existing(key);
    const detected = devserver.detect(key);
    return {
      project: key,
      open: Boolean(held),
      url: held ? held.url : null,
      port: held ? held.port : null,
      adopted: held ? Boolean(held.adopted) : false,
      viewport: held && held.session ? (held.session.viewport || 'desktop') : null,
      devServer: { ok: detected.ok, why: detected.why },
      available: this.availability(),
      profile: wprofile.describe(key),
    };
  }

  /** Close one project's preview. The dev server is the ProcessManager's. */
  async close(projectPath) {
    const key = path.resolve(projectPath);
    const held = this._open.get(key);
    this._open.delete(key);
    this._before.delete(`${key}:desktop`);
    if (!held) return { ok: true };
    try {
      if (held.session) {
        if (held.session.targetId && held.session.open) {
          try { await held.session.conn.send('Target.closeTarget', { targetId: held.session.targetId }, 1500); } catch { /* the socket close follows */ }
        }
        held.session.close('the workshop was closed');
      }
    } catch { /* closing is best effort; the kill below frees the port */ }
    try { if (held.child && held.child.pid) held.child.kill(); } catch { /* gone */ }
    // THE DEV SERVER IS NOT KILLED HERE when it was ADOPTED — it was already
    // running and belongs to whoever started it. One LAIN started goes down
    // with its task through the ProcessManager, which owns that decision.
    if (!held.adopted && held.processId && this.processes) {
      try { await this.processes.stop(held.processId); } catch { /* the manager reports its own failures */ }
    }
    this._emit(EVENT.BROWSER_CLOSED, { taskId: '', what: 'workshop' });
    return { ok: true };
  }

  async closeAll() {
    for (const key of [...this._open.keys()]) {
      // eslint-disable-next-line no-await-in-loop -- bounded and rare
      await this.close(key);
    }
    return { ok: true };
  }
}

/** THE ONE PER APP. Held on the App, never at module scope. */
function forApp(app) {
  if (!app) return new Workshop();
  if (!app._workshop) app._workshop = new Workshop({ app });
  return app._workshop;
}

module.exports = { Workshop, forApp, NAV_TIMEOUT_MS };
