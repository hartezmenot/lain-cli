'use strict';

/**
 * THE PANE REPORTS — producing what CONTEXT and DETAIL show.
 *
 * Split out of ui/index.js because it is a different kind of work from handling
 * a keystroke: it reads the project tree and probes the running system, it is
 * asynchronous, and it has a caching rule of its own. The views themselves stay
 * pure — layout.js asks `screen.report` for the last completed pass and draws
 * whatever is there.
 *
 * THE RULE: a pass runs when a pane is OPENED, once, and never on a timer.
 * A pane nobody is looking at must cost nothing, and one that recomputed per
 * redraw would rescan the tree many times a second.
 *
 * ------------------------------------------------------------------------
 * WHAT WENT WRONG HERE, AND WHY IT LOOKED LIKE A TAB BUG.
 *
 * The CONTEXT branch was added at the TOP of `ensureReport` and read `app` —
 * which is declared with `const` eight lines FURTHER DOWN. That is a temporal
 * dead zone, so the line did not read a stale value or an undefined one: it
 * threw `ReferenceError: Cannot access 'app' before initialization`, every
 * single time, synchronously, on the keystroke that opened CONTEXT.
 *
 * The symptom was reported as "open Context, switch tabs, come back, LAIN
 * crashes", and the middle step is a red herring — the FIRST view is set at
 * startup without going through here, so the throw waits for the first
 * NAVIGATION to context, which is exactly what returning to the tab is.
 *
 * The consequences ran further than the crash. Because the pass threw before
 * it started, `screen.report.brief` was never set, so CONTEXT drew its
 * "surveying — reading the tree…" placeholder forever. The pane that was
 * supposed to say what is true about the project could only ever say that it
 * was about to find out.
 *
 * TWO FIXES, because one of them is not enough:
 *
 *   1. the ordering bug itself, which is the root cause
 *   2. a boundary that stops ANY future failure in a report from reaching the
 *      key handler. A report is a convenience — a pane that cannot read the
 *      tree should say so and leave the session running. Nothing drawn on a
 *      screen is worth taking the user's work down for.
 * ------------------------------------------------------------------------
 */

/**
 * Start the pass for `view` if it needs one.
 *
 * @param {object} ui     the UI (holds the app and the screen)
 * @param {string} view   the view being opened
 * @returns {Promise|null} the pass, for tests that want to await it
 */
function ensureReport(ui, view) {
  try {
    return start(ui, view);
  } catch (e) {
    // SEE THE HEADER. This catch exists because the thing it caught was a
    // ReferenceError in this very file, on the path a user takes several times
    // a minute. It is recorded rather than swallowed: a pane stuck on
    // "reading…" with no explanation is the state this whole comment is about.
    note(ui, view, e);
    return null;
  }
}

/** Why a pass did not happen, kept where the pane can say so. */
function note(ui, view, e) {
  try {
    if (!ui.screen.report.failed || typeof ui.screen.report.failed !== 'object') ui.screen.report.failed = {};
    ui.screen.report.failed[view] = String((e && e.message) || e).slice(0, 200);
  } catch { /* the recording of a failure must not be a second failure */ }
}

