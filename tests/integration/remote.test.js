'use strict';

/**
 * REMOTE CONTROL — the real supervisor, a fake Telegram, and a fake local model.
 *
 * ------------------------------------------------------------------------
 * WHAT IS REAL HERE AND WHAT IS NOT.
 *
 *   REAL   the supervisor binary, its credential store, its authorization, its
 *          pairing, its polling loop, its dedupe, its capability validation and
 *          every answer it produces.
 *   FAKE   Telegram itself, and the local model — two small HTTP servers this
 *          file starts, pointed at with `LAIN_TELEGRAM_API` and the wire's
 *          `setBrain`.
 *
 * That split is deliberate and it is the only one that lets the interesting
 * things be tested at all. A test that hit real Telegram would need a real bot
 * token in CI, would be flaky on somebody's train wifi, and could not simulate
 * the case that matters most — the network failing in the middle. A test that
 * mocked the supervisor would prove nothing about the code that ships.
 *
 * NOTHING HERE EVER REACHES api.telegram.org. The base URL is overridden before
 * the supervisor is started, so a bug in this file produces a connection
 * refused, not a message to a stranger.
 *
 * ------------------------------------------------------------------------
 * EVERY TOKEN IN THIS FILE IS FAKE and shaped like a real one on purpose:
 * `http::valid_token` refuses anything that is not, so a test using `xyz` would
 * exercise the rejection path and prove nothing about the rest. Each test MINTS
 * ITS OWN (see `mintToken`) and the fake refuses any other token with a 404 on
 * every method — which is what the real Telegram does to a wrong credential —
 * so a supervisor that outlived its run (the orphan hazard the teardown note
 * describes) can land on this server's port and still be refused. It can
 * neither steal updates nor inject replies, because its remembered token
 * belongs to a fake that is already gone.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { test } = require('../helpers');
const supervisor = require('../../src/supervisor');
const guardian = require('../../src/guardian');
const rc = require('../../src/remotecontrol');

/** Shaped like Telegram's, and belonging to nobody. Kept only for the tests
 *  that assert a leaked credential never appears in a readable surface. */
const FAKE_TOKEN = '000000000:AAAAAAAAAAAA';

/** A fresh, well-formed credential per test. The fake below answers ONLY this
 *  token; anything else gets the 404 a wrong credential earns at the real
 *  Telegram. One-of-a-kind tokens are what make an orphaned supervisor that
 *  wanders onto this port harmless — its remembered token is not this one. */
function mintToken() {
  const secret = crypto.randomBytes(24).toString('base64url').slice(0, 24);
  return `${100000000 + Math.floor(Math.random() * 899999999)}:${secret}`;
}

/** How long an empty getUpdates is HELD before being answered empty, standing in
 *  for the long-poll window the adapter is built around. The hold is what paces
 *  the adapter's poll loop — with no hold the loop is limited only by process
 *  creation and the rig manufactures a curl-spawn storm that is nothing like
 *  the wire the adapter is built for. Two and a half seconds paces the loop at
 *  a tenth of Telegram's 25s window while keeping the wait any test can sit
 *  through short; a held request is released the instant a message is spoken,
 *  and a poll that arrives to a non-empty queue is answered immediately, so
 *  the hold never delays a pickup — it only spaces the empty polls. */
const HOLD_MS = 2500;

