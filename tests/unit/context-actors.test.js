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
      // AN EDIT, NOT A READ. A successful read is live state and is drawn in the
      // one row above the caret rather than kept in the conversation (ui/feed.js
      // `durable`). This test is about telling the five VOICES apart, so it needs
      // a call that persists — and a change to the project is one.
      liveActions: [{ name: 'edit_file', target: 'dashboard.py', ok: true }],
      width: 90,
    });
    const text = T.strip(lines.join('\n'));
    // The voices that could be mistaken for LAIN keep their names.
    for (const label of ['USER', 'EXTERNAL', 'MCP']) {
      assert.ok(text.includes(label), `${label} is not labelled in Context:\n${text}`);
    }
    // The two that no longer wear a word are told apart by SHAPE, which
    // survives monochrome: a tool call is quoted behind a gutter, prose is not.
    assert.match(text, /│\s+✓ edited · dashboard\.py/, `a tool call is quoted:\n${text}`);
    assert.match(text, /^I found the writer\./m, `and prose sits at the margin:\n${text}`);
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
    // ---- RELATIVE, NOT ABSOLUTE ----------------------------------------
    //
    // These asserted 2 and 4 columns, which was the feed's own base indent plus
    // its relative offsets. The base is gone - the content frame owns the outer
    // margin and the layout applies it (ui/frame.js `contentBounds`) - so what
    // survives here is the only thing this test was ever about: a labelled body
    // is indented UNDER its label, and unlabelled prose is not.
    assert.match(text, /^EXTERNAL$/m, 'the label is at the margin');
    const body = /^(\s*)EXTERNAL speaking\./m.exec(text);
    assert.ok(body && body[1].length > 0, 'a labelled body is indented under its label');
    assert.match(text, /^LAIN speaking\./m, 'and unlabelled prose is at the margin');
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

  await test('CONTEXT: a consulted model\'s turn keeps the USER\'S words as the task', () => {
    // THE DEFECT THIS GUARDS, restated for what replaced the relay. The relay
    // drove the turn loop itself, so the first thing LAIN submitted was its OWN
    // instruction, which became the task in the banner — the one place that is
    // supposed to say what the user asked for said what LAIN asked for.
    //
    // The relay is gone (with `/external`; see routecommands.js). The property
    // survives because the dispatcher that replaced it does not submit anything
    // of its own at all: it records the USER'S text as the turn's input and the
    // reply as an assistant message, so there is nothing for LAIN's own words
    // to displace.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'chatdispatch.js'), 'utf8');
    assert.match(src, /newRecord\(session\.id, text/,
      "the turn record's input must be what the user typed");
    assert.match(src, /role: 'user', content: String\(text\)/,
      'and that is what enters the conversation');
    assert.ok(!/app\.submit\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
      'a chat source must never start a turn of its own');
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

  await test('SURFACE: the conversation is the surface — there is no pane to name', () => {
    // ------------------------------------------------------------------
    // THIS TEST HELD THAT `context` WAS A NAMED PANE OF ITS OWN, distinct from
    // the log, and that ACTIVITY was the pane LAIN opened on. Both facts were
    // about an arrangement of nine panes.
    //
    // The property underneath survived the arrangement: the account of what was
    // said and done is on screen without anybody asking for it, because a reply
    // nobody can see is indistinguishable from an agent that did nothing. That
    // used to require choosing which pane led. Now it is simply what the screen
    // IS.
    // ------------------------------------------------------------------
    const { Screen } = require('../../src/ui/layout');
    const s = new Screen({ out: { columns: 90, rows: 30, isTTY: true, write() {}, on() {}, removeListener() {} } });
    s.state = {
      cwd: process.cwd(),
      session: { cwd: process.cwd(), task: null, turns: [] },
      transcript: [], liveActions: [], liveNarration: [], liveNotes: [],
      liveUser: 'THE_THING_I_ASKED', extras: [],
    };
    const out = T.strip(s.workspaceLines(90, 20).join(String.fromCharCode(10)));
    assert.ok(out.includes('THE_THING_I_ASKED'),
      'the conversation must be on screen with nothing selected, because nothing can be selected');
  });
};
