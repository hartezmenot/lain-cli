'use strict';

/**
 * THE PROBE SEAM.
 *
 * A SECOND, SEPARATE seam beside the desktop bridge in mcp.js — not a widening
 * of it. That file says plainly what it is not:
 *
 *     "There is no game-specific code, no process memory access and no code
 *      injection in this seam, and adding any would be a different product."
 *
 * LAIN Probe IS that different product, so it gets its own door rather than
 * having memory scanning and hardware watchpoints bolted onto a seam that
 * declares them out of scope. Nothing in mcp.js changes; a setup with no Probe
 * behaves exactly as before.
 *
 * WHO ASKS THE USER, AND WHY IT IS NOT LAIN.
 *
 * The desktop bridge is gated here because a bridge is an arbitrary external
 * program with no relationship to the person at the machine — LAIN is the only
 * thing that can ask on its behalf.
 *
 * The Probe is not that. It runs an always-on-top window of its own, and it
 * asks — in words, per capability, with a timeout that denies — immediately
 * before it acts, inside the engine that acts. Gating again here would prompt
 * the user twice for one decision, which teaches people to click through
 * prompts, and that is worse than useless.
 *
 * So LAIN's job at this seam is to LAUNCH, ROUTE, SHOW and STOP:
 *
 *     /mcp probe          launch it and connect
 *     /mcp status         what it is, and what it is currently allowed to do
 *     /mcp stop probe     shut it down
 *
 * `/mcp revoke` reaches the Probe too, because the STOP handle must work from
 * whichever surface the user happens to be looking at.
 *
 * THE PROTOCOL is the same one-JSON-object-per-line dialect the desktop bridge
 * speaks, so the Probe is reachable by the code that already exists. The Probe
 * implements it directly (`--protocol lain`); no translation lives here.
 *
 * ONE CONVERSATION, AND LAIN OWNS IT.
 *
 * The Probe window has a message box and no LLM. A line typed there arrives
 * here as a `user.message` EVENT, and is handed to the same `app.handle()` that
 * a line typed into the CLI goes through - so it is classified, queued, or
 * treated as an answer to an outstanding question by exactly the code that
 * already does that. Nothing about turn-taking is reimplemented, which is the
 * point: a second path would drift from the first and the two would disagree
 * about what is happening.
 *
 * The channel therefore carries two kinds of message from the Probe:
 *
 *     RESPONSES   {"id": 7, "ok": true, ...}                answers to requests
 *     EVENTS      {"event": "user.message", "text": "..."}  unsolicited
 *
 * An event has no `id`. That is the whole of the distinction.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const HELLO_TIMEOUT_MS = 20_000;   // the Probe opens a window before answering
const CALL_TIMEOUT_MS = 120_000;   // an investigation waits for a human event
const MAX_LINE = 8_000_000;

const STATE = Object.freeze({
  NOT_CONFIGURED: 'NOT CONFIGURED',
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
});

/**
 * WHERE THE PROBE IS, and how to run it.
 *
 * From config if the user has said; otherwise a look in the obvious places. A
 * guess that fails is reported as NOT CONFIGURED with the paths that were
 * tried, because "it did not work" is not a useful thing to tell someone.
 *
 *     "probe": {
 *       "python": "C:\\...\\Python311\\python.exe",
 *       "path":   "C:\\Users\\...\\Documents\\lain-probe"
 *     }
 *
 * TARGET POLICY IS OPTIONAL, AND OFF BY DEFAULT.
 *
 *   allowTargets   an OPERATOR RESTRICTION. Absent, null or [] means the
 *                  person at the Probe window may authorise any eligible
 *                  process - which is the normal case. A non-empty list pins
 *                  this Probe to those executable names and NOTHING ELSE, for
 *                  every session, until the key is removed.
 *   denyTargets    never authorisable, whoever asks. Adds to the Probe's
 *                  built-in protected-process list.
 *
 * This used to be required: before the Probe gained user-controlled target
 * authorisation, an empty allowTargets meant "nothing is attachable" and the
 * key had to be filled in for the Probe to be usable at all. That inverted -
 * and the values people had filled in stayed behind, silently restricting
 * every session to a name they had typed once, months earlier, for a test.
 * So a restriction now announces itself: `/mcp probe` prints it, the Probe
 * window shows it, and a refusal names this file rather than a command-line
 * flag nobody typed.
 */
