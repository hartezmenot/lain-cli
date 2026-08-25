'use strict';

/**
 * WHICH DIRECTORIES LAIN MAY WORK IN.
 *
 * Opening a coding agent on a folder is handing it a shell and a filesystem.
 * Nothing here asked before doing that: LAIN started in whatever directory it
 * was launched from and would read, write and run anywhere the OS allowed.
 *
 * ------------------------------------------------------------------------
 * NOT permissions.js, AND THE DIFFERENCE IS DELIBERATE.
 *
 * That module gates the SCREEN, the mouse and the keyboard, and its whole
 * argument is that a grant is temporary, narrow and never written to disk — you
 * should have to say yes again next time. This is the opposite question: "is
 * this folder mine to work on" is a fact about a project, it does not change
 * between sessions, and asking on every launch would train the answer out of
 * you. Two questions, two lifetimes, two modules.
 *
 * ------------------------------------------------------------------------
 * THE THREE ANSWERS.
 *
 *   TRUSTED     read, write and run inside this directory. What you mean when
 *               you open LAIN on your own project.
 *   READ_ONLY   look but do not touch. For a repository you are reading, or
 *               somebody else's code you were sent.
 *   UNTRUSTED   nothing at all. The default for a directory nobody has decided
 *               about, because an unanswered question is not consent.
 *
 * ------------------------------------------------------------------------
 * OUTSIDE THE PROJECT IS A SEPARATE DECISION.
 *
 * Trusting a directory says nothing about `C:\Windows` or `~/.ssh`. A path
 * outside the trusted root is asked about on its own — except where it is
 * plainly harmless, which is what `autoOutside` decides. The rule there is
 * narrow and stated rather than clever: a path is auto-approved only if it is
 * NOT a system location and NOT the bare root of a drive or a home directory.
 * Anything that could take a machine or an account with it is asked about,
 * every time, whatever the mode.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LEVEL = Object.freeze({
  TRUSTED: 'TRUSTED',
  READ_ONLY: 'READ_ONLY',
  UNTRUSTED: 'UNTRUSTED',
});

/**
 * HOW THE GATE BEHAVES when a path is not already decided about.
 *
 * WHAT WAS MISSING. There was one boolean — `autoOutsideProject` — reachable
 * only through `/trust strict` and `/trust auto`, and it could express two of
 * the three things people actually want. The third, "never ask me, just refuse
 * it", had no way to be said at all: on an unattended run the gate would put a
 * prompt on a screen nobody is looking at and wait.
 *
 *   ASK    the default. An undecided path outside the project asks the person
 *          at the keyboard. Says yes to nothing on its own.
 *   AUTO   ordinary paths outside the project pass without asking. System and
 *          credential locations are STILL always asked about — see NEVER_AUTO,
 *          which no mode can override.
 *   DENY   an undecided path outside the project is refused, and nobody is
 *          asked. For an unattended run, a shared machine, or anyone who wants
 *          a hard boundary rather than a question they might click through.
 *
 * ONE FIELD DECIDES IT. `cfg.permissionMode` is the setting; the old boolean is
 * still READ so an existing config keeps behaving as it did, but it is never
 * written again and never consulted once a mode has been set. Two fields that
 * can disagree about what is allowed is the exact shape of bug this replaces.
 */
const MODE = Object.freeze({
  ASK: 'ASK',
  AUTO: 'AUTO',
  DENY: 'DENY',
});

/**
 * The gate's behaviour, from configuration. ONE place derives it.
 *
 * The legacy boolean is translated rather than honoured separately: `false`
 * meant "ask about everything outside", which is ASK; `true` (or absent, which
 * was the old default) meant AUTO.
 */
function modeOf(cfg = {}) {
  const raw = String((cfg && cfg.permissionMode) || '').toUpperCase();
  if (MODE[raw]) return MODE[raw];
  if (cfg && cfg.autoOutsideProject === false) return MODE.ASK;
  return MODE.AUTO;
}

