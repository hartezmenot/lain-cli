'use strict';

/**
 * THE VMWARE PROVIDER — `vmrun`, and nothing invented.
 *
 * ------------------------------------------------------------------------
 * ON THIS MACHINE, TODAY, VMWARE IS NOT INSTALLED.
 *
 * That was established by looking, not assumed: no `vmrun`, `vmware` or `vmcli`
 * on PATH; no `HKLM\SOFTWARE\VMware, Inc.`; no VMware entry in either uninstall
 * registry view; no VMware services registered. So every operation below
 * returns VM_UNAVAILABLE with that sentence, and NOTHING here has been proved
 * against a running hypervisor.
 *
 * This file is written to the real `vmrun` interface — the verbs, the argument
 * order, the exit behaviour and the output shapes are the documented ones — but
 * until it has run against an installation, that is a claim about the code and
 * not about the world. It is labelled NOT VERIFIED and it stays that way until
 * somebody runs it. Reporting a smoke as passing because the provider returned
 * a plausible object would be the exact dishonesty §5 forbids.
 *
 * ------------------------------------------------------------------------
 * WHY `vmrun` AND NOT THE REST OF THE VMWARE SURFACE.
 *
 * `vmrun` ships with Workstation, Player and Fusion, is stable across versions,
 * and covers every verb §5 asks for. `vmcli` is newer and Workstation-only, and
 * the VIX API needs a native binding this project will not take. One tool,
 * present wherever VMware is, driven as a subprocess.
 *
 * ------------------------------------------------------------------------
 * GUEST CREDENTIALS ARE NOT STORED, AND NOT LOGGED.
 *
 * `vmrun -gu <user> -gp <password>` puts a guest password on a command line.
 * This module takes them from the environment at call time
 * (`LAIN_VM_GUEST_USER` / `LAIN_VM_GUEST_PASSWORD`) and never writes them to
 * config, never returns them in a result and REDACTS them from every command
 * string it reports — see `redact`, which is applied to the diagnostic before
 * it can reach an error message, an artifact or a transcript.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const failures = require('./failures');
const { CODE } = failures;

/** VM lifecycle, as §5 names it. One vocabulary for every surface. */
const STATE = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  READY: 'READY',
  BUSY: 'BUSY',
  FAILED: 'FAILED',
});

/** How long a `vmrun` call may take before it is treated as hung. */
const CALL_TIMEOUT_MS = 120_000;

/** Where `vmrun` lives when it is not on PATH. Checked with `statSync`. */
function candidates() {
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(pf, 'VMware', 'VMware Workstation', 'vmrun.exe'),
      path.join(pf86, 'VMware', 'VMware Workstation', 'vmrun.exe'),
      path.join(pf, 'VMware', 'VMware Player', 'vmrun.exe'),
      path.join(pf86, 'VMware', 'VMware Player', 'vmrun.exe'),
      path.join(pf, 'VMware', 'VMware VIX', 'vmrun.exe'),
      path.join(pf86, 'VMware', 'VMware VIX', 'vmrun.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/VMware Fusion.app/Contents/Public/vmrun', '/usr/local/bin/vmrun'];
  }
  return ['/usr/bin/vmrun', '/usr/local/bin/vmrun', '/opt/vmware/bin/vmrun'];
}

let _cached = null;

/** WHERE IS `vmrun`? A list checked against the disk, never a guess. */
function tool({ refresh = false } = {}) {
  if (_cached && !refresh) return _cached;
  const tried = [];
  const fromEnv = process.env.LAIN_VMRUN;
  const list = fromEnv ? [fromEnv, ...candidates()] : candidates();
  for (const p of list) {
    tried.push(p);
    try { if (fs.statSync(p).isFile()) { _cached = { ok: true, path: p, tried }; return _cached; } } catch { /* not here */ }
  }
  // PATH LAST, because a `vmrun` shim on PATH is less trustworthy than the one
  // in a real installation directory — but it is still a legitimate answer.
  _cached = { ok: false, tried, why: `vmrun was not found (looked in ${tried.length} places)` };
  return _cached;
}