function isolate(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lain-rc-${tag}-`));
}

/**
 * A TELEGRAM THAT DOES WHAT THIS TEST SAYS.
 *
 * Speaks the three methods the adapter uses. `queue` is what `getUpdates` will
 * hand over next; `sent` is everything the adapter posted back, which is how
 * every assertion about what the bot SAID is made.
 */
/**
 * DIAGNOSTIC TRACE — off unless LAIN_RC_TRACE names a file. When it does, every
 * rig-side event (update spoken, poll served/held, message landed) is written
 * with epoch-ms so the gap between the supervisor DOING something and the rig
 * SEEING it can be measured after the fact. The supervisor's own stderr is
 * `ignore`d by design (see supervisor.rs), so this file is the only clock.
 */
function tracer() {
  const target = process.env.LAIN_RC_TRACE;
  if (!target) return { append: () => {}, stamp: () => '' };
  const stamp = () => `${Date.now()} ${process.pid}`;
  const append = (line) => {
    try { fs.appendFileSync(target, `${stamp()} ${line}\n`); } catch { /* diagnosis only */ }
  };
  return { append, stamp };
}

function fakeTelegram({ token = mintToken(), me = { id: 77, username: 'lain_test_bot', first_name: 'LAIN Test' } } = {}) {
  const trace = tracer().append;
  const state = { token, queue: [], sent: [], polls: 0, fail: false, nextUpdateId: 1, held: [] };
  const reply = (res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const takeAll = () => { const take = state.queue; state.queue = []; return take; };
  // A HELD GETUPDATES IS HANDED ITS MESSAGE THE MOMENT ONE IS SPOKEN.
  const release = () => {
    while (state.held.length > 0 && state.queue.length > 0) {
      reply(state.held.shift(), { ok: true, result: takeAll() });
    }
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // The wire: {base}/bot{token}/{method}. The token rides in the path — the
    // fake reads it back out, and answers a wrong one with the 404 the real
    // Telegram gives a credential it does not know. Everything depends on this
    // refusal staying here: it is what makes an orphaned supervisor holding some
    // earlier test's token unable to steal updates from this server's port.
    const m = /^\/bot([^/]+)\/([a-zA-Z]+)$/.exec(url.pathname);
    const method = m ? m[2] : null;
    const who = m ? m[1] : null;
    if (who !== state.token) {
      trace('TOKEN-404 some-other-token (an orphan?)');
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: 'Not Found' }));
      return;
    }
    if (state.fail) { trace(`SERVE-FAIL ${method}`); res.writeHead(500); res.end('nope'); return; }
    if (method === 'getMe') return reply(res, { ok: true, result: me });
    if (method === 'getUpdates') {
      state.polls += 1;
      if (state.queue.length > 0) { trace(`POLL-SERVED n=${state.queue.length}`); return reply(res, { ok: true, result: takeAll() }); }
      // AN EMPTY QUEUE IS HELD, NOT ANSWERED. A real getUpdates stays open
      // until an update arrives or the long-poll window closes — that hold is
      // what paces the adapter's poll loop, and the adapter is BUILT around it
      // (POLL_SECS, HTTP_TIMEOUT_SECS). The previous fake answered instantly,
      // which turned the loop into a curl spawn storm whenever the machine
      // was busy; a message spoken into that storm was handed over late,
      // past these tests' own pairing gates, and the late "Authorized" text
      // was then read as the answer to whatever was asked next. The hold
      // below is short only because the tests do not need to wait: a held
      // request is released by `say` at once, the way Telegram delivers.
      trace('POLL-HELD');
      state.held.push(res);
      setTimeout(() => {
        const i = state.held.indexOf(res);
        if (i < 0) return; // a message arrived and already answered this.
        state.held.splice(i, 1);
        if (state.fail) { trace('HOLD-TIMEOUT-FAIL'); res.writeHead(500); res.end('nope'); return; }
        trace('HOLD-TIMEOUT-EMPTY');
        reply(res, { ok: true, result: [] });
      }, HOLD_MS);
      return;
    }
    if (method === 'sendMessage') {
      const text = url.searchParams.get('text') || '';
      state.sent.push({ chat_id: url.searchParams.get('chat_id'), text });
      trace(`SENT text=${JSON.stringify(text).slice(0, 80)}`);
      return reply(res, { ok: true, result: { message_id: state.sent.length } });
    }
    return reply(res, { ok: false, description: `unexpected method ${method}` });
  });
  state.server = server;
  state.listen = () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
  state.close = () => new Promise((r) => {
    // A held request must be answered before the close, or the open socket
    // keeps the server from ever finishing it.
    while (state.held.length > 0) reply(state.held.shift(), { ok: true, result: takeAll() });
    server.close(() => r());
  });
  /** Queue a message as if a person sent it. A held getUpdates gets it now. */
  state.say = (text, chatId = 555) => {
    trace(`SAY text=${JSON.stringify(text).slice(0, 60)} held=${state.held.length}`);
    state.queue.push({
      update_id: state.nextUpdateId++,
      message: { chat: { id: chatId, username: 'someone' }, text },
    });
    release();
  };
  return state;
}

/**
 * A LOCAL MODEL THAT SAYS WHAT THIS TEST SAYS.
 *
 * `answers` is a list of replies handed out in order. That is enough to drive
 * the two-call shape — interpret, then explain — deterministically, which a
 * real 3B model emphatically is not.
 */
function fakeBrain(answers) {
  const trace = tracer().append;
  const state = { answers: [...answers], seen: [], down: false };
  const server = http.createServer((req, res) => {
    trace('BRAIN-REQUEST');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      // A MODEL THAT IS DOWN RATHER THAN GONE. Closing the socket tests one
      // failure; refusing while still listening tests the other, and only the
      // second one can come back.
      if (state.down) { res.writeHead(503); res.end('model is loading'); return; }
      state.seen.push(body);
      trace(`BRAIN-ANSWER n=${state.seen.length}`);
      const content = state.answers.shift();
      res.writeHead(content === undefined ? 500 : 200, { 'content-type': 'application/json' });
      res.end(content === undefined
        ? 'no more answers'
        : JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  state.server = server;
  state.listen = () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}/v1`)));
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}

function until(fn, ms = 15000, step = 50) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = async () => {
      let v = null;
      try { v = await fn(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, step);
    };
    tick();
  });
}

/**
 * A private home, a private Telegram, and everything taken down afterwards
 * WHATEVER HAPPENS — see the note in guardian.test.js about the afternoon that
 * produced 354 orphaned supervisors.
 */
