'use strict';

/**
 * THE CLIENT SIDE OF REMOTE CONTROL — and it is a client, not an implementation.
 *
 * ------------------------------------------------------------------------
 * WHAT IS NOT IN THIS FILE, and must never arrive in it.
 *
 * No Telegram polling. No bot token. No chat ids. No idea what a pairing code
 * is beyond a string to print. No second opinion about whether a session is
 * running. Every one of those lives in the supervisor, because every one of
 * them has to outlive this process — see rust/lain-supervisor/src/remote.rs.
 *
 * What IS here: the wire calls, and the shapes the terminal draws.
 *
 * ------------------------------------------------------------------------
 * THE CREDENTIAL PASSES THROUGH AND IS NOT KEPT.
 *
 * `connect` takes a token, puts it on a loopback socket, and returns. It is not
 * stored on `app`, not written to config.json, not added to the session, and
 * not returned by anything here — `status()` answers with an identity and a
 * count, which is what a person needs to see and the least that will do.
 *
 * The one thing this file does with it locally is hand it to redact.js, so that
 * if the value ever reaches a screen by some route nobody predicted, it is
 * drawn as `123…dsaw` rather than as itself.
 *
 * ------------------------------------------------------------------------
 * `capability` IS THE SAME DOOR THE PHONE USES.
 *
 * `/session` in the terminal and "what is still running?" on Telegram end up in
 * the same `capability::run` in the same process, and get the same text back.
 * That is the entire point of §20: one runtime, several windows. A view built
 * here out of `app.jobs` and `session.turns` would be a second truth, and on
 * the day the two disagreed there would be no way to say which was wrong.
 */

const supervisor = require('./supervisor');

/** A wire call that must not wait forever on a wedged supervisor. */
const TIMEOUT_MS = 8000;

/**
 * Proving a token means a round trip to Telegram, which is a real network on
 * somebody's hotel wifi.
 */
const CONNECT_TIMEOUT_MS = 30000;

/** The answer when there is no runtime to ask. Frozen: a caller that mutates a
 * shared "nothing" would corrupt the next caller's nothing. */
const ABSENT = Object.freeze({ available: false, configured: false, link: 'STOPPED' });

async function ask(msg, { timeoutMs = TIMEOUT_MS, start = false } = {}) {
  try {
    const r = start
      ? await supervisor.call(msg, { timeoutMs })
      : await supervisor.callIfRunning(msg, { timeoutMs });
    return r || null;
  } catch {
    // A supervisor that cannot be reached is a STATE, not an exception — the
    // rule guardian.js already follows, for the reason stated there.
    return null;
  }
}

/**
 * WHAT IS CONNECTED, WITHOUT STARTING ANYTHING.
 *
 * Reading must not spawn a supervisor: a person who types `/rc` to check
 * whether they ever set this up has not asked to start a background process.
 */
async function status() {
  const r = await ask({ op: 'remote_status' });
  if (!r || !r.ok) return { ...ABSENT };
  return { available: true, ...(r.remote || {}) };
}

/**
 * PROVE IT, THEN STORE IT — in that order, and the order is the safety.
 *
 * The supervisor calls `getMe` before writing anything, so a typo is never
 * persisted and never reported as a working connection. `start: true` because
 * connecting a bot is precisely the case where a runtime is worth having: the
 * adapter has to keep listening after this terminal has gone.
 */
async function connect(token) {
  // ---- HELD BACK FROM EVERY SCREEN BEFORE IT IS SENT ANYWHERE ------------
  //
  // Same as the `/api` flow, and for the same reason: from here on the exact
  // bytes are known, so redact.js can keep them off the activity feed, an
  // error message, the transcript, the dashboard and a copied buffer. The
  // input history is scrubbed too — the panel keeps a secret answer out of
  // ↑/↓, and this is the belt to that pair of braces.
  const redact = require('./redact');
  redact.register(token);
  const r = await ask({ op: 'remote_connect', token }, { timeoutMs: CONNECT_TIMEOUT_MS, start: true });
  if (!r) return { ok: false, error: 'no runtime answered — the supervisor could not be started' };
  if (!r.ok) return { ok: false, error: r.error || 'the token was not accepted' };
  return { ok: true, remote: r.remote || {}, pairingCode: r.pairing_code || '' };
}

/**
 * WHICH LOCAL MODEL SPEAKS FOR LAIN.
 *
 * A base URL and a model name, which is how LAIN has always described a place a
 * model lives — see connections.js. Nothing new is invented here and no second
 * provider system exists: `/rc` picks one of the connections the user already
 * has, and only a local one.
 */
async function setBrain({ baseUrl, model, key = '' }) {
  if (key) require('./redact').register(key);
  const r = await ask(
    { op: 'remote_brain', base_url: String(baseUrl || ''), model: String(model || ''), key: String(key || '') },
    { start: true },
  );
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'no runtime answered' };
  return { ok: true, remote: r.remote || {} };
}

/** GONE MEANS GONE: the credential and the authorizations are removed, not hidden. */
async function disconnect() {
  const r = await ask({ op: 'remote_disconnect' });
  if (!r) return { ok: false, error: 'no runtime is running, so nothing is connected' };
  if (!r.ok) return { ok: false, error: r.error || 'the runtime refused' };
  return { ok: true, removed: Boolean(r.removed), remote: r.remote || {} };
}

/** Restart the adapter, keeping the credential and the authorizations. */
async function reconnect() {
  const r = await ask({ op: 'remote_reconnect' }, { start: true });
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'nothing is connected' };
  return { ok: true, remote: r.remote || {} };
}

/** A fresh pairing code, for a code that expired or a second device. */
async function pairCode() {
  const r = await ask({ op: 'remote_pair_code' });
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'nothing is connected' };
  return { ok: true, code: r.pairing_code || '', remote: r.remote || {} };
}

/**
 * ONE CAPABILITY, THROUGH THE SAME VALIDATION A CHAT GOES THROUGH.
 *
 * `readOnly` exists so a caller can drop its own authority deliberately. The
 * terminal does not: a local client on a loopback socket has already proved
 * more than any chat can — it is running as the user, on the user's machine.
 *
 * Returns `{ ok, text, result }`. `text` is the authoritative rendering, made
 * in the runtime alongside the data, so a terminal and a phone cannot end up
 * describing different runtimes.
 */
async function capability(name, args = {}, { readOnly = false } = {}) {
  const r = await ask({ op: 'capability', name: String(name), args, read_only: Boolean(readOnly) });
  // ---- "NOTHING ANSWERED" IS NOT "THE ANSWER WAS NO" ----------------------
  //
  // THE DEFECT THIS FIXES, found by driving the real CLI: `callIfRunning`
  // reports a missing supervisor as `{ok: false, error: 'no supervisor is
  // running'}` — an OBJECT, and therefore truthy. The first version of this
  // checked only `if (!r)`, so a machine with no runtime reported
  // `available: true` with an empty answer, and `/session` drew its heading over
  // nothing instead of saying it could not ask. Exactly the confusion between
  // "quiet" and "not connected" that runtimefeed.js exists to prevent.
  //
  // THE SUPERVISOR ALWAYS ECHOES `op`. Its presence is the proof that a reply
  // came from the runtime at all, which is a different question from whether the
  // runtime agreed to what was asked.
  const answered = Boolean(r && r.op);
  if (!answered) return { ok: false, available: false, text: '', result: null };
  return { ok: Boolean(r.ok), available: true, text: String(r.text || ''), result: r.result || null };
}

module.exports = { status, connect, setBrain, disconnect, reconnect, pairCode, capability, ABSENT };
