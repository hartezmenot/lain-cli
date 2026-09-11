'use strict';

/**
 * WHERE A TASK RUNS — the execution environment, named once so everything can
 * agree.
 *
 * ------------------------------------------------------------------------
 * THE FAILURE THIS PREVENTS IS THE ONE §6 DESCRIBES, AND IT IS SILENT.
 *
 *     filesystem → host
 *     browser    → VM
 *     process    → host
 *
 * Three subsystems each answering "where am I" independently, describing three
 * different copies of the project, and every one of them succeeding. The tests
 * pass, the screenshot is of the wrong build, and nothing anywhere reports a
 * contradiction — because no single value was ever wrong.
 *
 * So the environment is a property OF THE TASK, resolved once, and every
 * environment-sensitive operation takes it as an argument rather than deciding
 * for itself. `host` is still the answer almost always; the point is that it is
 * an ANSWER.
 *
 * ------------------------------------------------------------------------
 * THE SPELLING IS `host` OR `vm:<id>`, AND IT IS A STRING ON PURPOSE.
 *
 * It has to survive a task record on disk, a JSON line to the Harness
 * application, an argument to a guest command and a `/env` display. A string
 * that parses back to the same thing everywhere costs nothing; an object would
 * arrive as `[object Object]` in three of those four places.
 *
 * ------------------------------------------------------------------------
 * LAIN ONLY TOUCHES VMs IT WAS EXPLICITLY GIVEN.
 *
 * `list()` returns REGISTERED environments — the ones a person put in their
 * configuration. It never enumerates the hypervisor and adopts what it finds.
 * A person's VMware library is full of machines that are theirs: a work
 * desktop, a lab, something mid-migration. Powering one of those off to run a
 * smoke test, or restoring it to a snapshot, is data loss committed by a tool
 * that decided it had authority. Registration IS the authority, and there is no
 * other route to one.
 */

const failures = require('./failures');
const { CODE } = failures;

/** The host this LAIN process runs on. Always present, never registered. */
const HOST = 'host';

/** How a VM environment is spelled. `vm:` then an id a person chose. */
const VM_PREFIX = 'vm:';

/** An id has to be safe in a path, a command line and a JSON key. */
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * PARSE ONE ENVIRONMENT SPELLING. Total: an unrecognised value is reported as
 * invalid rather than quietly treated as the host, because "I could not read
 * this so I ran it here" is exactly how work escapes an isolation boundary.
 */
function parse(spec) {
  const s = String(spec == null ? HOST : spec).trim();
  if (!s || s === HOST) return { ok: true, kind: 'host', id: null, spec: HOST };
  if (s.startsWith(VM_PREFIX)) {
    const id = s.slice(VM_PREFIX.length);
    if (!ID_RE.test(id)) return { ok: false, why: `not a usable VM id: ${JSON.stringify(id)}` };
    return { ok: true, kind: 'vm', id, spec: `${VM_PREFIX}${id}` };
  }
  return { ok: false, why: `unknown execution environment: ${JSON.stringify(s)} (expected "host" or "vm:<id>")` };
}

function isHost(spec) { const p = parse(spec); return p.ok && p.kind === 'host'; }
function isVm(spec) { const p = parse(spec); return p.ok && p.kind === 'vm'; }

/**
 * THE REGISTERED ENVIRONMENTS, from the ONE configuration authority.
 *
 * Stored under `environments` in the same config.json everything else uses —
 * NOT a new `.lain/environments.yml`. A second configuration file is a second
 * place for the answer to be, a second thing to migrate and a second thing to
 * get out of step; §19's "fit actual configuration architecture. No duplicate
 * config authority" is the instruction and this is it.
 *
 * Shape, and every field is there because something reads it:
 *
 *   environments: {
 *     "win11-test": {
 *       provider: "vmware",
 *       vmx: "D:\\VMs\\win11-test\\win11-test.vmx",
 *       owned: true,              // LAIN may start, stop and snapshot it
 *       cleanSnapshot: "LAIN-CLEAN",
 *       guest: { user: "...", },  // credentials are NOT stored here — see below
 *       network: "host-only"
 *     }
 *   }
 */
/** Where a person actually writes an environment entry. Named, never guessed. */
function configPath() {
  try { return require('../config').configFile(); } catch { return 'your LAIN config.json'; }
}

