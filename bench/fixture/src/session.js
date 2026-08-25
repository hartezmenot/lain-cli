'use strict';

// Operator sessions. A session exists only on top of a token auth accepted:
// a rejected token is a login failure, not a session with a hole in it.

const { issueToken, validateToken } = require('./auth');

let seq = 0;

/**
 * Open a session for an operator. Returns `{ ok: false, reason }` when the
 * token does not validate.
 */
function createSession(user) {
  const token = issueToken(user);
  if (!validateToken(token)) return { ok: false, reason: 'TOKEN_REJECTED' };
  seq += 1;
  return { ok: true, token, user, id: seq };
}

/** Close a session. Idempotent. */
function closeSession(session) {
  if (!session || !session.ok) return false;
  session.closed = true;
  return true;
}

module.exports = { createSession, closeSession };
