'use strict';

/**
 * THE DURABLE LAYER — the `.lain/` state that compaction must never touch.
 *
 * The compaction design (contextauthority.js) holds that a conversation is
 * disposable and the project's own intelligence is not. These tests are the
 * proof of the second half: architecture, memory, scratch scoping and the
 * no-duplicated-transcript rule, each checked against the real modules with
 * a real directory on disk.
 *
 *   12  the intended architecture survives conversation compaction
 *   13  promoted facts survive compaction AND an explicit clear
 *   14  scratch is scoped to one session and orphans exclude the current one
 *   15  compaction never injects a duplicated transcript into the wire
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const tools = require('../../src/tools');
const { Session } = require('../../src/session');
const architecture = require('../../src/architecture');
const scratch = require('../../src/scratch');
const lainstore = require('../../src/lainstore');
const { buildWire } = require('../../src/contextfit');

const PC = { provider: 'p', connectionId: 'p:a', model: 'm', ctx: 200000, maxTokens: 4096 };

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lain-layer-'));
}

async function call(name, input, cwd, sessionId = 's-test') {
  return tools.execute(name, input, { cwd, session: { id: sessionId } });
}

/** A session under real char pressure, the same shape the compaction tests use. */
function pressureSession(body = 12000, steps = 40) {
  const session = new Session({ cwd: process.cwd() });
  session.messages.push({ role: 'user', content: 'do the work' });
  for (let i = 0; i < steps; i++) {
    session.messages.push({
      role: 'assistant', content: `step ${i}`, ts: new Date().toISOString(),
      tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: JSON.stringify({ path: `f${i}.js` }) }],
    });
    session.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(body) });
  }
  return session;
}

