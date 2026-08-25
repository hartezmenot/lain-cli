'use strict';

/**
 * WHO MAY SEE THE DASHBOARD — a password, hashed, and the session it buys.
 *
 * WHY A PASSWORD AND NOT THE TOKEN. A per-session random token is strong, and
 * it was strictly better than the token-in-the-URL it replaced. It has one
 * practical fault: it changes every session, so reaching the dashboard from a
 * phone means finding the terminal and copying 32 hex characters, every time.
 * That is a credential the user cannot ever KNOW, only transcribe. A password
 * they choose once is the thing you can actually use from the sofa.
 *
 * ------------------------------------------------------------------------
 * WHAT IS AND IS NOT STORED.
 *
 *   NEVER THE PASSWORD.  Only `scrypt(password, salt)`. The config file holds
 *                        the salt, the hash and the parameters; there is no
 *                        code path that writes the password anywhere, and none
 *                        that can recover it.
 *   NEVER IN CONTEXT.    `/dash password` prints nothing back, and the value is
 *                        never handed to `render.write`.
 *   NEVER IN HISTORY.    See dashcommand.js — the command reads it from a
 *                        prompt rather than from the argument line, so it does
 *                        not enter the input history or the transcript.
 *
 * scrypt is deliberate: it is in node:crypto, needs no dependency, and is
 * memory-hard, so a stolen config file does not become a fast offline guessing
 * exercise. The cost parameters are the Node defaults, which are sized for
 * exactly this.
 *
 * ------------------------------------------------------------------------
 * THE TOKEN DID NOT GO AWAY, it changed job. Proving the password once buys a
 * SESSION token, which is what the page then sends on every request. So the
 * password crosses the wire once instead of forty times a minute, and revoking
 * everyone is dropping a Map rather than changing a secret.
 */

const crypto = require('crypto');

/** scrypt output length, in bytes. */
const KEY_LEN = 32;
/** How long a proved session lasts without being used. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * How many wrong guesses before a client is refused outright.
 *
 * A dashboard on a LAN is reachable by anything on that LAN, and a four-word
 * password is not much against an unbounded guesser. This is not rate limiting
 * dressed up — it is a hard stop, cleared by restarting LAIN.
 */
const MAX_ATTEMPTS = 10;

/** Hash a password for storage. Returns what config.json should hold. */
function hash(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, KEY_LEN);
  return { alg: 'scrypt', salt: salt.toString('hex'), hash: key.toString('hex'), n: KEY_LEN };
}

/**
 * Is this the password? Constant-time, and false for anything malformed.
 *
 * NEVER THROWS. A truncated or hand-edited record must read as "wrong
 * password", not as a stack trace out of the request handler — an auth check
 * that can crash is an auth check that can be made to fail open.
 */
function verify(record, password) {
  try {
    if (!record || record.alg !== 'scrypt' || !record.salt || !record.hash) return false;
    const salt = Buffer.from(String(record.salt), 'hex');
    const want = Buffer.from(String(record.hash), 'hex');
    if (!salt.length || !want.length) return false;
    const got = crypto.scryptSync(String(password == null ? '' : password), salt, want.length);
    return crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** Is a password configured at all? */
function configured(cfg) {
  const r = cfg && cfg.dashPassword;
  return Boolean(r && r.alg === 'scrypt' && r.salt && r.hash);
}

/**
 * The proved sessions, and the refusals.
 *
 * In memory only, so every session token dies with the process — which is the
 * behaviour you want from something whose whole job is to be revocable.
 */
class Sessions {
  constructor({ ttlMs = SESSION_TTL_MS, maxAttempts = MAX_ATTEMPTS } = {}) {
    this.ttlMs = ttlMs;
    this.maxAttempts = maxAttempts;
    this.byToken = new Map();   // token -> { at, label }
    this.failures = 0;
  }

  /** True once too many wrong guesses have been made. Cleared by a restart. */
  get lockedOut() { return this.failures >= this.maxAttempts; }

  /** Record a wrong guess. Returns how many remain. */
  noteFailure() {
    this.failures += 1;
    return Math.max(0, this.maxAttempts - this.failures);
  }

  /** Mint a session for a client that proved the password. */
  grant(label = '') {
    const token = crypto.randomBytes(24).toString('hex');
    this.byToken.set(token, { at: Date.now(), label: String(label || '') });
    this.failures = 0;          // a success clears the count
    return token;
  }

  /** Is this a live session? Touching it keeps it alive. */
  valid(token) {
    const t = String(token || '');
    const e = this.byToken.get(t);
    if (!e) return false;
    if (Date.now() - e.at > this.ttlMs) { this.byToken.delete(t); return false; }
    e.at = Date.now();
    return true;
  }

  /** Drop everything — every open page is logged out on its next request. */
  revokeAll() {
    const n = this.byToken.size;
    this.byToken.clear();
    return n;
  }

  get count() { return this.byToken.size; }
}

module.exports = { hash, verify, configured, Sessions, SESSION_TTL_MS, MAX_ATTEMPTS, KEY_LEN };
