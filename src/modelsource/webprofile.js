'use strict';

/**
 * THE AUTHENTICATED BROWSER PROFILE — a second browser purpose, kept apart from
 * the first on purpose.
 *
 * ------------------------------------------------------------------------
 * TWO BROWSERS, AND WHY THEY MAY NOT BE ONE.
 *
 *   VERIFICATION BROWSER   harness/browserharness.js. Headless, and its profile
 *                          is an `mkdtemp` directory deleted when the task
 *                          ends. It is pointed at CODE UNDER TEST, which is by
 *                          definition the code least worth trusting with a
 *                          person's logged-in sessions. That invariant is
 *                          stated at `_launch` in that file and is NOT relaxed
 *                          here — nothing in this module reaches it, and
 *                          `isolatedFrom` is the assertion that says so.
 *
 *   WEB MODEL BROWSER      this one. Headful, because a person has to be able
 *                          to log in, answer an MFA prompt and solve a CAPTCHA
 *                          in it. Its profile PERSISTS, because the alternative
 *                          is asking somebody to log in to ChatGPT again on
 *                          every turn.
 *
 * Reusing one for the other in either direction is a real failure: a
 * verification run driving the person's authenticated Google session, or a
 * login thrown away every time a task finishes.
 *
 * ------------------------------------------------------------------------
 * WHAT IS AND IS NOT READ FROM THIS MACHINE.
 *
 * LAIN opens a browser profile IT created, under its own config home, and the
 * person logs in there. It does NOT copy, import, decrypt or read Chrome's,
 * Edge's or Firefox's own profile directories — no cookie jar, no login-data
 * database, no keychain entry. That would be credential extraction, and it is
 * refused by construction: the only path this module will ever hand out is one
 * under `configDir()/webmodels`, and `pathFor` throws on anything else.
 *
 * ------------------------------------------------------------------------
 * WHAT THE PROFILE HOLDS, AND WHERE IT MAY NEVER GO.
 *
 * A profile directory holds cookies and site storage — that IS the login. So
 * this module deals in PATHS and STATES and never in contents: nothing here
 * reads a cookie, and no value from inside a profile is returned, logged,
 * rendered, put in an artifact or placed in a model's context. `describe()` is
 * the whole of what a status view is allowed to know, and it is three fields
 * none of which is a secret.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

/** Where every web-model profile lives. One parent, so the boundary is checkable. */
function root() {
  return path.join(config.configDir(), 'webmodels');
}

/** A source id reduced to something that is definitely a single path segment. */
function slug(sourceId) {
  const s = String(sourceId || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) throw new Error('a web model profile needs a source id');
  return s;
}

/**
 * THE PROFILE DIRECTORY FOR ONE SOURCE, and the only way to get one.
 *
 * It REFUSES to hand back a path outside `root()`. That is not defensive
 * decoration: the argument arrives from a source id, source ids are declared in
 * contract.js today and will one day come from a config file or a plugin, and
 * the day one contains `..` this function is the difference between a scoped
 * directory and a browser pointed at somebody's real profile.
 */
function pathFor(sourceId) {
  const dir = path.join(root(), slug(sourceId));
  const parent = path.resolve(root());
  if (path.resolve(dir) === parent || !path.resolve(dir).startsWith(parent + path.sep)) {
    throw new Error(`refusing a web model profile outside ${parent}`);
  }
  return dir;
}

/** Make it, if it is not there. Returns the path either way. */
function ensure(sourceId) {
  const dir = pathFor(sourceId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * HAS SOMEBODY LOGGED IN HERE BEFORE?
 *
 * A heuristic about the DIRECTORY, deliberately not about its contents: a
 * profile Chromium has actually run in has a `Default` subdirectory and a
 * `Local State` file. That is enough to tell "never used" from "used", and it
 * requires opening nothing. Whether the login is still VALID is a question only
 * the site can answer, and the source asks it by looking at the page — see
 * webmodel.js `status`.
 */
function used(sourceId) {
  const dir = pathFor(sourceId);
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch { return false; }
  for (const marker of ['Default', 'Local State']) {
    try { fs.statSync(path.join(dir, marker)); return true; } catch { /* try the next */ }
  }
  return false;
}

/**
 * WHAT A STATUS VIEW MAY KNOW. Three fields, no contents, no secret.
 *
 * The path is included because "where did my login go" is a fair question and
 * the answer is a directory the person owns. Nothing inside it is ever read.
 */
function describe(sourceId) {
  let dir = null;
  try { dir = pathFor(sourceId); } catch { dir = null; }
  return {
    sourceId: String(sourceId || ''),
    profilePath: dir,
    everUsed: dir ? used(sourceId) : false,
  };
}

/**
 * SIGN OUT, PROPERLY — the only destructive operation here, and it is the
 * person's own.
 *
 * `disconnect()` on a source forgets LIVE state and deliberately leaves the
 * login alone, because "stop using ChatGPT for this session" and "log me out of
 * ChatGPT" are different requests. This is the second one, and it is reached
 * only when a person asks for it by name.
 */
function forget(sourceId) {
  const dir = pathFor(sourceId);           // throws before removing anything outside root
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    return { ok: true, removed: dir };
  } catch (e) {
    return { ok: false, why: `could not remove the saved login: ${(e && e.message) || e}` };
  }
}

/**
 * THE ASSERTION THAT THE TWO BROWSER PURPOSES HAVE NOT MERGED.
 *
 * Called by the conformance suite with the verification harness's own profile
 * path. It is a function rather than a comment because the failure it guards is
 * silent: a refactor that gave the web-model browser the harness's launcher
 * would work perfectly, and would put a person's logged-in Google session
 * inside something a verification contract drives.
 */
function isolatedFrom(otherProfilePath) {
  const other = path.resolve(String(otherProfilePath || ''));
  const mine = path.resolve(root());
  if (!other) return { ok: true, why: '' };
  if (other === mine || other.startsWith(mine + path.sep) || mine.startsWith(other + path.sep)) {
    return { ok: false, why: `the verification profile ${other} overlaps the web-model profile root ${mine}` };
  }
  return { ok: true, why: '' };
}

module.exports = { root, pathFor, ensure, used, describe, forget, isolatedFrom, slug };
