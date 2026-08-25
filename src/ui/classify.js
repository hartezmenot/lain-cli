'use strict';

/**
 * WHAT KIND OF THING DID THE MODEL JUST SAY — named, once, in one place.
 *
 * ------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, and it is an architectural complaint rather than a
 * feature request.
 *
 * ui/condense.js already decided which sentences the feed draws. It decided
 * correctly and it decided INVISIBLY: the classes were implicit in a pile of
 * regular expressions, so the only answer the program could give to "why was
 * that line hidden" was "because `ANNOUNCE_LOOK` matched and `REASON` did not".
 * That is an answer about an implementation, and it has two costs that compound:
 *
 *   NOBODY CAN AUDIT IT.   A reviewer asking whether findings survive has to
 *                          read every pattern and simulate the order.
 *   IT GROWS BY BLACKLIST. The only way to fix a wrong decision in a pile of
 *                          patterns is another pattern, forever.
 *
 * So the CLASSES are named here and the POLICY over them is written down once.
 * A line is hidden because it is an OPERATIONAL_INTENT and operational intent
 * is suppressed mid-turn — a sentence a person can argue with. The patterns are
 * still patterns; what changed is that they now decide a NAME, and something
 * else decides what happens to each name.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT AN NLP SYSTEM AND MUST NOT BECOME ONE. Every rule below is a closed
 * list of words or a shape. There is no model call, no scoring, no training
 * data and no state: the same sentence always classifies the same way, which is
 * the only property that makes a UI decision explainable after the fact.
 *
 * ------------------------------------------------------------------------
 * PRESENTATION ONLY, exactly as ui/condense.js is. Nothing here edits what the
 * model said in the session, on the wire, or in the turn record. It decides
 * what is DRAWN, and `/copy last` still hands back the unedited words.
 */

/**
 * THE ELEVEN THINGS A VISIBLE MESSAGE CAN BE.
 *
 * Ordered from the ones the interface wants gone to the ones it exists to
 * carry. Every one of them is a different DECISION, which is the only reason
 * for a class to exist — two classes with the same policy would be one class
 * with two spellings.
 */
const CLASS = Object.freeze({
  /** "Let me inspect router.js." — the screen is already saying this. */
  OPERATIONAL_INTENT: 'OPERATIONAL_INTENT',
  /** "Ok." · "The user wants the runner traced." — words about the words. */
  SELF_NARRATION: 'SELF_NARRATION',
  /** "Hmm." · "Actually, let me reconsider." · "Should I read the loader?" */
  INTERNAL_RECONSIDERATION: 'INTERNAL_RECONSIDERATION',
  /** "The flag parses but is never dispatched." — established, and it matters. */
  FINDING: 'FINDING',
  /** "This may indicate the loader is initialized twice." — NOT established. */
  HYPOTHESIS: 'HYPOTHESIS',
  /** "Permission is required before modifying configuration." */
  BLOCKER: 'BLOCKER',
  /** A question put to the PERSON, which is the most important line LAIN writes. */
  ASK_USER: 'ASK_USER',
  /** "The build failed with exit 1." */
  ERROR: 'ERROR',
  /** "The tests pass." */
  COMPLETION: 'COMPLETION',
  /** The closing report: Issue / Fix / Changed / Verified / How to run. */
  SUMMARY: 'SUMMARY',
  /** Prose that is none of the above. Kept, because unknown is not noise. */
  OTHER: 'OTHER',
});

/**
 * WHAT HAPPENS TO A CLASS. Three outcomes, and the third one is not decoration.
 *
 *   SUPPRESS   not drawn. What it was about to say is already on the screen.
 *   SHOW       drawn, and may be folded into DETAIL if the message is long.
 *   PRESERVE   drawn, and never selected away by a fold. A hypothesis is the
 *              most valuable thing a model writes and the least likely to
 *              contain a filename, so a fold that keeps "result-bearing"
 *              sentences drops exactly the sentence worth keeping.
 */
const DECISION = Object.freeze({
  SUPPRESS: 'SUPPRESS',
  SHOW: 'SHOW',
  PRESERVE: 'PRESERVE',
});

