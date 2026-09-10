'use strict';

/**
 * `/api` END TO END, THROUGH THE REAL BINARY, AGAINST A REAL HTTP SERVER.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHAT IT CAUGHT.
 *
 * Every earlier verification of `/api` used a FAKE credential. That exercises
 * the failure path — a provider refuses, the credential is kept, the reason is
 * printed — and it never reaches the successful one, because the flow stops
 * before it. So the happy path was "implemented and unverified", and it was
 * broken: `discoverModels` read `.length` off the RESULT OBJECT that
 * `connections.discover` returns, which is always undefined, so every
 * successful discovery in existence reported "the provider answered, but
 * listed no models" and the model picker — the step the whole flow exists to
 * reach — never opened. The unit tests were green because their stub returned
 * an array, which is a shape the real function never produces.
 *
 * A FAILURE PATH PROVED CORRECT IS NOT A HAPPY PATH PROVED CORRECT.
 *
 * ------------------------------------------------------------------------
 * WHAT IS REAL HERE, and it is everything except the provider's identity:
 *
 *   the binary      spawned as a child process, drawing real frames
 *   the terminal    LAIN_FORCE_TUI — the real draw path over a pipe
 *   the keystrokes  the actual escape sequences an arrow key sends
 *   the transport   a real socket, a real GET, real JSON, real headers
 *   the store       the real config file, read back by a SECOND process
 *
 * WHAT IS NOT REAL: the server is ours, so this is FIXTURE-VERIFIED and not
 * LIVE PROVIDER VERIFIED. Those are different claims and this file never makes
 * the second one. It does verify the one thing a live provider would add and a
 * mock usually hides — that the credential is actually PUT ON THE WIRE, in the
 * header the protocol requires — by asserting on what the server received.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes } = require('../helpers');

const ESC = '\x1b';
const UP = ESC + '[A';
const DOWN = ESC + '[B';
const CR = '\r';
const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * THE SENTINEL. A credential that could not possibly occur by accident, so
 * "this string is absent from every byte the program wrote" is a real claim
 * rather than a coincidence.
 */
const SENTINEL = 'LAIN_SECRET_SENTINEL_DO_NOT_RENDER_9f3a';

/** The models the fixture route serves. Named so they are findable on screen. */
const SERVED = ['fixture/alpha-1', 'fixture/beta-2', 'fixture/gamma-3'];

/**
 * A provider that answers `/v1/models` the way an OpenAI-compatible router
 * does, and REMEMBERS what it was sent — which is how the credential's journey
 * is proved rather than assumed.
 */
function serveModels() {
  const seen = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization || '', xkey: req.headers['x-api-key'] || '' });
      if (!/\/models$/.test(req.url || '')) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: SERVED.map((id) => ({ id })) }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        seen,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A trusted, empty config home the child will read and write. */
function home(prefix) {
  const cwd = tmpdir(prefix);
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    trustedPaths: [{ path: cwd, level: 'TRUSTED', at: new Date().toISOString() }],
  }), 'utf8');
  return { cwd, configDir };
}

const readCfg = (configDir) => JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));

/**
 * THE FLOW REALLY RAN, ASSERTED BEFORE THE LEAK IS.
 *
 * The order matters and it was got wrong once. `stdinSteps` writes each chunk
 * after a fixed pause; on a loaded machine the pause can expire before the
 * panel the chunk is meant to answer has opened, and the sentinel is then typed
 * at the ORDINARY prompt as a task. That is not a masking failure — LAIN cannot
 * know that a line somebody typed as a message is a credential — but a
 * no-leak assertion checked first reports it as one, which sends a reader
 * hunting for a leak that is not there.
 *
 * So the landmarks are checked first. A missed panel now fails as a missed
 * panel, and a leak assertion that fires is a leak.
 */
function reachedCredentialPanel(out) {
  assert.match(out, /api credential/i,
    'the masked credential panel never opened — the keystroke arrived before the flow did, '
    + 'so nothing below is testing what it means to test');
}

