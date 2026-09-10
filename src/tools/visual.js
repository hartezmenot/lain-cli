'use strict';

/**
 * visual_choice — the one way a model may ask a person to LOOK at something.
 *
 *     model → this tool → visual window (four candidates, real pixels)
 *                       → LAIN's ordinary MCQ (the answer)
 *                       → structured decision back to the model
 *
 * It exists so that "which of these looks right" costs ONE round trip instead
 * of a hundred. A model cannot see; asked to tune a threshold by looking at
 * screenshots it will describe each one at length, adjust, capture again, and
 * never converge — because it cannot evaluate its own output. This replaces
 * that loop with a bounded question to somebody who can.
 *
 * THE BUDGET IS ENFORCED HERE, not advised. When the rounds are spent the tool
 * refuses and says STOP AND ASK. A budget a model can talk its way past is a
 * suggestion, and the behaviour being prevented is precisely a model
 * persistently trying one more adjustment.
 *
 * WHAT IT WILL NOT DO. It does not capture screens (a transport does that,
 * behind the user's own gate), does not generate the candidates (the caller
 * does, from real parameters), and does not decide anything. It refuses a
 * candidate with no machine evidence, because four pictures and a model's
 * impressions of them is not a choice — it is the model's guess wearing a
 * person's authority.
 */

const visualMod = require('../visual');
/**
 * How many named facts one round may ask for —.
 *
 * Enough to replace a paragraph of prose with structure, few enough that
 * choosing a candidate does not become a questionnaire. A person who has
 * already looked once is spending attention on every extra question.
 */
const MAX_OBSERVATIONS = 4;
const windowMod = require('../visualwindow');
/** What is happening, as named facts — the contract a companion renders. */
const { EVENT, busOf } = require('../events');

const schema = {
  name: 'visual_choice',
  description:
    'Ask the USER to look at up to four candidate images and choose between them. Use this when '
    + 'the question is one you cannot answer by reading — "which is more legible", "does this look '
    + 'right", "which contrast works" — instead of capturing, describing and adjusting repeatedly. '
    + 'Generate the candidates by varying real parameters, give each one a MACHINE measurement '
    + '(OCR confidence, a pixel statistic, a DOM rectangle), and the user picks. '
    + 'The answer comes back as structure — which one, whether they accepted it, and what they '
    + 'said was wrong — and it is kept for the rest of the task. '
    + 'STRICTLY BOUNDED: a few rounds per task. When they are spent, stop and ask the user in '
    + 'words rather than adjusting again.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'what you need judged, in one sentence' },
      scene: {
        type: 'string',
        description:
          'WHAT YOU ARE LOOKING AT — "dungeon 3, torchlit", "the settings panel". A round budget '
          + 'belongs to a scene: when this changes, LAIN starts a fresh bounded re-observation '
          + 'instead of refusing, and KEEPS what the user already established. Say it changed '
          + 'because it changed, not to buy more rounds — the number of scenes is bounded too.',
      },
      observe: {
        type: 'array',
        description:
          'NAMED FACTS to ask for after they choose, each as its own question — '
          + '[{key:"indicator_visible", question:"Can you see the indicator?"}, '
          + '{key:"background", question:"How is the background?", options:["fine","too bright","too dark"]}]. '
          + 'With options it is a choice; without, it is a yes/no. They come back as structure you '
          + 'can act on, and are carried into later rounds, instead of a paragraph you must reread.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: "the name of the fact, e.g. enemy_contrast" },
            question: { type: 'string', description: 'what to ask, in one sentence' },
            options: { type: 'array', items: { type: 'string' }, description: 'the answers, if it is a choice' },
          },
          required: ['key', 'question'],
        },
      },
      candidates: {
        type: 'array',
        description: 'two to four options. Each: { label, image (a file path), machine (a measured fact), params }',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'short name, e.g. "grayscale + threshold 140"' },
            image: { type: 'string', description: 'path to a png/jpg showing this candidate' },
            machine: { type: 'string', description: 'a MEASURED fact, e.g. "OCR confidence 0.81, 12 regions". Never an impression.' },
            params: { type: 'object', description: 'the parameters that produced it, so the choice can be applied' },
          },
          required: ['label', 'machine'],
        },
      },
    },
    required: ['question', 'candidates'],
  },
};

