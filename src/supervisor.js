'use strict';

/**
 * THE CLIENT FOR THE PROCESS THAT OUTLIVES THIS ONE.
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS FOR, in one measurement. `app._jobs` is a `Jobs` instance held in
 * memory on the App. It is never persisted and appears in no session state, so
 * a background worker survives a failed TURN and dies with the PROCESS — and a
 * suite that finished thirty seconds after LAIN crashed finished for nobody.
 * Two handover properties failed on exactly that, because nothing outlived the
 * application to watch the work.
 *
 * The supervisor (rust/lain-supervisor) owns those workers instead. This file
 * is the only thing in LAIN that talks to it.
 *
 * ------------------------------------------------------------------------
 * IT IS ALWAYS OPTIONAL, and that is a hard rule rather than a courtesy.
 *
 * LAIN is a zero-dependency Node program that must run on a machine with no
 * Rust toolchain, and 2,567 passing tests do not get to become conditional on a
 * binary being built. So every function here answers with a STATE rather than
 * throwing: `available:false` when the binary is absent, and the existing
 * in-process `jobs.js` continues to be what `run_background` uses. Nothing in
 * the tool vocabulary changes, and nothing regresses when the supervisor is not
 * there — see `probe()`.
 *
 * ------------------------------------------------------------------------
 * DISCOVERY IS A FILE AND A PID, which is `instances.js`'s convention and is
 * borrowed on purpose: the supervisor writes `endpoint.json` under LAIN's config
 * home, and a record is only believed if the process it names is alive. The one
 * failure this must never have is handing somebody a port that now belongs to
 * something else.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/** A supervisor call is local and should be instant; hanging is the failure. */
const TIMEOUT_MS = 5000;
/** How long to wait for a freshly spawned supervisor to announce its port. */
const START_TIMEOUT_MS = 8000;

function home() {
  if (process.env.LAIN_HOME) return process.env.LAIN_HOME;
  const base = process.env.USERPROFILE || process.env.HOME || '.';
  return path.join(base, '.lain-v2');
}

function stateDir(root = home()) { return path.join(root, 'supervisor'); }
function endpointFile(root = home()) { return path.join(stateDir(root), 'endpoint.json'); }

/**
 * Where the built binary is. Debug and release are both accepted because a
 * contributor who ran `cargo build` should not have to learn why it did not
 * take effect.
 */
function binary() {
  // THE OVERRIDE IS CHECKED LIKE ANY OTHER PATH. Returning it unverified made
  // `probe()` report a supervisor that was available and `ensure()` then spawn
  // something that does not exist — which fails asynchronously, long after the
  // call that could have reported it honestly.
  const forced = process.env.LAIN_SUPERVISOR_BIN;
  if (forced) {
    try { return fs.statSync(forced).isFile() ? forced : null; } catch { return null; }
  }
  const exe = process.platform === 'win32' ? 'lain-supervisor.exe' : 'lain-supervisor';
  const root = path.join(__dirname, '..', 'rust', 'lain-supervisor', 'target');
  // THE NEWEST BUILD WINS, not a fixed preference for `release`. Preferring
  // release unconditionally meant that `cargo build` (which writes debug) left
  // a stale release binary in charge, so a change was made, tested, and had no
  // effect — the supervisor answering was one built hours earlier. Whichever was
  // compiled most recently is the one the developer meant.
  let best = null;
  for (const profile of ['release', 'debug']) {
    const p = path.join(root, profile, exe);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { path: p, mtimeMs: st.mtimeMs };
    } catch { /* not built in this profile */ }
  }
  return best ? best.path : null;
}

/** Is this process alive? The pid is the truth; the file is a hint. */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The endpoint a live supervisor is serving on, or null. */
function endpoint(root = home()) {
  let raw;
  try { raw = fs.readFileSync(endpointFile(root), 'utf8'); } catch { return null; }
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || !v.pid || !v.port) return null;
  if (!alive(v.pid)) return null;
  return { pid: v.pid, port: v.port, version: v.version || null };
}

/**
 * WHAT IS ACTUALLY POSSIBLE RIGHT NOW — one answer, never an exception.
 *
 * `{ available, running, why }`. Callers branch on this; nothing here decides
 * policy, and the absence of a toolchain is a normal state rather than an error.
 */
