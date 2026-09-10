'use strict';

/**
 * `/brief` — THE ENGINEERING BRIEFING.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS NOT CALLED `/steer`.
 *
 * `/steer` already exists and means something else entirely: it is how the user
 * corrects work that is ALREADY RUNNING, and the word is load-bearing across
 * `app.steerQueue`, `task.steers`, `plan.steer()`, the prompt's "the user has
 * since said" block and a smoke test of its own. `define()` throws on a
 * duplicate name, so registering a second `/steer` would not shadow the first —
 * it would take the binary down at startup.
 *
 * Beyond that, a user typing `/steer` to redirect a running task and receiving
 * a four-hundred-line project audit is exactly the one-word-two-meanings defect
 * this project's architecture guard exists to prevent. So the capability keeps
 * the name the request itself uses for the artifact — an engineering BRIEFING —
 * and `/steer` keeps meaning what it has always meant.
 * ------------------------------------------------------------------------
 *
 * WHAT IT IS FOR. Everything it reports is already obtainable: the parser, the
 * symbol model, the typo check, the residue scanner, the diff sensor and the
 * execution ledger are all reachable as tools. Obtaining it
 * that way costs six or eight tool calls and leaves the correlation to whoever
 * is reading. This does the collection and the correlation once, and hands over
 * a single document. (A browser was among these once, as a tool; it was removed
 * in 2026-09 and the list is shorter.)
 *
 * IT CHANGES NOTHING. Not one byte is written by any part of this. It is safe
 * during a turn for the same reason `/health` is.
 */

const survey = require('./survey');
const briefing = require('./briefing');
const findings = require('./findings');
const facts = require('./facts');

/** How long any one external analyser may take before it is called a timeout. */
const ANALYZER_TIMEOUT_MS = 120_000;

/**
 * Parse the flags.
 *
 * Deliberately few. Every option here is one the answer genuinely depends on:
 * whether to pay for the expensive sweep, whether a migration is being checked,
 * and whether to run the suite.
 */
function parseArgs(argv = '') {
  const raw = String(argv || '').trim();
  const opts = { deadCode: false, residue: null, tests: false, full: false, detail: false };
  const words = raw.split(/\s+/).filter(Boolean);
  const gone = [];
  const removed = [];
  const present = [];
  for (const w of words) {
    if (w === '--dead' || w === '--deadcode') { opts.deadCode = true; continue; }
    if (w === '--tests') { opts.tests = true; continue; }
    // The long form is still here; it stopped being the DEFAULT for a person.
    if (w === '--full' || w === '--long') { opts.full = true; continue; }
    // ---- WHERE THE `detail` PANE WENT --------------------------------------
    //
    // CONTEXT and DETAIL were two renderings of THIS survey, drawn as two of
    // the nine workspace panes (ui/contextview.js). CONTEXT carried identity,
    // state and counts; DETAIL carried the rows behind those counts — every
    // finding with its explanation, every changed file, what was NOT measured.
    //
    // The panes are gone, the renderings are not: `/brief` is CONTEXT and
    // `/brief detail` is DETAIL, off the same pass, so the two still cannot
    // describe the project differently.
    if (w === 'detail' || w === '--detail') { opts.detail = true; continue; }
    if (w.startsWith('--gone=')) { gone.push(...w.slice(7).split(',').filter(Boolean)); continue; }
    if (w.startsWith('--removed=')) { removed.push(...w.slice(10).split(',').filter(Boolean)); continue; }
    if (w.startsWith('--present=')) { present.push(...w.slice(10).split(',').filter(Boolean)); continue; }
  }
  if (gone.length || removed.length || present.length) opts.residue = { gone, removed, present };
  return opts;
}

/**
 * Run the project's own test command, when asked.
 *
 * Through the deterministic execution layer with argv as an array — the same
 * path every other command takes — so a failing suite comes back with its shell,
 * its directory and a classification rather than as an opaque non-zero.
 */
async function runTests(root, cfgCommand) {
  const command = cfgCommand || null;
  if (!command) return null;
  const { run } = require('./tools/shell');
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const r = await run(command, { shell, cwd: root, timeoutMs: 600_000 });
  return {
    ok: !r.isError,
    command,
    exitCode: r.exitCode,
    output: r.output,
  };
}

/**
 * Collect and render. Shared by the command and the tool so that the two can
 * never drift into two different briefings.
 *
 * @returns {Promise<{text, survey, delta}>}
 */
