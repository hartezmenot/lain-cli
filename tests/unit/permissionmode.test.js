'use strict';

/**
 * THE THIRD ANSWER THE GATE COULD NOT GIVE.
 *
 * There was one boolean — `autoOutsideProject` — reachable only through
 * `/trust strict` and `/trust auto`. It could say "ask me" and "don't ask me
 * about ordinary paths". It could not say "never ask me, refuse it", so on an
 * unattended run the gate put a prompt on a screen nobody was watching and
 * waited for an answer that was never coming.
 *
 * What these check is the mode itself, that ONE setting decides it, and — the
 * part worth being strict about — that NO mode can open a system or credential
 * location without asking.
 */

const assert = require('assert');
const path = require('path');
const { test } = require('../helpers');

const trust = require('../../src/trust');

const ROOT = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';
const OUTSIDE = process.platform === 'win32' ? 'C:\\elsewhere\\notes.txt' : '/elsewhere/notes.txt';
const SYSTEM = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
const CREDS = path.join(require('os').homedir(), '.ssh', 'id_rsa');

const check = (cfg, target = OUTSIDE) => trust.check({ cfg, root: ROOT, target });

module.exports = async function () {
  await test('MODE: ASK refuses, and says a person can settle it', () => {
    const v = check({ permissionMode: 'ASK' });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.ask, true, 'ASK must be answerable, or it is DENY under another name');
  });

  await test('MODE: AUTO lets an ordinary outside path through', () => {
    assert.strictEqual(check({ permissionMode: 'AUTO' }).ok, true);
  });

  await test('MODE: DENY REFUSES WITHOUT ASKING — the state that was missing', () => {
    // `ask: false` is the whole point: on an unattended run nothing may put a
    // prompt on a screen nobody is watching and then wait.
    const v = check({ permissionMode: 'DENY' });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.ask, false, 'DENY must not raise a prompt');
    assert.match(v.why, /DENY/);
  });

  await test('MODE: NO MODE OPENS A SYSTEM LOCATION WITHOUT ASKING', () => {
    // The one property that must survive every mode. AUTO is the dangerous
    // case, because it is the mode that says yes.
    for (const mode of ['ASK', 'AUTO', 'DENY']) {
      const v = check({ permissionMode: mode }, SYSTEM);
      assert.strictEqual(v.ok, false, `${mode} allowed a system path outright`);
    }
    const auto = check({ permissionMode: 'AUTO' }, SYSTEM);
    assert.match(auto.why, /system or credential/);
  });

  await test('MODE: nor a credential location', () => {
    for (const mode of ['ASK', 'AUTO', 'DENY']) {
      assert.strictEqual(check({ permissionMode: mode }, CREDS).ok, false, `${mode} allowed ~/.ssh`);
    }
  });

  await test('MODE: the project itself is unaffected by the mode', () => {
    // The mode is about OUTSIDE. A trusted project stays trusted in all three.
    const cfg = (mode) => ({ permissionMode: mode, trustedPaths: [{ path: ROOT, level: 'TRUSTED' }] });
    for (const mode of ['ASK', 'AUTO', 'DENY']) {
      const v = trust.check({ cfg: cfg(mode), root: ROOT, target: path.join(ROOT, 'src', 'a.js'), write: true });
      assert.strictEqual(v.ok, true, `${mode} refused a write inside a trusted project`);
    }
  });

  await test('MODE: ONE SETTING DECIDES IT — the gate and the report agree', () => {
    // They used to be two: this command translated the boolean into its own
    // vocabulary while the gate read the boolean directly.
    const cmd = require('../../src/trustcommand');
    for (const mode of ['ASK', 'AUTO', 'DENY']) {
      assert.strictEqual(cmd.modeOf({ permissionMode: mode }), trust.modeOf({ permissionMode: mode }));
      assert.strictEqual(cmd.modeOf({ permissionMode: mode }), mode);
    }
  });

  await test('MODE: an existing config keeps behaving exactly as it did', () => {
    // The old boolean is READ, so nobody's settings change under them.
    assert.strictEqual(trust.modeOf({ autoOutsideProject: false }), trust.MODE.ASK);
    assert.strictEqual(trust.modeOf({ autoOutsideProject: true }), trust.MODE.AUTO);
    assert.strictEqual(trust.modeOf({}), trust.MODE.AUTO, 'the old default was auto');
  });

  await test('MODE: the new field WINS over the old boolean', () => {
    assert.strictEqual(trust.modeOf({ autoOutsideProject: true, permissionMode: 'DENY' }), trust.MODE.DENY);
  });

  await test('MODE: setting it REMOVES the old boolean rather than leaving both', () => {
    // Two settings that can disagree about what is allowed is the shape of bug
    // being replaced; leaving a stale one in the file recreates it.
    const cmd = require('../../src/trustcommand');
    const cfg = { autoOutsideProject: true };
    const app = { cfg, render: { write() {} }, session: { cwd: process.cwd() } };
    const C = new Proxy({}, { get: () => (s) => String(s == null ? '' : s) });
    cmd.setMode(app, 'deny', () => {}, C);
    assert.strictEqual(cfg.permissionMode, 'DENY');
    assert.ok(!('autoOutsideProject' in cfg), 'the superseded setting must be removed');
  });

  await test('MODE: /trust strict and /permissions mode ask record THE SAME THING', () => {
    const cmd = require('../../src/trustcommand');
    const C = new Proxy({}, { get: () => (s) => String(s == null ? '' : s) });
    const a = { cfg: {}, render: { write() {} }, session: { cwd: process.cwd() } };
    const b = { cfg: {}, render: { write() {} }, session: { cwd: process.cwd() } };
    cmd.setMode(a, 'strict', () => {}, C);
    cmd.setMode(b, 'ask', () => {}, C);
    assert.deepStrictEqual(a.cfg, b.cfg);
  });

  await test('MODE: the words people actually type are all accepted', () => {
    const cmd = require('../../src/trustcommand');
    for (const [word, want] of [
      ['ask', 'ASK'], ['strict', 'ASK'], ['confirm', 'ASK'],
      ['auto', 'AUTO'], ['allow', 'AUTO'],
      ['deny', 'DENY'], ['restricted', 'DENY'], ['off', 'DENY'],
    ]) {
      assert.strictEqual(cmd.MODE_WORDS[word], want, word);
    }
  });

  await test('MODE: an unknown word changes NOTHING and says what is valid', () => {
    const cmd = require('../../src/trustcommand');
    const said = [];
    const C = new Proxy({}, { get: () => (s) => String(s == null ? '' : s) });
    const app = { cfg: { permissionMode: 'AUTO' }, render: { write() {} }, session: { cwd: process.cwd() } };
    const ok = cmd.setMode(app, 'sometimes', (s) => said.push(s), C);
    assert.strictEqual(ok, false);
    assert.strictEqual(app.cfg.permissionMode, 'AUTO', 'a typo must not change the mode');
    assert.match(said.join(''), /ask \| auto \| deny/);
  });

  await test('MODE: every mode has a stated meaning, and the gate has no fourth behaviour', () => {
    assert.deepStrictEqual(Object.keys(trust.MODE_MEANS).sort(), ['ASK', 'AUTO', 'DENY']);
    for (const m of Object.values(trust.MODE)) assert.ok(trust.MODE_MEANS[m], `${m} has no explanation`);
  });
};
