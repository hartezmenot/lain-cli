'use strict';

/**
 * `/external` IS NOT A MODEL PICKER.
 *
 * It used to be: the whole of "external" was a model id in the config, chosen
 * from the same 900-row catalog `/models` opens. So the top-level question was
 * "which model", and a reviewer that is NOT a model in that catalog — a chat
 * page you are logged into, a person reading the packet — could not be
 * expressed at all.
 *
 * What these hold:
 *
 *   - the question is WHO, and there are four answers
 *   - the browser companion is NOT automated and never claims to be
 *   - nothing here scrapes, drives or reads a page
 *   - a pasted review is held to the same standard as an API one
 *   - the reverse-engineering seam is declared, bounded and NOT CONFIGURED
 *   - the reviewer, whichever it is, still gets no tools
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

const actors = require('../../src/actors');
const external = require('../../src/external');

function fakeApp(cfg = {}, { tui = false } = {}) {
  const { App } = require('../../src/app');
  const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
  Object.assign(app.cfg, cfg);
  app.ui.enabled = tui;
  return app;
}

module.exports = async function () {
  // --------------------------------------------------------- who, not what --

  await test('ACTOR: the question is WHO — four actors, and none of them is a catalog', () => {
    const app = fakeApp();
    const st = actors.status(app);
    const kinds = st.actors.map((a) => a.kind).sort();
    assert.deepStrictEqual(kinds, ['API', 'BROWSER', 'HUMAN', 'REVERSE']);
    // Every one of them says what it IS before you choose it.
    for (const a of st.actors) assert.ok(a.label && typeof a.automated === 'boolean', `${a.kind} must declare itself`);
  });

  await test('ACTOR: only the API actor is AUTOMATED — a web page is not an API', () => {
    const app = fakeApp();
    const by = Object.fromEntries(actors.status(app).actors.map((a) => [a.kind, a]));
    assert.strictEqual(by.API.automated, true);
    assert.strictEqual(by.BROWSER.automated, false, 'a page the user drives is not automated');
    assert.strictEqual(by.HUMAN.automated, false);
    assert.strictEqual(by.REVERSE.automated, false);
  });

  await test('ACTOR: the browser companion does not scrape, drive or read the page', () => {
    // Asserted against the SOURCE, because the whole promise is about what the
    // code does NOT contain. A comment saying so is not the same as not doing it.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'actors.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of ['puppeteer', 'playwright', 'webdriver', 'document.querySelector', 'WebSocket', 'cookie']) {
      assert.ok(!code.includes(banned), `the browser companion must not reach for ${banned}`);
    }
    // What it DOES do is open a URL, and the URL is a temporary chat.
    assert.match(actors.DEFAULT_BROWSER_URL, /^https:\/\/chatgpt\.com\/\?temporary-chat=true$/);
  });

  await test('ACTOR: an existing model-only config is still an API actor', () => {
    // The config key did not change, so nobody's setup broke.
    const app = fakeApp({ externalTroubleshoot: { model: 'some-model' } });
    assert.strictEqual(actors.kindOf(app.cfg), actors.KIND.API);
    const a = actors.create(app);
    assert.ok(a instanceof actors.ApiActor);
  });

  await test('ACTOR: a chosen actor with nothing to run it is NOT CONFIGURED, not silently API', () => {
    const app = fakeApp({ externalTroubleshoot: { actor: 'API' } });   // no model
    assert.strictEqual(actors.create(app), null, 'an API actor with no model is an empty setting');
    const st = actors.status(app).actors.find((a) => a.kind === 'API');
    assert.strictEqual(st.ok, false);
    assert.match(st.why, /NOT CONFIGURED|no model/i);
  });

  await test('ACTOR: `off` really means no actor at all', () => {
    const app = fakeApp({ externalTroubleshoot: { enabled: false, model: 'm', actor: 'HUMAN' } });
    assert.strictEqual(actors.create(app), null);
    assert.strictEqual(actors.status(app).off, true);
    assert.strictEqual(actors.status(app).chosen, null);
  });

  // ------------------------------------------------------------ the packet --

  await test('ACTOR: the human relay hands over a REAL packet, or says it could not', () => {
    const app = fakeApp({ externalTroubleshoot: { actor: 'HUMAN' } }, { tui: true });
    const a = actors.create(app);
    assert.ok(a instanceof actors.HumanActor);
    return a.send('INVESTIGATION PACKET — round 1 of 3\nPROBLEM\n  x').then((r) => {
      assert.strictEqual(r.ok, true);
      // Either the clipboard took it or a real file on disk did. Never an
      // apology, and never a claim that it was delivered when it was not.
      assert.ok(['clipboard', 'file'].includes(r.delivered), `delivered: ${r.delivered}`);
      if (r.delivered === 'file') assert.ok(fs.existsSync(r.file), 'the fallback must be a file that exists');
      assert.match(a.sent, /INVESTIGATION PACKET/, 'and the packet is kept verbatim');
    });
  });

  await test('ACTOR: a PASTED review is read into the same four sections as an API one', async () => {
    const app = fakeApp({ externalTroubleshoot: { actor: 'HUMAN' } }, { tui: true });
    const a = actors.create(app);
    const reply = 'FACT\n  status.json is stale.\nEVIDENCE\n  mtime Aug 14.\n'
      + 'HYPOTHESIS\n  the writer stopped.\nRECOMMENDATION\n  check the writer process.';
    const got = a.read(reply);
    assert.strictEqual(got.ok, true);
    assert.match(got.sections.fact.join(' '), /status\.json is stale/);
    assert.match(got.sections.evidence.join(' '), /mtime Aug 14/);
    assert.match(got.sections.hypothesis.join(' '), /writer stopped/);
    assert.match(got.sections.recommendation.join(' '), /check the writer process/);
    assert.strictEqual(got.overclaim, null);
  });

  await test('ACTOR: a pasted review that claims to have ACTED is flagged too', () => {
    // A human-relayed model has no tools here either. The check may not be
    // something only the API path gets.
    const app = fakeApp({ externalTroubleshoot: { actor: 'HUMAN' } }, { tui: true });
    const a = actors.create(app);
    const got = a.read('FACT\n  I ran the tests and they passed.');
    assert.ok(got.overclaim, 'the claim must be caught however the review arrived');
  });

  await test('ACTOR: nothing empty is accepted as a review', () => {
    const app = fakeApp({ externalTroubleshoot: { actor: 'HUMAN' } }, { tui: true });
    const got = actors.create(app).read('   \n  ');
    assert.strictEqual(got.ok, false);
    assert.match(got.error, /nothing came back/);
  });

  await test('ACTOR: off a TTY the human relay says so instead of hanging', async () => {
    // There is nobody to paste. Waiting forever is the worst possible answer.
    const app = fakeApp({ externalTroubleshoot: { actor: 'HUMAN' } }, { tui: false });
    const a = actors.create(app);
    assert.strictEqual(a.status().ok, false);
    const got = await a.receive();
    assert.strictEqual(got.ok, false);
    assert.match(got.error, /interactive terminal/);
  });

  // ----------------------------------------------------------- the reverse --

  await test('ACTOR: the reverse-engineering seam is DECLARED and NOT CONFIGURED', () => {
    const app = fakeApp();
    const st = new actors.ReverseActor(app, app.cfg).status();
    assert.strictEqual(st.ok, false);
    assert.match(st.why, /NOT CONFIGURED/);
    // The capability boundary is on the record, and read-only.
    assert.deepStrictEqual(st.capabilities, ['process.select', 'memory.read', 'screen.inspect', 'symbol.resolve']);
    assert.ok(!st.capabilities.some((c) => /write|inject|patch/i.test(c)),
      'the declared seam must not include writing to another process');
  });

  await test('ACTOR: nothing in the tree implements memory editing or injection', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'actors.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of ['WriteProcessMemory', 'ReadProcessMemory', 'ptrace', 'VirtualAlloc', 'CreateRemoteThread']) {
      assert.ok(!code.includes(banned), `${banned} must not exist here`);
    }
  });

  // ---------------------------------------------------------- one controller --

  await test('ACTOR: the reviewer gets NO TOOLS, whichever actor it is', () => {
    // external.js is the only thing that speaks to a provider here, and it
    // passes an empty tool list. That is what keeps the reviewer an advisor.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'external.js'), 'utf8');
    assert.match(src, /tools:\s*\[\]/, 'the external request must carry no tools');
    assert.match(external.SYSTEM, /NO tools, NO filesystem and NO shell/);
    // And no actor class may call a tool of its own.
    const a = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'actors.js'), 'utf8');
    assert.ok(!/require\('\.\/tools'\)/.test(a), 'an actor must not reach the tool registry');
  });

  await test('ACTOR: rounds stay bounded whatever the actor', () => {
    for (const kind of ['API', 'HUMAN', 'BROWSER']) {
      const app = fakeApp({ externalTroubleshoot: { actor: kind, model: 'm', maxRounds: 99 } }, { tui: true });
      const st = actors.status(app).actors.find((x) => x.kind === kind);
      assert.ok(st.maxRounds <= 6, `${kind} must not be able to configure the cap away`);
    }
  });

  await test('ACTOR: /external no longer opens the model catalog as its first question', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routecommands.js'), 'utf8');
    const cmd = src.slice(src.indexOf("define('/external'"), src.indexOf("define('/models'"));
    // The FIRST panel it opens on a TTY is the actor menu. The model picker is
    // reachable from inside it, which is the point — a second question.
    assert.ok(cmd.indexOf('externalActorAdapter') < cmd.indexOf('modelsAdapter'),
      'the actor menu must come before any model list');
    assert.match(cmd, /onPickApi/, 'and the model picker is what the API actor drills into');
  });

  await test('ACTOR: /model and /models are untouched — they still browse the catalog', () => {
    const commands = require('../../src/commands');
    for (const name of ['/model', '/models']) {
      assert.ok(commands.REGISTRY.has(name), `${name} must still exist`);
    }
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routecommands.js'), 'utf8');
    const models = src.slice(src.indexOf("define('/models'"));
    assert.match(models, /pickCommand/, '/models still opens the one catalog picker');
  });
};
