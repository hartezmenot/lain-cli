'use strict';

/**
 * THE BROWSER HARNESS — an instrument, not a browsing tool.
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS FOR, STATED NARROWLY ON PURPOSE.
 *
 * Point it at the application under test — nearly always something this machine
 * is serving on localhost — drive the flow a verification contract names, and
 * report what was actually there: the DOM, the accessibility tree, the console,
 * the network, a screenshot. Then close.
 *
 * It is NOT the browsing capability that was removed from this project in
 * 2026-09. It does not answer questions from the public web, does not use the
 * person's profile or cookies, does not follow links it was not given and has
 * no search anything. The difference is not a policy bolted on top; it is the
 * shape of the API — there is no `search`, and every entry point takes a URL
 * the contract supplied.
 *
 * ------------------------------------------------------------------------
 * STRUCTURED AND VISUAL OBSERVATION COEXIST, AND NEITHER IS THE FALLBACK.
 *
 * The DOM answers "is the button disabled" exactly and for nothing. A
 * screenshot answers "does the canvas show the ship" and the DOM cannot. So
 * both are first-class here, and the ROUTER (harness/observation.js) decides
 * which to ask — this file simply provides both honestly.
 *
 * ------------------------------------------------------------------------
 * IT REPORTS UNAVAILABILITY RATHER THAN FAKING CAPABILITY.
 *
 * Three things must hold before a browser observation is possible: a Node with
 * a WebSocket client, a browser binary or an already-open debug port, and
 * permission to spend the seconds it takes. When any of them is missing,
 * `available()` says which one, every check returns INCONCLUSIVE with that
 * sentence, and NOTHING pretends the flow passed. An unavailable capability
 * that reports itself is useful; one that silently succeeds is a liability.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cdp = require('./cdp');

/** The default port. 9222 is the DevTools convention and every tool knows it. */
const DEFAULT_PORT = 9222;
/** A page that has not loaded by now is a page with a problem. */
const NAV_TIMEOUT_MS = 20000;
/** How long to wait for a freshly launched browser to open its debug port. */
const LAUNCH_TIMEOUT_MS = 15000;

/**
 * WHERE A BROWSER LIVES ON THIS MACHINE.
 *
 * A LIST, NOT A GUESS. Each entry is checked with `existsSync`, so the answer
 * is "this file is here" rather than "this is usually where it is" — and when
 * none of them is present the reason says so with the paths that were tried,
 * which is the difference between a diagnosable failure and a mystery.
 */
function candidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge',
  ];
}

function findBrowser(explicit = null) {
  const tried = [];
  const list = explicit ? [explicit] : candidates();
  for (const p of list) {
    tried.push(p);
    try { if (fs.statSync(p).isFile()) return { ok: true, path: p, tried }; } catch { /* unreadable */ }
  }
  return { ok: false, tried };
}

/**
 * CAN A BROWSER OBSERVATION HAPPEN AT ALL, AND IF NOT, WHY NOT?
 *
 * Cheap and side-effect free: it probes an HTTP port and stats some files. It
 * never launches anything. `/harness doctor` calls it, and so does every check
 * before it decides to be INCONCLUSIVE.
 */
async function available({ port = DEFAULT_PORT, browserPath = null } = {}) {
  const client = cdp.clientAvailable();
  const found = findBrowser(browserPath);
  const live = await cdp.endpoint(port);
  const out = {
    available: false,
    state: 'OPTIONAL_UNAVAILABLE',
    why: '',
    client: client.ok,
    clientWhy: client.why,
    attachable: live.ok,
    launchable: found.ok,
    browserPath: found.ok ? found.path : null,
    port,
    browser: live.ok ? live.browser : null,
    tried: found.tried,
  };
  if (!client.ok) { out.why = client.why; return out; }
  if (browserPath && !found.ok) { out.state = 'MISCONFIGURED'; out.why = `configured browser binary is missing: ${browserPath}`; return out; }
  if (live.ok) { out.state = 'AVAILABLE'; out.available = true; out.why = `attachable: ${live.browser} on port ${port}`; return out; }
  if (found.ok) { out.state = 'AVAILABLE'; out.available = true; out.why = `launchable: ${found.path}`; return out; }
  out.why = `no browser is listening on port ${port} and no browser binary was found (looked in ${found.tried.length} places)`;
  return out;
}

/**
 * ONE BROWSER SESSION — a connection, a page, and everything it saw.
 *
 * The console and network logs are ACCUMULATED FROM THE MOMENT THE SESSION
 * OPENS, not fetched on demand, because neither is retrievable after the fact:
 * a console error that fired during navigation is gone by the time anybody
 * thinks to ask. Subscribing first and reading later is the only ordering that
 * can answer "were there console errors during this flow".
 */
