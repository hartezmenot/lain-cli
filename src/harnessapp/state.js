'use strict';

/**
 * WHAT THE HARNESS APPLICATION IS TOLD — a read model, and nothing else.
 *
 * ------------------------------------------------------------------------
 * THE RULE THAT SHAPES THIS FILE, AND IT IS THE WHOLE ARCHITECTURE.
 *
 * The frontend owns UI STATE ONLY. Which lane is showing, which panel is open,
 * what is scrolled where — those are the browser's. Everything else is read
 * from the authority that already owns it, projected, and handed over:
 *
 *   tasks / activity / verification / artifacts   harnesssurface.js  (the Harness)
 *   processes                                     the same projection
 *   sessions                                      sessionindex.js
 *   the conversation                              session.turns / session.messages
 *   changes on disk                               ui/panes.changedFiles (checkpoints)
 *   model sources and their models                modelsource/registry.js
 *   the Workshop's browser and dev server         workshop/index.js
 *   goal and plan                                 goal.js / session.plan
 *
 * NOT ONE of those is recomputed here. This file reshapes; it never decides. A
 * second opinion about whether a task passed would be a second answer to the
 * question the whole program exists to answer honestly.
 *
 * ------------------------------------------------------------------------
 * IT IS CHEAP, BECAUSE IT IS POLLED.
 *
 * The application asks for this on a timer. So nothing here opens a browser,
 * launches a dev server, refreshes a catalog or contacts a website. Model
 * DISCOVERY is a paid operation and is a separate, explicit route — see
 * routes.js. `overview` is the cheap read that only reports what is already
 * known.
 *
 * ------------------------------------------------------------------------
 * NO SECRETS CROSS THIS BOUNDARY. Same rule as dash.js: no credential, no
 * cookie, no profile contents, no raw provider payload. The redaction filter
 * still sits on the writers, and this deliberately carries nothing that would
 * need it.
 */

const path = require('path');

/** How many sessions a lane lists. A sidebar, not an archive browser. */
const SESSION_LIMIT = 40;
/** How many conversation turns the app is handed at once. */
const TURN_LIMIT = 200;
/** How much of one message body travels. The app renders prose, not a log. */
const MESSAGE_CHARS = 20_000;

/**
 * WHICH LANE A SESSION BELONGS TO.
 *
 * ONE MARKER DECIDES IT, and it is Astra's: `session.cowork` is the binding
 * their runtime writes (src/cowork/sessionstate.js). Everything without one is
 * an ENGINEERING session — which is the right default, because that is what a
 * session in this program has always been.
 *
 * NOTHING HERE INFERS A LANE FROM THE WORK. A session that happens to have
 * edited a spreadsheet is not a Cowork session; a session Astra bound to
 * Telegram is. Guessing would put a person's engineering history in the wrong
 * list, and the marker exists precisely so nobody has to guess.
 */
function laneOf(data) {
  const c = data && data.cowork;
  return c && c.lane === 'cowork' ? 'cowork' : 'engineering';
}

/**
 * THE SESSION LISTS, one per lane.
 *
 * Read through sessionindex.js — the same summaries `/resume` shows — so the
 * application and the terminal cannot disagree about what a session was.
 */
function sessions(app, { limit = SESSION_LIMIT } = {}) {
  let rows = [];
  try {
    rows = require('../sessionindex').summaries({ limit: Math.min(limit, 200) }) || [];
  } catch { rows = []; }
  const current = app && app.session ? app.session.id : null;
  const out = { engineering: [], cowork: [] };
  for (const s of rows) {
    const lane = laneOf(s.data || s);
    const entry = {
      id: s.id,
      short: s.short || (s.id || '').split('-').pop(),
      title: s.headline || s.objective || '(no objective recorded)',
      project: s.cwd ? path.basename(s.cwd) : '',
      cwd: s.cwd || '',
      when: s.when && s.when.text ? s.when.text : '',
      turns: s.turns || 0,
      current: s.id === current,
      // REMOTE ORIGIN, and only when Astra actually recorded one. `harness`
      // means the person started it here; the rest name where it came from.
      source: lane === 'cowork' ? ((s.data && s.data.cowork && s.data.cowork.source) || 'harness') : null,
    };
    out[lane].push(entry);
  }
  return out;
}

