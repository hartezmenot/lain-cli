'use strict';

/**
 * THE FIVE VIEWS — an engineering workspace, not a chat window with tabs.
 *
 * The old set was seven panes organised around WHAT LAIN HAD: a transcript, a
 * plan, a diff, some captured output, a file tree, and two report generators.
 * That is a list of the program's internals. A person opening a project does
 * not think "I would like the audit pane"; they think:
 *
 *     what is this        → PROJECT
 *     what do we know     → CONTEXT
 *     what is happening   → WORK
 *     what changed        → CHANGES
 *     can I trust it      → VERIFY
 *
 * Five questions, five views, in the order somebody actually asks them.
 *
 * ------------------------------------------------------------------------
 * WHAT HAPPENED TO AUDIT AND HEALTH.
 *
 * Neither was a destination anybody wanted to be in — they were evidence
 * generators wearing a pane. Their findings now appear where the question they
 * answer gets asked: project shape and entry points in PROJECT, code health and
 * unverified systems in VERIFY, and the standing facts in CONTEXT. The
 * implementations are untouched and still reachable as `/audit` and `/health`;
 * what changed is that nobody has to visit them to learn what they found.
 * ------------------------------------------------------------------------
 *
 * EVERY VIEW BUILDS A DOCUMENT, never a list of pre-formatted strings. That is
 * what lets the same content align its fields, wrap a long path without losing
 * a character, and stay readable at forty columns. See ui/doc.js.
 */

const path = require('path');
const { doc } = require('./doc');
const { P } = require('./paint');

/** Rows of a live feed to show inside a view that is not WORK. */
const ACTIVITY_TAIL = 6;
const MAX_LIST = 12;

/** UNVERIFIED is a first-class answer everywhere, and always reads as itself. */
const UNVERIFIED = 'UNVERIFIED';

function toneFor(value) {
  const v = String(value || '').toUpperCase();
  if (v === 'PASS' || v === 'CLEAN' || v.startsWith('OK')) return P.ok;
  if (v === UNVERIFIED) return P.warn;
  if (v === 'FAILED' || v === 'DEGRADED' || v.startsWith('FAIL')) return P.bad;
  return null;
}

// ----------------------------------------------------------------- PROJECT --

/**
 * "What am I working on, and how do I run it?"
 *
 * The RUN section is the reason this view exists. It is the single most
 * re-asked question in any unfamiliar repository, the answer is written down in
 * the manifest, and until now LAIN made a person go and read it.
 *
 * NOTHING HERE IS INVENTED. A command that the repository does not establish is
 * reported as UNVERIFIED rather than guessed — a wrong `npm run dev` is worse
 * than no answer, because it gets run.
 */
function projectView({ facts = [], brief = null, width = 80, cwd = '' }) {
  const d = doc();
  const name = path.basename(cwd || process.cwd()) || 'project';
  d.title('project', name);

  const f = (area, nm) => facts.find((x) => x.area === area && x.name === nm) || null;
  const val = (x) => (x && x.value !== 'UNKNOWN' ? x.value : null);

  d.section('root');
  d.field('Path', cwd || process.cwd());

  // ---- STACK, from the file census rather than from a guess --------------
  const langs = brief && brief.languages ? brief.languages : null;
  if (langs) {
    const top = Object.entries(langs)
      .filter(([ext]) => /^(js|ts|tsx|jsx|py|go|rs|java|rb|cs|php|c|cc|cpp|h|swift|kt)$/.test(ext))
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([ext, n]) => `${ext} (${n})`);
    if (top.length) { d.section('stack'); d.field('Languages', top.join(', ')); }
  }
  const runtimes = f('SHELL', 'Shells available');
  const env = brief && brief.environment ? brief.environment : null;
  if (env && env.runtimes && Object.keys(env.runtimes).length) {
    if (!langs) d.section('stack');
    d.field('Runtimes', Object.entries(env.runtimes).map(([k, v]) => (k === v ? k : `${k} (${v})`)).join(', '));
  }
  void runtimes;

  // ---- HOW TO RUN IT -----------------------------------------------------
  d.section('run');
  const pm = env && env.packageManager ? env.packageManager : null;
  const test = f('TESTING', 'Test command');
  const scripts = brief && brief.scripts ? brief.scripts : null;
  if (scripts && Object.keys(scripts).length) {
    for (const [k, v] of Object.entries(scripts).slice(0, 6)) d.field(k, v);
  } else if (!val(test) && !pm) {
    d.field('Start', UNVERIFIED, { tone: P.warn, note: 'no manifest in this project declares one' });
  }
  d.field('Test', val(test) || UNVERIFIED, {
    tone: val(test) ? null : P.warn,
    note: val(test) ? `declared in ${test.evidence.replace(/^declared in /, '')}` : 'nothing in the repository declares a test command',
  });
  if (pm) {
    d.field('Install', `${pm.manager} install`, {
      note: pm.missing
        ? `${pm.manager} is NOT installed here, though ${pm.from} says this project uses it`
        : `from ${pm.from}`,
    });
  }

  // ---- WHERE THE WORK IS --------------------------------------------------
  const entries = brief && brief.entryPoints ? brief.entryPoints : [];
  if (entries.length) {
    d.section('entry points');
    for (const e of entries.slice(0, 6)) d.field(e.what, e.file);
  }

  if (env && env.venv) {
    d.section('environment');
    d.field('Python venv', env.venv.active ? `active (${env.venv.path})` : env.venv.path, {
      tone: env.venv.active ? P.ok : P.warn,
      note: env.venv.active ? null : 'NOT active in this shell — the project\'s packages will be missing',
    });
  }
  return d.render(width);
}

