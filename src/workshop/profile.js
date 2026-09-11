'use strict';

/**
 * THE FRONTEND WORKSHOP BROWSER PROFILE — the THIRD browser purpose.
 *
 * ------------------------------------------------------------------------
 * THREE PURPOSES, THREE LIFECYCLES, AND THEY MUST NOT MERGE.
 *
 *   A. VERIFICATION BROWSER   harness/browserharness.js. Headless, `mkdtemp`
 *                             profile deleted with the task. Pointed at code
 *                             under test, which is the code least worth
 *                             trusting with anything.
 *
 *   B. WEB MODEL BROWSER      modelsource/webbrowser.js. Headful, PERSISTENT
 *                             profile under `configDir()/webmodels`, holding a
 *                             person's ChatGPT / Google login.
 *
 *   C. WORKSHOP BROWSER       this one. PROJECT-BOUND: one profile per project,
 *                             under `configDir()/workshop/<project hash>`, and
 *                             it lives as long as the person is working on that
 *                             project rather than as long as a task runs.
 *
 * THEY SHARE CDP INFRASTRUCTURE (harness/cdp.js) AND NOTHING ELSE. Sharing the
 * transport is reuse; sharing a profile is a category error with consequences:
 *
 *   · Workshop reusing (A) would throw the preview away — with its localStorage,
 *     its logged-in dev account and its scroll position — every time a
 *     verification contract finished. A preview you cannot keep is not a
 *     workshop.
 *   · Workshop reusing (B) would put the person's real ChatGPT cookies inside a
 *     browser pointed at code under development. That is the exact leak
 *     webprofile.js was written to prevent, arrived at from the other side.
 *   · Verification reusing (C) would make a contract's verdict depend on
 *     whatever state a person left in the preview, which destroys the property
 *     that makes verification worth anything.
 *
 * ------------------------------------------------------------------------
 * PROJECT-BOUND, AND THAT IS WHY IT IS HASHED.
 *
 * Two projects must not share a preview profile: `localhost:3000` means a
 * different application in each, and their cookies and storage would collide on
 * exactly the origin they both use. The directory is keyed by the ABSOLUTE
 * project path, hashed — a hash rather than a slug because a path is not a
 * filename, and because a readable directory name here would put the person's
 * directory layout in a place it does not need to be.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

/** Where every Workshop profile lives. One parent, so the boundary is checkable. */
function root() {
  return path.join(config.configDir(), 'workshop');
}

/** A project path reduced to one stable, safe path segment. */
function key(projectPath) {
  const abs = path.resolve(String(projectPath || ''));
  if (!abs) throw new Error('a workshop profile needs a project path');
  return crypto.createHash('sha256').update(abs).digest('hex').slice(0, 16);
}

/**
 * THE PROFILE DIRECTORY FOR ONE PROJECT, and the only way to get one.
 *
 * Refuses to hand back a path outside `root()`. `key` already guarantees a hex
 * segment, so this cannot currently fail — which is the point of keeping it:
 * the day the naming changes, this is what stops the change reaching the disk.
 */
function pathFor(projectPath) {
  const dir = path.join(root(), key(projectPath));
  const parent = path.resolve(root());
  if (!path.resolve(dir).startsWith(parent + path.sep)) {
    throw new Error(`refusing a workshop profile outside ${parent}`);
  }
  return dir;
}

function ensure(projectPath) {
  const dir = pathFor(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * THE ASSERTION THAT THE THREE PURPOSES HAVE NOT MERGED.
 *
 * A function rather than a comment because the failure it guards is silent: a
 * refactor that handed the Workshop the web-model launcher would work perfectly
 * on the day and would put a login inside a browser driving code under
 * development.
 */
function isolatedFrom(otherProfilePath) {
  const other = path.resolve(String(otherProfilePath || ''));
  const mine = path.resolve(root());
  if (!other) return { ok: true, why: '' };
  if (other === mine || other.startsWith(mine + path.sep) || mine.startsWith(other + path.sep)) {
    return { ok: false, why: `${other} overlaps the workshop profile root ${mine}` };
  }
  return { ok: true, why: '' };
}

/** What a status view may know. A path and a fact; never contents. */
function describe(projectPath) {
  let dir = null;
  try { dir = pathFor(projectPath); } catch { dir = null; }
  let used = false;
  try { used = Boolean(dir && fs.statSync(path.join(dir, 'Default')).isDirectory()); } catch { used = false; }
  return { projectPath: String(projectPath || ''), profilePath: dir, everUsed: used };
}

/** Remove one project's preview profile. Only reached when somebody asks. */
function forget(projectPath) {
  const dir = pathFor(projectPath);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    return { ok: true, removed: dir };
  } catch (e) {
    return { ok: false, why: `could not remove the preview profile: ${(e && e.message) || e}` };
  }
}

module.exports = { root, key, pathFor, ensure, isolatedFrom, describe, forget };