async function withRemote(tag, fn, { brainAnswers = null, token = null } = {}) {
  const home = isolate(tag);
  const tg = fakeTelegram(token ? { token } : {});
  const api = await tg.listen();
  const brain = brainAnswers ? fakeBrain(brainAnswers) : null;
  const brainUrl = brain ? await brain.listen() : '';
  const prevHome = process.env.LAIN_HOME;
  const prevApi = process.env.LAIN_TELEGRAM_API;
  process.env.LAIN_HOME = home;
  // BEFORE THE SUPERVISOR STARTS. The child inherits this, and it is the only
  // thing standing between this test and the real Telegram.
  process.env.LAIN_TELEGRAM_API = api;
  guardian.forgetLocal();
  try {
    return await fn({ tg, brain, brainUrl, home });
  } finally {
    // ---- LET THE FIRE-AND-FORGET CALLS LAND BEFORE PULLING THE PLUG -------
    //
    // `guardian.identify`, `turnBegin` and friends are deliberately not awaited
    // — a turn must never wait on a socket — and several of these tests use
    // them. One scheduled a millisecond before the test ended would otherwise
    // run AFTER `LAIN_HOME` was restored and call `wake()`, starting a
    // supervisor against a home this file does not own and cannot clean up.
    //
    // Measured while writing this: eleven orphaned supervisors in one run, each
    // holding the built binary open, which then made `cargo build` fail with
    // "Access is denied" — a build error with no visible connection to its
    // cause. The second shutdown catches one that started during the first.
    await new Promise((r) => setTimeout(r, 250));
    try { await supervisor.shutdown(); } catch { /* never started */ }
    await new Promise((r) => setTimeout(r, 150));
    try { await supervisor.shutdown(); } catch { /* already gone, which is the point */ }
    // ---- A SHUTDOWN THAT NEVER ARRIVED LEAVES A LEAK, NOT A MYSTERY --------
    //
    // The child is spawned detached and unref'd — outliving this process is
    // its job — so a shutdown request that starves under load (timed out, or
    // answered but not yet exited) leaves a supervisor nothing else can
    // reach: the port may be gone, but the endpoint file still names the
    // pid, and that is the same truth `existing()` itself trusts. This home
    // was minted for this test and is destroyed with it, so the pid named
    // there can only be this test's own supervisor. Killed here, it cannot
    // join the orphan population that starves every later run's polls.
    const leaked = supervisor.endpoint();
    if (leaked) { try { process.kill(leaked.pid, 'SIGKILL'); } catch { /* already gone */ } }
    guardian.forgetLocal();
    await tg.close();
    if (brain) await brain.close();
    if (prevHome === undefined) delete process.env.LAIN_HOME; else process.env.LAIN_HOME = prevHome;
    if (prevApi === undefined) delete process.env.LAIN_TELEGRAM_API; else process.env.LAIN_TELEGRAM_API = prevApi;
  }
}

/** Everything the bot has said to a chat, joined. */
function saidTo(tg, chatId = 555) {
  return tg.sent.filter((m) => String(m.chat_id) === String(chatId)).map((m) => m.text).join('\n---\n');
}

