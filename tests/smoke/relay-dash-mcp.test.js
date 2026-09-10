'use strict';

/**
 * THE RELAY, THE DASHBOARD AND THE DESKTOP SEAM — through the real binary.
 *
 * A unit test proves a function returns the right thing; only this proves the
 * thing reaches a user. Everything here spawns bin/lain.js and asserts on what
 * a person would have read, or talks to the dashboard over real HTTP.
 *
 * LIMITATION, STATED: the model is the scripted mock provider, so both LAIN's
 * own model and the external reviewer are that double. The PATH is real — the
 * binary, the config, the provider resolution, the relay, the packet, the
 * rounds, the exit reason — but no real second model was consulted here.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const BRIDGE = path.join(__dirname, '..', 'fixtures', 'stub-bridge.js');

/** A Python project with a real, findable defect and a config we control. */
function probot(cfg = {}) {
  const cwd = tmpdir('probot-');
  fs.mkdirSync(path.join(cwd, 'probot'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'requirements.txt'), 'flask\n');
  fs.writeFileSync(path.join(cwd, 'probot', 'dashboard.py'),
    'def refresh():\n    try:\n        pull()\n    except Exception:\n        pass\n\n'
    + 'def render():\n    try:\n        draw()\n    except: pass\n');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(cfg, null, 2));
  return { cwd, configDir };
}

const REVIEW_1 = {
  text: 'FACT\n  Two handlers in probot/dashboard.py discard the exception.\n'
    + 'EVIDENCE\n  The local scan found 2 markers, both in probot/dashboard.py.\n'
    + 'HYPOTHESIS\n  Not established: they may be hiding a startup failure.\n'
    + 'RECOMMENDATION\n  Log the exception in refresh(), then run the module.',
};
const REVIEW_2 = {
  text: 'FACT\n  A command ran after the change.\n'
    + 'EVIDENCE\n  The command exited 0.\n'
    + 'HYPOTHESIS\n  The bare handlers were the cause.\n'
    + 'RECOMMENDATION\n  Add a regression test for the log line.',
};

function get(port, p, headers = {}) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    }).on('error', (e) => resolve({ code: 0, body: e.message }));
  });
}

