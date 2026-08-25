'use strict';

/**
 * A RATE LIMIT IS A FACT ABOUT A ROUTE, NOT ABOUT A MODEL.
 *
 * ------------------------------------------------------------------------
 * THE CONFUSION THIS EXISTS TO END.
 *
 *     provider A + model X  ->  rate limited
 *
 * is routinely read as
 *
 *     model X  ->  unavailable
 *
 * and it is not. The same model is very often reachable through two or three
 * configured connections, and a limit on one of them says nothing whatever
 * about the others. Treating the two as the same thing produces the worst
 * possible offer at the worst possible moment: "this model is rate limited,
 * would you like a DIFFERENT MODEL" — when the model was fine and it was the
 * road to it that was closed.
 *
 * Changing model changes the answers. It changes reasoning quality, tool
 * behaviour, context size and cost, in the middle of a task the user chose
 * that model for. Changing provider changes none of those. So they are
 * different operations, they are offered separately, and the cheap one is
 * offered first.
 * ------------------------------------------------------------------------
 *
 * NOTHING HERE IS A SECOND ROUTER. The eligible routes come from
 * `catalog.build()` — the same structure `/model` and `provider.resolve()`
 * read, in which a model already HAS a list of connections — and their health
 * comes from `availability.js`, which has always been keyed by connection id
 * precisely so that one provider being down says nothing about another. This
 * file adds no state and no routing table. It asks two questions of two
 * existing systems and puts the answers side by side, which is the one thing
 * nothing was doing.
 *
 * AND IT NEVER CHANGES THE MODEL. `pick` returns routes for the model it was
 * given or it returns nothing. A silent downgrade to a different model when
 * every road is closed would be the same category error in the other
 * direction, and it would be invisible: the task would simply start producing
 * different work.
 */

const catalogMod = require('./catalog');
const connectionsMod = require('./connections');
const { STATUS } = require('./availability');

/**
 * WHAT KIND OF CHANGE IS BEING ASKED FOR.
 *
 * The distinction `/steer` needs, and the reason it needs it: only the first
 * of these preserves what the user chose.
 */
const ROUTE = Object.freeze({
  UNCHANGED: 'UNCHANGED',
  PROVIDER_FAILOVER: 'SAME MODEL / DIFFERENT PROVIDER',
  MODEL_CHANGE: 'DIFFERENT MODEL / SAME PROVIDER',
  MODEL_AND_PROVIDER: 'DIFFERENT MODEL / DIFFERENT PROVIDER',
  UNKNOWN: 'UNKNOWN',
});

/** Why a route cannot be used right now. */
const BLOCKED = Object.freeze({
  RATE_LIMITED: 'rate limited',
  UNAVAILABLE: 'unreachable',
  DISABLED: 'disabled',
  MAINTENANCE: 'in maintenance',
});

/** The catalog for this app's configured connections. Built, never cached. */
function catalogOf(app) {
  const cfg = (app && app.cfg) || {};
  const connections = connectionsMod.fromConfig(cfg, (app && app.connectionEvidence) || {});
  return catalogMod.build(connections);
}

/**
 * EVERY ROUTE TO ONE MODEL, with what is currently true about each.
 *
 * This is the whole answer to "is the model unavailable, or is one road to it
 * closed" — a question nothing could previously ask, because the two halves
 * lived in two systems that never met.
 */
function routesFor(app, model, { now = Date.now() } = {}) {
  const modelId = String(model || (app && app.cfg && app.cfg.model) || '');
  if (!modelId) return [];
  let catalog;
  try { catalog = catalogOf(app); } catch { return []; }
  const m = catalog.byId.get(modelId) || catalogMod.find(catalog, modelId);
  if (!m) return [];

  const avail = app && app.availability;
  const current = app && app.cfg ? app.cfg.connection : null;

  return m.connections.map((c) => {
    const state = avail ? avail.get(c.connectionId) : null;
    const gate = avail ? avail.shouldAttempt(c.connectionId, now) : { allow: true, status: STATUS.UNKNOWN, reason: '' };
    const limited = Boolean(state && state.rateLimited && (!state.resumeAt || state.resumeAt > now));
    return {
      model: m.id,
      connectionId: c.connectionId,
      provider: c.provider || c.connectionId,
      current: c.connectionId === current,
      status: state ? state.status : STATUS.UNKNOWN,
      rateLimited: limited,
      resumeAt: (state && state.resumeAt) || 0,
      // ELIGIBLE MEANS "a request sent here right now would be attempted".
      // Both halves matter: the breaker's verdict AND the limit, which are
      // recorded separately because they clear separately.
      eligible: Boolean(gate.allow) && !limited,
      blocked: blockedWhy(state, gate, limited),
    };
  });
}

