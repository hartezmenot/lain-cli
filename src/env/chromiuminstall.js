'use strict';

/**
 * A BROWSER LAIN OWNS — pinned, installed on purpose, and never updated behind
 * a running verification.
 *
 * ------------------------------------------------------------------------
 * WHY A MANAGED BUILD RATHER THAN THE ONE ON THE MACHINE.
 *
 * "The tests pass on my machine" is usually a story about a dependency nobody
 * pinned, and a browser is the largest unpinned dependency a frontend
 * verification has. The person's Chrome updates itself every few weeks, without
 * asking, sometimes mid-suite. So a red verdict cannot be attributed: it could
 * be the code, or it could be that Chrome changed under it — and the evidence
 * from last week does not say which browser produced it.
 *
 * Chrome for Testing exists precisely for this. It is versioned, it is
 * archived, it does not auto-update, and a build downloaded today is the same
 * build in six months.
 *
 * ------------------------------------------------------------------------
 * INSTALLING IS AN EXPLICIT ACT AND WILL NEVER HAPPEN ON ITS OWN.
 *
 * Nothing in the launch path calls `install`. A verification that quietly
 * downloaded 160MB the first time somebody ran it would turn a two-second test
 * into a two-minute one for reasons the output does not explain, on a network
 * the person did not agree to use. `resolve()` reads the disk; this module is
 * reached only when a person asks — `/env chromium install`.
 *
 * That is also the whole of §14's "do not silently auto-update during a
 * verification run": there is no code path from a run to an install.
 *
 * ------------------------------------------------------------------------
 * IT REPORTS THE VERSION EVEN WHEN IT DID NOT INSTALL IT.
 *
 * `versionAt` works on a borrowed system browser too, because the evidence has
 * to say which browser produced a verdict whether or not LAIN chose it. An
 * unknown version is reported as unknown rather than as a plausible guess.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

/**
 * THE PINNED BUILD.
 *
 * A CONSTANT IN THE SOURCE, not a "latest" lookup, and that is the point: a
 * checkout of this tree at this commit installs this browser. Bumping it is a
 * commit somebody reviews, which is what makes a browser upgrade attributable
 * when a verdict changes the same week.
 */
const PINNED = '141.0.7390.54';

/** Where Chrome for Testing publishes what it has. Read only when installing. */
const CATALOG = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';
const DOWNLOAD_BASE = 'https://storage.googleapis.com/chrome-for-testing-public';

const INSTALL_HINT = '/env chromium install — downloads the pinned Harness browser (~160MB, once)';

/**
 * WHAT THIS PLATFORM IS CALLED IN THE DISTRIBUTION, and where the executable
 * sits inside the archive. Both come from the same table so they cannot drift.
 */
