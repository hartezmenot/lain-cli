'use strict';

/**
 * CONTEXT IS WHAT YOU NEED TO KNOW. DETAIL IS EVERYTHING THAT WAS FOUND.
 *
 * ------------------------------------------------------------------------
 * THE MISTAKE THIS CORRECTS.
 *
 * The survey behind these panes reads the tree, the git state, the toolchain,
 * the findings, the environment and the test run. Every one of those is worth
 * having. It does not follow that every one of them is worth being the first
 * thing on screen — and the pane was showing all of it, because it was
 * rendered from the survey with nothing deciding what a person actually needed
 * at a glance.
 *
 * "It was discovered, so it is context" is the wrong rule. Discovery produces
 * a lot of true, low-value information: how many files were scanned, which
 * axes were not measured, the wording of every warning. A pane that leads with
 * that is a pane people stop reading, and then the ONE line that mattered —
 * the build is broken, the migration left the old implementation running — is
 * lost inside it.
 *
 *     CONTEXT   identity, structure, what is being worked on, what state it
 *               is in, the migration in flight, what to run, what to do next.
 *               Counts and pointers where the detail lives.
 *
 *     DETAIL    the findings themselves, the file-by-file changes, the
 *               verification evidence, the environment, what was NOT measured.
 *
 * NOT DUPLICATED. Where CONTEXT names a count — "3 errors" — DETAIL carries
 * the rows behind it, and only DETAIL carries them. Two panes showing the same
 * list is two places to read the same thing and one place for them to
 * disagree.
 * ------------------------------------------------------------------------
 *
 * ONE SURVEY, TWO RENDERINGS. Nothing here computes anything: both functions
 * read the survey ui/reports.js already produced, and the helpers come from
 * briefview.js rather than being written a second time. A second analysis
 * would be a second answer to "what is this project", which is exactly the
 * failure the pane and `/brief` were kept on one survey to avoid.
 */

const path = require('path');

const { doc } = require('./doc');
const { P } = require('./paint');
const briefview = require('./briefview');

/** Shown in CONTEXT before the reader is sent to DETAIL for the rest. */
const MAX_CONTEXT_CHANGES = 3;
/** Shown in DETAIL. Beyond this a list stops being read at all. */
const MAX_DETAIL_CHANGES = 40;
const MAX_DETAIL_FINDINGS = 30;

function toneFor(v) {
  const s = String(v || '').toUpperCase();
  if (s === 'PASS' || s === 'CLEAN') return P.ok;
  if (s === 'UNVERIFIED') return P.warn;
  if (s === 'FAILED' || s === 'DEGRADED') return P.bad;
  return null;
}

/** The languages this project is actually written in, biggest first. */
function stackOf(surveyOrQuick) {
  return Object.entries((surveyOrQuick && surveyOrQuick.languages) || {})
    .filter(([e]) => /^(?:js|ts|tsx|jsx|py|go|rs|java|rb|cs|php|cpp|c|h|hpp|kt|swift|vue|svelte)$/.test(e))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([e, n]) => `${e} (${n})`);
}

/** Findings by severity, as a count rather than as a wall of text. */
function severities(survey) {
  const counts = {};
  for (const f of (survey && survey.findings) || []) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return counts;
}

/**
 * THE MIGRATION IN FLIGHT, if there is one.
 *
 * This belongs in CONTEXT above almost everything else, and it is the clearest
 * case for the whole split. A migration is a claim about the project's FINAL
 * SHAPE that is only half true while it is running: the new implementation
 * exists and the old one has not gone yet. Somebody returning to the project —
 * or a model picking the task up — that does not know this is in progress will
 * read the duplicate implementations as a defect and "fix" one of them.
 *
 * Deliberately three lines at most. What is being migrated, how far along, and
 * what has not gone yet. The contract itself is a document, and this is not
 * the place to reprint it.
 */
