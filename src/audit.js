'use strict';

/**
 * `/audit` — a plain-language reading of THIS project before anyone changes it.
 *
 * The question it answers is the one a person asks when they open a codebase
 * they do not know: what is this, how is it run, what can it do, what looks
 * unfinished, and where does the work stand right now. It is meant to be read by
 * someone who knows computers but not this project — so it names files and says
 * what they are for, and it never dumps code back at the reader.
 *
 * EVIDENCE, NOT CLAIMS. Every line comes from reading the tree: the manifest,
 * the directory shape, the same capability probe set `/compare` uses (see
 * capabilities.js), and a bounded scan for the markers people leave on work that
 * is not done — TODO, FIXME, "not implemented", an empty catch. Nothing here is
 * asked of a model; it is all local and deterministic, which is what makes it
 * safe to run before deciding anything.
 *
 * It reuses `/compare`'s tree reader and detector rather than growing a second
 * one, and it does NOT replace `/compare`: with a source argument, `/audit`
 * forwards to it, so "read this project" and "read it against that other one"
 * are the same door.
 */

const fs = require('fs');
const path = require('path');

const project = require('./project');
const { scanDir, detect } = require('./compare');
const { CAPABILITIES } = require('./capabilities');

/** Files worth reading for markers — source, not lockfiles or assets. */
const READABLE = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|cs|php|swift|kt|sh|ps1)$/i;
/** How many source files to open when hunting for unfinished-work markers. */
const MAX_MARKER_FILES = 400;

/** Surfaces a person touches directly — if these exist, there is a front end. */
const FRONTEND = /(?:\.(?:html?|css|scss|vue|svelte|jsx|tsx)$)|(?:^|\/)(?:public|static|assets|components|pages|templates|views|client|web|frontend|ui)(?:\/|$)/i;
/** Where a request is served or state is owned — the back end. */
const BACKEND = /(?:^|\/)(?:server|api|routes?|controllers?|handlers?|services?|backend|core|db|models?|migrations?)(?:\/|$)|(?:^|\/)(?:app|main|server|manage|wsgi|asgi|index)\.(?:py|js|ts|go|rb)$/i;

/**
 * The markers people leave on work that is not finished, each in plain words.
 *
 * These test for work in CODE, not the phrase in prose: the words "not
 * implemented" in a comment are a description, while a function body that only
 * throws a not-implemented error is genuinely unfinished. An earlier version
 * matched the bare phrase and counted its own regex definitions and every
 * comment that mentioned it — noise dressed as a finding.
 */
const MARKERS = [
  { id: 'todo', re: /(?:\/\/|#|\*|<!--)\s*(?:TODO|FIXME|XXX|HACK)\b/g, plain: 'left-for-later notes (TODO / FIXME)' },
  { id: 'stub', re: /\braise\s+NotImplementedError|\bthrow\s+new\s+\w*Error\s*\(\s*['"`](?:TODO|not[ _]?implemented|unimplemented|not yet\b)|\bunimplemented!\s*\(|\btodo!\s*\(/gi, plain: 'unfinished stubs (raise/throw "not implemented")' },
  // BOTH SPELLINGS OF THE SAME MISTAKE. This was JavaScript-shaped only —
  // `catch {}` — so a Python project full of `except Exception: pass`, which is
  // the textbook version of an error nobody will ever see, scored zero and the
  // audit reported it as clean.
  {
    id: 'emptycatch',
    re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}|except\b[^\n:]*:\s*(?:#[^\n]*)?\s*\n\s*pass\b|except\b[^\n:]*:\s*pass\b/g,
    plain: 'errors caught and silently dropped',
  },
];

// ------------------------------------------------------------------- probe ---

/** Common entry-point files, past what the manifest already declares. */
function entryFiles(root) {
  const candidates = [
    'bin', 'index.js', 'main.js', 'server.js', 'app.js', 'cli.js',
    'main.py', 'app.py', '__main__.py', 'manage.py', 'wsgi.py', 'asgi.py',
    'main.go', 'src/main.rs', 'Main.java', 'index.ts', 'src/index.ts',
  ];
  const found = [];
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(root, c))) found.push(c); } catch { /* ignore */ }
  }
  return found;
}

/** Read a manifest's declared entry points (bin/main/start), if any. */
function declaredEntries(root) {
  const out = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (j.main) out.push(`main: ${j.main}`);
    if (j.bin) {
      const bins = typeof j.bin === 'string' ? [j.bin] : Object.values(j.bin);
      for (const b of bins) out.push(`bin: ${b}`);
    }
    if (j.scripts && j.scripts.start) out.push(`npm start → ${j.scripts.start}`);
  } catch { /* no package.json, or unreadable — the file scan still finds entries */ }
  return out;
}