/** One inspection per task. Held on the app so a turn boundary does not reset the budget. */
function inspectionFor(app, question) {
  if (!app._visual) app._visual = new visualMod.VisualInspection(question);
  return app._visual;
}

async function run(input, ctx) {
  const app = ctx && ctx.app;
  const question = String((input && input.question) || '').trim();
  if (!question) return { output: 'visual_choice needs a question', isError: true };

  const raw = Array.isArray(input.candidates) ? input.candidates : [];
  let candidates;
  try {
    candidates = raw.map((c) => visualMod.candidate({
      id: c.id || c.label,
      label: c.label,
      params: c.params,
      image: c.image,
      machine: c.machine,
    }));
  } catch (e) {
    return { output: `${e.message}. Nothing was shown.`, isError: true };
  }

  const insp = inspectionFor(app, question);
  // ---- THE ENVIRONMENT MAY HAVE CHANGED — ---------------------------
  //
  // A budget spent tuning contrast in one dungeon must not refuse to look at a
  // different one, and re-running the whole optimisation because the lighting
  // changed is the loop this tool exists to prevent. A new SCENE is a new
  // bounded episode; what the person already established is KEPT, because
  // "the indicator must stay visible" is still true in the new dungeon.
  //
  // LAIN DOES NOT GUESS THAT THE SCENE CHANGED. The caller says what it is
  // looking at; inferring it from pixels would be the model judging its own
  // visual interpretation, which is the one thing human judgment is for.
  const changed = insp.enter(String((input && input.scene) || '').trim());
  const may = insp.mayAsk();
  if (!may.ok) {
    return {
      output: `${may.why}.\n${insp.report().text}\n`
        + 'Do not generate more candidates. Say what is still unresolved and ask the user directly.',
      isError: true,
      meta: { visual: 'BUDGET_SPENT' },
    };
  }

  let round;
  try { round = insp.ask(candidates); }
  catch (e) { return { output: `${e.message}. Nothing was shown.`, isError: true }; }

  // ---- SHOW IT ------------------------------------------------------------
  const shown = windowMod.show(round, {
    question,
    constraints: insp.constraints(),
    roundsLeft: insp.remaining,
  });
  if (!shown.ok) {
    insp.abandon('the visual window could not be written');
    return { output: `${shown.why}. Nothing was shown and nobody was asked.`, isError: true };
  }

  // ---- ASK ----------------------------------------------------------------
  //
  // No interactive UI is not a reason to invent an answer. It is a reason to
  // say the judgment did not happen — the file is on disk and can be looked at.
  if (typeof ctx.ask !== 'function') {
    insp.abandon('no interactive UI in this run');
    return {
      output: `NOT VISUALLY VERIFIED — there is no interactive UI in this run, so nobody was asked.\n`
        + `The candidates were written to ${shown.file}.\n`
        + 'Proceed on machine evidence alone and say that no one has looked.',
    };
  }

  // THE EXISTING TWO-LEVEL CONVENTION, not a new one: `choice — why`. The
  // compact MCQ draws the part before the dash, one row per candidate, and Esc
  // opens the details view carrying the measurement and the parameters. A
  // separate `detail` argument would have been a second channel that nothing
  // renders — see ui/adapters.splitOption, which is what makes this work.
  const options = round.candidates.map((c) => {
    const params = Object.keys(c.params || {}).length ? `; params ${JSON.stringify(c.params)}` : '';
    return `${c.label} — measured ${c.machine}${params}`;
  });
  options.push('None of these are right — say what is wrong and I will adjust');

  const where = shown.opened
    ? 'the candidates are open in a browser window'
    : `open ${shown.file} — a browser could not be started`;
  // WHAT IS ON SCREEN, BEFORE ANYBODY LOOKS AT IT. A companion showing "LAIN is
  // waiting" should be able to say what it is waiting to be looked at — and the
  // round number is the bound, which is the other thing worth seeing.
  busOf(ctx.app).emit(EVENT.VISUAL_PRESENTED, {
    question,
    candidates: round.candidates.map((c) => c.label),
    round: round.n,
    of: insp.maxRounds,
    file: shown.file,
  });
  const answer = await ctx.ask({
    question: `${question}\n(${where}; round ${round.n} of ${insp.maxRounds})\n`
      + 'Choosing is not the same as accepting: if one is close but wrong, pick it and say what to change.',
    options,
  });

  if (answer == null || answer === '') {
    insp.abandon('the user dismissed the question');
    return {
      output: 'NOT VISUALLY VERIFIED — the user dismissed the question without looking. '
        + 'Continue on machine evidence and say that nobody has judged it.',
    };
  }

  // ---- RECORD -------------------------------------------------------------
  //
  // The panel returns the OPTION TEXT, so the candidate is found by matching it
  // rather than by parsing a letter out of the front — the rows are labelled
  // `[A]`..`[D]` by the panel itself and that labelling is the panel's
  // business, not a format this tool may rely on. A free-text answer (the
  // "Other…" row) matches nothing and is a rejection, which is correct: it is
  // the person saying none of these, in their own words.
  const notes = String(answer);
  const picked = round.candidates.find((c) => notes.startsWith(c.label));
  const chose = picked ? picked.id : null;
  // ACCEPTANCE IS A SEPARATE CLAIM FROM CHOICE, and it has to be said. Picking
  // the best of four poor options is choosing; calling it right is not the same
  // sentence, and only the second one earns "visually verified".
  const accepted = Boolean(chose) && /\b(accept|right|correct|good|perfect|that's it|thats it|yes)\b/i.test(notes);

  // ---- STRUCTURED FACTS, ASKED SEPARATELY -------------------------------
  //
  //. "Which is best" is one question; "can you see the indicator", "is the
  // enemy distinguishable", "is the background too bright" are three more, and
  // each has an answer worth keeping as a NAMED FACT rather than buried in a
  // sentence. A model reading `background: "too_bright"` can act on it; a model
  // re-reading prose has to interpret it again every round.
  //
  // Each goes through the ONE question surface as its own typed question, so a
  // yes/no is a yes/no and a scale is a choice — see ui/answer.js. Bounded, and
  // only after a candidate was chosen: interrogating somebody who has just told
  // you none of them work is the wrong moment.
  const observations = {};
  const asked = Array.isArray(input.observe) ? input.observe.slice(0, MAX_OBSERVATIONS) : [];
  if (chose && asked.length) {
    for (const o of asked) {
      const key = String((o && o.key) || '').trim();
      const q = String((o && o.question) || '').trim();
      if (!key || !q) continue;
      const opts = Array.isArray(o.options) ? o.options.map(String).filter(Boolean) : [];
      // A question with choices IS a choice; one without is a yes/no, because
      // that is what "can you see it" actually is.
      const reply = await ctx.ask({
        question: q,
        options: opts,
        input: opts.length ? 'choice' : 'confirm',
      });
      // A DISMISSAL IS NOT AN ANSWER. Recording one as a fact would put the
      // model's guess in a field that is supposed to hold a person's judgment.
      if (reply == null || reply === '') break;
      observations[key] = String(reply);
    }
  }

  insp.answer(visualMod.decision({ chose, accepted, notes, observations }));
  // JUDGED, and by whom. A companion must be able to tell "the user looked and
  // chose" from "the model decided" — they are different kinds of evidence and
  // merging them is what visual.js exists to prevent.
  busOf(ctx.app).emit(EVENT.VISUAL_JUDGED, { chose, accepted, notes, observations: JSON.stringify(observations) });
  const rep = insp.report();
  const con = insp.conclusion();
  return {
    output: [
      `HUMAN VISUAL DECISION — ${con.text}`,
      rep.chosen ? `chosen: ${rep.chosen.label}` : 'chosen: none',
      rep.chosen && Object.keys(rep.chosen.params).length
        ? `parameters: ${JSON.stringify(rep.chosen.params)}` : '',
      `they said: ${notes}`,
      changed ? `the scene changed to "${insp.scene}" — this is a fresh bounded look, not more tuning` : '',
      Object.keys(observations).length ? `they also said: ${JSON.stringify(observations)}` : '',
      `rounds left: ${insp.remaining}`,
      insp.remaining <= 0
        ? 'The budget is spent. Do not generate more candidates — apply this and verify, or ask in words.'
        : 'Apply this. Only ask again if their answer changed what the candidates should be.',
    ].filter(Boolean).join('\n'),
    meta: { visual: con.verdict, chosen: rep.chosen ? rep.chosen.id : null },
  };
}

module.exports = { tools: { visual_choice: { mutates: false, schema, run } }, inspectionFor };
