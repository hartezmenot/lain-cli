'use strict';

/**
 * WHEN A MACHINE CANNOT JUDGE, ASK THE PERSON — ONCE, WITH OPTIONS, AND STOP.
 *
 * The failure this exists to prevent is not a bug. It is a model doing exactly
 * what it was asked, forever:
 *
 *     change the contrast → capture → describe the image in 900 tokens
 *     → change the contrast → capture → describe the image in 900 tokens → …
 *
 * A model cannot see. It can read OCR text, pixel statistics, a DOM node, an
 * HTTP status — and from those it can know a great deal — but "is the indicator
 * legible against that background" is not a question it can answer, and no
 * number of attempts converges on an answer it cannot evaluate. Left alone it
 * will spend a whole budget discovering that.
 *
 * So the shape is fixed, and it is short:
 *
 *     OBSERVE            candidates are generated ALGORITHMICALLY, not reasoned
 *                        out one parameter at a time
 *     PRESENT            up to four, side by side, each with one line of
 *                        MACHINE evidence — a number, not an impression
 *     HUMAN JUDGMENT     the person picks, and may say what is wrong with it
 *     APPLY              the chosen parameters are kept
 *     VERIFY ONCE        and the round ends
 *
 * BOUNDED, AND THE BOUND IS THE POINT. `MAX_ROUNDS` rounds per task. When they
 * are spent the answer is not "keep going"; it is STOP AND ASK, with what was
 * learned attached. A workflow that can run twice is a workflow; one that can
 * run indefinitely is the loop it was built to replace.
 *
 * ------------------------------------------------------------------------
 * THREE KINDS OF EVIDENCE, and the third is new.
 *
 *   MACHINE   something was READ — OCR confidence, a pixel histogram, a DOM
 *             rectangle, a test result. inspection.js owns this.
 *   VISUAL    something was SEEN by a capture — a screenshot exists.
 *   HUMAN     someone LOOKED and JUDGED — "the indicator is visible", "the
 *             enemy blends into the background", "B, but darker".
 *
 * A screenshot existing is not a person having looked at it. That distinction
 * is the whole warrant behind "visually verified", and this file is where the
 * third kind gets recorded so the claim can finally be earned rather than
 * asserted. Nothing here captures a screen, opens a window, or decides that
 * something looks right.
 */

/** Rounds of human judgment one task may spend. Small on purpose. */
const MAX_ROUNDS = 3;
/** Candidates shown at once. Four fits a screen and a keyboard row. */
const MAX_CANDIDATES = 4;

/**
 * How many DIFFERENT ENVIRONMENTS one inspection may look at —.
 *
 * A new scene earns a fresh round budget, because tuning a dungeon and tuning
 * a different dungeon are different questions. This is the bound on that: with
 * no cap, "the environment changed" is simply a way to buy three more rounds
 * for ever, which is the unbounded loop wearing its own fix as a costume.
 */
const MAX_EPISODES = 4;
/** Letters, in the order the compact MCQ uses them. */
const LETTERS = ['A', 'B', 'C', 'D'];

/** How a round ended. `PENDING` is the only one that is not final. */
const ROUND = Object.freeze({
  PENDING: 'PENDING',
  CHOSEN: 'CHOSEN',
  REJECTED: 'REJECTED',
  ABANDONED: 'ABANDONED',
});

/** The verdict a finished workflow carries. */
const VERDICT = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  NEEDS_ADJUSTMENT: 'NEEDS_ADJUSTMENT',
  BUDGET_SPENT: 'BUDGET_SPENT',
  NOT_INSPECTED: 'NOT_INSPECTED',
});

/**
 * One candidate put in front of a person.
 *
 * `machine` is REQUIRED and must be a fact, not an opinion: a confidence, a
 * count, a measurement. It is what stops the presentation from being four
 * pictures and a model's guesses about them — the person is being asked for the
 * judgment the machine cannot make, and giving them the machine's guess at that
 * same judgment is how the answer gets anchored to it.
 */
function candidate({ id, label, params = {}, image = null, machine = '' }) {
  const name = String(label || id || '').trim();
  if (!name) throw new Error('a candidate needs a label — the person has to tell them apart');
  if (!String(machine || '').trim()) {
    throw new Error(`candidate "${name}" has no machine evidence — a picture with an opinion attached is not a candidate`);
  }
  return {
    id: String(id || name),
    label: name,
    params: params && typeof params === 'object' ? { ...params } : {},
    image: image ? String(image) : null,
    machine: String(machine).trim().slice(0, 200),
  };
}

/**
 * A HUMAN'S ANSWER, kept as structure rather than as a sentence.
 *
 * "C is too harsh, B is better, the indicator is visible but the enemies blend
 * in" is three facts and a preference. Kept as prose it is a paragraph the
 * model re-reads and re-interprets on every subsequent turn; kept as fields it
 * is a constraint that later rounds can be checked against.
 */
