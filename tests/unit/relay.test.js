'use strict';

/**
 * THE TWO-MODEL RELAY.
 *
 * LAIN investigates locally, a second model reviews what it found, LAIN acts,
 * and the reviewer looks at the result. The value of that is entirely in whether
 * you can trust which of them said a thing, so these assert:
 *
 *   - the packet is built from REAL state, and an empty field says it is empty
 *   - the reviewer is held to FACT / EVIDENCE / HYPOTHESIS / RECOMMENDATION
 *   - a reviewer that claims to have run something is FLAGGED, because it has
 *     no tools here and ran nothing
 *   - not configured is a state that is reported, never quietly substituted
 *   - "fixed" requires a command that ran and passed AFTER a change
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const external = require('../../src/external');
const investigation = require('../../src/investigation');

function fakeApp(over = {}) {
  const { App } = require('../../src/app');
  const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
  Object.assign(app.cfg, over);
  return app;
}

module.exports = async function () {
  // ------------------------------------------------------------ configured --

  await test('EXT: with nothing configured it is NOT CONFIGURED, and says which', () => {
    const s = external.settings({});
    assert.strictEqual(s.ok, false);
    assert.strictEqual(s.why, 'NOT CONFIGURED');
    assert.strictEqual(s.enabled, false);
  });

  await test('EXT: a model named but not served is a DIFFERENT problem, said differently', () => {
    const app = fakeApp({ externalTroubleshoot: { enabled: true, model: 'no-such-model' } });
    const r = external.route(app);
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /not served by any configured connection/);
    assert.notStrictEqual(r.why, 'NOT CONFIGURED', 'these are not the same thing and must not read the same');
  });

  await test('EXT: rounds are bounded and cannot be configured away', () => {
    assert.strictEqual(external.settings({ externalTroubleshoot: { model: 'm', maxRounds: 999 } }).maxRounds, 6);
    assert.strictEqual(external.settings({ externalTroubleshoot: { model: 'm', maxRounds: -4 } }).maxRounds, 1);
    // 0 is "not set", not "no rounds" — a relay with no rounds is not a relay.
    assert.strictEqual(external.settings({ externalTroubleshoot: { model: 'm', maxRounds: 0 } }).maxRounds, external.DEFAULT_MAX_ROUNDS);
    assert.strictEqual(external.settings({ externalTroubleshoot: { model: 'm' } }).maxRounds, external.DEFAULT_MAX_ROUNDS);
  });

  await test('EXT: `enabled: false` really disables it', () => {
    const s = external.settings({ externalTroubleshoot: { enabled: false, model: 'm' } });
    assert.strictEqual(s.ok, false);
    assert.match(s.why, /disabled/);
  });

  // ------------------------------------------------------------- the words --

  await test('EXT: the reply is read into the four sections it was asked for', () => {
    const s = external.sections([
      'FACT',
      '  Two handlers discard the exception.',
      'EVIDENCE',
      '  probot/dashboard.py lines 3-5.',
      'HYPOTHESIS',
      '  Not established: it may be hiding a startup failure.',
      'RECOMMENDATION',
      '  Log the exception, then run the module.',
    ].join('\n'));
    assert.match(s.fact.join(' '), /discard the exception/);
    assert.match(s.evidence.join(' '), /dashboard\.py/);
    assert.match(s.hypothesis.join(' '), /Not established/);
    assert.match(s.recommendation.join(' '), /Log the exception/);
  });

  await test('EXT: a reviewer claiming to have ACTED is flagged — it has no tools here', () => {
    // The worst possible failure of a two-model loop is an invented tool result
    // read as a real one.
    assert.strictEqual(external.overclaims('I ran the test suite and it passed.'), 'I ran');
    assert.strictEqual(external.overclaims('I opened dashboard.py.'), 'I opened');
    assert.strictEqual(external.overclaims('I have read the file.'), 'I have read');
    // Recommending an action is not claiming to have performed one.
    assert.strictEqual(external.overclaims('Run the test suite and read the output.'), null);
    assert.strictEqual(external.overclaims('LAIN should read dashboard.py.'), null);
  });

  await test('EXT: the system prompt forbids pretending, in words the model will read', () => {
    assert.match(external.SYSTEM, /NO tools/);
    assert.match(external.SYSTEM, /NEVER claim to have performed an action/);
    assert.match(external.SYSTEM, /FACT[\s\S]*EVIDENCE[\s\S]*HYPOTHESIS[\s\S]*RECOMMENDATION/);
  });

  // ---------------------------------------------------------------- packet --

  await test('PACKET: it is built from real state, and an empty field says so', () => {
    const app = fakeApp();
    const report = {
      problem: 'errors are silently dropped',
      evidence: { hits: [{ file: 'probot/dashboard.py', score: 9, matched: ['dropped'] }], markers: [{ id: 'emptycatch', plain: 'errors caught and silently dropped', count: 2 }], terms: ['dropped'], scanned: 3, total: 4 },
    };
    const p = investigation.buildPacket(app, report, { round: 1, of: 3 });
    assert.match(p, /INVESTIGATION PACKET — round 1 of 3/);
    assert.match(p, /PROBLEM AS STATED BY THE USER\n {2}errors are silently dropped/);
    assert.match(p, /probot\/dashboard\.py — 9 match\(es\)/);
    assert.match(p, /2 errors caught and silently dropped/);
    // The empty ones are NAMED as empty rather than omitted, so the reviewer can
    // tell "nothing was found" from "nobody looked".
    assert.match(p, /FILES INSPECTED SO FAR\n {2}\(none yet\)/);
    assert.match(p, /COMMANDS RUN SO FAR\n {2}\(none yet\)/);
    assert.match(p, /CHANGES ALREADY MADE THIS SESSION\n {2}\(nothing has been changed\)/);
    assert.match(p, /nothing has been run, so nothing is verified/);
    assert.match(p, /CURRENT HYPOTHESIS\n {2}\(none established yet\)/);
    assert.match(p, /Do not claim to have inspected anything yourself/);
  });

  await test('PACKET: the previous recommendation travels with the next round', () => {
    const app = fakeApp();
    const last = { ok: true, sections: { fact: [], evidence: [], hypothesis: ['maybe the handler'], recommendation: ['Log the exception first.'], rest: [] } };
    const p = investigation.buildPacket(app, { problem: 'x', evidence: {} }, { round: 2, of: 3, lastExternal: last });
    assert.match(p, /YOUR PREVIOUS RECOMMENDATION\n {2}Log the exception first\./);
    assert.match(p, /CURRENT HYPOTHESIS\n {2}maybe the handler/);
  });

  // --------------------------------------------------------------- verdict --

  await test('VERDICT: "fixed" needs a command that PASSED after a real change', () => {
    const app = fakeApp();
    app.session.lifecycle = null;
    assert.strictEqual(investigation.verdictAfterAction(app, 0).settled, false, 'nothing run is not fixed');

    app.session.lifecycle = { lastCommand: { command: 'pytest', ok: false } };
    const failing = investigation.verdictAfterAction(app, 0);
    assert.strictEqual(failing.settled, false);
    assert.match(failing.why, /still failing/);

    // A green check with nothing changed is not a fix either — it is a green
    // check on the same code that was broken a moment ago.
    app.session.lifecycle = { lastCommand: { command: 'pytest', ok: true } };
    const noChange = investigation.verdictAfterAction(app, 0);
    assert.strictEqual(noChange.settled, false);
    assert.match(noChange.why, /nothing was changed/);
  });

  await test('RELAY: every exit is NAMED — there is no silent stop', () => {
    const reasons = Object.values(investigation.STOP);
    assert.ok(reasons.includes('verified fixed'));
    assert.ok(reasons.includes('verified unresolved'));
    assert.ok(reasons.includes('you stopped it'));
    assert.ok(reasons.includes('round limit reached'));
    assert.ok(reasons.includes('the external model is unavailable'));
    assert.ok(reasons.includes('no external model is configured'));
  });

  await test('RELAY: unconfigured, it reports that and does the local work anyway', async () => {
    const dir = tmpdir('relay-');
    fs.writeFileSync(path.join(dir, 'a.py'), 'try:\n    x()\nexcept: pass\n');
    const app = fakeApp();
    app.session.cwd = dir;
    const said = [];
    app.render.write = (s) => said.push(s);
    const report = await investigation.relay(app, 'errors are dropped', {});
    const text = said.join('');
    assert.strictEqual(report.stop, investigation.STOP.NOT_CONFIGURED);
    assert.match(text, /EXTERNAL ACTOR/);
    assert.match(text, /NOT CONFIGURED/);
    assert.match(text, /continuing with local troubleshooting only/);
    // And the local evidence really was gathered and shown.
    assert.match(text, /TROUBLESHOOT/);
    assert.match(text, /silently dropped/);
  });

  await test('RELAY: /troubleshoot only takes the relay path when one is configured', () => {
    // The gate moved from "is a MODEL configured" to "is an ACTOR usable" —
    // deliberately, because a browser companion and a human relay need no model
    // and could never have reached the relay under the old question. The
    // strength of the check is unchanged: it must still read REAL state through
    // the actor's own status, never a flag someone set in the config.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'troubleshoot.js'), 'utf8');
    assert.match(src, /require\('\.\/actors'\)\.create\(app\)/,
      'the relay must be gated on a real actor, not on a flag someone set');
    assert.match(src, /reviewer\.status\(\)\.ok/,
      'and on that actor reporting itself usable, not merely existing');
    assert.match(src, /NOT CONFIGURED/, 'and the local path must say a reviewer was not used');
  });
};
