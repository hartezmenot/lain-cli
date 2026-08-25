'use strict';

/**
 * MACHINE DETECTION — what OS, shell, runtimes and test runner this machine
 * actually has. THE DETECTION HALF OF `src/environment.js`, split out so the
 * file stays one idea per section; `environment.js` re-exports it.
 *
 * WHY THIS EXISTS. The prompt used to tell the model `Platform: win32` and
 * nothing else — not the shell, not which package manager this tree uses, not
 * whether a venv was sitting unactivated. Every one of those was rediscovered
 * by running a command and reading its failure. All of it is knowable for free,
 * before the first command is spent.
 *
 * THE ONE PROPERTY: every answer here is DETERMINISTIC STRING WORK against the
 * filesystem and `process`. No subprocess is spawned to ask a version number —
 * the detection rides on the stable prefix of every request of every turn.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------- OS name ---

/** `process.platform`'s real name: the model is told "Windows", not "win32". */
function osName(platform) {
  switch (platform) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    case 'android': return 'Android';
    case 'aix': return 'AIX';
    case 'freebsd': return 'freebsd';
    case 'openbsd': return 'openbsd';
    case 'sunos': return 'Solaris';
    default: return String(platform || 'unknown');   // passed through, not guessed
  }
}

// ------------------------------------------------------------------ shell ---

/** Which shells exist on PATH, in preference order for this platform. */
function detectShell() {
  const available = [];
  const has = (exe) => {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      try { if (fs.existsSync(path.join(dir, exe))) return true; } catch { /* unreadable dir */ }
    }
    return false;
  };
  if (process.platform === 'win32') {
    if (has('powershell.exe') || has('pwsh.exe')) available.push('powershell');
    if (has('cmd.exe')) available.push('cmd');
    if (has('bash.exe')) available.push('bash');
  } else {
    if (has('bash')) available.push('bash');
    if (has('zsh')) available.push('zsh');
    if (has('sh')) available.push('sh');
  }
  const preferred = available[0]
    || (process.platform === 'win32' ? 'cmd' : 'sh');   // some shell is always named
  return { preferred, available };
}

// -------------------------------------------------------- package manager ---

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

/**
 * THE PACKAGE MANAGER, settled by the lockfile — never by package.json.
 *
 * A manifest says nothing about npm vs pnpm vs yarn; every manager claims it.
 * The lockfile is the artifact one of them wrote, so it settles it exactly, and
 * running the wrong one would write a second competing lockfile.
 */
function detectPackageManager(dir) {
  for (const [lock, manager] of LOCKFILES) {
    try {
      if (!fs.existsSync(path.join(dir, lock))) continue;
    } catch { continue; }
    const pm = { manager, from: lock };
    // Missing vs installed, WITHOUT running anything: `bun pm` exists on PATH
    // or it does not. Naming a manager that cannot run just moves the failed
    // call one step later; saying it is absent is the fact that helps.
    const exe = manager + (process.platform === 'win32' ? '.cmd' : '');
    let onPath = false;
    for (const d of (process.env.PATH || '').split(path.delimiter)) {
      if (!d) continue;
      try {
        if (fs.existsSync(path.join(d, exe)) || fs.existsSync(path.join(d, manager))) {
          onPath = true;
          break;
        }
      } catch { /* unreadable dir */ }
    }
    if (!onPath) pm.missing = true;
    return pm;
  }
  return null;
}

// -------------------------------------------------------------------- venv ---

/**
 * THE PYTHON VENV, if this project has one, and whether it is ACTIVE.
 *
 * The confusing failure this prevents: a bare `python` cannot see packages
 * installed into .venv, so a dependency that is plainly present reports as
 * missing and the model starts "fixing" the wrong thing.
 */
function detectVenv(dir) {
  const binDirs = process.platform === 'win32' ? ['Scripts', 'bin'] : ['bin'];
  // AN ACTIVE VENV IS A FACT OF THE SHELL, not of the directory: VIRTUAL_ENV is
  // set means a venv is active, wherever it lives, and that is not a warning.
  // It is reported even when the directory it points at is not under `dir` —
  // the shell's state, not the project's layout, is what the model needs.
  const active = process.env.VIRTUAL_ENV || null;
  for (const venvName of ['.venv', 'venv']) {
    const venvDir = path.join(dir, venvName);
    for (const bin of binDirs) {
      for (const exe of (process.platform === 'win32' ? ['python.exe', 'python'] : ['python', 'python3'])) {
        try {
          if (fs.existsSync(path.join(venvDir, bin, exe))) {
            return {
              path: venvDir,
              active: Boolean(active),
              interpreter: path.join(venvDir, bin, exe),
            };
          }
        } catch { /* unreadable dir */ }
      }
    }
  }
  if (active) return { path: active, active: true, interpreter: null };
  return null;
}

