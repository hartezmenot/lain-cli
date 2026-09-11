'use strict';

/**
 * THE HARNESS AS AN APPLICATION WINDOW — the first real step out of the CLI.
 *
 * ------------------------------------------------------------------------
 * WHAT THE PRODUCT BOUNDARY SAYS, AND WHERE THIS SITS AGAINST IT.
 *
 *                          LAIN INSTALLER
 *                    ┌───────────┴───────────┐
 *              Harness Desktop            lain CLI
 *                    └───────────┬───────────┘
 *                             LAIN Core
 *
 * The blueprint is explicit that LAIN Harness is not "a webpage living inside
 * LAIN CLI". Until now it was exactly that: `/app` printed a localhost URL and
 * a password into the terminal, and whatever the person did next happened in a
 * browser tab among their other tabs, visually a child of the CLI that spawned
 * it.
 *
 * This makes it a WINDOW. Chromium's `--app=<url>` gives a frame with no tab
 * strip, no address bar, its own taskbar entry and its own icon — the thing a
 * person alt-tabs to rather than hunts for. It runs on the Harness-owned
 * Chromium and a Harness-owned profile, so it is not the person's browser and
 * carries none of their cookies.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS NOT, STATED PLAINLY SO NOBODY MARKS IT DONE.
 *
 * It is NOT a native desktop application. There is no menu bar, no tray icon,
 * no file associations, no single-instance handling beyond what is below, no
 * auto-update, no native file dialogs, and the process is a Chromium.
 *
 * AND THE REASON IS A REAL CONSTRAINT, not an omission. A native shell means
 * Electron, Tauri, or an OS webview binding — every one of which is an npm
 * dependency and a build step. This project has NEITHER: `package.json` has no
 * `dependencies` key at all and ships source only. Adding one is a decision
 * about what LAIN is, not a task to slip into an implementation pass.
 *
 * THE PATH WHEN IT IS TAKEN is almost certainly `rust/lain-supervisor`, which
 * already exists, already ships as a native binary, and could host a webview
 * without any of that reaching the Node package. This module is deliberately
 * shaped so that swapping the host underneath changes nothing above it: the
 * application is served over loopback and driven by structured state, so a
 * native window is a different frame around the same product.
 *
 * ------------------------------------------------------------------------
 * IT NEVER PARSES CLI OUTPUT. The window talks to the same structured state
 * the terminal renders — see harnessapp/state.js and harnessipc.js. Nothing
 * here spawns `lain` and reads ANSI, which is the architecture the blueprint
 * forbids in as many words.
 */

const path = require('path');
const purpose = require('../env/purpose');

/** One window per LAIN process. A second `/app` focuses rather than duplicates. */
let held = null;

/**
 * IS THERE A WINDOW ALREADY? A `child` that has exited is not a window, and
 * treating one as live is how `/app` stops working until the session restarts.
 */
function existing() {
  if (!held) return null;
  const alive = held.child && held.child.exitCode == null && !held.child.killed;
  if (!alive) { held = null; return null; }
  return held;
}

/**
 * OPEN THE APPLICATION WINDOW.
 *
 * Falls back to the person's default browser — reporting that it did — rather
 * than failing, because a Harness in a tab is worth much more than no Harness.
 * Which one happened is in the return value, so the caller can say so.
 */
async function open(app, url, { width = 1440, height = 900 } = {}) {
  const live = existing();
  if (live) {
    // ALREADY OPEN. Chromium focuses an existing `--app` window when asked for
    // the same URL and profile, so the second launch is cheap and does the
    // right thing; there is no cross-platform way to raise a window we hold a
    // handle to without one.
    return { ok: true, already: true, mode: 'window', why: '' };
  }

  const rt = require('../env/chromium');
  const runtime = rt.forApp(app);
  const found = rt.resolve({ policy: runtime.policy() });
  if (!found.ok) {
    const fell = await require('../openexternal').open(url);
    return fell.ok
      ? { ok: true, mode: 'browser', why: `no Harness browser (${found.why}) — opened your default browser instead` }
      : { ok: false, mode: 'none', why: `${found.why}; and the default browser would not open: ${fell.why}` };
  }

  let profileDir;
  try {
    profileDir = runtime.profileFor(purpose.PURPOSE.HARNESSAPP);
  } catch (e) {
    return { ok: false, mode: 'none', why: `no application profile: ${(e && e.message) || e}` };
  }

  const args = rt.appWindowArgs(url, profileDir, { width, height });
  let child;
  try {
    // NOT THROUGH THE ProcessManager, and not through ChromiumRuntime.launch.
    // Both of those exist to own an INSTRUMENT with a CDP port that LAIN drives.
    // This window is not driven: there is no debug port, nothing connects to
    // it, and it must outlive every task. It is closed by `close()` and by
    // process exit, like the Workshop's preview and for the same reason.
    child = require('child_process').spawn(found.path, args, {
      detached: false, stdio: 'ignore', windowsHide: false,
    });
  } catch (e) {
    const fell = await require('../openexternal').open(url);
    return fell.ok
      ? { ok: true, mode: 'browser', why: `the application window would not start (${(e && e.message) || e})` }
      : { ok: false, mode: 'none', why: `the application window would not start: ${(e && e.message) || e}` };
  }

  held = { child, url, profileDir, browserPath: found.path, version: found.version, startedAt: Date.now() };
  child.on('exit', () => { if (held && held.child === child) held = null; });
  child.on('error', () => { if (held && held.child === child) held = null; });

  return {
    ok: true, mode: 'window', why: '',
    version: found.version, owned: found.owned, profileDir,
  };
}

/** What a status surface may know. A shape and a fact; never contents. */
function status() {
  const live = existing();
  if (!live) return { open: false, mode: null };
  return {
    open: true,
    mode: 'window',
    url: live.url,
    version: live.version,
    profile: path.basename(live.profileDir),
    uptimeMs: Date.now() - live.startedAt,
  };
}

/** Close the window LAIN opened. Never touches anything it did not start. */
function close() {
  const live = existing();
  if (!live) return { closed: false };
  try { live.child.kill(); } catch { /* already gone */ }
  held = null;
  return { closed: true };
}

module.exports = { open, close, status, existing };