class BrowserSession {
  constructor(conn, { taskId = null, processId = null, base = null } = {}) {
    this.conn = conn;
    this.taskId = taskId;
    this.processId = processId;
    this.base = base;
    this.console = [];
    this.network = [];
    this.pageErrors = [];
    this.url = null;
    this.openedAt = Date.now();
  }

  get open() { return Boolean(this.conn && this.conn.open); }

  _collect() {
    this.conn.on((method, params) => {
      if (method === 'Runtime.consoleAPICalled') {
        const text = (params.args || []).map((a) => (a.value != null ? String(a.value) : (a.description || a.type))).join(' ');
        this.console.push({ level: params.type || 'log', text: text.slice(0, 2000), at: Date.now() });
      } else if (method === 'Log.entryAdded' && params.entry) {
        this.console.push({ level: params.entry.level || 'log', text: String(params.entry.text || '').slice(0, 2000), url: params.entry.url, at: Date.now() });
      } else if (method === 'Runtime.exceptionThrown') {
        const d = (params.exceptionDetails || {});
        const text = d.exception && (d.exception.description || d.exception.value);
        this.pageErrors.push({ text: String(text || d.text || 'uncaught exception').slice(0, 2000), at: Date.now() });
      } else if (method === 'Network.responseReceived' && params.response) {
        this.network.push({ url: String(params.response.url || '').slice(0, 500), status: params.response.status, at: Date.now() });
      }
      const cap = 500;
      if (this.console.length > cap) this.console.splice(0, this.console.length - cap);
      if (this.network.length > cap) this.network.splice(0, this.network.length - cap);
    });
  }

  /** Every console entry at error level, plus uncaught exceptions. */
  errors() {
    return [
      ...this.console.filter((c) => /error/i.test(c.level)),
      ...this.pageErrors.map((e) => ({ level: 'error', text: e.text, at: e.at })),
    ];
  }

  async enable() {
    this._collect();
    this.enabledDomains = new Set();
    for (const domain of ['Page', 'Runtime', 'Log', 'Network', 'DOM']) {
      // A DOMAIN THAT WILL NOT ENABLE IS NOT FATAL. Older builds and some
      // targets refuse one of these; losing network capture is worth far less
      // than losing the whole session, so the failure is absorbed and shows up
      // later as an empty log rather than as a dead browser.
      try { await this.conn.send(`${domain}.enable`); this.enabledDomains.add(domain); } catch { /* availability remains explicit */ }
    }
  }

