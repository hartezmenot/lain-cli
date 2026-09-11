'use strict';

/**
 * WHERE A CREDENTIAL CAN BE SENT — the endpoints LAIN actually knows.
 *
 * ------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, and it is not "a provider list would be nice".
 *
 * `/api <credential>` has to ask WHICH PROVIDER the credential belongs to, and
 * then it has to send it somewhere. Two facts were already written down twice —
 * `connections.js` had `envRoutes` and `provider.js` had a fallback with the
 * same two base URLs — and neither list was reachable from a command. So the
 * one question `/api` needs answering had no owner.
 *
 * This is that owner. It is NOT a second provider architecture: connections.js
 * still models routes and readiness, provider.js still resolves and calls, and
 * both now read their endpoints from here instead of carrying a private copy.
 *
 * ------------------------------------------------------------------------
 * NO ENDPOINT IS EVER GUESSED. THIS IS A SECURITY BOUNDARY.
 *
 * Every `baseUrl` here is a host a credential will be POSTed to. A guessed base
 * URL is a guessed place to send somebody's API key, and being wrong about it
 * is not a cosmetic bug — it is handing a secret to whoever owns the name.
 *
 * ------------------------------------------------------------------------
 * BUT "I DO NOT KNOW IT" IS NOT A REASON TO HIDE A PROVIDER, and the first
 * version of this file made exactly that mistake.
 *
 * It listed four endpoints and silently dropped every other provider in the
 * ecosystem, on the grounds that this build could not name their URLs. That was
 * wrong in method rather than in caution: the endpoints were ON THIS MACHINE,
 * in the user's own working V1 configuration, and the file was written without
 * looking. `~/.lain/config.json` carries twenty configured providers, several
 * with their base URLs written out — which is where the OpenCode Zen, Z.AI,
 * Kimi and Cline rows below come from. They are corroborated, not invented.
 *
 * So a provider is in one of THREE states, and all three are visible:
 *
 *   KNOWN                the endpoint is established. Pick it and go.
 *   NEEDS ENDPOINT       LAIN knows the provider exists and does NOT know where
 *                        it lives. It is still OFFERED, labelled as needing an
 *                        endpoint, and picking it asks for one. Hiding it was
 *                        the defect; guessing for it would be a worse one.
 *   ALREADY CONFIGURED   anything in `cfg.connections` is offered by name, with
 *                        the base URL the USER wrote.
 *
 * A picker that admits what it does not know beats one that guesses AND beats
 * one that pretends the provider does not exist.
 *
 * ------------------------------------------------------------------------
 * PROTOCOL, NOT VENDOR. `protocol` is the wire shape provider.js speaks —
 * `anthropic` for the Messages API, `chat` for everything OpenAI-compatible,
 * which is what every router in practice serves. It is the only thing about a
 * provider that changes how a request is built.
 */

/**
 * The endpoints LAIN knows, in the order a picker should offer them.
 *
 * `envKey` is the environment variable that configures the same route with no
 * config file at all — connections.js reads these to build its env routes, so
 * that list and this one cannot drift apart.
 */
const KNOWN = Object.freeze([
  Object.freeze({
    id: 'openai',
    label: 'OpenAI / Codex',
    protocol: 'chat',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
  }),
  Object.freeze({
    id: 'anthropic',
    label: 'Claude / Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
  }),
  Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
  }),
  Object.freeze({
    id: 'ollama',
    label: 'Ollama Cloud',
    protocol: 'chat',
    baseUrl: 'https://ollama.com/v1',
    envKey: 'OLLAMA_API_KEY',
  }),
  // ---- SUPPLIED BY THE OPERATOR ------------------------------------------
  //
  // Not guessed and not recalled: api.b.ai/v1 is the endpoint this build is
  // actually served through, given to /api's table the way the V1 rows below
  // were earned — by being a route this machine really uses. The `/v1` root
  // means the OpenAI chat shape, which is what the sender already speaks.
  Object.freeze({
    id: 'bai',
    label: 'b.ai',
    protocol: 'chat',
    baseUrl: 'https://api.b.ai/v1',
    envKey: 'BAI_API_KEY',
  }),
  // ---- CORROBORATED FROM THE USER'S OWN WORKING V1 CONFIGURATION ---------
  //
  // `~/.lain/config.json` carries these providers with these base URLs. They
  // are established routes this machine has actually used, which is a far
  // better source than anybody's recollection — and the reason the first
  // version of this file was wrong to leave them out.
  Object.freeze({
    id: 'opencode',
    label: 'OpenCode Zen',
    protocol: 'chat',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    envKey: 'OPENCODE_API_KEY',
  }),
  Object.freeze({
    id: 'zai',
    label: 'Z.AI',
    protocol: 'chat',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    envKey: 'ZAI_API_KEY',
  }),
  Object.freeze({
    id: 'kimi',
    label: 'Kimi',
    protocol: 'chat',
    baseUrl: 'https://api.kimi.com/coding/v1',
    envKey: 'KIMI_API_KEY',
  }),
  Object.freeze({
    id: 'cline',
    label: 'Cline',
    protocol: 'chat',
    baseUrl: 'https://api.cline.bot/api/v1',
    envKey: 'CLINE_API_KEY',
  }),
]);