function migrationRows(cwd) {
  try {
    const M = require('../migration');
    const c = M.latest(cwd || '');
    if (!c || c.stage === M.STAGE.COMPLETE || c.stage === M.STAGE.ROLLED_BACK) return null;
    const final = M.finalState(c);
    return {
      line: require('../migrationbrief').oneLine(c),
      stage: c.stage,
      outstanding: final.inactive.slice(0, 4),
      more: Math.max(0, final.inactive.length - 4),
      preserved: final.preserved.length,
    };
  } catch { return null; }
}

/**
 * THE LONG PARAGRAPHS ACTIVITY FOLDED, in the order they were said.
 *
 * Read from the session rather than from anything the feed kept, so what is
 * shown here is exactly what the model wrote — the fold is a DRAWING decision
 * and never touches the record. A turn recorded before folding existed simply
 * has nothing that qualifies.
 *
 * Bounded, like every other list in this file: past a point a pane of reasoning
 * is not read either.
 */
const MAX_DETAIL_REASONING = 12;
function foldedProse(session) {
  const turns = (session && session.turns) || [];
  const condense = require('./condense');
  const out = [];
  for (const t of turns) {
    const narration = Array.isArray(t.narration) ? t.narration : [];
    const lastSaid = narration.length ? narration[narration.length - 1] : null;
    for (const n of narration) {
      const text = String((n && n.text) || '');
      if (!text.trim()) continue;
      // The same question ACTIVITY asked. If it folded, the whole is owed here.
      if (!condense.fold(condense.prose(text, { last: n === lastSaid }),
        { last: n === lastSaid }).folded) continue;
      out.push(text);
    }
  }
  return out.slice(-MAX_DETAIL_REASONING);
}
// ------------------------------------------------------------- CONTEXT -----

