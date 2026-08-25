'use strict';

/**
 * THE DESKTOP BRIDGE SEAM.
 *
 * LAIN does not automate a desktop. It talks to a process that does.
 *
 *     LAIN → (this file) → bridge process (stdio, JSON lines) → the desktop
 *
 * That boundary is the whole design. Screen capture, mouse and keyboard
 * synthesis and window management are platform work with real security weight,
 * and a coding CLI that grows its own copy of them becomes a remote-control tool
 * that happens to edit files. So the bridge is EXTERNAL, the user configures
 * which one, and LAIN ships none: with nothing configured this reports NOT
 * CONFIGURED and every capability is simply absent.
 *
 * IT IS GENERIC ON PURPOSE. The operations are `screen.capture`, `mouse.move`,
 * `mouse.click`, `keyboard.type`, `window.list` and `window.focus` — the
 * primitives every desktop automation is built from. Nothing here knows about
 * any particular application; an auto-clicker, a memory-editor workflow and a
 * form-filling script are all just callers. There is no game-specific code, no
 * process memory access and no code injection in this seam, and adding any
 * would be a different product.
 *
 * NOTHING REACHES THE DESKTOP WITHOUT CONSENT. Every operation is gated on
 * permissions.js, checked here, on every call, immediately before it is sent —
 * not once at connect time. A revoked grant stops the next action, not the next
 * session.
 *
 * THE PROTOCOL, one JSON object per line, in both directions:
 *
 *     → {"id":1,"op":"hello","client":"lain","version":1}
 *     ← {"id":1,"ok":true,"name":"...","version":"...","capabilities":[...]}
 *     → {"id":2,"op":"window.list"}
 *     ← {"id":2,"ok":true,"result":[{"id":"...","title":"..."}]}
 *     ← {"id":3,"ok":false,"error":"no such window"}
 *
 * A bridge that fails to answer, dies, or speaks nonsense is DISCONNECTED with
 * the real reason attached. It is never reported as available.
 */

const { spawn } = require('child_process');

/** Operation → the permission it requires. An op not in here is not callable. */
const OPS = Object.freeze({
  'screen.capture': 'screen',
  'mouse.move': 'mouse',
  'mouse.click': 'mouse',
  'keyboard.type': 'keyboard',
  'keyboard.key': 'keyboard',
  'window.list': 'window',
  'window.focus': 'window',
});

const STATE = Object.freeze({
  NOT_CONFIGURED: 'NOT CONFIGURED',
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
});

const HELLO_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 15_000;
const MAX_LINE = 4_000_000;      // a screenshot arrives as one line

/**
 * EVERY CONFIGURED SERVER, by name.
 *
 * The config began as ONE bridge — `mcp.command` — because there was one thing
 * to talk to. That shape cannot express what people actually have: a browser
 * server, a filesystem server, a desktop server, each its own process with its
 * own command and its own capabilities. So the config now reads:
 *
 *     "mcp": {
 *       "servers": {
 *         "browser": { "command": ["node", "path/to/browser-mcp.js"] },
 *         "desktop": { "command": ["python", "bridge.py"], "enabled": false }
 *       }
 *     }
 *
 * THE OLD SHAPE STILL WORKS and is listed as the server named `desktop`, so no
 * existing setup breaks — and there is still exactly ONE resolver, because a
 * second one "for the old way" is how two different answers to "is a bridge
 * configured" come to exist.
 *
 * `enabled: false` keeps a server in the config and out of the running: the
 * difference between "not set up" and "deliberately switched off" is worth
 * being able to say.
 *
 * @returns {Array<{id, command, cwd, env, name, enabled}>}
 */
function servers(cfg = {}) {
  const m = cfg.mcp || cfg.desktopBridge || null;
  if (!m) return [];
  const one = (id, s) => {
    if (!s || !Array.isArray(s.command) || !s.command.length) return null;
    return {
      id,
      command: s.command.map(String),
      cwd: s.cwd || undefined,
      // A server inherits NOTHING by default. It is a process with hands on the
      // machine; handing it the whole environment (tokens included) is not a
      // convenience worth having.
      env: s.env && typeof s.env === 'object' ? { ...s.env } : {},
      name: s.name || s.command[0],
      enabled: s.enabled !== false,
    };
  };
  if (m.servers && typeof m.servers === 'object') {
    return Object.entries(m.servers).map(([id, s]) => one(id, s)).filter(Boolean);
  }
  const legacy = one('desktop', m);
  return legacy ? [legacy] : [];
}

/**
 * The server the DESKTOP tool talks to.
 *
 * ONE bridge is connected at a time. The permission model, the control window
 * and the revoke path are all built around a single live grant, and quietly
 * running four of them would make "what is allowed right now" unanswerable —
 * which is the one question that design exists to keep answerable. The server
 * named `desktop` wins if there is one; otherwise the first enabled server.
 */
function settings(cfg = {}) {
  const all = servers(cfg).filter((s) => s.enabled);
  if (!all.length) return null;
  return all.find((s) => s.id === 'desktop') || all[0];
}

function configured(cfg) { return settings(cfg) !== null; }

class Bridge {
  constructor(cfg, permissions) {
    this.cfg = cfg || {};
    this.permissions = permissions;
    this.child = null;
    this.state = configured(this.cfg) ? STATE.DISCONNECTED : STATE.NOT_CONFIGURED;
    this.reason = configured(this.cfg) ? 'not started' : 'no bridge command in config';
    this.capabilities = [];
    this.info = null;
    this._pending = new Map();
    this._seq = 0;
    this._buf = '';
    /** Bounded record of what actually went across, for the control window. */
    this.activity = [];
  }

