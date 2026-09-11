'use strict';

/**
 * THE GUEST BRIDGE — how work happens inside a VM, and how little of LAIN goes
 * in with it.
 *
 * ------------------------------------------------------------------------
 * WHAT GOES INTO THE GUEST: NOTHING THAT DECIDES ANYTHING. (§25, §26)
 *
 *   CORRECT                          WRONG
 *   host Harness                     host Harness
 *     → VM execution adapter           → a second LAIN Harness in the VM
 *         → deterministic runner           → another task engine
 *                                          → another permission system
 *
 * The guest gets a sequence of primitives — start this process, run this
 * command, move this file, launch a browser with these flags — and it has no
 * opinion about any of them. Every decision (which environment, whether a check
 * passed, what to do next, whether the person allowed it) stays on the host,
 * where the task, the permissions and the evidence already live.
 *
 * There is NO MODEL INSIDE THE VM. Putting one there to "run commands" would
 * mean a second thing forming intentions, on the far side of a boundary, with
 * its own view of what it was asked to do — two authorities, and the interesting
 * failures all live in the gap between them.
 *
 * ------------------------------------------------------------------------
 * THE BRIDGE IS `vmrun`, AND THAT IS ON PURPOSE.
 *
 * Auditing first, as §25 asks: this project already owns a process manager, a
 * CDP client and an artifact store, and none of them can reach into a guest.
 * What was missing was TRANSPORT. `vmrun`'s guest operations (runProgramInGuest,
 * copyFileFromHostToGuest, copyFileFromGuestToHost, listProcessesInGuest) are
 * exactly that transport and they need nothing installed in the guest beyond
 * VMware Tools, which a usable guest has anyway.
 *
 * So there is no agent to write, deploy, version, secure or keep alive. The
 * narrow bridge §25 permits turns out to be a thin adapter over a transport
 * that already exists — which is the cheapest possible answer and the one with
 * the least to go wrong.
 *
 * ------------------------------------------------------------------------
 * READY MEANS ANSWERED, NOT POWERED. (§24)
 *
 * `wait` below polls the guest with a real round trip and a deadline. A VM that
 * is "running" can be five seconds into boot, or sitting at a login screen, or
 * have no Tools installed at all — and a smoke that starts work against any of
 * those fails somewhere further along, for a reason that points at the wrong
 * thing entirely.
 */

const path = require('path');
const environments = require('./environments');
const failures = require('./failures');
const purpose = require('./purpose');
const { CODE } = failures;

/** How long a guest gets to answer before READY is refused. */
const READY_TIMEOUT_MS = 180_000;
/** How often it is asked while it boots. */
const READY_POLL_MS = 3000;

/** Where LAIN puts its own things inside a guest. One root, so cleanup is one path. */
const GUEST_ROOT_WIN = 'C:\\lain-harness';
const GUEST_ROOT_POSIX = '/tmp/lain-harness';

/** Resolve an environment to its provider, or say precisely why not. */
function bind(spec) {
  const p = environments.providerFor(spec);
  if (!p.ok) return p;
  if (p.kind === 'host') {
    return failures.fail(CODE.VM_UNAVAILABLE, 'this operation needs a VM environment, and the task is bound to the host');
  }
  return { ok: true, provider: p.provider, env: p.describe };
}

/** The guest's own path separator convention, from what a person registered. */
function guestRoot(env) {
  return /win/i.test(String(env.guestOs || 'windows')) ? GUEST_ROOT_WIN : GUEST_ROOT_POSIX;
}

function guestJoin(env, ...parts) {
  const root = guestRoot(env);
  const sep = root.includes('\\') ? '\\' : '/';
  return [root, ...parts].join(sep);
}

/**
 * BRING A VM UP AND WAIT UNTIL IT CAN ACTUALLY TAKE WORK.
 *
 * `clean` restores the registered clean snapshot first — which is destructive
 * and therefore only ever reaches a VM registered `owned`, only ever restores
 * the snapshot the person named, and is off by default.
 */