function blockedWhy(state, gate, limited) {
  if (limited) return BLOCKED.RATE_LIMITED;
  if (!gate.allow) {
    if (gate.status === STATUS.DISABLED) return BLOCKED.DISABLED;
    if (gate.status === STATUS.MAINTENANCE) return BLOCKED.MAINTENANCE;
    return BLOCKED.UNAVAILABLE;
  }
  return '';
}

/**
 * The best other route to the SAME model, or an honest account of why not.
 *
 * ------------------------------------------------------------------------
 * "EXHAUSTED" IS A REAL ANSWER AND IT IS NOT THE SAME AS "NONE".
 *
 *   none        this model has one configured route. There was never an
 *               alternative, and a provider failover is not the fix here.
 *   exhausted   it has three, and all three are rate limited. The model is
 *               genuinely unreachable FOR NOW, and the honest thing is to say
 *               when the earliest one clears — not to quietly pick a different
 *               model, which is a decision nobody made.
 * ------------------------------------------------------------------------
 */
function pick(app, { model = null, exclude = [], now = Date.now() } = {}) {
  const routes = routesFor(app, model, { now });
  const skip = new Set([...exclude].filter(Boolean));
  const others = routes.filter((r) => !r.current && !skip.has(r.connectionId));

  if (!routes.length) {
    return { ok: false, route: null, routes, exhausted: false, why: 'no route to that model is configured' };
  }
  if (!others.length) {
    return {
      ok: false, route: null, routes, exhausted: false,
      why: routes.length === 1
        ? `${routes[0].model} is served by one connection only (${routes[0].connectionId})`
        : 'every other route to this model has already been tried in this attempt',
    };
  }
  const usable = others.filter((r) => r.eligible);
  if (!usable.length) {
    const limited = others.filter((r) => r.rateLimited);
    // ALL RATE LIMITED is the case the brief calls out by name, and it gets its
    // own flag rather than being folded into "nothing available" — the fix is
    // to wait, and waiting needs a number.
    const exhausted = limited.length === others.length;
    const soonest = limited.map((r) => r.resumeAt).filter((t) => t > 0).sort((a, b) => a - b)[0] || 0;
    return {
      ok: false,
      route: null,
      routes,
      exhausted,
      resumeAt: soonest,
      why: exhausted
        ? `all ${routes.length} providers for ${routes[0].model} are rate limited`
        : `no other provider for ${routes[0].model} can be reached (${others.map((r) => `${r.connectionId}: ${r.blocked}`).join(', ')})`,
    };
  }
  // PREFER A ROUTE THAT HAS ACTUALLY WORKED. An untried connection might be
  // misconfigured; one that answered recently is known to carry this model.
  const rank = (r) => (r.status === STATUS.AVAILABLE ? 0 : r.status === STATUS.UNKNOWN ? 1 : 2);
  usable.sort((a, b) => rank(a) - rank(b));
  return { ok: true, route: usable[0], routes, exhausted: false, why: '' };
}

/**
 * WHAT WOULD CHANGE if this session moved to (model, connection)?
 *
 * `/steer` asks this before doing anything, because the answer decides what
 * the user is told: moving to the same model on another provider is a
 * FAILOVER and preserves the request, and everything else is a change of what
 * is answering.
 */
function classify(app, { model = null, connection = null } = {}) {
  const cfg = (app && app.cfg) || {};
  const nextModel = model == null || model === '' ? cfg.model : model;
  const nextConn = connection == null || connection === '' ? cfg.connection : connection;
  const sameModel = String(nextModel || '') === String(cfg.model || '');
  const sameConn = String(nextConn || '') === String(cfg.connection || '');

  if (sameModel && sameConn) return { kind: ROUTE.UNCHANGED, model: nextModel, connection: nextConn, sameModel, sameConn };
  if (sameModel) return { kind: ROUTE.PROVIDER_FAILOVER, model: nextModel, connection: nextConn, sameModel, sameConn };
  if (sameConn) return { kind: ROUTE.MODEL_CHANGE, model: nextModel, connection: nextConn, sameModel, sameConn };
  return { kind: ROUTE.MODEL_AND_PROVIDER, model: nextModel, connection: nextConn, sameModel, sameConn };
}

