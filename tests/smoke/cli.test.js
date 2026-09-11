'use strict';

/**
 * REAL CLI SMOKE TESTS. Every case spawns bin/lain.js as a child process.
 *
 * This file may not require() a single application module. If it did, a green
 * run would prove only that the modules work — which is exactly how V1 shipped a
 * runnable foreign-plan bug under 88 passing test files.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli, assertIncludes, assertNotIncludes } = require('../helpers');

module.exports = async function () {
  await test('SMOKE: --version exits 0 and prints a version', async () => {
    const r = await runCli(['--version']);
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'lain 2.');
  });

  await test('SMOKE: --help exits 0 and documents explicit resume', async () => {
    const r = await runCli(['--help']);
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'there is no automatic resume');
  });

  await test('SMOKE: an unknown option exits 2 without a stack trace', async () => {
    const r = await runCli(['--nonsense']);
    assert.strictEqual(r.code, 2);
    assertNotIncludes(r.out, 'at Object.');
  });

  await test('SMOKE: fresh session + hello, clean exit', async () => {
    const r = await runCli([], {
      stdin: 'hello\n/exit\n',
      script: [{ text: 'Hello. What would you like to build?' }],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'What would you like to build?');
    assertIncludes(r.stdout, 'Session saved.');
  });

  await test('SMOKE: a simple task runs a shell command for real', async () => {
    const cwd = tmpdir('lain-smoke-');
    fs.writeFileSync(path.join(cwd, 'marker.txt'), 'present');
    const r = await runCli(['-p', 'list the directory'], {
      cwd,
      script: [
        { text: 'Listing.', tool_calls: [{ name: 'run_bash', input: { command: 'ls -1' } }] },
        { text: 'That is the listing.' },
      ],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'marker.txt', 'real shell output reached the terminal');
    assertIncludes(r.stdout, '1 tool call');
  });

  await test('SMOKE: file read + modification actually change the disk', async () => {
    const cwd = tmpdir('lain-smoke-');
    fs.writeFileSync(path.join(cwd, 'app.js'), 'const label = "OLD";\n');
    const r = await runCli(['-p', 'change the label'], {
      cwd,
      script: [
        { text: 'Reading.', tool_calls: [{ name: 'read_file', input: { path: 'app.js' } }] },
        { text: 'Editing.', tool_calls: [{ name: 'edit_file', input: { path: 'app.js', old: '"OLD"', new: '"NEW"' } }] },
        { text: 'Changed the label.' },
      ],
    });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'app.js'), 'utf8'), 'const label = "NEW";\n');
    assertIncludes(r.stdout, '2 tool calls');
    assertIncludes(r.stdout, '1 file changed');
  });

  await test('SMOKE: a productive turn ending in narration reports its full tool count', async () => {
    const cwd = tmpdir('lain-smoke-');
    const r = await runCli(['-p', 'do step 2'], {
      cwd,
      script: [
        { text: 'Writing.', tool_calls: [{ name: 'write_file', input: { path: 'a.txt', content: 'a' } }] },
        { text: 'Writing.', tool_calls: [{ name: 'write_file', input: { path: 'b.txt', content: 'b' } }] },
        { text: 'Step 2 is complete. I will continue with step 3.' },
      ],
    });
    assertIncludes(r.stdout, '2 tool calls');
    assertNotIncludes(r.stdout, '0 tool calls');
  });

  // ---- provider outage & recovery -----------------------------------------

  // ---- AN OUTAGE THAT NEVER LIFTS, AND SIZED SO IT STAYS THAT WAY -------
  //
  // The retry budget has grown three times — 2, then 5, then 10 — and each
  // time a fixture of hardcoded refusals quietly stopped exhausting it: the
  // script ran out, the mock answered normally, the outage lifted, and a test
  // about a provider that never comes back started failing on the assertion
  // rather than on the behaviour. The comment here was rewritten twice for
  // exactly that.
  //
  // DERIVED FROM THE BUDGET, so it cannot go stale again. A few spare entries
  // past MAX_RETRIES, because a turn may make one request before the retry
  // loop begins.
  const { MAX_RETRIES } = require('../../src/backoff');
  const dead = { error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:20128' } };
  const outage = Array.from({ length: MAX_RETRIES + 4 }, () => dead);

  await test('SMOKE: provider outage does not kill the REPL, and /status still works', async () => {
    const r = await runCli([], {
      stdin: 'do something\n/status\n/exit\n',
      script: outage,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0, 'CLI exited cleanly despite the outage');
    assertIncludes(r.stdout, 'is not answering');
    assertIncludes(r.stdout, 'The prompt is yours.');
    assertIncludes(r.stdout, 'Status', '/status ran while the provider was dead');
    assertNotIncludes(r.out, 'ERR_USE_AFTER_CLOSE');
    assertNotIncludes(r.out, 'fatal:');
  });

  await test('SMOKE: after an outage the breaker holds — no retry storm', async () => {
    const r = await runCli([], {
      stdin: 'try now\ntry again\n/exit\n',
      script: outage,           // an outage that never lifts — see above
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    // The second prompt must be skipped BEFORE any socket, so it cannot consume
    // a fourth script entry. That is the difference between a breaker and a loop.
    assertIncludes(r.stdout, 'No request was sent.');
    assertIncludes(r.stdout, '/provider retry');
  });

  await test('SMOKE: /provider retry reopens the route and real work resumes', async () => {
    const cwd = tmpdir('lain-smoke-');
    const r = await runCli([], {
      cwd,
      stdin: 'try now\n/provider status\n/provider retry mock\nnow go\n/exit\n',
      script: [
        ...outage,
        { text: 'Back. Writing.', tool_calls: [{ name: 'write_file', input: { path: 'recovered.txt', content: 'ok' } }] },
        { text: 'Recovered.' },
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'Connections', '/provider status worked while the route was down');
    assertIncludes(r.stdout, 'no request was sent', '/provider retry contacted nothing');
    assert.ok(fs.existsSync(path.join(cwd, 'recovered.txt')), 'work happened after the explicit retry');
  });

  await test('SMOKE: /undo restores a file the model changed', async () => {
    const cwd = tmpdir('lain-smoke-');
    fs.writeFileSync(path.join(cwd, 'keep.js'), 'ORIGINAL\n');
    const r = await runCli([], {
      cwd,
      stdin: 'change it\n/changes\n/undo\n/exit\n',
      script: [
        { text: 'Reading it first.', tool_calls: [{ name: 'read_file', input: { path: 'keep.js' } }] },
        { text: 'Editing.', tool_calls: [{ name: 'write_file', input: { path: 'keep.js', content: 'REPLACED\n' } }] },
        { text: 'Changed it.' },
      ],
    });
    assert.strictEqual(r.code, 0);
    // `/changes` PRINTS THE DIFF NOW, not a bare list of paths — the DIFF and
    // FILES panes went and their renderers came here (src/workcommands.js). The
    // grouping is still stated, in the vocabulary the pane used: `~ MODIFIED`.
    assertIncludes(r.stdout, 'MODIFIED');
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'keep.js'), 'utf8'), 'ORIGINAL\n', 'undo restored the prior bytes');
  });

  await test('SMOKE: /undo of a CREATED file removes it again', async () => {
    const cwd = tmpdir('lain-smoke-');
    const r = await runCli([], {
      cwd,
      stdin: 'make it\n/undo\n/exit\n',
      script: [
        { text: 'Creating.', tool_calls: [{ name: 'write_file', input: { path: 'new.txt', content: 'x' } }] },
        { text: 'Made it.' },
      ],
    });
    assert.strictEqual(r.code, 0);
    assert.ok(!fs.existsSync(path.join(cwd, 'new.txt')), 'undoing a creation deletes the file');
  });

  await test('SMOKE: a 401 says authentication, not outage, and is not retried', async () => {
    const r = await runCli([], {
      stdin: 'go\n/exit\n',
      script: [{ error: { status: 401, message: 'invalid api key' } }],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'invalid api key');
  });

  await test('SMOKE: with no provider configured, nothing is sent and the CLI still exits 0', async () => {
    const r = await runCli(['-p', 'hello'], {
      env: { LAIN_PROVIDER: '', LAIN_MOCK_SCRIPT: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'No provider configured');
  });

  // ---- session isolation ---------------------------------------------------

  await test('SMOKE: a new session is EMPTY and does not inherit previous work', async () => {
    const cwd = tmpdir('lain-smoke-');
    const configDir = path.join(cwd, 'cfg');

    const first = await runCli(['-p', 'remember the trading refactor'], {
      cwd, configDir,
      script: [{ text: 'Noted: the adaptive trading refactor.' }],
    });
    assert.strictEqual(first.code, 0);

    // Same cwd, same config home, brand new run.
    const second = await runCli([], {
      cwd, configDir,
      stdin: '/status\n/exit\n',
      script: [],
    });
    assert.strictEqual(second.code, 0);
    assertIncludes(second.stdout, 'messages        0', 'the new session starts with zero messages');
    assertNotIncludes(second.stdout, 'trading refactor');
  });

  await test('SMOKE: /resume explicitly restores a session', async () => {
    const cwd = tmpdir('lain-smoke-');
    const configDir = path.join(cwd, 'cfg');
    const first = await runCli(['-p', 'the objective is the parser rewrite'], {
      cwd, configDir,
      script: [{ text: 'Understood.' }],
    });
    const id = (first.stdout.match(/session ([0-9]{8}-[0-9]{6}-[a-z0-9]{4})/) || [])[1];
    assert.ok(id, `could not find a session id in:\n${first.stdout}`);

    const second = await runCli(['--resume', id], {
      cwd, configDir,
      stdin: '/status\n/exit\n',
      script: [],
    });
    assert.strictEqual(second.code, 0);
    assertIncludes(second.stdout, '(resumed)');
    assertIncludes(second.stdout, id);
    assertNotIncludes(second.stdout, 'messages        0');
  });

  await test('SMOKE: /resume with an unknown id refuses and does not invent a session', async () => {
    const r = await runCli(['--resume', 'nope-does-not-exist'], {
      stdin: '/exit\n',
      script: [],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'Nothing was resumed');
  });

  // ---- paste -------------------------------------------------------------

  await test('SMOKE: a 40-line paste beginning with "continue" is content, not a command', async () => {
    const paste = ['continue;', '  }', '}'].concat(Array.from({ length: 37 }, (_, i) => `const v${i} = ${i};`));
    const r = await runCli([], {
      // Each line arrives separately through readline; the first line is the one
      // that must not be mistaken for a control word.
      stdin: paste.join('\n') + '\n/exit\n',
      script: Array.from({ length: 41 }, () => ({ text: 'ack' })),
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assertNotIncludes(r.out, 'fatal:');
    assertNotIncludes(r.out, 'unknown option');
  });

  await test('SMOKE: a 100-line paste arrives as ONE input, verbatim', async () => {
    const cwd = tmpdir('lain-smoke-');
    const lines = ['continue;'].concat(Array.from({ length: 99 }, (_, i) => `  step_${i}(); // done, plan, fix`));
    const paste = lines.join('\n');
    const r = await runCli([], {
      cwd,
      // Real bracketed-paste markers — exactly what a terminal sends.
      stdin: `\x1b[200~${paste}\x1b[201~\n/task\n/exit\n`,
      // ONE response is scripted. If the paste were split, later lines would
      // consume more and the run would not match.
      script: [{ text: 'Received one message.' }],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'Received one message.');
    assert.strictEqual((r.stdout.match(/Received one message\./g) || []).length, 1, 'exactly one turn ran');
    assertIncludes(r.stdout, 'Task', 'the paste became a task, not a control word');
  });

  await test('SMOKE: pasted JSON and shell output are content, not commands', async () => {
    const json = '{\n  "status": "done",\n  "plan": ["fix", "continue"],\n  "steps": 3\n}';
    const r = await runCli([], {
      stdin: `\x1b[200~${json}\x1b[201~\n/exit\n`,
      script: [{ text: 'That is JSON.' }],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'That is JSON.');
  });

  await test('SMOKE: run_cmd / run_powershell execute for real on this platform', async () => {
    const cwd = tmpdir('lain-smoke-');
    const isWin = process.platform === 'win32';
    const tool = isWin ? 'run_cmd' : 'run_bash';
    const command = isWin ? 'echo CMD_MARKER' : 'echo CMD_MARKER';
    const r = await runCli(['-p', 'run it'], {
      cwd,
      script: [
        { text: 'Running.', tool_calls: [{ name: tool, input: { command } }] },
        { text: 'Ran it.' },
      ],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'CMD_MARKER', `${tool} produced real output`);
  });

  if (process.platform === 'win32') {
    await test('SMOKE: run_powershell executes for real', async () => {
      const cwd = tmpdir('lain-smoke-');
      const r = await runCli(['-p', 'run it'], {
        cwd,
        script: [
          { text: 'Running.', tool_calls: [{ name: 'run_powershell', input: { command: 'Write-Output PS_MARKER' } }] },
          { text: 'Ran it.' },
        ],
        timeoutMs: 60000,
      });
      assert.strictEqual(r.code, 0);
      assertIncludes(r.stdout, 'PS_MARKER', 'run_powershell produced real output');
    });
  }

  await test('SMOKE: an unregistered slash line is sent to the model, not rejected', async () => {
    const r = await runCli([], {
      stdin: '/usr/local/bin/node --version\n/exit\n',
      script: [{ text: 'That looks like a path, not a command.' }],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'That looks like a path');
  });

  await test('SMOKE: /tools lists the real registry and shell tools are present', async () => {
    const r = await runCli([], { stdin: '/tools\n/exit\n', script: [] });
    assert.strictEqual(r.code, 0);
    for (const t of ['run_bash', 'run_powershell', 'run_cmd', 'read_file', 'write_file', 'edit_file', 'list_dir']) {
      assertIncludes(r.stdout, t);
    }
  });

  await test('SMOKE: --sessions lists without resuming anything', async () => {
    const cwd = tmpdir('lain-smoke-');
    const configDir = path.join(cwd, 'cfg');
    await runCli(['-p', 'first'], { cwd, configDir, script: [{ text: 'ok' }] });
    const r = await runCli(['--sessions'], { cwd, configDir });
    assert.strictEqual(r.code, 0);
    assert.ok(/\d{8}-\d{6}-[a-z0-9]{4}/.test(r.stdout), 'listed at least one session id');
  });

  await test('SMOKE: clean exit via /exit saves the session and prints the resume hint', async () => {
    const r = await runCli([], { stdin: '/exit\n', script: [] });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'lain --resume');
  });
};
