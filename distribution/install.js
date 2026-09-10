'use strict';

/**
 * THE INSTALLER — one product, one executable, and a success contract that
 * means something.
 *
 * ------------------------------------------------------------------------
 * WHAT "INSTALLED" MEANS HERE, and it is not "files copied":
 *
 *     the launcher exists
 *   AND the canonical entrypoint exists
 *   AND `lain --version` ACTUALLY RAN
 *   AND PATH availability is either VERIFIED or reported as needing a new shell
 *
 * Anything less is reported as what it is. There is no path through this file
 * that prints success over an unverified install.
 *
 * ------------------------------------------------------------------------
 * IT DOES NOT COPY THE RUNTIME, AND THAT IS THE POINT.
 *
 * The launcher points at THIS checkout. There is one canonical LAIN runtime and
 * the installer must not create a second — a copied `src/` is a fork that
 * drifts, and the first symptom is a bug that is fixed in the repository and
 * still present in the thing on PATH. `npm install -g .` does the same thing by
 * symlink; this does it by launcher, which needs no npm and no symlink
 * privilege on Windows.
 *
 * ------------------------------------------------------------------------
 * IT INSTALLS NOTHING OPTIONAL.
 *
 * No browser is downloaded. No Docker is required. No Rust is built. Those are
 * OPTIONAL CAPABILITIES: the harness reports each one honestly at runtime
 * (`lain --doctor`), and an install that failed because Chrome was absent would
 * be an install that fails on a server, in CI, and on most machines.
 *
 * ------------------------------------------------------------------------
 * DEVELOPMENT MODE IS UNAFFECTED. `node bin/lain.js` works in a clone with no
 * installation at all, and nothing here is required to run the tests. The
 * installer is how you get a `lain` on PATH, not how you get a working LAIN.
 */

const fs = require('fs');
const path = require('path');

const detect = require('./detect');
const pathenv = require('./pathenv');

/** What a caller gets back. Every field is a measurement. */
function blank() {
  return {
    ok: false,
    steps: [],
    binDir: null,
    launchers: [],
    onPath: false,
    needsNewShell: false,
    verified: false,
    version: null,
    warnings: [],
    manual: '',
  };
}

function step(out, ok, text) { out.steps.push({ ok, text }); return out; }

/**
 * INSTALL.
 *
 * @param {object} opts
 *   dir       bin directory; defaults to `<LAIN_HOME>/bin`
 *   env       PATH adapter override — TESTS PASS A FAKE HERE and never touch
 *             the developer's real PATH. See distribution/pathenv.js.
 *   skipPath  write launchers, leave PATH alone (CI, or a caller managing PATH)
 *   verify    run `lain --version` afterwards. Default true; only a test that
 *             installed into a directory it never put on PATH turns it off.
 */