function settings(cfg = {}) {
  const p = (cfg && cfg.probe) || {};
  const tried = [];
  let root = p.path || null;
  if (!root) {
    for (const candidate of [
      path.resolve(process.cwd(), 'lain-probe'),
      path.resolve(__dirname, '..', '..', 'lain-probe'),
      path.resolve(process.env.USERPROFILE || '', 'Documents', 'lain-probe'),
    ]) {
      tried.push(candidate);
      if (fs.existsSync(path.join(candidate, 'probe', '__main__.py'))) { root = candidate; break; }
    }
  }
  if (!root || !fs.existsSync(path.join(root, 'probe', '__main__.py'))) {
    return { ok: false, tried, reason: root ? `no probe package at ${root}` : 'lain-probe was not found' };
  }
  // THE INTERPRETER IS ABSOLUTE AND EXPLICIT. On the machine this was built on,
  // `python3` is a bare 3.14 with none of the packages the Probe needs, and a
  // launch through it fails with an ImportError that looks like a missing
  // dependency and is not one.
  const python = p.python || process.env.LAIN_PROBE_PYTHON || null;
  if (!python) {
    return { ok: false, tried, reason: 'no python configured — set probe.python to the interpreter that has numpy, cv2 and pymem' };
  }
  if (!fs.existsSync(python)) {
    return { ok: false, tried, reason: `probe.python does not exist: ${python}` };
  }
  // AN EXPLICIT RESTRICTION OR NONE AT ALL. `allowTargets` is only a
  // restriction when it is a non-empty array; every other shape - absent,
  // null, [], a string, junk - means the user decides at the Probe window.
  // Silence must never come out the other end as "only probe-test-target.exe".
  const allowTargets = Array.isArray(p.allowTargets)
    ? p.allowTargets.map((t) => String(t).trim()).filter(Boolean) : [];
  const denyTargets = Array.isArray(p.denyTargets)
    ? p.denyTargets.map((t) => String(t).trim()).filter(Boolean) : [];
  const restricted = allowTargets.length > 0;
  return {
    ok: true, root, python, allowTargets, denyTargets, restricted,
    policySource: `allowTargets in ${require('./config').configFile()}`,
    policy: restricted ? `RESTRICTED TO: ${allowTargets.join(', ')}` : 'USER SELECTABLE',
    ui: p.ui !== false,
  };
}

function configured(cfg) { return settings(cfg).ok; }

/**
 * THE ONE LIVE PROBE, for the tool registry.
 *
 * `tools/index.js` decides which tools the model is offered, and it is called
 * from `turn.js` with no App to ask — the same reason it consults `mcp` through
 * `configured(config)` rather than through an instance. So a connected Probe
 * registers itself here and clears itself on the way down, and the vocabulary
 * follows the connection rather than the configuration: a Probe that is
 * configured but not running must not be advertised, because a model told it
 * can investigate will try.
 */
let _live = null;

/** The connected Probe, or null. Never a disconnected one. */
function live() { return _live && _live.state === STATE.CONNECTED ? _live : null; }

class Probe {
  constructor(cfg, app) {
    this.cfg = cfg || {};
    this.app = app || null;
    this.child = null;
    this.state = configured(this.cfg) ? STATE.DISCONNECTED : STATE.NOT_CONFIGURED;
    this.reason = configured(this.cfg) ? 'not started' : settings(this.cfg).reason;
    this.info = null;
    this.capabilities = [];
    /** The Probe's investigation contract, read from it at connect. */
    this.skillDigest = '';
    this._pending = new Map();
    this._seq = 0;
    this._buf = '';
    this.activity = [];
    this.projectRoot = null;
    // One connection id per link. A reconnect makes a new one against the same
    // LAIN session, which is how "reconnected" stays distinguishable from
    // "started a second conversation".
    this.connectionId = null;
    this._eventHandlers = [];
  }

