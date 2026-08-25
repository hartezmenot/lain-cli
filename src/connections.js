'use strict';

/**
 * CONNECTIONS — a provider is not a credential.
 *
 * V1 modelled auth as "provider → one credential", which is why Claude had
 * exactly one answer ("no OAuth, use an API key") on a machine where a perfectly
 * good authenticated Claude session already existed inside a local bridge.
 *
 * A model can be reachable by several routes at once, each with its own auth
 * method and its own readiness:
 *
 *   anthropic
 *     ├─ connection lain:anthropic     native · api_key   (LAIN holds the key)
 *     └─ connection bridge:omniroute   bridge · none      (the BRIDGE holds it)
 *
 * LAIN never needs the bridge's tokens. The bridge authenticates upstream
 * itself, which is exactly what makes using it legitimate rather than a
 * credential grab. Nothing here reads another program's credential store.
 *
 * READINESS is deliberately NOT "a credential exists":
 *
 *   NONE              no credential and no keyless route
 *   CREDENTIAL_FOUND  something is configured but unproven or expired
 *   AUTHENTICATED     credential present and not expired
 *   REQUEST_READY     A REAL REQUEST THROUGH THIS ROUTE SUCCEEDED
 *
 * Only evidence of a successful request yields REQUEST_READY. A token on disk
 * never does.
 */

const fs = require('fs');
// A resolved credential is registered the moment it is read, so every display
// surface is covered from the first listing onwards. See src/redact.js.
const redact = require('./redact');
const path = require('path');

const READINESS = Object.freeze({
  NONE: 'NONE',
  CREDENTIAL_FOUND: 'CREDENTIAL_FOUND',
  AUTHENTICATED: 'AUTHENTICATED',
  REQUEST_READY: 'REQUEST_READY',
});

const VIA = Object.freeze({ NATIVE: 'native', BRIDGE: 'bridge' });
const AUTH = Object.freeze({ API_KEY: 'api_key', OAUTH: 'oauth', NONE: 'none' });

const RANK = { REQUEST_READY: 0, AUTHENTICATED: 1, CREDENTIAL_FOUND: 2, NONE: 3 };

function readinessFor({ credentialPresent = false, expired = false, requestSucceeded = false, authFailed = false }) {
  if (requestSucceeded) return READINESS.REQUEST_READY;
  if (authFailed) return READINESS.CREDENTIAL_FOUND;
  if (!credentialPresent) return READINESS.NONE;
  if (expired) return READINESS.CREDENTIAL_FOUND;
  return READINESS.AUTHENTICATED;
}

// ----------------------------------------------------------- discovery ------
//
// WHAT A CONNECTION SERVES IS DISCOVERED, NOT TRANSCRIBED.
//
// Until this existed, a connection's `models` could only come from config. That
// is workable for a two-model API key and absurd for a router: the user's own
// bridge advertises thousands of ids, and with none of them written into
// config.json by hand, `/models` printed "No models", no model could be
// selected, `provider.resolve` fell through to the env-var branch, and LAIN
// could not make a single request against a live, reachable, already-
// authenticated route. Measured, not theorised — that is what the binary did.
//
// THE RULES THIS OBEYS
//
//   - Discovery is a CATALOG request (`GET /models`), never a model round-trip.
//     No tokens are spent and no completion is generated.
//   - It is EXPLICIT. There is no timer, no background poll and no refresh on a
//     keystroke. It runs when someone needs a model list and the cache cannot
//     answer, and it says so on screen while it happens.
//   - The answer is CACHED ON DISK per connection, so relaunching costs nothing
//     and `fromConfig` stays synchronous and cheap.
//   - Declared models WIN. A connection that lists its models in config is
//     stating them deliberately; discovery never overrules that.
//   - The provider's own metadata (`root`, `parent`, `owned_by`) is preserved
//     verbatim, because catalog.js uses it as declared equivalence. Discovery
//     that flattened records to bare id strings would silently destroy model
//     identity and re-create the duplicate rows catalog.js exists to prevent.

/** A day. A router's catalog moves, but not between two launches. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Bounded so a pathological endpoint cannot exhaust memory or the config dir. */
const MAX_DISCOVERED = 20_000;
const DISCOVER_TIMEOUT_MS = 15_000;

function cacheDir() {
  return path.join(require('./config').configDir(), 'catalog');
}

/** Connection ids are user-chosen; they are not automatically safe filenames. */
function cacheFile(id) {
  return path.join(cacheDir(), String(id).replace(/[^a-zA-Z0-9._-]/g, '_') + '.json');
}

