'use strict';

/** task identity · lifecycle/liveness · evidence · plan · availability · connections */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const taskId = require('../../src/task');
const { Lifecycle, STATE } = require('../../src/lifecycle');
const { EvidenceLedger } = require('../../src/evidence');
const { Plan, STATUS } = require('../../src/plan');
const { Availability, STATUS: AV } = require('../../src/availability');
const connections = require('../../src/connections');

module.exports = async function () {
  // ---- task identity: ONE authority -------------------------------------
  const active = { objective: 'fix the bot not trading on startup' };

  await test('TASK: "continue" with an active task is a continuation', () => {
    assert.strictEqual(taskId.classify('continue', { activeTask: active }).kind, taskId.KIND.CONTINUATION);
    assert.strictEqual(taskId.classify('keep going', { activeTask: active }).kind, taskId.KIND.CONTINUATION);
  });

  await test('TASK: "continue" with NO active task is a new task', () => {
    assert.strictEqual(taskId.classify('continue', { activeTask: null }).kind, taskId.KIND.NEW);
  });

  await test('TASK: a paste is NEVER a control word, whatever it starts with', () => {
    const v = taskId.classify('continue', { activeTask: active, isPaste: true });
    assert.strictEqual(v.kind, taskId.KIND.CONTENT);
    const v2 = taskId.classify('continue;\n}\nconst x = 1;', { activeTask: active });
    assert.strictEqual(v2.kind, taskId.KIND.CONTENT, 'multi-line is content too');
  });

  await test('TASK: restating the objective is the SAME task, not a new one', () => {
    // The V1 token burn: a rephrase wiped the read history and restarted from zero.
    const v = taskId.classify('why is the bot not trading', { activeTask: active });
    assert.strictEqual(v.sameTask, true);
    assert.strictEqual(v.kind, taskId.KIND.RESTATEMENT);
  });

  await test('TASK: an unrelated instruction while active is a STEER, not a reset', () => {
    const v = taskId.classify('only fix the UI, leave the trading logic alone', { activeTask: active });
    assert.strictEqual(v.kind, taskId.KIND.STEER);
    assert.strictEqual(v.sameTask, true, 'a steer never discards the task');
  });

  // ---- lifecycle / liveness ---------------------------------------------
  await test('LIFECYCLE: a productive turn ending in narration is NOT no-progress', () => {
    const l = new Lifecycle('build it');
    const v = l.observeTurn({ toolCalls: 10, text: "Step 2 is complete. I'll continue with step 3.", mutated: 2 });
    assert.strictEqual(v.productive, true);
    assert.strictEqual(l.state, STATE.ACTIVE);
  });

  await test('LIFECYCLE: pure narration is COUNTED, and never becomes a verdict', () => {
    // ---- THIS TEST ASSERTED THE OPPOSITE, AND THE ARCHITECTURE CHANGED -----
    //
    // It required that three narration-only turns move the lifecycle to
    // BLOCKED — a TERMINAL state carrying "repeated narration with no action".
    // That was LAIN concluding the model had failed because a counter reached
    // three, and it was the last mechanism in the program with that shape.
    //
    // A count cannot tell "stuck" apart from "thinking aloud through something
    // genuinely hard", or from a user who asked three questions that wanted
    // prose rather than tools — and BLOCKED reads to every surface as "this
    // task is over and it went badly".
    //
    // The COUNT is real accounting and is kept: it feeds diagnostics and the
    // investigation packet, and a caller may still tell the PERSON about it.
    // What it may no longer do is end the task on LAIN's opinion of how the
    // model is working.
    const l = new Lifecycle('build it');
    l.observeTurn({ toolCalls: 0, text: "I'll now continue." });
    l.observeTurn({ toolCalls: 0, text: 'Continuing now.' });
    const third = l.observeTurn({ toolCalls: 0, text: 'Let me proceed.' });

    assert.strictEqual(third.blocked, undefined, 'a counter does not get to declare a verdict');
    assert.strictEqual(third.narrationOnly, true, 'but it is still recognised for what it is');
    assert.strictEqual(third.narrations, 3, 'and still counted, because the accounting is useful');
    assert.strictEqual(l.state, STATE.ACTIVE,
      'the task stays open — the next thing the user or model does decides what happens');
  });

  await test('LIFECYCLE: nothing in the tree can reach BLOCKED from a counter', () => {
    // The stronger form of the same rule. BLOCKED still exists as a state and
    // may still be restored from a saved session, but no threshold anywhere
    // writes it any more.
    const fs = require('fs');
    const path = require('path');
    const src = path.join(__dirname, '..', '..', 'src');
    const offenders = [];
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.js')) continue;
      const text = fs.readFileSync(path.join(src, f), 'utf8');
      const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      if (/\.state\s*=\s*STATE\.BLOCKED/.test(code)) offenders.push(`${f}: assigns STATE.BLOCKED`);
    }
    assert.deepStrictEqual(offenders, [], offenders.join('\n'));
  });

  await test('LIFECYCLE: substantive prose with no tools is NOT a stall', () => {
    const l = new Lifecycle('explain the design');
    const v = l.observeTurn({ toolCalls: 0, text: 'The parser fails because line 42 returns undefined for an empty header.' });
    assert.strictEqual(v.productive, false);
    assert.strictEqual(l.state, STATE.ACTIVE, 'answering a question is not a stall');
  });

  await test('LIVENESS: repeats are detected ACROSS interleaving, not just consecutively', () => {
    // read A, read B, read A, read C, read A  → three identical A reads.
    const l = new Lifecycle('investigate');
    const A = { name: 'read_file', input: { path: 'a.js' }, output: 'SAME' };
    l.observeTool(A);
    l.observeTool({ name: 'read_file', input: { path: 'b.js' }, output: 'B' });
    l.observeTool(A);
    l.observeTool({ name: 'read_file', input: { path: 'c.js' }, output: 'C' });
    const v = l.observeTool(A);
    assert.strictEqual(v.repeated, 3, 'counted across interleaving');
    // AND THE OBSERVER STOPS THERE. It used to hand back a sentence addressed
    // to the model, which turn.js pushed into the conversation as though the
    // user had typed it. What comes back now is the count and the identity of
    // the loop; who gets told is looping.js's decision, and it is the person.
    assert.ok(!('nudge' in v), 'an observer does not compose text for the model');
    assert.ok(v.key, 'the loop is identified, so one advisory can be silenced without silencing all');
    assert.strictEqual(l.state, STATE.ACTIVE, 'and noticing a repeat does not stop the task');
  });

  await test('LIVENESS: a mutation resets the ladder — motion that changes things is progress', () => {
    const l = new Lifecycle('build');
    const A = { name: 'read_file', input: { path: 'a.js' }, output: 'SAME' };
    l.observeTool(A); l.observeTool(A); l.observeTool(A);
    l.observeTool({ name: 'write_file', input: { path: 'a.js' }, output: 'wrote', mutated: ['/tmp/a.js'] });
    assert.strictEqual(l.nudges, 0);
    assert.strictEqual(l.state, STATE.ACTIVE);
  });

  await test('LIFECYCLE: a user correction revives a BLOCKED task', () => {
    const l = new Lifecycle('x');
    l.state = STATE.BLOCKED;
    l.noteUserInput();
    assert.strictEqual(l.state, STATE.ACTIVE, 'the user pushing back is new information');
  });

  await test('LIFECYCLE: completion REQUIRES evidence — "Done." is not enough', () => {
    const l = new Lifecycle('x');
    assert.strictEqual(l.complete().ok, false, 'no evidence, no completion');
    l.observeTool({ name: 'write_file', input: { path: 'a' }, output: 'ok', mutated: ['/tmp/a'] });
    // A WRITTEN FILE IS NOT A FINISHED TASK. This asserted the opposite, and
    // that was the bug: with the plan ticked off, one edit and no check at all
    // completed the task and LAIN stopped one step before the only step that
    // would have proved anything.
    const unverified = l.complete();
    assert.strictEqual(unverified.ok, false, 'a change nobody checked is not finished work');
    assert.strictEqual(unverified.unverified, true);
    assert.notStrictEqual(l.state, STATE.DONE, 'and the lifecycle must not have moved');
    // Running something clean after the change is what finishes it.
    l.observeTool({ name: 'run_bash', input: { command: 'npm test' }, output: '', isError: false, exitCode: 0 });
    assert.strictEqual(l.complete().ok, true);
    assert.strictEqual(l.state, STATE.DONE);
  });

  await test('LIFECYCLE: a task needing no file change can still complete via verification', () => {
    const l = new Lifecycle('confirm the port is free');
    assert.strictEqual(l.complete({ verified: true }).ok, true);
  });

  // ---- evidence ledger: a cache, never a prison --------------------------
  await test('EVIDENCE: an unchanged LARGE whole-file re-read is served from the ledger', () => {
    const dir = tmpdir('lain-ev-');
    const f = path.join(dir, 'big.js');
    fs.writeFileSync(f, Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'));
    const l = new EvidenceLedger(dir);
    assert.strictEqual(l.check('read_file', { path: 'big.js' }), null, 'first read goes through');
    l.observe('read_file', { path: 'big.js' }, { output: 'x', meta: { size: fs.statSync(f).size, mtimeMs: Math.floor(fs.statSync(f).mtimeMs), lines: 400 } });
    const sub = l.check('read_file', { path: 'big.js' });
    assert.ok(sub, 'second identical read is served');
    assert.ok(/already inspected|unchanged/i.test(sub.output));
    assert.ok(!/forbid|not allowed|denied/i.test(sub.output), 'it must never forbid');
  });

  await test('EVIDENCE: a TARGETED read is ALWAYS served, never substituted', () => {
    const dir = tmpdir('lain-ev-');
    const f = path.join(dir, 'big.js');
    fs.writeFileSync(f, Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'));
    const st = fs.statSync(f);
    const l = new EvidenceLedger(dir);
    l.record('big.js', { size: st.size, mtime: Math.floor(st.mtimeMs) }, { lines: 400 });
    assert.strictEqual(l.check('read_file', { path: 'big.js', offset: 10, limit: 20 }), null,
      'the promised escape hatch must actually work');
  });

  await test('EVIDENCE: a CHANGED file is always re-read', () => {
    const dir = tmpdir('lain-ev-');
    const f = path.join(dir, 'big.js');
    fs.writeFileSync(f, Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'));
    const l = new EvidenceLedger(dir);
    l.record('big.js', { size: 1, mtime: 1 }, { lines: 400 });   // a stale stamp
    assert.strictEqual(l.check('read_file', { path: 'big.js' }), null, 'stale evidence must not hide new bytes');
  });

  await test('EVIDENCE: a small file is never substituted', () => {
    const dir = tmpdir('lain-ev-');
    const f = path.join(dir, 'small.js');
    fs.writeFileSync(f, 'a\nb\nc\n');
    const st = fs.statSync(f);
    const l = new EvidenceLedger(dir);
    l.record('small.js', { size: st.size, mtime: Math.floor(st.mtimeMs) }, { lines: 3 });
    assert.strictEqual(l.check('read_file', { path: 'small.js' }), null);
  });

  await test('EVIDENCE: an edit invalidates the entry', () => {
    const dir = tmpdir('lain-ev-');
    const f = path.join(dir, 'x.js');
    fs.writeFileSync(f, 'a');
    const st = fs.statSync(f);
    const l = new EvidenceLedger(dir);
    l.record('x.js', { size: st.size, mtime: Math.floor(st.mtimeMs) }, { lines: 500 });
    l.observe('write_file', { path: 'x.js' }, { output: 'wrote' });
    assert.strictEqual(l.lookup('x.js', { size: st.size, mtime: Math.floor(st.mtimeMs) }), null);
  });

  // ---- plans: session-owned, completed steps are evidence ----------------
  await test('PLAN: a steer NEVER rewrites or drops a completed step', () => {
    const p = new Plan('build the CLI');
    p.addSteps(['scaffold', 'router', 'tests']);
    p.complete('scaffolded');                      // step 1 done
    p.steer('do not build the router yet, finish the CLI first', { drop: [1, 2], replace: [{ n: 1, text: 'WIPED' }] });
    assert.strictEqual(p.steps[0].status, STATUS.DONE, 'completed step survives');
    assert.strictEqual(p.steps[0].text, 'scaffold', 'completed step was not rewritten');
    assert.strictEqual(p.steps[1].status, STATUS.DROPPED, 'a pending step CAN be dropped');
    assert.ok(p.decisions.some((d) => /finish the CLI first/.test(d.text)), 'the reason is recorded');
  });

  await test('PLAN: a failure is recorded and the plan is NOT reset', () => {
    const p = new Plan('x');
    p.addSteps(['a', 'b']);
    p.complete('a done');
    p.recordFailure('smoke test failed: exit 1');
    assert.strictEqual(p.completed.length, 1, 'completed work survives a failure');
    assert.ok(p.decisions.some((d) => d.reason === 'failure'));
  });

  await test('PLAN: there is no plan file in the project — plans live in the session', () => {
    // Structural assertion against the regression: V1 leaked plans across
    // sessions precisely because the plan was a file in the project. Comments
    // are stripped first, or this matches its own documentation.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'plan.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/require\(['"]fs['"]\)|writeFileSync|readFileSync|plan\.md/.test(src),
      'plan.js must not touch the filesystem');
  });

  // ---- availability -----------------------------------------------------
  await test('AVAILABILITY: the breaker opens after the threshold and skips before any socket', () => {
    const a = new Availability({ failureThreshold: 2, cooldownMs: 60000 });
    a.noteFailure('c1', { kind: 'UNAVAILABLE', message: 'refused' });
    assert.strictEqual(a.get('c1').status, AV.DEGRADED);
    a.noteFailure('c1', { kind: 'UNAVAILABLE', message: 'refused' });
    assert.strictEqual(a.get('c1').status, AV.UNAVAILABLE);
    const gate = a.shouldAttempt('c1');
    assert.strictEqual(gate.allow, false, 'no request is sent while open');
    assert.ok(gate.retryAfterMs > 0);
  });

  await test('AVAILABILITY: an AUTH failure is not an outage', () => {
    const a = new Availability({ failureThreshold: 2 });
    a.noteFailure('c2', { kind: 'AUTH', message: 'bad key' });
    a.noteFailure('c2', { kind: 'AUTH', message: 'bad key' });
    assert.notStrictEqual(a.get('c2').status, AV.UNAVAILABLE, 'the server answered — it is reachable');
  });

  await test('AVAILABILITY: user controls work with the provider dead, and retry is instant', () => {
    const a = new Availability({ failureThreshold: 1 });
    a.noteFailure('c3', { kind: 'UNAVAILABLE', message: 'down' });
    assert.strictEqual(a.shouldAttempt('c3').allow, false);
    a.retry('c3');
    assert.strictEqual(a.shouldAttempt('c3').allow, true, 'explicit retry closes the breaker immediately');
    a.disable('c3');
    assert.strictEqual(a.shouldAttempt('c3').allow, false);
    a.noteSuccess('c3');
    assert.strictEqual(a.get('c3').status, AV.DISABLED, "a success must not override the user's choice");
    a.enable('c3');
    assert.strictEqual(a.shouldAttempt('c3').allow, true);
  });

  // ---- connections ------------------------------------------------------
  await test('CONNECTIONS: REQUEST_READY requires a successful request, not a credential', () => {
    const cfg = { connections: { c: { provider: 'anthropic', via: 'native', auth: 'api_key', apiKey: 'k' } } };
    const withKey = connections.fromConfig(cfg, {});
    assert.strictEqual(withKey[0].readiness, connections.READINESS.AUTHENTICATED, 'a key alone is only AUTHENTICATED');
    const proven = connections.fromConfig(cfg, { c: { requestSucceeded: true } });
    assert.strictEqual(proven[0].readiness, connections.READINESS.REQUEST_READY);
  });

  await test('CONNECTIONS: a bridge route needs no LAIN credential and is not called api_key', () => {
    const cfg = { connections: { omniroute: { provider: 'anthropic', via: 'bridge', models: ['claude-opus-5'] } } };
    const c = connections.fromConfig(cfg, {})[0];
    assert.strictEqual(c.auth, connections.AUTH.NONE);
    assert.strictEqual(c.readiness, connections.READINESS.AUTHENTICATED);
    assert.strictEqual(connections.hasKeylessRoute('anthropic', [c]), true);
  });

  await test('OAUTH: a provider with no OAuth says so and never silently becomes api_key', () => {
    const cfg = { connections: { a: { provider: 'anthropic', via: 'native', auth: 'api_key', apiKey: 'k' } } };
    const rows = connections.authRoutes('anthropic', connections.fromConfig(cfg, {}));
    const oauthRow = rows.find((r) => r.kind === 'oauth');
    assert.strictEqual(oauthRow.enabled, false);
    assert.ok(/OAUTH NOT AVAILABLE/.test(oauthRow.status));
    assert.ok(/not faked/i.test(oauthRow.detail));
    assert.ok(rows.some((r) => r.kind === 'api_key'), 'the api_key row is separate and explicit');
  });

  await test('OAUTH: a keyless bridge route is offered before any API-key suggestion', () => {
    const cfg = { connections: { omni: { provider: 'anthropic', via: 'bridge', models: ['claude-opus-5'] } } };
    const rows = connections.authRoutes('anthropic', connections.fromConfig(cfg, {}));
    const bridgeIdx = rows.findIndex((r) => r.kind === 'bridge');
    const keyIdx = rows.findIndex((r) => r.kind === 'api_key');
    assert.ok(bridgeIdx >= 0, 'the bridge route is shown');
    assert.ok(keyIdx === -1 || bridgeIdx < keyIdx, 'a real authenticated route comes first');
  });
};
