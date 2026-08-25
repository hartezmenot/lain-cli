'use strict';

/**
 * `/api <credential>` — from a pasted key to a usable model, without typing an id.
 *
 * ------------------------------------------------------------------------
 * WHAT WAS MISSING, and it was the whole of the flow.
 *
 * `/api` existed and did two things: `refresh` and `status`. There was no way to
 * GIVE LAIN a credential at all — a key had to be written into config.json by
 * hand, or exported as an environment variable, and the model then had to be
 * named by id because nothing had discovered what the route served.
 *
 * The steps were all present and none of them were joined up: connections.js
 * knows how to model a route and how to `discover` what it serves, catalog.js
 * knows how to fold that into the model list, and ui/panel.js knows how to ask
 * a question. This is the join.
 *
 *     /api sk-…
 *         ↓  which provider does this belong to?
 *     provider picker            ← providers.js, the ONE table of endpoints
 *         ↓  stored under lain:<provider>
 *     credential saved           ← config.js, the existing store
 *         ↓  GET /models
 *     discovery                  ← connections.discover, no tokens spent
 *         ↓
 *     model picker               ← the SAME picker /models opens
 *
 * ------------------------------------------------------------------------
 * NO SECOND PROVIDER ARCHITECTURE. Every step above is an existing owner being
 * called in order. What is new here is the ORDER and the questions, which is
 * exactly what was missing — and `refresh` and `status` still route to the same
 * places they always did.
 *
 * ------------------------------------------------------------------------
 * A CREDENTIAL IS NEVER ECHOED. It goes to the config store and nowhere else:
 * not into the transcript, not into the panel, not into an error message. What
 * is shown back is its SHAPE — `sk-…4f2a` — which is enough to recognise which
 * key you pasted and not enough to be one.
 */

const providers = require('./providers');
const connectionsMod = require('./connections');

/** The subcommands `/api` has always had. Anything else is a credential. */
const SUBCOMMANDS = new Set(['refresh', 'status', 'list', 'help']);

/**
 * The row that means "LAIN does not know this one — I will say where it goes".
 *
 * A NAMED CONSTANT, and it was briefly a raw NUL byte written into the source
 * by a patch script — invisible corruption of exactly the kind the control-byte
 * guard exists for, and it was caught by it on the next run. A sentinel has to
 * be readable in the file it lives in.
 */
const OTHER = '__other__';

/** Said whenever the flow stops without storing anything. */
const CANCELLED = '  Cancelled. Nothing was stored.' + String.fromCharCode(10);

/**
 * Is this argument a credential rather than a subcommand?
 *
 * DELIBERATELY NOT A KEY-SHAPE PATTERN. Every provider spells its keys
 * differently and a new one would be refused by a regex written before it
 * existed — the same failure as a hardcoded provider list, one level down. The
 * only thing LAIN actually knows is which words are its OWN subcommands;
 * everything else is the user handing it something.
 */
function looksLikeCredential(arg, cfg = {}) {
  const s = String(arg || '').trim();
  if (!s || SUBCOMMANDS.has(s.toLowerCase())) return false;
  // ---- A PROVIDER'S NAME IS NOT A PROVIDER'S KEY ------------------------
  //
  // `/api openrouter` is somebody asking about a route, and `openrouter` is
  // ten characters with no spaces — so the length test alone would have stored
  // the WORD as that route's credential and reported success. A stored
  // credential that is a provider name is worse than a rejected command: the
  // route then fails to authenticate for a reason nothing on screen explains.
  //
  // Every name a picker would offer is excluded, which is the same list the
  // picker itself is built from — so this cannot drift out of step with it.
  const name = s.toLowerCase();
  if (providers.choices(cfg).some((p) => String(p.id).toLowerCase() === name)) return false;
  // A credential has no spaces. A mistyped subcommand is caught by the same
  // test, and gets told what the subcommands are rather than being stored.
  return !/\s/.test(s) && s.length >= 8;
}

