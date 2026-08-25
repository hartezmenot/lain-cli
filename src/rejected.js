'use strict';

/**
 * WHAT LAIN WAS NOT ALLOWED TO DO — and how to change your mind.
 *
 * A refusal that exists only in the model's tool result is a decision the
 * person at the keyboard never sees. They find out when the work is wrong, and
 * by then the reason has scrolled away. So every refusal is recorded here, and
 * `/permissions` is where they are reviewed and, if you want, allowed.
 *
 * ------------------------------------------------------------------------
 * THIS IS A LEDGER, NOT A POLICY. It stores what happened; `trust.js` decides
 * what is allowed. Allowing an entry writes a real trust decision through that
 * module rather than keeping a second list of exceptions here — two places
 * that both say what is permitted is exactly how they come to disagree.
 *
 * IN MEMORY, PER SESSION. A refusal is about a moment: the model asked for
 * something now, in this task, and the answer was no. Persisting them would
 * turn a review list into a backlog nobody empties, and the decisions that
 * SHOULD outlive the session — trusting a directory — are already persisted by
 * trust.js.
 */

const path = require('path');

/** Bounded like every other in-memory list. Newest kept. */
const MAX = 50;

/** The list for this app, created on first use. */
function listOf(app) {
  if (!app._rejected) app._rejected = [];
  return app._rejected;
}

/**
 * Record a refusal.
 *
 * COLLAPSED BY TARGET. A model that is refused will very often try the same
 * path again a moment later, and forty identical rows make the one interesting
 * refusal impossible to find. The count is kept instead, which is also the more
 * useful fact: "it tried this eleven times" says something a single row does
 * not.
 */
function note(app, { tool, target, why, write = false } = {}) {
  if (!app || !target) return null;
  const list = listOf(app);
  const key = path.resolve(String(target));
  const found = list.find((e) => e.target === key && e.tool === tool);
  if (found) {
    found.count += 1;
    found.at = Date.now();
    return found;
  }
  const entry = {
    id: `r${list.length + 1}-${Date.now().toString(36)}`,
    tool: String(tool || 'tool'),
    target: key,
    why: String(why || 'outside what this session may touch'),
    write: Boolean(write),
    count: 1,
    at: Date.now(),
    allowed: false,
  };
  list.push(entry);
  if (list.length > MAX) list.splice(0, list.length - MAX);
  return entry;
}

/** Everything refused this session, newest first. */
function all(app) {
  return listOf(app).slice().sort((a, b) => b.at - a.at);
}

/** How many DISTINCT things are waiting to be reconsidered. */
function pending(app) {
  return listOf(app).filter((e) => !e.allowed).length;
}

/**
 * Allow one entry, for real.
 *
 * IT WRITES A TRUST DECISION, through trust.js, for the DIRECTORY the path is
 * in. Allowing one file and refusing its sibling is a distinction nobody wants
 * to maintain by hand, and a second exception list here would be a second
 * source of truth about what is permitted.
 *
 * The entry is marked rather than deleted: "you allowed this" is part of the
 * record of the session, and a list that erases its own history cannot be
 * audited.
 */
function allow(app, id) {
  const entry = listOf(app).find((e) => e.id === id);
  if (!entry) return { ok: false, error: 'no such refusal' };
  const trust = require('./trust');
  const dir = path.dirname(entry.target);
  app.cfg.trustedPaths = trust.remember(app.cfg, dir, trust.LEVEL.TRUSTED);
  try { require('./config').save(app.cfg); } catch { /* an unwritable config still allows it for this session */ }
  entry.allowed = true;
  entry.allowedAt = Date.now();
  return { ok: true, entry, dir };
}

/** Forget everything. Used by `/permissions clear`. */
function clear(app) {
  const n = listOf(app).length;
  app._rejected = [];
  return n;
}

module.exports = { note, all, pending, allow, clear, MAX };
