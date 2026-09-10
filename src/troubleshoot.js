'use strict';

/**
 * `/troubleshoot` — A WORKFLOW YOU CAN SEE, not just a differently-worded prompt.
 *
 * Typing `/troubleshoot there are 8 errors silently dropped` used to do one
 * thing: set the TROUBLESHOOT mode paragraph and hand the sentence to the model.
 * The model then investigated perfectly well — and the user watched a hundred
 * lines of tool chatter scroll past with no structure to read it by. The
 * workflow existed; nothing about it was visible.
 *
 * So this frames the work, twice:
 *
 *   BEFORE  the PROBLEM as stated, and the EVIDENCE a local scan can already
 *           see — which files mention the user's own words, and which of LAIN's
 *           unfinished-work markers are relevant. Deterministic, costs nothing,
 *           and it is on screen before the model has said anything.
 *   AFTER   the INVESTIGATION that actually ran (the real tool calls, in order),
 *           and the model's FINDING, LIKELY CAUSE, RECOMMENDED FIX and
 *           VERIFICATION.
 *
 * WHAT IT WILL NOT DO IS INVENT THE CONCLUSION. The closing sections are parsed
 * out of what the model genuinely said. If it did not state a cause, the report
 * says "not stated" rather than promoting a plausible sentence into a finding —
 * which is the exact failure the TROUBLESHOOT workflow exists to prevent.
 *
 * The detailed tool log is untouched and stays in the ACTIVITY view. This is the
 * summary you can read without it, not a replacement for it.
 */

const { scanDir } = require('./compare');
const { MARKERS } = require('./audit');
const T = require('./ui/text');
const { P } = require('./ui/paint');

/** Words too common to point anywhere. */
const STOP = new Set([
  'the', 'and', 'but', 'for', 'are', 'was', 'were', 'that', 'this', 'with', 'from', 'have', 'has',
  'not', 'you', 'your', 'its', 'it\'s', 'they', 'them', 'when', 'what', 'why', 'how', 'does', 'doesn',
  'there', 'their', 'been', 'being', 'into', 'about', 'some', 'any', 'all', 'can', 'will', 'would',
  'should', 'could', 'error', 'errors', 'issue', 'problem', 'bug', 'fix', 'broken', 'wrong',
]);

/** Files worth opening — source, not lockfiles or assets. */
const READABLE = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|cs|php|swift|kt|sh|ps1|json|ya?ml|toml|ini|cfg|env)$/i;
const MAX_FILES = 300;
const MAX_HITS = 6;

