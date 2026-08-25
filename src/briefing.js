'use strict';

/**
 * THE BRIEFING — a survey, written out the way one engineer briefs another.
 *
 * This is the only part of the system that is allowed to be long. Everywhere
 * else in LAIN, output is trimmed hard because it rides on every request; this
 * is paid for ONCE and exists to stop something far more expensive — a model
 * rediscovering, over eight tool calls, facts that four instruments already
 * established. A briefing that costs 3,000 tokens and removes twelve
 * exploratory round trips is a large saving, not a large cost.
 *
 * Long is not the same as undifferentiated. Every section here answers a
 * question somebody actually asks:
 *
 *   what IS this project        · PROJECT / ENVIRONMENT
 *   what has changed            · GIT
 *   does it build, run, pass    · HEALTH, kept on five separate axes
 *   what is wrong, exactly      · FINDINGS, with ids, locations and evidence
 *   is any of it one problem    · ROOT-CAUSE CANDIDATES
 *   what does nobody know       · UNVERIFIED
 *   what should I do            · REPAIR DIRECTIVE
 *
 * PLAIN TEXT, NO COLOUR, NO BOX DRAWING. The briefing is meant to survive being
 * copied, piped, and handed to a model, and ANSI escapes inside a transcript
 * are noise that costs tokens and can break a parse. The terminal renderer adds
 * colour around this; it never adds it inside.
 */

const path = require('path');
const F = require('./findings');
const F_facts = require('./facts');
const rootcause = require('./rootcause');
const { HEALTH } = require('./survey');

/** Hard bounds, so one pathological project cannot produce a megabyte. */
const MAX_DETAILED = 40;
const MAX_SUMMARY_ROWS = 120;

function rule(title) { return `\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`; }
function sub(title) { return `\n--- ${title} ${'-'.repeat(Math.max(0, 68 - title.length))}`; }

/** `src/x.js:12:4` — every location said the same way. */
function where(f) {
  if (!f.file) return null;
  return `${f.file}${f.line ? `:${f.line}` : ''}${f.line && f.column ? `:${f.column}` : ''}`;
}

// ------------------------------------------------------------------ header ---

function projectSection(s) {
  const out = [rule('PROJECT CONTEXT')];
  out.push(`Root: ${s.root}`);
  const langs = Object.entries(s.languages || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ext, n]) => `${ext} (${n})`);
  if (langs.length) out.push(`Files by type: ${langs.join(', ')}`);
  out.push(`Source files analysed: ${s.scanned}`);
  out.push(`Survey took ${Math.round(s.elapsedMs / 100) / 10}s.`);
  return out.join('\n');
}

function environmentSection(s) {
  const e = s.environment;
  const out = [rule('ENVIRONMENT')];
  if (!e) { out.push('Not determined.'); return out.join('\n'); }
  out.push(`OS: ${e.os}`);
  out.push(`Shell: ${e.shell.preferred}${e.shell.available.length > 1
    ? ` (also available: ${e.shell.available.filter((x) => x !== e.shell.preferred).join(', ')})` : ''}`);
  if (e.shell.note) out.push(`  NOTE: ${e.shell.note}`);
  const rt = Object.entries(e.runtimes || {}).map(([k, v]) => (k === v ? k : `${k} (${v})`));
  if (rt.length) out.push(`Runtimes on PATH: ${rt.join(', ')}`);
  if (e.packageManager) {
    out.push(`Package manager: ${e.packageManager.manager} (from ${e.packageManager.from})`
      + (e.packageManager.missing ? ' — NOT INSTALLED on this machine' : ''));
  }
  if (e.venv) {
    out.push(e.venv.active
      ? `Python venv: active (${e.venv.path})`
      : `Python venv: ${e.venv.path} — NOT ACTIVE in this shell`);
  }
  if (e.testRunner) out.push(`Test command: ${e.testRunner.command} (from ${e.testRunner.from})`);

  // ---- EXECUTION STATE, so it is never guessed at again ------------------
  out.push(sub('EXECUTION'));
  out.push(`Commands run in: ${s.root}`);
  out.push('Every execution tool accepts an explicit cwd; there is no need to cd inside a command.');
  if (s.lastCommand) {
    out.push(`Last command: ${s.lastCommand.command}`);
    out.push(`  ${s.lastCommand.ok ? 'PASSED' : `FAILED (exit ${s.lastCommand.exitCode})`}`);
  } else {
    out.push('Last command: none recorded in this session.');
  }
  if (s.loops && s.loops.length) {
    out.push('Commands that failed repeatedly and never succeeded:');
    for (const l of s.loops.slice(0, 5)) {
      out.push(`  ${l.command.slice(0, 100)}`);
      out.push(`    ${l.attempts} attempts · ${l.classifications.join(', ')}`
        + `${l.shells.length > 1 ? ` · ${l.shells.length} shells` : ''}`);
      if (l.shells.length > 1 && l.classifications.length === 1) {
        out.push('    CONCLUSION: the classification did not change across shells. Changing shell again will not help.');
      }
    }
  }
  return out.join('\n');
}

