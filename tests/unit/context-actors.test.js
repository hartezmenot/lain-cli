'use strict';

/**
 * CONTEXT IS THE STORY, AND IT HAS FIVE VOICES.
 *
 * USER, LAIN, EXTERNAL, MCP, ACTIONS. Two of those had labels and colours from
 * the day the relay landed and NOTHING EVER PRODUCED ONE: the external
 * reviewer's analysis reached the screen through `render.write`, which lands in
 * the transcript as unlabelled dim text at the foot of the feed. A second model
 * was genuinely on screen and looked like leftover logging.
 *
 * ------------------------------------------------------------------------
 * TWO OF THE FIVE NO LONGER WEAR A WORD, and that is the point rather than a
 * regression. `LAIN` named the application to the person who had just typed
 * `lain` to start it — once per paragraph, dragging a four-space indent behind
 * it, so the answer they came to read sat furthest from the margin. `ACTIONS`
 * announced a list of actions that already say what they are.
 *
 * The DISTINCTION is what these tests are for, and it survives: a tool call has
 * a quoted gutter, a user message has its own ground, the model's prose sits at
 * the margin, and the voices that are genuinely ambiguous — a second model, a
 * bridge — keep their names. What is asserted below is that a reader can still
 * tell them apart, not that a particular word is on screen.
 */

const assert = require('assert');
const { test } = require('../helpers');

const views = require('../../src/ui/views');
const feed = require('../../src/ui/feed');
const T = require('../../src/ui/text');

const turn = (userInput, text) => ({ userInput, text, actions: [], narration: null, errors: [] });

