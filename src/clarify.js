'use strict';

/**
 * ONE GOOD QUESTION IS CHEAPER THAN FORTY FILES.
 *
 * The behaviour this exists to encourage looks like a cost, and is a saving:
 *
 *     BAD    search 40 files → read 15 → implement → run → discover the
 *            assumption was wrong → rewrite
 *     GOOD   "Is selling a hold or a tap?" → build the right thing once
 *
 * A clarification is a TOKEN OPTIMISATION. It is not politeness, and it is not
 * the model being unsure of itself: it is refusing to spend a whole branch of
 * work on a coin-flip that a person can settle in four words.
 *
 * ------------------------------------------------------------------------
 * AND THE OPPOSITE FAILURE IS WORSE, which is why this file is mostly limits.
 * An agent that asks freely stops being an agent: every question is a stop, a
 * context switch and a wait, and a person who is asked six times learns to stop
 * reading the questions. So:
 *
 *   BOUNDED     `MAX_ROUNDS` clarifications per task. Then decide and say what
 *               you assumed.
 *   NEVER TWICE A question already asked cannot be asked again, however it is
 *               reworded — the answer is already in the task context, and
 *               asking again says nobody was listening.
 *   NEVER WHAT  A question whose answer is on disk is not a clarification, it
 *   IS KNOWABLE is an unwillingness to look. Those are refused by name.
 *   ALWAYS KEPT Every answer becomes a task decision, so it survives the turn,
 *               the compaction and `/resume`.
 *
 * MATERIALITY IS THE MODEL'S JUDGMENT, not this file's — nothing here can know
 * whether "hold or tap" changes the implementation. What this file can do is
 * make the budget small enough that the model has to spend it on something that
 * matters, and refuse the two cases that are never material.
 */

/** Clarifying questions one task may ask. Deliberately small. */
const MAX_ROUNDS = 3;

/**
 * QUESTIONS THAT ARE NOT CLARIFICATIONS.
 *
 * Each of these has an answer the machine can establish by looking, and asking
 * a person instead is the agent handing back the job it was given. Matched on
 * the question text, which is crude — and the failure mode of crude here is a
 * real question occasionally being refused, which the model can rephrase, as
 * against a person being asked what their own file contains.
 */
const KNOWABLE = [
  { re: /\bwhat (?:is|are) (?:in|inside) (?:the )?(?:file|folder|directory|repo)/i,
    why: 'read it' },
  { re: /\b(?:which|what) (?:file|files|function|class|module)s? (?:contains?|defines?|has|have)\b/i,
    why: 'search for it' },
  { re: /\b(?:do|does|did) the tests? pass\b/i, why: 'run them' },
  { re: /\bis (?:it|that|this) installed\b/i, why: 'check' },
  { re: /\bwhat (?:version|node version|python version)\b/i, why: 'check' },
];

/** Would inspection answer this? Returns the reason, or ''. */
function knowable(question) {
  const q = String(question || '');
  for (const k of KNOWABLE) if (k.re.test(q)) return k.why;
  return '';
}

/**
 * The comparable form of a question.
 *
 * Punctuation, case, filler and politeness removed, so "Is it a hold or a tap?"
 * and "should I hold LMB, or tap it" are recognised as one question. Not
 * clever, and does not need to be: it has to catch a model rewording its way
 * round the budget, not defeat an adversary.
 */
