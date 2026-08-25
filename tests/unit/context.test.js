'use strict';

/**
 * THE CONTEXT WINDOW.
 *
 * V2 had no context management of any kind: `session.messages` grew for the
 * life of the task and every step re-sent all of it, so a long task ended in a
 * provider rejection carrying the whole turn's work. These assert the two
 * properties that make the fix trustworthy:
 *
 *   1. it gets the conversation UNDER the budget, and
 *   2. what comes out is still a VALID conversation — same order, same
 *      messages, every tool result still paired with the call that made it.
 *
 * (2) is the half that is easy to get wrong. A scheme that deletes old messages
 * shrinks the payload and then earns a 400 for an orphaned tool_result.
 */

const assert = require('assert');
const { test } = require('../helpers');

const { Session, budgetChars, TOOL_STUB_MIN } = require('../../src/session');
const { Plan } = require('../../src/plan');

/** A session of `n` model steps, each with one big tool result. */
function longSession(n, bodyChars = 9000) {
  const s = new Session({ cwd: process.cwd() });
  s.messages.push({ role: 'user', content: 'add a telegram signal on/off button' });
  for (let i = 0; i < n; i++) {
    s.messages.push({
      role: 'assistant',
      content: `Checking ${i}.`,
      tool_calls: [{ id: `c${i}`, name: 'grep', arguments: JSON.stringify({ pattern: 'telegram' }) }],
    });
    s.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'src/settings.js:1:hit\n'.repeat(Math.ceil(bodyChars / 22)) });
  }
  return s;
}

/** Every tool_result must still name a tool_call that is present, in order. */
function protocolIsValid(messages) {
  const declared = new Set();
  for (const m of messages) {
    if (m.role === 'tool') { if (!declared.has(String(m.tool_call_id))) return false; continue; }
    for (const tc of m.tool_calls || []) declared.add(String(tc.id));
  }
  return true;
}

