'use strict';

/**
 * THE HARNESS APPLICATION'S API — reads, and the few actions that cost something.
 *
 * ------------------------------------------------------------------------
 * TWO KINDS OF ROUTE, AND THE SPLIT IS THE POINT.
 *
 *   GET /api/state        cheap, polled, opens nothing. See state.js.
 *   POST /api/…           deliberate. Each one launches a browser, contacts a
 *                         website, starts a dev server or submits a turn, and
 *                         is reached only because a person clicked something.
 *
 * A poll that could open a browser is a poll that opens one every two seconds.
 * So model DISCOVERY, Workshop OPEN, viewport changes, captures and
 * verification are all POSTs, and `/api/state` reports only what is already
 * known.
 *
 * ------------------------------------------------------------------------
 * IT DELEGATES EVERY DECISION.
 *
 * Nothing here decides whether a task passed, which model is available, whether
 * a page loaded, or whether a file changed. Each route calls the module that
 * owns that question and hands back what it said. The one thing these functions
 * add is an HTTP shape.
 *
 * ------------------------------------------------------------------------
 * SUBMITTING A TURN GOES THROUGH `app.handle`, WHICH IS THE ONE DOOR.
 *
 * Not `submit`, and certainly not `runTurn`. `handle` is where a command is
 * recognised, an open question is answered, a composed goal is captured and the
 * input gateway admits or holds a sentence — and every one of those must behave
 * identically whether the words arrived from the terminal or from the
 * application. A second entry point would be a second set of rules.
 */

const state = require('./state');
const source = require('./source');

/** How long a Workshop action may take before the app is told it did not finish. */
const ACTION_TIMEOUT_MS = 120_000;

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400) { return { code, body: { ok: false, why: String(why || 'refused') } }; }

/** Bound work, so a wedged browser cannot hold an HTTP connection open forever. */
function within(promise, ms = ACTION_TIMEOUT_MS, what = 'the operation') {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, why: `${what} did not finish within ${Math.round(ms / 1000)}s` }), ms)),
  ]);
}

/**
 * EVERY ROUTE, as `METHOD /path` -> handler.
 *
 * A flat table rather than a chain of ifs, so "what can this application do"
 * is answerable by reading one object — and so an unknown path is a 404 rather
 * than something falling through to a handler that half-matches it.
 */