/** The conversation, as the application renders it. Bounded, and prose only. */
function conversation(session) {
  if (!session) return [];
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  const out = [];
  for (const m of msgs.slice(-TURN_LIMIT)) {
    if (!m || m.role === 'system') continue;
    // TOOL RESULTS ARE NOT CONVERSATION. They are the bulk, they are already
    // summarised by the activity projection, and shipping them here would make
    // every poll carry a file body.
    if (m.role === 'tool') continue;
    const body = String(m.content || '');
    if (!body.trim()) continue;
    out.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: body.slice(0, MESSAGE_CHARS),
      at: m.ts || null,
      // WHO ANSWERED, when it was not LAIN's own runtime. Stamped at execution
      // time by chatdispatch.js and carried on the message ever since.
      provenance: m.provenance ? { label: m.provenance.label, source: m.provenance.sourceId } : null,
    });
  }
  return out;
}

/** Files this session has actually changed, from the checkpoint ledger. */
function changes(app) {
  try {
    return require('../ui/panes')
      .changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd })
      .map((f) => ({ path: f.rel, kind: f.kind, added: f.added, removed: f.removed }));
  } catch { return []; }
}

/**
 * THE CHAT SOURCES, cheaply.
 *
 * `registry.overview` launches nothing and refreshes nothing — see its header.
 * The MODEL LISTS are absent here on purpose: discovering what a logged-in
 * account offers is a paid operation behind an explicit route.
 */
async function sources(app) {
  try {
    const view = await require('../modelsource/registry').overview(app);
    return {
      selected: view.selected,
      sources: view.sources.map((s) => ({
        id: s.source,
        label: s.label,
        kind: s.kind,
        state: s.state,
        why: s.why || '',
        model: s.selected || null,
        chosen: Boolean(s.chosen),
        capabilities: s.capabilities || null,
      })),
    };
  } catch (e) {
    return { selected: 'lain', sources: [], why: (e && e.message) || String(e) };
  }
}

/** The Workshop, if one is open for this project. Never opens one. */
function workshop(app) {
  try {
    const ws = require('../workshop').forApp(app);
    const cwd = app.session.cwd;
    const live = ws.existing(cwd);
    const avail = ws.availability();
    return {
      available: Boolean(avail.available),
      why: avail.why || '',
      open: Boolean(live),
      url: live ? (live.url || null) : null,
      viewport: live ? (live.viewport || 'desktop') : null,
      observations: live ? ws.observations(cwd) : null,
      before: Boolean(ws.before(cwd, live ? live.viewport || 'desktop' : 'desktop')),
    };
  } catch (e) {
    return { available: false, why: (e && e.message) || String(e), open: false };
  }
}

/**
 * THE ONE LIVE OPERATIONAL ROW, PROJECTED FOR THE FRONTEND.
 *
 * ------------------------------------------------------------------------
 * THE SAME FUNCTIONS THE TERMINAL DRAWS FROM, NOT A SECOND OPINION.
 *
 * `ui/status.js liveState` is the authority on what is happening right now and
 * on the precedence between six things that could all be true at once; the
 * window title already derives from it (src/termtitle.js `stateOf`) precisely
 * so the title and the row cannot disagree. This is a THIRD reader of the same
 * value, for the same reason.
 *
 * Deriving it here instead — checking `app.abort` for "is it running", say —
 * would produce a Harness that says RUNNING while the terminal says RATE
 * LIMITED, and the two would drift apart one special case at a time. There is
 * no separate CLI-vs-Harness alert semantics to build.
 *
 * `alert` is carried ALONGSIDE the row rather than folded into it, because the
 * frontend needs to know whether a resting alert is resumable to decide what a
 * button offers — continue, or retry.
 */
function execution(app) {
  const idle = { word: 'READY', detail: '', level: 'idle', spin: false, clock: null, alert: null };
  try {
    const ui = app.ui;
    if (!ui || !ui.enabled) return idle;
    const live = require('../ui/status').liveState(require('../ui/projection').statusState(ui));
    const rest = require('../ui/alert').resting(ui);
    return {
      word: live.word || 'READY',
      detail: live.detail || '',
      // The colour vocabulary is the strip's own — 'bad' and 'warn' are what
      // liveState emits — mapped once, here, to the two words this brief uses.
      level: live.colour === 'bad' ? 'red' : live.colour === 'warn' ? 'amber' : (live.spin ? 'working' : 'idle'),
      spin: Boolean(live.spin),
      clock: require('../ui/workclock').reading(ui.clock),
      // NULL WHEN NOTHING IS RESTING, so the frontend cannot render a stale
      // warning it was handed as an empty object.
      alert: rest.level ? { level: rest.level, word: rest.word, resumable: rest.resumable } : null,
    };
  } catch (e) {
    return { ...idle, detail: (e && e.message) || String(e) };
  }
}

