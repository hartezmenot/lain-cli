'use strict';

/**
 * THE HARNESS AT THE REAL PROMPT. Every case spawns bin/lain.js as a child.
 *
 * This file may not require() a single application module — a green run here
 * proves the commands are reachable, registered, and survive a real turn, which
 * is exactly what an in-process test cannot show.
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS ACTUALLY GUARDING.
 *
 * Two of this project's most expensive bugs were of a shape only this tier can
 * catch: a helper extracted from app.js that read a name nothing gave it, and
 * an event whose producer and consumer spelled it differently. Both loaded,
 * exported and read perfectly; both died on the real path. The harness added a
 * new module required lazily from inside a method, a new command family and
 * four new tools — every one of them the same shape.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli, assertIncludes, assertNotIncludes } = require('../helpers');

/** A turn must never die because the harness is in the loop. */
function assertNoCrash(r) {
  assertNotIncludes(r.out, 'TypeError');
  assertNotIncludes(r.out, 'ReferenceError');
  assertNotIncludes(r.out, 'is not a function');
  assertNotIncludes(r.out, 'Cannot read');
}

module.exports = async function () {
  await test('HARNESS-CLI: /harness answers before anything has been asked', async () => {
    const r = await runCli([], { stdin: '/harness\n/exit\n' });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, 'No harness task yet');
  });

  await test('HARNESS-CLI: a turn opens a task, and /harness shows its state', async () => {
    const cwd = tmpdir('lain-harness-');
    const r = await runCli([], {
      cwd,
      stdin: 'add a greeting file\n/harness\n/exit\n',
      script: [
        { text: 'Writing it.', tool_calls: [{ name: 'write_file', input: { path: 'greet.txt', content: 'hello' } }] },
        { text: 'Written.' },
      ],
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, 'LAIN TASK', 'a task record must exist after a turn');
    assertIncludes(r.out, 'add a greeting file', 'and it is titled by what was asked');
    // THE MODEL STOPPING IS NOT A PASS. The task is VERIFYING, and the screen
    // says nothing has been proved.
    assertIncludes(r.out, 'nothing has been proved yet');
    assertNotIncludes(r.out, 'PASSED');
  });

  await test('HARNESS-CLI: the task record is written under .lain/tasks', async () => {
    const cwd = tmpdir('lain-harness-');
    const r = await runCli([], {
      cwd,
      stdin: 'touch something\n/exit\n',
      script: [
        { text: 'Doing it.', tool_calls: [{ name: 'write_file', input: { path: 'a.txt', content: 'x' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    const tasks = path.join(cwd, '.lain', 'tasks');
    assert.ok(fs.existsSync(tasks), 'the harness must persist a task directory');
    const ids = fs.readdirSync(tasks);
    assert.ok(ids.length >= 1, 'one task per request');
    const record = JSON.parse(fs.readFileSync(path.join(tasks, ids[0], 'task.json'), 'utf8'));
    assert.strictEqual(record.state, 'VERIFYING', `a model that stopped leaves the task VERIFYING, not done (got ${record.state})`);
    // THE FLIGHT RECORDER HAS THE TOOL CALL IN IT.
    const events = fs.readFileSync(path.join(tasks, ids[0], 'events.jsonl'), 'utf8');
    assert.match(events, /tool\.started/, 'the durable log must contain what happened');
    assert.match(events, /write_file/);
  });

  await test('HARNESS-CLI: /verify runs real evidence and settles the task', async () => {
    const cwd = tmpdir('lain-harness-');
    fs.writeFileSync(path.join(cwd, 'suite.js'), 'console.log("2 passed, 0 failed");\n');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'v', scripts: { test: 'node suite.js' } }));
    const r = await runCli([], {
      cwd,
      stdin: 'make the suite pass\n/verify tests\n/harness\n/exit\n',
      script: [
        { text: 'Looking.', tool_calls: [{ name: 'read_file', input: { path: 'suite.js' } }] },
        { text: 'It is already right.' },
      ],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, 'VERIFICATION PASSED');
    assertIncludes(r.out, '1 passed');
    assertIncludes(r.out, 'is now');
    const tasks = path.join(cwd, '.lain', 'tasks');
    const ids = fs.readdirSync(tasks);
    const record = JSON.parse(fs.readFileSync(path.join(tasks, ids[0], 'task.json'), 'utf8'));
    assert.strictEqual(record.state, 'PASSED', 'evidence, and only evidence, reaches PASSED');
  });

  await test('HARNESS-CLI: a red suite makes /verify FAIL the task', async () => {
    const cwd = tmpdir('lain-harness-');
    fs.writeFileSync(path.join(cwd, 'suite.js'), 'console.log("1 passed, 1 failed"); process.exit(1);\n');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'v', scripts: { test: 'node suite.js' } }));
    const r = await runCli([], {
      cwd,
      stdin: 'fix it\n/verify tests\n/exit\n',
      script: [{ text: 'All fixed!' }],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    // THE MODEL SAID "ALL FIXED". THE EVIDENCE SAYS OTHERWISE, AND THE
    // EVIDENCE IS WHAT THE TASK STATE FOLLOWS.
    assertIncludes(r.out, 'VERIFICATION FAILED');
    const ids = fs.readdirSync(path.join(cwd, '.lain', 'tasks'));
    const record = JSON.parse(fs.readFileSync(path.join(cwd, '.lain', 'tasks', ids[0], 'task.json'), 'utf8'));
    assert.strictEqual(record.state, 'FAILED');
  });

  await test('HARNESS-CLI: /artifacts lists the receipts and can open one', async () => {
    const cwd = tmpdir('lain-harness-');
    fs.writeFileSync(path.join(cwd, 'suite.js'), 'console.log("7 passed, 0 failed");\n');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'v', scripts: { test: 'node suite.js' } }));
    const r = await runCli([], {
      cwd,
      stdin: 'check the suite\n/verify tests\n/artifacts\n/exit\n',
      script: [{ text: 'Have a look.' }],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, 'Artifacts');
    assertIncludes(r.out, 'verification');
    assertIncludes(r.out, '/artifacts open');
  });

  await test('HARNESS-CLI: /env and /harness doctor report what is really here', async () => {
    const r = await runCli([], { stdin: '/env\n/harness doctor\n/exit\n', timeoutMs: 60000 });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, 'Processes');
    assertIncludes(r.out, 'Browser');
    // The doctor is grouped into CORE and OPTIONAL, and both halves must show.
    assertIncludes(r.out, 'Core');
    assertIncludes(r.out, 'runtime');
    assertIncludes(r.out, 'task storage');
    assertIncludes(r.out, 'Verification');
    assertIncludes(r.out, 'Optional');
    // AN UNAVAILABLE CAPABILITY SAYS WHY. A row with no reason is the failure
    // this whole design is against.
    assertIncludes(r.out, 'event integration');
  });

  await test('HARNESS-CLI: lain --doctor is the same report, without a session', async () => {
    // The post-install verification command. It must work with no provider
    // configured — which is the state of every machine at the moment it is
    // checked — and it must not create a session doing it.
    const r = await runCli(['--doctor'], { timeoutMs: 60000 });
    assert.strictEqual(r.code, 0, r.out);
    assertNoCrash(r);
    assertIncludes(r.out, 'LAIN Harness');
    assertIncludes(r.out, 'Core');
    assertIncludes(r.out, 'Core is available.');
    assertNotIncludes(r.out, 'Session saved');
    assertNotIncludes(r.out, 'resume with');
  });

  await test('HARNESS-CLI: /harness capabilities names what needs approval', async () => {
    const r = await runCli([], { stdin: '/harness capabilities\n/exit\n', timeoutMs: 60000 });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, 'Capabilities');
    assertIncludes(r.out, 'DESTRUCTIVE');
    assertIncludes(r.out, 'approval required');
    assertIncludes(r.out, 'delete_file');
  });

  await test('HARNESS-CLI: /harness timeline is the flight recorder, in order', async () => {
    const cwd = tmpdir('lain-harness-');
    const r = await runCli([], {
      cwd,
      stdin: 'read the manifest\n/harness timeline\n/exit\n',
      script: [
        { text: 'Reading.', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
        { text: 'Read it.' },
      ],
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, 'Timeline');
    assertIncludes(r.out, 'task created');
    assertIncludes(r.out, 'list_dir');
  });

  await test('HARNESS-CLI: /tasks lists what this project has records of', async () => {
    const cwd = tmpdir('lain-harness-');
    const r = await runCli([], {
      cwd,
      stdin: 'do a thing\n/tasks\n/exit\n',
      script: [{ text: 'Done a thing.' }],
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, 'Tasks');
    assertIncludes(r.out, 'do a thing');
  });

  await test('HARNESS-CLI: /task still prints everything it always printed', async () => {
    // BACKWARD COMPATIBILITY, ASSERTED. The harness section was APPENDED; not
    // one word of what this command said before was replaced.
    const cwd = tmpdir('lain-harness-');
    const r = await runCli([], {
      cwd,
      stdin: 'investigate the config\n/task\n/exit\n',
      script: [{ text: 'Looked at it.' }],
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, 'objective', 'the original table is still there');
    assertIncludes(r.out, 'started');
    assertIncludes(r.out, 'state');
    assertIncludes(r.out, 'LAIN TASK', 'and the harness record is appended beneath it');
  });

  await test('HARNESS-CLI: the model can start a managed service and check it', async () => {
    const cwd = tmpdir('lain-harness-');
    // A PORT THE OS PICKED, so the health check has something to probe and two
    // runs can never collide. A service with no port is legitimately UNKNOWN —
    // nothing looked — and asserting on that would be asserting on the absence
    // of a check rather than on a check. A hard-coded port was the first
    // version and it is exactly how a suite starts failing for a reason that
    // has nothing to do with the code.
    const net = require('net');
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    fs.writeFileSync(path.join(cwd, 'srv.js'),
      `const http=require("http");http.createServer((q,s)=>s.end("ok")).listen(${port},"127.0.0.1",()=>console.log("listening"));\n`);
    const r = await runCli(['-p', 'start the server'], {
      cwd,
      script: [
        {
          text: 'Starting it.',
          tool_calls: [{
            name: 'service_start',
            input: { name: 'api', command: 'node srv.js', port, wait_ms: 12000 },
          }],
        },
        { text: 'Checking it.', tool_calls: [{ name: 'service_check', input: { name: 'api' } }] },
        { text: 'It is up.' },
      ],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, 'api', 'the service is named in the result');
    assertIncludes(r.out, 'HEALTHY', 'a port that accepts connections reads HEALTHY');
    assertIncludes(r.out, 'accepts connections', 'and the reason is stated, not implied');
    const stillListening = await new Promise((resolve) => {
      const socket = require('net').connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
    assert.strictEqual(stillListening, false, 'one-shot exit must release the service port');
  });

  await test('HARNESS-CLI: verify_task refuses an empty contract rather than passing it', async () => {
    const cwd = tmpdir('lain-harness-');
    const r = await runCli(['-p', 'claim it is done'], {
      cwd,
      script: [
        { text: 'Proving it.', tool_calls: [{ name: 'verify_task', input: { name: 'nothing', requirements: [] } }] },
        { text: 'I could not prove it.' },
      ],
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, 'at least one requirement');
  });

  await test('HARNESS-CLI: the observe tool routes to a source and names it', async () => {
    const cwd = tmpdir('lain-harness-');
    fs.writeFileSync(path.join(cwd, 'thing.txt'), 'the contents of the thing');
    const r = await runCli(['-p', 'what is in thing.txt'], {
      cwd,
      script: [
        { text: 'Looking.', tool_calls: [{ name: 'observe', input: { goal: 'file', path: 'thing.txt' } }] },
        { text: 'That is what is in it.' },
      ],
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertIncludes(r.out, '[filesystem]', 'the answer must say which source produced it');
    assertIncludes(r.out, 'the contents of the thing');
  });

  await test('HARNESS-CLI: /steer still works with the harness in the loop', async () => {
    // The mission names this one explicitly. It is the established control and
    // must not have been disturbed.
    const r = await runCli([], { stdin: '/steer stop editing files and read the logs first\n/exit\n', timeoutMs: 60000 });
    assert.strictEqual(r.code, 0);
    assertNoCrash(r);
    assertNotIncludes(r.out, 'Usage: /steer', 'a real instruction must not fall through to usage');
  });
};