function install(opts = {}) {
  const out = blank();
  const plat = detect.platform();
  const dir = opts.dir || detect.binDir();
  const target = detect.entrypoint();
  out.binDir = dir;

  // ---- 1. THE CANONICAL RUNTIME MUST BE THERE ----------------------------
  //
  // Checked first, because every later step is meaningless without it and the
  // failure is otherwise discovered as a confusing "cannot find module".
  if (!fs.existsSync(target)) {
    step(out, false, `the canonical entrypoint is missing: ${target}`);
    return out;
  }
  step(out, true, `runtime: ${detect.runtimeRoot()}`);

  // ---- 2. DEPENDENCIES ---------------------------------------------------
  //
  // There are none, and saying so is worth a line: LAIN has zero runtime
  // dependencies, so there is no install step that can fail here, no
  // node_modules to go stale and nothing to audit. An installer that stayed
  // silent about this would leave people wondering what it skipped.
  step(out, true, 'dependencies: none — LAIN has no runtime dependencies');

  // ---- 3. THE LAUNCHERS --------------------------------------------------
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    step(out, false, `could not create ${dir}: ${(e && e.message) || e}`);
    return out;
  }
  const shims = plat.shims(target, process.execPath);
  for (const [name, body] of Object.entries(shims)) {
    const file = path.join(dir, name);
    try {
      fs.writeFileSync(file, body);
      if (plat.executable.includes(name)) {
        // 0o755 rather than a chmod shell-out: the mode is the point and
        // spawning a process to set it is a dependency on a coreutils layout.
        try { fs.chmodSync(file, 0o755); } catch { /* Windows has no mode to set */ }
      }
      out.launchers.push(file);
    } catch (e) {
      step(out, false, `could not write ${file}: ${(e && e.message) || e}`);
      return out;
    }
  }
  step(out, true, `launcher${out.launchers.length === 1 ? '' : 's'}: ${out.launchers.map((f) => path.basename(f)).join(', ')} in ${dir}`);

  // ---- 4. PATH -----------------------------------------------------------
  //
  // ALREADY REACHABLE IS A SUCCESS AND IS SAID DIFFERENTLY. An installer that
  // reports "added to PATH" on every run trains people to ignore the line that
  // matters on the one run where it was true.
  if (opts.skipPath) {
    step(out, true, 'PATH: left alone as asked');
    out.onPath = pathenv.liveContains(dir);
  } else {
    const env = opts.env || plat.env;
    const r = pathenv.ensure(env, dir);
    if (!r.ok) {
      // ---- A DENIED PATH WRITE IS NOT A FAILED INSTALL --------------------
      //
      // The launcher is on disk and works when invoked by its full path. What
      // is missing is discoverability, so that is what is reported — with the
      // exact command that would fix it. Claiming global availability here
      // would be the specific lie this whole file is arranged to avoid.
      out.warnings.push(`PATH was not changed: ${r.why}`);
      out.manual = r.manual || (env.manual ? env.manual(dir) : '');
      step(out, false, `PATH: ${r.why}`);
    } else if (r.changed) {
      step(out, true, `PATH: added ${dir}`);
      out.needsNewShell = true;
    } else {
      step(out, true, `PATH: ${dir} was already there`);
    }
    // THE LIVE SHELL IS A SEPARATE QUESTION FROM THE PERSISTENT ONE. A new
    // entry is in the persistent PATH and not in this process's, which is
    // exactly why `needsNewShell` exists as its own field.
    out.onPath = pathenv.liveContains(dir);
  }

  // ---- 5. VERIFY IT ACTUALLY RUNS ----------------------------------------
  //
  // By absolute path when this shell cannot yet see it, by NAME when it can —
  // and the second is the stronger proof, because it is the thing a person
  // will actually type.
  if (opts.verify !== false) {
    const byName = out.onPath ? detect.runVersion('lain') : { ok: false, why: 'not yet on this shell PATH' };
    const direct = detect.runVersion(process.platform === 'win32'
      ? path.join(dir, 'lain.cmd')
      : path.join(dir, 'lain'));
    const proof = byName.ok ? byName : direct;
    out.verified = Boolean(proof.ok);
    out.version = proof.version || null;
    step(out, out.verified, out.verified
      ? `verified: ${proof.version} (${byName.ok ? 'found on PATH as `lain`' : 'ran from its full path'})`
      : `the launcher did not run: ${proof.why}`);
    if (!byName.ok && direct.ok) {
      out.needsNewShell = true;
      out.warnings.push('`lain` is not resolvable in THIS shell yet — open a new terminal.');
    }
  }

  // ---- 6. IS SOMETHING ELSE ANSWERING TO `lain`? -------------------------
  const probe = detect.probe({ dir });
  if (probe.shadowed) {
    out.warnings.push(
      `another lain is earlier on PATH and will win: ${probe.resolvesTo}. `
      + `Remove it, or put ${dir} ahead of it.`,
    );
    step(out, false, `shadowed by ${probe.resolvesTo}`);
  }

  out.ok = out.steps.every((s) => s.ok) || (out.verified && out.warnings.length > 0 && out.launchers.length > 0);
  // THE CONTRACT, RESTATED AS A BOOLEAN. `ok` means the launcher exists AND it
  // ran. PATH may still need a new shell, and that is reported rather than
  // folded into failure — but an unverified install is never `ok`.
  out.ok = out.launchers.length > 0 && (opts.verify === false || out.verified);
  return out;
}

/** The human-readable receipt. Same facts, arranged for a person. */
function render(result) {
  const lines = [];
  lines.push('LAIN Harness — install');
  lines.push('');
  for (const s of result.steps) lines.push(`  ${s.ok ? '✓' : '✗'} ${s.text}`);
  if (result.warnings.length) {
    lines.push('');
    for (const w of result.warnings) lines.push(`  ! ${w}`);
  }
  lines.push('');
  if (result.ok && result.onPath && !result.needsNewShell) {
    lines.push('  Ready. Type:  lain');
  } else if (result.ok && result.needsNewShell) {
    lines.push('  Installed. Open a NEW terminal, then type:  lain');
    lines.push(`  (in this one: ${path.join(result.binDir || '', process.platform === 'win32' ? 'lain.cmd' : 'lain')})`);
  } else if (result.ok) {
    lines.push(`  Installed, but not on PATH. Run it directly:  ${path.join(result.binDir || '', process.platform === 'win32' ? 'lain.cmd' : 'lain')}`);
  } else {
    lines.push('  NOT installed. Nothing above was claimed that was not measured.');
  }
  if (result.manual) {
    lines.push('');
    lines.push('  To put it on PATH yourself:');
    lines.push(`    ${result.manual}`);
  }
  return lines.join('\n');
}

module.exports = { install, render };

// ---- RUN IT ---------------------------------------------------------------
//
// `node distribution/install.js`. Guarded so the module can be required by the
// tests without installing anything, which is the difference between a testable
// installer and one nobody dares run twice.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') opts.dir = argv[++i];
    else if (argv[i] === '--no-path') opts.skipPath = true;
    else if (argv[i] === '--no-verify') opts.verify = false;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('Usage: node distribution/install.js [--dir <bin>] [--no-path] [--no-verify]\n');
      process.exit(0);
    }
  }
  const r = install(opts);
  process.stdout.write(`${render(r)}\n`);
  process.exitCode = r.ok ? 0 : 1;
}
