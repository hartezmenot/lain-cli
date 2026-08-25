'use strict';

/**
 * COPY / PASTE, through the real binary.
 *
 * A paste is the one input a terminal tells us about STRUCTURALLY: bracketed
 * paste mode wraps it in `ESC[200~ … ESC[201~`, so LAIN never has to guess.
 * Everything here follows from taking that seriously — the bytes between the
 * markers are CONTENT, whatever they happen to spell.
 *
 * The failure this prevents is the worst kind: a user pastes a prompt that
 * mentions `/exit` or "continue from step 4", and LAIN executes it. That is
 * data loss and a wrecked session from an action the user never took.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes } = require('../helpers');

const START = '\x1b[200~';
const END = '\x1b[201~';
const paste = (text) => START + text + END + '\n';

/** The mock answers once, so a turn happens and we can see what it received. */
const script = [{ text: 'Understood.' }];

/** What the model was actually sent, read from the persisted session. */
function userMessages(configDir) {
  const dir = path.join(configDir, 'sessions');
  const files = fs.readdirSync(dir).map((f) => path.join(dir, f));
  const newest = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const s = JSON.parse(fs.readFileSync(newest, 'utf8'));
  return (s.messages || []).filter((m) => m.role === 'user' && !m._liveness).map((m) => m.content);
}

module.exports = async function () {
  await test('PASTE: a multi-line paste is ONE input, byte-for-byte', async () => {
    const cwd = tmpdir('paste-');
    const configDir = path.join(cwd, '.config');
    const body = 'function hi() {\n  return 1;\n}\n\nconst x = 2;';
    const r = await runCli([], { cwd, configDir, stdin: paste(body), script });
    assert.strictEqual(r.code, 0);
    const msgs = userMessages(configDir);
    assert.strictEqual(msgs.length, 1, `expected one input, got ${msgs.length}: ${JSON.stringify(msgs)}`);
    assert.strictEqual(msgs[0], body, 'the pasted bytes must arrive unaltered');
  });

  await test('PASTE: slash commands INSIDE a paste are content, never executed', async () => {
    const cwd = tmpdir('paste-');
    const configDir = path.join(cwd, '.config');
    // The exact shape from the design.
    const body = 'Continue from step 4.\nThen run /models.\nFinally say done.\n/exit';
    const r = await runCli([], { cwd, configDir, stdin: paste(body), script });
    assert.strictEqual(r.code, 0);

    const msgs = userMessages(configDir);
    assert.strictEqual(msgs.length, 1, 'one paste is one input');
    assert.strictEqual(msgs[0], body, 'including the lines that look like commands');

    // /models would print a model list or a "no models" notice; /exit would end
    // the session before the model ever answered.
    const out = String(r.out);
    assertNotIncludes(out, 'Canonical model list', '/models must not have run');
    assertIncludes(out, 'Understood.', 'the turn ran, so /exit did not pre-empt it');
  });

  await test('PASTE: control words inside a paste do not become a continuation', async () => {
    const cwd = tmpdir('paste-');
    const configDir = path.join(cwd, '.config');
    const body = 'continue\nresume\ndone\nstep 4\nplan';
    const r = await runCli([], { cwd, configDir, stdin: paste(body), script });
    const msgs = userMessages(configDir);
    assert.strictEqual(msgs[0], body, 'every one of these is content when pasted');
  });

  await test('PASTE: a paste never mutates the plan or the objective', async () => {
    const cwd = tmpdir('paste-');
    const configDir = path.join(cwd, '.config');
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'build the parser\n/plan step design it\n' + paste('plan\nstep 4\nclear') + '/plan\n',
      script: [{ text: 'ok' }, { text: 'ok' }],
    });
    const out = String(r.out);
    assertIncludes(out, 'design it', 'the plan step survived the paste');
  });

  await test('PASTE: text typed BEFORE a paste is not lost', async () => {
    const cwd = tmpdir('paste-');
    const configDir = path.join(cwd, '.config');
    // A user types a lead-in, then pastes the payload, then sends.
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'here is the trace: ' + START + 'Error: ENOENT\n  at readFileSync' + END + '\n',
      script,
    });
    const msgs = userMessages(configDir);
    assert.strictEqual(msgs.length, 1);
    assertIncludes(msgs[0], 'here is the trace:', 'the typed lead-in must survive');
    assertIncludes(msgs[0], 'Error: ENOENT', 'and so must the pasted payload');
  });

  await test('PASTE: a large paste stays one input and is not truncated', async () => {
    const cwd = tmpdir('paste-');
    const configDir = path.join(cwd, '.config');
    const body = Array.from({ length: 300 }, (_, i) => `line ${i + 1} of the pasted log`).join('\n');
    const r = await runCli([], { cwd, configDir, stdin: paste(body), script, timeoutMs: 45000 });
    const msgs = userMessages(configDir);
    assert.strictEqual(msgs.length, 1, '300 lines is one paste, not 300 inputs');
    assert.strictEqual(msgs[0].split('\n').length, 300);
    assertIncludes(msgs[0], 'line 300 of the pasted log', 'nothing may be dropped off the end');
  });

  await test('PASTE: an `@` inside a paste does not open file completion', async () => {
    const cwd = tmpdir('paste-');
    const configDir = path.join(cwd, '.config');
    const body = 'see @src/auth.js and email me@example.com';
    const r = await runCli([], {
      cwd, configDir, env: { LAIN_FORCE_TUI: '1', COLUMNS: '90', LINES: '26' },
      stdin: paste(body), script,
    });
    // A completion menu is driven by TYPING; a paste is not typed.
    assertNotIncludes(String(r.out).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), '┌─ FILES',
      'a pasted @ must not open the file picker');
  });

  await test('PASTE: a single-line paste is still content, not a command', async () => {
    const cwd = tmpdir('paste-');
    const configDir = path.join(cwd, '.config');
    const r = await runCli([], { cwd, configDir, stdin: paste('/models'), script });
    const msgs = userMessages(configDir);
    assert.strictEqual(msgs[0], '/models', 'a one-line paste of a command name is text');
    assertNotIncludes(String(r.out), 'Canonical model list', 'and it must not run');
  });

  await test('PASTE: pasting while a task runs adds content without disturbing it', async () => {
    const cwd = tmpdir('paste-');
    const configDir = path.join(cwd, '.config');
    const r = await runCli([], {
      cwd, configDir,
      stdinSteps: ['do the thing\n', paste('extra context\n/exit\ncontinue')],
      stepDelayMs: 700,
      script: [
        { text: 'working', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 3' } }] },
        { text: 'done' }, { text: 'ok' },
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const msgs = userMessages(configDir);
    assertIncludes(msgs.join('\n'), 'extra context', 'the paste was received');
    assertNotIncludes(String(r.out), 'Canonical model list');
  });
};
