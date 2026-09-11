'use strict';

/**
 * `[object Object]` MUST NEVER REACH A DIAGNOSTIC EXPORT.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, QUOTED FROM A REAL `/copy context`:
 *
 *     USER (mid-turn)
 *     [object Object]
 *
 *     USER (mid-turn)
 *     [object Object]
 *
 * `steerTexts` is named for what it once held. turn.js pushes `{ step, text }`
 * RECORDS, and the projection treated each entry as a string — so the one
 * sentence the export exists to carry was replaced by the shape of its box.
 *
 * IT PASSED ITS TESTS THE WHOLE TIME, because the fixture used plain strings:
 * a shape the writer does not write. Every case below is built from the shape
 * `turn.js` actually produces, or from a deliberately hostile one.
 */

const assert = require('assert');
const { test } = require('../helpers');

const copysummary = require('../../src/copysummary');

/** A session in the shape turnclose.js persists. */
function sessionWith(steerTexts, extra = {}) {
  return {
    cwd: '/proj',
    task: { objective: 'centre the pay button' },
    plan: { steps: [] },
    turns: [{
      turnId: 't1',
      userInput: 'the pay button is stuck on the left',
      from: null,
      text: 'Centred it.',
      actions: [],
      narration: [],
      steerTexts,
      reasoning: 'PRIVATE: the user probably means the flex container',
      errors: [],
      stopReason: 'end',
      ...extra,
    }],
  };
}

const appFor = (session) => ({ session, checkpoints: null, pendingCompletion: null });

