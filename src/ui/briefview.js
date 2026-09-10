'use strict';

/**
 * `/brief`, FOR A PERSON — the same survey, laid out to be scanned.
 *
 * ------------------------------------------------------------------------
 * TWO AUDIENCES, ONE SET OF FACTS.
 *
 * The `engineering_brief` TOOL produces a long, dense document on purpose: a
 * model reads it once, in full, and every finding it omits is a tool call the
 * model has to spend rediscovering it. That is the right shape for a reader
 * with no eyes and infinite patience.
 *
 * A PERSON is the opposite reader. They glance. They want to know what this
 * project is, whether anything is broken, what changed, and what to run — in a
 * few seconds, without reading a page of evidence to find out.
 *
 * So this is a second RENDERING, not a second survey. Both come from
 * `survey.run()`; neither recomputes anything the other established. The long
 * form is still there behind `--full`, because the evidence has not gone
 * anywhere — it has stopped being the first thing a human is shown.
 * ------------------------------------------------------------------------
 *
 * NOTHING IS INVENTED. A run command that the repository does not establish is
 * reported as not detected rather than guessed at, for the same reason the
 * operational contract reports UNKNOWN: a wrong `npm run dev` is worse than no
 * answer, because somebody runs it.
 */

const fs = require('fs');
const path = require('path');

const { doc } = require('./doc');
const { P } = require('./paint');

/** Enough to see the shape of the work; the rest is behind --full. */
const MAX_CHANGES = 6;
const MAX_ATTENTION = 5;
const MAX_RUN = 6;

/** The bar used for a proportion. Blocks, not percentages alone. */
function bar(fraction, width = 20) {
  const n = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(n) + '░'.repeat(width - n);
}

function toneFor(v) {
  const s = String(v || '').toUpperCase();
  if (s === 'PASS' || s === 'CLEAN') return P.ok;
  if (s === 'UNVERIFIED') return P.warn;
  if (s === 'FAILED' || s === 'DEGRADED') return P.bad;
  return null;
}

/**
 * HOW TO RUN THIS, read from the repository.
 *
 * package.json scripts are the only place a JavaScript project actually
 * declares this, so they are read directly rather than inferred. A project
 * without them gets an honest "not detected" instead of a plausible guess.
 */
function runCommands(root, survey) {
  const out = [];
  const seenCmd = new Set();
  const seenLabel = new Set();
  // DEDUPED BY LABEL AS WELL AS BY COMMAND. `npm run test` and `npm test` are
  // two spellings of one thing, and listing both under "test" makes a reader
  // wonder which is correct — which is the opposite of the point of this
  // section. First one wins, and the order below is deliberate.
  const add = (label, cmd) => {
    if (!cmd || seenCmd.has(cmd) || seenLabel.has(label)) return;
    seenCmd.add(cmd);
    seenLabel.add(label);
    out.push({ label, cmd });
  };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const scripts = (pkg && pkg.scripts) || {};
    // Ordered by what somebody reaches for first, not alphabetically.
    for (const name of ['dev', 'start', 'serve', 'build', 'test', 'lint']) {
      if (scripts[name]) add(name, `npm run ${name}`);
    }
    if (scripts.test) add('test', 'npm test');
  } catch { /* no manifest, or an unreadable one — say so below */ }

  // ---- HOW TO RUN IT, FOR A PROJECT THAT IS NOT NODE ---------------------
  //
  // Everything above reads package.json, so a Python, Rust or Go project got an
  // EMPTY "How to run" block — on the screen whose whole job is to answer that
  // question. Each of these is read from a manifest that is actually present,
  // never from what happens to be installed: `cargo` on PATH does not make this
  // a Rust project, and a wrong run command is worse than an absent one because
  // it gets typed.
  const has = (f) => { try { return fs.existsSync(path.join(root, f)); } catch { return false; } };
  if (has('Cargo.toml')) add('run', 'cargo run');
  if (has('go.mod')) add('run', 'go run .');
  if (has('docker-compose.yml') || has('compose.yml')) add('up', 'docker compose up');
  for (const entry of ['main.py', 'app.py', 'manage.py', '__main__.py']) {
    if (has(entry)) { add('run', `python ${entry}`); break; }
  }
  try {
    const mk = fs.readFileSync(path.join(root, 'Makefile'), 'utf8');
    const t = /^(run|start|dev|serve)\s*:/m.exec(mk);
    if (t) add(t[1] === 'run' ? 'run' : t[1], `make ${t[1]}`);
  } catch { /* no Makefile */ }

  // ---- AND HOW TO TEST IT, FROM THE ONE MODULE THAT DECIDES THAT ----------
  //
  // testing.js is the single place that answers "how are this project's tests
  // run", and `discover_tests` returns the same answer to the model. Deriving a
  // second one here would be a second thing that can be wrong, and the one that
  // is wrong is always the copy nobody remembers exists.
  //
  // It also covers what this function could not: pytest, cargo, go, a Makefile
  // target — so a Python project stops showing an empty "How to test".
  try {
    const testing = require('../testing');
    const report = testing.discover(root);
    const primary = testing.primary(report);
    if (primary) add('test', primary.command);
  } catch { /* the survey below still has the environment's own answer */ }
  const env = survey && survey.environment;
  if (env && env.testRunner) add('test', env.testRunner.command);
  return out.slice(0, MAX_RUN);
}