function probe() {
  const bin = binary();
  const ep = endpoint();
  if (ep) return { available: true, running: true, endpoint: ep, binary: bin, why: '' };
  if (!bin) {
    return {
      available: false, running: false, endpoint: null, binary: null,
      why: 'the supervisor binary is not built — run `cargo build --release` in rust/lain-supervisor',
    };
  }
  return { available: true, running: false, endpoint: null, binary: bin, why: 'no supervisor is running' };
}

/**
 * Send one request and read one reply.
 *
 * A connection per call. These are rare, local and small, and a persistent
 * socket would be a second lifetime to manage for no measurable gain — while
 * costing exactly the property this whole component exists for, since a client
 * holding a socket open is a client whose death is visible to the server.
 */
function send(port, msg, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const sock = net.connect({ port, host: '127.0.0.1' });
    let buf = '';
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* gone */ } done({ ok: false, error: 'supervisor timed out' }); }, timeoutMs);
    sock.on('connect', () => { sock.write(`${JSON.stringify(msg)}\n`); });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      const line = buf.slice(0, nl);
      try { sock.end(); } catch { /* already closing */ }
      let parsed;
      try { parsed = JSON.parse(line); } catch { parsed = { ok: false, error: 'unreadable reply' }; }
      done(parsed);
    });
    sock.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: `supervisor unreachable: ${e.message}` }); });
    sock.on('close', () => { clearTimeout(timer); done({ ok: false, error: 'supervisor closed the connection' }); });
  });
}

/**
 * Make sure one is running, and return the endpoint.
 *
 * DETACHED, with its streams let go. That is the whole mechanism: a child that
 * shares this process's stdio and process group would be torn down with it, and
 * the requirement is precisely that it is not. `unref()` then removes it from
 * this process's event loop so LAIN can exit whenever it likes.
 */
const starting = new Map();
const owned = new Map();

