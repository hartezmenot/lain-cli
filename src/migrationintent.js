'use strict';

/**
 * THE CHEAP HALF. Everything here runs locally, costs nothing, and settles the
 * questions that would otherwise be settled by an expensive model guessing.
 *
 * ------------------------------------------------------------------------
 * THE ECONOMICS, which are the entire argument for this file.
 *
 *   EXPENSIVE   send the whole repository and "migrate the agents to Vue" to
 *               the big model; it reads forty files to work out how many
 *               agents there are, picks one reading of "the agents", migrates
 *               all three, and the user meant one
 *
 *   CHEAP       count the agents locally (no tokens), notice the request names
 *               none of them (no tokens), ask four words on screen, and send
 *               the big model a contract that already says WHICH ONE
 *
 * The second is not merely cheaper; it is the only one of the two that can be
 * right, because the missing fact was never in the repository. Nothing the
 * model reads can tell it which agent the user meant.
 * ------------------------------------------------------------------------
 *
 * WHY IT IS DETERMINISTIC, and must stay so. Same argument as mode.js: using a
 * model call to decide how to spend model calls is circular, and "migrate X to
 * Y" is settled by a dozen words of English. No network, no tokens, no I/O
 * beyond counting files, and the same input always produces the same draft.
 *
 * IT NEVER DECIDES THE AMBIGUOUS CASE ITSELF. Where the words genuinely do not
 * say — which agent, what happens to the old implementation, whether the shared
 * JSON comes too — it produces a QUESTION rather than a default. A default here
 * is a silent choice about somebody else's architecture.
 */

const tech = require('./tech');

// ----------------------------------------------------------------- signals --

/** Verbs that mean "the final state should differ", not "add something". */
const VERB_RE = /\b(?:migrat\w*|convert(?:ed|ing)?|port(?:ed|ing)?|switch(?:ed|ing)?|transition\w*|translat\w*|re-?writ\w*|replac\w*|turn(?:ed|ing)?|chang\w*|mov\w*|merg\w*|consolidat\w*|unif\w*|split|separat\w*|extract\w*)\b/i;