/**
 * WHAT DESERVES ATTENTION, and it is not everything.
 *
 * A report where every non-green state looks like a catastrophe teaches its
 * reader to ignore the colour. So a blocked-by-quota test and a file that does
 * not parse are separated: one is expected and one is not.
 */
function attention(survey) {
  const rows = [];
  const findings = survey.findings || [];
  const critical = findings.filter((f) => f.severity === 'CRITICAL');
  const errors = findings.filter((f) => f.severity === 'ERROR');
  for (const f of [...critical, ...errors].slice(0, MAX_ATTENTION)) {
    rows.push({
      level: f.severity === 'CRITICAL' ? 'ERROR' : 'WARNING',
      text: `${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}  ` : ''}${f.message}`,
    });
  }
  const unverified = findings.filter((f) => f.severity === 'UNVERIFIED');
  for (const f of unverified.slice(0, MAX_ATTENTION)) {
    rows.push({ level: 'BLOCKED', text: f.message, why: f.explanation });
  }
  return rows;
}

/**
 * The whole view.
 *
 * @param {object} survey  a survey.run() result
 * @param {object} o       width, and the session for objective/progress
 */
function render(survey, { width = 80, session = null, cwd = '' } = {}) {
  const d = doc();
  const root = survey.root || cwd || process.cwd();
  const name = path.basename(root);
  const H = survey.health || {};

  d.title('lain / brief', name);
  d.subtitle('Project state, what changed, and what to do next');

  // ---- WHAT AM I LOOKING AT ---------------------------------------------
  d.section('project');
  d.field('Root', root);
  const langs = Object.entries(survey.languages || {})
    .filter(([e]) => /^(js|ts|tsx|jsx|py|go|rs|java|rb|cs|php)$/.test(e))
    .sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([e, n]) => `${e} (${n})`);
  if (langs.length) d.field('Stack', langs.join(', '));
  d.field('Analysed', `${survey.scanned} source file(s)`);

  // ---- WHAT IS LAIN DOING -----------------------------------------------
  const task = session && session.task;
  const plan = session && session.plan;
  if (task && task.objective) {
    d.section('objective');
    d.text(task.objective);
    const steps = (plan && plan.steps) || [];
    if (steps.length) {
      const done = steps.filter((s) => s.status === 'done').length;
      const pct = Math.round((done / steps.length) * 100);
      d.field('Progress', `${bar(done / steps.length)}  ${pct}%  (${done}/${steps.length})`);
      const active = steps.find((s) => s.status === 'active');
      if (active) d.field('Active', active.text);
    }
  }

  // ---- IS ANYTHING BROKEN -----------------------------------------------
  d.section('state');
  for (const [label, key] of [['Build', 'build'], ['Tests', 'test'], ['Runtime', 'runtime'],
    ['Engineering', 'engineering']]) {
    d.field(label, H[key], { tone: toneFor(H[key]) });
  }

  // ---- WHAT CHANGED ------------------------------------------------------
  const git = survey.git;
  if (git && git.ok && git.files.length) {
    d.section('changed', `${git.files.length} file(s) · ${git.totalLines} line(s)`);
    const mark = (f) => (f.untracked ? '+' : f.deleted ? '-' : 'M');
    for (const f of git.files.slice(0, MAX_CHANGES)) {
      d.field(`${mark(f)} ${f.file}`, `+${f.added} -${f.removed}`
        + (f.rewrite ? '   WHOLE-FILE REWRITE' : '')
        + (f.generated ? `   ${f.generated}` : ''),
      { tone: f.rewrite ? P.warn : null });
    }
    if (git.files.length > MAX_CHANGES) d.note(`… ${git.files.length - MAX_CHANGES} more`);
  } else if (git && git.ok) {
    d.section('changed');
    d.field('Working tree', 'clean', { tone: P.ok });
  }

  // ---- WHAT WAS VERIFIED -------------------------------------------------
  d.section('verification');
  if (survey.testRun) {
    d.field(survey.testRun.ok ? 'Passed' : 'FAILED', survey.testRun.command,
      { tone: survey.testRun.ok ? P.ok : P.bad });
  } else {
    d.field('Tests', 'not run in this survey', { tone: P.warn });
  }
  const findings = survey.findings || [];
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const material = ['CRITICAL', 'ERROR', 'WARNING', 'SUSPICIOUS']
    .filter((s) => counts[s]).map((s) => `${counts[s]} ${s.toLowerCase()}`);
  d.field('Findings', material.length ? material.join(' · ') : 'none', {
    tone: counts.CRITICAL || counts.ERROR ? P.bad : counts.WARNING ? P.warn : P.ok,
  });

  // ---- WHAT NEEDS ATTENTION ----------------------------------------------
  const rows = attention(survey);
  if (rows.length) {
    d.section('attention');
    for (const r of rows) {
      const tone = r.level === 'ERROR' ? P.bad : r.level === 'BLOCKED' ? P.warn : P.warn;
      d.bullet(`${r.level}  ${r.text}`, { mark: r.level === 'BLOCKED' ? '·' : '!', tone });
      if (r.why) d.note(r.why);
    }
  }

  // ---- HOW DO I RUN IT ---------------------------------------------------
  //
  // Mandatory, and derived — never invented.
  d.section('run');
  const cmds = runCommands(root, survey);
  if (cmds.length) {
    for (const c of cmds) d.field(c.label, c.cmd, { tone: P.cmd });
  } else {
    d.field('Command', 'no verified run command detected', { tone: P.warn });
  }

  // ---- WHAT DO I DO NEXT -------------------------------------------------
  d.section('next');
  d.bullet(nextAction(survey, H), { mark: '→', tone: P.info });
  d.note('/brief --full for the complete evidence, findings and repair directive.');

  return d.render(width);
}

/**
 * ONE recommended action, chosen from what the survey established.
 *
 * Ordered by what actually blocks progress: a file that will not parse stops
 * everything, and an unmeasured axis is only worth naming once the measured
 * ones are clean.
 */
function nextAction(survey, H) {
  const findings = survey.findings || [];
  const broken = findings.find((f) => f.severity === 'CRITICAL');
  if (broken) return `Fix ${broken.file || 'the critical finding'}${broken.line ? `:${broken.line}` : ''} — ${broken.message}`;
  if (H.build === 'FAILED') return 'The source does not parse. Fix the build before anything else.';
  const err = findings.find((f) => f.severity === 'ERROR');
  if (err) return `Investigate ${err.file || err.category}${err.line ? `:${err.line}` : ''} — ${err.message}`;
  if (H.test === 'UNVERIFIED') return 'Run the test suite — nothing has verified behaviour yet.';
  if (H.engineering === 'DEGRADED') return 'Review the findings above; the build passes but the codebase has open issues.';
  return 'Nothing is blocking. Continue the current task.';
}

// THE `pending` PLACEHOLDER MOVED to ui/contextview.js, which now owns both
// pane renderings and therefore owns what they say before the survey lands.
// Keeping a second copy here would have been a second answer to "what does
// CONTEXT show while it is reading" — and the old one was on screen a great
// deal longer than it should have been, because the pass that was supposed to
// replace it threw before it started (see ui/reports.js).

module.exports = { render, runCommands, attention, nextAction, bar };
