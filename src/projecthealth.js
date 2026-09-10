'use strict';

/**
 * `/health` — IS THIS PROJECT HEALTHY?
 *
 * A view of the CODEBASE the user is working on. Not of LAIN: LAIN's own
 * readiness is a different question with a different answer, and it lives in
 * health.js behind `/ready`. Running `/health` in scalpbot and being told about
 * LAIN's provider, context window and connections is an answer to a question
 * nobody asked — the project is what the user came here to understand.
 *
 * EVIDENCE, AND A CONFIDENCE WITH IT. Every row is read from the tree by
 * audit.js (one scan, reused here rather than re-walked) or from this session's
 * own checkpoints and lifecycle. Nothing is asked of a model. And because a
 * local scan can be wrong about what it means, findings carry how sure we are:
 *
 *   ✓ CONFIRMED    the evidence IS the finding — the file is 140 KB, the
 *                  catch block is empty, there are no test files
 *   ⚠ LIKELY       the evidence strongly implies it but a person should look
 *   ? NEEDS REVIEW something was noticed and this cannot judge it
 *
 * That distinction is the whole guard against the failure mode of tools like
 * this: reporting "unused code" because a naive search found no reference, and
 * being confidently wrong in a way that costs someone an afternoon.
 */

const path = require('path');

const { audit } = require('./audit');
const T = require('./ui/text');
const { P, byColour } = require('./ui/paint');

/** state → symbol, colour, and whether it counts as healthy. */
const STATE = Object.freeze({
  STABLE: { sym: '✓', colour: 'green', word: 'STABLE', good: true },
  FOUND: { sym: '✓', colour: 'green', word: 'FOUND', good: true },
  PASSED: { sym: '✓', colour: 'green', word: 'PASSED', good: true },
  ATTENTION: { sym: '⚠', colour: 'yellow', word: 'ATTENTION', good: false },
  REVIEW: { sym: '?', colour: 'yellow', word: 'REVIEW', good: false },
  FAILED: { sym: '✕', colour: 'red', word: 'FAILED', good: false },
  MISSING: { sym: '✕', colour: 'red', word: 'MISSING', good: false },
  INFO: { sym: '●', colour: 'cyan', word: 'INFO', good: true },
  NONE: { sym: '·', colour: 'dim', word: 'NOT FOUND', good: true },
});

/** How sure this reading is. See the header. */
const SURE = Object.freeze({
  CONFIRMED: { sym: '✓', colour: 'green', word: 'CONFIRMED' },
  LIKELY: { sym: '⚠', colour: 'yellow', word: 'LIKELY' },
  REVIEW: { sym: '?', colour: 'cyan', word: 'NEEDS REVIEW' },
});

/** A file this big is doing too much — the same threshold /audit uses. */
const BIG_FILE_BYTES = 60_000;

/**
 * Read the project into grouped rows plus graded findings.
 *
 * @param {string} root  the project directory
 * @param {object} app   optional — supplies THIS session's work state
 */