const ROUTES = {
  // ------------------------------------------------------------- reading --

  'GET /api/state': async (app) => ok({ state: await state.read(app) }),

  // ------------------------------------------------ the chat model source --

  /**
   * WHAT THIS ACCOUNT ACTUALLY OFFERS. Paid: it opens the authenticated
   * browser, and on a signed-out account it reports AUTH_REQUIRED rather than
   * an empty list — see modelsource/webmodel.js on why those are different
   * answers.
   */
  'POST /api/source/models': async (app, body) => {
    const registry = require('../modelsource/registry');
    const src = registry.get(app, String(body.source || ''));
    if (!src) return bad(`"${body.source}" is not a chat source`);
    const inv = await within(src.discoverModels({ refresh: Boolean(body.refresh) }), ACTION_TIMEOUT_MS, 'model discovery');
    return ok({
      source: src.id,
      models: inv.models || [],
      cached: Boolean(inv.cached),
      why: inv.why || '',
      authRequired: Boolean(inv.authRequired),
    });
  },

  /** Open the site so a PERSON can sign in. LAIN never types a credential. */
  'POST /api/source/connect': async (app, body) => {
    const registry = require('../modelsource/registry');
    const src = registry.get(app, String(body.source || ''));
    if (!src) return bad(`"${body.source}" is not a chat source`);
    const st = await within(src.connect(), ACTION_TIMEOUT_MS, 'connecting');
    return ok({ state: st.state, why: st.why || '' });
  },

  'POST /api/source/select': async (app, body) => {
    const registry = require('../modelsource/registry');
    const chosen = registry.selectSource(app, String(body.source || ''));
    if (!chosen.ok) return bad(chosen.why);
    if (body.model) {
      const picked = await within(registry.selectModel(app, chosen.source, String(body.model)), ACTION_TIMEOUT_MS, 'selecting the model');
      if (!picked.ok) return bad(picked.why);
    }
    try { app.session.save(); } catch { /* the selection still holds for this run */ }
    return ok({ source: chosen.source, model: (app.session.sourceSelections || {})[chosen.source] || null });
  },

  // ------------------------------------------------------------- the turn --

  /**
   * ASK SOMETHING. The application does not wait for the answer: a coding turn
   * runs for minutes, and an HTTP request held open for one is a request that
   * times out somewhere in between. The reply arrives through `/api/state` like
   * everything else, which is also what keeps the terminal and the application
   * showing the same conversation.
   */
  // ---- THE SOURCE WORKSPACE -------------------------------------------
  //
  // `/api/files/…`, NOT `/api/source/…`. That prefix was already taken, by the
  // MODEL sources — ChatGPT, Gemini, the local runtime. Two unrelated meanings
  // of "source" under one namespace is the kind of collision that reads fine
  // the day it lands and costs an afternoon later.
  //
  // READS ARE POSTs, and that is deliberate rather than sloppy REST: they take
  // a PATH from the caller, and a path in a query string is a path in the
  // browser's history, in the address bar and in any log between. The bodies
  // are tiny and the page is the only client.
  //
  // Every one of them goes through harnessapp/source.js, which resolves through
  // tools/fs.js and refuses anything outside the project — the UI holds edit
  // INTENT and never the file authority.
  'POST /api/files/tree': (app, body) => ok(source.tree(app, String(body.path || ''))),
  'POST /api/files/open': (app, body) => {
    const r = source.open(app, String(body.path || ''));
    return r.ok ? ok(r) : bad(r.why);
  },
  'POST /api/files/find': (app, body) => ok(source.find(app, String(body.q || ''))),
  'POST /api/files/freshness': (app, body) => ok({ files: source.freshness(app, body.open || []) }),
  'POST /api/files/save': (app, body) => {
    const r = source.save(app, String(body.path || ''), body.body, {
      hash: body.hash, mtimeMs: body.mtimeMs, force: Boolean(body.force),
    });
    // A REFUSAL IS NOT AN ERROR HERE. Stale and truncation both come back 200
    // with the reason and the evidence, because the page has to SHOW them —
    // a 4xx would be swallowed by the generic handler and the person would see
    // "save failed" with nothing to act on.
    return ok(r);
  },

  // ---- UI <-> SOURCE --------------------------------------------------
  //
  // The defining feature. Both directions return EVIDENCE and a CONFIDENCE,
  // and `UNKNOWN` is a real answer — see harnessapp/uisource.js on why a
  // confident wrong file costs more than an honest shrug.
  'POST /api/files/from-element': (app, body) => ok(
    require('./uisource').fromElement(app, body.element || {}),
  ),
  'POST /api/files/to-ui': (app, body) => ok(
    require('./uisource').toSelectors(app, String(body.path || ''), { line: body.line }),
  ),

  'POST /api/turn': async (app, body) => {
    const text = String(body.text || '').trim();
    if (!text) return bad('nothing was asked');
    if (app.abort && !app.abort.signal.aborted) return bad('a turn is already running', 409);
    // NOT AWAITED, deliberately — see above. `handle` is the one door: it
    // recognises commands, answers open questions, captures a composed goal and
    // consults the input gateway, exactly as it does for the terminal.
    Promise.resolve(app.handle(text, { from: 'harness-app' })).catch(() => {});
    return ok({ accepted: true });
  },

  'POST /api/interrupt': async (app) => {
    if (!app.abort || app.abort.signal.aborted) return ok({ interrupted: false });
    app.abort.abort();
    return ok({ interrupted: true });
  },

  // ------------------------------------------------------- the Workshop ---

  /**
   * OPEN THE WORKSHOP for the current project: start or adopt the dev server,
   * launch the project-bound preview browser, and load the page.
   */
  'POST /api/workshop/open': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.open(app.session.cwd, {
      taskId: body.taskId || null,
    }), ACTION_TIMEOUT_MS, 'opening the Workshop');
    return r.ok ? ok(r) : bad(r.why);
  },

  'POST /api/workshop/close': async (app) => {
    const ws = require('../workshop').forApp(app);
    return ok(await ws.close(app.session.cwd));
  },

  'POST /api/workshop/navigate': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.navigate(app.session.cwd, String(body.url || '')), ACTION_TIMEOUT_MS, 'navigation');
    return r.ok ? ok(r) : bad(r.why);
  },

  'POST /api/workshop/reload': async (app) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.reload(app.session.cwd), ACTION_TIMEOUT_MS, 'reload');
    return r.ok ? ok(r) : bad(r.why);
  },

  /** ARM ELEMENT PICKING. The next click in the preview selects rather than acts. */
  'POST /api/workshop/pick': async (app) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.pick(app.session.cwd), 30_000, 'arming the picker');
    return r.ok ? ok(r) : bad(r.why);
  },

  /** WHAT THE PERSON PICKED, or null. Polled by the app while picking is armed. */
  'POST /api/workshop/picked': async (app) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.picked(app.session.cwd), 30_000, 'reading the selection');
    return ok(r);
  },

  'POST /api/workshop/unpick': async (app) => {
    const ws = require('../workshop').forApp(app);
    return ok(await ws.unpick(app.session.cwd));
  },

  'POST /api/workshop/element': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.element(app.session.cwd, String(body.selector || '')), 30_000, 'inspecting the element');
    return r.ok ? ok(r) : bad(r.why);
  },

  'POST /api/workshop/ax': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.axTree(app.session.cwd, body.selector || null), 30_000, 'reading the accessibility tree');
    return r.ok ? ok(r) : bad(r.why);
  },

  'POST /api/workshop/viewport': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.viewport(app.session.cwd, String(body.name || 'desktop')), ACTION_TIMEOUT_MS, 'the viewport change');
    return r.ok ? ok(r) : bad(r.why);
  },

  /** A SCREENSHOT. `as: 'before'` also banks it for the comparison. */
  'POST /api/workshop/capture': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const taskId = (app._harness && app._harness.snapshot && app._harness.snapshot().task)
      ? app._harness.snapshot().task.id : null;
    const r = await within(ws.capture(app.session.cwd, {
      as: body.as || null, taskId, name: body.name || null,
    }), ACTION_TIMEOUT_MS, 'the capture');
    if (!r.ok) return bad(r.why);
    const before = body.as === 'after' ? ws.before(app.session.cwd, r.viewport) : null;
    return ok({ shot: r, before });
  },

  /**
   * VERIFY THE FRONTEND at one or more viewports.
   *
   * IT RETURNS EVIDENCE, NOT A VERDICT ABOUT THE TASK. harness/verify.js and
   * completion.js remain the only things that settle work; this is what they
   * settle from. See workshop/index.js `verify`.
   */
  'POST /api/workshop/verify': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const taskId = (app._harness && app._harness.snapshot && app._harness.snapshot().task)
      ? app._harness.snapshot().task.id : null;
    const r = await within(ws.verify(app.session.cwd, {
      viewports: Array.isArray(body.viewports) && body.viewports.length ? body.viewports : ['desktop', 'mobile'],
      taskId,
      selector: body.selector || null,
    }), ACTION_TIMEOUT_MS * 2, 'verification');
    return r.ok === false && r.why ? bad(r.why) : ok(r);
  },

  /**
   * ATTACH AN OBSERVATION TO THE NEXT TURN.
   *
   * The Workshop's whole reason for existing on the same screen as the
   * conversation: a person selects an element, and what they selected becomes
   * the context of what they ask next — WITHOUT sending the DOM.
   *
   * Bounded and specific by construction: the selector, the accessible name,
   * the box, and the console/network lines that are actually failing.
   */
  'POST /api/workshop/attach': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const text = String(body.text || '').trim();
    if (!text) return bad('nothing was asked');
    const el = body.selector
      ? await within(ws.element(app.session.cwd, String(body.selector)), 30_000, 'inspecting the element')
      : { ok: false };
    const obs = ws.observations(app.session.cwd) || {};
    const lines = [text, ''];
    if (el.ok && el.element) {
      const e = el.element;
      lines.push('THE ELEMENT I SELECTED IN THE PREVIEW:');
      lines.push(`  selector   ${e.selector || body.selector}`);
      if (e.role || e.name) lines.push(`  accessible ${[e.role, e.name].filter(Boolean).join(' — ')}`);
      if (e.tag) lines.push(`  tag        ${e.tag}${e.id ? `#${e.id}` : ''}${e.classes ? `.${String(e.classes).trim().split(/\s+/).join('.')}` : ''}`);
      if (e.rect) lines.push(`  box        ${e.rect.w}×${e.rect.h} at ${e.rect.x},${e.rect.y}`);
      // ---- THE COMPUTED VALUES, AND ONLY THE ONES THAT DECIDE LAYOUT ----
      //
      // `layout` carries every property inspect.js reads. Sending all of them
      // would be a wall of defaults; these are the ones an alignment question is
      // actually answered by. See workshop/inspect.js LAYOUT_PROPS.
      if (e.layout) {
        const care = ['display', 'position', 'align-items', 'justify-content', 'margin', 'padding', 'width', 'text-align'];
        const said = care.filter((k) => e.layout[k]).map((k) => `${k}: ${String(e.layout[k]).trim()}`);
        if (said.length) lines.push(`  computed   ${said.join('; ')}`);
      }
      // THE PARENT DECIDES MOST ALIGNMENT, which is why inspect.js carries it:
      // a child that will not centre is usually a parent that is not a flex row.
      if (e.parent) {
        lines.push(`  parent     <${e.parent.tag}> display: ${e.parent.display}`
          + `${e.parent.justify ? `; justify-content: ${e.parent.justify}` : ''}`
          + `${e.parent.align ? `; align-items: ${e.parent.align}` : ''}`);
      }
    }
    // ---- THE REPORTS ARE SUMMARIES, NOT ARRAYS -------------------------
    //
    // `consoleReport` and `networkReport` return `{errors,total,entries}` and
    // `{total,failed,entries}` — already filtered to what is worth reading, and
    // already bounded. Treating them as raw arrays (which this did until a real
    // run printed `console undefined`) silently attaches nothing at all.
    const cons = obs.console || {};
    const errs = (cons.entries || []).slice(0, 5);
    if (errs.length) {
      lines.push('', `CONSOLE ERRORS ON THE PAGE (${cons.errors} of ${cons.total} entries):`);
      for (const e of errs) lines.push(`  ${String(e.text).slice(0, 200)}`);
    }
    const net = obs.network || {};
    const failed = (net.entries || []).slice(0, 5);
    if (failed.length) {
      lines.push('', `FAILED REQUESTS (${net.failed} of ${net.total}):`);
      for (const n of failed) lines.push(`  ${n.status} ${String(n.url).slice(0, 160)}`);
    }
    if (obs.viewport) lines.push('', `Observed at the ${obs.viewport} viewport.`);
    if (app.abort && !app.abort.signal.aborted) return bad('a turn is already running', 409);
    const composed = lines.join('\n');
    Promise.resolve(app.handle(composed, { from: 'harness-app' })).catch(() => {});
    return ok({ accepted: true, sent: composed });
  },
};

/**
 * Dispatch one request. Returns `{code, body}`; the server does the writing.
 *
 * UNKNOWN IS 404, not a fall-through. A path that half-matches a handler is how
 * an application quietly does the wrong thing.
 */
async function dispatch(app, method, pathname, body) {
  const key = `${String(method).toUpperCase()} ${pathname}`;
  const fn = ROUTES[key];
  if (!fn) return { code: 404, body: { ok: false, why: `no route ${key}` } };
  try {
    return await fn(app, body || {});
  } catch (e) {
    // A ROUTE THAT THREW IS REPORTED, NEVER SWALLOWED. The application shows the
    // sentence; the alternative is a button that does nothing for no stated
    // reason, which is indistinguishable from a broken build.
    return { code: 500, body: { ok: false, why: `${key}: ${(e && e.message) || e}` } };
  }
}

module.exports = { dispatch, ROUTES, ACTION_TIMEOUT_MS };
