'use strict';

/**
 * `/compare` and the refresh commands, through the real binary.
 *
 * The unit tier proves the probes and the diff are right. These prove they are
 * REACHABLE — a command that exists in a registry and cannot be run from a
 * prompt is not a capability.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A small tree that has a couple of capabilities this project does not. */
function otherVersion() {
  const dir = tmpdir('other-');
  const files = {
    'src/staticcheck.js': '// verifies a plain HTML site hangs together\n',
    'src/fixledger.js': '// remembers which fix cleared which error\n',
    'src/knowledge.js': '// searchable reference notes\n',
    'src/orchestra.js': '// several models on one task\n',
    'src/checkpoint.js': "const crypto = require('crypto');\n",
    'package.json': '{"name":"other"}\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

module.exports = async function () {
  await test('CMP SMOKE: /compare with no source explains what it can read', async () => {
    const r = await runCli([], { cwd: tmpdir('cmp-'), stdin: '/compare\n', script: [] });
    const out = plain(r.out);
    assertIncludes(out, 'Compare against what?');
    assertIncludes(out, 'a folder on this machine');
    assertIncludes(out, 'nothing leaves the machine', 'the local option must be the recommended one, and say why');
  });

  await test('CMP SMOKE: /compare <folder> prints a grid and a plain-language summary', async () => {
    const other = otherVersion();
    const r = await runCli([], { cwd: tmpdir('cmp-'), stdin: `/compare ${other}\n`, script: [], timeoutMs: 60000 });
    const out = plain(r.out);
    assertIncludes(out, 'Capability', 'the grid header');
    assertIncludes(out, '┌', 'it must actually be a grid');
    assertIncludes(out, 'Static site verifier', 'a capability the other tree has');
    assertIncludes(out, 'Missing here, present there:', 'and a summary in words, not only a table');
    assertIncludes(out, 'DO NOT MIGRATE', 'the orchestra must be marked, not offered');
  });

  await test('CMP SMOKE: the offer to migrate names a real capability id', async () => {
    const other = otherVersion();
    const r = await runCli([], { cwd: tmpdir('cmp-'), stdin: `/compare ${other}\n`, script: [], timeoutMs: 60000 });
    const out = plain(r.out);
    assertIncludes(out, 'Would you like to add any of these?');
    const m = /\/compare add ([\w-]+)/.exec(out);
    assert.ok(m, 'the offer must show a runnable example');
    assertIncludes(out, 'built for this codebase', 'and be explicit that nothing is copied wholesale');
  });

  await test('CMP SMOKE: /compare add refuses a deliberately excluded capability', async () => {
    // The orchestra is a separate project. Offering to migrate it would be the
    // report contradicting the architecture.
    const other = otherVersion();
    const r = await runCli([], {
      cwd: tmpdir('cmp-'),
      stdinSteps: [`/compare ${other}\n`, '/compare add orchestra\n'], stepDelayMs: 900,
      script: [], timeoutMs: 60000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'left out on purpose');
    assertIncludes(out, 'separate project');
  });

  await test('CMP SMOKE: /compare add before any comparison says so instead of guessing', async () => {
    const r = await runCli([], { cwd: tmpdir('cmp-'), stdin: '/compare add anything\n', script: [] });
    assertIncludes(plain(r.out), 'Run /compare <source> first');
  });

  await test('CMP SMOKE: an unreadable source is an error, never an empty comparison', async () => {
    const r = await runCli([], { cwd: tmpdir('cmp-'), stdin: '/compare C:\\no\\such\\place\n', script: [] });
    const out = plain(r.out);
    assertIncludes(out, 'Could not read that');
    assert.ok(!/Capability/.test(out), 'a failed read must not print a grid of all-missing rows');
  });

  // ------------------------------------------------------------- refresh ---

  await test('REFRESH SMOKE: all three spellings are reachable and behave the same', async () => {
    // There is no way to guess whether a person reaches for /api, /model or
    // /models, and they run the same code.
    for (const cmd of ['/api refresh', '/model refresh', '/models refresh']) {
      const r = await runCli([], { cwd: tmpdir('rf-'), stdin: `${cmd}\n`, script: [], timeoutMs: 30000 });
      const out = plain(r.out);
      assertIncludes(out, 'Refreshing', `${cmd} did not run`);
      // With the mock provider there is no route to ask, and it must SAY so.
      assertIncludes(out, 'Nothing to refresh', `${cmd} must explain when there is nothing to ask`);
    }
  });

  await test('REFRESH SMOKE: /help lists the refresh forms so they are discoverable', async () => {
    const r = await runCli([], { cwd: tmpdir('rf-'), stdin: '/help\n', script: [] });
    const out = plain(r.out);
    assertIncludes(out, '/api');
    assertIncludes(out, '/compare');
    assert.match(out, /\/models \[name\|refresh\]/, 'the refresh form must be visible in help, not folklore');
  });

  await test('REFRESH SMOKE: refreshing costs no model request', async () => {
    const r = await runCli([], { cwd: tmpdir('rf-'), stdin: '/api refresh\n/status\n', script: [], timeoutMs: 30000 });
    assert.match(plain(r.out), /0 requests/, 'a catalog refresh must never spend a completion');
  });
};
