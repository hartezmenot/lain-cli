'use strict';

/**
 * The dashboard. Two deliberate defects live here; see the fixture README.
 */

let cache = null;

/**
 * Pull the latest reading and store it.
 *
 * DEFECT 1: every exception is swallowed, so a failing pull is indistinguishable
 * from a successful one and the caller can never know the dashboard is stale.
 */
function refresh(pull) {
  try {
    cache = pull();
    return cache;
  } catch (e) {
    return null;
  }
}

/**
 * The signal state the dashboard should display.
 *
 * DEFECT 2: it returns the cached value rather than the live one, so the
 * dashboard keeps showing the last good reading after the source has changed.
 */
function signalState(live) {
  return cache;
}

function reset() { cache = null; }

module.exports = { refresh, signalState, reset };