function ensure(opts = {}) {
  const root = path.resolve(home());
  if (starting.has(root)) return starting.get(root);
  const pending = start(root, opts).finally(() => starting.delete(root));
  starting.set(root, pending);
  return pending;
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  const deadline = Date.now() + 3000;
  while (alive(child.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (alive(child.pid)) throw new Error(`owned supervisor ${child.pid} did not stop`);
}

/** Only processes spawned by this client, never one discovered in another home. */
async function cleanupOwned() {
  await Promise.all([...starting.values()]);
  const results = await Promise.allSettled([...owned.values()].map(stopChild));
  for (const [pid, child] of owned) if (!alive(pid) || child.exitCode !== null) owned.delete(pid);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

async function start(root, { startTimeoutMs = START_TIMEOUT_MS, signal = null } = {}) {
  if (signal && signal.aborted) return { available: true, running: false, why: 'supervisor startup cancelled' };
  const first = probe();
  if (first.running) return first;
  if (!first.available) return first;

  try { fs.mkdirSync(stateDir(root), { recursive: true }); } catch { /* reported by readiness */ }
  let child;
  let spawnError = null;
  try {
    child = spawn(first.binary, ['serve', '--home', root], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, LAIN_HOME: root },
    });
    // A SPAWN FAILURE ARRIVES LATE, AND UNHANDLED IT IS FATAL. `spawn` reports
    // ENOENT by emitting `error` on the child, after this function has already
    // returned — and an 'error' event with no listener takes the whole Node
    // process down. LAIN must never die because an optional component is
    // missing, so the failure is absorbed here and surfaced by the readiness
    // poll below, which is the thing that can actually report it.
    child.on('error', (e) => { spawnError = e; });
    if (child.pid) {
      owned.set(child.pid, child);
      child.once('exit', () => owned.delete(child.pid));
    }
    child.unref();
  } catch (e) {
    return { available: false, running: false, endpoint: null, binary: first.binary, why: `could not start the supervisor: ${e.message}` };
  }

  // It announces by writing the endpoint file. Poll briefly for it rather than
  // holding a pipe, because holding a pipe is the thing we just avoided.
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError || (signal && signal.aborted)) break;
    const ep = endpoint(root);
    if (ep) {
      const pong = await send(ep.port, { op: 'ping' }, { timeoutMs: Math.max(1, Math.min(500, deadline - Date.now())) });
      if (pong && pong.ok) return { available: true, running: true, endpoint: ep, binary: first.binary, why: '' };
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  await stopChild(child);
  if (signal && signal.aborted) return { available: true, running: false, endpoint: null, why: 'supervisor startup cancelled' };
  return { available: true, running: false, endpoint: null, binary: first.binary, why: 'the supervisor did not announce a port in time' };
}

/**
 * ONE CALL TO A SUPERVISOR THAT IS ALREADY THERE — and never one that is not.
 *
 * `call` below starts one when none is running, which is right for submitting a
 * job and wrong for everything the Guardian does: guardian.js is on the input
 * path and on the turn loop's status callback, and neither may pay eight
 * seconds for a process to boot. So the two are separate functions rather than
 * a flag, because a flag on the wrong call site is a spawn nobody meant.
 *
 * Answers `{ok:false}` when nothing is listening, which every caller already
 * treats as "the runtime cannot say", the same as an unbuilt binary.
 */
async function callIfRunning(msg, opts = {}) {
  const ep = endpoint();
  if (!ep) return { ok: false, error: 'no supervisor is running' };
  return send(ep.port, msg, opts);
}

/** One call, with discovery in front of it. Returns the supervisor's reply. */
async function call(msg, opts = {}) {
  const ep = endpoint();
  if (!ep) {
    const started = await ensure(opts);
    if (!started.running) return { ok: false, error: started.why || 'no supervisor' };
    return send(started.endpoint.port, msg, opts);
  }
  return send(ep.port, msg, opts);
}

/**
 * Start work that must outlive this process.
 *
 * `requestId` is the idempotency key and matters more than it looks: a client
 * that loses the connection between sending this and reading the reply does not
 * know whether the work started. Retrying with the same key returns the SAME
 * job rather than a second copy of a build. See §14 and Registry::submit.
 */
async function submit({ command, shell = '', cwd = '', session = '', requestId = '', deadlineSecs = 0 }, opts = {}) {
  if (!command) return { ok: false, error: 'submit needs a command' };
  const request_id = requestId || `${session || 'nosession'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  // THE WINDOW BELONGS TO THE JOB. Passed once, at submission, and then owned by
  // the supervisor — no later turn, model or provider can quietly move it.
  const deadline_secs = Math.max(0, Math.floor(Number(deadlineSecs) || 0));
  return call({ op: 'submit', command, shell, cwd, session, request_id, deadline_secs }, opts);
}

/**
 * EXECUTION EVENTS SINCE `after` — what happened while nobody was reasoning.
 *
 * The reconnect path for the brain rather than for the job list: a worker may
 * have failed, or run out its window, at a moment when no model was connected.
 * Compact by construction — identifiers and measurements, never a log.
 */
async function events({ after = 0, limit = 50 } = {}, opts = {}) {
  return call({ op: 'events', after, limit }, opts);
}

async function status(jobId, opts = {}) { return call({ op: 'status', job_id: jobId }, opts); }
async function cancel(jobId, opts = {}) { return call({ op: 'cancel', job_id: jobId }, opts); }

// ---------------------------------------------------------------------------
// PROVIDER HEALTH — the second thing that must outlive a LAIN process.
//
// `availability.js` holds this in a Map on the App, under a comment saying it
// is in-memory by design because "a restart legitimately knows nothing". That
// is right about a circuit breaker and wrong about a rate limit: when a
// provider says `retry in 4 hours` it has stated a fact with a future in it,
// and a LAIN that restarts five minutes later calls the closed route, is
// refused, and pays for the same discovery again — while the model picker, the
// one screen where "which of these can I use right now" is asked, shows the
// closed door as untried.
//
// So the durable copy lives with the supervisor and the Map becomes a hot
// mirror in front of it. See rust/lain-supervisor/src/providers.rs.
//
// STILL ALWAYS OPTIONAL. Every function here returns `{ok:false}` rather than
// throwing when no binary is built, and `availability.js` works exactly as it
// did before in that case — see the hard rule at the top of this file.
// ---------------------------------------------------------------------------

/**
 * A REQUEST HAPPENED AND THIS IS HOW IT WENT.
 *
 * The only way a machine may change provider state, and it mirrors the single
 * call site in turn.js where health is already learned from requests that were
 * going to happen anyway. There is no ping loop on either side of the socket.
 *
 * `resetAt` is an absolute epoch-ms time and 0 means THE PROVIDER DID NOT SAY.
 * That distinction is carried all the way through: the supervisor stores it as
 * null and every reader is expected to print "unknown reset" rather than draw a
 * countdown to a number nobody supplied.
 */
async function noteProvider({
  connectionId, ok = false, kind = '', reason = '', provider = '', model = '',
  resetAt = 0, failureThreshold = 0,
} = {}, opts = {}) {
  if (!connectionId) return { ok: false, error: 'noteProvider needs a connectionId' };
  return call({
    op: 'provider_note',
    connection_id: String(connectionId),
    ok: Boolean(ok),
    kind: String(kind || ''),
    reason: String(reason || '').slice(0, 300),
    provider: String(provider || ''),
    model: String(model || ''),
    reset_at: Math.max(0, Math.floor(Number(resetAt) || 0)),
    failure_threshold: Math.max(0, Math.floor(Number(failureThreshold) || 0)),
  }, opts);
}

/**
 * EVERY ROUTE THIS MACHINE KNOWS ABOUT — the reconnect path for provider state.
 *
 * Asked once at startup: a brand-new LAIN is told which doors were shut while
 * it did not exist, and until when.
 */
async function providers(opts = {}) { return call({ op: 'provider_list' }, opts); }

/** A decision a PERSON made — `/provider disable`, `/provider maintenance`. */
async function setProvider(connectionId, statusWord, reason = '', opts = {}) {
  if (!connectionId) return { ok: false, error: 'setProvider needs a connectionId' };
  return call({ op: 'provider_set', connection_id: String(connectionId), status: String(statusWord || 'UNKNOWN'), reason: String(reason || '') }, opts);
}

/**
 * `/provider retry` — back to knowing nothing about this route.
 *
 * `forget` removes the row outright, for a connection that has been deleted
 * from the config; without it the store would keep answering about routes that
 * no longer exist.
 */
async function clearProvider(connectionId, { forget = false } = {}, opts = {}) {
  if (!connectionId) return { ok: false, error: 'clearProvider needs a connectionId' };
  return call({ op: 'provider_clear', connection_id: String(connectionId), forget: Boolean(forget) }, opts);
}

/**
 * Every job the supervisor knows about, optionally for one session.
 *
 * This is the reconnect path: a brand-new LAIN process asks and is told what
 * happened while it did not exist.
 */
async function list({ session = '' } = {}, opts = {}) { return call({ op: 'list', session }, opts); }

/** Stop the supervisor. Running workers are NOT killed — this process stops. */
async function shutdown(opts = {}) {
  const ep = endpoint();
  if (!ep) return { ok: true, note: 'nothing running' };
  return send(ep.port, { op: 'shutdown' }, opts);
}

/** Test/installer teardown for an explicit home. Verify the wire's PID first. */
async function shutdownIn(root, { timeoutMs = 3000 } = {}) {
  const ep = endpoint(root);
  if (!ep) return;
  const pong = await send(ep.port, { op: 'ping' }, { timeoutMs });
  if (!pong.ok || pong.pid !== ep.pid) throw new Error(`cannot verify supervisor identity in ${root}`);
  await send(ep.port, { op: 'shutdown' }, { timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (alive(ep.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (alive(ep.pid)) throw new Error(`supervisor ${ep.pid} remained after teardown in ${root}`);
}

/**
 * Build the binary. Only ever called deliberately — never on a normal start,
 * because a coding CLI that shells out to a compiler at launch is a coding CLI
 * that fails to launch on a machine without one.
 */
function build({ release = true } = {}) {
  const dir = path.join(__dirname, '..', 'rust', 'lain-supervisor');
  const args = ['build', '--offline'];
  if (release) args.push('--release');
  const r = spawnSync('cargo', args, { cwd: dir, encoding: 'utf8' });
  return {
    ok: r.status === 0,
    status: r.status,
    output: `${r.stdout || ''}${r.stderr || ''}`.slice(-4000),
  };
}

module.exports = {
  probe, ensure, submit, status, cancel, list, events, shutdown, shutdownIn, build,
  call, callIfRunning,
  noteProvider, providers, setProvider, clearProvider,
  endpoint, binary, alive, stateDir, endpointFile, TIMEOUT_MS, cleanupOwned,
};