function registry() {
  try {
    const cfg = require('../config').load();
    const raw = cfg && cfg.environments;
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

/**
 * ONE REGISTERED ENVIRONMENT, or a precise reason there is none.
 *
 * `owned: true` IS REQUIRED FOR ANY CONTROL OPERATION and is checked here
 * rather than at each call site, because "did we check ownership" is not a
 * question that should have seven answers. A registered but unowned VM can be
 * READ — a person may want its status — and cannot be started, stopped,
 * snapshotted or restored.
 */
function describe(spec) {
  const p = parse(spec);
  if (!p.ok) return { ok: false, ...failures.fail(CODE.VM_UNAVAILABLE, p.why) };
  if (p.kind === 'host') {
    return {
      ok: true, kind: 'host', id: null, spec: HOST, provider: 'host',
      owned: true, label: 'this machine',
    };
  }
  const entry = registry()[p.id];
  if (!entry) {
    return {
      ok: false, kind: 'vm', id: p.id, spec: p.spec,
      ...failures.fail(
        CODE.VM_UNAVAILABLE,
        `no environment named "${p.id}" is registered`,
        'LAIN only controls VMs a person has registered — it never enumerates the hypervisor and adopts what it finds.',
        // THE REAL MECHANISM, not an invented one. This said
        // `/env vm add <id> --vmx <path>`, which does not exist — a remedy the
        // product cannot keep is worse than none, because a person types it and
        // learns the diagnostic lies. Registration is a config edit today.
        { remedy: `register it under "environments" in ${configPath()}` },
      ),
    };
  }
  return {
    ok: true,
    kind: 'vm',
    id: p.id,
    spec: p.spec,
    provider: String(entry.provider || 'vmware'),
    // ABSENT MEANS NOT OWNED. A person who wrote a bare entry has not said
    // LAIN may power-cycle it, and the safe reading of silence is "no".
    owned: entry.owned === true,
    vmx: entry.vmx || null,
    cleanSnapshot: entry.cleanSnapshot || null,
    network: entry.network || 'default',
    label: entry.label || p.id,
  };
}

/** Every environment a person has registered, plus the host. For `/env`. */
function list() {
  const out = [describe(HOST)];
  for (const id of Object.keys(registry())) out.push(describe(`${VM_PREFIX}${id}`));
  return out;
}

/** The provider module for one environment. The only place a provider is chosen. */
function providerFor(spec) {
  const d = describe(spec);
  if (!d.ok) return d;
  if (d.kind === 'host') return { ok: true, kind: 'host', provider: null, describe: d };
  switch (d.provider) {
    case 'vmware':
      return { ok: true, kind: 'vm', provider: require('./vmware'), describe: d };
    default:
      // NAMED AND REFUSED. §4 asks for an abstraction that another backend
      // could join later; this is the seam, and an unimplemented provider says
      // so instead of falling back to VMware and controlling the wrong thing.
      return {
        ok: false,
        ...failures.fail(CODE.VM_UNAVAILABLE, `no provider is implemented for "${d.provider}"`),
      };
  }
}

/**
 * SHOULD THIS WORK RUN IN A VM? — the default policy, §7.
 *
 * ISOLATION MUST NOT DESTROY SPEED, and that is the whole rule. A grep, a unit
 * test and a source read gain nothing from a hypervisor and lose seconds to it,
 * every time, all day. So HOST is the default and a VM is chosen for the
 * specific kinds of work where a pristine machine is the POINT rather than a
 * precaution.
 *
 * Returns a RECOMMENDATION with a reason, never a decision: the task's binding
 * is authoritative, and a person who asked for the host gets the host.
 */
const VM_WORTHY = new Set([
  'isolated-smoke',        // a person asked for isolation explicitly
  'release-verification',  // the proof that ships
  'clean-install',         // only meaningful on a machine without it installed
  'desktop-application',   // native UI, and the host desktop is the person's
  'destructive',           // anything that could change host state
]);

function recommend(kind, { requested = null } = {}) {
  if (requested) {
    const p = parse(requested);
    if (!p.ok) return { spec: HOST, why: p.why, honoured: false };
    return { spec: p.spec, why: 'the task asked for this environment', honoured: true };
  }
  if (VM_WORTHY.has(String(kind || ''))) {
    const vms = list().filter((e) => e.kind === 'vm' && e.ok && e.owned);
    if (!vms.length) {
      return {
        spec: HOST, honoured: false,
        why: `${kind} would be better isolated, but no Harness-owned VM is registered`,
      };
    }
    return { spec: vms[0].spec, honoured: true, why: `${kind} runs in a clean environment` };
  }
  return { spec: HOST, honoured: true, why: 'a VM would add time and no isolation this work needs' };
}

module.exports = {
  HOST, VM_PREFIX, ID_RE, VM_WORTHY,
  parse, isHost, isVm, registry, describe, list, providerFor, recommend, configPath,
};