function start(ui, view) {
  // ONE DECLARATION, AT THE TOP, BEFORE ANY BRANCH READS IT.
  const app = ui.app;

  // CONTEXT and DETAIL are two RENDERINGS of one survey, not two passes — see
  // ui/contextview.js. Opening either starts the same read and fills the same
  // cache, so switching between them costs nothing and they can never describe
  // the project differently.
  if (view === 'context' || view === 'detail') return ensureBrief(ui, app);
  if (view !== 'audit' && view !== 'health') return null;
  // PENDING IS PER VIEW.
  //
  // It used to be ONE flag shared by both, so tabbing AUDIT → HEALTH while the
  // audit was still reading the tree meant health's pass was refused — and
  // nothing ever asked again. The pane then sat on "reading the project…" for
  // the rest of the session, which reads as a hang; and it happened every time,
  // because tabbing through the views is exactly how anyone reaches health.
  // Two independent reads need two independent flags.
  if (!ui._reportPending || typeof ui._reportPending !== 'object') ui._reportPending = {};
  if (ui._reportPending[view] || ui.screen.report[view]) return null;
  ui._reportPending[view] = true;
  const done = () => { ui._reportPending[view] = false; ui.screen.draw(); };

  if (view === 'audit') {
    const auditMod = require('../audit');
    return Promise.resolve(auditMod.audit(app && app.session ? app.session.cwd : process.cwd()))
      .then((a) => {
        ui.screen.report.audit = a;
        ui.screen.report.work = auditMod.workState(app);
      })
      // An unreadable tree leaves the pane saying "reading…", which is honest;
      // inventing an empty audit would read as "nothing here to worry about".
      .catch(() => { /* leave it unset */ })
      .then(done);
  }

  // The HEALTH pane is the PROJECT's health. LAIN's own readiness is `/rc` and
  // is deliberately not a workspace tab: it is a question about the tool, asked
  // once before a release, not something to keep on screen while working.
  return Promise.resolve(require('../projecthealth').assess(app && app.session ? app.session.cwd : process.cwd(), app))
    .catch(() => null)
    .then((h) => { if (h) ui.screen.report.health = h; })
    .then(done);
}

/**
 * The survey behind CONTEXT — the SAME one `/brief` runs.
 *
 * Deliberately not a second computation: the pane and the command must never be
 * able to describe the project differently.
 *
 * ------------------------------------------------------------------------
 * ONE PASS IN FLIGHT, AND A RE-ENTRY REUSES WHAT IS THERE.
 *
 * It used to start a fresh survey on EVERY entry into the pane, on the
 * reasoning that the tree moves underneath it. It does — but tabbing away and
 * back is not evidence that it did, and paying a full tree-and-git-and-
 * toolchain read for a keystroke means a person cycling the tabs sets several
 * concurrent surveys running over the same directory, each finishing in
 * whatever order it likes and each overwriting the last. That is the "state
 * mutated while the pane is being reconstructed" shape, and it is expensive
 * as well as unstable.
 *
 * So: one in flight, results reused, and `refresh(ui)` (`/brief`, or a new
 * turn) is what asks for a new one. `stale` records when the last pass ran, so
 * the pane can say how old what it is showing is instead of implying it is now.
 * ------------------------------------------------------------------------
 */
function ensureBrief(ui, app) {
  if (ui._briefPending) return ui._briefPending;
  // ---- STALE MEANS THE PROJECT MOVED, NOT THAT YOU LOOKED AGAIN ---------
  //
  // The two are easy to confuse and only one of them is evidence. Tabbing back
  // to CONTEXT tells us nothing about the tree; a turn having run, or files
  // having been written, tells us everything. So the cache is keyed on what
  // LAIN already knows it did, which costs two property reads.
  const key = workKey(app);
  if (ui.screen.report.brief && ui.screen.report.briefKey === key) return null;
  // ---- A RE-READ NEVER TAKES THE OLD REPORT OFF THE SCREEN --------------
  //
  // It used to clear the cached survey and then start a new one, so the pane
  // fell back to its "reading the tree…" placeholder for the whole of every
  // refresh. During an active turn that is close to permanent: files change on
  // every write, which moves the key, which threw the report away again — so
  // the pane a person opens DURING the work is exactly the pane that could
  // never show any.
  //
  // A survey a few seconds old is a good answer. A placeholder is not an answer
  // at all. So the old one stays up, `reading` says a newer one is on its way,
  // and it is replaced only when there is something to replace it with.
  ui.screen.report.briefKey = key;
  ui.screen.report.reading = true;
  // AND THE CHEAP FACTS ARE ON SCREEN BEFORE THE EXPENSIVE ONES START. See
  // quickFacts: about twenty milliseconds of directory walk, which is the
  // difference between a pane that says what this project is immediately and
  // one that says it is about to find out.
  if (!ui.screen.report.quick) {
    try { ui.screen.report.quick = quickFacts(app && app.session ? app.session.cwd : process.cwd()); } catch { /* thin is fine */ }
  }
  const build = require('../briefcommand').build;
  ui._briefPending = Promise.resolve()
    .then(() => build(app, { root: app && app.session && app.session.cwd }))
    .then((out) => {
      // A SURVEY THAT CAME BACK EMPTY IS NOT A SURVEY. Storing a partial or
      // absent result would leave the pane rendering fields off an object that
      // has none of them, which is the malformed-data crash rather than a
      // report that failed honestly.
      if (out && out.survey) {
        ui.screen.report.brief = out.survey;
        ui.screen.report.briefAt = Date.now();
      } else {
        note(ui, 'context', new Error('the survey produced no result'));
      }
    })
    .catch((e) => { note(ui, 'context', e); })
    // ---- ALWAYS, ON BOTH PATHS -------------------------------------------
    //
    // The flag was cleared inside `.then` and inside `.catch` separately, so a
    // failure in the `then` — a redraw throwing, say — left it set forever and
    // the pane never asked again. One place, no branches.
    .then(() => {
      ui._briefPending = null;
      ui.screen.report.reading = false;
      // AND THE REDRAW CANNOT BE THE THING THAT KILLS THE SESSION. This lands
      // asynchronously, possibly after the UI has been torn down or while
      // another view is being drawn, which is precisely when a refresh is most
      // likely to find something half-built.
      try { if (typeof ui.refresh === 'function') ui.refresh(); } catch { /* the draw will come round again */ }
    });
  return ui._briefPending;
}

