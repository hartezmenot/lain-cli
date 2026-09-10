'use strict';

/**
 * ONE VOCABULARY FOR EVERY ENGINEERING FINDING, whatever produced it.
 *
 * A parse error, a dangling symbol, a leftover from a half-done migration and a
 * test that did not run are four completely different observations. What they
 * have in common is what a person
 * needs in order to act on them: WHERE it is, WHAT it is, HOW SURE we are, WHAT
 * SAW IT, and WHETHER IT IS STILL OPEN. (A console exception from a real
 * browser was a fifth once; it went with the browser in 2026-09, and the
 * vocabulary that read it with it.)
 *
 * Without a shared shape, each producer invents its own — and the report
 * becomes a pile of differently-formatted paragraphs that a reader has to
 * normalise in their head before they can compare anything. That normalising is
 * the work this file removes.
 *
 * THE FOUR AXES, kept apart on purpose because collapsing any two of them loses
 * the thing that makes a finding actionable:
 *
 *   CATEGORY    what KIND of problem — a type error and a missing file are not
 *               both "an error"
 *   SEVERITY    how much it matters ENGINEERING-wise, which is not the same as
 *               how loudly the tool that found it shouted
 *   CONFIDENCE  whether this is PROVEN, merely OBSERVED, INFERRED from other
 *               facts, or only SUSPECTED. A tool that reports a hypothesis in
 *               the same voice as a compiler error teaches its reader to
 *               distrust both.
 *   SOURCE      what actually saw it. This is what stops deterministic evidence
 *               and speculation getting mixed together downstream.
 *
 * STABLE IDS ARE KEYED ON THE FINDING, NOT ON ITS POSITION IN A LIST. `ERROR
 * #014` has to still be `ERROR #014` after the report is regenerated, or an
 * instruction like "fix #014 and investigate #027" rots the moment anything is
 * edited. So the id is assigned from a FINGERPRINT that deliberately excludes
 * the line number: inserting a function above a defect must not renumber it.
 */

/** What KIND of problem this is. Never collapsed into "error". */
const CATEGORY = Object.freeze({
  SYNTAX: 'SYNTAX',
  TYPE: 'TYPE',
  SYMBOL: 'SYMBOL',
  REFERENCE: 'REFERENCE',
  IMPORT: 'IMPORT',
  EXPORT: 'EXPORT',
  TYPO: 'TYPO',
  MIGRATION_RESIDUE: 'MIGRATION_RESIDUE',
  CONTRACT: 'CONTRACT',
  RUNTIME: 'RUNTIME',
  TEST: 'TEST',
  BUILD: 'BUILD',
  LINT: 'LINT',
  DEPRECATION: 'DEPRECATION',
  DEAD_CODE: 'DEAD_CODE',
  CONFIGURATION: 'CONFIGURATION',
  PATH: 'PATH',
  PERMISSION: 'PERMISSION',
  // (FRONTEND_CONSOLE and FRONTEND_LAYOUT — categories for findings read off a
  // running page — were removed with the browser in 2026-09. Their only
  // producer was the browser console, and the static front-end boundary
  // detection in audit.js reports through categories that never needed it.)
  GIT: 'GIT',
  ENVIRONMENT: 'ENVIRONMENT',
  UNVERIFIED: 'UNVERIFIED',
});

/**
 * Engineering impact, not tool volume.
 *
 * A linter calling something an "error" and a compiler calling something an
 * "error" are not the same event, and a report that grades by the emitting
 * tool's own word puts a missing semicolon next to a style preference.
 */
const SEVERITY = Object.freeze({
  CRITICAL: 'CRITICAL',
  ERROR: 'ERROR',
  WARNING: 'WARNING',
  SUSPICIOUS: 'SUSPICIOUS',
  INFO: 'INFO',
  UNVERIFIED: 'UNVERIFIED',
});

/** Ordering for display: the things that stop the project working come first. */
const SEVERITY_ORDER = [
  SEVERITY.CRITICAL, SEVERITY.ERROR, SEVERITY.WARNING,
  SEVERITY.SUSPICIOUS, SEVERITY.UNVERIFIED, SEVERITY.INFO,
];

/**
 * HOW THIS IS KNOWN — the axis that keeps the report honest.
 *
 * PROVEN     the evidence IS the finding. The parser rejected the file; there
 *            is nothing left to establish.
 * OBSERVED   a tool saw it directly, but what it MEANS may be something else.
 *            A console error is observed; whether it is the bug is not.
 * INFERRED   derived from two or more observations by a rule stated in the
 *            finding itself.
 * SUSPECTED  a heuristic noticed a shape. It may be nothing.
 */