async function assess(root, app = null) {
  const a = await audit(root);
  const groups = [];
  const findings = [];
  const g = (title, rows) => groups.push({ title, rows: rows.filter(Boolean) });
  const row = (area, state, note = '') => ({ area, state, note });
  const find = (sure, text) => findings.push({ sure, text });

  // ---------------------------------------------------------- STRUCTURE ---
  const marker = (id) => a.markers.find((m) => m.id === id) || null;
  const entryNote = a.entries.length ? a.entries.slice(0, 2).join(' · ') : 'no obvious entry point';
  g('Structure', [
    row('Language', a.languages.length ? STATE.STABLE : STATE.REVIEW,
      a.languages.join(', ') || 'could not tell from the file types'),
    row('Files', STATE.INFO, `${a.fileCount} files${a.scanned < a.fileCount ? ` (read ${a.scanned})` : ''}`),
    row('Config', a.manifests.length ? STATE.FOUND : STATE.NONE, a.manifests.join(', ') || 'no manifest'),
    row('Tests', a.tests.count ? STATE.STABLE : STATE.MISSING,
      a.tests.count ? `${a.tests.count} test file(s)` : 'no test files found'),
    row('Entry points', a.entries.length ? STATE.FOUND : STATE.REVIEW, entryNote),
    row('Front end', a.boundary.frontend ? STATE.FOUND : STATE.NONE,
      a.boundary.frontend ? `${a.boundary.frontend} file(s)` : 'no front-end surface detected'),
    row('Back end', a.boundary.backend ? STATE.FOUND : STATE.NONE,
      a.boundary.backend ? `${a.boundary.backend} file(s)` : 'no back-end surface detected'),
  ]);

  // -------------------------------------------------------- CODE HEALTH ---
  const silent = marker('emptycatch');
  const todo = marker('todo');
  const stub = marker('stub');
  const big = a.biggest.file && a.biggest.bytes > BIG_FILE_BYTES ? a.biggest : null;

  const where = (m) => (m && m.worst
    ? `${m.count} · ${m.worst.hits} of them in ${m.worst.file}`
    : m ? `${m.count} · e.g. ${m.example}` : '');

  g('Code health', [
    row('Silent errors', silent ? STATE.ATTENTION : STATE.STABLE,
      silent ? where(silent) : 'no empty catch blocks found'),
    row('Left for later', todo ? STATE.ATTENTION : STATE.STABLE,
      todo ? where(todo) : 'no TODO / FIXME notes'),
    row('Unfinished stubs', stub ? STATE.ATTENTION : STATE.STABLE,
      stub ? where(stub) : 'nothing throws "not implemented"'),
    row('Large files', big ? STATE.ATTENTION : STATE.STABLE,
      big ? `${big.file} is ${Math.round(big.bytes / 1000)} KB` : 'nothing oversized'),
  ]);

  if (silent) {
    find(SURE.CONFIRMED, `${silent.count} error(s) are caught and silently dropped`
      + (silent.worst ? ` — ${silent.worst.hits} in ${silent.worst.file}` : ''));
  }
  if (big) find(SURE.CONFIRMED, `${big.file} is ${Math.round(big.bytes / 1000)} KB — one file doing several jobs`);
  if (!a.tests.count) find(SURE.CONFIRMED, 'there are no test files, so no change here can be verified');
  if (stub) find(SURE.LIKELY, `${stub.count} unfinished stub(s), starting with ${stub.example}`);
  if (todo) find(SURE.REVIEW, `${todo.count} left-for-later note(s) — some may be stale, some may matter`);
  if (!a.entries.length) find(SURE.REVIEW, 'no entry point was recognisable — how this is started is unclear from the tree');

  // ---------------------------------------------------------- WORK STATE ---
  const work = workState(app);
  const workRows = [];
  if (work) {
    if (work.objective) workRows.push(row('Current task', STATE.INFO, work.objective));
    if (work.plan) workRows.push(row('Plan', STATE.INFO, `${work.plan.done}/${work.plan.total} steps done`));
    if (work.changed && work.changed.length) {
      workRows.push(row('Files changed', STATE.INFO, `${work.changed.length} this session — ${work.changed.slice(0, 3).join(', ')}`));
    }
    if (work.lastCheck) {
      workRows.push(row('Last verification', work.lastCheck.ok ? STATE.PASSED : STATE.FAILED,
        `${work.lastCheck.command}${work.lastCheck.ok ? '' : ' — this is still red'}`));
      if (!work.lastCheck.ok) find(SURE.CONFIRMED, `the last check that ran (${work.lastCheck.command}) FAILED`);
    }
  }
  if (!workRows.length) workRows.push(row('This session', STATE.INFO, 'nothing changed here yet'));
  g('Work state', workRows);

  // ------------------------------------------------------------- OVERALL ---
  const flat = groups.flatMap((gr) => gr.rows);
  const bad = flat.filter((r) => !r.state.good);
  const overall = bad.some((r) => r.state === STATE.FAILED || r.state === STATE.MISSING)
    ? { word: 'NEEDS ATTENTION', colour: 'red' }
    : bad.length
      ? { word: 'NEEDS ATTENTION', colour: 'yellow' }
      : { word: 'HEALTHY', colour: 'green' };

  return {
    name: a.name,
    root: a.root,
    overall,
    groups,
    findings,
    counts: { areas: flat.length, needAttention: bad.length },
    next: nextAction(a, work),
    audit: a,
  };
}

