'use strict';

/**
 * CTRL+C IS GLOBAL — a panel does not get to hold it.
 *
 * Found by driving the real TUI: with the model picker open, Ctrl+C Ctrl+C did
 * nothing. The interrupt policy was right and the exit flag was being set — but
 * the REPL loop was parked inside `await ui.ask(...)`, and nothing resolved that
 * promise, so the flag was set where nobody was in a position to read it. The
 * only way out was Escape first.
 *
 * These drive the real binary from every panel depth, because "it works at the
 * top level" was already true when the bug was reported.
 */

const assert = require('assert');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const ETX = String.fromCharCode(3);
const ESC = '\x1b';
const DOWN = ESC + '[B';
const RIGHT = ESC + '[C';
const CR = '\r';
const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '28' };
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A config whose model has several routes, so a drill-down really exists. */
function withRoutes() {
  const cwd = tmpdir('pick-');
  const fs = require('fs');
  const path = require('path');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    model: 'claude-opus-5', connection: 'alpha',
    connections: {
      alpha: { provider: 'anthropic', via: 'bridge', protocol: 'chat', baseUrl: 'http://127.0.0.1:1/v1', models: ['claude-opus-5', 'claude-opus-5-low', 'claude-opus-5-high', 'kimi-k3'] },
      beta: { provider: 'openrouter', via: 'bridge', protocol: 'chat', baseUrl: 'http://127.0.0.1:2/v1', models: ['claude-opus-5'] },
    },
  }), 'utf8');
  return { cwd, configDir };
}

/** Two Ctrl+C presses from wherever `steps` leaves the interface. */
async function exitsFrom(steps, label) {
  const { cwd, configDir } = withRoutes();
  const r = await runCli([], {
    cwd, configDir, env: tui,
    stdinSteps: [...steps, ETX, ETX], stepDelayMs: 900,
    script: [], timeoutMs: 40000,
  });
  const out = plain(r.out);
  assert.strictEqual(r.code, 0, `${label}: LAIN did not exit — Ctrl+C was swallowed\n${out.slice(-700)}`);
  assertIncludes(out, 'Press Ctrl+C again to exit', `${label}: the first press must arm, not exit`);
  assertIncludes(out, 'Session saved', `${label}: the second press must exit cleanly`);
  assert.ok(!/Escape|Esc to/.test(out.split('Press Ctrl+C again')[1] || ''), `${label}: Escape must not be required`);
  return out;
}

module.exports = async function () {
  await test('EXIT: Ctrl+C twice leaves from the model list', async () => {
    await exitsFrom(['/models\n'], 'root list');
  });

  await test('EXIT: Ctrl+C twice leaves from a filtered search', async () => {
    await exitsFrom(['/models\n', 'opus'], 'filtered');
  });

  await test('EXIT: Ctrl+C twice leaves from the route choice', async () => {
    // claude-opus-5 is served by two connections, so Enter opens a real choice.
    await exitsFrom(['/models opus\n', CR], 'routes');
  });

  await test('EXIT: Ctrl+C twice leaves from the effort choice', async () => {
    await exitsFrom(['/models opus\n', RIGHT, CR], 'efforts');
  });

  await test('EXIT: Ctrl+C twice leaves from a NON-model panel too', async () => {
    await exitsFrom(['/provider\n'], 'provider panel');
  });

  await test('EXIT: Escape still closes a panel without changing the model', async () => {
    const { cwd, configDir } = withRoutes();
    // A bare `/models` — a query matching exactly one model is committed
    // outright, so there would be no panel to escape from.
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdinSteps: ['/models\n', DOWN, ESC, '/status\n', ETX, ETX], stepDelayMs: 900,
      script: [], timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'Unchanged', 'cancelling must say so, not leave the user guessing');
    assertIncludes(out, 'claude-opus-5', 'the active model must survive Escape');
  });

  await test('EXIT: an interrupt during real work still INTERRUPTS rather than exiting', async () => {
    // The two Ctrl+C behaviours must stay separate: cancel while working, exit
    // while idle.
    const r = await runCli([], {
      cwd: tmpdir('pick-'), env: tui,
      stdinSteps: ['audit it\n', ETX], stepDelayMs: 1200,
      script: [
        { text: 'Working.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 6' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'INTERRUPTED', 'a press during work must cancel the work');
    assert.ok(!/Press Ctrl\+C again to exit/.test(out), 'and must NOT arm the exit confirmation');
  });
};
