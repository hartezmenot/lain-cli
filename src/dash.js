'use strict';

/**
 * `/dash` — REMOTE CONTROL, from a phone on the sofa.
 *
 * Not readiness, which answers "is LAIN ready?" and lives at `/ready`. This is
 * a small web dashboard that answers "what is LAIN doing, and can I nudge it
 * from over here?". The two are never merged again.
 *
 * WHAT MAKES IT SAFE ENOUGH TO EXIST:
 *
 *   LOCALHOST BY DEFAULT. It binds 127.0.0.1 unless the user explicitly asks
 *   for LAN, and the LAN form says out loud what it just exposed. Nothing here
 *   ever binds a public interface on its own.
 *
 *   A PASSWORD, AND ONLY A PASSWORD. There is one user-facing credential for
 *   this dashboard and it is called a password everywhere a person can see it.
 *   Either the user set one with `/dash password`, or LAIN generated a STARTUP
 *   PASSWORD and printed it once in the terminal. Proving it buys a SESSION
 *   KEY, which is plumbing the page sends on every request and which nobody is
 *   ever asked to read, type or transcribe. Anyone on the LAN who has not
 *   proved the password gets 401.
 *
 *   THIS USED TO BE CALLED A TOKEN, and the word was the problem rather than a
 *   label on it. "Token" named two completely different things — a credential a
 *   human types and a key a browser holds — so the gate offered them as equal
 *   alternatives, which made the password look optional, and no screen could
 *   say which one it wanted. One name for the human half, one name for the
 *   machine half, and they are never confused again.
 *
 *   READ-ONLY UNTIL YOU SAY OTHERWISE. Actions are refused until `/dash actions
 *   on`, and the set is fixed and tiny: stop the turn, steer it, cancel a retry,
 *   revoke desktop permission. There is NO shell endpoint, NO file write, NO
 *   arbitrary command, and no way to add one through configuration. A web page
 *   equivalent to a terminal is exactly what this must not be.
 *
 *   NO SECRETS ON THE WIRE. The state payload carries model names, phases,
 *   counts and file names — never API keys, never message content, never the
 *   contents of files.
 *
 * Zero dependencies: node:http and one self-contained HTML page.
 */

const http = require('http');
const os = require('os');
const crypto = require('crypto');

/**
 * A FREE PORT, CHOSEN BY THE OS — not a well-known one.
 *
 * This defaulted to 8787 until the very machine it was written on turned out to
 * be running something else there. Windows lets a second socket bind
 * 127.0.0.1:8787 while another program holds 0.0.0.0:8787, no error is raised,
 * and which of the two answers a local connection is then a coin toss — so LAIN
 * printed a URL that opened somebody else's application. An ephemeral port
 * cannot collide, and the fixed number bought nothing anyway: the startup
 * password changes every session, so the URL has to be copied fresh regardless.
 * `/dash port <n>` is there for anyone who genuinely wants a stable one.
 */
const DEFAULT_PORT = 0;
/** How much recent activity the page shows. Bounded, like every other feed. */
const RECENT = 12;

/** The only things a remote client may ever ask LAIN to do. */
const ACTIONS = Object.freeze({
  stop: 'stop the running turn',
  steer: 'send a steering instruction to the running turn',
  'cancel-retry': 'stop waiting for a rate limit',
  'revoke-desktop': 'revoke every desktop permission now',
});

let server = null;
let state = null;

/**
 * THE STARTUP PASSWORD — a random one, minted per run and printed once.
 *
 * It exists so a LAIN with no password set is still reachable, and so there is
 * something to type into the gate the first time. It is a PASSWORD in the only
 * sense that matters here: it is the thing a person types to get in. It is not
 * a second KIND of credential with its own vocabulary, which is what calling it
 * a token made it look like.
 */
function startupPassword() { return crypto.randomBytes(16).toString('hex'); }

