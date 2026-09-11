'use strict';

/**
 * THE BROWSER HARNESS CONTROLLER — sessions, flows, and the artifacts they leave.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS ADDS OVER harness/browser.js.
 *
 * That file is one page and what can be asked of it. This owns the things that
 * are not about a page: getting a browser at all, deciding between attaching to
 * one that is already open and launching one, keeping the session alive across
 * several checks of the same contract, filing the screenshots and console dumps
 * as artifacts, and closing everything when the task ends.
 *
 * ------------------------------------------------------------------------
 * A LAUNCHED BROWSER IS A MANAGED PROCESS, AND THAT IS NOT A DETAIL.
 *
 * It goes through the ProcessManager, owned by the task, so `cleanup(taskId)`
 * takes it down with everything else. A browser launched outside that ownership
 * is exactly the shape of the ninety orphaned processes this repository already
 * paid for once — headless Chrome is especially good at surviving unnoticed,
 * because nothing appears on screen to remind anybody it is there.
 *
 * ------------------------------------------------------------------------
 * THE TWO MODES, AND WHY BOTH EXIST.
 *
 * SIMPLE: the caller asks one thing — read this element, capture this page —
 * and gets an answer. That is `observe`, and it is what the observation router
 * calls.
 *
 * DELEGATED: the caller hands over a whole flow with a goal, a URL, an allowed
 * set of actions, a time limit and a verification contract, and gets back a
 * structured verdict plus artifacts. That is `verify`, and it is deliberately
 * NOT an autonomous agent: it executes the steps it was given, in order,
 * against the page it was given, and stops. There is no exploration, no
 * "try something else", and no way for a flow to navigate somewhere it was not
 * told to go.
 */

const path = require('path');
const fs = require('fs');
const cdp = require('./cdp');
const browser = require('./browser');
const { EVENT } = require('../events');
const { VERDICT } = require('./checks');
const { SOURCE } = require('./observation');

/** A flow that has not finished by now is a flow with a problem. */
const FLOW_TIMEOUT_MS = 90_000;
/** Actions a flow may take. A CLOSED LIST — see the header on delegation. */
const ACTIONS = Object.freeze(['navigate', 'click', 'type', 'wait', 'evaluate', 'screenshot']);

class BrowserHarness {
  constructor({ bus = null, runtime = null, processes = null, port = browser.DEFAULT_PORT, headless = true } = {}) {
    this.bus = bus;
    this.runtime = runtime;
    this.processes = processes;
    this.port = Number(port) || browser.DEFAULT_PORT;
    this.headless = headless !== false;
    /** taskId -> BrowserSession. One page per task is enough and is bounded. */
    this._sessions = new Map();
    this._launches = new Map();
    this._opening = new Map();
    this.lastWhy = '';
  }

  _emit(name, payload) {
    if (this.bus && typeof this.bus.emit === 'function') this.bus.emit(name, payload);
  }

  /**
   * CAN A VERIFICATION BROWSER RUN?
   *
   * It asks env/chromium.js, NOT `browser.available({ port })`. That function
   * reports `attachable: true` when anything is listening on 9222 and calls the
   * capability AVAILABLE on that basis — which, after the attach path was
   * removed, would be a availability answer about a browser this Harness will
   * never use. Availability now means exactly what the launch path needs: a
   * WebSocket client and a browser binary it is allowed to start.
   */
  availability() {
    const rt = require('../env/chromium');
    const h = new rt.ChromiumRuntime({ processes: this.processes }).health();
    return {
      available: h.available,
      state: h.available ? 'AVAILABLE' : 'OPTIONAL_UNAVAILABLE',
      why: h.available ? `launchable: ${h.browser.path}` : h.why,
      client: h.client,
      // NEVER ATTACHABLE. Kept in the shape because callers read it, and now
      // it is always false — which is the honest answer, not a missing field.
      attachable: false,
      launchable: Boolean(h.browser),
      browserPath: h.browser ? h.browser.path : null,
      browser: h.browser ? h.browser.version : null,
      owned: h.browser ? h.browser.owned : false,
      remedy: h.remedy || '',
      port: 0,
      tried: [],
    };
  }