/** `sk-…9f2a` — enough to recognise, not enough to use. */
function shapeOf(cred) {
  const s = String(cred || '');
  if (s.length <= 10) return '…';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

/**
 * WHICH PROVIDER DOES THIS KEY BELONG TO?
 *
 * The known endpoints, then anything already in the user's config, then
 * `Other…` — which asks for a base URL rather than guessing one. See
 * providers.js for why a guessed endpoint is a security question and not a
 * convenience one.
 */
function providerAdapter(list) {
  // ---- ORDERED BY HOW READY A ROW IS TO BE USED -------------------------
  //
  // `Other…` used to sit at the bottom, which was right when the picker was
  // twelve rows and wrong the moment it became twenty-one. The panel shows
  // about ten at a time, so the ONE row that works for every provider in
  // existence — "I know where my key goes, let me type the URL" — had fallen
  // two screens below the fold, and the rows standing in front of it are the
  // ones LAIN can do LEAST with.
  //
  // So the list runs from most ready to least:
  //
  //   PICK AND GO        the endpoint is known, or the user already configured
  //                      it. One keystroke and the credential is stored.
  //   Other…             the universal escape. Works for anything.
  //   NEEDS AN ENDPOINT  a name LAIN knows and cannot place. This is the SAME
  //                      action as `Other…` with the name filled in — a
  //                      convenience over it, not a step before it — so it
  //                      belongs after it rather than in front of it.
  //
  // Nothing is hidden and nothing is guessed; only the order changed.
  const row = (p) => ({
    // THREE STATES, ALL VISIBLE. A row with an endpoint shows it; a row LAIN
    // knows of but cannot place SAYS SO rather than being quietly dropped,
    // which is what the first version of this picker did. See providers.js.
    label: p.baseUrl
      ? `${p.label}   ${p.baseUrl}`
      : `${p.label}   — needs an endpoint`,
    value: p.id,
  });
  const ready = list.filter((p) => p.baseUrl);
  const unplaced = list.filter((p) => !p.baseUrl);
  return {
    title: 'WHICH PROVIDER IS THIS CREDENTIAL FOR?',
    kind: 'PROVIDER_SELECTION',
    mode: 'EXPANDED',
    items: [
      ...ready.map(row),
      { label: 'Other…   (enter the base URL yourself)', value: OTHER },
      ...unplaced.map(row),
    ],
    footer: '↑↓ select · Enter confirm · Esc cancel',
  };
}

/**
 * ASK FOR THE CREDENTIAL, WITHOUT SHOWING IT.
 *
 * `secret: true` is read by ui/inputbox.js, which draws one dot per character
 * instead of the text, and by ui/index.js, which keeps the line out of the ↑/↓
 * history. The BUFFER is untouched — what is sent is the real credential, and
 * only the drawing is masked.
 *
 * This is what bare `/api` opens, so a key never has to be typed on a command
 * line where it would be echoed before this frame could exist.
 */
function credentialAdapter() {
  return {
    title: 'API CREDENTIAL',
    kind: 'ASK_USER',
    mode: 'EXPANDED',
    takes: 'TEXT',
    secret: true,
    options: [],
    question: 'Paste the API key or token.',
    items: [
      { label: 'Paste the API key or token.', selectable: false },
      { label: '', selectable: false },
      { label: 'It is masked as you type and is never written to history,', selectable: false },
      { label: 'the transcript, or an error message.', selectable: false },
      { label: '', selectable: false },
      { label: 'Enter confirms. Esc cancels and stores nothing.', selectable: false },
    ],
    footer: 'Enter confirm · Esc cancel',
    onTyped(text) {
      const t = String(text == null ? '' : text).trim();
      return t ? { close: t } : undefined;
    },
  };
}

/** The base URL for a provider LAIN does not know. Typed, never guessed. */
function baseUrlAdapter() {
  return {
    title: 'BASE URL',
    kind: 'ASK_USER',
    mode: 'EXPANDED',
    takes: 'TEXT',
    options: [],
    question: 'Which endpoint should this credential be sent to?',
    items: [
      { label: 'Which endpoint should this credential be sent to?', selectable: false },
      { label: '', selectable: false },
      { label: 'For an OpenAI-compatible router this is usually the /v1 root,', selectable: false },
      { label: 'for example  https://your-router.example/api/v1', selectable: false },
      { label: '', selectable: false },
      { label: 'Type it on the line above and press Enter. Esc cancels.', selectable: false },
    ],
    footer: 'Enter confirm · Esc cancel',
    onTyped(text) {
      const s = String(text == null ? '' : text).trim();
      return s ? { close: s } : undefined;
    },
  };
}

/** Only somewhere a credential can safely be sent. */
function validBaseUrl(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return 'a base URL must start with http:// or https://';
  try { new URL(s); } catch { return 'that is not a URL LAIN can parse'; }
  return null;
}

/**
 * STORE THE CREDENTIAL, under the existing connection model.
 *
 * `lain:<provider>` says WHO HOLDS THE KEY, which is the distinction
 * connections.js is built around. An existing entry for the same provider is
 * UPDATED rather than duplicated — re-keying a route that already works is the
 * commonest reason to run this a second time.
 */
function store(app, config, { provider, protocol, baseUrl, credential, connectionId }) {
  const cfg = app.cfg;
  // ---- HELD BACK FROM EVERY SCREEN, BEFORE IT IS WRITTEN ANYWHERE --------
  //
  // From here on the exact bytes are known, so src/redact.js can keep them off
  // every display surface - the activity feed, an error message, `/provider
  // status`, the dashboard, a copied transcript. And `/api sk-...` typed at the
  // prompt was remembered by the input history BEFORE anything knew what it
  // was, so that entry is taken back out: the up-arrow must not return a
  // plain-text key.
  const redact = require('./redact');
  redact.register(credential);
  redact.scrubHistory(app.input);
  if (!cfg.connections || typeof cfg.connections !== 'object') cfg.connections = {};
  const id = connectionId || providers.connectionIdFor(provider);
  const existing = cfg.connections[id] || {};
  cfg.connections[id] = {
    ...existing,
    provider,
    via: 'native',
    auth: 'api_key',
    protocol: protocol || existing.protocol || 'chat',
    baseUrl: baseUrl || existing.baseUrl || '',
    apiKey: credential,
  };
  config.save(cfg);
  return id;
}

/**
 * WHAT THE ROUTE SERVES — asked once, immediately.
 *
 * A catalog request (`GET /models`), never a model round-trip: no tokens are
 * spent and no completion is generated. This is the step that makes typing a
 * model id unnecessary, and it is also the first real proof the credential
 * works — which is why its failure is reported in the provider's own words
 * rather than as "something went wrong".
 */
async function discoverModels(app, connectionId) {
  const conn = (app.connections() || []).find((c) => c.id === connectionId);
  if (!conn) return { ok: false, error: 'the connection was saved but cannot be read back' };
  try {
    // ---- `discover` RETURNS A RESULT, NOT A LIST -------------------------
    //
    // THE DEFECT THIS FIXES, and it made the happy path unreachable. This read
    //
    //     const models = await connectionsMod.discover(conn);
    //     if (!models || !models.length) return { error: 'listed no models' };
    //
    // `discover` answers `{ ok, count, models, url }`. An object has no
    // `length`, so `!models.length` was ALWAYS true and `/api` reported "the
    // provider answered, but listed no models" for every successful discovery
    // in existence — then wrote the result object into the catalog cache in
    // place of the array. The credential was stored and the flow stopped one
    // step before the model picker, which is the step it exists for.
    //
    // It survived because the only verification anyone had run used a FAKE
    // credential, which fails earlier and never reaches this line. A failure
    // path proved correct is not a happy path proved correct.
    //
    // `discover` also writes the cache itself, keyed on the connection and
    // stamped with the URL it actually read — so the second write here was a
    // worse copy of one that had already happened.
    const r = await connectionsMod.discover(conn);
    if (!r || !r.ok) {
      return { ok: false, error: (r && r.error) || 'the provider answered, but listed no models' };
    }
    return { ok: true, models: r.models, url: r.url };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * The whole flow. Returns nothing; everything it has to say, it says on screen.
 *
 * NON-TTY IS NOT A DEGRADED TTY. With no panel to ask through there is no way
 * to choose a provider, and guessing one would store a credential against a
 * route the user never named. It says so and stores nothing.
 */
async function credentialFlow(app, credential, { C, config, refreshCatalog }) {
  const w = (s) => app.render.write(s);
  if (!app.ui || !app.ui.enabled) {
    w(C.yellow('  /api <credential> needs the interactive picker to ask which provider it belongs to.\n'));
    w(C.dim('  Without a terminal, declare the route in config.json instead — see /provider status.\n'));
    return;
  }

  // ---- NO CREDENTIAL YET: ASK FOR IT, MASKED ----------------------------
  //
  // Bare `/api` lands here. Asking through the panel is strictly better than
  // requiring `/api <key>` on the command line, where the shell echoes it
  // before anything of LAIN's can mask it.
  let cred = String(credential || '').trim();
  if (!cred) {
    cred = await app.ui.ask(credentialAdapter());
    if (!cred) { w(C.dim(CANCELLED)); return; }
    cred = String(cred).trim();
  }

  const list = providers.choices(app.cfg);
  const pickedId = await app.ui.ask(providerAdapter(list));
  if (!pickedId) { w(C.dim('  Cancelled. Nothing was stored.\n')); return; }

  let provider = pickedId;
  let protocol = 'chat';
  let baseUrl = '';
  let connectionId = null;

  if (pickedId === OTHER) {
    const typed = await app.ui.ask(baseUrlAdapter());
    if (!typed) { w(C.dim('  Cancelled. Nothing was stored.\n')); return; }
    const bad = validBaseUrl(typed);
    if (bad) { w(C.yellow(`  ${bad}\n`)); w(C.dim('  Nothing was stored.\n')); return; }
    baseUrl = String(typed).trim();
    // NAMED AFTER ITS HOST, because a route has to be referable — by `/model`,
    // by `/provider disable`, and in the header. An unnamed one cannot be.
    try { provider = new URL(baseUrl).hostname.replace(/^www\./, ''); } catch { provider = 'custom'; }
  } else {
    const p = list.find((x) => x.id === pickedId);
    if (!p) { w(C.yellow('  That provider is no longer available.\n')); return; }
    provider = p.id;
    protocol = p.protocol;
    baseUrl = p.baseUrl;
    connectionId = p.connectionId || null;
    if (!baseUrl) {
      const typed = await app.ui.ask(baseUrlAdapter());
      if (!typed) { w(C.dim('  Cancelled. Nothing was stored.\n')); return; }
      const bad = validBaseUrl(typed);
      if (bad) { w(C.yellow(`  ${bad}\n`)); w(C.dim('  Nothing was stored.\n')); return; }
      baseUrl = String(typed).trim();
    }
  }

  const id = store(app, config, { provider, protocol, baseUrl, credential: cred, connectionId });
  w(C.green(`  ${id}`) + C.dim(`  ${shapeOf(cred)}  →  ${baseUrl}\n`));

  // ---- WHAT IT SERVES ------------------------------------------------------
  w(C.dim(`  FETCHING AVAILABLE MODELS from ${baseUrl} …\n`));
  const found = await discoverModels(app, id);
  if (!found.ok) {
    // THE CREDENTIAL IS KEPT. It may be perfectly good and the network may not
    // be — throwing it away would make a transient failure look like a typo,
    // and the user would paste it again to no better effect.
    w(C.yellow(`  Model discovery failed: ${found.error}\n`));
    w(C.dim('  The credential is stored. Try `/api refresh` once the cause is fixed,\n'));
    w(C.dim('  or `/provider status` to see how this route is doing.\n'));
    return;
  }
  w(C.green(`  ${found.models.length} model(s) available\n`));

  // ---- AND THE PICKER, SO NOBODY TYPES AN ID -------------------------------
  //
  // The SAME picker `/models` opens. A second list here would be a second
  // filter, a second Enter and a second thing to keep in step.
  await refreshCatalog(app, { only: id, quiet: true });
  return require('./modelcommand').pickCommand(app, { args: [], rest: '' }, { C, config, refreshCatalog });
}

// `providerAdapter` is exported for the test that pins WHERE `Other…` sits in
// the list — see tests/unit/apiflow.test.js. Its position is a property of the
// picker rather than of a flow, so it is asserted on the adapter directly.
module.exports = {
  credentialFlow, looksLikeCredential, shapeOf, validBaseUrl, providerAdapter, SUBCOMMANDS,
};