/** The distinctive words in the user's description, most specific first. */
function terms(problem) {
  const words = String(problem || '').toLowerCase().match(/[a-z_][a-z0-9_.-]{2,}/g) || [];
  const seen = new Set();
  const out = [];
  for (const raw of words) {
    const w = raw.replace(/^[._-]+|[._-]+$/g, '');
    if (w.length < 4 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  // Longer words are more specific, and a filename-looking token most of all.
  return out.sort((a, b) => (b.includes('.') ? 1 : 0) - (a.includes('.') ? 1 : 0) || b.length - a.length).slice(0, 5);
}

/** Which of the unfinished-work markers this description is actually about. */
function relevantMarkers(problem) {
  const p = String(problem || '').toLowerCase();
  const out = [];
  if (/\b(?:silent|silently|swallow|drop|dropped|caught|catch|except|exception|error)\b/.test(p)) out.push('emptycatch');
  if (/\b(?:not implemented|unimplemented|stub|missing|todo|unfinished)\b/.test(p)) out.push('stub', 'todo');
  return out;
}

/**
 * WHAT CAN BE SEEN WITHOUT ASKING ANYONE. One bounded pass over the tree,
 * counting the user's own words and the relevant markers per file.
 */
async function gather(root, problem) {
  const tree = scanDir(root);
  const want = terms(problem);
  const markerIds = relevantMarkers(problem);
  const markers = MARKERS.filter((m) => markerIds.includes(m.id));
  const perFile = new Map();
  const markerCounts = new Map();
  let read = 0;

  for (const f of tree.files) {
    if (!READABLE.test(f) || read >= MAX_FILES) continue;
    read += 1;
    const body = await tree.read(f);
    if (!body) continue;
    const low = body.toLowerCase();
    const name = f.toLowerCase();
    let score = 0;
    const matched = [];
    for (const w of want) {
      // THE PATH COUNTS TOO. "the dashboard is dropping errors" points straight
      // at dashboard.py, and a content-only search finds nothing there because
      // the file does not say its own name. A name match is worth several
      // mentions — it is what a person would look at first.
      const inName = name.includes(w);
      const n = low.split(w).length - 1;
      if (inName) { score += 5; matched.push(w); }
      if (n > 0) { score += n; if (!inName) matched.push(w); }
    }
    for (const m of markers) {
      m.re.lastIndex = 0;
      const n = (body.match(m.re) || []).length;
      if (!n) continue;
      markerCounts.set(m.id, (markerCounts.get(m.id) || 0) + n);
      score += n * 3;              // a real marker outweighs a word mention
      matched.push(m.id);
    }
    if (score > 0) perFile.set(f, { file: f, score, matched: [...new Set(matched)] });
  }

  const hits = [...perFile.values()].sort((a, b) => b.score - a.score).slice(0, MAX_HITS);
  return {
    terms: want,
    scanned: read,
    total: tree.files.length,
    hits,
    markers: markers.map((m) => ({ id: m.id, plain: m.plain, count: markerCounts.get(m.id) || 0 }))
      .filter((m) => m.count > 0),
  };
}

// ------------------------------------------------------- the model's words ---

const HEADS = [
  ['finding', /^\W*(?:\*\*)?\s*(?:finding|findings|what i found|diagnosis|what is happening)\b\s*(?:\*\*)?\s*[:\-—]?\s*/i],
  ['cause', /^\W*(?:\*\*)?\s*(?:likely cause|root cause|the cause|cause)\b\s*(?:\*\*)?\s*[:\-—]?\s*/i],
  ['fix', /^\W*(?:\*\*)?\s*(?:recommended fix|suggested fix|the fix|fix|what to do)\b\s*(?:\*\*)?\s*[:\-—]?\s*/i],
  ['verification', /^\W*(?:\*\*)?\s*(?:verification|how to verify|to verify|verified by)\b\s*(?:\*\*)?\s*[:\-—]?\s*/i],
];

/**
 * Pull the four closing sections out of what the model said.
 *
 * Nothing is inferred. A section the model did not write comes back empty, and
 * the report shows it as "not stated" — a gap the user can see is worth more
 * than a sentence promoted to a conclusion it never claimed to be.
 */
function conclusions(text) {
  const out = { finding: [], cause: [], fix: [], verification: [], rest: [] };
  let current = 'rest';
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) { if (out[current].length) out[current].push(''); continue; }
    const head = HEADS.find(([, re]) => re.test(line));
    if (head) {
      current = head[0];
      const tail = line.replace(head[1], '').trim();
      if (tail) out[current].push(tail);
      continue;
    }
    out[current].push(line);
  }
  for (const k of Object.keys(out)) {
    while (out[k].length && !out[k][out[k].length - 1]) out[k].pop();
  }
  return out;
}

// ------------------------------------------------------------------ report ---

/** Start a report for a problem. Stored on the app so `/copy troubleshoot` finds it. */
async function begin(app, problem) {
  const evidence = await gather(app.session.cwd, problem);
  const report = { problem, project: require('./ui/text').projectName(app.session.cwd), evidence, investigation: [], conclusions: null, startedAt: Date.now() };
  app._troubleshoot = report;
  return report;
}

/**
 * Close a report with what ACTUALLY happened: the real tool calls of the turn,
 * in order, and whatever the model concluded.
 */
function conclude(app, record) {
  const report = app._troubleshoot;
  if (!report) return null;
  const views = require('./ui/views');
  const actions = (record && record.actions) || [];
  const seen = new Set();
  for (const a of actions) {
    const said = `${a.ok ? '✓' : '✗'} ${views.phrase(a.name, a.target)}`;
    if (seen.has(said)) continue;
    seen.add(said);
    report.investigation.push({ text: said, ok: a.ok !== false });
  }
  report.conclusions = conclusions(record && record.text);
  report.endedAt = Date.now();
  return report;
}

