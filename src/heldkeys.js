'use strict';

/**
 * WHAT IS CURRENTLY HELD DOWN — and the promise that it comes back up.
 *
 *: "A process crash must not leave W held forever."
 *
 * ------------------------------------------------------------------------
 * THE GAP THIS CLOSES, which the `finally` in keyboarddelivery.hold does not.
 *
 * That `finally` is correct and stays: if the wait throws, the release still
 * runs. But it only protects the case where THIS PROCESS KEEPS RUNNING. Three
 * ways out leave a key down with nobody to lift it:
 *
 *     Ctrl+C during a hold        the process is torn down mid-await
 *     an uncaught exception       the stack unwinds past the finally's frame
 *     the user closing LAIN       no more turns, and W is still down
 *
 * In every one of those the key is down IN WINDOWS, not in LAIN — so the state
 * that has to be repaired lives outside the program that crashed, and a
 * variable inside it cannot repair anything. What can is a small registry that
 * knows which keys are down and how to lift them, plus exit handlers that run
 * on the way out.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS A MODULE-LEVEL SINGLETON, against the usual rule.
 *
 * State on the app is right for anything that belongs to a session. A key held
 * down belongs to the MACHINE: it survives the session, the app object and the
 * turn that pressed it, and the process exiting is exactly when there is no app
 * left to ask. The registry is keyed by key name for the same reason — Windows
 * has one W, however many LAIN objects exist in this process.
 *
 * NOTHING HERE ASKS PERMISSION. Releasing a key is the undo of something that
 * was already permitted, and requiring a fresh grant to STOP pressing a key
 * would mean a refusal leaves it down. Lifting is always allowed.
 */

/** key (upper-case) -> { release, at, why } */
const held = new Map();

let armed = false;

/** Nothing may hang the exit path. A release that stalls is abandoned. */
const RELEASE_MS = 1500;

/**
 * Record that a key went down, with the means to lift it.
 *
 * @param {string} key      as the transport spells it
 * @param {Function} release  () => Promise, idempotent, needs no permission
 * @param {string} why      for the report, when a stuck key has to be explained
 */
function down(key, release, why = '') {
  const k = String(key || '').trim().toUpperCase();
  if (!k || typeof release !== 'function') return null;
  held.set(k, { release, at: Date.now(), why: String(why || '') });
  arm();
  return k;
}

/** Record that a key came up. Never throws — an unknown key is simply not held. */
function up(key) {
  const k = String(key || '').trim().toUpperCase();
  if (!k) return false;
  return held.delete(k);
}

/** What is down right now, for /status, the report and the final audit. */
function list() {
  return [...held.entries()].map(([key, v]) => ({ key, heldMs: Date.now() - v.at, why: v.why }));
}

/**
 * LIFT EVERYTHING. The one operation the exit path needs.
 *
 * EVERY KEY IS ATTEMPTED even if an earlier one throws: one transport error
 * must not leave the remaining keys down, which is the whole failure being
 * prevented. The registry is cleared regardless — a key we cannot lift is not
 * a key we should keep trying to lift on the way out of the process.
 *
 * @returns {Promise<{released:string[], failed:Array<{key:string,error:string}>}>}
 */
async function releaseAll(why = 'shutting down') {
  const entries = [...held.entries()];
  held.clear();
  const released = [];
  const failed = [];
  for (const [key, v] of entries) {
    try {
      await Promise.race([
        Promise.resolve(v.release(why)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('release timed out')), RELEASE_MS)),
      ]);
      released.push(key);
    } catch (e) {
      failed.push({ key, error: (e && e.message) || 'release failed' });
    }
  }
  return { released, failed };
}

/**
 * The synchronous half, for `process.on('exit')`.
 *
 * NOTHING ASYNC RUNS AT 'exit' — no promise callback, no timer, no I/O
 * completion. So an async release registered there is a release that never
 * happens, and the honest thing is to say so on stderr rather than to appear to
 * handle it. The async paths above cover every exit LAIN controls; this covers
 * the ones it does not, by telling the person which key is down and how to
 * clear it. A message a person can act on beats a handler that cannot run.
 */
function warnIfStillHeld() {
  if (!held.size) return '';
  const keys = [...held.keys()].join(', ');
  return `LAIN exited with ${keys} still held down. Press and release ${keys} to clear it.`;
}

/**
 * Attach the exit handlers, once.
 *
 * ARMED LAZILY, on the first key that actually goes down: a session that never
 * touches the keyboard should not install process-wide handlers, and the test
 * suite runs thousands of sessions that never press anything.
 */
function arm() {
  if (armed) return;
  armed = true;
  const flush = async (why) => {
    if (!held.size) return;
    const r = await releaseAll(why);
    if (r.failed.length) {
      process.stderr.write(`could not release ${r.failed.map((f) => f.key).join(', ')} — press them by hand\n`);
    }
  };
  // beforeExit CAN await, and is where an ordinary end-of-run lands.
  process.once('beforeExit', () => { flush('LAIN is finishing').catch(() => {}); });
  // 'exit' cannot. All that is left is to tell the person.
  process.once('exit', () => {
    const msg = warnIfStillHeld();
    if (msg) process.stderr.write(`${msg}\n`);
  });
}

/** For tests and for a fresh process: forget everything without releasing. */
function reset() { held.clear(); }

module.exports = { down, up, list, releaseAll, warnIfStillHeld, reset, RELEASE_MS };