module.exports = async function () {
  // ---------------------------------------------------------------- relay ---

  // ---- THE RELAY IS ORPHANED, AND THAT IS THE FINDING --------------------
  //
  // These three tests drove `/troubleshoot` — removed from the command surface
  // by the 2026-09 UX subtraction pass — and asserted the bounded external
  // review it started: rounds, FACT/RECOMMENDATION, a NAMED exit, and the
  // NOT CONFIGURED path when no reviewer exists.
  //
  // `investigation.relay` is called from exactly one place, `troubleshoot.js`
  // `runCommand`, and NO registered command reaches that any more. The relay is
  // therefore unreachable from the CLI: the machinery is intact and nothing can
  // start it. Rewording these tests to pass would hide that, and deleting them
  // would erase the only record of what the code can still do — so what is
  // asserted here is the REACHABILITY fact itself, in the tier that can see it.
  //
  // This is reported as a known limitation rather than repaired, because the
  // repair is a product decision: either give the relay a door (a command, or a
  // model-facing tool) or retire it with its module. Both are larger than a
  // test fix, and neither is this pass's to make silently.

  await test('RELAY: the external-review relay has no entry point from the CLI', () => {
    // Structural, not behavioural — there is nothing to drive. Proven the way
    // the reachability guard proves anything: by reading who calls it.
    const fsx = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', '..', 'src');
    const callers = fsx.readdirSync(root)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /require\(['\"]\.\/investigation['\"]\)/.test(fsx.readFileSync(path.join(root, f), 'utf8')));
    assert.deepStrictEqual(callers, ['troubleshoot.js'],
      'if this changed, the relay gained or lost a caller — update the limitation');
    // And the only thing that calls INTO troubleshoot.runCommand was the
    // command that no longer exists.
    const { REGISTRY } = require('../../src/commands');
    assert.ok(!REGISTRY.has('/troubleshoot'), '/troubleshoot is not a command');
  });

  await test('RELAY: the reviewer setting still reads and writes, with no relay to run', async () => {
    // `/external` is a live command and is what a person would use to point at
    // a reviewer. It must keep working — the setting is not what broke.
    const { cwd, configDir } = probot({});
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/external\n/exit\n',
      script: [{ text: 'unused' }],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assert.strictEqual(r.code, 0);
    assertIncludes(out, 'External actor');
    assertIncludes(out, 'NOT CONFIGURED');
  });

  await test('EXTERNAL: /external shows, sets and disables the reviewer', async () => {
    // A real catalog, because choosing a reviewer is choosing from the SAME
    // model list everything else uses — an empty catalog has nothing to pick.
    const { cwd, configDir } = probot({
      connections: { omniroute: { provider: 'anthropic', via: 'bridge', baseUrl: 'http://127.0.0.1:1/v1', models: ['claude-opus-5', 'kimi-k3'] } },
    });
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/external\n/external claude-opus-5\n/external\n/external rounds 2\n/external off\n/external\n/exit\n',
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'NOT CONFIGURED');
    assertIncludes(out, '✓ external reviewer:');
    assertIncludes(out, 'max rounds');
    assertIncludes(out, 'max rounds 2');
    assertIncludes(out, 'external reviewer off');
  });

  // ----------------------------------------------------------------- dash ---

  await test('DASH: the real binary serves a credential-protected dashboard, read-only', async () => {
    const { cwd, configDir } = probot({});
    // Driven with staged input so the server is up before it is polled.
    const r = await runCli([], {
      cwd, configDir,
      stdinSteps: ['/dash\n', '/dash status\n', '/exit\n'],
      stepDelayMs: 1200,
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'Remote Control');
    // THE URL AND THE CREDENTIAL ARE NOW TWO THINGS. This asserted a URL ending
    // `/?t=<token>` — which is to say it asserted that the link WAS the secret.
    // That is the shape being removed: a URL leaks through browser history, the
    // address bar, proxy logs and `Referer`, and sending yourself "the dashboard
    // link" sent the credential with it for good. The page asks for the token
    // instead, so the link is safe to pass around and the token is printed on
    // its own line for the person who can see this terminal.
    assert.match(out, /http:\/\/127\.0\.0\.1:\d+\//, 'a localhost URL');
    assert.ok(!/\?t=/.test(out), 'no credential may be in the URL');
    // THE STARTUP PASSWORD, ON ITS OWN ROW under a `password` label. It used to
    // read `key <32 hex>` on one line — the last place the old token vocabulary
    // survived. See repl.js on why the value gets a row of its own.
    assert.match(out, /\bpassword[ \t]*\r?\n?[ \t]*[a-f0-9]{32}/,
      'and the startup password is printed separately');
    assertIncludes(out, 'read-only');
    assert.ok(!/0\.0\.0\.0/.test(out), 'the default must not bind every interface');
    assert.strictEqual(r.code, 0);
  });

  await test('DASH: it really answers over HTTP, and really stops with the session', async () => {
    const { cwd, configDir } = probot({});
    const { spawn } = require('child_process');
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('LAIN_')) delete env[k];
    Object.assign(env, { LAIN_CONFIG_DIR: configDir, LAIN_HOME: path.join(configDir, 'supervisor-home'), LAIN_NO_COLOR: '1', NO_COLOR: '1', LAIN_PROVIDER: 'mock', LAIN_SUPERVISOR_BIN: process.env.LAIN_SUPERVISOR_BIN || '', LAIN_SUPERVISOR_LEASE_PORT: process.env.LAIN_SUPERVISOR_LEASE_PORT || '' });
    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'lain.js')], { cwd, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    try {
      await wait(1200);
      child.stdin.write('/dash\n');
      await wait(1500);
      // THE URL AND THE PASSWORD ARE PRINTED SEPARATELY NOW — see the test
      // above for why the link stopped being the credential.
      //
      // ONE PATTERN FOR BOTH SURFACES. `/dash` prints the label and the value
      // on one row; the autostart line in repl.js splits them across two,
      // because that runs before the UI exists and has to fit 40 columns. What
      // is asserted is the LABEL followed by the value — not the layout.
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      assert.ok(m, `no dashboard URL was printed:\n${out.slice(-400)}`);
      const tm = /\bpassword[ \t]*\r?\n?[ \t]*([a-f0-9]{32})/.exec(out);
      assert.ok(tm, `no startup password was printed:\n${out.slice(-400)}`);
      const port = Number(m[1]);
      const t = tm[1];
      assert.strictEqual((await get(port, '/api/state')).code, 401, 'no password, no answer');
      // THE HEADER FORM, which is how the page actually asks — this is the path
      // that has to work, and testing only the query form would leave it unproven.
      const state = await get(port, '/api/state', { 'x-lain-session': t });
      assert.strictEqual(state.code, 200);
      const s = JSON.parse(state.body);
      assert.ok(s.project.name, 'the state names the project');
      assert.strictEqual(s.control.actions, false, 'read-only until told otherwise');
      // THE SHELL LOADS FOR ANYONE — it must, in order to ask — and carries no
      // token and no project. Fetched with NO credential at all, deliberately.
      const page = await get(port, '/');
      assert.strictEqual(page.code, 200, 'the shell must load so it can ask for the password');
      assert.match(page.body, /LAIN/);
      assert.match(page.body, /id="gate"/, 'and it must be the gate that loads');
      assert.ok(!page.body.includes(t), 'THE TOKEN MUST NOT BE IN THE PAGE');
      assert.ok(!page.body.includes(s.project.name),
        'nor may an unauthenticated stranger learn which project this is');
      child.stdin.write('/exit\n');
      await wait(2500);
      const after = await get(port, '/api/state', { 'x-lain-session': t });
      assert.strictEqual(after.code, 0, 'the socket must not outlive the session');
    } finally {
      try { child.kill(); } catch { /* gone */ }
    }
  });

  // ------------------------------------------------------------------ mcp ---

  await test('DASH: autostart is ON by default, and OFF is respected', async () => {
    // THE DEFAULT CHANGED, DELIBERATELY. This asserted the opposite — that a
    // plain session starts no dashboard — on the reasoning that a CLI should
    // not open a listening socket for somebody who never asked.
    //
    // That reasoning holds up poorly against what is actually bound: an
    // OS-chosen port on 127.0.0.1, unreachable from the network, serving a page
    // that is a locked gate until a credential is proved. Weighed against
    // retyping `/dash` every session, the design is right that it should simply
    // be there. So the test now pins the new contract AND the way out of it,
    // because a default with no escape is not a default.
    const on = probot({});
    const a = await runCli([], { cwd: on.cwd, configDir: on.configDir, stdin: '/exit\n', script: [], timeoutMs: 30000 });
    assert.match(plain(a.out), /dashboard\s+http/, 'a plain session should bring the dashboard up');

    const off = probot({ dashAutostart: false });
    const b = await runCli([], { cwd: off.cwd, configDir: off.configDir, stdin: '/exit\n', script: [], timeoutMs: 30000 });
    assert.ok(!/dashboard\s+http/.test(plain(b.out)), 'and dashAutostart:false must still turn it off');
  });

  await test('DASH: with autostart ON, it is already serving before /dash is typed', async () => {
    // WHAT THIS PROVES, and it is the point of the feature: the URL is printed
    // and the port ANSWERS, without `/dash` ever being run. Asserting only the
    // printed line would prove a message, not a server.
    const { cwd, configDir } = probot({ dashAutostart: true });
    const { spawn } = require('child_process');
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('LAIN_')) delete env[k];
    Object.assign(env, { LAIN_CONFIG_DIR: configDir, LAIN_HOME: path.join(configDir, 'supervisor-home'), LAIN_NO_COLOR: '1', NO_COLOR: '1', LAIN_PROVIDER: 'mock', LAIN_SUPERVISOR_BIN: process.env.LAIN_SUPERVISOR_BIN || '', LAIN_SUPERVISOR_LEASE_PORT: process.env.LAIN_SUPERVISOR_LEASE_PORT || '' });
    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'lain.js')], { cwd, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    // ---- WAIT FOR THE LINE, NOT FOR A NUMBER OF MILLISECONDS -------------
    //
    // This slept 2000ms and then asserted, which is a race against process
    // startup — and it loses whenever the machine is busy, which inside a file
    // that has already spawned thirteen other binaries is often. A loss was
    // indistinguishable from the banner never being printed at all.
    const until = async (re, ms = 15000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = re.exec(plain(out));
        if (hit) return hit;
        if (Date.now() > deadline) return null;
        await wait(50);
      }
    };
    try {
      const m = await until(/dashboard\s+http:\/\/127\.0\.0\.1:(\d+)\//);
      assert.ok(m, `no dashboard was started by itself:\n${plain(out).slice(-400)}`);
      const tm = await until(/\bpassword[ \t]*\r?\n?[ \t]*([a-f0-9]{32})/);
      assert.ok(tm, `the startup password must be printed, since the URL no longer carries it:
${plain(out).slice(0, 400)}`);
      const port = Number(m[1]);
      // IT REALLY ANSWERS — and still refuses without the token.
      assert.strictEqual((await get(port, '/api/state')).code, 401, 'autostart must not mean unlocked');
      const ok = await get(port, '/api/state', { 'x-lain-session': tm[1] });
      assert.strictEqual(ok.code, 200, 'the autostarted server must actually serve');
      assert.strictEqual(JSON.parse(ok.body).control.actions, false, 'and be read-only, like any other');
    } finally {
      try { child.stdin.write('/exit\n'); } catch { /* already gone */ }
      await wait(800);
      try { child.kill(); } catch { /* gone */ }
    }
  });

  await test('MCP: unconfigured, /mcp says NOT CONFIGURED and starts nothing', async () => {
    const { cwd, configDir } = probot({});
    const r = await runCli([], { cwd, configDir, stdin: '/mcp\n/mcp connect\n/exit\n', script: [], timeoutMs: 30000 });
    const out = plain(r.out);
    assertIncludes(out, 'NOT CONFIGURED');
    assertIncludes(out, 'The bridge is a separate program you provide');
    assertIncludes(out, 'LAIN automates nothing itself');
  });

  await test('MCP: configured, it connects and grants NOTHING on its own', async () => {
    const { cwd, configDir } = probot({ mcp: { command: [process.execPath, BRIDGE] } });
    const r = await runCli([], {
      cwd, configDir,
      stdinSteps: ['/mcp connect\n', '/mcp\n', '/exit\n'],
      stepDelayMs: 1200,
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, '✓ CONNECTED');
    assertIncludes(out, 'stub-bridge');
    assertIncludes(out, 'nothing is permitted yet');
    // Every capability must read as NOT granted.
    for (const cap of ['Screen', 'Keyboard', 'Mouse', 'Window']) {
      assert.match(out, new RegExp(`${cap}\\s+— not granted`), `${cap} must not be granted by connecting`);
    }
  });

  await test('MCP: the model is offered the machine tool only when a bridge exists', async () => {
    // THE PROPERTY IS UNCHANGED; ONLY THE NAME IS. This asserted that a tool
    // called `desktop` appeared with a bridge and not without one. `desktop` was
    // a SECOND name for operations `computer` already performed — the duplicate
    // vocabulary the design forbids — so it was removed and its name is now checked for
    // by its absence. The gate it was testing is still the gate: nothing that
    // touches the screen, mouse or keyboard is put in front of the model until a
    // transport is actually connected, so the model cannot even try.
    const without = probot({});
    const a = await runCli([], { cwd: without.cwd, configDir: without.configDir, stdin: '/tools\n/exit\n', script: [], timeoutMs: 30000 });
    const noBridge = plain(a.out);
    assert.ok(!/\bcomputer\b/.test(noBridge), 'no bridge, no machine tool — the model cannot even try');
    assert.ok(!/\bdesktop\b/.test(noBridge), 'the retired second vocabulary must not come back');

    const with_ = probot({ mcp: { command: [process.execPath, BRIDGE] } });
    const b = await runCli([], { cwd: with_.cwd, configDir: with_.configDir, stdin: '/tools\n/exit\n', script: [], timeoutMs: 30000 });
    const bridged = plain(b.out);
    assertIncludes(bridged, 'computer', 'with a bridge configured it is offered');
    assert.ok(!/\bdesktop\b/.test(bridged), 'and a bridge must not introduce a name of its own');
    // ONE tool speaks for the machine, not two rows meaning the same thing.
    const rows = bridged.split('\n').filter((l) => /^\s*computer\s+\S/.test(l)).length;
    assert.strictEqual(rows, 1, 'exactly one tool speaks for the machine');
  });

  // ----------------------------------------------------------------- copy ---

  await test('COPY: every named section copies, or says why it cannot', async () => {
    const { cwd, configDir } = probot({});
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'summarise the dashboard\n'
        + '/copy last\n/copy activity\n/copy task\n/copy audit\n/copy health\n/copy rc\n/copy context\n/copy diff\n/copy troubleshoot\n/exit\n',
      script: [{ text: 'The dashboard swallows two exceptions.' }],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    for (const name of ['last', 'activity', 'task', 'audit', 'health', 'rc', 'context']) {
      assert.match(out, new RegExp(`copied ${name}|wrote \\d+ line\\(s\\)`), `/copy ${name} produced nothing`);
    }
    // The two with genuinely nothing in them must SAY so rather than copy air.
    assert.match(out, /diff: nothing to copy yet/);
    assert.match(out, /troubleshoot: nothing to copy yet/);
    assert.strictEqual(r.code, 0);
  });

  // ---------------------------------------------------------------- title ---

  await test('TITLE: the tab names the project, from the real binary', async () => {
    const dir = tmpdir('scalpbot-');
    const r = await runCli([], { cwd: dir, env: { LAIN_FORCE_TUI: '1', COLUMNS: '96', LINES: '30' }, stdin: '/exit\n', script: [] });
    const titles = [...r.out.matchAll(/\x1b\]0;([^\x07]*)\x07/g)].map((m) => m[1]).filter(Boolean);
    assert.ok(titles.length, 'the binary must emit the OSC sequence');
    const folder = path.basename(dir);
    assert.ok(titles.some((x) => x === folder),
      `expected the idle project title "${folder}", saw ${JSON.stringify(titles)}`);
  });

  // --------------------------------------------------------------- resume ---

  await test('RESUME: it restores conclusions, and says what was NOT there', async () => {
    const { cwd, configDir } = probot({});
    const first = await runCli([], {
      cwd, configDir,
      stdin: 'fix the dropped errors\n/exit\n',
      script: [{ text: 'Checking.', tool_calls: [{ name: 'run_bash', input: { command: 'echo checked' } }] }, { text: 'Done.' }],
      timeoutMs: 40000,
    });
    const id = (/--resume (\S+)/.exec(first.out) || [])[1];
    assert.ok(id, 'the session must offer a resume token');
    const second = await runCli([], { cwd, configDir, stdin: `/resume ${id}\n/exit\n`, script: [], timeoutMs: 30000 });
    const out = plain(second.out);
    assertIncludes(out, 'RESUMING SESSION');
    assertIncludes(out, 'objective: fix the dropped errors');
    assertIncludes(out, 'last check: echo checked');
    // What was never there must read as absent, not as restored.
    assertIncludes(out, 'no corrections recorded');
    assertIncludes(out, 'desktop permission: nothing granted');
  });
};
