'use strict';

/**
 * OPEN SOMETHING IN WHATEVER THE PERSON USES FOR IT.
 *
 * ------------------------------------------------------------------------
 * THIS IS NOT THE HARNESS BROWSER, AND THE DIFFERENCE MATTERS.
 *
 * env/chromium.js owns three purposes — VERIFY, WORKSHOP, WEBMODEL — and every
 * one of them is an INSTRUMENT: a browser LAIN drives, on a profile LAIN owns,
 * pointed at code under test. None of them is "show the person their own
 * application", and using one for that would put the Harness UI in a headless
 * throwaway profile with no bookmarks, no extensions and no session.
 *
 * This is the other thing: hand a URL to the desktop and let it do what it
 * always does. LAIN does not drive what opens, does not read it, and does not
 * keep a handle on it.
 *
 * ------------------------------------------------------------------------
 * IT REPORTS FAILURE INSTEAD OF PRETENDING.
 *
 * "Errors not clearly printed" is one of the reported `/app` defects, and a
 * launcher that resolves successfully whatever happens is how that gets built.
 * A non-zero exit, a missing opener, a refused spawn — each comes back as a
 * sentence naming what was tried, so the caller can print the URL and let the
 * person open it themselves.
 */

const { spawn } = require('child_process');

/** How long an opener gets before it is treated as wedged. */
const TIMEOUT_MS = 8000;

/**
 * THE OPENER FOR THIS PLATFORM.
 *
 * Windows goes through `cmd /c start`, which needs an empty title argument
 * first: `start "" "<url>"`. Without it `start` treats a quoted URL as the
 * window title and opens nothing — a silent no-op, which is exactly the class
 * of failure this module exists to make loud.
 */
function opener(target) {
  if (process.platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', 'start', '', target], shell: false };
  }
  if (process.platform === 'darwin') return { cmd: 'open', args: [target], shell: false };
  return { cmd: 'xdg-open', args: [target], shell: false };
}

/**
 * OPEN IT. Resolves `{ok, why, using}` and never throws.
 *
 * DETACHED AND UNREF'D. The opener outlives this call by design — a browser
 * starting cold can take seconds, and LAIN must not hold the process open
 * waiting for it, nor take it down at exit. What is awaited is only whether
 * the LAUNCH failed, which resolves in milliseconds.
 */
function open(target) {
  const url = String(target || '').trim();
  if (!url) return Promise.resolve({ ok: false, why: 'nothing to open' });
  // ONLY http/https. This takes a URL from a caller and hands it to the shell;
  // `file:`, and anything that could name an executable, has no business here.
  if (!/^https?:\/\//i.test(url)) {
    return Promise.resolve({ ok: false, why: `refusing to open a non-http target: ${url}` });
  }

  const { cmd, args } = opener(url);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (e) {
      resolve({ ok: false, using: cmd, why: `${cmd} would not start: ${(e && e.message) || e}` });
      return;
    }
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done({ ok: true, using: cmd, why: '' }), TIMEOUT_MS);
    if (timer.unref) timer.unref();

    child.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, using: cmd, why: `${cmd} is not available: ${(e && e.message) || e}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // A NON-ZERO EXIT IS A REAL FAILURE and is the one signal that says the
      // desktop had no handler for this. `start` and `open` both return 0 the
      // instant they have handed the URL over, so a zero here means launched,
      // not finished.
      done(code === 0
        ? { ok: true, using: cmd, why: '' }
        : { ok: false, using: cmd, why: `${cmd} exited ${code} — no application answered for this URL` });
    });
    try { child.unref(); } catch { /* already detached */ }
  });
}

module.exports = { open, opener, TIMEOUT_MS };
