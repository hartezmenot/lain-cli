'use strict';

/**
 * TASK LIFECYCLE + LIVENESS. One module, because they are one question asked
 * two ways: "is this task still going, and is anything actually moving?"
 *
 * V1 split them across `taskstate.js` (14 states), `tasklifecycle.js` (6),
 * `liveness.js`, `diagnostic.noProgress` and `App._shouldStopAutonomous`, then
 * fed them inconsistently — and one of them was never called from production at
 * all. Here there is exactly one, and turn.js hands it every turn.
 *
 * THE FOUR THINGS THAT ARE NOT COMPLETION
 *   - a turn with no tool calls in its LAST step   → the turn still did its work
 *   - narration ("continuing…", "I'll now…")       → words are not evidence
 *   - the same tool call repeated                   → motion is not progress
 *   - the model saying "Done."                      → a claim, not a result
 *
 * THE TWO THINGS THAT ARE NOT A NEW TASK
 *   - "continue"
 *   - restating the same objective
 *   (both decided in task.js — this module consumes that verdict)
 *
 * Liveness observes the WHOLE turn. Repetition is detected across interleaving:
 * read A, read B, read A, read C, read A is three identical A-reads, and
 * consecutive-only counting would score it as zero. It is a fingerprint COUNT
 * over the task, not a streak.
 *
 * And it is never a jail. Repetition is REPORTED, to the person, and that is
 * the end of this module's involvement: nothing here writes to the
 * conversation, forces a tool, forbids a tool, dictates an order, or stops a
 * turn because motion stopped looking like progress. Who gets told and what
 * they can do about it is looping.js.
 */

const crypto = require('crypto');

