'use strict';

/**
 * A NORMAL TASK MUST NOT PRODUCE A WALL OF NARRATION.
 *
 * ------------------------------------------------------------------------
 * THE QUESTION THIS ANSWERS, and it is deliberately not "what percentage was
 * suppressed". A percentage can be excellent while the two sentences that got
 * through are the two most irritating ones a model writes. So this asserts on
 * an ENTIRE realistic transcript: exactly which sentences survive, and exactly
 * which do not.
 *
 * ------------------------------------------------------------------------
 * THE MEASURED DEFECT. From a real audit of this exact transcript, two lines
 * reached the screen that should not have:
 *
 *     "Let me reconsider - the parser is probably the issue here."
 *     "I think I should look at the serializer first before making any changes."
 *
 * ONE ROOT CAUSE WITH TWO FACES. The announcement patterns are anchored at
 * `^ LEAD INTENT`, and any opener outside `LEAD` defeats them — the sentence
 * then fell through to the hedge test and was PRESERVED as a hypothesis.
 *
 *   `Actually,` was not in LEAD, and ui/condense.js `prose` asks `isNarration`
 *     of the RAW line, BEFORE `trimSentences` strips the preface. So the
 *     classifier never saw the sentence without its marker.
 *   `I think` was not in LEAD either, so a hedge in front of an intention was
 *     read as a hedge about a claim.
 *
 * ------------------------------------------------------------------------
 * THE LINE THIS MUST NOT CROSS. A hedge in front of an INTENTION is an
 * intention; a hedge in front of a CLAIM is a hypothesis, and a hypothesis is
 * the most valuable thing a model writes. Both are asserted below, in both
 * directions, because a fix that suppressed the second would be worse than the
 * defect it replaced.
 */

const assert = require('assert');
const { test } = require('../helpers');

const classify = require('../../src/ui/classify');
const views = require('../../src/ui/views');
const feedcache = require('../../src/ui/feedcache');

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const kept = (t) => classify.renderPolicy(classify.classifySentence(t).class) !== classify.DECISION.SUPPRESS;

/** A transcript in the shape a real model actually produces. */
const TRANSCRIPT = [
  // ---- must GO: announcement, self-correction, hedged intention -----------
  ['go', 'I will start by looking at the project structure to understand the codebase.'],
  ['go', 'Let me check the test file to see what is failing.'],
  ['go', 'Actually, let me reconsider - the parser is probably the issue here.'],
  ['go', 'I think I should look at the serializer first before making any changes.'],
  ['go', 'I guess we could try the other loader.'],
  ['go', 'Now let me fix that.'],
  ['go', 'Let me run the tests to verify my change works correctly.'],
  ['go', 'Hmm.'],
  ['go', 'But wait.'],
  ['go', 'Ok, that makes sense.'],
  ['go', 'The user wants the failing tests fixed.'],
  // ---- must STAY: findings, hypotheses, blockers, errors, completions -----
  ['stay', 'The serializer still emits the legacy field.'],
  ['stay', 'The flag parses but is never dispatched.'],
  ['stay', 'I think the loader may be running twice because the registry is keyed by name.'],
  ['stay', 'This may indicate the loader is initialized twice.'],
  ['stay', 'The build failed with exit 1.'],
  ['stay', 'The tests pass.'],
  ['stay', 'Permission is required before modifying configuration.'],
  ['stay', 'Do you want me to keep the old loader, or remove it?'],
];