async function build(app, { argv = '', session = null, root: explicitRoot = null } = {}) {
  // The tool path knows the working directory as `ctx.cwd` and has no `app`
  // session to read it from, so it passes it explicitly. Falling back to
  // `process.cwd()` would survey whatever directory LAIN was launched in
  // rather than the one the session is working in.
  const root = explicitRoot || (app && app.session && app.session.cwd) || process.cwd();
  const opts = parseArgs(argv);
  const sess = session || (app && app.session) || null;

  let testRun = null;
  if (opts.tests) {
    let cmd = null;
    try {
      const env = require('./environment').detect(root);
      cmd = env.testRunner ? env.testRunner.command : null;
    } catch { cmd = null; }
    testRun = await runTests(root, cmd);
  }

  const s = await survey.run({
    root,
    app,
    session: sess,
    testRun,
    residue: opts.residue,
    includeDeadCode: opts.deadCode,
    timeoutMs: ANALYZER_TIMEOUT_MS,
  });

  // ---- STABLE IDS, AND WHAT CHANGED SINCE LAST TIME ----------------------
  //
  // The ledger lives on the session, so `ERROR #014` is still `ERROR #014` on
  // the second run and an instruction naming it does not rot. It also computes
  // the lifecycle: what is fixed, what is merely no longer observed, what is
  // new. Those three are different facts and the report keeps them apart.
  const ledger = findings.forSession(sess);
  const delta = ledger.record(s.findings, s.ran);
  // Facts get their own ledger and their own ids for the same reason findings
  // do — `CONTRACT #014` has to survive a regeneration — and it reports a
  // convention that has started answering differently, which is either a real
  // migration or a discoverer that is not stable.
  const factLedger = facts.forSession(sess);
  const factDelta = factLedger.record(s.facts || []);
  return {
    // THE LONG FORM IS THE MODEL'S. It is built either way, because the tool
    // returns it and because `--full` asks for it — but it is no longer what a
    // person is shown first. See ui/briefview.js on the two audiences.
    text: briefing.render(s, delta, factDelta),
    survey: s,
    delta,
    factDelta,
    opts,
  };
}

/** Register `/brief`. */
function register({ define, C }) {
  define('/brief', {
    // ---- MACHINERY GOES TO THE SURFACE ------------------------------------
    //
    // The same rule `/health` and `/audit` follow, and for the same reason: a
    // reading OF the project is not part OF the work, so it must not land in
    // the context the model reads. That is not a limitation on who can see the
    // briefing — the model reaches exactly the same document through the
    // `engineering_brief` tool, which is the path that belongs in a turn.
    // `flashMs: 0` because this is read rather than glanced at.
    surface: true,
    flashMs: 0,
    args: '[detail] [--tests] [--dead] [--full]',
    desc: 'Full engineering briefing: health on five axes, findings with ids and evidence, root causes',
    async run(app, ctx) {
      // `rest`, not `args`: the dispatcher hands `args` over as an ARRAY of
      // words and `rest` as the raw remainder. Reading `args` here would have
      // stringified an array into "--tests,--dead" and matched no flag at all.
      const argv = (ctx && ctx.rest) || '';
      app.render.write(C.dim('  Surveying the project…\n'));
      let out;
      try {
        out = await build(app, { argv });
      } catch (e) {
        app.render.write(C.red(`  The survey failed: ${(e && e.message) || e}\n`));
        return;
      }
      // ---- WHAT A PERSON SEES, AND WHAT A MODEL SEES ---------------------
      //
      // The default is the information-first view: what this project is,
      // whether anything is broken, what changed, what to run, what to do
      // next — scannable in a few seconds. The long evidence document is
      // unchanged and one flag away, and it is still exactly what the
      // `engineering_brief` tool returns to the model.
      if (out.opts.full) {
        app.render.write(`${out.text}\n`);
      } else if (out.opts.detail) {
        // THE EVIDENCE BEHIND THE COUNTS — what the DETAIL pane used to draw.
        // Same survey, second rendering; see `parseArgs`.
        const width = (app.render && app.render.width) || 80;
        app.render.write(`${require('./ui/contextview').render('detail', out.survey, {
          width, session: app.session, cwd: app.session && app.session.cwd,
        }).join('\n')}\n`);
      } else {
        const view = require('./ui/briefview');
        const width = (app.render && app.render.width) || 80;
        app.render.write(`${view.render(out.survey, {
          width, session: app.session, cwd: app.session && app.session.cwd,
        }).join('\n')}\n`);
      }
    },
  });
}

module.exports = { register, build, parseArgs, runTests, ANALYZER_TIMEOUT_MS };
