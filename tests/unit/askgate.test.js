'use strict';

/**
 * ask_user IS A BOUNDARY — the defect, and the fix, as behaviour.
 *
 * The reported symptom was "it says it wants to ask, and then does the work
 * anyway". That is not the model ignoring its own question: a step can carry
 * several tool calls, and the loop ran every one of them — so a call emitted
 * BESIDE the question was performed after the answer arrived, having been
 * decided before it existed.
 */

const assert = require('assert');
const { test } = require('../helpers');

const askgate = require('../../src/askgate');

const call = (name, id) => ({ id: id || `c_${name}`, name, input: {} });

module.exports = async function () {
  await test('ASKGATE: a step with no question is untouched', () => {
    // Almost every step. It must cost nothing and change nothing.
    const calls = [call('read_file'), call('grep'), call('apply_patch')];
    const g = askgate.cut(calls);
    assert.deepStrictEqual(g.run, calls);
    assert.deepStrictEqual(g.deferred, []);
  });

  await test('ASKGATE: everything AFTER the question is deferred', () => {
    // The defect, stated as an assertion: `apply_patch` was emitted in the same
    // breath as the question, so it cannot be a response to the answer.
    const g = askgate.cut([call('read_file'), call('ask_user'), call('apply_patch'), call('run_tests')]);
    assert.deepStrictEqual(g.run.map((c) => c.name), ['read_file', 'ask_user']);
    assert.deepStrictEqual(g.deferred.map((c) => c.name), ['apply_patch', 'run_tests']);
  });

  await test('ASKGATE: a question emitted LAST defers nothing', () => {
    // The shape a well-behaved model produces. There is nothing behind it.
    const g = askgate.cut([call('read_file'), call('ask_user')]);
    assert.deepStrictEqual(g.run.map((c) => c.name), ['read_file', 'ask_user']);
    assert.deepStrictEqual(g.deferred, []);
  });

  await test('ASKGATE: only the FIRST question splits the step', () => {
    // A second question behind the first was also decided before any answer.
    const g = askgate.cut([call('ask_user', 'a'), call('ask_user', 'b')]);
    assert.deepStrictEqual(g.run.map((c) => c.id), ['a']);
    assert.deepStrictEqual(g.deferred.map((c) => c.id), ['b']);
  });

  await test('ASKGATE: every deferred call still gets a result message', () => {
    // NOT tidiness. The calls were persisted with the assistant turn before any
    // of them ran, and an OpenAI-shaped API rejects an assistant message whose
    // tool_calls are not all answered — so a silently skipped call would make
    // the NEXT request a 400.
    const session = { messages: [] };
    const deferred = [call('apply_patch', 'p1'), call('run_tests', 'r1')];
    assert.strictEqual(askgate.answerDeferred(session, deferred), 2);
    assert.strictEqual(session.messages.length, 2);
    assert.deepStrictEqual(session.messages.map((m) => m.tool_call_id), ['p1', 'r1']);
    for (const m of session.messages) {
      assert.strictEqual(m.role, 'tool');
      assert.ok(/NOT RUN/.test(m.content), m.content);
      // NOT an error: nothing went wrong, the call was simply premature.
      assert.strictEqual(m.isError, false);
    }
  });

  await test('ASKGATE: the refusal tells the model to DECIDE AGAIN, not to retry', () => {
    // "Not run" invites the identical call back. The reason is what makes the
    // question worth having asked.
    const said = askgate.deferredResult(call('apply_patch'));
    assert.ok(/decided before the answer existed/.test(said), said);
    assert.ok(/Decide again/.test(said), said);
  });

  await test('ASKGATE: junk in does not throw', () => {
    assert.deepStrictEqual(askgate.cut(null), { run: [], deferred: [] });
    assert.strictEqual(askgate.answerDeferred({ messages: [] }, null), 0);
  });

  await test('ASKGATE: the turn loop actually gates on it', () => {
    // The unit above is arithmetic; this is the wiring. A gate nothing calls is
    // the defect with an extra file.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'turn.js'), 'utf8');
    assert.ok(/askgate\.cut\(/.test(src), 'turn.js splits the step at the question');
    assert.ok(/askgate\.answerDeferred\(/.test(src), 'and answers what it deferred');
    assert.ok(!/for \(const c of normalized\) \{\s*\n\s*if \(signal/.test(src),
      'and no longer iterates the ungated list');
  });
};