/** What each mode means, in one sentence, for every screen that shows it. */
const MODE_MEANS = Object.freeze({
  [MODE.ASK]: 'anything outside this project asks you first',
  [MODE.AUTO]: 'ordinary paths outside the project pass; system and credential ones still ask',
  [MODE.DENY]: 'anything outside this project is refused without asking',
});

/**
 * PLACES THAT ARE NEVER AUTO-APPROVED, however the mode is set.
 *
 * These are not a blocklist of "dangerous files" — that game cannot be won.
 * They are the handful of roots where a mistake is not a bad edit but a broken
 * machine or a leaked credential, and where the cost of asking is one keypress.
 */
const NEVER_AUTO = [
  /^[A-Za-z]:[\\/]?$/,                       // C:\  — the bare drive
  /^[\\/]$/,                                 // /    — the bare root
  /^[A-Za-z]:[\\/]Windows([\\/]|$)/i,
  /^[A-Za-z]:[\\/]Program Files( \(x86\))?([\\/]|$)/i,
  /^[\\/](etc|bin|sbin|usr|boot|dev|proc|sys|var)([\\/]|$)/i,
  /[\\/]\.ssh([\\/]|$)/i,
  /[\\/]\.aws([\\/]|$)/i,
  /[\\/]\.gnupg([\\/]|$)/i,
  /[\\/]\.config[\\/]gh([\\/]|$)/i,
  /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Crypto([\\/]|$)/i,
];

/** Normalise for comparison: absolute, real case-insensitive on Windows. */
function norm(p) {
  const s = path.resolve(String(p || ''));
  return process.platform === 'win32' ? s.replace(/[\\/]+$/, '').toLowerCase() : s.replace(/\/+$/, '');
}

/** Is `child` the same as, or inside, `root`? */
function within(child, root) {
  const c = norm(child);
  const r = norm(root);
  if (!c || !r) return false;
  if (c === r) return true;
  return c.startsWith(r + path.sep) || c.startsWith(`${r}/`);
}

/**
 * Is this a path where a mistake is unrecoverable?
 *
 * Checked against the REAL path where one is available, so a symlink or a
 * junction pointing at `C:\Windows` is judged by where it lands rather than by
 * what it is called.
 */
function sensitive(p) {
  const raw = path.resolve(String(p || ''));
  let real = raw;
  try { real = fs.realpathSync.native ? fs.realpathSync.native(raw) : fs.realpathSync(raw); } catch { real = raw; }
  const home = norm(os.homedir());
  for (const candidate of [raw, real]) {
    if (NEVER_AUTO.some((re) => re.test(candidate))) return true;
    // THE HOME DIRECTORY ITSELF, but not the things inside it. Writing to
    // `~/project` is ordinary; writing to `~` is a different kind of act.
    if (norm(candidate) === home) return true;
  }
  return false;
}

/** What the config records about one directory. */
function entryFor(cfg, dir) {
  const list = (cfg && cfg.trustedPaths) || [];
  const target = norm(dir);
  // THE LONGEST MATCH WINS, so trusting `~/code` and then marking
  // `~/code/vendor` read-only means the more specific answer is the one used.
  let best = null;
  for (const e of list) {
    if (!e || !e.path) continue;
    if (!within(target, e.path)) continue;
    if (!best || norm(e.path).length > norm(best.path).length) best = e;
  }
  return best;
}

/** The level LAIN currently has for a directory. UNTRUSTED until decided. */
function levelOf(cfg, dir) {
  const e = entryFor(cfg, dir);
  return e && LEVEL[e.level] ? e.level : LEVEL.UNTRUSTED;
}

/** Has this directory been decided about at all? */
function decided(cfg, dir) {
  return Boolean(entryFor(cfg, dir));
}

/**
 * Record a decision. Returns the new list, for the caller to save.
 *
 * REPLACES ANY EXACT ENTRY for the same directory rather than appending, so
 * answering twice does not leave two contradictory records with the outcome
 * decided by iteration order.
 */
