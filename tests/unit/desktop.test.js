'use strict';

/**
 * THE DESKTOP SEAM AND ITS GATE.
 *
 * These are the assertions that make the feature safe to have at all, so they
 * are about REFUSAL as much as about function:
 *
 *   - nothing is granted without an answered prompt, and there is no prompt to
 *     answer without an interactive terminal
 *   - a grant is narrow, temporary and revocable, and expiry is checked on use
 *   - a revoked or expired grant stops the NEXT action, not the next session
 *   - a bridge that dies takes every grant with it
 *   - LAIN reports what is actually true: NOT CONFIGURED, DISCONNECTED with a
 *     real reason, or CONNECTED with the capabilities the bridge advertised
 *
 * The bridge under test is a protocol double that performs nothing (see
 * tests/fixtures/stub-bridge.js). No test here controls a desktop.
 */

const assert = require('assert');
const path = require('path');
const { test } = require('../helpers');

const mcp = require('../../src/mcp');
const { Permissions, CAPABILITY } = require('../../src/permissions');

const BRIDGE = path.join(__dirname, '..', 'fixtures', 'stub-bridge.js');
const cfgFor = (extra = []) => ({ mcp: { command: [process.execPath, BRIDGE, ...extra] } });

/** A clock we control, so expiry is tested rather than waited for. */
function fakeClock(start = 1_000_000) {
  const t = { now: start };
  return { t, perms: new Permissions({ now: () => t.now }) };
}

