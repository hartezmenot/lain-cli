'use strict';

/**
 * EVERY COMMAND, ACTUALLY RUN.
 *
 * A registry entry is not a capability. V1 shipped two `case '/status'` branches
 * with the second unreachable, and a validator that would have caught it sitting
 * unused in the tree — so "it is in the list" has been demonstrably wrong before.
 *
 * This walks the REGISTRY ITSELF rather than a hand-written list, so a command
 * added later is audited whether or not anyone remembers to add it here.
 */

const assert = require('assert');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const commands = require('../../src/commands');
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Commands that end the session or need an argument to do anything. */
const LEAVES = new Set(['/exit', '/quit']);
/** Run with no argument: these must still respond, not throw or hang. */
const NO_ARG_SAFE = (name) => !LEAVES.has(name);

module.exports = async function () {
  await test('CMD: every command is described, and every name is well-formed', () => {
    const names = commands.names ? commands.names() : [...commands.REGISTRY.keys()];
    assert.ok(names.length >= 20, `only ${names.length} commands registered`);
    for (const n of names) {
      assert.match(n, /^\/[a-z][a-z0-9-]*$/, `${n} is not a usable command name`);
      const c = commands.REGISTRY.get(n);
      assert.ok(c.desc && c.desc.length > 8, `${n} has no usable description — it cannot be discovered`);
      assert.strictEqual(typeof c.run, 'function', `${n} is listed but not runnable`);
    }
  });

  await test('CMD: /help lists every registered command — nothing is hidden folklore', async () => {
    const r = await runCli([], { cwd: tmpdir('cmd-'), stdin: '/help\n', script: [] });
    const out = plain(r.out);
    for (const n of commands.REGISTRY.keys()) {
      assertIncludes(out, n, `${n} is registered but absent from /help`);
    }
  });

  await test('CMD: every command actually RUNS from a prompt, with no argument', async () => {
    // One process, every command, in order. A command that throws would kill the
    // REPL; a command that hangs would time the run out. Both are failures here.
    const names = [...commands.REGISTRY.keys()].filter(NO_ARG_SAFE);
    const stdin = names.map((n) => `${n}\n`).join('') + '/exit\n';
    const r = await runCli([], { cwd: tmpdir('cmd-'), stdin, script: [], timeoutMs: 120000 });
    assert.strictEqual(r.code, 0, `the REPL did not survive running every command:\n${r.out.slice(-1200)}`);
    const out = plain(r.out);
    assert.ok(!/TypeError|ReferenceError|is not a function|Cannot read/.test(out),
      `a command threw:\n${out.slice(-1500)}`);
  });

  await test('CMD: each command declares whether it is safe during a turn', () => {
    for (const [n, c] of commands.REGISTRY) {
      assert.ok(['safe', 'blocked'].includes(c.duringTurn), `${n} has no during-turn policy`);
    }
  });

  await test('CMD: the commands that rewrite the session are the ones blocked', () => {
    // Named explicitly, because getting this wrong in either direction is bad:
    // a blocked read-only command is an annoyance, an unblocked mutator is a
    // corrupted session.
    // /troubleshoot starts a turn of its own (it submits the problem forced into
    // TROUBLESHOOT mode), so it must be blocked while another turn owns the
    // session — the same reason /compact and /new are.
    // /backup copies or restores the whole working tree, so it is blocked for
    // the plainest reason on this list: restoring files under a turn that is
    // still editing them puts two writers on one tree.
    //
    // ---- /clear MOVED ONTO THIS LIST, and the move IS the fix -------------
    //
    // It used to be an alias of /clean, and this comment said both "change only
    // what is on screen". That was accurate, and it was also the bug: the
    // command people reach for when they are up against the context limit did
    // nothing whatever to the context. Measured on the wire, the request after
    // /clear carried MORE messages than the one before it.
    //
    // /clear now empties `session.messages` — the exact array a turn is
    // sending — so it belongs here beside /compact and /new for the identical
    // reason: rewriting the conversation under a live request is a corruption,
    // not a convenience. /clean is still absent, and still means the screen.
    // ---- /verify JOINED THIS LIST, and for a different reason from the rest --
    //
    // Everything else here is blocked because it REWRITES the session under a
    // live request. `/verify` is blocked because it EXECUTES: it spawns test
    // runners, build commands and browsers. Two suites racing over one build
    // directory manufacture failures that belong to neither, and a browser
    // launched beside a turn that is launching one fights it for the debug
    // port. Same conclusion, different argument, and worth stating so nobody
    // later "corrects" it to safe-during-a-turn on the grounds that it changes
    // no session state.
    //
    // /troubleshoot was deliberately removed; the registry describes the
    // current product, including the remaining verification command.
    const blocked = [...commands.REGISTRY.entries()].filter(([, c]) => c.duringTurn === 'blocked').map(([n]) => n).sort();
    assert.deepStrictEqual(blocked, ['/backup', '/clear', '/compact', '/cwd', '/exit', '/new', '/plan', '/quit', '/resume', '/undo', '/verify'].sort());
    assert.notStrictEqual(commands.REGISTRY.get('/clean').duringTurn, 'blocked',
      'clearing the SCREEN never needs to stop the work');
  });

  await test('CMD: a blocked command mid-turn EXPLAINS, and the turn survives', async () => {
    const r = await runCli([], {
      cwd: tmpdir('cmd-'), env: { LAIN_FORCE_TUI: '1', COLUMNS: '96', LINES: '28' },
      stdinSteps: ['audit it\n', '/new\n'], stepDelayMs: 900,
      script: [
        { text: 'Working.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 4' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    assertIncludes(out, "can't run while a turn is in flight");
    assertIncludes(out, 'audit it', 'the task must not be lost');
  });

  await test('CMD: a read-only command mid-turn just works', async () => {
    const r = await runCli([], {
      cwd: tmpdir('cmd-'), env: { LAIN_FORCE_TUI: '1', COLUMNS: '96', LINES: '28' },
      stdinSteps: ['audit it\n', '/status\n'], stepDelayMs: 900,
      script: [
        { text: 'Working.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 4' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'context', '/status must answer during a turn');
    assert.ok(!/can't run while a turn is in flight/.test(out), 'a read must not be blocked');
  });

  await test('CMD: the commands this pass added are present and reachable', async () => {
    for (const n of ['/compare', '/api', '/doctor', '/compact']) {
      assert.ok(commands.REGISTRY.has(n), `${n} is missing from the registry`);
    }
    const r = await runCli([], { cwd: tmpdir('cmd-'), stdin: '/help\n', script: [] });
    const out = plain(r.out);
    assert.match(out, /\/models \[name\|refresh\]/, 'the refresh form must be discoverable from /help');
    // ---- AND THE FORM THAT TAKES A CREDENTIAL --------------------------
    //
    // `/api` had `refresh` and `status` and no way to GIVE LAIN a key at all —
    // it had to be written into config.json by hand. The credential form is the
    // one a person actually needs first, so it is the one that must be visible
    // in `/help`; pinning only the old two would let it be added and remain
    // undiscoverable.
    assert.match(out, /\/api \[<credential>\|refresh \[id\]\|status\]/, 'so must /api');
    assert.match(out, /bare \/api asks for a key/, 'and the way in with no argument at all');
  });
};
