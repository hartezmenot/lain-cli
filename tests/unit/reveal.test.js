'use strict';

/**
 * PROSE THAT RESOLVES — presented rather than dumped.
 *
 * The two properties that matter are IT ENDS EXACTLY WHERE IT STARTED (nothing
 * is invented, nothing is left corrupted) and IT IS PURE OF THE CLOCK (a frame
 * drawn twice is the same frame, or ui/layout.js's identical-frame suppression
 * would be writing the screen sixty times a second for ever).
 */

const assert = require('assert');
const { test } = require('../helpers');

const reveal = require('../../src/ui/reveal');

/** A newline, as a value — these files are written without literal escapes. */
const NL = String.fromCharCode(10);

const TEXT = 'The runner stopped without a crash trace, and the supervisor never restarted it.';

module.exports = async function () {
  await test('MOTION: prose never jumps — no frame adds more than a fair share at once', () => {
    // ---- THE FORBIDDEN SHAPE ---------------------------------------------
    //
    //   animate briefly -> instantly show the rest
    //
    // Stated as a measurement rather than as an intention: walk the whole
    // reveal a frame at a time and look at how much SETTLED TEXT each frame
    // added. A teleport is one frame that adds most of the paragraph.
    const long = new Array(60).fill('the loader reads the manifest').join(' and ');
    const total = reveal.duration(long);
    let prev = 0;
    let worst = 0;
    for (let t = 0; t <= total; t += 12) {
      // Count only characters that have SETTLED — an unsettled glyph is not
      // text arriving, and counting it would score the effect as progress.
      const shown = reveal.resolve(long, 1000, 1000 + t);
      let settled = 0;
      while (settled < shown.length && shown[settled] === long[settled]) settled += 1;
      worst = Math.max(worst, settled - prev);
      prev = settled;
    }
    const share = worst / long.length;
    assert.ok(share < 0.25,
      `no single frame may deliver a quarter of the text: ${(share * 100).toFixed(1)}%`);
    assert.strictEqual(reveal.resolve(long, 1000, 1000 + total), long, 'and it all arrives');
  });

  await test('MOTION: the reveal front is RAGGED, not a solid block sliding along', () => {
    // A band in which every character is scrambled reads as one moving object.
    // The wave settles characters at slightly different moments, so at a given
    // instant the front contains both kinds. Asserted by finding a settled
    // character with an unsettled one after it.
    const line = 'the loader reads the manifest but the writer never sees the field';
    const total = reveal.duration(line);
    let ragged = false;
    for (let t = 40; t < total && !ragged; t += 8) {
      const shown = reveal.resolve(line, 1000, 1000 + t);
      for (let i = 0; i + 1 < shown.length; i++) {
        if (shown[i] === line[i] && shown[i + 1] !== line[i + 1]
            && /[A-Za-z0-9]/.test(line[i]) && /[A-Za-z0-9]/.test(line[i + 1])) { ragged = true; break; }
      }
    }
    assert.ok(ragged, 'settled and unsettled characters coexist in the front');
  });

  await test('MOTION: a long paragraph takes proportionally longer to reach halfway', () => {
    // The other half of "no teleport": the reveal must progress THROUGH the
    // content rather than finishing early and idling. Halfway in time should
    // be near halfway in text, whatever the length.
    for (const n of [10, 100, 400]) {
      const text = new Array(n).fill('word').join(' ');
      const total = reveal.duration(text);
      const half = reveal.resolve(text, 1000, 1000 + Math.round(total / 2));
      const frac = half.length / text.length;
      assert.ok(frac > 0.3 && frac < 0.7,
        `${n} words: at half the time, ${(frac * 100).toFixed(0)}% of the text`);
    }
  });

  // ---- THE HANDOVER, WHICH IS WHERE THE MAGICIAN EFFECT LIVED ------------

  await test('REVEAL: prose keeps resolving across the end of its own turn', () => {
    // ---- THE DEFECT, and it is not in resolve() ---------------------------
    //
    // A paragraph begins to resolve and a fraction of a second later the rest
    // of it is simply THERE. `resolve` is a pure function of (text, said-at,
    // now) and behaves perfectly; what failed was the HANDOVER. The live copy
    // of a turn's prose is cleared by ui/story.js `endTurn` the instant the
    // turn record lands, and the record carried no stamp — so the presentation
    // lost the one input it is a function of, and snapped to full.
    const conv = require('../../src/ui/conversation');
    const feedcache = require('../../src/ui/feedcache');
    const now = 1000000;
    const text = 'The implementation exists, but the route is not wired. '
      + 'The runtime path is missing its dispatch.';
    // The turn record, as src/turn.js now writes it: stamped.
    const session = { turns: [{ userInput: 'go', text, narration: [{ step: 0, text, at: now - 80 }], actions: [] }] };
    const draw = (at) => {
      feedcache.reset();
      return conv.activity({ session, width: 100, reveal: (t, said) => reveal.resolve(t, said, at) }).join(NL);
    };

    const early = draw(now);
    assert.ok(!early.includes('missing its dispatch'),
      `it is still arriving, not already whole:${NL}${early}`);
    assert.notStrictEqual(early.trim(), '', 'and something of it is on screen');

    const later = draw(now + reveal.MAX_MS + 500);
    assert.ok(later.includes('missing its dispatch'), 'and it does arrive in full');
  });

  await test('REVEAL: a record with NO stamp is drawn settled, never replayed', () => {
    // Every session saved before the stamp existed. Unknown means unknown, and
    // guessing "just arrived" would replay an hour-old paragraph on resume.
    const conv = require('../../src/ui/conversation');
    require('../../src/ui/feedcache').reset();
    const text = 'The dispatcher never fires.';
    const session = { turns: [{ userInput: 'go', text, narration: [{ step: 0, text }], actions: [] }] };
    const drawn = conv.activity({
      session, width: 100, reveal: (t, said) => reveal.resolve(t, said, Date.now()),
    }).join(NL);
    assert.ok(drawn.includes(text), `an unstamped record is settled text:${NL}${drawn}`);
  });

  await test('REVEAL: draining for teardown settles the prose instead of freezing it', () => {
    // Seen on the last frame of a real session: `░|=*#! +@▓` where the answer
    // should have been. There is no next frame at teardown, so anything still
    // moving is what the user is left looking at.
    const { ActivitySurface } = require('../../src/ui/activity');
    const now = 2000000;
    const a = new ActivitySurface({ now: () => now });
    const text = 'Backend wiring is missing.';
    assert.notStrictEqual(a.reveal(text, now - 10, now), text, 'mid-flight it is still resolving');
    a.drain();
    assert.strictEqual(a.reveal(text, now - 10, now), text, 'drained, it is exactly what was said');
    assert.strictEqual(a.revealing([{ text, at: now - 10 }], now), false,
      'and the redraw clock is told there is nothing left to do');
  });

  await test('REVEAL: it ends as EXACTLY the text that went in', () => {
    const d = reveal.duration(TEXT);
    assert.strictEqual(reveal.resolve(TEXT, 1000, 1000 + d), TEXT);
    assert.strictEqual(reveal.resolve(TEXT, 1000, 1000 + d + 5000), TEXT);
  });

  await test('REVEAL: it grows, and never shrinks', () => {
    const d = reveal.duration(TEXT);
    let last = -1;
    for (let t = 0; t <= d; t += 10) {
      const n = reveal.resolve(TEXT, 1000, 1000 + t).length;
      assert.ok(n >= last, `it never goes backwards: ${last} -> ${n}`);
      last = n;
    }
    assert.strictEqual(reveal.resolve(TEXT, 1000, 1000 + d).length, TEXT.length);
  });

  await test('REVEAL: what is settled behind the band is the REAL text', () => {
    // The scramble is a band at the leading edge, not a wash over everything.
    // Anything more than BAND characters back must already be the truth.
    const d = reveal.duration(TEXT);
    for (let t = 40; t < d; t += 25) {
      const out = reveal.resolve(TEXT, 1000, 1000 + t);
      const settled = Math.max(0, out.length - reveal.BAND);
      assert.strictEqual(out.slice(0, settled), TEXT.slice(0, settled),
        `settled text must be true at t=${t}`);
    }
  });

  await test('REVEAL: only letters and digits are ever unsettled', () => {
    // Punctuation and whitespace carry the shape of the sentence and the width
    // of the row. Scrambling those would move the wrapping under the reader.
    const d = reveal.duration(TEXT);
    for (let t = 20; t < d; t += 15) {
      const out = reveal.resolve(TEXT, 1000, 1000 + t);
      for (let i = 0; i < out.length; i++) {
        if (out[i] === TEXT[i]) continue;
        assert.ok(/[A-Za-z0-9]/.test(TEXT[i]), `only alphanumerics change, not ${JSON.stringify(TEXT[i])}`);
      }
    }
  });

  await test('REVEAL: every unsettled glyph is one cell wide', () => {
    // ui/text.js measures a row by counting characters. A double-width glyph
    // would make every width calculation on that row wrong and tear the frame.
    const T = require('../../src/ui/text');
    assert.strictEqual(T.width(reveal.GLYPHS), reveal.GLYPHS.length);
  });

  await test('REVEAL: a frame drawn twice is the same frame', () => {
    const d = reveal.duration(TEXT);
    for (let t = 0; t <= d; t += 37) {
      assert.strictEqual(reveal.resolve(TEXT, 1000, 1000 + t), reveal.resolve(TEXT, 1000, 1000 + t));
    }
  });

  await test('REVEAL: paragraphs arrive IN ORDER, and the second waits for the first', () => {
    const a = 'The parser accepts the legacy field.';
    const b = 'The serializer still emits it.';
    const text = `${a}\n\n${b}`;
    const d = reveal.duration(text);
    // Part way through, the first paragraph is complete and the second has not
    // begun — which is what the extra cost of a blank line buys.
    let sawFirstAlone = false;
    for (let t = 0; t < d; t += 10) {
      const out = reveal.resolve(text, 1000, 1000 + t);
      if (out.startsWith(a) && !out.includes(b.slice(0, 6))) sawFirstAlone = true;
      if (out.includes(b.slice(0, 6))) {
        assert.ok(out.startsWith(a), 'the second paragraph never arrives before the first is done');
      }
    }
    assert.ok(sawFirstAlone, 'there is a moment where only the first paragraph is on screen');
  });

  await test('REVEAL: marked text arrives WHOLE LINES at a time', () => {
    // A half-written ``` is not a presentation of anything, and the renderer
    // downstream must always see complete lines.
    const text = ['## Result', '', '```js', 'const x = 1;', '```', '', 'It passes.'].join('\n');
    assert.ok(reveal.marked(text));
    const d = reveal.duration(text);
    const src = text.split('\n');
    for (let t = 0; t <= d; t += 9) {
      const out = reveal.resolve(text, 1000, 1000 + t);
      if (!out) continue;
      const got = out.split('\n');
      for (let i = 0; i < got.length; i++) {
        assert.strictEqual(got[i], src[i], `line ${i} arrives whole at t=${t}`);
      }
    }
    assert.strictEqual(reveal.resolve(text, 1000, 1000 + d), text);
  });

  await test('REVEAL: it is FAST — a long answer is resolved inside the cap', () => {
    const long = TEXT.repeat(40);
    assert.ok(reveal.duration(long) <= reveal.MAX_MS,
      `capped: ${Math.round(reveal.duration(long))}ms`);
    assert.strictEqual(reveal.resolve(long, 1000, 1000 + reveal.MAX_MS), long);
  });

  await test('REVEAL: with no stamp it is already settled', () => {
    // A record from before this existed. Unknown means unknown — guessing "just
    // arrived" would replay an old paragraph every time the screen redrew.
    assert.strictEqual(reveal.resolve(TEXT, 0, 999999), TEXT);
  });

  await test('REVEAL: pending() tells the ticker when there is still motion', () => {
    const entries = [{ text: TEXT, at: 1000 }];
    assert.strictEqual(reveal.pending(entries, 1010), true);
    assert.strictEqual(reveal.pending(entries, 1000 + reveal.MAX_MS + 100), false);
    assert.strictEqual(reveal.pending([{ text: TEXT }], 999999), false, 'an unstamped record is settled');
    assert.strictEqual(reveal.pending([], 1), false);
  });

  await test('REVEAL: the surface honours instant, so a pipe gets the settled text', () => {
    const { ActivitySurface } = require('../../src/ui/activity');
    const still = new ActivitySurface({ instant: true, now: () => 1000 });
    assert.strictEqual(still.reveal(TEXT, 1000, 1000), TEXT);
    assert.strictEqual(still.revealing([{ text: TEXT, at: 1000 }], 1001), false);
  });
};