const CONFIDENCE = Object.freeze({
  PROVEN: 'PROVEN',
  OBSERVED: 'OBSERVED',
  INFERRED: 'INFERRED',
  SUSPECTED: 'SUSPECTED',
  /**
   * NOT ESTABLISHED — the answer is not known, and no guess is offered.
   *
   * Shared with the project-fact model (facts.js), where it is the whole point:
   * a convention that could not be proved from the repository is reported as
   * UNKNOWN/UNVERIFIED rather than as a plausible-looking value. One
   * vocabulary, because a fact and a finding grade their certainty on the same
   * scale and two scales would invite comparing them wrongly.
   */
  UNVERIFIED: 'UNVERIFIED',
});

/** What actually saw it. Deterministic evidence must be distinguishable. */
const SOURCE = Object.freeze({
  PARSER: 'JavaScript/JSON/Python parser',
  TYPE_CHECKER: 'Type checker',
  TOKENIZER: 'Tokenizer',
  SYMBOL_GRAPH: 'Symbol graph',
  GIT_DIFF: 'Git diff',
  RESIDUE_SCANNER: 'Migration residue scanner',
  RUNTIME: 'Runtime',
  TEST_RUNNER: 'Test runner',
  // (BROWSER_CONSOLE and DOM_MEASUREMENT — sources that read a running page —
  // were removed with the browser in 2026-09; nothing can produce them now.)
  STATIC_ANALYSIS: 'Static analysis',
  FILESYSTEM: 'Filesystem',
  EXECUTION_ENGINE: 'Execution engine',
  LINTER: 'Linter',
});

/**
 * WHERE A FINDING IS IN ITS LIFE.
 *
 * `FIXED` and `VERIFIED` are deliberately two states. A finding that stopped
 * being reported because the analyser that found it did not run this time is
 * not fixed — it is unobserved, and calling that a fix is the exact dishonesty
 * this whole system exists to prevent.
 */
const STATE = Object.freeze({
  OPEN: 'OPEN',
  INVESTIGATING: 'INVESTIGATING',
  CONFIRMED: 'CONFIRMED',
  FIXED: 'FIXED',
  VERIFIED: 'VERIFIED',
  DISMISSED: 'DISMISSED',
  UNVERIFIED: 'UNVERIFIED',
});

/**
 * THE LABEL AN ID CARRIES — `ERROR #014`, `RESIDUE #031`, `UI #004`.
 *
 * Chosen from the CATEGORY where the category is the memorable thing, and from
 * the SEVERITY otherwise. The point is that the label reads as what the reader
 * is looking for: nobody hunts for "MIGRATION_RESIDUE #31", they hunt for
 * "RESIDUE #31".
 */
const LABEL_BY_CATEGORY = Object.freeze({
  [CATEGORY.MIGRATION_RESIDUE]: 'RESIDUE',
  [CATEGORY.TYPE]: 'TYPE',
  [CATEGORY.TYPO]: 'TYPO',
  [CATEGORY.SYMBOL]: 'SYMBOL',
  [CATEGORY.RUNTIME]: 'RUNTIME',
  [CATEGORY.TEST]: 'TEST',
  [CATEGORY.GIT]: 'GIT',
  [CATEGORY.DEAD_CODE]: 'DEAD',
  [CATEGORY.LINT]: 'LINT',
  [CATEGORY.ENVIRONMENT]: 'ENV',
  [CATEGORY.UNVERIFIED]: 'UNVERIFIED',
});

function labelFor(finding) {
  const byCat = LABEL_BY_CATEGORY[finding.category];
  if (byCat) return byCat;
  if (finding.severity === SEVERITY.WARNING) return 'WARNING';
  if (finding.severity === SEVERITY.SUSPICIOUS) return 'SUSPICIOUS';
  if (finding.severity === SEVERITY.INFO) return 'INFO';
  if (finding.severity === SEVERITY.UNVERIFIED) return 'UNVERIFIED';
  return 'ERROR';
}

/**
 * THE FINGERPRINT AN ID IS KEYED ON.
 *
 * Line and column are EXCLUDED, deliberately. Code moves: adding an import at
 * the top of a file shifts every line under it, and a report where every id
 * changes because of that is a report whose ids mean nothing. What identifies a
 * finding is what it is ABOUT — the file, the symbol, the category, and the
 * shape of the message with its numbers removed so that "expected 3, got 4" and
 * "expected 3, got 5" are the same recurring defect.
 */
