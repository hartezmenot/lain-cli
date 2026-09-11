'use strict';

/**
 * THE PROJECT'S DEV SERVER — detected from what the project DECLARES, started
 * through the process authority that already exists.
 *
 * ------------------------------------------------------------------------
 * IT NEVER INVENTS A COMMAND.
 *
 * Every command below is copied out of the project's own manifest. A Workshop
 * that guessed `npm run dev` at a project without that script would spend
 * twenty seconds failing and then report the PROJECT as broken, which is the
 * profile's fault and not the project's. No script, no dev server, and the
 * Workshop says so — see harness/profile.js, which applies the identical rule
 * to verification contracts.
 *
 * ------------------------------------------------------------------------
 * IT STARTS NOTHING ITSELF.
 *
 * `ProcessManager.start` owns spawning, ownership, health, logs and cleanup —
 * it is the reason ninety orphaned processes are not a recurring event in this
 * repository. A second spawner here would be a second thing that can leak a
 * server nobody recorded. This module DECIDES WHAT TO RUN; the manager runs it.
 *
 * ------------------------------------------------------------------------
 * A PORT ANSWERING IS NOT THIS PROJECT. THIS COST A REAL BUG.
 *
 * The first version of this probed a list of conventional ports — 5173, 3000,
 * 4200, 8080… — and adopted the first one that answered. Driven for real on a
 * developer machine it attached to `:4000`, which was an UNRELATED application
 * the person happened to be running, and then confidently reported a passing
 * desktop-and-mobile verification of somebody else's page. Every observation
 * was correct; every one of them was about the wrong program.
 *
 * "Something is listening" and "this project is being served" are different
 * facts, and the first is not evidence of the second. So adoption now requires
 * IDENTITY, from one of exactly two sources:
 *
 *   1. THE PROJECT DECLARED THE PORT — `vite --port 4321` in its own dev
 *      script. The project said so; that is evidence.
 *   2. LAIN STARTED IT — a ProcessManager process for this project, whose port
 *      the manager recorded.
 *
 * A conventional port with nothing tying it to this project is NOT adopted. We
 * start our own on a port we choose and know is free, which is slower by a few
 * seconds and correct, and correctness is the entire value of a verification
 * surface. Guessing here does not produce a broken Workshop — it produces a
 * confidently green one pointed at the wrong application, which is worse.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { portOpen } = require('../harness/processes');

/**
 * SCRIPT NAMES THAT MEAN "SERVE THIS FOR DEVELOPMENT", most specific first.
 *
 * `start` is LAST and is deliberately suspect: in a Node service it means the
 * production server, and in a frontend project it usually means the dev server.
 * Preferring `dev` ahead of it is what keeps this right for both.
 */
const SCRIPTS = ['dev', 'start:dev', 'serve', 'preview', 'start'];

/** Where LAIN puts a server it starts itself, when the project names no port. */
const PREFERRED_BASE = 5300;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * WHAT THIS PROJECT DECLARES, or a stated reason there is nothing to run.
 *
 * `declaredPort` is the load-bearing field: it is the only port this module
 * will ever ADOPT, because it is the only one the project itself vouched for.
 */
function detect(cwd) {
  const root = path.resolve(cwd || process.cwd());
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg) {
    return { ok: false, why: 'no package.json here — LAIN has no dev server to start', declaredPort: null };
  }
  const scripts = (pkg.scripts && typeof pkg.scripts === 'object') ? pkg.scripts : {};
  const name = SCRIPTS.find((n) => typeof scripts[n] === 'string' && scripts[n].trim());
  if (!name) {
    return {
      ok: false,
      why: `package.json declares no dev script (looked for ${SCRIPTS.join(', ')})`,
      declaredPort: null,
    };
  }
  // THE PORT THE SCRIPT ITSELF NAMES, when it names one. This is the project
  // speaking about itself, which is the only port identity this module trusts.
  const line = String(scripts[name] || '');
  const m = /--port[= ](\d{2,5})/.exec(line) || /\bPORT=(\d{2,5})/.exec(line);
  return {
    ok: true,
    script: name,
    // A COMMAND STRING, NOT AN ARGUMENT LIST, and that is the manager's own
    // contract rather than a preference: harness/processes.js runs a bare
    // string through a shell and a list directly. `npm` is `npm.cmd` on
    // Windows, so spawning it directly is ENOENT — found by driving this.
    command: `npm run ${name}`,
    why: `npm run ${name}`,
    declaredPort: m ? Number(m[1]) : null,
  };
}

