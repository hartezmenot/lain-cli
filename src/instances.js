'use strict';

/**
 * WHICH LAINS ARE RUNNING — a registry of live instances.
 *
 * The dashboard assumed one global LAIN. Open two projects in two terminals and
 * you got two dashboards on two ephemeral ports with no way to tell which was
 * which, no way to switch, and no reason to prefer one URL over the other.
 *
 * ------------------------------------------------------------------------
 * A DIRECTORY OF SMALL FILES, not a daemon and not a lock.
 *
 * `~/.lain-v2/instances/<pid>.json`, written when the dashboard starts and
 * removed on the way out. Choosing files over a coordinating process is the
 * whole design: there is nothing to start, nothing to keep alive, nothing that
 * can be down, and a crash leaves a stale file rather than a wedged service.
 *
 * THE PID IS THE TRUTH, THE FILE IS A HINT. A record is only believed if the
 * process it names is still alive — `kill(pid, 0)` — because the one thing this
 * must never do is point somebody at a port that now belongs to something else.
 * Stale files are swept on read.
 *
 * NEVER ATTACHES. This records where an instance says it is listening; it does
 * not connect, proxy or send anything. Switching instances in the dashboard is
 * the browser opening a different URL, which keeps two LAINs exactly as
 * separate as they are on the machine — their state is never merged.
 *
 * NOTHING SECRET GOES IN. No token, no password hash, no message content, no
 * API key. The file says a LAIN exists, where its dashboard listens and what it
 * is working on; the credential is still required to see anything, and these
 * files are readable by anything that can read the config directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./config');

/** A record older than this is swept even if a process happens to hold the pid. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Bound on how much of an objective is recorded. It is a label, not a log. */
const MAX_TASK = 120;

function dir() { return path.join(config.configDir(), 'instances'); }
function fileFor(pid) { return path.join(dir(), `${pid}.json`); }

/**
 * Is this process still alive?
 *
 * `kill(pid, 0)` sends no signal and only asks. EPERM means it exists and
 * belongs to somebody else — which is still ALIVE, and reading it as dead is
 * how a live instance gets swept out of its own registry.
 */
function alive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Announce this instance, or update what it says about itself.
 *
 * Best-effort by design: a registry that cannot be written is a dashboard
 * without a switcher, not a LAIN that fails to start.
 */
function announce({ port, host, project, cwd, session, model, provider, state, task } = {}) {
  const rec = {
    pid: process.pid,
    port: Number(port) || 0,
    host: host || '127.0.0.1',
    project: String(project || ''),
    cwd: String(cwd || ''),
    session: String(session || ''),
    model: model || null,
    provider: provider || null,
    state: state || 'READY',
    task: task ? String(task).replace(/\s+/g, ' ').slice(0, MAX_TASK) : null,
    startedAt: (current && current.startedAt) || Date.now(),
    at: Date.now(),
    host_name: os.hostname(),
  };
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(fileFor(process.pid), JSON.stringify(rec), 'utf8');
    current = rec;
    return rec;
  } catch {
    return null;
  }
}

/** What this process last announced, so `announce` can keep `startedAt` stable. */
let current = null;

/** Stop advertising this instance. Called on the way out. */
function withdraw() {
  try { fs.unlinkSync(fileFor(process.pid)); } catch { /* already gone */ }
  current = null;
}

/**
 * Every LIVE instance, newest first, with the dead ones swept as we go.
 *
 * @param {object} opts  `{ includeSelf }` — the dashboard wants itself in the
 *                       list so it can mark which one you are looking at.
 */
function list({ includeSelf = true } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const p = path.join(dir(), name);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { rec = null; }
    // A FILE THAT CANNOT BE READ, NAMES A DEAD PROCESS, OR IS ANCIENT IS SWEPT.
    // The point of the registry is that everything in it can be opened; a row
    // that cannot is worse than a shorter list.
    const old = rec && rec.at && (Date.now() - rec.at) > MAX_AGE_MS;
    if (!rec || !rec.pid || !alive(rec.pid) || old) {
      try { fs.unlinkSync(p); } catch { /* someone else got there first */ }
      continue;
    }
    if (!includeSelf && rec.pid === process.pid) continue;
    out.push({
      ...rec,
      self: rec.pid === process.pid,
      url: rec.port ? `http://127.0.0.1:${rec.port}/` : null,
      uptimeMs: rec.startedAt ? Date.now() - rec.startedAt : 0,
    });
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return out;
}

module.exports = { announce, withdraw, list, alive, dir, MAX_AGE_MS, MAX_TASK };