function contextDoc(survey, { width, session, cwd, reading = false }) {
  const d = doc();
  const root = (survey && survey.root) || cwd || process.cwd();
  const H = (survey && survey.health) || {};

  // `reading…` sits in the corner while a NEWER pass is in flight, over the
  // report that is already up. The old behaviour — take the report away and
  // show a placeholder — answered a question nobody asked with nothing.
  d.title('context', reading ? `${path.basename(root)}  · re-reading` : path.basename(root));
  d.subtitle('What is true about this project right now');

  // ---- IDENTITY AND SHAPE ------------------------------------------------
  d.section('project');
  d.field('Root', root);
  const stack = stackOf(survey);
  if (stack.length) d.field('Stack', stack.join(', '));
  const env = survey && survey.environment;
  if (env && env.packageManager) d.field('Tooling', env.packageManager);
  // ---- THE MACHINE, NOT JUST THE PROJECT --------------------------------
  //
  // Which OS and which shell decide whether a command in this pane can be
  // pasted as written, and they are the first thing anybody returning to a
  // project has to re-establish. The model is already told (src/prompt.js
  // reads the same detector); the person reading CONTEXT was not.
  //
  // From the real detector, never from `process.platform` alone: "Windows" and
  // "powershell, also cmd, bash" are different facts, and only the second one
  // tells you what `&&` will do.
  try {
    const machine = require('../environment').detect(root);
    d.field('System', `${machine.os} · ${machine.shell.preferred}`);
  } catch { /* the pane is still worth drawing without it */ }

  // ---- WHAT IS BEING WORKED ON ------------------------------------------
  //
  // THE OBJECTIVE IS NOT HERE, and that is not an omission. The PINNED banner
  // above this pane already carries it and the plan progress, and never
  // scrolls (ui/layout.js bannerLines). Printing it again put the same sentence
  // on screen twice, which is the thing `PHASE A: the objective is on screen
  // ONCE` exists to stop — and it cost rows in the pane that has least to
  // spare.
  //
  // What the banner does NOT say is which STEP is being worked on, so that is
  // the one line worth adding under it.
  const plan = session && session.plan;
  const steps = (plan && plan.steps) || [];
  const active = steps.find((s) => s.status === 'active');
  if (active) {
    d.section('doing now');
    d.text(active.text);
  }

  // ---- THE MIGRATION, WHICH CHANGES HOW EVERYTHING ELSE READS -----------
  const mig = migrationRows(cwd);
  if (mig) {
    d.section('migration', mig.stage);
    d.text(mig.line);
    if (mig.outstanding.length) {
      d.field('Not yet gone', mig.outstanding.join(', ') + (mig.more ? ` (+${mig.more})` : ''), { tone: P.warn });
    }
    if (mig.preserved) d.field('Preserved', `${mig.preserved} resource(s) that must not change`);
  }

  // ---- IS ANYTHING BROKEN -----------------------------------------------
  d.section('state');
  for (const [label, key] of [['Build', 'build'], ['Tests', 'test'], ['Runtime', 'runtime'],
    ['Frontend', 'frontend'], ['Engineering', 'engineering']]) {
    d.field(label, H[key], { tone: toneFor(H[key]) });
  }
  const counts = severities(survey);
  const material = ['CRITICAL', 'ERROR', 'WARNING'].filter((s) => counts[s]).map((s) => `${counts[s]} ${s.toLowerCase()}`);
  d.field('Findings', material.length ? `${material.join(' · ')}   (DETAIL, 8)` : 'none', {
    tone: counts.CRITICAL || counts.ERROR ? P.bad : counts.WARNING ? P.warn : P.ok,
  });

  // ---- WHAT CHANGED, as a shape rather than a list ----------------------
  const git = survey && survey.git;
  if (git && git.ok && git.files.length) {
    d.section('changed', `${git.files.length} file(s) · ${git.totalLines} line(s)`);
    for (const f of git.files.slice(0, MAX_CONTEXT_CHANGES)) {
      d.field(`${f.untracked ? '+' : f.deleted ? '-' : 'M'} ${f.file}`, `+${f.added} -${f.removed}`,
        { tone: f.rewrite ? P.warn : null });
    }
    if (git.files.length > MAX_CONTEXT_CHANGES) d.note(`… ${git.files.length - MAX_CONTEXT_CHANGES} more in DETAIL (8)`);
  } else if (git && git.ok) {
    d.section('changed');
    d.field('Working tree', 'clean', { tone: P.ok });
  }

  // ---- HOW DO I RUN IT ---------------------------------------------------
  //
  // Kept in CONTEXT despite the trimming: it is short, it is actionable, and
  // it is the single thing most often wanted from a project you have not
  // touched in a week.
  const cmds = briefview.runCommands(root, survey);
  if (cmds.length) {
    d.section('run');
    for (const c of cmds.slice(0, 3)) d.field(c.label, c.cmd, { tone: P.cmd });
  }

  // ---- WHAT DO I DO NEXT -------------------------------------------------
  d.section('next');
  d.bullet(briefview.nextAction(survey, H), { mark: '→', tone: P.info });
  d.note('Findings, the full change list and the evidence behind them are in DETAIL (8). '
    + 'The conversation is in ACTIVITY (2).');

  return d.render(width);
}

// -------------------------------------------------------------- DETAIL -----

