'use strict';

/**
 * NARRATION THE SCREEN ALREADY SAYS — dropped, and only that.
 *
 * These are as much about what the filter must NOT touch as about what it
 * removes. Editing a model's words is a serious thing to do; a filter that
 * quietly eats a finding is far worse than one that leaves a redundant
 * sentence, so most of what is asserted here is restraint.
 */

const assert = require('assert');
const { test } = require('../helpers');

const condense = require('../../src/ui/condense');

const drops = (s) => assert.ok(condense.isNarration(s), `should drop: ${s}`);
const keeps = (s) => assert.ok(!condense.isNarration(s), `must KEEP: ${s}`);

module.exports = async function () {
  await test('CONDENSE: a monologue seam riding on a FINDING is trimmed, not dropped', () => {
    // ---- FOUND ON A CAPTURED ACCEPTANCE FRAME ---------------------------
    //
    // The model wrote:
    //
    //     Let me reconsider. Hmm. Actually, the --zerotier flag parses, but
    //     run() never dispatches to zerotier.connect().
    //
    // The first two sentences went. The third stayed — correctly, it carries
    // the finding — but kept its `Actually,`, a word that says only "I am
    // revising my thinking out loud", attached to the one sentence in the
    // message worth reading.
    const said = 'Let me reconsider. Hmm. Actually, the --zerotier flag parses, '
      + 'but run() never dispatches to zerotier.connect().';
    assert.strictEqual(condense.prose(said, { last: false }),
      'The --zerotier flag parses, but run() never dispatches to zerotier.connect().');
  });

  await test('CONDENSE: the COMMA is what makes a seam word a seam', () => {
    // "Actually, the flag parses" is somebody revising out loud. "Actually
    // running the tests is the next step" is an ADVERB modifying a verb, and
    // trimming that rewrites the sentence rather than tidying it.
    assert.strictEqual(condense.unpreface('Actually, the flag parses.'), 'The flag parses.');
    assert.strictEqual(condense.unpreface('Hmm, the loader runs twice.'), 'The loader runs twice.');
    assert.strictEqual(condense.unpreface('But wait, the handler is registered twice.'),
      'The handler is registered twice.');
    for (const keep of [
      'Actually running the tests is the next step.',
      'Wait for the build to finish before testing.',
      'However, the loader runs twice.',
    ]) assert.strictEqual(condense.unpreface(keep), keep, 'must not trim: ' + keep);
  });

  await test('CONDENSE: a trimmed sentence never grows an "undefined" prefix', () => {
    // The two families had a leading-whitespace capture EACH, so whichever
    // branch did not match left its group undefined — and the rebuilt sentence
    // began with the literal string "undefined". A capture that only sometimes
    // exists is a capture the caller has to guess about.
    for (const s of [
      'Actually, the flag parses.',
      'Also worth noting the loader runs twice.',
      'Hmm, the dispatch table is empty.',
      'Interestingly, the handler is registered twice.',
    ]) {
      assert.ok(!/undefined/.test(condense.unpreface(s)), 'clean trim of: ' + s);
    }
  });

  await test('CONDENSE: a hedge does not turn an announcement into a finding', () => {
    // The brief asks for the CLASS to be detected rather than a phrase list.
    // These are all the same move — an opener from the closed list, a verb from
    // the closed list — worn tentatively. The hedge is the only difference.
    drops('I should probably check the loader.');
    drops('Perhaps we should check the serializer.');
    drops('Maybe I should look at the parser.');
    drops('We could try reading the manifest.');
    drops('Possibly I will read the runner log.');
  });

  await test('CONDENSE: a HEDGED FINDING is never touched — certainty is not invented', () => {
    // ---- THE LINE THIS MUST NOT CROSS ------------------------------------
    //
    // "This might mean the loader runs twice" is speculation, and the brief
    // lists speculation as unwanted. It is still NOT for this filter: the
    // hedge is load-bearing. Trimming it to "The loader runs twice" would have
    // LAIN assert as fact something the model deliberately marked uncertain,
    // which is worse than any amount of narration. Dropping the sentence loses
    // the hypothesis instead. Both are wrong, so it is left exactly as written.
    keeps('This might mean the loader runs twice.');
    keeps('It seems like the loader might be the problem.');
    keeps('Maybe the handler is registered twice.');
    keeps('Perhaps the simplest fix is to register the handler once.');
  });

  await test('CONDENSE: a tentative sentence with substance still survives', () => {
    // The ordinary rescues apply to the tentative forms exactly as they do to
    // the plain ones — otherwise widening the openers would quietly narrow what
    // a model is allowed to say.
    keeps('We could try `--batch=32`.');
    keeps('We could try a smaller batch because the provider refused 64.');
    // A LOOK is rescued by a REASON and not by naming a file — that rule is
    // older than these openers and is unchanged by them, because the timeline
    // one row lower is already drawing the verb AND the file.
    drops('Maybe I should look at src/parser.js:88.');
    keeps('Maybe I should look at the parser, because the serializer still emits the field.');
    // And an either/or is a decision being put to somebody, whatever it opens
    // with. `ask_user` is where it belongs, but eating it would be far worse.
    keeps('Should I use a minimal patch or a structural rewrite?');
  });

  // ---- THE THREE HOLES A REAL SESSION WALKED THROUGH ---------------------
  //
  // Each of these was measured off the actual CLI, not imagined: the model
  // produced them, the filter passed them, and they were on screen.

  await test('CONDENSE: THINKING announced out loud is narration too', () => {
    // It carries no LOOK verb and no DO verb, so both lists missed it — and it
    // is the single most conspicuous line the brief asks to be rid of.
    drops('Let me think about what might be happening here.');
    drops('Let me consider the options.');
    drops("I'll figure out what is going on.");
    drops('Let me reconsider.');
    drops('Now let me work out where it stops.');
  });

  await test('CONDENSE: a THOUGHT with substance in it is a hypothesis, and stays', () => {
    // The rescue is DOING's, not LOOKING's: naming the thing being reasoned
    // about is exactly what makes the sentence worth its row.
    keeps('Let me think about why run() never reaches dispatch.');
    keeps("Let me consider whether the loader could run twice, because the log shows two inits.");
    keeps('Let me think about src/parser.js — it is the only caller.');
  });

  await test('CONDENSE: throat-clearing is TRIMMED, and never takes the fact with it', () => {
    // "Also worth noting the loader runs twice" is a preface in front of a
    // FINDING. Deleting the sentence would delete the finding, which is the one
    // thing this filter must never do.
    assert.strictEqual(condense.unpreface('Also worth noting the loader runs twice.'),
      'The loader runs twice.');
    assert.strictEqual(condense.unpreface("It's worth noting that the parser drops the field."),
      'The parser drops the field.');
    assert.strictEqual(condense.unpreface('Interestingly, the handler is registered twice.'),
      'The handler is registered twice.');
    // The fact survives the whole pipeline, not just the helper.
    assert.match(condense.prose('Also worth noting the loader runs twice.'), /loader runs twice/);
  });

  await test('CONDENSE: the preface is trimmed wherever in the line it occurs', () => {
    // Measured off a real session. The model writes a PARAGRAPH ON ONE LINE and
    // the throat-clearing was on the second sentence of it — a first-sentence
    // pass left the one instance that actually happened.
    const line = 'The CLI flag parses correctly, but run() never dispatches to zerotier.connect(). '
      + 'Also worth noting the loader runs twice.';
    assert.strictEqual(condense.prose(line, { last: false }),
      'The CLI flag parses correctly, but run() never dispatches to zerotier.connect(). '
      + 'The loader runs twice.');
  });

  await test('CONDENSE: a CONTRAST is not a preface and is left alone', () => {
    // `However` and `That said` are part of the argument being made. A list
    // that swallowed them would be rewriting reasoning, not removing preamble.
    for (const line of [
      'However, the loader runs twice.',
      'That said, the handler is registered.',
      'Notably absent: the dispatch call.',
    ]) assert.strictEqual(condense.unpreface(line), line, `must not trim: ${line}`);
  });

  await test('CONDENSE: a message that is ALL announcement goes mid-turn and stays at the end', () => {
    // The measured case. `I will now run the tests.` was the whole of a
    // mid-turn message, so the old rule kept it — and the timeline one row
    // lower was already drawing `running · npm test`.
    const only = 'I will now run the tests.';
    assert.strictEqual(condense.prose(only, { last: false }), '',
      'mid-turn, ACTIVITY is the narration and the sentence is a second copy');
    assert.strictEqual(condense.prose(only, { last: true }), only,
      'as the last thing said, a turn that says nothing at all reads as a failure');
    assert.strictEqual(condense.prose(only), only, 'and the default is the cautious one');
  });

  await test('CONDENSE: mid-turn dropping still never touches a message with substance', () => {
    const finding = 'The CLI flag parses correctly, but run() never dispatches to zerotier.connect().';
    assert.strictEqual(condense.prose(finding, { last: false }), finding);
    const mixed = "Let me think about this. The dispatcher never fires.";
    assert.strictEqual(condense.prose(mixed, { last: false }), 'The dispatcher never fires.');
  });

  await test('CONDENSE: an announcement of a tool call the timeline draws is dropped', () => {
    drops("I'll now inspect the startup folder.");
    drops('Let me look at the runner log.');
    drops('Now I will read python.js.');
    drops("Let's check how the exe is launched.");
    drops('I need to check whether there is a supervisor script.');
    drops("I'm going to read src/text.js:88.");
    drops("Next up: I'll grep for the handler.");
  });

  await test('CONDENSE: the dot in a filename does not end the sentence', () => {
    // The pattern used to stop at the first full stop, which in
    // "Now I will read python.js." is inside the filename — so the single most
    // common form of the thing this exists to catch went straight through.
    drops('Now I will read python.js.');
    drops('Let me open src/ui/layout.js.');
    drops("I'll check tests/run.js.");
  });

  await test('CONDENSE: a REASON rescues the same sentence', () => {
    // "I'll read the parser" is the timeline said twice. "…because the
    // serializer still emits the field" is a hypothesis, and a hypothesis is
    // worth its line.
    keeps("I'll read the parser because the serializer still emits the field.");
    keeps("I'll check the loader to rule out the cache.");
    keeps("I'll read the old implementation instead of the new one.");
  });

  await test('CONDENSE: a whole LINE of several sentences is never dropped entire', () => {
    // `isNarration` is a question about one sentence. A multi-sentence line is
    // handled by `trimSentences`, which keeps the parts that are not
    // announcements — dropping the lot would take the finding with it.
    keeps("I'll read the file. The parser is where the bug is.");
    keeps("Let me check the log. It stops without a trace.");
  });

  await test('CONDENSE: an announcement INSIDE a paragraph goes, and the finding stays', () => {
    // ---- MEASURED ON A REAL SESSION ---------------------------------------
    //
    // A line-only filter removed 0 of 40 prose lines, and not because the model
    // was quiet: it writes a PARAGRAPH ON ONE LINE, with the announcement as one
    // sentence inside it. Keeping all three sentences or dropping all three are
    // both wrong. The unit of narration is the sentence.
    assert.strictEqual(
      condense.prose('Let me explore the project first. It is a fixture with four files. '
        + 'Let me read those files and figure out what is happening.'),
      'It is a fixture with four files.',
    );
    assert.strictEqual(
      condense.prose('The parser accepts the legacy field. I will now read python.js. '
        + 'The serializer still emits it.'),
      'The parser accepts the legacy field. The serializer still emits it.',
    );
    assert.strictEqual(
      condense.prose('The build might take a while — use run_background. '
        + 'Also, let us check the tail of the runner log.'),
      'The build might take a while — use run_background.',
    );
  });

  await test('CONDENSE: a paragraph with nothing to cut comes back byte-identical', () => {
    const text = 'Runner stopped without a crash trace. The supervisor never restarted it.';
    assert.strictEqual(condense.prose(text), text);
    assert.strictEqual(condense.trimSentences(text), text, 'not even rebuilt');
  });

  await test('CONDENSE: a full stop inside a filename does not split a sentence', () => {
    // `python.js.` and `v0.3` must stay inside their sentence, or the filter
    // would be deciding about fragments.
    const text = 'The consumer is v0.3 and src/parser.js normalises the key. That is the defect.';
    assert.strictEqual(condense.prose(text), text);
  });

  await test('CONDENSE: a FINDING is never narration, whatever it opens with', () => {
    keeps('Runner stopped without a crash trace.');
    keeps('Parser accepts the legacy field but the serializer still emits it.');
    keeps("I'll fix the off-by-one in lineAt at src/text.js:88.");
    keeps('Good, that means the parser is fine.');
    keeps('Now the tests pass.');
    keeps('The build fails on Windows only.');
  });

  await test('CONDENSE: thinking noise goes, including a chain of it', () => {
    drops('Hmm.');
    drops('Actually…');
    drops('Hmm, but wait...');
    drops("Let's see.");
    drops('OK, right, so.');
    // But not when the same word starts a real sentence.
    keeps('So the parser never runs.');
    keeps('Actually the serializer is the one emitting it.');
    keeps('Wait until the runner has flushed before reading it.');
  });

  await test('CONDENSE: a standalone restatement of the request goes', () => {
    drops('The user wants Lain to trace the runner.');
    drops('You asked me to check the loader.');
    keeps('The user-facing loader is the one that breaks.');
  });

  await test('CONDENSE: a long sentence is left alone whatever it opens with', () => {
    // Past the length bound the line is carrying more than an announcement,
    // and guessing which half is which is not something a regex should do.
    const long = "I'll check the loader, the parser and the serializer in turn, "
      + 'starting from the one the stack trace names and working outwards from there.';
    assert.ok(long.length > condense.MAX_LINE);
    keeps(long);
  });

  await test('CONDENSE: code inside a fence is never narration', () => {
    const text = ['Here is the shape:', '```js', "// I'll read the file", 'read(file);', '```'].join('\n');
    const out = condense.prose(text);
    assert.ok(out.includes("// I'll read the file"), 'a comment that reads like English is still code');
    assert.ok(out.includes('read(file);'));
  });

  await test('CONDENSE: a message that is ENTIRELY narration is shown as it is', () => {
    // Removing all of it would show a turn in which nothing was said at all,
    // which is a worse picture than a redundant sentence.
    const only = "Let me look at the runner log.";
    assert.strictEqual(condense.prose(only), only);
  });

  await test('CONDENSE: the gap a removed line leaves is not a paragraph break', () => {
    const text = 'Let me check the runner.\n\nRunner stopped without a crash trace.';
    assert.strictEqual(condense.prose(text), 'Runner stopped without a crash trace.');
  });

  await test('CONDENSE: a message with nothing to drop comes back identical', () => {
    const text = 'Runner stopped without a crash trace.\n\nThe supervisor never restarted it.';
    assert.strictEqual(condense.prose(text), text);
  });

  await test('CONDENSE: the leading restatement is still handled', () => {
    // ui/phrasing.js owns that one and this composes with it rather than
    // duplicating it.
    const out = condense.prose('The user wants a reply containing exactly "PROVIDER OK". PROVIDER OK');
    assert.strictEqual(out, 'PROVIDER OK');
  });

  await test('CONDENSE: it is presentation — the count is reportable', () => {
    const text = ["Let me read the loader.", 'It never sees the field.', "Now I'll check the writer."].join('\n');
    assert.strictEqual(condense.cutCount(text), 2);
    assert.strictEqual(condense.prose(text), 'It never sees the field.');
  });

  await test('CONDENSE: a question the model asks ITSELF is deliberation, not speech', () => {
    // Addressed to nobody, answerable by nobody — the turn does not stop for
    // it. A real question goes through ask_user, which stops the turn and draws
    // a panel (see askgate.js); prose cannot do that.
    drops('Should I ask_user the user?');
    drops('Can I ask the user about this?');
    drops('Should I check the writer too?');
    drops('Do I need to read the loader first?');
    drops('Maybe I should check the serializer?');
  });

  await test('CONDENSE: a real question TO THE USER is never touched', () => {
    // The bright line. Eating one of these would be far worse than any amount
    // of narration, so a sentence offering a choice is kept whatever it looks
    // like, and so is anything that is not about asking or about looking.
    keeps('Should I rewrite the loader or add a shim?');
    keeps('Do you want the fallback kept?');
    keeps('Which spelling should the wire use?');
    keeps('Should I proceed?');
    keeps('Maybe I should ask whether you want A or B?');
  });
};