function remember(cfg, dir, level) {
  const list = ((cfg && cfg.trustedPaths) || []).filter((e) => e && e.path && norm(e.path) !== norm(dir));
  if (LEVEL[level] && level !== LEVEL.UNTRUSTED) {
    list.push({ path: path.resolve(dir), level, at: new Date().toISOString() });
  }
  return list;
}

/**
 * May LAIN touch this path, given the project root and the trust level?
 *
 * @returns {{ok:boolean, why?:string, ask?:boolean, outside?:boolean}}
 *   `ask` means a person should be asked; `ok:false` with no `ask` is a refusal
 *   that asking cannot fix.
 */
function check({ cfg, root, target, write = false, autoOutside = false, mode = null } = {}) {
  // THE MODE IS THE AUTHORITY, and it is resolved here so a caller that forgets
  // to pass it still gets the configured behaviour rather than a default that
  // silently disagrees with what `/permissions` says is in force.
  //
  //   an explicit `mode`         wins, for a caller that means a specific one
  //   a CONFIGURED permissionMode next, because a mode the user actually set
  //                              must not be overridable by a caller's default
  //   otherwise `autoOutside`    the older boolean, so existing callers keep
  //                              working unchanged
  //
  // ASK IS THE FALLBACK, not AUTO. This is a security decision reached when
  // nobody has expressed one, and the conservative answer — put the question to
  // a person — is the only safe thing to assume in that case. `modeOf` is where
  // the CONFIG's own default lives, and it is deliberately not consulted here
  // for a config that says nothing.
  const m = (mode && MODE[mode]) ? MODE[mode]
    : (cfg && MODE[String(cfg.permissionMode || '').toUpperCase()]) ? MODE[String(cfg.permissionMode).toUpperCase()]
      : (autoOutside ? MODE.AUTO : MODE.ASK);
  const inside = within(target, root);

  // ---- WHICH DECISION COVERS THIS PATH ------------------------------------
  //
  // The TARGET's own entry, not the session root's. This compared against
  // `root` alone, so a second directory the user had explicitly trusted — via
  // `/permissions allow`, or "yes, and trust this folder" — was still refused
  // by the outside branch below. The user said yes and LAIN went on saying no,
  // which is worse than never having offered.
  //
  // Falls back to the root's level for a path inside the project that has no
  // entry of its own, which is the ordinary case.
  const own = entryFor(cfg, target);
  const level = own && LEVEL[own.level] ? own.level : (inside ? levelOf(cfg, root) : LEVEL.UNTRUSTED);
  const named = own ? path.basename(own.path) || own.path : path.basename(root);

  if (inside || own) {
    if (level === LEVEL.TRUSTED) return { ok: true };
    if (level === LEVEL.READ_ONLY) {
      return write
        ? { ok: false, ask: true, why: `${named} is open read-only` }
        : { ok: true };
    }
    return { ok: false, ask: true, why: `nothing has been decided about ${named} yet` };
  }

  // ---- OUTSIDE THE PROJECT ------------------------------------------------
  if (sensitive(target)) {
    // NEVER AUTOMATIC. Not a refusal — the user may genuinely mean it — but it
    // is always their call, in every mode.
    return { ok: false, ask: true, outside: true, why: 'that is a system or credential location' };
  }
  if (m === MODE.AUTO) return { ok: true, outside: true };
  // DENY REFUSES WITHOUT ASKING, and says so — `ask: false` is what stops the
  // gate putting a prompt on a screen nobody is watching and then waiting for
  // an answer that is never coming.
  if (m === MODE.DENY) {
    return { ok: false, ask: false, outside: true, why: 'that is outside this project, and permissions are set to DENY' };
  }
  return { ok: false, ask: true, outside: true, why: 'that is outside this project' };
}

module.exports = {
  LEVEL, MODE, MODE_MEANS, modeOf,
  levelOf, decided, remember, check, within, sensitive, norm, NEVER_AUTO,
};
