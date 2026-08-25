'use strict';

/**
 * A CREDENTIAL MAY EXIST INSIDE LAIN. IT MAY NOT BE DRAWN.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS ONE MODULE AND NOT A RULE EVERY SURFACE FOLLOWS.
 *
 * Masking used to live where the key was TYPED — ui/inputbox.js draws dots
 * instead of characters, ui/index.js keeps the line out of ↑/↓ history — and
 * that is correct and it is one surface of a dozen. A key reaches a screen by
 * many other routes, and every one of them is somebody remembering:
 *
 *     an activity row          a command echoed with its argument
 *     an error message         a provider that quotes the request it refused
 *     a status view            a connection listing what it holds
 *     the transcript           anything written linearly, later copied
 *     a summary                the model repeating what it was told
 *     the dashboard            a second renderer, in a browser
 *
 * A rule that each of those must remember to apply is a rule that one of them
 * will not. So the redaction is not a rule — it is a FILTER ON THE WAY OUT,
 * applied at the two places bytes become a screen (src/render.js `write`, which
 * is the only linear writer, and ui/layout.js `draw`, which is the only frame
 * writer) and at the places bytes leave for somewhere else (the clipboard, the
 * transcript, the dashboard). A surface added tomorrow inherits it by writing
 * through the same door.
 *
 * ------------------------------------------------------------------------
 * IT REDACTS BY VALUE, NOT BY SHAPE, and that ordering is the whole design.
 *
 * A pattern for "things that look like an API key" cannot be written: every
 * provider spells its keys differently, and the one that appears next month is
 * refused by a regex written today — the same failure as a hardcoded provider
 * list, one level down. What LAIN actually KNOWS is the exact bytes of the
 * credentials it is holding, because it is holding them. So those exact strings
 * are what is looked for, and a shape pattern runs only as a second pass for a
 * token that arrived from somewhere LAIN never stored — a provider echoing an
 * `Authorization` header back inside an error, most commonly.
 *
 * ------------------------------------------------------------------------
 * WHAT IS SHOWN INSTEAD. `sk-…9f2a` — enough to recognise which key you pasted,
 * not enough to be one. The same shape `/api` already reported, from the same
 * function, so the two cannot disagree about what a masked key looks like.
 *
 * ------------------------------------------------------------------------
 * NEVER WRITTEN DOWN. The registry is a Set in memory for the life of the
 * process. It is never serialised, never logged, and never reaches the config
 * file — the config file holds the credential itself, which is a separate
 * decision made by the user when they ran `/api`.
 */

/**
 * THE LIVE CREDENTIALS THIS PROCESS IS HOLDING.
 *
 * Module scope, deliberately: a secret is a property of the PROCESS, not of a
 * session or a turn. Two sessions in one process share a terminal, and a key
 * masked in one and printed by the other is not masked.
 */
const secrets = new Set();

/**
 * Below this, a string is too short to be a credential and too likely to be a
 * word. Redacting an 8-character value out of every line that contains it would
 * do more damage than the leak it prevents.
 */
const MIN_SECRET = 12;

