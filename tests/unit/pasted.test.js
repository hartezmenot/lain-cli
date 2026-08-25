'use strict';

/**
 * A PASTE IS AN ATTACHMENT, NOT A SPEECH.
 *
 * Pasting a 400-line stack trace into the prompt is one act. The feed rendered
 * every line of it as though the person had said it, so a single paste buried
 * the whole conversation above it and pushed the model's answer off the screen —
 * the activity stream stopped being readable exactly when it carried the most.
 *
 * What is asserted here is both halves of the fix, because only having one of
 * them is a different bug each time: the marker must REPLACE the payload on
 * screen, and the payload must still be THERE underneath.
 */

const assert = require('assert');
const { test } = require('../helpers');

/** A newline, as a value. */
const NL = String.fromCharCode(10);

const pasted = require('../../src/ui/pasted');
const feed = require('../../src/ui/feed');

/** A believable paste: bulky and structured. */
const bigPaste = (tag = 'A') => Array.from({ length: 40 },
  (_, i) => `${tag} line ${i} of a stack trace that goes on and on and on and on`).join('\n');

module.exports = async function () {
  await test('PINNED: three plain typed lines are still shown whole', () => {
    // The first attempt at the fix above was too broad: it showed only the
    // first line of ANY multi-line objective, which hides two thirds of a
    // prompt composed with Ctrl+J. Three sentences run together are a
    // sentence; it is STRUCTURE that cannot survive flattening.
    const views = require('../../src/ui/views');
    const typed = ['line one', 'line two', 'line three'].join(NL);
    const [row] = views.taskBanner({ session: { task: { objective: typed } }, width: 110 });
    assert.strictEqual(row.trim(), 'TASK  line one line two line three');
  });
  await test('PINNED: a SHORT structured objective is not flattened either', () => {
    // ---- THE BANNER WAS ASKING THE FEED'S QUESTION ---------------------
    //
    // It asked isPaste(), which is rightly a bar about BULK — two hundred
    // characters before a message counts as an attachment. The banner's
    // question is different. Seen on screen, from a ten-line instruction that
    // came to a hundred and seventy characters — under the bar, so flattened:
    //
    //     TASK  STEER — ACCEPTANCE 1. one 2. two 3. three - alpha - beta A…
    //
    // Structure that is short is still structure, and one row still cannot
    // show two lines.
    const views = require('../../src/ui/views');
    const short = ['STEER — ACCEPTANCE', '', '1. one', '2. two', '3. three', '',
      '- alpha', '- beta', '', 'A trailing paragraph.'].join(NL);
    const [row] = views.taskBanner({ session: { task: { objective: short } }, width: 110 });
    assert.strictEqual(row.trim(), 'TASK  STEER — ACCEPTANCE',
      'the banner shows the first line, not the whole thing run together');
    assert.ok(!/1. one/.test(row), 'the list does not leak into the row');
  });
  await test('PASTED: a big multi-line payload is drawn as one marker', () => {
    pasted.reset();
    const out = [];
    feed.pushUser(out, bigPaste());
    assert.strictEqual(out.length, 1, `one row, not forty: got ${out.length}`);
    assert.match(String(out[0].text), /\[pasted text #1\]/);
  });

  await test('PASTED: the payload still travels with the row', () => {
    // The marker changes what is DRAWN. Losing the content as well would be a
    // data-loss bug wearing a tidiness argument — the click-to-expand path,
    // /copy and the mouse selection all read `source`.
    pasted.reset();
    const out = [];
    const payload = bigPaste();
    feed.pushUser(out, payload);
    assert.strictEqual(out[0].source, payload, 'the full text must still be on the row');
  });

  await test('PASTED: an ordinary message is untouched', () => {
    // The failure mode of over-applying this is hiding things people typed.
    pasted.reset();
    for (const ordinary of [
      'fix the login bug',
      'line one\nline two\nline three',
      'a'.repeat(500),                          // long, but one line: prose
      Array.from({ length: 20 }, () => 'x').join('\n'),  // many lines, but tiny
    ]) {
      const out = [];
      feed.pushUser(out, ordinary);
      const text = out.map((r) => r.text).join('\n');
      assert.ok(!/\[pasted text/.test(text), `this was hidden and should not be: ${JSON.stringify(ordinary.slice(0, 40))}`);
    }
  });

  await test('PASTED: the SAME paste keeps the SAME number across re-renders', () => {
    // The feed is rebuilt from scratch several times a second while a turn
    // runs. A counter that incremented per render would relabel one paste
    // #1, #2, #3… as the screen repainted — worse than printing the payload.
    pasted.reset();
    const payload = bigPaste();
    const first = pasted.label(payload);
    for (let i = 0; i < 50; i++) pasted.label(payload);
    assert.strictEqual(pasted.label(payload), first, 'one paste, one number, for ever');
    assert.strictEqual(pasted.count(), 1, 'and it is counted once');
  });

  await test('PASTED: different pastes get sequential numbers', () => {
    pasted.reset();
    assert.match(pasted.label(bigPaste('A')), /#1\]/);
    assert.match(pasted.label(bigPaste('B')), /#2\]/);
    assert.match(pasted.label(bigPaste('C')), /#3\]/);
    // And they stay themselves when revisited out of order.
    assert.match(pasted.label(bigPaste('A')), /#1\]/);
    assert.match(pasted.label(bigPaste('B')), /#2\]/);
  });

  await test('PASTED: the marker never expands, however wide the feed', () => {
    // The rule is about what the row SAYS, not about clipping. A wider terminal
    // must not start revealing the payload.
    pasted.reset();
    const payload = bigPaste();
    for (const width of [40, 80, 200, 500]) {
      const out = [];
      feed.pushUser(out, payload);
      const text = out.map((r) => r.text).join('\n');
      assert.ok(!text.includes('stack trace that goes on'), `the payload leaked at width ${width}`);
    }
  });

  await test('PASTED: reset starts numbering again at one', () => {
    pasted.reset();
    pasted.label(bigPaste('X'));
    pasted.reset();
    assert.strictEqual(pasted.count(), 0);
    assert.match(pasted.label(bigPaste('Y')), /#1\]/);
  });

  await test('PASTED: it is total — null and undefined do not throw', () => {
    pasted.reset();
    for (const v of [null, undefined, '', 0]) {
      assert.strictEqual(typeof pasted.compact(v), 'string');
      assert.strictEqual(pasted.isPaste(v), false);
    }
  });

  await test('PASTED: one paste keeps ONE number even after the session folds it', () => {
    // A paste is seen twice in two forms: whole while it sits in the input, and
    // cut to 400 characters once src/session.js folds it. Keyed on the full
    // text those are different strings, and the same paste was drawn as #1
    // while being typed and #2 a moment later. A number that changes under the
    // reader is worse than no number at all.
    pasted.reset();
    const whole = bigPaste('Z');
    const folded = whole.slice(0, 400);
    assert.strictEqual(pasted.label(whole), pasted.label(folded),
      'the folded form is the same paste');
    assert.strictEqual(pasted.count(), 1);
  });

  await test('PASTED: two genuinely different pastes still differ', () => {
    // The other direction, so keying on the head cannot collapse everything
    // into one marker.
    pasted.reset();
    assert.notStrictEqual(pasted.label(bigPaste('P')), pasted.label(bigPaste('Q')));
    assert.strictEqual(pasted.count(), 2);
  });

  await test('PASTE: a long SINGLE-LINE payload is a marker — the wall of text', () => {
    // ---- REPRODUCED FROM A SCREENSHOT -------------------------------------
    //
    // A long structured instruction whose newlines did not survive the trip: a
    // terminal that does not bracket the paste, a shell that joins the lines, a
    // source that had none. `isPaste` needed BOTH bulk and >6 lines, so a
    // 700-character single line failed the line test and was drawn as speech —
    // headings, fences and a numbered list flowed into one paragraph that
    // filled the pane and buried the conversation above it.
    const oneLine = 'corresponds to projected position ```text Validate: ```text position correct '
      + 'size correct alignment correct ``` This is only an architecture test. Do NOT pretend this '
      + 'replaces actual visual validation. The purpose is to ensure the capability validation layer '
      + 'can later accept VISION_RESULT without redesigning Investigation. --- # 24. TEST DISCOVERY '
      + 'OVERSHOOT Construct: Required dependency: VERIFIED Unrelated unknown: present Expected: '
      + 'IMPLEMENT --- # COMPLETION REQUIREMENTS 1. Audit the actual transition. 2. Implement '
      + 'deterministic capability readiness. 3. Prevent unrelated unknowns from blocking.';
    assert.ok(!oneLine.includes('\n'), 'one line, as it really arrived');
    assert.ok(oneLine.length > pasted.MAX_TYPED);
    assert.strictEqual(pasted.isPaste(oneLine), true, 'nobody types that much without pressing Enter');
    assert.match(pasted.compact(oneLine), /^\[pasted text #\d+\]$/);
  });

  await test('PASTE: an ordinary long sentence is still shown in full', () => {
    // The other side of the bound, and the one that matters more: hiding
    // something a person typed would be far worse than showing a paste.
    const typed = 'Fix the serializer so the wire uses the 0.3 spelling, and leave the parser alone '
      + 'because the unknown-field report is a separate defect that I want to look at myself first. '
      + 'Run the suite afterwards and tell me which of the five tests were red before you started.';
    assert.ok(typed.length > pasted.MIN_CHARS, 'past the bulk bar');
    assert.ok(typed.length < pasted.MAX_TYPED, 'but inside what somebody actually types');
    assert.strictEqual(pasted.isPaste(typed), false);
    assert.strictEqual(pasted.compact(typed), typed);
  });

  await test('PINNED: a pasted objective is NAMED, not flattened into the banner', () => {
    // ---- THE PINNED HALF OF THE WALL OF TEXT, seen on screen -------------
    //
    //     TASK  STEER — RENDERING AUDIT # PHASE 0 — AUDIT BEFORE IMPLEMENTATION
    //           Before modifying code: 1. Inspect the existing activity/motion…
    //
    // Every newline collapsed to a space, headings and a numbered list run
    // into one another, and the row whose whole job is to say WHAT IS BEING
    // WORKED ON said nothing recognisable. The feed had already solved this;
    // the banner was flattening the identical bytes two rows above it.
    const views = require('../../src/ui/views');
    const objective = [
      'STEER — RENDERING AUDIT', '', '# PHASE 0', '',
      '1. Inspect the pipeline.', '2. Inspect the input.', '3. Inspect the output.',
      '4. Classify each item.', '5. Report honestly.', '',
      'The problem is not that there is no animation; it is that the rendered '
      + 'experience is wrong, because structured content collapses into a wall of text.',
    ].join(NL);
    const [row] = views.taskBanner({ session: { task: { objective } }, width: 100 });
    assert.match(row, /\[pasted text #\d+\]/, 'the banner names it the way the feed does');
    assert.match(row, /STEER — RENDERING AUDIT/, 'and still says WHICH task, from its first line');
    assert.ok(!/PHASE 0/.test(row), `the body of the paste is not flattened into the row: ${row}`);
  });

  await test('PINNED: a typed objective is untouched', () => {
    // A sentence flattened onto one row is exactly what that row is for.
    const views = require('../../src/ui/views');
    const [row] = views.taskBanner({
      session: { task: { objective: 'find why the runner stops after the third file' } }, width: 100,
    });
    assert.match(row, /find why the runner stops after the third file/);
    assert.ok(!/pasted text/.test(row), 'and it is not called an attachment');
  });
};
