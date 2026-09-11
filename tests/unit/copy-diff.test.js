'use strict';

/**
 * `/copy` AND THE DIFF GROUPING.
 *
 * Two small things with one rule in common: they report what is actually there.
 * `/copy` is a LOCAL utility — it must never reach a model, never start a turn,
 * and never hand back an empty string dressed as success. The diff must say what
 * happened to each file, and must not call a rewrite a rename.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const copy = require('../../src/copy');
const panes = require('../../src/ui/panes');

/** A fake app carrying only the state these read. */
function fakeApp(dir) {
  return {
    session: {
      cwd: dir,
      task: { objective: 'fix the logger', steers: [{ text: 'keep the format' }] },
      plan: { steps: [{ status: 'done', text: 'read it' }, { status: 'active', text: 'fix it' }] },
      lifecycle: { summary: () => ({ state: 'WORKING', turns: 2, toolCalls: 5, filesChanged: 1, reason: '' }) },
      turns: [{
        turnId: 't1',
        userInput: 'fix the logger',
        text: 'I changed the retention window to 7 days.',
        actions: [{ verb: 'EDIT', target: 'logger.js', summary: 'retention 30 -> 7' }],
        narration: [],
        // THE REAL RECORD SHAPE. turn.js pushes `{ step, text }`, and a fixture
        // of plain strings is what let `[object Object]` reach a real export.
        steerTexts: [{ step: 3, text: 'keep the format' }],
        // PRIVATE, and the point of the assertion below: a turn record keeps
        // this so a silent turn is not a blank pane. It must never be exported.
        reasoning: 'the user probably means the rotation window not the buffer',
        errors: [],
        stopReason: 'end',
      }],
      messages: [{ role: 'user', content: 'fix the logger' }, { role: 'assistant', content: 'done' }],
    },
    render: { transcript: [] },
    checkpoints: null,
    ui: { outputs: [{ command: 'npm test', output: '2 passing', exitCode: 0 }], liveActions: [], liveNarration: [] },
  };
}

