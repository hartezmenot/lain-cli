'use strict';

/**
 * THE PROCESS MANAGER — services that stay up, owned by a task.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT jobs.js, AND WHY NEITHER ABSORBS THE OTHER.
 *
 * `src/jobs.js` runs A COMMAND THAT ENDS. Its whole shape says so: QUEUED ->
 * RUNNING -> {SUCCEEDED, FAILED, CANCELLED, TIMED_OUT}, a default 30-minute
 * timeout, a captured result waiting to be read. `run_background` starts a test
 * suite and `job_wait` blocks on its exit. That is exactly right for a suite
 * and exactly wrong for a dev server, where every one of those is a mistake:
 * exit is a CRASH rather than a result, a timeout would kill the thing under
 * test, and "the result" never arrives because there isn't one.
 *
 * A service has questions a job has never had to answer: what PORT is it on, is
 * it HEALTHY, can it be RESTARTED without losing what depends on it, and who
 * cleans it up when the task ends. Bolting those onto the job vocabulary would
 * have made every field optional and every state ambiguous — is `RUNNING` a
 * suite that is executing or a server that is up but refusing connections?
 *
 * So: two vocabularies, one seam, stated here. A JOB ends and yields a RESULT.
 * A PROCESS stays up and has a HEALTH. Nothing in this file may wait for a
 * process to exit as though the exit were the point, and nothing in jobs.js may
 * grow a port.
 *
 * ------------------------------------------------------------------------
 * EVERY PROCESS HAS AN OWNER TASK, AND THAT IS WHAT MAKES CLEANUP POSSIBLE.
 *
 * The failure this prevents is documented in this repository's own status file:
 * roughly ninety orphaned supervisor processes accumulated across days of test
 * runs, because a timed-out harness never reached its teardown and every leaked
 * process kept polling a port forever. Ownership plus `cleanup(taskId)` is the
 * structural answer — a task that ends takes its services with it.
 *
 * ------------------------------------------------------------------------
 * NOTHING HERE POLLS ON ITS OWN.
 *
 * There is no interval anywhere in this file. A crash is learned from the
 * child's own `exit` event, which costs nothing and is instant. A health check
 * happens when somebody ASKS for one. `waitUntilHealthy` is the single place
 * that retries, it does so only while a caller is awaiting it, and it stops at
 * a deadline the caller chose.
 */

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const https = require('https');
const { EVENT } = require('../events');

const STATUS = Object.freeze({
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPED: 'STOPPED',
  CRASHED: 'CRASHED',
  FAILED: 'FAILED',
});

/** The process is gone and will not come back without a restart. */
const GONE = Object.freeze(new Set([STATUS.STOPPED, STATUS.CRASHED, STATUS.FAILED]));

/**
 * HEALTH IS NOT STATUS, and conflating them was the first design mistake here.
 *
 * STATUS is about the OS process: is there a pid, did it exit. HEALTH is about
 * the service: does it answer. A dev server that is RUNNING but returns 500 on
 * every request is a real and common state, and a single field cannot say it.
 *
 * UNKNOWN is a first-class answer and is the default. A process with no health
 * check configured is not "healthy" — nothing looked.
 */
const HEALTH = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  HEALTHY: 'HEALTHY',
  UNHEALTHY: 'UNHEALTHY',
});

/** How much of a service's output is kept in memory. */
const MAX_LOG = 200_000;
/** How long a health probe waits before calling it unhealthy. */
const PROBE_MS = 2000;
/** The gap between readiness attempts. Only ever used inside waitUntilHealthy. */
const RETRY_MS = 250;

let seq = 0;
const ownedChildren = new Set();