// ----------------------------------------------------------------- CONTEXT --

/**
 * "What does LAIN currently know about this project?"
 *
 * THE DEFAULT VIEW, and the most important change in the whole redesign. What
 * used to be here was the conversation — which is a RECORD of how the knowledge
 * was arrived at, not the knowledge. Somebody returning to a project after a
 * day wants the conclusions, and had to reconstruct them by reading back
 * through an agent's narration.
 *
 * Every section is rendered independently so the whole thing can be scanned in
 * a few seconds. Nothing here is a paragraph.
 */
function contextView({
  facts = [], concerns = [], brief = null, session = null, width = 80, cwd = '', activity = [],
}) {
  const d = doc();
  d.title('context', path.basename(cwd || process.cwd()));

  // ---- WHAT IS BEING WORKED ON RIGHT NOW ---------------------------------
  const task = session && session.task;
  const plan = session && session.plan;
  d.section('current work');
  if (task && task.objective) {
    d.field('Task', task.objective);
    const steps = (plan && plan.steps) || [];
    const done = steps.filter((s) => s.status === 'done').length;
    const active = steps.find((s) => s.status === 'active');
    if (steps.length) d.field('Progress', `${done} of ${steps.length} steps`);
    if (active) d.field('Active', active.text);
  } else {
    d.note('Nothing in progress.');
  }

  // ---- WHAT WE KNOW, STRUCTURALLY ----------------------------------------
  //
  // The operational contract, which the briefing already establishes with
  // evidence. Shown here as fields rather than prose: these are the facts a
  // session would otherwise rediscover, and prose is how they get skipped.
  const byArea = new Map();
  for (const f of facts) {
    if (!byArea.has(f.area)) byArea.set(f.area, []);
    byArea.get(f.area).push(f);
  }
  const showArea = (area, heading, names = null) => {
    const list = (byArea.get(area) || []).filter((f) => !names || names.includes(f.name));
    if (!list.length) return;
    d.section(heading);
    for (const f of list.slice(0, MAX_LIST)) {
      const unknown = f.value === 'UNKNOWN';
      d.field(f.name, unknown ? UNVERIFIED : f.value, {
        tone: unknown ? P.warn : null,
        note: unknown ? f.why : (f.counterExample ? `NOT: ${f.counterExample}` : null),
      });
    }
  };
  showArea('SHELL', 'execution', ['Default shell', 'Command separator', 'Null sink']);
  showArea('CWD', 'working directory', ['Project root', 'Changing directory']);
  showArea('SOURCE_LOCATION', 'source locations');
  showArea('PROBE', 'lain-probe');
  showArea('DATA', 'data');

  // ---- CONCERNS ----------------------------------------------------------
  //
  // Deliberately near the top of what a person reads, because the entire point
  // of a concern is that it is the thing you were going to forget.
  const openConcerns = concerns.filter((c) => c.state === 'OPEN');
  d.section('concerns', openConcerns.length ? '' : 'none');
  if (openConcerns.length) {
    for (const c of openConcerns.slice(0, MAX_LIST)) {
      d.bullet(`${c.id}  ${c.text}`, { mark: '!', tone: P.warn });
    }
    if (openConcerns.length > MAX_LIST) d.note(`${openConcerns.length - MAX_LIST} more — /concern`);
  } else {
    d.note('Nothing outstanding. Add one with /concern <what worries you>.');
  }

  // ---- WHAT IS AND IS NOT ESTABLISHED ------------------------------------
  if (brief && brief.health) {
    d.section('last verified');
    for (const [label, key] of [['Build', 'build'], ['Tests', 'test'], ['Runtime', 'runtime'],
      ['Frontend', 'frontend'], ['Engineering', 'engineering']]) {
      const v = brief.health[key];
      d.field(label, v, { tone: toneFor(v) });
    }
  }

  // ---- WHAT THE MODEL IS DOING, QUIETLY AT THE FOOT ----------------------
  //
  // Present so the view does not go stale while work happens, and LAST so it
  // never pushes the knowledge off the screen. The full account is in WORK.
  const tail = activity.filter((l) => String(l).trim()).slice(-ACTIVITY_TAIL);
  if (tail.length) {
    d.section('latest activity', 'full account in WORK');
    d.raw(tail);
  }
  return d.render(width);
}

