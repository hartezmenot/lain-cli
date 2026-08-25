'use strict';

/**
 * The tool registry. ONE vocabulary — there is no second list of names, no
 * parallel schema set, and no "advertised but not dispatchable" gap (V1 had 68
 * schemas against 78 dispatch entries).
 *
 * A tool is `{ mutates, schema, run(input, ctx) }` and returns
 * `{ output, isError?, mutated?[], meta? }`. `run` never throws for an ordinary
 * failure — a failure is a result the model should see.
 */

const shell = require('./shell');
const fsTools = require('./fs');
const editTools = require('./edit');
const search = require('./search');
// PROJECT INTELLIGENCE - `understand` and `locate`. Separated from search.js
// because they COMPOSE the primitives there rather than being more of them,
// and because that file crossed the god-object guard when they arrived.
const intel = require('./intel');
const ask = require('./ask');
const planTools = require('./plan');
const visualTools = require('./visual');
const jobTools = require('./jobs');
const execTools = require('./exec');
// SEMANTIC EDITS are always offered, like search and unlike `computer`: they
// need no bridge, no runtime and no configuration, and the alternative
// behaviour they replace — read a whole file to change one function, then write
// the whole file back — is the most expensive habit a model has on any task
// with code in it. See tools/semantic.js.
const semanticTools = require('./semantic');
// MIGRATION is always offered, for the same reason as semantic edits and for a
// sharper one. It needs no bridge and no configuration, and the behaviour it
// replaces is not merely expensive — it is WRONG: asked to migrate X to Y, a
// model writes Y, leaves X exactly where it was, and reports success truthfully
// about what it added and falsely about what was asked. A tool that only
// appeared once something detected a migration would be missing at the one
// moment that failure forms. See tools/migrate.js.
const migrateTools = require('./migrate');

// `visual_choice` is ALWAYS offered, unlike `computer` and `probe`. It needs no
// bridge — its candidates are images produced by whatever made them, a browser
// screenshot or a Python script — and the behaviour it replaces (capture,
// describe, adjust, repeat) is available to a model on any task with a picture
// in it. One schema on every request against a loop that can spend a whole
// budget is a trade worth making in one direction only.
// `observe_*` IS ALWAYS OFFERED TOO, for the same reason and a stronger one.
// It needs no bridge — a run that writes a log is watchable with no screen at
// all, and the capture rules simply record NOT SEEN when nothing can look. And
// it is the cheap alternative to a behaviour the model will otherwise invent
// for itself: watching a long run by screenshotting it in a loop. A tool that
// only appears once a Probe is connected would be missing at exactly the moment
// the expensive habit forms.
const observeTools = require('./observe');
// TESTS ARE ALWAYS OFFERED, for the sharpest version of the reason semantic
// edits are. What they replace is not an expensive habit but a FALSE REPORT:
// "there are no tests" said about a tree with 179 of them, and "all tests pass"
// said about a run that never happened. Both were reachable because discovery
// and execution had no vocabulary of their own — see testing.js. A tool that
// only appeared once something had detected a test suite would be missing at
// exactly the moment the model decides there is nothing to detect.
const testTools = require('./tests');
// THE DURABLE LAYER — `concept`, `architecture`, `wiring`, `scratch` — is always
// offered, for the same reason and for the one the compaction design turns on:
// the knowledge these hold is exactly the knowledge a conversation loses, so a
// tool that appeared once something had detected a vocabulary would be missing
// at the moment the definition was in hand — and the moment after a compaction
// is the moment a model most needs what a previous context recorded. They write
// only LAIN's own .lain/ state (lainstore.js), never user source. See
// tools/concept.js for why they are four tools and one family.
const conceptTools = require('./concept');

const TOOLS = {
  ...fsTools.tools, ...editTools.tools, ...search.tools, ...intel.tools, ...shell.tools,
  ...planTools.tools, ...ask.tools, ...visualTools.tools, ...jobTools.tools,
  ...execTools.tools, ...observeTools.tools, ...semanticTools.tools,
  ...migrateTools.tools, ...testTools.tools, ...conceptTools.tools,
};

