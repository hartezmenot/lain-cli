'use strict';

/**
 * The turn loop against the real session, real tool registry and real
 * filesystem. Only the network boundary is the mock.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');

function freshModules(home) {
  process.env.LAIN_CONFIG_DIR = home;
  process.env.LAIN_PROVIDER = 'mock';
  for (const m of ['../../src/config', '../../src/session', '../../src/mockprovider', '../../src/provider', '../../src/turn']) {
    delete require.cache[require.resolve(m)];
  }
  return {
    Session: require('../../src/session').Session,
    runTurn: require('../../src/turn').runTurn,
    mock: require('../../src/mockprovider'),
  };
}

async function drain(gen) {
  const events = [];
  let record = null;
  for await (const ev of gen) {
    events.push(ev);
    if (ev.type === 'done') record = ev.record;
  }
  return { events, record };
}

/**
 * THE RETRY SCHEDULE IS REAL; THE WAITING IS NOT.
 *
 * backoff.js totals about nineteen minutes across ten attempts, which is right
 * for a provider and impossible for a test — driving an outage to exhaustion
 * for real made this file take nineteen minutes and look exactly like a hang.
 *
 * This replaces ONLY the sleeping. Every attempt still happens, in order, with
 * the production schedule, and `waited` records what the delays would have been
 * so a test can assert them.
 */
function fastTimers() {
  const waited = [];
  return {
    waited,
    setTimeout: (fn, ms) => { waited.push(ms); return setTimeout(fn, 0); },
    clearTimeout,
  };
}

