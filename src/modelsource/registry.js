'use strict';

/**
 * WHICH CHAT SOURCES EXIST, AND WHICH ONE THIS SESSION IS USING.
 *
 * ------------------------------------------------------------------------
 * THE ONE ENTRY POINT. Everything outside `src/modelsource` reaches the model
 * sources through this file: the chat dispatcher, the `/source` command, the
 * status views, and — when it is built — the Harness frontend. Nothing else
 * constructs a source, so there is exactly one place that knows a web source
 * needs a browser and a runtime source needs a catalog.
 *
 * ------------------------------------------------------------------------
 * SELECTION IS SESSION STATE, AND IT IS TWO FACTS RATHER THAN ONE.
 *
 *   session.chatSource        which source answers chat turns
 *   session.sourceSelections  the model chosen FOR EACH source, kept apart
 *
 * Keeping the per-source choices apart is what makes switching cheap and
 * correct: going ChatGPT → Gemini → ChatGPT returns to the ChatGPT model that
 * was already chosen instead of asking again. And it is what makes the failure
 * honest — if that model is no longer in the account's list, the person is TOLD,
 * rather than being silently moved onto a different model whose answers they
 * would attribute to the one they picked.
 *
 * ------------------------------------------------------------------------
 * PER-APP, NEVER MODULE SCOPE. A source holds a browser holding a login. Two
 * Apps in one process must not share one, which is the same rule the session,
 * the checkpoints and the job list already follow.
 */

const contract = require('./contract');
const { SOURCE, LABEL, KIND, CONNECTION } = contract;

/** The sources this build knows about, in the order a picker should show them. */
const DECLARED = Object.freeze([
  { id: SOURCE.LAIN, kind: KIND.RUNTIME },
  { id: SOURCE.CHATGPT_WEB, kind: KIND.WEB },
  { id: SOURCE.GEMINI_WEB, kind: KIND.WEB },
]);

/** The site plan behind each web source. Declaration only — see websurface.js. */
const PLANS = Object.freeze({
  [SOURCE.CHATGPT_WEB]: () => require('./chatgpt'),
  [SOURCE.GEMINI_WEB]: () => require('./gemini'),
});

function store(app) {
  if (!app) return new Map();
  if (!app._modelSources) app._modelSources = new Map();
  return app._modelSources;
}

/**
 * THE SOURCE, BUILT ONCE PER APP.
 *
 * @param {object} opts.surface  an explicit surface, used by the conformance
 *   suite to drive the real orchestrator over the deterministic fixture. It is a
 *   parameter rather than a module-level switch so a test cannot accidentally
 *   leave production pointed at a fake.
 */
function get(app, sourceId, { surface = null } = {}) {
  const id = String(sourceId || '');
  const held = store(app);
  if (!surface && held.has(id)) return held.get(id);

  let made = null;
  if (id === SOURCE.LAIN) {
    made = new (require('./runtime').RuntimeModelSource)({ app });
  } else if (surface) {
    made = new (require('./webmodel').WebModelSource)({ surface, app, id, label: LABEL[id] || id });
  } else if (PLANS[id]) {
    const site = PLANS[id]();
    made = new (require('./webmodel').WebModelSource)({
      surface: site.surface({ browser: require('./webbrowser').forApp(app) }),
      app,
      id,
      label: LABEL[id] || id,
    });
  } else {
    return null;
  }
  held.set(id, made);
  return made;
}

/** Every declared source, as instances. */
function all(app) {
  return DECLARED.map((d) => get(app, d.id)).filter(Boolean);
}

/**
 * WHICH SOURCE ANSWERS A CHAT TURN.
 *
 * Defaults to LAIN, and that default is load-bearing: with nothing chosen, a
 * session behaves exactly as it did before web sources existed. Selecting a web
 * source is a deliberate act, and it is the only thing that changes a turn's
 * path.
 */
function selectedId(app) {
  const s = app && app.session;
  const want = s && s.chatSource ? String(s.chatSource) : SOURCE.LAIN;
  return DECLARED.some((d) => d.id === want) ? want : SOURCE.LAIN;
}

function selected(app) { return get(app, selectedId(app)); }

/** Is the chat source something other than LAIN's own runtime? */
function usingWeb(app) {
  const id = selectedId(app);
  const row = DECLARED.find((d) => d.id === id);
  return Boolean(row && row.kind === KIND.WEB);
}

/**
 * CHOOSE A SOURCE, and restore the model already chosen for it if there is one.
 *
 * Does NOT verify that model against the site — that costs a browser and a page
 * load, and a person switching source in a picker should not wait for one. The
 * verification happens where it matters: `send` re-selects the model on the page
 * and refuses if it will not take. See webmodel.js `_send`.
 */
function selectSource(app, sourceId) {
  const id = String(sourceId || '');
  if (!DECLARED.some((d) => d.id === id)) {
    return { ok: false, why: `"${id}" is not a chat source (${DECLARED.map((d) => d.id).join(', ')})` };
  }
  const s = app && app.session;
  if (!s) return { ok: false, why: 'no session' };
  s.chatSource = id;
  const model = (s.sourceSelections || {})[id] || null;
  if (id === SOURCE.LAIN && !model && app.cfg && app.cfg.model) {
    // Not a silent switch: the runtime source's model IS `cfg.model`, which the
    // person already chose with `/model`. Recording it makes that explicit.
    s.sourceSelections = { ...(s.sourceSelections || {}), [id]: app.cfg.model };
  }
  return { ok: true, source: id, model: (s.sourceSelections || {})[id] || null, why: '' };
}

/** Choose a model on a source. Delegates the real work to the source itself. */
async function selectModel(app, sourceId, modelId, opts = {}) {
  const src = get(app, sourceId);
  if (!src) return { ok: false, why: `"${sourceId}" is not a chat source` };
  return src.selectModel(modelId, opts);
}

/**
 * THE WHOLE PICTURE, FOR A FRONTEND.
 *
 * One shape per source, cheap by default — no browser is launched and no
 * catalog is refreshed. This is what a source picker renders, and it is
 * deliberately everything a picker needs and nothing about how any of it works:
 * no selector, no cookie, no profile path beyond the fact that one exists.
 */
async function overview(app, { open = false } = {}) {
  const chosen = selectedId(app);
  const rows = [];
  for (const src of all(app)) {
    let st;
    // eslint-disable-next-line no-await-in-loop -- three sources, and a status
    // call that opens a browser must not race two others doing the same.
    try { st = await src.status({ open: open && src.id === chosen }); } catch (e) {
      st = { source: src.id, label: src.label, kind: src.kind, state: CONNECTION.FAILED, why: (e && e.message) || String(e) };
    }
    rows.push({
      ...st,
      chosen: src.id === chosen,
      selected: src.selectedModel ? src.selectedModel() : null,
    });
  }
  return { selected: chosen, sources: rows };
}

module.exports = {
  DECLARED, get, all, selectedId, selected, usingWeb, selectSource, selectModel, overview,
  SOURCE, LABEL, KIND,
};