/** Guest credentials, from the environment only, at the moment of the call. */
function guestAuth() {
  const user = process.env.LAIN_VM_GUEST_USER || '';
  const pass = process.env.LAIN_VM_GUEST_PASSWORD || '';
  if (!user) return { ok: false, why: 'no guest user is configured (set LAIN_VM_GUEST_USER)', args: [] };
  return { ok: true, user, args: ['-gu', user, '-gp', pass] };
}

/**
 * REMOVE ANYTHING SECRET FROM A COMMAND BEFORE IT IS SHOWN OR STORED.
 *
 * Applied to the ARGUMENT ARRAY rather than to a joined string, so the value
 * after `-gp` is replaced positionally instead of by pattern-matching a
 * password that could be any text at all.
 */
function redact(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    out.push(String(args[i]));
    if (args[i] === '-gp' || args[i] === '-p') { out.push('********'); i++; }
  }
  return out.join(' ');
}

/** One `vmrun` invocation. Never throws; every outcome is a value. */
function run(args, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const t = tool();
  if (!t.ok) {
    return Promise.resolve(failures.fail(
      CODE.VM_UNAVAILABLE,
      'VMware is not installed on this machine',
      `vmrun was not found. Looked in:\n${t.tried.join('\n')}`,
      { state: STATE.UNAVAILABLE },
    ));
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(t.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolve(failures.fail(CODE.GUEST_EXEC_FAILED, `vmrun would not start: ${(e && e.message) || e}`, redact(args)));
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(failures.fail(CODE.GUEST_EXEC_FAILED, `vmrun did not answer within ${timeoutMs}ms`, redact(args)));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (d) => { out += d.toString(); if (out.length > 1_000_000) child.kill(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); finish(failures.fail(CODE.GUEST_EXEC_FAILED, `vmrun failed: ${(e && e.message) || e}`, redact(args))); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // `vmrun` reports failure in its OUTPUT as often as in its exit code —
      // "Error: The virtual machine is not powered on" with status 0 is normal.
      // Treating exit code alone as truth would report failures as successes.
      const text = `${out}${err}`;
      const errored = code !== 0 || /^Error:/im.test(text);
      if (errored) {
        return finish(failures.fail(
          CODE.GUEST_EXEC_FAILED,
          (text.match(/^Error:\s*(.+)$/im) || [null, `vmrun exited ${code}`])[1].trim(),
          `${redact(args)}\n${text}`.slice(0, 4000),
        ));
      }
      finish({ ok: true, stdout: out, stderr: err, command: redact(args) });
    });
  });
}

/** Is VMware usable at all? Cheap: stats a file, runs nothing. */
function available() {
  const t = tool();
  if (!t.ok) {
    return {
      available: false, state: STATE.UNAVAILABLE,
      why: 'VMware is not installed on this machine',
      detail: `vmrun was not found. Looked in:\n${t.tried.join('\n')}`,
      tried: t.tried,
    };
  }
  return { available: true, state: STATE.AVAILABLE, why: `vmrun: ${t.path}`, path: t.path, tried: t.tried };
}

/** Which registered VMs are running. `vmrun list` prints one .vmx path per line. */
async function list() {
  const r = await run(['list']);
  if (!r.ok) return r;
  const running = String(r.stdout || '')
    .split(/\r?\n/)
    .slice(1)                     // the first line is "Total running VMs: N"
    .map((l) => l.trim())
    .filter(Boolean);
  return { ok: true, running, count: running.length };
}

/**
 * THE STATE OF ONE REGISTERED VM.
 *
 * RUNNING IS NOT READY, and §24 is explicit about it: a powered-on guest whose
 * runner cannot answer is not a machine that can take work. So this reports
 * STOPPED or BUSY from the hypervisor, and READY only ever comes from the
 * handshake in guest.js. This function cannot return READY, deliberately.
 */
