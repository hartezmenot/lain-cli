'use strict';

/**
 * ASKING A PERSON — the two places LAIN is allowed to, and the limits on both.
 *
 * Both exist to stop the same failure from opposite directions:
 *
 *   A model that never asks spends forty files discovering that "sell with LMB"
 *   meant hold, not tap, and rewrites everything.
 *
 *   A model that asks freely stops being an agent — every question is a stop,
 *   a context switch and a wait, and somebody asked six times learns to stop
 *   reading the questions.
 *
 * And the visual case is worse than the verbal one, because a model cannot see:
 * asked to tune a threshold from screenshots it will describe each one at
 * length, adjust, capture again, and never converge — it cannot evaluate its
 * own output. That loop has no natural end, so the end is imposed here.
 *
 * The rule both files share: A BUDGET A MODEL CAN TALK ITS WAY PAST IS A
 * SUGGESTION. Every limit below is enforced, not advised.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const clarify = require('../../src/clarify');
const visual = require('../../src/visual');
const vwindow = require('../../src/visualwindow');
const askTool = require('../../src/tools/ask').tools.ask_user;
const visualTool = require('../../src/tools/visual').tools.visual_choice;

/** An app just real enough for the tools: a plan to remember decisions in. */
function fakeApp() { return { session: { plan: { decisions: [] } } }; }

/** Four candidates with real measurements, as a caller must supply them. */
function fourCandidates() {
  return [
    { label: 'original', machine: 'OCR confidence 0.42' },
    { label: 'grayscale', machine: 'OCR confidence 0.71', params: { gray: true } },
    { label: 'threshold 140', machine: 'OCR confidence 0.81', params: { gray: true, threshold: 140 } },
    { label: 'threshold 200', machine: 'OCR confidence 0.55', params: { gray: true, threshold: 200 } },
  ];
}

