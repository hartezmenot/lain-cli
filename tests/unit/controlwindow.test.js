'use strict';

/**
 * THE DESKTOP CONTROL WINDOW.
 *
 * Its whole value is that the STOP works when nothing else does, so what is
 * asserted here is the PROTOCOL between the two processes — a state file LAIN
 * writes and a flag file the window writes — rather than the drawing. Files,
 * not a socket, precisely so the stop path has as little under it as possible.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { test } = require('../helpers');

const VIEWER = path.join(__dirname, '..', '..', 'bin', 'lain-control.js');
const BRIDGE = path.join(__dirname, '..', 'fixtures', 'stub-bridge.js');

function isolated(fn) {
  const before = process.env.LAIN_CONFIG_DIR;
  process.env.LAIN_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlwin-'));
  try { return fn(); } finally { process.env.LAIN_CONFIG_DIR = before; }
}

function fakeApp() {
  const { App } = require('../../src/app');
  const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
  app.cfg.mcp = { command: [process.execPath, BRIDGE] };
  return app;
}

module.exports = async function () {
  await test('CTLWIN: the state file says exactly what is permitted, and to what', () => {
    isolated(() => {
      const cw = require('../../src/controlwindow');
      const app = fakeApp();
      app.desktop().permissions.grant(['screen', 'mouse'], { scope: 'session', target: 'Cheat Engine' });
      assert.strictEqual(cw.write(app), true);
      const s = JSON.parse(fs.readFileSync(cw.statePath(), 'utf8'));
      assert.strictEqual(s.active, true);
      assert.strictEqual(s.target, 'Cheat Engine');
      assert.strictEqual(s.capabilities.screen.granted, true);
      assert.strictEqual(s.capabilities.mouse.granted, true);
      // The narrowness has to survive the trip, or the window would show a
      // grant the user never gave.
      assert.strictEqual(s.capabilities.keyboard.granted, false);
      assert.strictEqual(s.capabilities.window.granted, false);
    });
  });

  await test('CTLWIN: the state carries no secrets — it is a window into permission only', () => {
    isolated(() => {
      const cw = require('../../src/controlwindow');
      const app = fakeApp();
      app.cfg.apiKey = 'sk-never-here';
      app.session.messages.push({ role: 'user', content: 'my private prompt text' });
      app.desktop().permissions.grant(['screen'], { scope: 'once' });
      cw.write(app);
      const raw = fs.readFileSync(cw.statePath(), 'utf8');
      assert.ok(!/sk-never-here/.test(raw));
      assert.ok(!/my private prompt text/.test(raw));
    });
  });

  await test('CTLWIN: STOP is a flag file — the simplest thing that can work', () => {
    isolated(() => {
      const cw = require('../../src/controlwindow');
      const app = fakeApp();
      assert.strictEqual(cw.stopRequested(), false);
      fs.mkdirSync(cw.dir(), { recursive: true });
      fs.writeFileSync(cw.revokePath(), '1');
      assert.strictEqual(cw.stopRequested(), true);
      cw.clearStop();
      assert.strictEqual(cw.stopRequested(), false);
      cw.close(app);
    });
  });

  await test('CTLWIN: a STOP from the window revokes, and the NEXT action is refused', async () => {
    const before = process.env.LAIN_CONFIG_DIR;
    process.env.LAIN_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlwin-'));
    const cw = require('../../src/controlwindow');
    const app = fakeApp();
    try {
      const { bridge, permissions } = app.desktop();
      assert.strictEqual((await bridge.connect()).ok, true);
      permissions.grant(['window'], { scope: 'session', target: 'Anything' });
      cw.write(app);
      assert.strictEqual((await bridge.call('window.list')).ok, true, 'granted, so it goes through');

      fs.writeFileSync(cw.revokePath(), String(Date.now()));
      // The poll is what LAIN runs while a grant is live; drive one tick of it.
      if (cw.stopRequested()) { cw.clearStop(); permissions.revoke('stopped from the control window'); }

      const after = await bridge.call('window.list');
      assert.strictEqual(after.ok, false, 'the very next action must be refused');
      assert.strictEqual(after.denied, true);
      assert.ok(permissions.log.some((l) => l.event === 'revoked'), 'and it is on the record');
      bridge.close();
      cw.close(app);
    } finally {
      process.env.LAIN_CONFIG_DIR = before;
    }
  });

  await test('CTLWIN: the viewer renders the state it is given, and can only STOP', async () => {
    // Run the REAL viewer against a state file and read the frame it drew.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlview-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      project: 'scalpbot',
      bridge: { state: 'CONNECTED', name: 'stub-bridge' },
      target: 'Cheat Engine',
      active: true,
      capabilities: {
        screen: { granted: true, msLeft: 42000 },
        keyboard: { granted: true, msLeft: 42000 },
        mouse: { granted: false },
        window: { granted: false },
      },
      activity: [{ text: 'keyboard.type — ok', ok: true }],
    }));
    const frame = await new Promise((resolve) => {
      const child = execFile(process.execPath, [VIEWER, dir], { env: { ...process.env, NO_COLOR: '1' } });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      setTimeout(() => { child.kill(); resolve(out); }, 1200);
    });
    const shown = (frame.split('\x1b[2J\x1b[H').pop() || '').replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(shown, /LAIN DESKTOP CONTROL/);
    assert.match(shown, /● ACTIVE/);
    assert.match(shown, /Target\s+Cheat Engine/);
    assert.match(shown, /Screen\s+✓ ALLOWED/);
    assert.match(shown, /Keyboard\s+✓ ALLOWED/);
    assert.match(shown, /Mouse\s+—/, 'a capability that was NOT granted must not read as allowed');
    assert.match(shown, /keyboard\.type — ok/, 'each action shows as it happens');
    assert.match(shown, /STOP CONTROL/);
    // It is a viewer and a stop button. Nothing in it can grant or extend.
    const src = fs.readFileSync(VIEWER, 'utf8');
    assert.ok(!/grant\(/.test(src), 'the window must never be able to grant anything');
  });

  await test('CTLWIN: the window opens on a GRANT, not at launch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'permissions.js'), 'utf8');
    assert.match(src, /perms\.grant\(spec\.caps[\s\S]{0,400}controlwindow'\)\.open\(app\)/,
      'it must be opened by the grant itself — there is nothing to watch before one');
  });
};