/** Shared containment for services and finite verification commands. */
function spawnOwned({ command, args = null, cwd, env = process.env, shell = null, cleanupPaths = [] }) {
  // On Windows the guardian must survive its caller's console/OS lifetime.
  // IPC remains referenced, so ordinary calls still await bounded cleanup.
  const child = spawn(process.execPath, [require.resolve('./processguardian')], {
    cwd, env, windowsHide: true, detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', (result) => {
    if (result.startedPid) child.commandPid = result.startedPid;
    else child.commandResult = result;
  });
  ownedChildren.add(child);
  child.once('close', () => ownedChildren.delete(child));
  child.on('error', () => {}); // callers report the failure; never an unhandled event
  if (cleanupPaths.length && child.pid) {
    // A sibling, not a descendant of the service tree: it must survive that
    // tree being killed to remove the profile once the files are unlocked.
    const cleaner = spawn(process.execPath, [require.resolve('./processcleanup'), String(child.pid), JSON.stringify(cleanupPaths)], {
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    cleaner.on('error', (e) => child.emit('error', e));
    cleaner.unref();
  }
  child.send({ command, args, cwd, env, shell, cleanupPaths }, (e) => { if (e) child.emit('error', e); });
  return child;
}

function stopTree(child, opts = {}) {
  if (!child) return Promise.resolve();
  if (!child._treeStop) child._treeStop = terminateTree(child, opts);
  return child._treeStop;
}

async function terminateTree(child, { graceMs = 3000 } = {}) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) {
    child.send({ stop: true }, () => {});
    const deadline = Date.now() + Math.max(1000, graceMs);
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    if (child.exitCode !== null || child.signalCode !== null) return;
  }
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('close', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  const deadline = Date.now() + Math.max(1000, graceMs);
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  if (child.exitCode === null && child.signalCode === null) throw new Error(`owned process ${child.pid} did not stop`);
}

async function cleanupOwned() {
  const results = await Promise.allSettled([...ownedChildren].map((child) => stopTree(child)));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Does anything accept a TCP connection on this port? */
function portOpen(port, host = '127.0.0.1', timeoutMs = PROBE_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* already gone */ } resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    try { sock.connect(port, host); } catch { done(false); }
  });
}