  /**
   * GET A SESSION, LAUNCHING A BROWSER THIS HARNESS OWNS.
   *
   * ------------------------------------------------------------------------
   * IT USED TO ATTACH FIRST, AND THAT WAS THE DEFECT.
   *
   * The rule here was "ATTACH BEFORE LAUNCH, always", justified as: a debug
   * port that is already open belongs to somebody, often the person, so use
   * theirs rather than spending a few hundred megabytes on a second browser.
   *
   * The premise was right and the conclusion was backwards. A debug port that
   * belongs to the person is the one browser this instrument must NEVER touch.
   * `browser.DEFAULT_PORT` is 9222 — the DevTools convention every tool knows —
   * so anyone who had ever started Chrome with `--remote-debugging-port=9222`,
   * for their own debugging or for another tool, silently handed verification
   * their real browser: their cookies, their logged-in sessions, their open
   * tabs. And it then created tabs and navigated in it. Nothing announced this.
   *
   * The few hundred megabytes were never the expensive part.
   *
   * So there is no attach path. Every session runs in a browser this Harness
   * started, on a port the browser chose, in a disposable profile — see
   * env/chromium.js, which is now the only thing in the tree that launches one.
   */
  session(opts = {}) {
    const key = String(opts.taskId || 'default');
    if (opts.taskId && this.runtime) {
      const owner = this.runtime.get(opts.taskId);
      if (!owner || owner.terminal) return Promise.resolve({ ok: false, why: 'a browser requires an unfinished owner task' });
    }
    if (this._opening.has(key)) return this._opening.get(key);
    const opening = this._session(opts).then(async (result) => {
      if (!result.ok) await this._closeKeys([key]);
      return result;
    }, async (error) => {
      await this._closeKeys([key]);
      throw error;
    }).finally(() => this._opening.delete(key));
    this._opening.set(key, opening);
    return opening;
  }

  async _session({ taskId = null, launch = true, signal = null } = {}) {
    const key = String(taskId || 'default');
    if (signal && signal.aborted) return { ok: false, why: 'browser operation cancelled' };
    const existing = this._sessions.get(key);
    if (existing && existing.open) return { ok: true, session: existing };

    const client = cdp.clientAvailable();
    if (!client.ok) { this.lastWhy = client.why; return { ok: false, why: client.why }; }

    // NO `cdp.endpoint(this.port)` PROBE HERE. See the header: reaching an
    // already-open debug port is how this adopted the person's own browser.
    if (!launch) {
      this.lastWhy = 'a browser observation needs a browser, and launching was declined';
      return { ok: false, why: this.lastWhy };
    }
    const started = await this._launch(taskId, signal);
    if (!started.ok) { this.lastWhy = started.why; return started; }
    const processId = started.processId;
    const live = started.endpoint;
    if (!live.ok || (signal && signal.aborted)) {
      this.lastWhy = signal && signal.aborted ? 'browser operation cancelled' : 'the browser did not open a debug port';
      return { ok: false, why: this.lastWhy };
    }

    const tab = await cdp.newTab(live.base, 'about:blank');
    const socket = tab.ok ? tab.target.webSocketDebuggerUrl : null;
    if (!socket) {
      this.lastWhy = 'the browser has no page to attach to';
      return { ok: false, why: this.lastWhy };
    }
    const conn = new cdp.Connection(socket);
    const opened = await conn.connect();
    if (!opened.ok) { this.lastWhy = opened.why; return { ok: false, why: opened.why }; }
    const session = new browser.BrowserSession(conn, { taskId, processId, base: live.base });
    session.targetId = tab.ok ? tab.target.id : null;
    this._sessions.set(key, session);
    await session.enable();
    if (signal && signal.aborted) return { ok: false, why: 'browser operation cancelled' };
    this._emit(EVENT.BROWSER_STARTED, { taskId: String(taskId || ''), port: this.port, browser: live.browser || '' });
    return { ok: true, session };
  }

