'use strict';

/**
 * THE PROMPT THAT KEPT COMING BACK.
 *
 * A Probe session the user started with `/mcp probe` and was sitting in front
 * of raised the same desktop-permission modal every ten minutes, because LAIN's
 * only two grant scopes were both wall clocks. Same Probe, same window, same
 * question, already answered — which reads as a malfunction and trains the
 * answer out of anybody who uses it for an hour.
 *
 * What these check is the shape of the replacement, and BOTH halves of it. A
 * scope that never expires is trivial to write and is a security hole; the
 * property that makes it narrower rather than looser is that it is bound to a
 * session identity and cannot outlive it. So there are as many tests here for
 * the grant ENDING as for it lasting.
 */

const assert = require('assert');
const { test } = require('../helpers');

const P = require('../../src/permissions');

/** A Permissions with a clock we control. */
function perms() {
  let now = 1_000_000;
  const p = new P.Permissions({ now: () => now });
  return { p, advance: (ms) => { now += ms; } };
}

module.exports = async function () {
  await test('PROBE PERM: a probe grant does not expire on the clock — that is the whole point', () => {
    const { p, advance } = perms();
    p.grant(['screen'], { scope: P.SCOPE.PROBE, session: 'c_one' });
    advance(P.SESSION_MS * 100);                 // hours later
    assert.strictEqual(p.check('screen').ok, true, 'a watched Probe session must not lapse mid-investigation');
  });

  await test('PROBE PERM: a SESSION grant still expires — the old scope is untouched', () => {
    const { p, advance } = perms();
    p.grant(['screen'], { scope: P.SCOPE.SESSION });
    advance(P.SESSION_MS + 1);
    assert.strictEqual(p.check('screen').ok, false, 'the wall-clock scopes must keep their timers');
  });

  await test('PROBE PERM: the grant ENDS when the session it names ends', () => {
    const { p } = perms();
    p.grant(['screen', 'mouse'], { scope: P.SCOPE.PROBE, session: 'c_one' });
    const ended = p.endProbeSession('c_one');
    assert.deepStrictEqual(ended.sort(), ['mouse', 'screen']);
    assert.strictEqual(p.check('screen').ok, false);
    assert.strictEqual(p.check('mouse').ok, false);
    assert.strictEqual(p.probeAuthorised, false);
  });

  await test('PROBE PERM: A RECONNECTED PROBE INHERITS NOTHING', () => {
    // The security property. A new connection is a new id, so the old grant
    // stops matching and is dropped on the next check rather than quietly
    // covering a session the user never authorised.
    const { p } = perms();
    p.grant(['screen'], { scope: P.SCOPE.PROBE, session: 'c_one' });
    p.endProbeSession('c_one');
    p.probeSession = 'c_two';                    // as if a second Probe connected
    assert.strictEqual(p.check('screen').ok, false, 'the new session must ask for itself');
  });

  await test('PROBE PERM: a stale teardown cannot revoke a NEWER session\'s grants', () => {
    // The old connection's `_down` can fire after the new one is up. Keyed on
    // the id so a late teardown is a no-op rather than a silent revocation.
    const { p } = perms();
    p.grant(['screen'], { scope: P.SCOPE.PROBE, session: 'c_two' });
    const ended = p.endProbeSession('c_one', 'the old one died');
    assert.deepStrictEqual(ended, []);
    assert.strictEqual(p.check('screen').ok, true, 'the live session must survive an old teardown');
  });

  await test('PROBE PERM: a probe grant with no session is REFUSED, not granted forever', () => {
    // A never-expiring grant that nothing can end is the hole this scope would
    // otherwise be. It has to be impossible to create by accident.
    const { p } = perms();
    const r = p.grant(['screen'], { scope: P.SCOPE.PROBE });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(p.check('screen').ok, false);
  });

  await test('PROBE PERM: /mcp revoke ends the authorisation, not just the grants', () => {
    // Revoking used to clear the grants and leave the session marked
    // authorised, so the next request could be re-granted at probe scope
    // without the user being asked again about what they had just revoked.
    const { p } = perms();
    p.grant(['screen'], { scope: P.SCOPE.PROBE, session: 'c_one' });
    p.revoke('you revoked it');
    assert.strictEqual(p.probeAuthorised, false);
    assert.strictEqual(p.check('screen').ok, false);
  });

  await test('PROBE PERM: ending a session leaves non-probe grants alone', () => {
    const { p } = perms();
    p.grant(['screen'], { scope: P.SCOPE.PROBE, session: 'c_one' });
    p.grant(['keyboard'], { scope: P.SCOPE.SESSION });
    p.endProbeSession('c_one');
    assert.strictEqual(p.check('screen').ok, false);
    assert.strictEqual(p.check('keyboard').ok, true, 'a bridge grant is a different decision');
  });

  await test('PROBE PERM: the request offers the SESSION option only when a Probe is live', () => {
    const without = P.requestAdapterSpec({ caps: ['screen'] }).options.map((o) => o.value);
    assert.deepStrictEqual(without, ['once', 'session', 'deny']);
    const with_ = P.requestAdapterSpec({ caps: ['screen'], probeSession: 'c_one' });
    assert.deepStrictEqual(with_.options.map((o) => o.value), ['once', 'probe', 'deny']);
    assert.ok(/until the Probe exits/.test(with_.options[1].label), with_.options[1].label);
  });

  await test('PROBE PERM: Deny is always the last option and is never a scope', () => {
    for (const spec of [
      P.requestAdapterSpec({ caps: ['screen'] }),
      P.requestAdapterSpec({ caps: ['screen'], probeSession: 'c_one' }),
    ]) {
      const last = spec.options[spec.options.length - 1];
      assert.strictEqual(last.value, 'deny');
      assert.ok(!Object.values(P.SCOPE).includes('deny'));
    }
  });

  await test('PROBE PERM: the Probe\'s teardown really calls it — both paths', () => {
    // The two halves have to be wired to each other; a scope that ends with the
    // session and a session that never says it ended is the same bug as before.
    const probeMod = require('../../src/probe');
    const ended = [];
    const fakePerms = { endProbeSession: (id, why) => ended.push([id, why]) };
    const app = { desktop: () => ({ permissions: fakePerms }), session: null };

    const a = new probeMod.Probe({}, app);
    a.connectionId = 'c_close';
    a.close('you stopped it');

    const b = new probeMod.Probe({}, app);
    b.connectionId = 'c_crash';
    b._pending = new Map();
    b._down('the Probe exited (code 1)');

    assert.deepStrictEqual(ended.map((e) => e[0]), ['c_close', 'c_crash'],
      'both /mcp stop probe and an unexpected exit must end the authorisation');
  });

  await test('PROBE PERM: a teardown with no permission system does not throw', () => {
    // A permission system that can throw out of a teardown leaves the grant
    // standing, which is the failure mode that matters.
    const probeMod = require('../../src/probe');
    const p = new probeMod.Probe({}, { desktop: () => { throw new Error('no desktop'); } });
    p.connectionId = 'c_x';
    p._pending = new Map();
    p.close('closed');
    p._down('gone');
  });

  await test('PROBE PERM: state() reports a probe grant as granted, with no countdown', () => {
    // The status views read `msLeft`. A probe grant has no clock, so it must
    // report null rather than a number that would tick down to a lie.
    const { p } = perms();
    p.grant(['screen'], { scope: P.SCOPE.PROBE, session: 'c_one' });
    const st = p.state();
    assert.strictEqual(st.active, true);
    assert.strictEqual(st.capabilities.screen.granted, true);
    assert.strictEqual(st.capabilities.screen.msLeft, null);
    assert.strictEqual(st.capabilities.screen.scope, 'probe');
  });
};