/**
 * Tailscale hands out addresses from the CGNAT block 100.64.0.0/10 — the 64
 * IPv4 /16s from 100.64.x.x to 100.127.x.x — regardless of what the interface
 * happens to be named on a given OS, so the address itself is the reliable
 * signal; the interface name (`tailscale0`, `Tailscale`) is a second, cheaper
 * check that catches it before parsing the octets.
 */
function isTailscaleAddress(ip) {
  const m = /^100\.(\d{1,3})\./.exec(String(ip || ''));
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
}

/** Every non-internal IPv4 address, so the URL printed is one that works. */
function addresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      out.push({
        name,
        address: i.address,
        zerotier: /zerotier|zt/i.test(name) || /^10\.\d+\./.test(i.address),
        tailscale: /tailscale/i.test(name) || isTailscaleAddress(i.address),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------- state ---

/**
 * WHAT THE DASHBOARD SHOWS. Read from state that already exists; nothing here
 * computes a second version of anything, and nothing here is a secret.
 */
function dashState(app) {
  const s = app.session;
  const life = s.lifecycle;
  let pc = {};
  try { pc = require('./provider').resolve({ ...app.cfg, _evidence: app.connectionEvidence }); } catch { pc = {}; }

  const ui = app.ui || {};
  const phase = ui.phase || null;
  const turns = s.turns || [];
  const last = turns[turns.length - 1] || null;

  let changed = [];
  try {
    changed = require('./ui/panes').changedFiles({ checkpoints: app.checkpoints, cwd: s.cwd })
      .map((f) => ({ path: f.rel, kind: f.kind, added: f.added, removed: f.removed }));
  } catch { changed = []; }

  let desktop = { state: 'NOT CONFIGURED', configured: false, permissions: { capabilities: {}, active: false }, activity: [] };
  try { desktop = app.desktop().bridge.status(); } catch { /* keep the honest default */ }

  // WHICH MODEL ANSWERS A CHAT TURN — LAIN's own runtime, ChatGPT.com or
  // Gemini.google.com. Read from the registry, which is per SESSION; the
  // external-reviewer setting this replaced was per config and belonged to a
  // command that no longer exists.
  //
  // CHEAP BY CONSTRUCTION: `selectedId` and `usingWeb` read session fields and
  // launch nothing. A dashboard poll that opened a browser to draw a row would
  // be a status view with a side effect.
  let chat = { source: 'lain', label: 'LAIN', model: null, web: false };
  try {
    const reg = require('./modelsource/registry');
    const src = reg.selectedId(app);
    chat = {
      source: src,
      label: reg.LABEL[src] || src,
      model: ((s.sourceSelections || {})[src]) || null,
      web: reg.usingWeb(app),
    };
  } catch { /* keep the honest default */ }

  const recent = [];
  for (const a of (ui.liveActions && ui.liveActions.length ? ui.liveActions : (last && last.actions) || []).slice(-RECENT)) {
    recent.push({ name: a.name, target: a.target || '', ok: a.ok !== false, actor: a.actor || 'TOOL' });
  }

  const room = (() => { try { return require('./session').budgetChars(pc); } catch { return 0; } })();
  const used = (() => { try { return s.contextChars(); } catch { return 0; } })();

  return {
    at: Date.now(),
    project: { name: require('./ui/text').projectName(s.cwd), path: s.cwd },
    session: { id: s.id, turns: turns.length, messages: (s.messages || []).length },
    task: s.task ? { objective: String(s.task.objective).replace(/\s+/g, ' ').slice(0, 300), steers: (s.task.steers || []).length } : null,
    plan: s.plan && s.plan.steps ? {
      done: s.plan.steps.filter((x) => x.status === 'done').length,
      total: s.plan.steps.length,
      steps: s.plan.steps.slice(0, 20).map((x) => ({ text: String(x.text).slice(0, 120), status: x.status })),
    } : null,
    model: { id: pc.canonicalModel || pc.model || app.cfg.model || null, provider: pc.provider || null, connection: pc.connectionId || null, effort: app.cfg.effort || 'auto' },
    // WHO ANSWERS A CHAT TURN. `coding` is stated rather than implied because
    // it is the question a reader of this payload is most likely to get wrong:
    // selecting a website source changes who answers a QUESTION and never who
    // writes a file. See src/modelsource/lane.js.
    chatSource: { ...chat, coding: 'LAIN' },
    phase: phase ? { phase: phase.phase, actor: phase.actor || 'LAIN', tool: phase.tool || null, target: phase.target || null } : null,
    busy: Boolean(ui.busy || phase),
    interrupted: Boolean(ui.interrupted),
    retryCancelled: Boolean(ui.retryCancelled),
    retry: phase && phase.phase === 'RETRYING'
      ? { attempt: phase.attempt, of: phase.of, resumeAt: phase.resumeAt || null, rateLimited: Boolean(phase.rateLimited) }
      : null,
    lifecycle: life ? { state: life.state, reason: life.reason || null } : null,
    verification: life && life.lastCommand ? { command: life.lastCommand.command, ok: Boolean(life.lastCommand.ok) } : null,
    context: { used, room, percent: room ? Math.round((used / room) * 100) : 0 },
    changed,
    recent,
    // THE CONVERSATION ITSELF — see dashconversation.js. Built from the same
    // session state the CONTEXT pane renders, so the phone and the terminal
    // read one story rather than two.
    conversation: require('./dashconversation').conversation(s, {
      actions: ui.liveActions || [],
      narration: ui.liveNarration || [],
      user: ui.liveUser || null,
    }),
    outputs: (ui.outputs || []).slice(-3).map((o) => ({ command: o.command, exitCode: o.exitCode })),
    errors: (last && (last.errors || []).slice(0, 5).map((e) => `${e.kind}: ${e.message}`)) || [],
    desktop: {
      state: desktop.state,
      configured: Boolean(desktop.configured),
      reason: desktop.reason || null,
      name: desktop.name || null,
      target: desktop.target || null,
      capabilities: desktop.capabilities || [],
      permissions: desktop.permissions ? desktop.permissions.capabilities : {},
      active: Boolean(desktop.permissions && desktop.permissions.active),
      activity: (desktop.activity || []).slice(-6).map((a) => a.text),
    },
    // ---- THE HARNESS, AS A PROJECTION AND NOT A SECOND OPINION -----------
    //
    // The dashboard has always been a WINDOW: it renders what LAIN owns and
    // computes nothing of its own. The harness gave it a task state, a
    // verification verdict and a list of receipts that no window could have
    // derived from a transcript — so they are handed over here, in the one
    // shape every surface reads. `null` when no task has been opened, which is
    // a real state and must not render as an empty one. See harnesssurface.js.
    harness: (() => { try { return require('./harnesssurface').project(app); } catch { return null; } })(),
    control: {
      actions: state ? state.actions : false,
      bind: state ? state.host : null,
      connected: state ? state.clients : 0,
    },
  };
}

// ------------------------------------------------------------------ actions --

function performAction(app, action, value) {
  if (!ACTIONS[action]) return { ok: false, error: `unknown action "${action}"` };
  if (action === 'stop') {
    if (!app.abort || app.abort.signal.aborted) return { ok: false, error: 'nothing is running' };
    if (app.ui && app.ui.enabled) app.ui.setInterrupting(true);
    app.abort.abort();
    return { ok: true, did: 'stopped the running turn' };
  }
  if (action === 'cancel-retry') {
    const done = app.ui && typeof app.ui.cancelRetry === 'function' ? app.ui.cancelRetry() : false;
    return done ? { ok: true, did: 'cancelled the retry wait' } : { ok: false, error: 'no retry is waiting' };
  }
  if (action === 'revoke-desktop') {
    const had = app.desktop().permissions.revoke('revoked from the dashboard');
    return { ok: true, did: had.length ? `revoked ${had.join(', ')}` : 'nothing was granted' };
  }
  if (action === 'steer') {
    const text = String(value || '').trim();
    if (!text) return { ok: false, error: 'a steer needs something to say' };
    if (!app.abort || app.abort.signal.aborted) return { ok: false, error: 'no active task to steer' };
    app.queueSteer(text);
    return { ok: true, did: 'queued for the next model turn' };
  }
  return { ok: false, error: 'unreachable' };
}

// --------------------------------------------------------------------- http --

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'content-type': type + '; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    // The page is entirely self-contained; nothing may be pulled in from
    // anywhere else, and nothing may frame it.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

/**
 * MAY THIS REQUEST SEE ANYTHING? Two credentials are accepted, and they are for
 * two different people.
 *
 *   A SESSION KEY, minted by proving the password. This is what the page sends
 *     on every request once somebody has logged in. It is the normal path, the
 *     only one a browser ever uses, and it is never shown to anybody — it is
 *     plumbing, not a credential a person is asked to know.
 *
 *   THE STARTUP PASSWORD printed in the terminal. Kept because it is what
 *     `curl` and a script can use, and because someone who can read the
 *     terminal has already proved more than a password proves. It is also the
 *     way in when no password has been set yet.
 *
 * Both are compared in constant time against a value of the same length.
 *
 * `x-lain-session` is the header the page sends. `x-lain-token` is accepted
 * beside it because scripts written against the old name exist and turning them
 * away would be a breakage with no security gain — the value and the check are
 * identical, only the word changed.
 */
function authorised(url, req) {
  if (!state) return false;
  const supplied = String(
    url.searchParams.get('t')
    || req.headers['x-lain-session']
    || req.headers['x-lain-token']
    || '',
  );
  if (!supplied) return false;
  if (state.sessions && state.sessions.valid(supplied)) return true;
  if (supplied.length !== state.startupPassword.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(state.startupPassword));
}

function handle(app, req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ---- THE SHELL IS PUBLIC; EVERY FACT BEHIND IT IS NOT ---------------------
  //
  // This used to 401 the PAGE, which forced the token into the URL — there was
  // no other way to load it — and a URL is the one place a credential must
  // never live: browser history, the address bar, proxy logs, `Referer`, and
  // every copy-paste of "the dashboard link" carrying it onward for good.
  //
  // So the HTML is served to anyone who asks, because it contains NOTHING: no
  // token, no project, no task, no model, no conversation. It is an empty shell
  // that asks for the password and only then fetches. Refusing to serve an
  // empty page bought no secrecy and cost the credential its privacy.
  //
  // THE BOUNDARY DID NOT MOVE — it stopped being in the wrong place. Every
  // `/api/*` route below still requires the token on every single request, and
  // those are the only routes that know anything.
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    state.clients += 1;
    send(res, 200, page(), 'text/html');
    return;
  }

  // ---- LOGGING IN, which is the one route that runs BEFORE authorisation ----
  //
  // It has to: proving the password is how a client stops being anonymous. It
  // is also the only route that can be attacked by guessing, so it is the only
  // one that counts failures and stops answering after MAX_ATTEMPTS. That is a
  // hard stop cleared by restarting LAIN, not a delay — a dashboard on a LAN is
  // reachable by anything on that LAN.
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const auth = require('./dashauth');
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      if (state.sessions.lockedOut) {
        send(res, 429, { error: 'too many failed attempts — restart LAIN to try again' });
        return;
      }
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { j = {}; }
      if (!auth.configured(app.cfg)) {
        send(res, 409, { error: 'no password is set — run /dash password in the terminal' });
        return;
      }
      if (!auth.verify(app.cfg.dashPassword, j.password)) {
        const left = state.sessions.noteFailure();
        // The terminal is told, because a stranger guessing at your dashboard
        // is something the person sitting in front of LAIN should know about.
        app.render.notice('warn', `/dash: a failed login attempt (${left} remaining before it locks)`);
        send(res, 401, { error: 'wrong password', attemptsLeft: left });
        return;
      }
      // `session` is the honest name for what this is; `token` rides along so a
      // page or script written against the old key keeps working. Both carry
      // the same value — this is one field under two names, not two secrets.
      const key = state.sessions.grant(req.headers['user-agent'] || '');
      send(res, 200, { session: key, token: key });
    });
    return;
  }
  // WHICH PASSWORD THIS LAIN WANTS — the one the user set, or the startup one
  // it printed. The page cannot know, and guessing wrong means a login form
  // whose wording does not match the thing that would actually be accepted.
  // Public, because it reveals nothing but the shape of the question.
  if (req.method === 'GET' && url.pathname === '/api/auth') {
    send(res, 200, {
      password: require('./dashauth').configured(app.cfg),
      lockedOut: state.sessions.lockedOut,
    });
    return;
  }

  if (!authorised(url, req)) { send(res, 401, { error: 'a password is required' }); return; }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    // REFRESHED ON EVERY POLL, so a switcher shows what each LAIN is doing NOW
    // rather than what it was doing when it started.
    try { announceSelf(app); } catch { /* the registry is optional */ }
    send(res, 200, dashState(app));
    return;
  }
  // ---- THE OTHER LAINS ----------------------------------------------------
  //
  // Behind the credential, like everything else: the list names projects and
  // working directories, which is not something to hand to an unauthenticated
  // caller. It carries no token for any of them — switching means opening that
  // instance's own URL and proving yourself there, which is what keeps two
  // LAINs as separate as they are on the machine.
  if (req.method === 'GET' && url.pathname === '/api/instances') {
    send(res, 200, { instances: require('./instances').list() });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/action') {
    if (!state.actions) {
      send(res, 403, { error: 'this dashboard is read-only. Run /dash actions on in the terminal to allow control.' });
      return;
    }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { j = {}; }
      const r = performAction(app, String(j.action || ''), j.value);
      state.log.push({ at: Date.now(), action: j.action, ok: r.ok, detail: r.did || r.error });
      if (state.log.length > 50) state.log.shift();
      // Remote control is never silent locally: the terminal says what happened.
      app.render.notice(r.ok ? 'info' : 'warn', `/dash: ${j.action} — ${r.did || r.error}`);
      send(res, r.ok ? 200 : 400, r);
    });
    return;
  }
  send(res, 404, { error: 'not found' });
}

