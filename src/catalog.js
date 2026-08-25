'use strict';

/**
 * MODEL · CONNECTION · EFFORT — three orthogonal things, modelled as three
 * things.
 *
 * V1 fused all three into one opaque registry key (`provider:model-effort`) and
 * ended up with 3,761 entries, 1,359 of them effort variants, 1.29 MB of config,
 * and the same model appearing four times. The correct architecture existed —
 * but only as a view built at render time, while the request path still used the
 * flat string.
 *
 * Here the structured form IS the runtime identity:
 *
 *   Model        claude-opus-5                      one entry, one identity
 *     Connection anthropic  · native · api_key      a route that can serve it
 *     Connection omniroute  · bridge · none         another route
 *     Connection ninerouter · bridge · none
 *   Effort       low | medium | high                orthogonal axis
 *
 * `resolve()` turns (model, connection, effort) into the exact upstream id at
 * SEND time. Nothing upstream of that ever holds a fused string.
 *
 * NOTHING IS HARDCODED TO ANY VENDOR. Models and connections come from config;
 * a bridge that advertises Gemini and Kimi produces Gemini and Kimi rows by the
 * same code path that produces Claude rows.
 */

const providerMod = require('./provider');

// -------------------------------------------------------------- effort ------

/**
 * The effort vocabulary. Longest-first matching is load-bearing: with a greedy
 * or short-first match, `gpt-5.5-extra-high` splits as base `gpt-5.5-extra` plus
 * effort `high`, inventing a base that does not exist and stranding the variant.
 *
 * `thinking` and `agentic` are REASONING MODES, not separate models — a bridge
 * that lists `claude-opus-5`, `claude-opus-5-agentic` and `claude-opus-5-thinking`
 * side by side is one model at three reasoning settings, the same shape as
 * `-low`/`-high`. Without this they had no effort word to split on at all and
 * became three unrelated top-level rows: "Claude Opus 5", "Claude Opus 5
 * Agentic", "Claude Opus 5 Thinking" — the V1 failure this file exists to
 * prevent, from a vocabulary gap rather than a fused key.
 */
const EFFORT_WORDS = [
  'extra-high', 'extra-low', 'minimal', 'xhigh', 'none', 'medium', 'high', 'low', 'max', 'thinking', 'agentic',
];
const EFFORT_ORDER = {
  none: 0, minimal: 1, low: 2, 'extra-low': 3, medium: 4, high: 5, xhigh: 6, 'extra-high': 7, max: 8,
  agentic: 9, thinking: 10,
};

/**
 * Suffixes that are MODEL IDENTITY, never effort.
 *
 * `-fast` is the subtle one: it is an orthogonal ROUTE axis, and `gpt-5.5-high`
 * and `gpt-5.5-high-fast` both exist. Treating it as effort would merge two
 * genuinely different routes; it stays attached to the base so the fast family
 * remains its own model. `thinking` is deliberately NOT here — see EFFORT_WORDS
 * above; this list is only for a suffix that can trail an ALREADY-stripped
 * effort word (`-high-fast`), and `thinking`/`agentic` are the effort word.
 */
const IDENTITY_SUFFIX = /-(fast|flash|pro|lite|mini|nano|preview|latest|instruct|turbo)$/i;

const EFFORT_RE = new RegExp(
  '^(.*?)-(' + EFFORT_WORDS.slice().sort((a, b) => b.length - a.length).join('|') + ')$', 'i'
);

/**
 * Split an upstream id into { base, effort } when it ends in an effort word.
 * Pure syntax — the caller decides whether it is really a variant, because a
 * lone `qwen-max` is a model name, not a max-effort variant of `qwen`.
 */
function splitEffort(id) {
  const s = String(id || '');
  let axis = '';
  let core = s;
  const ax = IDENTITY_SUFFIX.exec(core);
  if (ax) { axis = ax[0]; core = core.slice(0, -axis.length); }
  const m = EFFORT_RE.exec(core);
  if (!m) return null;
  return { base: m[1] + axis, effort: m[2].toLowerCase() };
}

/**
 * A readable name for a canonical model id.
 *
 * Real router ids are namespaced and may carry a variant suffix, e.g.
 * `openrouter/anthropic/claude-opus-5:batch`. Stripping to the last `:` or `/`
 * turned every one of those into "Batch" — verified against a live catalog of
 * 2,760 ids, where dozens of distinct models all rendered identically. Only the
 * ROUTING NAMESPACE is dropped; the variant is kept, parenthesised, because it
 * is part of what distinguishes the model.
 */