  /** Observe unsolicited Probe events. Returns an unsubscribe function. */
  onEvent(fn) {
    this._eventHandlers.push(fn);
    return () => { this._eventHandlers = this._eventHandlers.filter((f) => f !== fn); };
  }

  _dispatchEvent(msg) {
    for (const fn of this._eventHandlers.slice()) {
      // A handler that throws must not take down the reader.
      try { Promise.resolve(fn(msg)).catch(() => {}); } catch { /* ignore */ }
    }
  }

  _note(text, ok = true) {
    this.activity.push({ at: Date.now(), text: String(text), ok });
    if (this.activity.length > 100) this.activity.shift();
  }

  /** Start the Probe and complete the handshake. Never throws. */
  async connect(projectRoot) {
    const s = settings(this.cfg);
    if (!s.ok) { this.state = STATE.NOT_CONFIGURED; this.reason = s.reason; return { ok: false, state: this.state, reason: this.reason, tried: s.tried }; }
    if (this.state === STATE.CONNECTED) return { ok: true, state: this.state, info: this.info, capabilities: this.capabilities };

    this.projectRoot = projectRoot || process.cwd();
    this.state = STATE.CONNECTING;
    this.reason = '';

    // THE PROJECT ROOT IS PASSED EXPLICITLY. The Probe is a separate process
    // and does not share a working directory with LAIN.
    const args = ['-m', 'probe',
      '--project-root', this.projectRoot,
      '--serve', '--protocol', 'lain'];
    // App exposes the conversation as `session.id`; there is no `sessionId`.
    // Getting this wrong passed `undefined` and the Probe lost the link back to
    // the conversation it belongs to.
    const lainSession = this.app && this.app.session ? this.app.session.id : null;
    if (lainSession) args.push('--parent-session', String(lainSession));
    // ONLY WHEN THE OPERATOR ACTUALLY SAID SO. An empty list pushes nothing,
    // and the Probe then lets the person at its window choose. `--policy-source`
    // travels with the restriction so that the refusal a user reads names this
    // config file instead of a flag they never typed.
    if (s.restricted) {
      for (const t of s.allowTargets) args.push('--allow-target', t);
      args.push('--policy-source', s.policySource);
    }
    for (const t of s.denyTargets) args.push('--deny-target', t);
    if (!s.ui) args.push('--no-ui');

    try {
      this.child = spawn(s.python, args, {
        cwd: s.root,
        // The Probe inherits nothing it was not given. It is a process with
        // hands on the machine.
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,     // it has a window, and the user should see it
      });
    } catch (e) {
      return this._down(`could not start the Probe: ${e.message}`);
    }

    this.child.on('error', (e) => this._down(`Probe process error: ${e.message}`));
    this.child.on('exit', (code, sig) => this._down(`the Probe exited (${sig || `code ${code}`})`));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this._onData(d));
    // The Probe's stderr is structured log lines, not protocol. Kept, bounded.
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => this._onLog(d));

    // THE HANDSHAKE CARRIES IDENTITY, not just a greeting. The Probe must know
    // which conversation it belongs to and which project it is pointed at, and
    // it must not have to guess either.
    this.connectionId = `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const hello = await this._send({
      op: 'hello',
      client: 'lain',
      version: 2,
      lain_session: this.app && this.app.session ? this.app.session.id : null,
      connection_id: this.connectionId,
      project_root: this.projectRoot,
    }, HELLO_TIMEOUT_MS);
    if (!hello.ok) return this._down(`handshake failed: ${hello.error}`);
    this.capabilities = Array.isArray(hello.capabilities) ? hello.capabilities : [];
    this.info = { name: hello.name || 'lain-probe', version: hello.version || null };
    this.identity = hello.identity || null;
    // A disagreement about which project this is gets SAID, not resolved.
    if (hello.warning) this._note(`warning: ${hello.warning}`, false);
    this.state = STATE.CONNECTED;
    this.reason = '';
    _live = this;                       // the model may now be offered `probe`
    // THE INVESTIGATION CONTRACT, read from the Probe rather than kept here.
    // A copy in LAIN would drift the first time the Probe's skill document
    // changed, and the drift would be silent. Best effort: an older Probe that
    // has no skill tool still connects, and the conversation still works.
    try {
      const sk = await this.call('probe.skill', { form: 'digest' }, 10_000);
      this.skillDigest = sk.ok && sk.result ? String(sk.result.skill || '') : '';
    } catch (e) { this.skillDigest = ''; }
    this._note(`connected to ${this.info.name} ${this.info.version || ''} · ${this.capabilities.length} tool(s)`);
    return { ok: true, state: this.state, info: this.info, capabilities: this.capabilities };
  }

  _onLog(chunk) {
    for (const line of String(chunk).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let level = 'info', event = t;
      if (t.startsWith('{')) {
        try { const rec = JSON.parse(t); level = rec.level || 'info'; event = rec.event || t; } catch { /* not a log line */ }
      }
      if (level === 'error' || level === 'warn') this._note(`probe: ${event}`, level !== 'error');
    }
  }

  _down(reason) {
    const wasConnected = this.state === STATE.CONNECTED;
    // Withdraw the capability BEFORE anything else: a tool offered by a Probe
    // that is going away is worse than one never offered.
    if (_live === this) _live = null;
    // ---- AND THE AUTHORISATION GOES WITH THE SESSION ----------------------
    //
    // This is the other half of the probe-scoped grant (see permissions.js
    // SCOPE). A grant that is bound to a session must END with that session, or
    // "until the Probe exits" is a promise nothing keeps — and a Probe that
    // reconnects would silently inherit an authorisation the user gave to the
    // previous one.
    //
    // Keyed on THIS connection's id, so a late teardown from an old connection
    // cannot revoke a newer session's grants. Best effort by nature: a
    // permission system that can throw out of a teardown is one that leaves the
    // grant standing.
    this._endAuthorisation(reason);
    this.skillDigest = '';
    this.state = configured(this.cfg) ? STATE.DISCONNECTED : STATE.NOT_CONFIGURED;
    this.reason = String(reason || 'disconnected');
    this.capabilities = [];
    for (const [, p] of this._pending) p.reject(new Error(this.reason));
    this._pending.clear();
    if (wasConnected) this._note(this.reason, false);
    return { ok: false, state: this.state, reason: this.reason };
  }

  _onData(chunk) {
    this._buf += chunk;
    if (this._buf.length > MAX_LINE * 2) { this._down('the Probe sent an oversized message'); return; }
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this._note(`unparseable line from the Probe: ${line.slice(0, 120)}`, false); continue; }
      // AN EVENT HAS NO `id`. Anything else is an answer to a request we made.
      if (msg && msg.event && msg.id === undefined) {
        this._note(`event: ${msg.event}`);
        this._dispatchEvent(msg);
        continue;
      }
      const p = this._pending.get(msg.id);
      if (!p) continue;
      this._pending.delete(msg.id);
      p.resolve(msg);
    }
  }

  _send(payload, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve) => {
      if (!this.child || this.child.killed) { resolve({ ok: false, error: 'the Probe is not running' }); return; }
      const id = ++this._seq;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ ok: false, error: `no answer within ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this._pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); },
      });
      try { this.child.stdin.write(JSON.stringify({ id, ...payload }) + '\n'); }
      catch (e) { clearTimeout(timer); this._pending.delete(id); resolve({ ok: false, error: e.message }); }
    });
  }

  /**
   * Call one Probe tool.
   *
   * NO ALLOWLIST HERE, deliberately — unlike the desktop bridge. The Probe's
   * tool surface is its own and it gates every sensitive one itself, in its own
   * window (see the file header). A second list here would go stale the moment
   * the Probe grew a tool, and would produce "unknown operation" for something
   * that exists and works.
   *
   * A DENIAL IS NOT AN ERROR TO ROUTE AROUND. It comes back flagged, so a
   * caller asks the user rather than retrying.
   */
  async call(tool, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    if (this.state !== STATE.CONNECTED) {
      return { ok: false, error: `the Probe is ${this.state}${this.reason ? ` — ${this.reason}` : ''}` };
    }
    const r = await this._send({ op: tool, params }, timeoutMs);
    this._note(`${tool} — ${r.ok ? 'ok' : `failed: ${r.error}`}`, Boolean(r.ok));
    if (!r.ok) {
      // `result` rides along on a FAILURE too: a failing script's exit code and
      // stderr are exactly what the caller needs to fix it.
      return { ok: false, error: r.error || 'the Probe refused', denied: Boolean(r.denied),
               capability: r.capability, code: r.code, result: r.result };
    }
    return { ok: true, result: r.result };
  }

  /** Everything the Probe currently permits itself. Read from the Probe. */
  async permissions() {
    const r = await this.call('permission.state', {}, 10_000);
    return r.ok ? r.result : null;
  }

  /** The STOP handle, reachable from LAIN. */
  async revoke() {
    if (this.state !== STATE.CONNECTED) return { ok: false, error: 'the Probe is not connected' };
    const r = await this.call('permission.revoke', {}, 10_000);
    if (r.ok) this._note('permissions revoked from LAIN');
    return r;
  }

  /**
   * Mirror a line of the conversation into the Probe window.
   *
   * Best effort by design: the Probe is a companion surface, and a turn must
   * not fail because a window could not be updated.
   */
  async say(text, role = 'assistant') {
    if (this.state !== STATE.CONNECTED) return false;
    const s = String(text == null ? '' : text).trim();
    if (!s) return false;
    const r = await this.call('session.say', { text: s.slice(0, 4000), role }, 15_000);
    return Boolean(r.ok);
  }

  /**
   * DROP EVERY PROBE-SCOPED GRANT THIS CONNECTION BOUGHT.
   *
   * One place, called from both teardown paths, because two copies of "end the
   * authorisation" is one copy that gets forgotten in the path nobody tests.
   */
  _endAuthorisation(why = 'the Probe session ended') {
    if (!this.connectionId) return;
    try {
      const perms = this.app && typeof this.app.desktop === 'function'
        ? this.app.desktop().permissions : null;
      if (perms && typeof perms.endProbeSession === 'function') {
        perms.endProbeSession(this.connectionId, why);
      }
    } catch { /* a teardown that throws leaves the grant standing */ }
  }

  close(why = 'closed') {
    this._endAuthorisation(why);
    if (this.child) { try { this.child.kill(); } catch { /* already gone */ } }
    this.child = null;
    this.state = configured(this.cfg) ? STATE.DISCONNECTED : STATE.NOT_CONFIGURED;
    this.reason = why;
    this.capabilities = [];
    return true;
  }

  status() {
    const s = settings(this.cfg);
    return {
      state: this.state,
      reason: this.reason,
      configured: s.ok,
      root: s.ok ? s.root : null,
      python: s.ok ? s.python : null,
      targetPolicy: s.ok ? s.policy : null,
      targetRestricted: s.ok ? s.restricted : false,
      policySource: s.ok && s.restricted ? s.policySource : null,
      tried: s.ok ? undefined : s.tried,
      name: this.info ? this.info.name : null,
      version: this.info ? this.info.version : null,
      projectRoot: this.projectRoot,
      connectionId: this.connectionId,
      identity: this.identity || null,
      capabilities: this.capabilities,
      pid: this.child ? this.child.pid : null,
      // BESIDE the canonical `pid`, never instead of it — anything reading
      // `status().pid` gets the same number it always got. See numfmt.js on why
      // presentation must not become the data.
      pidShown: this.child ? require('./numfmt').pid(this.child.pid) : null,
      activity: this.activity.slice(-20),
    };
  }
}

/**
 * MIRROR A FINISHED TURN INTO THE PROBE WINDOW.
 *
 * The Probe is a companion surface on the SAME conversation, so what the model
 * said belongs there too - a window showing only one side of a dialogue is a
 * log, not a conversation.
 *
 * Best effort, deliberately: a turn must never fail because a window could not
 * be updated, and the Probe may be mid-shutdown when this runs.
 */
function mirrorTurn(app, record) {
  const probe = app && app._probe;
  if (!probe || !record || !record.text) return;
  Promise.resolve(probe.say(record.text, 'assistant')).catch(() => {});
}

module.exports = { Probe, live, mirrorTurn, settings, configured, STATE, HELLO_TIMEOUT_MS, CALL_TIMEOUT_MS };