/** First-person, future-tense statements of outstanding work. See saysMoreToDo. */
const MORE_TO_DO = [
  /\bI (?:still |now )?(?:need|have) to\b/i,
  /\bI(?:'ll| will| am going to| shall) (?:now |then |next )?(?:run|check|verify|test|inspect|investigate|look|continue|fix|add)\b/i,
  /\bstill (?:needs?|has|have|to be) (?:to )?(?:be )?(?:verif|test|check|run|investigat|fix|done|confirm)/i,
  /\b(?:not|yet to be) (?:yet )?(?:verified|tested|confirmed|checked)\b/i,
  /\blet me (?:now |then )?(?:run|check|verify|test|inspect|look)\b/i,
  /\bnext,? I(?:.ll| will)?\b/i,
];

/**
 * THE MODEL ASKING THE PERSON TO DO SOMETHING. See asksUserToAct.
 *
 * Deliberately narrow. These are requests that cannot be read as anything else:
 * an instruction to act addressed to the reader, or an explicit request to be
 * told when something has happened. "Press the button" inside a description of
 * what some code does would be a false positive, so a bare imperative is not
 * enough - it needs "now", "then", "please", or a report-back clause.
 */
const ASKS_USER = [
  /\b(?:now|then|next|please|first)[, ]+(?:go (?:and )?)?(?:press|click|tap|hit|open|close|launch|start|type|enter|move|select|switch|change)\b/i,
  /\b(?:let me know|tell me|report back|say)\s+(?:when|once|after|what)\b/i,
  /\bonce you(?:'ve| have)?\s+(?:done|pressed|clicked|opened|changed|typed)\b/i,
  /\bcan you (?:please )?(?:press|click|open|type|run|check|confirm|tell)\b/i,
];

const STATE = Object.freeze({
  ACTIVE: 'ACTIVE',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED',
  NEEDS_USER: 'NEEDS_USER',
  NEEDS_AUTH: 'NEEDS_AUTH',
  FAILED: 'FAILED',
});

const TERMINAL = new Set([STATE.DONE, STATE.BLOCKED, STATE.NEEDS_USER, STATE.NEEDS_AUTH, STATE.FAILED]);

/**
 * How many unproductive TURNS — narration, no tools, nothing changed — before
 * the task is BLOCKED.
 *
 * THE THRESHOLD FOR REPEATED TOOL CALLS USED TO LIVE HERE TOO, and no longer
 * does. It gated a message written into the conversation as `role: 'user'` and,
 * past this same budget, a forced BLOCKED state — LAIN correcting the model in
 * the person's voice and then stopping it. The observation was never the
 * problem; addressing it to the model was. Repetition is now reported to the
 * PERSON as an advisory and the model is left alone, so the threshold for
 * mentioning it belongs with the thing that mentions it: looping.SAY_AT.
 */
const NUDGE_BUDGET = 2;

/**
 * A PRINTABLE separator, deliberately.
 *
 * A literal NUL byte in source makes the whole file report as BINARY to grep,
 * to the `file` command, and to every text tool that inspects it. V1 shipped
 * exactly that in src/tools.js — used as a join separator — and carried a
 * one-shot repair script for it that was never run. This sequence cannot appear
 * in a tool name, so it does the same job in plain ASCII.
 */
const FP_SEP = '|#|';

function fingerprint(name, input, output) {
  const h = crypto.createHash('sha1');
  h.update(String(name));
  h.update(FP_SEP);
  h.update(JSON.stringify(input || {}));
  h.update(FP_SEP);
  h.update(String(output == null ? '' : output).slice(0, 4000));
  return h.digest('hex').slice(0, 16);
}

/** Text that only ANNOUNCES work. Used only alongside a zero-work turn. */
// The adverb slot matters: "I'll now continue" is plainly narration, and without
// it the pattern only matched when the verb followed the pronoun immediately.
const NARRATION_RE = /^\W*(ok(ay)?|right|alright|sure|now|so)?[\s,.:-]*(let me |i'?ll |i am |i'?m |going to |about to |we'?ll )?(now |then |just |also |next |quickly |first |go ahead and )*(continu\w*|resum\w*|pick(ing|ed)? up|proceed\w*|start\w*|look\w*|check\w*|inspect\w*|investigat\w*|trac\w*|dig\w*|gather\w*|work\w* on)\b/i;
const FINDING_RE = /\b(found|because|caused|returns?|fails?|error|missing|null|undefined|line \d+|is set to|root cause|fixed|passes|verified|reproduc)\b/i;

function isNarrationOnly(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 400) return false;
  if (!NARRATION_RE.test(t)) return false;
  return !FINDING_RE.test(t);
}

/**
 * Text that CLAIMS THE WORK SUCCEEDED.
 *
 * Not "the model finished talking" and not "the model sounded pleased" — the
 * specific shapes of a success report, which is what has to be checked against
 * what actually happened. Negations are excluded, because "the tests do not
 * pass" is the opposite claim made of the same words.
 */
const SUCCESS_RE = /\b(all (?:the )?tests? (?:now )?pass|tests? (?:are )?passing|tests? affirm|suite is green|successful(?:ly)? (?:implement|complet|fix|updat|appli)|implementation (?:is )?(?:complete|successful)|everything (?:now )?works?|works? (?:correctly|as expected)|(?:is|are) now (?:working|fixed|complete)|verified (?:that )?(?:it|this) works|done[.!]?$)/i;
const NEGATED_RE = /\b(?:do(?:es)?n'?t|do not|does not|not all|fail(?:s|ed|ing)|still (?:broken|failing|red)|cannot|can'?t|unable)\b/i;

function claimsSuccess(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Judge the CLOSING statement. A trace that mentions a passing test halfway
  // through and then reports a failure is not claiming success.
  const tail = t.slice(-600);
  if (!SUCCESS_RE.test(tail)) return false;
  return !NEGATED_RE.test(tail);
}

class Lifecycle {
  constructor(objective = '') {
    this.objective = String(objective);
    this.state = STATE.ACTIVE;
    this.reason = '';
    this.seen = new Map();      // fingerprint -> count (task-scoped, interleaving-safe)
    this.quiet = new Set();     // fingerprints the user said "let it run" about
    this.nudges = 0;
    this.evidence = {
      filesChanged: new Set(),
      commandsRun: 0,
      toolCalls: 0,
      verifiedChecks: 0,
      userConfirmed: false,
    };
    /**
     * The most recent command this task ran, and whether it succeeded:
     * `{ command, ok, exitCode }` or null.
     *
     * This is the difference between "a command ran" and "the check passed".
     * Completion evidence counted only the former, so a task that edited a file
     * and left the test suite RED satisfied it — the changed file was the
     * evidence, and the failing run was not consulted. That is precisely the
     * "failed work must not falsely complete" case.
     */
    this.lastCommand = null;
    this.blockers = [];
    this.turns = 0;
  }

  get isActive() { return this.state === STATE.ACTIVE; }
  get isTerminal() { return TERMINAL.has(this.state); }

  /** The user pushed back / rephrased / steered. That is new information. */
  noteUserInput() {
    this.nudges = 0;
    this.seen.clear();                 // a correction earns an un-prejudiced start
    // AND SO DOES THE ADVISORY. "Let it run" was said about a loop that has
    // just been steered; if the same call still repeats after a correction that
    // is news, and silence would be LAIN holding the user to a decision they
    // made about a different situation.
    this.quiet.clear();
    if (this.state === STATE.BLOCKED || this.state === STATE.NEEDS_USER) {
      this.state = STATE.ACTIVE;
      this.reason = '';
    }
    return this;
  }

  /** Context was compacted. Explicitly not a new task and not progress. */
  noteCompaction() { return this; }

  /**
   * Observe ONE completed tool call.
   *
   * IT OBSERVES. It does not intervene, it does not write to the conversation
   * and it cannot stop the turn — the caller gets the count and the identity of
   * what is repeating, and decides who to tell. See looping.js.
   *
   * @returns {{repeated:number, key:string, isError:boolean}}
   */
  observeTool({ name, input, output, isError = false, mutated = [], exitCode = null }) {
    this.evidence.toolCalls += 1;
    if (/^run_/.test(name)) {
      this.evidence.commandsRun += 1;
      // Recorded per command, so the LAST one is always the current verdict. A
      // failing test run followed by a fix and a passing run leaves `ok: true`,
      // which is exactly right — the point is the state the task ends in, not
      // whether anything ever failed along the way.
      this.lastCommand = {
        command: String((input && input.command) || name).replace(/\s+/g, ' ').slice(0, 120),
        ok: !isError,
        exitCode: exitCode == null ? null : Number(exitCode),
      };
      // A command that ran clean AFTER something was changed is the shape of a
      // verification. Named conservatively: it is evidence a check passed, not
      // a claim about what the check tested.
      if (!isError && this.evidence.filesChanged.size > 0) this.evidence.verifiedChecks += 1;
    }
    for (const m of mutated) this.evidence.filesChanged.add(m);

    const fp = fingerprint(name, input, output);
    const n = (this.seen.get(fp) || 0) + 1;
    this.seen.set(fp, n);

    // A MUTATION IS PROGRESS BY DEFINITION — something on disk is different now
    // — and it also clears the narration ladder `observeTurn` keeps.
    //
    // IT IS ALSO REPORTED AS UNREPEATED even when the same command ran before,
    // because a call that changes the world is not the same event twice: `npm
    // install` run identically in two places did two different things. Without
    // this a build step that mutates would be flagged as a loop.
    if (mutated.length) { this.nudges = 0; return { repeated: 1, key: fp, isError: Boolean(isError) }; }
    // `repeated` COUNTS OCCURRENCES: 1 is the first sighting, 3 means three
    // identical results. The count the user is shown is this number.
    return { repeated: n, key: fp, isError: Boolean(isError) };
  }

  /**
   * "LET IT RUN" — the user has seen this exact loop and waved it through.
   *
   * Held HERE because a task is the natural life of the decision: it is about
   * this call returning this output during this piece of work, and a new task
   * gets a new Lifecycle and an un-prejudiced start, exactly as a correction
   * does through `noteUserInput`. Nothing else reads it; looping.js asks.
   */
  letRun(key) {
    if (key) this.quiet.add(String(key));
    return this;
  }

  /**
   * Observe a whole finished TURN.
   * `toolCalls` MUST be the turn-wide total, not the final step's.
   */
  observeTurn({ toolCalls = 0, text = '', mutated = 0 } = {}) {
    this.turns += 1;
    // Any tool work at all means the turn was productive. A closing sentence is
    // how a working turn ENDS — this is the V1 miscount, fixed at the source.
    if (toolCalls > 0 || mutated > 0) { this.nudges = 0; return { productive: true }; }
    if (isNarrationOnly(text)) {
      this.nudges += 1;
      // ---- COUNTED, AND THAT IS ALL IT IS ----------------------------------
      //
      // THIS USED TO DECLARE THE TASK BLOCKED. Three turns that announced work
      // without doing any, and the lifecycle moved to a TERMINAL state with the
      // reason "repeated narration with no action" — LAIN concluding that the
      // model had failed, on the strength of a counter reaching three.
      //
      // It was the last thing in the program with that shape. An accounting
      // threshold is not evidence about intent: a model may narrate three times
      // because it is stuck, or because it is thinking aloud through something
      // genuinely hard, or because a user asked three questions that wanted
      // prose rather than tools. Nothing here can tell those apart, and the
      // state it was writing — BLOCKED, which is TERMINAL — reads to every
      // surface as "this task is over and it went badly".
      //
      // The COUNT stays. It is real accounting, it feeds diagnostics and the
      // investigation packet, and `narrationOnly` is returned so a caller that
      // wants to say something to the PERSON can. What is gone is its authority
      // to end a task on LAIN's opinion of how the model is working.
      return { productive: false, narrationOnly: true, narrations: this.nudges };
    }
    // Substantive prose with no tools is legitimate: answering a question,
    // explaining a design. Not progress on files, not a stall either.
    return { productive: false };
  }

  /**
   * DOES THE MODEL'S CLOSING CLAIM MATCH THE EVIDENCE?
   *
   * `complete()` already refuses to finish a task whose last check failed — but
   * it is only consulted when a plan runs out of steps. Observed against a real
   * provider: a turn ended with "Successful implementation. The tests affirm
   * success" while `node test/run.js` was failing on a syntax error, the plan
   * still had a step open, and so nothing was said. LAIN's own state was right
   * and the last thing on the user's screen was wrong.
   *
   * This is that same evidence, asked at the end of every turn instead of only
   * at the end of a plan. Deterministic and free — it compares a string against
   * a command exit code, and makes no request of anything.
   *
   * It contradicts the CLAIM, never the work: a turn that says nothing about
   * success gets nothing said back.
   *
   * @returns {string|null} what to tell the user, or null when they agree
   */
  contradiction(text) {
    const last = this.lastCommand;
    if (!last || last.ok) return null;
    if (!claimsSuccess(text)) return null;
    return `The last check was still failing when that was written: ${last.command}`
      + `${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}. Run it again before treating this as done.`;
  }

  noteAuthFailure(provider, detail = '') {
    this.state = STATE.NEEDS_AUTH;
    this.reason = `authentication failed for ${provider}${detail ? ': ' + detail : ''}`;
    this.blockers.push(this.reason);
    return this;
  }

  needsUser(question) {
    this.state = STATE.NEEDS_USER;
    this.reason = String(question || 'this needs a decision from you');
    return this;
  }

  /**
   * DOES THE MODEL SAY IT STILL HAS WORK?
   *
   * The other half of "plan 100% is not task complete": the model routinely
   * ticks its last step and says, in the same breath, that it still has to run
   * the tests. Believing the checklist over the sentence is how a task stops
   * one step before the only step that would have proved it.
   *
   * Deliberately narrow. It matches FIRST-PERSON, FUTURE work only — "I still
   * need to", "I'll run", "let me check" — so a closing "Next steps for you:"
   * (advice to the user, not outstanding work) does not hold a finished task
   * open forever. A false positive here costs an extra turn; a false negative
   * costs the verification.
   */
  static saysMoreToDo(text) {
    const t = String(text || '');
    return MORE_TO_DO.some((re) => re.test(t));
  }

  /**
   * IS THE MODEL ASKING THE PERSON TO DO SOMETHING?
   *
   * The counterpart of saysMoreToDo. BOTH CLASSIFY AN ENDING; NEITHER CAUSES
   * ONE. This said "decides whether LAIN carries on by itself or stops and
   * waits", and LAIN no longer carries on by itself at all — a comment still
   * claiming it does is how a removed mechanism gets quietly rebuilt.
   *
   *     saysMoreToDo    "I'll run the tests next"    -> the task stays ACTIVE
   *     asksUserToAct   "Now press 2 and narrow"     -> lifecycle is NEEDS_USER
   *
   * What differs is what the STATUS says and what the user's next message
   * continues. In neither case does LAIN start a turn.
   *
   * The second was invisible. A real Probe investigation ended on exactly that
   * sentence - the model asking the user to press a key so the next reading
   * would change - and because it was neither a tool call nor a first-person
   * plan, the turn simply ended and the strip said DONE over an investigation
   * that was waiting for a human. Continuing there would be worse than
   * stopping: LAIN would be answering a question addressed to somebody else.
   */
  static asksUserToAct(text) {
    const t = String(text || '');
    return ASKS_USER.some((re) => re.test(t));
  }

  fail(why) { this.state = STATE.FAILED; this.reason = String(why || 'failed'); return this; }

  /**
   * COMPLETION REQUIRES EVIDENCE, AND A CHANGE REQUIRES A CHECK.
   *
   * Three gates, in order of how badly getting them wrong hurts:
   *
   *   1. SOMETHING HAPPENED. A changed file, a command, a verified check, or
   *      the user confirming an external action. "Done." on its own completes
   *      nothing.
   *   2. IT IS NOT CURRENTLY FAILING. The last command the task ran is its own
   *      verdict on itself and outranks a finished checklist.
   *   3. WHAT CHANGED WAS CHECKED. Files were written and nothing was run
   *      afterwards is an unverified change, not a finished task.
   *
   * A task that legitimately needed no change can still complete on a passing
   * run alone, and `userConfirmed` overrules gates 2 and 3 — the user is allowed
   * to say a failure is expected, or that no check is needed.
   *
   * NOTE WHAT IS NOT HERE: the plan. A finished plan is not an input to this
   * decision at all. `plan.isFinished` only decides when it is worth ASKING.
   */
  complete({ verified = false, userConfirmed = false, note = '' } = {}) {
    if (verified) this.evidence.verifiedChecks += 1;
    if (userConfirmed) this.evidence.userConfirmed = true;
    const e = this.evidence;
    const has = e.filesChanged.size > 0 || e.commandsRun > 0 || e.verifiedChecks > 0 || e.userConfirmed;
    if (!has) {
      return { ok: false, state: this.state, why: 'no completion evidence: nothing changed, no command ran, nothing verified' };
    }
    // A RED CHECK IS NOT A FINISHED TASK.
    //
    // Evidence answers "did anything happen"; it does not answer "did it work".
    // Without this, a task that edited a file and left the suite failing
    // completed on the strength of the edit alone — the changed file counted and
    // the failing run did not. The last command the task ran is its own verdict
    // on itself, and it overrules a finished checklist.
    //
    // The escape is to run something that passes, which is the behaviour we
    // wanted anyway. `userConfirmed` still overrides, because the user is
    // allowed to say "yes, I know, that failure is expected".
    const last = this.lastCommand;
    if (last && !last.ok && !e.userConfirmed) {
      return {
        ok: false,
        state: this.state,
        why: `the last command failed${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}: ${last.command}`,
        failedCheck: last,
      };
    }
    // AN UNVERIFIED CHANGE IS NOT A FINISHED TASK.
    //
    // This is the clause that made a finished PLAN finish the TASK. The test
    // above is `filesChanged || commandsRun || …` — "did anything happen at
    // all" — so the moment the last step was ticked off, a task that had
    // written a file and run NOTHING was declared complete. Every step done and
    // not one thing checked is precisely the state where the work most needs to
    // carry on, and LAIN was calling it finished.
    //
    // A change has to be followed by something that RAN and passed. That is
    // what `verifiedChecks` counts (see observeTool: a clean command after a
    // change). A task that changed nothing is unaffected — "does the suite
    // pass?" still completes on the passing run alone — and `userConfirmed`
    // still overrules, because the user may say the check is not needed.
    if (e.filesChanged.size > 0 && e.verifiedChecks === 0 && !e.userConfirmed) {
      return {
        ok: false,
        state: this.state,
        why: `${e.filesChanged.size} file(s) changed but nothing has been run to check them`,
        unverified: true,
      };
    }
    this.state = STATE.DONE;
    this.reason = note || `${e.filesChanged.size} file(s) changed, ${e.commandsRun} command(s) run`
      + (last && last.ok ? `, last check passed: ${last.command}` : '');
    return { ok: true, state: this.state, why: this.reason };
  }

  summary() {
    return {
      state: this.state,
      reason: this.reason,
      objective: this.objective,
      turns: this.turns,
      toolCalls: this.evidence.toolCalls,
      filesChanged: this.evidence.filesChanged.size,
      commandsRun: this.evidence.commandsRun,
      repeatedObservations: [...this.seen.values()].filter((n) => n > 1).length,
      nudges: this.nudges,
      lastCommand: this.lastCommand,
    };
  }

  toJSON() {
    return {
      objective: this.objective, state: this.state, reason: this.reason,
      nudges: this.nudges, turns: this.turns, blockers: this.blockers,
      lastCommand: this.lastCommand,
      evidence: { ...this.evidence, filesChanged: [...this.evidence.filesChanged] },
    };
  }

  static from(data) {
    if (!data || typeof data !== 'object') return null;
    const l = new Lifecycle(data.objective);
    l.state = data.state || STATE.ACTIVE;
    l.reason = data.reason || '';
    l.nudges = data.nudges || 0;
    l.turns = data.turns || 0;
    l.blockers = Array.isArray(data.blockers) ? data.blockers : [];
    // Restored so a resumed task cannot complete on the strength of a check
    // that was still failing when the session ended.
    l.lastCommand = data.lastCommand && typeof data.lastCommand === 'object' ? data.lastCommand : null;
    const e = data.evidence || {};
    l.evidence = {
      filesChanged: new Set(e.filesChanged || []),
      commandsRun: e.commandsRun || 0,
      toolCalls: e.toolCalls || 0,
      verifiedChecks: e.verifiedChecks || 0,
      userConfirmed: Boolean(e.userConfirmed),
    };
    return l;
  }
}

module.exports = { STATE, TERMINAL, Lifecycle, fingerprint, isNarrationOnly, claimsSuccess, NUDGE_BUDGET };
