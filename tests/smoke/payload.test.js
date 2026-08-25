'use strict';

/**
 * WHAT ACTUALLY GOES ON THE WIRE — the only honest answer to "did context
 * management do anything".
 *
 * Every assertion in this file is measured from `LAIN_MOCK_WIRELOG`, which the
 * mock provider appends one line to per request: the message COUNT and the
 * character count of the payload it was handed. Not the persisted session, not
 * the Context pane, not a notice on screen — the array that a provider would
 * have accepted or refused.
 *
 * ------------------------------------------------------------------------
 * THE REPORTED FAILURE, which these reproduce:
 *
 *     413 Payload Too Large — Chat history exceeds the 800-message limit;
 *     compact the conversation and retry.
 *
 * LAIN's pre-flight check measured CHARACTERS and nothing else, so a thousand
 * short messages passed every check it had and were sent anyway. The provider
 * was doing LAIN's counting for it, and the answer arrived as a refusal with a
 * whole turn's work inside the rejected request.
 *
 * LIVE CLI VERIFIED: the real binary, the real session loader, the real turn
 * loop, the real compaction. The network call is the mock.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Every request this run made, as `{ messages, chars }`. */
function wire(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => {
    const [messages, chars] = l.split('\t');
    return { messages: Number(messages), chars: Number(chars) };
  });
}

/**
 * A project holding a saved session with `n` messages already in it.
 *
 * BUILT AS A SESSION FILE rather than by talking to LAIN a thousand times: the
 * failure is about the SIZE of a restored history, and driving the binary
 * through 900 exchanges to reach it would take an hour and prove the same
 * thing. `--resume` then loads it through the real loader.
 */
function projectWithHistory(n, { provider = 'omniroute' } = {}) {
  const cwd = tmpdir('payload-');
  const configDir = path.join(cwd, 'cfg');
  const sessionsDir = path.join(configDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    trustedPaths: [{ path: cwd, level: 'TRUSTED' }],
    // NAMED SO THE LIMIT IS REAL. providerlimits.js knows omniroute caps the
    // message COUNT; a run against a provider with no known cap would prove
    // nothing about the check that matters here.
    providerLimits: { mock: { messages: 800 } },
    _wantProvider: provider,
  }));

  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push({ role: 'user', content: `turn ${i}`, ts: new Date().toISOString() });
    messages.push({ role: 'assistant', content: `ack ${i}`, ts: new Date().toISOString() });
  }
  const id = '20260823-120000-hist';
  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify({
    id, cwd, createdAt: new Date().toISOString(), messages,
    turns: [], usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
  }));
  return { cwd, configDir, id, messageCount: messages.length };
}