const PLATFORMS = {
  'win32-x64': { id: 'win64', exe: 'chrome.exe' },
  'win32-ia32': { id: 'win32', exe: 'chrome.exe' },
  'darwin-x64': { id: 'mac-x64', exe: path.join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') },
  'darwin-arm64': { id: 'mac-arm64', exe: path.join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') },
  'linux-x64': { id: 'linux64', exe: 'chrome' },
};

function platform() {
  const key = `${process.platform}-${process.arch}`;
  return PLATFORMS[key] || null;
}

/** Every managed build lives under one parent, so the boundary is checkable. */
function root() {
  return path.join(require('../config').configDir(), 'chromium');
}

/** One version's directory. Hex-free but validated, because it names a path. */
function dirFor(version) {
  const v = String(version || '');
  if (!/^\d+(\.\d+){0,3}$/.test(v)) throw new Error(`not a version: ${JSON.stringify(v)}`);
  return path.join(root(), v);
}

/** Where the executable ends up for a given version on this platform. */
function exePath(version) {
  const p = platform();
  if (!p) return null;
  return path.join(dirFor(version), p.exe);
}

/**
 * IS THE PINNED BUILD INSTALLED?
 *
 * Checks the pinned version first and then any other version present, because
 * a person who pinned forward and back should not be told they have nothing.
 * The version actually used is always reported.
 */
function installed({ version = PINNED } = {}) {
  const tried = [];
  const p = platform();
  if (!p) return { ok: false, tried, why: `no managed browser is published for ${process.platform}/${process.arch}` };

  const candidates = [version];
  try {
    for (const e of fs.readdirSync(root(), { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== version && /^\d+(\.\d+){0,3}$/.test(e.name)) candidates.push(e.name);
    }
  } catch { /* nothing installed yet */ }

  for (const v of candidates) {
    let exe;
    try { exe = exePath(v); } catch { continue; }
    tried.push(exe);
    try {
      if (fs.statSync(exe).isFile()) return { ok: true, path: exe, version: v, pinned: v === version };
    } catch { /* not this one */ }
  }
  return { ok: false, tried, why: `the pinned Harness browser (${version}) is not installed` };
}

/**
 * THE VERSION OF A BROWSER ON DISK, WITHOUT RUNNING IT.
 *
 * A managed build carries its version in its path. A system Chrome on Windows
 * keeps a sibling directory named for its version — the standard layout — which
 * is the cheapest reliable read there. Everywhere else this returns '' rather
 * than shelling out: the AUTHORITATIVE version comes from CDP once the browser
 * is up (see chromium.js), and this is only for a pre-flight display.
 */
function versionAt(exe) {
  const p = String(exe || '');
  if (!p) return '';
  const m = p.replace(/\\/g, '/').match(/\/chromium\/(\d+(?:\.\d+){0,3})\//);
  if (m) return m[1];
  try {
    const dir = path.dirname(p);
    const versions = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(e.name))
      .map((e) => e.name)
      .sort();
    if (versions.length) return versions[versions.length - 1];
  } catch { /* unreadable, and a guess would be worse than nothing */ }
  return '';
}

/** One HTTPS GET into memory, with redirects and a hard ceiling. */
function get(url, { limit = 400 * 1024 * 1024, redirects = 5, onProgress = null } = {}) {
  return new Promise((resolve) => {
    if (redirects < 0) return resolve({ ok: false, why: 'too many redirects' });
    let req;
    try {
      req = https.get(url, { headers: { 'user-agent': 'lain-harness' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), { limit, redirects: redirects - 1, onProgress }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve({ ok: false, why: `${url} answered ${res.statusCode}` });
        }
        const total = Number(res.headers['content-length']) || 0;
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > limit) { req.destroy(); return resolve({ ok: false, why: `the download exceeded ${limit} bytes` }); }
          chunks.push(c);
          if (onProgress) onProgress(size, total);
        });
        res.on('end', () => resolve({ ok: true, body: Buffer.concat(chunks), bytes: size }));
        res.on('error', (e) => resolve({ ok: false, why: `the download failed: ${(e && e.message) || e}` }));
      });
    } catch (e) { return resolve({ ok: false, why: `could not request ${url}: ${(e && e.message) || e}` }); }
    req.on('error', (e) => resolve({ ok: false, why: `could not reach ${url}: ${(e && e.message) || e}` }));
    req.setTimeout(120_000, () => { req.destroy(); resolve({ ok: false, why: `${url} timed out` }); });
  });
}

/**
 * WHAT AN INSTALL WOULD DO, WITHOUT DOING IT.
 *
 * Separate from `install` so `/env` can show the version, the URL and the
 * destination before anybody spends a download on it — and so a test can assert
 * the whole plan without touching the network.
 */
function plan({ version = PINNED } = {}) {
  const p = platform();
  if (!p) {
    return { ok: false, why: `no managed browser is published for ${process.platform}/${process.arch}` };
  }
  return {
    ok: true,
    version,
    platform: p.id,
    url: `${DOWNLOAD_BASE}/${version}/${p.id}/chrome-${p.id}.zip`,
    dest: dirFor(version),
    exe: exePath(version),
    catalog: CATALOG,
  };
}

