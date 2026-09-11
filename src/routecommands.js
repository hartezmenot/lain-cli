'use strict';

/**
 * THE ROUTE COMMANDS — which model, through which connection, at what effort,
 * and which model reviews an investigation.
 *
 * Split out of commands.js, which had grown past the god-object guard. The seam
 * is not arbitrary: every command here is a question about the CATALOG — what is
 * served, by whom, how to reach it, and which of them plays reviewer — while
 * commands.js keeps the session, the workspace and the reports.
 *
 * There is still exactly ONE registry. This file does not own a second one: it
 * is handed `define` and registers into the same map, at load time, from the
 * bottom of commands.js. That is also why it requires nothing back from
 * commands.js — a cycle here would be a second dispatch path waiting to happen.
 */

const config = require('./config');
const catalogMod = require('./catalog');
const connectionsMod = require('./connections');

/**
 * @param {object} api  { define, REGISTRY, C } — the registry's own vocabulary,
 *                      passed in rather than imported back.
 */
function register({ define, REGISTRY, C }) {
  /** Re-read what the routes serve. The implementation lives in catalog.js. */
  const refreshCatalog = (app, opts) => catalogMod.refreshAndReport(app, opts, { C });
  /**
   * ---- `/external` IS RETIRED, AND IT IS NOT COMING BACK ------------------
   *
   * It lived here and was a DRAFT-AND-DISPATCH verb: compose a packet, preview
   * it, confirm it, send it once, print the reply, hand it back as advice. Four
   * files of machinery — external.js, actors.js, externalrequest.js and
   * investigation.js's relay — and a person who wanted a second opinion had to
   * remember a command to get one.
   *
   * THE USEFUL HALF OF IT WAS NEVER THE COMMAND. It was "a model other than
   * LAIN's own looks at this", and that is a PROPERTY OF THE SESSION, not a verb:
   * once ChatGPT.com is the selected chat source, the next ordinary sentence goes
   * to it and the answer lands in the same session history as everything else.
   * See src/modelsource and `/source`.
   *
   * WHAT WAS REUSED rather than rewritten:
   *   · the bounded, redacted session-facts packet   -> modelsource/context.js
   *   · the call ledger (dispatched / responded /    -> externalstate.js, kept
   *     failed / timed out, and RESPONDED REQUIRES      whole and now written by
   *     A RESPONSE)                                     the web sources
   *   · the overclaim check — a consulted model that -> modelsource/contract.js
   *     claims to have ACTED is flagged
   *   · "advisory input, not a result, and not from  -> chatdispatch.js
   *     the user"
   *
   * WHAT WAS RETIRED: the actor taxonomy (API / HUMAN / REVERSE), the clipboard
   * relay, the draft/confirm/send state machine, and the bounded LAIN → EXTERNAL
   * → LAIN investigation relay — which had been unreachable since `/troubleshoot`
   * was removed and was recorded as orphaned in docs/STATUS.md.
   *
   * TWO CONSULTATION SYSTEMS WOULD BE WORSE THAN EITHER. That is the whole
   * argument for removing rather than keeping this beside the new one.
   */

  /**
   * ONE MODEL COMMAND, AND IT IS THE SINGULAR ONE.
   *
   * ------------------------------------------------------------------------
   * THE HISTORY, because the end state only makes sense against it.
   *
   * There were two commands with two BEHAVIOURS: `/models` browsed, and `/model`
   * selected the first fuzzy match without showing what else matched. A previous
   * pass fixed the dangerous half of that by making `/model` forward to the one
   * picker — but it left both names advertised, so a person still had to know
   * two words for one thing and still had to choose between them every time.
   *
   * `/model` is now THE command. `/models` survives as a hidden compatibility
   * alias: it still runs when typed, for anyone with it in their fingers or in a
   * script, and it appears in neither `/help` nor the palette. See commands.js
   * `define` for what `hidden` means and what it must never be used for.
   *
   * The graphical picker is the Harness application's; this is the terminal's.
   */
  define('/model', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[name|refresh]',
    desc: 'Model picker — type to filter, Enter to use',
    run(app, ctx) { return require('./modelcommand').pickCommand(app, ctx, { C, config, refreshCatalog }); },
  });

  define('/models', {
    surface: true,
    // HIDDEN: runs when typed, offered nowhere. One name is advertised.
    hidden: true,
    args: '[name|refresh]',
    desc: 'Compatibility alias for /model',
    run(app, ctx) { return REGISTRY.get('/model').run(app, ctx); },
  });

  // ONE effort command. V1 shipped /effort AND /efforts; there is no alias here.
  define('/effort', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[level]',
    desc: 'Show or set reasoning effort (orthogonal to model identity)',
    async run(app, { args }) {
      const cat = app.catalog();
      const m = app.cfg.model ? cat.byId.get(app.cfg.model) : null;
      const conn = m && (app.cfg.connection ? m.connections.find((c) => c.connectionId === app.cfg.connection) : m.connections[0]);
      const available = conn ? conn.efforts : [];
      // Bare /effort on a TTY opens the ONE interaction panel. Same owner, same
      // parser, same validation — the panel only supplies the value.
      if (!args[0] && app.ui && app.ui.enabled) {
        const { effortAdapter } = require('./ui/panel');
        const picked = await app.ui.ask(effortAdapter({ available, current: app.cfg.effort }));
        if (picked) args = [picked];
      }
      if (!args[0]) {
        app.render.write('  effort: ' + (app.cfg.effort || C.dim('auto'))
          + (available.length
            ? C.dim(`  ·  available here: ${available.join(', ')}, auto`)
            : C.dim('  ·  this route exposes no effort levels')) + '\n');
        return;
      }
      const want = String(args[0]).toLowerCase();
      // `auto` is the absence of a pin, not a level: the route picks. It is
      // handled by this same command and parser — there is no second owner and no
      // alias, which is why /efforts does not exist.
      if (want === 'auto' || want === 'default' || want === 'none') {
        app.cfg.effort = null;
        config.save(app.cfg);
        app.render.write(C.green('  effort auto') + C.dim(' — no level pinned; the route decides\n'));
        return;
      }
      if (available.length && !available.includes(want)) {
        app.render.write(C.yellow(`  "${want}" is not offered by ${conn.connectionId}.`) + C.dim(` Available: ${available.join(', ')}, auto\n`));
        return;
      }
      app.cfg.effort = want;
      config.save(app.cfg);
      app.render.write(C.green(`  effort ${want}`) + '\n');
    },
  });


  define('/api', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[<credential>|<connection>|refresh [id]|status]  — bare /api asks for a key',
    desc: 'Give LAIN a credential, re-key a configured route, or re-read what the APIs serve',
    /**
     * FOUR THINGS, ONE OWNER EACH.
     *
     * `refresh` and `status` are unchanged and still route to their existing
     * owners. Handing LAIN a key had no way in from the CLI at all until
     * `credentialFlow`. The fourth is the repair for a key that STOPPED
     * working: name a configured route — `/api lain:custom` — and its
     * credential is replaced under the SAME connection id, so a 401 fixes the
     * one route rather than adding a second for the same endpoint. See
     * rekeyFlow in apicommand.js.
     *
     * A CREDENTIAL IS ANYTHING THAT IS NEITHER A SUBCOMMAND NOR A ROUTE NAME,
     * which is the only test LAIN can honestly make: every provider spells
     * its keys differently, and a shape pattern written today refuses the
     * provider that appears tomorrow. See apicommand.js.
     */
    async run(app, { args }) {
      const apiMod = require('./apicommand');
      const first = args[0] || '';
      // ---- BARE `/api` ASKS FOR THE CREDENTIAL, MASKED --------------------
      //
      // It used to mean `refresh`, which is the least likely thing somebody
      // types `/api` for and gave no way in at all. Asking through the panel is
      // also strictly safer than `/api <key>`: on the command line the shell
      // has already echoed the key before anything of LAIN's could mask it.
      // `refresh` is still one word away and still does exactly what it did.
      if (!first) return apiMod.credentialFlow(app, '', { C, config, refreshCatalog });
      const sub = String(first).toLowerCase();
      if (sub === 'refresh') { await refreshCatalog(app, { only: args[1] || null }); return; }
      // ---- A CONFIGURED ROUTE'S NAME RE-KEYS IT ---------------------------
      //
      // THE ORDER IS THE WHOLE POINT. `lain:custom` is eleven characters with
      // no spaces, so under the credential rule alone it WAS a credential —
      // stored as an API key against a provider the user never chose, and the
      // route then failed to authenticate for a reason nothing on screen
      // explained. A word that names a route must repair that route, never
      // become its credential. `connectionByName` is what decides.
      if (apiMod.connectionByName(app, first)) {
        return apiMod.rekeyFlow(app, first, { C, config, refreshCatalog });
      }
      if (apiMod.looksLikeCredential(first, app.cfg)) {
        return apiMod.credentialFlow(app, String(first).trim(), { C, config, refreshCatalog });
      }
      // ---- A PROVIDER'S NAME WITH NO ROUTE YET IS AN ADD ------------------
      //
      // `/api custom` fell through to the status view: somebody adding that
      // route was shown the routes they already had. The name is an answer to
      // the provider question, so it is passed as one — see credentialFlow's
      // `preselect`. Re-keying still wins above, because a route that EXISTS
      // must be repaired rather than duplicated.
      if (apiMod.providerNamed(app, first)) {
        return apiMod.credentialFlow(app, '', { C, config, refreshCatalog, preselect: first });
      }
      // Anything else is the connection view, which already exists. One owner.
      return REGISTRY.get('/provider').run(app, { args: ['status'], rest: '' });
    },
  });

  define('/provider', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[status|refresh [id]|disable <id>|enable <id>|maintenance <id>|retry <id>]',
    desc: 'Connection availability and catalog. Works while a provider is dead.',
    async run(app, { args }) {
      const sub = (args[0] || 'status').toLowerCase();
      const id = args[1];
      const w = (s) => app.render.write(s);

      // The one command that DOES contact a route — and only its catalog
      // endpoint, never a completion. Without an id it refreshes every route that
      // does not declare its own models.
      if (sub === 'refresh') {
        const results = await app.ensureCatalog({ force: true, only: id || null, announce: false });
        if (!results.length) {
          w(C.dim(`  Nothing to refresh${id ? ` for "${id}"` : ''} — routes that declare their own models are left alone.\n`));
          return;
        }
        for (const r of results) {
          if (r.ok) w(C.green(`  ${r.id}`) + C.dim(`  ${r.count} model(s) from ${r.url}\n`));
          else w(C.yellow(`  ${r.id}`) + C.dim(`  no catalog — ${r.error}\n`));
        }
        const cat = app.catalog();
        w(C.dim(`\n  ${cat.models.length} canonical model(s). /model to browse.\n`));
        return;
      }

      if (sub !== 'status') {
        if (!id) { w(C.dim(`  Usage: /provider ${sub} <connection-id>\n`)); return; }
        // NONE of these contact the provider. That is the point: a dead provider
        // must not be able to stop you managing it.
        const r = sub === 'disable' ? app.availability.disable(id)
          : sub === 'enable' ? app.availability.enable(id)
            : sub === 'maintenance' ? app.availability.maintenance(id)
              : sub === 'retry' ? app.availability.retry(id) : null;
        if (!r) { w(C.dim('  Usage: /provider status|disable|enable|maintenance|retry <id>\n')); return; }
        w(C.green(`  ${id} → ${r.status}`) + C.dim(' (no request was sent)\n'));
        return;
      }

      const conns = app.connections();
      // The SAME interaction panel every other interactive surface uses.
      if (app.ui && app.ui.enabled) {
        const { providerAdapter } = require('./ui/panel');
        await app.ui.ask(providerAdapter({
          connections: conns,
          availabilityOf: (cid) => app.availability.get(cid).status,
        }));
        return;
      }
      w('\n' + C.bold('Connections') + '\n');
      if (!conns.length) { w(C.dim('  none configured\n')); return; }
      for (const c of conns) {
        const a = app.availability.get(c.id);
        w('  ' + c.id.padEnd(22)
          + C.dim(`${c.provider} · ${c.via} · auth=${c.auth}`) + '\n');
        w('    ' + C.dim(`readiness ${c.readiness}  ·  availability ${a.status}${a.reason ? ' — ' + a.reason : ''}`) + '\n');
        // ---- A LIMIT IS A CLOSED DOOR WITH A CLOCK ON IT, AND IT SAYS SO ----
        //
        // Not folded into the availability line above: `DEGRADED — rate
        // limited` is the status of a route somebody might reasonably try, and
        // the one thing that decides whether trying is pointless is the time.
        // A limit hydrated from an earlier session is marked, because "LAIN
        // learned this before you started it" is the answer to "why does it
        // think that when I have not called anything yet".
        if (a.rateLimited) {
          const left = a.resumeAt ? a.resumeAt - Date.now() : 0;
          const rl = require('./ratelimit');
          // NEVER AN INVENTED COUNTDOWN. With no stated reset the honest row is
          // that nobody said when — a number here would be planned around.
          const when = a.resumeAt > 0
            ? (left > 0 ? `clears in ${rl.human(left)} — around ${rl.at(a.resumeAt)}` : 'should have cleared')
            : 'UNKNOWN RESET — the provider did not say when';
          const from = app.availability.hydrated && app.availability.hydrated.has(c.id)
            ? ' (from an earlier session)' : '';
          w('    ' + C.dim(`rate limited · ${when}${from}`) + '\n');
        }
        // WHERE the model list came from. "declared" and "discovered" fail in
        // different ways and are fixed in different places, so they are never
        // collapsed into one number.
        const origin = c.declaredModels ? 'declared in config'
          : c.discoveredAt ? `discovered ${new Date(c.discoveredAt).toISOString().slice(0, 16).replace('T', ' ')}`
            : 'not yet discovered';
        w('    ' + C.dim(`catalog ${c.models.length} model(s) — ${origin}`) + '\n');
      }
      w(C.dim('\n  readiness is about credentials; availability is about reachability. They are separate.\n'));
      w(C.dim('  /provider refresh [id] re-reads a route\'s catalog (no completion is requested).\n'));
    },
  });

  define('/oauth', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[provider]',
    desc: 'Authentication routes per provider — never fakes OAuth',
    run(app, { rest }) {
      const conns = app.connections();
      const w = (s) => app.render.write(s);
      const providers = rest ? [rest] : [...new Set(conns.map((c) => c.provider))];
      if (!providers.length) { w(C.dim('  No connections configured.\n')); return; }
      for (const p of providers) {
        w('\n' + C.bold(p) + '\n');
        const rows = connectionsMod.authRoutes(p, conns);
        if (!rows.length) { w(C.dim('  no routes\n')); continue; }
        for (const r of rows) {
          const status = r.enabled ? r.status : C.yellow(r.status);
          w('  ' + r.label.padEnd(30) + status + '\n');
          if (r.detail) w(C.dim('      ' + r.detail) + '\n');
        }
        if (connectionsMod.hasKeylessRoute(p, conns)) {
          w(C.green('  ✓ a keyless route is already authenticated — no API key needed for this provider\n'));
        }
      }
    },
  });
}

module.exports = { register };
