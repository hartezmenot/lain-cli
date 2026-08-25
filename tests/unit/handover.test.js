'use strict';

/**
 * THE HANDOVER PACKET — a replacement model continuing from OBSERVED state.
 *
 * The property under test is not "a string was produced". It is that the packet
 * disagrees with the previous model wherever reality does: a write the tools
 * recorded but that never reached the disk is reported as not landed, and a
 * test the model called green is reported with the exit code it actually had.
 *
 * These run against real files and a real checkpoint store, because every claim
 * the packet makes is a claim about the filesystem and a stub would let it go
 * unchecked.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { test } = require('../helpers');
const handover = require('../../src/handover');
const prompt = require('../../src/prompt');
const { Session } = require('../../src/session');
const { Plan } = require('../../src/plan');
const { Checkpoints } = require('../../src/checkpoint');

const NL = String.fromCharCode(10);

/**
 * A session whose previous turn died mid-task, with two files: one whose edit
 * landed and one whose edit did not.
 */
function dead({ lastOk = false, stopReason = 'provider', model = 'model-A' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-ho-'));
  fs.writeFileSync(path.join(root, 'loader.js'), 'const A = 1;' + NL);
  fs.writeFileSync(path.join(root, 'ghost.js'), 'const B = 2;' + NL);

  const s = new Session({ cwd: root });
  s.task = { objective: 'fix the loader so it reads JSON', steers: [{ text: 'keep the old format working too' }] };
  s.lifecycle = {
    state: 'ACTIVE',
    evidence: { filesChanged: new Set([path.join(root, 'loader.js'), path.join(root, 'ghost.js')]) },
    lastCommand: { command: 'npm test', ok: lastOk, exitCode: lastOk ? 0 : 1 },
  };
  s.turns = [{ model, stopReason, steps: 7, actions: [{ name: 'edit_file', target: 'ghost.js' }] }];

  const cp = new Checkpoints(s.id, root, { load: false });
  const e1 = cp.capture('t1', [path.join(root, 'loader.js')]);
  fs.writeFileSync(path.join(root, 'loader.js'), 'const A = JSON.parse(x);' + NL);  // landed
  cp.settle(e1);
  const e2 = cp.capture('t1', [path.join(root, 'ghost.js')]);                        // never written
  cp.settle(e2);

  return { root, s, cp };
}

module.exports = async function () {
  await test('HANDOVER-1: a dead turn produces a packet naming the task and where it stopped', () => {
    const { root, s, cp } = dead();
    const out = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    assert.ok(out, 'a turn that did not finish must produce a handover');
    assert.ok(/fix the loader so it reads JSON/.test(out), 'the task must survive');
    assert.ok(/provider stopped answering/.test(out), 'and why the previous turn ended');
    assert.ok(/edit_file ghost\.js/.test(out), 'and what was in flight when it did');
  });

  await test('HANDOVER-2: a mutation that landed is VERIFIED against disk, not reported', () => {
    const { root, s, cp } = dead();
    const out = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    assert.ok(/VERIFIED changed on disk/.test(out));
    assert.ok(/loader\.js \(modified\)/.test(out), 'the edit that landed must be named as landed');
  });

  // §20. The tool layer RECORDED ghost.js as changed. The bytes say otherwise,
  // and the bytes win — this is the whole reason the packet re-measures.
  await test('HANDOVER-11 / ADVERSARIAL: a write that never landed is reported as not landed', () => {
    const { root, s, cp } = dead();
    const out = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    assert.ok(/did not land/.test(out), 'an attempted-but-absent edit must be called out');
    assert.ok(/ghost\.js/.test(out));
    // And it must not appear as a verified change — that would be the lie.
    const verified = out.slice(out.indexOf('VERIFIED changed on disk'), out.indexOf('did not land'));
    assert.ok(!/ghost\.js/.test(verified), 'ghost.js must never be listed as verified changed');
  });

  await test('HANDOVER-3: a failing check is reported with its real exit code, whatever was claimed', () => {
    const failed = dead({ lastOk: false });
    const out = handover.build(failed.s, { cwd: failed.root, checkpoints: failed.cp, toModel: 'model-B' });
    assert.ok(/npm test` — FAILED \(exit 1\)/.test(out), `the real result must survive:${NL}${out}`);

    const passed = dead({ lastOk: true });
    const ok = handover.build(passed.s, { cwd: passed.root, checkpoints: passed.cp, toModel: 'model-B' });
    assert.ok(/npm test` — PASSED/.test(ok), 'and a genuine pass reads as a pass');
  });

  await test('HANDOVER-4: switching model mid-task hands over rather than restarting', () => {
    const { root, s, cp } = dead({ stopReason: 'end' });   // the turn FINISHED
    const same = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-A' });
    assert.strictEqual(same, '', 'same model, finished turn: there is nothing to hand over');

    const other = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    assert.ok(/taking over this task from a different model \(model-A\)/.test(other),
      'a different model must be told it is taking over');
    assert.ok(/fix the loader/.test(other), 'and the task continues — it is not a new session');
  });

  await test('HANDOVER-5: session state carries no model or provider, so a switch cannot reset it', () => {
    const s = new Session({ cwd: process.cwd() });
    const json = s.toJSON();
    for (const key of ['model', 'provider', 'connection', 'route']) {
      assert.ok(!(key in json), `session state must not own \`${key}\` — a model change would reset the task`);
    }
    assert.ok('evidence' in json && 'task' in json && 'plan' in json,
      'what the session DOES own is the work, which survives the switch');
  });

  await test('HANDOVER-9: the packet is a briefing, not a transcript', () => {
    const { root, s, cp } = dead();
    // A conversation that would be ruinous to replay.
    s.messages = [];
    for (let i = 0; i < 200; i++) s.messages.push({ role: 'tool', content: 'x'.repeat(2000) });
    const out = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    assert.ok(out.length < 4000, `the handover grew to ${out.length} chars — it must stay a briefing`);
    assert.ok(!/xxxxxxxxxx/.test(out), 'no tool output may be replayed into it');
  });

  await test('HANDOVER-10: it tells the replacement what NOT to redo', () => {
    const { root, s, cp } = dead();
    const out = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    // The same words the working context used, because this REPLACES it and the
    // guarantee must survive the substitution — see the note in handover.js.
    assert.ok(/do not restart it/.test(out));
    assert.ok(/re-run project discovery/.test(out), 'rediscovery is the cost this exists to prevent');
    assert.ok(/Re-verify anything[\s\S]*only claimed/.test(out),
      'and it must ask for claims to be re-checked, not inherited');
  });

  await test('HANDOVER-12: undo state lives with the session, so it survives a model switch', () => {
    const { root, s, cp } = dead();
    // The checkpoint store is keyed by session and sits on disk; nothing about
    // it is model-scoped, so a replacement model can still revert model A's work.
    const fresh = new Checkpoints(s.id, root, { load: true });
    assert.ok(Array.isArray(fresh.entries), 'the store reloads from disk');
    assert.ok(fresh.entries.length >= 1, 'model A\'s checkpoints are still there for model B');
  });

  await test('CONTEXT: the handover REPLACES the ordinary working context, never doubles it', () => {
    const { root, s, cp } = dead();
    const sys = prompt.build({
      cwd: root, platform: 'win32', model: 'model-B', session: s, checkpoints: cp,
    });
    assert.ok(/# Session handover/.test(sys), 'a handover turn must be labelled as one');
    assert.ok(!/# Already established/.test(sys),
      'the two renderings must not both appear — that is the same state twice');
  });

  await test('CONTEXT: an ordinary continuation still gets the ordinary working context', () => {
    const { root, s, cp } = dead({ stopReason: 'end' });
    const sys = prompt.build({
      cwd: root, platform: 'win32', model: 'model-A', session: s, checkpoints: cp,
    });
    assert.ok(!/# Session handover/.test(sys), 'nothing was handed over, so nothing should say so');
  });

  await test('HANDOVER: a healthy session hands over nothing at all', () => {
    const s = new Session({ cwd: process.cwd() });
    assert.strictEqual(handover.build(s, { cwd: process.cwd(), toModel: 'model-A' }), '',
      'a fresh session has no handover to make');
  });

  // ---- T1 / T2 (§13): THE PLAN SECTION, RENDERED, FROM RUNTIME STATE ---------
  //
  // The mission's §10 said the plan's position must come from the runtime's own
  // record, and the gap that hid the old `s.done` bug for months was exactly
  // here: HANDOVER-5 asserted the plan was IN the session JSON, and no test ever
  // looked at the packet's rendered plan lines. A getter could be misread, a
  // field could be invented, and both stayed invisible because the section was
  // never printed in a test. These print it.

  await test('HANDOVER / T1: plan position is derived from runtime state, not from prose', () => {
    // A dead session whose plan holds every kind of step at once — one done, one
    // active, one dropped, one todo — so the counts and the outstanding list each
    // have to find THEIR OWN steps rather than all agreeing by accident.
    const { root, s, cp } = dead();
    const plan = new Plan('fix the loader');
    plan.addSteps(['inspect loader', 'rewrite it', 'deprecate the old path', 'test it']);
    plan.complete('read the loader');
    plan.steer('not doing the deprecation', { drop: [3] });
    s.plan = plan;

    const out = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    // The POSITION comes from `completed`/`remaining` — the same getters /plan
    // reads — so it can never disagree with any other view of the plan.
    assert.ok(/Plan: 1\/4 steps done\./.test(out),
      `the position must come from the plan's own getters:${NL}${out}`);
    assert.ok(/1 dropped/.test(out), 'a dropped step is counted, not listed as work to do');
    // STILL OUTSTANDING names the two steps the next entry must actually do —
    // from `remaining`, which excludes both done and dropped.
    assert.ok(/Still outstanding:[\s\S]*rewrite it[\s\S]*test it/.test(out),
      'the outstanding steps must be listed by their status, not by their position');
    assert.ok(!/\(done: read the loader\)/.test(out),
      'a completed step is counted, never re-listed as work for the replacement');
  });

  await test('HANDOVER / T1: the same state renders the same packet, twice', () => {
    // C3. The digest is deterministic: nothing here is time-varying or
    // model-generated, so building it twice from one state must produce one
    // packet. If this ever fails, something in the chain has started putting
    // wall-clock or request output into the briefing.
    const { root, s, cp } = dead();
    s.plan = new Plan('fix the loader');
    s.plan.addSteps(['inspect loader', 'rewrite it']);
    s.plan.complete('read the loader');

    const a = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    const b = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    assert.strictEqual(a, b, 'identical inputs must produce the identical packet');
  });

  await test('HANDOVER / T2: the PLAN, not just its digest, is in the prompt of a dead-turn entry', () => {
    // The bug this file's §header was written about, as an assertion. The old
    // packet asked a non-existent `s.done` field for each step, so every plan
    // rendered as `0/N done` with nothing outstanding. `app.js:226` appends the
    // plan digest separately, and a test asserting only `/✓ 1\./` stays green
    // through that second site while the packet's own section is broken — which
    // is exactly how the bug survived. This asserts the packet's line itself.
    const { root, s, cp } = dead();
    const plan = new Plan('fix the loader');
    plan.addSteps(['inspect loader', 'rewrite it']);
    plan.complete('read the loader');
    s.plan = plan;

    const sys = prompt.build({
      cwd: root, platform: 'win32', model: 'model-B', session: s, checkpoints: cp,
    });
    assert.ok(/# Session handover/.test(sys), 'this is a handover turn');
    // The packet's own plan line — the section that is rendered only by the
    // handover builder, not the digest that app.js appends for every turn.
    assert.ok(/Plan: 1\/2 steps done\./.test(sys),
      `the packet's plan position must reach the model:${NL}${sys.slice(-1200)}`);
    assert.ok(/Still outstanding:[\s\S]*rewrite it/.test(sys),
      'and the next step, by name, so "continue" has a there');
  });

  await test('HANDOVER / T2: a completed step is never re-listed as outstanding in a handover', () => {
    // T3's half. Verified truth must survive the interruption — and the flip
    // side: work the dead turn genuinely finished must not be handed back as
    // still to do, or the replacement redoes it. `complete()` is the only
    // sanctioned way to finish a step, and it sets `status`, not a `done` flag.
    const { root, s, cp } = dead();
    const plan = new Plan('fix the loader');
    plan.addSteps(['inspect loader', 'rewrite it']);
    plan.complete('read the loader');
    s.plan = plan;

    const out = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    assert.ok(out.includes('Still outstanding:'), 'the outstanding section must exist to be checked');
    const outstanding = out.slice(out.indexOf('Still outstanding'));
    assert.ok(!/inspect loader/.test(outstanding),
      'a done step must not come back as work for the replacement to redo');
  });

  // ---- THE .LAIN SECTIONS ---------------------------------------------------
  //
  // The packet's session-half is one process's memory; these test the half that
  // is the PROJECT'S. Same rule as every section above: skipped silently when
  // absent, disagreeing with the transcript when the disk does.

  /** A dead session whose project has a full `.lain/` layer, like the one above. */
  function deadWithLain() {
    const { root, s, cp } = dead();
    const tools = require('../../src/tools');
    const ctx = { cwd: root, session: { id: s.id } };
    const fsx = require('fs');
    const pathx = require('path');
    return tools.execute('architecture', {
      op: 'declare', name: 'Loader', id: 'loader', status: 'IMPLEMENTED',
      location: 'loader.js', purpose: 'Reads config and hydrates the runtime.',
    }, ctx).then(() => tools.execute('architecture', {
      op: 'declare', name: 'Ghost', id: 'ghost', status: 'IMPLEMENTED',
      location: 'ghost.js', purpose: 'A component whose file is about to vanish.',
    }, ctx)).then(() => tools.execute('concept', {
      op: 'define', term: 'hydrate', kind: 'process',
      purpose: 'Filling the runtime state from config at boot.', nodes: ['loader'],
    }, ctx)).then(() => tools.execute('wiring', {
      op: 'connect', from: 'loader', to: 'ghost', rel: 'CALLS', via: 'require',
    }, ctx)).then(() => tools.execute('scratch', {
      op: 'note', text: 'loader reads JSON but never validates it', kind: 'lead',
    }, ctx)).then(() => tools.execute('scratch', {
      op: 'promote', text: 'loader.js parses with JSON.parse', evidence: 'read loader.js',
    }, ctx)).then(() => {
      // The implementation vanishes; the architecture remembers it was meant.
      fsx.unlinkSync(pathx.join(root, 'ghost.js'));
      return { root, s, cp };
    });
  }

  await test('HANDOVER: the packet carries the architecture branch, vocabulary and wiring', async () => {
    const { root, s, cp } = await deadWithLain();
    const out = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    // loader.js is the file that changed; its node is the branch the packet names.
    assert.ok(/The work is inside these recorded components:/.test(out));
    assert.ok(/Loader \(loader\) — Reads config and hydrates the runtime\./.test(out),
      'the changed file arrives as a component with a purpose, not bytes');
    assert.ok(/hydrate — Filling the runtime state from config at boot\./.test(out),
      'the branch pulls in the vocabulary the component was defined with');
    assert.ok(/How they are wired:/.test(out) && /Loader calls Ghost/.test(out),
      'and its recorded connections, which no import graph expresses');
    assert.ok(/The previous turn had already found/.test(out)
      && /loader reads JSON but never validates it/.test(out),
      'the dead turn\'s scratch findings ride the packet instead of dying with it');
    assert.ok(/Checked facts about this project/.test(out) && /\[evidence: read loader\.js\]/.test(out),
      'promoted facts arrive with the evidence that established them');
  });

  await test('HANDOVER: a deleted implementation is MISSING, and nothing claims it exists', async () => {
    // §24's recovery case, end to end: the file is gone, the packet says so in
    // the reconciler's words, and the architecture's memory of intent survives.
    const { root, s, cp } = await deadWithLain();
    const out = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    assert.ok(/MISSING: Ghost was IMPLEMENTED at ghost\.js and there is nothing there now/.test(out),
      'the disk was re-measured and the vanished component is named');
    assert.ok(/recorded in \.lain and did not go anywhere/.test(out),
      'with the guarantee that the intent survives the loss');
    // The branch section names loader.js's component; it must not name ghost's
    // as present — ghost.js never changed, it vanished.
    const branch = out.slice(out.indexOf('The work is inside'), out.indexOf('No check has been run'));
    assert.ok(!/Ghost was IMPLEMENTED at ghost\.js and there is nothing/.test(branch),
      'the alarm is not echoed as if it were a working component');
  });

  await test('HANDOVER: a project with no .lain produces exactly the packet it always did', () => {
    const { root, s, cp } = dead();
    const out = handover.build(s, { cwd: root, checkpoints: cp, toModel: 'model-B' });
    assert.ok(out, 'the packet is built');
    for (const absent of ['recorded components', 'The intended architecture disagrees',
      'had already found', 'Checked facts about this project']) {
      assert.ok(!out.includes(absent), `a project with no .lain must not grow a "${absent}" section`);
    }
  });
};
