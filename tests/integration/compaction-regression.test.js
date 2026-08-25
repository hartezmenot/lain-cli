'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const { App } = require('../../src/app');
const { Session } = require('../../src/session');
const mock = require('../../src/mockprovider');

function script(steps) {
  const dir = tmpdir('compact-reg-');
  const file = path.join(dir, 'script.json');
  fs.writeFileSync(file, JSON.stringify(steps), 'utf8');
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = file;
  process.env.LAIN_CONTEXT_BUDGET_TOKENS = '8000';
  mock._reset();
  return dir;
}

function unscript() {
  delete process.env.LAIN_PROVIDER;
  delete process.env.LAIN_MOCK_SCRIPT;
  delete process.env.LAIN_CONTEXT_BUDGET_TOKENS;
  mock._reset();
}

function app(cwd) {
  const a = new App({ interactive: false, cwd });
  a.render.write = () => {};
  a.render.notice = () => {};
  a.render.turnSummary = () => {};
  a.render.nl = () => {};
  a.session.save = () => {};
  return a;
}

function pressureSession() {
  const session = new Session({ cwd: process.cwd() });
  session.messages.push({ role: 'user', content: 'original objective' });
  for (let i = 0; i < 30; i++) {
    session.messages.push({
      role: 'assistant', content: `step ${i}`, ts: new Date().toISOString(),
      tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: JSON.stringify({ path: `f${i}.js` }) }],
    });
    session.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(12000) });
  }
  return session;
}

module.exports = async function () {
  await test('COMPACT REG: pressure, ask_user, and bounded compaction leave the job parked', async () => {
    const steps = [
      { text: 'asking', tool_calls: [{ name: 'ask_user', input: { question: 'Which provider?', options: ['a', 'b'] } }] },
    ];
    const dir = script(steps);
    try {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-cwd-'));
      const a = app(cwd);
      a.session.messages = pressureSession().messages;
      const job = a.startBackground('inspect the work');

      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(job.needsInput, true, 'the background job must remain parked');
      assert.strictEqual(job.question && job.question.question, 'Which provider?');
      assert.strictEqual(job.session.contextAuthority.attempts, 1,
        `context authority attempted compaction ${job.session.contextAuthority.attempts} times`);
      assert.ok(job.session.contextChars() < 363_000,
        `the provider projection was compacted (${job.session.contextChars()} chars)`);
      assert.strictEqual(job.session.messages[0].content, 'original objective');
      fs.rmSync(cwd, { recursive: true, force: true });
    } finally {
      unscript();
    }
  });
};
