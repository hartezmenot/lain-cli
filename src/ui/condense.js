'use strict';

/**
 * NARRATION THAT THE SCREEN ALREADY SAYS — dropped, because it is a second copy.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT PURELY A PROMPT PROBLEM.
 *
 * src/prompt.js opens by telling the model to work quietly, lists the four
 * things prose is for, and names the exact phrases not to use. Measured against
 * real models it says them anyway — not always, but often enough that a session
 * reads as
 *
 *     I'll check how the exe is launched.
 *     ✓ Read startup.lnk
 *     Now let me look at the runner log.
 *     ✓ Read runner.log
 *
 * where every line the model wrote is a worse copy of the line under it. The
 * prompt ASKS. This is the half that makes it true, and it is the same argument
 * ui/phrasing.js `trimRestatement` already makes for the opening sentence.
 *
 * ------------------------------------------------------------------------
 * WHAT IT WILL NOT DO, and the limits are the design.
 *
 *   WHOLE SENTENCES ONLY.    A clause inside a sentence is doing work in that
 *                            sentence. Only a SENTENCE that is entirely an
 *                            announcement is a candidate — which is the unit
 *                            that matters, because a real model writes a
 *                            paragraph on one line with the announcement as one
 *                            sentence inside it. See SENTENCE_SPLIT.
 *   A CLOSED SET.            An opener from a fixed list, followed by a verb
 *                            from a fixed list. Not a guess at intent.
 *   SHORT ONLY.              Past `MAX_LINE` the sentence is carrying something
 *                            besides the announcement, whatever it opens with.
 *                            That is deliberately generous: "I'll check the
 *                            loader, the parser and the serializer in turn,
 *                            starting from the one the stack trace names" is a
 *                            plan, and a plan earns its line. The cost is that a
 *                            long compound announcement survives, and the prompt
 *                            is the half that addresses that one.
 *   NEVER INSIDE A FENCE.    Code is not narration, and a line of code that
 *                            happens to read like English is still code.
 *   THE WHOLE MESSAGE ONLY    If everything matched, the model said nothing but
 *   MID-TURN.                narration. As the LAST thing said in a turn it is
 *                            kept — a turn that ends having apparently said
 *                            nothing reads as a failure. Mid-turn it goes: the
 *                            timeline underneath is already drawing the verb and
 *                            the file in full, which is the whole of what the
 *                            sentence was about to say. See `prose`'s `last`.
 *   NEVER A FINDING.         A line naming a file, a symbol, a number or a
 *                            failure is a result, not an announcement — even
 *                            when it opens with "I'll".
 *
 * ------------------------------------------------------------------------
 * PRESENTATION ONLY. This shapes what is DRAWN. The model's text is unchanged
 * in the session, on the wire and in the turn record, so nothing here can cost
 * the model context or lose a finding, and turning it off changes the screen
 * and nothing else.
 *
 * `/copy activity` DOES get the condensed form, and that is correct rather than
 * an oversight: it copies the ACTIVITY VIEW, which is the screen. `/copy last`
 * and `/copy context` read the session directly and hand back exactly what the
 * model wrote, so the unedited words are always one command away.
 */

const { trimRestatement } = require('./phrasing');

/** A newline, as a value. */
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/**
 * THE VOCABULARY MOVED, AND THAT IS THE WHOLE OF THE CHANGE HERE.
 *
 * ------------------------------------------------------------------------
 * WHAT WAS WRONG WITH IT LIVING IN THIS FILE.
 *
 * Every pattern this file used to hold was answering one question — WHAT KIND
 * OF SENTENCE IS THIS — and then immediately acting on the answer without ever
 * naming it. So the classes were real and invisible: a line was dropped
 * "because ANNOUNCE_LOOK matched and REASON did not", which is a statement
 * about an implementation and not about the sentence. Nobody could audit it,
 * and the only way to fix a wrong decision was one more pattern.
 *
 * ui/classify.js now names the classes and states the policy over them. This
 * file kept the half it was always best at: the EDITING. Deciding a class and
 * rewriting a paragraph are different jobs — the first is a closed set of
 * shapes and the second is careful surgery on somebody's words — and they
 * change for different reasons.
 *
 * ONE DECISION PATH, and that is why `isNarration` is three lines now. It asks
 * the classifier and reads the policy. There is no second opinion in this file
 * about what an announcement is, and there cannot be one.
 */
const classify = require('./classify');

const {
  MAX_LINE, CARRIES_RESULT, SENTENCE_SPLIT, FENCE,
} = classify;