// ------------------------------------------------------------ vocabulary ---
//
// These moved here from ui/condense.js unchanged. Their commentary — why LOOK
// and DO are rescued differently, why a full stop inside a filename does not
// end a sentence — lives with the patterns rather than with the editing pass,
// because they are what decides the NAME.

/** Past this, a line is carrying more than an announcement. */
const MAX_LINE = 110;

/**
 * TWO KINDS OF VERB, and they are held apart because the rescue differs.
 *
 * LOOKING is what the timeline already draws in full — the verb AND the file.
 * "I'll read python.js" is drawn one row lower as `reading / python.js`, so
 * naming the file does not rescue the sentence. Only a REASON rescues it.
 *
 * DOING may be about to state something the tool result will not — which
 * approach, what it is replacing, why this file and not that one.
 */
const LOOK = '(?:read|re-?read|check|re-?check|look|take\\s+a\\s+look|inspect|examine|open|'
  + 'review|search|grep|scan|find|locate|see|verify|confirm|investigate|trace|'
  + 'explore|dig|peek|walk\\s+through|trace\\s+through)';
const DO = '(?:run|start|kick\\s+off|test|try|fix|update|patch|add|write|make|do|go|'
  + 'move|continue|proceed|begin)';

/** "Let me think about what might be happening here." — announced deliberation. */
const THINK = '(?:think|consider|reconsider|reason\\s+about|figure\\s+out|work\\s+out|'
  + 'understand|get\\s+a\\s+sense|make\\s+sense\\s+of|puzzle\\s+out|mull)';

/**
 * The openers. Optional stage-setting words, then a first-person intention.
 *
 * The subordinate clause — "While the build is running, …" — is part of the
 * lead rather than content, and is capped at a short clause so a sentence that
 * genuinely turns on a condition cannot be swallowed by it.
 */
const LEAD = '(?:(?:so|ok|okay|alright|right|good|great|now|next|then|first|firstly|'
  + 'finally|also|additionally|meanwhile|'
  + 'perhaps|maybe|possibly|'
  // ---- DISCOURSE MARKERS AND HEDGES, AND BOTH ARE LOAD-BEARING ----------
  //
  // MEASURED FAILURES, from a realistic transcript:
  //
  //   "Actually, let me reconsider - the parser is probably the issue."
  //   "I think I should look at the serializer first."
  //   "I guess we could try the other loader."
  //
  // All three reached the screen. The first because classification ran BEFORE
  // the preface was trimmed (ui/condense.js `prose` asks `isNarration` of the
  // RAW line), so `Actually,` sat in front of the announcement and stopped it
  // matching; it then fell through to the hedge test and was PRESERVED as a
  // hypothesis. The other two failed for the same reason with a different
  // opener: a hedge was not in this list, so `I think I should look` was not
  // recognised as an announcement either.
  //
  // A HEDGE IN FRONT OF AN INTENTION IS STILL AN INTENTION, and that is why
  // putting them HERE is precise rather than blunt: this list only matters
  // when an INTENT and a verb follow it.
  //
  //   'I think I should look at the parser'  -> LEAD + INTENT + LOOK -> goes
  //   'I think the parser is failing here'   -> no INTENT -> HYPOTHESIS -> kept
  //
  // The hedge is only ever discounted on a sentence that was going to be an
  // announcement anyway. A hedged CLAIM is untouched and still preserved.
  + 'actually|hmm+|wait|but\\s+wait|in\\s+fact|honestly|'
  + 'i\\s+think|i\\s+guess|i\\s+suspect|i\\s+wonder|i\\s+believe)[,:.]?\\s+|next\\s+up[,:]\\s+'
  + '|(?:while|once|after|before|when)\\s[^,.!?]{0,60},\\s+)*';
