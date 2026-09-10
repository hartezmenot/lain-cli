'use strict';

/**
 * PATH, READ AND WRITTEN SAFELY — and never by the runtime.
 *
 * ------------------------------------------------------------------------
 * WHY THIS LIVES OUTSIDE `src/`.
 *
 * A running LAIN must never mutate the user's PATH. Not on startup, not
 * helpfully, not once. PATH is installation's business, and a runtime that
 * edits it is a program that changes the shape of your machine because you
 * asked it a question.
 *
 * That rule is enforced STRUCTURALLY rather than by convention: this directory
 * is outside `src/`, the architecture guard requires every file in `src/` to be
 * reachable from `src/cli.js`, and nothing in `src/` requires anything here. The
 * runtime therefore *cannot* reach this code, whatever anybody later intends.
 *
 * ------------------------------------------------------------------------
 * THE FIVE RULES THIS FILE EXISTS TO OBEY.
 *
 *   1. NEVER OVERWRITE PATH. Read it, decide, append one entry, write back.
 *   2. NEVER REPLACE OR REWRITE ENTRIES. No global string substitution — that
 *      is how somebody's toolchain disappears.
 *   3. NEVER DUPLICATE. An entry already present is a no-op, compared the way
 *      the platform compares paths (case-insensitively on Windows, trailing
 *      separators ignored everywhere).
 *   4. ONLY THE BIN DIRECTORY. Never a repository root — a checkout on PATH
 *      puts every script in it one typo away from running.
 *   5. FAILURE IS A STATE. A denied write is reported with the exact manual
 *      command that would do it, and the install still succeeds — with
 *      `onPath: false` said out loud rather than a false claim of success.
 *
 * ------------------------------------------------------------------------
 * THE ADAPTER IS WHY THIS IS TESTABLE.
 *
 * Every function takes an `env` adapter — `{ get(), set(), shellHint() }` — so a
 * test can drive the whole decision tree against a fake and never touch the
 * developer's real PATH. `platform/windows.js` and `platform/unix.js` provide
 * the real ones. There is no code path here that reaches a registry or a shell
 * profile directly.
 */

const path = require('path');

/** Compare two directories the way THIS platform compares them. */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    let s = path.resolve(String(p));
    // A trailing separator is not a different directory.
    if (s.length > 1 && (s.endsWith(path.sep) || s.endsWith('/'))) s = s.slice(0, -1);
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  try { return norm(a) === norm(b); } catch { return false; }
}

/** Split a PATH string into real entries, dropping the empties a stray `;` leaves. */
function entries(value, sep = path.delimiter) {
  return String(value || '').split(sep).map((s) => s.trim()).filter(Boolean);
}

/** Is `dir` already reachable through this PATH value? */
function contains(value, dir, sep = path.delimiter) {
  return entries(value, sep).some((e) => samePath(e, dir));
}

/**
 * ENSURE A DIRECTORY IS ON THE PERSISTENT PATH.
 *
 * @param {object} env  the platform adapter — see the header
 * @param {string} dir  the BIN directory, never a repository root
 * @returns {{ok, changed, why, manual, needsNewShell}}
 *
 * `changed: false, ok: true` is the good case on a machine that is already set
 * up, and it must be distinguishable from "we changed it" — an installer that
 * says "added to PATH" every run teaches people to ignore it.
 */
function ensure(env, dir) {
  if (!dir) return { ok: false, changed: false, why: 'no directory given', manual: '', needsNewShell: false };
  let current;
  try { current = env.get(); } catch (e) {
    return {
      ok: false, changed: false, needsNewShell: false,
      why: `could not read the persistent PATH: ${(e && e.message) || e}`,
      manual: env.manual ? env.manual(dir) : '',
    };
  }
  if (contains(current, dir, env.sep || path.delimiter)) {
    return { ok: true, changed: false, why: 'already on PATH', manual: '', needsNewShell: false };
  }
  // APPEND, NEVER REBUILD. The value that goes back is exactly what came out
  // plus one entry, so nothing else in it can be reordered, lost or reshaped.
  const sep = env.sep || path.delimiter;
  const next = current && current.trim() ? `${current.replace(/[;:]\s*$/, '')}${sep}${dir}` : dir;
  try {
    env.set(next);
  } catch (e) {
    return {
      ok: false, changed: false, needsNewShell: false,
      why: `could not write the persistent PATH: ${(e && e.message) || e}`,
      manual: env.manual ? env.manual(dir) : '',
    };
  }
  return {
    ok: true, changed: true, why: `added ${dir} to PATH`,
    manual: '', needsNewShell: true,
  };
}

/**
 * REMOVE a directory from the persistent PATH, leaving every other entry
 * byte-identical. Used only by the uninstaller.
 */
function remove(env, dir) {
  let current;
  try { current = env.get(); } catch (e) { return { ok: false, changed: false, why: String((e && e.message) || e) }; }
  const sep = env.sep || path.delimiter;
  const kept = entries(current, sep).filter((e) => !samePath(e, dir));
  if (kept.length === entries(current, sep).length) {
    return { ok: true, changed: false, why: 'it was not on PATH' };
  }
  try { env.set(kept.join(sep)); } catch (e) { return { ok: false, changed: false, why: String((e && e.message) || e) }; }
  return { ok: true, changed: true, why: `removed ${dir} from PATH` };
}

/**
 * IS IT REACHABLE IN *THIS* PROCESS, right now?
 *
 * Separate from `contains(env.get())` on purpose, and the difference is the
 * whole reason an installer has to talk about shells. The persistent PATH is
 * what a NEW terminal will get; `process.env.PATH` is what THIS one has. A
 * freshly added entry is in the first and not the second, and reporting either
 * one as the other is how an installer comes to say "ready" over a shell where
 * the command does not exist yet.
 */
function liveContains(dir) {
  return contains(process.env.PATH || process.env.Path || '', dir);
}

module.exports = { ensure, remove, contains, entries, samePath, liveContains };