/**
 * The heart of it: read the tree once and pull every signal out of that one
 * read. Bounded by MAX_MARKER_FILES so a large repo cannot turn this into a
 * full-content scan.
 */
async function scanMarkers(tree) {
  const counts = new Map();
  const examples = new Map();
  // WHERE THE PROBLEM IS CONCENTRATED, not merely one file that has it. "8
  // silent catches" is a number; "8 silent catches, 5 of them in dashboard.py"
  // is somewhere to go. Same single read of the tree, one extra comparison.
  const worst = new Map();
  let frontend = 0;
  let backend = 0;
  let biggest = { file: null, bytes: 0 };
  let readCount = 0;

  for (const f of tree.files) {
    if (FRONTEND.test(f)) frontend++;
    if (BACKEND.test(f)) backend++;
    if (!READABLE.test(f)) continue;
    if (readCount >= MAX_MARKER_FILES) continue;
    readCount++;
    const body = await tree.read(f);
    if (!body) continue;
    if (body.length > biggest.bytes) biggest = { file: f, bytes: body.length };
    for (const m of MARKERS) {
      m.re.lastIndex = 0;
      const hits = (body.match(m.re) || []).length;
      if (!hits) continue;
      counts.set(m.id, (counts.get(m.id) || 0) + hits);
      if (!examples.has(m.id)) examples.set(m.id, f);
      const w = worst.get(m.id);
      if (!w || hits > w.hits) worst.set(m.id, { file: f, hits });
    }
  }
  return { counts, examples, worst, frontend, backend, biggest, readCount };
}

/**
 * Audit a project directory into a plain data object. Pure — no app, no
 * rendering — so it is testable on its own and reusable.
 */