async function status(env) {
  if (!env || !env.vmx) {
    return failures.fail(CODE.VM_UNAVAILABLE, `${(env && env.id) || 'the environment'} has no .vmx path registered`);
  }
  const avail = available();
  if (!avail.available) return failures.fail(CODE.VM_UNAVAILABLE, avail.why, avail.detail, { state: STATE.UNAVAILABLE });
  try { fs.statSync(env.vmx); } catch {
    return failures.fail(CODE.VM_UNAVAILABLE, `the registered .vmx is missing: ${env.vmx}`, '', { state: STATE.UNAVAILABLE });
  }
  const l = await list();
  if (!l.ok) return l;
  const on = l.running.some((p) => path.resolve(p).toLowerCase() === path.resolve(env.vmx).toLowerCase());
  return { ok: true, state: on ? STATE.BUSY : STATE.STOPPED, powered: on, vmx: env.vmx };
}

/** Refuse any control operation on a VM a person did not hand over. */
function ownership(env) {
  if (!env || !env.owned) {
    return failures.fail(
      CODE.VM_UNAVAILABLE,
      `${(env && env.id) || 'this VM'} is not registered as Harness-owned`,
      'LAIN will not start, stop, snapshot or restore a VM it was not explicitly given. Register it with owned: true.',
    );
  }
  return { ok: true };
}

async function start(env, { gui = false } = {}) {
  const own = ownership(env); if (!own.ok) return own;
  const r = await run(['start', env.vmx, gui ? 'gui' : 'nogui']);
  if (!r.ok) return { ...r, code: CODE.VM_START_FAILED, state: STATE.FAILED };
  return { ok: true, state: STATE.STARTING, vmx: env.vmx };
}

async function stop(env, { hard = false } = {}) {
  const own = ownership(env); if (!own.ok) return own;
  const r = await run(['stop', env.vmx, hard ? 'hard' : 'soft']);
  if (!r.ok) return r;
  return { ok: true, state: STATE.STOPPED, vmx: env.vmx };
}

/** Every snapshot this VM has, newest last. `vmrun listSnapshots` prints names. */
async function snapshots(env) {
  const r = await run(['listSnapshots', env.vmx]);
  if (!r.ok) return r;
  const names = String(r.stdout || '').split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean);
  return { ok: true, snapshots: names };
}

async function snapshot(env, name) {
  const own = ownership(env); if (!own.ok) return own;
  if (!name) return failures.fail(CODE.VM_UNAVAILABLE, 'a snapshot needs a name');
  const r = await run(['snapshot', env.vmx, String(name)]);
  if (!r.ok) return r;
  return { ok: true, snapshot: String(name) };
}

/**
 * RESTORE A KNOWN CLEAN STATE.
 *
 * ------------------------------------------------------------------------
 * THE MOST DESTRUCTIVE OPERATION IN THIS FILE, AND THE MOST GUARDED.
 *
 * Reverting a snapshot DISCARDS everything the guest has done since it was
 * taken. On somebody's real machine that is their work, gone, with no undo. So
 * three things must all hold, and each is checked separately so the refusal
 * says which one failed:
 *
 *   · the VM is registered Harness-owned
 *   · the snapshot is the one REGISTERED as this environment's clean state,
 *     not any snapshot a caller names — so a bug elsewhere cannot revert a
 *     person to an arbitrary point in their own history
 *   · that snapshot actually exists, checked before the revert rather than
 *     discovered by `vmrun` failing halfway
 */
