'use strict';

/**
 * WHICH MODELS ARE NEW TO YOU.
 *
 * A refresh on a real router returns two or three thousand models, and the one
 * thing you actually wanted to know is whether the model you just added showed
 * up. The refresh report already says "3 new" — but by the time you are in the
 * picker scrolling a thousand rows, that sentence has scrolled away and there is
 * nothing beside the row itself to say which three they were.
 *
 * THE RULE, and it is deterministic on purpose:
 *
 *   A model is NEW from the moment a refresh FIRST discovers it, and stops
 *   being new when either
 *     - the NEXT refresh runs (that refresh's additions replace this set), or
 *     - you select it.
 *
 * So the marker always answers exactly one question — "what did the last
 * refresh bring in that I have not used yet?" — and it cannot accumulate,
 * because each refresh replaces the set rather than adding to it.
 *
 * NEW IS NEVER CLAIMED FOR A MODEL THAT WAS ALREADY KNOWN. The set comes from
 * the refresh diff, which compares the catalog before and after; a model that
 * was in both is not in it. The very first refresh on an empty catalog is the
 * one case where "everything is new" is true and useless, so it is skipped.
 *
 * It persists next to the model cache, because refreshing, quitting and coming
 * back tomorrow to choose is a normal way to use this.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');

/** Do not carry an unbounded id list around; a refresh that adds this many is
 *  a first discovery, not news about three models. */
const MAX_TRACKED = 200;

function file() {
  return path.join(config.configDir(), 'new-models.json');
}

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { at: Number(j.at) || 0, ids: Array.isArray(j.ids) ? j.ids : [] };
  } catch { return { at: 0, ids: [] }; }
}

function write(state) {
  try {
    fs.mkdirSync(config.configDir(), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file());
    return true;
  } catch { return false; }        // an unwritable config still runs
}

/**
 * Record what a refresh just discovered. REPLACES the previous set.
 *
 * @param {string[]} added        model ids the refresh added
 * @param {boolean}  firstCatalog true when there was nothing before this
 */
function record(added, { firstCatalog = false } = {}) {
  const ids = Array.isArray(added) ? added.filter(Boolean) : [];
  // "Everything is new" is true on a first discovery and tells you nothing, so
  // the marker stays off rather than painting a thousand rows.
  if (firstCatalog || ids.length > MAX_TRACKED) { write({ at: Date.now(), ids: [] }); return []; }
  write({ at: Date.now(), ids });
  return ids;
}

/** The current set, as a Set of ids. */
function all() {
  return new Set(read().ids);
}

function isNew(id) {
  return read().ids.includes(String(id));
}

/** You used it, so it is no longer news. */
function seen(id) {
  const state = read();
  const next = state.ids.filter((x) => x !== String(id));
  if (next.length === state.ids.length) return false;
  write({ at: state.at, ids: next });
  return true;
}

/** Forget everything. Used by `/api refresh` failures and by tests. */
function clear() { return write({ at: Date.now(), ids: [] }); }

module.exports = { record, all, isNew, seen, clear, file, MAX_TRACKED };