function detailDoc(survey, { width, cwd, session = null }) {
  const d = doc();
  const root = (survey && survey.root) || cwd || process.cwd();

  d.title('detail', path.basename(root));
  d.subtitle('The evidence behind CONTEXT — findings, changes and what was not measured');

  // ---- WHAT WAS ACTUALLY LOOKED AT --------------------------------------
  d.section('survey');
  d.field('Analysed', `${survey.scanned} source file(s)`);
  const langs = Object.entries(survey.languages || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (langs.length) d.field('By extension', langs.map(([e, n]) => `${e}:${n}`).join('  '));
  for (const n of (survey.notes || []).slice(0, 6)) d.note(n);

  // ---- THE FINDINGS THEMSELVES ------------------------------------------
  const findings = survey.findings || [];
  const ordered = [...findings].sort((a, b) => {
    const rank = { CRITICAL: 0, ERROR: 1, WARNING: 2, SUSPICIOUS: 3, UNVERIFIED: 4 };
    return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
  });
  if (ordered.length) {
    d.section('findings', `${ordered.length}`);
    for (const f of ordered.slice(0, MAX_DETAIL_FINDINGS)) {
      const tone = f.severity === 'CRITICAL' || f.severity === 'ERROR' ? P.bad
        : f.severity === 'UNVERIFIED' ? P.warn : P.warn;
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}  ` : '';
      d.bullet(`${f.severity}  ${where}${f.message}`, { mark: f.severity === 'UNVERIFIED' ? '·' : '!', tone });
      if (f.explanation) d.note(f.explanation);
    }
    if (ordered.length > MAX_DETAIL_FINDINGS) d.note(`… ${ordered.length - MAX_DETAIL_FINDINGS} more`);
  } else {
    d.section('findings');
    d.field('Found', 'none', { tone: P.ok });
  }

  // ---- EVERY CHANGED FILE ------------------------------------------------
  const git = survey.git;
  if (git && git.ok && git.files.length) {
    d.section('changed', `${git.files.length} file(s) · ${git.totalLines} line(s)`);
    for (const f of git.files.slice(0, MAX_DETAIL_CHANGES)) {
      d.field(`${f.untracked ? '+' : f.deleted ? '-' : 'M'} ${f.file}`, `+${f.added} -${f.removed}`
        + (f.rewrite ? '   WHOLE-FILE REWRITE' : '') + (f.generated ? `   ${f.generated}` : ''),
      { tone: f.rewrite ? P.warn : null });
    }
    if (git.files.length > MAX_DETAIL_CHANGES) d.note(`… ${git.files.length - MAX_DETAIL_CHANGES} more`);
  }

  // ---- WHAT WAS VERIFIED, AND WHAT WAS NOT ------------------------------
  d.section('verification');
  if (survey.testRun) {
    d.field(survey.testRun.ok ? 'Passed' : 'FAILED', survey.testRun.command,
      { tone: survey.testRun.ok ? P.ok : P.bad });
  } else {
    d.field('Tests', 'not run in this survey', { tone: P.warn });
  }
  // AN AXIS NOBODY MEASURED IS NOT AN AXIS THAT PASSED, and this is the pane
  // where that distinction is spelled out rather than folded into a colour.
  const unverified = findings.filter((f) => f.severity === 'UNVERIFIED');
  if (unverified.length) {
    d.field('Not measured', `${unverified.length} axis/axes — listed above with the reason`, { tone: P.warn });
  }

  // ---- THE MACHINE THIS RUNS ON -----------------------------------------
  const env = survey.environment;
  if (env) {
    d.section('environment');
    if (env.os) d.field('OS', env.os);
    if (env.shell && env.shell.preferred) d.field('Shell', env.shell.preferred);
    if (env.packageManager) d.field('Packages', env.packageManager);
    if (env.testRunner) d.field('Test runner', env.testRunner.command);
    if (env.venv) d.field('Virtualenv', String(env.venv));
    // `runtimes` is a { label: executable } map from environment.detectRuntimes.
    const runtimes = Object.entries(env.runtimes || {}).slice(0, 8);
    if (runtimes.length) d.field('Runtimes', runtimes.map(([k, v]) => `${k} (${v})`).join(', '));
  }

  // ---- ALL RUN COMMANDS --------------------------------------------------
  const cmds = briefview.runCommands(root, survey);
  if (cmds.length) {
    d.section('run');
    for (const c of cmds) d.field(c.label, c.cmd, { tone: P.cmd });
  }

  // ---- THE REASONING ACTIVITY FOLDED AWAY -------------------------------
  //
  // ACTIVITY shows the actionable part of a long analytical paragraph and a
  // pointer here (ui/condense.js `fold`, ui/feed.js). This is where the
  // pointer points. Without it the fold would be a quiet deletion wearing a
  // promise, which is the one thing the fold must not be.
  //
  // ONLY WHAT WAS ACTUALLY FOLDED. A paragraph short enough to have been
  // drawn whole in ACTIVITY is already on screen, and repeating it here
  // would make this pane a second transcript — which is what CONTEXT and
  // DETAIL were split apart to stop being.
  const folded = foldedProse(session);
  if (folded.length) {
    d.section('reasoning', `${folded.length}`);
    for (const t of folded) { d.text(t); d.text(''); }
  }
  d.section('next');
  d.note('CONTEXT (1) carries the summary of all of this. `/brief --full` prints the complete evidence.');
  return d.render(width);
}

// ------------------------------------------------------------- pending -----

/**
 * What a pane shows before the full survey has landed.
 *
 * NOT A PLACEHOLDER WHEREVER IT CAN AVOID BEING ONE. Four lines of "reading the
 * tree…" in an otherwise empty pane is the state a person complained about, and
 * it was wrong twice over: it is not information, and most of what the pane
 * exists to say does not need the expensive survey at all. `quick` is the
 * twenty-millisecond half (see ui/reports.js quickFacts) and it goes up
 * immediately; the rest fills in behind it.
 */
function pending(view, width, why = '', quick = null) {
  const d = doc();
  const isDetail = view === 'detail';
  d.title(isDetail ? 'detail' : 'context', why ? 'unavailable' : 'reading…');
  d.subtitle(isDetail
    ? 'The evidence behind CONTEXT'
    : 'What is true about this project right now');
  if (why) {
    // A PANE THAT CANNOT READ THE TREE SAYS SO. It used to sit on "reading…"
    // for the rest of the session, which is indistinguishable from a hang and
    // is how a hard error in this path stayed invisible.
    d.section('unavailable');
    d.text(`The project survey could not be produced: ${why}`);
    d.note('Everything else still works. /brief runs the same survey from the command line.');
    return d.render(width);
  }

  if (quick && quick.root) {
    d.section('project');
    d.field('Root', quick.root);
    const stack = stackOf(quick);
    if (stack.length) d.field('Stack', stack.join(', '));
    const frameworks = (quick.detected || [])
      .filter((t) => t.kind !== 'language')
      .map((t) => t.label);
    if (frameworks.length) d.field('Uses', frameworks.join(', '));

    const mig = migrationRows(quick.root);
    if (mig) {
      d.section('migration', mig.stage);
      d.text(mig.line);
      if (mig.outstanding.length) d.field('Not yet gone', mig.outstanding.join(', '), { tone: P.warn });
    }

    if ((quick.commands || []).length) {
      d.section('run');
      for (const c of quick.commands.slice(0, 3)) d.field(c.label, c.cmd, { tone: P.cmd });
    }
  }

  // ---- THE "STILL READING" LINE GOES LAST, AND IS ONE LINE ---------------
  //
  // It was a SECTION, with a heading and a sentence, sitting in the middle of
  // the pane — so the notice that the pane was not finished took more room
  // than several of the facts it was waiting on. Nobody needs a paragraph
  // about a one-second read.
  //
  // The corner of the title already says `reading…`, which is where a status
  // belongs. This is the footnote under the content, not a section competing
  // with it — and when there is nothing else yet it is the only thing here,
  // which is the one case where it should be.
  if (quick && quick.root) d.note('still reading the git state, the toolchain and the findings');
  else {
    d.section('reading');
    d.text('Reading the tree, the git state and the toolchain.');
    d.note('The conversation is in ACTIVITY (2).');
  }
  return d.render(width);
}

/**
 * The pane, whichever of the two it is.
 *
 * ONE ENTRY POINT so layout.js has one case for both and cannot end up with
 * two different notions of when a survey counts as present.
 */
function render(view, survey, { width = 80, session = null, cwd = '', failed = '', quick = null, reading = false } = {}) {
  if (!survey || typeof survey !== 'object') return pending(view, width, failed, quick);
  try {
    const lines = view === 'detail'
      ? detailDoc(survey, { width, cwd, session })
      : contextDoc(survey, { width, session, cwd, reading });
    return lines;
  } catch (e) {
    // MALFORMED OR PARTIAL SURVEY DATA MUST NOT TAKE THE SCREEN DOWN. The pane
    // is drawn on every redraw, so a field this does not expect would otherwise
    // crash the session on every frame rather than once.
    return pending(view, width, `the survey could not be rendered (${(e && e.message) || e})`, quick);
  }
}

module.exports = { render, pending, contextDoc, detailDoc, stackOf, severities, migrationRows };