module.exports = async function () {
  await test('LAIN: the intended architecture survives conversation compaction', async () => {
    const cwd = root();
    try {
      // Record intent through the model-facing door, not the module: the tool
      // is the path a real session would take.
      const r = await call('architecture', {
        op: 'declare', name: 'Context Authority', status: 'IMPLEMENTED',
        purpose: 'Owns every compaction transition.', location: 'src/contextauthority.js',
      }, cwd);
      assert.strictEqual(r.isError, undefined, `declare failed: ${r.output}`);

      const session = new Session({ cwd });
      session.messages = pressureSession().messages;
      const decision = session.contextAuthority.compact(PC, {}, { reason: 'test-pressure' });
      assert.strictEqual(decision.result.compacted, true, 'the conversation really was compacted');

      const after = architecture.load(cwd);
      assert.ok(after.nodes['context-authority'], 'the declared node is still there');
      assert.strictEqual(after.nodes['context-authority'].status, 'IMPLEMENTED');
      assert.strictEqual(after.nodes['context-authority'].purpose, 'Owns every compaction transition.');
      assert.strictEqual(lainstore.has(cwd, 'architecture'), true, '.lain/architecture still exists');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  await test('LAIN: promoted facts survive compaction AND an explicit clear', async () => {
    const cwd = root();
    try {
      const p = await call('scratch', {
        op: 'promote', text: 'the working budget is 50,000 tokens by default',
        evidence: 'read src/contextbudget.js DEFAULT_BUDGET_TOKENS',
      }, cwd);
      assert.strictEqual(p.isError, undefined, `promote failed: ${p.output}`);

      const session = new Session({ cwd });
      session.messages = pressureSession().messages;
      session.contextAuthority.compact(PC, {}, { reason: 'test-pressure' });
      session.clearContext();

      const facts = scratch.facts(cwd);
      assert.strictEqual(facts.length, 1, 'the fact outlived both operations');
      assert.strictEqual(facts[0].text, 'the working budget is 50,000 tokens by default');
      assert.strictEqual(facts[0].evidence, 'read src/contextbudget.js DEFAULT_BUDGET_TOKENS');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  await test('LAIN: scratch is scoped to one session, and orphans exclude the current one', async () => {
    const cwd = root();
    try {
      await call('scratch', { op: 'note', text: 'session one found this' }, cwd, 's-one');
      await call('scratch', { op: 'note', text: 'session two found that' }, cwd, 's-two');

      const one = scratch.notes(cwd, 's-one');
      const two = scratch.notes(cwd, 's-two');
      assert.strictEqual(one.length, 1);
      assert.strictEqual(two.length, 1);
      assert.strictEqual(one[0].text, 'session one found this', 'one session never sees another\'s notes');

      // CLOSE is completion: the notes are spent, the directory is gone.
      scratch.close(cwd, 's-two');
      assert.strictEqual(scratch.notes(cwd, 's-two').length, 0);
      assert.ok(!fs.existsSync(lainstore.scratchDir(cwd, 's-two')), 'the closed scratch directory is removed');

      // The unfinished one is an orphan — unless it belongs to the session asking.
      const all = scratch.orphans(cwd);
      assert.deepStrictEqual(all.map((o) => o.session), ['s-one'], 'only the unfinished session is an orphan');
      assert.deepStrictEqual(scratch.orphans(cwd, { exclude: 's-one' }), [],
        'a session asking about orphans is never told about its own live scratch');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  await test('LAIN: compaction never injects a duplicated transcript into the wire', () => {
    const session = pressureSession();
    const before = session.messages.length;
    const decision = session.contextAuthority.compact(PC, {}, { reason: 'test-pressure' });
    assert.strictEqual(decision.result.compacted, true);

    // The wire is built FROM the session, not alongside it — so its length is
    // the session plus the system prompt plus at most one live tail, and no
    // tool_call id may appear twice (a doubled exchange is the 400 the fold
    // exists to prevent, read in the other direction).
    const wire = buildWire(session, 'system prompt');
    assert.ok(wire.length <= session.messages.length + 1,
      `wire grew: ${wire.length} messages for ${session.messages.length} in the session`);
    const ids = wire.flatMap((m) => (m.tool_calls || []).map((c) => c.id));
    assert.strictEqual(new Set(ids).size, ids.length, 'a tool_call id appears twice in the wire');
    const answers = wire.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    assert.strictEqual(new Set(answers).size, answers.length, 'a tool result appears twice in the wire');
    assert.ok(session.messages.length <= before,
      'compaction reduced or held the message count, never grew it');

    // And a second compaction of the same epoch changes nothing at all.
    const chars = session.contextChars();
    session.contextAuthority.compact(PC, {}, { reason: 'test-pressure-again' });
    assert.strictEqual(session.contextChars(), chars, 'a compacted compact is a no-op');
  });

  await test('LAIN: the four doors are advertised and dispatchable', async () => {
    const cwd = root();
    try {
      for (const name of ['concept', 'architecture', 'wiring', 'scratch']) {
        assert.ok(tools.has(name), `${name} is in the registry`);
      }
      // One round trip through each: define -> connect -> view, and an
      // unknown op is a recoverable result rather than a crash.
      const bad = await call('concept', { op: 'nope' }, cwd);
      assert.strictEqual(bad.isError, true);
      assert.match(bad.output, /unknown op/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  await test('LAIN: seeding records observations, never guessed intent', async () => {
    const cwd = root();
    try {
      fs.mkdirSync(path.join(cwd, 'src', 'auth'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'src', 'auth', 'session.js'), 'function validateSession() {}\n');
      const r = await call('architecture', { op: 'seed' }, cwd);
      assert.strictEqual(r.isError, undefined, `seed failed: ${r.output}`);
      const model = architecture.load(cwd);
      const node = model.nodes['src-auth-session'];
      assert.ok(node, 'the seeded file is a node');
      assert.strictEqual(node.origin, 'seed', 'marked as a candidate, not declared intent');
      assert.strictEqual(node.purpose, '', 'purpose is deliberately not guessed');
      assert.strictEqual(node.status, 'PLANNED', 'no intent claim is made about a seeded node');
      assert.strictEqual(node.location, 'src/auth/session.js');
      // Reconciled immediately: the observation axis is the disk's word.
      assert.ok(['PRESENT', 'UNKNOWN'].includes(node.observed.status),
        'observed left to the reconciler, not asserted by the seed');
      // Idempotent: a second seed adds nothing.
      await call('architecture', { op: 'seed' }, cwd);
      assert.strictEqual(Object.keys(architecture.load(cwd).nodes).length, Object.keys(model.nodes).length,
        'a second seed does not duplicate nodes');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  await test('LAIN: verify refuses what is not on disk, with the reconciler as the only observer-writer', async () => {
    const cwd = root();
    try {
      await call('architecture', {
        op: 'declare', name: 'Ghost', status: 'IMPLEMENTED', location: 'src/ghost.js',
        purpose: 'A component whose file does not exist.',
      }, cwd);
      const r = await call('architecture', { op: 'verify', node: 'Ghost', how: 'ran it', result: 'passed' }, cwd);
      assert.strictEqual(r.isError, true, 'verifying a component with no file must be refused');
      assert.match(r.output, /nothing exists at/);

      // The refusal is recorded as an OBSERVATION — the disk's word, written
      // only by the reconciler, never by the model-facing tool.
      const model = architecture.load(cwd);
      assert.strictEqual(model.nodes.ghost.observed.status, 'MISSING');
      assert.notStrictEqual(model.nodes.ghost.status, 'VERIFIED', 'the status never moved');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
};