/** The directional phrase. Without one there is no target and no migration. */
const TO_RE = /\b(?:in)?to\s+(?:an?\s+|the\s+|use\s+|using\s+)?([A-Za-z][A-Za-z0-9_+#.-]*(?:\s+[A-Za-z][A-Za-z0-9_+#.-]*)?)/i;
const FROM_RE = /\bfrom\s+(?:an?\s+|the\s+|using\s+)?([A-Za-z][A-Za-z0-9_+#.-]*)/i;
const WITH_RE = /\breplac\w*\s+(?:the\s+)?(.+?)\s+with\s+(?:an?\s+|the\s+)?(.+?)(?:\s*[.,;]|$)/i;
const ARROW_RE = /([A-Za-z][A-Za-z0-9_+#.-]*)\s*(?:->|→|=>)\s*([A-Za-z][A-Za-z0-9_+#.-]*)/;

const MERGE_RE = /\b(?:merge|combine|consolidat\w*|unif\w*|fold)\b/i;
const SPLIT_RE = /\b(?:split|separat\w*|break\s+(?:up|apart|out)|divid\w*)\b/i;
const EXTRACT_RE = /\bextract\w*\b/i;

/** The user has already said what happens to the old implementation. */
const REPLACE_HINT_RE = /\b(?:replac\w*|instead of|in place of|get rid of|drop the|remove the|delete the|no longer|stop using|swap out)\b/i;
const KEEP_HINT_RE = /\b(?:keep|retain|preserve|alongside|as well as|in addition|both|fallback|fall back|side by side|coexist|leave .{0,20}(?:alone|as is|untouched))\b/i;
const ARCHIVE_HINT_RE = /\b(?:archiv\w*|back ?up|stash|park|move .{0,20}(?:aside|out of the way))\b/i;

/** The user has already said what happens to shared data and configuration. */
const DATA_NOUN = '(?:json|ya?ml|toml|config\\w*|settings|data|asset\\w*|resource\\w*|schema)';
const DATA_KEEP_RE = new RegExp(`\\b(?:keep|leave|preserve|don'?t (?:touch|change|migrate))\\b[^!?]{0,30}\\b${DATA_NOUN}\\b`, 'i');
const DATA_MOVE_RE = new RegExp(`\\b(?:migrat\\w*|convert|port|translat\\w*|update)\\b[^!?]{0,30}\\b${DATA_NOUN}\\b`, 'i');

/**
 * TECHNOLOGY NAMES THAT ARE ALSO ORDINARY ENGLISH.
 *
 * "go", "make", "react", "solid", "parcel", "bun" and "swift" all appear in
 * sentences that have nothing to do with the technologies they name, and
 * "migrate the button so it does not react to clicks" must not be read as a
 * React migration. For these, and only these, a CAPITAL LETTER is required —
 * which is how people write them when they mean the technology.
 */
const AMBIGUOUS = new Set(['go', 'make', 'c', 'solid', 'react', 'parcel', 'bun', 'angular', 'swift', 'rust']);

/** A word that names a scope explicitly: "the scanner subsystem", "Agent B". */
const SCOPE_RE = /\b(?:only|just|scoped? to)\b/i;
const WHOLE_RE = /\b(?:whole|entire|all of|everything|across the (?:repo|repository|project|codebase)|project[- ]wide)\b/i;

/** Anything that reads as a path. Deliberately narrow. */
const PATH_RE = /(?:^|[\s"'`(])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+|[\w-]+\.[A-Za-z0-9]{1,5})(?=$|[\s"'`),.;])/g;

/** Words that are never a technology, however they are positioned. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'them', 'one', 'ones',
  'use', 'using', 'be', 'being', 'make', 'made', 'work', 'run', 'new', 'old',
  'something', 'anything', 'everything', 'code', 'implementation', 'version',
]);

// -------------------------------------------------------------- the parse ---

/** Trim a captured phrase down to the noun that names a technology. */
function cleanName(s) {
  const t = String(s || '').trim()
    .replace(/^(?:an?|the|use|using)\s+/i, '')
    .replace(/[.,;:!?]+$/, '')
    .trim();
  if (!t) return '';
  // "Vue while the other two remain React" — keep the first word or two only.
  const words = t.split(/\s+/).slice(0, 2);
  if (words.length === 2 && !tech.resolve(words.join(' ')).known) {
    // Two words that are not a known compound: the first is the name.
    return STOPWORDS.has(words[0].toLowerCase()) ? '' : words[0];
  }
  const first = words[0];
  return STOPWORDS.has(String(first).toLowerCase()) ? '' : words.join(' ');
}

/**
 * The first technology named anywhere in the sentence that is not the target.
 *
 * A filename is skipped — `scanner.cpp` names a file, and the fact that it
 * ends in a C++ extension is a conclusion for the file sweep to draw, not a
 * word in the request. An ambiguous name (see AMBIGUOUS) counts only when it
 * is capitalised.
 */
function inferTech(text, exceptName) {
  const except = exceptName ? tech.resolve(exceptName) : null;
  for (const m of String(text || '').matchAll(/[A-Za-z][A-Za-z0-9_+#.-]*/g)) {
    const word = m[0];
    if (/\.[A-Za-z0-9]{1,5}$/.test(word)) continue;              // a filename
    const t = tech.resolve(word);
    if (!t.known) continue;
    if (except && except.known && t.id === except.id) continue;
    if (AMBIGUOUS.has(t.id) && !/^[A-Z]/.test(word)) continue;
    return word;
  }
  return '';
}

/**
 * Does this request ask for a structural migration?
 *
 * A verb ALONE is not enough — "move the button left" is a change, not a
 * migration — so a direction is required too. Under-matching is the safe
 * direction: a migration that reads as an ordinary implementation request
 * still gets done, just without the contract.
 */
function looksLikeMigration(text) {
  const s = String(text || '').replace(/\s+/g, ' ');
  if (!s) return false;
  if (ARROW_RE.test(s)) return true;
  if (WITH_RE.test(s)) return true;
  if (!VERB_RE.test(s)) return false;
  if (MERGE_RE.test(s) || SPLIT_RE.test(s) || EXTRACT_RE.test(s)) return true;
  return TO_RE.test(s) || FROM_RE.test(s);
}

/**
 * Read the request into the parts a contract is made of.
 *
 * Everything it cannot establish comes back empty rather than guessed, and the
 * empties are exactly what `questions()` then asks about.
 */
function parse(text) {
  const raw = String(text || '');
  const s = raw.replace(/\s+/g, ' ').trim();
  const out = {
    text: s,
    sourceName: '',
    targetName: '',
    operation: null,
    dispositionHint: '',
    dataHint: '',
    paths: [],
    projectWide: WHOLE_RE.test(s),
    scoped: SCOPE_RE.test(s),
  };

  const arrow = ARROW_RE.exec(s);
  if (arrow) { out.sourceName = cleanName(arrow[1]); out.targetName = cleanName(arrow[2]); }

  const withM = WITH_RE.exec(s);
  if (withM && !out.targetName) {
    out.sourceName = cleanName(withM[1]);
    out.targetName = cleanName(withM[2]);
    out.operation = 'REPLACE';
  }

  if (!out.targetName) {
    const to = TO_RE.exec(s);
    if (to) out.targetName = cleanName(to[1]);
  }
  if (!out.sourceName) {
    const from = FROM_RE.exec(s);
    if (from) out.sourceName = cleanName(from[1]);
  }

  // ---- THE SHAPE OF THE OPERATION ---------------------------------------
  if (!out.operation) {
    if (MERGE_RE.test(s)) out.operation = /\bimplementations?\b|\bdupli/i.test(s) ? 'CONSOLIDATE' : 'MERGE';
    else if (SPLIT_RE.test(s)) out.operation = 'SPLIT';
    else if (EXTRACT_RE.test(s)) out.operation = 'EXTRACT';
    else out.operation = 'REPLACE';
  }

  // ---- THE SOURCE THE SENTENCE NAMED WITHOUT SAYING "FROM" --------------
  //
  // "Migrate this C++ implementation to Python" names both sides; only one of
  // them is introduced by a preposition. When nothing is found here the source
  // is left EMPTY on purpose — migrationmap.js then reads it off the files
  // actually in scope, which is a better answer than a guess from prose.
  if (!out.sourceName) out.sourceName = inferTech(s, out.targetName);

  // ---- "KEEP" ABOUT THE DATA IS NOT "KEEP" ABOUT THE IMPLEMENTATION -----
  //
  // "port scanner.cpp to Rust, keep enemies.json" says one thing about the
  // JSON and NOTHING about the C++ — reading its "keep" as "leave the C++
  // running" would silently turn a replacement into a coexistence, which is
  // the one answer nobody gave. So a hint that falls inside a data clause is
  // not a hint about the implementation.
  const dataKeep = DATA_KEEP_RE.exec(s);
  const dataMove = dataKeep ? null : DATA_MOVE_RE.exec(s);
  if (dataKeep) out.dataHint = 'PRESERVE';
  else if (dataMove) out.dataHint = 'TRANSLATE';
  const inDataClause = (m) => {
    if (!m) return false;
    for (const dm of [dataKeep, dataMove]) {
      if (dm && m.index >= dm.index && m.index < dm.index + dm[0].length) return true;
    }
    return false;
  };
  const arch = ARCHIVE_HINT_RE.exec(s);
  const keep = KEEP_HINT_RE.exec(s);
  const repl = REPLACE_HINT_RE.exec(s);
  if (arch && !inDataClause(arch)) out.dispositionHint = 'ARCHIVE';
  else if (keep && !inDataClause(keep)) out.dispositionHint = 'KEEP';
  else if (repl && !inDataClause(repl)) out.dispositionHint = 'REPLACE';

  for (const m of s.matchAll(PATH_RE)) {
    const p = m[1];
    // A technology name with a dot in it is not a path.
    if (tech.resolve(p).known) continue;
    out.paths.push(p);
  }
  out.paths = [...new Set(out.paths)];

  return out;
}

// ----------------------------------------------------------- the questions --

/**
 * WHAT THE WORDS DID NOT SAY.
 *
 * Each question is generated only when the request genuinely leaves the answer
 * open — a question whose answer is already in the user's sentence is the
 * agent not listening, which clarify.js refuses for the same reason.
 *
 * `values` runs parallel to `options`: the option is what a person reads, the
 * value is what the contract stores. Keeping them apart means the wording can
 * be changed without changing what any answer means.
 */
function questions(draft, { candidates = [], dataResources = [], sourcePresent = 0, scopeResolved = false } = {}) {
  const out = [];
  const d = draft || {};

  // ---- 1. WHICH PART OF THE PROJECT -------------------------------------
  //
  // Asked when the request names no path, does not say "the whole project",
  // and there is more than one candidate it could plausibly mean. One
  // candidate is not an ambiguity, and neither is a request that named a path.
  //
  // ---- AND NOT WHEN THE SCOPE IS ALREADY SETTLED ------------------------
  //
  // `scopeResolved` is the verdict from migrationmap, which resolves a scope
  // the request NAMED IN WORDS — "change agent-b from React to Vue" says which
  // agent, in the sentence, without a path in sight. Asking anyway is the
  // failure clarify.js refuses by name: the user answers a question they
  // already answered, and a mis-click then migrates a component nobody
  // mentioned. Observed doing exactly that before this line existed.
  if (!scopeResolved && !d.projectWide && !d.paths.length && candidates.length > 1) {
    const options = candidates.slice(0, 8).map((c) => c.label);
    out.push({
      id: 'scope',
      question: `Which ${candidates[0].noun || 'part'} should be migrated?`,
      options: [...options, 'All of them'],
      values: [...candidates.slice(0, 8).map((c) => ({ kind: 'component', name: c.name, paths: c.paths })), { kind: 'project' }],
      input: 'choice',
      why: 'a scoped migration read as a project-wide one rewrites code nobody asked about',
    });
  }

  // ---- 2. WHAT HAPPENS TO WHAT IS ALREADY THERE -------------------------
  //
  // The single most consequential thing the request usually omits, and the one
  // the model gets wrong by being helpful: it adds the target and keeps the
  // source, which is neither of the answers below.
  if (!d.dispositionHint && sourcePresent > 0) {
    const what = d.sourceName || 'the existing implementation';
    out.push({
      id: 'old',
      question: `What should happen to ${what}?`,
      options: [
        'Replace it — archive the old one once the new one is verified',
        'Keep it as a fallback, not active',
        'Run both together',
        'Archive it now, without waiting',
      ],
      values: [
        { fate: 'REPLACE' }, { fate: 'FALLBACK' }, { fate: 'COEXIST' }, { fate: 'ARCHIVE' },
      ],
      input: 'choice',
      why: 'adding the target while leaving the source active is the default failure this contract exists to prevent',
    });
  }

  // ---- 3. THE DATA THAT IS NOT IMPLEMENTATION ---------------------------
  if (!d.dataHint && dataResources.length) {
    const shown = dataResources.slice(0, 3).join(', ');
    out.push({
      id: 'data',
      question: `What should happen to the shared data and configuration (${shown}${dataResources.length > 3 ? `, +${dataResources.length - 3} more` : ''})?`,
      options: [
        'Keep compatible resources unchanged',
        'Migrate them too',
        'Decide each one individually',
      ],
      values: [{ data: 'PRESERVE' }, { data: 'TRANSLATE' }, { data: 'ASK' }],
      input: 'choice',
      why: 'translating a JSON file that both implementations already read is work that breaks something',
    });
  }

  return out;
}

/**
 * Which option does this answer mean?
 *
 * The panel takes a typed line as well as a highlighted row (see ui/answer.js),
 * so an answer arrives as the option text, a number, a letter, or something the
 * user typed that is on no list at all. The last case is NOT forced onto the
 * nearest option — it comes back as free text, because a person who typed a
 * sentence meant the sentence.
 */
function resolveAnswer(question, answer) {
  const a = String(answer == null ? '' : answer).trim();
  if (!a) return { index: -1, value: null, free: '' };
  const opts = question.options || [];
  const exact = opts.findIndex((o) => o.toLowerCase() === a.toLowerCase());
  if (exact >= 0) return { index: exact, value: (question.values || [])[exact] || null, free: '' };
  const n = /^\d+$/.test(a) ? Number(a) - 1 : -1;
  if (n >= 0 && n < opts.length) return { index: n, value: (question.values || [])[n] || null, free: '' };
  if (/^[A-Za-z]$/.test(a)) {
    const i = a.toUpperCase().charCodeAt(0) - 65;
    if (i >= 0 && i < opts.length) return { index: i, value: (question.values || [])[i] || null, free: '' };
  }
  const starts = opts.findIndex((o) => o.toLowerCase().startsWith(a.toLowerCase()) || a.toLowerCase().startsWith(o.toLowerCase().slice(0, 12)));
  if (starts >= 0) return { index: starts, value: (question.values || [])[starts] || null, free: '' };
  return { index: -1, value: null, free: a };
}

/**
 * Fold an answer into the draft.
 *
 * The draft is what `migrationmap.build` then reads, so an answered question
 * changes the CONTRACT rather than being remembered as a sentence somebody
 * said. That is the difference between resolving ambiguity and recording it.
 */
function applyAnswer(draft, question, answer) {
  const r = resolveAnswer(question, answer);
  const d = draft;
  d.answers = d.answers || {};
  d.answers[question.id] = { question: question.question, answer: String(answer || ''), index: r.index };

  if (r.free) {
    // Free text is kept verbatim and treated as a scope or a note, never
    // silently rounded to an option nobody picked.
    if (question.id === 'scope') { d.paths = [...new Set([...(d.paths || []), ...parse(r.free).paths])]; d.scopeNote = r.free; }
    else d.note = `${d.note ? `${d.note} ` : ''}${r.free}`;
    return d;
  }
  const v = r.value || {};
  if (question.id === 'scope') {
    if (v.kind === 'project') d.projectWide = true;
    else if (v.kind === 'component') { d.component = v.name; d.paths = [...new Set([...(d.paths || []), ...(v.paths || [])])]; }
  } else if (question.id === 'old') {
    d.dispositionHint = v.fate === 'FALLBACK' || v.fate === 'COEXIST' ? 'KEEP' : v.fate;
    d.coexist = v.fate === 'COEXIST' || v.fate === 'FALLBACK';
    d.fallback = v.fate === 'FALLBACK';
  } else if (question.id === 'data') {
    d.dataHint = v.data === 'ASK' ? '' : v.data;
    d.dataIndividually = v.data === 'ASK';
  }
  return d;
}

module.exports = {
  looksLikeMigration, parse, questions, resolveAnswer, applyAnswer, cleanName,
  VERB_RE, TO_RE, FROM_RE, WITH_RE, ARROW_RE, MERGE_RE, SPLIT_RE, WHOLE_RE, STOPWORDS,
};