/**
 * WHAT CAN BE SAID ABOUT A PROJECT IN TWENTY MILLISECONDS.
 *
 * The full survey reads the tree, the git state and the toolchain, and spawns
 * compilers to do it. That is a second here and can be several on a large
 * project — during which the pane had nothing at all to show, which is what
 * "can't see anything" meant.
 *
 * But almost nothing on the CONTEXT pane actually needs the expensive half.
 * Where the project is, what it is written in, and how to run it are a
 * directory walk and one file read: measured at 13ms, 7ms and 3ms on this
 * repository. So they go up FIRST, and the findings, the git diff and the
 * health axes fill in behind them.
 *
 * Bounded and never fatal. A count that cannot be taken is simply absent.
 */
function quickFacts(root) {
  const out = { root, languages: {}, detected: [], commands: [], at: Date.now() };
  try { out.languages = require('../langscan').languages(root); } catch { out.languages = {}; }
  try {
    out.detected = require('../tech').detect(root).slice(0, 5)
      .map((d) => ({ id: d.id, label: d.label, kind: d.kind, files: d.files }));
  } catch { out.detected = []; }
  try { out.commands = require('./briefview').runCommands(root, null); } catch { out.commands = []; }
  return out;
}

/**
 * HOW MUCH WORK HAS HAPPENED, as one short string.
 *
 * Turns taken and files written — both already tracked, both only move when
 * something real happened. Deliberately NOT a hash of the tree: that would be
 * the same directory walk the survey does, which is the cost this is avoiding.
 * It can therefore miss a change made outside LAIN, and that is the right
 * failure: showing a survey a few minutes old is a small wrong, and re-reading
 * the whole project on every keystroke is a large one.
 */
function workKey(app) {
  try {
    const s = app && app.session;
    if (!s) return '0:0';
    const life = s.lifecycle;
    const changed = life && life.evidence && life.evidence.filesChanged;
    const files = changed && typeof changed.size === 'number' ? changed.size : 0;
    return `${(s.turns || []).length}:${files}`;
  } catch { return '0:0'; }
}

/**
 * Throw away the cached survey so the next entry into CONTEXT re-reads.
 *
 * Called when something has actually changed the project — not on a timer and
 * not on a tab switch. Keeping the invalidation explicit is what stops the
 * "read it again every time you look at it" behaviour coming back.
 */
function refresh(ui) {
  try {
    ui.screen.report.brief = null;
    ui.screen.report.briefAt = 0;
    if (ui.screen.report.failed) delete ui.screen.report.failed.context;
  } catch { /* nothing cached, nothing to clear */ }
  return null;
}

module.exports = { ensureBrief, ensureReport, refresh, workKey, quickFacts };