/**
 * Point the session at a route.
 *
 * The ONLY writer of `cfg.model` / `cfg.connection` in this file, and it says
 * what it changed so a caller can report a failover as a failover. It does not
 * persist: a failover is a decision about THIS session, and writing it to the
 * config would silently make a temporary detour permanent.
 */
function apply(app, route) {
  if (!app || !app.cfg || !route || !route.connectionId) return { changed: false };
  const before = { model: app.cfg.model, connection: app.cfg.connection };
  const verdict = classify(app, { model: route.model, connection: route.connectionId });
  app.cfg.model = route.model || app.cfg.model;
  app.cfg.connection = route.connectionId;
  return { changed: verdict.kind !== ROUTE.UNCHANGED, kind: verdict.kind, before, after: { model: app.cfg.model, connection: app.cfg.connection } };
}

/**
 * Resolve what a person typed into a route, without guessing.
 *
 * A word is a CONNECTION if a configured connection answers to it, and a MODEL
 * if the catalog does. Nothing that matches neither is turned into a route —
 * see steer's use of this: an unrecognised word is an instruction for the
 * model, not a mangled provider name, and inventing a route from it would
 * silently send the task somewhere nobody asked for.
 */
function targetOf(app, text) {
  const q = String(text || '').trim();
  if (!q) return null;
  let catalog;
  try { catalog = catalogOf(app); } catch { return null; }
  const key = q.toLowerCase();

  // CONNECTION FIRST. A connection id is a name the user chose, and it is the
  // more specific of the two — a router named `openrouter` should not be read
  // as a fuzzy model match against something with "open" in its id.
  const model = catalog.byId.get(app && app.cfg ? app.cfg.model : '') || null;
  const conns = new Map();
  for (const m of catalog.models) for (const c of m.connections) conns.set(c.connectionId.toLowerCase(), c);
  if (conns.has(key)) {
    const c = conns.get(key);
    // The model stays exactly what it was: naming a provider is a failover.
    const stillServed = model && model.connections.some((x) => x.connectionId === c.connectionId);
    return {
      kind: 'connection',
      connectionId: c.connectionId,
      model: stillServed ? model.id : null,
      servesCurrentModel: Boolean(stillServed),
    };
  }
  const m = catalogMod.find(catalog, q);
  if (m) return { kind: 'model', model: m.id, connectionId: null };
  return null;
}

/** The routes, as rows a person reads. Current first, then usable, then not. */
function describe(routes, { now = Date.now() } = {}) {
  if (!routes || !routes.length) return '  no configured route to that model';
  const rl = require('./ratelimit');
  const rows = [];
  for (const r of routes) {
    const mark = r.current ? '*' : ' ';
    const state = r.rateLimited
      ? `RATE LIMITED${r.resumeAt > now ? ` · clears in ${rl.human(r.resumeAt - now)}` : ''}`
      : r.eligible ? 'available' : (r.blocked || String(r.status).toLowerCase());
    rows.push(`  ${mark} ${r.connectionId.padEnd(22)} ${state}`);
  }
  return rows.join('\n');
}

/** Words that make `/steer` a routing instruction rather than a message. */
const ROUTE_VERB = /^(?:to|via|provider|connection|route|model)\s+(.+)$/i;
/** Words that ask what the routes ARE, rather than changing them. */
const ROUTE_QUERY = /^(?:routes?|providers?|where|status)$/i;
/** Verbs that COMMIT to being about routing, so an unknown target is an error. */
const EXPLICIT = new Set(['provider', 'connection', 'route', 'model']);

/**
 * `/steer` AS A ROUTING INSTRUCTION — or not one at all.
 *
 * ------------------------------------------------------------------------
 * THE RULE THAT KEEPS `/steer` FROM BECOMING TWO COMMANDS.
 *
 * `/steer stop editing files and read the logs` must keep working exactly as it
 * did; it is the command's whole reason for existing. So a routing steer has to
 * be recognisable without ever capturing a sentence meant for the model, and
 * the test is the same one commands.js uses to decide what a slash command is:
 * the target must RESOLVE against something real. `/steer to omniroute` is a
 * route because a connection called omniroute exists; `/steer to the logs
 * first` is an instruction because nothing called "the logs first" does.
 *
 * `provider`, `connection`, `route` and `model` COMMIT. Having typed one of
 * those, an unresolvable name is a mistake worth reporting rather than a
 * sentence to forward to the model — nobody steers a task with the words
 * "provider foo".
 * ------------------------------------------------------------------------
 *
 * Returns `{ handled }` and, when handled, everything the caller needs to say
 * what happened. It renders nothing: commands.js owns the screen.
 */