/**
 * Memoised cache reads.
 *
 * `fromConfig` is called from render paths, so an uncached read would mean
 * parsing a multi-megabyte JSON file per frame. Keyed on mtime+size, so a
 * refresh written by this process — or by another one — is picked up on the
 * next call without any invalidation protocol.
 */
const _memo = new Map(); // file -> { mtimeMs, size, value }

function readCache(id) {
  const file = cacheFile(id);
  let st;
  try { st = fs.statSync(file); } catch { _memo.delete(file); return null; }
  const hit = _memo.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let value = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.models)) value = { fetchedAt: Number(j.fetchedAt) || 0, models: j.models, source: j.source || null };
  } catch { value = null; }
  _memo.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

function writeCache(id, models, source) {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = cacheFile(id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), source: source || null, models }), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function cacheAgeMs(id) {
  const c = readCache(id);
  return c ? Date.now() - c.fetchedAt : Infinity;
}

/**
 * Normalise one `/v1/models` row into the record shape catalog.js consumes.
 *
 * Only fields with catalog meaning are kept. A router's rows also carry
 * context_length, pricing, capabilities and permission arrays — none of which
 * identify a model, and all of which would multiply the cache size by an order
 * of magnitude for nothing.
 */
function normalizeCatalogRow(row) {
  if (typeof row === 'string') return row.trim() ? { id: row.trim() } : null;
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id || row.name || '').trim();
  if (!id) return null;
  const out = { id };
  // `root: <same as id>` is a router filling the field in rather than declaring
  // an identity. Keeping it would make every id its own root and defeat the
  // grouping catalog.js does from routing namespaces.
  if (row.root && String(row.root) !== id) out.root = String(row.root);
  if (row.parent) out.parent = String(row.parent);
  if (row.owned_by) out.owned_by = String(row.owned_by);
  else if (row.ownedBy) out.owned_by = String(row.ownedBy);
  return out;
}

/**
 * Ask a connection what it serves. Returns a plain result — a route that cannot
 * be reached is an ANSWER ("this is why"), never a thrown error, because the
 * caller is usually a UI that must keep working with a dead provider.
 *
 * @param {object} conn  a connection as produced by fromConfig()
 * @returns {Promise<{ok:boolean, count:number, models?:Array, error?:string, url:string}>}
 */
