'use strict';

/**
 * `/health` — the RC-readiness view.
 *
 * The failure mode this guards against is a dishonest green: a view that says
 * STABLE because the tests pass, or that quietly omits what is missing or was
 * dropped on purpose. So the assertions are about HONESTY — reliability is
 * marked "implemented" not "stable", known gaps are present and named, and
 * deliberate exclusions read as excluded rather than broken.
 */

const assert = require('assert');
const { test } = require('../helpers');

const health = require('../../src/health');
const commands = require('../../src/commands');

function fakeApp() {
  const { App } = require('../../src/app');
  const out = { write() {}, on() {}, columns: 96, isTTY: false };
  return new App({ out, interactive: false, cwd: process.cwd() });
}

/** Flatten the grouped assessment into { area -> row }. */
function byArea(a) {
  const m = new Map();
  for (const g of a.groups) for (const r of g.rows) m.set(r.area, r);
  return m;
}

module.exports = async function () {
  await test('HEALTH: the implemented workflows read as implemented', async () => {
    const a = await health.assess(fakeApp());
    const m = byArea(a);
    // NAMED FOR THE CAPABILITY, NOT FOR A COMMAND. `/audit` and
    // `/troubleshoot` were removed from the command surface in the 2026-09
    // UX subtraction pass; the WORKFLOWS they reached were not, so the view
    // probes the module and the mode rather than the command registry, and
    // these two rows are named for what a person can do. Dropping them from
    // this list would have quietly stopped checking they still exist.
    for (const area of ['Project reading', 'Troubleshooting', '/compare', '/resume']) {
      assert.ok(m.has(area), `${area} must appear in the readiness view`);
      assert.strictEqual(m.get(area).state.word, 'IMPLEMENTED');
    }
    for (const area of ['/audit', '/troubleshoot']) assert.ok(!m.has(area), `${area} was removed from the primary command surface`);
  });

  await test('HEALTH: reliability is "implemented", never "stable" from code alone', async () => {
    // The whole point: a wired code path is not a proven one. Only a live probe
    // earns STABLE/VERIFIED, and no reliability row is proven by assess() itself.
    const a = await health.assess(fakeApp());
    const reliability = a.groups.find((g) => g.title === 'Reliability');
    assert.ok(reliability && reliability.rows.length, 'there must be a reliability section');
    for (const r of reliability.rows) {
      assert.notStrictEqual(r.state.word, 'STABLE', `${r.area} claims STABLE from code alone`);
      assert.notStrictEqual(r.state.word, 'VERIFIED', `${r.area} claims VERIFIED from code alone`);
    }
  });

  await test('HEALTH: known gaps are shown, not hidden', async () => {
    const a = await health.assess(fakeApp());
    const m = byArea(a);
    // WAS 'MISSING', AND THE FACT CHANGED RATHER THAN THE TEST BEING WRONG.
    // src/memory.js is a real durable store — decisions, facts, limitations and
    // notes kept per project in LAIN's config home, surviving compaction and
    // restart — so the capability probe now matches something that genuinely
    // exists. Leaving this asserting MISSING would pin a claim that is no
    // longer true, which is the opposite of what this suite is for.
    assert.strictEqual(m.get('Cross-run learning').state.word, 'IMPLEMENTED');
    // THE SEAM EXISTING IS NOT THE BRIDGE BEING THERE. With nothing configured
    // the row must read MISSING / NOT CONFIGURED, however much code is present
    // to talk to a bridge — "mcp.js is in the tree" is a different fact, and
    // reporting the first as the second is the dishonest green this view exists
    // to prevent.
    const mcp = m.get('MCP bridge');
    assert.strictEqual(mcp.state.word, 'MISSING');
    assert.match(mcp.note, /NOT CONFIGURED/);
    // ---- THE CHAT MODEL SOURCE, WHICH REPLACED THE EXTERNAL REVIEWER ----
    //
    // The old rows asserted that an unconfigured reviewer reads as MISSING
    // rather than as a working one. That reviewer went with `/external`; what
    // is reported now is the session's chat SOURCE, and the equivalent honesty
    // requirement is the second row: a website source may never be shown as
    // holding execution authority, because it never has any.
    assert.strictEqual(m.get('Source').state.word, 'IMPLEMENTED');
    assert.match(m.get('Source').note, /own runtime/);
    assert.strictEqual(m.get('Coding authority').state.word, 'IMPLEMENTED');
    assert.match(m.get('Coding authority').note, /always LAIN/);
  });

  await test('HEALTH: nothing is granted until someone says yes', async () => {
    const perm = byArea(await health.assess(fakeApp())).get('Desktop permission');
    assert.ok(perm, 'the permission state must be reported');
    assert.match(perm.note, /nothing is granted/);
    assert.strictEqual(perm.state.ready, true, 'no grant outstanding is the SAFE state, not a gap');
  });

  await test('HEALTH: deliberate exclusions read as excluded, not broken', async () => {
    const a = await health.assess(fakeApp());
    const m = byArea(a);
    assert.strictEqual(m.get('Orchestra').state.word, 'INTENTIONALLY EXCLUDED');
    assert.strictEqual(m.get('lain-model').state.word, 'INTENTIONALLY EXCLUDED');
    // An exclusion counts as "ready" — it is a decision, not an unfinished area.
    assert.strictEqual(m.get('Orchestra').state.ready, true);
  });

  await test('HEALTH: the summary counts ready areas and is not a perfect score', async () => {
    const a = await health.assess(fakeApp());
    assert.ok(a.summary.total > a.summary.ready, 'with real gaps present, not everything is ready');
    assert.ok(a.summary.ready > 0);
  });

  await test('HEALTH: the render carries the legend and every group, and never crashes plain', async () => {
    const a = await health.assess(fakeApp());
    let text = '';
    const app = { render: { width: 96, write(s) { text += s; }, notice() {} } };
    health.renderHealth(app, a, { C: null });
    assert.match(text, /RC readiness/);
    assert.match(text, /excluded/);
    for (const g of a.groups) assert.ok(text.includes(g.title), `${g.title} missing from the render`);
  });

  await test('HEALTH: /health and /ready are registered and read-only during a turn', () => {
    assert.ok(commands.looksLikeCommand('/health'));
    assert.ok(commands.looksLikeCommand('/ready'));
    assert.strictEqual(commands.REGISTRY.get('/health').duringTurn, 'safe');
  });
};
