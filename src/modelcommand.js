'use strict';

/**
 *  AND  — browsing the catalog, and choosing from it.
 *
 * Split out of catalog.js, which had reached the god-object guard. The seam is
 * a real one: that file ANSWERS QUESTIONS about what is served — build, search,
 * fold effort variants, resolve a name — and this is the one COMMAND that asks
 * them on a person's behalf and writes the answer to config.
 *
 * Everything it needs is imported from catalog.js. It adds no second search, no
 * second notion of what a route is, and no second place that decides a default.
 */

const config = require('./config');
const { search, displayName } = require('./catalog');

/**
 * THE MODEL PICKER — the one implementation behind /models and /model.
 *
 * It lives here because every branch of it is a catalog question. commands.js
 * registers the two names; there is no second state machine, no second filter
 * and no second idea of what Enter means.
 */
async function pickCommand(app, { args = [], rest = '' } = {}, { C, config, refreshCatalog } = {}) {
    // `refresh` is accepted on all three of /api, /model and /models because
    // there is no way to guess which one a person will reach for, and they run
    // the same code — there is one registry.
    if (rest.trim().toLowerCase() === 'refresh') { await refreshCatalog(app); return; }
    // A picker with nothing in it is not an answer. If no route has ever been
    // asked what it serves, ask now — this is the moment the list is needed.
    await app.ensureCatalog();
    const cat = app.catalog();
    const w = (s) => app.render.write(s);
    // ONE RULE EVERYWHERE: commit when nothing is left to decide.
    //
    // `/models sonnet` matches 52 models, so it opens the picker with `sonnet`
    // already filtering. `/models claude-opus-5` matches exactly one, so there
    // is nothing to browse and it is simply selected — the same judgement Enter
    // makes inside the picker, so the two can never give different answers for
    // the same words. This also keeps exact-name selection working on a real
    // terminal, where the panel would otherwise be the only way in.
    const soleMatch = rest ? (() => {
      const known = new Set(app.connections().map((c) => c.id));
      const tail = args.length > 1 ? args[args.length - 1] : null;
      const conn = tail && known.has(tail) ? tail : null;
      const q = conn ? rest.slice(0, rest.length - conn.length).trim() : rest;
      const found = search(cat, q);
      return found.length === 1 ? found[0] : null;
    })() : null;

    // `/models` browses everything; `/models claude` browses what matches. Both
    // open the SAME panel — a name is a filter, not a different command.
    if (cat.models.length && !soleMatch && app.ui && app.ui.enabled) {
      const { modelsAdapter } = require('./ui/panel');
      // Readiness and availability are DIFFERENT questions and stay separate
      // fields: one is about credentials, the other about reachability. Both key
      // off baseConnectionId — the connection a request actually goes through,
      // not the display id, which may carry a route namespace.
      const byId = new Map(app.connections().map((c) => [c.id, c]));
      const readinessOf = (c) => (byId.get(c.baseConnectionId) || {}).readiness || 'unknown';
      const availabilityOf = (c) => app.availability.get(c.baseConnectionId).status;
      // ONE builder, used both to open the browser and to rebuild it as the
      // user types. Effort now travels with the route choice, so picking in the
      // browser settles model, connection and level in a single act.
      const newModels = require('./newmodels');
      const isNew = newModels.all();
      const build = (filter) => modelsAdapter({
        catalog: cat,
        current: app.cfg.model,
        currentConnection: app.cfg.connection,
        filter,
        readinessOf,
        availabilityOf,
        // THE WHOLE ENTRY, not just the word: the rate-limit countdown lives on
        // it, and "rate limited" without "clears in 3h 59m" is the half of the
        // fact that does not help anybody choose.
        availabilityRaw: (c) => app.availability.get(c.baseConnectionId),
        isNew,
        onPickRoute: (model, conn, effort) => {
          app.cfg.model = model.id;
          app.cfg.connection = conn.connectionId;
          if (effort !== undefined) app.cfg.effort = effort;
          config.save(app.cfg);
          // Using it is the end of it being news.
          newModels.seen(model.id);
        },
      });
      // Typing narrows the list. `replace` swaps the frame's CONTENT without
      // touching the promise below, so a filter keystroke can never resolve or
      // orphan the caller. Purely local: the catalog is already in memory.
      app.ui.setModelFilter((text) => {
        if (app.ui.panel.stack.length !== 1) return;   // not inside a drill-down
        app.ui.panel.replace(build(text));
        app.ui.refresh();
      });
      const picked = await app.ui.ask(build(rest));
      app.ui.setModelFilter(null);
      // THE QUERY BELONGED TO THE PICKER, so it leaves with it. While the
      // browser is open the filter text lives on the input line — that is what
      // makes typing narrow the list — and it was being left behind when the
      // panel closed, so the next thing typed was appended to a dead search and
      // submitted as `qwen free/status`.
      if (app.input) app.input.setLine('');
      else app.ui.setInput('');
      // DID MY MODEL ACTUALLY CHANGE? Answered on the spot, in the words the
      // picker used — not left for the user to go and check with /status. The
      // header updates too; this is the receipt for the action just taken.
      if (picked && picked.model) {
        const chosen = (cat.models || []).find((m) => m.id === picked.model);
        const name = chosen ? chosen.displayName : picked.model;
        const conn = chosen && chosen.connections.find((c) => c.connectionId === picked.connection);
        app.render.write('\n' + C.green('  ✓ Model selected') + '\n');
        app.render.write('      ' + C.bold(name) + '\n');
        if (conn) app.render.write(C.dim(`      ${conn.provider}`) + '\n');
        app.render.write(C.dim(`      effort ${picked.effort || app.cfg.effort || 'auto'}`) + '\n');
      } else {
        // Escape. Saying so is the difference between "cancelled" and "did that
        // do anything?".
        app.render.write(C.dim('  Unchanged.\n'));
      }
      return;
    }
    if (!cat.models.length) {
      w(C.dim('\n  No models. Declare a connection in ' + config.configFile() + ':\n'));
      w(C.dim('    { "connections": { "omniroute": { "provider": "anthropic", "via": "bridge",\n'));
      w(C.dim('        "baseUrl": "http://localhost:20128/v1" } } }\n'));
      w(C.dim('\n  A connection with a baseUrl is asked what it serves; listing "models" is optional.\n'));
      w(C.dim('  /provider refresh <id> re-reads a route\'s catalog.\n'));
      return;
    }
    // ONE row format for the full list and for a search — effort variants are
    // collapsed, so gpt-5.5-low/-medium/-high is one model with three efforts,
    // never three rows.
    const fresh = require('./newmodels').all();
    const rows = (list) => {
      // The SAME row format the picker uses: a count is only worth showing where
      // there is a choice in it. "1 route" is not something a person can act on.
      for (const m of list) {
        const routes = m.connections.length;
        const efforts = (m.connections[0] || {}).efforts || [];
        const hint = routes > 1
          ? `${routes} providers`
          : [(m.connections[0] || {}).provider, efforts.length > 1 ? `${efforts.length} levels` : null]
            .filter(Boolean).join('  ·  ');
        const mark = app.cfg.model === m.id ? C.green('● ') : '  ';
        // NEW leads the row, where the eye lands, and only for models the LAST
        // refresh actually brought in — never for one that was already there.
        const isNew = fresh.has(m.id) ? C.green('NEW ') : '    ';
        w('  ' + mark + isNew + m.displayName.padEnd(34) + C.dim(hint) + '\n');
      }
      w(C.dim('\n  /models <name> narrows this · an unambiguous name selects it outright\n'));
    };

    if (!rest) {
      w('\n' + C.bold('Models') + C.dim(`  ${cat.models.length} model(s)`) + '\n');
      rows(cat.models);
      return;
    }
    // `/models <name> <connection>` names a route explicitly. The last word is
    // only treated as a connection when it IS one — otherwise a two-word model
    // name would lose its second word and match nothing, which is exactly what
    // happened to `claude-opus-5 omniroute` when the whole string was searched.
    const known = new Set(app.connections().map((c) => c.id));
    const last = args.length > 1 ? args[args.length - 1] : null;
    const wantConn = last && known.has(last) ? last : null;
    const query = wantConn ? rest.slice(0, rest.length - wantConn.length).trim() : rest;

    // A NAME IS A SEARCH, not a selection. Showing one arbitrary hit out of
    // forty is how `/models sonnet` on a 967-model catalog concealed every
    // Sonnet but one. Commit only when the answer is unambiguous.
    const hits = search(cat, query);
    if (!hits.length) { w(C.dim(`  No model matching "${query}".\n`)); return; }
    if (hits.length > 1) {
      w('\n' + C.bold(`Models matching "${query}"`) + C.dim(`  ${hits.length} found`) + '\n');
      rows(hits);
      return;
    }
    // EXACTLY ONE MATCH IS A CHOICE ALREADY MADE.
    //
    // The same rule the picker applies to Enter, applied here: when nothing is
    // left to decide, decide it. This is also the only way to select a model
    // without a terminal — scripts and piped sessions have no panel — so it
    // keeps `/model <exact-name>` working as a selection while `/models sonnet`
    // stays a search.
    const m = hits[0];
    let conn = (wantConn && m.connections.find((c) => c.connectionId === wantConn)) || null;
    if (wantConn && !conn) {
      w(C.dim(`  "${m.displayName}" is not served by "${wantConn}".\n`));
      return;
    }

    // ---- ONE MODEL IS NOT ONE CHOICE WHEN TWO ROUTES SERVE IT --------------
    //
    // This took `m.connections[0]` — an arbitrary route, whichever the catalog
    // happened to list first — committed it, and THEN printed "2 routes serve
    // this model" underneath. The one moment the user was making a decision was
    // the moment LAIN made it for them, and the list of alternatives was a
    // report on a choice already taken.
    //
    // The name narrowed it to one MODEL. WHICH PROVIDER SERVES IT IS A SECOND
    // QUESTION, with real differences behind it: price, rate limits, effort
    // levels, and which one is answering right now. So it gets asked — through
    // the same route picker the browser drills into, so there is one
    // implementation of "choose a route" rather than a second for the typed path.
    if (!conn && m.connections.length > 1 && app.ui && app.ui.enabled) {
      const { modelRoutesAdapter } = require('./ui/panel');
      const byId = new Map(app.connections().map((c) => [c.id, c]));
      let picked = null;
      await app.ui.ask(modelRoutesAdapter({
        model: m,
        currentConnection: app.cfg.connection,
        readinessOf: (c) => (byId.get(c.baseConnectionId) || {}).readiness || 'unknown',
        availabilityOf: (c) => app.availability.get(c.baseConnectionId).status,
        // THE WHOLE ENTRY, not just the word: the rate-limit countdown lives on
        // it, and "rate limited" without "clears in 3h 59m" is the half of the
        // fact that does not help you choose.
        availabilityRaw: (c) => app.availability.get(c.baseConnectionId),
        onPickRoute: (_model, c) => { picked = c; },
      }));
      // ESCAPE CHANGES NOTHING. Cancelling a question is not an instruction to
      // pick the first option on the user's behalf.
      if (!picked) { w(C.dim('  unchanged.\n')); return; }
      conn = picked;
    }
    // OFF A TTY there is nobody to ask, so the first route is taken — and said
    // out loud below. A script that pipes `/model x` still works; it simply
    // learns which route it got instead of being quietly assigned one.
    if (!conn) conn = m.connections[0];
    if (!conn) {
      w(C.dim(`  "${m.displayName}" has no route that can serve it.\n`));
      return;
    }
    app.cfg.model = m.id;
    app.cfg.connection = conn.connectionId;
    config.save(app.cfg);
    if (app.ui && app.ui.enabled) app.ui.refresh();
    w('\n' + C.green(`  ${m.displayName}`) + C.dim(`  via ${conn.connectionId}${app.cfg.effort ? ' · effort ' + app.cfg.effort : ''}`) + '\n');
    // Everything that was NOT chosen, so a single-match selection never hides
    // that there were other routes.
    if (m.connections.length > 1) {
      w(C.dim(`  ${m.connections.length} routes serve this model:\n`));
      for (const c of m.connections) {
        const a = app.availability.get(c.connectionId);
        w(C.dim(`    ${c.connectionId === conn.connectionId ? '●' : ' '} ${c.connectionId.padEnd(22)}${c.provider} · ${c.via} · ${a.status}`) + '\n');
      }
      w(C.dim(`  /models ${query} <connection> picks a different one.\n`));
    }
    if (conn.efforts.length) w(C.dim(`  efforts on this route: ${conn.efforts.join(', ')}  ·  /effort to choose\n`));
}

module.exports = { pickCommand };