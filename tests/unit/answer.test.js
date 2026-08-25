'use strict';

/**
 * THE MCQ INPUT SURFACE.
 *
 * THE BUG THIS TIER EXISTS FOR, reproduced against the real binary before any
 * of it was written: LAIN asked "level (please type a number)" with the options
 * 1-4, the user typed `2`, pressed Enter — and LAIN recorded "The user chose:
 * 1". Three defects with one cause:
 *
 *   · the rows were lettered `[A]`-`[D]` while the question asked for a number
 *   · the digit went to the input line, which the panel never read
 *   · Enter resolved the HIGHLIGHTED row, discarding the typing in silence
 *
 * A wrong answer accepted without a word is worse than no answer at all, so the
 * first test here is the exact reproduction and it asserts the value.
 */

const assert = require('assert');
const { test } = require('../helpers');

const A = require('../../src/ui/answer');
const panelMod = require('../../src/ui/panel');

/** A rendered panel as one plain string. */
const strip = (lines) => lines.join(String.fromCharCode(10));

module.exports = async function () {
  // ------------------------------------------------------- THE REGRESSION --

  await test('MCQ: typing 2 against the options 1-4 answers 2, not 1', async () => {
    const p = new panelMod.InteractionPanel();
    const done = p.open(panelMod.askAdapter({
      question: 'level (please type a number)',
      options: ['1', '2', '3', '4', A.OTHER],
    }));
    assert.strictEqual(p.cursor, p.items.findIndex((i) => i.value === '1'),
      'the cursor starts on the first choice — which is what used to be answered');
    assert.strictEqual(p.submitTyped('2'), true, 'the typed line must be consumed');
    assert.strictEqual(await done, '2');
  });

  await test('MCQ: the rows are NUMBERED when the choices are numbers', async () => {
    const a = panelMod.askAdapter({ question: 'level', options: ['1', '2', '3', '4', A.OTHER] });
    const rows = a.items.filter((i) => i.value !== undefined).map((i) => i.label);
    assert.deepStrictEqual(rows, ['1.  1', '2.  2', '3.  3', '4.  4', '5.  Other…'],
      'lettering the rows of a numeric question asks about its own labels');
  });

  await test('MCQ: the rows stay LETTERED when the choices are words', async () => {
    const a = panelMod.askAdapter({ question: 'Which frontend?', options: ['React', 'Svelte'] });
    const rows = a.items.filter((i) => i.value !== undefined).map((i) => i.label);
    assert.deepStrictEqual(rows, ['A.  React', 'B.  Svelte']);
  });

  // ------------------------------------------------ WHAT A TYPED LINE MEANS --

  await test('ANSWER: a bare label picks that row, in either alphabet', async () => {
    const opts = ['React', 'Svelte', 'Vanilla'];
    for (const typed of ['b', 'B', '[B]', 'B.', '2', '2)']) {
      const m = A.match(typed, opts);
      assert.strictEqual(m.kind, 'OPTION', typed + ' should be a choice');
      assert.strictEqual(m.value, 'Svelte', typed + ' should be Svelte');
    }
  });

  await test('ANSWER: the option text wins over the row label', async () => {
    // Options 10/20/30 — typing `20` means twenty, not "the twentieth row".
    const m = A.match('20', ['10', '20', '30']);
    assert.strictEqual(m.value, '20');
  });

  await test('ANSWER: a sentence that begins with a digit is TEXT, not a choice', async () => {
    // The silent-wrong-answer bug in a new costume: `2 files` is not option 2.
    const m = A.match('2 files, not the whole tree', ['a', 'b']);
    assert.strictEqual(m.kind, 'TEXT');
    assert.strictEqual(m.value, '2 files, not the whole tree');
  });

  await test('ANSWER: an answer that is on no list is still an answer', async () => {
    const m = A.match('neither — use Preact', ['React', 'Svelte']);
    assert.strictEqual(m.kind, 'TEXT');
  });

  await test('ANSWER: an empty line resolves nothing — Enter still means the row', async () => {
    assert.strictEqual(A.match('   ', ['a']), null);
  });

  await test('MCQ: free text typed at the choices is taken at face value', async () => {
    const p = new panelMod.InteractionPanel();
    const done = p.open(panelMod.askAdapter({ question: 'Which?', options: ['React', 'Svelte', A.OTHER] }));
    p.submitTyped('neither, use Preact');
    assert.strictEqual(await done, 'neither, use Preact');
  });

  // --------------------------------------------------------------- OTHER… --

  await test('OTHER: choosing it opens a real text state, and Enter there answers', async () => {
    const p = new panelMod.InteractionPanel();
    const done = p.open(panelMod.askAdapter({ question: 'Which?', options: ['React', A.OTHER] }));
    p.cursor = p.items.findIndex((i) => i.value === A.OTHER);
    p.select({ key: 'enter' });
    assert.strictEqual(p.stack.length, 2, 'it must lead somewhere, not close the panel');
    assert.strictEqual(p.takes, A.KIND.TEXT);
    assert.match(p.frame.footer, /type your answer/, 'and the footer must say so');
    p.submitTyped('Preact');
    assert.strictEqual(await done, 'Preact');
  });

  await test('OTHER: Escape goes BACK to the choices, not away from the question', async () => {
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.askAdapter({ question: 'Which?', options: ['React', A.OTHER] }));
    p.cursor = p.items.findIndex((i) => i.value === A.OTHER);
    p.select({ key: 'enter' });
    assert.strictEqual(p.escape(), true);
    assert.strictEqual(p.stack.length, 1);
    assert.strictEqual(p.takes, A.KIND.CHOICE, 'and the choices are back');
  });

  await test('OTHER: typing the Other row by number also opens the text state', async () => {
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.askAdapter({ question: 'level', options: ['1', '2', A.OTHER] }));
    p.submitTyped('3');
    assert.strictEqual(p.takes, A.KIND.TEXT, 'answering "3" must not answer the literal string Other…');
  });

  // ------------------------------------------- WHAT THE SCREEN PROMISES ----

  await test('PROMPT: the input border, the footer and the rows name the same keys', async () => {
    const opts = ['1', '2', '3', A.OTHER];
    const a = panelMod.askAdapter({ question: 'level', options: opts });
    assert.strictEqual(A.inputLabel(opts, A.KIND.CHOICE), 'ANSWER — type a number 1-4');
    assert.match(a.footer, /type a number 1-4/);
    assert.match(a.footer, /Enter send/);
    assert.match(a.footer, /Esc cancel/);
  });

  await test('PROMPT: a lettered question never promises a number', async () => {
    const opts = ['React', 'Svelte'];
    assert.match(A.inputLabel(opts, A.KIND.CHOICE), /type A-B/);
    assert.ok(!/number/.test(A.inputLabel(opts, A.KIND.CHOICE)),
      'do not say "type a number" unless a number is what it takes');
  });

  await test('PROMPT: the model own reply instruction is removed from the question', async () => {
    // Two instructions that can disagree is how the wrong one gets followed.
    assert.strictEqual(A.stripUiInstruction('level (please type a number)'), 'level');
    assert.strictEqual(A.stripUiInstruction('Which one? (reply with a letter)'), 'Which one?');
    // But a parenthetical that is INFORMATION is left exactly as written.
    assert.strictEqual(
      A.stripUiInstruction('Which port (the one in config.json)?'),
      'Which port (the one in config.json)?');
    assert.strictEqual(A.stripUiInstruction('(type a number)'), '(type a number)',
      'never strip the whole question away');
  });

  // ------------------------------------------------------ NOT A NEW WIDGET --

  await test('NO SECOND INPUT SYSTEM: nothing here reads a keystroke', async () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/ui/answer.js'), 'utf8');
    for (const forbidden of ['stdin', 'setRawMode', 'readline', 'require(']) {
      assert.ok(!src.includes(forbidden),
        'ui/answer.js must interpret a line, never read one: ' + forbidden);
    }
  });

  // ------------------------------------------------- THE FIVE INPUT KINDS --
  //
  //: "Do not overload one MCQ renderer with incompatible input types." Each
  // kind gets its own frame, and the thing that must be true of all five is
  // that the surface can actually TAKE what the prompt asks for.

  await test('KIND: a NUMBER question draws no option list and takes a number', async () => {
    const p = new panelMod.InteractionPanel();
    const done = p.open(panelMod.askAdapter({ question: 'What level?', input: 'number' }));
    assert.strictEqual(p.takes, A.KIND.NUMBER);
    assert.strictEqual(p.items.filter((i) => i.value !== undefined).length, 0,
      'a number question has no options to choose between, so it must not draw a list');
    assert.match(p.frame.footer, /type a number/);
    p.submitTyped('42');
    assert.strictEqual(await done, '42');
  });

  await test('KIND: a NUMBER question REFUSES prose, and stays open to be corrected', async () => {
    // Quietly accepting "about forty" is worse than refusing: the model acts on
    // it. This is the whole reason a declared kind exists.
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.askAdapter({ question: 'What level?', input: 'number' }));
    assert.strictEqual(p.submitTyped('about forty'), true, 'the line was consumed');
    assert.strictEqual(p.visible, true, 'and the question is STILL OPEN');
    assert.match(p.lastError, /is not a number/);
    assert.match(strip(p.render(70, 12)), /is not a number/, 'and the reason is on screen');
    // …and the correction is taken.
    p.submitTyped('40');
    assert.strictEqual(p.visible, false);
    assert.strictEqual(p.lastError, null, 'a refusal does not outlive the question');
  });

  await test('KIND: a TEXT question opens straight into typing — no list, no Other', async () => {
    const p = new panelMod.InteractionPanel();
    const done = p.open(panelMod.askAdapter({ question: 'What should it be called?', input: 'text' }));
    assert.strictEqual(p.takes, A.KIND.TEXT);
    assert.strictEqual(p.items.filter((i) => i.value !== undefined).length, 0);
    p.submitTyped('the reel handler');
    assert.strictEqual(await done, 'the reel handler');
  });

  await test('KIND: a CONFIRMATION is Y and N, and takes either spelling', async () => {
    const a = panelMod.askAdapter({ question: 'Overwrite it?', input: 'confirm' });
    const rows = a.items.filter((i) => i.value !== undefined).map((i) => i.label);
    assert.deepStrictEqual(rows, ['Y.  Yes', 'N.  No']);
    for (const [typed, want] of [['y', 'Yes'], ['Y', 'Yes'], ['yes', 'Yes'], ['n', 'No'], ['no', 'No']]) {
      const p = new panelMod.InteractionPanel();
      const done = p.open(panelMod.askAdapter({ question: 'Overwrite it?', input: 'confirm' }));
      p.submitTyped(typed);
      assert.strictEqual(await done, want, `${typed} should mean ${want}`);
    }
  });

  await test('KIND: a CONFIRMATION refuses a third answer rather than inventing one', async () => {
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.askAdapter({ question: 'Overwrite it?', input: 'confirm' }));
    p.submitTyped('maybe later');
    assert.strictEqual(p.visible, true, 'yes and no are the only two answers it has');
    assert.match(p.lastError, /not yes or no/);
  });

  await test('KIND: MULTI_SELECT marks with Space and sends what is marked', async () => {
    const p = new panelMod.InteractionPanel();
    const done = p.open(panelMod.askAdapter({
      question: 'Which checks?', options: ['unit', 'smoke', 'live'], input: 'multi',
    }));
    assert.strictEqual(p.takes, A.KIND.MULTI_SELECT);
    assert.match(p.items.find((i) => i.value === 'unit').label, /^\[ \] 1\./, 'unmarked to begin with');
    p.cursor = p.items.findIndex((i) => i.value === 'unit');
    p.shortcut(' ');
    assert.match(p.items.find((i) => i.value === 'unit').label, /^\[x\] 1\./, 'Space marks it');
    p.cursor = p.items.findIndex((i) => i.value === 'live');
    p.shortcut(' ');
    p.select({ key: 'enter' });
    assert.strictEqual(await done, 'unit, live');
  });

  await test('MULTI_SELECT: a typed list works too, and every token must resolve', async () => {
    const p = new panelMod.InteractionPanel();
    const done = p.open(panelMod.askAdapter({
      question: 'Which checks?', options: ['unit', 'smoke', 'live'], input: 'multi',
    }));
    // One bad token refuses the WHOLE line: half of what somebody meant,
    // silently accepted, is the same error as the wrong single choice.
    p.submitTyped('1, 9');
    assert.strictEqual(p.visible, true);
    assert.match(p.lastError, /not one of the choices/);
    p.submitTyped('1,3');
    assert.strictEqual(await done, 'unit, live');
  });

  await test('MULTI_SELECT: Enter with nothing marked is refused, not an empty answer', async () => {
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.askAdapter({ question: 'Which?', options: ['a', 'b'], input: 'multi' }));
    p.select({ key: 'enter' });
    assert.strictEqual(p.visible, true);
    assert.match(p.lastError, /nothing is marked/);
  });

  await test('KIND: "Other…" is added ONLY to a list of choices', async () => {
    // On a number question it is an option that cannot be typed; on a yes/no it
    // is a third answer to a two-answer question; on free text it is the thing
    // you are already doing. Appending it everywhere is how a surface comes to
    // offer what it cannot take.
    const A2 = A;
    for (const [input, options] of [['number', []], ['text', []], ['confirm', []], ['multi', ['a', 'b']]]) {
      const kind = A2.kindOf(input, options);
      assert.notStrictEqual(kind, A2.KIND.CHOICE, `${input} must not be a CHOICE`);
    }
    assert.strictEqual(A2.kindOf('choice', ['a']), A2.KIND.CHOICE);
    // And a "choice" with no options at all is a text question, because there
    // is nothing to choose between whatever was declared.
    assert.strictEqual(A2.kindOf('choice', []), A2.KIND.TEXT);
  });

  await test('KIND: an unknown input name falls back rather than breaking the question', async () => {
    assert.strictEqual(A.kindOf('bananas', ['a', 'b']), A.KIND.CHOICE);
    assert.strictEqual(A.kindOf(null, []), A.KIND.TEXT);
  });

  await test('OTHER PANELS ARE UNTOUCHED: only a question accepts typing', async () => {
    const p = new panelMod.InteractionPanel();
    p.open(panelMod.confirmAdapter({ question: 'Overwrite it?' }));
    assert.strictEqual(p.acceptsTyped, false);
    assert.strictEqual(p.submitTyped('yes'), false, 'a confirm must not be answerable by prose');
    assert.strictEqual(p.visible, true);
  });
};