/**
 * WHERE THIS SESSION'S WORK RUNS, AND WHICH BROWSER RUNS IT.
 *
 * ------------------------------------------------------------------------
 * DELIBERATELY SMALL. §12: expose the environment SUBTLY, not as a VMware
 * dashboard. Three facts fit beside a model name —
 *
 *     toradb
 *     glm-5.3-flash
 *     VM · READY
 *
 * — and everything else belongs in `/env`, which already exists and is already
 * the diagnostic surface. A second, richer environment panel in the frontend
 * would be a second projection of the same truth, drifting.
 *
 * CHEAP, because this is polled: it stats files and reads the runtime's own
 * instance list. It never starts a VM, never launches a browser and never
 * calls `vmrun` — asking a hypervisor for its state on a 1.5s timer would be a
 * subprocess per poll.
 */
function environment(app) {
  try {
    const chromium = require('../env/chromium').forApp(app);
    const h = chromium.health();
    const task = (() => {
      try {
        const harness = require('../harnesslink').existing(app);
        const t = harness && harness.runtime && harness.runtime.latest ? harness.runtime.latest() : null;
        return (t && t.environment) || 'host';
      } catch { return 'host'; }
    })();
    const vm = require('../env/environments').parse(task);
    return {
      task,
      kind: vm.ok && vm.kind === 'vm' ? 'vm' : 'host',
      // VMware's real state is NOT polled — see the header. This says only
      // whether a VM environment is even registered, which is a config read.
      vms: require('../env/environments').list().filter((e) => e.kind === 'vm').length,
      browser: h.browser
        ? { version: h.browser.version, owned: h.browser.owned, source: h.browser.source }
        : null,
      why: h.available ? '' : h.why,
      running: (h.running || []).filter((i) => i.state === 'RUNNING').map((i) => i.purpose),
    };
  } catch (e) {
    return { task: 'host', kind: 'host', vms: 0, browser: null, why: (e && e.message) || String(e), running: [] };
  }
}

/**
 * EVERYTHING THE APPLICATION POLLS FOR.
 *
 * One shape, so the frontend has one thing to hold and one place to look. The
 * halves that are expensive are absent by construction rather than by a flag.
 */
async function read(app) {
  const s = app.session;
  const harness = (() => {
    try { return require('../harnesssurface').project(app); } catch { return null; }
  })();
  const goalText = (() => {
    try { return require('../goal').text(s); } catch { return ''; }
  })();
  return {
    at: Date.now(),
    // WHICH SESSION IS OPEN IN THE TERMINAL. The application does not get to
    // change this: `/resume` is how a session becomes current, and a second way
    // in would be a second answer to "which session am I in".
    current: {
      id: s.id,
      lane: laneOf(s),
      project: path.basename(s.cwd || ''),
      cwd: s.cwd,
      goal: goalText,
      turns: (s.turns || []).length,
      cowork: s.cowork ? { source: s.cowork.source } : null,
    },
    sessions: sessions(app),
    conversation: conversation(s),
    changes: changes(app),
    sources: await sources(app),
    workshop: workshop(app),
    // THE LIVE OPERATIONAL ROW. One state, shared with the terminal and the
    // window title — see `execution` above.
    execution: execution(app),
    // WHERE THE WORK RUNS. Small on purpose — see `environment` above.
    environment: environment(app),
    // THE HARNESS'S OWN PROJECTION, passed through untouched. `null` means no
    // task — which is a fact, and is drawn as one rather than as an empty task.
    harness,
    plan: s.plan && s.plan.steps && s.plan.steps.length
      ? {
        live: s.plan.isLive,
        done: s.plan.completed.length,
        total: s.plan.steps.length,
        steps: s.plan.steps.slice(0, 40).map((x) => ({ text: x.text, status: x.status, origin: x.origin || 'llm' })),
      }
      : null,
    // ---- COWORK, AND EXACTLY WHAT ASTRA HAS BUILT ----------------------
    //
    // Their contract today (src/cowork/sessionstate.js) is a SOURCE BINDING and
    // nothing more: which transport a session came from. There is no task,
    // artifact, approval or job surface behind it yet.
    //
    // So the application lists Cowork sessions and names their source, and says
    // plainly that the rest is not available. Rendering an approvals panel over
    // a backend that has none would be inventing a capability, which is the one
    // thing this projection must never do.
    cowork: {
      contract: 'source-binding-v1',
      capabilities: { sessions: true, tasks: false, artifacts: false, approvals: false, jobs: false },
      why: 'Astra has bound Cowork sessions to a source; the task and artifact surface is not implemented yet.',
    },
  };
}

module.exports = { read, sessions, conversation, changes, sources, workshop, execution, environment, laneOf, SESSION_LIMIT, TURN_LIMIT };
