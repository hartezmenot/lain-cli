'use strict';

/**
 * LAIN'S OWN BROWSER — a separate Chromium, a separate profile, never yours.
 *
 *     LAIN → BrowserRuntime → (browsercdp.js) → a Chromium process it started
 *
 * WHY THIS EXISTS. The BROWSER actor used to call `start <url>`, which hands
 * the URL to whatever browser the machine considers default — the user's, with
 * their tabs, their logins and their forty other windows. That is unusable as
 * an execution surface for four separate reasons, all of which are the same
 * reason:
 *
 *   · LAIN cannot tell its own window from the user's, so it cannot observe one
 *   · it cannot interact without risking a click in somebody's real session
 *   · it cannot isolate cookies or storage, so evidence has no provenance
 *   · and the user's browsing is disturbed by an agent doing its work
 *
 * A browser LAIN starts, with a profile LAIN owns, has none of those problems.
 *
 * ------------------------------------------------------------------------
 * WHAT IT WILL NOT DO, and these are rules rather than omissions:
 *
 *   NEVER THE USER'S PROFILE.   There is no code path that points
 *     `--user-data-dir` anywhere but `~/.lain-v2/browser/profile`, and no path
 *     that attaches to a browser LAIN did not start. Attaching to a running
 *     browser would put LAIN inside a logged-in session.
 *   NEVER CREDENTIALS.          Nothing reads cookies, localStorage, saved
 *     passwords or the credential store, and nothing copies them into a
 *     session, a transcript or a request. If a site needs a login, the person
 *     logs in — in the window, themselves. See `open()`.
 *   NEVER THE NETWORK.          The debugging port is loopback, chosen by the
 *     OS, and never advertised. See browsercdp.js.
 *   NEVER SILENTLY.             Every navigation and interaction is recorded in
 *     `activity`, which OUTPUT draws, so what the browser did is auditable.
 *
 * ------------------------------------------------------------------------
 * A SCREENSHOT IS NOT A VERIFICATION. This produces MACHINE evidence with a
 * BROWSER provenance — a capture exists, a DOM query returned this rectangle,
 * the URL is that. Whether the page LOOKS right is a judgment no machine here
 * makes: it goes to the bounded human workflow in visual.js, and until somebody
 * has actually looked the answer stays NOT VISUALLY VERIFIED.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const cdp = require('./browsercdp');

/**
 * THE LIFECYCLE, NAMED. Every one of these is a different thing to be waiting
 * for, and collapsing them into "TOOL RUNNING" is how a person stops being able
 * to tell "LAIN is working" from "LAIN is waiting for me".
 */
const STATE = Object.freeze({
  NOT_STARTED: 'NOT_STARTED',
  STARTING: 'STARTING',
  READY: 'READY',
  NAVIGATING: 'NAVIGATING',
  LOADING: 'LOADING',
  INSPECTING: 'INSPECTING',
  INTERACTING: 'INTERACTING',
  WAITING: 'WAITING',
  FAILED: 'FAILED',
  STOPPED: 'STOPPED',
});

/** States in which the runtime can accept work. */
const USABLE = new Set([STATE.READY, STATE.NAVIGATING, STATE.LOADING, STATE.INSPECTING, STATE.INTERACTING, STATE.WAITING]);

function home() {
  try { return require('./config').configDir(); } catch { return path.join(os.homedir(), '.lain-v2'); }
}

/** `~/.lain-v2/browser/{profile,screenshots,artifacts,logs}` */
/**
 * @param {string} profile  WHICH profile, so two providers do not share one.
 *
 * A single shared profile was right while there was one page. It is wrong the
 * moment ChatGPT and Gemini are both driven: one profile means one cookie jar
 * and one set of tabs, so the two would log in over each other and their
 * conversations would be at risk of being confused for one another. A profile
 * per provider costs a directory and makes the separation structural rather
 * than something to remember.
 *
 * Screenshots, artifacts and logs stay SHARED — they are LAIN's record of what
 * it did, not the provider's session state.
 */