module.exports = async function () {
  await test('COPY: every section reads EXISTING state — none of them asks a model', async () => {
    const app = fakeApp(tmpdir('copy-'));
    const last = await copy.collect(app, 'last');
    assert.match(last.text, /retention window to 7 days/);
    const task = await copy.collect(app, 'task');
    assert.match(task.text, /TASK  fix the logger/);
    assert.match(task.text, /⚑ keep the format/, 'a steer is part of what the task now is');
    const out = await copy.collect(app, 'output');
    assert.match(out.text, /\$ npm test/);
    assert.match(out.text, /2 passing/);
    // ---- `/copy context` IS BUILT FROM TURN RECORDS NOW -----------------
    //
    // It used to dump `session.messages`, the PROVIDER WIRE FORMAT — system
    // prompts, tool plumbing and whole file bodies re-sent for cache
    // alignment. The old assertion (`/--- USER/`) was matching that shape.
    const ctx = await copy.collect(app, 'context');
    assert.match(ctx.text, /^USER$/m, 'it starts from what the person actually asked');
    assert.match(ctx.text, /fix the logger/);
    assert.match(ctx.text, /^LAIN$/m, 'and carries what LAIN said in public');
    assert.match(ctx.text, /retention window to 7 days/);
    assert.match(ctx.text, /TOOL/, 'and what the tools actually did');
    assert.match(ctx.text, /USER \(mid-turn\)/, 'and corrections made while it ran');

    // THE ONE THING THAT MUST NEVER LEAVE. Hidden reasoning is the model's
    // private working, addressed to nobody, and a diagnostic export is exactly
    // the path by which it would reach somewhere it was never meant to go.
    assert.ok(!/rotation window not the buffer/.test(ctx.text),
      'hidden reasoning reached the clipboard');

    // And the raw wire format is still reachable when THAT is the question.
    const raw = await copy.collect(app, 'messages');
    assert.match(raw.text, /--- USER/);
  });

  await test('COPY: bare /copy is the task summary, not the last answer', async () => {
    const app = fakeApp(tmpdir('copy-sum-'));
    const sum = await copy.collect(app, 'summary');
    assert.match(sum.text, /^USER REQUEST$/m);
    assert.match(sum.text, /fix the logger/);
    assert.match(sum.text, /^RESULT$/m);
    assert.match(sum.text, /retention window to 7 days/);
    assert.match(sum.text, /^REMAINING$/m, 'an unfinished plan step is outstanding work');
    assert.match(sum.text, /fix it/);
    // NONE OF THE TRANSIENT UI. These are the exclusions the brief names.
    assert.ok(!/reasoning|rotation window not the buffer/i.test(sum.text));
    assert.ok(!/READY|spinner|00:0\d:\d\d/.test(sum.text));
    // AND IT IS WHAT BARE `/copy` REACHES FOR.
    assert.deepStrictEqual(copy.DEFAULT_ORDER, ['question', 'summary', 'last']);
  });

  await test('COPY: an unknown name says what the names ARE', async () => {
    const r = await copy.collect(fakeApp(tmpdir('copy2-')), 'wibble');
    assert.match(r.error, /nothing called "wibble"/);
    assert.match(r.error, /diff/, 'and lists what it could have meant');
  });

  await test('COPY: nothing to copy is reported as nothing, never as empty success', async () => {
    const app = fakeApp(tmpdir('copy3-'));
    app.ui.outputs = [];
    const r = await copy.collect(app, 'output');
    assert.strictEqual(r.empty, true);
    assert.ok(!r.text);
  });

  await test('COPY: colour never reaches the clipboard', async () => {
    // What gets pasted into an editor or a chat window must be text. The panes
    // it copies from are coloured now, so this is a real risk rather than a
    // theoretical one.
    const app = fakeApp(process.cwd());
    const health = await copy.collect(app, 'health');
    assert.ok(health.text, 'the project health section produces something');
    assert.ok(!/\x1b\[/.test(health.text), 'escape sequences must be stripped on the way out');
  });

  await test('COPY: it is registered, and it is not a turn', () => {
    const commands = require('../../src/commands');
    const c = commands.REGISTRY.get('/copy');
    assert.ok(c, '/copy must exist');
    assert.match(c.desc, /local/i);
    assert.strictEqual(commands.blockedDuringTurn('/copy'), false, 'looking something up must not wait for the work');
  });

  // ------------------------------------------------------------------ diff ---

  await test('DIFF: changes are grouped by WHAT HAPPENED, not listed alphabetically', () => {
    const files = [
      { rel: 'a.js', kind: 'added', before: null, after: 'new\n', added: 1, removed: 0 },
      { rel: 'b.js', kind: 'modified', before: 'x\n', after: 'y\n', added: 1, removed: 1 },
      { rel: 'c.js', kind: 'deleted', before: 'gone\n', after: null, added: 0, removed: 1 },
    ];
    const g = panes.groupChanges(files);
    assert.deepStrictEqual(g.added.map((f) => f.rel), ['a.js']);
    assert.deepStrictEqual(g.modified.map((f) => f.rel), ['b.js']);
    assert.deepStrictEqual(g.removed.map((f) => f.rel), ['c.js']);
    assert.deepStrictEqual(g.renamed, []);
  });

  await test('DIFF: a rename is only a rename when the bytes are identical', () => {
    const same = 'const x = 1;\nmodule.exports = x;\n';
    const g = panes.groupChanges([
      { rel: 'old.js', kind: 'deleted', before: same, after: null, added: 0, removed: 2 },
      { rel: 'new.js', kind: 'added', before: null, after: same, added: 2, removed: 0 },
    ]);
    assert.deepStrictEqual(g.renamed, [{ from: 'old.js', to: 'new.js' }]);
    assert.deepStrictEqual(g.added, [], 'the pair is reported once, as one event');
    assert.deepStrictEqual(g.removed, []);

    // A file that MOVED AND CHANGED is not a rename: calling it one would hide
    // the change, which is the part a reviewer actually needs to see.
    const g2 = panes.groupChanges([
      { rel: 'old.js', kind: 'deleted', before: same, after: null, added: 0, removed: 2 },
      { rel: 'new.js', kind: 'added', before: null, after: same + 'const y = 2;\n', added: 3, removed: 0 },
    ]);
    assert.deepStrictEqual(g2.renamed, []);
    assert.strictEqual(g2.added.length, 1);
    assert.strictEqual(g2.removed.length, 1);
  });

  await test('DIFF: two empty files are not a rename of each other', () => {
    const g = panes.groupChanges([
      { rel: 'a.js', kind: 'deleted', before: '', after: null, added: 0, removed: 0 },
      { rel: 'b.js', kind: 'added', before: null, after: '', added: 0, removed: 0 },
    ]);
    assert.deepStrictEqual(g.renamed, [], 'identical emptiness is not evidence of anything');
  });

  await test('DIFF: the pane shows the ACTUAL DIFF by default, and stays inside its width', () => {
    // WHAT CHANGED, NOT MERELY WHICH FILES CHANGED.
    //
    // The pane used to open on a grouped LIST — `~ MODIFIED  kept.js  +1 -1` —
    // with "Enter to open a file" beneath it, so the one question a diff view
    // exists to answer cost a keystroke per file to reach. The grouping was not
    // discarded: it moved to the FILES pane, which is the structural view and
    // where "which files did this touch?" belongs. The test below holds it there.
    //
    // The width guarantee is unchanged and matters more than it did, because
    // these rows now carry colour and a full-width rule.
    const T = require('../../src/ui/text');
    const dir = tmpdir('diff-');
    fs.writeFileSync(path.join(dir, 'kept.js'), 'after\n');
    const checkpoints = { entries: [{ files: [{ path: path.join(dir, 'kept.js'), bytes: Buffer.from('before\n'), existed: true }] }] };
    const lines = panes.diffView({ checkpoints, cwd: dir, width: 70 });
    const text = T.strip(lines.join('\n'));
    assert.match(text, /kept\.js/, 'the file is named');
    assert.match(text, /MODIFIED/, 'and what happened to it');
    assert.match(text, /-\s*before/, 'the removed line is shown without being asked for');
    assert.match(text, /\+\s*after/, 'and so is the added one');
    assert.ok(!/Enter to open a file/.test(text), 'the diff must not be hidden behind a keystroke');
    for (const l of lines) assert.ok(T.width(l) <= 70, `a diff row was ${T.width(l)} wide at 70`);
  });

  await test('FILES: the grouping moved HERE — what changed, by what happened to it', () => {
    const T = require('../../src/ui/text');
    const dir = tmpdir('files-');
    fs.writeFileSync(path.join(dir, 'kept.js'), 'after\n');
    fs.writeFileSync(path.join(dir, 'fresh.js'), 'new\n');
    const checkpoints = {
      entries: [{
        files: [
          { path: path.join(dir, 'kept.js'), bytes: Buffer.from('before\n'), existed: true },
          { path: path.join(dir, 'fresh.js'), bytes: null, existed: false },
        ],
      }],
    };
    const lines = panes.filesView({
      checkpoints, cwd: dir, width: 70,
      tree: [{ rel: 'kept.js', name: 'kept.js', depth: 0, isDir: false }],
    });
    const text = T.strip(lines.join('\n'));
    assert.match(text, /~ MODIFIED/, 'the grouping the diff pane gave up lives here now');
    assert.match(text, /\+ ADDED/);
    assert.match(text, /kept\.js/);
    assert.match(text, /fresh\.js/);
    assert.match(text, /PROJECT/, 'and the structural tree is still below it');
    for (const l of lines) assert.ok(T.width(l) <= 70, `a files row was ${T.width(l)} wide at 70`);
  });

  await test('DIFF: + and - are in the TEXT, so a monochrome terminal still reads it', () => {
    const NL = String.fromCharCode(10);
    // ------------------------------------------------------------------
    // §8 OF THE REWRITE: additions and removals must be distinguishable where
    // the terminal supports colour, and the diff must remain READABLE without
    // it. Those are two requirements and only the first is about colour.
    //
    // `unified` puts the line number and the `+` / `-` / ` ` marker into the
    // STRING, before anything paints it — so the meaning survives NO_COLOR, a
    // pipe, and a terminal with no SGR support at all. Colour only makes it
    // faster to scan.
    //
    // Asserted on the STRIPPED rows, which is exactly what a monochrome
    // terminal would show.
    const T = require('../../src/ui/text');
    const rows = panes.unified('one' + NL + 'two' + NL + 'three' + NL,
      'one' + NL + 'TWO CHANGED' + NL + 'three' + NL + 'four' + NL).map((l) => T.strip(l));
    const text = rows.join(NL);
    assert.ok(/-\s*two/.test(text), `a removal is marked with a minus:${NL}${text}`);
    assert.ok(/\+\s*TWO CHANGED/.test(text), `an addition with a plus:${NL}${text}`);
    assert.ok(/\+\s*four/.test(text), 'including one appended at the end');
    // AND THE LINE NUMBERS, which are what make a diff checkable against a file.
    assert.ok(/^\s*\d+\s/.test(rows[0]), `every row is numbered: ${JSON.stringify(rows[0])}`);
    // NO ESCAPE SEQUENCE CARRIES ANY OF THAT MEANING: stripping them changed
    // nothing about which rows are additions and which are removals.
    // COUNTED RATHER THAN NAMED: `unified` works from the first and last
    // differing line, so a change in the middle of a file is a run of removals
    // followed by a run of additions. How many of each is the diff's business;
    // that BOTH runs exist, marked, in the text, is this test's.
    const adds = (text.match(/^\s*\d+ \+ /gm) || []).length;
    const dels = (text.match(/^\s*\d+ - /gm) || []).length;
    assert.ok(adds > 0, `additions must be marked: ${adds}`);
    assert.ok(dels > 0, `and removals: ${dels}`);
    assert.ok(adds > dels, 'a file that grew has more added rows than removed ones');
  });
};
