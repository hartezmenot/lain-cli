'use strict';

/**
 * A PROBE TURN MUST CARRY LAIN'S OWN EVIDENCE DISCIPLINE, NOT JUST THE PROBE'S
 * CONTRACT.
 *
 * Found while auditing interactive discovery behaviour: the Probe's skill
 * digest (or its fallback) describes what THE PROBE's operations do, but says
 * nothing about how LAIN should spend its OWN evidence budget around them —
 * whether to read an existing project before the first Probe call, whether to
 * re-observe an unchanged screen, or whether to write an undiscovered value
 * merely to see what changes. Those are LAIN's calls, not the Probe's, so they
 * have to be said by LAIN and cannot be left to a document the Probe owns.
 */

const assert = require('assert');
const { test } = require('../helpers');
const probeskill = require('../../src/probeskill');
const probeMod = require('../../src/probe');

function withFakeLiveProbe(probe, fn) {
  const original = probeMod.live;
  probeMod.live = () => probe;
  try { return fn(); } finally { probeMod.live = original; }
}

module.exports = async function () {
  await test('PROBE DISCIPLINE: a probe-originated turn carries the behavioural commitments', async () => {
    const probe = { skillDigest: '' };
    const app = { _probe: probe };
    const sys = withFakeLiveProbe(probe, () => probeskill.decorate(app, 'BASE SYSTEM PROMPT', 'probe'));

    assert.ok(sys.includes('BASE SYSTEM PROMPT'), 'the original system prompt must survive, untouched');
    assert.ok(sys.includes(probeskill.DISCIPLINE), 'the discipline block must be appended');
    assert.ok(/prior evidence/i.test(sys), 'must say the project is prior evidence, not ground truth');
    assert.ok(/transition/i.test(sys), 'must prefer state transitions over static reads');
    assert.ok(/ask the user/i.test(sys), 'must direct LAIN to ask the user for a controlled action');
    // ACROSS A LINE BREAK. `.` does not match a newline, so this asserted that
    // the warning was on ONE line rather than that it was present — and it
    // failed the day somebody re-wrapped the paragraph, with the text still
    // saying exactly what it had always said. A test about WORDING must not be
    // a test about line width.
    assert.ok(/writ(?:e|ing)[\s\S]{0,80}(candidate|address)/i.test(sys),
      'must explicitly warn against writing an unidentified value to test it');
  });

  await test('PROBE DISCIPLINE: present even when the Probe has its own current skill digest', async () => {
    const probe = { skillDigest: 'THE PROBE\'S OWN LIVE CONTRACT TEXT' };
    const app = { _probe: probe };
    const sys = withFakeLiveProbe(probe, () => probeskill.decorate(app, 'BASE', 'probe'));

    assert.ok(sys.includes("THE PROBE'S OWN LIVE CONTRACT TEXT"), 'the live contract must still be included');
    assert.ok(sys.includes(probeskill.DISCIPLINE),
      'LAIN\'s own discipline is orthogonal to the Probe\'s contract and must not be dropped just because a live digest exists');
  });

  await test('PROBE DISCIPLINE: absent for an ordinary (non-Probe) turn', () => {
    const sys = probeskill.decorate({ _probe: null }, 'BASE', 'terminal');
    assert.strictEqual(sys, 'BASE', 'a turn typed at the ordinary prompt must not be decorated at all');
  });

  await test('PROBE DISCIPLINE: absent when no Probe is actually connected', () => {
    const sys = withFakeLiveProbe(null, () => probeskill.decorate({ _probe: null }, 'BASE', 'probe'));
    assert.strictEqual(sys, 'BASE', 'describing a companion that is not there is worse than saying nothing');
  });

  for (const [name, probe] of [
    ['a current, live contract', { skillDigest: 'THE PROBE\'S OWN LIVE CONTRACT TEXT', _investigation: '' }],
    ['the fallback contract', { skillDigest: '', _investigation: '' }],
  ]) {
    await test(`PROBE LIVE STATE: absent when the Probe did not carry it (${name})`, () => {
      const app = { _probe: probe };
      const sys = withFakeLiveProbe(probe, () => probeskill.decorate(app, 'BASE', 'probe'));
      assert.ok(sys.includes(probeskill.DISCIPLINE), 'discipline must still be appended');
      assert.ok(!sys.includes('ACTIVE PROBE INVESTIGATION'),
        'no live-state block may appear when the Probe sent none');
    });
  }

  await test('PROBE LIVE STATE: a Probe turn is decorated with the carried investigation state', () => {
    const probe = {
      skillDigest: '',
      _investigation: '# ACTIVE PROBE INVESTIGATION\n\nTarget:\n  Process: game.exe\n'
        + 'Lifecycle stage: DISCOVERY\n\nActive objective: Find the player.',
    };
    const app = { _probe: probe };
    const sys = withFakeLiveProbe(probe, () => probeskill.decorate(app, 'BASE', 'probe'));

    assert.ok(sys.includes('ACTIVE PROBE INVESTIGATION'), 'the live investigation block must be injected');
    assert.ok(/game\.exe/.test(sys), 'the target from the investigation must reach the model');
    assert.ok(/Lifecycle stage: DISCOVERY/.test(sys), 'the lifecycle stage must reach the model');
    assert.ok(/Find the player/.test(sys), 'the active objective must reach the model');
    assert.ok(sys.includes(probeskill.DISCIPLINE), 'LAIN\'s own discipline must still be appended');
  });

  await test('PROBE LIVE STATE: a non-Probe turn is never decorated, even with carried state', () => {
    const probe = { skillDigest: '', _investigation: '# ACTIVE PROBE INVESTIGATION' };
    const app = { _probe: probe };
    const sys = withFakeLiveProbe(probe, () => probeskill.decorate(app, 'BASE', 'terminal'));
    assert.strictEqual(sys, 'BASE',
      'an ordinary turn must not be touched just because a Probe happens to hold state');
  });
};
