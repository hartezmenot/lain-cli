'use strict';

/**
 * THE SURFACES — the projection every window reads, the capability registry,
 * and the timeline.
 *
 * The assertion that matters most here is a negative one: a surface must not be
 * able to render "nothing has been proved" as "nothing failed". Those are the
 * same numbers and opposite meanings, and every dashboard that has ever lied
 * about a build did it exactly there.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const surface = require('../../src/harnesssurface');
const registry = require('../../src/harness/registry');
const timeline = require('../../src/harness/timeline');
const { Harness } = require('../../src/harness');
const { EventBus, EVENT } = require('../../src/events');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lain-surface-')); }

module.exports = async function () {
  // ------------------------------------------------------------ projection --

  await test('SURFACE: with no harness at all the projection is null, not an empty task', () => {
    // An empty object with zeroes in it renders as a task that exists and has
    // done nothing, which is a different and false claim.
    assert.strictEqual(surface.project(null), null);
    assert.strictEqual(surface.project({}), null);
    assert.strictEqual(surface.line({}), null);
  });

  await test('SURFACE: an unproved task projects verification as null', () => {
    const h = new Harness({ workspace: tmp(), persist: false });
    const t = h.begin({ title: 'unproved work' });
    h.runtime.start(t.id);
    const p = surface.project({ _harness: h });
    assert.strictEqual(p.verification, null, 'nothing proved must never render as zero failures');
    assert.strictEqual(p.task.state, 'RUNNING');
    assert.match(surface.line({ _harness: h }), /unproven/);
  });

  await test('SURFACE: a settled task projects the verdict and its counts', async () => {
    const dir = tmp();
    const h = new Harness({ workspace: dir, persist: true });
    const t = h.begin({ title: 'proved work' });
    h.runtime.start(t.id);
    await h.verify({ requirements: [{ description: 'a file', checks: [{ kind: 'file', label: 'missing', path: 'nope.txt' }] }] });
    const p = surface.project({ _harness: h });
    assert.strictEqual(p.task.state, 'FAILED');
    assert.strictEqual(p.verification.verdict, 'FAILED');
    assert.strictEqual(p.verification.failed, 1);
    assert.match(surface.line({ _harness: h }), /FAILED/);
    await h.shutdown();
  });

  await test('SURFACE: the payload carries names and counts, never bodies', async () => {
    const dir = tmp();
    const h = new Harness({ workspace: dir, persist: true });
    const t = h.begin({ title: 'secrets' });
    h.runtime.start(t.id);
    h.runtime.keep(t.id, { kind: 'log', name: 'creds.txt', body: 'SUPER-SECRET-TOKEN-abc123' });
    const p = surface.project({ _harness: h });
    const json = JSON.stringify(p);
    assert.ok(!json.includes('SUPER-SECRET-TOKEN'), 'an artifact BODY must never ride the state payload');
    assert.ok(json.includes('creds.txt'), 'its name may');
    assert.strictEqual(p.evidence.artifacts, 1);
    await h.shutdown();
  });

  await test('SURFACE: a finished task is still projected — the window does not go blank', async () => {
    const dir = tmp();
    const h = new Harness({ workspace: dir, persist: true });
    const t = h.begin({ title: 'ends' });
    h.runtime.start(t.id);
    h.runtime.cancel(t.id, 'the person stopped it');
    const p = surface.project({ _harness: h });
    assert.ok(p, 'a task that ended is still the news');
    assert.strictEqual(p.task.state, 'CANCELLED');
    assert.strictEqual(p.task.terminal, true);
    await h.shutdown();
  });

  await test('SURFACE: the dashboard payload carries the harness section', () => {
    // The dashboard renders this and computes nothing of its own. Checked at
    // the seam rather than by driving a browser.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'dash.js'), 'utf8');
    assert.match(src, /harnesssurface'\)\.project\(app\)/, 'dashState must project rather than assemble');
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'dashpage.js'), 'utf8');
    assert.match(page, /s\.harness/, 'the page must read the projected section');
    assert.match(page, /nothing yet/, 'and say so when nothing has been proved');
  });

  // ------------------------------------------------------------- the seam --

  await test('LINK: a greeting does not open a task, and real work does', () => {
    // `.lain/tasks/` is only worth reading if everything in it is work. The
    // mode verdict is consumed, never re-derived.
    const link = require('../../src/harnesslink');
    const modeId = require('../../src/mode');
    const app = { cwd: tmp(), session: { id: 's1', task: null }, events: new EventBus() };
    assert.strictEqual(link.beginTurn(app, { sameTask: false, mode: modeId.KIND.CHAT }, 'hello'), null);
    assert.strictEqual(link.existing(app), null, 'and no harness is even constructed');
    const t = link.beginTurn(app, { sameTask: false, mode: modeId.KIND.IMPLEMENT }, 'add a login page');
    assert.ok(t && t.id, 'real work opens a task');
    assert.strictEqual(t.state, 'RUNNING');
  });

  await test('LINK: a question asked mid-task belongs to that task', () => {
    const link = require('../../src/harnesslink');
    const modeId = require('../../src/mode');
    const app = { cwd: tmp(), session: { id: 's1', task: null }, events: new EventBus() };
    const t = link.beginTurn(app, { sameTask: false, mode: modeId.KIND.IMPLEMENT }, 'build the thing');
    const same = link.beginTurn(app, { sameTask: true, mode: modeId.KIND.EXPLAIN }, 'what does this do?');
    assert.strictEqual(same.id, t.id, 'it carries on rather than opening a second record');
  });

  await test('LINK: continuing after a verdict opens a REPAIR task, not an orphan', async () => {
    // `activeId` is cleared when a task settles. Reading `active()` here would
    // have produced a fresh task with no link to the failure that caused it —
    // the exact loss of history the state machine refuses to allow elsewhere.
    const link = require('../../src/harnesslink');
    const modeId = require('../../src/mode');
    const app = { cwd: tmp(), session: { id: 's1', task: null }, events: new EventBus() };
    const first = link.beginTurn(app, { sameTask: false, mode: modeId.KIND.BUGFIX }, 'fix the redirect');
    const h = link.existing(app);
    h.runtime.verifying(first.id);
    h.runtime.settle(first.id, await require('../../src/harness/verify').run([{ checks: [{ kind: 'file', path: __filename + '.absent' }] }], { taskId: first.id }));
    const next = link.beginTurn(app, { sameTask: true, mode: modeId.KIND.BUGFIX }, 'fix the redirect');
    assert.notStrictEqual(next.id, first.id, 'a terminal task is never reopened');
    assert.strictEqual(next.causedBy, first.id, 'and the new one names what caused it');
    assert.strictEqual(h.runtime.get(first.id).state, 'FAILED', 'the first verdict still stands');
  });

  await test('LINK: a model that claims success moves the task to VERIFYING', () => {
    // The claim is not evidence and cannot reach PASSED. It means "stop
    // executing and go and prove it".
    const link = require('../../src/harnesslink');
    const modeId = require('../../src/mode');
    const { Lifecycle } = require('../../src/lifecycle');
    const app = { cwd: tmp(), session: { id: 's1', task: null, lifecycle: new Lifecycle('x') }, events: new EventBus() };
    const t = link.beginTurn(app, { sameTask: false, mode: modeId.KIND.IMPLEMENT }, 'fix the redirect');
    link.endTurn(app, { text: 'All the tests now pass and the redirect works correctly.' });
    assert.strictEqual(link.existing(app).runtime.get(t.id).state, 'VERIFYING');
  });

  await test('LINK: a turn that claims nothing leaves the task RUNNING', () => {
    const link = require('../../src/harnesslink');
    const modeId = require('../../src/mode');
    const { Lifecycle } = require('../../src/lifecycle');
    const app = { cwd: tmp(), session: { id: 's1', task: null, lifecycle: new Lifecycle('x') }, events: new EventBus() };
    const t = link.beginTurn(app, { sameTask: false, mode: modeId.KIND.IMPLEMENT }, 'fix the redirect');
    link.endTurn(app, { text: 'I read three files and have not changed anything yet.' });
    assert.strictEqual(link.existing(app).runtime.get(t.id).state, 'RUNNING');
  });

  await test('VOCABULARY: no event name is advertised and never emitted', () => {
    // ---- THE TOOL REGISTRY RULE, APPLIED TO THE EVENT CHANNEL ------------
    //
    // The architecture guard already refuses a tool that is advertised and not
    // dispatchable, for a reason that is exactly as true here: a name in the
    // vocabulary that nothing ever emits is a companion window with a section
    // that stays empty forever, and that is indistinguishable from the feature
    // being broken. The harness added twenty-seven names at once, and three of
    // them (`agent.*`, `approval.*`) were dead until their emitters were wired
    // — which is how this check came to exist.
    const SRC = path.join(__dirname, '..', '..', 'src');
    const texts = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        if (path.resolve(p) === path.resolve(path.join(SRC, 'events.js'))) continue;  // the vocabulary itself
        texts.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(SRC);
    const src = texts.join('\n');
    const dead = [];
    for (const [key, name] of Object.entries(EVENT)) {
      if (src.includes(`EVENT.${key}`)) continue;
      if (src.includes(`'${name}'`)) continue;
      dead.push(`${key} (${name})`);
    }
    assert.deepStrictEqual(dead, [], `advertised but never emitted: ${dead.join(', ')}`);
  });

  // ------------------------------------------------------------- approvals --

  await test('APPROVAL: a request for consent is a NAMED FACT a second window can see', async () => {
    // A person who has walked away has no way to learn that LAIN is waiting on
    // them — the modal is on a screen nobody is looking at. This is the only
    // route by which "something needs you" leaves the machine.
    const permissions = require('../../src/permissions');
    const bus = new EventBus();
    const seen = [];
    bus.on((e) => seen.push(e));
    const perms = { pending: null, deny() {}, grant() { return ['screen']; }, _note() {} };
    const app = {
      events: bus,
      desktop: () => ({ permissions: perms }),
      ui: { enabled: true, noteActor() {}, ask: async () => 'Allow once (1 minute)' },
    };
    const r = await permissions.request(app, { caps: ['screen'], reason: 'to look at the window' });
    assert.strictEqual(r.ok, true);
    const asked = seen.find((e) => e.type === EVENT.APPROVAL_REQUIRED);
    const settled = seen.find((e) => e.type === EVENT.APPROVAL_RESOLVED);
    assert.ok(asked, 'the request must be announced');
    assert.match(asked.reason, /look at the window/);
    assert.ok(settled && settled.granted === true, 'and so must the answer');
  });

  await test('APPROVAL: a refusal is announced as a refusal', async () => {
    const permissions = require('../../src/permissions');
    const bus = new EventBus();
    const seen = [];
    bus.on((e) => seen.push(e));
    const perms = { pending: null, deny() {}, grant() { return []; }, _note() {} };
    const app = {
      events: bus,
      desktop: () => ({ permissions: perms }),
      ui: { enabled: true, noteActor() {}, ask: async () => 'Deny' },
    };
    const r = await permissions.request(app, { caps: ['screen'] });
    assert.strictEqual(r.ok, false);
    const settled = seen.find((e) => e.type === EVENT.APPROVAL_RESOLVED);
    assert.ok(settled && settled.granted === false);
  });

  await test('APPROVAL: unattended asks nobody and announces nothing', async () => {
    // Inferring consent from "there was no way to object" is the failure the
    // gate exists to prevent, and a bus event must not imply somebody was asked.
    const permissions = require('../../src/permissions');
    const bus = new EventBus();
    const seen = [];
    bus.on((e) => seen.push(e.type));
    const app = { events: bus, ui: null, desktop: () => ({ permissions: { pending: null, deny() {}, _note() {} } }) };
    const r = await permissions.request(app, { caps: ['screen'] });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(seen, [], 'nothing was asked, so nothing is announced');
  });

  // -------------------------------------------------------------- registry --

  await test('REGISTRY: destructive and external need approval; the ordinary work does not', () => {
    assert.strictEqual(registry.POLICY[registry.SIDE_EFFECT.DESTRUCTIVE], registry.APPROVAL.REQUIRED);
    assert.strictEqual(registry.POLICY[registry.SIDE_EFFECT.EXTERNAL], registry.APPROVAL.REQUIRED);
    for (const e of ['READ', 'WRITE', 'EXECUTE', 'NETWORK']) {
      assert.strictEqual(registry.POLICY[registry.SIDE_EFFECT[e]], registry.APPROVAL.AUTOMATIC,
        `${e} must not interrupt somebody — a harness that asks forty times is not consented to`);
    }
  });

  await test('REGISTRY: deleting needs approval and reading does not', () => {
    assert.strictEqual(registry.needsApproval('delete_file', { mutates: true }), true);
    assert.strictEqual(registry.needsApproval('read_file', { mutates: false }), false);
    assert.strictEqual(registry.needsApproval('write_file', { mutates: true }), false);
  });

  await test('REGISTRY: a destructive capability is never retried', () => {
    assert.strictEqual(registry.describe('delete_file', { mutates: true }).retry, 'DISABLED');
    assert.strictEqual(registry.describe('read_file', { mutates: false }).retry, 'IDEMPOTENT');
  });

  await test('REGISTRY: every live tool is described, with all six facts', () => {
    // Read from the LIVE tool registry, so a tool added tomorrow is described
    // without anybody editing the table.
    const all = registry.all();
    const names = new Set(all.map((c) => c.name));
    for (const n of require('../../src/tools').names()) {
      assert.ok(names.has(n), `${n} has no capability description`);
    }
    for (const c of all) {
      for (const k of ['name', 'provider', 'trust', 'sideEffect', 'approval', 'retry', 'timeoutMs']) {
        assert.ok(c[k] !== undefined, `${c.name} is missing ${k}`);
      }
      assert.ok(Object.values(registry.SIDE_EFFECT).includes(c.sideEffect), `${c.name}: ${c.sideEffect} is not a side effect`);
    }
  });

  await test('REGISTRY: a shell is EXECUTE, not merely a write', () => {
    assert.strictEqual(registry.effectFor('run_bash', { mutates: true }), registry.SIDE_EFFECT.EXECUTE);
    assert.strictEqual(registry.effectFor('web_fetch', { mutates: false }), registry.SIDE_EFFECT.NETWORK);
    assert.strictEqual(registry.effectFor('some_new_write_tool', { mutates: true }), registry.SIDE_EFFECT.WRITE);
    assert.strictEqual(registry.effectFor('some_new_read_tool', { mutates: false }), registry.SIDE_EFFECT.READ);
  });

  // -------------------------------------------------------------- timeline --

  await test('TIMELINE: it is a projection, and it holds no state of its own', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'harness', 'timeline.js'), 'utf8');
    assert.ok(!/class\s+Timeline/.test(src), 'a third copy of the same facts cannot disagree with its source only if it does not exist');
    assert.ok(!/\.on\s*\(/.test(src), 'it must not subscribe — the events are already recorded twice');
  });

  await test('TIMELINE: every event kind renders as a fact, never as a feeling', () => {
    const rows = [
      { type: EVENT.TASK_CREATED, at: 1, title: 'x' },
      { type: EVENT.TASK_STATE, at: 2, from: 'RUNNING', to: 'VERIFYING', why: 'the model stopped' },
      { type: EVENT.PROCESS_FAILED, at: 3, name: 'frontend', why: 'exited with 1' },
      { type: EVENT.VERIFICATION_FAILED, at: 4, why: 'the flow failed' },
      { type: EVENT.BROWSER_OBSERVED, at: 5, what: 'flow', url: 'http://x', failures: 2 },
      { type: EVENT.HOOK_RAN, at: 6, hook: 'h', point: 'task.started', ms: 3, ok: true },
    ].map(timeline.line);
    assert.match(rows[0], /task created/);
    assert.match(rows[1], /RUNNING → VERIFYING/);
    assert.match(rows[2], /frontend FAILED/);
    assert.match(rows[3], /verification FAILED/);
    assert.match(rows[4], /2 failed assertion/);
    assert.match(rows[5], /hook h at task.started/);
  });

  await test('TIMELINE: an event with no case still appears, rather than vanishing', () => {
    // A new name should look slightly raw on the timeline, not be invisible
    // until somebody remembers to add a case.
    const text = timeline.line({ type: 'something.new', at: 1, why: 'because' });
    assert.match(text, /something.new/);
    assert.match(text, /because/);
  });

  await test('TIMELINE: it prefers the durable log and falls back to the bus', () => {
    const bus = new EventBus();
    const h = new Harness({ bus, workspace: tmp(), persist: false });
    const t = h.begin({ title: 'x' });
    h.runtime.start(t.id);
    const rows = h.timeline(t.id, { limit: 50 });
    assert.ok(rows.length >= 2, 'with persistence off the bus is all there is, and it is enough');
    assert.ok(rows.every((r) => typeof r.time === 'string' && r.text));
  });
};