function dirs(profile = 'profile') {
  const root = path.join(home(), 'browser');
  const safe = String(profile || 'profile').replace(/[^A-Za-z0-9._-]/g, '-') || 'profile';
  return {
    root,
    profile: safe === 'profile' ? path.join(root, 'profile') : path.join(root, 'profiles', safe),
    screenshots: path.join(root, 'screenshots'),
    artifacts: path.join(root, 'artifacts'),
    logs: path.join(root, 'logs'),
  };
}

/**
 * THE ONE LIVE RUNTIME, for the tool registry.
 *
 * `tools/index.js` decides what the model is offered and is called from turn.js
 * with no App to ask — the same reason it consults `probe` this way. A running
 * browser registers itself here and clears itself on the way down, so the
 * vocabulary follows the PROCESS rather than the configuration: a model told it
 * can drive a browser that is not running will try.
 */
let _live = null;

/** The running browser, or null. Never a stopped one. */
function live() { return _live && _live.running ? _live : null; }

/**
 * One browser, owned by LAIN.
 *
 * Started on demand and never at launch: a Chromium that opens because you ran
 * a coding CLI is a Chromium nobody asked for.
 */
class BrowserRuntime {
  constructor(cfg = {}, { profile = 'profile' } = {}) {
    this.cfg = cfg || {};
    /**
     * WHICH PROFILE THIS RUNTIME OWNS.
     *
     * Defaults to the shared one, so every existing caller — the `browser`
     * tool, `/external browser`, imageview — behaves exactly as before. A
     * named profile is how two providers get separate logins and separate
     * conversations instead of overwriting one another's.
     */
    this.profileName = String(profile || 'profile');
    this.state = STATE.NOT_STARTED;
    this.reason = 'not started';
    this.session = null;
    this.child = null;
    this.binary = null;
    this.url = null;
    /** Bounded record of what the browser actually did. OUTPUT draws this. */
    this.activity = [];
    this.startedAt = null;
  }

  _note(text, ok = true) {
    this.activity.push({ at: Date.now(), text: String(text).slice(0, 200), ok });
    if (this.activity.length > 100) this.activity.shift();
    return this.activity[this.activity.length - 1];
  }

  _to(state, reason = '') {
    this.state = state;
    this.reason = String(reason || '');
    return this;
  }

  get running() { return USABLE.has(this.state) && Boolean(this.session); }

  /**
   * Start Chromium with LAIN's own profile.
   *
   * Idempotent: calling it while running is a no-op that reports READY, so a
   * caller never has to track whether it started one already.
   */
  async start({ headless = false } = {}) {
    if (this.running) return { ok: true, state: this.state, binary: this.binary, already: true };
    this._to(STATE.STARTING, 'launching');
    const d = dirs(this.profileName);
    const opts = this.cfg.browser || {};
    const r = await cdp.launch({
      profileDir: d.profile,
      headless: headless || opts.headless === true,
      binary: opts.binary || null,
    });
    if (!r.ok) {
      this._to(STATE.FAILED, r.error);
      this._note(`could not start: ${r.error}`, false);
      return { ok: false, state: this.state, error: r.error, tried: r.tried || null };
    }
    this.session = r.session;
    this.child = r.child;
    this.binary = r.binary;
    this.startedAt = Date.now();
    this.child.on('exit', () => {
      if (this.state !== STATE.STOPPED) this._to(STATE.FAILED, 'the browser exited');
      this.session = null;
    });
    this._to(STATE.READY, '');
    // ONLY THE DEFAULT PROFILE BECOMES `live`. `live()` decides whether the
    // model is offered the `browser` tool, and that tool drives `app._browser`.
    // A provider's own runtime starting would otherwise advertise a tool
    // pointing at a browser that is not the one the model would get.
    if (this.profileName === 'profile') _live = this;
    this._note(`started ${path.basename(this.binary)} with LAIN's own profile`);
    return { ok: true, state: this.state, binary: this.binary, profile: d.profile, pid: this.child.pid };
  }

