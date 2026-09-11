'use strict';

/**
 * THE LAIN HARNESS APPLICATION — the graphical product, served locally.
 *
 * ------------------------------------------------------------------------
 * THE STACK, AND WHY IT IS THIS ONE.
 *
 * Node's own `http`, and one self-contained page of vanilla HTML/CSS/JS. No
 * framework, no bundler, no build step, no dependency.
 *
 * That is not minimalism for its own sake. This repository has ZERO runtime
 * dependencies and ships as `files: ["bin/", "src/", ...]` — source only, no
 * build output. Adding React would add a toolchain, a build artifact, a
 * `node_modules` at install time and a second way for `lain` to fail to start,
 * in exchange for component ergonomics on a UI that is a sidebar, a
 * conversation, a picker and a preview pane.
 *
 * And the pattern is already proven HERE: `dash.js` + `dashpage.js` serve a
 * live, polling, authenticated local UI exactly this way. Extending a working
 * foundation was the instruction; this is what extending it looks like.
 *
 * ------------------------------------------------------------------------
 * IT IS A SECOND SURFACE OVER ONE PRODUCT, NOT A SECOND PRODUCT.
 *
 * The CLI and this application drive the SAME `App`, in the SAME process, over
 * the SAME session. Typing in the terminal and typing in the browser append to
 * one conversation, because there is one. Nothing here holds state that the
 * Core does not already own — see state.js, which is the whole read model.
 *
 * ------------------------------------------------------------------------
 * AUTHENTICATION IS `dashauth`, UNCHANGED.
 *
 * A startup password printed in the terminal, a session token minted for a
 * client that proves it, bounded attempts, and the credential never in the URL.
 * That machinery exists, is tested, and had its own defect found and fixed
 * once; a second copy of it here would be a second thing to get wrong.
 *
 * ------------------------------------------------------------------------
 * LOOPBACK ONLY. Binding this to a LAN interface would expose a surface that
 * can start browsers, drive a dev server and submit turns on somebody's
 * machine. `dash` has a deliberate `lan` opt-in for a read-mostly view; this
 * has no such flag, and adding one is a decision with a much higher bar.
 */

const http = require('http');
const crypto = require('crypto');

const routes = require('./routes');

/** The port the application prefers. One above the dashboard's neighbourhood. */
const DEFAULT_PORT = 4478;
/** Bodies are commands and prompts, never uploads. */
const MAX_BODY = 256 * 1024;

/** Module-scope, like dash.js: at most one application server per process. */
let state = null;
let server = null;

function startupPassword() { return crypto.randomBytes(16).toString('hex'); }

/** How long a launch token is worth anything. It is used within a second. */
const LAUNCH_TTL_MS = 120_000;

/**
 * MINT A ONE-TIME LAUNCH TOKEN.
 *
 * Stored on `state` rather than in a module-level map so it dies with the
 * server: a token that outlived the listener it was minted for would be a
 * credential with no owner.
 */
function mintLaunchToken() {
  if (!state) return null;
  const token = crypto.randomBytes(24).toString('hex');
  state.launch = { token, expires: Date.now() + LAUNCH_TTL_MS };
  return token;
}

/**
 * SPEND ONE, OR REFUSE. Returns a real session credential, or null.
 *
 * SINGLE USE IS ENFORCED BY DELETING IT FIRST, before any comparison can fail
 * or throw. A token that survives a rejected attempt is not single-use, and the
 * ordering is the only thing that guarantees it.
 */
function consumeLaunchToken(supplied) {
  if (!state || !state.launch || !supplied) return null;
  const held = state.launch;
  state.launch = null;
  if (Date.now() > held.expires) return null;
  const given = String(supplied);
  if (given.length !== held.token.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(held.token))) return null;
  return state.sessions.grant('harness-app-launch');
}