function displayName(base) {
  const raw = String(base || '');
  const segments = raw.split('/');
  const last = segments.pop();
  // Leading segments are a QUALIFIER (`no-think/gh/…`, `anthropic/…`). Dropping
  // them silently made genuinely different models share a name — measured: 13
  // rows all reading "Claude Opus 5". Keeping them parenthesised distinguishes
  // the models without burying the name.
  const qualifier = segments.join('/');
  const [name, variant] = last.split(':');
  const pretty = String(name || last)
    .replace(/[_]+/g, ' ')
    .replace(/-/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => {
      if (/\d/.test(w)) return w;
      if (w.length <= 3 && !/^(pro|max|air)$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
  const tags = [qualifier, variant].filter(Boolean).join(' · ');
  return tags ? `${pretty} (${tags})` : pretty;
}

// ------------------------------------------------------------- catalog ------

/**
 * Build the canonical catalog from configured connections.
 *
 * @param {Array} connections  [{ id, provider, via, auth, protocol, baseUrl,
 *                                apiKey|envKey, models: [upstreamId, ...] }]
 * @returns {{ models: Array, byId: Map }}
 *   model = { id, displayName, connections: [{ connectionId, provider, via, auth,
 *             efforts: [..], upstreamByEffort: {effort: id}, upstreamId }] }
 */
/**
 * Strip a ROUTING NAMESPACE from an upstream id.
 *
 * A real bridge namespaces the same model by upstream: a live catalog carried
 * `openrouter/anthropic/claude-opus-5` and `cline/anthropic/claude-opus-5`,
 * which are one model reachable two ways — exactly the thing routes exist to
 * express. Left un-stripped they became 20 separate rows all displaying
 * "Claude Opus 5", which is the duplicate-identity failure this file exists to
 * prevent, wearing a different hat.
 *
 * CONSERVATIVE: only the FIRST segment is dropped, and only when three or more
 * remain meaningful (namespace/vendor/model). `vendor/model` is left alone, so
 * `openrouter/x/foo` and `cline/y/foo` keep different vendors and never merge.
 * A false merge of two different models is worse than showing two rows.
 *
 * ONE EXCEPTION, at any segment count: a leading segment that IS this
 * connection's OWN id. A route prefixing its own model list with its own name
 * (`gh/claude-opus-5` from the connection literally named `gh`) is not a vendor
 * distinguishing itself from another vendor — it is a route namespacing itself,
 * and stripping it is exactly what already happens for free when the same
 * route's OTHER models arrive unprefixed. Left alone, that one route's own
 * prefixed spelling stood as a whole separate model next to the unprefixed
 * spelling every other route used for the same thing. Still provider metadata
 * first where it exists (`root`/`parent`, below) — this only covers a route
 * that prefixes without declaring so.
 */
function stripRoutingNamespace(id, ownConnectionId = null) {
  const parts = String(id || '').split('/');
  if (parts.length >= 2 && ownConnectionId && foldKey(parts[0]) === foldKey(ownConnectionId)) {
    // NO NAMESPACE TO REPORT: the stripped segment was the connection's own
    // id, not a distinguishable sub-route within it — reporting it as one
    // built the `connectionId` below as `gh:gh`, a route "distinguished from
    // itself".
    return { key: parts.slice(1).join('/'), namespace: null };
  }
  if (parts.length < 3) return { key: String(id || ''), namespace: null };
  return { key: parts.slice(1).join('/'), namespace: parts[0] };
}

/**
 * A connection's `models` entry may be a bare id or a catalog record.
 *
 * A record carries the provider's OWN equivalence metadata, which beats any
 * name heuristic: `root` is the base model identity, `parent` declares that this
 * id is an alias of another, and `owned_by` names the upstream that serves it.
 * Measured on a live bridge, `gh/claude-opus-5` and `github/claude-opus-5` both
 * report `root: claude-opus-5` and the second declares `parent: gh/claude-opus-5`
 * — the same model reachable two ways, stated by the provider rather than
 * inferred from the string.
 */
function normalizeEntry(m) {
  if (typeof m === 'string') return { id: m, root: null, parent: null, ownedBy: null };
  if (!m || typeof m !== 'object' || !m.id) return null;
  return {
    id: String(m.id),
    root: m.root ? String(m.root) : null,
    parent: m.parent ? String(m.parent) : null,
    ownedBy: m.owned_by ? String(m.owned_by) : (m.ownedBy ? String(m.ownedBy) : null),
  };
}

/**
 * The identity key for a model, and the route that reaches it.
 *
 * `root` is used EXACTLY, never normalized further. Two roots that merely look
 * similar (`claude-opus-5` vs `anthropic/claude-opus-5`) are left apart: the
 * provider distinguished them, and a false merge is worse than an extra row.
 */
/**
 * THE SAME MODEL, SPELLED DIFFERENTLY.
 *
 * Routers disagree about punctuation and case for identifiers that are
 * otherwise character-for-character the same model. Measured on the live
 * catalog: `GPT_5` and `gpt-5`, `claude_sonnet_4` and `claude-sonnet-4`,
 * `stepfun/Step-3.5-Flash` and `stepfun/step-3.5-flash` — six pairs that
 * rendered as two visually identical rows each, because displayName() folds
 * case and separators for reading but the IDENTITY did not.
 *
 * This folds ONLY case and separator spelling. It is not a similarity match: no
 * token is added, dropped or reordered, so `gpt-5` and `gpt-5-mini` stay two
 * models, and a genuinely different model that merely LOOKS alike is untouched.
 * Anything beyond respelling is left alone — a false merge hides a model, which
 * is worse than showing a duplicate.
 */
function foldKey(id) {
  // `\s` (whitespace), NOT a literal `s` — a dropped backslash here silently
  // deletes every lowercase `s` from every id ("claude-sonnet-5" folded to
  // "claude-onnet-5"), which happens to go unnoticed for legitimate merges
  // (both spellings lose their `s`es identically, so they still match each
  // other) and is exactly backwards for the case this file cares most about:
  // it can fold two DIFFERENT models to the same key, which is the false
  // merge the docstring above says is worse than a duplicate row.
  return String(id || '').toLowerCase().replace(/[-_.\s]+/g, '-');
}

/**
 * Which spelling to keep when two are the same model.
 *
 * The conventional one (lower case, hyphens) wins; then the one with more
 * routes, because it is the one more of the catalog agrees on; then
 * lexicographic, so the answer is the same on every run.
 */
function preferredId(a, b) {
  const conventional = (m) => (/^[a-z0-9/:.-]+$/.test(m.id) ? 0 : 1);
  if (conventional(a) !== conventional(b)) return conventional(a) < conventional(b) ? a : b;
  if (a.connections.length !== b.connections.length) return a.connections.length > b.connections.length ? a : b;
  return a.id <= b.id ? a : b;
}

function identityOf(entry, ownConnectionId = null) {
  if (entry.root) {
    return { key: entry.root, route: entry.ownedBy || stripRoutingNamespace(entry.id, ownConnectionId).namespace };
  }
  const { key, namespace } = stripRoutingNamespace(entry.id, ownConnectionId);
  return { key, route: entry.ownedBy || namespace };
}

function build(connections = []) {
  const models = new Map(); // baseId -> model

  for (const conn of connections) {
    if (!conn || !conn.id) continue;
    // ALIASES. A record whose `parent` names another id in the same catalog is
    // the provider telling us the two are the same route under two names
    // (`github/claude-opus-5` -> parent `gh/claude-opus-5`). Listing both makes
    // one route appear twice in the picker, so the alias is dropped and the
    // canonical id kept. This is declared equivalence, never inferred.
    const declaredIds = new Set();
    for (const raw of conn.models || []) {
      const e = normalizeEntry(raw);
      if (e) declaredIds.add(splitEffort(e.id) ? splitEffort(e.id).base : e.id);
    }

    // A base may be offered at several efforts by ONE connection.
    const byBase = new Map();
    for (const raw of conn.models || []) {
      const entry = normalizeEntry(raw);
      if (!entry) continue;
      if (entry.parent) {
        const parentBase = splitEffort(entry.parent) ? splitEffort(entry.parent).base : entry.parent;
        if (declaredIds.has(parentBase)) continue; // an alias of something we already have
      }
      const sp = splitEffort(entry.id);
      const base = sp ? sp.base : entry.id;
      if (!byBase.has(base)) byBase.set(base, { efforts: new Map(), plain: null, entry });
      const slot = byBase.get(base);
      if (sp) { if (!slot.efforts.has(sp.effort)) slot.efforts.set(sp.effort, entry.id); }
      else slot.plain = entry.id;
    }

    for (const [base, slot] of byBase) {
      // CONSERVATIVE: one effort sibling is not a variant family. `qwen-max`
      // alone stays the model `qwen-max`, not `qwen` at max effort. A false
      // merge of two different models is worse than showing two rows.
      const isFamily = slot.efforts.size >= 2;
      const realBase = isFamily ? base : (slot.plain || [...slot.efforts.values()][0] || base);

      // Identity comes from the provider's metadata when it supplied any, and
      // from the routing-namespace heuristic otherwise. Either way the ROUTE is
      // recorded on the connection below and the exact upstream id still travels
      // on the wire — collapsing changes what is DISPLAYED, never what is sent.
      const { key: modelId, route: namespace } = identityOf({ ...slot.entry, id: realBase }, conn.id);

      if (!models.has(modelId)) {
        models.set(modelId, { id: modelId, displayName: displayName(modelId), connections: [] });
      }
      const efforts = isFamily
        ? [...slot.efforts.keys()].sort((a, b) => (EFFORT_ORDER[a] ?? 99) - (EFFORT_ORDER[b] ?? 99))
        : [];
      const connectionId = namespace ? `${conn.id}:${namespace}` : conn.id;
      // ONE ROW PER ROUTE THE USER CAN ACTUALLY CHOOSE BETWEEN.
      //
      // A router can advertise the same model twice under upstream namespaces
      // that reduce to the same route — measured on a live catalog: 8 of 975
      // models arrived with two entries whose `connectionId` was identical and
      // whose only difference was an opaque upstream uuid. Selection persists
      // `connectionId`, so picking either row stored the same thing: two rows,
      // one outcome, and a route screen the user was forced through to choose
      // between two identical lines. The first is kept; the request still
      // carries its exact upstream id, so nothing about the wire changes.
      const already = models.get(modelId).connections.find((c) => c.connectionId === connectionId);
      if (already) {
        // Keep the richer entry: a route that exposes effort levels tells the
        // user more than one that does not.
        if (!already.efforts.length && efforts.length) {
          already.efforts = efforts;
          already.upstreamByEffort = isFamily ? Object.fromEntries(slot.efforts) : {};
          already.upstreamId = isFamily ? null : realBase;
        }
        continue;
      }
      models.get(modelId).connections.push({
        connectionId,
        // `connectionId` is what the user selects and what /models shows.
        // `baseConnectionId` is the actual configured connection the request
        // goes through — resolve() and availability key off THAT.
        baseConnectionId: conn.id,
        provider: conn.provider || conn.id,
        route: namespace,
        via: conn.via || 'native',
        auth: conn.auth || 'none',
        efforts,
        upstreamByEffort: isFamily ? Object.fromEntries(slot.efforts) : {},
        upstreamId: isFamily ? null : realBase,
      });
    }
  }

  // ONE ROW PER MODEL, whatever the routes chose to call it. Two entries whose
  // ids differ only in case or separators are one model offered twice; their
  // routes are merged under the conventional spelling.
  //
  // BOTH ids stay resolvable. A configuration that already persisted the other
  // spelling must keep working — silently failing to resolve a saved model is
  // how a working setup breaks on an upgrade.
  const byFold = new Map();
  for (const m of models.values()) {
    const k = foldKey(m.id);
    const prev = byFold.get(k);
    if (!prev) { byFold.set(k, m); continue; }
    const keep = preferredId(prev, m);
    const drop = keep === prev ? m : prev;
    for (const c of drop.connections) {
      if (!keep.connections.some((x) => x.connectionId === c.connectionId)) keep.connections.push(c);
    }
    keep.aliases = [...new Set([...(keep.aliases || []), ...(drop.aliases || []), drop.id])];
    byFold.set(k, keep);
  }

  const canonical = new Map();
  for (const m of byFold.values()) {
    canonical.set(m.id, m);
    for (const a of m.aliases || []) canonical.set(a, m);
  }
  const list = [...byFold.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { models: list, byId: canonical };
}

/**
 * (model, connection, effort) → the EXACT upstream id to put on the wire.
 * This is the only place a fused string is ever produced.
 */
function resolve(catalog, { model, connectionId = null, effort = null }) {
  const m = catalog.byId.get(model);
  if (!m) return { ok: false, error: `unknown model "${model}"` };
  const conn = connectionId ? m.connections.find((c) => c.connectionId === connectionId) : m.connections[0];
  if (!conn) return { ok: false, error: `model "${model}" is not served by connection "${connectionId}"` };

  if (!conn.efforts.length) {
    return { ok: true, model: m.id, connection: conn, effort: null, upstreamId: conn.upstreamId || m.id };
  }
  const want = String(effort || '').toLowerCase();
  const chosen = conn.upstreamByEffort[want]
    ? want
    : conn.efforts.includes('medium') ? 'medium' : conn.efforts[Math.floor(conn.efforts.length / 2)];
  return {
    ok: true, model: m.id, connection: conn, effort: chosen,
    upstreamId: conn.upstreamByEffort[chosen],
    effortFallback: want && chosen !== want ? `"${want}" not offered here; using "${chosen}"` : null,
  };
}

/**
 * The model to use when the user has not chosen one — or null when choosing
 * would be guessing.
 *
 * LAIN HAS NO OPINION ABOUT WHICH MODEL IS GOOD. It cannot rank a router's
 * 2,760 entries, and a ranking invented here would be exactly the model
 * equivalence this file refuses to infer everywhere else. An earlier attempt
 * took `models[0]` and selected an alphabetically-first synthetic video
 * detector as the coding model — a guess wearing the costume of a decision.
 *
 * So there are two legitimate sources and deliberately no third:
 *
 *   1. A connection DECLARES its default (`"default": "..."` in its config
 *      block). That is a human stating it. Vendor-neutral: the string is
 *      matched against that connection's own catalog, whatever it holds.
 *   2. The catalog holds exactly ONE model, so nothing is being decided.
 *
 * Otherwise: null, and the caller says so. A wall you can see beats a silent
 * wrong answer.
 *
 * @returns {{model, connection, source:'declared'|'only'}|{error:string}|null}
 */
function chooseDefault(catalog, cfg = {}) {
  if (!catalog || !catalog.models.length) return null;
  const declared = cfg.connections && typeof cfg.connections === 'object' ? cfg.connections : {};

  for (const [connId, c] of Object.entries(declared)) {
    const want = c && c.default;
    if (!want) continue;
    const m = find(catalog, String(want));
    if (!m) return { error: `${connId}: default model "${want}" is not in this route's catalog` };
    // Prefer the route that declared it, when that route actually serves it.
    const conn = m.connections.find((x) => x.baseConnectionId === connId) || m.connections[0];
    return { model: m, connection: conn, source: 'declared' };
  }

  if (catalog.models.length === 1) {
    return { model: catalog.models[0], connection: catalog.models[0].connections[0], source: 'only' };
  }
  return null;
}

/** Search by display name or by raw upstream id — both must find the model. */
function find(catalog, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  for (const m of catalog.models) if (m.id.toLowerCase() === q) return m;
  for (const m of catalog.models) if (m.displayName.toLowerCase() === q) return m;
  for (const m of catalog.models) {
    if (m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q)) return m;
    for (const c of m.connections) {
      if (Object.values(c.upstreamByEffort).some((u) => String(u).toLowerCase() === q)) return m;
      if (c.upstreamId && String(c.upstreamId).toLowerCase() === q) return m;
    }
  }
  return null;
}

const { search } = require('./modelsearch');

/**
 * WHAT CHANGED between two catalogs.
 *
 * The reason a refresh needs this: "1,247 models discovered" is not an answer.
 * You refreshed because you added something, so the question is whether the
 * thing you added is there — and whether the model you are currently using
 * survived, because a catalog that silently drops it leaves LAIN pointing at a
 * route that no longer exists.
 *
 * Compared by canonical id, so a provider reshuffling its own ordering or
 * re-spelling an alias does not read as churn.
 */
function diff(before, after, currentModel = null) {
  const ids = (cat) => new Set(((cat && cat.models) || []).map((m) => m.id));
  const was = ids(before);
  const now = ids(after);
  const added = [...now].filter((id) => !was.has(id));
  const removed = [...was].filter((id) => !now.has(id));
  const current = currentModel ? String(currentModel) : null;
  return {
    before: was.size,
    after: now.size,
    added,
    removed,
    changed: added.length > 0 || removed.length > 0,
    // `null` means "you had not chosen one", which is not the same as "the one
    // you chose is gone" and must not be reported as though it were.
    currentModel: current,
    currentSurvived: current ? now.has(current) || Boolean(find(after, current)) : null,
  };
}

/**
 * RE-READ WHAT THE ROUTES SERVE, without restarting.
 *
 * One implementation behind three names, because there is one registry and
 * adding a second would be the classic way to get two disagreeing lists. It is
 * a CATALOG request — the `/models` endpoint — never a completion: no tokens.
 *
 * It reports the DIFFERENCE, not a total. You refreshed because you added
 * something, so "1,247 models" does not answer your question; "3 new, 1 gone,
 * your model survived" does. A failure names the route and the reason, and a
 * route that declares its own models is said to be skipped rather than
 * silently contributing nothing.
 */
async function refreshAndReport(app, { only = null } = {}, { C } = {}) {
  const w = (s) => app.render.write(s);
  const before = app.catalog();
  const current = providerMod.resolve(app.cfg).model;

  w(C.dim('  Refreshing…\n'));
  let results;
  try {
    results = await app.ensureCatalog({ force: true, only, announce: false });
  } catch (e) {
    app.render.notice('error', `Refresh failed: ${(e && e.message) || e}`);
    return null;
  }

  if (!results.length) {
    w(C.dim(`  Nothing to refresh${only ? ` for "${only}"` : ''} — every route declares its own model list, so there is nothing to ask.\n`));
    return null;
  }

  let failures = 0;
  for (const r of results) {
    if (r.ok) w(C.green('  ✓ ') + r.id + C.dim(`  ${r.count} model(s) from ${r.url}\n`));
    else { failures += 1; w(C.yellow('  ✕ ') + r.id + C.dim(`  ${r.error}\n`)); }
  }

  const after = app.catalog();
  const d = diff(before, after, current);
  // WHICH ONES WERE NEW, remembered past the end of this sentence. The picker
  // marks them; selecting one, or the next refresh, retires the mark. See
  // newmodels.js for the rule.
  require('./newmodels').record(d.added, { firstCatalog: d.before === 0 });
  if (!d.changed) {
    w(C.dim(`  Already up to date — ${d.after} model(s), nothing added or removed.\n`));
  } else {
    w(C.green(`  ✓ ${d.after} model(s)`) + C.dim(`  (was ${d.before})\n`));
    if (d.added.length) w(C.green(`  ✓ ${d.added.length} new`) + C.dim(`: ${d.added.slice(0, 5).join(', ')}${d.added.length > 5 ? ' …' : ''}\n`));
    if (d.removed.length) w(C.yellow(`  ✕ ${d.removed.length} gone`) + C.dim(`: ${d.removed.slice(0, 5).join(', ')}${d.removed.length > 5 ? ' …' : ''}\n`));
  }
  // The one consequence that changes what happens next.
  if (d.currentSurvived === false) {
    app.render.notice('warn',
      `The model you were using (${d.currentModel}) is no longer served by any route. `
      + 'Pick another with /models — nothing has been chosen for you.');
  } else if (d.currentSurvived === true) {
    w(C.dim(`  Current model kept: ${d.currentModel}\n`));
  }
  if (failures) w(C.dim(`  ${failures} route(s) could not be reached; the rest were refreshed.\n`));
  if (app.ui && app.ui.enabled) app.ui.refresh();
  return d;
}


// THE `/models` COMMAND LIVES IN modelcommand.js — the thing that ASKS these
// questions, kept apart from the catalog that answers them.
//
// IT IS NOT RE-EXPORTED HERE, deliberately. Re-exporting it made catalog.js
// require modelcommand while modelcommand required catalog, and in that cycle
// the destructured `search` and `displayName` were `undefined` at load time —
// node says so out loud, and the command would have failed the first time
// anybody typed it. routecommands.js requires modelcommand directly instead.

module.exports = { build, foldKey, resolve, find, search, chooseDefault, diff, refreshAndReport, splitEffort, displayName, EFFORT_WORDS, EFFORT_ORDER, IDENTITY_SUFFIX };