  /**
   * LAUNCH ONE, headless, in a throwaway profile.
   *
   * A THROWAWAY PROFILE IS A SAFETY PROPERTY, not tidiness. Reusing the
   * person's real profile would put their logged-in sessions, cookies and
   * saved passwords inside something a verification contract drives — and this
   * instrument is pointed at code under test, which is by definition the code
   * least worth trusting with them.
   */
  async _launch(taskId, signal = null) {
    // ---- ONE LAUNCHER FOR THE WHOLE TREE ---------------------------------
    //
    // This used to be fifty lines of "find a browser, build args, spawn, poll
    // DevToolsActivePort, open an endpoint" — and workshop/index.js and
    // modelsource/webbrowser.js each had their own copy, which had already
    // drifted apart on the details (who deletes the stale port file, who
    // disables extensions, who goes through the ProcessManager). See
    // env/chromium.js, which owns all of it now, and env/purpose.js, which
    // holds the differences that are REAL rather than accidental.
    //
    // VERIFY is the purpose here, and its traits carry the properties this
    // instrument depends on: headless, a fresh disposable profile per launch,
    // extensions off, and ownership by the TASK so it dies with it.
    const rt = require('../env/chromium');
    const runtime = new rt.ChromiumRuntime({ processes: this.processes, events: this.bus });
    const got = await runtime.launch(rt.PURPOSE.VERIFY, {
      taskId, headless: this.headless, signal, environment: this.environment || 'host',
    });
    if (!got.ok) {
      this._emit(EVENT.BROWSER_ERROR, { taskId: String(taskId || ''), why: got.why });
      return { ok: false, why: got.why, detail: got.detail || '', code: got.code || '' };
    }
    const inst = got.instance;
    // THE PROFILE IS THE INSTANCE'S, and cleanup already knows how to remove a
    // launched profile — it is handed the same two fields it always had.
    this._launches.set(String(taskId || 'default'), { processId: inst.proc ? inst.proc.processId : null, profile: inst.profileDir });
    // WHICH BROWSER PRODUCED THIS, recorded where the evidence can reach it.
    // A verdict that cannot name its browser cannot be compared with last
    // week's — see env/chromiuminstall.js on why the build is pinned.
    this.lastBrowser = {
      version: inst.version, owned: inst.owned, managed: inst.managed,
      source: inst.source, path: inst.browserPath, environment: inst.environment,
    };
    const live = await cdp.endpoint(inst.port);
    if (!live.ok) return { ok: false, why: live.why, processId: inst.proc ? inst.proc.processId : null };
    return { ok: true, processId: inst.proc ? inst.proc.processId : null, endpoint: live, instance: inst };
  }

  // ------------------------------------------------------------- observing --

  /**
   * ANSWER ONE QUESTION. Called by the observation router, which has already
   * decided that this source is the right one to ask.
   */
  async observe(source, spec = {}, ctx = {}) {
    const got = await this.session({ taskId: ctx.taskId, launch: spec.launch !== false });
    if (!got.ok) return { ok: false, source, why: got.why, value: null, summary: got.why };
    const s = got.session;
    if (spec.url && spec.url !== s.url) {
      const nav = await s.navigate(spec.url);
      if (!nav.ok) return { ok: false, source, why: nav.why, value: null, summary: nav.why };
    }
    if (source === SOURCE.DOM) {
      if (!spec.selector) {
        const r = await s.evaluate('document.title + " :: " + location.href');
        return r.ok
          ? { ok: true, source, value: r.value, summary: String(r.value) }
          : { ok: false, source, why: r.why, value: null, summary: r.why };
      }
      const el = await s.element(spec.selector);
      if (!el.ok) return { ok: false, source, why: el.why, value: null, summary: el.why };
      const v = el.value || {};
      if (!v.exists) return { ok: true, source, value: 'absent', summary: `${spec.selector} is not in the DOM` };
      return {
        ok: true,
        source,
        value: JSON.stringify(v),
        summary: `${spec.selector}: ${v.tag}, ${v.visible ? 'visible' : 'not visible'}, ${v.disabled ? 'disabled' : 'enabled'}`
          + (v.text ? `, text "${v.text.slice(0, 80)}"` : ''),
      };
    }
    if (source === SOURCE.ACCESSIBILITY) {
      const ax = await s.axTree(spec.selector || null);
      if (!ax.ok) return { ok: false, source, why: ax.why, value: null, summary: ax.why };
      const rows = ax.nodes.filter((n) => !n.ignored && (n.role || n.name))
        .map((n) => `${n.role || '?'}: ${n.name || ''}${n.disabled ? ' (disabled)' : ''}`);
      return { ok: true, source, value: rows.join('\n'), summary: `${rows.length} accessible node${rows.length === 1 ? '' : 's'}` };
    }
    if (source === SOURCE.CONSOLE) {
      const entries = spec.errors_only === false ? s.console : s.errors();
      const text = entries.map((e) => `[${e.level}] ${e.text}`).join('\n');
      return { ok: true, source, value: text, summary: `${entries.length} console entr${entries.length === 1 ? 'y' : 'ies'}` };
    }
    if (source === SOURCE.NETWORK) {
      const text = s.network.map((n) => `${n.status} ${n.url}`).join('\n');
      return { ok: true, source, value: text, summary: `${s.network.length} response${s.network.length === 1 ? '' : 's'}` };
    }
    if (source === SOURCE.SCREENSHOT) {
      const shot = await s.screenshot();
      if (!shot.ok) return { ok: false, source, why: shot.why, value: null, summary: shot.why };
      const kept = this._keep(ctx.taskId, 'screenshot', 'page.png', shot.buffer);
      this._emit(EVENT.BROWSER_OBSERVED, { taskId: String(ctx.taskId || ''), what: 'screenshot', url: s.url || '' });
      return {
        ok: true, source, value: kept ? kept.path : '(not kept)',
        summary: `captured ${s.url || 'the page'}${kept ? ` to ${path.basename(kept.path)}` : ''}`,
      };
    }
    return { ok: false, source, why: `the browser cannot answer "${source}"`, value: null, summary: '' };
  }