// --------------------------------------------------------------------- page --

/** One self-contained page. No frameworks, no fonts, no requests anywhere. */
/**
 * THE PAGE lives in dashpage.js — a mobile CONVERSATION rather than the stack
 * of status sections this used to serve. Split so this file stays the SERVER:
 * routing, the credential, the fixed action allowlist and the ephemeral session.
 * Presentation and permission enforcement are different jobs, and only one of
 * them is a security boundary.
 */
const page = () => require('./dashpage').page();

// ------------------------------------------------------------------ control --

function status() {
  if (!server || !state) return { running: false };
  return {
    running: true,
    host: state.host,
    port: state.port,
    // THE STARTUP PASSWORD, under the name it is called everywhere else.
    startupPassword: state.startupPassword,
    actions: state.actions,
    lan: state.host === '0.0.0.0',
    urls: urls(),
    pid: process.pid,
    clients: state.clients,
    tookAnotherPort: state.tookAnotherPort || null,
  };
}

/**
 * The addresses to open, WITHOUT the credential.
 *
 * These used to end `/?t=<secret>`, which made the URL and the credential the
 * same string — so the convenient thing to do with it (send yourself the link)
 * was also the thing that leaked it, permanently, into a chat history. The
 * password is printed on its own line beside these and typed into the page.
 *
 * `?t=` is still ACCEPTED by the server and still honoured by the page, so
 * nobody holding an old link is turned away; the page scrubs it out of the
 * address bar on arrival. It is simply no longer handed out.
 */