function lastReport(app) { return (app && app._troubleshoot) || null; }

/** The report as a framed pane, at any width. */
function reportLines(r, width = 80) {
  const w = Math.max(44, width);
  const inner = w - 4;
  if (!r) return T.box(P.head('TROUBLESHOOT'), ['  ' + P.meta('nothing being troubleshot')], w);
  const body = [];
  const head = (t) => { if (body.length) body.push(''); body.push(P.key(t)); };
  const wrapped = (text, paint = (s) => s) => {
    for (const l of require('./ui/views').wrap(String(text), inner - 2)) body.push('  ' + paint(l));
  };

  head('PROBLEM');
  wrapped(r.problem);

  head('EVIDENCE');
  const e = r.evidence || { hits: [], markers: [], terms: [] };
  if (e.markers && e.markers.length) {
    for (const m of e.markers) body.push('  ' + P.warn('⚠ ') + `${m.count} ${m.plain}`);
  }
  if (e.hits && e.hits.length) {
    for (const h of e.hits) {
      body.push('  ' + P.warn('⚠ ') + P.path(T.clip(h.file, inner - 26))
        + P.meta(`   ${h.score} match(es): ${h.matched.slice(0, 3).join(', ')}`));
    }
  }
  if ((!e.hits || !e.hits.length) && (!e.markers || !e.markers.length)) {
    body.push('  ' + P.meta(`nothing in the tree matched ${e.terms && e.terms.length ? e.terms.join(', ') : 'this description'} — the cause is probably not in the source`));
  }
  body.push('  ' + P.meta(`scanned ${e.scanned} of ${e.total} files locally, before asking anything`));

  head('INVESTIGATION');
  if (r.investigation.length) {
    for (const i of r.investigation.slice(0, 14)) {
      body.push('  ' + (i.ok ? P.ok(i.text.slice(0, 1)) : P.bad(i.text.slice(0, 1))) + ' ' + T.clip(i.text.slice(2), inner - 4));
    }
    if (r.investigation.length > 14) body.push('  ' + P.meta(`… ${r.investigation.length - 14} more, in full in the ACTIVITY view`));
  } else {
    body.push('  ' + P.meta('not started yet'));
  }

  const c = r.conclusions;
  const section = (title, key, paint) => {
    head(title);
    const lines = c && c[key] && c[key].length ? c[key] : null;
    if (!lines) {
      // NOT STATED is a real answer and is shown as one. Filling it from the
      // nearest plausible sentence is how a guess becomes a diagnosis.
      body.push('  ' + P.meta('not stated' + (c ? '' : ' yet')));
      return;
    }
    for (const l of lines) wrapped(l, paint);
  };
  section('FINDING', 'finding');
  section('LIKELY CAUSE', 'cause', P.warn);
  section('RECOMMENDED FIX', 'fix');
  section('VERIFICATION', 'verification');

  if (c && c.rest.length && !c.finding.length) {
    head('WHAT THE MODEL SAID');
    for (const l of c.rest.slice(0, 12)) wrapped(l, P.meta);
  }

  // THE SECOND OPINION, kept visibly separate. An external reviewer's
  // hypothesis rendered as LAIN's own finding is the one failure a two-model
  // loop must not have, so every line it produced is labelled EXTERNAL, painted
  // in the external colour, and grouped under the round it came from.
  if (Array.isArray(r.rounds) && r.rounds.length) {
    head('EXTERNAL REVIEW');
    body.push('  ' + P.external('EXTERNAL') + P.meta(`  ${(r.external && r.external.model) || 'second model'}`));
    for (const rd of r.rounds) {
      body.push('');
      body.push('  ' + P.meta(`round ${rd.round}`));
      const s = rd.analysis.sections;
      const part = (label, rows, paint = (x) => x) => {
        if (!rows || !rows.length) return;
        body.push('    ' + P.external(label));
        for (const l of rows.slice(0, 4)) {
          for (const line of require('./ui/views').wrap(String(l), inner - 8)) body.push('      ' + paint(line));
        }
      };
      part('FACT', s.fact);
      part('EVIDENCE', s.evidence, P.path);
      part('HYPOTHESIS', s.hypothesis, P.warn);
      part('RECOMMENDATION', s.recommendation);
      if (!s.fact.length && !s.recommendation.length) part('(unstructured reply)', s.rest, P.meta);
      if (rd.analysis.overclaim) {
        body.push('      ' + P.warn(`⚠ claimed "${rd.analysis.overclaim}" — it has no tools here and ran nothing`));
      }
    }
  }

  if (r.stop) {
    head('OUTCOME');
    const good = /fixed/.test(r.stop);
    body.push('  ' + (good ? P.ok('✓ ') : P.warn('· ')) + (good ? P.ok(r.stop) : P.warn(r.stop))
      + (r.stopDetail ? P.meta(` — ${T.clip(r.stopDetail, inner - 30)}`) : ''));
  }

  return T.box(P.head(`TROUBLESHOOT — ${r.project}`), body, w);
}

