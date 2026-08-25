'use strict';

/**
 * TWO REAL LAINS, ONE MACHINE — the dashboard's multi-session promise, driven
 * against the actual binaries rather than asserted from the registry alone.
 *
 * `instances.js` is a directory of small files precisely so two independent
 * `bin/lain.js` processes can discover each other with no daemon and no lock —
 * so this is the one place that claim is worth testing with two REAL processes
 * sharing one `LAIN_CONFIG_DIR`, not two in-process `App` objects sharing a
 * module cache no real deployment would share.
 *
 * Everything here spawns and kills real child processes; `runCli` (tests/
 * helpers.js) is not used because it waits for the child to exit on its own,
 * and a session holding a dashboard open does not exit until told to.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { test, tmpdir, BIN } = require('../helpers');
const dashauth = require('../../src/dashauth');

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function post(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload || {}));
  });
}

/** One real, headless `bin/lain.js`, sharing `configDir` so the registry sees it. */
function spawnLain(configDir, label) {
  const cwd = tmpdir(`lain-dash-proj-${label}-`);
  fs.writeFileSync(path.join(cwd, 'README.md'), `# ${label}\n`);
  const scriptPath = path.join(configDir, `script-${label}.json`);
  if (!fs.existsSync(scriptPath)) fs.writeFileSync(scriptPath, JSON.stringify([{ text: 'ok.' }]));
  const child = spawn(process.execPath, [BIN], {
    cwd,
    env: {
      ...process.env, LAIN_CONFIG_DIR: configDir, LAIN_PROVIDER: 'mock', LAIN_MOCK_SCRIPT: scriptPath,
      NO_COLOR: '1', LAIN_NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, cwd, getOut: () => out };
}

/**
 * Poll a spawned instance's own stdout for the dashboard line it prints once,
 * at startup. The per-session TOKEN line is only printed when NO password is
 * configured (see repl.js: "the token is not printed once a password
 * exists") — a password-gated instance prints "password required" on that
 * line instead. Waiting for the URL line ALONE is not enough: it and the line
 * under it are two separate writes that can arrive in separate stdout chunks,
 * so polling right after the URL appears can still read `getOut()` a moment
 * too early and miss whichever second line was coming.
 */
async function waitForDash(inst, { timeoutMs = 8000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const out = inst.getOut();
    const u = /dashboard (http:\S+)/.exec(out);
    // THE STARTUP PASSWORD IS ON ITS OWN ROW, under a `password` label. It used
    // to read `key <32 hex>` on one line, and that word was the last place the
    // old token vocabulary survived — see repl.js on why the value gets a row
    // of its own rather than sharing one at 40 columns.
    const t = /\bpassword\s*\r?\n\s*([0-9a-f]{32})/.exec(out);
    if (u && (t || /password required/.test(out))) return { url: u[1], password: t ? t[1] : null };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`dashboard never announced itself:\n${inst.getOut().slice(0, 2000)}`);
}

module.exports = async function () {
  await test('DASH LIVE: two real instances discover each other, and a killed one is swept', async () => {
    const configDir = tmpdir('lain-dash-cfg-');
    const a = spawnLain(configDir, 'alpha');
    const b = spawnLain(configDir, 'beta');
    try {
      const [ta, tb] = await Promise.all([waitForDash(a), waitForDash(b)]);

      const rA = await get(`${ta.url}api/instances`, { 'x-lain-session': ta.password });
      assert.strictEqual(rA.status, 200);
      const listA = JSON.parse(rA.body).instances;
      assert.ok(listA.some((i) => i.pid === b.child.pid), 'alpha must see beta running');
      assert.ok(listA.some((i) => i.pid === a.child.pid && i.self), 'alpha must mark itself');

      const rB = await get(`${tb.url}api/instances`, { 'x-lain-session': tb.password });
      const listB = JSON.parse(rB.body).instances;
      assert.ok(listB.some((i) => i.pid === a.child.pid), 'beta must see alpha running — discovery is mutual');

      // A WRONG TOKEN SEES NOTHING, on either instance.
      const rBad = await get(`${ta.url}api/state`, { 'x-lain-session': 'not-the-password' });
      assert.strictEqual(rBad.status, 401);

      // KILLING ONE MUST NOT TOUCH THE OTHER, and the survivor's registry must
      // stop listing a pid that no longer answers to it.
      b.child.kill('SIGKILL');
      let sawGone = false;
      for (let i = 0; i < 20 && !sawGone; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const r2 = await get(`${ta.url}api/instances`, { 'x-lain-session': ta.password });
        const list2 = JSON.parse(r2.body).instances;
        sawGone = !list2.some((i) => i.pid === b.child.pid);
      }
      assert.ok(sawGone, 'a killed instance must eventually disappear from the survivor\'s registry, not linger as a fake running session');

      const rAfter = await get(`${ta.url}api/state`, { 'x-lain-session': ta.password });
      assert.strictEqual(rAfter.status, 200, 'the surviving instance must keep answering after the other died');
    } finally {
      try { a.child.kill('SIGKILL'); } catch { /* already gone */ }
      try { b.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  await test('DASH LIVE: a configured password gates login, and wrong guesses lock out', async () => {
    const configDir = tmpdir('lain-dash-cfg-');
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      dashPassword: dashauth.hash('correct horse battery staple'),
    }));
    const inst = spawnLain(configDir, 'pw');
    try {
      const t = await waitForDash(inst);
      assert.match(inst.getOut(), /password required/, 'the startup password must not be printed once one is set');

      const rAuth = await get(`${t.url}api/auth`);
      assert.deepStrictEqual(JSON.parse(rAuth.body), { password: true, lockedOut: false });

      const rWrong = await post(`${t.url}api/login`, {}, { password: 'nope' });
      assert.strictEqual(rWrong.status, 401);
      assert.strictEqual(JSON.parse(rWrong.body).attemptsLeft, dashauth.MAX_ATTEMPTS - 1);

      const rRight = await post(`${t.url}api/login`, {}, { password: 'correct horse battery staple' });
      assert.strictEqual(rRight.status, 200);
      // `session` is the field the page reads. `token` is still sent beside it
      // for scripts written against the old name — one value, two keys, never
      // two secrets.
      const body = JSON.parse(rRight.body);
      const sessionKey = body.session;
      assert.ok(sessionKey && sessionKey.length > 20, 'proving the password must mint a session key');
      assert.strictEqual(body.token, sessionKey, 'the compatibility key must be the same value');

      const rState = await get(`${t.url}api/state`, { 'x-lain-session': sessionKey });
      assert.strictEqual(rState.status, 200, 'a session key minted by the password must work on every other route');
      const rLegacy = await get(`${t.url}api/state`, { 'x-lain-token': sessionKey });
      assert.strictEqual(rLegacy.status, 200, 'the old header name must keep working for existing scripts');

      // LOCKOUT IS A HARD STOP, not a delay. The successful login above reset
      // the failure count to zero (a success clears it — dashauth.js's
      // `grant()`), so it takes exactly MAX_ATTEMPTS more wrong guesses before
      // the lockout engages, and the MAX_ATTEMPTS-th wrong guess is still
      // answered as an ordinary 401 ("that guess was wrong") — it is the
      // FOLLOWING request that finds the door already shut.
      let last;
      for (let i = 0; i < dashauth.MAX_ATTEMPTS; i++) {
        last = await post(`${t.url}api/login`, {}, { password: `still-wrong-${i}` });
      }
      assert.strictEqual(last.status, 401);
      assert.strictEqual(JSON.parse(last.body).attemptsLeft, 0);
      last = await post(`${t.url}api/login`, {}, { password: `one-more-guess` });
      assert.strictEqual(last.status, 429);
      const rLockedOut = await post(`${t.url}api/login`, {}, { password: 'correct horse battery staple' });
      assert.strictEqual(rLockedOut.status, 429, 'lockout refuses even the RIGHT password until LAIN restarts');
    } finally {
      try { inst.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });
};