/** `sk-…9f2a` — enough to recognise, not enough to use. */
function shape(cred) {
  const s = String(cred || '');
  if (s.length <= 10) return '…';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

/**
 * Hold this value back from every display surface, from now on.
 *
 * Called wherever a credential enters LAIN: the `/api` flow that stores one,
 * the connection layer that reads one out of config or the environment, and
 * the provider layer that puts one in a header.
 */
function register(secret) {
  const s = String(secret == null ? '' : secret).trim();
  if (s.length < MIN_SECRET) return false;
  secrets.add(s);
  return true;
}

/** Everything a config file and the environment are currently holding. */
function registerFrom(cfg = {}) {
  const conns = (cfg && cfg.connections && typeof cfg.connections === 'object') ? cfg.connections : {};
  for (const c of Object.values(conns)) {
    if (!c || typeof c !== 'object') continue;
    if (c.apiKey) register(c.apiKey);
    if (c.token) register(c.token);
    if (c.envKey && process.env[c.envKey]) register(process.env[c.envKey]);
  }
  // The env-declared routes, from the one table of them. A key that configures
  // LAIN without a config file is exactly as secret as one that is written down.
  try {
    for (const r of require('./providers').envRoutes()) {
      if (r.envKey && process.env[r.envKey]) register(process.env[r.envKey]);
    }
  } catch { /* providers is a leaf module; if it cannot load, nothing else can */ }
  return secrets.size;
}

/** Forget everything. For tests, and for a process that has re-keyed. */
function clear() { secrets.clear(); }

/** How many are held. Never WHAT is held — that would be the leak itself. */
function count() { return secrets.size; }

/**
 * A TOKEN THAT ARRIVED FROM SOMEWHERE LAIN NEVER STORED.
 *
 * The second pass, and it is deliberately narrow: only a value that is
 * INTRODUCED as a credential by the text around it. `Bearer <token>`,
 * `x-api-key: <token>`, `"api_key": "<token>"` — the shapes a provider uses
 * when it quotes the request it just refused.
 *
 * NOT a general "long random string" detector. A commit hash, a file digest and
 * a base64 payload are all long random strings that a person needs to be able
 * to read, and a filter that ate those would be turned off within a day.
 */
const INTRODUCED = new RegExp(
  '((?:bearer\\s+|x-api-key\\s*[:=]\\s*"?|api[_-]?key\\s*[:=]\\s*"?|'
  + 'authorization\\s*[:=]\\s*"?(?:bearer\\s+)?|token\\s*[:=]\\s*"?))'
  + '([A-Za-z0-9_\\-.]{16,})', 'gi');

/**
 * The text, with every credential this process holds replaced by its shape.
 *
 * PURE and cheap: with nothing registered and no introduced token, the input is
 * returned unchanged and nothing is allocated. This runs on the frame path, so
 * the common case has to cost a scan and no more.
 */
function text(s) {
  if (s === null || s === undefined) return s;
  let out = String(s);
  if (!out) return out;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(shape(secret));
  }
  // The second pass only pays for itself when the introducing word is present.
  if (/bearer|api[_-]?key|authorization|token/i.test(out)) {
    out = out.replace(INTRODUCED, (m, lead, tok) => lead + shape(tok));
  }
  return out;
}

/**
 * Does this text still contain a credential? For the tests, and for a caller
 * that wants to refuse rather than mask.
 */
function leaks(s) {
  const t = String(s == null ? '' : s);
  for (const secret of secrets) if (t.includes(secret)) return true;
  return false;
}

/**
 * A CREDENTIAL TYPED ON THE COMMAND LINE IS TAKEN BACK OUT OF HISTORY.
 *
 * `/api` asks for the key through a masked panel, and a line answered there is
 * never remembered (ui/index.js). But `/api sk-...` typed at the prompt is an
 * ordinary line: it was remembered before anything knew what it was, and the
 * up-arrow would put it back on screen in plain text. The filter on the writer
 * would mask the DRAWING of it, and the buffer would still hold the real key
 * for the next Enter to send somewhere.
 *
 * So the moment a credential is registered, every history entry containing it
 * is DROPPED. Dropped rather than masked: a recalled `/api sk-...9f2a` would be
 * a command that re-keys the route with the mask.
 *
 * IT LIVES HERE RATHER THAN ON THE LINE EDITOR because it is secret policy, and
 * secret policy has one owner. src/input.js knows about lines and keystrokes;
 * it has no business knowing what a credential is.
 *
 * @param {object} input  the Input (src/input.js), or anything with `history`
 * @returns {number} how many entries were dropped
 */
function scrubHistory(input) {
  if (!input || !Array.isArray(input.history)) return 0;
  const before = input.history.length;
  input.history = input.history.filter((h) => !leaks(h));
  const dropped = before - input.history.length;
  if (dropped) input.histIndex = input.history.length;
  // The line still being edited is the same exposure, one keystroke earlier.
  if (leaks(input.line) && typeof input.setLine === 'function') input.setLine('');
  return dropped;
}

module.exports = { register, registerFrom, clear, count, text, leaks, shape, scrubHistory, MIN_SECRET };
