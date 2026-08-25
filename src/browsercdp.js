'use strict';

/**
 * THE ONE BROWSER ADAPTER — Chrome DevTools Protocol, spoken directly.
 *
 * This is the only file in LAIN that knows how a browser is driven. Everything
 * above it (browser.js) talks in terms of open / screenshot / click / type, and
 * would keep working if this were replaced by a Playwright adapter tomorrow.
 * That boundary is the point: browser automation libraries are large, they move
 * fast, and a program that spreads their API through its command handlers has
 * married one of them.
 *
 * ------------------------------------------------------------------------
 * WHY THERE IS NO DEPENDENCY HERE AT ALL.
 *
 * Puppeteer and Playwright are, at the layer LAIN needs, a WebSocket and a
 * JSON-RPC dialect. Node 22 shipped a global `WebSocket`; the dialect is
 * documented; and LAIN is a zero-dependency program whose whole security story
 * is that you can read everything it runs. Adding ~300MB of transitive
 * dependency — which downloads its own browser binary from the network at
 * install time — to send `Page.captureScreenshot` would be the single largest
 * change to this program's trust surface, and it would buy a convenience layer
 * over about two hundred lines.
 *
 * WHAT IS GIVEN UP, honestly: the ergonomics. No auto-waiting, no frame
 * juggling, no selector engine beyond what the page itself provides. Those are
 * real, and if this seam ever needs them the adapter is the thing to replace —
 * not the callers.
 *
 * ------------------------------------------------------------------------
 * THE BROWSER IS NOT THE USER'S BROWSER. This launches a separate process with
 * its own `--user-data-dir`, and there is deliberately no code path that
 * attaches to a running one: connecting to an existing browser would put LAIN
 * inside the user's logged-in session, with their cookies, on their tabs. See
 * browser.js for the profile, and the header there for the rest of the rule.
 *
 * THE DEBUGGING PORT IS LOOPBACK ONLY. Chromium binds `--remote-debugging-port`
 * to 127.0.0.1 unless told otherwise, and nothing here tells it otherwise. A
 * debugging port reachable from the network is a remote code execution surface.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/** How long to wait for the browser to announce its endpoint. */
const LAUNCH_TIMEOUT_MS = 20000;
/** How long any one protocol command may take. */
const CALL_TIMEOUT_MS = 30000;

/**
 * WHERE A CHROMIUM MIGHT BE, in the order worth trying.
 *
 * LAIN ships no browser: downloading a ~150MB binary on first use is exactly
 * the kind of thing a coding CLI should not do behind your back. It uses one
 * that is already installed — with its OWN profile, which is what keeps it
 * separate from the user's session. Edge is included because on Windows it is
 * always present and is the same engine.
 */
function candidates() {
  const env = process.env;
  if (process.platform === 'win32') {
    const pf = env['ProgramFiles'] || 'C:\\Program Files';
    const px = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = env.LOCALAPPDATA || '';
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(px, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      la && path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(px, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}

/** The first Chromium on this machine, or null with everywhere that was tried. */
function findBrowser(explicit = null) {
  const tried = [];
  const list = explicit ? [explicit, ...candidates()] : candidates();
  for (const p of list) {
    tried.push(p);
    try { if (fs.existsSync(p)) return { ok: true, path: p, tried }; } catch { /* keep looking */ }
  }
  return { ok: false, path: null, tried };
}

/**
 * A live protocol connection to one browser process.
 *
 * Deliberately thin: `send` is the whole API, and every capability above is
 * built out of it. Nothing here retries, and nothing here decides policy.
 */
class CdpSession {
  constructor(child, wsUrl) {
    this.child = child;
    this.wsUrl = wsUrl;
    this.ws = null;
    this.sessionId = null;
    this.targetId = null;
    this._seq = 0;
    this._pending = new Map();
    this._events = [];
  }

  /** Open the socket. Never throws; a failure comes back as `{ok:false}`. */
  connect() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      try { this.ws = new WebSocket(this.wsUrl); }
      catch (e) { done({ ok: false, error: `could not open the protocol socket: ${e.message}` }); return; }

      const timer = setTimeout(() => done({ ok: false, error: 'the browser did not accept a protocol connection' }), LAUNCH_TIMEOUT_MS);
      if (timer.unref) timer.unref();

      this.ws.addEventListener('open', () => { clearTimeout(timer); done({ ok: true }); });
      this.ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        done({ ok: false, error: `protocol socket error: ${(e && e.message) || 'unknown'}` });
      });
      this.ws.addEventListener('close', () => {
        for (const [, p] of this._pending) p({ error: { message: 'the browser closed the connection' } });
        this._pending.clear();
      });
      this.ws.addEventListener('message', (ev) => this._onMessage(String(ev.data)));
    });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const resolve = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      resolve(msg);
      return;
    }
    // Events are kept, bounded, for the few things that need them (load).
    if (msg.method) {
      this._events.push(msg);
      if (this._events.length > 200) this._events.shift();
    }
  }

  /**
   * One protocol command.
   *
   * `sessionId` is attached automatically once a page is attached, so callers
   * never carry it: a command sent to the browser instead of the page fails in
   * a way that reads like the page is broken.
   */
  send(method, params = {}, { timeoutMs = CALL_TIMEOUT_MS, browserLevel = false } = {}) {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== 1) { resolve({ error: { message: 'the browser is not connected' } }); return; }
      const id = ++this._seq;
      const payload = { id, method, params };
      if (!browserLevel && this.sessionId) payload.sessionId = this.sessionId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ error: { message: `${method} did not answer within ${Math.round(timeoutMs / 1000)}s` } });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this._pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { clearTimeout(timer); this._pending.delete(id); resolve({ error: { message: e.message } }); }
    });
  }

  /**
   * The events already received, of the given kinds.
   *
   * `Runtime.enable` is sent at attach, so `Runtime.consoleAPICalled` and
   * `Runtime.exceptionThrown` have been landing in this buffer since the page
   * opened — the browser's own record of what went wrong was being collected
   * and thrown away. This is the reader for it. Bounded by the same 200-event
   * ring as everything else, so a page that logs in a loop cannot grow it.
   */
  eventsOf(methods) {
    const want = new Set(Array.isArray(methods) ? methods : [methods]);
    return this._events.filter((e) => want.has(e.method));
  }

  /** Wait for one event, or time out. Used for page loads and nothing else. */
  waitFor(method, timeoutMs = CALL_TIMEOUT_MS) {
    const seen = this._events.length;
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        for (let i = seen; i < this._events.length; i++) {
          if (this._events[i].method === method) { resolve({ ok: true, event: this._events[i] }); return; }
        }
        if (Date.now() - started > timeoutMs) { resolve({ ok: false }); return; }
        const t = setTimeout(tick, 50);
        if (t.unref) t.unref();
      };
      tick();
    });
  }

  close() {
    try { if (this.ws) this.ws.close(); } catch { /* already gone */ }
    this.ws = null;
  }
}