module.exports = async function () {
  // ------------------------------------------------------- clarification --

  await test('CLARIFY: a question is asked, answered, and kept where the task keeps what it knows', async () => {
    const app = fakeApp();
    const ctx = { app, ask: async () => 'hold' };
    const r = await askTool.run({ question: 'Is selling a hold or a tap?', options: ['hold', 'tap'] }, ctx);
    assert.match(r.output, /The user chose: hold/);
    // In the PLAN's decisions, which already survive compaction and /resume —
    // an answer kept anywhere else would have to be established again.
    assert.strictEqual(app.session.plan.decisions.length, 1);
    assert.match(app.session.plan.decisions[0].text, /hold or a tap\? → hold/);
    assert.strictEqual(app.session.plan.decisions[0].reason, 'user clarification');
  });

  await test('CLARIFY: the same question REWORDED is refused, with the answer they already gave', async () => {
    // The refusal is not "no". It is the answer the model needed and had
    // forgotten it had — so the turn continues instead of stopping.
    const app = fakeApp();
    const ctx = { app, ask: async () => 'hold' };
    await askTool.run({ question: 'Is selling a hold or a tap?' }, ctx);
    const again = await askTool.run({ question: 'should I hold LMB, or tap it?' }, ctx);
    assert.match(again.output, /you already asked this and they answered: "hold"/);
    assert.strictEqual(again.isError, false, 'it carries an answer, so it is not an error');
    assert.strictEqual(app.session.plan.decisions.length, 1, 'and it is not recorded twice');
  });

  await test('CLARIFY: two genuinely different questions are both allowed through', () => {
    // The dedupe must not be so eager that it swallows real questions.
    const c = new clarify.Clarifications();
    c.record('Which colour for the banner?', 'blue');
    assert.strictEqual(c.previous('Should the toolbar be pinned to the side?'), null);
    assert.ok(clarify.overlap(clarify.normalise('is selling a hold or a tap'),
      clarify.normalise('should I hold LMB, or tap it')) >= clarify.SAME,
    'while a rewording of one question still matches');
  });

  await test('CLARIFY: a question the machine can answer is refused BY NAME', async () => {
    const ctx = { app: fakeApp(), ask: async () => 'x' };
    const r = await askTool.run({ question: 'which files contain the reel logic?' }, ctx);
    assert.match(r.output, /not a clarification — search for it/);
    assert.strictEqual(r.isError, true);
    const t = await askTool.run({ question: 'do the tests pass?' }, ctx);
    assert.match(t.output, /run them/);
  });

  await test('CLARIFY: the budget is spent, and the refusal says what to do instead', async () => {
    const app = fakeApp();
    const ctx = { app, ask: async () => 'yes' };
    for (const q of ['Colour for the banner?', 'Pin the toolbar?', 'Metric or imperial units?']) {
      await askTool.run({ question: q }, ctx);
    }
    const over = await askTool.run({ question: 'Something else entirely, about naming?' }, ctx);
    assert.match(over.output, /budget for this task is spent/);
    assert.match(over.output, /state the assumption you made/, 'it must say what to do, not only what it refused');
  });

  await test('CLARIFY: a DISMISSED question does not spend the budget', async () => {
    // Nobody answered, so nothing was established. Charging for it would let a
    // stray Escape cost the task a question it still needs.
    const app = fakeApp();
    const dismissed = { app, ask: async () => null };
    await askTool.run({ question: 'Colour for the banner?' }, dismissed);
    assert.strictEqual(clarify.forTask(app).spent, 0);
  });

  await test('CLARIFY: a new task gets a fresh budget — it limits a task, not the user', () => {
    const c = new clarify.Clarifications();
    c.record('a?', '1'); c.record('b?', '2'); c.record('c?', '3');
    assert.strictEqual(c.remaining, 0);
    assert.strictEqual(new clarify.Clarifications().remaining, clarify.MAX_ROUNDS);
  });

  // ------------------------------------------------------------- visual --

  await test('VISUAL: a candidate with no MEASUREMENT is refused', () => {
    // Four pictures and a model's impressions of them is not a choice — it is
    // the model's guess wearing the person's authority.
    assert.throws(() => visual.candidate({ label: 'grayscale' }), /no machine evidence/);
    assert.doesNotThrow(() => visual.candidate({ label: 'grayscale', machine: 'OCR 0.71' }));
  });

  await test('VISUAL: a parameter sweep is refused — a choice is at most four', () => {
    const i = new visual.VisualInspection('which reads best?');
    const five = Array.from({ length: 5 }, (_, n) => visual.candidate({ label: `t${n}`, machine: `OCR 0.${n}` }));
    assert.throws(() => i.ask(five), /parameter sweep/);
    assert.throws(() => i.ask(five.slice(0, 1)), /at least two/);
  });

  await test('VISUAL: CHOOSING is not ACCEPTING, and only accepting earns the claim', () => {
    // Picking the best of four poor options is choosing. Saying it looks right
    // is a different sentence, and only the second one is a warrant.
    const i = new visual.VisualInspection('which reads best?');
    const cs = fourCandidates().map(visual.candidate);
    i.ask(cs);
    i.answer(visual.decision({ chose: cs[2].id, accepted: false, notes: 'closest, but the enemies blend in' }));
    const con = i.conclusion();
    assert.strictEqual(con.verdict, visual.VERDICT.NEEDS_ADJUSTMENT);
    assert.match(con.text, /NOT VISUALLY VERIFIED/);
    assert.strictEqual(con.human, true, 'a person did look, and that is separately true');
  });

  await test('VISUAL: acceptance by a person is the ONLY route to a visual verdict', () => {
    const i = new visual.VisualInspection('which reads best?');
    const cs = fourCandidates().map(visual.candidate);
    i.ask(cs);
    i.answer(visual.decision({ chose: cs[1].id, accepted: true, notes: 'that is right' }));
    assert.strictEqual(i.conclusion().verdict, visual.VERDICT.ACCEPTED);
  });

  await test('VISUAL: nobody shown anything is NOT INSPECTED, not "fine"', () => {
    const i = new visual.VisualInspection('which reads best?');
    assert.strictEqual(i.conclusion().verdict, visual.VERDICT.NOT_INSPECTED);
    assert.match(i.conclusion().text, /NOT VISUALLY INSPECTED/);
  });

  await test('VISUAL: the budget ENDS the loop, and says stop rather than continue', () => {
    const i = new visual.VisualInspection('which reads best?', { maxRounds: 2 });
    const cs = fourCandidates().map(visual.candidate);
    for (let n = 0; n < 2; n++) {
      i.ask(cs);
      i.answer(visual.decision({ chose: cs[0].id, notes: 'still not right' }));
    }
    assert.strictEqual(i.mayAsk().ok, false);
    assert.throws(() => i.ask(cs), /budget is spent/);
    const con = i.conclusion();
    assert.strictEqual(con.verdict, visual.VERDICT.BUDGET_SPENT);
    assert.match(con.text, /STOP AND ASK/);
  });

  await test('VISUAL: what the person said becomes STRUCTURE, carried into later rounds', () => {
    // Kept as prose it is a paragraph the model reinterprets every turn. Kept
    // as fields it is a constraint a later round can be checked against.
    const i = new visual.VisualInspection('which reads best?');
    const cs = fourCandidates().map(visual.candidate);
    i.ask(cs);
    i.answer(visual.decision({
      chose: cs[2].id,
      notes: 'C is too harsh',
      observations: { indicator_visible: 'yes', enemy_contrast: 'too low' },
    }));
    assert.deepStrictEqual(i.constraints(), { indicator_visible: 'yes', enemy_contrast: 'too low' });
    assert.strictEqual(i.chosen().label, 'threshold 140');
  });

  await test('VISUAL: rejecting every candidate is a real answer, not a failure', () => {
    const i = new visual.VisualInspection('which reads best?');
    const cs = fourCandidates().map(visual.candidate);
    i.ask(cs);
    i.answer(visual.decision({ chose: null, notes: 'none of these — the indicator is gone in all four' }));
    assert.strictEqual(i.rounds[0].state, visual.ROUND.REJECTED);
    assert.match(i.conclusion().text, /rejected every candidate/);
  });

  await test('VISUAL: the report keeps MACHINE and HUMAN evidence apart', () => {
    const i = new visual.VisualInspection('which reads best?');
    const cs = fourCandidates().map(visual.candidate);
    i.ask(cs);
    i.answer(visual.decision({ chose: cs[2].id, notes: 'closest but too harsh' }));
    const text = i.report().text;
    assert.match(text, /MACHINE: OCR confidence 0\.81/);
    assert.match(text, /HUMAN: closest but too harsh/);
    assert.ok(text.indexOf('MACHINE') < text.indexOf('HUMAN'), 'measured first, judged second');
  });

  // ------------------------------------------------------- the window --

  await test('WINDOW: the page shows every candidate, with its measurement', () => {
    const i = new visual.VisualInspection('which reads best?');
    const round = i.ask(fourCandidates().map(visual.candidate));
    const html = vwindow.page(round, { question: 'which reads best?', roundsLeft: 2 });
    for (const letter of ['A', 'B', 'C', 'D']) assert.ok(html.includes(`>${letter}<`), `no card ${letter}`);
    assert.match(html, /OCR confidence 0\.81/);
    assert.match(html, /2 rounds left/);
  });

  await test('WINDOW: a candidate whose image is missing is SHOWN, saying so', () => {
    // Dropping it would silently turn a four-way choice into a three-way one,
    // and the person would be choosing from a set nobody told them had changed.
    const i = new visual.VisualInspection('q');
    const round = i.ask([
      visual.candidate({ label: 'a', machine: 'm1', image: '/nope/missing.png' }),
      visual.candidate({ label: 'b', machine: 'm2' }),
    ]);
    const html = vwindow.page(round);
    assert.match(html, /could not be read/);
    assert.match(html, /none was supplied/);
    assert.ok(html.includes('>A<') && html.includes('>B<'), 'both are still offered');
  });

  await test('WINDOW: a real image is embedded, so the page stands alone', () => {
    // Nothing is fetched, no path leaks, and the file can be reopened later.
    const dir = tmpdir('vis-');
    const png = path.join(dir, 'x.png');
    // The smallest valid PNG: an 1x1 image, written byte by byte.
    fs.writeFileSync(png, Buffer.from(
      '89504e470d0a1a0a0000000d494844520000000100000001080200000090777'
      + '3de0000000c4944415408d763f8cfc00000030101003e2d0b8e0000000049454e44ae426082', 'hex'));
    const uri = vwindow.embed(png);
    assert.ok(String(uri).startsWith('data:image/png;base64,'), `got: ${String(uri).slice(0, 40)}`);
    const i = new visual.VisualInspection('q');
    const round = i.ask([
      visual.candidate({ label: 'a', machine: 'm1', image: png }),
      visual.candidate({ label: 'b', machine: 'm2' }),
    ]);
    const html = vwindow.page(round);
    assert.match(html, /data:image\/png;base64,/);
    assert.ok(!html.includes(dir), 'and the local path is not in the page');
  });

  await test('WINDOW: the page says where the answer is given', () => {
    // A page with no way to answer, and no sentence saying so, is a person
    // waiting for a button that does not exist.
    const i = new visual.VisualInspection('q');
    const html = vwindow.page(i.ask(fourCandidates().slice(0, 2).map(visual.candidate)));
    assert.match(html, /Answer in LAIN, not here/);
  });

  await test('WINDOW: no script and no network — it is a picture and some text', () => {
    const i = new visual.VisualInspection('q');
    const html = vwindow.page(i.ask(fourCandidates().slice(0, 2).map(visual.candidate)));
    assert.ok(!/<script/i.test(html), 'no script');
    assert.ok(!/https?:\/\//i.test(html), 'nothing is fetched');
  });

  // ---------------------------------------------------------- the tool --

  await test('TOOL: with no interactive UI, nobody was asked and it says so', async () => {
    const app = fakeApp();
    const r = await visualTool.run({ question: 'which reads best?', candidates: fourCandidates() }, { app });
    assert.match(r.output, /NOT VISUALLY VERIFIED/);
    assert.match(r.output, /nobody was asked/);
    assert.ok(!r.isError, 'not being able to ask is a result, not a failure');
  });

  await test('TOOL: a candidate without a measurement is refused before anything is shown', async () => {
    const r = await visualTool.run({
      question: 'which reads best?',
      candidates: [{ label: 'a' }, { label: 'b', machine: 'x' }],
    }, { app: fakeApp() });
    assert.strictEqual(r.isError, true);
    assert.match(r.output, /no machine evidence/);
    assert.match(r.output, /Nothing was shown/);
  });

  await test('TOOL: the answer comes back as a decision, and the budget counts down', async () => {
    const app = fakeApp();
    const ctx = { app, ask: async ({ options }) => options[2] };   // the third candidate
    const r = await visualTool.run({ question: 'which reads best?', candidates: fourCandidates() }, ctx);
    assert.match(r.output, /HUMAN VISUAL DECISION/);
    assert.match(r.output, /chosen: threshold 140/);
    assert.match(r.output, /parameters: .*"threshold":140/);
    assert.match(r.output, /rounds left: 2/);
    assert.strictEqual(r.meta.visual, visual.VERDICT.NEEDS_ADJUSTMENT, 'choosing is not accepting');
  });

  await test('TOOL: "none of these" is recorded as a rejection, in their words', async () => {
    const app = fakeApp();
    const ctx = { app, ask: async ({ options }) => options[options.length - 1] };
    const r = await visualTool.run({ question: 'which reads best?', candidates: fourCandidates() }, ctx);
    assert.match(r.output, /chosen: none/);
    assert.strictEqual(app._visual.rounds[0].state, visual.ROUND.REJECTED);
  });

  await test('TOOL: when the budget is spent it REFUSES, and tells the model to stop adjusting', async () => {
    const app = fakeApp();
    const ctx = { app, ask: async ({ options }) => options[0] };
    for (let n = 0; n < visual.MAX_ROUNDS; n++) {
      await visualTool.run({ question: 'which reads best?', candidates: fourCandidates() }, ctx);
    }
    const over = await visualTool.run({ question: 'which reads best?', candidates: fourCandidates() }, ctx);
    assert.strictEqual(over.isError, true);
    assert.strictEqual(over.meta.visual, 'BUDGET_SPENT');
    assert.match(over.output, /Do not generate more candidates/);
    assert.match(over.output, /ROUND 1/, 'and it hands back what was already learned');
  });

  await test('TOOL: it is offered on every task, unlike the bridge tools', () => {
    // The loop it replaces — capture, describe, adjust, repeat — is available
    // to a model on any task with a picture in it.
    const names = require('../../src/tools').names();
    assert.ok(names.includes('visual_choice'));
    assert.ok(!names.includes('desktop'), 'while desktop still waits for a configured bridge');
  });
};
