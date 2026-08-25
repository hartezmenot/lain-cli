'use strict';

/**
 * WHAT KIND OF WORK IS THIS?
 *
 * `task.js` answers "is this the same task as before?". This answers a
 * different and orthogonal question: what does the user actually want done —
 * and therefore what should happen FIRST.
 *
 * The two must not be merged. "continue" is a continuation of whatever mode was
 * already running; "audit this" is a new task in a mode that must not write
 * files. One classifier answering both would have to disagree with itself.
 *
 * WHY THIS IS DETERMINISTIC, AND MUST STAY SO
 *
 * The alternative is a model call to decide how to spend model calls, which is
 * both circular and the most expensive possible way to answer a question that a
 * dozen words of English already settle. "Add a button" is an implementation
 * request under any reading. So this is pure string work: no network, no tokens,
 * no I/O, and the same input always yields the same mode.
 *
 * It is also ADVISORY. The mode selects a paragraph of guidance for the system
 * prompt — it never forces a tool, forbids a tool, or dictates an order. A
 * misclassification therefore costs a slightly wrong hint, never a blocked task.
 * That is the whole reason it is safe to decide this locally.
 *
 * WHAT EACH MODE CHANGES
 *
 *   BUGFIX / TROUBLESHOOT   trace before editing; find the break, fix that
 *   MIGRATE                 the FINAL STATE differs; the old thing must go
 *   IMPLEMENT               find the existing architecture before adding to it
 *   NEW_PROJECT             build in stages, each one verified
 *   AUDIT / EXPLAIN         read only; do not modify anything
 *   RESUME                  pick up the existing plan rather than re-planning
 *   CHAT                    answer; do not go rummaging through the repository
 */

// The task-identity verdict is CONSUMED, never re-derived. Importing task.js's
// vocabulary is what makes that structural: there is no second place in the
// program that decides what "carry on" means, and this file could not disagree
// with task.js even if it wanted to.
const taskKinds = require('./task').KIND;

const KIND = Object.freeze({
  CHAT: 'CHAT',
  MIGRATE: 'MIGRATE',
  EXPLAIN: 'EXPLAIN',
  AUDIT: 'AUDIT',
  BUGFIX: 'BUGFIX',
  TROUBLESHOOT: 'TROUBLESHOOT',
  IMPLEMENT: 'IMPLEMENT',
  REFACTOR: 'REFACTOR',
  NEW_PROJECT: 'NEW_PROJECT',
  RESUME: 'RESUME',
  PROBE: 'PROBE',
});

/** Read-only modes. Nothing here should be writing to the user's files. */
const READ_ONLY = new Set([KIND.AUDIT, KIND.EXPLAIN, KIND.CHAT]);

// --------------------------------------------------------------- signals ----
//
// Ordered by how strongly each phrase commits to a mode. The first rule that
// matches wins, so the sequence below IS the precedence.

/** "make me a X", "build a new Y from scratch" — nothing exists yet. */
const NEW_PROJECT_RE = /\b(?:create|build|make|write|scaffold|generate|start|set ?up|bootstrap)\b[^.?!]{0,40}\b(?:new |brand[- ]new |a |an |me a |me an )?(?:project|app|application|bot|tool|service|server|website|site|cli|library|package|game|dashboard|script)\b/i;
const FROM_SCRATCH_RE = /\bfrom scratch\b|\bnew project\b|\bgreenfield\b/i;