/**
 * Launch a browser with an isolated profile and attach to a fresh page.
 *
 * @param {object} o
 *   profileDir  the user-data-dir. REQUIRED — there is no default, because a
 *               default is how something ends up in the real profile.
 *   headless    run without a window (tests); default false, because the point
 *               of this browser is that a person can see and use it.
 *   binary      an explicit browser path, when the search would pick wrong.
 * @returns {{ok, session?, child?, binary?, error?, tried?}}
 */
async function launch({ profileDir, headless = false, binary = null, args = [] } = {}) {
  if (!profileDir) return { ok: false, error: 'a profile directory is required' };
  const found = findBrowser(binary);
  if (!found.ok) {
    return {
      ok: false,
      error: 'no Chromium-based browser was found on this machine',
      tried: found.tried,
    };
  }
  try { fs.mkdirSync(profileDir, { recursive: true }); }
  catch (e) { return { ok: false, error: `could not create the browser profile directory: ${e.message}` }; }

  const argv = [
    // THE ISOLATION, and the first argument for that reason.
    `--user-data-dir=${profileDir}`,
    // Port 0 lets the OS choose; the real one is read from the browser's own
    // announcement. A fixed port collides with a second LAIN, and worse, makes
    // the surface predictable.
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    // No crash bubbles, no restore prompts, no background phoning home from a
    // profile that exists only to be automated.
    '--disable-session-crashed-bubble',
    '--disable-background-networking',
    '--disable-sync',
    '--no-service-autorun',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    ...args,
    'about:blank',
  ];

  let child;
  try {
    child = spawn(found.path, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  } catch (e) {
    return { ok: false, error: `could not start ${path.basename(found.path)}: ${e.message}` };
  }

  // THE ENDPOINT COMES FROM THE BROWSER ITSELF, on stderr. Reading it from the
  // profile's DevToolsActivePort file is the other way and races with startup.
  const wsUrl = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(null), LAUNCH_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    const onData = (d) => {
      buf += String(d);
      const m = /ws:\/\/[^\s]+/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    child.stderr.on('data', onData);
    child.on('exit', () => { clearTimeout(timer); resolve(null); });
  });

  if (!wsUrl) {
    try { child.kill(); } catch { /* already gone */ }
    return { ok: false, error: 'the browser started but never announced a debugging endpoint', binary: found.path };
  }

  const session = new CdpSession(child, wsUrl);
  const opened = await session.connect();
  if (!opened.ok) {
    try { child.kill(); } catch { /* already gone */ }
    return { ok: false, error: opened.error, binary: found.path };
  }

  // One page, created and attached FLAT so every later command carries its
  // session id automatically.
  const created = await session.send('Target.createTarget', { url: 'about:blank' }, { browserLevel: true });
  if (!created.result) {
    session.close();
    try { child.kill(); } catch { /* already gone */ }
    return { ok: false, error: `could not open a page: ${(created.error || {}).message || 'unknown'}`, binary: found.path };
  }
  session.targetId = created.result.targetId;
  const attached = await session.send('Target.attachToTarget',
    { targetId: session.targetId, flatten: true }, { browserLevel: true });
  if (!attached.result) {
    session.close();
    try { child.kill(); } catch { /* already gone */ }
    return { ok: false, error: `could not attach to the page: ${(attached.error || {}).message || 'unknown'}`, binary: found.path };
  }
  session.sessionId = attached.result.sessionId;
  await session.send('Page.enable');
  await session.send('Runtime.enable');

  return { ok: true, session, child, binary: found.path, wsUrl };
}

module.exports = { launch, findBrowser, candidates, CdpSession, LAUNCH_TIMEOUT_MS, CALL_TIMEOUT_MS };