  async navigate(url, timeoutMs = NAV_TIMEOUT_MS) {
    const target = String(url);
    let finish;
    const loaded = new Promise((resolve) => {
      const off = this.conn.on((method) => {
        if (method === 'Page.loadEventFired') finish(true);
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
      finish = (ok) => { clearTimeout(timer); off(); this._loads.delete(finish); resolve(ok); };
      if (!this._loads) this._loads = new Set();
      this._loads.add(finish);
    });
    let r;
    try { r = await this.conn.send('Page.navigate', { url: target }, timeoutMs); } catch (e) {
      finish(false);
      return { ok: false, why: `navigation failed: ${(e && e.message) || e}` };
    }
    if (r && r.errorText) { finish(false); return { ok: false, why: `navigation failed: ${r.errorText}` }; }
    const didLoad = await loaded;
    this.url = target;
    return { ok: didLoad, loaded: didLoad, why: didLoad ? `loaded ${target}` : `navigated to ${target}, but the load event did not fire within ${timeoutMs}ms` };
  }

  /**
   * EVALUATE AN EXPRESSION IN THE PAGE.
   *
   * The single primitive the DOM reads are built on. `returnByValue` so the
   * result arrives as JSON rather than as a remote object handle nobody here
   * would release — a handle leak in a verification run is a browser that grows
   * until the machine notices.
   */
  async evaluate(expression, timeoutMs = cdp.CALL_TIMEOUT_MS) {
    let r;
    try {
      r = await this.conn.send('Runtime.evaluate', {
        expression: String(expression), returnByValue: true, awaitPromise: true,
      }, timeoutMs);
    } catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      return { ok: false, why: `the page threw: ${String(text).slice(0, 400)}` };
    }
    return { ok: true, value: r && r.result ? r.result.value : undefined };
  }

  /**
   * WHAT IS THIS ELEMENT?
   *
   * One evaluate, everything a contract usually asks about: whether it is
   * there, its text, whether it is disabled, whether it is actually visible
   * (which `display:none` and a zero-size box both defeat), and its attributes.
   * Doing it in one round trip rather than five matters because a verification
   * contract asks about several elements and each round trip is a real
   * millisecond cost against a real deadline.
   */
  async element(selector) {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(String(selector))});
      if (!el) return { exists: false };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;
      return {
        exists: true,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').trim().slice(0, 2000),
        value: 'value' in el ? String(el.value == null ? '' : el.value).slice(0, 500) : null,
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        attributes: attrs,
      };
    })()`;
    return this.evaluate(expr);
  }

  /**
   * THE ACCESSIBILITY TREE, which answers a different question from the DOM.
   *
   * The DOM says what is in the document; this says what a user is told. A
   * button that is `<div onclick>` exists in one and is invisible to the other,
   * and for "can a user submit this form" the second answer is the true one.
   */
  async axTree(selector = null) {
    try {
      if (selector) {
        const doc = await this.conn.send('DOM.getDocument', { depth: 1 });
        const node = await this.conn.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: String(selector) });
        if (!node || !node.nodeId) return { ok: false, why: `no element matches ${selector}` };
        const ax = await this.conn.send('Accessibility.getPartialAXTree', { nodeId: node.nodeId, fetchRelatives: false });
        return { ok: true, nodes: (ax.nodes || []).map(axRow) };
      }
      const ax = await this.conn.send('Accessibility.getFullAXTree', { max_depth: 6 });
      return { ok: true, nodes: (ax.nodes || []).slice(0, 300).map(axRow) };
    } catch (e) {
      return { ok: false, why: `the accessibility tree is not available: ${(e && e.message) || e}` };
    }
  }

  async click(selector) {
    const r = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(String(selector))});
      if (!el) return 'missing';
      el.click();
      return 'clicked';
    })()`);
    if (!r.ok) return { ok: false, why: r.why };
    return r.value === 'clicked'
      ? { ok: true, why: `clicked ${selector}` }
      : { ok: false, why: `nothing matches ${selector}` };
  }

  /**
   * TYPE INTO A FIELD, and dispatch the events a framework listens for.
   *
   * Setting `.value` alone is the classic mistake: React, Vue and Svelte all
   * keep their own state and never see it, so the form submits empty and the
   * failure looks like a backend bug. The input and change events are what make
   * this observation of the real application rather than of the DOM's opinion.
   */
  async type(selector, text) {
    const r = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(String(selector))});
      if (!el) return 'missing';
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      if (setter && setter.set) setter.set.call(el, ${JSON.stringify(String(text))});
      else el.value = ${JSON.stringify(String(text))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'typed';
    })()`);
    if (!r.ok) return { ok: false, why: r.why };
    return r.value === 'typed' ? { ok: true, why: `typed into ${selector}` } : { ok: false, why: `nothing matches ${selector}` };
  }

  /** Wait for a selector to appear. Bounded, and it says so when it gives up. */
  async waitFor(selector, timeoutMs = 8000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (!this.open) return { ok: false, why: 'browser session closed' };
      // eslint-disable-next-line no-await-in-loop -- polling the page is the
      // only way to wait for arbitrary DOM; the deadline is the caller's.
      const el = await this.element(selector);
      if (el.ok && el.value && el.value.exists) return { ok: true, why: `${selector} appeared` };
      if (Date.now() >= deadline) return { ok: false, why: `${selector} did not appear within ${timeoutMs}ms` };
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** A PNG of the page, as a Buffer, or null with the reason. */
  async screenshot() {
    try {
      const r = await this.conn.send('Page.captureScreenshot', { format: 'png' }, 20000);
      if (!r || !r.data) return { ok: false, why: 'the browser returned no image data' };
      return { ok: true, buffer: Buffer.from(r.data, 'base64') };
    } catch (e) {
      return { ok: false, why: `the screenshot failed: ${(e && e.message) || e}` };
    }
  }

  close(why = 'closed by the harness') {
    if (this._loads) for (const finish of [...this._loads]) finish(false);
    if (this.conn) this.conn.close(why);
  }
}

function axRow(n) {
  return {
    role: n.role && n.role.value,
    name: n.name && n.name.value,
    disabled: Boolean((n.properties || []).find((p) => p.name === 'disabled' && p.value && p.value.value)),
    ignored: Boolean(n.ignored),
  };
}

module.exports = {
  BrowserSession, available, findBrowser, candidates,
  DEFAULT_PORT, NAV_TIMEOUT_MS, LAUNCH_TIMEOUT_MS, axRow,
};