/**
 * INSTALL THE PINNED BUILD. Only ever called because a person asked.
 *
 * EXTRACTED TO A TEMPORARY DIRECTORY AND THEN MOVED. A half-written install
 * directory looks exactly like a complete one to `installed()`, so a download
 * interrupted at 80% would leave a browser that resolves and does not run. The
 * rename is the commit point.
 */
async function install({ version = PINNED, onProgress = null, force = false } = {}) {
  const p = plan({ version });
  if (!p.ok) return p;

  const have = installed({ version });
  if (have.ok && have.version === version && !force) {
    return { ok: true, already: true, path: have.path, version };
  }

  const got = await get(p.url, { onProgress });
  if (!got.ok) return { ok: false, why: `could not download the Harness browser: ${got.why}`, url: p.url };

  let tmp;
  try {
    fs.mkdirSync(root(), { recursive: true });
    tmp = fs.mkdtempSync(path.join(root(), '.installing-'));
  } catch (e) {
    return { ok: false, why: `could not prepare ${root()}: ${(e && e.message) || e}` };
  }

  const zip = path.join(tmp, 'chrome.zip');
  try { fs.writeFileSync(zip, got.body); } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, why: `could not write the archive: ${(e && e.message) || e}` };
  }

  // STRIP ONE LEVEL: the archive wraps everything in `chrome-win64/`, which
  // nobody wants repeated inside a directory already named for the version.
  const out = await Promise.resolve(require('./unzip').extract(zip, path.join(tmp, 'x'), { strip: 1 }));
  try { fs.rmSync(zip, { force: true }); } catch { /* best effort */ }
  if (!out.ok) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, why: out.why };
  }

  const staged = path.join(tmp, 'x', platform().exe);
  try {
    if (!fs.statSync(staged).isFile()) throw new Error('not a file');
  } catch {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, why: `the archive did not contain ${platform().exe} — the distribution layout has changed` };
  }

  const dest = dirFor(version);
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(path.join(tmp, 'x'), dest);
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, why: `could not place the browser at ${dest}: ${(e && e.message) || e}` };
  }

  const now = installed({ version });
  if (!now.ok) return { ok: false, why: `the install completed but ${exePath(version)} is not there` };
  return { ok: true, already: false, path: now.path, version, bytes: got.bytes, files: out.written };
}

/** Remove one managed build. Only reached when somebody asks. */
function remove({ version = PINNED } = {}) {
  let dir;
  try { dir = dirFor(version); } catch (e) { return { ok: false, why: (e && e.message) || String(e) }; }
  const parent = path.resolve(root());
  if (!path.resolve(dir).startsWith(parent + path.sep)) return { ok: false, why: `refusing to remove ${dir}` };
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    return { ok: true, removed: dir };
  } catch (e) {
    return { ok: false, why: `could not remove ${dir}: ${(e && e.message) || e}` };
  }
}

/** What is on disk, for `/env`. Stats only — no network, no launch. */
function describe() {
  const p = platform();
  const have = installed();
  let builds = [];
  try {
    builds = fs.readdirSync(root(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+(\.\d+){0,3}$/.test(e.name))
      .map((e) => e.name).sort();
  } catch { builds = []; }
  return {
    pinned: PINNED,
    platform: p ? p.id : `${process.platform}/${process.arch} (unsupported)`,
    root: root(),
    installed: have.ok,
    version: have.ok ? have.version : null,
    path: have.ok ? have.path : null,
    builds,
    hint: have.ok ? '' : INSTALL_HINT,
    tmpdir: os.tmpdir(),
  };
}

module.exports = {
  PINNED, CATALOG, DOWNLOAD_BASE, INSTALL_HINT, PLATFORMS,
  platform, root, dirFor, exePath, installed, versionAt, plan, install, remove, describe,
};
