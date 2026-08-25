'use strict';

/**
 * CONTEXT IS A CONVERSATION — the unit half of the live-turn failure.
 *
 * The reported failure was that a working session showed
 *
 *     search / read / search / read / search / read …
 *
 * and nothing the model actually SAID, with the screen apparently stuck. It
 * reproduced on the real binary with thirty calls in one turn, and it was four
 * separate defects wearing one coat:
 *
 *   1. a run of calls filled every row of the pane and pushed the prose off it;
 *   2. prose was only flushed to the feed at the NEXT tool result, so a model
 *      that wrote for thirty seconds was invisible for thirty seconds;
 *   3. the flush did not redraw even when it happened;
 *   4. nothing ever said WHY a turn had stopped, so a blocked turn looked like
 *      a hung one — and the status strip called it DONE.
 *
 * Each is pinned here, at the level it lives at. The smoke half drives the real
 * binary and asserts what a person would actually see; see
 * smoke/conversation-visible.test.js.
 */

const assert = require('assert');
const { test } = require('../helpers');

/** A newline, as a value. */
const NL = String.fromCharCode(10);
/** Colour stripped, so an assertion reads the text a person sees. */
const SGR = new RegExp(String.fromCharCode(27) + '\[[0-9;]*m', 'g');
const strip = (x) => String(x).replace(SGR, '');

const feed = require('../../src/ui/feed');
const views = require('../../src/ui/views');
const { Screen } = require('../../src/ui/layout');
const { Story } = require('../../src/ui/story');
const turnevents = require('../../src/turnevents');
const { describeTarget } = require('../../src/turn');

/** A run of successful calls, as pushAction would produce them. */
function calls(n, name = 'read_file') {
  const out = [];
  for (let i = 0; i < n; i++) feed.pushAction(out, { name, target: `src/f${i}.js`, ok: true });
  return out;
}

const texts = (entries) => entries.map((e) => e.text);