/**
 * THE ACTIVE VOCABULARY — still ONE list, computed in one place.
 *
 * ONE NAME FOR THE MACHINE, and it is `computer`.
 *
 * There used to be three. `desktop` was advertised whenever an MCP bridge was
 * configured, `probe` whenever a Probe was running, and `computer` for either —
 * so a model with a Probe up was offered BOTH `computer{op:"key"}` AND
 * `probe{op:"input.keyboard.tap"}`, and with a bridge configured both
 * `computer{op:"click"}` and `desktop{op:"mouse.click"}`. Three ways to press
 * one key is not three capabilities; it is one capability the model has to
 * guess its way through, and a guess that lands on the wrong spelling is a
 * keystroke that goes nowhere with no way to tell why.
 *
 * `computer` covers everything `desktop` did AND OCR, over either transport —
 * computer.js owns the dialect for both — so this is pure subtraction. The
 * bridge did not go away; it stopped being a second vocabulary.
 *
 * A model on an ordinary coding task is still never told it can control the
 * machine: `computer` appears only when a transport is live. Every function
 * below reads THIS, so schemas and dispatch cannot drift apart — the property
 * the architecture guard checks.
 */
function active(ctxApp) {
  let mcpConfigured = false;
  try { mcpConfigured = require('../mcp').configured(require('../config').load()); } catch { mcpConfigured = false; }
  let out = TOOLS;
  // `probe` follows the CONNECTION, not the configuration. `desktop` can be
  // advertised while merely configured because its tool connects the bridge
  // lazily on first use; the Probe is started by the user with `/mcp probe` and
  // opens a window, so advertising one that is not running would offer the
  // model an investigation it cannot perform.
  let probeLive = null;
  try { probeLive = require('../probe').live(); } catch { probeLive = null; }
  // The PROBE environment keeps the Probe's vocabulary even when the connection
  // has dropped: the environment deliberately survives a disconnect, so the
  // model must still be able to call probe ops (and get an honest error) and
  // reach probe_bridge_cli. Withdrawing the vocabulary here would turn a dropped
  // connection back into the accidental-CLI-fallback this gate exists to stop.
  const envIsProbe = (() => {
    try { return require('../environment').describe(ctxApp()).isProbe; } catch { return false; }
  })();
  if (probeLive || envIsProbe) out = { ...out, ...require('./probe').tools };
  // `computer` FOLLOWS EITHER TRANSPORT, because it is LAIN's operation and not
  // any bridge's: the model asks to click or to look, and LAIN decides which of
  // the connected bridges carries it. That is the whole ownership correction —
  // screen and input are how anyone uses a computer, while memory, breakpoints
  // and findings genuinely are the Probe's domain and keep the `probe` tool.
  if (probeLive || mcpConfigured) out = { ...out, ...require('./computer').tools };
  // `browser` follows the RUNTIME, like `probe` and unlike `desktop`: the user
  // starts LAIN's Chromium with /external browser, and a model told it can drive
  // a browser that is not running will try.
  let browserLive = null;
  try { browserLive = require('../browser').live(); } catch { browserLive = null; }
  if (browserLive) out = { ...out, ...require('./browser').tools };
  // ---- LOOKING SOMETHING UP, and the two halves follow different rules ----
  //
  // `web_fetch` is a plain HTTP GET: no browser, no profile, no cookies. It
  // works headless, in CI and over SSH, so it is always offered — a question
  // whose answer is in a changelog should never have to be answered from a
  // training cut-off. See src/research.js for what leaves and who is told.
  //
  // `web_search` FOLLOWS THE RUNTIME, like `browser` and `probe`, because it
  // drives that same Chromium. Search engines are the one part of the web that
  // is actively hostile to a bare socket, and offering a model a search it
  // cannot perform is offering it a way to waste a step.
  out = { ...out, ...require('./web').fetchTools };
  if (browserLive) out = { ...out, ...require('./web').searchTools };
  return out;
}

/**
 * Schemas sent to the model. Same source as dispatch, so they cannot drift.
 *
 * THE APP IS THE CONTEXT, and the Probe vocabulary rides the session's
 * environment, so every reader forwards the App it is working for. A reader
 * with none (a unit test, a cold start) gets the connection-only vocabulary,
 * which is the same answer it always gave.
 */
function schemas(app) {
  return Object.values(active(() => app)).map((t) => t.schema);
}

function has(name, app) { return Object.prototype.hasOwnProperty.call(active(() => app), name); }
function isMutating(name, app) { const t = active(() => app)[name]; return Boolean(t && t.mutates); }
function names(app) { return Object.keys(active(() => app)); }

/**
 * Execute one call. An unknown name is a normal, recoverable result — the model
 * gets told what does exist and picks again.
 */
