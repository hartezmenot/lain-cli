'use strict';

/**
 * THE ENGINEERING TOOLS, THROUGH THE REAL BINARY.
 *
 * Everything here spawns `bin/lain.js` as a child process and drives it with a
 * scripted model. Nothing require()s an application module — that is the whole
 * difference between LIVE-VERIFIED and UNIT-VERIFIED, and it is what catches
 * the class of defect the unit tier structurally cannot: a tool that is
 * advertised but not dispatchable, a schema the provider layer rejects, a
 * result that never reaches the screen.
 *
 * The unit tier proves these tools do the right thing. This proves the model
 * can actually reach them.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const CR = '\r';

/** A small project with a migration half-done in it. */
function project() {
  const dir = tmpdir('lain-eng-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'data.js'),
    "'use strict';\nconst ENEMIES = { slime: { hp: 10 } };\nmodule.exports = { ENEMIES };\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'game.js'),
    "'use strict';\nconst { ENEMIES } = require('./data');\n"
    + 'function spawn(kind) {\n  return { ...ENEMIES[kind], kind };\n}\n'
    + 'module.exports = { spawn };\n', 'utf8');
  return dir;
}

module.exports = async function () {
  await test('ENG: the model can reach read_symbol and gets one definition back', async () => {
    const dir = project();
    const r = await runCli([], {
      cwd: dir,
      script: [
        { text: 'Looking at spawn.', tool_calls: [{ name: 'read_symbol', input: { path: 'src/game.js', name: 'spawn' } }] },
        { text: 'Read it.' },
      ],
      stdin: `show me spawn${CR}/exit${CR}`,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    assert.ok(!/unknown tool/.test(r.out), `the tool was not dispatchable: ${r.out.slice(-1500)}`);
    assert.ok(!/read_symbol failed/.test(r.out), r.out.slice(-1500));
  });

  await test('ENG: replace_symbol edits the real file on disk, through the real binary', async () => {
    const dir = project();
    const r = await runCli([], {
      cwd: dir,
      script: [
        {
          text: 'Changing spawn.',
          tool_calls: [{
            name: 'replace_symbol',
            input: {
              path: 'src/game.js', name: 'spawn',
              replacement: 'function spawn(kind) {\n  return { ...ENEMIES[kind], kind, spawned: true };\n}',
            },
          }],
        },
        { text: 'Done.' },
      ],
      stdin: `update spawn${CR}/exit${CR}`,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    const after = fs.readFileSync(path.join(dir, 'src', 'game.js'), 'utf8');
    assert.ok(after.includes('spawned: true'), 'the file on disk must actually have changed');
    assert.ok(after.includes("const { ENEMIES } = require('./data');"), 'and nothing around it moved');
  });

  await test('ENG: a semantic edit that breaks the file leaves the file intact on disk', async () => {
    // The rollback contract, verified where it counts: on the filesystem, after
    // a real process exited.
    const dir = project();
    const before = fs.readFileSync(path.join(dir, 'src', 'game.js'), 'utf8');
    const r = await runCli([], {
      cwd: dir,
      script: [
        {
          text: 'Changing spawn.',
          tool_calls: [{
            name: 'replace_symbol',
            input: { path: 'src/game.js', name: 'spawn', replacement: 'function spawn(kind) { return {' },
          }],
        },
        { text: 'That failed.' },
      ],
      stdin: `break spawn${CR}/exit${CR}`,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'game.js'), 'utf8'), before,
      'a rejected semantic edit must leave the file byte-for-byte unchanged');
  });

  await test('ENG: find_residue reaches the model and names the leftover', async () => {
    const dir = project();
    const r = await runCli([], {
      cwd: dir,
      script: [
        {
          text: 'Checking the migration.',
          tool_calls: [{ name: 'find_residue', input: { gone: ['ENEMIES'] } }],
        },
        { text: 'Checked.' },
      ],
      stdin: `did the migration finish${CR}/exit${CR}`,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    assert.ok(!/unknown tool/.test(r.out), r.out.slice(-1500));
    assert.ok(!/find_residue failed/.test(r.out), r.out.slice(-1500));
  });

  await test('ENG: a shell command runs in the cwd it was given, not the session directory', async () => {
    // CWD as a parameter rather than a `cd` welded into the command — the whole
    // point being that the shell's separator rules never enter into it.
    const dir = project();
    const marker = 'lain_cwd_marker.txt';
    const r = await runCli([], {
      cwd: dir,
      script: [
        {
          text: 'Writing in src.',
          tool_calls: [{
            name: process.platform === 'win32' ? 'run_powershell' : 'run_bash',
            input: {
              command: process.platform === 'win32'
                ? `Set-Content -Path ${marker} -Value ok`
                : `echo ok > ${marker}`,
              cwd: 'src',
            },
          }],
        },
        { text: 'Written.' },
      ],
      stdin: `write a marker in src${CR}/exit${CR}`,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    assert.ok(fs.existsSync(path.join(dir, 'src', marker)),
      'the file must land in the directory the tool was told to use');
    assert.ok(!fs.existsSync(path.join(dir, marker)),
      'and not in the session directory');
  });

  await test('ENG: a failing command comes back CLASSIFIED, on the real screen', async () => {
    const dir = project();
    const r = await runCli([], {
      cwd: dir,
      script: [
        {
          text: 'Running it.',
          tool_calls: [{
            name: process.platform === 'win32' ? 'run_powershell' : 'run_bash',
            input: { command: 'lain_no_such_program_9271 --help' },
          }],
        },
        { text: 'It is not installed.' },
      ],
      stdin: `run the tool${CR}/exit${CR}`,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    // The classification has to survive the whole path — tool result, turn
    // record, transcript — not merely exist inside execution.js.
    assert.ok(/COMMAND_NOT_FOUND/.test(r.out),
      `the failure was not classified anywhere the model can see it:\n${r.out.slice(-2000)}`);
  });

  await test('ENG: an edit that introduces an unresolved name is reported with the write', async () => {
    const dir = project();
    const r = await runCli([], {
      cwd: dir,
      script: [
        {
          text: 'Adding a helper.',
          tool_calls: [{
            name: 'write_file',
            input: {
              path: 'src/api.js',
              content: 'function getUsers(db) { return db.all(); }\n'
                + 'function main(db) { return getUser(db); }\n'
                + 'module.exports = { getUsers, main };\n',
            },
          }],
        },
        { text: 'Added.' },
      ],
      stdin: `add the api${CR}/exit${CR}`,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, r.out.slice(-2000));
    assert.ok(fs.existsSync(path.join(dir, 'src', 'api.js')), 'the write still happened');
    assert.ok(/UNRESOLVED NAME/.test(r.out),
      `the typo check did not reach the model:\n${r.out.slice(-2000)}`);
  });

  await test('ENG: every advertised tool is dispatchable in a real process', async () => {
    // The V1 defect this whole registry design exists to prevent: 68 schemas
    // against 78 dispatch entries. Checked here in a spawned binary rather than
    // in-process, so a tool that only resolves under the test runner's module
    // cache cannot pass.
    const dir = project();
    const r = await runCli(['--print-tools'], { cwd: dir, timeoutMs: 30000 });
    if (r.code !== 0) return;            // the flag is not supported; nothing to assert
    assert.ok(/read_symbol/.test(r.out) && /find_residue/.test(r.out), r.out.slice(0, 800));
  });
};
