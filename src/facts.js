'use strict';

/**
 * PROJECT FACTS — the conventions a model must not have to rediscover.
 *
 * A fact is small and boring: the PID argument is decimal, line numbers are
 * 1-based, the shell here is PowerShell, byte ranges end exclusive. Each one is
 * a single word of information. Each one, when unknown, costs a model several
 * tool calls and a wrong answer in between — and it pays that cost again in the
 * next session, and the next, because nothing remembers.
 *
 * A person with an IDE never pays it. The debugger shows addresses in hex
 * because it knows they are addresses; the language server reports line 183
 * and the editor jumps to line 183 because both agree what 183 counts from;
 * the terminal is the shell the project uses. None of that is intelligence. It
 * is CONTEXT, supplied by tooling, and its absence is why an agent burns a
 * dozen requests establishing that `--pid` wants `16296` and not `0x3FA8`.
 *
 * ------------------------------------------------------------------------
 * A FACT IS NOT A FINDING, and the two must not be filed together.
 *
 *   FACT          "The PID argument is decimal."
 *   FINDING       "Something passed hexadecimal to --pid."
 *   CONTRADICTION "The documentation says hex; the parser converts decimal."
 *
 * The first is how the project works. The second is something wrong. The third
 * is a defect ABOUT a fact, and it is the most valuable of the three, because
 * it is the case where reading the documentation would have made things worse.
 * Contradictions are emitted as findings (see contracts.js); facts stay here.
 * ------------------------------------------------------------------------
 *
 * EVIDENCE OR NOTHING. Every fact carries where it came from, and a fact that
 * could not be established from the repository is recorded with the value
 * UNKNOWN and confidence UNVERIFIED. It is never filled in with the likely
 * answer. A plausible wrong fact is far worse than an absent one: an absent
 * fact makes a model look, and a wrong one makes it confidently not look.
 */

const { CONFIDENCE } = require('./findings');

/**
 * WHAT KIND OF CONVENTION THIS IS.
 *
 * Grouped the way somebody looks for them, not the way they were discovered —
 * a reader wanting to run a command wants EXECUTION, SHELL, CWD and PATH
 * together, and does not care which module proved each one.
 */
const AREA = Object.freeze({
  EXECUTION: 'EXECUTION',
  SHELL: 'SHELL',
  PATH: 'PATH',
  CWD: 'CWD',
  CLI: 'CLI',
  MEMORY: 'MEMORY',
  SOURCE_LOCATION: 'SOURCE_LOCATION',
  DATA: 'DATA',
  CONFIGURATION: 'CONFIGURATION',
  ENVIRONMENT: 'ENVIRONMENT',
  ENCODING: 'ENCODING',
  TESTING: 'TESTING',
  BUILD: 'BUILD',
  PROTOCOL: 'PROTOCOL',
  TYPE: 'TYPE',
});

/**
 * THE REPRESENTATIONS THAT GET CONFUSED, named so they cannot be.
 *
 * `DECIMAL` and `HEXADECIMAL` are here as first-class values rather than as
 * free text because the entire point of the model is that a PID and a memory
 * address are NOT interchangeable. Two facts whose values are the strings
 * "decimal" and "Decimal (base 10)" cannot be compared; two whose values are
 * `REPR.DECIMAL` can.
 */
const REPR = Object.freeze({
  DECIMAL: 'decimal',
  HEXADECIMAL: 'hexadecimal',
  HEX_STRING: 'hexadecimal string (0x-prefixed)',
  BOOLEAN: 'boolean',
  STRING: 'string',
  INTEGER: 'integer',
  PATH: 'path',
  ZERO_BASED: '0-based',
  ONE_BASED: '1-based',
  INCLUSIVE: 'inclusive',
  EXCLUSIVE: 'exclusive',
  UTF8: 'UTF-8',
  /** The only honest answer when the repository does not settle it. */
  UNKNOWN: 'UNKNOWN',
});

/**
 * HOW A FACT WAS ESTABLISHED.
 *
 * `EXECUTED` is the strongest and is used deliberately: rather than reading
 * `lineAt` and reasoning that it returns `lo + 1`, the discoverer RUNS it on a
 * known input and observes the answer. Source can be misread; a measurement of
 * the code's actual behaviour cannot.
 */
const VIA = Object.freeze({
  EXECUTED: 'executed against this build',
  SOURCE: 'source declaration',
  SCHEMA: 'declared schema',
  MANIFEST: 'project manifest',
  FILESYSTEM: 'filesystem',
  RUNTIME: 'live runtime',
  DOCUMENTATION: 'documentation',
});