// -------------------------------------------------------------------- WORK --

/**
 * "What is happening, and what is the model doing?"
 *
 * The conversation, the plan and the current step — the things that were
 * scattered across three panes. The transcript is NOT removed and NOT
 * summarised; it simply stopped being the first thing anybody sees.
 */
function workView({ session = null, activity = [], width = 80, next = null }) {
  const d = doc();
  const task = session && session.task;
  const plan = session && session.plan;
  d.title('work', task && task.objective ? '' : 'nothing in progress');

  if (task && task.objective) {
    d.section('current task');
    d.field('Objective', task.objective);
    if (task.steers && task.steers.length) {
      d.field('Since corrected', String(task.steers[task.steers.length - 1].text || '').slice(0, 160));
    }
  }

  const steps = (plan && plan.steps) || [];
  if (steps.length) {
    d.section('plan');
    for (const s of steps.slice(0, 20)) {
      const mark = s.status === 'done' ? '✓' : s.status === 'active' ? '▸' : s.status === 'dropped' ? '·' : '○';
      const tone = s.status === 'done' ? P.ok : s.status === 'active' ? P.info : P.meta;
      d.bullet(s.text, { mark, tone });
    }
  }

  if (next) { d.section('next'); d.bullet(next, { mark: '→', tone: P.info }); }

  d.section('activity');
  const rows = activity.filter((l) => l != null);
  if (rows.length) d.raw(rows);
  else d.note('Nothing yet. Type a task below to begin.');
  return d.render(width);
}

// ----------------------------------------------------------------- CHANGES --

/**
 * "What actually changed?"
 *
 * The shape first, the detail on demand. Dumping a full diff here is what made
 * the old pane something people scrolled past: the question being asked is
 * which files moved and whether that is the change that was intended.
 */