  /**
   * Navigate, and wait for the page to actually load.
   *
   * ABOUT LOGGING IN: if the page asks for credentials, that is the person's to
   * do, in this window, with their own hands. Nothing here fills a form, reads
   * a cookie, or carries a secret anywhere. The profile persists between runs
   * precisely so they only have to do it once.
   */
  async open(url) {
    if (!this.running) return { ok: false, state: this.state, error: 'the browser is not running' };
    const target = String(url || '').trim();
    if (!target) return { ok: false, error: 'open needs a URL' };
    this._to(STATE.NAVIGATING, target);
    const nav = await this.session.send('Page.navigate', { url: target });
    if (!nav.result || nav.result.errorText) {
      const why = (nav.result && nav.result.errorText) || (nav.error && nav.error.message) || 'navigation failed';
      this._to(STATE.READY);
      this._note(`open ${target} — ${why}`, false);
      return { ok: false, error: why, url: target };
    }
    this._to(STATE.LOADING, target);
    await this.session.waitFor('Page.loadEventFired', 20000);
    this.url = target;
    this._to(STATE.READY);
    this._note(`open ${target}`);
    const info = await this.pageInfo();
    return { ok: true, url: target, title: info.title || null, finalUrl: info.url || target };
  }

  /** Title, URL and size — the cheapest true things about the page. */
  async pageInfo() {
    if (!this.running) return { ok: false, error: 'the browser is not running' };
    const r = await this.session.send('Runtime.evaluate', {
      expression: '({title:document.title,url:location.href,'
        + 'width:innerWidth,height:innerHeight,ready:document.readyState})',
      returnByValue: true,
    });
    const v = r.result && r.result.result && r.result.result.value;
    return v ? { ok: true, ...v } : { ok: false, error: 'the page did not answer' };
  }