const INTENT = '(?:i\\s*(?:\'|’)?\\s*ll|i\\s+will|i\\s*(?:\'|’)?m\\s+going\\s+to|'
  + 'i\\s+am\\s+going\\s+to|i\\s+need\\s+to|i\\s+want\\s+to|i\\s+should|i\\s+am\\s+about\\s+to|'
  + 'let\\s+me|let\\s+us|let\\s*(?:\'|’)?s|we\\s*(?:\'|’)?ll|we\\s+will|going\\s+to|'
  + 'we\\s+could|i\\s+could|we\\s+might|i\\s+might|we\\s+should|'
  + 'time\\s+to|next\\s+up[,:]?)';
const HEDGE = '(?:just|quickly|now|also|first|then|briefly|next|probably|maybe|perhaps|'
  + 'go\\s+ahead\\s+and)\\s+';

/**
 * ONE SENTENCE, AND THE DOT IN A FILENAME IS NOT THE END OF IT.
 *
 * A full stop only ends a sentence when whitespace or the end of the line
 * follows it, which keeps `python.js` inside the clause.
 */
const ONE_SENTENCE = '(?:[^.!?]|[.](?![\\s]|$))*[.!?…]*\\s*$';
const ANNOUNCE_LOOK = new RegExp(
  `^\\s*${LEAD}${INTENT}\\s+(?:${HEDGE})*${LOOK}\\b${ONE_SENTENCE}`, 'i');
const ANNOUNCE_DO = new RegExp(
  `^\\s*${LEAD}${INTENT}\\s+(?:${HEDGE})*${DO}\\b${ONE_SENTENCE}`, 'i');
const ANNOUNCE_THINK = new RegExp(
  `^\\s*${LEAD}${INTENT}\\s+(?:${HEDGE})*${THINK}\\b${ONE_SENTENCE}`, 'i');

/**
 * A line that is only stage-setting or thinking noise, split into the two
 * classes it was always two of.
 *
 * REVISION markers are a monologue being revised in public; ACKNOWLEDGEMENT is
 * the model reporting its own state of mind. Both go, and they go for different
 * reasons — which is exactly what a named class is for.
 */
const REVISION_WORD = '(?:hmm+|huh|wait|hold\\s+on|actually|interesting|'
  + 'let\\s*(?:\'|’)?s\\s+see|let\\s+me\\s+(?:think|reconsider|check\\s+again)|'
  + 'one\\s+(?:sec|second|moment)|anyway|moving\\s+on)';
const ACK_WORD = '(?:ok|okay|alright|right|good|great|perfect|excellent|nice|got\\s+it|'
  + 'understood|sure|but|so|well|now|then|makes\\s+sense|that\\s+makes\\s+sense|'
  + 'as\\s+expected|so\\s+far\\s+so\\s+good)';
const SEP = '[\\s,.!?…:;-]';
/**
 * A CHAIN OF THEM IS STILL ONE OF THEM. "Hmm, but wait…" is three fillers, and
 * it is a REVISION because one of the three is — an acknowledgement chain that
 * contains a revision marker is somebody revising, not somebody agreeing.
 */
const REVISION = new RegExp(`^\\s*(?:(?:${REVISION_WORD}|${ACK_WORD})${SEP}*)*`
  + `${REVISION_WORD}(?:${SEP}*(?:${REVISION_WORD}|${ACK_WORD}))*${SEP}*$`, 'i');
const ACKNOWLEDGEMENT = new RegExp(`^\\s*(?:${ACK_WORD}${SEP}*)+$`, 'i');
/** Either of the two, which is the test the editing pass asks. */
const FILLER = new RegExp(`^\\s*(?:(?:${REVISION_WORD}|${ACK_WORD})${SEP}*)+$`, 'i');

/** A WHOLE LINE THAT RESTATES THE REQUEST, anywhere in the message. */
const RESTATES = new RegExp(
  '^\\s*(?:so\\s+)?(?:the\\s+user\\s+(?:wants|is\\s+asking|asked|would\\s+like|needs)'
  + '|you\\s+(?:want|asked|wanted|need)\\s+me\\s+to'
  + '|as\\s+(?:you\\s+)?requested'
  + '|based\\s+on\\s+your\\s+request'
  + '|per\\s+your\\s+request)\\b[^.!?]*[.!?]?\\s*$', 'i');