module.exports = async function () {
  // --------------------------------------------------------- publicText --

  await test('PROJECTION: a steer record yields its text, not its shape', () => {
    assert.strictEqual(copysummary.publicText({ step: 3, text: 'keep the format' }), 'keep the format');
    assert.strictEqual(copysummary.publicText('a plain string'), 'a plain string');
  });

  await test('PROJECTION: an object with no public text yields NOTHING', () => {
    // OMISSION, never stringification. There is no honest rendering of an
    // internal marker, and `[object Object]` hands somebody debugging their
    // own code a fact about LAIN's internals instead of what they typed.
    for (const internal of [{ step: 1 }, {}, { id: 7, kind: 'MARKER' }, { count: 2 }]) {
      assert.strictEqual(copysummary.publicText(internal), '', JSON.stringify(internal));
    }
  });

  await test('PROJECTION: malformed and unknown entries yield NOTHING, never throw', () => {
    for (const junk of [null, undefined, {}, [], () => {}, Symbol('x'), new Map(), new Date(0)]) {
      let out;
      assert.doesNotThrow(() => { out = copysummary.publicText(junk); }, String(String(junk)));
      assert.strictEqual(typeof out, 'string');
      assert.ok(!/\[object /.test(out), `${String(junk)} produced ${out}`);
    }
  });

  await test('PROJECTION: an attachment-shaped payload contributes only its text parts', () => {
    const parts = [{ text: 'look at this' }, { image: 'BASE64…' }, { text: 'please' }];
    assert.strictEqual(copysummary.publicText(parts), 'look at this please');
    // And a payload that is ALL binary contributes nothing at all.
    assert.strictEqual(copysummary.publicText([{ image: 'BASE64…' }, { blob: 'x' }]), '');
  });

  // ------------------------------------------------- /copy context ------

  await test('CONTEXT: a real steer record appears as its sentence', () => {
    const out = copysummary.context(appFor(sessionWith([{ step: 2, text: 'keep it working on mobile' }])));
    assert.match(out, /USER \(mid-turn\)/);
    assert.match(out, /keep it working on mobile/);
    assert.ok(!/\[object Object\]/.test(out), out);
  });

  await test('CONTEXT: an internal-only record is OMITTED, heading and all', () => {
    // Not "rendered as blank" — absent. A heading over nothing is a claim that
    // something was said.
    const out = copysummary.context(appFor(sessionWith([{ step: 1 }, { kind: 'INTERNAL' }])));
    assert.ok(!/USER \(mid-turn\)/.test(out), out);
    assert.ok(!/\[object Object\]/.test(out), out);
  });

  await test('CONTEXT: a mixed list keeps the real ones and drops the rest', () => {
    const out = copysummary.context(appFor(sessionWith([
      { step: 1, text: 'first correction' },
      { step: 2 },
      'a bare string steer',
      { step: 4, text: '   ' },
      { step: 5, text: 'last correction' },
    ])));
    const headings = (out.match(/USER \(mid-turn\)/g) || []).length;
    assert.strictEqual(headings, 3, `expected 3 mid-turn entries, got ${headings}\n${out}`);
    for (const kept of ['first correction', 'a bare string steer', 'last correction']) {
      assert.ok(out.includes(kept), `${kept} was dropped`);
    }
    assert.ok(!/\[object Object\]/.test(out), out);
  });

  await test('CONTEXT: hidden reasoning is still never exported', () => {
    const out = copysummary.context(appFor(sessionWith([{ step: 1, text: 'ok' }])));
    assert.ok(!/PRIVATE:/.test(out), 'the model private working reached the clipboard');
    assert.ok(!/probably means the flex container/.test(out));
  });

  await test('CONTEXT: no system prompt, at the projection layer', () => {
    // `session.messages` is the PROVIDER WIRE FORMAT. The projection must not
    // read it at all, whatever is in it.
    const s = sessionWith([{ step: 1, text: 'ok' }]);
    s.messages = [{ role: 'system', content: 'a large system prompt nobody wants pasted' }];
    assert.ok(!/system prompt nobody wants/.test(copysummary.context(appFor(s))), 'the wire format leaked');
  });

  await test('CONTEXT: ANSI is stripped by the layer that OWNS that rule', async () => {
    // ---- ASSERTED WHERE THE GUARANTEE LIVES ---------------------------
    //
    // The first version of this called `copysummary.context` directly and
    // failed — correctly. The projection does not strip control bytes and
    // should not: `copy.js` `sanitize` is the ONE owner of "nothing with an
    // escape byte reaches the clipboard or a file", and `collect` applies it to
    // every section. A second implementation here would be a second answer to
    // the same question, which is the duplication this codebase's architecture
    // guards exist to prevent.
    //
    // So the assertion moved to the path a person actually invokes.
    const copy = require('../../src/copy');
    const ESC = String.fromCharCode(27);
    const s = sessionWith([{ step: 1, text: ESC + '[31mred' + ESC + '[0m steer' }]);
    const got = await copy.collect(appFor(s), 'context');
    assert.ok(got.text, got.error || 'nothing came back');
    assert.ok(!got.text.includes(ESC), 'an escape sequence reached the export');
    assert.match(got.text, /red steer/, 'and the words survived the stripping');
  });

  // ------------------------------------------------------- /copy --------

  await test('SUMMARY: STEERS shows the sentence, and drops internal records', () => {
    const out = copysummary.summary(appFor(sessionWith([
      { step: 1, text: 'keep the format' },
      { step: 2 },
    ])));
    assert.match(out, /^STEERS$/m);
    assert.match(out, /⚑ keep the format/);
    assert.ok(!/\[object Object\]/.test(out), out);
  });

  await test('SUMMARY: with only internal records there is no STEERS section', () => {
    const out = copysummary.summary(appFor(sessionWith([{ step: 1 }, { step: 2 }])));
    assert.ok(!/^STEERS$/m.test(out), `an empty heading claims something was said:\n${out}`);
    // The rest of the summary is unaffected.
    assert.match(out, /^USER REQUEST$/m);
    assert.match(out, /^RESULT$/m);
  });

  await test('SUMMARY: the accepted shape is unchanged by this fix', () => {
    // §J — do not regress /copy while fixing /copy context.
    const out = copysummary.summary(appFor(sessionWith([{ step: 1, text: 'keep the format' }])));
    for (const heading of ['USER REQUEST', 'RESULT']) {
      assert.match(out, new RegExp(`^${heading}$`, 'm'), heading);
    }
    for (const banned of [/READY/, /\d\d:\d\d:\d\d/, /spinner/i, /token/i, /PRIVATE:/]) {
      assert.ok(!banned.test(out), `${banned} reached the summary:\n${out}`);
    }
  });
};
