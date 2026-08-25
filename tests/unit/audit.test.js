'use strict';

/**
 * `/audit` and `/troubleshoot`.
 *
 * The failure modes these guard against:
 *   - an audit that reports the PHRASE "not implemented" from a comment as
 *     unfinished work (noise dressed as a finding);
 *   - an audit that dumps code instead of a plain-language reading;
 *   - `/troubleshoot` quietly becoming an ordinary edit request because the
 *     classifier guessed BUGFIX from the words, defeating the whole point of a
 *     command that says "trace before you touch anything".
 *
 * They test the PATH the user takes — command → mode → guidance — not just that
 * a function returns a value.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const auditMod = require('../../src/audit');
const commands = require('../../src/commands');

/** A project on disk, from a { relpath: body } map. */
function project(files) {
  const dir = tmpdir('audit-');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

/** A render sink that records everything written, for asserting on the report. */
function sink() {
  const out = [];
  return {
    text: '',
    render: {
      width: 96,
      write(s) { out.push(s); this._text = (this._text || '') + s; },
      notice(kind, msg) { out.push(`[${kind}] ${msg}`); },
      // THE TRANSIENT SURFACE. `commands.run` opens and closes it around every
      // command, so a stand-in for Render has to answer these two or it is not
      // standing in for Render. Off a TTY the real ones are no-ops, which is
      // exactly what these are.
      openSurface() { return false; },
      doneSurface() {},
    },
    get all() { return out.join(''); },
  };
}

module.exports = async function () {
  // --------------------------------------------------------------- audit ---

  await test('AUDIT: reads structure, entry point and tests from a real tree', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'demo', main: 'src/index.js', scripts: { start: 'node src/index.js' } }),
      'src/index.js': 'console.log("hi");',
      'tests/index.test.js': 'require("assert");',
    });
    const a = await auditMod.audit(dir);
    assert.strictEqual(a.name, 'demo');
    assert.ok(a.languages.includes('javascript'));
    assert.ok(a.entries.some((e) => /main: src\/index\.js/.test(e)), 'the declared entry point must be found');
    assert.strictEqual(a.tests.count, 1, 'the test file must be counted');
  });

  await test('AUDIT: a real stub is flagged, but the PHRASE in a comment is not', async () => {
    const dir = project({
      // A genuine unfinished function — this SHOULD be flagged.
      'src/real.py': 'def pay():\n    raise NotImplementedError\n',
      // The same words, but in a comment describing the code — must NOT count.
      'src/prose.js': '// this is fully implemented; nothing here is not implemented\nconst ok = 1;\n',
    });
    const a = await auditMod.audit(dir);
    const stub = a.markers.find((m) => m.plain.startsWith('unfinished stubs'));
    assert.ok(stub, 'the real stub must produce a marker');
    assert.strictEqual(stub.count, 1, 'exactly one real stub, not the comment');
    assert.match(stub.example, /real\.py/);
  });

  await test('AUDIT: an empty catch is flagged; one with a body is not', async () => {
    const dir = project({
      'src/silent.js': 'try { risky(); } catch {}\n',
      'src/handled.js': 'try { risky(); } catch (e) { log(e); }\n',
    });
    const a = await auditMod.audit(dir);
    const ec = a.markers.find((m) => /silently dropped/.test(m.plain));
    assert.ok(ec && ec.count === 1, 'only the empty catch counts');
  });

  await test('AUDIT: capabilities are detected from evidence, with the file as proof', async () => {
    // checkpoint.js is one of the probed capabilities (see capabilities.js).
    const dir = project({ 'src/checkpoint.js': 'const crypto = require("crypto");' });
    const a = await auditMod.audit(dir);
    assert.ok(a.capabilities.some((c) => c.where.some((f) => /checkpoint/.test(f))),
      'a detected capability must name the file it was found in');
  });

  await test('AUDIT: the report is plain language — sections, not a code dump', async () => {
    const dir = project({ 'package.json': '{"name":"demo"}', 'src/index.js': 'const secret = 42;' });
    const app = sink();
    const a = await auditMod.audit(dir);
    auditMod.renderAudit(app, a, { C: null });
    const text = app.all;
    assert.match(text, /Structure/);
    assert.match(text, /How it runs/);
    assert.ok(!text.includes('const secret = 42'), 'the audit must not paste source back at the reader');
  });

  await test('AUDIT: with no tests, the single next step is to add one', async () => {
    const dir = project({ 'src/index.js': 'const a = 1;' });
    const a = await auditMod.audit(dir);
    assert.match(auditMod.nextStep(a), /add a test/i);
  });

  await test('AUDIT: work state reflects a live session, and is absent without one', async () => {
    assert.strictEqual(auditMod.workState({}), null);
    const app = {
      session: {
        task: { objective: 'fix the signal button' },
        plan: { steps: [{ done: true }, { done: false }], digest: () => '' },
        lifecycle: { evidence: { filesChanged: ['/p/telegram.js'] }, lastCommand: { command: 'npm test', ok: false } },
      },
    };
    const ws = auditMod.workState(app);
    assert.strictEqual(ws.objective, 'fix the signal button');
    assert.deepStrictEqual(ws.plan, { done: 1, total: 2 });
    assert.deepStrictEqual(ws.filesChanged, ['telegram.js']);
    assert.strictEqual(ws.lastCheck.ok, false);
  });

  // ------------------------------------------------------ command wiring ---

  await test('WIRING: /audit and /troubleshoot are registered commands', () => {
    assert.ok(commands.looksLikeCommand('/audit'));
    assert.ok(commands.looksLikeCommand('/troubleshoot the button is stuck'));
  });

  await test('WIRING: /audit <folder> forwards to the comparison, not the self-audit', async () => {
    const other = project({ 'src/orchestra.js': 'x' });
    const here = sink();
    here.cfg = {};
    here.session = { cwd: process.cwd() };
    await commands.run(here, `/audit ${other}`);
    assert.ok(here._lastCompare, '/audit with a source must run /compare (which records _lastCompare)');
    assert.match(here.all, /Comparison/);
  });

  await test('WIRING: bare /troubleshoot asks what is wrong instead of doing nothing', async () => {
    const app = sink();
    let submitted = null;
    app.submit = (t, o) => { submitted = { t, o }; };
    await commands.run(app, '/troubleshoot');
    assert.match(app.all, /Troubleshoot what/i);
    assert.strictEqual(submitted, null, 'an empty /troubleshoot must not submit a turn');
  });

  await test('WIRING: /troubleshoot <text> submits that text FORCED into TROUBLESHOOT mode', async () => {
    const app = sink();
    let submitted = null;
    app.submit = (t, o) => { submitted = { t, o }; };
    await commands.run(app, '/troubleshoot the signal button stays OFF');
    assert.ok(submitted, 'it must submit a turn');
    assert.strictEqual(submitted.t, 'the signal button stays OFF');
    assert.strictEqual(submitted.o.forceMode, 'TROUBLESHOOT');
  });

  // ------------------------------------------------- the mode override ---

  await test('MODE: a forced mode overrides the local classifier guess', () => {
    const { App } = require('../../src/app');
    const out = { write() {}, on() {}, columns: 80, isTTY: false };
    const app = new App({ out, interactive: false, cwd: process.cwd() });
    // "add a feature" would classify as IMPLEMENT; the command forces otherwise.
    const v = app.identify('add a feature to the button', false, 'TROUBLESHOOT');
    assert.strictEqual(v.mode, 'TROUBLESHOOT');
    assert.strictEqual(app.session.mode, 'TROUBLESHOOT');
    assert.match(v.modeReason, /command/i);
  });

  await test('AUDIT: a silently swallowed error counts in Python too, not only JavaScript', async () => {
    // The marker was `catch {}` and nothing else, so a Python project full of
    // `except Exception: pass` — the textbook version of an error nobody will
    // ever see — audited as clean. The user's own example project is Python.
    const dir = project({
      'requirements.txt': 'flask\n',
      'probot/dashboard.py': [
        'def refresh():',
        '    try:',
        '        pull()',
        '    except Exception:',
        '        pass',
        '',
        'def other():',
        '    try:',
        '        push()',
        '    except: pass',
      ].join('\n'),
      'probot/ok.py': 'def f():\n    try:\n        g()\n    except Exception as e:\n        log(e)\n',
    });
    const a = await auditMod.audit(dir);
    const m = a.markers.find((x) => x.id === 'emptycatch');
    assert.ok(m, 'two swallowed exceptions must be found');
    assert.strictEqual(m.count, 2, 'and the one that IS handled must not be counted');
    assert.match(m.worst.file, /dashboard\.py/, 'and the report says which file has them');
  });

  await test('MODE: an unknown forced mode falls back to the classifier, never breaks', () => {
    const { App } = require('../../src/app');
    const out = { write() {}, on() {}, columns: 80, isTTY: false };
    const app = new App({ out, interactive: false, cwd: process.cwd() });
    const v = app.identify('explain how the parser works', false, 'NOT_A_REAL_MODE');
    assert.ok(v.mode && v.mode !== 'NOT_A_REAL_MODE', 'a bogus force must not leak through as the mode');
  });
};