/** Log every dashboard page out. Used when the password changes. */
function revokeSessions() {
  return state && state.sessions ? state.sessions.revokeAll() : 0;
}

function urls() {
  if (!state) return [];
  const out = [`http://127.0.0.1:${state.port}/`];
  if (state.host === '0.0.0.0') {
    for (const a of addresses()) {
      const tag = a.tailscale ? '   (Tailscale?)' : a.zerotier ? '   (ZeroTier?)' : '';
      out.push(`http://${a.address}:${state.port}/${tag}`);
    }
  }
  return out;
}

/** Start the dashboard. Localhost unless `lan` is explicitly true. */
function start(app, { lan = false, port = DEFAULT_PORT } = {}) {
  if (server) return Promise.resolve({ ok: true, already: true, ...status() });
  const host = lan ? '0.0.0.0' : '127.0.0.1';
  state = {
    host, port, startupPassword: startupPassword(), actions: false, clients: 0, log: [],
    // Proved logins live here and nowhere else, so they die with the process.
    sessions: new (require('./dashauth').Sessions)(),
  };
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      try { handle(app, req, res); } catch (e) { send(res, 500, { error: e.message }); }
    });
    let fellBack = false;
    server.on('error', (e) => {
      // ANOTHER PROGRAM ALREADY HAS THE PORT — and on this machine, the default
      // 8787 really was taken by an unrelated app. Windows will happily let a
      // second socket bind 127.0.0.1:8787 while something else holds
      // 0.0.0.0:8787, and then which of them answers a local connection is
      // anyone's guess: LAIN would print a URL that opens somebody else's page.
      // `exclusive` makes the clash a real EADDRINUSE, and rather than failing
      // we take a free port and say which one.
      if (e.code === 'EADDRINUSE' && !fellBack) {
        fellBack = true;
        state.tookAnotherPort = state.port;
        try { server.listen({ port: 0, host, exclusive: true }); return; } catch { /* fall through */ }
      }
      server = null;
      const s = state; state = null;
      resolve({ ok: false, error: e.code === 'EADDRINUSE' ? `port ${s.port} is already in use` : e.message });
    });
    server.listen({ port, host, exclusive: true }, () => {
      state.port = server.address().port;
      // ANNOUNCE THIS INSTANCE once the port is real. Best-effort: a registry
      // that cannot be written costs the dashboard its switcher, not LAIN its
      // startup. See instances.js for why it is files and not a daemon.
      try { announceSelf(app); } catch { /* the dashboard still works alone */ }
      resolve({ ok: true, ...status() });
    });
  });
}