module.exports = async function () {
  await test('CONTEXT: all five voices are told apart', () => {
    const lines = views.activity({
      session: { turns: [turn('fix the dashboard', 'I found the writer.')] },
      extras: [
        { kind: 'external', text: 'The evidence suggests the writer is failing silently.' },
        { kind: 'mcp', text: 'Window focused: Chrome' },
      ],
      liveActions: [{ name: 'read_file', target: 'dashboard.py', ok: true }],
      width: 90,
    });
    const text = T.strip(lines.join('\n'));
    // The voices that could be mistaken for LAIN keep their names.
    for (const label of ['USER', 'EXTERNAL', 'MCP']) {
      assert.ok(text.includes(label), `${label} is not labelled in Context:\n${text}`);
    }
    // The two that no longer wear a word are told apart by SHAPE, which
    // survives monochrome: a tool call is quoted behind a gutter, prose is not.
    assert.match(text, /│\s+✓ Read dashboard\.py/, `a tool call is quoted:\n${text}`);
    assert.match(text, /^ {2}I found the writer\./m, `and prose sits at the margin:\n${text}`);
    assert.ok(!/^\s*LAIN$/m.test(text), 'the application does not name itself at the user');
    assert.ok(!/^\s*ACTIONS$/m.test(text), 'and actions do not announce that they are actions');
    assert.match(text, /fix the dashboard/);
    assert.match(text, /I found the writer/);
    assert.match(text, /evidence suggests/);
    assert.match(text, /Window focused/);
  });

  await test('CONTEXT: the voices appear in the order they spoke', () => {
    const text = T.strip(views.activity({
      session: { turns: [turn('do it', 'Looking now.')] },
      extras: [{ kind: 'external', text: 'Reviewed.' }],
      width: 90,
    }).join('\n'));
    const at = (s) => text.indexOf(s);
    assert.ok(at('USER') < at('Looking now.'), 'the request comes before the answer');
    assert.ok(at('Looking now.') < at('EXTERNAL'), 'and the review comes after what it reviewed');
  });

  await test('CONTEXT: the EXTERNAL voice is magenta, and nothing else is', () => {
    const saved = { no: process.env.NO_COLOR, lain: process.env.LAIN_NO_COLOR };
    delete process.env.NO_COLOR;
    delete process.env.LAIN_NO_COLOR;
    process.env.LAIN_FORCE_COLOR = '1';
    try {
      const lines = views.activity({
        session: { turns: [turn('x', 'LAIN speaking.')] },
        extras: [{ kind: 'external', text: 'EXTERNAL speaking.' }],
        width: 90,
      });
      const ext = lines.find((l) => /EXTERNAL/.test(T.strip(l)));
      assert.match(ext, /\x1b\[35m/, 'the EXTERNAL label must carry the external colour');
      const lain = lines.find((l) => /LAIN speaking\./.test(T.strip(l)));
      assert.ok(lain && !/\x1b\[35m/.test(lain), 'magenta belongs to the external model alone');
    } finally {
      delete process.env.LAIN_FORCE_COLOR;
      if (saved.no !== undefined) process.env.NO_COLOR = saved.no;
      if (saved.lain !== undefined) process.env.LAIN_NO_COLOR = saved.lain;
    }
  });

  await test('CONTEXT: with NO_COLOR the labels and indentation still separate them', () => {
    // Colour may never be the ONLY distinction.
    const lines = views.activity({
      session: { turns: [turn('x', 'LAIN speaking.')] },
      extras: [{ kind: 'external', text: 'EXTERNAL speaking.' }],
      width: 90,
    });
    for (const l of lines) assert.ok(!/\x1b\[/.test(l), 'no colour is emitted with NO_COLOR set');
    const text = lines.join('\n');
    assert.match(text, /^\s{2}EXTERNAL$/m);
    assert.match(text, /^\s{4}EXTERNAL speaking\./m, 'a labelled body is indented under its label');
    // The model's own prose sits at the MARGIN, which is what tells it from a
    // labelled voice when there is no colour available to help.
    assert.match(text, /^\s{2}LAIN speaking\./m, 'and unlabelled prose is at the margin');
  });

  await test('CONTEXT: an external review SURVIVES the turn that acts on it', () => {
    // The relay's rounds are the middle of the story. `extras` lives on the
    // task, not the turn, precisely so LAIN acting on round 1 does not erase it.
    const { UI } = require('../../src/ui');
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
    const ui = new UI(app);
    ui.enabled = false;                       // refresh() is a no-op; state still moves
    ui.noteActor('external', 'Round 1 review.');
    assert.strictEqual(ui.extras.length, 1);
    ui.beginTurn();
    ui.endTurn();
    assert.strictEqual(ui.extras.length, 1, 'a turn beginning and ending must not erase it');
    ui.clearExtras();
    assert.strictEqual(ui.extras.length, 0, 'a NEW TASK is what clears the story');
  });

  await test('CONTEXT: the feed exposes a push for every kind it can label', () => {
    // A label with no producer is how EXTERNAL and MCP came to be dead.
    for (const kind of Object.keys(feed.KIND)) {
      const pushName = {
        user: 'pushUser', model: 'pushModel', external: 'pushExternal', mcp: 'pushMcp',
        action: 'pushAction', note: 'pushNote',
        // `more` has no producer of its own ON PURPOSE: it is the pointer under
        // a folded paragraph, so it is emitted by the paragraph it belongs to.
        // A pointer that could be pushed on its own would be a pointer to
        // nothing. The invariant this test exists for still holds — the label
        // has a producer, and it is named here.
        more: 'pushModel',
      }[kind];
      assert.ok(pushName && typeof feed[pushName] === 'function',
        `KIND.${kind} has no producer — it can never appear on screen`);
    }
  });

  await test('CONTEXT: the relay keeps the USER\'S words as the task, not its own', () => {
    // The relay drives the turn loop itself, so no turn ever carried the
    // problem statement — and the first thing LAIN submitted was its OWN
    // instruction, which became the task in the banner. The one place that is
    // supposed to say what the user asked for said what LAIN asked for.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'investigation.js'), 'utf8');
    assert.match(src, /if \(!app\.session\.task\) app\.identify\(problem/,
      'the relay must establish the task from the problem before any round');
    assert.match(src, /sameTask: true/,
      "and its own instruction must continue that task rather than replacing it");
  });

  await test('CONTEXT: only LAIN\'s own machinery may assert sameTask', () => {
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
    // Typed input never carries it, so a genuinely new request is still new.
    const first = app.identify('inspect the dashboard', false);
    assert.strictEqual(first.sameTask, false);
    const objective = app.session.task.objective;
    // A caller that DOES assert it keeps the original objective.
    app.identify('a second model recommends this next step: log the exception', false, 'TROUBLESHOOT', true);
    assert.strictEqual(app.session.task.objective, objective, 'the user\'s words must survive');
    // And with no task at all, asserting it cannot invent one.
    const fresh = new App({ out: { write() {}, on() {}, columns: 96, isTTY: false }, interactive: false, cwd: process.cwd() });
    fresh.session.task = null;
    const v = fresh.identify('something', false, null, true);
    assert.strictEqual(v.sameTask, false, 'there is no task to be the same as');
  });

  await test('CONTEXT: the pane is NAMED context, and it is not the log', () => {
    // CONTEXT is a named pane of its own — that is the property being held.
    //
    // It is no longer the pane LAIN OPENS on. ACTIVITY leads, because a reply
    // nobody can see is indistinguishable from an agent that did nothing, and
    // CONTEXT keeps perfectly well one keypress away. Keeping CONTEXT in front
    // meant drawing a second copy of the feed underneath its briefing, which
    // made the landing pane a worse ACTIVITY and a worse CONTEXT at once.
    const tabs = require('../../src/ui/tabs');
    const { Screen } = require('../../src/ui/layout');
    const s = new Screen({ out: { columns: 90, rows: 30, isTTY: true, write() {}, on() {}, removeListener() {} } });
    assert.ok(tabs.VIEWS.includes('context'), 'context is one of the panes');
    assert.strictEqual(s.view, tabs.VIEWS[0], 'the screen opens on the first pane in the one list');
    const line = T.strip(s.tabsLine(90));
    assert.match(line, new RegExp(`\\b${tabs.numberOf('context')} context\\b`), 'context is numbered in the strip');
  });
};
