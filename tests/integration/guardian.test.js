'use strict';

/**
 * THE RUNTIME AUTHORITY — proved against a REAL supervisor, not a mock.
 *
 * ------------------------------------------------------------------------
 * EVERY TEST HERE IS A FAILURE THAT ACTUALLY HAPPENED. They are not coverage of
 * a new module; they are the specific ways LAIN used to lose things, written
 * down so they cannot come back quietly.
 *
 *   INPUT HELD       a turn died, the person typed `continue`, and Node sent the
 *                    literal word `continue` to a replacement model that then
 *                    re-read the whole repository to work out what it meant.
 *   INPUT SURVIVES   the sentence lived in a JavaScript array on an App object,
 *                    so the process that lost the turn also lost the sentence.
 *   TURN LOST        Node was killed mid-turn. It wrote no ending, so the
 *                    session file described a turn still happily in flight and
 *                    nothing anywhere knew otherwise.
 *   MODEL SWITCHED   a different model started answering and nothing recorded
 *                    that a boundary had been crossed.
 *   CANCELLED        the one bad-looking ending that must NOT trigger recovery.
 *   ONE AUTHORITY    Rust and Node must not both hold the same fact.
 *
 * ------------------------------------------------------------------------
 * A REAL PROCESS, AND A REAL DEATH. The `TURN LOST` test starts a second Node
 * process, has it declare a turn, and KILLS it — because the whole question is
 * what a supervisor believes about a client that is no longer there, and no
 * amount of in-process arrangement can ask that question.
 *
 * THEY SKIP THEMSELVES when the Rust binary is not built. LAIN is a
 * zero-dependency Node program and its suite may not become conditional on a
 * toolchain; the skip is DECLARED rather than silent, because a guarantee that
 * quietly stopped being checked is not a guarantee.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { test } = require('../helpers');
const supervisor = require('../../src/supervisor');
const guardian = require('../../src/guardian');
const handover = require('../../src/handover');

const ROOT = path.join(__dirname, '..', '..');

/** A private LAIN home, so a test never touches the user's real supervisor. */
function isolate(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lain-guard-${tag}-`));
}

/**
 * Run inside a private home, AND TAKE THE SUPERVISOR DOWN AFTERWARDS WHATEVER
 * HAPPENS.
 *
 * The `finally` is not tidiness. Every one of these tests starts a real detached
 * process that is built precisely so that its client dying does not stop it —
 * so a test that fails BEFORE its own `shutdown()` line leaves one running for
 * the rest of the machine's uptime. Measured while writing these: one afternoon
 * of iterating produced 354 orphaned supervisors, which between them held the
 * debug binary open and made `cargo build` fail with "Access is denied" — a
 * build failure with no apparent connection to its cause.
 *
 * So the shutdown belongs here, where it runs on the failure path too, and the
 * per-test calls are the ordinary case rather than the guarantee.
 */
async function withHome(home, fn) {
  const prev = process.env.LAIN_HOME;
  process.env.LAIN_HOME = home;
  // The Node client caches nothing across homes except the hot mirror, which is
  // a display cache — cleared so one test's snapshot cannot be read as another's.
  guardian.forgetLocal();
  try { return await fn(); } finally {
    // Shutting down does NOT kill any worker — that is the supervisor's whole
    // contract, and it is what makes this safe to do unconditionally.
    try { await supervisor.shutdown(); } catch { /* none was started */ }
    guardian.forgetLocal();
    if (prev === undefined) delete process.env.LAIN_HOME; else process.env.LAIN_HOME = prev;
  }
}

/**
 * Poll a READ until it answers.
 *
 * READ-ONLY, and the name says so because the first version of this file did not
 * observe the rule: it polled `guardian.offer` — which HOLDS the sentence it is
 * asking about — and each retry parked another copy. Seven held messages where
 * one was expected, and the test was measuring its own helper.
 *
 * Every wait here is now on `guardian.state`, and the mutating call is made once
 * afterwards. That is also what the real caller does, so the test exercises the
 * shape the product has rather than one invented to make waiting easy.
 */
function untilRead(fn, ms = 20000, step = 100) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = async () => {
      let v = null;
      try { v = await fn(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, step);
    };
    tick();
  });
}

/** The runtime's view of a session, once it says `want`. */
function settled(session, want) {
  return untilRead(async () => {
    const st = await guardian.state(session);
    return st && (!want || want(st)) ? st : null;
  });
}

module.exports = async function () {
  const probe = supervisor.probe();
  if (!probe.available) {
    await test('GUARDIAN: skipped — the Rust binary is not built', () => {
      assert.ok(probe.why.includes('cargo build'), probe.why);
    });
    return;
  }

  // ---- INPUT HOLD --------------------------------------------------------

  await test('GUARDIAN: a healthy session sends what you typed, untouched', async () => {
    const home = isolate('ok');
    await withHome(home, async () => {
      await supervisor.ensure();
      guardian.turnBegin('s-ok', { model: 'm', provider: 'p', connectionId: 'c' });
      guardian.turnEnd('s-ok', { outcome: 'completed' });
      // The client chains a session's calls, so this read is already behind both
      // writes — the wait is for the socket, not for an ordering the runtime
      // does not guarantee. See `ordered` in src/guardian.js.
      const done = await settled('s-ok', (st) => st.state === 'COMPLETED');
      assert.ok(done, 'the runtime recorded the ending');
      const v = await guardian.offer('s-ok', 'and now the tests', { kind: 'user' });
      assert.ok(v.available, 'the supervisor answered');
      assert.strictEqual(v.deliver, true, 'nothing is in the way of an ordinary sentence');
      assert.strictEqual(v.reason, '');
      await supervisor.shutdown();
    });
  });

  await test('GUARDIAN: after a provider failure, `continue` is HELD and never sent bare', async () => {
    const home = isolate('hold');
    await withHome(home, async () => {
      await supervisor.ensure();
      guardian.turnBegin('s-h', { model: 'claude-opus-5', provider: 'anthropic', connectionId: 'c1' });
      guardian.turnEnd('s-h', { outcome: 'provider', kind: 'PROVIDER_DOWN', reason: '502 from the gateway' });
      assert.ok(await settled('s-h', (st) => st.state === 'PROVIDER_FAILED'), 'the failure was recorded');
      const held = await guardian.offer('s-h', 'continue', { kind: 'user' });
      assert.strictEqual(held.deliver, false,
        'the runtime must refuse to pass a bare sentence into a dead turn');
      assert.match(held.reason, /^PROVIDER_FAILED/, 'and say WHICH failure, not merely that there was one');
      assert.match(held.reason, /502/, 'carrying the provider\'s own words');

      // AND THE SENTENCE IS ON DISK, not in a JavaScript array on an App.
      const pend = await guardian.pending('s-h');
      assert.strictEqual(pend.held.length, 1);
      assert.strictEqual(pend.held[0].text, 'continue');
      await supervisor.shutdown();
    });
  });

  await test('GUARDIAN: the held sentence survives the supervisor being restarted', async () => {
    // The property the JavaScript array never had. A steer lost to a crash is
    // the defect this whole mechanism was built out of.
    const home = isolate('durable');
    await withHome(home, async () => {
      await supervisor.ensure();
      guardian.turnBegin('s-d', { model: 'm' });
      guardian.turnEnd('s-d', { outcome: 'provider', reason: 'the socket closed' });
      await settled('s-d', (st) => st.state === 'PROVIDER_FAILED');
      const v = await guardian.offer('s-d', 'carry on where you left off', { kind: 'user' });
      assert.strictEqual(v.deliver, false);
      await supervisor.shutdown();
      await untilRead(() => (supervisor.probe().running ? null : true));

      await supervisor.ensure();
      const pend = await guardian.pending('s-d');
      assert.strictEqual(pend.held.length, 1, 'a restart must not lose what was typed');
      assert.strictEqual(pend.held[0].text, 'carry on where you left off');
      assert.ok(pend.state.needs_handover, 'and it is still owed a briefing');
      await supervisor.shutdown();
    });
  });

  await test('GUARDIAN: taking the input is the ONLY thing that empties the queue', async () => {
    const home = isolate('take');
    await withHome(home, async () => {
      await supervisor.ensure();
      guardian.turnBegin('s-t', { model: 'm' });
      guardian.turnEnd('s-t', { outcome: 'provider' });
      await settled('s-t', (st) => st.state === 'PROVIDER_FAILED');
      assert.strictEqual((await guardian.offer('s-t', 'first', {})).deliver, false);
      assert.strictEqual((await guardian.offer('s-t', 'and second', {})).deliver, false);

      // A NEW TURN DOES NOT DROP THEM. Node starting a turn is not evidence that
      // anything reached a model.
      guardian.turnBegin('s-t', { model: 'm' });
      const still = await guardian.pending('s-t');
      assert.strictEqual(still.held.length, 2, 'both, oldest first');
      assert.deepStrictEqual(still.held.map((h) => h.text), ['first', 'and second']);

      const { taken } = await guardian.deliver('s-t');
      assert.strictEqual(taken.length, 2, 'a person who typed twice meant both');
      const after = await guardian.pending('s-t');
      assert.strictEqual(after.held.length, 0);
      await supervisor.shutdown();
    });
  });

  // ---- CANCELLATION ------------------------------------------------------

  await test('GUARDIAN: pressing Ctrl+C does NOT put you through a recovery', async () => {
    // The one bad-looking ending that must not arm a handover. A person who
    // interrupted a turn knows exactly what they stopped; a briefing would spend
    // a request explaining their own decision back to them.
    const home = isolate('abort');
    await withHome(home, async () => {
      await supervisor.ensure();
      guardian.turnBegin('s-a', { model: 'm' });
      guardian.turnEnd('s-a', { outcome: 'aborted' });
      assert.ok(await settled('s-a', (st) => st.state === 'CANCELLED'), 'recorded as cancelled');
      const v = await guardian.offer('s-a', 'do it differently', {});
      assert.strictEqual(v.deliver, true, 'an interrupted turn is not a broken one');
      await supervisor.shutdown();
    });
  });

  // ---- RATE LIMIT --------------------------------------------------------

  await test('GUARDIAN: a rate limit holds input and says so in its own words', async () => {
    const home = isolate('limit');
    await withHome(home, async () => {
      await supervisor.ensure();
      guardian.turnBegin('s-r', { model: 'm', connectionId: 'omniroute-main' });
      guardian.turnEnd('s-r', { outcome: 'rate_limited', kind: 'RATE_LIMITED', reason: 'retry in 4 hours' });
      assert.ok(await settled('s-r', (st) => st.state === 'RATE_LIMITED'), 'the limit was recorded');
      const v = await guardian.offer('s-r', 'keep going', {});
      assert.strictEqual(v.deliver, false, 'the next request would be refused, so the sentence is parked');
      // THE MOST SPECIFIC REASON, not the generic one. A rate limit also arms a
      // handover, and answering HANDOVER_PENDING here would bury the one fact
      // that tells a person when to try again.
      assert.match(v.reason, /^RATE_LIMITED/, `got: ${v.reason}`);
      assert.match(v.reason, /4 hours/);
      await supervisor.shutdown();
    });
  });

  // ---- MODEL SWITCH ------------------------------------------------------

  await test('GUARDIAN: changing model is observed as a boundary without anybody saying so', async () => {
    const home = isolate('switch');
    await withHome(home, async () => {
      await supervisor.ensure();
      guardian.turnBegin('s-m', { model: 'claude-opus-5', provider: 'anthropic' });
      guardian.turnEnd('s-m', { outcome: 'completed' });
      guardian.turnBegin('s-m', { model: 'glm-5.3-flash', provider: 'zai' });
      // ORDERING IS THE POINT OF THIS TEST as much as detection is. These two
      // writes go over separate connections and, unchained, arrive in whatever
      // order the loopback stack chooses — which made this pass about two runs
      // in three before src/guardian.js started chaining a session's calls.
      const st = await settled('s-m', (s) => s.model === 'glm-5.3-flash');
      assert.ok(st && st.handover_pending, 'a failover nobody typed is still a model change');
      assert.strictEqual(st.previous_model, 'claude-opus-5');
      assert.match(st.handover_reason, /claude-opus-5/);
      await supervisor.shutdown();
    });
  });

  // ---- NODE DEATH --------------------------------------------------------

  await test('GUARDIAN: a turn owned by a KILLED process is LOST, not still running', async () => {
    // The case the session file structurally cannot record: a process that is
    // killed writes no ending, so the transcript describes a turn in flight and
    // the only witness is something watching from outside.
    const home = isolate('lost');
    await withHome(home, async () => {
      await supervisor.ensure();

      // A REAL second Node process declares a turn and then dies.
      const script = [
        `process.env.LAIN_HOME=${JSON.stringify(home)};`,
        `const g=require(${JSON.stringify(path.join(ROOT, 'src', 'guardian.js'))});`,
        "g.turnBegin('s-lost',{model:'m',provider:'p'});",
        "g.turnPhase('s-lost','RUNNING_TOOL');",
        // Stay alive long enough for the fire-and-forget writes to land, then
        // announce the pid so the test can wait for the state to exist.
        "setTimeout(()=>{console.log('READY');},600);",
        'setTimeout(()=>{},60000);',
      ].join('');
      const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, LAIN_HOME: home }, stdio: ['ignore', 'pipe', 'ignore'] });
      const ready = await new Promise((resolve) => {
        let buf = '';
        child.stdout.on('data', (d) => { buf += d.toString(); if (buf.includes('READY')) resolve(true); });
        setTimeout(() => resolve(false), 15000);
      });
      assert.ok(ready, 'the child must have declared its turn');

      const running = await settled('s-lost', (st) => st.effective_state === 'TOOL_RUNNING');
      assert.ok(running, 'the runtime knows about the turn');
      assert.strictEqual(running.effective_state, 'TOOL_RUNNING', 'and it is genuinely in flight');
      assert.strictEqual(running.owner_pid, child.pid);

      child.kill('SIGKILL');
      const lost = await settled('s-lost', (st) => st.effective_state === 'LOST');
      assert.ok(lost, 'a turn whose owner is gone is not a turn that is running');
      // THE RECORDED STATE IS PRESERVED. "It says TOOL_RUNNING and nobody is
      // there" is the diagnosis; a single overwritten word would destroy it.
      assert.strictEqual(lost.state, 'TOOL_RUNNING');
      assert.strictEqual(lost.owner_alive, false);

      const v = await guardian.offer('s-lost', 'continue', { kind: 'user' });
      assert.strictEqual(v.deliver, false, 'and `continue` must not be sent into it');
      assert.match(v.reason, /^TURN_LOST/);
      assert.match(v.reason, new RegExp(String(child.pid)), 'naming the process that went away');
      await supervisor.shutdown();
    });
  });

  // ---- THE PACKET --------------------------------------------------------

  await test('GUARDIAN: the packet carries the intent AND says it is not the context', async () => {
    // §2 in one assertion. The replacement model must receive the person's own
    // words, framed by what LAIN observed — and must be told explicitly that the
    // word `continue` is an instruction rather than a description of the task.
    const session = {
      id: 's-p',
      cwd: ROOT,
      turns: [{ model: 'claude-opus-5', stopReason: 'provider', steps: 4, actions: [] }],
      task: { objective: 'wire the dashboard to the live feed', steers: [] },
    };
    const packet = handover.build(session, {
      cwd: ROOT,
      toModel: 'glm-5.3-flash',
      runtime: {
        kind: 'PROVIDER_FAILED',
        reason: 'PROVIDER_FAILED: the previous turn did not finish — 502',
        state: { previous_model: 'claude-opus-5' },
        input: [{ text: 'continue', at: Date.now(), reason: 'PROVIDER_FAILED' }],
      },
    });
    assert.ok(packet, 'a runtime failure alone is enough to earn a packet');
    assert.match(packet, /runtime stopped this message reaching the model/i);
    assert.match(packet, /"continue"/, 'the person\'s own words, quoted rather than paraphrased');
    assert.match(packet, /INTENT of the request/i, 'and named as intent');
    assert.match(packet, /not the context/i);
    assert.match(packet, /do not re-run project orientation/i, 'which is the whole saving');
  });

  await test('GUARDIAN: a packet is built even when the transcript recorded no ending', async () => {
    // THE CASE THE OLD TRIGGER COULD NOT SEE. A killed process writes no
    // `stopReason`, so `session.turns` describes a turn still in flight — and
    // every clause of the old opening reads that as nothing having gone wrong.
    const session = {
      id: 's-q',
      cwd: ROOT,
      turns: [{ model: 'claude-opus-5', stopReason: null, steps: 2, actions: [] }],
      task: { objective: 'migrate the loader', steers: [] },
    };
    const without = handover.build(session, { cwd: ROOT, toModel: 'claude-opus-5' });
    assert.strictEqual(without, '', 'nothing in the session says anything went wrong');

    const withRuntime = handover.build(session, {
      cwd: ROOT,
      toModel: 'claude-opus-5',
      runtime: {
        kind: 'TURN_LOST',
        reason: 'TURN_LOST: the process running the previous turn (pid 4242) is gone',
        state: { previous_model: 'claude-opus-5' },
        input: [{ text: 'continue', at: Date.now(), reason: 'TURN_LOST' }],
      },
    });
    assert.ok(withRuntime, 'but the runtime watched it happen from outside');
    assert.match(withRuntime, /no longer exists/i);
    assert.match(withRuntime, /killed or it crashed/i);
  });

  // ---- ONE AUTHORITY -----------------------------------------------------

  await test('GUARDIAN: Node holds no second copy of the decision', async () => {
    // §23. The hot mirror is a DISPLAY cache and must never be consulted by the
    // gateway: `last()` may be stale by design, and a decision made from it is a
    // second authority free to disagree with the first on the day it matters.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'guardian.js'), 'utf8');
    const offer = src.slice(src.indexOf('async function offer('), src.indexOf('/** What is still held'));
    assert.ok(!/\blast\s*\(/.test(offer), 'the gateway must not read the mirror');
    assert.ok(!/mirror\./.test(offer), 'nor the map behind it');
    // And there is no local re-implementation of the verdict anywhere in Node.
    const gate = fs.readFileSync(path.join(ROOT, 'src', 'inputgate.js'), 'utf8');
    for (const word of ['RATE_LIMITED', 'PROVIDER_FAILED', 'TURN_LOST', 'HANDOVER_PENDING']) {
      // Named, for the sentence a person reads — never compared against a state
      // Node computed for itself.
      assert.ok(gate.includes(word), `${word} is named for the user`);
    }
    // ---- CODE, NOT PROSE ---------------------------------------------------
    //
    // Comments are stripped before the check. The rule is about what the gate
    // DOES, and a file is allowed — encouraged — to explain in words why it does
    // not read the transcript. The first version of this assertion matched the
    // vocabulary rather than the behaviour and failed on a comment saying
    // exactly the right thing, which is a guard training people to delete
    // explanations.
    const code = gate
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(String.fromCharCode(10))
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join(String.fromCharCode(10));
    assert.ok(!/session\.turns|stopReason/.test(code),
      'the gate must not re-derive the turn state from the transcript');
  });

  await test('GUARDIAN: with no supervisor running, everything is delivered as before', async () => {
    // THE HARD RULE. LAIN is a zero-dependency Node program: a missing or
    // stopped supervisor costs it a millisecond and never a person's sentence.
    const home = isolate('degraded');
    await withHome(home, async () => {
      assert.ok(!supervisor.probe().running, 'no supervisor in this home');
      const v = await guardian.offer('s-none', 'continue', { kind: 'user' });
      assert.strictEqual(v.deliver, true, 'absence of a runtime is never a refusal to work');
      assert.strictEqual(v.available, false, 'and it is honest about not having been asked');
      const pend = await guardian.pending('s-none');
      assert.deepStrictEqual(pend.held, []);
      assert.strictEqual(pend.available, false);
    });
  });

  // ---- TOKEN TELEMETRY ---------------------------------------------------

  await test('GUARDIAN: a live figure never becomes part of the total twice', async () => {
    const home = isolate('usage');
    await withHome(home, async () => {
      await supervisor.ensure();
      guardian.noteUsage('s-u', { inputTokens: 42000, cacheReadTokens: 31000 }, { live: true });
      const live = await settled('s-u', (st) => st.usage.live_open);
      assert.strictEqual(live.usage.live_input_tokens, 42000);
      assert.strictEqual(live.usage.input_tokens, 0, 'a reading is not a receipt');
      assert.strictEqual(live.usage.output_is_live, false, 'and output is never advertised as live');

      guardian.noteUsage('s-u', { inputTokens: 42000, outputTokens: 1200, cacheReadTokens: 31000, requests: 1 });
      const done = await settled('s-u', (st) => !st.usage.live_open);
      assert.strictEqual(done.usage.input_tokens, 42000, 'counted exactly once');
      assert.strictEqual(done.usage.output_tokens, 1200);
      assert.strictEqual(done.usage.live_input_tokens, 0, 'and the reading is gone');
      await supervisor.shutdown();
    });
  });

  // ---- THE EVENT STREAM --------------------------------------------------

  await test('GUARDIAN: the runtime records what happened, and not what was typed', async () => {
    const home = isolate('events');
    await withHome(home, async () => {
      await supervisor.ensure();
      guardian.turnBegin('s-e', { model: 'm' });
      guardian.turnEnd('s-e', { outcome: 'provider', reason: 'gateway timeout' });
      await settled('s-e', (st) => st.state === 'PROVIDER_FAILED');
      assert.strictEqual((await guardian.offer('s-e', 'my secret prompt', {})).deliver, false);

      const rows = await guardian.events({ after: 0, limit: 100 });
      const kinds = rows.map((r) => r.kind);
      assert.ok(kinds.includes('TURN_STARTED'));
      assert.ok(kinds.includes('TURN_INTERRUPTED'), 'a failed turn is interrupted, not completed');
      assert.ok(kinds.includes('INPUT_HELD'));
      // THE TEXT IS NOT IN THE LOG. The log is read by people and by tools; a
      // person's prompt is their business and a log that quietly accumulates it
      // is a disclosure nobody agreed to. It lives in the state file, which
      // exists to give it back to them.
      const dump = JSON.stringify(rows);
      assert.ok(!dump.includes('my secret prompt'), 'the event log records that input was held, not what it said');
      const held = rows.find((r) => r.kind === 'INPUT_HELD');
      assert.strictEqual(held.chars, 'my secret prompt'.length, 'only its size');
      // Every row is numbered and resumable — the reconnect path for reasoning.
      assert.strictEqual(rows[0].seq, 1);
      const rest = await guardian.events({ after: rows[0].seq, limit: 100 });
      assert.strictEqual(rest.length, rows.length - 1);
      await supervisor.shutdown();
    });
  });

  // ---- THE REAL LOOP, DRIVING IT ------------------------------------------------
  //
  // Every test above drives the API by hand. This one proves the WIRING: an
  // ordinary turn, run by the real loop against the mock provider, is announced
  // and closed by turn.js and turnclose.js — the runtime's record of it comes
  // from the loop itself and from nowhere else. Before that wiring existed,
  // guardian.rs waited for a `turn_end` that nothing ever sent, so a handover
  // boundary armed by a real failure could never close again.

  await test('GUARDIAN: a REAL turn announces itself and its ending — the loop, not a test', async () => {
    const home = isolate('loop');
    await withHome(home, async () => {
      await supervisor.ensure();
      const script = path.join(home, 'script.json');
      fs.writeFileSync(script, JSON.stringify([{ text: 'Done.' }]), 'utf8');
      process.env.LAIN_PROVIDER = 'mock';
      process.env.LAIN_MOCK_SCRIPT = script;
      try {
        // Fresh turn.js so its mock wiring is read for THIS home.
        for (const m of ['../../src/turn', '../../src/turnclose', '../../src/mockprovider']) {
          delete require.cache[require.resolve(m)];
        }
        const { Session } = require('../../src/session');
        const { runTurn } = require('../../src/turn');
        const s = new Session({ cwd: home });
        for await (const ev of runTurn(s, 'do the thing', { cfg: {} })) { /* drain */ }

        // THE LOOP'S OWN REPORT, settled in the runtime: an ordinary ending is
        // COMPLETED — the word map in turnclose.js turned `end` into `completed`,
        // because guardian.rs's vocabulary and turnrecord's differ by exactly
        // that word, and passing `end` through unread would have filed every
        // finished turn as a failure.
        const done = await settled(s.id, (st) => st.state === 'COMPLETED');
        assert.ok(done, 'the runtime recorded the ending the LOOP reported');
        // And nothing is owed: an ordinary sentence goes straight through.
        const v = await guardian.offer(s.id, 'and now something else', { kind: 'user' });
        assert.strictEqual(v.deliver, true, 'a finished turn holds no boundary open');
      } finally {
        delete process.env.LAIN_PROVIDER;
        delete process.env.LAIN_MOCK_SCRIPT;
      }
      await supervisor.shutdown();
    });
  });
};
