'use strict';

/**
 * `/external` AND `/resume`, THROUGH THE REAL BINARY.
 *
 * A unit test proves a function returns the right thing; only this proves it
 * reaches a user. Everything here spawns bin/lain.js.
 *
 * The two claims being checked are the ones the whole batch turns on:
 *
 *   `/external` asks WHO, and does not put the model catalog on screen.
 *   `/resume` shows sessions by what they were, and never needs an id.
 *
 * LIMITATION, STATED: the provider is the scripted mock, so no real second
 * model is consulted in this file. The PATH is real — the binary, the config,
 * the panel, the session store — but a genuine external review is a LIVE
 * verification and is not claimed here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
// Per-frame boundary is `\x1b[?25l` (hide-cursor, once per draw(), nowhere
// else) now that a redraw no longer opens with a full-screen clear.
const frames = (out) => String(out).split('\x1b[?25l').slice(1).map(plain);
const tui = (cols = 100, rows = 34) => ({ LAIN_FORCE_TUI: '1', COLUMNS: String(cols), LINES: String(rows) });

/** A config home with a real catalog, so "the model list" is a thing that exists. */
function withCatalog(extra = {}) {
  const cwd = tmpdir('exres-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    connections: {
      omniroute: {
        provider: 'anthropic', via: 'bridge', baseUrl: 'http://127.0.0.1:1/v1',
        models: ['claude-opus-5', 'kimi-k3', 'gpt-5.4', 'gemini-3-flash', 'llama-3.1-8b'],
      },
    },
    ...extra,
  }, null, 2));
  return { cwd, configDir };
}