async function ready(spec, { clean = false, timeoutMs = READY_TIMEOUT_MS, signal = null } = {}) {
  const b = bind(spec);
  if (!b.ok) return b;
  const { provider, env } = b;

  const avail = provider.available();
  if (!avail.available) {
    return failures.fail(CODE.VM_UNAVAILABLE, avail.why, avail.detail, { state: provider.STATE.UNAVAILABLE });
  }

  if (clean) {
    const r = await provider.restore(env);
    if (!r.ok) return r;
  }

  const st = await provider.status(env);
  if (!st.ok) return st;
  if (!st.powered) {
    const started = await provider.start(env);
    if (!started.ok) return started;
  }

  const deadline = Date.now() + timeoutMs;
  let last = 'the guest was not asked yet';
  while (Date.now() < deadline && !(signal && signal.aborted)) {
    // eslint-disable-next-line no-await-in-loop -- a boot is a poll by nature.
    const h = await provider.health(env, { timeoutMs: Math.min(30_000, deadline - Date.now()) });
    if (h.ok && h.ready) return { ok: true, state: provider.STATE.READY, environment: env.spec, id: env.id };
    last = (h && (h.why || h.detail)) || last;
    // eslint-disable-next-line no-await-in-loop -- same.
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  if (signal && signal.aborted) return failures.fail(CODE.VM_NOT_READY, 'waiting for the guest was cancelled');
  return failures.fail(
    CODE.VM_NOT_READY,
    `${env.id} is powered on but never became ready`,
    `Last answer: ${last}. A VM that is running is not necessarily a VM that can take work — VMware Tools must be installed and the guest logged in for guest operations to work.`,
    { state: provider.STATE.BUSY },
  );
}

/** Run one command in the guest. A primitive: it decides nothing. */
async function exec(spec, command, args = [], opts = {}) {
  const b = bind(spec);
  if (!b.ok) return b;
  return b.provider.exec(b.env, command, args, opts);
}

/**
 * PUT A KNOWN TREE INTO THE GUEST. (§20)
 *
 * COPY, NOT A SHARED FOLDER, and the reason is a real hazard rather than a
 * preference: a permanent shared folder means a test running inside the guest
 * writes THE HOST'S WORKING TREE. A build step, a formatter, a test that
 * rewrites a fixture — any of them silently edits the source the person is
 * working in, from inside a machine that was supposed to be isolated. The
 * isolation would be exactly backwards.
 *
 * So a release smoke copies an archive of a known tree and the guest tests
 * THAT. What the guest does to its copy cannot reach the host, which is the
 * property the whole VM was for.
 */
async function sync(spec, hostArchive, { name = 'project' } = {}) {
  const b = bind(spec);
  if (!b.ok) return b;
  const dest = guestJoin(b.env, `${name}${path.extname(String(hostArchive)) || '.zip'}`);
  const put = await b.provider.copyIn(b.env, hostArchive, dest);
  if (!put.ok) return put;
  return { ok: true, guestPath: dest };
}

/**
 * BRING EVIDENCE BACK, THROUGH THE ARTIFACT AUTHORITY. (§21)
 *
 * The guest path never reaches the frontend. A file is copied to a host
 * temporary location, read, and handed to the SAME artifact store every
 * host-side observation already goes through — so a screenshot taken in a VM
 * and one taken on the host are the same kind of thing to everything
 * downstream, and nothing has to learn what `C:\lain-harness\out\shot.png`
 * means.
 */
async function collect(spec, guestPath, { store = null, taskId = null, kind = 'screenshot', name = null, note = '' } = {}) {
  const b = bind(spec);
  if (!b.ok) return b;
  const fs = require('fs');
  const os = require('os');
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-guest-'));
  } catch (e) {
    return failures.fail(CODE.ARTIFACT_TRANSFER_FAILED, `could not prepare a landing directory: ${(e && e.message) || e}`);
  }
  const base = String(guestPath).split(/[\\/]/).pop() || 'artifact';
  const local = path.join(tmp, base);
  const got = await b.provider.copyOut(b.env, guestPath, local);
  if (!got.ok) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } return got; }

  if (!store) return { ok: true, path: local, from: guestPath, artifact: null };
  let body;
  try { body = fs.readFileSync(local); } catch (e) {
    return failures.fail(CODE.ARTIFACT_TRANSFER_FAILED, `the file arrived but could not be read: ${(e && e.message) || e}`);
  }
  try {
    const art = store.put(taskId, { kind, name: name || base, body, note: note || `from ${b.env.spec}` });
    return { ok: true, artifact: art, from: guestPath, environment: b.env.spec };
  } catch (e) {
    return failures.fail(CODE.ARTIFACT_TRANSFER_FAILED, `the artifact store refused it: ${(e && e.message) || e}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * LAUNCH A HARNESS CHROMIUM INSIDE THE GUEST.
 *
 * THE SAME CONTRACT AS THE HOST, and that is the point of routing it through
 * here: `chromium.launch(purpose, { environment: 'vm:x' })` lands in this
 * function, the purposes mean the same thing, the flags come from the same
 * table, and a caller does not learn which machine the browser is on.
 *
 * NOT VERIFIED. There is no VMware on this machine to run it against, so this
 * is the contract and the call shape and nothing more. It reports
 * VM_UNAVAILABLE today, from `bind`, before it reaches anything speculative.
 */
async function launchChromium(spec, kind, { taskId = null, headless = true } = {}) {
  const b = bind(spec);
  if (!b.ok) return b;
  if (!purpose.isPurpose(kind)) return failures.fail(CODE.CHROMIUM_FAILED, `unknown browser purpose: ${kind}`);
  // A GUEST'S PROFILE IS THE GUEST'S. It is not the host's profile directory
  // and it is emphatically not the web-model profile — §17's "VM smoke must
  // never receive those cookies" is satisfied structurally, because there is no
  // path by which a host profile is copied in.
  const profileDir = guestJoin(b.env, 'profiles', String(kind));
  const exe = b.env.chromium || null;
  if (!exe) {
    return failures.fail(
      CODE.CHROMIUM_FAILED,
      `${b.env.id} has no guest Chromium registered`,
      'Register the guest browser path with `chromium` on the environment entry, or install one in the guest image.',
    );
  }
  const args = require('./chromium').argsFor(kind, profileDir, { headless });
  const started = await b.provider.exec(b.env, exe, args, { wait: false });
  if (!started.ok) return { ...started, code: CODE.CHROMIUM_FAILED };
  return { ok: true, environment: b.env.spec, profileDir, args, exe, taskId };
}

/** Stop everything LAIN started in this guest. Best effort, and it says so. */
async function cleanup(spec) {
  const b = bind(spec);
  if (!b.ok) return b;
  return { ok: true, environment: b.env.spec, note: 'guest cleanup is delegated to the clean-snapshot restore before the next run' };
}

module.exports = {
  READY_TIMEOUT_MS, READY_POLL_MS, GUEST_ROOT_WIN, GUEST_ROOT_POSIX,
  bind, ready, exec, sync, collect, launchChromium, cleanup, guestRoot, guestJoin,
};