/**
 * Put this instance in the registry, or refresh what it says about itself.
 *
 * Called when the server binds and again whenever the dashboard is asked for
 * state — which is every poll, so the model, the task and the lifecycle a
 * switcher shows are current rather than whatever was true at startup.
 */
function announceSelf(app) {
  if (!state || !state.port) return null;
  const s = app && app.session;
  let pc = {};
  try { pc = require('./provider').resolve({ ...app.cfg, _evidence: app.connectionEvidence }); } catch { pc = {}; }
  return require('./instances').announce({
    port: state.port,
    host: state.host,
    project: s ? require('./ui/text').projectName(s.cwd) : '',
    cwd: s ? s.cwd : '',
    session: s ? s.id : '',
    model: pc.canonicalModel || pc.model || (app && app.cfg && app.cfg.model) || null,
    provider: pc.provider || null,
    state: s && s.lifecycle ? s.lifecycle.state : 'READY',
    task: s && s.task ? s.task.objective : null,
  });
}

function stop() {
  if (!server) return { ok: false, error: 'not running' };
  try { server.close(); } catch { /* already closing */ }
  // STOP ADVERTISING. A record pointing at a closed port is worse than no
  // record: it is a row in somebody's switcher that opens nothing.
  try { require('./instances').withdraw(); } catch { /* nothing to remove */ }
  server = null;
  state = null;
  return { ok: true };
}

function setActions(on) {
  if (!state) return { ok: false, error: 'not running' };
  state.actions = Boolean(on);
  return { ok: true, actions: state.actions };
}

module.exports = {
  start, stop, status, setActions, dashState, performAction, ACTIONS, page, addresses, DEFAULT_PORT, revokeSessions,
  isTailscaleAddress,
};
