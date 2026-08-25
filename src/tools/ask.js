'use strict';

/**
 * ask_user — the model asks the human a question with concrete options.
 *
 * The CHOICES ARE RENDERED DETERMINISTICALLY by the existing InteractionPanel.
 * The model supplies data (a question and a list); it never draws the menu and
 * never fabricates UI text, so a question costs exactly the tokens of its own
 * arguments and nothing more.
 *
 * This is a tool, not a control channel: the answer comes back as an ordinary
 * tool result, which means it lands in the conversation as evidence by the same
 * path as every other result. It cannot start a task, end one, mutate the plan
 * or reset a step — a turn is already in flight when it runs.
 *
 * THE ANSWER MAY NOT BE ON THE LIST. The panel takes a typed line as well as a
 * highlighted row — a number, a letter, or free text — so an option list is an
 * offer rather than a cage. See ui/answer.js for what a line means.
 *
 * Without an interactive UI (a pipe, `-p`, a test) it does not hang or invent an
 * answer: it says so, and the model chooses how to proceed.
 */

const MAX_OPTIONS = 12;

const tools = {
  ask_user: {
    mutates: false,
    schema: {
      name: 'ask_user',
      description:
        'Ask the user a question with a short list of options, when a genuine fork in the work '
        + 'needs their decision. Returns the option they chose. '
        + 'ASK EARLY RATHER THAN LATE: one question that settles an ambiguity is far cheaper than '
        + 'searching forty files, building the wrong thing and rewriting it — so if two readings of '
        + 'the request would lead to different implementations, ask BEFORE investigating. '
        + 'Ask ONLY about what the user knows and the machine cannot find out: intent, preference, '
        + 'and which reading of their words is right. Never ask what a read, a search or a test run '
        + 'would answer. A few questions per task, then decide yourself and state the assumption. '
        + 'DO NOT WRITE ANY INSTRUCTION ABOUT HOW TO REPLY — no "(please type a number)", no '
        + '"reply with a letter". The interface draws the choices, numbers or letters them, and '
        + 'prints its own prompt describing exactly what it accepts; your version can only '
        + 'contradict it. Give the question and the options and nothing else.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'the question, in one sentence' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'the choices, for input "choice" or "multi". PLAIN STRINGS — put any '
              + 'reasoning in the same string after an em dash ("React — fast, big ecosystem"), '
              + 'not in a nested object. An "Other…" entry is added automatically to a choice '
              + 'list, so never write one yourself.',
          },
          input: {
            type: 'string',
            enum: ['choice', 'number', 'text', 'confirm', 'multi'],
            description:
              'WHAT KIND OF ANSWER this needs, so the interface can offer a surface that actually '
              + 'takes it: "choice" (default, one of options), "number" (a validated number — no '
              + 'options), "text" (free text — no options), "confirm" (yes or no), "multi" (any of '
              + 'options). Get this right rather than asking for a number in the question text: the '
              + 'interface prints its own accurate prompt from this field, and a mismatch means the '
              + 'user is told to type something the surface will not accept.',
          },
        },
        required: ['question'],
      },
    },
    async run(input, ctx) {
      const question = String((input && input.question) || '').trim();
      if (!question) return { output: 'ask_user needs a question', isError: true };
      // NORMALISED, NOT COERCED. The schema asks for strings; models send
      // `{ label, description }` objects because that is the natural way to
      // write a choice with a reason attached, and `String(o)` turned every
      // one of them into `[object Object]` — an unanswerable question with
      // four identical rows. ui/answer.js owns what an option says; this is
      // the boundary that stops the raw shape travelling any further.
      const options = Array.isArray(input.options)
        ? input.options.map((o) => require('../ui/answer').optionText(o).replace(/\s+/g, ' ').trim())
          .filter(Boolean).slice(0, MAX_OPTIONS)
        : [];
      const asKind = input.input == null ? null : String(input.input);

      // THE POLICY, ENFORCED RATHER THAN SUGGESTED. See clarify.js: a budget a
      // model can talk its way past is a suggestion, and "ask sparingly" in a
      // tool description has no way to know that this is the fourth time.
      const clarify = require('../clarify');
      const budget = ctx.app ? clarify.forTask(ctx.app) : null;
      if (budget) {
        const may = budget.mayAsk(question);
        if (!may.ok) {
          // A REFUSAL THAT CARRIES THE ANSWER. When the question was already
          // asked, the reply is not "no" — it is the answer they gave, which is
          // what the model actually needed and had forgotten it had.
          return { output: may.why, isError: !may.previous, meta: { clarify: 'REFUSED' } };
        }
      }

      if (typeof ctx.ask !== 'function') {
        return {
          output: 'No interactive UI is available in this run, so the user cannot be asked. '
            + 'Decide using your best judgement and say which assumption you made.',
          isError: false,
        };
      }

      const answer = await ctx.ask({ question, options, input: asKind });
      if (answer == null || answer === '') {
        // A DISMISSAL DOES NOT SPEND THE BUDGET. Nobody answered, so nothing
        // was established, and charging for it would let a stray Escape cost
        // the task a question it still needs.
        return { output: 'The user dismissed the question without answering. Continue with your best judgement.' };
      }

      if (budget) {
        budget.record(question, answer);
        // KEPT WHERE THE TASK KEEPS WHAT IT KNOWS, so it survives the turn,
        // compaction and /resume rather than having to be asked again.
        clarify.remember(ctx.app, question, answer);
      }
      return {
        output: `The user chose: ${answer}`
          + (budget && budget.remaining <= 0
            ? '\nThat was the last clarification for this task — decide the rest yourself and state your assumptions.'
            : ''),
        meta: { question, answer },
      };
    },
  },
};

module.exports = { tools, MAX_OPTIONS };