function decision({ chose = null, accepted = false, notes = '', observations = {} } = {}) {
  return {
    chose: chose == null ? null : String(chose),
    accepted: Boolean(accepted),
    notes: String(notes || '').slice(0, 400),
    // Free-form on purpose: "indicator_visible", "enemy_contrast",
    // "button_position" are the caller's vocabulary, not this file's.
    observations: observations && typeof observations === 'object' ? { ...observations } : {},
    at: new Date().toISOString(),
  };
}

/**
 * A bounded visual inspection for one task.
 *
 * Holds the rounds, the budget and the accumulated human constraints. It does
 * not render anything and does not talk to a bridge: `visualwindow.js` shows a
 * round, the ordinary ask_user panel takes the answer, and this records what
 * happened and says whether another round is allowed.
 */
class VisualInspection {
  constructor(question, { maxRounds = MAX_ROUNDS } = {}) {
    this.question = String(question || '').trim();
    this.maxRounds = Math.max(1, Math.min(10, Number(maxRounds) || MAX_ROUNDS));
    /** `[{ candidates, decision, state }]` — oldest first. */
    this.rounds = [];
    /** Everything the person has told us, merged. See `constraints`. */
    this._constraints = {};
    /**
     * WHAT IS BEING LOOKED AT —.
     *
     * A budget spent tuning contrast in one dungeon must not refuse to look at
     * a different dungeon, and re-running the whole optimisation because the
     * lighting changed is the loop this file exists to prevent. So a round
     * names its SCENE, and a genuinely different scene starts a new bounded
     * episode instead of exhausting the old one.
     *
     * LAIN DOES NOT GUESS THAT THE SCENE CHANGED. The caller states what it is
     * looking at; inferring it from pixels would be the model judging its own
     * visual interpretation, which is the thing human judgment is for.
     */
    this.scene = null;
    this.episodes = 0;
  }

  /**
   * The environment changed — begin a bounded re-observation.
   *
   * The constraints are KEPT: "the indicator must stay visible" is still true
   * in the new dungeon, and making the person say it again is the cost this
   * whole workflow exists to avoid. What resets is the budget, because the
   * question is now a different one.
   *
   * @returns {boolean} true when this really is a new scene.
   */
  enter(scene) {
    const next = String(scene || '').trim();
    if (!next || next === this.scene) return false;
    const first = this.scene === null;
    this.scene = next;
    this.episodes += 1;
    if (first) return false;
    // Past rounds stay in the record — they are what happened — but they no
    // longer count against a budget that is answering a different question.
    for (const r of this.rounds) r.episode = r.episode || this.episodes - 1;
    this._closed = this.rounds.length;
    return true;
  }

  /** Rounds spent on the CURRENT scene. A new scene is a new bounded episode. */
  get spentHere() {
    return this.rounds.slice(this._closed || 0).filter((r) => r.state !== ROUND.PENDING).length;
  }

  get spent() { return this.rounds.filter((r) => r.state !== ROUND.PENDING).length; }
  /** Rounds left FOR THIS SCENE. See `enter` — a new environment is a new question. */
  get remaining() { return Math.max(0, this.maxRounds - this.spentHere); }
  get pending() { return this.rounds.find((r) => r.state === ROUND.PENDING) || null; }

  /** Is another round allowed, and if not, why not. */
  mayAsk() {
    if (this.pending) return { ok: false, why: 'a round is already waiting for an answer' };
    // THE ESCAPE HATCH IS ALSO BOUNDED. Without this, "the environment changed"
    // becomes a way to buy another three rounds indefinitely — the same
    // unbounded loop, wearing the fix as a costume.
    if (this.episodes > MAX_EPISODES) {
      return { ok: false, why: `${MAX_EPISODES} environments have been inspected — stop and ask, this is not converging` };
    }
    if (this.remaining <= 0) {
      return { ok: false, why: `the inspection budget is spent (${this.maxRounds} round(s)) — stop and ask, do not keep adjusting` };
    }
    return { ok: true, why: '' };
  }

  /**
   * Put a set of candidates in front of the person.
   *
   * Refuses rather than truncates when there are too many: five candidates is a
   * sign the caller is exploring a parameter space one value at a time, which
   * is the behaviour the budget exists to stop.
   */
  ask(candidates) {
    const may = this.mayAsk();
    if (!may.ok) throw new Error(may.why);
    const list = Array.isArray(candidates) ? candidates : [];
    if (list.length < 2) throw new Error('a choice needs at least two candidates');
    if (list.length > MAX_CANDIDATES) {
      throw new Error(`${list.length} candidates is not a choice, it is a parameter sweep — show at most ${MAX_CANDIDATES}`);
    }
    const round = {
      n: this.rounds.length + 1,
      candidates: list.map((c, i) => ({ ...c, letter: LETTERS[i] })),
      decision: null,
      state: ROUND.PENDING,
    };
    this.rounds.push(round);
    return round;
  }