  /**
   * A screenshot, written to LAIN's own screenshots directory.
   *
   * Returned as a PATH, never as base64 in a tool result: a 300KB image encoded
   * into a model's context is a large bill for something the model cannot see.
   * The path goes to the visual workflow, which shows it to a person.
   */
  async screenshot(name = null) {
    if (!this.running) return { ok: false, error: 'the browser is not running' };
    this._to(STATE.INSPECTING, 'screenshot');
    const r = await this.session.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 30000 });
    this._to(STATE.READY);
    const data = r.result && r.result.data;
    if (!data) return { ok: false, error: (r.error && r.error.message) || 'no image came back' };
    const d = dirs();
    const file = path.join(d.screenshots, `${name || `shot-${Date.now()}`}.png`);
    try {
      fs.mkdirSync(d.screenshots, { recursive: true });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    } catch (e) { return { ok: false, error: `could not save the screenshot: ${e.message}` }; }
    const bytes = fs.statSync(file).size;
    this._note(`screenshot ${path.basename(file)} (${Math.round(bytes / 1024)} KB)`);
    return { ok: true, file, bytes };
  }

  /**
   * What is actually on the page, by selector — MACHINE evidence with a
   * BROWSER provenance.
   *
   * Returns the rectangle, the text and whether it is visible. That is what
   * answers "did the button move" without anybody looking at a picture, and it
   * is the half of visual verification a machine can genuinely do.
   */
  /**
   * RUN AN EXPRESSION IN THE PAGE AND BRING BACK A VALUE.
   *
   * Exists so that the CDP result shape — `r.result.result.value`, three
   * `result`s deep and easy to get wrong — is known in exactly one place. It
   * was got wrong the first time somebody outside this file reached for it
   * (src/research.js, extracting search results), which returned `undefined`
   * and reported the page as unreadable rather than as misread.
   *
   * NOT A GENERAL ESCAPE HATCH for the model: no tool exposes this. It is for
   * the readers in this codebase that need a value out of a page and would
   * otherwise each carry their own copy of the unwrapping.
   */
  async evaluate(expression) {
    if (!this.session) return { ok: false, error: 'the browser is not connected' };
    const r = await this.session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r && r.error) return { ok: false, error: r.error.message || 'the page did not answer' };
    const res = r && r.result && r.result.result;
    // A THROWN EXCEPTION IS NOT AN EMPTY ANSWER. Without this an expression
    // that raised came back indistinguishable from one that returned nothing.
    if (r && r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { ok: false, error: (d.exception && d.exception.description) || d.text || 'the expression threw' };
    }
    if (!res || !('value' in res)) return { ok: false, error: 'the page returned no value' };
    return { ok: true, value: res.value };
  }

  async inspect(selector) {
    if (!this.running) return { ok: false, error: 'the browser is not running' };
    const sel = String(selector || '').trim();
    if (!sel) return { ok: false, error: 'inspect needs a CSS selector' };
    this._to(STATE.INSPECTING, sel);
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        found: true,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 200),
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0,
        viewport: { width: innerWidth, height: innerHeight },
      };
    })()`;
    const r = await this.session.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    this._to(STATE.READY);
    const v = r.result && r.result.result && r.result.result.value;
    if (!v) return { ok: false, error: (r.error && r.error.message) || 'the page did not answer' };
    this._note(`inspect ${sel} — ${v.found ? 'found' : 'no such element'}`, v.found);
    return { ok: true, selector: sel, ...v };
  }

  /**
   * MEASURE an element — the numbers, against the numbers that were expected.
   *
   * `inspect` answers "where is it". This answers "is it where it should be,
   * and by how much is it not", which is the question a layout change actually
   * raises. A model cannot see a page, and a description of one written from
   * its source is a guess; a delta of `x: +43` is a fact, and it points at a
   * width, a margin or a flex property rather than at a feeling.
   *
   * The computed styles come back with it because the rectangle says WHAT is
   * wrong and the styles say WHY: an element 43px right of where it belongs,
   * with `margin-left: 43px`, is a solved problem in one call.
   */
  async measure(selector, expected = null) {
    if (!this.running) return { ok: false, error: 'the browser is not running' };
    const sel = String(selector || '').trim();
    if (!sel) return { ok: false, error: 'measure needs a CSS selector' };
    this._to(STATE.INSPECTING, sel);
    // The properties that decide where a box lands and whether it is seen. A
    // full computed style is ~340 declarations, almost all of them inherited
    // defaults, and sending that into a context window is a large bill for a
    // handful of useful numbers.
    const PROPS = ['display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
      'margin', 'padding', 'border-width', 'box-sizing', 'flex', 'flex-direction', 'align-items',
      'justify-content', 'grid-template-columns', 'gap', 'overflow', 'z-index', 'opacity',
      'visibility', 'font-size', 'line-height', 'color', 'background-color', 'transform'];
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return { found: false, viewport: { width: innerWidth, height: innerHeight } };
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const style = {};
      for (const p of ${JSON.stringify(PROPS)}) style[p] = s.getPropertyValue(p);
      const parent = el.parentElement;
      const pr = parent ? parent.getBoundingClientRect() : null;
      return {
        found: true,
        tag: el.tagName.toLowerCase(),
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
                right: Math.round(r.right), bottom: Math.round(r.bottom) },
        parentRect: pr ? { x: Math.round(pr.x), y: Math.round(pr.y), width: Math.round(pr.width), height: Math.round(pr.height) } : null,
        style,
        overflowing: r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1,
        visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0,
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio: devicePixelRatio,
      };
    })()`;
    const r = await this.session.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    this._to(STATE.READY);
    const v = r.result && r.result.result && r.result.result.value;
    if (!v) return { ok: false, error: (r.error && r.error.message) || 'the page did not answer' };
    let delta = null;
    if (v.found && expected && typeof expected === 'object') {
      delta = {};
      for (const k of ['x', 'y', 'width', 'height']) {
        if (expected[k] == null) continue;
        delta[k] = v.rect[k] - Number(expected[k]);
      }
    }
    this._note(`measure ${sel} — ${v.found ? `${v.rect.width}x${v.rect.height} at ${v.rect.x},${v.rect.y}` : 'no such element'}`, v.found);
    return { ok: true, selector: sel, delta, ...v };
  }

  /**
   * WHAT THE PAGE ITSELF REPORTED — console messages and uncaught exceptions.
   *
   * The browser has been recording these since the page opened, and nothing was
   * reading them. A model diagnosing "the button does nothing" was reasoning
   * from source code while a `TypeError` with a file and a line number sat one
   * call away. This is the runtime evidence the diagnosis should start from.
   */
  consoleLog({ limit = 40, errorsOnly = false } = {}) {
    if (!this.running) return { ok: false, error: 'the browser is not running' };
    const raw = this.session.eventsOf(['Runtime.consoleAPICalled', 'Runtime.exceptionThrown']);
    const out = [];
    for (const e of raw) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = (e.params && e.params.exceptionDetails) || {};
        out.push({
          level: 'exception',
          text: (d.exception && (d.exception.description || d.exception.value)) || d.text || 'uncaught exception',
          url: d.url || null,
          line: d.lineNumber != null ? d.lineNumber + 1 : null,
          column: d.columnNumber != null ? d.columnNumber + 1 : null,
        });
        continue;
      }
      const p = e.params || {};
      const level = p.type === 'warning' ? 'warn' : String(p.type || 'log');
      if (errorsOnly && level !== 'error' && level !== 'exception') continue;
      const text = (p.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type || '')))
        .join(' ').slice(0, 400);
      const frame = p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0];
      out.push({
        level,
        text,
        url: frame ? frame.url : null,
        line: frame && frame.lineNumber != null ? frame.lineNumber + 1 : null,
        column: frame && frame.columnNumber != null ? frame.columnNumber + 1 : null,
      });
    }
    const kept = out.slice(-Math.max(1, limit));
    return {
      ok: true,
      messages: kept,
      total: out.length,
      errors: out.filter((m) => m.level === 'error' || m.level === 'exception').length,
    };
  }

  /**
   * ATTACH REAL FILES TO A FILE INPUT — the primitive that was missing.
   *
   * WHY THIS EXISTS. LAIN could type into a chat page and could not give it a
   * picture. An image reached the model as a DESCRIPTION — `photo.png 1920×1080
   * · NOT SEEN` — which is honest (see ui/images.js: LAIN deliberately refuses
   * to fabricate an ASCII stand-in) and completely useless to a vision model.
   * The image was not being degraded; it was being omitted, because no code
   * path turned a file on disk into an attachment on a page.
   *
   * `DOM.setFileInputFiles` is that path, and it is the only honest one: it
   * puts REAL FILES on a REAL `<input type=file>`, exactly as the operating
   * system's file chooser would. Nothing is encoded, transcoded, screenshotted
   * or approximated — the bytes the page uploads are the bytes on disk.
   *
   * EVERY FILE IS CHECKED FIRST. A path that does not exist is refused before
   * anything is sent, because a silent partial attach is the failure mode that
   * looks like success: the message goes, the picture does not, and the reply
   * is about nothing.
   */
  async attach(selector, files) {
    if (!this.running) return { ok: false, error: 'the browser is not running' };
    const list = (Array.isArray(files) ? files : [files]).map((f) => String(f || '')).filter(Boolean);
    if (!list.length) return { ok: false, error: 'attach needs at least one file' };
    const missing = list.filter((f) => { try { return !fs.existsSync(f); } catch { return true; } });
    if (missing.length) {
      return { ok: false, error: `no such file: ${missing.join(', ')} — nothing was attached` };
    }
    const sel = String(selector || '').trim();
    if (!sel) return { ok: false, error: 'attach needs a CSS selector for the file input' };

    this._to(STATE.INTERACTING, `attach ${list.length} file(s)`);
    // The node has to be resolved through the DOM domain: setFileInputFiles
    // takes a nodeId, not a selector.
    const doc = await this.session.send('DOM.getDocument', { depth: 1 });
    const root = doc.result && doc.result.root && doc.result.root.nodeId;
    if (!root) { this._to(STATE.READY); return { ok: false, error: 'the page did not return a document' }; }
    const found = await this.session.send('DOM.querySelector', { nodeId: root, selector: sel });
    const nodeId = found.result && found.result.nodeId;
    if (!nodeId) {
      this._to(STATE.READY);
      return { ok: false, error: `no element matches ${sel} — nothing was attached` };
    }
    const set = await this.session.send('DOM.setFileInputFiles', { nodeId, files: list });
    this._to(STATE.READY);
    if (set.error) {
      this._note(`attach ${sel} — ${set.error.message}`, false);
      return { ok: false, error: set.error.message, selector: sel };
    }
    this._note(`attached ${list.length} file(s) to ${sel}`);
    return { ok: true, selector: sel, files: list, count: list.length };
  }

  /**
   * The page's file input, if it has one.
   *
   * Chat pages hide it behind a button, so it is usually present but not
   * visible — which is why this does NOT require visibility the way `compose`
   * does. A hidden input still accepts files.
   */
  async fileInput() {
    if (!this.running) return null;
    for (const sel of ['input[type="file"]', 'input[type=file]']) {
      const doc = await this.session.send('DOM.getDocument', { depth: 1 });
      const root = doc.result && doc.result.root && doc.result.root.nodeId;
      if (!root) return null;
      const found = await this.session.send('DOM.querySelector', { nodeId: root, selector: sel });
      if (found.result && found.result.nodeId) return sel;
    }
    return null;
  }

  /**
   * Click an element, by selector, through REAL INPUT EVENTS.
   *
   * `el.click()` would be simpler and would be a lie: it fires a synthetic
   * event that skips hit-testing, so it "succeeds" on an element covered by a
   * modal, scrolled out of view, or behind an overlay. Dispatching a mouse
   * event at the element's own coordinates is what the user's click would do,
   * including failing when the user's click would fail.
   */
  async click(selector) {
    const at = await this.inspect(selector);
    if (!at.ok) return at;
    if (!at.found) return { ok: false, error: `no element matches ${selector}`, selector };
    if (!at.visible) return { ok: false, error: `${selector} is not visible, so a click would not reach it`, selector };
    this._to(STATE.INTERACTING, `click ${selector}`);
    const x = at.rect.x + Math.floor(at.rect.width / 2);
    const y = at.rect.y + Math.floor(at.rect.height / 2);
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    const up = await this.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    this._to(STATE.READY);
    if (up.error) { this._note(`click ${selector} — ${up.error.message}`, false); return { ok: false, error: up.error.message }; }
    this._note(`click ${selector} at (${x}, ${y})`);
    return { ok: true, selector, at: { x, y } };
  }

  /** Focus an element and type into it, one key event at a time. */
  async type(selector, text) {
    const clicked = await this.click(selector);
    if (!clicked.ok) return clicked;
    this._to(STATE.INTERACTING, `type into ${selector}`);
    const s = String(text == null ? '' : text);
    for (const ch of s) {
      await this.session.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
    }
    this._to(STATE.READY);
    this._note(`type ${s.length} character(s) into ${selector}`);
    return { ok: true, selector, typed: s.length };
  }

  /** A named key — Enter, Tab, Escape — as a real key event. */
  async key(name) {
    if (!this.running) return { ok: false, error: 'the browser is not running' };
    const KEYS = {
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    };
    const k = KEYS[name];
    if (!k) return { ok: false, error: `unknown key "${name}". Known: ${Object.keys(KEYS).join(', ')}` };
    this._to(STATE.INTERACTING, `key ${name}`);
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    this._to(STATE.READY);
    this._note(`key ${name}`);
    return { ok: true, key: name };
  }

  /** Wait for a selector to exist, or say plainly that it never did. */
  async wait(selector, timeoutMs = 10000) {
    if (!this.running) return { ok: false, error: 'the browser is not running' };
    this._to(STATE.WAITING, selector);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const at = await this.inspect(selector);
      if (at.ok && at.found) { this._to(STATE.READY); return { ok: true, selector, waitedMs: Date.now() - started }; }
      await new Promise((r) => { const t = setTimeout(r, 200); if (t.unref) t.unref(); });
    }
    this._to(STATE.READY);
    this._note(`wait ${selector} — never appeared`, false);
    return { ok: false, selector, error: `${selector} did not appear within ${Math.round(timeoutMs / 1000)}s` };
  }

  /** Stop the browser. The profile survives, so a login is not repeated. */
  stop(why = 'stopped') {
    // Withdraw the capability BEFORE anything else: a tool offered by a browser
    // that is going away is worse than one never offered.
    if (_live === this) _live = null;
    if (this.session) this.session.close();
    if (this.child) { try { this.child.kill(); } catch { /* already gone */ } }
    this.session = null;
    this.child = null;
    this._to(STATE.STOPPED, why);
    this._note(`stopped — ${why}`);
    return { ok: true, state: this.state };
  }

  /** Everything a status surface may say. Never claims more than is true. */
  status() {
    const d = dirs();
    return {
      state: this.state,
      reason: this.reason,
      running: this.running,
      binary: this.binary,
      profile: d.profile,
      isolated: true,
      url: this.url,
      pid: this.child ? this.child.pid : null,
      upMs: this.startedAt ? Date.now() - this.startedAt : 0,
      activity: this.activity.slice(-20),
    };
  }
}