/**
 * A line that carries a RESULT is never an announcement, whatever it opens
 * with. A NAMED FUNCTION IS A SUSPECT and the timeline cannot draw one.
 */
const CALL = '[A-Za-z_$][\\w$]*\\(';
const CARRIES_RESULT = new RegExp(
  '(?:`|:\\d+|\\b\\d+\\b'
  + '|[\\w-]+\\.(?:js|ts|py|go|rs|java|rb|json|md|yml|yaml|toml|sh|ps1|txt|html|css)\\b'
  + `|${CALL}|→|->)`, 'i');

/**
 * WHAT A FINDING SOUNDS LIKE WHEN IT NAMES NO FILE.
 *
 * `CARRIES_RESULT` catches the finding that points at something — a path, a
 * line number, a call. It misses the other half, and the other half is the one
 * the brief names first:
 *
 *     The flag parses but is never dispatched.
 *     The serializer still emits the legacy field.
 *
 * No filename, no number, no call — and both are exactly the sentence this
 * interface exists to keep. What they have instead is CONTRAST: something is
 * true and something else, which should follow from it, is not. That shape is a
 * short closed list of words, and it is what a finding reads like.
 *
 * A LOOSE TEST ON PURPOSE, and it is safe to be loose here because FINDING and
 * OTHER are drawn identically. Being wrong costs the name in an audit report,
 * never a line on the screen.
 */
const ASSERTS = new RegExp(
  '\\b(?:never|always|still|only|instead|no\\s+longer|missing|absent|unwired|unused|'
  + 'duplicated|twice|neither|but|however|does\\s*n[o’\']t|do\\s*n[o’\']t|is\\s*n[o’\']t|'
  + 'are\\s*n[o’\']t|was\\s*n[o’\']t|were\\s*n[o’\']t|cannot|can\\s*n[o’\']t|fails\\s+to|'
  + 'without|before\\s+it|out\\s+of\\s+order'
  + ')\\b', 'i');

/**
 * A REASON — the one thing that rescues an announcement about LOOKING.
 * Deliberately narrow: `whether`, `which` and `why` are NOT here.
 */
const REASON = /\b(?:because|but|however|although|since|so\s+that|to\s+see\s+if|to\s+confirm|to\s+rule\s+out|in\s+case|instead\s+of|rather\s+than)\b/i;

/** A QUESTION THE MODEL IS ASKING ITSELF, IN PUBLIC. */
const SELF_ASK = new RegExp(
  '^\\s*(?:so\\s+|but\\s+|hmm[,.]?\\s+|actually[,.]?\\s+)?'
  + '(?:should|shall|can|could|do|must|ought)\\s+(?:i|we)\\b[^?]*'
  + '\\bask(?:_user|\\s+(?:the\\s+)?user)?\\b[^?]*\\?\\s*$', 'i');

/**
 * THE SAME SELF-QUESTION, HEDGED — and a model hedges constantly.
 *
 * `SELF_ASK` above is anchored on a modal in first position: `Should I ask…`,
 * `Can I ask_user…`. That is the shape a model writes when it is being direct,
 * and it is not the common one. These reached the screen unchanged:
 *
 *     Maybe I should ask the user which one they want.
 *     I wonder if I should ask the user.
 *     Is it worth asking the user?
 *
 * Same sentence, same deliberation, addressed to nobody — and on screen it
 * reads as though LAIN were waiting for an answer to a question nobody was
 * ever asked. `ask_user` is how a question is asked; prose is not.
 *
 * NOTE THE GUARD AT THE CALL SITE. None of these may fire on a sentence
 * addressed to the PERSON: `Is it worth asking you to confirm first?` is a
 * genuine question wearing the same opener, and suppressing it would leave LAIN
 * apparently working while it is actually blocked. That is the expensive
 * direction, so second person wins.
 */