module.exports = async function () {
  // ------------------------------------------------------------ permissions --

  await test('PERM: nothing is granted until it is granted', () => {
    const { perms } = fakeClock();
    for (const cap of Object.keys(CAPABILITY)) {
      assert.strictEqual(perms.check(cap).ok, false, `${cap} must start denied`);
    }
    assert.strictEqual(perms.state().active, false);
  });

  await test('PERM: a grant is NARROW — one capability is not all of them', () => {
    const { perms } = fakeClock();
    perms.grant(['screen'], { scope: 'once' });
    assert.strictEqual(perms.check('screen').ok, true);
    assert.strictEqual(perms.check('keyboard').ok, false, 'seeing the screen is not typing on it');
    assert.strictEqual(perms.check('mouse').ok, false);
  });

  await test('PERM: a grant EXPIRES, and expiry is checked on every use', () => {
    const { t, perms } = fakeClock();
    perms.grant(['keyboard'], { scope: 'once' });
    assert.strictEqual(perms.check('keyboard').ok, true);
    t.now += 61_000;
    const after = perms.check('keyboard');
    assert.strictEqual(after.ok, false, 'a minute later it is over');
    assert.match(after.why, /expired/);
    assert.ok(perms.log.some((l) => l.event === 'expired'), 'and the expiry is recorded');
  });

  await test('PERM: revoke is immediate, total, and cannot fail', () => {
    const { perms } = fakeClock();
    perms.grant(['screen', 'keyboard', 'mouse'], { scope: 'session' });
    assert.strictEqual(perms.state().active, true);
    const had = perms.revoke('stop button');
    assert.deepStrictEqual(had.sort(), ['keyboard', 'mouse', 'screen']);
    assert.strictEqual(perms.state().active, false);
    for (const cap of ['screen', 'keyboard', 'mouse']) assert.strictEqual(perms.check(cap).ok, false);
    assert.deepStrictEqual(perms.revoke(), [], 'revoking nothing is fine');
  });

  await test('PERM: every decision is logged, so "what did it do" is answerable', () => {
    const { perms } = fakeClock();
    perms.grant(['mouse'], { scope: 'once', target: 'Some App' });
    perms.used('mouse', 'mouse.click');
    perms.deny(['keyboard'], 'you said no');
    perms.revoke('done');
    const events = perms.log.map((l) => l.event);
    assert.deepStrictEqual(events, ['granted', 'used', 'denied', 'revoked']);
  });

  await test('PERM: with no interactive terminal there is no grant, ever', async () => {
    // A piped run, a one-shot -p and a test all land here. "Nobody could object"
    // is not consent.
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
    const r = await require('../../src/permissions').request(app, { caps: ['screen'] });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /no interactive terminal/);
    assert.strictEqual(app.desktop().permissions.check('screen').ok, false);
  });

  await test('PERM: the request SHOWS what is being granted, line by line', () => {
    // This was one clipped line — "An external model is asking for temporary
    // control of this machin…" — with the capability list eaten. Being asked to
    // grant control of your machine without being shown what you are granting
    // is the worst possible version of this prompt.
    const { requestAdapterSpec } = require('../../src/permissions');
    const spec = requestAdapterSpec({ caps: ['screen', 'keyboard'], target: 'Cheat Engine', reason: 'to read the value' });
    assert.strictEqual(spec.title, 'DESKTOP CONTROL REQUEST');
    const text = spec.lines.join('\n');
    assert.match(text, /✓ see the screen/);
    assert.match(text, /✓ send keystrokes/);
    assert.ok(!/move and click the mouse/.test(text), 'a capability NOT asked for must not be listed');
    assert.match(text, /target window: Cheat Engine/);
    assert.match(text, /reason: to read the value/);
    assert.deepStrictEqual(spec.options.map((o) => o.value), ['once', 'session', 'deny']);

    // And the panel must render every one of those lines as its own row.
    const { askAdapter } = require('../../src/ui/panel');
    const panel = askAdapter({ title: spec.title, question: spec.lines.join('\n'), options: spec.options.map((o) => o.label) });
    assert.strictEqual(panel.title, 'DESKTOP CONTROL REQUEST');
    const labels = panel.items.map((i) => i.label);
    for (const l of spec.lines) assert.ok(labels.includes(l), `"${l}" is not a row of its own`);
    assert.ok(labels.some((l) => /Deny/.test(l)), 'and Deny must be one of the choices');
  });

  // ---------------------------------------------------------------- bridge --

  await test('MCP: with nothing configured it says NOT CONFIGURED and starts nothing', async () => {
    const b = new mcp.Bridge({}, new Permissions());
    assert.strictEqual(b.state, mcp.STATE.NOT_CONFIGURED);
    const r = await b.connect();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(b.child, null, 'no process may be started for a bridge that does not exist');
    assert.strictEqual(b.status().configured, false);
  });

  await test('MCP: a real handshake reports the capabilities the bridge advertised', async () => {
    const b = new mcp.Bridge(cfgFor(['--caps', 'window.list,screen.capture']), new Permissions());
    const r = await b.connect();
    try {
      assert.strictEqual(r.ok, true, r.reason);
      assert.strictEqual(b.state, mcp.STATE.CONNECTED);
      assert.deepStrictEqual(b.capabilities, ['window.list', 'screen.capture']);
      assert.strictEqual(b.info.name, 'stub-bridge');
      // An op the bridge did not advertise is refused before anything is sent.
      const denied = await b.call('keyboard.type', { text: 'x' });
      assert.strictEqual(denied.ok, false);
      assert.match(denied.error, /does not offer/);
    } finally { b.close(); }
  });

  await test('MCP: a bridge that never answers the handshake is DISCONNECTED with a reason', async () => {
    const b = new mcp.Bridge(cfgFor(['--no-hello']), new Permissions());
    const r = await b.connect();
    try {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(b.state, mcp.STATE.DISCONNECTED);
      assert.match(b.reason, /handshake failed/);
      assert.match(b.reason, /no answer within/, 'the real reason, not a generic failure');
    } finally { b.close(); }
  });

  await test('MCP: no permission means the operation is NOT SENT', async () => {
    const perms = new Permissions();
    const b = new mcp.Bridge(cfgFor(), perms);
    await b.connect();
    try {
      const r = await b.call('window.list');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.denied, true, 'a refusal is a refusal, not a transport error');
      assert.strictEqual(r.capability, 'window');
      assert.ok(!perms.log.some((l) => l.event === 'used'), 'nothing may be recorded as used');
    } finally { b.close(); }
  });

  await test('MCP: with permission the operation goes through, and is recorded', async () => {
    const perms = new Permissions();
    const b = new mcp.Bridge(cfgFor(), perms);
    await b.connect();
    try {
      perms.grant(['window'], { scope: 'once', target: 'Cheat Engine' });
      const r = await b.call('window.list');
      assert.strictEqual(r.ok, true, r.error);
      assert.ok(Array.isArray(r.result) && r.result.length, 'the bridge answered');
      assert.ok(perms.log.some((l) => l.event === 'used' && /window/.test(l.detail)));
      assert.ok(b.status().activity.some((a) => /window\.list/.test(a.text)));
    } finally { b.close(); }
  });

  await test('MCP: revoking stops the NEXT action, not the next session', async () => {
    const perms = new Permissions();
    const b = new mcp.Bridge(cfgFor(), perms);
    await b.connect();
    try {
      perms.grant(['window'], { scope: 'session' });
      assert.strictEqual((await b.call('window.list')).ok, true);
      perms.revoke('stop');
      const after = await b.call('window.list');
      assert.strictEqual(after.ok, false, 'the very next call must be refused');
      assert.strictEqual(after.denied, true);
    } finally { b.close(); }
  });

  await test('MCP: a bridge that dies takes every grant with it', async () => {
    const perms = new Permissions();
    const b = new mcp.Bridge(cfgFor(['--die']), perms);
    await b.connect();
    perms.grant(['screen', 'keyboard'], { scope: 'session' });
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(b.state, mcp.STATE.DISCONNECTED);
    assert.strictEqual(perms.state().active, false, 'permission must not outlive the thing it was for');
    const r = await b.call('screen.capture');
    assert.strictEqual(r.ok, false);
  });

  await test('MCP: an unknown operation is refused before any permission question', async () => {
    const perms = new Permissions();
    const b = new mcp.Bridge(cfgFor(), perms);
    await b.connect();
    try {
      const r = await b.call('process.inject', { pid: 1 });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /unknown desktop operation/);
      // The seam is SCREEN / MOUSE / KEYBOARD / WINDOW. Nothing else is callable.
      assert.deepStrictEqual(Object.keys(mcp.OPS).sort(), [
        'keyboard.key', 'keyboard.type', 'mouse.click', 'mouse.move',
        'screen.capture', 'window.focus', 'window.list',
      ]);
    } finally { b.close(); }
  });

  // ------------------------------------------------------------------ tool --

  await test('TOOL: `desktop` is not a name the model can call at all', () => {
    // It USED to be offered whenever a bridge was configured, which made it the
    // second of three vocabularies for one machine. The bridge is still here —
    // everything above this line still tests it — but `computer` is the only
    // name the model sees, over either transport. See unit/onecomputer.test.js.
    const tools = require('../../src/tools');
    assert.ok(!tools.names().includes('desktop'), 'the bridge is a transport, not a tool name');
    // And the two lists stay identical either way — the guard's property.
    assert.deepStrictEqual(tools.schemas().map((s) => s.name).sort(), tools.names().sort());
  });
};