// ----------------------------------------------------------------- command ---

async function runCommand(app, { rest }, { C } = {}) {
  const col = C || { bold: (s) => s, dim: (s) => s };
  if (!rest) {
    app.render.write('\n' + col.bold('Troubleshoot what?') + '\n');
    app.render.write(col.dim('  Describe the problem in your own words, e.g.\n'));
    app.render.write(col.dim("    /troubleshoot the Telegram signal button won't switch from OFF to ON\n"));
    app.render.write(col.dim('  LAIN scans for evidence first, then traces the path — trigger → handler →\n'));
    app.render.write(col.dim('  request → state → service — and reports what it ruled out.\n'));
    return;
  }

  // WITH AN EXTERNAL ACTOR CONFIGURED THIS IS A RELAY, not a single turn: LAIN
  // investigates, a reviewer looks at what it found, LAIN acts and verifies,
  // and the reviewer looks at the result — bounded, with a named exit. See
  // investigation.js. Without one, the local workflow below runs unchanged and
  // says so; it never quietly substitutes LAIN's own model for the reviewer.
  //
  // GATED ON THE ACTOR BEING GENUINELY USABLE, not on a flag someone set. It
  // used to ask `external.settings(cfg).ok`, which is the question "is a MODEL
  // configured" — so a human relay, which needs no model at all, could never
  // reach the relay however deliberately it was chosen.
  const reviewer = require('./actors').create(app);
  if (reviewer && reviewer.status().ok) {
    return require('./investigation').relay(app, rest, { C: col });
  }

  // THE EVIDENCE PASS RUNS FIRST, and is on screen before the model is asked
  // anything. It is local, deterministic and free.
  let report = null;
  try { report = await begin(app, rest); }
  catch (e) { app.render.notice('warn', `could not scan for evidence first: ${e.message}`); }
  if (report) {
    app.render.write('\n');
    for (const l of reportLines(report, app.render.width)) app.render.write(l + '\n');
    app.render.write('\n');
  }

  const record = await app.submit(rest, { forceMode: 'TROUBLESHOOT' });

  if (report) {
    conclude(app, record);
    app.render.write('\n');
    for (const l of reportLines(report, app.render.width)) app.render.write(l + '\n');
    // NOT CONFIGURED IS SAID OUT LOUD. Silence here would leave "did a second
    // model look at this?" unanswerable, which is how a single opinion gets
    // mistaken for a reviewed one.
    app.render.write('\n  ' + col.dim('EXTERNAL ACTOR  ') + col.yellow('✕ NOT CONFIGURED')
      + col.dim('  — local investigation only. /external to choose a reviewer.\n'));
    app.render.write(col.dim('  The full tool log is in the ACTIVITY view. /copy troubleshoot takes this report.\n'));
  }
  return report;
}

module.exports = { runCommand, begin, conclude, gather, terms, conclusions, reportLines, lastReport, relevantMarkers };