// ------------------------------------------------------------ test runner ---

/**
 * THE TEST COMMAND, read from the manifest — never guessed.
 *
 * pytest being installed does not make it THIS project's runner, and `npm test`
 * means nothing without a test script to back it. A package.json with no test
 * script produces null, not a plausible lie.
 */
function detectTestRunner(dir) {
  try {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (p && p.scripts && typeof p.scripts.test === 'string' && p.scripts.test.trim()) {
        return { command: 'npm test', from: 'package.json' };
      }
      return null;
    }
  } catch { /* unparseable manifest: not a runner */ }
  try {
    const py = path.join(dir, 'pytest.ini');
    if (fs.existsSync(py)) return { command: 'pytest', from: 'pytest.ini' };
    const pyproject = path.join(dir, 'pyproject.toml');
    if (fs.existsSync(pyproject)) {
      const body = fs.readFileSync(pyproject, 'utf8');
      if (/\[tool\.pytest/.test(body)) return { command: 'pytest', from: 'pyproject.toml' };
    }
  } catch { /* unreadable */ }
  try {
    const mk = path.join(dir, 'Makefile');
    if (fs.existsSync(mk)) {
      const body = fs.readFileSync(mk, 'utf8');
      if (/^test\s*:/m.test(body)) return { command: 'make test', from: 'Makefile' };
    }
  } catch { /* unreadable */ }
  return null;
}

// -------------------------------------------------------------- runtimes ---

/** Runtimes knowable from the filesystem: no version subprocess is spawned. */
function detectRuntimes(dir) {
  const out = {};
  try {
    if (fs.existsSync(path.join(dir, 'package.json'))) out.node = { from: 'package.json' };
  } catch { /* unreadable */ }
  try {
    const py = fs.existsSync(path.join(dir, 'pytest.ini'))
      || fs.existsSync(path.join(dir, 'pyproject.toml'))
      || fs.existsSync(path.join(dir, 'requirements.txt'))
      || fs.existsSync(path.join(dir, 'setup.py'));
    if (py) out.python = { from: 'project manifest' };
  } catch { /* unreadable */ }
  try {
    if (fs.existsSync(path.join(dir, 'go.mod'))) out.go = { from: 'go.mod' };
  } catch { /* unreadable */ }
  try {
    if (fs.existsSync(path.join(dir, 'Cargo.toml'))) out.rust = { from: 'Cargo.toml' };
  } catch { /* unreadable */ }
  return out;
}

// ---------------------------------------------------------------- summary ---

/**
 * THE STABLE ORIENTATION PREFIX, for the system prompt.
 *
 * Memoized per directory: the summary sits in the system block, which carries
 * the request's cache breakpoint, and the provider matches an exact prefix — so
 * a summary that can change between two steps of one turn breaks the cache and
 * re-bills the whole conversation. A turn CAN change what this reads (`npm
 * install` creates a lockfile); the memo makes the summary stable for the
 * running turn, and `reset()` lets a new session see the world as it now is.
 */
const _memo = new Map();
let _memoWarm = false;

function summary(dir) {
  const key = String(dir || process.cwd());
  if (_memo.has(key)) return _memo.get(key);
  const lines = [`OS: ${osName(process.platform)}`];
  const sh = detectShell();
  if (sh && sh.preferred) lines.push(`Shell: ${sh.preferred}`);
  const pm = detectPackageManager(key);
  if (pm) {
    lines.push(pm.missing
      ? `Package manager: ${pm.manager} (from ${pm.from}) — NOT installed on this machine`
      : `Package manager: ${pm.manager} (from ${pm.from})`);
  }
  const venv = detectVenv(key);
  if (venv && !venv.active) {
    lines.push(`Python venv: ${venv.path} — present but NOT active (a bare \`python\` cannot see its packages)`);
  }
  const tr = detectTestRunner(key);
  if (tr) lines.push(`Tests: ${tr.command} (from ${tr.from})`);
  const s = lines.join('\n');
  _memo.set(key, s);
  return s;
}

/** The whole picture, for consumers that want structured facts. */
function detect(dir) {
  const key = String(dir || process.cwd());
  return {
    os: osName(process.platform),
    shell: detectShell(),
    packageManager: detectPackageManager(key),
    venv: detectVenv(key),
    testRunner: detectTestRunner(key),
    runtimes: detectRuntimes(key),
  };
}

/** Forget the memo. A new session sees the world as it now is. */
function reset() {
  _memo.clear();
  _memoWarm = false;
}

module.exports = {
  osName, detectShell, detectPackageManager, detectVenv,
  detectTestRunner, detectRuntimes, detect, summary, reset,
};