/**
 * Build one fact.
 *
 * `value` is required and may be `REPR.UNKNOWN`; there is no way to create a
 * fact without stating what it claims, including that it claims nothing.
 */
function make(f = {}) {
  const unknown = f.value === REPR.UNKNOWN || f.value == null;
  const out = {
    area: f.area || AREA.ENVIRONMENT,
    name: String(f.name || '').trim(),
    value: unknown ? REPR.UNKNOWN : String(f.value),
    // UNKNOWN AND UNVERIFIED TRAVEL TOGETHER. A fact cannot be UNKNOWN and
    // confident, and cannot claim a value it did not establish; forcing the
    // pair here means no discoverer can produce that combination by accident.
    confidence: unknown ? CONFIDENCE.UNVERIFIED : (f.confidence || CONFIDENCE.OBSERVED),
    examples: (f.examples || []).map(String).filter(Boolean),
    counterExample: f.counterExample ? String(f.counterExample) : null,
    scope: f.scope ? String(f.scope) : null,
    via: f.via || (unknown ? null : VIA.SOURCE),
    evidence: f.evidence ? String(f.evidence).trim() : null,
    at: f.at ? String(f.at) : null,
    notes: f.notes ? String(f.notes).trim() : null,
    /** Why nobody could establish it. Only meaningful when UNKNOWN. */
    why: unknown && f.why ? String(f.why).trim() : null,
  };
  out.key = `${out.area}|${out.name}`;
  return out;
}

/** A fact that could not be established. The shape exists so it is easy to do. */
function unknown({ area, name, why, scope = null }) {
  return make({ area, name, value: REPR.UNKNOWN, why, scope });
}

/**
 * THE LEDGER — facts for a session, with stable ids.
 *
 * Ids matter here for the same reason they matter for findings: a briefing that
 * says `CONTRACT #014` has to still mean that after it is regenerated, or an
 * instruction referring to it rots. Keyed on area + name, which is what the
 * fact IS — the VALUE is allowed to change (that is a contradiction worth
 * noticing, not a new fact).
 */
class FactLedger {
  constructor() {
    this.identity = new Map();
    this.seq = 0;
    this.last = null;
  }

  idFor(fact) {
    const seen = this.identity.get(fact.key);
    if (seen) return seen;
    this.seq += 1;
    const id = `CONTRACT #${String(this.seq).padStart(3, '0')}`;
    this.identity.set(fact.key, id);
    return id;
  }

  /**
   * Record one sweep, and report any fact whose VALUE changed since the last.
   *
   * A changed value is not a new fact; it is the same convention answering
   * differently, which is either a real migration or a discoverer that is
   * unstable. Either is worth surfacing rather than silently overwriting.
   */
  record(facts) {
    const stamped = facts.map((f) => ({ ...f, id: this.idFor(f) }));
    const before = new Map((this.last || []).map((f) => [f.key, f]));
    const changed = [];
    for (const f of stamped) {
      const prev = before.get(f.key);
      if (prev && prev.value !== f.value) changed.push({ ...f, was: prev.value });
    }
    this.last = stamped;
    return { facts: stamped, changed };
  }
}

function forSession(session) {
  if (!session) return new FactLedger();
  if (!session.facts) session.facts = new FactLedger();
  return session.facts;
}

/** Group facts by area, preserving the order areas were first seen. */
function byArea(facts) {
  const out = new Map();
  for (const f of facts) {
    if (!out.has(f.area)) out.set(f.area, []);
    out.get(f.area).push(f);
  }
  return out;
}

/**
 * One fact, rendered for the briefing.
 *
 * An UNKNOWN fact is rendered as loudly as a known one, and says why. The
 * temptation is to hide the things that could not be established, which is
 * exactly backwards: those are the ones a model is about to burn requests on.
 */
function line(f, { width = 28 } = {}) {
  // A name longer than the column gets ONE space rather than being welded to
  // its value — `Target naming and authorization:UNKNOWN` is unreadable, and
  // padEnd alone produces exactly that.
  const raw = `${f.name}:`;
  const label = raw.length >= width ? `${raw} ` : raw.padEnd(width);
  if (f.value === REPR.UNKNOWN) {
    return `  ${label}UNKNOWN — ${f.why || 'not established from this repository'}`;
  }
  const ex = f.examples.length ? `   e.g. ${f.examples.slice(0, 2).join(', ')}` : '';
  return `  ${label}${f.value}${ex}`;
}

module.exports = { AREA, REPR, VIA, make, unknown, FactLedger, forSession, byArea, line, CONFIDENCE };