/** "audit", "review the codebase", "what's missing" — assess, do not change. */
const AUDIT_RE = /\b(?:audit|assess|review|inspect|analy[sz]e|evaluate|critique|health[- ]check)\b/i;
const AUDIT_QUESTION_RE = /\bwhat(?:'s| is| are)?\b[^.?!]{0,30}\b(?:missing|wrong with|broken|left to do|the state of|not implemented)\b/i;

/** "explain", "what does X do", "how does Y work" — describe, do not change. */
const EXPLAIN_RE = /\b(?:explain|describe|walk me through|what does\b|what do\b|how does\b|how do(?:es)?\b[^.?!]{0,20}\bwork|what is this|tell me (?:about|what|how)|summari[sz]e)\b/i;

/**
 * A concrete failure: a named thing behaving in a named wrong way.
 *
 * `SYMPTOM_RE` is the observable ("doesn't switch", "returns null", "crashes"),
 * which is what separates a bug report from a feature request.
 */
const SYMPTOM_RE = /\b(?:doesn'?t|does not|won'?t|will not|isn'?t|is not|aren'?t|are not|can'?t|cannot|never|fails?|failing|failed|broken|breaks?|crash(?:es|ed|ing)?|hangs?|stuck|error|errors|exception|throws?|returns? (?:null|undefined|nothing|the wrong)|wrong|incorrect|empty|missing|not (?:working|updating|showing|saving|firing|switching|changing|responding))\b/i;
const BUG_NOUN_RE = /\b(?:bug|regression|defect|traceback|stack ?trace|500|404|nan|undefined is not)\b/i;
/** "it should X but Y" — the clearest possible statement of a defect. */
const EXPECTATION_RE = /\bshould\b[^.?!]{0,60}\b(?:but|instead|however|yet)\b/i;

/**
 * Vague trouble: something is wrong and the user cannot say what.
 *
 * This is the ONLY thing separating TROUBLESHOOT from BUGFIX, and it is
 * deliberately a test for vagueness rather than a test for specificity. An
 * earlier version asked "does this name something concrete?" and demanded a
 * path, a quoted string or a CamelCase identifier — which failed on "the login
 * button is stuck on OFF", a perfectly specific bug report written the way
 * people actually write them. Recognising the small, closed set of hedging
 * words is reliable; recognising every way English can name a thing is not.
 */
const VAGUE_RE = /\b(?:some(?:thing|how|where)|anything|not sure|no idea|dunno|weird|strange|odd|flaky|intermittent|randomly|sometimes|occasionally|seems? to|kind of|acting up)\b/i;

/**
 * A complaint with no subject at all — "it doesn't work", "nothing happens".
 * There is nothing to trace yet, so the first job is to find out what broke.
 */
const NO_SUBJECT_RE = /^(?:it|this|that|things?|nothing|everything|stuff|the app|the thing)\b[^.?!]{0,40}$/i;

/**
 * CHANGING THE SHAPE OF WORKING CODE, not what it does.
 *
 * Shares most of its verbs with IMPLEMENT and is a genuinely different job:
 * the behaviour already exists and is correct, so the risk is not "does the new
 * thing work" but "did the old thing survive". That inverts what to do first —
 * pin the current behaviour down before moving anything, because afterwards
 * there is nothing left to compare against.
 *
 * MUST BE TESTED BEFORE `IMPLEMENT_RE`, which also matches `refactor` and
 * `rename` and would otherwise swallow every one of these.
 */
const REFACTOR_RE = /\b(?:refactor|restructure|reorgani[sz]e|rewrite|clean ?up|tidy|simplify|de-?duplicate|dedupe|extract|inline|split (?:up|out|into)|move|rename|modulari[sz]e|untangle|consolidate)\b/i;

/** "add", "implement", "support for" — build something that is not there yet. */
const IMPLEMENT_RE = /\b(?:add|implement|introduce|support|enable|integrate|wire ?up|hook ?up|expose|extend|create|build|make|write|refactor|rename|migrate|convert|replace|remove|delete|drop|update|change|improve|optimi[sz]e|port)\b/i;

/**
 * Conversation, not work. Pleasantries arrive combined — "nice, thank you",
 * "ok cool thanks" — so the whole line must be nothing but them.
 */
const CHAT_WORD = '(?:hi|hey|hello|yo|thanks?|thank you|ta|cheers|ok(?:ay)?|cool|nice|great|perfect|got it|sounds good|never ?mind|nvm|sorry|no worries|wait|hmm+|lol)';
/**
 * WHO THE PLEASANTRY IS ADDRESSED TO. "hi there", "hey lain", "thanks mate".
 *
 * Without this, only a greeting standing completely alone was recognised, so
 * "hi there" fell all the way through to the default — which is IMPLEMENT. A
 * greeting was therefore answered with build-it-in-stages guidance, and the
 * mode most likely to touch the code was the one reached by saying hello.
 */
const CHAT_ADDRESS = '(?:there|again|all|team|mate|friend|folks|everyone|lain|bot)';
const CHAT_RE = new RegExp(
  `^\\s*${CHAT_WORD}(?:[\\s,.!?]+(?:${CHAT_WORD}|${CHAT_ADDRESS}))*[\\s.!?]*$`, 'i');

/**
 * FIND IT, DO NOT CHANGE IT — "where is X", "what controls Y", "which file
 * sets Z", "trace the call".
 *
 * These ask LAIN to LOCATE something. They name no defect, so TROUBLESHOOT is
 * wrong, and they ask for no change, so IMPLEMENT is worse than wrong: it is
 * the mutation mode, and reaching it from a question is how "find what sets
 * this value" turns into an edit nobody asked for. EXPLAIN is read-only and its
 * guidance is exactly right for the job — map it deterministically, search
 * rather than read everything.
 */
const LOCATE_RE = /\b(?:where(?:'s| is| are| does| do)|which file|what (?:controls|sets|decides|calls|uses|defines|owns)|who (?:calls|sets|owns))\b|\b(?:find|locate|trace|track down|follow)\b[^.?!]{0,40}\b(?:where|what|which|the (?:code|function|file|place|caller|definition|call|path|flow|chain))\b/i;

/** A question with no imperative — the user wants an answer, not an edit. */
const QUESTION_RE = /^[^.!]*\?\s*$/;

/**
 * Classify a request into a workflow mode.
 *
 * @param {string} text
 * @param {object} ctx
 *   isPaste     a paste is CONTENT; it never selects a mode (see task.js rule 1)
 *   taskKind    the verdict from task.js, so a continuation stays a continuation
 *   activeMode  the mode already running, inherited by a continuation
 *   projectEmpty  no recognisable project here — "build a bot" then means a new one
 * @returns {{ mode, reason, readOnly, deterministic: true }}
 */
function classify(text, ctx = {}) {
  const raw = String(text == null ? '' : text);
  const s = raw.trim();
  const one = s.replace(/\s+/g, ' ');

  const decide = (mode, reason) => ({ mode, reason, readOnly: READ_ONLY.has(mode), deterministic: true });

  // 1. A CONTINUATION KEEPS ITS MODE. "continue" says nothing about what kind
  //    of work this is — the work already running decides that. Re-classifying
  //    it from the word "continue" alone would flip a bugfix into a chat.
  if (ctx.taskKind === taskKinds.CONTINUATION) {
    return decide(ctx.activeMode || KIND.RESUME, 'continuing the active task');
  }

  // 2. A PASTE IS CONTENT. The terminal told us structurally. A pasted stack
  //    trace is full of "error" and "failed" and is not a bug report — it is
  //    evidence attached to whatever is already being worked on.
  if (ctx.isPaste) {
    return decide(ctx.activeMode || KIND.IMPLEMENT, 'pasted content, not a new request');
  }

  if (!one) return decide(KIND.CHAT, 'empty input');

  // 3. Pleasantries. Cheap to detect and it stops "thanks!" scanning a repo.
  if (CHAT_RE.test(one)) return decide(KIND.CHAT, 'conversational');

  // 4. A NEW PROJECT outranks IMPLEMENT, because "build a trading bot" and
  //    "build a login form" share a verb and mean very different things. The
  //    object of the verb is what separates them.
  if (FROM_SCRATCH_RE.test(one)) return decide(KIND.NEW_PROJECT, 'asks for something built from scratch');
  if (NEW_PROJECT_RE.test(one)) {
    // In an existing project, "build a dashboard" is a feature, not a new repo.
    if (ctx.projectEmpty) return decide(KIND.NEW_PROJECT, 'names a whole project and there is nothing here yet');
    return decide(KIND.IMPLEMENT, 'names a component to build inside the existing project');
  }

  // 4c. A PROBE TASK, BEFORE AUDIT — a runtime-investigation request, which is
  //     a different WORKSPACE, not just a different paragraph of guidance. The
  //     whole point of the Probe being a first-class environment is that
  //     "inspect this target" must not arrive as a generic request about the
  //     codebase and let the model search the source tree for a value that only
  //     exists in a live process. BEFORE AUDIT because the probe verbs overlap
  //     the audit ones — "inspect" reads as an assessment verb, but what is
  //     being inspected is a target (a process), which is not something the
  //     codebase audit covers. A genuine defect report about the codebase does
  //     not match the probe vocabulary, because nothing in it names a runtime
  //     value, a target or a probe stage.
  //     Advisory like every mode: with no Probe connected this still says PROBE,
  //     and the guidance the mode carries is the honest answer ("none is
  //     connected").
  if (require('./probetask').PROBE_TASK_RE.test(one)) {
    return decide(KIND.PROBE, 'runtime-investigation task: the live target owns it, not the codebase');
  }

  // 5. AUDIT before EXPLAIN: "review this project" is an assessment, and both
  //    are read-only so a wrong call between them is cheap.
  if (AUDIT_RE.test(one) || AUDIT_QUESTION_RE.test(one)) return decide(KIND.AUDIT, 'asks for an assessment');

  // 6. A DEFECT. "should X but Y" is unambiguous; otherwise a symptom word
  //    plus something concrete to attach it to.
  if (EXPECTATION_RE.test(one)) return decide(KIND.BUGFIX, 'states expected behaviour against actual');
  const symptom = SYMPTOM_RE.test(one) || BUG_NOUN_RE.test(one);
  if (symptom) {
    // VAGUE trouble is a different job: the cause is unknown, so the first move
    // is to narrow it down rather than to edit anything.
    if (VAGUE_RE.test(one) || NO_SUBJECT_RE.test(one)) {
      return decide(KIND.TROUBLESHOOT, 'reports a problem without saying where it is');
    }
    return decide(KIND.BUGFIX, 'reports a specific thing behaving wrongly');
  }

  // 7. VAGUE UNEASE with no symptom word at all — "the app is being weird",
  //    "it's acting up". There is a problem and no statement of what it is,
  //    which is the troubleshooting job even without a recognised symptom.
  if (VAGUE_RE.test(one)) return decide(KIND.TROUBLESHOOT, 'reports unease without a specific symptom');

  // 8. EXPLAIN — after defects, so "explain why it crashes" is a bug, not a
  //    lecture request.
  if (EXPLAIN_RE.test(one)) return decide(KIND.EXPLAIN, 'asks for an explanation');

  // 8b. LOCATING SOMETHING IS READING, NOT WRITING. After defects for the same
  //     reason EXPLAIN is — "find why it crashes" is a bug report — and before
  //     the change verbs, because "find the code that sets this" shares
  //     "find" with them and means the opposite.
  if (LOCATE_RE.test(one)) return decide(KIND.EXPLAIN, 'asks where something is, not for it to change');

  // 9. REFACTOR before IMPLEMENT — they share verbs, and only this one is
  //    about code that already works. See REFACTOR_RE.
  if (REFACTOR_RE.test(one)) return decide(KIND.REFACTOR, 'asks to restructure code that already works');

  // 9b. A MIGRATION — AFTER refactor and before implement.
  //
  //     AFTER REFACTOR because the two overlap on the words that describe
  //     MOVING code around inside one technology. "Extract the parser into its
  //     own file" and "split this module up" are restructuring: the language,
  //     the framework and the runtime are all exactly what they were, and the
  //     refactor guidance (pin the behaviour down, find every caller) is what
  //     that job needs. Tested first, they were being swallowed by the word
  //     "into".
  //
  //     BEFORE IMPLEMENT because that is where the damage is. Read as an
  //     implementation request, "migrate X to Y" becomes "add Y" — the model
  //     writes the new thing, leaves the old one running, and reports success
  //     truthfully about the half it describes. That is the exact failure the
  //     migration subsystem exists to prevent.
  //
  //     The test itself is deliberately narrow (a verb AND a direction — see
  //     migrationintent.js), so "move the button left" is not caught by it.
  if (require('./migrationintent').looksLikeMigration(one)) {
    return decide(KIND.MIGRATE, 'asks for a structural migration: the final state must not contain the old thing');
  }

  // 10. IMPLEMENT — an imperative to change the code.
  if (IMPLEMENT_RE.test(one)) return decide(KIND.IMPLEMENT, 'asks for a change to the code');

  // 9. A bare question with no imperative is a question.
  if (QUESTION_RE.test(one)) return decide(KIND.CHAT, 'a question with nothing to change');

  // 10. Default. Most bare statements in a coding CLI are work, and IMPLEMENT
  //     carries the "look before you leap" guidance — the safest default hint.
  return decide(KIND.IMPLEMENT, 'no clearer signal; treated as work to do');
}

/**
 * Does this text point at something concrete?
 *
 * A path, an identifier, a quoted string, a CamelCase or snake_case name, or a
 * capitalised product noun. This is what separates "the login button is stuck"
 * from "something is broken" — the first can be traced, the second must be
 * narrowed down first.
 */
function namesSomething(text) {
  const t = String(text || '');
  if (/[\w-]+\.(?:js|ts|tsx|jsx|py|go|rs|java|rb|cs|php|json|yml|yaml|html|css|sh|ps1)\b/i.test(t)) return true;
  if (/[/\\][\w.-]+/.test(t)) return true;                       // a path
  if (/`[^`]+`|"[^"]+"|'[^']+'/.test(t)) return true;            // a quoted thing
  if (/\b[a-z]+[A-Z]\w*\b/.test(t)) return true;                 // camelCase
  if (/\b\w+_\w+\b/.test(t)) return true;                        // snake_case
  if (/\b\w+\(\)/.test(t)) return true;                          // a call
  if (/\b[A-Z][a-z]+[A-Z]\w*\b/.test(t)) return true;            // PascalCase
  // A noun the user capitalised mid-sentence is usually a product or component.
  if (/\S\s+[A-Z][a-z]{2,}/.test(t)) return true;
  return false;
}

module.exports = { KIND, READ_ONLY, classify, namesSomething };