/**
 * THE OPERATIONAL CONTRACT — the conventions, before anything else.
 *
 * Placed early on purpose. Every section after it reports file:line, shell
 * commands and parameter names, and all of those are ambiguous until the reader
 * knows what the numbering counts from and which shell is meant. Putting the
 * contract after the findings would mean the findings are read first and
 * interpreted twice.
 *
 * UNKNOWN FACTS ARE PRINTED AS LOUDLY AS KNOWN ONES. The instinct is to hide
 * what could not be established; that is exactly backwards, because those are
 * the ones somebody is about to spend requests on. Where several unknowns share
 * one reason — everything the Probe owns, for instance — the reason is stated
 * once and the names are listed under it, so honesty does not become repetition.
 */
function factsSection(facts, changed) {
  const out = [rule('PROJECT FACTS / OPERATIONAL CONTRACT')];
  if (!facts || !facts.length) {
    out.push('No project conventions could be established.');
    return out.join('\n');
  }
  out.push('Established from this repository. Do not rediscover these; do not experiment against them.');
  out.push('A fact marked UNKNOWN was NOT established — investigate it rather than assuming a value.');

  for (const [area, list] of F_facts.byArea(facts)) {
    const known = list.filter((f) => f.value !== F_facts.REPR.UNKNOWN);
    const unknown = list.filter((f) => f.value === F_facts.REPR.UNKNOWN);
    out.push(sub(area));
    for (const f of known) {
      out.push(F_facts.line(f));
      if (f.counterExample) out.push(`${' '.repeat(30)}NOT: ${f.counterExample}`);
      if (f.notes) out.push(`${' '.repeat(30)}${wrap(f.notes, 30)}`);
    }
    if (unknown.length) {
      // Group by reason so one shared explanation is not repeated five times.
      const byWhy = new Map();
      for (const f of unknown) {
        const why = f.why || 'not established from this repository';
        if (!byWhy.has(why)) byWhy.set(why, []);
        byWhy.get(why).push(f.name);
      }
      for (const [why, names] of byWhy) {
        out.push(`  UNKNOWN: ${names.join(', ')}`);
        out.push(`${' '.repeat(4)}${wrap(why, 4)}`);
      }
    }
  }

  if (changed && changed.length) {
    out.push(sub('CHANGED SINCE THE PREVIOUS BRIEFING'));
    out.push('A convention answering differently is either a real migration or an unstable reading. Either');
    out.push('is worth confirming before relying on it.');
    for (const c of changed) out.push(`  ${c.id}  ${c.name}: was ${c.was}, now ${c.value}`);
  }
  return out.join('\n');
}

