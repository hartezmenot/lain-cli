'use strict';

/**
 * STRUCTURED JUDGMENT AND A CHANGING ENVIRONMENT.
 *
 * THE THREE THINGS THAT WERE MISSING, each a way the bounded workflow was less
 * useful than it looked:
 *
 *   NAMED FACTS  a decision could carry them — `decision()` has always had an
 *           `observations` field — and nothing ever put anything in it. The
 *           answer came back as one prose blob, so every later round had to
 *           re-interpret a sentence instead of reading a value.
 *
 *   REJECTIONS  their facts were thrown away. "None of these, and the
 *           background is too bright" is the most valuable answer the workflow
 *           can get, and only a chosen candidate's observations were kept.
 *
 *   THE BUDGET  it belonged to the INSPECTION, not to the SCENE. Three
 *           rounds spent tuning one dungeon meant refusing to look at a
 *           different dungeon — while the alternative, re-running the whole
 *           optimisation on every change, is the infinite loop this file's
 *           bounds exist to prevent.
 *
 * The bound on the fix is tested too: "the environment changed" must not become
 * a way to buy three more rounds for ever.
 */

const assert = require('assert');
const { test } = require('../helpers');

const visual = require('../../src/visual');

const cand = (id, machine) => visual.candidate({ id, label: id, machine });
const four = () => [cand('a', 'OCR 0.81'), cand('b', 'OCR 0.62')];

module.exports = async function () {
  // ------------------------------------------------- STRUCTURED FACTS ----

  await test('FACTS: named observations are kept, and carried into later rounds', () => {
    const insp = new visual.VisualInspection('which is most legible?');
    insp.ask(four());
    insp.answer(visual.decision({
      chose: 'a',
      notes: 'this one',
      observations: { indicator_visible: 'yes', background: 'too_bright' },
    }));
    assert.deepStrictEqual(insp.constraints(), {
      indicator_visible: 'yes', background: 'too_bright',
    }, 'a later round is checked against these rather than re-deriving them from prose');
  });

  await test('FACTS: a REJECTION\'S facts are kept — they are the most useful ones', () => {
    // "None of these, and the background is too bright" tells you more than any
    // of the four candidates did, and the next round is built from exactly it.
    const insp = new visual.VisualInspection('q');
    insp.ask(four());
    insp.answer(visual.decision({
      chose: null,
      notes: 'none of these work',
      observations: { background: 'too_bright' },
    }));
    assert.strictEqual(insp.constraints().background, 'too_bright',
      'the facts were discarded because no candidate was chosen');
  });

  await test('FACTS: later rounds merge onto earlier ones, newest winning', () => {
    const insp = new visual.VisualInspection('q');
    insp.ask(four());
    insp.answer(visual.decision({ chose: 'a', observations: { background: 'too_bright', enemy: 'ok' } }));
    insp.ask(four());
    insp.answer(visual.decision({ chose: 'b', observations: { background: 'fine' } }));
    assert.deepStrictEqual(insp.constraints(), { background: 'fine', enemy: 'ok' });
  });

  // --------------------------------------------- A CHANGING ENVIRONMENT --

  await test('SCENE: naming the FIRST scene is not a change', () => {
    const insp = new visual.VisualInspection('q');
    assert.strictEqual(insp.enter('dungeon 1'), false, 'there was nothing to change from');
    assert.strictEqual(insp.scene, 'dungeon 1');
  });

  await test('SCENE: the same scene again is not a change, and does not refill the budget', () => {
    const insp = new visual.VisualInspection('q', { maxRounds: 2 });
    insp.enter('dungeon 1');
    insp.ask(four()); insp.answer(visual.decision({ chose: 'a' }));
    insp.ask(four()); insp.answer(visual.decision({ chose: 'a' }));
    assert.strictEqual(insp.enter('dungeon 1'), false);
    assert.strictEqual(insp.mayAsk().ok, false, 'the same question got three rounds');
  });

  await test('SCENE: a DIFFERENT scene is a fresh bounded look, and keeps what was learned', () => {
    const insp = new visual.VisualInspection('q', { maxRounds: 2 });
    insp.enter('dungeon 1');
    insp.ask(four());
    insp.answer(visual.decision({ chose: 'a', observations: { indicator_visible: 'yes' } }));
    insp.ask(four());
    insp.answer(visual.decision({ chose: 'a' }));
    assert.strictEqual(insp.mayAsk().ok, false, 'the budget for THAT scene is spent');

    assert.strictEqual(insp.enter('dungeon 3, torchlit'), true);
    assert.strictEqual(insp.mayAsk().ok, true, 'a different environment is a different question');
    // AND THE CONSTRAINTS SURVIVE. "The indicator must stay visible" is still
    // true in the new dungeon, and making the person say it again is the cost
    // this whole workflow exists to avoid.
    assert.strictEqual(insp.constraints().indicator_visible, 'yes');
  });

  await test('SCENE: the record of what happened is NOT erased by a new scene', () => {
    const insp = new visual.VisualInspection('q', { maxRounds: 2 });
    insp.enter('one');
    insp.ask(four()); insp.answer(visual.decision({ chose: 'a' }));
    insp.enter('two');
    assert.strictEqual(insp.spent, 1, 'the round still happened');
    assert.strictEqual(insp.rounds.length, 1);
  });

  await test('SCENE: the escape hatch is BOUNDED — it cannot buy rounds for ever', () => {
    // Without this, "the environment changed" is the same unbounded loop
    // wearing its own fix as a costume.
    const insp = new visual.VisualInspection('q', { maxRounds: 1 });
    for (let i = 0; i <= visual.MAX_EPISODES; i++) {
      insp.enter(`scene ${i}`);
      if (insp.mayAsk().ok) { insp.ask(four()); insp.answer(visual.decision({ chose: 'a' })); }
    }
    insp.enter('one more scene');
    const may = insp.mayAsk();
    assert.strictEqual(may.ok, false, `${visual.MAX_EPISODES + 1} scenes were allowed`);
    assert.match(may.why, /not converging/);
  });

  await test('SCENE: an empty scene name changes nothing — it is not a reset', () => {
    const insp = new visual.VisualInspection('q', { maxRounds: 1 });
    insp.enter('dungeon 1');
    insp.ask(four()); insp.answer(visual.decision({ chose: 'a' }));
    assert.strictEqual(insp.enter(''), false);
    assert.strictEqual(insp.enter(null), false);
    assert.strictEqual(insp.mayAsk().ok, false, 'a blank scene refilled the budget');
  });

  // ----------------------------------------------------- STILL BOUNDED --

  await test('BOUNDS: the round and candidate limits are unchanged', () => {
    assert.strictEqual(visual.MAX_ROUNDS, 3);
    assert.strictEqual(visual.MAX_CANDIDATES, 4);
    const insp = new visual.VisualInspection('q');
    assert.throws(() => insp.ask([cand('a', 'm'), cand('b', 'm'), cand('c', 'm'), cand('d', 'm'), cand('e', 'm')]),
      /parameter sweep/, 'five candidates is a sweep, not a choice');
  });

  await test('BOUNDS: a candidate with no machine evidence is still refused', () => {
    // Four pictures and the model's impressions of them is not a choice — it is
    // the model's guess wearing a person's authority.
    assert.throws(() => visual.candidate({ id: 'a', label: 'a' }), /machine/i);
  });
};