/**
 * PROVIDERS LAIN KNOWS OF AND CANNOT PLACE.
 *
 * They exist, this build cannot name their endpoint, and BOTH of those facts
 * belong on screen. Omitting them made the picker look like the ecosystem was
 * four providers wide; giving them a plausible URL would point a credential at
 * a guess. So they are offered, labelled, and route into the same base-URL
 * question `Other…` uses — the user supplies the one thing LAIN is missing.
 *
 * A row moves OUT of this list by someone establishing its endpoint, not by
 * someone assuming one.
 */
const NEEDS_ENDPOINT = Object.freeze([
  Object.freeze({ id: 'tokenrouter', label: 'TokenRouter' }),
  Object.freeze({ id: 'agentrouter', label: 'AgentRouter' }),
  Object.freeze({ id: 'zenmux', label: 'ZenMux' }),
  Object.freeze({ id: 'nvidia', label: 'NVIDIA' }),
  Object.freeze({ id: 'gemini', label: 'Google Gemini' }),
  Object.freeze({ id: 'qwen', label: 'Qwen' }),
  Object.freeze({ id: 'deepseek', label: 'DeepSeek' }),
  Object.freeze({ id: 'modelscope', label: 'ModelScope' }),
  Object.freeze({ id: 'kiro', label: 'Kiro' }),
  Object.freeze({ id: 'commandcode', label: 'CommandCode' }),
  Object.freeze({ id: 'zed', label: 'Zed' }),
  Object.freeze({ id: 'omniroute', label: 'OmniRoute' }),
]);

/**
 * WHAT THE USER'S OWN V1 CONFIGURATION SAYS, read at run time.
 *
 * ------------------------------------------------------------------------
 * THE AUDIT THIS CLOSES. The lists above are STATIC, and a static list is a
 * snapshot of what somebody knew on the day they wrote it. `~/.lain/config.json`
 * — V1's configuration, which is still on this machine — is the authoritative
 * record of the routes this user actually has, endpoints included, and several
 * of those endpoints are private: a local gateway on a port, a proxy behind a
 * name nobody else would ever guess. No table written here can contain those,
 * and offering the provider without its endpoint would make the user retype a
 * URL they already told LAIN once.
 *
 * So the file is read, and what it contributes is exactly two facts per entry:
 * the provider's NAME and, when it has one, its BASE URL.
 *
 * ------------------------------------------------------------------------
 * THE CREDENTIALS IN THAT FILE ARE NEVER READ, and that is not an oversight to
 * be tidied up later. V1's config holds live API keys in plain text. Copying
 * one into V2 silently would mean a key moved between two stores because a
 * picker was being helpful, with nobody deciding it. `/api` exists to ask.
 * Only `baseUrl` and `protocol` are taken; the object is not otherwise touched.
 *
 * READ ONCE PER PROCESS. `choices()` is called on every keystroke of the
 * picker's filter, and a file read per keystroke is a file read per keystroke.
 * A missing or unreadable file is the ordinary state on a machine that never
 * ran V1, and it contributes nothing rather than failing.
 */
const V1_CONFIG = 'config.json';
/**
 * Cached BY PATH, not by "have I run yet". `LAIN_V1_CONFIG` is how a test
 * points this at a fixture, and a cache that ignores the path would hand the
 * second caller the first caller's answer — which is a test that passes because
 * of the test before it.
 */
let v1cache = null;
let v1cacheFor = null;
function v1File() {
  const os = require('os');
  const path = require('path');
  return process.env.LAIN_V1_CONFIG || path.join(os.homedir(), '.lain', V1_CONFIG);
}
function v1Routes() {
  const file = v1File();
  if (v1cache && v1cacheFor === file) return v1cache;
  v1cache = [];
  v1cacheFor = file;
  try {
    const fs = require('fs');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const declared = (raw && raw.providers && typeof raw.providers === 'object') ? raw.providers : {};
    for (const [id, p] of Object.entries(declared)) {
      if (!p || typeof p !== 'object') continue;
      // NAME AND ENDPOINT ONLY. See above: the key stays where the user put it.
      v1cache.push({
        id: String(id),
        label: String(id),
        protocol: p.protocol === 'anthropic' ? 'anthropic' : 'chat',
        baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
      });
    }
  } catch { /* no V1 on this machine is the ordinary state, and contributes nothing */ }
  return v1cache;
}

/** The known provider with this id, or null. */
function byId(id) {
  const want = String(id || '').toLowerCase();
  return KNOWN.find((p) => p.id === want) || null;
}