module.exports = async function () {
  await test('FLOOD: history compacts harder than the work in hand', () => {
    // ---- THE DOOR THE COMPACTION DID NOT COVER ---------------------------
    //
    // A run of calls is broken by any prose between two of them, and a real
    // investigation is exactly that shape: four reads, a finding, four more
    // reads, a finding. No single run ever reached the threshold, so every one
    // of thirty calls was drawn at full length — the flood came back through
    // the one door the compaction did not cover.
    //
    // The LAST run is the work in hand and keeps its rows. Everything before it
    // has finished and keeps two, folded into a summary stating the true count.
    // Nothing is discarded — see ui/compact.js.
    const actions = [];
    const narration = [];
    for (let g = 0; g < 5; g++) {
      for (let k = 0; k < 6; k++) {
        actions.push({ step: g, name: 'read_file', target: 'f' + g + '_' + k + '.js', ok: true });
      }
      narration.push({ step: g, text: 'Finding ' + g + ': module ' + g + ' never dispatches.' });
    }
    const session = { turns: [{ userInput: 'audit', text: 'Done.', narration, actions }] };
    const rows = views.activity({ session, width: 96 }).map(strip);

    const callRows = rows.filter((r) => /✓ Read/.test(r));
    assert.ok(callRows.length < 20,
      'thirty calls do not become thirty rows: ' + callRows.length + NL + rows.join(NL));
    // THE COUNT IS STILL TRUE — a folded run says how many it stands for.
    assert.ok(rows.some((r) => /✓ Read ×\d+/.test(r)), 'a folded run states its count');
    // AND THE CURRENT RUN IS NOT FOLDED WITH THE REST.
    for (const f of ['f4_0.js', 'f4_1.js', 'f4_2.js', 'f4_3.js', 'f4_4.js', 'f4_5.js']) {
      assert.ok(rows.some((r) => r.includes(f)), 'the current run keeps ' + f);
    }
    // AND EVERY FINDING SURVIVES. Compaction is about calls, never about prose.
    for (let g = 0; g < 5; g++) {
      assert.ok(rows.some((r) => r.includes('Finding ' + g + ':')), 'finding ' + g + ' survives');
    }
  });

  await test('FLOOD: a FAILURE is never compacted away', () => {
    // The one row worth reading in full is the one that did not work.
    const actions = [];
    for (let k = 0; k < 12; k++) {
      actions.push({ step: 0, name: 'read_file', target: 'g' + k + '.js', ok: k !== 2 });
    }
    const session = {
      turns: [{
        userInput: 'audit', text: 'Done.',
        narration: [{ step: 1, text: 'Done.' }], actions,
      }],
    };
    const rows = views.activity({ session, width: 96 }).map(strip);
    assert.ok(rows.some((r) => /g2\.js/.test(r)),
      'the failed call survives the fold:' + NL + rows.join(NL));
  });

  await test('FEED: a settled edit keeps its +/- , so the account survives the turn', () => {
    // ---- THE NUMBER THAT VANISHED ---------------------------------------
    //
    // The counts were first put on the LIVE action record (ui/story.js), which
    // is cleared the moment the turn ends and hands the feed back to
    // `session.turns`. Measured across real captured frames: 24 rows carried
    // counts and 216 did not — the same row showing `+75 -40` while the turn
    // ran and losing it the instant the turn finished. A number that vanishes
    // is worse than one that was never there.
    //
    // They live on the TURN RECORD now, put there from the checkpoint at the
    // moment the call finishes (describe.js `editSize`).
    const session = { turns: [{
      userInput: 'refactor',
      text: 'Done.',
      narration: [{ step: 1, text: 'Done.' }],
      actions: [
        { step: 0, name: 'edit_file', target: 'python.js', ok: true, added: 75, removed: 40 },
        { step: 0, name: 'edit_file', target: 'config.js', ok: true, added: 4, removed: 1 },
        { step: 0, name: 'read_file', target: 'router.js', ok: true, added: 0, removed: 0 },
      ],
    }] };
    const rows = views.activity({ session, width: 96 }).map(strip);
    assert.ok(rows.some((r) => /Edited python\.js\s+\+75 -40/.test(r)),
      `the edit keeps its size:${NL}${rows.join(NL)}`);
    assert.ok(rows.some((r) => /Edited config\.js\s+\+4 -1/.test(r)), 'and so does the next one');
    // A READ CHANGED NOTHING, and must not wear a `+0 -0` that says it did.
    assert.ok(rows.some((r) => /Read router\.js\s*$/.test(r)),
      `a call that changed nothing carries no counts:${NL}${rows.join(NL)}`);
  });

  // ------------------------------------------------------- tool compaction --

  await test('FLOOD: a short run of calls is left exactly as it is', () => {
    // Compaction that starts at three would be its own kind of hiding.
    const run = calls(5);
    assert.deepStrictEqual(texts(feed.compactRuns(run)), texts(run));
  });

  await test('FLOOD: a long run becomes a count plus the most recent calls', () => {
    const run = [...calls(8, 'grep'), ...calls(8, 'read_file')];
    const out = feed.compactRuns(run);
    assert.ok(out.length < run.length, 'sixteen calls must not cost sixteen rows');
    assert.match(out[0].text, /Searched ×8 · Read ×4/, `got: ${out[0].text}`);
    assert.strictEqual(out[0].compacted, true);
    // The most recent four survive verbatim: what it is doing NOW is the part
    // worth reading in full.
    assert.strictEqual(out.length, 1 + feed.KEEP);
    assert.match(out[out.length - 1].text, /Read src\/f7\.js/);
  });

  await test('FLOOD: the count is TRUE — nothing is dropped without being counted', () => {
    const run = calls(30, 'grep');
    const out = feed.compactRuns(run);
    const summary = out.find((e) => e.compacted);
    const stated = Number(/×(\d+)/.exec(summary.text)[1]);
    assert.strictEqual(stated + feed.KEEP, 30, 'the summary plus the kept rows must account for every call');
  });

  await test('FLOOD: a FAILED call is never compacted away', () => {
    // A failure is the one row in a flood worth reading, and it is the row a
    // count would erase most easily.
    const run = calls(12);
    feed.pushAction(run, { name: 'read_file', target: 'src/gone.js', ok: false, note: 'no such file' });
    run.push(...calls(2));
    const out = feed.compactRuns(run);
    assert.ok(texts(out).some((t) => t.includes('gone.js')), `the failure vanished:\n${texts(out).join('\n')}`);
  });

  await test('FLOOD: conversation between two runs is never swallowed by either', () => {
    const said = [
      { kind: 'user', text: 'find the bug' },
      ...calls(9, 'grep'),
      { kind: 'model', text: 'The cache is never invalidated.' },
      ...calls(9, 'read_file'),
      { kind: 'model', text: 'Fixed it.' },
    ];
    const out = feed.compactRuns(said);
    assert.deepStrictEqual(
      out.filter((e) => e.kind !== 'action').map((e) => e.text),
      ['find the bug', 'The cache is never invalidated.', 'Fixed it.'],
    );
  });

  await test('FLOOD: compaction happens BEFORE the tail is taken', () => {
    // Otherwise the fix performs the failure: sixty rows of the tail are all
    // tool calls, and the conversation above them is what gets cut.
    const session = {
      turns: [{
        userInput: 'find the bug',
        narration: [{ step: 0, text: 'Tracing where it stops.' }],
        actions: Array.from({ length: 80 }, (_, i) => ({ step: 0, name: 'grep', target: `/x${i}/`, ok: true })),
      }],
    };
    const lines = views.activity({ session, width: 90 }).join('\n');
    assert.ok(lines.includes('Tracing where it stops.'), `the model's prose was cut:\n${lines.slice(-600)}`);
    assert.ok(lines.includes('find the bug'), 'and so was the user');
  });

  // --------------------------------------------------- prose while working --

  await test('LIVE PROSE: a finished paragraph reaches the screen without waiting for a tool', () => {
    const seen = [];
    const app = { ui: { enabled: true, noteNarration: (t) => seen.push(t) } };
    let buf = '';
    buf = turnevents.flushParagraphs(app, buf + 'I am tracing where the update stops.');
    assert.deepStrictEqual(seen, [], 'an unfinished thought waits');
    buf = turnevents.flushParagraphs(app, buf + '\n\nNow reading the renderer.');
    assert.deepStrictEqual(seen, ['I am tracing where the update stops.']);
    assert.strictEqual(buf, 'Now reading the renderer.', 'the incomplete tail stays in the buffer');
  });

  await test('LIVE PROSE: a model that never breaks a paragraph is not invisible either', () => {
    const seen = [];
    const app = { ui: { enabled: true, noteNarration: (t) => seen.push(t) } };
    const long = 'This is a sentence that says something. '.repeat(30);
    const left = turnevents.flushParagraphs(app, long);
    assert.strictEqual(seen.length, 1, 'a long unbroken stretch is flushed at a sentence end');
    assert.ok(seen[0].endsWith('.'), `it is cut at a sentence, not mid-word: ${JSON.stringify(seen[0].slice(-40))}`);
    assert.ok(left.length < long.length);
  });

  await test('LIVE PROSE: flushing prose REDRAWS — recording it is not showing it', () => {
    // This is defect 3, and on its own it is enough to produce the report: the
    // sentences existed, were recorded, and reached the screen only when
    // something else happened to repaint it.
    let draws = 0;
    const ui = Object.create(require('../../src/ui/index').UI.prototype);
    ui.story = new Story();
    ui.refresh = () => { draws++; };
    ui.noteNarration('Something the model said.');
    assert.strictEqual(draws, 1, 'noteNarration must redraw');
    assert.strictEqual(ui.story.narration.length, 1);
  });

  // ------------------------------------------------------- program notices --

  await test('NOTE: a notice lands IN PLACE in the conversation, not under all of it', () => {
    const story = new Story();
    story.noteAction({ name: 'grep', target: '/x/', ok: true });
    story.noteSystem('read_file has returned identical output 3 times', 'warn');
    story.noteAction({ name: 'read_file', target: 'a.js', ok: true });
    assert.strictEqual(story.notes[0].after, 1, 'anchored to what had happened when it was said');

    const lines = views.activity({
      session: { turns: [] },
      liveActions: story.actions,
      liveNotes: story.notes,
      width: 90,
    });
    const body = lines.join('\n');
    const noteAt = body.indexOf('identical output 3 times');
    const lastCall = body.indexOf('Read a.js');
    assert.ok(noteAt > 0, 'the notice must be on screen');
    assert.ok(noteAt < lastCall, 'and above the call that came after it, not below everything');
    // Labelled as the PROGRAM speaking, which is a different voice from the
    // model's — and the model's prose no longer wears a label at all, so this
    // word is the whole of the distinction.
    //
    // AND IT IS THE SEVERITY'S OWN WORD. This one was made at `warn`, and a
    // warning that draws as the same neutral `NOTE` as routine housekeeping is
    // the failure §16 names: a 429 hidden inside the colour reserved for LAIN
    // tidying its own context.
    assert.ok(body.includes('WARN'), `labelled by severity, not as prose:\n${body}`);
    assert.ok(!body.includes('NOTE'), 'a warning is not filed under the neutral word');
  });

  await test('NOTE: notices are cleared by the next turn — they are advice, not history', () => {
    const story = new Story();
    story.noteSystem('discovering models from local…');
    assert.strictEqual(story.notes.length, 1);
    story.beginTurn();
    assert.strictEqual(story.notes.length, 0, 'model discovery must not sit in Context all session');
  });

  // --------------------------------------------------------- interruptions --

  await test('INTERRUPTED: a turn that was cut short says so, with the reason', () => {
    const said = [];
    const app = { ui: { enabled: true, noteActor: (kind, text) => said.push({ kind, text }) } };
    // The word was MODEL INTERRUPTED for every reason but `aborted`, which put
    // the wrong actor on four different endings — most visibly on a provider
    // refusal, where "MODEL INTERRUPTED — the provider stopped answering" names
    // the wrong one twice over: the model interrupted nothing, and nobody
    // interrupted it. Each reason now says who actually stopped ().
    turnevents.noteInterruption(app, { stopReason: 'blocked' });
    assert.strictEqual(said.length, 1);
    assert.strictEqual(said[0].kind, 'note');
    assert.match(said[0].text, /TASK BLOCKED/);
    assert.match(said[0].text, /no new evidence/, 'the REASON, not just the fact');

    said.length = 0;
    turnevents.noteInterruption(app, { stopReason: 'provider' });
    assert.match(said[0].text, /PROVIDER REFUSED/, 'the actor that actually refused');
    assert.ok(!/MODEL INTERRUPTED/.test(said[0].text));
  });

  await test('INTERRUPTED: a turn that simply ended says nothing at all', () => {
    const said = [];
    const app = { ui: { enabled: true, noteActor: (k, t) => said.push(t) } };
    turnevents.noteInterruption(app, { stopReason: 'end' });
    turnevents.noteInterruption(app, {});
    assert.deepStrictEqual(said, []);
  });

  await test('INTERRUPTED: every stop reason the turn loop can produce has words', () => {
    // A reason with no sentence would print a raw enum at the user.
    for (const why of ['max-steps', 'aborted', 'provider', 'blocked', 'no-credential']) {
      assert.ok(turnevents.WHY[why] && turnevents.WHY[why].length > 10, `${why} has no explanation`);
    }
  });

  await test('INTERRUPTED: an interruption SURVIVES the turn that was interrupted', () => {
    // It is a fact about the task, not about the turn, so it goes to
    // session.actors — which persists, and comes back with /resume.
    const session = { turns: [{ userInput: 'go', narration: [], actions: [] }] };
    const lines = views.activity({
      session,
      extras: [{ kind: 'note', text: 'MODEL INTERRUPTED — it reached the step limit for one turn', afterTurns: 1 }],
      width: 90,
    }).join('\n');
    assert.ok(lines.includes('MODEL INTERRUPTED'), lines);
  });

  await test('INTERRUPTED: the status strip does not call a blocked turn DONE', () => {
    const st = require('../../src/ui/status');
    // The word here was INTERRUPTED, which was this test getting exactly what
    // it asked for — it only ever cared that a blocked turn is not DONE — while
    // four different stop reasons quietly shared one word. the design asks for them to
    // be distinguishable, so a blocked turn now says BLOCKED. The whole set is
    // asserted side by side in unit/vocabulary.test.js.
    const cut = st.liveState({ lastTurn: { toolCalls: 10, filesChanged: 0, stopReason: 'blocked' } });
    assert.strictEqual(cut.word, 'BLOCKED');
    assert.notStrictEqual(cut.word, 'DONE');
    assert.match(cut.detail, /no new evidence/);
    assert.match(cut.detail, /10 tool calls/, 'the work that DID happen is still reported');
    const ok = st.liveState({ lastTurn: { toolCalls: 3, filesChanged: 1, stopReason: 'end' } });
    assert.strictEqual(ok.word, 'DONE');
  });

  await test('NOT VERIFIED: a turn that ended on a FAILING check is not DONE', () => {
    // FOUND BY DRIVING THE REAL CLI, not by a test. The model said "All good,
    // everything works correctly now", `node test.js` had exited 1, and LAIN
    // printed the contradiction into the conversation — underneath a strip
    // reading `✓ LAIN DONE`. Two surfaces disagreeing about one fact, and the
    // one a person reads at a glance was the wrong one.
    //
    // The strip is where "did that work?" gets answered without reading
    // anything, so a red check outranks a turn that merely ENDED.
    const st = require('../../src/ui/status');
    const bad = st.liveState({
      lastTurn: { toolCalls: 2, filesChanged: 1, stopReason: 'end' },
      lastCheckFailed: { command: 'node test.js', ok: false, exitCode: 1 },
    });
    assert.strictEqual(bad.word, 'NOT VERIFIED');
    assert.notStrictEqual(bad.tick, true, 'and it must not wear the green tick');
    assert.match(bad.detail, /node test\.js exited 1/, 'it names the check and the code');
    assert.match(bad.detail, /1 file changed/, 'the work that DID happen is still reported');

    // A PASSING CHECK IS UNTOUCHED — this must not turn every finished turn
    // into a warning.
    const good = st.liveState({
      lastTurn: { toolCalls: 2, filesChanged: 1, stopReason: 'end' },
      lastCheckFailed: null,
    });
    assert.strictEqual(good.word, 'DONE');
  });

  // ------------------------------------------------------------- viewport --

  await test('VIEWPORT: the three states are distinguishable', () => {
    const sc = new Screen({ out: { write() {}, columns: 80, rows: 24 } });
    // FOLLOW_LIVE is a property of a FEED. The default view is CONTEXT, which
    // is a document and does not follow anything — see ui/tabs.js growsUpward.
    sc.setView('activity');
    assert.strictEqual(sc.viewportState(5), 'FOLLOW_LIVE');
    sc.stickToBottom = false;
    sc._anchorSpoken = 5;
    assert.strictEqual(sc.viewportState(5), 'MANUAL_SCROLL', 'scrolled up with nothing new');
    assert.strictEqual(sc.viewportState(8), 'NEW_ACTIVITY_PENDING', 'scrolled up while something was said');
  });

  await test('VIEWPORT: reading history while LAIN answers shows how much was missed', () => {
    const sc = new Screen({ out: { write() {}, columns: 80, rows: 24 } });
    sc.stickToBottom = false;
    sc._anchorSpoken = 2;
    const lines = Object.assign(new Array(200).fill('x'), { spoken: 5 });
    const hint = sc.scrollHint(lines, 20);
    assert.match(hint, /↓ 3 new/, `got: ${hint}`);
    assert.match(hint, /End/, 'and the way back, so it is not folklore');
  });

  await test('VIEWPORT: "new" counts MESSAGES — thirty reads are not somebody speaking', () => {
    const said = [{ kind: 'user', text: 'go' }, ...calls(30), { kind: 'model', text: 'done' }];
    assert.strictEqual(feed.spokenCount(said), 2);
  });

  await test('VIEWPORT: following means nothing is unread', () => {
    const sc = new Screen({ out: { write() {}, columns: 80, rows: 24 } });
    sc.setView('activity');                       // following is a FEED property
    const lines = Object.assign(new Array(5).fill('x'), { spoken: 9 });
    assert.strictEqual(sc.scrollHint(lines, 20), '', 'no indicator while at the bottom of a short feed');
  });

  await test('VIEWPORT: new output does NOT drag a reader back down', () => {
    const sc = new Screen({ out: { write() {}, columns: 80, rows: 24 } });
    sc.stickToBottom = false;
    sc.workspaceScroll = 3;
    // A draw with more content than before must not move the window.
    const before = sc.workspaceScroll;
    sc.scrollHint(Object.assign(new Array(400).fill('x'), { spoken: 40 }), 20);
    assert.strictEqual(sc.workspaceScroll, before);
  });

  // -------------------------------------------------- what a call is about --

  await test('SEARCH: a search is described by what it looked FOR', () => {
    // `Searched for "."` — the scope, in the place where the question belongs —
    // made ten different searches read as ten identical rows.
    assert.strictEqual(describeTarget('grep', { pattern: 'invalidate', path: '.' }), '/invalidate/');
    assert.strictEqual(describeTarget('grep', { pattern: 'invalidate', path: 'src' }), '/invalidate/ in src');
    assert.strictEqual(describeTarget('read_file', { path: 'src/a.js' }), 'src/a.js', 'a read is still about its file');
  });

  await test('OUTPUT: Context points at OUTPUT rather than carrying a test log', () => {
    const out = [];
    feed.pushAction(out, { name: 'run_bash', target: 'npm test', ok: true, brief: false, output: true });
    assert.match(texts(out).join('\n'), /full output in OUTPUT/);
    const quiet = [];
    feed.pushAction(quiet, { name: 'read_file', target: 'a.js', ok: true, brief: false, file: true });
    assert.strictEqual(quiet.length, 1, 'a file read points nowhere — the file went to the model');
  });

  // ------------------------------------------- the shape of a real answer --

  await test('SHAPE: a model answer keeps the lines the model put in it', () => {
    // FOUND BY A REAL MODEL, not by this suite. A whole message was one entry,
    // and one entry goes through `wrap`, which reflows on whitespace — so a
    // real final answer of headings, bullets, a table and fenced code came out
    // as one run-on paragraph with the code inside the prose. No scripted model
    // writes an answer shaped like that, which is why nothing here saw it.
    const out = [];
    feed.pushModel(out, '### What it does\n\n```js\nreturn cache;\n```\n\n- swallows the error\n- ignores its argument');
    assert.deepStrictEqual(texts(out), [
      '### What it does', '', '```js', 'return cache;', '```', '', '- swallows the error', '- ignores its argument',
    ]);
  });

  await test('SHAPE: a blank line the model wrote is drawn as a blank row', () => {
    const out = [];
    feed.pushModel(out, 'First paragraph.\n\nSecond paragraph.');
    const rows = feed.renderFeed(out, 80);
    // NO LABEL AND NO INDENT. `LAIN` named the application to the person who
    // typed `lain` to start it, and dragged four spaces behind it — spent on
    // the one thing on screen they were actually reading.
    assert.deepStrictEqual(rows, ['  First paragraph.', '', '  Second paragraph.']);
  });

  await test('SHAPE: a long line still folds to the pane', () => {
    // Per-line entries must not turn off wrapping — a 400-character sentence
    // has to fold, it just must not take the newlines around it with it.
    const out = [];
    feed.pushModel(out, `${'word '.repeat(60)}\nshort`);
    const rows = feed.renderFeed(out, 60);
    assert.ok(rows.length > 4, 'the long line folded');
    assert.ok(rows.every((r) => r.length <= 60), 'and nothing overflows the width');
  });

  await test('SHAPE: leading and trailing blank lines are not drawn', () => {
    const out = [];
    feed.pushModel(out, '\n\n  Answer.  \n\n');
    assert.deepStrictEqual(texts(out), ['  Answer.']);
  });

  await test('SHAPE: a twenty-line answer is ONE new message, not twenty', () => {
    // Otherwise `↓ 20 new` teaches a person to ignore the indicator.
    const out = [];
    feed.pushUser(out, 'explain it');
    feed.pushModel(out, Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
    assert.strictEqual(feed.spokenCount(out), 2);
  });

  await test('SHAPE: paragraphs the model separated stay separated on screen', () => {
    // ---- SEEN ON SCREEN ---------------------------------------------------
    //
    // A page of reasoning arrived as one slab, paragraph butted against
    // paragraph, with no way into it.
    //
    // The break is not lost in the DRAWING. `turnevents.flushParagraphs` splits
    // the streamed text on a blank line and trims each chunk, so the blank line
    // that made the boundary is consumed by the split — and each paragraph
    // reaches the feed as a separate call with nothing between them.
    const feed = require('../../src/ui/feed');
    const out = [];
    feed.pushModel(out, 'That IS the experiment: measure how much TT reuse there is.');
    feed.pushModel(out, 'TRUE parallelism needs workers.');
    feed.pushModel(out, 'Decision: implement the think-ahead via worker threads.');
    const rows = feed.renderFeed(out, 96);
    assert.deepStrictEqual(rows, [
      '  That IS the experiment: measure how much TT reuse there is.',
      '',
      '  TRUE parallelism needs workers.',
      '',
      '  Decision: implement the think-ahead via worker threads.',
    ]);
  });

  await test('SHAPE: ONE blank between paragraphs — the model wrote one', () => {
    // Restoring more would be inventing emphasis it did not ask for.
    const feed = require('../../src/ui/feed');
    const out = [];
    feed.pushModel(out, 'First.');
    feed.pushModel(out, 'Second.');
    const rows = feed.renderFeed(out, 90);
    const blanks = rows.filter((r) => !r.trim()).length;
    assert.strictEqual(blanks, 1, `exactly one blank row, got ${blanks}: ${JSON.stringify(rows)}`);
  });

  await test('SHAPE: a paragraph and a TOOL CALL are still told apart, not merged', () => {
    // The separator must not blur the one distinction the feed exists for.
    const feed = require('../../src/ui/feed');
    const out = [];
    feed.pushAction(out, { name: 'read_file', target: 'a.js', ok: true });
    feed.pushModel(out, 'One.');
    const text = feed.renderFeed(out, 90).join('\n');
    assert.match(text, /│ ✓ Read a\.js/, 'the call keeps its quoted gutter');
    assert.match(text, /^ {2}One\.$/m, 'and the prose sits at the margin');
  });
};