module.exports = async function () {
  await test('YAP: the filter is ON while the turn streams, not only once it is recorded', () => {
    // ---- THE DEFECT, AND IT IS THE ONE A PERSON ACTUALLY SEES -----------
    //
    // `condense.prose` defaults `last` to TRUE, deliberately: a message that is
    // ENTIRELY narration is kept when it is the final thing a turn said,
    // because a turn that appears to have said nothing reads as a failure.
    //
    // The RECORDED path passes `{ last: n === lastSaid }` and gets that right.
    // The LIVE path passed nothing, so every mid-turn announcement took the
    // cautious branch and was KEPT while the turn streamed — then vanished the
    // instant the turn ended and the recorded path drew it instead.
    //
    // The narration filter was therefore off during the only period anybody is
    // watching it work, which is why it kept testing correct.
    const older = { after: 0, at: 1, text: 'Let me check the loader.' };
    const newest = { after: 0, at: 2, text: 'The loader runs twice.' };

    feedcache.reset();
    const rows = views.activity({
      session: { turns: [] }, width: 90,
      liveNarration: [older, newest],
      liveActions: [{ name: 'read_file', target: 'a.js', ok: true }],
    }).map(strip).join(' ');

    assert.ok(!/Let me check the loader/.test(rows),
      'a mid-turn announcement must be suppressed WHILE STREAMING');
    assert.ok(/The loader runs twice/.test(rows), 'and the finding must survive');
  });

  await test('YAP: the newest paragraph is spared, and stops being spared when another arrives', () => {
    // The other half of the same rule. An announcement that is the model's
    // CURRENT last word stays — the screen must not look like nothing was said
    // — and goes as soon as anything follows it.
    const a = { after: 0, at: 1, text: 'Let me check the loader.' };
    const b = { after: 0, at: 2, text: 'Now let me fix it.' };
    const c = { after: 0, at: 3, text: 'The handler is registered twice.' };

    const draw = (live) => {
      feedcache.reset();
      return views.activity({ session: { turns: [] }, width: 90, liveNarration: live, liveActions: [] })
        .map(strip).join(' ');
    };

    assert.ok(/Now let me fix it/.test(draw([a, b])),
      'the current last word is kept even when it is pure announcement');
    assert.ok(!/Now let me fix it/.test(draw([a, b, c])),
      'and is dropped the moment it is no longer the last word');
    assert.ok(/registered twice/.test(draw([a, b, c])));
  });

  await test('YAP: every sentence of a realistic transcript lands on the right side', () => {
    const wrong = [];
    for (const [want, line] of TRANSCRIPT) {
      const survives = kept(line);
      if ((want === 'stay') !== survives) {
        const c = classify.classifySentence(line);
        wrong.push(`${want === 'stay' ? 'LOST' : 'LEAKED'}  [${c.class}] ${line}`);
      }
    }
    assert.deepStrictEqual(wrong, [], `\n${wrong.join('\n')}`);
  });

  await test('YAP: a hedge before an INTENTION goes; the same hedge before a CLAIM stays', () => {
    // The distinction the whole fix turns on. Same opener, opposite outcome,
    // decided by whether an intention follows it.
    assert.strictEqual(kept('I think I should look at the parser first.'), false, 'hedged intention');
    assert.strictEqual(kept('I think the parser is failing here.'), true, 'hedged claim');
    assert.strictEqual(kept('I guess we could try the other loader.'), false, 'hedged intention');
    assert.strictEqual(kept('I guess the loader is registered twice.'), true, 'hedged claim');
  });

  await test('YAP: a discourse marker cannot smuggle an announcement through', () => {
    // The ordering defect: classification used to run before the preface was
    // trimmed, so the marker hid the announcement behind it.
    for (const marker of ['Actually, ', 'Hmm, ', 'Wait, ', 'In fact, ', 'Honestly, ']) {
      assert.strictEqual(kept(`${marker}let me check the loader.`), false,
        `"${marker}" let an announcement through`);
    }
    // And it does not eat the sentence underneath when that sentence is real.
    assert.strictEqual(kept('Actually, the flag is never dispatched.'), true);
  });

  await test('YAP: the model deliberating about whether to ASK is not a question', () => {
    // ---- THE REPORTED BEHAVIOUR ----------------------------------------
    //
    // "the model appears to repeatedly ask itself questions, including things
    // resembling `Can I ask_user the user?` and then continues without actually
    // asking." That is deliberation with a question mark on it, addressed to
    // nobody — and it reads on screen as though LAIN were waiting for an answer
    // that nobody was ever asked for.
    //
    // The direct forms were already caught. THE HEDGED ONES WERE NOT, and a
    // model hedges constantly: `maybe`, `I wonder`, `is it worth`. Same
    // sentence, same non-question, three openers the pattern did not know.
    for (const line of [
      'Can I ask_user the user?',
      'Should I ask the user about this?',
      'Do I need to ask the user first?',
      'Maybe I should ask the user which one they want.',
      'I wonder if I should ask the user.',
      'Is it worth asking the user?',
      'Perhaps we should ask the user before continuing.',
    ]) {
      assert.strictEqual(kept(line), false, `self-deliberation reached the screen: ${line}`);
    }
  });

  await test('YAP: a real question TO the user survives all of that', () => {
    // THE LINE THIS MUST NOT CROSS, and it is the more expensive direction.
    // Suppressing a question somebody was waiting to be asked leaves LAIN
    // apparently working while it is actually blocked.
    for (const line of [
      'Do you want me to keep the old loader, or remove it?',
      'Should I use the recursive option, or delete the directory by hand?',
      'Is it worth asking you to confirm before I remove the old loader?',
    ]) {
      assert.strictEqual(kept(line), true, `a question addressed to the user was eaten: ${line}`);
    }
  });

  await test('YAP: a whole engineering turn shows only what was worth showing', () => {
    // The end-to-end question: can a normal task run without a wall of prose?
    feedcache.reset();
    const narration = TRANSCRIPT.map(([, text], i) => ({ step: i, text }));
    const rows = views.activity({
      session: {
        turns: [{
          userInput: 'fix the failing tests',
          text: 'done',
          narration,
          actions: [
            { name: 'list_dir', target: '.', ok: true },
            { name: 'read_file', target: 'src/parser.js', ok: true },
            { name: 'apply_patch', target: 'src/serializer.js', ok: true },
            { name: 'run_bash', target: 'npm test', ok: true },
          ],
        }],
      },
      width: 88,
    }).map(strip);

    const prose = rows.join(' ');
    for (const [want, line] of TRANSCRIPT) {
      const frag = line.replace(/[.?]$/, '').slice(0, 34);
      const there = prose.includes(frag);
      if (want === 'go') assert.ok(!there, `narration reached the feed: ${line}`);
      else assert.ok(there, `something worth saying was lost: ${line}`);
    }
    // And the tool account is still there — suppressing prose must not suppress
    // the record of what actually happened.
    assert.ok(/patched · src\/serializer\.js/.test(prose), 'the edit must still be reported');
    // `verb · subject`, and the verb of a shell command is its PROGRAM - the word
    // `Ran` said only that something ran, which every row on the screen shares.
    // See ui/phrasing.js.
    assert.ok(/npm · test/.test(prose), 'the command must still be reported');
  });
};