function gitSection(s) {
  const out = [rule('GIT STATE')];
  if (!s.git || !s.git.ok) { out.push(s.git ? s.git.error : 'Not available.'); return out.join('\n'); }
  if (!s.git.files.length) { out.push('Working tree is clean — nothing differs from the last commit.'); return out.join('\n'); }
  out.push(`${s.git.files.length} file(s) differ from the last commit, ${s.git.totalLines} line(s) in total.`);
  for (const f of s.git.files.slice(0, 40)) {
    const marks = [f.untracked ? 'NEW' : null, f.deleted ? 'DELETED' : null,
      f.renamed ? `renamed from ${f.from}` : null, f.rewrite ? 'WHOLE-FILE REWRITE' : null,
      f.generated ? f.generated : null, f.unexpected ? 'not written by this session' : null]
      .filter(Boolean).join(', ');
    out.push(`  ${f.file}  +${f.added} -${f.removed}${marks ? `  [${marks}]` : ''}`);
  }
  if (s.git.files.length > 40) out.push(`  [${s.git.files.length - 40} more]`);
  if (s.git.missing && s.git.missing.length) {
    out.push(`Written by this session but showing no diff: ${s.git.missing.join(', ')}`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ health ---

/**
 * FIVE AXES, FIVE LINES, AND A SENTENCE THAT REFUSES TO LET THEM MERGE.
 *
 * The sentence is not decoration. `BUILD: PASS` next to `ENGINEERING: DEGRADED`
 * is the single most misread pair in any report of this kind, and the reflex to
 * read the first line and stop is strong enough to be worth interrupting in
 * words.
 */
function healthSection(s) {
  const h = s.health;
  const out = [rule('HEALTH — FIVE SEPARATE AXES')];
  out.push(`BUILD        ${h.build}`);
  out.push(`TESTS        ${h.test}`);
  out.push(`RUNTIME      ${h.runtime}`);
  out.push(`FRONTEND     ${h.frontend}`);
  out.push(`ENGINEERING  ${h.engineering}`);
  out.push('');
  if (h.build === HEALTH.PASS && h.engineering !== HEALTH.CLEAN) {
    out.push('BUILD PASS DOES NOT MEAN THE PROJECT IS HEALTHY. The source parses; that is all it establishes.');
    out.push('The engineering findings below are real and survive a successful build, because a compiler has no');
    out.push('opinion on a leftover dataset, a name that resolves to nothing on an untaken path, or a warning');
    out.push('that is a latent bug.');
  }
  if (h.test === HEALTH.PASS && h.engineering !== HEALTH.CLEAN) {
    out.push('A PASSING SUITE DOES NOT MEAN THE FINDINGS ARE HARMLESS. It means no test reached them.');
  }
  const unverified = [
    h.test === HEALTH.UNVERIFIED ? 'TESTS' : null,
    h.runtime === HEALTH.UNVERIFIED ? 'RUNTIME' : null,
    h.frontend === HEALTH.UNVERIFIED ? 'FRONTEND' : null,
    h.build === HEALTH.UNVERIFIED ? 'BUILD' : null,
  ].filter(Boolean);
  if (unverified.length) {
    out.push(`UNVERIFIED: ${unverified.join(', ')}. Nothing looked at ${unverified.length > 1 ? 'these' : 'this'}.`);
    out.push('That is not the same as a pass, and must not be reported as one.');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- findings ---

/**
 * One finding, in full.
 *
 * The field order is the order a reader needs them in: WHERE first, because
 * that is what they act on; then WHAT; then WHY IT MATTERS; then, last, HOW IT
 * IS KNOWN — which is what tells them how much to trust the rest.
 */
function detail(f) {
  const out = [`\n${f.id}`];
  out.push(`  Category:    ${f.category}`);
  out.push(`  Severity:    ${f.severity}`);
  out.push(`  Confidence:  ${f.confidence}`);
  // `where()` already falls back to the bare path when there is no line, so a
  // separate File: row printed the same string twice.
  const loc = where(f);
  if (loc) out.push(`  Location:    ${loc}`);
  if (f.symbol) out.push(`  Symbol:      ${f.symbol}`);
  if (f.container) out.push(`  Container:   ${f.container}`);
  if (f.actual != null) out.push(`  Actual:      ${f.actual}`);
  if (f.expected != null) out.push(`  Candidate:   ${f.expected}`);
  if (f.references != null) out.push(`  References:  ${f.references}`);
  out.push(`  Message:     ${f.message}`);
  if (f.explanation) out.push(`  Explanation: ${wrap(f.explanation, 15)}`);
  if (f.risk) out.push(`  Risk:        ${wrap(f.risk, 15)}`);
  if (f.related.files.length) out.push(`  Related:     ${f.related.files.slice(0, 8).join(', ')}`);
  if (f.related.symbols.length) out.push(`  Symbols:     ${f.related.symbols.slice(0, 8).join(', ')}`);
  if (f.related.tests.length) out.push(`  Tests:       ${f.related.tests.slice(0, 6).join(', ')}`);
  out.push(`  Source:      ${f.source}`);
  if (f.evidence) out.push(`  Evidence:    ${wrap(f.evidence, 15)}`);
  out.push(`  State:       ${f.state}`);
  return out.join('\n');
}

/** Wrap continuation lines under a field label so the column stays readable. */
function wrap(text, indent, width = 92) {
  const pad = ' '.repeat(indent);
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line.length + w.length + 1) > width - indent) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join(`\n${pad}`);
}

function findingsSection(s, findings) {
  const out = [rule('FINDINGS')];
  if (!findings.length) {
    out.push('No findings. Every analyser that ran reported nothing.');
    out.push('This is not the same as "no defects" — see UNVERIFIED below for what was not looked at.');
    return out.join('\n');
  }
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  out.push(F.SEVERITY_ORDER.filter((sv) => counts[sv]).map((sv) => `${sv}: ${counts[sv]}`).join('   ')
    || `${findings.length} findings`);

  const sorted = [...findings].sort(F.bySeverityThenFile);
  const detailed = sorted.filter((f) => f.severity !== F.SEVERITY.INFO).slice(0, MAX_DETAILED);
  const rest = sorted.filter((f) => !detailed.includes(f));

  for (const f of detailed) out.push(detail(f));

  if (rest.length) {
    out.push(sub('ALSO NOTED (one line each)'));
    for (const f of rest.slice(0, MAX_SUMMARY_ROWS)) {
      out.push(`  ${f.id.padEnd(16)} ${(where(f) || '-').padEnd(34)} ${f.message.slice(0, 100)}`);
    }
    if (rest.length > MAX_SUMMARY_ROWS) out.push(`  [${rest.length - MAX_SUMMARY_ROWS} more]`);
  }
  return out.join('\n');
}

function rootCauseSection(candidates) {
  const out = [rule('ROOT-CAUSE CANDIDATES')];
  if (!candidates.length) {
    out.push('No group of findings shares a file, a symbol or a declared relationship.');
    out.push('Treat the findings above as independent unless reading them suggests otherwise.');
    return out.join('\n');
  }
  out.push('Findings below are grouped because they touch the same file or the same symbol — that grouping is');
  out.push('OBSERVED. The hypothesis attached to each is INFERRED, and may be wrong.');
  for (const c of candidates) {
    out.push(`\n${c.id}`);
    out.push(`  Area:        ${c.area}`);
    out.push(`  Confidence:  ${c.confidence}`);
    out.push(`  Members:     ${c.members.map((m) => m.id).join(', ')}`);
    out.push(`  Sources:     ${c.sources.join(', ')}`);
    out.push(`  Hypothesis:  ${wrap(c.hypothesis, 15)}`);
    out.push('  Why grouped: they share the file or symbol named above, not a similarity of wording.');
  }
  return out.join('\n');
}

function unverifiedSection(s, findings) {
  const out = [rule('UNVERIFIED — WHAT NOBODY LOOKED AT')];
  const rows = findings.filter((f) => f.severity === F.SEVERITY.UNVERIFIED);
  if (!rows.length && !(s.skipped || []).length) {
    out.push('Every analyser this project warrants ran.');
    return out.join('\n');
  }
  for (const f of rows) {
    out.push(`\n${f.id}  ${f.message}`);
    if (f.explanation) out.push(`  ${wrap(f.explanation, 2)}`);
    if (f.risk) out.push(`  RISK: ${wrap(f.risk, 8)}`);
  }
  for (const sk of s.skipped || []) out.push(`\n  ${sk.tool}: ${sk.why}`);
  out.push('\nNone of the above may be reported as passing. "Not measured" and "measured and fine" are different');
  out.push('results, and only one of them was obtained.');
  return out.join('\n');
}

function limitationsSection(s) {
  const out = [rule('KNOWN LIMITATIONS OF THIS BRIEFING')];
  out.push('- The symbol model, typo check and semantic ranges cover JavaScript (.js/.cjs/.mjs) only.');
  out.push('  TypeScript findings come from tsc when it is installed; Python from its own parser.');
  out.push('- The unresolved-name check reports only when it can name a near miss, so it under-reports by design.');
  out.push('- It sees BARE identifiers. A misspelled PROPERTY — el.warth for el.width — is not detectable without');
  out.push('  type information, because nothing here knows what el is. Those are found by tsc, or not at all.');
  out.push('- A name referenced only inside a template literal is invisible to the symbol model.');
  out.push('- Residue and dependency findings prove absence of TEXTUAL reference, not absence of dependency:');
  out.push('  code reached by a computed name, a plugin registry or reflection can be missed.');
  out.push('- Root-cause grouping is mechanical. A group is evidence of shared surface, not proof of shared cause.');
  if (s.notes && s.notes.length) for (const n of s.notes) out.push(`- ${n}`);
  return out.join('\n');
}

/**
 * THE DIRECTIVE — generated identically every time, on purpose.
 *
 * A briefing that ends with facts and no instruction gets read as a status
 * report. This section is what turns it into a handover: it names the loop, and
 * it names the specific ways this kind of work goes wrong.
 */
function directiveSection(s, candidates) {
  const out = [rule('REPAIR DIRECTIVE')];

  // ---- THE CONTRACT COMES BEFORE THE WORK -------------------------------
  //
  // Stated here as well as in its own section, because this is the part that
  // is read immediately before acting. The instruction that matters is the
  // last one: a contradiction is worth REPORTING, and is never a licence to
  // quietly adopt a different convention — that is how one wrong belief
  // becomes the project's new de facto rule.
  out.push('OPERATIONAL CONTRACT');
  out.push('You are working inside the conventions listed under PROJECT FACTS above. They were established');
  out.push('from this repository, not assumed. Do not rediscover them and do not experiment against them:');
  out.push('use the stated shell, the stated working directory, the stated argument representations, and the');
  out.push('stated source-location numbering.');
  out.push('A fact marked UNKNOWN is genuinely not established. Investigate it — often the contract names the');
  out.push('exact call that answers it — rather than trying values until one is accepted.');
  out.push('If you find evidence contradicting a stated fact, REPORT THE CONTRADICTION. Do not silently adopt');
  out.push('a different convention.');
  out.push('');
  out.push('The findings above were produced by deterministic instruments, not by a model. They are evidence.');
  out.push('Treat CONFIDENCE as load-bearing: PROVEN needs no confirmation, SUSPECTED may be nothing.');
  out.push('');
  out.push('For each finding you take on:');
  out.push('  1. Open the exact file and line given. Do not search for it.');
  out.push('  2. Read the surrounding implementation before deciding what is wrong.');
  out.push('  3. Decide whether the finding is real. A SUSPECTED finding may be correct code.');
  out.push('  4. Find the cause, not the symptom.');
  out.push('  5. Check the related files and symbols listed with it — those are the other places to look.');
  out.push('  6. Check the ROOT-CAUSE CANDIDATES before fixing anything: several findings may be one edit.');
  out.push('  7. Make the smallest change that fixes the cause. Prefer replace_symbol or apply_patch over');
  out.push('     rewriting a file; a whole-file rewrite makes the intended change unreviewable.');
  out.push('  8. If you replaced an implementation, prove the old one is gone with find_residue.');
  out.push('  9. Run something that would have failed before the fix, and read the result.');
  out.push(' 10. Check the diff shape with review_changes before you report.');
  out.push(' 11. Re-run this briefing. It is a SNAPSHOT and is stale the moment you edit anything.');
  out.push('');
  out.push('Rules that apply throughout:');
  out.push('- Build success is one piece of evidence. It is not a verdict on the project.');
  out.push('- Do not report an unverified subsystem as verified. Absence of measurement is not a pass.');
  out.push('- Do not guess shell syntax. A failing command already carries its shell, its directory and a');
  out.push('  classification; read that instead of trying another shell.');
  out.push('- Do not edit files unrelated to a finding.');
  out.push('- Keep CHANGED separate from VERIFIED when you report.');
  if (candidates.length) {
    out.push('');
    out.push(`Start with ${candidates[0].id} (${candidates[0].confidence} confidence): `
      + `${candidates[0].members.length} findings share ${candidates[0].area}.`);
  }
  const worst = [...s.findings].sort(F.bySeverityThenFile)[0];
  if (worst && (worst.severity === F.SEVERITY.CRITICAL || worst.severity === F.SEVERITY.ERROR)) {
    out.push(`The most severe single finding is ${worst.id} at ${where(worst) || 'no file'}.`);
  }
  return out.join('\n');
}

function lifecycleSection(delta) {
  if (!delta || (!delta.fixed.length && !delta.appeared.length && !delta.unobserved.length)) return '';
  const out = [rule('SINCE THE PREVIOUS BRIEFING')];
  if (delta.fixed.length) {
    out.push(`FIXED (${delta.fixed.length}) — the analyser that found these ran again and no longer reports them:`);
    for (const f of delta.fixed.slice(0, 20)) out.push(`  ${f.id}  ${f.message.slice(0, 90)}`);
  }
  if (delta.unobserved.length) {
    out.push(`\nNO LONGER OBSERVED (${delta.unobserved.length}) — these are NOT fixed. The analyser that found`);
    out.push('them did not run this time, so their state is unknown:');
    for (const f of delta.unobserved.slice(0, 20)) out.push(`  ${f.id}  ${f.message.slice(0, 90)}`);
  }
  if (delta.appeared.length) {
    out.push(`\nNEW (${delta.appeared.length}) — not present in the previous briefing:`);
    for (const f of delta.appeared.slice(0, 20)) out.push(`  ${f.id}  ${f.message.slice(0, 90)}`);
  }
  return out.join('\n');
}

/**
 * Render a completed survey.
 *
 * @param {object} survey  a survey.run() result
 * @param {object} [delta] a ledger.record() result, for the lifecycle section
 */
function render(survey, delta = null, factDelta = null) {
  const findings = delta ? delta.findings : survey.findings;
  const candidates = rootcause.candidates(findings);
  const facts = factDelta ? factDelta.facts : (survey.facts || []);
  const parts = [
    'LAIN ENGINEERING BRIEFING',
    `Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} for ${path.basename(survey.root)}`,
    'This is a snapshot. It is stale as soon as any file changes.',
    projectSection(survey),
    factsSection(facts, factDelta ? factDelta.changed : null),
    environmentSection(survey),
    gitSection(survey),
    healthSection(survey),
    findingsSection(survey, findings),
    rootCauseSection(candidates),
    lifecycleSection(delta),
    unverifiedSection(survey, findings),
    limitationsSection(survey),
    directiveSection({ ...survey, findings }, candidates),
  ].filter(Boolean);
  return parts.join('\n');
}

module.exports = { render, detail, healthSection, directiveSection, rootCauseSection, wrap, where, MAX_DETAILED };