function fingerprint(f) {
  const shape = String(f.message || '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return [f.category || '', f.file || '', f.symbol || '', shape].join('|');
}

/**
 * Build one finding, filling in everything the renderer is allowed to assume.
 *
 * Anything absent stays absent rather than being invented — a finding with no
 * column says nothing about columns, and never guesses one.
 */
function make(f = {}) {
  const out = {
    category: f.category || CATEGORY.UNVERIFIED,
    severity: f.severity || SEVERITY.INFO,
    confidence: f.confidence || CONFIDENCE.OBSERVED,
    source: f.source || SOURCE.STATIC_ANALYSIS,
    state: f.state || STATE.OPEN,
    file: f.file || null,
    line: Number.isFinite(f.line) ? f.line : null,
    column: Number.isFinite(f.column) ? f.column : null,
    symbol: f.symbol || null,
    container: f.container || null,
    message: String(f.message || '').trim(),
    explanation: f.explanation ? String(f.explanation).trim() : null,
    risk: f.risk ? String(f.risk).trim() : null,
    actual: f.actual == null ? null : String(f.actual),
    expected: f.expected == null ? null : String(f.expected),
    evidence: f.evidence ? String(f.evidence).trim() : null,
    related: {
      files: [...new Set(((f.related && f.related.files) || []).filter(Boolean))],
      symbols: [...new Set(((f.related && f.related.symbols) || []).filter(Boolean))],
      tests: [...new Set(((f.related && f.related.tests) || []).filter(Boolean))],
    },
    references: Number.isFinite(f.references) ? f.references : null,
  };
  out.key = fingerprint(out);
  out.label = labelFor(out);
  return out;
}

/**
 * THE LEDGER — findings across repeated runs, with ids that survive.
 *
 * Held on the session, never at module scope, for the same reason the attempt
 * ledger is: two sessions in one process must not share an issue list, and
 * module-level session state is what the architecture guard forbids.
 */
class FindingLedger {
  constructor() {
    /** @type {Map<string, {id, seq, label}>} fingerprint → assigned identity */
    this.identity = new Map();
    /** Per label, the last number handed out. */
    this.counters = new Map();
    /** The most recent completed run. */
    this.last = null;
    this.runs = 0;
  }

  /** Assign — or recall — the stable id for one finding. */
  idFor(finding) {
    const existing = this.identity.get(finding.key);
    if (existing) return existing.id;
    const label = finding.label;
    const next = (this.counters.get(label) || 0) + 1;
    this.counters.set(label, next);
    const id = `${label} #${String(next).padStart(3, '0')}`;
    this.identity.set(finding.key, { id, seq: next, label });
    return id;
  }

  /**
   * Record one run, and work out what changed since the previous one.
   *
   * @param {Array} findings
   * @param {Set<string>} ranSources  the SOURCE values whose analysers actually
   *   executed this time. A finding that vanished is only FIXED if the thing
   *   that would have seen it looked again.
   * @returns {{findings, fixed, unobserved, appeared}}
   */
  record(findings, ranSources = new Set()) {
    const stamped = findings.map((f) => ({ ...f, id: this.idFor(f) }));
    const nowKeys = new Set(stamped.map((f) => f.key));
    const before = this.last ? this.last.findings : [];
    const beforeKeys = new Set(before.map((f) => f.key));

    const fixed = [];
    const unobserved = [];
    for (const f of before) {
      if (nowKeys.has(f.key)) continue;
      // ---- GONE, BUT WAS ANYONE LOOKING? ---------------------------------
      //
      // The distinction the whole lifecycle rests on. A parse error that is no
      // longer reported BY A PARSER THAT RAN is fixed. The same error not
      // reported because the parser was skipped is unknown, and saying "fixed"
      // there would be the report lying about the one thing it exists to get
      // right.
      if (ranSources.has(f.source)) fixed.push({ ...f, state: STATE.FIXED });
      else unobserved.push({ ...f, state: STATE.UNVERIFIED });
    }
    const appeared = stamped.filter((f) => this.runs > 0 && !beforeKeys.has(f.key));

    this.runs += 1;
    this.last = { findings: stamped, at: Date.now(), ranSources: [...ranSources] };
    return { findings: stamped, fixed, unobserved, appeared };
  }
}

/** The ledger for a session, created on first use. */
function forSession(session) {
  if (!session) return new FindingLedger();
  if (!session.findings) session.findings = new FindingLedger();
  return session.findings;
}

/** Sort for display: worst first, then by file so one file reads together. */
function bySeverityThenFile(a, b) {
  const d = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  if (d !== 0) return d;
  const f = String(a.file || '').localeCompare(String(b.file || ''));
  if (f !== 0) return f;
  return (a.line || 0) - (b.line || 0);
}

module.exports = {
  CATEGORY, SEVERITY, SEVERITY_ORDER, CONFIDENCE, SOURCE, STATE,
  FindingLedger, forSession, make, fingerprint, labelFor, bySeverityThenFile,
};
