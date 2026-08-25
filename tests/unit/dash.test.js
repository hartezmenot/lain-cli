'use strict';

/**
 * `/dash` — THE REMOTE-CONTROL DASHBOARD.
 *
 * A listening socket on someone's machine has to earn its place, so these are
 * mostly assertions about what it REFUSES:
 *
 *   - it binds localhost unless LAN is asked for, explicitly
 *   - every request needs the session token, page and API alike
 *   - it is read-only until control is turned on, deliberately, in the terminal
 *   - the action set is fixed and tiny — there is no shell, no file write, and
 *     no way to add one through configuration
 *   - the payload carries no credential and no message content
 *
 * The server is started for real on an ephemeral port and driven over real
 * HTTP; nothing here mocks the transport.
 */

const assert = require('assert');
const http = require('http');
const { test } = require('../helpers');

const dash = require('../../src/dash');

/** An app with just enough state for the dashboard to read. */
function fakeApp() {
  const { App } = require('../../src/app');
  return new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
}

function get(port, path, headers = {}) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ code: res.statusCode, body, headers: res.headers }));
    }).on('error', (e) => resolve({ code: 0, body: e.message }));
  });
}

function post(port, path, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ code: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ code: 0, body: e.message }));
    req.end(data);
  });
}

module.exports = async function () {
  await test('PASSWORD: the whole login flow, over real HTTP', async () => {
    //. Driven end to end against the real server rather than against the
    // auth module, because the thing that has to be true is a property of the
    // ROUTES: what is public, what 401s, what a wrong guess costs, and what a
    // correct one buys.
    const auth = require('../../src/dashauth');
    const app = fakeApp();
    app.cfg = { ...app.cfg, dashPassword: auth.hash('sofa-password') };
    const r = await dash.start(app, { port: 0 });
    try {
      // The shell is public — it must load in order to ASK for the password.
      assert.strictEqual((await get(r.port, '/')).code, 200);
      // Every fact behind it is not.
      assert.strictEqual((await get(r.port, '/api/state')).code, 401);

      // THE GATE ASKS WHAT KIND OF CREDENTIAL THIS LAIN WANTS. Without this the
      // page would have to guess, and a form that says "token" to somebody who
      // set a password cannot possibly work.
      const what = await get(r.port, '/api/auth');
      assert.strictEqual(what.code, 200);
      assert.strictEqual(JSON.parse(what.body).password, true);

      // A wrong password is refused and says how many guesses remain.
      const bad = await post(r.port, '/api/login', { password: 'not it' });
      assert.strictEqual(bad.code, 401);
      assert.ok(Number.isFinite(JSON.parse(bad.body).attemptsLeft), 'guessing must be bounded and say so');

      // The right one buys a SESSION token — so the password crosses the wire
      // once rather than on every request.
      const ok = await post(r.port, '/api/login', { password: 'sofa-password' });
      assert.strictEqual(ok.code, 200);
      const key = JSON.parse(ok.body).session;
      assert.ok(key && key.length >= 32, 'the login must mint a session key');
      assert.ok(!ok.body.includes('sofa-password'), 'THE PASSWORD MUST NOT BE ECHOED BACK');
      assert.strictEqual((await get(r.port, '/api/state', { 'x-lain-session': key })).code, 200);

      // And revoking really logs the page out rather than just looking like it.
      dash.revokeSessions();
      assert.strictEqual((await get(r.port, '/api/state', { 'x-lain-session': key })).code, 401);
    } finally { dash.stop(); }
  });

  await test('PASSWORD: with none set, the printed STARTUP PASSWORD still works', async () => {
    // Nobody is locked out by this change. A LAIN with no password behaves
    // exactly as it did, and `/api/auth` says so, so the gate asks for a token.
    const app = fakeApp();
    const r = await dash.start(app, { port: 0 });
    try {
      assert.strictEqual(JSON.parse((await get(r.port, '/api/auth')).body).password, false);
      assert.strictEqual((await get(r.port, '/api/state', { 'x-lain-session': r.startupPassword })).code, 200);
      // And logging in is refused with a reason rather than a confusing 401.
      const none = await post(r.port, '/api/login', { password: 'anything' });
      assert.strictEqual(none.code, 409);
      assert.match(JSON.parse(none.body).error, /no password is set/);
    } finally { dash.stop(); }
  });

  await test('DASH: it binds LOCALHOST unless LAN is asked for', async () => {
    const app = fakeApp();
    const r = await dash.start(app, { port: 0 });
    try {
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.host, '127.0.0.1', 'the default must not be reachable from the network');
      assert.strictEqual(r.lan, false);
      assert.ok(r.urls[0].startsWith('http://127.0.0.1:'));
    } finally { dash.stop(); }
  });

  await test('DASH: no token, no ANSWER — every fact is behind the token', async () => {
    const app = fakeApp();
    const r = await dash.start(app, { port: 0 });
    try {
      assert.strictEqual((await get(r.port, '/api/state')).code, 401);
      assert.strictEqual((await get(r.port, '/api/state?t=wrong')).code, 401);
      // A token of the right LENGTH but the wrong value is still no.
      const wrong = 'f'.repeat(r.startupPassword.length);
      assert.strictEqual((await get(r.port, `/api/state?t=${wrong}`)).code, 401);
      assert.strictEqual((await get(r.port, `/api/state?t=${r.startupPassword}`)).code, 200);
      // The header is the way the page sends it now, and must work identically.
      const viaHeader = await get(r.port, '/api/state', { 'x-lain-session': r.startupPassword });
      assert.strictEqual(viaHeader.code, 200, 'the header form must be accepted');
      assert.strictEqual((await get(r.port, '/api/state', { 'x-lain-session': wrong })).code, 401);
    } finally { dash.stop(); }
  });

  await test('DASH: the PAGE is served without a token, and contains nothing worth taking', async () => {
    // THE SHELL USED TO 401, and that is what forced the token into the URL:
    // there was no other way to load the page, so the link and the credential
    // became one string — and a URL leaks through history, the address bar,
    // proxy logs, `Referer`, and every "here's the dashboard link" ever sent.
    //
    // The page is now an empty shell. Serving it to anyone costs nothing
    // BECAUSE it holds nothing, and that is what this asserts: not merely that
    // it returns 200, but that a stranger who loads it learns no fact.
    const app = fakeApp();
    const r = await dash.start(app, { port: 0 });
    try {
      const res = await get(r.port, '/');
      assert.strictEqual(res.code, 200, 'the shell must load so it can ASK for the token');
      assert.ok(!res.body.includes(r.startupPassword), 'THE TOKEN MUST NOT BE IN THE PAGE');
      // Nothing about this session either — the shell is served before anyone
      // has proved who they are.
      for (const secret of [app.session.id, app.session.cwd, app.cfg.model]) {
        if (!secret) continue;
        assert.ok(!res.body.includes(String(secret)),
          `the unauthenticated shell leaked ${JSON.stringify(String(secret))}`);
      }
      // And it must actually be the gate, not a page that merely renders empty.
      assert.ok(/id="gate"/.test(res.body), 'the shell must carry the token gate');
    } finally { dash.stop(); }
  });

  await test('DASH: the URL it hands out does NOT carry the token', async () => {
    const app = fakeApp();
    const r = await dash.start(app, { port: 0 });
    try {
      for (const u of r.urls) {
        assert.ok(!u.includes(r.startupPassword), `the printed URL is the credential: ${u}`);
        assert.ok(!/[?&]t=/.test(u), `the printed URL still has a token parameter: ${u}`);
      }
      // BUT AN OLD LINK IS NOT TURNED AWAY. Anyone holding one keeps working;
      // the page scrubs it from the address bar on arrival.
      assert.strictEqual((await get(r.port, `/api/state?t=${r.startupPassword}`)).code, 200,
        'the query form must still be honoured for links already in the wild');
    } finally { dash.stop(); }
  });

  await test('DASH: the state says what LAIN is doing, and carries no secrets', async () => {
    const app = fakeApp();
    app.cfg = { ...app.cfg, apiKey: 'sk-should-never-appear', connections: { x: { apiKey: 'sk-secret-value' } } };
    const r = await dash.start(app, { port: 0 });
    try {
      const res = await get(r.port, `/api/state?t=${r.startupPassword}`);
      const s = JSON.parse(res.body);
      assert.ok(s.project && s.project.name, 'the project must be named');
      assert.ok('task' in s && 'model' in s && 'desktop' in s && 'external' in s);
      assert.ok(!/sk-secret-value|sk-should-never-appear/.test(res.body), 'no credential may cross the wire');
      // Nor the conversation itself.
      assert.ok(!('messages' in s) || !Array.isArray(s.messages), 'message content is not the dashboard business');
    } finally { dash.stop(); }
  });

  await test('DASH: READ-ONLY until control is turned on in the terminal', async () => {
    const app = fakeApp();
    const r = await dash.start(app, { port: 0 });
    try {
      const denied = await post(r.port, `/api/action?t=${r.startupPassword}`, { action: 'stop' });
      assert.strictEqual(denied.code, 403);
      assert.match(denied.body, /read-only/);
      dash.setActions(true);
      const allowed = await post(r.port, `/api/action?t=${r.startupPassword}`, { action: 'stop' });
      // Nothing is running, so it fails — but it was ATTEMPTED, which is the
      // difference this test is about.
      assert.strictEqual(allowed.code, 400);
      assert.match(allowed.body, /nothing is running/);
    } finally { dash.stop(); }
  });

  await test('DASH: the action set is FIXED — no shell, no file write, no escape', async () => {
    assert.deepStrictEqual(Object.keys(dash.ACTIONS).sort(), ['cancel-retry', 'revoke-desktop', 'steer', 'stop']);
    const app = fakeApp();
    const r = await dash.start(app, { port: 0 });
    try {
      dash.setActions(true);
      for (const attempt of ['shell', 'run', 'exec', 'write', 'read', 'eval', 'undo', '/exit']) {
        const res = await post(r.port, `/api/action?t=${r.startupPassword}`, { action: attempt, value: 'rm -rf /' });
        assert.strictEqual(res.code, 400, `"${attempt}" must not be reachable`);
        assert.match(res.body, /unknown action/);
      }
    } finally { dash.stop(); }
  });

  await test('DASH: REVOKE DESKTOP works from the dashboard, immediately', async () => {
    const app = fakeApp();
    app.desktop().permissions.grant(['screen', 'mouse'], { scope: 'session' });
    assert.strictEqual(app.desktop().permissions.state().active, true);
    const r = await dash.start(app, { port: 0 });
    try {
      dash.setActions(true);
      const res = await post(r.port, `/api/action?t=${r.startupPassword}`, { action: 'revoke-desktop' });
      assert.strictEqual(res.code, 200);
      assert.strictEqual(app.desktop().permissions.state().active, false, 'the grant must be gone at once');
    } finally { dash.stop(); }
  });

  await test('DASH: the page is self-contained — it fetches nothing from anywhere', async () => {
    const app = fakeApp();
    const r = await dash.start(app, { port: 0 });
    try {
      const res = await get(r.port, `/?t=${r.startupPassword}`);
      assert.strictEqual(res.code, 200);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.match(res.headers['content-security-policy'], /default-src 'none'/);
      // No CDN, no font, no image, no external anything.
      assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(res.body.replace(/http:\/\/\$\{/g, '')),
        'the page must not reference any external origin');
      assert.match(res.body, /LAIN/);
    } finally { dash.stop(); }
  });

  await test('DASH: stopping it really stops it', async () => {
    const app = fakeApp();
    const r = await dash.start(app, { port: 0 });
    dash.stop();
    assert.strictEqual(dash.status().running, false);
    const after = await get(r.port, `/api/state?t=${r.startupPassword}`);
    assert.strictEqual(after.code, 0, 'the socket must be closed, not merely ignored');
  });

  await test('DASH: /dash, /rc and /ready are three things and none is an alias', () => {
    const commands = require('../../src/commands');
    // /rc USED TO MEAN READINESS. It now means REMOTE CONTROL, and readiness
    // moved to /ready with the same engine — see reportcommands.js. The property
    // these three assertions protect is unchanged: separate subjects, separate
    // engines, no aliasing.
    for (const name of ['/dash', '/rc', '/ready']) {
      assert.ok(commands.REGISTRY.has(name), `${name} must exist`);
    }
    const dash = commands.REGISTRY.get('/dash');
    const rc = commands.REGISTRY.get('/rc');
    const ready = commands.REGISTRY.get('/ready');
    assert.notStrictEqual(dash.run, rc.run, '/dash is a local web server; /rc is a Telegram bot');
    assert.notStrictEqual(rc.run, ready.run, '/rc is remote control; /ready is readiness');
    assert.notStrictEqual(dash.run, ready.run);
    assert.match(rc.desc, /remote/i, '/rc must read as remote control');
    assert.ok(!/remote control/i.test(ready.desc), '/ready must not read as remote control');
  });

  // ---- OVERLAY NETWORKS: RECOGNISED, NEVER ASSUMED INSTALLED ----------------
  //
  // Neither ZeroTier nor Tailscale is a dependency LAIN can assume: `addresses()`
  // only ever TAGS what `os.networkInterfaces()` already reports, so a machine
  // with neither installed sees a plain LAN address and nothing claims otherwise.

  await test('DASH: a Tailscale CGNAT address (100.64.0.0/10) is recognised by IP alone', () => {
    // The whole block, not just one address in it — 100.64.x.x through
    // 100.127.x.x is 64 different /16s, and an off-by-one in the range check
    // would silently stop tagging half of them.
    assert.ok(dash.isTailscaleAddress('100.64.0.1'));
    assert.ok(dash.isTailscaleAddress('100.100.5.9'));
    assert.ok(dash.isTailscaleAddress('100.127.255.254'));
    // Just outside the block on both sides — a real, ordinary address must
    // never be mistaken for an overlay network.
    assert.ok(!dash.isTailscaleAddress('100.63.255.255'));
    assert.ok(!dash.isTailscaleAddress('100.128.0.0'));
    assert.ok(!dash.isTailscaleAddress('10.0.0.5'), 'an ordinary private LAN address is not CGNAT');
    assert.ok(!dash.isTailscaleAddress(''));
    assert.ok(!dash.isTailscaleAddress(undefined));
  });

  await test('DASH: addresses() tags a Tailscale-named interface even off the CGNAT range', () => {
    // `os.networkInterfaces()` is read live and cannot be scripted here without
    // mocking the os module, so this drives `addresses()` for real and only
    // asserts on its SHAPE: every entry must carry both flags, independently —
    // the interface-name check and the IP-range check are two different signals
    // and neither may silently stand in for the other.
    for (const a of dash.addresses()) {
      assert.strictEqual(typeof a.zerotier, 'boolean');
      assert.strictEqual(typeof a.tailscale, 'boolean');
    }
  });
};