/** The env-declared native routes, for connections.js. One list, one source. */
function envRoutes() {
  return KNOWN.map((p) => ({
    id: `env:${p.id}`,
    provider: p.id,
    envKey: p.envKey,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
  }));
}

/**
 * EVERYTHING A CREDENTIAL COULD BELONG TO, for the `/api` picker.
 *
 * The known endpoints, then whatever the user has already configured that is
 * not one of them — a private router, a proxy, a self-hosted gateway. Their
 * entry carries THEIR base URL, so choosing it re-keys a route that already
 * works rather than pointing it somewhere new.
 *
 * `known: false` marks the ones LAIN did not supply, so a caller can say where
 * the endpoint came from rather than implying it vouched for it.
 *
 * @param {object} cfg  the live config, for its `connections`
 */
function choices(cfg = {}) {
  // ---- A BRIDGE-HELD PROVIDER IS NEVER OFFERED, FROM ANY LIST ------------
  //
  // A bridge authenticates upstream itself, so LAIN has no use for a key and
  // offering the row invites somebody to store a secret for nothing.
  //
  // THE EXCLUSION USED TO LIVE IN THE `cfg.connections` LOOP ALONE, which
  // covered exactly the case where the provider's name appeared nowhere else.
  // A provider that is BOTH built-in and run through a bridge here — OpenRouter
  // behind a gateway, say — was still offered from `KNOWN`, with the built-in
  // endpoint, one row above the bridge that actually serves it. Found when
  // `omniroute` moved into the list of names LAIN knows of: the same name was
  // then a static row and a bridge connection at once, and the static row won.
  //
  // Gathered FIRST, so every list below is filtered by the same fact.
  const declaredAll = (cfg && cfg.connections && typeof cfg.connections === 'object') ? cfg.connections : {};
  const bridged = new Set();
  for (const [id, c] of Object.entries(declaredAll)) {
    if (c && typeof c === 'object' && c.via === 'bridge') bridged.add(String(c.provider || id));
  }
  const out = KNOWN.filter((p) => !bridged.has(p.id)).map((p) => ({ ...p, known: true, source: 'built-in' }));
  const seen = new Set([...out.map((p) => p.id), ...bridged]);
  // OFFERED, AND HONEST ABOUT WHAT IS MISSING. `baseUrl` is empty, which is what
  // makes the caller ask for one rather than store a credential against nothing.
  // THE USER'S OWN RECORD OUTRANKS "I DO NOT KNOW". A name in this list that V1
  // has an endpoint for is not a provider LAIN cannot place — it is one LAIN
  // was about to ask about needlessly. `OmniRoute` is the case that made this
  // visible: a local gateway on a port, written down a year ago, which no table
  // in this file could ever carry and which the user should not have to retype.
  const v1 = new Map(v1Routes().filter((r) => r.baseUrl).map((r) => [r.id, r]));
  for (const p of NEEDS_ENDPOINT) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const known = v1.get(p.id);
    out.push({
      ...p,
      label: known ? `${p.label}   (from your V1 configuration)` : p.label,
      protocol: known ? known.protocol : 'chat',
      baseUrl: known ? known.baseUrl : '',
      envKey: null,
      known: false,
      needsEndpoint: !known,
      source: known ? 'your V1 configuration' : 'endpoint not established',
    });
  }
  // ---- AND WHAT V1 ALREADY KNEW, on a machine that has it -----------------
  //
  // After the built-in rows so a provider LAIN can place is offered with the
  // endpoint LAIN vouches for, and before the V2 connections so a route the
  // user has already set up in V2 wins over the older record of it.
  for (const p of v1Routes()) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({
      ...p,
      label: p.baseUrl ? `${p.label}   (from your V1 configuration)` : p.label,
      envKey: null,
      known: false,
      needsEndpoint: !p.baseUrl,
      source: p.baseUrl ? 'your V1 configuration' : 'endpoint not established',
    });
  }
  for (const [id, c] of Object.entries(declaredAll)) {
    if (!c || typeof c !== 'object') continue;
    // A BRIDGE HOLDS ITS OWN CREDENTIAL — already excluded above, for every
    // list rather than only for this one. Kept here so a reader of this loop
    // does not have to go looking for the reason its rows are missing.
    if (c.via === 'bridge') continue;
    const name = String(c.provider || id);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      id: name,
      label: `${name}   (configured)`,
      protocol: c.protocol || 'chat',
      baseUrl: c.baseUrl || '',
      envKey: c.envKey || null,
      known: false,
      source: 'your config',
      connectionId: id,
    });
  }
  return out;
}

/**
 * The connection id a credential for this provider should be stored under.
 *
 * `lain:` says WHO HOLDS THE KEY, which is the distinction connections.js is
 * built around: `bridge:` routes authenticate upstream themselves and LAIN
 * never sees their tokens.
 */
const connectionIdFor = (providerId) => `lain:${String(providerId)}`;

module.exports = { KNOWN, NEEDS_ENDPOINT, byId, envRoutes, v1Routes, choices, connectionIdFor };