module.exports = async function () {
  const NL = String.fromCharCode(10);
  await test('CTX: an unbounded conversation is brought under the budget', () => {
    const s = longSession(40);
    const before = s.contextChars();
    const r = s.compact({ budgetChars: 50_000 });
    assert.ok(before > 300_000, `the fixture must actually be too big: ${before}`);
    assert.ok(r.compacted);
    assert.ok(r.after <= 50_000, `still ${r.after} chars — over the budget it was given`);
  });

  await test('CTX: nothing is DELETED — the conversation keeps every message, in order', () => {
    const s = longSession(40);
    const n = s.messages.length;
    const roles = s.messages.map((m) => m.role).join(',');
    s.compact({ budgetChars: 50_000 });
    assert.strictEqual(s.messages.length, n, 'compaction must not drop messages');
    assert.strictEqual(s.messages.map((m) => m.role).join(','), roles, 'nor reorder them');
  });

  await test('CTX: every tool result is still paired with the call that made it', () => {
    // The failure this prevents is a 400 from the provider, which is strictly
    // worse than the overflow it was trying to avoid.
    const s = longSession(40);
    s.compact({ budgetChars: 50_000 });
    assert.ok(protocolIsValid(s.messages), 'a tool_result was left without its tool_call');
    for (const m of s.messages) {
      if (m.role === 'tool') assert.ok(m.tool_call_id, 'a tool message lost its id');
    }
  });

  await test('CTX: the OBJECTIVE is never touched', () => {
    const s = longSession(40);
    s.compact({ budgetChars: 20_000 });
    assert.strictEqual(s.messages[0].content, 'add a telegram signal on/off button');
  });

  await test('CTX: a long plan digest folds old completed steps instead of repeating them', () => {
    const plan = new Plan('fix the bot');
    plan.addSteps(Array.from({ length: 20 }, (_, i) => `step ${i + 1}`));
    for (let i = 0; i < 17; i++) plan.complete(`done ${i + 1}`);
    const digest = plan.digest(4000);
    const rows = digest.split('\n');
    assert.strictEqual(rows.filter((r) => /^✓ \d+\./.test(r)).length, 6,
      'only the six newest completed steps are shown in full');
    assert.match(digest, /11 earlier completed step\(s\) omitted/);
    assert.match(digest, /→ 18\. step 18/);
  });

  await test('CTX: the RECENT working set keeps its full body', () => {
    const s = longSession(40);
    s.compact({ budgetChars: 60_000 });
    const last = s.messages[s.messages.length - 1];
    assert.ok(!last.elided, 'the most recent tool result must survive whole');
    assert.ok(last.content.length > 8000);
  });

  await test('CTX: an elided result says WHICH CALL made it, so it can be re-run', () => {
    // The stub is the recovery mechanism: the model can reproduce anything it
    // lost, because the call is named. A bare "[removed]" cannot be acted on.
    const s = longSession(40);
    s.compact({ budgetChars: 50_000 });
    const stub = s.messages.find((m) => m.elided && m.role === 'tool');
    assert.match(stub.content, /grep/, 'the tool name must survive');
    assert.match(stub.content, /"pattern":"telegram"/, 'and its arguments');
    assert.match(stub.content, /Re-run/, 'and how to get it back');
  });

  // ---- WHAT WAS ELIDED IS NO LONGER "ALREADY IN CONTEXT" ------------------
  //
  // The forensic break, reproduced end to end. The evidence ledger exists to
  // stop a file being re-read into the transcript twice, and its premise is
  // that the content IS in the transcript. Compaction is the one operation
  // that falsifies that premise, and it did so silently.
  //
  // The observed result: the stub says "Re-run the call if you need the rest",
  // the ledger answers "continue from what you already have", the model has
  // neither, and it crawls the file back through the ranged reads the refusal
  // recommends. LEARN -> COMPACT -> FOLLOW-UP must end in a served read.
  await test('CTX: a file whose result was ELIDED can be read again — the claim is retracted', async () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const path2 = require('path');
    const tools = require('../../src/tools');

    const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'lain-ctx-ev-'));
    const body = Array.from({ length: 400 }, (_, i) => `line ${i}: function thing${i}() {}`).join(String.fromCharCode(10));
    fs2.writeFileSync(path2.join(root, 'big.js'), body);

    const s = new Session({ cwd: root });
    const res = await tools.execute('read_file', { path: 'big.js' }, { cwd: root });
    s.evidence.observe('read_file', { path: 'big.js' }, res);
    s.messages.push({ role: 'user', content: 'understand this' });
    s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"big.js"}' }] });
    s.messages.push({ role: 'tool', tool_call_id: 'c1', content: res.output });

    // While the body is genuinely in context, suppression is CORRECT and stays.
    assert.ok(s.evidence.check('read_file', { path: 'big.js' }),
      'with the content in context, a whole re-read is still redundant');

    for (let i = 0; i < 30; i++) {
      s.messages.push({ role: 'assistant', content: `step ${i}` });
      s.messages.push({ role: 'user', content: `n${i}` });
    }
    s.compact({ force: true });

    assert.ok(!s.messages[2].content.includes('thing200'), 'the body really was elided');
    assert.strictEqual(s.evidence.check('read_file', { path: 'big.js' }), null,
      'the content is gone, so the ledger must NOT still claim the model has it');
  });

  // ---- ADAPTATION, NOT PROHIBITION ----------------------------------------
  //
  // The architectural invariant: compaction may change the REPRESENTATION of
  // knowledge, but it must not destroy the workers' ability to answer. These
  // four test the whole lifecycle rather than any one tool name.
  //
  //   A  what the file CONTAINED survives the loss of its body
  //   B  detail that did NOT survive is still cheaply recoverable
  //   C  the model is told the truth about which state it is in
  //   D  when cheap evidence is not enough, the expensive path is still open
  function learned() {
    const fs2 = require('fs');
    const os2 = require('os');
    const path2 = require('path');
    const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'lain-adapt-'));
    const body = [
      "'use strict';",
      'function budgetChars(pc) { return pc * 2; }',
      'class Ledger {',
      '  record(p) { return p; }',
      '  elide(p) { return p; }',
      '}',
      'function unrelated() { return 0; }',
    ].join(NL) + NL + 'x'.repeat(9000) + NL;
    fs2.writeFileSync(path2.join(root, 'session.js'), body);
    return root;
  }

  async function afterCompaction(root) {
    const tools = require('../../src/tools');
    const s = new Session({ cwd: root });
    const res = await tools.execute('read_file', { path: 'session.js' }, { cwd: root });
    s.evidence.observe('read_file', { path: 'session.js' }, res);
    s.messages.push({ role: 'user', content: 'understand the ledger' });
    s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"session.js"}' }] });
    s.messages.push({ role: 'tool', tool_call_id: 'c1', content: res.output });
    for (let i = 0; i < 30; i++) {
      s.messages.push({ role: 'assistant', content: `step ${i}` });
      s.messages.push({ role: 'user', content: `n${i}` });
    }
    s.compact({ force: true });
    return { s, raw: res.output };
  }

  await test('ADAPT A: the body goes, what the file DEFINED survives the compaction', async () => {
    const { s, raw } = await afterCompaction(learned());
    const stub = s.messages[2].content;
    assert.ok(!stub.includes('xxxxxxxxxx'), 'the bulk really was removed');
    assert.ok(/budgetChars/.test(stub) && /Ledger/.test(stub) && /elide/.test(stub),
      `what it defined must survive its body:${NL}${stub.slice(0, 400)}`);
    assert.ok(stub.length < raw.length / 5,
      `the residue must stay far smaller than the body (${stub.length} vs ${raw.length})`);
  });

  await test('ADAPT B: detail that did NOT survive is recoverable targeted, not by re-reading', async () => {
    const root = learned();
    const { s, raw } = await afterCompaction(root);
    // The stub names `budgetChars` but not what it DOES. That is the question a
    // follow-up asks, and the worker answers it without replaying the file.
    assert.ok(!s.messages[2].content.includes('return pc * 2'), 'the implementation is genuinely gone');
    const tools = require('../../src/tools');
    const one = await tools.execute('read_symbol', { path: 'session.js', name: 'budgetChars' }, { cwd: root });
    assert.ok(!one.isError && /return pc \* 2/.test(one.output), 'the worker rehydrates the definition');
    assert.ok(one.output.length < raw.length / 5, 'and it costs a fraction of the file');
  });

  await test('ADAPT C: the ledger reports WHICH state it is in, and never claims a body it lost', async () => {
    const { s } = await afterCompaction(learned());
    const d = s.evidence.digest(6);
    assert.ok(/elided/i.test(d) && /session\.js/.test(d),
      `the model must be told the body is gone:${NL}${d}`);
    assert.ok(!/Already inspected this session/.test(d),
      'and must NOT be told it is still inspected content');
    assert.ok(/read_symbol|check_symbols/.test(d), 'the cheap route must be named');
  });

  await test('ADAPT D: QUALITY — when the cheap evidence is not enough, the full read is still served', async () => {
    const root = learned();
    const { s, raw } = await afterCompaction(root);
    assert.strictEqual(s.evidence.check('read_file', { path: 'session.js' }), null,
      'nothing may block the read');
    const tools = require('../../src/tools');
    const again = await tools.execute('read_file', { path: 'session.js' }, { cwd: root });
    assert.ok(!again.isError, 'a genuine need for the whole file must be answerable');
    assert.strictEqual(again.output.length, raw.length, 'and it comes back whole, not a summary');
  });

  await test('CTX: eliding a SEARCH retracts nothing — it never claimed content was in context', () => {
    const s = new Session({ cwd: process.cwd() });
    s.messages.push({ role: 'user', content: 'find it' });
    for (let i = 0; i < 20; i++) {
      s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `g${i}`, name: 'grep', arguments: '{"pattern":"x"}' }] });
      s.messages.push({ role: 'tool', tool_call_id: `g${i}`, content: 'z'.repeat(9000) });
    }
    const before = s.evidence.size();
    s.compact({ force: true });
    assert.strictEqual(s.evidence.size(), before, 'a stubbed grep must not disturb the ledger');
  });

  await test('CTX: a conversation that already fits is left completely alone', () => {
    const s = longSession(2, 300);
    const copy = JSON.stringify(s.messages);
    const r = s.compact({ budgetChars: 500_000 });
    assert.strictEqual(r.compacted, false);
    assert.strictEqual(JSON.stringify(s.messages), copy, 'nothing may be touched below the budget');
  });

  await test('CTX: small tool results are not replaced by a longer stub', () => {
    const s = new Session({ cwd: process.cwd() });
    s.messages.push({ role: 'user', content: 'go' });
    for (let i = 0; i < 30; i++) {
      s.messages.push({ role: 'assistant', content: 'x', tool_calls: [{ id: `c${i}`, name: 'grep', arguments: '{}' }] });
      s.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'ok' });
    }
    s.compact({ budgetChars: 100, force: true });
    const shortOnes = s.messages.filter((m) => m.role === 'tool' && m.content === 'ok');
    assert.strictEqual(shortOnes.length, 30, `a ${TOOL_STUB_MIN}-char floor exists so compaction never makes the payload bigger`);
  });

  await test('CTX: compaction is IDEMPOTENT — running it twice changes nothing further', () => {
    const s = longSession(40);
    s.compact({ budgetChars: 50_000 });
    const once = JSON.stringify(s.messages);
    const r = s.compact({ budgetChars: 50_000, force: true });
    assert.strictEqual(JSON.stringify(s.messages), once);
    assert.strictEqual(r.compacted, false, 'an already-compacted conversation has nothing left to elide');
  });

  await test('CTX: even a huge RECENT read is elided rather than sent and refused', () => {
    // One `read_file` of a 400KB file can exceed the window on its own. Keeping
    // the working set whole is a preference, not a promise.
    const s = new Session({ cwd: process.cwd() });
    s.messages.push({ role: 'user', content: 'read it' });
    for (let i = 0; i < 4; i++) {
      s.messages.push({ role: 'assistant', content: 'reading', tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: '{"path":"big.js"}' }] });
      s.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(120_000) });
    }
    const r = s.compact({ budgetChars: 150_000 });
    assert.ok(r.after <= 150_000, `${r.after} chars — the recent set alone was over the window and was not trimmed`);
    assert.ok(protocolIsValid(s.messages));
  });

  await test('CTX: a single result BIGGER than the window is truncated, not stubbed away', () => {
    // One read of a huge file used to be sent whole and refused. The model must
    // still get the part that answers its question — the head — plus a clear
    // statement that there is more and how to reach it.
    const s = new Session({ cwd: process.cwd() });
    s.messages.push({ role: 'user', content: 'read the log' });
    s.messages.push({ role: 'assistant', content: 'reading', tool_calls: [{ id: 'c0', name: 'read_file', arguments: '{"path":"huge.log"}' }] });
    s.messages.push({ role: 'tool', tool_call_id: 'c0', content: 'FIRST LINE MATTERS\n' + 'x'.repeat(400_000) });
    const r = s.compact({ budgetChars: 40_000 });
    assert.ok(r.after <= 40_000, `${r.after} chars — a single oversized result still overflows the window`);
    const body = s.messages[2].content;
    assert.match(body, /^FIRST LINE MATTERS/, 'the head of the result must survive — that is where the answer usually is');
    assert.match(body, /more chars/, 'and the model must be told there is more');
    assert.match(body, /Read a range|narrow the search/, 'and how to get to it');
  });

  // ------------------------------------------------------------- budget ----

  await test('CTX: the budget reserves room for the reply and the system prompt', () => {
    const budget = budgetChars({ ctx: 128000, maxTokens: 4096 });
    assert.ok(budget > 0);
    // Whatever the char/token ratio, the conversation may never claim the whole
    // window: the reply and the tool schemas have to fit beside it.
    assert.ok(budget < 128000 * 4, `${budget} leaves no room for the response`);
  });

  await test('CTX: an explicit override wins over advertised metadata', () => {
    const prev = process.env.LAIN_CONTEXT_CHARS;
    process.env.LAIN_CONTEXT_CHARS = '6000';
    try {
      assert.strictEqual(budgetChars({ ctx: 200000, maxTokens: 8192 }), 6000);
    } finally {
      if (prev === undefined) delete process.env.LAIN_CONTEXT_CHARS;
      else process.env.LAIN_CONTEXT_CHARS = prev;
    }
  });
};