module.exports = async function () {
  await test('a turn ending in narration still reports its FULL tool count', async () => {
    // THE V1 BUG: the final step had zero tool calls, so a turn that ran three
    // tools and closed with "Step 2 complete, I'll continue" was scored as a
    // no-progress narration turn.
    const home = tmpdir('lain-turn-');
    process.env.LAIN_MOCK_SCRIPT = writeScript(home, [
      { text: 'Writing.', tool_calls: [{ name: 'write_file', input: { path: 'a.txt', content: 'A' } }] },
      { text: 'Reading.', tool_calls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
      { text: 'Listing.', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
      { text: 'Step 2 is complete. I will continue with step 3.' },
    ]);
    const { Session, runTurn, mock } = freshModules(home);
    mock._reset();
    const s = new Session({ cwd: home });
    const { record } = await drain(runTurn(s, 'do the thing', { cfg: { model: 'mock-model' } }));

    assert.strictEqual(record.toolCalls, 3, 'turn-wide tool count');
    assert.strictEqual(record.steps, 4, 'four model steps');
    assert.strictEqual(record.stopReason, 'end');
    assert.deepStrictEqual(record.toolNames.sort(), ['list_dir', 'read_file', 'write_file']);
    assert.strictEqual(record.mutations.length, 1, 'one file mutated');
    assert.ok(/continue with step 3/i.test(record.text), 'closing narration captured');
  });

  await test('the tool protocol is persisted into session.messages', async () => {
    const home = tmpdir('lain-turn-');
    process.env.LAIN_MOCK_SCRIPT = writeScript(home, [
      { text: 'Looking.', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
      { text: 'Done.' },
    ]);
    const { Session, runTurn, mock } = freshModules(home);
    mock._reset();
    const s = new Session({ cwd: home });
    await drain(runTurn(s, 'look', { cfg: {} }));

    const asst = s.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    const toolMsg = s.messages.find((m) => m.role === 'tool');
    assert.ok(asst, 'an assistant message carries tool_calls');
    assert.ok(toolMsg, 'a tool result message exists');
    assert.strictEqual(toolMsg.tool_call_id, asst.tool_calls[0].id, 'result is matched to its call by id');
  });

  await test('every tool call gets a result message, even when the tool fails', async () => {
    const home = tmpdir('lain-turn-');
    process.env.LAIN_MOCK_SCRIPT = writeScript(home, [
      { text: 'Reading a missing file.', tool_calls: [{ name: 'read_file', input: { path: 'nope.txt' } }] },
      { text: 'That failed.' },
    ]);
    const { Session, runTurn, mock } = freshModules(home);
    mock._reset();
    const s = new Session({ cwd: home });
    const { record } = await drain(runTurn(s, 'read nope', { cfg: {} }));
    const toolMsg = s.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'failed call still answered');
    assert.strictEqual(toolMsg.isError, true);
    assert.strictEqual(record.toolCalls, 1, 'a failed call is still a call');
    assert.ok(record.errors.some((e) => e.kind === 'TOOL'));
  });

  await test('an unknown tool name is a recoverable result, not a crash', async () => {
    const home = tmpdir('lain-turn-');
    process.env.LAIN_MOCK_SCRIPT = writeScript(home, [
      { text: 'Trying.', tool_calls: [{ name: 'no_such_tool', input: {} }] },
      { text: 'Picking another.' },
    ]);
    const { Session, runTurn, mock } = freshModules(home);
    mock._reset();
    const s = new Session({ cwd: home });
    const { record } = await drain(runTurn(s, 'go', { cfg: {} }));
    const toolMsg = s.messages.find((m) => m.role === 'tool');
    assert.ok(/unknown tool/.test(toolMsg.content));
    assert.ok(/read_file/.test(toolMsg.content), 'tells the model what does exist');
    assert.strictEqual(record.stopReason, 'end');
  });

  await test('a provider outage is REPORTED, never thrown, and the record survives', async () => {
    const home = tmpdir('lain-turn-');
    // AN OUTAGE THAT NEVER LIFTS. The retry budget has grown twice — 2, then
    // 5, now 10 — and each time a fixture that used to exhaust it stopped
    // doing so, the mock answered normally, and this test failed reporting
    // 'end' for a provider that was meant never to come back. Fourteen
    // refusals against a budget of ten, so the arithmetic has room.
    const dead = { error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:20128' } };
    process.env.LAIN_MOCK_SCRIPT = writeScript(home, Array.from({ length: 14 }, () => dead));
    const { Session, runTurn, mock } = freshModules(home);
    mock._reset();
    const s = new Session({ cwd: home });
    // ---- THE WAITING IS INJECTED; THE POLICY IS NOT ---------------------
    //
    // The retry schedule is ten attempts totalling about nineteen minutes
    // (backoff.js). Driving an outage to exhaustion for real would make this
    // test take nineteen minutes and look exactly like a hang — it did, once.
    //
    // `timers` replaces only the sleeping. The attempt COUNT, the schedule and
    // every decision around it are the production ones, which is what this
    // test is actually about.
    const timers = fastTimers();
    const waited = timers.waited;
    const { events, record } = await drain(runTurn(s, 'anything', { cfg: {}, timers }));

    assert.ok(record, 'a done event with a record was still emitted');
    assert.strictEqual(record.stopReason, 'provider');
    assert.ok(events.some((e) => e.type === 'provider_failure'), 'failure reported as an event');
    assert.strictEqual(record.providerFailure.kind, 'UNAVAILABLE');
    assert.ok(record.usage.requests >= 2, 'bounded retry actually retried');
    // AND IT WAITED THE REAL SCHEDULE, in order, rather than a test-only one.
    assert.deepStrictEqual(waited.slice(0, 4), [10_000, 15_000, 30_000, 45_000]);
    // BOUNDED: it gives up rather than retrying for ever.
    assert.ok(waited.length <= 10, `${waited.length} retries — the budget is 10`);
  });

  await test('the user message is recorded even when the provider never answers', async () => {
    const home = tmpdir('lain-turn-');
    process.env.LAIN_MOCK_SCRIPT = writeScript(home, [
      { error: { status: 503, message: 'upstream down' } },
      { error: { status: 503, message: 'upstream down' } },
      { error: { status: 503, message: 'upstream down' } },
    ]);
    const { Session, runTurn, mock } = freshModules(home);
    mock._reset();
    const s = new Session({ cwd: home });
    await drain(runTurn(s, 'my important request', { cfg: {}, timers: fastTimers() }));
    assert.strictEqual(s.messages[0].content, 'my important request');
  });

  await test('a COMPLETED turn closes its scratch; a dead one leaves it for whoever resumes', async () => {
    // The scratch lifecycle is the whole design of scratch.js: findings
    // recorded during a turn survive that turn's death, and are spent when
    // it completes. turn.js opens it before any work; turnclose closes it
    // on stopReason 'end' and on nothing else.
    const scratch = require('../../src/scratch');

    // COMPLETION: text-only final step, stopReason 'end', scratch deleted.
    const ok = tmpdir('lain-scratch-ok-');
    process.env.LAIN_MOCK_SCRIPT = writeScript(ok, [{ text: 'Done.' }]);
    const fresh1 = freshModules(ok);
    fresh1.mock._reset();
    const s1 = new fresh1.Session({ cwd: ok });
    const { record: r1 } = await drain(fresh1.runTurn(s1, 'finish this', { cfg: {} }));
    assert.strictEqual(r1.stopReason, 'end');
    assert.ok(!scratch.notes(ok, s1.id).length && !require('fs').existsSync(require('../../src/lainstore').scratchDir(ok, s1.id)),
      'a completed turn leaves no scratch behind');

    // DEATH: the provider never answers, and the scratch — opened before the
    // first request, with the goal — is exactly what survives.
    const dead = tmpdir('lain-scratch-dead-');
    // FOURTEEN, because the budget is TEN. Eight refusals no longer exhaust it
    // — the script ran out, the mock answered normally, and the turn ended with
    // stopReason 'end' when this test is about what happens when it does not.
    // The same arithmetic bit the outage test above when the budget moved.
    process.env.LAIN_MOCK_SCRIPT = writeScript(dead,
      Array.from({ length: 14 }, () => ({ error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:20128' } })));
    const fresh2 = freshModules(dead);
    fresh2.mock._reset();
    const s2 = new fresh2.Session({ cwd: dead });
    const { record: r2 } = await drain(fresh2.runTurn(s2, 'the unfinished goal', { cfg: {}, timers: fastTimers() }));
    assert.strictEqual(r2.stopReason, 'provider');
    const orphans = scratch.orphans(dead);
    assert.deepStrictEqual(orphans.map((o) => o.session), [s2.id], 'the dead turn\'s scratch is an orphan');
    assert.strictEqual(orphans[0].goal, 'the unfinished goal',
      'the goal the turn was opened with is what the next model reads');
  });

  await test('no credential costs ZERO requests', async () => {
    const home = tmpdir('lain-turn-');
    delete process.env.LAIN_PROVIDER;
    delete process.env.LAIN_MOCK_SCRIPT;
    const savedA = process.env.ANTHROPIC_API_KEY; const savedO = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
    process.env.LAIN_CONFIG_DIR = home;
    for (const m of ['../../src/config', '../../src/session', '../../src/provider', '../../src/turn']) delete require.cache[require.resolve(m)];
    const { Session } = require('../../src/session');
    const { runTurn } = require('../../src/turn');
    const s = new Session({ cwd: home });
    const { events, record } = await drain(runTurn(s, 'hello', { cfg: {} }));
    assert.strictEqual(record.stopReason, 'no-credential');
    assert.strictEqual(record.usage.requests, 0, 'must not spend a request');
    assert.ok(events.some((e) => e.type === 'notice' && /No provider configured/.test(e.message)));
    if (savedA) process.env.ANTHROPIC_API_KEY = savedA;
    if (savedO) process.env.OPENAI_API_KEY = savedO;
  });

  await test('files are really written to disk by the real fs tool', async () => {
    const home = tmpdir('lain-turn-');
    process.env.LAIN_MOCK_SCRIPT = writeScript(home, [
      { text: 'Writing.', tool_calls: [{ name: 'write_file', input: { path: 'out/real.txt', content: 'on disk' } }] },
      { text: 'Written.' },
    ]);
    const { Session, runTurn, mock } = freshModules(home);
    mock._reset();
    const s = new Session({ cwd: home });
    await drain(runTurn(s, 'write it', { cfg: {} }));
    assert.strictEqual(fs.readFileSync(path.join(home, 'out', 'real.txt'), 'utf8'), 'on disk');
  });
};