  /**
   * Record what the person said.
   *
   * A decision naming no candidate is a REJECTION, not a failure: "none of
   * these" is a real and useful answer, and the notes attached to it are worth
   * more than the four candidates were.
   */
  answer(d) {
    const round = this.pending;
    if (!round) throw new Error('no round is waiting for an answer');
    const dec = d && d.at ? d : decision(d || {});
    const known = round.candidates.find((c) => c.letter === dec.chose || c.id === dec.chose);
    round.decision = { ...dec, chose: known ? known.id : null, letter: known ? known.letter : null };
    round.state = known ? ROUND.CHOSEN : ROUND.REJECTED;
    // A REJECTION'S FACTS ARE THE MOST VALUABLE ONES, and they were thrown
    // away: "none of these, and the background is too bright" told us more than
    // any of the four candidates did, and the next round is built from exactly
    // that. Merged whether or not a candidate was chosen.
    if (dec.observations) Object.assign(this._constraints, dec.observations);
    if (known) round.chosen = known;
    return round;
  }

  /** The round was never answered — the task moved on, or was interrupted. */
  abandon(why = 'the task moved on') {
    const round = this.pending;
    if (!round) return null;
    round.state = ROUND.ABANDONED;
    round.decision = decision({ notes: String(why) });
    return round;
  }

  /**
   * WHAT THE PERSON HAS ESTABLISHED, merged across rounds.
   *
   * This is the point of keeping decisions as structure: a later round is
   * checked against it, and a model that would otherwise re-derive the
   * preference from a transcript is handed it as data.
   */
  constraints() { return { ...this._constraints }; }

  /** The chosen candidate of the most recent decided round, or null. */
  chosen() {
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      if (this.rounds[i].state === ROUND.CHOSEN) return this.rounds[i].chosen;
    }
    return null;
  }

  /**
   * WHERE THIS ENDED, and what may be claimed about it.
   *
   * `ACCEPTED` is the ONLY state in which anything may be called visually
   * verified, and it requires a person to have said so. A chosen candidate is
   * not acceptance: picking the best of four bad options is choosing, and
   * saying it looks right is a different sentence.
   */
  conclusion() {
    if (!this.rounds.length) {
      return { verdict: VERDICT.NOT_INSPECTED, human: false, text: 'NOT VISUALLY INSPECTED — nobody was shown anything' };
    }
    const last = this.rounds[this.rounds.length - 1];
    if (last.state === ROUND.PENDING) {
      return { verdict: VERDICT.NOT_INSPECTED, human: false, text: 'NEEDS USER ACTION — a round is waiting for an answer' };
    }
    const accepted = this.rounds.some((r) => r.decision && r.decision.accepted);
    if (accepted) {
      const c = this.chosen();
      return {
        verdict: VERDICT.ACCEPTED, human: true,
        text: `a person looked and accepted${c ? ` "${c.label}"` : ''} after ${this.spent} round(s)`,
      };
    }
    if (this.remaining <= 0) {
      return {
        verdict: VERDICT.BUDGET_SPENT, human: true,
        text: `${this.spent} round(s) of human judgment did not settle it — STOP AND ASK rather than adjusting again`,
      };
    }
    const c = this.chosen();
    return {
      verdict: VERDICT.NEEDS_ADJUSTMENT, human: true,
      text: c
        ? `a person chose "${c.label}" but did not call it right — NOT VISUALLY VERIFIED`
        : 'a person rejected every candidate — NOT VISUALLY VERIFIED',
    };
  }

  /**
   * The record, for the inspection report and for the session.
   *
   * MACHINE and HUMAN evidence side by side and never merged, because the whole
   * reason for this file is that they are different warrants.
   */
  report() {
    const c = this.chosen();
    const lines = [];
    for (const r of this.rounds) {
      lines.push(`ROUND ${r.n} — ${r.state}`);
      for (const cand of r.candidates) {
        const mark = r.chosen && r.chosen.id === cand.id ? '→' : ' ';
        lines.push(`  ${mark} [${cand.letter}] ${cand.label}`);
        lines.push(`      MACHINE: ${cand.machine}`);
      }
      if (r.decision && r.decision.notes) lines.push(`      HUMAN: ${r.decision.notes}`);
    }
    const con = this.conclusion();
    return {
      question: this.question,
      rounds: this.rounds.length,
      remaining: this.remaining,
      chosen: c ? { id: c.id, label: c.label, params: c.params } : null,
      constraints: this.constraints(),
      verdict: con.verdict,
      text: `${lines.join('\n')}\nVERDICT: ${con.text}`,
    };
  }
}

module.exports = {
  MAX_EPISODES,
  VisualInspection, candidate, decision,
  ROUND, VERDICT, MAX_ROUNDS, MAX_CANDIDATES, LETTERS,
};
