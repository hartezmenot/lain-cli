'use strict';

/**
 * WHAT SURVIVED — compaction and resume.
 *
 * The failure this guards against is a REASSURANCE: printing "✓ decisions
 * preserved" whether or not there were any, which holds up exactly until the
 * model contradicts it. Every line has to be a check against the session as it
 * actually stands, and an absent thing has to read as absent.
 */

const assert = require('assert');
const { test } = require('../helpers');

const continuity = require('../../src/continuity');

const rich = () => ({
  messages: new Array(214),
  turns: new Array(9),
  task: { objective: 'fix the telegram signal toggle', steers: [{ text: 'do not touch the schema' }] },
  plan: { steps: [{ status: 'done' }, { status: 'done' }, { status: 'active' }] },
  lifecycle: {
    evidence: { filesChanged: new Set(['/p/src/a.js', '/p/src/b.js']) },
    lastCommand: { command: 'npm test', ok: false },
  },
});

const bare = () => ({ messages: [], turns: [], task: null, plan: null, lifecycle: null });

module.exports = async function () {
  await test('CONT: compaction says what it did AND what it kept', () => {
    const s = continuity.compactionSummary(rich(), { before: 189000, after: 42000, elided: 147000 });
    assert.match(s.headline, /CONTEXT COMPACTION\s+189k → 42k/);
    const kept = s.kept.join(' · ');
    assert.match(kept, /the objective/);
    assert.match(kept, /1 correction you made/, "the user's own corrections cannot be recovered from the repo");
    assert.match(kept, /the plan \(2\/3 done\)/);
    assert.match(kept, /2 changed files/);
    assert.match(kept, /the last check \(FAILED\)/, 'a red check must stay red through a compaction');
  });

  await test('CONT: a compaction with nothing to keep claims nothing', () => {
    const s = continuity.compactionSummary(bare(), { before: 9000, after: 4000 });
    assert.deepStrictEqual(s.kept, [], 'an empty session has nothing preserved, and says so by saying nothing');
  });

  await test('CONT: resume reports each fact as present or ABSENT, never assumed', () => {
    const rows = continuity.resumeSummary(rich());
    const text = rows.map((r) => `${r.ok ? '+' : '-'} ${r.text}`).join('\n');
    assert.match(text, /\+ 214 messages, 9 turns/);
    assert.match(text, /\+ objective: fix the telegram signal toggle/);
    assert.match(text, /\+ 1 correction you made/);
    assert.match(text, /\+ plan: 2\/3 steps done/);
    assert.match(text, /\+ files changed: a\.js, b\.js/);
    // A failing check comes back FAILING. Reporting it as restored-and-fine is
    // how a red suite becomes finished work across a session boundary.
    assert.match(text, /- last check: npm test — FAILED, and it is still red/);
  });

  await test('CONT: the LATEST user message is never elided, at any size', () => {
    // Compaction rewrites what the model is about to read. Losing the newest
    // thing the user said is the one failure that cannot be recovered from —
    // the model would answer the previous question, confidently.
    const { Session } = require('../../src/session');
    const s = new Session({ cwd: process.cwd() });
    s.messages.push({ role: 'user', content: 'the original objective' });
    for (let i = 0; i < 60; i++) {
      s.messages.push({ role: 'assistant', content: 'x'.repeat(4000), tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: '{}' }] });
      s.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'y'.repeat(8000) });
    }
    const newest = 'THE NEWEST THING THE USER SAID';
    s.messages.push({ role: 'user', content: newest });
    const r = s.compact({ budgetChars: 5000 });
    assert.strictEqual(r.compacted, true, 'it really did have to elide something');
    const last = s.messages[s.messages.length - 1];
    assert.strictEqual(last.content, newest, 'the newest user message must survive intact');
    assert.strictEqual(s.messages[0].content, 'the original objective', 'and so must the objective');
  });

  await test('CONT: resume carries the chat source and the desktop state', () => {
    // A resumed session that has forgotten WHICH MODEL was answering its
    // questions, or whether anything still holds desktop permission, has
    // restored a transcript rather than a context. The first of those used to
    // be "what did the external reviewer conclude"; the relay that produced it
    // went with `/external`, and the durable fact in its place is the session's
    // selected chat source — which, unlike the relay's conclusions, changes what
    // the NEXT question does.
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
    require('../../src/modelsource/registry').selectSource(app, 'chatgpt-web');
    app.session.sourceSelections['chatgpt-web'] = 'gpt-x';
    const text = continuity.resumeSummary(rich(), app).map((r) => `${r.ok ? '+' : '-'} ${r.text}`).join('\n');
    assert.match(text, /chat source: ChatGPT\.com · gpt-x/);
    assert.match(text, /desktop permission: nothing granted/);
  });

  await test('CONT: a session that never chose a source says so as LAIN, not as nothing', () => {
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
    const text = continuity.resumeSummary(rich(), app).map((r) => `${r.ok ? '+' : '-'} ${r.text}`).join('\n');
    assert.match(text, /chat source: LAIN's own runtime/);
  });

  await test('CONT: a restored TRANSCRIPT is not reported as a restored context', () => {
    const rows = continuity.resumeSummary(bare());
    const text = rows.map((r) => `${r.ok ? '+' : '-'} ${r.text}`).join('\n');
    assert.match(text, /- no objective was recorded/);
    assert.match(text, /- no corrections recorded/);
    assert.match(text, /- no plan/);
    assert.match(text, /- no files were changed/);
    assert.match(text, /- no check had been run, so nothing is verified/);
    assert.ok(!/restored|preserved/i.test(text.replace(/^\+ \d+ messages.*$/m, '')),
      'nothing may claim to have been restored when nothing was there');
  });
};