module.exports = async function () {
  // -------------------------------------------------------------- external --

  await test('EXTERNAL: /external asks WHO — it does not open the model catalog', async () => {
    const { cwd, configDir } = withCatalog();
    const r = await runCli([], {
      cwd, configDir, env: tui(),
      stdinSteps: ['/external\n', '\x1b', '/exit\n'],
      stepDelayMs: 700,
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'EXTERNAL ACTOR', 'the panel names the question it is asking');
    for (const label of ['API model', "LAIN's browser", 'Human relay']) {
      assertIncludes(out, label, 'every actor must be offered');
    }
    // AND NOT THE CATALOG. This is the defect: the first question used to be a
    // model list, and every non-model reviewer was inexpressible.
    assertNotIncludes(out, 'MODELS   5', 'the model browser must not be what /external opens');
    assertNotIncludes(out, 'Claude Opus 5', 'nor its contents — the catalog renders display names');
    assert.strictEqual(r.code, 0);
  });

  await test('EXTERNAL: the row says which actor is AUTOMATED and which is not', async () => {
    // "You paste the reply back" versus "automated" is the whole difference,
    // and burying it is how a browser page gets mistaken for an API.
    const { cwd, configDir } = withCatalog();
    const r = await runCli([], {
      cwd, configDir, env: tui(),
      stdinSteps: ['/external\n', '\x1b', '/exit\n'],
      stepDelayMs: 700,
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'automated');
    assertIncludes(out, 'you drive the page');
    assertIncludes(out, 'paste the reply back', 'and the row must not be clipped before it says so');
  });

  await test('EXTERNAL: /model still opens the ordinary catalog — the two are separate', async () => {
    const { cwd, configDir } = withCatalog();
    const r = await runCli([], {
      cwd, configDir, env: tui(),
      stdinSteps: ['/model\n', '\x1b', '/exit\n'],
      stepDelayMs: 700,
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'MODELS', 'the model picker is untouched');
    assertIncludes(out, 'Claude Opus 5', 'by the name the picker actually shows');
    assertNotIncludes(out, 'EXTERNAL ACTOR', 'and it is not the actor menu');
    assert.strictEqual(r.code, 0);
  });

  await test('EXTERNAL: an actor is chosen by name off a TTY, and persists', async () => {
    const { cwd, configDir } = withCatalog();
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/external browser\n/external\n/external human\n/external\n/exit\n',
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, "✓ external actor: LAIN's browser");
    assertIncludes(out, 'chatgpt.com/?temporary-chat=true', 'and it says which page it will open');
    // WHAT IT SAYS IT WILL DO MUST BE WHAT IT DOES. This asserted the line
    // "LAIN does not read the page" — which had stopped being true. BrowserActor
    // drives LAIN's own Chromium, types the packet in and reads the reply back
    // off the page; the clipboard is only the fallback for when that browser is
    // not running. A true sentence had been left in place after the behaviour
    // underneath it was replaced, so the screen described the old architecture.
    assertIncludes(out, "LAIN's own Chromium", 'it must name whose browser this is');
    assertIncludes(out, 'reads the reply back off the page', 'and that it DOES read it');
    assertNotIncludes(out, 'LAIN does not read the page', 'the retired claim must not come back');
    assertIncludes(out, '✓ external actor: Human relay');
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert.strictEqual(cfg.externalTroubleshoot.actor, 'HUMAN', 'the choice really persisted');
  });

  await test('EXTERNAL: /external api <model> still sets a model, exactly as before', async () => {
    const { cwd, configDir } = withCatalog();
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/external api claude-opus-5\n/external\n/exit\n',
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, '✓ external reviewer:');
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert.strictEqual(cfg.externalTroubleshoot.actor, 'API');
    assert.strictEqual(cfg.externalTroubleshoot.model, 'claude-opus-5');
  });

  await test('EXTERNAL: the reverse adapter reports NOT CONFIGURED and changes nothing', async () => {
    const { cwd, configDir } = withCatalog();
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/external reverse\n/exit\n',
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'NOT CONFIGURED');
    assertIncludes(out, 'process.select', 'the capability boundary is named');
    assertIncludes(out, 'memory.read');
    assertNotIncludes(out, 'memory.write', 'and writing another process is not part of it');
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert.ok(!cfg.externalTroubleshoot || cfg.externalTroubleshoot.actor !== 'REVERSE',
      'a seam that is not built must not be recorded as chosen');
  });

  await test('EXTERNAL: the human relay hands the packet over and TAKES THE REPLY BACK', async () => {
    // THE DEADLOCK THIS EXISTS TO CATCH. The relay parks on `pendingAsk` from
    // inside a turn, and typed input is QUEUED for the REPL loop — which is
    // parked inside that same turn. So the answer waited for the work that was
    // waiting for the answer: the packet went out, the user pasted the review,
    // and nothing happened. Observed in the real binary, not in a unit test.
    const { cwd, configDir } = withCatalog({ externalTroubleshoot: { actor: 'HUMAN', maxRounds: 1 } });
    fs.mkdirSync(path.join(cwd, 'probot'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'probot', 'dashboard.py'),
      'def refresh():\n    try:\n        pull()\n    except Exception:\n        pass\n');
    const review = 'FACT\n  status.json is stale since Aug 14.\nEVIDENCE\n  its mtime has not moved.\n'
      + 'HYPOTHESIS\n  the writer stopped.\nRECOMMENDATION\n  check whether the writer is running.';
    const r = await runCli([], {
      cwd, configDir, env: tui(),
      stdinSteps: [
        '/troubleshoot the dashboard drops errors\n',
        `\x1b[200~${review}\x1b[201~`,
        '\r',
        '/exit\n',
      ],
      stepDelayMs: 1400,
      script: [{ text: 'Looking.' }],
      timeoutMs: 60000,
    });
    const out = plain(r.out).replace(/\s+/g, ' ');
    assertIncludes(out, 'the packet is on your clipboard', 'the handover must be announced');
    assertIncludes(out, 'paste the reply back', 'and what is expected of the user');
    // THE REPLY REALLY ARRIVED, and was read into the sections.
    assertIncludes(out, 'status.json is stale', 'the pasted review must reach the report');
    assertIncludes(out, 'check whether the writer is running', 'including its RECOMMENDATION');
    assertIncludes(out, 'Human relay', 'and the actor is named as what it was');
    assert.ok(!/recommended no next action/.test(out),
      'a review that DID recommend something must not be reported as recommending nothing');
  });

  // ---------------------------------------------------------------- resume --

  /** Run a session that leaves something recognisable behind. */
  async function seed(configDir, cwd, objective) {
    return runCli([], {
      cwd, configDir,
      stdin: `${objective}\n/exit\n`,
      script: [
        { text: 'Checking.', tool_calls: [{ name: 'run_bash', input: { command: 'echo checked' } }] },
        { text: 'Done looking.' },
      ],
      timeoutMs: 40000,
    });
  }

  await test('RESUME: the list names sessions by WHAT THEY WERE, with no id to remember', async () => {
    const { cwd, configDir } = withCatalog();
    await seed(configDir, cwd, 'the dashboard stopped updating');
    const r = await runCli([], { cwd, configDir, stdin: '/resume\n/exit\n', script: [], timeoutMs: 30000 });
    const out = plain(r.out);
    assertIncludes(out, 'the dashboard stopped updating', 'the objective is the handle');
    assertIncludes(out, path.basename(cwd), 'and so is the project');
    assertIncludes(out, 'TODAY', 'when it happened, in words');
    assert.ok(!/\/resume <id>/.test(out), 'it must not still be asking for an id');
    assert.strictEqual(r.code, 0);
  });

  await test('RESUME: a search finds the right one out of several', async () => {
    const { cwd, configDir } = withCatalog();
    await seed(configDir, cwd, 'the dashboard stopped updating');
    await seed(configDir, cwd, 'the signal button is in the wrong place');
    const r = await runCli([], { cwd, configDir, stdin: '/resume signal\n/exit\n', script: [], timeoutMs: 30000 });
    const out = plain(r.out);
    assertIncludes(out, 'signal button');
    assertNotIncludes(out, 'dashboard stopped updating', 'a search must actually narrow');
  });

  await test('RESUME: a number resumes the row that was just listed', async () => {
    const { cwd, configDir } = withCatalog();
    await seed(configDir, cwd, 'the dashboard stopped updating');
    const r = await runCli([], { cwd, configDir, stdin: '/resume\n/resume 1\n/exit\n', script: [], timeoutMs: 30000 });
    const out = plain(r.out);
    assertIncludes(out, 'RESUMING SESSION');
    assertIncludes(out, 'objective: the dashboard stopped updating', 'the ORIGINAL task came back');
    assertIncludes(out, 'last check: echo checked', 'and what was actually run');
  });

  await test('RESUME: an id still works — nobody holding one is turned away', async () => {
    const { cwd, configDir } = withCatalog();
    const first = await seed(configDir, cwd, 'fix the dropped errors');
    const id = (/--resume (\S+)/.exec(first.out) || [])[1];
    assert.ok(id, 'the session must still offer a resume token');
    const r = await runCli([], { cwd, configDir, stdin: `/resume ${id}\n/exit\n`, script: [], timeoutMs: 30000 });
    const out = plain(r.out);
    assertIncludes(out, 'RESUMING SESSION');
    assertIncludes(out, 'objective: fix the dropped errors');
  });

  await test('RESUME: a name that matches nothing says so and resumes nothing', async () => {
    const { cwd, configDir } = withCatalog();
    await seed(configDir, cwd, 'the dashboard stopped updating');
    const r = await runCli([], { cwd, configDir, stdin: '/resume kangaroo\n/exit\n', script: [], timeoutMs: 30000 });
    const out = plain(r.out);
    assertIncludes(out, 'No session matches');
    assertNotIncludes(out, 'RESUMING SESSION', 'a miss must never fall back to the most recent one');
  });

  await test('RESUME: the browser opens on a TTY, and D really opens the details', async () => {
    const { cwd, configDir } = withCatalog();
    await seed(configDir, cwd, 'the dashboard stopped updating');
    const r = await runCli([], {
      cwd, configDir, env: tui(),
      stdinSteps: ['/resume\n', 'd', '\x1b', '\x1b', '/exit\n'],
      stepDelayMs: 700,
      script: [],
      timeoutMs: 40000,
    });
    const all = frames(r.out);
    assert.ok(all.some((f) => /RESUME SESSION/.test(f)), 'the browser opened');
    const details = all.find((f) => /SESSION DETAILS/.test(f));
    assert.ok(details, `D must open the details:\n${(all.pop() || '').slice(0, 500)}`);
    assert.match(details, /ORIGINAL TASK/);
    assert.match(details, /the dashboard stopped updating/);
    assert.strictEqual(r.code, 0);
  });

  await test('RESUME: an EXTERNAL review survives being resumed', async () => {
    // It used to live on the UI object, so a resumed session came back with its
    // transcript and its changed files while the reviewer that produced half of
    // them was simply gone.
    const { cwd, configDir } = withCatalog();
    const first = await seed(configDir, cwd, 'the writer is stale');
    const id = (/--resume (\S+)/.exec(first.out) || [])[1];
    assert.ok(id);
    // Write a review into the saved session exactly as the relay would.
    const file = path.join(configDir, 'sessions', `${require('../../src/session').Session.match ? id : id}.json`);
    const dir = path.join(configDir, 'sessions');
    const real = fs.readdirSync(dir).find((n) => n.includes(id));
    assert.ok(real, `the session file must exist in ${dir}: ${fs.readdirSync(dir).join(', ')}`);
    const p = path.join(dir, real);
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    data.actors = [{ kind: 'external', text: 'FACT: status.json has not changed since Aug 14.', afterTurns: 1 }];
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');

    const r = await runCli([], {
      cwd, configDir, env: tui(),
      stdinSteps: [`/resume ${id}\n`, '/exit\n'],
      stepDelayMs: 900,
      script: [],
      timeoutMs: 40000,
    });
    const all = frames(r.out).join('\n');
    assert.match(all, /EXTERNAL/, 'the reviewer must be back on screen, under its own label');
    assert.match(all, /status\.json has not changed since Aug 14/, 'and so must what it said');
    assert.ok(file, 'path computed');
  });
};