const SELF_ASK_HEDGED = new RegExp(
  '^\\s*(?:so\\s+|but\\s+|hmm[,.]?\\s+|actually[,.]?\\s+)?'
  + '(?:(?:maybe|perhaps)\\s+(?:i|we)\\s+(?:should|could|might|ought\\s+to|need\\s+to)\\s+'
  + '|(?:i|we)\\s+wonder\\s+(?:if|whether)\\s+(?:i|we)\\s+(?:should|could|might|ought\\s+to|need\\s+to)\\s+'
  + '|is\\s+it\\s+worth\\s+)'
  + '[^?]*\\bask(?:ing|_user)?\\b', 'i');

const SELF_LOOK = new RegExp(
  '^\\s*(?:so\\s+|but\\s+|hmm[,.]?\\s+|actually[,.]?\\s+)?'
  + '(?:should|shall|can|could|do|does|must|ought|maybe|perhaps)\\s+(?:i|we)\\s+'
  + `(?:should\\s+|need\\s+to\\s+|have\\s+to\\s+|also\\s+|first\\s+|just\\s+)*${LOOK}\\b[^?]*\\?\\s*$`, 'i');

/** " or " means a choice is being offered, and a choice is for the user. */
const OFFERS_CHOICE = /\bor\b/i;

/**
 * A QUESTION PUT TO THE PERSON. The brightest line in this file.
 *
 * Second person, or an either/or, and it ends in a question mark. Anything that
 * reaches this test is not self-deliberation — SELF_ASK is asked first — so what
 * is left is addressed outward. Getting this wrong in the direction of SHOW
 * costs one redundant line; getting it wrong the other way eats a question
 * somebody was waiting to be asked.
 */