/** A port nothing is listening on. Asked of the OS rather than assumed. */
function freePort(from = PREFERRED_BASE) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(0));
    srv.listen(from, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function pickPort() {
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop -- a short ordered probe
    const p = await freePort(PREFERRED_BASE + i);
    if (p) return p;
  }
  // 0 lets the OS choose. The server is told, and we read the port back from it.
  return 0;
}

/**
 * IS THIS PROJECT ALREADY BEING SERVED, on evidence?
 *
 * @param {number|null} declaredPort  the only port a project vouches for.
 * @param {object} o.processes  consulted for a server LAIN itself started for
 *   this project — the manager recorded its port, which is the other identity.
 */
async function adoptable(cwd, declaredPort, { processes = null, host = '127.0.0.1' } = {}) {
  // 1. LAIN'S OWN, still running for this project.
  if (processes && typeof processes.list === 'function') {
    try {
      for (const p of processes.list() || []) {
        const same = p && p.cwd && path.resolve(p.cwd) === path.resolve(cwd);
        if (same && p.port && p.alive !== false) {
          // eslint-disable-next-line no-await-in-loop -- at most a handful
          if (await portOpen(p.port, host)) {
            return { ok: true, port: p.port, url: `http://${host}:${p.port}/`, why: 'the dev server LAIN started for this project is still up' };
          }
        }
      }
    } catch { /* the manager reporting nothing is a normal state */ }
  }
  // 2. THE PORT THE PROJECT DECLARED.
  if (declaredPort && await portOpen(declaredPort, host)) {
    return { ok: true, port: declaredPort, url: `http://${host}:${declaredPort}/`, why: `attached to :${declaredPort}, the port this project declares` };
  }
  return { ok: false };
}

/**
 * GET A URL TO PREVIEW.
 *
 * @returns {{ok, url, port, processId, adopted, why}}
 */
async function ensure(cwd, { processes = null, taskId = null, timeoutMs = 60_000 } = {}) {
  const root = path.resolve(cwd);
  const found = detect(root);

  // ---- ALREADY SERVED, ON EVIDENCE. Adopt it. -------------------------
  const live = await adoptable(root, found.declaredPort, { processes });
  if (live.ok) {
    return { ok: true, url: live.url, port: live.port, processId: null, adopted: true, why: live.why };
  }
  if (!found.ok) return { ok: false, why: found.why };
  if (!processes) return { ok: false, why: 'no process manager, so a dev server cannot be owned or cleaned up' };

  // ---- OTHERWISE START OUR OWN, ON A PORT WE KNOW IS FREE -------------
  //
  // PORT IS FORCED, not hoped for. Passing it removes the whole class of
  // "which of these ports is ours" question that produced the adoption bug: we
  // chose the number, so an answer on it is ours by construction.
  const port = found.declaredPort || await pickPort();
  const proc = processes.start({
    taskId,
    name: `dev:${found.script}`,
    command: found.command,
    cwd: root,
    env: { PORT: String(port) },
    port,
  });

  // ---- WAIT FOR THAT PORT, AND ONLY THAT PORT -------------------------
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    if (!proc.alive) {
      return { ok: false, why: `the dev server exited: ${proc.healthWhy || 'no reason given'}`, processId: proc.processId };
    }
    // eslint-disable-next-line no-await-in-loop -- polling a port a separate
    // process is opening is a poll by nature; the deadline bounds it.
    if (await portOpen(port, '127.0.0.1')) {
      return {
        ok: true,
        url: `http://127.0.0.1:${port}/`,
        port,
        processId: proc.processId,
        adopted: false,
        why: `started ${found.why} on :${port}`,
      };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    ok: false,
    processId: proc.processId,
    why: `${found.why} did not open :${port} within ${Math.round(timeoutMs / 1000)}s`,
  };
}

module.exports = { detect, ensure, adoptable, freePort, pickPort, SCRIPTS, PREFERRED_BASE };
