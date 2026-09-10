'use strict';

/**
 * WHAT IS ACTUALLY INSTALLED — measured, never assumed.
 *
 * ------------------------------------------------------------------------
 * THE CLAIM THIS FILE EXISTS TO REFUSE:
 *
 *     "Installed successfully."   (files were copied)
 *
 * Files existing is not an installation. An installation is a shell finding a
 * command and that command running. So everything here is a measurement:
 * `where.exe` / `command -v` for discovery, and an actual `--version`
 * invocation for liveness. Nothing is inferred from a file being on disk.
 *
 * ------------------------------------------------------------------------
 * SHADOWING IS A FIRST-CLASS ANSWER.
 *
 * A machine can easily end up with two `lain` on PATH — an npm global shim and
 * a directly installed launcher, or two checkouts. The one that wins is the
 * first on PATH, and it is very often not the one somebody just installed. An
 * installer that reports "ready" while a different LAIN answers is worse than
 * one that failed, because the failure is invisible and lands weeks later. So
 * `probe()` returns EVERY resolution it can see, in order, and says which one
 * wins.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pathenv = require('./pathenv');

/** The platform adapter for this machine. */
function platform() {
  return process.platform === 'win32' ? require('./platform/windows') : require('./platform/unix');
}

/**
 * LAIN's own home — the same one the runtime uses.
 *
 * `LAIN_HOME` is honoured because the test suite and the supervisor already do,
 * and an installer that ignored it would put the launcher somewhere the runtime
 * does not consider its own.
 */
function home() {
  if (process.env.LAIN_HOME) return process.env.LAIN_HOME;
  const base = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.';
  return path.join(base, '.lain-v2');
}

/** Where launchers go. The BIN directory, never a repository root. */
function binDir() { return platform().defaultBin(home()); }

/** The checkout this installer belongs to — the canonical runtime. */
function runtimeRoot() { return path.resolve(__dirname, '..'); }

/** The entrypoint a launcher must call. One canonical entry, per §16. */
function entrypoint() { return path.join(runtimeRoot(), 'bin', 'lain.js'); }

/**
 * EVERY `lain` A SHELL CAN SEE, in PATH order.
 *
 * `where.exe` prints one per line on Windows; `command -v` prints one. Both are
 * asked rather than reimplemented, because "what would the shell do" is a
 * question only the shell can answer correctly — extensions, PATHEXT, aliases
 * and all.
 */
function resolutions(name = 'lain') {
  const [cmd, args] = platform().whichCommand(name);
  let r;
  try { r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 }); } catch { return []; }
  if (!r || r.status !== 0) return [];
  return String(r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * DOES IT ACTUALLY RUN?
 *
 * `--version` is the right probe: it is the cheapest thing the binary can do
 * that still proves the whole chain — the launcher resolved, node started, the
 * package loaded, and `src/cli.js` executed. It touches no config, contacts no
 * provider and creates no session.
 */
function runVersion(exe = 'lain') {
  let r;
  try {
    // ---- WHY A COMMAND STRING AND NOT AN ARGUMENT ARRAY -------------------
    //
    // On Windows the launcher is a `.cmd`, which `spawn` cannot execute without
    // a shell — and Node deprecates (loudly, in the middle of the installer's
    // output) passing an ARGUMENT ARRAY together with `shell: true`, because the
    // arguments are concatenated rather than escaped. Building the one command
    // line ourselves sidesteps both: the only interpolation is a path this
    // module computed, quoted, and `--version` takes no user input at all.
    const quoted = /[\s"]/.test(exe) ? `"${exe}"` : exe;
    r = process.platform === 'win32'
      ? spawnSync(`${quoted} --version`, { encoding: 'utf8', windowsHide: true, timeout: 30000, shell: true })
      : spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) };
  }
  if (!r || r.error) return { ok: false, why: String((r && r.error && r.error.message) || 'it did not start') };
  if (r.status !== 0) return { ok: false, why: `it exited ${r.status}: ${String(r.stderr || '').trim().slice(0, 200)}` };
  const out = String(r.stdout || '').trim();
  return { ok: /^lain\s+\S/.test(out), version: out, why: out || 'it printed nothing' };
}

/** Which launcher files exist in a bin directory right now. */
function installedFiles(dir = binDir()) {
  const want = Object.keys(platform().shims('x'));
  const found = [];
  for (const f of want) {
    const p = path.join(dir, f);
    try { if (fs.statSync(p).isFile()) found.push(p); } catch { /* absent */ }
  }
  return found;
}

/**
 * THE WHOLE PICTURE, in one call. `install.js` verifies against this and
 * `/harness doctor` could read the same shape.
 */
function probe({ name = 'lain', dir = binDir() } = {}) {
  const files = installedFiles(dir);
  const found = resolutions(name);
  const winner = found[0] || null;
  const live = pathenv.liveContains(dir);
  const ours = winner ? files.some((f) => pathenv.samePath(path.dirname(f), path.dirname(winner))) : false;
  return {
    binDir: dir,
    runtimeRoot: runtimeRoot(),
    entrypoint: entrypoint(),
    entrypointExists: (() => { try { return fs.statSync(entrypoint()).isFile(); } catch { return false; } })(),
    launchers: files,
    installed: files.length > 0,
    // ON THIS SHELL, right now — which is not the same question as whether a
    // NEW shell would find it. See pathenv.liveContains.
    onLivePath: live,
    resolutions: found,
    resolvesTo: winner,
    // The winner is somewhere other than where we installed: something else
    // answers to `lain`, and saying so is the entire point of this field.
    shadowed: Boolean(winner) && files.length > 0 && !ours,
    version: found.length ? runVersion(name) : { ok: false, why: `no ${name} on PATH` },
  };
}

module.exports = { platform, home, binDir, runtimeRoot, entrypoint, resolutions, runVersion, installedFiles, probe };
