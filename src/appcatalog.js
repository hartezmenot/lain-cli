'use strict';

/**
 * WHICH MODELS THIS APP CAN REACH — connections, the catalog, and discovery.
 *
 * Split out of app.js when that file reached the architecture guard, and the
 * seam is the honest one: app.js orchestrates a SESSION — identify, submit,
 * complete, resume — and this answers a question about the OUTSIDE WORLD that
 * has nothing to do with any of it. It is the only place that decides which
 * connections exist, what they serve, and what the user is told while that is
 * being found out.
 *
 * Every function takes the app rather than being a method on it, so nothing
 * here can quietly acquire session state. They are re-exposed as App methods,
 * so no caller had to move with them.
 */

const connectionsMod = require('./connections');
const catalogMod = require('./catalog');

/** Connections as currently configured, with real request evidence applied. */
function connections(app) {
  return connectionsMod.fromConfig({ ...app.cfg, _evidence: app.connectionEvidence }, app.connectionEvidence);
}

/** The canonical catalog: one row per MODEL, routes underneath. */
function catalog(app) {
  return catalogMod.build(connections(app));
}

/**
 * Make sure the catalog can answer before something needs it.
 *
 * A connection states WHERE it is; what it SERVES is discovered from it. With
 * no declared model list and no cache, `/models` had nothing to show and no
 * model could be selected — which took the whole product down, because
 * `provider.resolve` needs a model to resolve.
 *
 * The DECIDING and the FETCHING both live in connections.js. This is the
 * orchestration: which set to ask for, and what the user is told while it
 * happens. It is a catalog request, never a model call — no tokens and no
 * completion — it runs at most once per connection per launch, and the answer
 * is cached on disk for a day, so it is not a background poll in disguise.
 */
async function ensureCatalog(app, { force = false, only = null, announce = true } = {}) {
  if (!app._discovered) app._discovered = new Set();
  return connectionsMod.discoverAll(connections(app), {
    force,
    only,
    done: app._discovered,
    signal: app.abort ? app.abort.signal : undefined,
    onProgress: announce ? (id) => app.transient('info', `discovering models from ${id}…`) : null,
  }).then((results) => {
    if (announce) {
      for (const r of results) {
        if (r.ok) app.transient('info', `${r.id}: ${r.count} model(s) advertised`);
        else app.transient('warn', `${r.id}: could not read a model list — ${r.error}`);
      }
    }
    return results;
  });
}

module.exports = { connections, catalog, ensureCatalog };