async function restore(env, name = null) {
  const own = ownership(env); if (!own.ok) return own;
  const want = name || env.cleanSnapshot;
  if (!want) {
    return failures.fail(
      CODE.VM_UNAVAILABLE,
      `${env.id} has no clean snapshot registered`,
      'Register one with cleanSnapshot so LAIN reverts to a state a person chose, never to whatever is newest.',
    );
  }
  if (name && env.cleanSnapshot && name !== env.cleanSnapshot) {
    return failures.fail(
      CODE.VM_UNAVAILABLE,
      `refusing to revert ${env.id} to "${name}"`,
      `Only the registered clean snapshot (${env.cleanSnapshot}) may be restored automatically.`,
    );
  }
  const have = await snapshots(env);
  if (!have.ok) return have;
  if (!have.snapshots.includes(want)) {
    return failures.fail(
      CODE.VM_UNAVAILABLE,
      `${env.id} has no snapshot named "${want}"`,
      `It has: ${have.snapshots.join(', ') || '(none)'}`,
    );
  }
  const r = await run(['revertToSnapshot', env.vmx, want]);
  if (!r.ok) return r;
  return { ok: true, restored: want, state: STATE.STOPPED };
}

/** Run one command inside the guest. The primitive everything else is built on. */
async function exec(env, command, args = [], { wait = true, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const own = ownership(env); if (!own.ok) return own;
  const auth = guestAuth();
  if (!auth.ok) return failures.fail(CODE.GUEST_EXEC_FAILED, auth.why);
  const r = await run([
    ...auth.args, 'runProgramInGuest', env.vmx,
    ...(wait ? [] : ['-noWait']), '-activeWindow', '-interactive',
    String(command), ...args.map(String),
  ], { timeoutMs });
  if (!r.ok) return { ...r, code: CODE.GUEST_EXEC_FAILED };
  return { ok: true, stdout: r.stdout, stderr: r.stderr };
}

async function copyIn(env, hostPath, guestPath) {
  const own = ownership(env); if (!own.ok) return own;
  const auth = guestAuth();
  if (!auth.ok) return failures.fail(CODE.ARTIFACT_TRANSFER_FAILED, auth.why);
  const r = await run([...auth.args, 'copyFileFromHostToGuest', env.vmx, String(hostPath), String(guestPath)]);
  if (!r.ok) return { ...r, code: CODE.ARTIFACT_TRANSFER_FAILED };
  return { ok: true, from: String(hostPath), to: String(guestPath) };
}

async function copyOut(env, guestPath, hostPath) {
  const own = ownership(env); if (!own.ok) return own;
  const auth = guestAuth();
  if (!auth.ok) return failures.fail(CODE.ARTIFACT_TRANSFER_FAILED, auth.why);
  const r = await run([...auth.args, 'copyFileFromGuestToHost', env.vmx, String(guestPath), String(hostPath)]);
  if (!r.ok) return { ...r, code: CODE.ARTIFACT_TRANSFER_FAILED };
  return { ok: true, from: String(guestPath), to: String(hostPath) };
}

/**
 * IS THE GUEST ANSWERING? Bounded, and it asks the GUEST rather than the
 * hypervisor — `vmrun` reporting a VM as running says nothing about whether
 * anything inside it can take work. See §24.
 */
async function health(env, { timeoutMs = 30_000 } = {}) {
  const st = await status(env);
  if (!st.ok) return st;
  if (!st.powered) return { ok: true, state: STATE.STOPPED, ready: false, why: 'the VM is not powered on' };
  const auth = guestAuth();
  if (!auth.ok) return { ok: true, state: STATE.BUSY, ready: false, why: auth.why };
  const r = await run([...auth.args, 'listProcessesInGuest', env.vmx], { timeoutMs });
  if (!r.ok) {
    return { ok: true, state: STATE.BUSY, ready: false, why: 'the guest is powered on but not answering yet', detail: r.detail || r.why };
  }
  return { ok: true, state: STATE.READY, ready: true, why: 'the guest answered' };
}

module.exports = {
  STATE, CALL_TIMEOUT_MS,
  tool, available, run, redact, guestAuth, ownership,
  list, status, start, stop, snapshot, snapshots, restore, exec, copyIn, copyOut, health,
};