  _note(text, ok = true) {
    this.activity.push({ at: Date.now(), text: String(text), ok });
    if (this.activity.length > 100) this.activity.shift();
  }

  /** Start the bridge and complete the handshake. Never throws. */
  async connect() {
    const s = settings(this.cfg);
    if (!s) {
      this.state = STATE.NOT_CONFIGURED;
      this.reason = 'no bridge command in config';
      return { ok: false, state: this.state, reason: this.reason };
    }
    if (this.state === STATE.CONNECTED) return { ok: true, state: this.state };
    this.state = STATE.CONNECTING;
    this.reason = '';
    try {
      this.child = spawn(s.command[0], s.command.slice(1), {
        cwd: s.cwd,
        env: s.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return this._down(`could not start the bridge: ${e.message}`);
    }
    this.child.on('error', (e) => this._down(`bridge process error: ${e.message}`));
    this.child.on('exit', (code, sig) => this._down(`bridge exited (${sig || `code ${code}`})`));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this._onData(d));
    // A bridge's stderr is diagnostics, not protocol. Kept, bounded, shown.
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => this._note(`bridge stderr: ${String(d).trim().slice(0, 200)}`, false));

    const hello = await this._send({ op: 'hello', client: 'lain', version: 1 }, HELLO_TIMEOUT_MS);
    if (!hello.ok) return this._down(`handshake failed: ${hello.error}`);
    this.capabilities = Array.isArray(hello.capabilities) ? hello.capabilities.filter((c) => OPS[c]) : [];
    this.info = { name: hello.name || s.name, version: hello.version || null };
    this.state = STATE.CONNECTED;
    this.reason = '';
    this._note(`connected to ${this.info.name} · ${this.capabilities.length} capability(ies)`);
    return { ok: true, state: this.state, capabilities: this.capabilities, info: this.info };
  }

  _down(reason) {
    const wasConnected = this.state === STATE.CONNECTED;
    this.state = configured(this.cfg) ? STATE.DISCONNECTED : STATE.NOT_CONFIGURED;
    this.reason = String(reason || 'disconnected');
    this.capabilities = [];
    for (const [, p] of this._pending) p.reject(new Error(this.reason));
    this._pending.clear();
    if (wasConnected) this._note(this.reason, false);
    // A bridge that dies while it holds permission does not get to keep it.
    if (wasConnected && this.permissions) this.permissions.revoke('the bridge disconnected');
    return { ok: false, state: this.state, reason: this.reason };
  }

  _onData(chunk) {
    this._buf += chunk;
    if (this._buf.length > MAX_LINE * 2) { this._down('bridge sent an oversized message'); return; }
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this._note(`unparseable line from bridge: ${line.slice(0, 120)}`, false); continue; }
      const p = this._pending.get(msg.id);
      if (!p) continue;
      this._pending.delete(msg.id);
      p.resolve(msg);
    }
  }

  _send(payload, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve) => {
      if (!this.child || this.child.killed) { resolve({ ok: false, error: 'the bridge is not running' }); return; }
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
   * Perform one operation. THE GATE IS HERE, checked on every call.
   *
   * @returns {{ok, result?, error?, denied?}}
   */
  async call(op, params = {}) {
    const cap = OPS[op];
    if (!cap) return { ok: false, error: `unknown desktop operation "${op}"` };
    if (this.state !== STATE.CONNECTED) {
      return { ok: false, error: `the desktop bridge is ${this.state}${this.reason ? ` — ${this.reason}` : ''}` };
    }
    if (this.capabilities.length && !this.capabilities.includes(op)) {
      return { ok: false, error: `this bridge does not offer ${op}` };
    }
    const allowed = this.permissions ? this.permissions.check(cap) : { ok: false, why: 'no permission system' };
    if (!allowed.ok) {
      // NOT AN ERROR TO ROUTE AROUND. The caller is told exactly what is missing
      // and must go and ask the user for it.
      return { ok: false, denied: true, capability: cap, error: `permission to ${cap} is ${allowed.why}` };
    }
    const r = await this._send({ op, params });
    if (this.permissions) this.permissions.used(cap, op);
    this._note(`${op} — ${r.ok ? 'ok' : `failed: ${r.error}`}`, Boolean(r.ok));
    // The control window shows each action as it happens, not a summary after.
    try { require('./controlwindow').write(this._app || null); } catch { /* no window open */ }
    if (!r.ok) return { ok: false, error: r.error || 'the bridge refused' };
    return { ok: true, result: r.result };
  }

  /** Stop the bridge and drop every grant with it. */
  close(why = 'closed') {
    if (this.permissions) this.permissions.revoke(why);
    if (this.child) { try { this.child.kill(); } catch { /* already gone */ } }
    this.child = null;
    this.state = configured(this.cfg) ? STATE.DISCONNECTED : STATE.NOT_CONFIGURED;
    this.reason = why;
    this.capabilities = [];
    return true;
  }

  /** What every status surface reads. Never claims more than is true. */
  status() {
    const perms = this.permissions ? this.permissions.state() : { active: false, capabilities: {}, log: [] };
    return {
      state: this.state,
      reason: this.reason,
      configured: configured(this.cfg),
      name: this.info ? this.info.name : (settings(this.cfg) || {}).name || null,
      capabilities: this.capabilities,
      permissions: perms,
      target: perms.target || null,
      activity: this.activity.slice(-20),
    };
  }
}

module.exports = {
  servers, Bridge, OPS, STATE, settings, configured, HELLO_TIMEOUT_MS, CALL_TIMEOUT_MS };
