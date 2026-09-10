'use strict';

/**
 * PERMANENT ADVERSARIAL PRODUCTION SMOKE HARNESS.
 *
 * Every case spawns the real CLI entry point as a child process. This file may
 * not require() a single application module.
 *
 * NOTE ON THE ENTRY POINT: the audit brief names `bin/dotcli.js`. That is V1's
 * binary. V2's entry point is `bin/lain.js` (declared in package.json `bin`), and
 * that is what `runCli` spawns. The intent — drive the REAL binary, never a
 * module — is honoured exactly.
 *
 * The numbering follows the 25 required checks in the design.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli, assertIncludes, assertNotIncludes } = require('../helpers');

const CONFIG = {
  connections: {
    anthropic: { provider: 'anthropic', via: 'native', auth: 'api_key', envKey: 'DEMO_KEY', models: ['claude-opus-5', 'claude-sonnet-5'] },
    omniroute: { provider: 'anthropic', via: 'bridge', baseUrl: 'http://localhost:20128/v1', models: ['claude-opus-5-low', 'claude-opus-5-medium', 'claude-opus-5-high', 'gemini-3.5-flash', 'kimi-k3'] },
    ninerouter: { provider: 'bridge9', via: 'bridge', baseUrl: 'http://127.0.0.1:9/v1', models: ['claude-opus-5-low', 'claude-opus-5-high', 'gpt-5.5-low', 'gpt-5.5-medium', 'gpt-5.5-extra-high', 'qwen-max'] },
  },
};

function ws() {
  const cwd = tmpdir('lain-prod-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2), 'utf8');
  return { cwd, configDir };
}

// AN OUTAGE THAT NEVER LIFTS. Three refusals exhausted the retry budget when
// it was 2; it is 5 now (, so a gateway having a bad thirty seconds is ridden
// out) and three would simply be retried through — the new behaviour working,
// not these tests failing. What they are about is a provider that never comes
// back, so it never comes back.
const DEAD = { error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:20128' } };
const OUTAGE = Array.from({ length: 8 }, () => DEAD);

module.exports = async function () {
  // 1-7: process starts, prompt appears, input works, tool call + result, turn
  // completes, prompt returns.
  await test('PROD 1-7: start -> prompt -> input -> tool call -> result -> turn end -> prompt returns', async () => {
    const { cwd, configDir } = ws();
    fs.writeFileSync(path.join(cwd, 'seed.txt'), 'SEED_CONTENT\n');
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'read the seed file\nnow say bye\n/exit\n',
      script: [
        { text: 'Reading.', tool_calls: [{ name: 'read_file', input: { path: 'seed.txt' } }] },
        { text: 'It says SEED.' },
        { text: 'Bye.' },
      ],
    });
    assert.strictEqual(r.code, 0, 'process exited cleanly');
    assertIncludes(r.stdout, 'LAIN v2', 'banner/prompt appeared');
    assertIncludes(r.stdout, 'read_file', 'tool call surfaced');
    assertIncludes(r.stdout, 'SEED_CONTENT', 'tool RESULT returned');
    assertIncludes(r.stdout, 'It says SEED.', 'turn completed');
    assertIncludes(r.stdout, 'Bye.', 'prompt returned and accepted more input');
  });

  await test('PROD 8: /status works', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], { cwd, configDir, stdin: '/status\n/exit\n', script: [] });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'Status');
    assertIncludes(r.stdout, 'session');
  });

  await test('PROD 9: /models works and collapses effort variants', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], { cwd, configDir, stdin: '/models\n/exit\n', script: [] });
    assertIncludes(r.stdout, '6 model(s)');
    assertNotIncludes(r.stdout, 'claude-opus-5-low');
  });

  await test('PROD 10: /effort works', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], { cwd, configDir, stdin: '/model claude-opus-5 omniroute\n/effort medium\n/effort\n/exit\n', script: [] });
    assertIncludes(r.stdout, 'effort medium');
    assertIncludes(r.stdout, 'available here: low, medium, high');
  });

  await test('PROD 11: /provider status works', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], { cwd, configDir, stdin: '/provider status\n/exit\n', script: [] });
    assertIncludes(r.stdout, 'Connections');
    assertIncludes(r.stdout, 'omniroute');
  });

  await test('PROD 12-13: /provider maintenance then /provider retry, no request sent', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/provider maintenance omniroute\n/provider status\n/provider retry omniroute\n/exit\n',
      script: [],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'omniroute → MAINTENANCE');
    assertIncludes(r.stdout, 'omniroute → UNKNOWN');
    assert.strictEqual((r.stdout.match(/no request was sent/g) || []).length, 2);
  });

  await test('PROD 14: /oauth does not fake OAuth', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], { cwd, configDir, stdin: '/oauth anthropic\n/exit\n', script: [] });
    assertIncludes(r.stdout, 'OAUTH NOT AVAILABLE FOR THIS PROVIDER');
    assertIncludes(r.stdout, 'not faked');
    assertNotIncludes(r.stdout, 'Logged in');
  });

  // 15-17 + section 4: the full session isolation scenario.
  await test('PROD: session A plans; session B starts EMPTY; /resume restores A', async () => {
    const { cwd, configDir } = ws();

    // SESSION A: create a plan, make progress, stop.
    const a = await runCli([], {
      cwd, configDir,
      stdin: 'rebuild the adaptive trading architecture\n/plan step design the router\n/plan step wire it up\n/plan done designed it\n/plan\n/exit\n',
      script: [{ text: 'Understood, starting on the trading architecture.' }],
    });
    assert.strictEqual(a.code, 0);
    const idA = (a.stdout.match(/session ([0-9]{8}-[0-9]{6}-[a-z0-9]{4})/) || [])[1];
    assert.ok(idA, 'session A id');
    assertIncludes(a.stdout, '1/2 done');

    // SESSION B: brand new, same cwd, same config home.
    const b = await runCli([], {
      cwd, configDir,
      stdin: 'hello\n/plan\n/task\n/exit\n',
      script: [{ text: 'Hello.' }],
    });
    assert.strictEqual(b.code, 0);
    assertIncludes(b.stdout, 'No plan.', 'a new session has NO plan');
    assertNotIncludes(b.stdout, 'trading architecture', 'no objective leaked');
    assertNotIncludes(b.stdout, 'design the router', 'no steps leaked');
    assertNotIncludes(b.stdout, 'set aside', 'no prior-plan prompt');
    assertNotIncludes(b.stdout, 'restore previous', 'no restore offer');

    // SESSION C: explicit resume of A restores task + plan + completed steps.
    const c = await runCli(['--resume', idA], {
      cwd, configDir,
      stdin: '/plan\n/task\n/exit\n',
      script: [],
    });
    assert.strictEqual(c.code, 0);
    assertIncludes(c.stdout, 'design the router', 'plan restored');
    assertIncludes(c.stdout, 'designed it', 'completed step note restored');
    assertIncludes(c.stdout, '1/2 done', 'completed steps preserved');
    assertIncludes(c.stdout, 'trading architecture', 'task objective restored');
  });

  // 18-20: paste
  await test('PROD 18: 40-line paste is ONE input', async () => {
    const { cwd, configDir } = ws();
    const paste = ['continue;'].concat(Array.from({ length: 39 }, (_, i) => `  line_${i}();`)).join('\n');
    const r = await runCli([], {
      cwd, configDir,
      stdin: `\x1b[200~${paste}\x1b[201~\n/exit\n`,
      script: [{ text: 'ONE_TURN_RAN' }],
      timeoutMs: 45000,
    });
    assert.strictEqual((r.stdout.match(/ONE_TURN_RAN/g) || []).length, 1);
  });

  await test('PROD 19: 100-line paste is ONE input', async () => {
    const { cwd, configDir } = ws();
    const paste = Array.from({ length: 100 }, (_, i) => `row ${i} plan done step fix`).join('\n');
    const r = await runCli([], {
      cwd, configDir,
      stdin: `\x1b[200~${paste}\x1b[201~\n/exit\n`,
      script: [{ text: 'ONE_TURN_RAN' }],
      timeoutMs: 45000,
    });
    assert.strictEqual((r.stdout.match(/ONE_TURN_RAN/g) || []).length, 1);
  });

  await test('PROD 20: pastes beginning with each control word stay CONTENT', async () => {
    // continue / resume / keep / fix / done / step / plan
    for (const word of ['continue', 'resume', 'keep going', 'fix', 'done', 'step 3', 'plan']) {
      const { cwd, configDir } = ws();
      const paste = `${word}\nsecond line of the paste\nthird line`;
      const r = await runCli([], {
        cwd, configDir,
        stdin: `\x1b[200~${paste}\x1b[201~\n/task\n/exit\n`,
        script: [{ text: 'TREATED_AS_CONTENT' }],
      });
      assert.strictEqual(r.code, 0, word);
      assertIncludes(r.stdout, 'TREATED_AS_CONTENT', `paste starting with "${word}" ran a turn`);
      // It became the task objective, i.e. content — not a control word.
      assertIncludes(r.stdout, 'objective', `paste starting with "${word}" became task content`);
    }
  });

  await test('PROD 20b: a paste during an ACTIVE task mutates neither the plan nor the objective', async () => {
    //: paste is content. It must not become a task transition or a plan
    // mutation just because a line contains a control word. The deliberate way
    // to change task is a session change, not a paste.
    const { cwd, configDir } = ws();
    const spec = ['continue', 'resume the old plan', 'done', 'step 4', 'plan: rewrite everything']
      .concat(Array.from({ length: 40 }, (_, i) => `spec line ${i}`)).join('\n');
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'build the CLI parser\n/plan step design the grammar\n'
        + `\x1b[200~${spec}\x1b[201~\n/plan\n/task\n/exit\n`,
      script: [{ text: 'Starting.' }, { text: 'Read the spec.' }],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    // The plan still has exactly the step we added; the paste added/dropped none.
    assertIncludes(r.stdout, 'design the grammar');
    assertIncludes(r.stdout, '0/1 done');
    // The objective is still the original task, not the pasted text.
    assertIncludes(r.stdout, 'build the CLI parser');
    // And the paste was NOT recorded as a steer.
    assertNotIncludes(r.stdout, 'steers');
  });

  await test('PROD 10b: /effort auto clears the pin; one command owns every level', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/model claude-opus-5 omniroute\n/effort high\n/effort auto\n/effort\n/exit\n',
      script: [],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'effort high');
    assertIncludes(r.stdout, 'effort auto');
    assertIncludes(r.stdout, 'the route decides');
    assertIncludes(r.stdout, 'available here: low, medium, high, auto');
  });

  await test('PROD 21: shell is unrestricted — pipes, redirects, chaining all run', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli(['-p', 'investigate'], {
      cwd, configDir,
      script: [
        { text: 'Piping.', tool_calls: [{ name: 'run_bash', input: { command: 'echo alpha && echo beta | tr a-z A-Z' } }] },
        { text: 'Writing via redirect.', tool_calls: [{ name: 'run_bash', input: { command: 'echo redirected > out.txt; cat out.txt' } }] },
        { text: 'Done investigating.' },
      ],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'alpha');
    assertIncludes(r.stdout, 'BETA', 'the pipe executed — no command rewriting');
    assertIncludes(r.stdout, 'redirected', 'redirection executed');
    assert.ok(fs.existsSync(path.join(cwd, 'out.txt')), 'the shell really wrote the file');
  });

  await test('PROD 22: provider outage does not kill the REPL', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'go\n/status\n/models\n/help\n/exit\n',
      script: OUTAGE,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assertNotIncludes(r.out, 'fatal:');
    assertIncludes(r.stdout, 'Status');
    assertIncludes(r.stdout, 'model(s)');
    assertIncludes(r.stdout, 'Commands');
  });

  await test('PROD 23: a dead provider does not hang the prompt indefinitely', async () => {
    const { cwd, configDir } = ws();
    const started = Date.now();
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'go\n/exit\n',
      script: OUTAGE,
      timeoutMs: 40000,
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(r.code, 0, 'exited on its own, not by harness kill');
    assert.ok(elapsed < 30000, `took ${elapsed}ms — the prompt must come back promptly`);
  });

  await test('PROD 23b: a provider that ACCEPTS and never replies does not hang the prompt', async () => {
    // The defect this test exists for: a socket that completes the TCP handshake
    // and then goes silent. `fetch` had no timeout, so the CLI hung indefinitely
    // (measured: 45s with no prompt back, killed externally). "Unreachable" fails
    // fast; "accepted and silent" did not, and that is the common shape of a
    // wedged local bridge.
    const net = require('net');
    const server = net.createServer((s) => { s.on('error', () => {}); });
    server.on('error', () => {});
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    try {
      const cwd = tmpdir('lain-hang-');
      const configDir = path.join(cwd, 'cfg');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
        model: 'hang-model', connection: 'blackhole',
        connections: { blackhole: { provider: 'hangprov', via: 'bridge', protocol: 'chat', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['hang-model'] } },
      }), 'utf8');

      // The BOUND is what this test is about, not its default value. The
      // default was raised to 120s because 30s was killing legitimate reasoning
      // models mid-think — so the deadline is set explicitly here, which keeps
      // the guarantee ("an accepted-and-silent socket is bounded, once, and the
      // REPL survives") while leaving the product free to choose a humane
      // default. Encoding the default would make every future change to it
      // look like a regression.
      const started = Date.now();
      const r = await runCli([], {
        cwd, configDir, stdin: 'go\n/status\n/exit\n',
        env: { LAIN_TTFB_TIMEOUT_MS: '4000' },
        timeoutMs: 120000,
      });
      const elapsed = Date.now() - started;

      assert.strictEqual(r.code, 0, 'the CLI exited on its own rather than being killed');
      assertIncludes(r.stdout, 'no response headers', 'the deadline fired');
      assertIncludes(r.stdout, 'The prompt is yours.');
      assertIncludes(r.stdout, 'Status', '/status ran after the hang — the REPL survived');
      // One attempt only: a server that never sent headers must not be retried,
      // or the wait is multiplied by the retry count.
      // ONE attempt: a server that never sent headers must not be retried, or
      // the wait is multiplied by the retry count. With a 4s deadline, anything
      // past ~15s means it tried again.
      assert.ok(elapsed < 20000, `took ${elapsed}ms — a silent socket must fail once, not retry`);
    } finally {
      server.close();
    }
  });

  await test('PROD 24: breaker escape hatch works after the breaker opens', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'go\ngo again\n/provider retry mock\nnow go\n/exit\n',
      script: [
        ...OUTAGE,
        { text: 'Back.', tool_calls: [{ name: 'write_file', input: { path: 'after.txt', content: 'ok' } }] },
        { text: 'Recovered.' },
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'No request was sent.', 'the breaker held on the 2nd attempt');
    assert.ok(fs.existsSync(path.join(cwd, 'after.txt')), 'work resumed after the explicit retry');
  });

  await test('PROD 25: /undo works', async () => {
    const { cwd, configDir } = ws();
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'BEFORE\n');
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'change it\n/changes\n/undo\n/exit\n',
      script: [
        { text: 'Editing.', tool_calls: [{ name: 'edit_file', input: { path: 'f.txt', old: 'BEFORE', new: 'AFTER' } }] },
        { text: 'Changed.' },
      ],
    });
    assert.strictEqual(r.code, 0);
    // `/changes` prints the diff and its grouping — see src/workcommands.js
    // on where the DIFF and FILES panes went.
    assertIncludes(r.stdout, 'MODIFIED');
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8'), 'BEFORE\n');
  });

  // ---- adversarial probes beyond the required 25 -------------------------

  await test('ADV: /undo after /resume must not undo the OTHER session\'s work', async () => {
    const { cwd, configDir } = ws();
    fs.writeFileSync(path.join(cwd, 'shared.txt'), 'ORIGINAL\n');
    const a = await runCli([], {
      cwd, configDir,
      stdin: 'edit it\n/exit\n',
      script: [
        { text: 'Reading it first.', tool_calls: [{ name: 'read_file', input: { path: 'shared.txt' } }] },
        { text: 'Editing.', tool_calls: [{ name: 'write_file', input: { path: 'shared.txt', content: 'FROM_A\n' } }] },
        { text: 'Done.' },
      ],
    });
    const idA = (a.stdout.match(/session ([0-9]{8}-[0-9]{6}-[a-z0-9]{4})/) || [])[1];
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'shared.txt'), 'utf8'), 'FROM_A\n');

    // Session B edits, then resumes A, then undoes. The undo must apply to
    // whatever B is now working on — never silently reach into A's history.
    const b = await runCli([], {
      cwd, configDir,
      stdin: `edit again\n/resume ${idA}\n/undo\n/exit\n`,
      script: [
        { text: 'Reading it first.', tool_calls: [{ name: 'read_file', input: { path: 'shared.txt' } }] },
        { text: 'Editing.', tool_calls: [{ name: 'write_file', input: { path: 'shared.txt', content: 'FROM_B\n' } }] },
        { text: 'Done.' },
      ],
    });
    assert.strictEqual(b.code, 0);
    // THE INVARIANT is that B's work survives, and it is asserted below on the
    // bytes themselves. The REASON changed, and this assertion was updated to
    // match rather than the code being bent back to satisfy it.
    //
    // Previously a resumed session simply had no checkpoints in memory, so
    // `/undo` shrugged — the right outcome reached by an accident of a
    // write-only snapshot store. Resuming now restores a session's OWN undo
    // history, which is what makes `/undo` work at all after a restart, so A's
    // snapshot really is present here. Undo refuses it because shared.txt no
    // longer holds what LAIN left there.
    //
    // That is a strictly stronger guarantee: it protects a concurrent change by
    // ANY writer — another session, an editor, a git checkout — instead of only
    // the case where the history happened to be empty.
    assertIncludes(b.out, 'changed after LAIN last wrote to it');
    const after = fs.readFileSync(path.join(cwd, 'shared.txt'), 'utf8');
    assert.strictEqual(after, 'FROM_B\n', 'undo after /resume must not revert another session\'s work');
  });

  await test('ADV: /new rebinds checkpoints — undo cannot cross a session boundary', async () => {
    const { cwd, configDir } = ws();
    fs.writeFileSync(path.join(cwd, 'x.txt'), 'ORIGINAL\n');
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'edit it\n/new\n/undo\n/exit\n',
      script: [
        { text: 'Reading it first.', tool_calls: [{ name: 'read_file', input: { path: 'x.txt' } }] },
        { text: 'Editing.', tool_calls: [{ name: 'write_file', input: { path: 'x.txt', content: 'EDITED\n' } }] },
        { text: 'Done.' },
      ],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, 'nothing to undo', 'a fresh session has no checkpoints to undo');
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'x.txt'), 'utf8'), 'EDITED\n',
      'the previous session\'s edit was NOT reverted by the new session');
  });

  await test('ADV: a targeted read must NOT create whole-file evidence', async () => {
    // A ranged read shows the model 10 lines. If that records evidence for the
    // WHOLE file, the next full read is substituted with "already inspected" —
    // which would be the ledger lying, and a prison.
    const { cwd, configDir } = ws();
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    fs.writeFileSync(path.join(cwd, 'big.js'), big);
    const r = await runCli(['-p', 'inspect'], {
      cwd, configDir,
      script: [
        { text: 'Ranged read.', tool_calls: [{ name: 'read_file', input: { path: 'big.js', offset: 1, limit: 10 } }] },
        { text: 'Now the whole file.', tool_calls: [{ name: 'read_file', input: { path: 'big.js' } }] },
        { text: 'Done.' },
      ],
    });
    assert.strictEqual(r.code, 0);
    // `[evidence]` is the substitution marker. The renderer truncates tool
    // output to 8 lines, so asserting on a late line would test the renderer,
    // not the ledger — the marker is the honest signal.
    assertNotIncludes(r.stdout, '[evidence]',
      'a 10-line ranged read must not suppress the subsequent full read');
    assertIncludes(r.stdout, '2 tool calls', 'both reads really executed');
  });

  await test('ADV: a repeated WHOLE-file read of an unchanged large file IS served from evidence', async () => {
    // The other half of the contract: the ledger must still do its job.
    const { cwd, configDir } = ws();
    fs.writeFileSync(path.join(cwd, 'big.js'), Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'));
    const whole = { name: 'read_file', input: { path: 'big.js' } };
    const r = await runCli(['-p', 'inspect'], {
      cwd, configDir,
      script: [
        { text: 'First.', tool_calls: [whole] },
        { text: 'Again.', tool_calls: [whole] },
        { text: 'Done.' },
      ],
    });
    assertIncludes(r.stdout, '[evidence]', 'an unchanged whole-file re-read is served from the ledger');
    // The terminal clips long tool output, so the escape hatch is asserted
    // against WHAT THE MODEL ACTUALLY RECEIVES: the persisted conversation.
    const sessDir = path.join(r.configDir, 'sessions');
    const file = fs.readdirSync(sessDir).find((f) => f.endsWith('.json'));
    const session = JSON.parse(fs.readFileSync(path.join(sessDir, file), 'utf8'));
    const toolMsgs = session.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
    assertIncludes(toolMsgs, 'ranged reads are always served',
      'the model is told the escape hatch, in its own context');
    assertNotIncludes(toolMsgs, 'forbidden', 'the ledger never phrases itself as a prohibition');
  });

  await test('ADV: liveness notices ALTERNATING repeats (A B A B A), not just consecutive', async () => {
    const { cwd, configDir } = ws();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'AAA\n');
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'BBB\n');
    const readA = { name: 'read_file', input: { path: 'a.txt' } };
    const readB = { name: 'read_file', input: { path: 'b.txt' } };
    const r = await runCli(['-p', 'investigate'], {
      cwd, configDir,
      script: [
        { text: 'A', tool_calls: [readA] },
        { text: 'B', tool_calls: [readB] },
        { text: 'A', tool_calls: [readA] },
        { text: 'B', tool_calls: [readB] },
        { text: 'A', tool_calls: [readA] },
        { text: 'Still looking.' },
      ],
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.stdout, '[looping]', 'alternating repetition was noticed');
    // AND IT IS SAID TO THE PERSON. `-p` has no panel to raise, so the
    // observation prints once; what it must NOT do is address the model. The
    // old text ("Something different is needed", "nothing here is mandatory")
    // went into the conversation as a `role: 'user'` message, which is LAIN
    // writing in the user's voice — the whole reason this changed.
    assertNotIncludes(r.stdout, 'nothing here is mandatory', 'the model is not lectured');
    assertNotIncludes(r.stdout, 'Something different is needed', 'and not instructed');
    const sessDir = path.join(r.configDir, 'sessions');
    const file = fs.readdirSync(sessDir).find((f) => f.endsWith('.json'));
    const session = JSON.parse(fs.readFileSync(path.join(sessDir, file), 'utf8'));
    const said = session.messages.filter((m) => m.role === 'user').map((m) => String(m.content));
    assert.deepStrictEqual(said, ['investigate'],
      `LAIN put words in the user's mouth: ${JSON.stringify(said)}`);
  });

  await test('ADV: liveness never blocks a tool the model chooses next', async () => {
    const { cwd, configDir } = ws();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'AAA\n');
    const readA = { name: 'read_file', input: { path: 'a.txt' } };
    const r = await runCli(['-p', 'investigate'], {
      cwd, configDir,
      script: [
        { text: 'A', tool_calls: [readA] },
        { text: 'A', tool_calls: [readA] },
        { text: 'A', tool_calls: [readA] },
        // After the advisory the model picks a DIFFERENT tool — it must run.
        { text: 'Switching.', tool_calls: [{ name: 'run_bash', input: { command: 'echo ESCAPED_THE_LADDER' } }] },
        { text: 'Done.' },
      ],
    });
    assertIncludes(r.stdout, 'ESCAPED_THE_LADDER', 'the model was free to change strategy');
  });

  await test('ADV: with a provider in maintenance, every command surface stays usable', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/provider maintenance omniroute\n/status\n/models\n/provider status\n/oauth anthropic\n/effort\n/help\n/plan\n/task\n/tools\n/changes\n/sessions\n/exit\n',
      script: [],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assertNotIncludes(r.out, 'fatal:');
    assertNotIncludes(r.out, 'internal error');
    for (const marker of ['Status', 'model(s)', 'Connections', 'OAUTH NOT AVAILABLE', 'effort:', 'Commands', 'No plan', 'No active task', 'run_bash']) {
      assertIncludes(r.stdout, marker);
    }
  });

  await test('ADV: /efforts does not exist anywhere in the command surface', async () => {
    const r = await runCli([], { stdin: '/help\n/exit\n', script: [] });
    assertNotIncludes(r.stdout, '/efforts');
  });
};
