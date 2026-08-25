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
   * THE SECOND OPINION — WHO reviews LAIN's investigations.
   *
   * This used to be a model picker: `/external` meant "which other model from
   * the catalog", so the top-level question was the same 900-row list `/models`
   * opens, and a reviewer that is NOT a model in that catalog — a chat page you
   * are logged into, a person reading the packet — could not be expressed at
   * all. WHO is the first question; WHICH MODEL is a second one, asked only of
   * the API actor, and asked through the one model picker rather than a copy of
   * it. See actors.js.
   *
   * `/model` and `/models` are untouched and still browse the catalog. Off by
   * default, and `/troubleshoot` says NOT CONFIGURED rather than quietly using
   * LAIN's own model and calling the result an external review.
   */
  define('/external', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[<what you want> | send | show | cancel | api <model> | browser | human | off | rounds <n>]',
    desc: 'Ask something outside LAIN — drafted here first, sent only when you say so',
    async run(app, { args, rest }) {
      const externalMod = require('./external');
      const actorsMod = require('./actors');
      const request = require('./externalrequest');

      /** Every actor and what it would cost, in text. The non-TTY surface. */
      const show = () => {
        const st = actorsMod.status(app);
        app.render.write('\n' + C.bold('External actor') + C.dim('  — who reviews an investigation\n'));
        if (st.off) app.render.write('  ' + C.yellow('OFF') + C.dim(' — /troubleshoot stays local\n'));
        for (const a of st.actors) {
          const mark = a.chosen ? C.green('● ') : '  ';
          const state = a.ok ? C.green('ready') : C.yellow(a.why || 'NOT CONFIGURED');
          app.render.write(`${mark}${a.label.padEnd(30)}${state}\n`);
          if (a.chosen && a.model) app.render.write(C.dim(`    model ${a.model} · via ${a.connection || 'the route that serves it'}\n`));
          if (a.chosen) app.render.write(C.dim(`    ${a.automated ? 'automated' : 'you hand the packet over yourself'} · ${a.maxRounds} rounds\n`));
        }
        app.render.write(C.dim('  /external api <model> · browser · human · rounds <n> · off\n'));
      };

      /** Record a chosen actor and say what it now means. */
      const choose = (kind, extra = {}) => {
        const next = { ...(app.cfg.externalTroubleshoot || {}), ...extra, actor: kind, enabled: true };
        if (!next.maxRounds) next.maxRounds = externalMod.DEFAULT_MAX_ROUNDS;
        app.cfg.externalTroubleshoot = next;
        config.save(app.cfg);
        const s = actorsMod.status(app).actors.find((a) => a.kind === kind) || {};
        app.render.write(C.green('  ✓ external actor: ') + C.bold(s.label || kind) + '\n');
        if (kind === actorsMod.KIND.BROWSER) {
          // WHAT IT ACTUALLY DOES NOW. This said "LAIN opens the page and puts
          // the packet on your clipboard — LAIN does not read the page", which
          // described the architecture that BrowserActor replaced. It drives
          // LAIN's own Chromium: it types the packet in, waits for the reply to
          // settle, and reads it back off the page. The clipboard survives only
          // as the fallback for when that browser is not running, so it is
          // named as the fallback rather than as the behaviour.
          app.render.write(C.dim(`    LAIN's own Chromium opens ${next.url || actorsMod.DEFAULT_BROWSER_URL}, types the packet\n`));
          app.render.write(C.dim('    and reads the reply back off the page. Its profile is LAIN\'s, never yours.\n'));
          app.render.write(C.dim('    If that browser is not running it falls back to the clipboard and says so.\n'));
        } else if (kind === actorsMod.KIND.HUMAN) {
          app.render.write(C.dim('    The packet goes to your clipboard. Paste the reply back when you have it.\n'));
        }
        return next;
      };

      // A TTY GETS THE ACTOR MENU, not a wall of text and not a model list.
      if (!rest && app.ui && app.ui.enabled) {
        const { externalActorAdapter } = require('./ui/pickers');
        let picked = null;
        await app.ui.ask(externalActorAdapter({
          status: actorsMod.status(app),
          onPick: (p) => { picked = p; },
          // THE SECOND QUESTION, and only for the actor that has one. It is the
          // same picker `/models` opens, filtered by nothing — one model list.
          onPickApi: () => {
            const cat = app.catalog();
            if (!cat || !cat.models.length) return null;
            const { modelsAdapter } = require('./ui/panel');
            return modelsAdapter({
              catalog: cat,
              current: (app.cfg.externalTroubleshoot || {}).model || null,
              onPickRoute: (model, conn) => {
                picked = { kind: actorsMod.KIND.API, model: model.id, connection: conn.connectionId };
              },
            });
          },
        }));
        if (!picked) { app.render.write(C.dim('  unchanged.\n')); return; }
        if (picked.kind === 'OFF') {
          app.cfg.externalTroubleshoot = { ...(app.cfg.externalTroubleshoot || {}), enabled: false };
          config.save(app.cfg);
          app.render.write(C.dim('  external reviewer off — /troubleshoot stays local.\n'));
          return;
        }
        if (picked.unavailable) {
          // A declared seam that is not built says so, and changes nothing.
          app.render.write('  ' + C.yellow(picked.unavailable) + '\n');
          return;
        }
        choose(picked.kind, picked.model ? { model: picked.model, connection: picked.connection } : {});
        return;
      }

      if (!rest) { show(); return; }
      const sub = String(args[0] || '').toLowerCase();
      const cfg = { ...(app.cfg.externalTroubleshoot || {}) };

      // ---- THE REQUEST VERBS, WHICH ARE NOT CONFIGURATION -----------------
      //
      // `send` is the typed form of "send it" for a session with no panel to
      // click; `show` and `cancel` are what you do to a draft that is being
      // held. All three act on the pending draft and none of them changes a
      // setting, so they are answered before the actor subcommands below.
      if (sub === 'send' || sub === 'dispatch') { await request.dispatch(app, { C }); return; }
      if (sub === 'show' || sub === 'draft') { request.show(app, { C }); return; }
      if (sub === 'cancel' || sub === 'discard') { request.cancel(app, { C }); return; }
      // `status` and `list` are single tokens, so without this they fall
      // through to the model-name shorthand below and become a catalog search:
      // `/external status` answered "No model matches \"status\"". They are
      // words people type at a CLI far more often than they are model names.
      if (sub === 'status' || sub === 'list') { show(); return; }

      // AN ACTOR BY NAME, for a pipe and for anyone who would rather type.
      //
      // WITH WORDS AFTER IT, THE NAME IS AN ADDRESS RATHER THAN A SETTING.
      // `/external browser` chooses the browser actor; `/external browser this
      // looks like a bug` chooses it AND drafts that request for it. Both go
      // through LAIN — the second one still draws the packet, still shows it,
      // and still sends nothing until it is confirmed. That is what keeps the
      // arrow User -> LAIN -> browser rather than User -> browser.
      const after = rest.slice(String(args[0] || '').length).trim();
      if (sub === 'browser' || sub === 'chatgpt') {
        choose(actorsMod.KIND.BROWSER);
        if (after) await request.runRequest(app, after, { C, actorKind: actorsMod.KIND.BROWSER });
        return;
      }
      if (sub === 'human' || sub === 'paste' || sub === 'relay') {
        choose(actorsMod.KIND.HUMAN);
        if (after) await request.runRequest(app, after, { C, actorKind: actorsMod.KIND.HUMAN });
        return;
      }
      if (sub === 'reverse') {
        app.render.write('  ' + C.yellow(new actorsMod.ReverseActor(app, app.cfg).status().why) + '\n');
        app.render.write(C.dim('    capabilities it would need: process.select, memory.read, screen.inspect, symbol.resolve\n'));
        return;
      }

      if (sub === 'off' || sub === 'disable') {
        cfg.enabled = false;
        app.cfg.externalTroubleshoot = cfg;
        config.save(app.cfg);
        app.render.write(C.dim('  external reviewer off — /troubleshoot stays local.\n'));
        return;
      }
      if (sub === 'rounds') {
        const n = Number(args[1]);
        if (!n || n < 1 || n > 6) { app.render.write(C.dim('  Usage: /external rounds <1-6>\n')); return; }
        cfg.maxRounds = n;
        app.cfg.externalTroubleshoot = cfg;
        config.save(app.cfg);
        app.render.write(C.green(`  max rounds ${n}`) + C.dim(' — the relay stops there whatever happens\n'));
        return;
      }

      // ---- ANYTHING ELSE IS SOMETHING THE USER WANTS ASKED ----------------
      //
      // THE DEFECT THIS FIXES. Everything below is a MODEL-CATALOG SEARCH, and
      // it used to be the only thing free text could reach. So `/external
      // create a plan for this` searched 900 model names for the phrase "create
      // a plan for this" and answered "No model matches" — as did every other
      // sentence a person would naturally type after the word external.
      //
      // The shorthand it protects is real and still works: `/external <model>`
      // means `/external api <model>`. A model name is ONE token and a sentence
      // has spaces in it, which is the whole discriminator — see
      // externalrequest.looksLikeModelName.
      if (sub !== 'api' && !request.looksLikeModelName(rest)) {
        await request.runRequest(app, rest, { C });
        return;
      }

      // THE API ACTOR NEEDS A MODEL, and a name is a SEARCH — exactly as it is
      // for /models, committing only when the answer is unambiguous. `api` is
      // optional so an existing `/external <model>` keeps working unchanged.
      const query = (sub === 'api' ? rest.slice(args[0].length).trim() : rest);
      if (!query) {
        app.render.write(C.dim('  Usage: /external api <model>   (/models to browse names)\n'));
        return;
      }
      await app.ensureCatalog();
      const cat = app.catalog();
      const hits = catalogMod.search(cat, query);
      if (!hits.length) { app.render.write(C.yellow(`  No model matches "${query}".`) + C.dim(' /models to browse.\n')); return; }
      if (hits.length > 1) {
        app.render.write(C.dim(`\n  ${hits.length} models match "${query}" — narrow it:\n`));
        for (const m of hits.slice(0, 8)) app.render.write('    ' + m.displayName + '\n');
        return;
      }
      cfg.enabled = true;
      cfg.actor = actorsMod.KIND.API;
      cfg.model = hits[0].id;
      cfg.connection = (hits[0].connections[0] || {}).connectionId || null;
      if (!cfg.maxRounds) cfg.maxRounds = externalMod.DEFAULT_MAX_ROUNDS;
      app.cfg.externalTroubleshoot = cfg;
      config.save(app.cfg);
      app.render.write(C.green('  ✓ external reviewer: ') + C.bold(hits[0].displayName) + '\n');
      app.render.write(C.dim(`    via ${cfg.connection || 'the route that serves it'} · ${cfg.maxRounds} rounds\n`));
      app.render.write(C.dim('    /troubleshoot now runs LAIN → external → LAIN, bounded.\n'));
    },
  });

  define('/models', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[name|refresh]',
    desc: 'Model picker — type to filter, Enter to use',
    run(app, ctx) { return require('./modelcommand').pickCommand(app, ctx, { C, config, refreshCatalog }); },
  });

  define('/model', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[name] — alias of /models',
    desc: 'Alias for /models — the same picker, the same filter',
    /**
     * AN ALIAS, NOT A SECOND IMPLEMENTATION.
     *
     * There were two model commands with two behaviours: `/models` browsed and
     * `/model` selected the first fuzzy match without showing you what else
     * matched. Nobody should have to know which of two words gets them a list and
     * which gets them a silent guess — so `/model` now forwards, verbatim, to the
     * one picker. One state machine, one filter, one Enter.
     */
    run(app, ctx) { return REGISTRY.get('/models').run(app, ctx); },
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
    args: '[<credential>|refresh [id]|status]  — bare /api asks for a key',
    desc: 'Give LAIN a credential, or re-read what the configured APIs serve',
    /**
     * THREE THINGS, ONE OF WHICH IS NEW.
     *
     * `refresh` and `status` are unchanged and still route to their existing
     * owners. What did not exist was the obvious one: handing LAIN a key.
     * There was no way to do it from the CLI at all — a credential had to be
     * written into config.json by hand, and the model then named by id because
     * nothing had asked the route what it served.
     *
     * A CREDENTIAL IS ANYTHING THAT IS NOT A SUBCOMMAND, which is the only test
     * LAIN can honestly make: every provider spells its keys differently, and a
     * shape pattern written today refuses the provider that appears tomorrow.
     * See apicommand.js.
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
      if (apiMod.looksLikeCredential(first, app.cfg)) {
        return apiMod.credentialFlow(app, String(first).trim(), { C, config, refreshCatalog });
      }
      const sub = String(first).toLowerCase();
      if (sub === 'refresh') { await refreshCatalog(app, { only: args[1] || null }); return; }
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
        w(C.dim(`\n  ${cat.models.length} canonical model(s). /models to browse.\n`));
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