  _keep(taskId, kind, name, body) {
    if (!this.runtime || !taskId) return null;
    try { return this.runtime.keep(taskId, { kind, name, body }); } catch { return null; }
  }

  // ------------------------------------------------------------- verifying --

  /**
   * RUN A FLOW AND JUDGE IT.
   *
   * The spec a verification contract writes:
   *
   *     { kind: 'browser',
   *       url: 'http://localhost:5173/login',
   *       actions: [ {type:'type', selector:'#email', text:'a@b.c'},
   *                  {type:'click', selector:'button[type=submit]'},
   *                  {type:'wait', selector:'.dashboard'} ],
   *       assert:  [ {selector:'.dashboard', visible:true} ],
   *       expect_url: '/dashboard',
   *       no_console_errors: true,
   *       screenshot: true }
   *
   * EVERY FAILURE MODE IS DISTINGUISHED. No browser is INCONCLUSIVE. A page
   * that will not load is INCONCLUSIVE — nothing about the flow was learned. An
   * assertion that is false is FAILED. That three-way split is the whole reason
   * a browser check is trustworthy enough to gate a task on.
   */
  async verify(spec = {}, ctx = {}) {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) cancel();
      else ctx.signal.addEventListener('abort', cancel, { once: true });
    }
    const timeout = Math.max(1, Number(spec.flow_timeout_ms) || FLOW_TIMEOUT_MS);
    const timer = setTimeout(cancel, timeout);
    let onAbort;
    const interrupted = new Promise((resolve) => {
      onAbort = () => resolve({ verdict: VERDICT.INCONCLUSIVE, why: ctx.signal && ctx.signal.aborted ? 'browser verification cancelled' : `browser verification timed out after ${timeout}ms` });
      if (abort.signal.aborted) onAbort();
      else abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([this._verify(spec, { ...ctx, signal: abort.signal }), interrupted]);
    } finally {
      cancel();
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', cancel);
      abort.signal.removeEventListener('abort', onAbort);
      await this.close(ctx.taskId);
    }
  }

  async _verify(spec = {}, ctx = {}) {
    if (ctx.signal && ctx.signal.aborted) return { verdict: VERDICT.INCONCLUSIVE, why: 'browser verification cancelled' };
    const began = Date.now();
    const avail = await this.availability();
    if (!avail.available) {
      return { verdict: VERDICT.INCONCLUSIVE, why: `no browser observation is possible here — ${avail.why}` };
    }
    const got = await this.session({ taskId: ctx.taskId, launch: true, signal: ctx.signal });
    if (!got.ok) return { verdict: VERDICT.INCONCLUSIVE, why: `the browser could not be opened — ${got.why}` };
    const s = got.session;
    const trail = [];

    if (spec.url) {
      const nav = await s.navigate(spec.url, Number(spec.timeout_ms) || browser.NAV_TIMEOUT_MS);
      trail.push(`navigate ${spec.url}: ${nav.why}`);
      if (!nav.ok) {
        this._emit(EVENT.BROWSER_ERROR, { taskId: String(ctx.taskId || ''), why: nav.why });
        return { verdict: VERDICT.INCONCLUSIVE, why: nav.why, output: trail.join('\n') };
      }
    }

    for (const action of (Array.isArray(spec.actions) ? spec.actions : [])) {
      if (ctx.signal && ctx.signal.aborted) return { verdict: VERDICT.INCONCLUSIVE, why: 'browser verification cancelled' };
      if (Date.now() - began > FLOW_TIMEOUT_MS) {
        return { verdict: VERDICT.INCONCLUSIVE, why: `the flow ran past its ${FLOW_TIMEOUT_MS}ms limit`, output: trail.join('\n') };
      }
      const type = String(action.type || '');
      if (!ACTIONS.includes(type)) {
        return { verdict: VERDICT.INCONCLUSIVE, why: `"${type}" is not an allowed browser action (${ACTIONS.join(', ')})`, output: trail.join('\n') };
      }
      // eslint-disable-next-line no-await-in-loop -- a flow is ordered by
      // definition; running its steps concurrently would be a different flow.
      const r = await this._act(s, action, ctx);
      trail.push(`${type} ${action.selector || action.url || ''}: ${r.why}`);
      if (!r.ok) {
        // AN ACTION THAT COULD NOT HAPPEN IS INCONCLUSIVE, NOT FAILED. "The
        // button was not there to click" might BE the bug — but it might also
        // be a page that had not finished rendering, and a check has no way to
        // tell those apart. The assertions say what is true; the actions only
        // get there.
        return { verdict: VERDICT.INCONCLUSIVE, why: `the flow could not continue: ${r.why}`, output: trail.join('\n') };
      }
    }

    const failures = [];
    const missing = [];
    for (const a of (Array.isArray(spec.assert) ? spec.assert : [])) {
      // eslint-disable-next-line no-await-in-loop
      const el = await s.element(a.selector);
      if (!el.ok) { missing.push(`${a.selector}: ${el.why}`); continue; }
      const v = el.value || {};
      if (a.exists === false) { if (v.exists) failures.push(`${a.selector} still exists`); continue; }
      if (!v.exists) { failures.push(`${a.selector} is not in the page`); continue; }
      if (a.visible === true && !v.visible) failures.push(`${a.selector} is present but not visible`);
      if (a.visible === false && v.visible) failures.push(`${a.selector} is visible and should not be`);
      if (a.disabled === true && !v.disabled) failures.push(`${a.selector} is enabled and should be disabled`);
      if (a.disabled === false && v.disabled) failures.push(`${a.selector} is disabled and should be enabled`);
      if (a.text && !String(v.text || '').includes(String(a.text))) {
        failures.push(`${a.selector} does not contain "${a.text}" (it has "${String(v.text).slice(0, 80)}")`);
      }
    }

    if (spec.expect_url) {
      const here = await s.evaluate('location.href');
      const url = here.ok ? String(here.value || '') : '';
      if (!here.ok) missing.push(`page URL unavailable: ${here.why}`);
      else if (!url.includes(String(spec.expect_url))) failures.push(`the page is at ${url || 'an unknown URL'}, expected it to contain ${spec.expect_url}`);
      trail.push(`url: ${url}`);
    }

    let consoleErrors = [];
    if (spec.no_console_errors) {
      if (s.enabledDomains && !s.enabledDomains.has('Runtime')) missing.push('console collection could not be enabled');
      consoleErrors = s.errors();
      if (consoleErrors.length) {
        failures.push(`${consoleErrors.length} console error${consoleErrors.length === 1 ? '' : 's'}: ${consoleErrors.slice(0, 3).map((e) => e.text.slice(0, 120)).join(' | ')}`);
      }
      this._keep(ctx.taskId, 'browser', 'console.txt', s.console.map((c) => `[${c.level}] ${c.text}`).join('\n'));
    }

    if (spec.screenshot !== false) {
      const shot = await s.screenshot();
      if (shot.ok) {
        const kept = this._keep(ctx.taskId, 'screenshot', `${failures.length ? 'failed' : 'passed'}.png`, shot.buffer);
        if (kept) trail.push(`screenshot: ${path.basename(kept.path)}`);
      }
    }

    this._emit(EVENT.BROWSER_OBSERVED, {
      taskId: String(ctx.taskId || ''), what: 'flow', url: s.url || '', failures: failures.length,
    });

    if (failures.length) {
      return { verdict: VERDICT.FAILED, why: failures.join('; '), output: trail.join('\n'), consoleErrors: consoleErrors.length };
    }
    if (missing.length || (!(spec.assert || []).length && !spec.expect_url && !spec.no_console_errors)) {
      return { verdict: VERDICT.INCONCLUSIVE, why: missing.join('; ') || 'the browser flow named no assertions', output: trail.join('\n') };
    }
    return {
      verdict: VERDICT.PASSED,
      why: `the flow reached its expected state${spec.no_console_errors ? ' with no console errors' : ''}`,
      output: trail.join('\n'),
    };
  }

  async _act(s, action, ctx) {
    switch (String(action.type)) {
      case 'navigate': return s.navigate(action.url);
      case 'click': return s.click(action.selector);
      case 'type': return s.type(action.selector, action.text == null ? '' : action.text);
      case 'wait': {
        if (action.selector) return s.waitFor(action.selector, Number(action.timeout_ms) || 8000);
        await new Promise((r) => {
          const done = () => { clearTimeout(timer); if (ctx.signal) ctx.signal.removeEventListener('abort', done); r(); };
          const timer = setTimeout(done, Math.min(10000, Number(action.ms) || 500));
          if (ctx.signal) { if (ctx.signal.aborted) done(); else ctx.signal.addEventListener('abort', done, { once: true }); }
        });
        return { ok: true, why: `waited ${Number(action.ms) || 500}ms` };
      }
      case 'evaluate': {
        const r = await s.evaluate(String(action.expression || ''));
        return r.ok ? { ok: true, why: `evaluated: ${String(r.value).slice(0, 120)}` } : r;
      }
      case 'screenshot': {
        const shot = await s.screenshot();
        if (!shot.ok) return shot;
        const kept = this._keep(ctx.taskId, 'screenshot', String(action.name || 'step.png'), shot.buffer);
        return { ok: true, why: kept ? `kept ${path.basename(kept.path)}` : 'captured' };
      }
      default: return { ok: false, why: `unknown action ${action.type}` };
    }
  }

  // ------------------------------------------------------------- lifecycle --

  async close(taskId = null) {
    const pending = taskId ? [this._opening.get(String(taskId))] : [...this._opening.values()];
    await Promise.allSettled(pending.filter(Boolean));
    const keys = taskId ? [String(taskId)] : [...new Set([...this._sessions.keys(), ...this._launches.keys()])];
    return this._closeKeys(keys);
  }

  async _closeKeys(keys) {
    if (this._closing) await this._closing;
    const work = this._disposeKeys(keys);
    this._closing = work;
    try { await work; } finally { if (this._closing === work) this._closing = null; }
  }

  async _disposeKeys(keys) {
    const errors = [];
    for (const k of keys) {
      const s = this._sessions.get(k);
      try {
        if (s) {
          if (s.targetId && s.conn && s.open) {
            try { await s.conn.send('Target.closeTarget', { targetId: s.targetId }, 1000); } catch { /* closing the socket still follows */ }
          }
          s.close();
          this._sessions.delete(k);
          this._emit(EVENT.BROWSER_CLOSED, { taskId: k });
        }
        const launched = this._launches.get(k);
        const processId = launched ? launched.processId : s && s.processId;
        if (processId && this.processes) {
          const stopped = await this.processes.stop(processId);
          if (!stopped.ok) throw new Error(stopped.why);
        }
        if (launched) {
          // This exact path was minted by mkdtemp; never a browser-supplied path.
          await fs.promises.rm(launched.profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
          this._launches.delete(k);
        }
      } catch (e) { errors.push(e); }
    }
    if (errors.length) throw errors[0];
  }
}

module.exports = { BrowserHarness, ACTIONS, FLOW_TIMEOUT_MS };