function changesView({ git = null, checkpoints = null, width = 80, cwd = '' }) {
  const d = doc();
  d.title('changes');

  if (!git || !git.ok) {
    d.section('working tree');
    d.note(git && git.error ? git.error : 'Not established.');
    return d.render(width);
  }
  if (!git.files.length) {
    d.section('working tree');
    d.field('Status', 'clean', { tone: P.ok, note: 'nothing differs from the last commit' });
    return d.render(width);
  }

  d.section('working tree', `${git.files.length} file(s) · ${git.totalLines} line(s)`);
  const added = git.files.filter((f) => f.untracked);
  const deleted = git.files.filter((f) => f.deleted);
  const modified = git.files.filter((f) => !f.untracked && !f.deleted);

  const list = (label, rows, tone) => {
    if (!rows.length) return;
    d.field(label, String(rows.length), { tone });
    for (const f of rows.slice(0, MAX_LIST)) {
      d.note(`${f.file}   +${f.added} -${f.removed}`
        + (f.rewrite ? '   WHOLE-FILE REWRITE' : '')
        + (f.generated ? `   ${f.generated}` : ''));
    }
    if (rows.length > MAX_LIST) d.note(`… ${rows.length - MAX_LIST} more`);
  };
  list('Modified', modified, null);
  list('Added', added, P.ok);
  list('Deleted', deleted, P.bad);

  // ---- WHAT IS WORTH A SECOND LOOK ---------------------------------------
  const suspicious = [];
  if (git.files.some((f) => f.rewrite)) suspicious.push('A file was rewritten whole rather than patched.');
  if (git.files.some((f) => f.generated)) suspicious.push('Generated or built files are in the change set.');
  if (git.huge) suspicious.push(`The change set is ${git.totalLines} lines. If the task was small, most of it was not asked for.`);
  const unexpected = git.files.filter((f) => f.unexpected);
  if (unexpected.length) suspicious.push(`${unexpected.length} file(s) differ but were not written by this session.`);
  if (suspicious.length) {
    d.section('worth a second look');
    for (const s of suspicious) d.bullet(s, { mark: '!', tone: P.warn });
  }

  const touched = checkpoints && typeof checkpoints.files === 'function' ? checkpoints.files() : null;
  if (touched && touched.length) {
    d.section('this session');
    d.field('Files written', String(touched.length), {
      note: touched.slice(0, 6).map((p) => path.relative(cwd || process.cwd(), p).replace(/\\/g, '/')).join(', '),
    });
  }
  return d.render(width);
}

// ------------------------------------------------------------------ VERIFY --

/**
 * "Can I trust the current state?"
 *
 * Confidence, not statistics. The five axes the survey already grades, the
 * things that were not measured said plainly, and the findings counted rather
 * than listed — the list is what `/brief` is for.
 */
function verifyView({ brief = null, width = 80 }) {
  const d = doc();
  d.title('verify');

  if (!brief) {
    d.section('status');
    d.note('No survey has run yet. Press r, or run /brief, to take one.');
    return d.render(width);
  }

  d.section('health');
  const H = brief.health || {};
  const why = {
    frontend: brief.frontend && brief.frontend.why ? brief.frontend.why : null,
    test: brief.testRun ? null : 'the suite was not run as part of this survey',
  };
  for (const [label, key] of [['Build', 'build'], ['Tests', 'test'], ['Runtime', 'runtime'],
    ['Frontend', 'frontend'], ['Engineering', 'engineering']]) {
    const v = H[key];
    d.field(label, v, { tone: toneFor(v), note: v === UNVERIFIED ? why[key] : null });
  }

  if (brief.testRun) {
    d.section('last test run');
    d.field('Command', brief.testRun.command);
    d.field('Result', brief.testRun.ok ? 'PASS' : `FAILED (exit ${brief.testRun.exitCode})`,
      { tone: brief.testRun.ok ? P.ok : P.bad });
  }

  // ---- FINDINGS, COUNTED ---------------------------------------------------
  const findings = brief.findings || [];
  if (findings.length) {
    const counts = {};
    for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
    d.section('findings', `${findings.length} total`);
    for (const sev of ['CRITICAL', 'ERROR', 'WARNING', 'SUSPICIOUS', 'INFO']) {
      if (!counts[sev]) continue;
      d.field(sev.toLowerCase(), String(counts[sev]),
        { tone: sev === 'CRITICAL' || sev === 'ERROR' ? P.bad : sev === 'WARNING' ? P.warn : null });
    }
    const worst = findings
      .filter((f) => f.severity === 'CRITICAL' || f.severity === 'ERROR')
      .slice(0, 5);
    if (worst.length) {
      d.section('most severe');
      for (const f of worst) {
        d.bullet(`${f.id || f.category}  ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}  ` : ''}${f.message}`,
          { mark: '!', tone: P.bad });
      }
    }
  }

  // ---- WHAT NOBODY LOOKED AT ---------------------------------------------
  const unverified = findings.filter((f) => f.severity === UNVERIFIED);
  if (unverified.length) {
    d.section('not measured');
    for (const f of unverified.slice(0, MAX_LIST)) d.bullet(f.message, { mark: '?', tone: P.warn });
    d.note('Absence of measurement is not a pass.');
  }

  if (brief.skipped && brief.skipped.length) {
    d.section('analysers that did not run');
    for (const s of brief.skipped.slice(0, 6)) d.field(s.tool, s.why, { tone: P.warn });
  }
  return d.render(width);
}

module.exports = { projectView, contextView, workView, changesView, verifyView, toneFor, UNVERIFIED };