async function discover(conn, { signal, timeoutMs = DISCOVER_TIMEOUT_MS } = {}) {
  const base = String((conn && conn.baseUrl) || '').replace(/\/+$/, '');
  if (!base) return { ok: false, count: 0, error: 'this connection declares no baseUrl', url: '' };
  // Anthropic's native protocol serves its catalog at the same path; the only
  // difference is how the request authenticates.
  const url = `${base}/models`;
  const headers = { accept: 'application/json' };
  if (conn.apiKey) {
    if (conn.protocol === 'anthropic') {
      headers['x-api-key'] = conn.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.authorization = `Bearer ${conn.apiKey}`;
    }
  }

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* no body */ }
      return { ok: false, count: 0, url, error: `${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}` };
    }
    const j = await res.json();
    const rows = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []));
    const models = [];
    const seen = new Set();
    for (const r of rows) {
      const m = normalizeCatalogRow(r);
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
      if (models.length >= MAX_DISCOVERED) break;
    }
    if (!models.length) return { ok: false, count: 0, url, error: 'the endpoint answered but advertised no models' };
    writeCache(conn.id, models, url);
    return { ok: true, count: models.length, models, url };
  } catch (e) {
    const why = ac.signal.aborted && !(signal && signal.aborted)
      ? `no answer within ${Math.round(timeoutMs / 1000)}s`
      : (e && e.message) || String(e);
    return { ok: false, count: 0, url, error: why };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Connections whose model list is empty and whose cache is missing or stale. */
function needsDiscovery(connections = []) {
  return connections.filter((c) => c && c.baseUrl && !c.declaredModels && cacheAgeMs(c.id) > CACHE_TTL_MS);
}

/**
 * Discover every route that needs it, in one pass.
 *
 * `done` is the caller's set of already-asked ids, mutated here — that is what
 * makes this at-most-once per connection per launch rather than a poll. Routes
 * that DECLARE their models are never contacted: the user already answered.
 *
 * @param {Array}  connections   as produced by fromConfig()
 * @param {object} opts  force, only, done (Set), onProgress(id), signal
 * @returns {Promise<Array<{id, ok, count, error?, url}>>}
 */
async function discoverAll(connections, { force = false, only = null, done = new Set(), onProgress = null, signal } = {}) {
  const wanted = only
    ? connections.filter((c) => c.id === only && c.baseUrl)
    : (force ? connections.filter((c) => c.baseUrl && !c.declaredModels) : needsDiscovery(connections));
  const todo = wanted.filter((c) => force || !done.has(c.id));

  const results = [];
  for (const c of todo) {
    done.add(c.id);
    if (onProgress) onProgress(c.id);
    // A catalog endpoint answering does not prove the CHAT endpoint works, so a
    // failure here is reported and deliberately never trips the request breaker.
    const r = await discover(c, { signal });
    results.push({ id: c.id, ...r });
  }
  return results;
}

/**
 * Read connections out of config. A connection is DECLARED, never guessed, and
 * `models` is whatever that route advertises — from config when the user stated
 * it, from the discovery cache otherwise.
 *
 * @param {object} cfg
 * @param {object} evidence  { [connectionId]: { requestSucceeded, authFailed } }
 */
function fromConfig(cfg = {}, evidence = {}) {
  const out = [];
  const declared = cfg.connections && typeof cfg.connections === 'object' ? cfg.connections : {};

  for (const [id, c] of Object.entries(declared)) {
    if (!c || typeof c !== 'object') continue;
    const ev = evidence[id] || {};
    const via = c.via === VIA.BRIDGE ? VIA.BRIDGE : VIA.NATIVE;
    const auth = c.auth || (via === VIA.BRIDGE ? AUTH.NONE : AUTH.API_KEY);
    // A bridge needs no LAIN credential at all — calling that "api_key" is a lie.
    const key = auth === AUTH.API_KEY
      ? (c.apiKey || (c.envKey ? process.env[c.envKey] : '') || '')
      : '';
    // ---- HELD BACK FROM EVERY DISPLAY SURFACE, FROM THE MOMENT IT IS READ --
    //
    // This is the one function that turns a config entry or an environment
    // variable into a live credential, so it is the one place that always knows
    // the exact bytes. Registering here means a key is masked on every screen
    // from the first listing onwards, whether it arrived from `/api`, from
    // config.json written by hand, or from the environment. See src/redact.js.
    if (key) redact.register(key);
    const credentialPresent = via === VIA.BRIDGE ? true : Boolean(key) || auth === AUTH.OAUTH;
    // A declared list is the user stating what this route serves; discovery
    // never overrules it. Absent one, the disk cache answers — which is what
    // makes a router with thousands of ids usable without transcribing any.
    const declared = Array.isArray(c.models) && c.models.length ? c.models : null;
    const cached = declared ? null : readCache(id);
    out.push({
      id,
      provider: c.provider || id,
      via,
      auth,
      protocol: c.protocol || 'chat',
      baseUrl: c.baseUrl || '',
      envKey: c.envKey || null,
      apiKey: key,
      models: declared || (cached ? cached.models : []),
      declaredModels: Boolean(declared),
      discoveredAt: cached ? cached.fetchedAt : null,
      readiness: readinessFor({
        credentialPresent,
        expired: Boolean(ev.expired),
        requestSucceeded: Boolean(ev.requestSucceeded),
        authFailed: Boolean(ev.authFailed),
      }),
    });
  }

  // Environment-declared native routes, so a bare API key still works with no
  // config file at all.
  // FROM THE ONE TABLE OF KNOWN ENDPOINTS — see providers.js. This list used to
  // be written out here and again in provider.js, so "where does an OpenAI key
  // go" had two answers that were only equal by coincidence, and neither was
  // reachable from the command that has to ASK the question (`/api`).
  const envRoutes = require('./providers').envRoutes();
  for (const r of envRoutes) {
    if (!process.env[r.envKey]) continue;
    if (out.some((c) => c.provider === r.provider && c.via === VIA.NATIVE)) continue;
    const ev = evidence[r.id] || {};
    // An env-declared key is exactly as secret as one written down. See above.
    redact.register(process.env[r.envKey]);
    const declared = (cfg.models && cfg.models[r.provider]) || null;
    const cached = declared && declared.length ? null : readCache(r.id);
    out.push({
      id: r.id, provider: r.provider, via: VIA.NATIVE, auth: AUTH.API_KEY,
      protocol: r.protocol, baseUrl: r.baseUrl, envKey: r.envKey,
      apiKey: process.env[r.envKey],
      models: (declared && declared.length ? declared : (cached ? cached.models : [])),
      declaredModels: Boolean(declared && declared.length),
      discoveredAt: cached ? cached.fetchedAt : null,
      readiness: readinessFor({ credentialPresent: true, requestSucceeded: Boolean(ev.requestSucceeded), authFailed: Boolean(ev.authFailed) }),
    });
  }

  return out.sort((a, b) => (RANK[a.readiness] ?? 9) - (RANK[b.readiness] ?? 9));
}

/**
 * Every authentication ROUTE for a provider, as `/oauth` shows it.
 *
 * The point of the shape: choosing "OAuth" can never silently land on the
 * API-key path. They are different rows with different actions, and a provider
 * with no legitimate OAuth says so plainly instead of falling through.
 *
 * LAIN does not implement any provider's OAuth here, does not scrape a login
 * page, and does not bypass a protected flow. A route exists because it is
 * configured, or it does not exist.
 */
function authRoutes(provider, connections = []) {
  const mine = connections.filter((c) => c.provider === provider);
  const rows = [];

  const oauth = mine.filter((c) => c.auth === AUTH.OAUTH);
  if (oauth.length) {
    for (const c of oauth) {
      rows.push({
        kind: 'oauth', label: `${provider} OAuth`, connectionId: c.id,
        status: c.readiness === READINESS.REQUEST_READY ? 'Connected (verified)'
          : c.readiness === READINESS.AUTHENTICATED ? 'Logged in' : 'Not logged in',
        action: 'Login', enabled: true,
        detail: 'A real OAuth route configured for this connection.',
      });
    }
  } else {
    rows.push({
      kind: 'oauth', label: `${provider} OAuth`, connectionId: null,
      status: 'OAUTH NOT AVAILABLE FOR THIS PROVIDER', action: null, enabled: false,
      detail: 'LAIN has no legitimate OAuth mechanism for this provider. It is not faked, and no protected flow is bypassed.',
    });
  }

  // A reachable bridge is a REAL, already-authenticated route and must be
  // offered before any "configure an API key" suggestion.
  for (const c of mine.filter((x) => x.via === VIA.BRIDGE)) {
    rows.push({
      kind: 'bridge', label: `${provider} via ${c.id}`, connectionId: c.id,
      status: c.readiness === READINESS.REQUEST_READY ? 'Connected (verified)' : 'Connected',
      action: 'Use', enabled: true,
      detail: `${c.models.length} model(s) — the bridge authenticates upstream itself; LAIN holds no credential for it.`,
    });
  }

  for (const c of mine.filter((x) => x.auth === AUTH.API_KEY)) {
    rows.push({
      kind: 'api_key', label: `${provider} API key`, connectionId: c.id,
      status: c.apiKey ? 'Configured' : 'Not configured',
      action: 'Configure', enabled: true,
      detail: c.envKey ? `Read from ${c.envKey}. Billed per token. This is NOT OAuth.` : 'Billed per token. This is NOT OAuth.',
    });
  }
  return rows;
}

/** Can this provider be used right now WITHOUT the user pasting an API key? */
function hasKeylessRoute(provider, connections = []) {
  return connections.some((c) => c.provider === provider
    && (c.via === VIA.BRIDGE || c.auth === AUTH.OAUTH)
    && (c.readiness === READINESS.AUTHENTICATED || c.readiness === READINESS.REQUEST_READY));
}

/**
 * WHAT A FINISHED TURN PROVED ABOUT ITS ROUTE.
 *
 * Readiness is earned, never assumed: `REQUEST_READY` means a request actually
 * came back, and an auth failure is the one kind of failure that says the
 * CREDENTIAL is wrong rather than that the server is unhappy. Both are facts
 * about a connection, so they are recorded here rather than in the REPL.
 *
 * Tool errors are excluded deliberately — a failed `grep` says nothing about
 * whether the provider answered.
 */
function noteTurn(evidence, id, record) {
  if (!id || !evidence || !record) return evidence;
  const ev = evidence[id] || (evidence[id] = {});
  if (record.providerFailure) {
    if (record.providerFailure.kind === 'AUTH') ev.authFailed = true;
    return evidence;
  }
  if (record.usage.requests > 0 && !record.errors.some((e) => e.kind !== 'TOOL')) {
    ev.requestSucceeded = true;
    ev.authFailed = false;
  }
  return evidence;
}

module.exports = {
  READINESS, VIA, AUTH, fromConfig, authRoutes, readinessFor, hasKeylessRoute, noteTurn,
  discover, discoverAll, needsDiscovery, readCache, writeCache, cacheFile, cacheAgeMs,
  normalizeCatalogRow, CACHE_TTL_MS, MAX_DISCOVERED,
};