async function execute(name, input, ctx) {
  // The vocabulary must include the Probe's own tools whenever the session is
  // IN the PROBE environment, connected or not — see the note inside active().
  const tool = active(() => (ctx && ctx.app) || null)[name];
  if (!tool) {
    return { output: `unknown tool "${name}". Available: ${names(ctx && ctx.app).join(', ')}`, isError: true };
  }
  // ---- MAY THIS TOUCH THAT PATH? ------------------------------------------
  //
  // ONE GATE, HERE, because this is the one door every tool call goes through.
  // The alternative was a check at each `resolve()` — four in fs.js, more in
  // edit.js and search.js — which is six places to keep in step and one place
  // to forget. A tool added tomorrow is covered without its author knowing the
  // gate exists.
  //
  // It answers only about the FILESYSTEM. Whether the screen may be seen is
  // permissions.js's question and is asked elsewhere; whether a directory is
  // ours to work in is trust.js's, and is asked here.
  // ---- WHOSE TASK IS THIS? --------------------------------------------------
  //
  // The second gate at the same door, beside the filesystem one. While the
  // session's execution environment is PROBE (environment.js), investigation
  // work belongs to the Probe's own tool surface; a CLI tool is refused HERE
  // rather than left to compete, because the measured failure was exactly that —
  // an investigation task answered with filesystem searches. `probe.bridge_cli`
  // is the one explicit door back out, so a genuine shell need costs a named,
  // deliberate call instead of a silent fallback.
  const envVerdict = require('../environment').checkToolAllowed(name, ctx && ctx.app);
  if (!envVerdict.ok) return { output: envVerdict.output, isError: true };

  const verdict = await require('../gate').check(name, input, ctx, { mutates: Boolean(tool.mutates) });
  if (!verdict.ok) return { output: verdict.output, isError: true };
  let r;
  try {
    r = await tool.run(input && typeof input === 'object' ? input : {}, ctx);
    r = r && typeof r === 'object' ? r : { output: String(r == null ? '' : r) };
  } catch (e) {
    return { output: `${name} failed: ${(e && e.message) || e}`, isError: true };
  }
  // ---- DID THE WRITE LEAVE THE FILE PARSEABLE? ----------------------------
  //
  // HERE FOR THE SAME REASON THE GATE IS: every tool that writes comes through
  // this door and reports what it touched in `mutated`, so one check covers
  // eight edit tools and whatever is added next. Per-tool checks would be eight
  // copies to keep in step and one to forget.
  //
  // The result is APPENDED, never converted into an error: the file really was
  // written, and calling the write a failure would be a false report the model
  // would then try to undo. What it changes is when the breakage is discovered
  // — at the edit, rather than by whatever expensive thing runs next.
  //
  // Silent unless the file genuinely does not parse. See diagnostics.js on why
  // saying nothing is the default.
  if (r.mutated && r.mutated.length && !r.isError) {
    try {
      const note = await require('../diagnostics').reportFor(r.mutated, ctx && ctx.cwd);
      if (note) r = { ...r, output: String(r.output || '') + note, syntaxError: true };
    } catch { /* a checker that fails must never fail the edit it was checking */ }
    // ---- AND THE THIRD RUNG: THE PROJECT'S OWN LINTER, ON THIS FILE --------
    //
    // The two rungs above answer "does it parse" and "does every name resolve",
    // and the second is only built for JavaScript. So a Python file containing
    //
    //     pirnt("hello")
    //
    // passed both and reached the model as a clean write — the defect was then
    // discovered by RUNNING it, which costs a suite, a stack trace and a turn
    // spent working backwards to a typo `ruff` names in eight milliseconds.
    //
    // ONLY WHAT THE PROJECT ALREADY HAS, only ever the one file, and only fast
    // tools: `tsc` and `cargo check` are stronger and are deliberately not here,
    // because both are whole-project and would make editing a large repository
    // unusable. See filecheck.js for all three rules.
    //
    // NOT `syntaxError`. A lint finding is not a broken file, and the flag that
    // says "this write did not produce something loadable" must keep meaning
    // that or the surfaces reading it start over-reporting.
    try {
      const lint = await require('../filecheck').reportFor(r.mutated, ctx && ctx.cwd);
      if (lint) r = { ...r, output: String(r.output || '') + lint, diagnostics: true };
    } catch { /* same rule: a checker may never fail the edit it was checking */ }
  }
  return r;
}

module.exports = { TOOLS, active, schemas, execute, has, isMutating, names };