const FILLER = /\b(?:the|a|an|is|are|do|does|did|should|would|could|i|you|we|it|that|this|to|of|for|in|on|please|just|quick|question|clarif\w*)\b/g;
function normalise(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(FILLER, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ');
}

/**
 * How alike two normalised questions must be to count as the same one.
 *
 * Chosen against the case it exists for: "is selling a hold or a tap" and
 * "should I hold LMB, or tap it" strip to {hold, or, selling, tap} and
 * {hold, lmb, or, tap} — three shared of five, which is 0.6. Genuinely
 * different questions share almost nothing once the filler is gone, so the
 * gap either side of this number is wide.
 */
const SAME = 0.6;

/** Jaccard overlap of two space-separated, sorted token keys. */
function overlap(a, b) {
  const A = new Set(String(a).split(' ').filter(Boolean));
  const B = new Set(String(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * The clarification budget and history for ONE task.
 *
 * Held on the app, not on the turn: a budget that resets every turn is not a
 * budget, and the whole point is that a task may not spend six questions on
 * itself across six turns.
 */
class Clarifications {
  constructor({ maxRounds = MAX_ROUNDS } = {}) {
    this.maxRounds = Math.max(1, Math.min(10, Number(maxRounds) || MAX_ROUNDS));
    /** `[{ question, key, answer, at }]`, oldest first. */
    this.asked = [];
  }

  get spent() { return this.asked.length; }
  get remaining() { return Math.max(0, this.maxRounds - this.spent); }

  /** Has this question — or a rewording of it — already been answered? */
  previous(question) {
    const key = normalise(question);
    if (!key) return null;
    const exact = this.asked.find((a) => a.key === key);
    if (exact) return exact;
    // A REWORDING IS THE SAME QUESTION. Exact keys catch a model repeating
    // itself; they do not catch it asking "is selling a hold or a tap" and then
    // "should I hold LMB, or tap it", which is one question twice and is what a
    // model actually does. Overlap on the stripped tokens catches that, and
    // separates cleanly from genuinely different questions — which share almost
    // no content words once the filler is gone.
    return this.asked.find((a) => overlap(a.key, key) >= SAME) || null;
  }

  /**
   * May this be asked?
   *
   * @returns {{ok, why, previous}} — `why` is written for the MODEL to read,
   *   so it says what to do instead rather than only what was refused.
   */
  mayAsk(question) {
    const q = String(question || '').trim();
    if (!q) return { ok: false, why: 'a clarification needs a question', previous: null };

    const already = this.previous(q);
    if (already) {
      return {
        ok: false,
        previous: already,
        why: `you already asked this and they answered: "${already.answer}". `
          + 'Use that answer. Asking again tells the user nobody was listening.',
      };
    }
    const know = knowable(q);
    if (know) {
      return {
        ok: false, previous: null,
        why: `that is not a clarification — ${know}. `
          + 'Ask the user only about things they know and the machine cannot find out: '
          + 'intent, preference, and which of two readings of their words is right.',
      };
    }
    if (this.remaining <= 0) {
      return {
        ok: false, previous: null,
        why: `the clarification budget for this task is spent (${this.maxRounds} question(s)). `
          + 'Decide it yourself, state the assumption you made in your answer, and continue.',
      };
    }
    return { ok: true, why: '', previous: null };
  }

  /** Record the question and the answer. Returns the entry. */
  record(question, answer) {
    const entry = {
      question: String(question || '').trim(),
      key: normalise(question),
      answer: String(answer == null ? '' : answer).slice(0, 400),
      at: new Date().toISOString(),
    };
    this.asked.push(entry);
    return entry;
  }

  /** Everything settled so far, for the working context. */
  settled() { return this.asked.map((a) => ({ question: a.question, answer: a.answer })); }
}

/**
 * The task's clarifications, created on demand.
 *
 * `/new` and a genuinely new task clear it — see App. A resumed session keeps
 * it, because the answers are part of what was established.
 */
function forTask(app) {
  if (!app._clarify) app._clarify = new Clarifications();
  return app._clarify;
}

/**
 * KEEP THE ANSWER WHERE THE TASK KEEPS WHAT IT KNOWS.
 *
 * The plan's decision list already survives compaction, `/resume` and the turn
 * boundary, and is already carried into the working context. An answer put
 * anywhere else would have to be re-established, which is exactly the rework
 * the question was asked to avoid.
 */
function remember(app, question, answer) {
  const plan = app && app.session && app.session.plan;
  if (!plan || !Array.isArray(plan.decisions)) return false;
  plan.decisions.push({
    text: `${question} → ${answer}`.slice(0, 400),
    at: new Date().toISOString(),
    reason: 'user clarification',
  });
  return true;
}

module.exports = { Clarifications, forTask, remember, normalise, knowable, overlap, MAX_ROUNDS, SAME, KNOWABLE };