module.exports = async function () {
  await test('PAYLOAD: a restored history over the provider cap is COMPACTED BEFORE the send', async () => {
    // THE REPRODUCTION. 1,000 messages, a cap of 800, and the first request of
    // the turn is the one that used to be refused.
    const { cwd, configDir, id, messageCount } = projectWithHistory(500);
    assert.ok(messageCount > 800, `the fixture must exceed the cap (${messageCount})`);
    const log = path.join(cwd, 'wire.log');
    const r = await runCli(['--resume', id, '-p', 'carry on'], {
      cwd, configDir,
      env: { LAIN_MOCK_WIRELOG: log },
      script: [{ text: 'Done.' }],
      timeoutMs: 90000,
    });
    const sent = wire(log);
    assert.ok(sent.length, 'the run must actually have made a request');
    const first = sent[0];
    assert.ok(first.messages <= 800,
      `the FIRST request carried ${first.messages} messages against an 800 cap — `
      + 'LAIN sent a payload it already knew would be refused');
    // AND IT STILL WORKED. Compacting to fit is not the same as giving up.
    assert.match(plain(r.out), /Done\./, 'the turn must still complete');
  });

  await test('PAYLOAD: nothing is compacted when the history is comfortably inside the cap', async () => {
    // The other half of the same rule: a check that fires whatever the size is
    // is not a check, it is a tax on every conversation.
    const { cwd, configDir, id, messageCount } = projectWithHistory(20);
    assert.ok(messageCount < 100);
    const log = path.join(cwd, 'wire.log');
    const r = await runCli(['--resume', id, '-p', 'carry on'], {
      cwd, configDir,
      env: { LAIN_MOCK_WIRELOG: log },
      script: [{ text: 'Fine.' }],
      timeoutMs: 60000,
    });
    const sent = wire(log);
    assert.ok(sent.length);
    // +1 for the system prompt, +1 for the new user message.
    assert.ok(sent[0].messages >= messageCount,
      `a small history must be sent whole (${sent[0].messages} vs ${messageCount})`);
    assert.ok(!/folding the oldest/.test(plain(r.out)), 'and nothing should have been folded');
  });

  await test('PAYLOAD: /clear empties what the PROVIDER receives, not just the screen', async () => {
    // The user's question, asked of the wire: "before /clear provider_messages
    // = N; after /clear provider_messages = 0" — or whatever bootstrap is
    // intentionally kept, which is asserted exactly.
    const cwd = tmpdir('payload-clear-');
    const configDir = path.join(cwd, 'cfg');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      trustedPaths: [{ path: cwd, level: 'TRUSTED' }],
    }));
    const log = path.join(cwd, 'wire.log');
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_MOCK_WIRELOG: log },
      stdinSteps: ['DISTINCTIVE_ALPHA remember this\n', '/clear\n', 'DISTINCTIVE_BETA say something\n', '/exit\n'],
      stepDelayMs: 2000,
      script: [{ text: 'Noted alpha.' }, { text: 'Noted beta.' }],
      timeoutMs: 90000,
    });
    const sent = wire(log);
    assert.ok(sent.length >= 2, `expected two requests, got ${sent.length}`);
    const before = sent[0];
    const after = sent[sent.length - 1];
    // THE SECOND REQUEST MUST NOT CARRY THE FIRST CONVERSATION. Counted, so a
    // partially-cleared history fails too rather than passing on a substring.
    assert.ok(after.messages <= before.messages,
      `after /clear the payload GREW: ${before.messages} → ${after.messages}`);
    // ---- WHAT A CLEARED REQUEST IS MADE OF -------------------------------
    //
    // Three messages, and each one is named so this cannot drift into a bound
    // that quietly permits a carried conversation:
    //
    //   system  the stable prompt, deliberately kept
    //   user    the new question
    //   user    the runtime-state block that rides at the TAIL of every wire
    //           since the prompt was split (see promptparts.js) — small, and
    //           the reason a cleared payload is 3 rather than the old 2
    //
    // EXACT, not `<=`. A cleared session carrying the earlier exchange would be
    // 5; one that silently lost the runtime block would be 2. Both are wrong and
    // both now fail.
    assert.strictEqual(after.messages, 3,
      `after /clear the provider received ${after.messages} messages — expected `
      + 'the system prompt, the new user message, and the runtime-state block');
    assert.match(plain(r.out), /Noted beta/, 'and the next turn still worked');
  });

  await test('PAYLOAD: a 413 that slips through is answered ONCE, with a SMALLER payload', async () => {
    // The fallback, for a limit LAIN did not know in advance. The rule is that
    // the same request is never re-sent unchanged: the second attempt must be
    // measurably smaller, or there was no point making it.
    const { cwd, configDir, id } = projectWithHistory(200);
    const log = path.join(cwd, 'wire.log');
    const r = await runCli(['--resume', id, '-p', 'carry on'], {
      cwd, configDir,
      env: { LAIN_MOCK_WIRELOG: log },
      script: [
        { error: { status: 413, message: 'Chat history exceeds the 800-message limit; compact the conversation and retry.' } },
        { text: 'Recovered.' },
      ],
      timeoutMs: 90000,
    });
    const sent = wire(log);
    assert.ok(sent.length >= 2, `expected a retry, saw ${sent.length} request(s)`);
    assert.ok(sent[1].messages < sent[0].messages,
      `the retry carried ${sent[1].messages} messages against the first ${sent[0].messages} — `
      + 'an unchanged payload would be refused for exactly the same reason');
    assert.match(plain(r.out), /Recovered/, 'and the work continued');
  });

  await test('PAYLOAD: a provider that keeps refusing stops truthfully, without a model-turn loop', async () => {
    const { cwd, configDir, id } = projectWithHistory(200);
    const log = path.join(cwd, 'wire.log');
    const refusal = { error: { status: 413, message: 'Chat history exceeds the 800-message limit; compact the conversation and retry.' } };
    const r = await runCli(['--resume', id, '-p', 'carry on'], {
      cwd, configDir,
      env: { LAIN_MOCK_WIRELOG: log },
      script: [refusal, refusal, refusal, refusal, refusal, refusal],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    const sent = wire(log);
    // BOUNDED. A deterministic refusal must not become a spiral of requests.
    assert.ok(sent.length <= 4, `${sent.length} requests against a deterministic refusal`);
    // AND NAMED FOR WHAT IT IS. Not an interruption, not a tool failure, not a
    // generic outage — the provider refused the size of the request.
    assert.ok(!/MODEL INTERRUPTED/.test(out), 'nobody interrupted it');
    assert.ok(!/CONTINUING|carry-on/i.test(out), 'and nothing manufactured another turn');
  });

  await test('PAYLOAD: a mid-turn steer SURVIVES the compaction that follows it', async () => {
    //: a correction typed while the model is working is a real user message
    // and must not be the thing that compaction throws away.
    const { cwd, configDir, id } = projectWithHistory(500);
    const log = path.join(cwd, 'wire.log');
    const r = await runCli(['--resume', id], {
      cwd, configDir,
      env: { LAIN_MOCK_WIRELOG: log, LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdinSteps: ['start the work\n', 'STEER_KEEP_THIS also check the other file\n', '\n', '/exit\n'],
      stepDelayMs: 2200,
      script: [
        { text: 'Working.', tool_calls: [{ name: 'run_bash', input: { command: 'echo one' } }] },
        { text: 'Still working.', tool_calls: [{ name: 'run_bash', input: { command: 'echo two' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 120000,
    });
    // THE SESSION IS THE RECORD, and the steer must be in it as a USER message
    // rather than as a counter somewhere.
    const dir = path.join(configDir, 'sessions');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const said = (saved.messages || []).filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
    assert.match(said, /STEER_KEEP_THIS/,
      'the correction was folded away by the compaction it triggered');
    assert.ok(wire(log).length, 'and the run really did talk to a provider');
  });

  await test('PAYLOAD: a NEW session in the SAME folder does not inherit the old one', async () => {
    // The user's suspicion, tested on the wire rather than on the object graph:
    // two runs in one directory, and the second must start from nothing.
    const cwd = tmpdir('payload-iso-');
    const configDir = path.join(cwd, 'cfg');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      trustedPaths: [{ path: cwd, level: 'TRUSTED' }],
    }));

    const logA = path.join(cwd, 'a.log');
    await runCli(['-p', 'SESSION_A_MESSAGE'], {
      cwd, configDir,
      env: { LAIN_MOCK_WIRELOG: logA },
      script: [{ text: 'A done.' }],
      timeoutMs: 60000,
    });
    const a = wire(logA);

    const logB = path.join(cwd, 'b.log');
    await runCli(['-p', 'SESSION_B_MESSAGE'], {
      cwd, configDir,
      env: { LAIN_MOCK_WIRELOG: logB },
      script: [{ text: 'B done.' }],
      timeoutMs: 60000,
    });
    const b = wire(logB);

    assert.ok(a.length && b.length, 'both runs must have made a request');
    assert.strictEqual(b[0].messages, a[0].messages,
      `the second session in the same folder started with ${b[0].messages} messages `
      + `where the first started with ${a[0].messages} — history leaked between sessions`);
  });
};