/** Does a URL answer, and with what status? Never throws. */
function httpProbe(url, timeoutMs = PROBE_MS) {
  return new Promise((resolve) => {
    let mod;
    let target;
    try { target = new URL(url); mod = target.protocol === 'https:' ? https : http; } catch { resolve({ ok: false, why: 'not a URL' }); return; }
    const req = mod.request(target, { method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      const code = res.statusCode || 0;
      resolve({ ok: code >= 200 && code < 400, status: code, why: `HTTP ${code}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, why: `no answer in ${timeoutMs}ms` }); });
    req.on('error', (e) => resolve({ ok: false, why: String((e && e.message) || e) }));
    req.end();
  });
}

class ManagedProcess {
  constructor({ taskId, name, command, args = null, cwd, env = null, port = null, health = null, shell = null }) {
    seq += 1;
    this.processId = `proc_${seq}`;
    this.taskId = taskId ? String(taskId) : null;
    this.name = String(name || 'service');
    this.command = String(command);
    this.args = Array.isArray(args) ? args.map(String) : null;
    this.cwd = cwd;
    this.env = env;
    this.shell = shell;
    this.port = port == null ? null : Number(port);
    /** `{url}` or `{port}` or null. Null means health is UNKNOWN, honestly. */
    this.healthSpec = health || (this.port ? { port: this.port } : null);
    this.status = STATUS.STARTING;
    this.health = HEALTH.UNKNOWN;
    this.healthWhy = 'nothing has looked yet';
    this.pid = null;
    this.exitCode = null;
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.restarts = 0;
    this.log = '';
    this._child = null;
    this._stopRequested = false;
    this._onExit = [];
  }

  _append(chunk) {
    this.log += chunk;
    if (this.log.length > MAX_LOG) this.log = this.log.slice(-MAX_LOG);
  }

  /** The last n lines of output — what a person actually reads. */
  tail(lines = 40) {
    return this.log.split('\n').slice(-Math.max(1, lines)).join('\n');
  }

  get alive() { return Boolean(this._child) && !GONE.has(this.status); }

  toJSON() {
    return {
      processId: this.processId, taskId: this.taskId, name: this.name,
      command: this.args ? `${this.command} ${this.args.join(' ')}` : this.command,
      pid: this.pid, commandPid: this.commandPid || null, port: this.port, status: this.status, health: this.health,
      healthWhy: this.healthWhy, exitCode: this.exitCode, restarts: this.restarts,
      startedAt: this.startedAt, stoppedAt: this.stoppedAt, cwd: this.cwd,
    };
  }
}

class ProcessManager {
  /**
   * @param {object} opts
   *   bus     — the shared EventBus. Optional.
   *   runtime — the TaskRuntime, so a process mirrors onto its owner's record.
   */
  constructor({ bus = null, runtime = null } = {}) {
    this.bus = bus;
    this.runtime = runtime;
    this._procs = new Map();
  }

  _emit(name, payload) {
    if (this.bus && typeof this.bus.emit === 'function') this.bus.emit(name, payload);
  }

  _mirror(p) {
    if (this.runtime && p.taskId) this.runtime.noteProcess(p.taskId, p.toJSON());
  }

  /**
   * START A SERVICE.
   *
   * Returns immediately with the record in STARTING. It does NOT wait for the
   * thing to be up — that is `waitUntilHealthy`, and keeping them apart matters:
   * a caller that wants to start three services and then check all of them must
   * not pay three sequential readiness waits.
   *
   * A SPAWN THAT FAILS IS A STATE, NOT A THROW. `command not found` arrives as
   * an `error` event on the child, becomes FAILED with the reason attached, and
   * the caller reads it like any other status.
   */
  start({ taskId = null, name, command, args = null, cwd = process.cwd(), env = null, port = null, health = null, shell = null, cleanupPaths = [] }) {
    if (taskId && this.runtime) {
      const owner = this.runtime.get(taskId);
      if (!owner || owner.terminal) throw new Error('a service requires an existing unfinished owner task');
    }
    const p = new ManagedProcess({ taskId, name, command, args, cwd, env, port, health, shell });
    p.cleanupPaths = cleanupPaths;
    this._procs.set(p.processId, p);
    this._spawn(p);
    this._emit(EVENT.PROCESS_STARTED, {
      processId: p.processId, taskId: p.taskId || '', name: p.name, port: p.port == null ? -1 : p.port, command: p.command,
    });
    this._mirror(p);
    return p;
  }

  _spawn(p) {
    let child;
    const opts = {
      cwd: p.cwd,
      env: p.env ? { ...process.env, ...p.env } : process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    };
    try {
      // A LIST OF ARGUMENTS MEANS NO SHELL, for the same reason process_run
      // takes one: a path with spaces needs no quoting and nothing is
      // re-parsed. A bare command string is run through a shell, because
      // `npm run dev -- --port 5173` is a shell line and pretending otherwise
      // would make the common case the awkward one.
      child = spawnOwned({ command: p.command, args: p.args, cwd: p.cwd, env: opts.env, shell: p.shell, cleanupPaths: p.cleanupPaths });
      child.on('message', (result) => {
        if (result.startedPid) { p.commandPid = result.startedPid; return; }
        p._result = result;
        if (result.error) p._append(result.error);
      });
    } catch (e) {
      p.status = STATUS.FAILED;
      p.healthWhy = String((e && e.message) || e);
      this._emit(EVENT.PROCESS_FAILED, { processId: p.processId, taskId: p.taskId || '', name: p.name, why: p.healthWhy });
      this._mirror(p);
      return;
    }
    p._child = child;
    p.pid = child.pid || null;
    p.status = STATUS.RUNNING;
    p._stopRequested = false;
    p._result = null;
    if (child.stdout) child.stdout.on('data', (b) => p._append(b.toString()));
    if (child.stderr) child.stderr.on('data', (b) => p._append(b.toString()));
    child.on('error', (e) => {
      p.status = STATUS.FAILED;
      p.health = HEALTH.UNHEALTHY;
      p.healthWhy = String((e && e.message) || e);
      p.stoppedAt = Date.now();
      this._emit(EVENT.PROCESS_FAILED, { processId: p.processId, taskId: p.taskId || '', name: p.name, why: p.healthWhy });
      this._mirror(p);
      this._settleWaiters(p);
    });
    child.on('exit', (code, signal) => {
      if (p._result && !p._result.error) { code = p._result.code; signal = p._result.signal; }
      p.exitCode = code == null ? null : Number(code);
      p.stoppedAt = Date.now();
      p._child = null;
      // A SERVICE THAT EXITS ON ITS OWN HAS CRASHED. That is the whole
      // difference from a job, where an exit is the result. Nobody asked it to
      // stop, so its absence is a fact the task needs to know about.
      if (p._stopRequested) {
        p.status = STATUS.STOPPED;
        p.health = HEALTH.UNKNOWN;
        p.healthWhy = 'stopped on request';
        this._emit(EVENT.PROCESS_STOPPED, {
          processId: p.processId, taskId: p.taskId || '', name: p.name, exitCode: p.exitCode == null ? -1 : p.exitCode,
        });
      } else if (p._result && p._result.error) {
        p.status = STATUS.FAILED;
        p.health = HEALTH.UNHEALTHY;
        p.healthWhy = p._result.error;
        this._emit(EVENT.PROCESS_FAILED, { processId: p.processId, taskId: p.taskId || '', name: p.name, why: p.healthWhy });
      } else {
        p.status = STATUS.CRASHED;
        p.health = HEALTH.UNHEALTHY;
        p.healthWhy = `exited on its own with code ${p.exitCode}${signal ? ` (${signal})` : ''}`;
        this._emit(EVENT.PROCESS_FAILED, {
          processId: p.processId, taskId: p.taskId || '', name: p.name,
          why: p.healthWhy, exitCode: p.exitCode == null ? -1 : p.exitCode, tail: p.tail(8),
        });
      }
      this._mirror(p);
      this._settleWaiters(p);
    });
  }

  _settleWaiters(p) {
    const waiters = p._onExit.splice(0);
    for (const fn of waiters) { try { fn(); } catch { /* a waiter that throws must not break the others */ } }
  }

  get(processId) { return this._procs.get(String(processId)) || null; }

  /** By name within a task — how a caller that started "frontend" finds it again. */
  named(taskId, name) {
    for (const p of this._procs.values()) {
      if (p.name === name && (!taskId || p.taskId === String(taskId))) return p;
    }
    return null;
  }

  list(taskId = null) {
    const all = [...this._procs.values()];
    return taskId ? all.filter((p) => p.taskId === String(taskId)) : all;
  }

  /**
   * ASK WHETHER IT IS HEALTHY. One probe, now, no retries.
   *
   * With no health spec the answer is UNKNOWN and says why — never HEALTHY.
   * "Nothing looked" and "it answered" must never render the same.
   */
  async check(processId) {
    const p = this.get(processId);
    if (!p) return { health: HEALTH.UNKNOWN, why: 'no such process' };
    if (GONE.has(p.status)) {
      p.health = HEALTH.UNHEALTHY;
      p.healthWhy = p.healthWhy || `the process is ${p.status}`;
    } else if (!p.healthSpec) {
      p.health = HEALTH.UNKNOWN;
      p.healthWhy = 'no health check configured — nothing looked';
    } else if (p.healthSpec.url) {
      const r = await httpProbe(p.healthSpec.url);
      p.health = r.ok ? HEALTH.HEALTHY : HEALTH.UNHEALTHY;
      p.healthWhy = r.why;
    } else if (p.healthSpec.port) {
      const open = await portOpen(p.healthSpec.port, p.healthSpec.host || '127.0.0.1');
      p.health = open ? HEALTH.HEALTHY : HEALTH.UNHEALTHY;
      p.healthWhy = open ? `port ${p.healthSpec.port} accepts connections` : `nothing is listening on port ${p.healthSpec.port}`;
    } else if (p.healthSpec.ready) {
      const re = p.healthSpec.ready instanceof RegExp ? p.healthSpec.ready : new RegExp(String(p.healthSpec.ready));
      const hit = re.test(p.log);
      p.health = hit ? HEALTH.HEALTHY : HEALTH.UNHEALTHY;
      p.healthWhy = hit ? 'the readiness line appeared in the output' : 'the readiness line has not appeared';
    }
    this._emit(EVENT.PROCESS_HEALTH, {
      processId: p.processId, taskId: p.taskId || '', name: p.name, health: p.health, why: p.healthWhy,
    });
    this._mirror(p);
    return { health: p.health, why: p.healthWhy, status: p.status };
  }

  /**
   * WAIT UNTIL IT ANSWERS, OR UNTIL THE DEADLINE.
   *
   * The ONLY retry loop in this file, and it exists because starting a dev
   * server and immediately asking a browser to open it is the single most
   * common way a frontend task fails for no real reason. It stops early when
   * the process crashes — waiting eight seconds for something already dead is
   * time nobody gets back and evidence nobody needed.
   */
  async waitUntilHealthy(processId, timeoutMs = 20000, { signal = null } = {}) {
    const p = this.get(processId);
    if (!p) return { health: HEALTH.UNKNOWN, why: 'no such process' };
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      if (signal && signal.aborted) return { health: HEALTH.UNKNOWN, why: 'readiness cancelled', status: p.status };
      if (GONE.has(p.status)) return { health: HEALTH.UNHEALTHY, why: p.healthWhy, status: p.status };
      const r = await this.check(processId);
      if (r.health === HEALTH.HEALTHY) return r;
      if (r.health === HEALTH.UNKNOWN && !p.healthSpec) return r;
      if (Date.now() >= deadline) {
        return { health: p.health, why: `${p.healthWhy} (gave up after ${timeoutMs}ms)`, status: p.status };
      }
      await new Promise((res) => setTimeout(res, RETRY_MS));
    }
  }

  /**
   * STOP. Asks politely, then insists.
   *
   * On Windows a SIGTERM to a shell-spawned tree leaves the children behind, so
   * the tree is killed by pid where that is what the platform needs. A stop that
   * leaves the port occupied is not a stop, and the next start fails with a
   * message about the port that has nothing to do with the real cause.
   */
  async stop(processId, { graceMs = 3000 } = {}) {
    const p = this.get(processId);
    if (!p) return { ok: false, why: 'no such process' };
    if (!p._child) {
      p.status = GONE.has(p.status) ? p.status : STATUS.STOPPED;
      return { ok: true, why: `already ${p.status}` };
    }
    p._stopRequested = true;
      await stopTree(p._child, { graceMs });
    const deadline = Date.now() + Math.max(1000, graceMs);
    while (p._child && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return { ok: !p._child, why: p._child ? `owned process ${p.pid} did not stop` : 'process tree stopped' };
  }

  /** Stop then start, keeping the same record so restarts are countable. */
  async restart(processId) {
    const p = this.get(processId);
    if (!p) return { ok: false, why: 'no such process' };
    const stopped = await this.stop(processId);
    if (!stopped.ok) return stopped;
    p.restarts += 1;
    p.status = STATUS.STARTING;
    p.health = HEALTH.UNKNOWN;
    p.healthWhy = 'restarting';
    p.exitCode = null;
    p.stoppedAt = null;
    p.startedAt = Date.now();
    this._spawn(p);
    this._emit(EVENT.PROCESS_STARTED, {
      processId: p.processId, taskId: p.taskId || '', name: p.name, port: p.port == null ? -1 : p.port, restart: p.restarts,
    });
    this._mirror(p);
    return { ok: true, why: `restarted (${p.restarts})` };
  }

  /**
   * A TASK THAT ENDS TAKES ITS SERVICES WITH IT.
   *
   * This is the answer to the ninety orphaned processes. Called on every
   * terminal task state and on shutdown, and it is safe to call twice.
   */
  async cleanup(taskId = null) {
    const doomed = this.list(taskId).filter((p) => p.alive);
    const results = await Promise.allSettled(doomed.map(async (p) => {
      const r = await this.stop(p.processId);
      if (!r.ok) throw new Error(r.why);
    }));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    return doomed.map((p) => p.processId);
  }

  /** Forget finished records. The evidence is in the artifact store by then. */
  forget(taskId = null) {
    for (const p of this.list(taskId)) {
      if (!p.alive) this._procs.delete(p.processId);
    }
  }
}

module.exports = { ProcessManager, ManagedProcess, STATUS, HEALTH, GONE, portOpen, httpProbe, MAX_LOG, PROBE_MS, spawnOwned, stopTree, cleanupOwned };