function send(res, code, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(code, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    // A local application that frames nothing and is framed by nothing.
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

/**
 * IS THIS REQUEST ALLOWED? The same rule dash.js applies, for the same reasons.
 *
 * The credential travels in a HEADER, never in the URL: a URL leaks through
 * history, the address bar, proxy logs and `Referer`, and sending somebody "the
 * link" would send them the credential for good.
 */
function authorised(req) {
  if (!state) return false;
  const supplied = String(req.headers['x-lain-session'] || '');
  if (!supplied) return false;
  if (state.sessions && state.sessions.valid(supplied)) return true;
  if (supplied.length !== state.startupPassword.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(state.startupPassword));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let over = false;
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY) { over = true; req.destroy(); }
    });
    req.on('end', () => {
      if (over) return resolve(null);
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

async function handle(app, req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ---- THE SHELL IS PUBLIC; EVERY FACT BEHIND IT IS NOT -----------------
  //
  // Serving the page without a credential is what lets the credential live in a
  // header instead of the URL: the page loads, asks for the password, and holds
  // the session token in memory. The page itself carries no state and no secret.
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    // ---- A ONE-TIME LAUNCH TOKEN REPLACES THE PASTED PASSWORD ----------
    //
    // `/app` opens this page in the person's browser itself, so there is no
    // step at which a human should be retyping a hex string that LAIN just
    // printed and LAIN is about to check. That flow was the reported defect:
    // the password could be pasted but Enter sometimes did not take it, and a
    // failure said very little.
    //
    // SO THE TOKEN TRAVELS ONCE, IN THE URL LAIN ITSELF OPENED, and is
    // consumed by the first request that presents it. Everything that makes a
    // URL secret unsafe is bounded here: it is single-use, it expires in
    // LAUNCH_TTL_MS, it is only ever minted for a loopback listener, and the
    // page erases it from the address bar before anything else runs.
    //
    // The SESSION credential still travels in a header and never in a URL —
    // see `authorised`. This changes only how the FIRST one is delivered.
    //
    // This is prototype-grade on purpose. The desktop application will use
    // local IPC and will not have a browser-shaped auth problem at all.
    const handed = consumeLaunchToken(url.searchParams.get('t'));
    send(res, 200, require('./page').html({ session: handed }), 'text/html');
    return;
  }

  // THE ONE ROUTE THAT RUNS BEFORE AUTHORISATION, because it is how a client
  // becomes authorised. Bounded attempts; a locked-out server says so.
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readBody(req);
    if (!body) { send(res, 400, { ok: false, why: 'unreadable request' }); return; }
    if (state.sessions.lockedOut) {
      send(res, 429, { ok: false, why: 'too many attempts — restart LAIN to try again' });
      return;
    }
    const given = String(body.password || '');
    const okLength = given.length === state.startupPassword.length;
    const good = okLength && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(state.startupPassword));
    if (!good) {
      const left = state.sessions.noteFailure();
      send(res, 401, { ok: false, why: `wrong password — ${left} attempt(s) left` });
      return;
    }
    send(res, 200, { ok: true, session: state.sessions.grant('harness-app') });
    return;
  }

  if (!authorised(req)) { send(res, 401, { ok: false, why: 'a password is required' }); return; }

  const body = req.method === 'POST' ? await readBody(req) : {};
  if (body === null) { send(res, 400, { ok: false, why: 'unreadable request' }); return; }
  const r = await routes.dispatch(app, req.method, url.pathname, body);
  send(res, r.code, r.body);
}

/** The URL `/app` actually opens: the shell, carrying one single-use token. */
function launchUrl() {
  const t = mintLaunchToken();
  return t ? `${state.url}?t=${t}` : state.url;
}

/**
 * START IT. Returns `{ok, port, url, startupPassword}` — the password is printed
 * by the caller, in the terminal, where only the person at the machine sees it.
 */
function start(app, { port = DEFAULT_PORT } = {}) {
  return new Promise((resolve) => {
    if (server) {
      // A FRESH TOKEN EACH TIME. `/app` twice must open twice; a token that was
      // already spent by the first launch would send the second to a login
      // prompt the person was told they would not see.
      resolve({
        ok: true, already: true, port: state.port, url: state.url,
        startupPassword: state.startupPassword,
        launchUrl: launchUrl(),
      });
      return;
    }
    state = {
      startupPassword: startupPassword(),
      sessions: new (require('../dashauth').Sessions)(),
      port: Number(port) || DEFAULT_PORT,
      url: '',
    };
    server = http.createServer((req, res) => {
      handle(app, req, res).catch((e) => {
        try { send(res, 500, { ok: false, why: (e && e.message) || String(e) }); } catch { /* the socket is gone */ }
      });
    });
    server.on('error', (e) => {
      server = null;
      const held = state;
      state = null;
      resolve({ ok: false, why: `could not serve the Harness application on ${held.port}: ${(e && e.message) || e}` });
    });
    // LOOPBACK ONLY — see the header. This surface starts browsers and submits
    // turns; it is not something to put on a network interface.
    server.listen(state.port, '127.0.0.1', () => {
      state.port = server.address().port;
      state.url = `http://127.0.0.1:${state.port}/`;
      resolve({
        ok: true, port: state.port, url: state.url,
        startupPassword: state.startupPassword,
        launchUrl: launchUrl(),
      });
    });
  });
}

function status() {
  return state
    ? { running: true, port: state.port, url: state.url }
    : { running: false, port: null, url: null };
}

function stop() {
  if (!server) return { ok: true, stopped: false };
  try { server.close(); } catch { /* already closing */ }
  server = null;
  state = null;
  return { ok: true, stopped: true };
}

module.exports = { start, stop, status, handle, authorised, mintLaunchToken, consumeLaunchToken, launchUrl, DEFAULT_PORT, MAX_BODY, LAUNCH_TTL_MS };
