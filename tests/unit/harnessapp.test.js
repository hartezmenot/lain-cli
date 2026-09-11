'use strict';

/**
 * THE HARNESS APPLICATION — its read model, its routes, and its boundaries.
 *
 * ------------------------------------------------------------------------
 * WHAT IS ASSERTED HERE IS MOSTLY A NEGATIVE, and deliberately so.
 *
 * The application is a SECOND SURFACE over one product. Almost everything that
 * could go wrong with it is it acquiring an opinion of its own: a second answer
 * to whether a task passed, a second way to make a session current, a second
 * turn entry point that skips the input gateway, a Cowork panel over a backend
 * that has none. So the tests are largely "it does not own this".
 *
 * The Workshop's own end-to-end behaviour is proved against a real dev server
 * and a real browser in tests/smoke/harnessapp-workshop.test.js. This file is
 * the part that can be decided without either.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const state = require('../../src/harnessapp/state');
const routes = require('../../src/harnessapp/routes');
const page = require('../../src/harnessapp/page');

function appAt(cwd) {
  const { App } = require('../../src/app');
  return new App({
    out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false },
    interactive: false,
    cwd: cwd || process.cwd(),
  });
}

module.exports = async function () {
  // --------------------------------------------------------- the read model --

  await test('APP: the state carries the session, the lanes and the sources', async () => {
    const app = appAt(tmpdir('app-'));
    const s = await state.read(app);
    assert.ok(s.current && s.current.id, 'the open session is named');
    assert.strictEqual(s.current.lane, 'engineering', 'a session with no Cowork binding is engineering');
    assert.ok(s.sessions.engineering && s.sessions.cowork, 'both lanes are projected');
    assert.ok(Array.isArray(s.sources.sources), 'the chat sources are listed');
    assert.deepStrictEqual(
      s.sources.sources.map((x) => x.id).sort(),
      ['chatgpt-web', 'gemini-web', 'lain'],
      'all three chat sources reach the application',
    );
  });

  await test('APP: a missing task is null, never an empty task', async () => {
    // The rule harnesssurface.js already holds, carried across the boundary. A
    // surface that renders "no task" as a task with no evidence is telling
    // somebody work exists that does not.
    const s = await state.read(appAt(tmpdir('app-')));
    assert.strictEqual(s.harness, null);
  });

  await test('APP: the lane comes from ASTRA\'S marker, never from the work', async () => {
    // Guessing would put a person's engineering history in the Cowork list. The
    // marker is src/cowork/sessionstate.js, and it is the only input.
    assert.strictEqual(state.laneOf({}), 'engineering');
    assert.strictEqual(state.laneOf({ cowork: { lane: 'cowork', source: 'telegram' } }), 'cowork');
    assert.strictEqual(state.laneOf({ messages: [{ content: 'clean this spreadsheet' }] }), 'engineering',
      'work about a spreadsheet is not a Cowork session');
  });

  await test('APP: Cowork reports EXACTLY what Astra has built, and no more', async () => {
    // The brief's hard rule: do not fake capabilities the backend does not have.
    // Astra's contract today is a source binding; there is no task, artifact,
    // approval or job surface behind it.
    const s = await state.read(appAt(tmpdir('app-')));
    assert.strictEqual(s.cowork.capabilities.sessions, true);
    for (const gone of ['tasks', 'artifacts', 'approvals', 'jobs']) {
      assert.strictEqual(s.cowork.capabilities[gone], false, `${gone} is not implemented and must not be claimed`);
    }
    assert.match(s.cowork.why, /not implemented/i, 'and it says so in words');
  });

  await test('APP: tool results never travel to the application', async () => {
    // They are the bulk and the risk. The activity projection already summarises
    // what ran; shipping the output would make every poll carry a file body.
    const app = appAt(tmpdir('app-'));
    app.session.messages.push({ role: 'user', content: 'read it' });
    app.session.messages.push({ role: 'tool', tool_call_id: 't1', content: 'SECRET-TOOL-DUMP 40000 lines' });
    app.session.messages.push({ role: 'assistant', content: 'done' });
    const conv = state.conversation(app.session);
    assert.deepStrictEqual(conv.map((m) => m.role), ['user', 'assistant']);
    assert.ok(!JSON.stringify(conv).includes('SECRET-TOOL-DUMP'));
  });

  await test('APP: provenance rides the message it belongs to', async () => {
    const app = appAt(tmpdir('app-'));
    app.session.messages.push({ role: 'user', content: 'explain it' });
    app.session.messages.push({
      role: 'assistant', content: 'here you go',
      provenance: { label: 'ChatGPT.com · gpt-x', sourceId: 'chatgpt-web' },
    });
    const conv = state.conversation(app.session);
    assert.strictEqual(conv[1].provenance.label, 'ChatGPT.com · gpt-x');
    assert.strictEqual(conv[0].provenance, null, 'a user message has none');
  });

  // ------------------------------------------------------------- the routes --

  await test('APP: an unknown route is 404, never a fall-through', async () => {
    const r = await routes.dispatch(appAt(tmpdir('app-')), 'POST', '/api/nope', {});
    assert.strictEqual(r.code, 404);
  });

  await test('APP: a route that throws reports the reason', async () => {
    // A button that does nothing for no stated reason is indistinguishable from
    // a broken build.
    const broken = { get session() { throw new Error('boom'); } };
    const r = await routes.dispatch(broken, 'GET', '/api/state', {});
    assert.strictEqual(r.code, 500);
    assert.match(r.body.why, /boom/);
  });

  await test('APP: an empty prompt is refused rather than submitted', async () => {
    const r = await routes.dispatch(appAt(tmpdir('app-')), 'POST', '/api/turn', { text: '   ' });
    assert.strictEqual(r.code, 400);
  });

  await test('APP: a turn refuses while one is already running', async () => {
    const app = appAt(tmpdir('app-'));
    app.abort = new AbortController();
    const r = await routes.dispatch(app, 'POST', '/api/turn', { text: 'go' });
    assert.strictEqual(r.code, 409);
  });

  await test('APP: asking goes through `app.handle`, the ONE door', () => {
    // Not `submit`, and never `runTurn`. `handle` is where a command is
    // recognised, an open question is answered, a composed goal is captured and
    // the input gateway admits or holds a sentence. A second entry point would
    // be a second set of rules for the same words.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/harnessapp/routes'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(/app\.handle\(/.test(src), 'it must submit through handle');
    assert.ok(!/app\.submit\(/.test(src), 'and never through submit');
    assert.ok(!/runTurn/.test(src), 'and never through the turn loop directly');
  });

  await test('APP: the application cannot make a different session current', () => {
    // `/resume` is the one path that crosses a session boundary — a rule the
    // Session class states in its own header. A second way in from a browser,
    // with a turn possibly running against the session being replaced, is
    // exactly the leak that rule exists to prevent.
    assert.ok(!Object.keys(routes.ROUTES).some((k) => /resume|session\/(open|switch)/i.test(k)),
      'no route may switch sessions');
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/harnessapp/routes'), 'utf8');
    assert.ok(!/Session\.resume|app\.adopt\(/.test(src), 'and nothing here adopts a session');
  });

  // ------------------------------------------------------ no second truth --

  await test('APP: the read model DERIVES nothing — it reads the owners', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/harnessapp/state'), 'utf8');
    for (const owner of ['harnesssurface', 'sessionindex', 'modelsource/registry', 'ui/panes', 'workshop', 'goal']) {
      assert.ok(src.includes(owner), `the read model must consume ${owner} rather than re-deriving it`);
    }
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A VERDICT COMPUTED HERE would be a second answer to the only question the
    // program exists to answer honestly.
    assert.ok(!/PASSED|FAILED|INCONCLUSIVE/.test(code), 'the app must not compute a verdict');
  });

  await test('APP: polling opens nothing — discovery and the Workshop are POSTs', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/harnessapp/state'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A poll that could launch a browser launches one every two seconds.
    assert.ok(!/discoverModels|\.open\(|\.connect\(|ensureCatalog/.test(src),
      'the polled read must not launch, connect or refresh anything');
    assert.ok(routes.ROUTES['POST /api/source/models'], 'discovery is an explicit route');
    assert.ok(routes.ROUTES['POST /api/workshop/open'], 'and so is opening the Workshop');
  });

  // -------------------------------------------------------------- the page --

  await test('APP: the page is one self-contained document with valid script', () => {
    const html = page.html();
    assert.match(html, /<!doctype html>/i);
    assert.ok(!/<script[^>]+src=/.test(html), 'no external script — there is no build step and no CDN');
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 2, 'the app and the workshop scripts are both present');
    for (const b of blocks) {
      // A TEMPLATE LITERAL THAT COMPOSES IS NOT JAVASCRIPT THAT PARSES. A
      // stray backtick in a comment ended the string and shipped a broken page
      // that still "rendered" — found by running this.
      assert.doesNotThrow(() => new Function(b), 'the emitted client script must parse');
    }
  });

  await test('APP: the shell is public and every fact behind it is not', () => {
    // The SESSION credential lives in a header, never the URL — so a link is
    // safe to hand around and the credential is not. Same rule dash.js settled
    // on, and it is unchanged.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/harnessapp/server'), 'utf8');
    assert.ok(/x-lain-session/.test(src), 'the session token travels in a header');
    assert.ok(/127\.0\.0\.1/.test(src), 'and it binds loopback only');
    assert.ok(!/0\.0\.0\.0/.test(src), 'never every interface');
  });

  await test('APP: the launch token is the ONE thing in a URL, and it is spent on use', () => {
    // ---- THIS RULE CHANGED, DELIBERATELY --------------------------------
    //
    // The guard above used to also ban `searchParams.get('t')` outright. That
    // was right while the only way in was a password a person pasted — and
    // that flow was the reported defect: the paste worked, Enter sometimes did
    // not take it, and the failure said very little.
    //
    // `/app` now opens the browser itself with a ONE-TIME launch token in the
    // URL, exchanged for a real session while the document is served. The
    // exception is bounded, and these are the bounds — asserted, so they
    // cannot quietly erode into "a credential in a URL".
    const server = require('../../src/harnessapp/server');
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/harnessapp/server'), 'utf8');

    // SINGLE USE, AND SPENT BEFORE IT IS CHECKED. The token is cleared from
    // state before any comparison can fail or throw; a token that survives a
    // rejected attempt is not single-use, and the ORDER is the only guarantee.
    const consume = src.slice(src.indexOf('function consumeLaunchToken('), src.indexOf('function readBody('));
    const clearedAt = consume.indexOf('state.launch = null');
    const comparedAt = consume.indexOf('timingSafeEqual');
    assert.ok(clearedAt > 0 && comparedAt > clearedAt,
      'the launch token must be spent BEFORE it is compared, or a failed attempt leaves it usable');

    // IT EXPIRES.
    assert.ok(server.LAUNCH_TTL_MS > 0 && server.LAUNCH_TTL_MS <= 5 * 60 * 1000,
      `a launch token good for ${server.LAUNCH_TTL_MS}ms is not a launch token`);
    assert.match(consume, /expires/, 'and the expiry is actually checked');

    // AND IT IS COMPARED IN CONSTANT TIME, like every other credential here.
    assert.match(consume, /timingSafeEqual/);

    // THE PAGE ERASES IT FROM THE ADDRESS BAR.
    const script = require('../../src/harnessapp/pagescript').js();
    assert.match(script, /history\.replaceState/,
      'a spent credential left in the address bar is still something a person can copy into a message');
  });

  await test('APP: an unknown or reused launch token is refused', () => {
    const server = require('../../src/harnessapp/server');
    // With no server running there is no state, so nothing can be spent.
    assert.strictEqual(server.consumeLaunchToken('deadbeef'), null);
    assert.strictEqual(server.consumeLaunchToken(''), null);
    assert.strictEqual(server.consumeLaunchToken(null), null);
  });
};