module.exports = async function () {
  const probe = supervisor.probe();
  if (!probe.available) {
    await test('RC: skipped — the Rust binary is not built', () => {
      assert.ok(probe.why.includes('cargo build'), probe.why);
    });
    return;
  }

  // ---- THE CREDENTIAL ----------------------------------------------------

  await test('RC: a token is proved against Telegram before it is stored, and never comes back out', async () => {
    // The constant token stays visible in this one test on purpose: the
    // assertions below are about IT never reaching a readable surface. The fake
    // is told to serve it, so this test still exercises the real connect path.
    await withRemote('connect', async ({ home }) => {
      const r = await rc.connect(FAKE_TOKEN);
      assert.ok(r.ok, `connect failed: ${r.error}`);
      assert.strictEqual(r.remote.bot_username, 'lain_test_bot', 'the identity getMe returned');
      assert.ok(r.pairingCode, 'a pairing code is issued in the same breath');

      // ---- IT IS NOT IN ANYTHING A CLIENT CAN READ ----------------------
      const s = await rc.status();
      assert.strictEqual(JSON.stringify(s).includes(FAKE_TOKEN), false, 'the status leaked the token');
      assert.ok(s.configured);
      assert.strictEqual(s.bot_name, 'LAIN Test');

      // ---- NOR IN THE EVENT LOG ------------------------------------------
      //
      // The log is read by people and by tools. A credential that reaches it has
      // leaked, however local the file is.
      const log = path.join(home, 'supervisor', 'guardian', 'events.jsonl');
      const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      assert.strictEqual(text.includes(FAKE_TOKEN), false, 'the event log leaked the token');
      assert.ok(text.includes('REMOTE_CONNECTED'), 'but the connection itself is recorded');
      assert.ok(text.includes('lain_test_bot'), 'by its public username');
    }, { token: FAKE_TOKEN });
  });

  await test('RC: a token Telegram rejects is not stored at all', async () => {
    await withRemote('badtoken', async ({ tg, home }) => {
      // getMe fails: the credential is wrong, or the network is.
      tg.fail = true;
      const r = await rc.connect(FAKE_TOKEN);
      assert.strictEqual(r.ok, false);
      const cred = path.join(home, 'supervisor', 'remote', 'telegram.json');
      assert.strictEqual(fs.existsSync(cred), false, 'nothing may be written on the strength of a typed value');
      const s = await rc.status();
      assert.strictEqual(s.configured, false, 'and it must not report itself as connected');
    }, { token: FAKE_TOKEN });
  });

  // ---- AUTHORIZATION -----------------------------------------------------

  await test('RC: an unpaired chat learns nothing about the runtime', async () => {
    await withRemote('unpaired', async ({ tg }) => {
      await rc.connect(tg.token);
      tg.say('/session');
      tg.say('what is running?');
      const got = await until(() => (tg.sent.length >= 2 ? saidTo(tg) : null));
      assert.ok(got, 'the bot answered');
      assert.match(got, /not authorized/i);
      // NOT ONE FACT. No session, no model, no worker, no state word.
      for (const leak of ['SESSION', 'RUNNING', 'IDLE', 'WORKER', 'ROUTES', 'COMPLETED']) {
        assert.ok(!got.includes(leak), `an unauthorized chat was told about ${leak}`);
      }
    });
  });

  await test('RC: pairing authorizes exactly one chat, and the code is spent', async () => {
    await withRemote('pairing', async ({ tg }) => {
      const r = await rc.connect(tg.token);
      tg.say(`/pair ${r.pairingCode}`);
      const ok = await until(() => (saidTo(tg).includes('Authorized') ? saidTo(tg) : null));
      assert.ok(ok, 'the paired chat is told so');
      assert.ok((await rc.status()).authorized_chats === 1);

      // A SECOND CHAT CANNOT REUSE IT.
      tg.say(`/pair ${r.pairingCode}`, 999);
      const other = await until(() => (saidTo(tg, 999) ? saidTo(tg, 999) : null));
      assert.match(other, /Pairing failed/);
      assert.strictEqual((await rc.status()).authorized_chats, 1, 'a single-use code stayed single-use');
    });
  });

  await test('RC: a wrong code teaches a guesser nothing', async () => {
    await withRemote('guess', async ({ tg }) => {
      await rc.connect(tg.token);
      tg.say('/pair AAAA-AAAA');
      const said = await until(() => (saidTo(tg) ? saidTo(tg) : null));
      assert.match(said, /not right/);
      // The real code must not appear anywhere in the refusal, nor a hint of
      // how close the guess was.
      const s = await rc.status();
      assert.ok(s.pairing_code, 'a code is still open');
      assert.strictEqual(said.includes(s.pairing_code), false, 'the refusal quoted the code back');
    });
  });

  // ---- THE VOCABULARY ----------------------------------------------------

  await test('RC: a command is answered from the runtime, with no model involved', async () => {
    await withRemote('command', async ({ tg }) => {
      const r = await rc.connect(tg.token);
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));
      const before = tg.sent.length;
      tg.say('/session');
      const said = await until(() => (tg.sent.length > before ? tg.sent[tg.sent.length - 1].text : null));
      assert.ok(said, 'the bot answered');
      assert.match(said, /LAIN SESSIONS/);
      // NO BRAIN IS CONFIGURED IN THIS TEST. A slash command must not need one:
      // that is what makes the runtime reachable when the local model is down.
      assert.ok(!/local model/i.test(said));
    });
  });

  await test('RC: anything that is not a command is refused as a command, not tried as one', async () => {
    await withRemote('noshell', async ({ tg }) => {
      const r = await rc.connect(tg.token);
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));
      const before = tg.sent.length;
      // The shape of an attack: a plausible-looking verb with a payload.
      tg.say('/exec rm -rf /');
      const said = await until(() => (tg.sent.length > before ? tg.sent[tg.sent.length - 1].text : null));
      assert.match(said, /not a command/i);
      assert.ok(!said.includes('rm -rf'), 'the payload is not echoed back');
    });
  });

  await test('RC: the same update is never acted on twice', async () => {
    await withRemote('dedupe', async ({ tg }) => {
      const r = await rc.connect(tg.token);
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));
      const before = tg.sent.length;
      // ONE update id, delivered twice — which is exactly what happens when the
      // adapter dies between acting and confirming its cursor.
      const dup = { update_id: 4242, message: { chat: { id: 555 }, text: '/status' } };
      tg.queue.push(dup);
      await until(() => (tg.sent.length > before ? true : null));
      const after = tg.sent.length;
      tg.queue.push({ ...dup });
      // Give the adapter time to poll again and decline it.
      await new Promise((res) => setTimeout(res, 1200));
      assert.strictEqual(tg.sent.length, after, 'a repeated update produced a second answer');
    });
  });

  // ---- THE LOCAL MODEL ---------------------------------------------------

  await test('RC: plain English goes model → capability → model, and the runtime decides', async () => {
    await withRemote('english', async ({ tg, brain, brainUrl }) => {
      const r = await rc.connect(tg.token);
      await rc.setBrain({ baseUrl: brainUrl, model: 'fake-local' });
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));

      const before = tg.sent.length;
      tg.say('which of my projects are still running?');
      const said = await until(() => (tg.sent.length > before ? tg.sent[tg.sent.length - 1].text : null), 20000);
      assert.ok(said, `the bot answered (model calls=${brain.seen.length}, polls=${tg.polls}, queued=${tg.queue.length})`);
      assert.match(said, /Nothing is running/i, 'the model got to phrase it');
      // AND IT WAS ASKED THE RIGHT WAY ROUND: routing first, then explanation.
      // Two calls, and the second one carried the runtime's own text as facts.
      assert.strictEqual(brain.seen.length, 2, 'interpret then explain — two calls, no more');
      assert.match(brain.seen[1], /LAIN SESSIONS/, 'the explanation was given the runtime facts');
      assert.match(brain.seen[0], /session\.list/, 'and the routing call was shown the vocabulary');
    }, {
      brainAnswers: [
        '{"capability":"session.list","args":{}}',
        'Nothing is running at the moment.',
      ],
    });
  });

  await test('RC: a local model that invents a number does not get to say it', async () => {
    await withRemote('invented', async ({ tg, brainUrl }) => {
      const r = await rc.connect(tg.token);
      await rc.setBrain({ baseUrl: brainUrl, model: 'fake-local' });
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));

      const before = tg.sent.length;
      tg.say('how far along is it?');
      const said = await until(() => (tg.sent.length > before ? tg.sent[tg.sent.length - 1].text : null), 20000);
      assert.ok(said, 'the bot answered');
      // ---- THE WHOLE POINT -------------------------------------------------
      //
      // The model claimed 61% and 2629 tests. The runtime never said either, so
      // the answer is discarded and the runtime's own words are sent instead,
      // WITH the reason — a user who is told nothing learns that the feature is
      // flaky rather than that the model is.
      assert.ok(!said.includes('It is 61% through'), 'the invented sentence was sent as an answer');
      assert.match(said, /LAIN SESSIONS/, 'the authoritative answer is what was sent');
      assert.match(said, /runtime never reported/i, 'and the user is told why they got a table');
      // The rejected figures ARE named in the note, which is not the same as
      // asserting them: a user who is told nothing concludes the feature is
      // flaky rather than that the model is.
      assert.match(said, /61/);
      assert.match(said, /2629/);
      // What must not happen is the model's sentence standing on its own.
      assert.ok(said.indexOf('LAIN SESSIONS') < said.indexOf('61'), 'the facts come first');
    }, {
      brainAnswers: [
        '{"capability":"session.list","args":{}}',
        'It is 61% through and 2629 tests have passed.',
      ],
    });
  });

  await test('RC: a local model that names a capability that does not exist is refused', async () => {
    await withRemote('invention', async ({ tg, brainUrl }) => {
      const r = await rc.connect(tg.token);
      await rc.setBrain({ baseUrl: brainUrl, model: 'fake-local' });
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));

      const before = tg.sent.length;
      tg.say('delete everything please');
      const said = await until(() => (tg.sent.length > before ? tg.sent[tg.sent.length - 1].text : null), 20000);
      assert.match(said, /REFUSED/);
      assert.match(said, /no such capability/i);
      // AND THE REFUSAL IS THE LIST. A model that guessed learns the real names;
      // an injection learns there is nothing else to reach.
      assert.match(said, /session\.list/);
    }, {
      brainAnswers: ['{"capability":"system.exec","args":{"cmd":"rm -rf /"}}'],
    });
  });

  await test('RC: the local model dying costs a phrasing and not the runtime', async () => {
    await withRemote('braindown', async ({ tg, brain, brainUrl }) => {
      const r = await rc.connect(tg.token);
      await rc.setBrain({ baseUrl: brainUrl, model: 'fake-local' });
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));
      // THE MODEL GOES AWAY MID-CONVERSATION.
      await brain.close();

      const before = tg.sent.length;
      tg.say('what is running?');
      const english = await until(() => (tg.sent.length > before ? tg.sent[tg.sent.length - 1].text : null), 20000);
      assert.match(english, /could not be reached/i);
      assert.match(english, /runtime itself is fine/i, 'and it says the runtime is unaffected');

      // AND EVERY COMMAND STILL WORKS — which is the claim being tested.
      const before2 = tg.sent.length;
      tg.say('/session');
      const said = await until(() => (tg.sent.length > before2 ? tg.sent[tg.sent.length - 1].text : null));
      assert.match(said, /LAIN SESSIONS/);
    }, { brainAnswers: ['{"capability":"session.list","args":{}}'] });
  });

  // ---- THE RUNTIME BEHIND IT ---------------------------------------------

  await test('RC: /session shows several sessions with their own states', async () => {
    await withRemote('multi', async ({ tg }) => {
      const r = await rc.connect(tg.token);
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));

      // Three conversations, three different endings — the exact case §21 asks
      // for, arranged through the ordinary observation calls Node makes.
      guardian.identify('s-a', { name: 'Project A', cwd: '/tmp/a' });
      guardian.turnBegin('s-a', { turnId: 't1', model: 'm1' });
      guardian.turnEnd('s-a', { outcome: 'completed' });
      guardian.identify('s-b', { name: 'Project B', cwd: '/tmp/b' });
      guardian.turnBegin('s-b', { turnId: 't1', model: 'm1' });
      guardian.identify('s-c', { name: 'Project C', cwd: '/tmp/c' });
      guardian.turnBegin('s-c', { turnId: 't1', model: 'm1' });
      guardian.turnEnd('s-c', { outcome: 'provider', reason: 'the socket closed' });

      const listed = await until(async () => {
        const out = await rc.capability('session.list');
        return out.available && out.text.includes('Project C') ? out : null;
      });
      assert.ok(listed, '/session never listed all three');
      assert.match(listed.text, /Project A/);
      assert.match(listed.text, /COMPLETED/);
      assert.match(listed.text, /Project B/);
      assert.match(listed.text, /RUNNING/);
      assert.match(listed.text, /Project C/);
      assert.match(listed.text, /FAILED/);

      // A SESSION IS NOT A TURN IS NOT A WORKER. The detail view keeps them
      // apart, which is the distinction §7 exists to protect.
      const one = await rc.capability('session.get', { session: 's-c' });
      assert.match(one.text, /Status:\s+FAILED/);
      assert.match(one.text, /Turn:\s+PROVIDER_FAILED/);
      assert.match(one.text, /Workers:/);
    });
  });

  await test('RC: progress is shown only where something counted it', async () => {
    await withRemote('progress', async ({ tg }) => {
      await rc.connect(tg.token);
      guardian.identify('counted', { name: 'Counted' });
      guardian.turnBegin('counted', { turnId: 't1', model: 'm' });
      guardian.identify('uncounted', { name: 'Uncounted' });
      guardian.turnBegin('uncounted', { turnId: 't1', model: 'm' });
      // One reports a real count with a source; the other reports only what it
      // is doing, which is what a turn with no plan does.
      guardian.progress('counted', { done: 3, total: 5, label: 'steps', source: 'plan', activity: 'integration tests' });
      guardian.progress('uncounted', { activity: 'reading files' });

      const got = await until(async () => {
        const out = await rc.capability('session.get', { session: 'counted' });
        return out.available && out.text.includes('60%') ? out : null;
      });
      assert.ok(got, 'a counted session never showed its percentage');
      assert.match(got.text, /60% \(3 of 5 steps, counted by plan\)/);

      // ---- AND IT MOVES, WITHOUT ANYBODY INVENTING THE MOVEMENT ---------
      //
      // The worker gets further; the count the runtime holds changes; the
      // figure a remote reader sees changes with it. No model is involved at
      // any point in that sentence.
      guardian.progress('counted', { done: 4, total: 5, label: 'steps', source: 'plan', activity: 'integration tests' });
      const moved = await until(async () => {
        const out = await rc.capability('session.get', { session: 'counted' });
        return out.available && out.text.includes('80%') ? out : null;
      });
      assert.ok(moved, 'the percentage never followed the count');
      assert.match(moved.text, /80% \(4 of 5 steps, counted by plan\)/);

      const none = await rc.capability('session.get', { session: 'uncounted' });
      assert.match(none.text, /not counted/);
      // NOT 0%. That is the failure this whole design exists to prevent.
      assert.ok(!/\b0%/.test(none.text), 'an uncounted session was reported as 0%');
      assert.match(none.text, /Activity:\s+reading files/);
    });
  });

  await test('RC: a queued continuation is one queue and one recovery, not a second one', async () => {
    await withRemote('continue', async ({ tg }) => {
      await rc.connect(tg.token);
      guardian.identify('conv', { name: 'Conv' });
      guardian.turnBegin('conv', { turnId: 't1', model: 'm' });
      guardian.turnEnd('conv', { outcome: 'rate_limited', reason: 'the route was limited' });
      await until(async () => {
        const st = await guardian.state('conv');
        return st && st.needs_handover ? st : null;
      });

      const out = await rc.capability('session.continue', { session: 'conv', intent: 'carry on but skip the migration' });
      assert.ok(out.ok, out.text);
      assert.match(out.text, /owed a handover/i, 'the reply says the briefing is coming');
      // THIS TEST PROCESS IS THE OWNER PID, and it is alive — so the runtime is
      // correct to report an attached CLI. Asserting the opposite would have
      // been asserting that the liveness check does not work.
      assert.match(out.text, /A CLI is attached/, 'and says who will pick it up');

      // IT LANDED IN THE SAME QUEUE a locally refused sentence lands in —
      // which is what makes the CLI recover it through the same code path.
      const pend = await guardian.pending('conv');
      assert.strictEqual(pend.held.length, 1);
      assert.strictEqual(pend.held[0].text, 'carry on but skip the migration');
      assert.strictEqual(pend.held[0].kind, 'remote');
    });
  });

  await test('RC: a model switch is validated against the routes the runtime knows are shut', async () => {
    await withRemote('switch', async ({ tg }) => {
      await rc.connect(tg.token);
      guardian.identify('sw', { name: 'Switch' });
      guardian.turnBegin('sw', { turnId: 't1', model: 'old-model' });
      // The runtime learns a route is limited, the way it always does.
      await supervisor.call({
        op: 'provider_note',
        connection_id: 'lain:shut',
        ok: false,
        kind: 'RATE_LIMITED',
        reason: 'quota exhausted',
        provider: 'shut',
        reset_at: Date.now() + 3600_000,
      });

      const refused = await rc.capability('session.model_switch', { session: 'sw', model: 'shut' });
      assert.strictEqual(refused.ok, false);
      assert.match(refused.text, /rate limited/i, 'switching onto a shut door is refused, with the reason');

      const ok = await rc.capability('session.model_switch', { session: 'sw', model: 'some-other-model' });
      assert.ok(ok.ok, ok.text);
      const st = await guardian.state('sw');
      assert.strictEqual(st.requested_model, 'some-other-model');
      // THE BOUNDARY IS ARMED BEFORE ANYTHING SWITCHES, which is the point of
      // doing this in the runtime: it survives the CLI dying in between.
      assert.strictEqual(st.handover_pending, true);
      assert.strictEqual(st.previous_model, 'old-model');
    });
  });

  await test('RC: unknown is not zero — a route that never reported a cache says so', async () => {
    await withRemote('tokens', async ({ tg }) => {
      await rc.connect(tg.token);
      guardian.identify('cost', { name: 'Cost' });
      guardian.turnBegin('cost', { turnId: 't1', model: 'm' });
      // Usage with no cache field at all: this provider does not report one.
      guardian.noteUsage('cost', { inputTokens: 1200, outputTokens: 340, requests: 1 });
      const got = await until(async () => {
        const out = await rc.capability('token.current', { session: 'cost' });
        return out.available && out.text.includes('1.2K') ? out : null;
      });
      assert.ok(got, 'usage never arrived');
      assert.match(got.text, /Cached:\s+unknown/, 'a cache nobody reported must not read as zero');
      assert.match(got.text, /Output:\s+340/);
    });
  });

  await test('RC: when the local model comes back it reads the runtime, not the past', async () => {
    await withRemote('brainback', async ({ tg, brain, brainUrl }) => {
      const r = await rc.connect(tg.token);
      await rc.setBrain({ baseUrl: brainUrl, model: 'fake-local' });
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));

      // Something happens while the model is unavailable.
      brain.down = true;
      guardian.identify('while-down', { name: 'While Down' });
      guardian.turnBegin('while-down', { turnId: 't1', model: 'm' });
      guardian.turnEnd('while-down', { outcome: 'completed' });

      const before = tg.sent.length;
      tg.say('what happened?');
      const said = await until(() => (tg.sent.length > before ? tg.sent[tg.sent.length - 1].text : null), 20000);
      assert.match(said, /could not be reached/i, 'the voice is gone');

      // ---- AND WHEN IT RETURNS ------------------------------------------
      //
      // §14: no rediscovery. The model asks the runtime and the runtime still
      // holds everything that happened while it was away — it does not have to
      // reconstruct anything, because it never held anything to lose.
      brain.down = false;
      const before2 = tg.sent.length;
      tg.say('what happened?');
      const back = await until(() => (tg.sent.length > before2 ? tg.sent[tg.sent.length - 1].text : null), 20000);
      assert.ok(back, 'the bot never answered after the model returned');
      assert.ok(!/could not be reached/i.test(back), 'it is working again');
      // The facts it was handed are the runtime's, and they include the
      // session that started and finished while it was down.
      const facts = brain.seen[brain.seen.length - 1];
      assert.match(facts, /While Down/, 'the runtime kept what happened while the voice was away');
      assert.match(facts, /COMPLETED/);
    }, {
      brainAnswers: [
        '{"capability":"session.list","args":{}}',
        'While Down has completed.',
      ],
    });
  });

  // ---- THE OTHER END OF /continue ----------------------------------------
  //
  // The watcher that polled for these is gone; the DOOR is not. `drainQueued`
  // is the same door it always was: the runtime's held queue, through the same
  // recovery a locally refused sentence takes. The Harness that inherits
  // remote control will open this door rather than build a second one.

  await test('RC: the CLI drains a remote continuation through the SAME recovery', async () => {
    await withRemote('drain', async ({ tg }) => {
      await rc.connect(tg.token);
      const id = 'drained';

      // ---- A CLI THAT IS ATTACHED AND IDLE ------------------------------
      //
      // The smallest thing the drain needs: a session, somewhere to write
      // a notice, and a `submit` to record what it was asked to run. Anything
      // more would be testing the App class rather than the seam.
      const submitted = [];
      const notices = [];
      const app = {
        session: { id },
        cfg: {},
        dispatching: 0,
        abort: null,
        inputClosed: false,
        render: { notice: (kind, text) => notices.push(`${kind}: ${text}`), write: text => notices.push(text) },
        submit: async (text, opts) => {
          submitted.push({ text, opts, handover: app._handover });
          return { stopReason: 'end' };
        },
      };

      guardian.identify(id, { name: 'Drained' });
      guardian.turnBegin(id, { turnId: 't1', model: 'm' });
      guardian.turnEnd(id, { outcome: 'rate_limited', reason: 'the route was limited' });
      await until(async () => {
        const st = await guardian.state(id);
        return st && st.needs_handover ? st : null;
      });

      // Somebody, somewhere else, asks for it to carry on.
      const queued = await rc.capability('session.continue', { session: id, intent: 'carry on' });
      assert.ok(queued.ok, queued.text);

      await require('../../src/inputgate').drainQueued(app);

      // ---- IT RAN, AS THE SAME TASK, WITH THE PACKET --------------------
      assert.strictEqual(submitted.length, 1, 'the queued intent was never run');
      assert.strictEqual(submitted[0].text, 'carry on', "and it ran the person's own words");
      assert.strictEqual(submitted[0].opts.sameTask, true, 'as a continuation, not a new objective');
      assert.strictEqual(submitted[0].opts.from, 'handover');
      // THE BRIEFING WAS ATTACHED, because the runtime said one was owed.
      assert.ok(submitted[0].handover, 'no handover packet was attached');
      assert.match(submitted[0].handover.reason, /RATE_LIMITED/);
      // AND THE USER WAS TOLD WHERE IT CAME FROM.
      assert.match(notices.join('\n'), /remote control/i);
      // The flag does not outlive its turn.
      assert.strictEqual(app._handover, null);

      // AND THE QUEUE IS EMPTY, so a second drain runs nothing.
      await require('../../src/inputgate').drainQueued(app);
      assert.strictEqual(submitted.length, 1, 'the intent was run twice');
    });
  });

  await test('RC: a remote stop is recorded by the runtime and spent, not left set', async () => {
    await withRemote('remotestop', async ({ tg }) => {
      await rc.connect(tg.token);
      const id = 'stopping';
      guardian.turnBegin(id, { turnId: 't1', model: 'm' });
      // The observation calls are fire-and-forget by design, so the session may
      // not exist yet the instant after asking for one.
      await until(async () => {
        const st = await guardian.state(id);
        return st && st.turn_id === 't1' ? st : null;
      });
      const asked = await rc.capability('session.stop', { session: id });
      assert.ok(asked.ok, asked.text);
      const askedState = await until(async () => {
        const s = await guardian.state(id);
        return s && s.stop_requested === true ? s : null;
      });
      assert.ok(askedState, 'the stop request was never recorded');

      // ---- AND THE REQUEST IS SPENT -------------------------------------
      //
      // The CLI-side watcher that honoured this is gone with /rc; the runtime
      // API that clears it survives for the Harness that inherits the control.
      // A flag left set would abort the NEXT turn, started minutes later by
      // somebody who never asked for anything to stop.
      guardian.stopClear(id);
      const st = await until(async () => {
        const s = await guardian.state(id);
        return s && s.stop_requested === false ? s : null;
      });
      assert.ok(st, 'the stop request was never cleared');
    });
  });

  // ---- NOTIFICATIONS -----------------------------------------------------

  await test('RC: the runtime tells an authorized chat when something needs a person', async () => {
    await withRemote('notify', async ({ tg }) => {
      const r = await rc.connect(tg.token);
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));
      const before = tg.sent.length;

      // A turn dies. Nobody asked anything — the phone is face down on a table.
      guardian.identify('notif', { name: 'Notified' });
      guardian.turnBegin('notif', { turnId: 't1', model: 'm' });
      guardian.turnEnd('notif', { outcome: 'provider', reason: 'the socket closed' });

      // The notifier ticks every few seconds, so this is a real wait rather
      // than an arrangement.
      const said = await until(
        () => (tg.sent.length > before ? tg.sent.slice(before).map((m) => m.text).join('\n') : null),
        20000,
      );
      assert.ok(said, 'nothing was ever sent');
      assert.match(said, /handover is owed|turn did not finish/i, 'and it says what happened');
      // ---- IT STATES WHAT HAPPENED, NOT WHAT IT MEANS ---------------------
      //
      // An event log entry is not evidence for a judgement. "A turn did not
      // finish" is a fact; "your build is broken" would be an opinion the
      // runtime is in no position to hold.
      assert.ok(!/broken|failed badly|you should/i.test(said));
    });
  });

  await test('RC: a notification is not repeated on the next tick', async () => {
    await withRemote('notifyonce', async ({ tg }) => {
      const r = await rc.connect(tg.token);
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));

      guardian.identify('once', { name: 'Once' });
      guardian.turnBegin('once', { turnId: 't1', model: 'm' });
      guardian.turnEnd('once', { outcome: 'provider', reason: 'the socket closed' });
      const first = await until(
        () => (tg.sent.some((m) => /handover is owed|did not finish/i.test(m.text)) ? tg.sent.length : null),
        20000,
      );
      assert.ok(first, 'the first notification never arrived');
      // TWO MORE TICKS. The cursor is persisted, so an event already reported
      // must not be reported again — a phone that repeats itself every five
      // seconds is a phone that gets muted, and a muted phone reports nothing.
      await new Promise((res) => setTimeout(res, 12000));
      const repeats = tg.sent.filter((m) => /handover is owed|did not finish/i.test(m.text)).length;
      assert.strictEqual(repeats, 1, `the same event was reported ${repeats} times`);
    });
  });

  // ---- FAILURE AND RECOVERY ----------------------------------------------

  await test('RC: Telegram going away degrades the link and leaves the runtime alone', async () => {
    await withRemote('degrade', async ({ tg }) => {
      await rc.connect(tg.token);
      await until(async () => ((await rc.status()).link === 'LISTENING' ? true : null));
      tg.fail = true;
      const degraded = await until(async () => ((await rc.status()).link === 'DEGRADED' ? await rc.status() : null));
      assert.ok(degraded, 'the link never reported itself degraded');
      assert.ok(degraded.last_error, 'and it says why');
      assert.strictEqual(degraded.last_error.includes(tg.token), false, 'the error leaked the token');

      // THE RUNTIME IS UNAFFECTED — §15. Sessions and workers do not depend on
      // a chat service being reachable.
      const still = await rc.capability('runtime.status');
      assert.ok(still.ok);
      assert.match(still.text, /Runtime:\s+ALIVE/);

      // AND IT RECOVERS WITHOUT ANYBODY ASKING.
      tg.fail = false;
      const back = await until(async () => ((await rc.status()).link === 'LISTENING' ? true : null), 30000);
      assert.ok(back, 'the adapter never came back after the network returned');
    });
  });

  await test('RC: disconnect removes it, and a restart does not silently reconnect', async () => {
    await withRemote('disconnect', async ({ tg, home }) => {
      const r = await rc.connect(tg.token);
      assert.ok(r.ok);
      const gone = await rc.disconnect();
      assert.ok(gone.ok && gone.removed);
      assert.strictEqual(fs.existsSync(path.join(home, 'supervisor', 'remote', 'telegram.json')), false);
      assert.strictEqual(fs.existsSync(path.join(home, 'supervisor', 'remote', 'authorized.json')), false);

      // A WHOLE NEW SUPERVISOR reads the same home and must find nothing.
      await supervisor.shutdown();
      guardian.forgetLocal();
      await supervisor.ensure();
      const after = await rc.status();
      assert.strictEqual(after.configured, false, 'a restart brought a removed bot back');
      assert.strictEqual(after.authorized_chats, 0);
    });
  });

  await test('RC: the credential and the authorizations survive a supervisor restart', async () => {
    await withRemote('survive', async ({ tg }) => {
      const r = await rc.connect(tg.token);
      tg.say(`/pair ${r.pairingCode}`);
      await until(() => (saidTo(tg).includes('Authorized') ? true : null));

      await supervisor.shutdown();
      guardian.forgetLocal();
      await supervisor.ensure();

      const after = await until(async () => {
        const s = await rc.status();
        return s.configured ? s : null;
      });
      assert.ok(after, 'the credential did not survive');
      assert.strictEqual(after.bot_username, 'lain_test_bot');
      assert.strictEqual(after.authorized_chats, 1, 'and neither did the authorization');
    });
  });
};