function steer(app, rest) {
  const t = String(rest || '').trim();
  if (!t) return { handled: false };

  const cfg = (app && app.cfg) || {};
  if (ROUTE_QUERY.test(t)) {
    const routes = routesFor(app, cfg.model);
    return {
      handled: true,
      kind: 'ROUTES',
      ok: true,
      message: routes.length
        ? `${cfg.model} is served by ${routes.length} connection(s):`
        : `no configured route to ${cfg.model || 'the current model'}`,
      detail: describe(routes),
    };
  }

  const m = ROUTE_VERB.exec(t);
  if (!m) return { handled: false };
  const verb = t.split(/\s+/)[0].toLowerCase();
  const target = targetOf(app, m[1]);

  if (!target) {
    if (!EXPLICIT.has(verb)) return { handled: false };   // it was a sentence
    const routes = routesFor(app, cfg.model);
    return {
      handled: true,
      kind: 'UNKNOWN',
      ok: false,
      message: `no model or connection called "${m[1].trim()}"`,
      detail: routes.length ? describe(routes) : '',
    };
  }

  // ---- A CONNECTION NAMED: THE MODEL DOES NOT MOVE ----------------------
  if (target.kind === 'connection') {
    if (!target.servesCurrentModel) {
      // REFUSED RATHER THAN SILENTLY CHANGING THE MODEL. Pointing the session at
      // a connection that does not carry the current model is a model change
      // wearing a provider's name, which is the confusion this file exists for.
      const routes = routesFor(app, cfg.model);
      return {
        handled: true,
        kind: 'UNKNOWN',
        ok: false,
        message: `${target.connectionId} does not serve ${cfg.model} — steering there would change the model, not the provider`,
        detail: describe(routes),
      };
    }
    const route = routesFor(app, cfg.model).find((r) => r.connectionId === target.connectionId);
    const verdict = classify(app, { connection: target.connectionId });
    if (verdict.kind === ROUTE.UNCHANGED) {
      return { handled: true, kind: ROUTE.UNCHANGED, ok: true, message: `already on ${target.connectionId}`, detail: '' };
    }
    const moved = apply(app, { model: cfg.model, connectionId: target.connectionId });
    return {
      handled: true,
      kind: ROUTE.PROVIDER_FAILOVER,
      ok: true,
      model: cfg.model,
      connectionId: target.connectionId,
      // NAMED AS A FAILOVER, deliberately. The user needs to know their model
      // did NOT change — that is the entire promise of this operation.
      message: `PROVIDER FAILOVER — ${moved.after.model} stays the model; requests now go via ${target.connectionId}`,
      detail: route && !route.eligible
        ? `  note: ${target.connectionId} is currently ${route.blocked || 'not reachable'} — the next request may be refused`
        : '',
      warning: Boolean(route && !route.eligible),
    };
  }

  // ---- A MODEL NAMED: this changes what answers -------------------------
  const verdict = classify(app, { model: target.model });
  if (verdict.kind === ROUTE.UNCHANGED) {
    return { handled: true, kind: ROUTE.UNCHANGED, ok: true, message: `already on ${target.model}`, detail: '' };
  }
  const routes = routesFor(app, target.model);
  const usable = routes.find((r) => r.eligible) || routes[0] || null;
  if (!usable) {
    return { handled: true, kind: 'UNKNOWN', ok: false, message: `no configured connection serves ${target.model}`, detail: '' };
  }
  const before = cfg.connection;
  apply(app, { model: target.model, connectionId: usable.connectionId });
  const kind = usable.connectionId === before ? ROUTE.MODEL_CHANGE : ROUTE.MODEL_AND_PROVIDER;
  return {
    handled: true,
    kind,
    ok: true,
    model: target.model,
    connectionId: usable.connectionId,
    message: `${kind} — now ${target.model} via ${usable.connectionId}`,
    detail: describe(routes),
  };
}

module.exports = {
  ROUTE, BLOCKED, routesFor, pick, classify, apply, targetOf, describe, catalogOf, steer,
  ROUTE_VERB, ROUTE_QUERY, EXPLICIT,
};
