'use strict';

/**
 * THE CONVERSATION MUST NEVER VANISH FROM THE SCREEN.
 *
 * Reported twice, from a live session: "LAIN's visible CONTEXT suddenly becomes
 * completely EMPTY / BLANK" while the model is still working.
 *
 * ------------------------------------------------------------------------
 * THE OWNERSHIP RULE, and it is already written down in ui/story.endTurn:
 *
 *     "runTurn appends the turn to session.turns before it yields done, so
 *      there is no frame in which both are absent"
 *
 * The Context pane is drawn from TWO sources: the LIVE story while a turn runs,
 * and `session.turns` once it has ended. `endTurn()` clears the live half. If a
 * turn ends without having written the persisted half, both are empty at the
 * same instant — and the screen shows a task banner over nothing, with the
 * user's own sentence gone.
 *
 * TWO ENDINGS SKIPPED IT: the no-credential exit and the circuit-breaker exit
 * both yielded `done` and returned without recording anything. Measured:
 * `turns 0 -> 0`.
 *
 * These tests hold the invariant rather than the two instances of it, because
 * the next ending added to that loop will be written by someone who has not
 * read this file.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const { Session } = require('../../src/session');
const { runTurn } = require('../../src/turn');
const contextfit = require('../../src/contextfit');
const providerLimits = require('../../src/providerlimits');

/** Run a turn to completion and report what the session ended up holding. */
async function drain(session, input, opts = {}) {
  const events = [];
  for await (const ev of runTurn(session, input, opts)) events.push(ev.type);
  return events;
}

module.exports = async function () {
  await test('TRANSCRIPT: every ending records the turn before it says done', async () => {
    // THE INVARIANT, tested through the ending that broke it. With no provider
    // configured the turn ends immediately — and must still leave something on
    // screen, because the user typed a sentence and deserves to see it.
    const s = new Session({ cwd: process.cwd() });
    const events = await drain(s, 'hello', { cfg: {} });
    assert.ok(events.includes('done'), 'the turn must end');
    assert.strictEqual(s.turns.length, 1,
      'an ending that records nothing blanks the Context the moment the live story clears');
    assert.strictEqual(s.turns[0].userInput, 'hello', 'and what the USER said must be in it');
    assert.strictEqual(s.turns[0].stopReason, 'no-credential', 'named honestly');
  });

  await test('TRANSCRIPT: no exit in the turn loop yields `done` without recording', () => {
    // A STRUCTURAL CHECK, because the failure is invisible at runtime unless
    // that exact path is taken — and two of them were. Every `yield { type:
    // 'done'` must have a `remember` above it in the same function.
    const src = fs.readFileSync(require.resolve('../../src/turn.js'), 'utf8');
    const lines = src.split('\n');
    const problems = [];
    lines.forEach((line, i) => {
      if (!/yield \{ type: 'done'/.test(line)) return;
      // Look back a little way for the record. The window is generous: what is
      // being checked is that the call is THERE on this path, not where.
      const above = lines.slice(Math.max(0, i - 12), i).join('\n');
      if (!/turnclose\.close\(/.test(above)) {
        problems.push(`turn.js:${i + 1} yields done with no turnclose.close above it`);
      }
    });
    assert.deepStrictEqual(problems, [], problems.join('\n'));
  });

  await test('ALIASING: fitting the provider payload does not touch the transcript', () => {
    // . `contextfit` compacts `session.messages` so the request
    // will be accepted; the human transcript is `session.turns` and is a
    // different thing. If they ever alias, a provider limit becomes a blank
    // screen — which is the report.
    const s = new Session({ cwd: process.cwd() });
    for (let i = 0; i < 500; i++) {
      s.messages.push({ role: 'user', content: `ask ${i}` });
      s.messages.push({ role: 'assistant', content: `answer ${i}` });
      s.turns.push({ turnId: `t${i}`, userInput: `ask ${i}`, text: `answer ${i}`, actions: [], narration: [] });
    }
    const pc = { provider: 'omniroute', connectionId: 'omniroute', ctx: 128000, maxTokens: 4096 };
    assert.strictEqual(providerLimits.limitsFor(pc, {}).messages, 800, 'this route really does cap messages');

    const turnsRef = s.turns;
    const firstTurn = s.turns[0];
    const beforeMessages = s.messages.length;

    const out = contextfit.fit(s, pc, { systemPrompt: 'SYS', cfg: {} });

    // THE PAYLOAD SHRANK — that is the point of the operation.
    assert.ok(s.messages.length < beforeMessages,
      `the provider payload must be reduced (${beforeMessages} -> ${s.messages.length})`);
    assert.ok(out.wire.length <= 800, `the wire must fit the cap, got ${out.wire.length}`);

    // AND THE TRANSCRIPT IS UNTOUCHED — same array object, same first entry.
    assert.strictEqual(s.turns, turnsRef, 'the transcript array must not be replaced');
    assert.strictEqual(s.turns.length, 500, 'nor emptied');
    assert.strictEqual(s.turns[0], firstTurn, 'nor rebuilt');
    assert.strictEqual(s.turns[0].text, 'answer 0', 'and its contents must survive intact');
  });

  await test('ALIASING: the wire array is a COPY, not the session\'s own', () => {
    // If the provider payload were the same array, anything the transport did
    // to it — and any later compaction — would edit the session underneath the
    // renderer.
    const s = new Session({ cwd: process.cwd() });
    s.messages.push({ role: 'user', content: 'one' });
    const out = contextfit.fit(s, { provider: 'mock', connectionId: 'mock', ctx: 128000 },
      { systemPrompt: 'SYS', cfg: {} });
    assert.notStrictEqual(out.wire, s.messages, 'the wire must not alias session.messages');
    out.wire.length = 0;
    assert.strictEqual(s.messages.length, 1, 'and truncating it must not empty the session');
  });

  await test('ISOLATION: two sessions never share a messages array', () => {
    // Re-checked after the context changes, as the design asks.
    const a = new Session({ cwd: process.cwd() });
    const b = new Session({ cwd: process.cwd() });
    assert.notStrictEqual(a.messages, b.messages);
    assert.notStrictEqual(a.turns, b.turns);
    a.messages.push({ role: 'user', content: 'only in A' });
    a.turns.push({ turnId: 'x', userInput: 'only in A', text: '', actions: [] });
    assert.strictEqual(b.messages.length, 0, 'B must not see A\'s conversation');
    assert.strictEqual(b.turns.length, 0, 'nor A\'s transcript');
  });
};