async function audit(root) {
  const abs = path.resolve(root);
  const scan = project.scan(abs);
  const tree = scanDir(abs);

  // Capability detection: the same symmetric probe set /compare uses, but here
  // over one tree — "what can this project already do", with the file as proof.
  const caps = [];
  for (const cap of CAPABILITIES) {
    const d = await detect(tree, cap);
    if (d.present) caps.push({ name: cap.name, group: cap.group, plain: cap.plain, where: d.where });
  }

  const markers = await scanMarkers(tree);

  // Tests: named directories and the file census, so "has tests" is a reading
  // rather than a hope.
  const testFiles = tree.files.filter((f) => /(?:^|\/)(?:tests?|spec|__tests__)\//i.test(f) || /\.(?:test|spec)\.[a-z]+$/i.test(f));

  return {
    root: abs,
    name: (() => {
      try { return JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8')).name || path.basename(abs); }
      catch { return path.basename(abs); }
    })(),
    languages: scan.languages,
    manifests: scan.manifests,
    run: scan.run,
    topLevel: scan.entries,
    sourceDirs: scan.tree,
    fileCount: tree.files.length,
    entries: [...declaredEntries(abs), ...entryFiles(abs).map((e) => `file: ${e}`)],
    boundary: { frontend: markers.frontend, backend: markers.backend },
    capabilities: caps,
    tests: { count: testFiles.length, some: testFiles.slice(0, 4) },
    markers: MARKERS
      .map((m) => ({
        id: m.id,
        plain: m.plain,
        count: markers.counts.get(m.id) || 0,
        example: markers.examples.get(m.id) || null,
        worst: markers.worst.get(m.id) || null,
      }))
      .filter((m) => m.count > 0),
    biggest: markers.biggest,
    scanned: markers.readCount,
  };
}

// ------------------------------------------------------------------ render ---

/**
 * Live task/verification state, read off the running session. This is the only
 * part that needs the app — the "where does the work stand right now" section —
 * and it is optional, so `audit()` stays pure.
 */
function workState(app) {
  const s = app && app.session;
  if (!s) return null;
  const out = {};
  if (s.task && s.task.objective) out.objective = s.task.objective;
  if (s.plan && typeof s.plan.digest === 'function') {
    const steps = s.plan.steps || [];
    out.plan = { done: steps.filter((x) => x.done).length, total: steps.length };
  }
  const life = s.lifecycle;
  if (life && life.evidence) {
    const files = [...(life.evidence.filesChanged || [])];
    if (files.length) out.filesChanged = files.map((f) => path.basename(f));
    if (life.lastCommand) out.lastCheck = life.lastCommand;
  }
  return Object.keys(out).length ? out : null;
}

function renderAudit(app, a, { C } = {}) {
  const col = C || { bold: (s) => s, dim: (s) => s, green: (s) => s, yellow: (s) => s };
  const w = (s) => app.render.write(s);

  w('\n' + col.bold(`Audit — ${a.name}`) + col.dim(`   ${a.root}\n`));
  w(col.dim(`  ${a.fileCount} files scanned` + (a.scanned < a.fileCount ? ` (read ${a.scanned} for detail)` : '')) + '\n');

  // STRUCTURE
  w('\n  ' + col.bold('Structure') + '\n');
  if (a.languages.length) w(`    ${col.green('✓')} Language: ${a.languages.join(', ')}\n`);
  if (a.manifests.length) w(`    ${col.green('✓')} Config: ${a.manifests.join(', ')}\n`);
  if (a.tests.count) w(`    ${col.green('✓')} Tests: ${a.tests.count} test file(s)\n`);
  else w(`    ${col.yellow('⚠')} No test files found\n`);
  if (a.boundary.frontend && a.boundary.backend) w(`    ${col.green('✓')} Front end and back end both present\n`);
  else if (a.boundary.backend) w(`    ${col.green('✓')} Back end (no separate front end detected)\n`);
  else if (a.boundary.frontend) w(`    ${col.yellow('⚠')} Front end present, no clear back end detected\n`);

  // HOW IT RUNS
  w('\n  ' + col.bold('How it runs') + '\n');
  if (a.entries.length) for (const e of a.entries.slice(0, 6)) w(`    • ${e}\n`);
  else w(col.dim('    No obvious entry point found — check the manifest or README.\n'));
  if (a.run.length) w(col.dim(`    Likely commands: ${a.run.slice(0, 4).join(' · ')}\n`));

  // WHAT IT CAN DO — grouped capabilities detected from the tree
  if (a.capabilities.length) {
    w('\n  ' + col.bold('What it can do') + col.dim('  (detected from the code)') + '\n');
    let group = null;
    for (const c of a.capabilities) {
      if (c.group !== group) { group = c.group; w(col.dim(`    ${group}\n`)); }
      w(`      ${col.green('✓')} ${c.name}\n`);
    }
  }

  // WATCH AREAS — unfinished-work markers, biggest file
  const hasWatch = a.markers.length || (a.biggest.file && a.biggest.bytes > 60_000) || !a.tests.count;
  w('\n  ' + col.bold('Watch areas') + '\n');
  if (!hasWatch) w(`    ${col.green('✓')} Nothing obviously unfinished turned up.\n`);
  for (const m of a.markers) {
    w(`    ${col.yellow('⚠')} ${m.count} ${m.plain}${m.example ? col.dim(`  (e.g. ${m.example})`) : ''}\n`);
  }
  if (a.biggest.file && a.biggest.bytes > 60_000) {
    w(`    ${col.yellow('⚠')} Largest file is big: ${a.biggest.file} (${Math.round(a.biggest.bytes / 1000)}k) — worth splitting\n`);
  }
  if (!a.tests.count) w(`    ${col.yellow('⚠')} No tests means changes are unverified — add one for anything you touch\n`);

  // WHERE THE WORK STANDS — live session state, if any
  const ws = workState(app);
  if (ws) {
    w('\n  ' + col.bold('Where the work stands') + '\n');
    if (ws.objective) w(`    Task: ${ws.objective.slice(0, 80)}\n`);
    if (ws.plan) w(`    Plan: ${ws.plan.done}/${ws.plan.total} steps done\n`);
    if (ws.filesChanged) w(`    Files changed this session: ${ws.filesChanged.slice(0, 8).join(', ')}\n`);
    if (ws.lastCheck) w(`    Last check: ${ws.lastCheck.command} — ${ws.lastCheck.ok ? col.green('passed') : col.yellow('FAILED')}\n`);
  }

  // A SINGLE NEXT STEP, not a lecture.
  w('\n  ' + col.dim(nextStep(a)) + '\n');
}

function nextStep(a) {
  if (!a.tests.count) return 'Most useful next step: add a test for the part you are about to change.';
  const notImpl = a.markers.find((m) => m.plain.startsWith('unfinished stubs'));
  if (notImpl) return `Most useful next step: look at the ${notImpl.count} unfinished spot(s), starting with ${notImpl.example}.`;
  if (a.biggest.file && a.biggest.bytes > 100_000) return `Most useful next step: ${a.biggest.file} is doing a lot — consider splitting it.`;
  return 'Nothing urgent stands out — the project looks coherent. Say what you want to change.';
}

// ------------------------------------------------------------------- view ---

/**
 * The audit as lines for the AUDIT workspace tab.
 *
 * Same evidence as the command — `audit()` above did the reading — laid out as
 * a table a person can scan: what this project is, how it runs, what it can
 * already do, and what looks unfinished. Plain text with symbols, because the
 * workspace clips by character count (see healthLines for the same reason).
 *
 * @returns {string[]}
 */
function auditLines(a, width = 80, work = null) {
  const T = require('./ui/text');
  const { P } = require('./ui/paint');
  const w = Math.max(44, width);
  const inner = w - 4;                       // what fits between the borders
  if (!a) return T.box(P.head('PROJECT AUDIT'), ['  ' + P.meta('reading the project…')], w);

  // ONE TABLE: AREA / STATUS / EVIDENCE. Every row says what was looked at, how
  // sure the reading is, and the thing in the tree that says so — because an
  // audit whose lines cannot be checked is just an opinion with a frame around
  // it. Every row is fitted to the box, colour included (ui/text.js measures
  // what the terminal shows, not what is in memory).
  const cArea = Math.min(22, Math.max(14, Math.floor(inner * 0.26)));
  const cState = 13;
  const body = [];
  const head = (t) => { body.push(''); body.push(P.key(t)); };
  const row = (area, state, evidence) => {
    const room = Math.max(10, inner - cArea - cState - 4);
    body.push('  ' + T.pad(T.clip(area, cArea - 2), cArea - 2)
      + '  ' + T.pad(state, cState)
      + '  ' + T.clip(String(evidence == null ? '' : evidence), room));
  };
  const CONFIRMED = P.ok('✓ CONFIRMED');
  const REVIEW = P.warn('? REVIEW');
  const NONE = P.meta('— none');

  body.push(P.meta(`${a.fileCount} files scanned`
    + (a.scanned < a.fileCount ? `, ${a.scanned} read in full` : '')));
  body.push('');
  body.push(P.head(T.pad('AREA', cArea) + '  ' + T.pad('STATUS', cState) + '  EVIDENCE'));

  head('STRUCTURE');
  row('Language', a.languages.length ? CONFIRMED : REVIEW, a.languages.join(', ') || 'no recognisable source extensions');
  row('Config', a.manifests.length ? CONFIRMED : NONE, a.manifests.join(', ') || 'no manifest in the root');
  row('Tests', a.tests.count ? CONFIRMED : P.bad('✕ MISSING'),
    a.tests.count ? `${a.tests.count} test file(s), e.g. ${(a.tests.some || [])[0] || ''}` : 'no test files found');
  row('Front/back end', a.boundary.frontend || a.boundary.backend ? CONFIRMED : REVIEW,
    a.boundary.frontend && a.boundary.backend
      ? `both present — ${a.boundary.frontend} front, ${a.boundary.backend} back`
      : a.boundary.backend ? `back end only (${a.boundary.backend} files)`
        : a.boundary.frontend ? `front end only (${a.boundary.frontend} files)` : 'neither surface was recognisable');

  head('ENTRY POINTS');
  if (a.entries.length) for (const e of a.entries.slice(0, 6)) row('', CONFIRMED, P.path(e));
  else row('', REVIEW, 'nothing recognisable — check the manifest or the README');

  if (a.capabilities.length) {
    head('CAPABILITIES');
    let group = null;
    for (const c of a.capabilities) {
      if (c.group !== group) { group = c.group; body.push('  ' + P.meta(group)); }
      row('  ' + c.name, CONFIRMED, c.where && c.where[0] ? P.path(c.where[0]) : '');
    }
  }

  head('WATCH AREAS');
  if (!a.markers.length && a.tests.count && !(a.biggest.file && a.biggest.bytes > 60_000)) {
    row('', CONFIRMED, P.ok('nothing obviously unfinished'));
  }
  for (const m of a.markers) {
    row(m.plain.replace(/\s*\(.*\)$/, ''), P.warn(`⚠ ${m.count}`),
      m.worst ? `${m.worst.hits} in ${P.path(m.worst.file)}` : m.example ? P.path(m.example) : '');
  }
  if (!a.tests.count) row('No tests', P.warn('⚠ RISK'), 'nothing here can be verified after a change');
  if (a.biggest.file && a.biggest.bytes > 60_000) {
    row('Large file', P.warn('⚠ SIZE'), `${P.path(a.biggest.file)} · ${Math.round(a.biggest.bytes / 1000)} KB`);
  }

  if (work) {
    head('CURRENT WORK');
    if (work.objective) row('Task', P.info('● INFO'), work.objective);
    if (work.plan) row('Plan', P.info('● INFO'), `${work.plan.done}/${work.plan.total} steps done`);
    if (work.filesChanged) row('Files changed', P.info('● INFO'), work.filesChanged.join(', '));
    if (work.lastCheck) {
      row('Last check', work.lastCheck.ok ? P.ok('✓ PASSED') : P.bad('✕ FAILED'), work.lastCheck.command);
    }
  }

  head('NEXT ACTION');
  body.push('  ' + T.clip(nextStep(a), inner - 2));
  return T.box(P.head(`PROJECT AUDIT — ${a.name}`), body, w);
}

// ----------------------------------------------------------------- command ---

/**
 * `/audit` end to end.
 *   /audit               → read THIS project and report.
 *   /audit <folder|url>  → forward to /compare, so comparison lives in one place.
 */
async function runCommand(app, ctx = {}, { C, config } = {}) {
  const rest = String(ctx.rest || '').trim();
  if (rest) {
    // A source was given: this is a comparison, and /compare already owns that
    // whole capability. Forwarding keeps one implementation, not two.
    return require('./compare').runCommand(app, ctx, { C, config });
  }
  app.render.write((C ? C.dim : (s) => s)('  Reading the project…\n'));
  let a;
  try { a = await audit(app.session ? app.session.cwd : process.cwd()); }
  catch (e) { app.render.notice('error', `Could not audit: ${e.message}`); return; }
  renderAudit(app, a, { C });
  return a;
}

module.exports = { audit, renderAudit, auditLines, workState, nextStep, runCommand, MARKERS };
