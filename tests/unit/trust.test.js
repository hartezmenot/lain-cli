'use strict';

/**
 * WHICH DIRECTORIES LAIN MAY WORK IN.
 *
 * Opening a coding agent on a folder hands it a shell and a filesystem, and
 * nothing asked before doing that. These pin the shape of the answer: an
 * undecided directory is not consent, read-only really refuses writes, and the
 * places where a mistake takes a machine or an account with it are never
 * approved automatically whatever the mode says.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const trust = require('../../src/trust');

const ROOT = path.join(os.tmpdir(), 'lain-trust-project');
const cfgWith = (dir, level) => ({ trustedPaths: [{ path: dir, level }] });

module.exports = async function () {
  await test('TRUST: an undecided directory is UNTRUSTED, and asking is the answer', () => {
    // The absence of an answer is not consent — the same rule permissions.js
    // holds for the screen.
    const cfg = {};
    assert.strictEqual(trust.levelOf(cfg, ROOT), trust.LEVEL.UNTRUSTED);
    assert.strictEqual(trust.decided(cfg, ROOT), false);
    const r = trust.check({ cfg, root: ROOT, target: path.join(ROOT, 'a.js') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.ask, true, 'it must be askable, not a dead end');
  });

  await test('TRUST: a trusted directory allows reads AND writes inside it', () => {
    const cfg = cfgWith(ROOT, trust.LEVEL.TRUSTED);
    for (const write of [false, true]) {
      const r = trust.check({ cfg, root: ROOT, target: path.join(ROOT, 'src', 'a.js'), write });
      assert.strictEqual(r.ok, true, `write=${write} should be allowed`);
    }
  });

  await test('TRUST: READ_ONLY really refuses the write, and only the write', () => {
    const cfg = cfgWith(ROOT, trust.LEVEL.READ_ONLY);
    assert.strictEqual(trust.check({ cfg, root: ROOT, target: path.join(ROOT, 'a.js') }).ok, true,
      'reading is the whole point of read-only');
    const w = trust.check({ cfg, root: ROOT, target: path.join(ROOT, 'a.js'), write: true });
    assert.strictEqual(w.ok, false);
    assert.strictEqual(w.ask, true);
    assert.match(w.why, /read-only/);
  });

  await test('TRUST: the LONGEST match wins, so a nested rule is not shadowed', () => {
    // Trusting `~/code` and marking `~/code/vendor` read-only must leave vendor
    // read-only, whichever order they were recorded in.
    const outer = path.join(ROOT, 'code');
    const inner = path.join(outer, 'vendor');
    const cfg = { trustedPaths: [
      { path: outer, level: trust.LEVEL.TRUSTED },
      { path: inner, level: trust.LEVEL.READ_ONLY },
    ] };
    assert.strictEqual(trust.levelOf(cfg, outer), trust.LEVEL.TRUSTED);
    assert.strictEqual(trust.levelOf(cfg, inner), trust.LEVEL.READ_ONLY, 'the specific rule must win');
    // And with the entries the other way round.
    cfg.trustedPaths.reverse();
    assert.strictEqual(trust.levelOf(cfg, inner), trust.LEVEL.READ_ONLY, 'order must not decide it');
  });

  await test('TRUST: a path OUTSIDE the project is asked about, even when trusted', () => {
    const cfg = cfgWith(ROOT, trust.LEVEL.TRUSTED);
    const r = trust.check({ cfg, root: ROOT, target: path.join(os.tmpdir(), 'somewhere-else', 'x.txt') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.outside, true);
    assert.match(r.why, /outside this project/);
  });

  await test('TRUST: auto mode allows an ORDINARY outside path', () => {
    // "auto is fine as long as it is not a root/system location" — the user's
    // own rule, and the reason autoOutside exists at all.
    const cfg = cfgWith(ROOT, trust.LEVEL.TRUSTED);
    const r = trust.check({
      cfg, root: ROOT, target: path.join(os.tmpdir(), 'scratch', 'notes.md'), autoOutside: true,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outside, true, 'it is still recorded as outside');
  });

  await test('TRUST: auto mode NEVER covers a system or credential location', () => {
    // The one rule that does not bend. These are not "dangerous files" — that
    // game cannot be won — they are the roots where a mistake is a broken
    // machine or a leaked key.
    const cfg = cfgWith(ROOT, trust.LEVEL.TRUSTED);
    const never = process.platform === 'win32'
      ? ['C:\\', 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'C:\\Program Files\\x',
        path.join(os.homedir(), '.ssh', 'id_rsa'), os.homedir()]
      : ['/', '/etc/passwd', '/usr/bin/env', path.join(os.homedir(), '.ssh', 'id_rsa'), os.homedir()];
    for (const target of never) {
      const r = trust.check({ cfg, root: ROOT, target, autoOutside: true });
      assert.strictEqual(r.ok, false, `${target} must never be automatic`);
      assert.strictEqual(r.ask, true, `${target} must still be askable`);
      assert.ok(trust.sensitive(target), `${target} must read as sensitive`);
    }
  });

  await test('TRUST: an ordinary project directory is NOT sensitive', () => {
    // The guard has to be narrow, or it asks about everything and gets clicked
    // through without reading.
    for (const p of [ROOT, path.join(ROOT, 'src', 'index.js'), path.join(os.homedir(), 'Documents', 'proj')]) {
      assert.strictEqual(trust.sensitive(p), false, `${p} should be ordinary`);
    }
  });

  await test('TRUST: remembering replaces, never appends a contradiction', () => {
    let cfg = { trustedPaths: [] };
    cfg.trustedPaths = trust.remember(cfg, ROOT, trust.LEVEL.TRUSTED);
    cfg.trustedPaths = trust.remember(cfg, ROOT, trust.LEVEL.READ_ONLY);
    assert.strictEqual(cfg.trustedPaths.length, 1, 'two answers for one directory is one record');
    assert.strictEqual(trust.levelOf(cfg, ROOT), trust.LEVEL.READ_ONLY, 'the later answer wins');
    // And UNTRUSTED means forget it, not store a third state.
    cfg.trustedPaths = trust.remember(cfg, ROOT, trust.LEVEL.UNTRUSTED);
    assert.strictEqual(cfg.trustedPaths.length, 0);
    assert.strictEqual(trust.decided(cfg, ROOT), false);
  });

  await test('TRUST: `within` is not fooled by a shared prefix', () => {
    // `/home/user/project-secrets` is not inside `/home/user/project`.
    const base = path.join(os.tmpdir(), 'proj');
    assert.strictEqual(trust.within(path.join(base, 'a'), base), true);
    assert.strictEqual(trust.within(base, base), true, 'the root is inside itself');
    assert.strictEqual(trust.within(`${base}-secrets`, base), false, 'a shared prefix is not containment');
  });
};