/** Live task/verification state, read off the running session. Optional. */
function workState(app) {
  const s = app && app.session;
  if (!s) return null;
  const out = {};
  if (s.task && s.task.objective) out.objective = s.task.objective.replace(/\s+/g, ' ');
  if (s.plan && Array.isArray(s.plan.steps)) {
    out.plan = { done: s.plan.steps.filter((x) => x.status === 'done').length, total: s.plan.steps.length };
  }
  try {
    const files = require('./ui/panes').changedFiles({ checkpoints: app.checkpoints, cwd: s.cwd });
    if (files.length) out.changed = files.map((f) => f.rel);
  } catch { /* no checkpoints yet */ }
  const life = s.lifecycle;
  if (life && life.lastCommand) out.lastCheck = life.lastCommand;
  return Object.keys(out).length ? out : null;
}

/** ONE next action, chosen from what is actually wrong. Never a lecture. */
function nextAction(a, work) {
  if (work && work.lastCheck && !work.lastCheck.ok) {
    return `Fix the failing check first: ${work.lastCheck.command} is red.`;
  }
  if (!a.tests.count) return 'Add a test for the part you are about to change — nothing here can be verified yet.';
  const silent = a.markers.find((m) => m.id === 'emptycatch');
  if (silent) {
    return `Start with the silently dropped errors${silent.worst ? ` in ${silent.worst.file}` : ''} — they hide the failures you are chasing.`;
  }
  const stub = a.markers.find((m) => m.id === 'stub');
  if (stub) return `Look at the ${stub.count} unfinished spot(s), starting with ${stub.example}.`;
  if (a.biggest.file && a.biggest.bytes > 100_000) return `${a.biggest.file} is doing a lot — consider splitting it.`;
  return 'Nothing urgent stands out. Say what you want to change.';
}

// ------------------------------------------------------------------- view ---

/**
 * The assessment as a framed pane. Same engine as the command — this only lays
 * it out — and every row is fitted to the frame, colour included (ui/text.js).
 */
function projectHealthLines(a, width = 80) {
  if (!a) return T.box('PROJECT HEALTH', ['  reading the project…'], Math.max(40, width));
  const w = Math.max(44, width);
  const inner = w - 4;
  const cArea = Math.min(20, Math.max(13, Math.floor(inner * 0.26)));
  const cState = 13;
  const body = [];

  body.push(P.meta('Overall') + '  ' + byColour(a.overall.colour, a.overall.word)
    + P.meta(`   ${a.counts.areas - a.counts.needAttention}/${a.counts.areas} areas healthy`));
  body.push('');
  body.push(P.head(T.pad('AREA', cArea) + '  ' + T.pad('STATUS', cState) + '  EVIDENCE'));

  for (const g of a.groups) {
    if (!g.rows.length) continue;
    body.push('');
    body.push(P.key(g.title.toUpperCase()));
    for (const r of g.rows) {
      const state = byColour(r.state.colour, `${r.state.sym} ${r.state.word}`);
      body.push('  ' + T.pad(T.clip(r.area, cArea - 2), cArea - 2)
        + '  ' + T.pad(state, cState)
        + '  ' + P.meta(T.clip(String(r.note || ''), inner - cArea - cState - 4)));
    }
  }

  const by = (s) => a.findings.filter((f) => f.sure === s);
  for (const [label, sure] of [['CONFIRMED', SURE.CONFIRMED], ['LIKELY', SURE.LIKELY], ['NEEDS REVIEW', SURE.REVIEW]]) {
    const list = by(sure);
    if (!list.length) continue;
    body.push('');
    body.push(P.key(label));
    for (const f of list) body.push('  ' + byColour(sure.colour, sure.sym) + ' ' + T.clip(f.text, inner - 4));
  }

  body.push('');
  body.push(P.key('NEXT ACTION'));
  body.push('  ' + T.clip(a.next, inner - 2));
  return T.box(P.head(`PROJECT HEALTH — ${a.name}`), body, w);
}

// ----------------------------------------------------------------- command ---

async function runCommand(app, ctx = {}, { C } = {}) {
  const rest = String(ctx.rest || '').trim();
  const root = rest ? path.resolve(app.session.cwd, rest) : app.session.cwd;
  const col = C || { dim: (s) => s };
  app.render.write(col.dim('  Reading the project…\n'));
  let a;
  try { a = await assess(root, rest ? null : app); }
  catch (e) { app.render.notice('error', `Could not read this project: ${e.message}`); return; }
  app.render.write('\n');
  for (const l of projectHealthLines(a, app.render.width)) app.render.write(l + '\n');
  app.render.write(col.dim('\n  /ready is the other health view — LAIN own readiness, not this project.\n'));
  return a;
}

module.exports = { assess, projectHealthLines, workState, nextAction, runCommand, STATE, SURE };