const ASKS_USER = /\?\s*$/;
const SECOND_PERSON = /\b(?:you|your|you're|you’re|shall\s+i|would\s+you|do\s+you\s+want|which\s+would)\b/i;

/**
 * A BLOCKER — a wall named, with the work stopped in front of it.
 *
 * "cannot" alone is not enough: "the parser cannot see the field" is a finding.
 * What makes a blocker is the SPEAKER being stopped, or a named gate.
 */
const BLOCKED = new RegExp(
  '\\b(?:'
  + 'i\\s+(?:cannot|can\'t|can’t|am\\s+unable\\s+to|am\\s+blocked)'
  + '|blocked\\s+(?:on|by)|permission\\s+is\\s+required|requires?\\s+permission'
  + '|needs?\\s+(?:your\\s+)?approval|not\\s+authori[sz]ed|access\\s+denied'
  + '|rate\\s+limit(?:ed)?|quota\\s+(?:reached|exhausted)|credential\\s+is\\s+missing'
  + '|no\\s+credential|waiting\\s+for\\s+you'
  + ')\\b', 'i');

/** AN ERROR — something ran and did not work. Names the failure, not a risk. */
const FAILED = new RegExp(
  '\\b(?:'
  + 'failed|failing|fails|error|errors|exception|traceback|stack\\s+trace|crashed|'
  + 'exit(?:ed\\s+with)?\\s+(?:code\\s+)?[1-9]|non-?zero\\s+exit|refused|rejected|'
  + 'timed\\s+out|not\\s+found|undefined\\s+is\\s+not'
  + ')\\b', 'i');

/**
 * A COMPLETION — a claim that something now works, stated as done.
 *
 * Held apart from FINDING because the policy differs at the end of a turn: a
 * completion is the sentence a person is looking for and must never be folded
 * away behind a pointer.
 */
const COMPLETED = new RegExp(
  '\\b(?:'
  + 'tests?\\s+(?:now\\s+)?pass(?:es|ed)?|all\\s+(?:tests|checks)\\s+pass|suite\\s+is\\s+green|'
  + '(?:is|are|now)\\s+(?:fixed|working|green|passing|resolved|done|complete)|'
  + 'no\\s+(?:failures|regressions)'
  + ')', 'i');
const DONE_ALONE = /^\s*(?:done|fixed|complete|completed|all\s+green)\s*[.!]?\s*$/i;

/**
 * A HYPOTHESIS — a cause offered, explicitly not established.
 *
 * The hedge is the whole of the signal, and it has to be a hedge about the
 * CLAIM rather than a hedge inside it: "the loader may run twice" hedges;
 * "check whether it may run twice" is an announcement with a hedge in its
 * object, and the announcement rules see that one first.
 */
const HEDGED = new RegExp(
  '\\b(?:'
  + 'may\\s+(?:indicate|mean|be|have|suggest)|might\\s+(?:be|have|indicate|mean|explain)|'
  + 'appears?\\s+to|seems?\\s+to|seems\\s+like|looks\\s+like|'
  + 'likely|probably|possibly|presumably|suggests?\\s+that|'
  + 'suspect|i\\s+think|my\\s+guess|could\\s+(?:be|explain|indicate)|'
  + 'not\\s+established|unconfirmed|hypothesis'
  + ')\\b', 'i');

/**
 * THE SUMMARY SCHEMA — the closing report's own section labels.
 *
 * A message carrying two or more of these as headings IS the summary, whatever
 * else is in it. One alone is not enough: a line reading `Fix` could be a
 * fragment, and a report is a structure rather than a word.
 *
 * ui/markdown.js draws these as section labels, and reads the same list from
 * here so the renderer and the classifier cannot disagree about what a heading
 * is.
 */
const SCHEMA_WORDS = Object.freeze([
  'issue', 'problem', 'cause', 'root cause', 'fix', 'change', 'changed', 'changes',
  'verified', 'verification', 'how to run', 'how to test',
  'limitations', 'limitation', 'remaining', 'next', 'next steps', 'summary', 'result',
]);
/** A line that is nothing but a schema word, with optional markup and colon. */
const SCHEMA_HEADING = new RegExp(
  `^\\s*(?:[-*+]\\s+)?(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(${SCHEMA_WORDS.join('|')})\\s*(?:\\*\\*|__)?\\s*:?\\s*$`, 'i');

/** WHERE ONE SENTENCE ENDS AND THE NEXT BEGINS. */
const SENTENCE_SPLIT = /(?<=[.!?…])\s+(?=[A-Z“‘"'(\[])/;

/** A fence opens or closes here. Everything between is code and is untouched. */
const FENCE = /^\s*(?:```|~~~)/;

// ------------------------------------------------------------- the rules ---

/**
 * WHICH CLASS IS THIS ONE SENTENCE, and WHY.
 *
 * The order IS the policy. It runs from the classes that must never be lost to
 * the classes the interface exists to remove, so a sentence that is both a
 * finding and an announcement is a finding — which is the direction this has to
 * fail in.
 *
 * @param {string} text  ONE sentence or one line. Not a whole message.
 * @param {object} ctx   { last } — is this the model's final word on the turn?
 * @returns {{class: string, why: string}}
 */
function classifySentence(text, ctx = {}) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return { class: CLASS.OTHER, why: 'empty' };

  // ---- THE QUESTION, BEFORE ANY SUPPRESSING RULE CAN REACH IT ------------
  //
  // "Should I ask the user?" is never a question TO the user — it is a question
  // about asking them, and by the time it is on screen the model has already
  // decided not to. A choice genuinely offered to somebody is an ASK whatever
  // else it looks like.
  // Second person wins: a question addressed to the PERSON is never
  // self-deliberation, whatever opener it wears. See SELF_ASK_HEDGED.
  if (SELF_ASK.test(t) || (SELF_ASK_HEDGED.test(t) && !SECOND_PERSON.test(t))) {
    return { class: CLASS.INTERNAL_RECONSIDERATION, why: 'a question about whether to ask, addressed to nobody' };
  }
  if (ASKS_USER.test(t) && (OFFERS_CHOICE.test(t) || SECOND_PERSON.test(t)) && !SELF_LOOK.test(t)) {
    return { class: CLASS.ASK_USER, why: 'a question addressed to the user' };
  }
  if (SELF_LOOK.test(t) && !OFFERS_CHOICE.test(t)) {
    return { class: CLASS.INTERNAL_RECONSIDERATION, why: 'deliberation about looking, asked out loud' };
  }

  // ---- THE SEAMS OF A MONOLOGUE -----------------------------------------
  //
  // Whole-line only. "Actually the parser never sees it" is analysis; only a
  // line that is NOTHING but markers is one of these.
  if (REVISION.test(t)) return { class: CLASS.INTERNAL_RECONSIDERATION, why: 'a revision marker with nothing attached' };
  if (ACKNOWLEDGEMENT.test(t)) return { class: CLASS.SELF_NARRATION, why: 'an acknowledgement with nothing attached' };
  if (RESTATES.test(t)) return { class: CLASS.SELF_NARRATION, why: 'restates the request back to the person who wrote it' };

  // ---- ANNOUNCEMENTS, AND WHAT RESCUES EACH KIND -------------------------
  //
  // Past MAX_LINE a sentence is carrying something besides the announcement,
  // whatever it opens with — deliberately generous, because a plan earns a line.
  const long = t.length > MAX_LINE;
  const result = CARRIES_RESULT.test(t);
  const reason = REASON.test(t);
  if (!long && ANNOUNCE_LOOK.test(t) && !reason) {
    // Naming the file does not rescue this one: the file is the half the
    // timeline is best at, drawn in full one row lower.
    return { class: CLASS.OPERATIONAL_INTENT, why: 'announces a look the timeline already draws, with no reason given' };
  }
  if (!long && ANNOUNCE_DO.test(t) && !result && !reason) {
    return { class: CLASS.OPERATIONAL_INTENT, why: 'announces an action the timeline already draws' };
  }
  if (!long && ANNOUNCE_THINK.test(t) && !result && !reason) {
    return { class: CLASS.INTERNAL_RECONSIDERATION, why: 'announces that thinking is about to happen' };
  }

  // ---- A WALL, AND A FAILURE --------------------------------------------
  //
  // AFTER the announcements, and that order is load-bearing. "Let me check the
  // logs for errors" contains the word `errors` and is still an announcement;
  // asking FAILED first would rescue every announcement that happens to name
  // the thing it is about to go and look at, which is most of them.
  if (BLOCKED.test(t)) return { class: CLASS.BLOCKER, why: 'names a wall the work stopped at' };
  if (FAILED.test(t)) return { class: CLASS.ERROR, why: 'names something that failed' };

  // ---- WHAT WAS FINISHED -------------------------------------------------
  //
  // Also after the announcements, for the same reason: "I'll run the tests" and
  // "the tests pass" are different sentences and only the second is a claim.
  if (DONE_ALONE.test(t) || COMPLETED.test(t)) {
    return { class: CLASS.COMPLETION, why: 'claims something is now done or passing' };
  }

  // ---- OFFERED, NOT ESTABLISHED -----------------------------------------
  if (HEDGED.test(t)) return { class: CLASS.HYPOTHESIS, why: 'offers a cause and marks it as unestablished' };

  // ---- ESTABLISHED, AND WORTH THE LINE ----------------------------------
  if (result) return { class: CLASS.FINDING, why: 'names a file, a symbol, a number or a call' };
  if (ASSERTS.test(t)) return { class: CLASS.FINDING, why: 'asserts that something expected does not happen' };
  return { class: CLASS.OTHER, why: 'prose that matches no rule — kept, because unknown is not noise' };
}

/** Every sentence in a message, fences excluded — the unit this file works in. */
function sentencesOf(text) {
  const out = [];
  let fenced = false;
  for (const line of String(text == null ? '' : text).split('\r\n').join('\n').split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line.trim()) continue;
    for (const part of line.split(SENTENCE_SPLIT)) if (part.trim()) out.push(part.trim());
  }
  return out;
}

/** How many of the closing schema's own headings this message carries. */
function schemaHeadings(text) {
  let n = 0;
  let fenced = false;
  for (const line of String(text == null ? '' : text).split('\r\n').join('\n').split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (SCHEMA_HEADING.test(line)) { n += 1; continue; }
    // `How to run: npm start` is a heading AND its content on one line — the
    // form the prompt asks for by name. ui/markdown.js draws it as a callout.
    if (/^\s*(?:[-*+]\s+)?(?:\*\*)?\s*how\s+to\s+(?:run|test)\b/i.test(line)) n += 1;
  }
  return n;
}

/**
 * WHICH CLASS IS THIS WHOLE MESSAGE.
 *
 * A message is its most consequential sentence, with one exception: a message
 * carrying the closing schema IS the summary, because that is a structure
 * rather than a sentence.
 *
 * @param {string} text
 * @param {object} ctx  { last }
 * @returns {{class: string, why: string, sentences: Array}}
 */
function classifyVisibleMessage(text, ctx = {}) {
  const src = String(text == null ? '' : text);
  const sentences = sentencesOf(src).map((s) => ({ text: s, ...classifySentence(s, ctx) }));
  const headings = schemaHeadings(src);
  if (headings >= 2) {
    return { class: CLASS.SUMMARY, why: `carries ${headings} of the closing schema's own headings`, sentences };
  }
  // THE MOST CONSEQUENTIAL SENTENCE WINS, in the order the classes are declared
  // to matter. A message with one finding in it is a message with a finding in
  // it, however much announcement surrounds it.
  const rank = [CLASS.ASK_USER, CLASS.BLOCKER, CLASS.ERROR, CLASS.FINDING,
    CLASS.HYPOTHESIS, CLASS.COMPLETION, CLASS.OTHER,
    CLASS.OPERATIONAL_INTENT, CLASS.INTERNAL_RECONSIDERATION, CLASS.SELF_NARRATION];
  for (const k of rank) {
    const hit = sentences.find((s) => s.class === k);
    if (hit) return { class: k, why: hit.why, sentences };
  }
  return { class: CLASS.OTHER, why: 'nothing was said', sentences };
}

/**
 * WHAT THE FEED DOES WITH A CLASS — the policy, written once.
 *
 * MID-TURN the three narration classes go, because the ACTIVITY surface
 * underneath is already drawing the verb and the file in full. AT THE END OF A
 * TURN nothing else is speaking, so a message that is ENTIRELY narration stays
 * rather than leaving a turn that appears to have said nothing — see
 * ui/condense.js `prose`, which owns that whole-message rescue. The per-sentence
 * decision is the same either way: a narration sentence sitting next to a
 * finding is noise in a final message too.
 *
 * @param {string} cls  a CLASS
 * @param {object} ctx  { last }
 */
function renderPolicy(cls) {
  const quiet = cls === CLASS.OPERATIONAL_INTENT
    || cls === CLASS.SELF_NARRATION
    || cls === CLASS.INTERNAL_RECONSIDERATION;
  if (quiet) return DECISION.SUPPRESS;
  // NEVER FOLDED AWAY. These three are the classes most likely to carry no
  // filename and most costly to lose — see DECISION.PRESERVE.
  if (cls === CLASS.HYPOTHESIS || cls === CLASS.ASK_USER || cls === CLASS.BLOCKER) {
    return DECISION.PRESERVE;
  }
  return DECISION.SHOW;
}

/**
 * THE DIAGNOSTIC VIEW — raw candidate, class, decision, reason.
 *
 * For the audit tool and the tests. NOT for the interface: a person watching
 * LAIN work has no use for the name of the rule that hid a sentence, and putting
 * it on screen would be the narration this file exists to remove, wearing a
 * badge. See tools/classify-report.js, which is where this is read.
 */
function explain(text, ctx = {}) {
  return sentencesOf(text).map((s) => {
    const c = classifySentence(s, ctx);
    return { text: s, class: c.class, decision: renderPolicy(c.class, ctx), why: c.why };
  });
}

module.exports = {
  CLASS, DECISION,
  classifyVisibleMessage, classifySentence, renderPolicy, explain, sentencesOf,
  schemaHeadings,
  // The vocabulary, for ui/condense.js — which does the EDITING this classifies.
  MAX_LINE, CARRIES_RESULT, SENTENCE_SPLIT, FENCE, FILLER, SCHEMA_HEADING, SCHEMA_WORDS,
};
