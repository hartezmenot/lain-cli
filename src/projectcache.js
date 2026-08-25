'use strict';

/**
 * THE SHALLOW VIEW OF THIS SESSION'S PROJECT, COMPUTED ONCE.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS CACHED AT ALL, which is the only interesting thing about it. The
 * welcome pane and the FILES view both want a scan and a tree, and BOTH REDRAW
 * ON EVERY KEYSTROKE. Scanning per frame would put a directory walk between a
 * person's finger and the character appearing, on a machine where the project
 * may be a monorepo. So it is computed on the first ask and kept.
 *
 * ------------------------------------------------------------------------
 * AND WHY IT IS CLEARED WHERE IT IS. The cache is keyed to `session.cwd`, and
 * `App.adopt` sets all three back to `undefined` when a session changes —
 * `/resume` and `/cwd` are exactly the moments a kept scan would start
 * describing a directory nobody is in any more. That clearing stays in adopt.js's
 * territory on purpose: it is the same line that rebinds the checkpoints and the
 * project brief, and splitting one "this is a different session now" statement
 * across two files is how one of the three gets forgotten.
 *
 * ------------------------------------------------------------------------
 * WHY IT MOVED OUT OF app.js. The god-object guard, and the same reasoning
 * `providerhealth.js`, `steerqueue.js` and `appcatalog.js` were lifted out
 * under: app.js owns the SESSION LOOP — submitting a turn, running it, ending
 * it, deciding whether the work is complete. A memoised directory scan is a
 * coherent subject that has nothing to do with any of that, and it changes for
 * entirely different reasons.
 *
 * The methods stay on the App as one-line delegations, because every caller in
 * the tree and every test already asks the app — which is the same shape
 * `connections()` and `catalog()` take.
 *
 * PLAIN FUNCTIONS OVER `app`, no `this`.
 */

/**
 * The shallow scan: manifests, top-level tree, the things that say what this
 * repository IS. Null when it could not be read, which is a normal answer for
 * a directory that has just been deleted from under a running LAIN.
 */
function scan(app) {
  if (app._scan === undefined) {
    try { app._scan = require('./project').scan(app.session.cwd); } catch { app._scan = null; }
  }
  return app._scan;
}

/**
 * Is there a recognisable project here?
 *
 * Decides whether "build a trading bot" means a NEW repository or a feature
 * inside this one — the same sentence meaning two different jobs depending on
 * where it was typed. Read from the scan that is already cached, so it costs
 * nothing to ask on every input.
 */
function isEmpty(app) {
  const s = scan(app);
  if (!s) return true;
  return !(s.manifests || []).length && !(s.tree || []).length;
}

/** The file tree the FILES view draws. Same cache, same lifetime. */
function tree(app) {
  if (app._tree === undefined) {
    try { app._tree = require('./ui/panes').scanTree(app.session.cwd); } catch { app._tree = []; }
  }
  return app._tree;
}

module.exports = { scan, isEmpty, tree };