/**
 * Is this line, on its own, nothing but narration of what the screen shows?
 *
 * The question every caller in this file asks, answered in the one place that
 * decides it. A `true` here always has a NAME behind it and a reason attached —
 * `classify.explain()` is the same decision with both of them shown.
 */
function isNarration(line) {
  const t = String(line == null ? '' : line).trim();
  if (!t) return false;
  return classify.renderPolicy(classify.classifySentence(t).class) === classify.DECISION.SUPPRESS;
}

/** Why a line was hidden — the class and the rule, for the audit tool. */
function why(line) {
  const c = classify.classifySentence(String(line == null ? '' : line).trim());
  return { class: c.class, decision: classify.renderPolicy(c.class), why: c.why };
}

/**
 * THROAT-CLEARING IN FRONT OF A REAL FACT — removed WITHOUT the fact.
 *
 * ------------------------------------------------------------------------
 * "Also worth noting the loader runs twice."
 *
 * The brief names that opener as unacceptable, and it is right about the
 * OPENER. It would be badly wrong to delete the sentence: `the loader runs
 * twice` is a FINDING, and a filter that removes findings is worse than any
 * amount of narration — the brief says exactly that, two sections later. The
 * two halves have to be told apart rather than judged together.
 *
 * So this is a TRIM, not a drop. The preface goes, the substance stays, and the
 * first letter is restored to a capital so what is left reads as a sentence:
 *
 *     Also worth noting the loader runs twice.  ->  The loader runs twice.
 *
 * A CLOSED, SHORT LIST, and every entry carries no information of its own — it
 * only announces that something is about to be said. `That said,` and
 * `However,` are NOT here and must never be: they state a CONTRAST, which is
 * part of the argument being made rather than a preamble to it.
 */
const PREFACE = new RegExp(
  // ONE LEADING-WHITESPACE GROUP for both families. It was one per branch, so
  // whichever branch did NOT match left its group undefined — and `unpreface`
  // put the literal string "undefined" on the front of every sentence the
  // second family trimmed. A capture that only sometimes exists is a capture
  // the caller has to guess about.
  '^(\\s*)(?:'
  // ---- ANNOUNCING THAT SOMETHING IS ABOUT TO BE SAID --------------------
  //
  // No comma required: "Also worth noting the loader runs twice" is the
  // commonest spelling of this and has none.
  + '(?:and\\s+)?(?:also[,]?\\s+)?'
  + '(?:(?:it(?:’s|\'s| is)\\s+)?worth\\s+(?:noting|mentioning|pointing\\s+out)'
  + '|interestingly'
  + '|one\\s+thing\\s+(?:to\\s+note|worth\\s+noting))'
  + '[,:]?\\s+(?:that\\s+)?'
  // ---- THE SEAM OF A MONOLOGUE, RIDING ON A REAL FACT -------------------
  //
  // Seen on a captured acceptance frame. The model wrote
  //
  //     Let me reconsider. Hmm. Actually, the --zerotier flag parses, but
  //     run() never dispatches to zerotier.connect().
  //
  // The first two sentences went; the third stayed, because it carries a
  // finding and dropping it would be the filter eating the answer. But it kept
  // its `Actually,` — a word that says only "I am revising my thinking out
  // loud", attached to the one sentence in the message worth reading.
  //
  // As a WHOLE line these are already dropped as filler. This is the other
  // half: in front of substance, the marker goes and the substance stays.
  //
  // THE COMMA IS WHAT MAKES IT A MARKER, and it is load-bearing. "Actually,
  // the flag parses" is somebody revising out loud; "Actually running the
  // tests is the next step" is an ADVERB modifying a verb, and trimming that
  // rewrites the sentence. So this family REQUIRES the punctuation that
  // separates a discourse marker from a word doing grammatical work.
  + '|(?:actually|hmm+|wait|but\\s+wait|so\\s+actually|in\\s+fact)[,:]\\s+'
  + ')(?=\\S)', 'i');

