'use strict';

/**
 * THE DESKTOP CONTROL WINDOW — a second window, on top, while LAIN has control.
 *
 * When something is moving your mouse and typing on your keyboard, the one
 * thing you must never have to do is go and find the terminal that started it.
 * So a grant opens a SEPARATE window that stays above the work, says exactly
 * what is permitted and to which application, counts the grant down, shows every
 * action as it happens, and stops everything with one key.
 *
 * HOW THE TWO PROCESSES TALK. A directory under the config home, written by
 * LAIN and read by the window:
 *
 *     control/state.json    what is permitted, the target, recent actions
 *     control/revoke        exists ⇒ the user pressed STOP over there
 *
 * Files rather than a socket, deliberately: this must keep working when the
 * bridge is wedged, when the dashboard is off, and when a port is unavailable —
 * and the STOP path in particular must have as little machinery under it as
 * possible. LAIN polls for the flag while a grant is live and revokes the
 * instant it appears.
 *
 * IT IS A VIEWER AND A STOP BUTTON. It cannot grant anything, cannot extend a
 * grant, and cannot ask for one; the only thing it can do to LAIN is take
 * permission away, which is the one direction that is always safe.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/** How often LAIN looks for a STOP from the window. */
const POLL_MS = 400;

let child = null;
let timer = null;

function dir() {
  const base = (() => {
    try { return require('./config').configDir(); } catch { return path.join(os.homedir(), '.lain-v2'); }
  })();
  return path.join(base, 'control');
}

function statePath() { return path.join(dir(), 'state.json'); }
function revokePath() { return path.join(dir(), 'revoke'); }

/** What the window draws. Written on every change; read on a timer over there. */
function write(app) {
  let status;
  try { status = app.desktop().bridge.status(); } catch { return false; }
  const perms = status.permissions || { capabilities: {} };
  const payload = {
    at: Date.now(),
    pid: process.pid,
    project: require('./ui/text').projectName(app.session.cwd),
    bridge: { state: status.state, name: status.name, reason: status.reason || null },
    target: status.target || null,
    active: Boolean(perms.active),
    capabilities: perms.capabilities || {},
    activity: (status.activity || []).slice(-8).map((a) => ({ text: a.text, ok: a.ok })),
  };
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = statePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, statePath());
    return true;
  } catch { return false; }
}

/** Has the user pressed STOP in the control window? */
function stopRequested() {
  try { return fs.existsSync(revokePath()); } catch { return false; }
}

function clearStop() {
  try { fs.unlinkSync(revokePath()); } catch { /* already gone */ }
}

/**
 * Open the window (if it is not already open) and keep it fed.
 *
 * Called when a grant is made — that is the moment there is something to watch.
 * A window that cannot be opened is REPORTED, never silently skipped: the user
 * would otherwise believe they had a stop button they do not have.
 */
function open(app) {
  clearStop();
  write(app);
  if (!child) {
    const viewer = path.join(__dirname, '..', 'bin', 'lain-control.js');
    try {
      child = process.platform === 'win32'
        // `start` gives it a console window of its own. The title argument is
        // EMPTY on purpose: a quoted title with spaces does not survive the
        // layers of quoting between Node, cmd and start — it arrived as the
        // single word "DESKTOP" — and the viewer sets its own console title
        // from inside, which does survive.
        ? spawn('cmd', ['/c', 'start', '', process.execPath, viewer, dir()], { detached: true, stdio: 'ignore' })
        : spawn(process.execPath, [viewer, dir()], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) {
      child = null;
      app.render.notice('warn',
        `could not open the desktop control window (${e.message}). `
        + '/mcp revoke in this terminal is the stop button until it can.');
    }
  }
  if (!timer) {
    timer = setInterval(() => {
      write(app);
      if (!stopRequested()) return;
      clearStop();
      const had = app.desktop().permissions.revoke('you pressed STOP in the control window');
      app.render.notice('warn', had.length
        ? `DESKTOP CONTROL REVOKED from the control window — ${had.join(', ')}`
        : 'desktop control stopped from the control window');
      if (app.ui && app.ui.enabled) app.ui.refresh();
      write(app);
    }, POLL_MS);
    if (timer.unref) timer.unref();
  }
  return Boolean(child);
}

/** Refresh what the window shows. Cheap; safe to call on every change. */
function update(app) { return write(app); }

/** Stop watching. The window itself notices and says CONTROL ENDED. */
function close(app = null) {
  if (timer) { clearInterval(timer); timer = null; }
  if (app) write(app);
  child = null;
  return true;
}

module.exports = { open, update, close, write, stopRequested, clearStop, dir, statePath, revokePath, POLL_MS };