/**
 * WIPE LAIN'S OWN BROWSER PROFILE.
 *
 * For tests, which must not inherit cookies, history or storage from a previous
 * run — a browser test that passes because of state left behind by an earlier
 * one is not a test.
 *
 * IT REFUSES TO DELETE ANYTHING THAT IS NOT LAIN'S. The path is recomputed from
 * `dirs()` and checked to be under the config home before a single byte is
 * removed. A profile path that is wrong by one bug is somebody's real browser
 * data, and the cost of that mistake is not recoverable.
 */
function clearProfile() {
  const d = dirs();
  const target = path.resolve(d.profile);
  const home = path.resolve(d.root);
  if (!target.startsWith(home) || path.basename(target) !== 'profile') {
    return { ok: false, why: "refusing to delete a path that is not LAIN's own profile" };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true, cleared: target };
  } catch (e) { return { ok: false, why: e.message }; }
}

/**
 * THE RUNTIME FOR ONE PROVIDER, created once and REUSED.
 *
 * This is what makes a conversation continuous. The browser actor used to call
 * `open(url)` on every round, and the default URL carried
 * `?temporary-chat=true` — so each round deliberately started a NEW chat and
 * the provider had no memory of the last one. The packet compensated by
 * restating context, which is the mechanised version of copying and pasting.
 *
 * Holding the runtime per provider means the page stays where it is: the second
 * message goes into the same conversation, because nothing navigated away.
 *
 * Kept on the APP, not at module scope — two sessions in one process must not
 * share a browser, and module-level session state is what the guard forbids.
 */
function runtimeFor(app, provider = 'profile') {
  if (!app) return null;
  if (!app._browsers) app._browsers = new Map();
  const key = String(provider || 'profile');
  if (!app._browsers.has(key)) {
    const rt = new BrowserRuntime(app.cfg || {}, { profile: key });
    app._browsers.set(key, rt);
    // The default profile IS the `browser` tool's runtime, so the tool and the
    // external actor share one browser rather than starting two.
    if (key === 'profile' && !app._browser) app._browser = rt;
  }
  return app._browsers.get(key);
}

module.exports = {
  BrowserRuntime, STATE, USABLE, dirs, live, clearProfile, runtimeFor, findBrowser: cdp.findBrowser,
};