/** The sentence with any such preface taken off, or unchanged. */
function unpreface(line) {
  const t = String(line);
  const m = PREFACE.exec(t);
  if (!m) return t;
  const rest = t.slice(m[0].length);
  if (!rest.trim()) return t;                 // the preface WAS the whole sentence
  return m[1] + rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * ONE LINE, WITH THE ANNOUNCEMENTS INSIDE IT TAKEN OUT.
 *
 * Returns the line unchanged unless it is several sentences AND at least one of
 * them is narration AND at least one is not. Every one of those conditions is
 * load-bearing:
 *
 *   SEVERAL SENTENCES   a single-sentence line is `isNarration`'s own job, and
 *                       going through here would only re-ask the same question.
 *   AT LEAST ONE CUT    otherwise the line is rebuilt for nothing, and rejoining
 *                       normalises whitespace the model may have meant.
 *   AT LEAST ONE KEPT   a line that is ENTIRELY narration is a decision for the
 *                       caller, which has the whole message and can tell whether
 *                       dropping it would leave nothing at all.
 *
 * @returns {string|null} the trimmed line, or null if every sentence went.
 */
function trimSentences(line) {
  const parts = String(line).split(SENTENCE_SPLIT);
  // A PREFACE IS TAKEN OFF WHETHER OR NOT ANYTHING IS DROPPED — it is a trim of
  // one sentence, not a decision about the line, so it applies to the
  // single-sentence case too and must not be gated behind a cut.
  //
  // EVERY SENTENCE, NOT JUST THE FIRST. Measured off a real session: the model
  // wrote a paragraph on one line and the throat-clearing was on the SECOND
  // sentence of it — "…never dispatches to zerotier.connect(). Also worth
  // noting the loader runs twice." A first-sentence-only pass left the one
  // instance that actually occurred.
  const prefaced = parts.map(unpreface);
  const moved = prefaced.some((p, i) => p !== parts[i]);
  if (parts.length < 2) return moved ? prefaced[0] : line;
  const kept = prefaced.filter((p) => !isNarration(p));
  if (kept.length === prefaced.length && !moved) return line;
  if (!kept.length) return null;
  // The indentation of the line is the line's, and survives the rebuild.
  const lead = (/^[ \t]*/.exec(line) || [''])[0];
  return lead + kept.join(' ').trim();
}

/**
 * The message, with the narration taken out.
 *
 * Returns the original when nothing matched, so the common case costs one pass
 * and changes nothing.
 *
 * ------------------------------------------------------------------------
 * `last` — IS THIS THE MODEL'S FINAL WORD ON THE TURN?
 *
 * It decides the one case this filter cannot judge alone: a message that is
 * ENTIRELY narration.
 *
 *     I will now run the tests.
 *
 * Every sentence of it matched, so the honest condensed form is nothing at all.
 * The old rule kept it regardless, on the argument that "an empty answer is
 * worse than a redundant one" — and against a real session that argument turned
 * out to be about a DIFFERENT message. It is right about the last thing said in
 * a turn: a turn that ends having apparently said nothing reads as a failure.
 * It is wrong about a mid-turn announcement, because the screen is not empty
 * there — the timeline underneath is about to draw `running · npm test`, in
 * full, which is the whole of what the sentence was going to say.
 *
 * So the guard narrows to where its reasoning holds. Mid-turn, ACTIVITY is the
 * narration (the brief's §6) and a pure announcement goes. At the end of a turn
 * nothing else is speaking, and it stays.
 *
 * DEFAULTS TO TRUE, so a caller that has not thought about it gets the cautious
 * behaviour rather than a silently emptied message.
 */
function prose(text, { last = true } = {}) {
  const src = trimRestatement(String(text == null ? '' : text));
  if (!src.trim()) return src;
  const lines = src.split(CR + NL).join(NL).split(NL);
  const out = [];
  let fenced = false;
  let cut = 0;
  for (const line of lines) {
    if (FENCE.test(line)) { fenced = !fenced; out.push(line); continue; }
    if (!fenced && isNarration(line)) { cut += 1; continue; }
    if (fenced) { out.push(line); continue; }
    // A PARAGRAPH ON ONE LINE is the shape a real model writes in, and the
    // announcement is one sentence inside it. See SENTENCE_SPLIT.
    const trimmed = trimSentences(line);
    if (trimmed === null) { cut += 1; continue; }
    if (trimmed !== line) cut += 1;
    out.push(trimmed);
  }
  if (!cut) return src;
  // A GAP LEFT BY A REMOVED LINE IS NOT A PARAGRAPH BREAK. Two blanks where a
  // sentence used to be reads as a missing paragraph, which is a different
  // wrong picture from the one this fixes.
  const joined = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
  if (joined.trim()) return joined;
  // EVERYTHING WAS NARRATION. Mid-turn that is exactly the case ACTIVITY exists
  // to cover and the message goes; as the last thing said it stays, because a
  // turn that ends having apparently said nothing reads as a failure. See the
  // `last` note above.
  return last ? src : '';
}


/**
 * PAST THIS MUCH PROSE MID-TURN, THE FEED SHOWS THE FINDING AND POINTS AT THE REST.
 *
 * ------------------------------------------------------------------------
 * THE WALL THAT SURVIVES THE NARRATION FILTER.
 *
 * Everything above removes sentences that say what the screen already says.
 * None of it touches a paragraph that is genuinely ANALYSIS — six sentences of
 * real reasoning, none of them an announcement, every one of them true. That is
 * the wall left on the screen, and it is left there in the middle of a run,
 * between two tool calls, where the reader wanted one line.
 *
 * It cannot be dropped: it is not narration, and deleting analysis to make the
 * feed tidy is the one thing this file must never do. So it is FOLDED — the
 * actionable part stays in ACTIVITY and the whole of it stays in DETAIL:
 *
 *     The runtime never dispatches to connect().
 *     ▶ full reasoning in DETAIL (8)
 *
 * ------------------------------------------------------------------------
 * WHAT IS KEPT IS CHOSEN, NOT TRUNCATED. Cutting the first N characters would
 * keep whatever the model happened to write first, which is usually the setup.
 * The sentences that carry a RESULT — a file, a symbol, a number, a failure —
 * are the ones a person needs at a glance, and `CARRIES_RESULT` already knows
 * how to spot them. If none does, the first sentence stands, because a
 * paragraph with no result in it is a paragraph whose first sentence is its
 * point.
 *
 * NEVER THE FINAL WORD. §18 of the brief: the summary is where LAIN is allowed
 * to explain. Folding is for prose BETWEEN tool calls, which is why the caller
 * passes `last` — the same flag that governs whole-message narration.
 *
 * NEVER ACROSS A FENCE. Code is the finding, and half a code block is nothing.
 */
const FOLD_CHARS = 320;
/** At most this many result-bearing sentences survive the fold. */
const FOLD_KEEP = 2;

/**
 * The message as ACTIVITY should draw it, and whether anything was held back.
 *
 * @returns {{text: string, folded: boolean}}
 */
function fold(text, { last = true } = {}) {
  const src = String(text == null ? '' : text);
  const plain = { text: src, folded: false };
  if (last || src.length <= FOLD_CHARS) return plain;
  // A fence means the substance is code, and code does not fold.
  const lines = src.split(CR + NL).join(NL).split(NL);
  if (lines.some((l) => FENCE.test(l))) return plain;

  const sentences = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    for (const part of line.split(SENTENCE_SPLIT)) if (part.trim()) sentences.push(part.trim());
  }
  if (sentences.length < 2) return plain;

  // ---- WHAT SURVIVES A FOLD IS CHOSEN BY CLASS FIRST ---------------------
  //
  // `CARRIES_RESULT` keeps the sentence that POINTS at something — a path, a
  // number, a call. A HYPOTHESIS usually points at nothing ("this may indicate
  // the loader is initialised twice") and is the most valuable sentence in the
  // paragraph, so selecting purely on result-bearing dropped exactly the line
  // worth keeping. ui/classify.js marks those PRESERVE; they come first, and
  // the result-bearing sentences fill whatever room is left.
  const preserved = sentences.filter(
    (x) => classify.renderPolicy(classify.classifySentence(x).class) === classify.DECISION.PRESERVE);
  const carrying = sentences.filter((x) => CARRIES_RESULT.test(x) && !preserved.includes(x));
  const chosen = [...preserved, ...carrying].slice(0, FOLD_KEEP);
  const kept = (chosen.length ? chosen : [sentences[0]]).join(' ');
  // NOT WORTH FOLDING. If what survives is most of what went in, the fold has
  // bought a pointer and nothing else, and the pointer is then pure noise.
  if (kept.length >= src.length * 0.7) return plain;
  return { text: kept, folded: true };
}

/**
 * How many SENTENCES this message would lose. For the tests, and for measuring.
 *
 * Counted in sentences rather than lines because that is the unit the filter
 * actually works in — a line-based count reported zero against a real session
 * in which two sentences of three were narration.
 */
function cutCount(text) {
  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  let fenced = false;
  let n = 0;
  for (const line of src) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line.trim()) continue;
    if (isNarration(line)) { n += 1; continue; }
    for (const s of line.split(SENTENCE_SPLIT)) if (isNarration(s)) n += 1;
  }
  return n;
}

module.exports = {
  prose, isNarration, why, trimSentences, unpreface, fold, cutCount,
  MAX_LINE, FOLD_CHARS, FOLD_KEEP,
};