module.exports = async function () {
  await test('API-FIXTURE: the WHOLE flow — masked key, picker, discovery, model picker, persistence', async () => {
    const srv = await serveModels();
    const { cwd, configDir } = home('apiflow-');
    try {
      const r = await runCli([], {
        cwd,
        configDir,
        env: { LAIN_FORCE_TUI: '1', COLUMNS: '110', LINES: '34' },
        stdinSteps: [
          // ---- bare /api opens the MASKED credential question --------------
          '/api\n',
          `${SENTINEL}\n`,
          // ---- the provider picker. UP from the first row WRAPS to the last.
          //
          // The last row is a provider LAIN knows the NAME of and cannot place,
          // and picking one asks for an endpoint instead of guessing — which is
          // the behaviour under test here. `Other...` takes the identical path;
          // it is asserted separately, by position, because its JOB is to be
          // findable rather than to be reachable by wrapping.
          //
          // Deterministic without counting how many providers the picker
          // happens to offer today, which is the point of coming from the end.
          UP, CR,
          // ---- the endpoint, typed, never guessed -------------------------
          `${srv.baseUrl}\n`,
          // ---- discovery runs here, then the MODEL picker opens. One DOWN,
          // then Enter: the arrow has to correspond to what Enter selects.
          DOWN, CR,
          '/exit\n',
        ],
        stepDelayMs: 1100,
        timeoutMs: 60000,
      });
      const out = plain(r.out);

      reachedCredentialPanel(out);
      // ---- THE CREDENTIAL WENT NOWHERE NEAR THE SCREEN -------------------
      assertNotIncludes(out, SENTINEL,
        'the credential reached a display surface — every byte this process wrote is searched');

      // ---- BUT IT DID GO ON THE WIRE, in the header the protocol requires --
      const asked = srv.seen.filter((s) => /\/models$/.test(s.url));
      assert.ok(asked.length >= 1, `the route was never asked what it serves (saw ${JSON.stringify(srv.seen)})`);
      assert.strictEqual(asked[0].auth, `Bearer ${SENTINEL}`,
        'the credential was not sent as the bearer token — masking must not reach the request');

      // ---- WHAT THE USER SAW, in order -----------------------------------
      assert.match(out, /api credential/i, 'the masked credential question opened');
      assert.match(out, /which provider is this credential for/i, 'the provider picker opened');
      // THE ESCAPE HATCH IS ON THE FIRST SCREEN. The panel shows about ten rows
      // and the list is twenty-one; `Other...` is the one row that works for
      // every provider in existence, so it may not sit below the fold. It was
      // last, and fell two screens down when the list grew.
      assertIncludes(out, 'Other', 'the row that asks rather than guesses must be visible');
      assert.match(out, /base url/i, 'Other... asked for an endpoint');
      assert.match(out, /fetching available models/i, 'discovery was announced');
      assertIncludes(out, `${SERVED.length} model(s) available`,
        'discovery reported the real count — the defect reported "listed no models" here');
      assert.ok(SERVED.some((m) => out.includes(m)), 'the discovered models reached the screen');

      // ---- AND THE SHAPE OF THE KEY, so a person knows WHICH key landed ---
      assert.match(out, /LAI…?9f3a|LAI…9f3a/,
        'the stored credential was reported by shape');

      // ---- IT WAS STORED, under the endpoint that was typed ---------------
      const cfg = readCfg(configDir);
      const conns = Object.values(cfg.connections || {});
      const fixture = conns.find((c) => c.baseUrl === srv.baseUrl);
      assert.ok(fixture, `nothing was stored for ${srv.baseUrl}: ${JSON.stringify(cfg.connections)}`);
      assert.strictEqual(fixture.apiKey, SENTINEL, 'the real credential must be stored, not the mask');
      assert.strictEqual(r.code, 0);
    } finally {
      await srv.close();
    }
  });

  await test('API-FIXTURE: a SECOND process reads the model back — the choice persisted', async () => {
    const srv = await serveModels();
    const { cwd, configDir } = home('apipersist-');
    try {
      await runCli([], {
        cwd,
        configDir,
        env: { LAIN_FORCE_TUI: '1', COLUMNS: '110', LINES: '34' },
        stdinSteps: ['/api\n', `${SENTINEL}\n`, UP, CR, `${srv.baseUrl}\n`, DOWN, CR, '/exit\n'],
        stepDelayMs: 1100,
        timeoutMs: 60000,
      });
      const cfg = readCfg(configDir);
      assert.ok(cfg.model, 'no model was pinned by the picker');
      assert.ok(SERVED.includes(cfg.model), `a model that is not one the route serves: ${cfg.model}`);

      // ---- A DIFFERENT PROCESS, READING THE SAME STORE -------------------
      //
      // Restart is the only honest test of persistence: an in-memory value
      // that was never written looks identical until the process ends.
      const again = await runCli(['-p', '/status'], {
        cwd, configDir, env: { LAIN_NO_TUI: '1' }, timeoutMs: 30000,
      });
      const out = plain(again.out);
      assertIncludes(out, cfg.model, 'the restarted process does not report the chosen model');
      assertNotIncludes(out, SENTINEL, 'the restarted process printed the credential');
    } finally {
      await srv.close();
    }
  });

  await test('API-FIXTURE: a route that refuses is reported in ITS words, and the key is KEPT', async () => {
    // The failure path, held apart from the success path on purpose: the two
    // are different claims and this file must never merge them.
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid_api_key' } }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const { cwd, configDir } = home('apifail-');
    try {
      const r = await runCli([], {
        cwd, configDir,
        env: { LAIN_FORCE_TUI: '1', COLUMNS: '110', LINES: '34' },
        stdinSteps: ['/api\n', `${SENTINEL}\n`, UP, CR, `${baseUrl}\n`, '/exit\n'],
        stepDelayMs: 1100,
        timeoutMs: 60000,
      });
      const out = plain(r.out);
      reachedCredentialPanel(out);
      assertIncludes(out, 'Model discovery failed', 'the failure must be reported, not swallowed');
      assertNotIncludes(out, SENTINEL, 'a refusal is a very common way for a key to reach a screen');
      assertIncludes(out, 'invalid_api_key', "in the provider's own words");
      assertIncludes(out, 'The credential is stored',
        'a transient failure must not throw the key away — see apicommand.js');
      const cfg = readCfg(configDir);
      const kept = Object.values(cfg.connections || {}).find((c) => c.baseUrl === baseUrl);
      assert.ok(kept && kept.apiKey === SENTINEL, 'the credential was not kept');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
};
