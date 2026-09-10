'use strict';

/**
 * THE OBSERVATION ROUTER and THE RECOVERY ENGINE — the two modules that stop a
 * model spending money on the wrong thing.
 *
 * The router's job is that a question about a UI element does not become a
 * screenshot when the DOM could have answered it for nothing. The recovery
 * engine's job is that a tool which cannot possibly succeed is not tried again.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const { Observatory, SOURCE, GOAL, ROUTES, COARSE_OF, PROVIDERS } = require('../../src/harness/observation');
const recovery = require('../../src/harness/recovery');
const { ProcessManager } = require('../../src/harness/processes');
const { TaskRuntime } = require('../../src/harness/runtime');
const observe = require('../../src/observe');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lain-observe-')); }

module.exports = async function () {
  // ------------------------------------------------------------- the router --

  await test('ROUTER: structure is asked before pixels for a UI element', () => {
    const order = ROUTES[GOAL.ELEMENT];
    assert.strictEqual(order[0], SOURCE.DOM);
    assert.ok(order.indexOf(SOURCE.DOM) < order.indexOf(SOURCE.SCREENSHOT));
    assert.ok(order.indexOf(SOURCE.ACCESSIBILITY) < order.indexOf(SOURCE.SCREENSHOT));
    assert.ok(order.indexOf(SOURCE.SCREENSHOT) < order.indexOf(SOURCE.VISION), 'vision is the last resort');
  });

  await test('ROUTER: a deliberately VISUAL goal gets pixels first', () => {
    // A canvas or a game has an empty DOM. Insisting on structure there
    // produces a confident "not present" about something plainly on screen.
    const order = ROUTES[GOAL.SCREEN];
    assert.strictEqual(order[0], SOURCE.SCREENSHOT);
    assert.ok(order.indexOf(SOURCE.SCREENSHOT) < order.indexOf(SOURCE.DOM));
  });

  await test('ROUTER: every source maps onto one of observe.js five witness kinds', () => {
    // The join that keeps the two vocabularies from being parallel lists that
    // can disagree. Total, and checked against the real SOURCE set.
    const coarse = new Set(Object.values(observe.SOURCE));
    for (const s of Object.values(SOURCE)) {
      assert.ok(COARSE_OF[s], `${s} has no coarse witness kind`);
      assert.ok(coarse.has(COARSE_OF[s]), `${s} maps to ${COARSE_OF[s]}, which observe.js does not have`);
    }
  });

  await test('ROUTER: every goal has a route, and an unknown one says what is known', async () => {
    for (const g of Object.values(GOAL)) {
      assert.ok(Array.isArray(ROUTES[g]) && ROUTES[g].length, `${g} routes nowhere`);
    }
    const o = new Observatory();
    const r = await o.observe('vibes', {}, { cwd: process.cwd() });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /not an observation goal/);
    assert.match(r.why, /element/);
  });

  await test('ROUTER: it stops at the FIRST source that answers', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'contents');
    const o = new Observatory();
    const r = await o.observe(GOAL.FILE, { path: 'a.txt' }, { cwd: dir });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, SOURCE.FILESYSTEM);
    assert.strictEqual(r.value, 'contents');
    assert.strictEqual(r.tried.length, 1, 'nothing after the answer is paid for');
  });

  await test('ROUTER: when nothing can answer it says so, with every source it tried', async () => {
    // This is what makes a verification INCONCLUSIVE rather than FAILED.
    const o = new Observatory();
    const r = await o.observe(GOAL.ELEMENT, { selector: '#nope' }, { cwd: process.cwd() });
    assert.strictEqual(r.ok, false);
    assert.ok(r.tried.length >= 2, 'it must report what it tried');
    assert.match(r.why, /no browser is attached/);
  });

  await test('ROUTER: an explicit source list overrides the route', async () => {
    const dir = tmp();
    const o = new Observatory();
    const r = await o.observe(GOAL.ELEMENT, { sources: [SOURCE.SYSTEM] }, { cwd: dir });
    assert.strictEqual(r.source, SOURCE.SYSTEM);
  });

  await test('ROUTER: an absent file is an ANSWER, an unreadable one is a MISS', async () => {
    const dir = tmp();
    const o = new Observatory();
    const gone = await o.observe(GOAL.FILE, { path: 'not-here.txt' }, { cwd: dir });
    assert.strictEqual(gone.ok, true, '"it is not there" is a real answer');
    assert.match(gone.summary, /does not exist/);
  });

  await test('ROUTER: a provider that throws does not take the router down', async () => {
    const original = PROVIDERS[SOURCE.FILESYSTEM];
    PROVIDERS[SOURCE.FILESYSTEM] = () => { throw new Error('provider exploded'); };
    try {
      const o = new Observatory();
      const r = await o.observe(GOAL.FILE, { path: 'x' }, { cwd: process.cwd() });
      assert.strictEqual(r.ok, false);
      assert.match(r.why, /provider exploded/);
    } finally { PROVIDERS[SOURCE.FILESYSTEM] = original; }
  });

  await test('ROUTER: process and log observations read the real process manager', async () => {
    const pm = new ProcessManager();
    const p = pm.start({ taskId: 't1', name: 'talker', command: process.execPath, args: ['-e', 'console.log("hello from the service"); setInterval(()=>{},1000)'] });
    await new Promise((r) => setTimeout(r, 300));
    const o = new Observatory();
    const state = await o.observe(GOAL.PROCESS, { name: 'talker' }, { cwd: process.cwd(), taskId: 't1', processes: pm });
    assert.strictEqual(state.ok, true);
    assert.match(state.summary, /talker/);
    const logs = await o.observe(GOAL.LOGS, { name: 'talker' }, { cwd: process.cwd(), taskId: 't1', processes: pm });
    assert.strictEqual(logs.ok, true);
    assert.match(String(logs.value), /hello from the service/);
    await pm.cleanup();
  });

  await test('ROUTER: an observation is recorded against the task that asked', async () => {
    const runtime = new TaskRuntime({ persist: false });
    const t = runtime.create({ title: 'x' });
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const o = new Observatory({ runtime });
    await o.observe(GOAL.FILE, { path: 'a.txt' }, { cwd: dir, taskId: t.id });
    const rec = runtime.get(t.id).observations;
    assert.strictEqual(rec.length, 1);
    assert.strictEqual(rec[0].source, SOURCE.FILESYSTEM);
    assert.strictEqual(rec[0].ok, true);
  });

  // ----------------------------------------------------------- the recovery --

  await test('RECOVERY: a missing binary is ENVIRONMENTAL and is never retried', () => {
    const v = recovery.recommend({ classification: 'COMMAND_NOT_FOUND' }, { operation: 'run pytest' });
    assert.strictEqual(v.kind, recovery.KIND.ENVIRONMENTAL);
    assert.strictEqual(v.action, recovery.ACTION.DIAGNOSE);
    assert.match(v.why, /cannot install it/);
  });

  await test('RECOVERY: a refusal asks for consent and never routes around it', () => {
    const v = recovery.recommend({ output: 'permission denied' }, { operation: 'write /etc/hosts' });
    assert.strictEqual(v.kind, recovery.KIND.PERMISSION);
    assert.strictEqual(v.action, recovery.ACTION.REQUEST_APPROVAL);
  });

  await test('RECOVERY: a red test suite is LOGICAL — re-plan, not retry', () => {
    const v = recovery.recommend({ output: 'AssertionError: expected 3 but got 4', exitCode: 1 }, { operation: 'npm test' });
    assert.strictEqual(v.kind, recovery.KIND.LOGICAL);
    assert.strictEqual(v.action, recovery.ACTION.REPLAN);
    assert.match(v.why, /same input will produce the same output/);
  });

  await test('RECOVERY: a transient failure is retried EXACTLY once, then re-classified', () => {
    // The spiral is broken by a DIFFERENT ANSWER, not by a smaller budget.
    const ledger = new recovery.Attempts();
    const first = recovery.recommend({ output: 'ECONNRESET' }, { operation: 'fetch', attempts: ledger });
    assert.strictEqual(first.action, recovery.ACTION.RETRY);
    const second = recovery.recommend({ output: 'ECONNRESET' }, { operation: 'fetch', attempts: ledger });
    assert.strictEqual(second.action, recovery.ACTION.DIAGNOSE);
    assert.match(second.why, /not transient after all/);
  });

  await test('RECOVERY: the ledger is keyed on the operation AND the kind', () => {
    const ledger = new recovery.Attempts();
    recovery.recommend({ output: 'ECONNRESET' }, { operation: 'fetch A', attempts: ledger });
    const other = recovery.recommend({ output: 'ECONNRESET' }, { operation: 'fetch B', attempts: ledger });
    assert.strictEqual(other.action, recovery.ACTION.RETRY, 'a different operation has its own budget');
  });

  await test('RECOVERY: permission is decided BEFORE environment', () => {
    // "Access is denied" on Windows is often reported for a path that also does
    // not exist. Routing a refusal to the diagnostics ladder would quietly work
    // around consent.
    const v = recovery.classify({ output: 'EACCES: permission denied, open \'C:/nope/x\'' });
    assert.strictEqual(v.kind, recovery.KIND.PERMISSION);
  });

  await test('RECOVERY: an unrecognisable failure is UNKNOWN, not guessed into a kind', () => {
    const v = recovery.classify({ output: 'the flurbulator disengaged' });
    assert.strictEqual(v.kind, recovery.KIND.UNKNOWN);
  });

  await test('RECOVERY: the explanation names the kind, the reason and the move', () => {
    const text = recovery.explain(recovery.recommend({ classification: 'DEPENDENCY_MISSING' }, { operation: 'x' }));
    assert.match(text, /ENVIRONMENTAL/);
    assert.match(text, /next: DIAGNOSE/);
  });

  await test('RECOVERY: every execution class it maps to has a real name in execution.js', () => {
    const execution = require('../../src/execution');
    const known = new Set(Object.values(execution.CLASS));
    for (const cls of Object.keys(recovery.BY_CLASS)) {
      assert.ok(known.has(cls), `recovery maps "${cls}", which execution.js does not produce`);
    }
  });
};
