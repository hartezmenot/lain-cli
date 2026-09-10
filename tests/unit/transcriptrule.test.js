'use strict';

/**
 * THE TRANSCRIPT IS A CONVERSATION, NOT AN EXECUTION LOG.
 *
 * ------------------------------------------------------------------------
 * WHAT WAS ON THE SCREEN THAT PRODUCED THIS FILE. One ordinary turn left six
 * rows behind, permanently, between two things a person had actually said:
 *
 *     | OK Ran python -c "import ast"
 *     | OK Ran python -c "import json, tempfile"
 *     | OK Ran python -m py_compile a.py
 *     |     [via shell: bash - cwd=<absolute temp path>]
 *     | OK Read a.py
 *     | OK Read b.py
 *
 * and elsewhere, dressed as prose the model had written:
 *
 *     1 unfinished turn(s) left findings behind - /lain
 *     held - the last turn did not finish. Recovering with what LAIN observed...
 *     Copied 3 line(s) - 184 characters.
 *
 * None of those nine lines is a message. Every one of them is LAIN's own
 * machinery, and all of them outlive their usefulness by an entire session while
 * crowding out the two things the surface exists for.
 *
 * So this file pins the rule, and the four mechanisms that implement it:
 *
 *   ui/durable.js     which calls leave a row behind, and which are live state
 *   ui/operation.js   where housekeeping goes instead of into the conversation
 *   ui/views.js       the invisible content frame both regions share
 *   ui/anchors.js     how you get back to the message you cannot see
 */

const assert = require('assert');
const { test } = require('../helpers');

const feed = require('../../src/ui/feed');
const durable = require('../../src/ui/durable');
const views = require('../../src/ui/views');
const T = require('../../src/ui/text');
const { Screen } = require('../../src/ui/layout');

const LF = String.fromCharCode(10);
const strip = (x) => T.strip(String(x));

/** A terminal double the Screen can size itself from. */
function fakeOut(cols, rows) {
  return { columns: cols, rows, isTTY: true, write() {}, on() {}, removeListener() {} };
}

module.exports = async function () {
  // ------------------------------------------- which calls leave a record --

  await test('TRANSCRIPT: a successful routine call leaves NO row', () => {
    for (const name of ['read_file', 'list_dir', 'grep', 'glob', 'file_info', 'web_fetch',
      'run_bash', 'run_powershell', 'plan_write', 'symbols']) {
      assert.strictEqual(durable.durable({ name, ok: true }), false,
        name + ' succeeding is live state, not a record');
    }
  });

  await test('TRANSCRIPT: a FAILURE is always kept, whatever the call was', () => {
    for (const name of ['read_file', 'grep', 'run_bash', 'edit_file', 'plan_write']) {
      assert.strictEqual(durable.durable({ name, ok: false }), true,
        'a failed ' + name + ' is the row somebody scrolls back to find');
    }
  });

  await test('TRANSCRIPT: a change to the PROJECT is the account of the work', () => {
    for (const name of ['write_file', 'edit_file', 'apply_patch', 'append_file',
      'insert_at', 'delete_range', 'move_file', 'delete_file']) {
      assert.strictEqual(durable.durable({ name, ok: true }), true, name + ' changed something');
    }
  });

  await test('TRANSCRIPT: a verification, a decision and a service are kept', () => {
    for (const name of ['run_tests', 'verify_task', 'ask_user', 'service_start']) {
      assert.strictEqual(durable.durable({ name, ok: true }), true, name + ' is durable');
    }
  });

  await test('TRANSCRIPT: the LAST clean command is the turn standing verdict', () => {
    // Not a guess about the command text — there is no keyword table here
    // deciding that "test" means a verification. It is src/lifecycle.js's own
    // rule: the last command run is the state the task ends in.
    const acts = [
      { name: 'run_bash', target: 'python -c "import ast"', ok: true },
      { name: 'run_bash', target: 'python -m py_compile a.py', ok: true },
      { name: 'read_file', target: 'a.py', ok: true },
      { name: 'run_bash', target: 'npm test', ok: true },
    ];
    const kept = durable.keepers(acts);
    assert.strictEqual(kept.size, 1, 'one verdict, not four commands');
    assert.strictEqual([...kept][0].target, 'npm test');
  });

  await test('TRANSCRIPT: a failed command is kept even with a clean one after it', () => {
    const acts = [
      { name: 'run_bash', target: 'npm test', ok: false },
      { name: 'edit_file', target: 'a.js', ok: true },
      { name: 'run_bash', target: 'npm test', ok: true },
    ];
    const kept = [...durable.keepers(acts)].map((a) => a.target + ':' + a.ok);
    assert.deepStrictEqual(kept.sort(), ['a.js:true', 'npm test:false', 'npm test:true']);
  });

  await test('TRANSCRIPT: the rendered conversation drops the routine run entirely', () => {
    // THE SCREEN FROM THE HEADER, rendered through the real function.
    const session = { turns: [{
      userInput: 'check the python files',
      text: 'All fine.',
      narration: [{ step: 0, text: 'Checking them now.' }, { step: 1, text: 'All fine.' }],
      actions: [
        { step: 0, name: 'run_bash', target: 'python -c "import ast"', ok: true },
        { step: 0, name: 'run_bash', target: 'python -c "import json, tempfile"', ok: true },
        { step: 0, name: 'run_bash', target: 'python -m py_compile a.py', ok: true },
        { step: 0, name: 'read_file', target: 'a.py', ok: true },
        { step: 0, name: 'read_file', target: 'b.py', ok: true },
      ],
    }] };
    const text = views.activity({ session, width: 96 }).map(strip).join(LF);
    assert.match(text, /check the python files/, 'what the person said survives');
    assert.match(text, /All fine/, 'and what LAIN answered');
    assert.ok(!/import ast/.test(text), 'the first mechanics command is gone');
    assert.ok(!/import json/.test(text), 'and the second');
    assert.ok(!/Read a\.py/.test(text), 'and the reads');
    assert.ok(!/Read b\.py/.test(text));
    // THE VERDICT STAYS, because the turn's last command is what it ended on.
    assert.match(text, /py_compile a\.py/, 'the standing verdict is kept');
  });

  await test('TRANSCRIPT: the live pass and the recorded pass use ONE rule', () => {
    // A call shown while the turn ran and dropped when it ended would make the
    // conversation visibly rewrite itself at the moment of settlement, which
    // reads as a bug whichever version is right.
    const live = views.activity({
      session: { turns: [] },
      liveActions: [{ name: 'read_file', target: 'a.js', ok: true }],
      liveNarration: [{ text: 'Looking.', after: 0 }],
      width: 90,
    }).map(strip).join(LF);
    const recorded = views.activity({
      session: { turns: [{ userInput: 'go', text: 'Looking.', narration: [{ step: 0, text: 'Looking.' }],
        actions: [{ step: 0, name: 'read_file', target: 'a.js', ok: true }] }] },
      width: 90,
    }).map(strip).join(LF);
    assert.ok(!/Read a\.js/.test(live), 'not while it runs');
    assert.ok(!/Read a\.js/.test(recorded), 'and not once it has ended');
  });

  await test('TRANSCRIPT: no hidden reasoning is ever rendered as an operation', () => {
    // An operation is an explicit action LAIN is taking. Nothing in the
    // operation channel comes from model reasoning, and nothing here accepts a
    // paragraph: the cap is what makes that structural rather than a promise.
    const op = require('../../src/ui/operation');
    const ui = { refresh() {} };
    op.note(ui, 'x'.repeat(500));
    assert.ok(ui.op.text.length <= op.MAX, 'an operation is a label, not a monologue');
  });

  // --------------------------------------------- housekeeping is transient --

  await test('OPERATION: an operation is the PRESENT; a resting state is the past', () => {
    const status = require('../../src/ui/status');
    const { PHASE } = require('../../src/turn');
    const note = { text: 'Recovering interrupted turn', level: 'info' };
    const row = (state) => strip(status.statusStrip({ op: note, ...state }, 80, 1, 0).join(''));

    // AN EMPTY ROW IS FILLED.
    assert.match(row({}), /Recovering interrupted turn/);
    assert.ok(!/READY/.test(row({})), 'it fills the row that was empty');

    // WORK IN FLIGHT OUTRANKS IT, always.
    for (const [why, active] of [
      ['a phase', { phase: { phase: PHASE.RECEIVING }, phaseSince: 1 }],
      ['a rate-limit wait', { waitingUntil: 9e12, waitingLabel: 'limit' }],
      ['a question', { awaitingUser: 'which file?' }],
      ['verification', { pendingCompletion: 'the contract' }],
    ]) {
      assert.ok(!/Recovering/.test(row(active)), 'housekeeping must not displace ' + why);
    }

    // ---- BUT A RESTING STATE DOES NOT HOLD THE ROW ----------------------
    //
    // THE DEFECT, found by driving the real binary through a refused credential
    // and then `continue`: the recovery ran, three operations were noted, and not
    // one reached the screen — `failed` was still showing the PREVIOUS turn's
    // 401. A resting state describes what already happened; the moment LAIN
    // starts doing something new it stops being the most specific true thing.
    for (const [why, resting] of [
      ['a failure from the turn that ended', { failed: { kind: 'AUTH', message: 'credential refused' } }],
      ['an interruption', { interrupted: true }],
      ['a settled verdict', { lastTurn: { toolCalls: 2, filesChanged: 1, stopReason: null } }],
    ]) {
      assert.match(row(resting), /Recovering interrupted turn/,
        'an operation outranks ' + why);
    }
  });

  await test('OPERATION: a note cannot make the window title claim work', () => {
    // The spinner is a liveness signal and must never be created by a label.
    const status = require('../../src/ui/status');
    const termtitle = require('../../src/termtitle');
    const live = status.liveState({ op: { text: 'Restoring what LAIN observed', level: 'info' } }, 0);
    assert.ok(!live.spin, 'a note is not work in flight');
    assert.strictEqual(termtitle.stateOf(live), termtitle.STATE.IDLE);
  });

  await test('OPERATION: recovery says what it is doing and writes no prose', () => {
    // The three sentences §5 named are gone from `inputgate.js`; what replaced
    // them is a sequence of operations. Asserted on the source because the
    // recovery path needs a Guardian and a supervisor to run.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'inputgate.js'), 'utf8');
    assert.ok(!/Recovering with what LAIN observed rather than sending/.test(src),
      'the glued recovery paragraph is gone');
    assert.match(src, /op\.say\(app, [^;]*'Recovering interrupted turn'/, 'and is an operation instead');
    assert.match(src, /Restoring what LAIN observed/);
    assert.match(src, /Continuing from verified state/);
    // THE FACT IS STILL RECORDED. `_handover` carries the reason into the packet
    // the model reads, which is what makes this a presentation change.
    assert.match(src, /app\._handover = verdict\.reason/, 'the evidence still travels');
  });

  await test('OPERATION: a clipboard copy is acknowledged without entering the record', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'mouse.js'), 'utf8');
    assert.ok(!/render\.notice\(ok \? 'info'/.test(src), 'the copy notice is no longer a notice');
    assert.match(src, /require\('\.\/operation'\)\.note\(ui, ok/, 'it is a transient operation');
  });

  // -------------------------------------------- the invisible content frame --

  await test('GEOMETRY: the content frame has equal gutters and no fixed cap', () => {
    // THE FRAME MOVED TO ui/frame.js and gained a real right gutter: `content`
    // subtracted only one side, because the feed still carried a two-column indent
    // of its own. It does not any more — the frame owns both margins and the
    // layout applies them. tests/unit/contentframe.test.js is where this property
    // is now pinned in full; these two lines keep the pointer honest.
    for (const w of [60, 80, 100, 120, 160, 240]) {
      const c = views.contentBounds(w);
      assert.strictEqual(c.left, c.right, 'symmetric at ' + w);
      assert.ok(c.width > w * 0.9, 'no arbitrary 80-column cap at ' + w + ': got ' + c.width);
    }
  });

  await test('GEOMETRY: the conversation and the composer start on the same column', () => {
    // The whole of the "invisible content frame": two text edges that agree.
    // Read from what was DRAWN, not from the constants, so the two cannot
    // silently drift.
    const inputbox = require('../../src/ui/inputbox');
    for (const cols of [60, 80, 100, 120, 160]) {
      const s = new Screen({ out: fakeOut(cols, 30) });
      s.enter();
      try {
        s.state = {
          cwd: process.cwd(), session: { turns: [{ userInput: 'hello', text: 'hi', narration: [], actions: [] }] },
          model: 'm', provider: 'p', connection: {}, transcript: [],
          liveActions: [], liveNarration: [], liveNotes: [], liveUser: null, extras: [], current: null,
        };
        s.draw();
        const composer = s.rowMap.inputTextCol;
        const frame = views.contentBounds(cols).left + 1;
        assert.strictEqual(s.rowMap.contentCol, frame, 'the frame is where it says at ' + cols);
        assert.strictEqual(composer, frame + inputbox.PAD,
          'the composer sits one pad inside the frame at ' + cols);
      } finally { s.leave(); }
    }
  });

  await test('GEOMETRY: prose WRAPS and preformatted content does not', () => {
    const out = [];
    feed.pushModel(out, 'A sentence long enough that it has to be broken across more than one row.');
    const prose = feed.renderFeed(out, 44).map(strip);
    assert.ok(prose.length > 1, 'prose wraps');

    const fig = [];
    feed.pushModel(fig, ['Shape:', '', '      A', '      |', '      v', '      B ---> C'].join(LF));
    const drawn = feed.renderFeed(fig, 44).map(strip);
    // EVERY ROW OF THE FIGURE SURVIVES WITH ITS OWN SPACING. A diagram reflowed
    // on whitespace is a diagram destroyed.
    for (const row of ['      A', '      |', '      v', '      B ---> C']) {
      assert.ok(drawn.some((r) => r.includes(row)),
        'the figure lost ' + JSON.stringify(row) + ':' + LF + drawn.join(LF));
    }
  });

  await test('GEOMETRY: a preformatted line too wide to fit FOLDS, losing nothing', () => {
    const md = require('../../src/ui/markdown');
    const line = '    const x = someFunction(argumentOne, argumentTwo, argumentThree, four);';
    const parts = md.foldPre(line, 40);
    assert.ok(parts.length > 1, 'it folded');
    for (const p of parts) assert.ok(T.width(p) <= 40, 'each row fits: ' + JSON.stringify(p));
    // LOSSLESS, which is what lets a selection copy the real text back. The
    // continuation carries the block's own indent, so the join drops it.
    const rejoined = parts[0] + parts.slice(1).map((p) => p.replace(/^ {1,8}/, '')).join('');
    assert.strictEqual(rejoined, line, 'every character survives, in order');
    // AND A RUN OF SPACES IS NEVER COLLAPSED — the prose wrapper would have.
    assert.ok(parts[0].startsWith('    '), 'the indent is kept');
  });

  // ------------------------------------------------------- the turn anchor --

  await test('ANCHOR: it appears only when the message is off screen', () => {
    const anchors = require('../../src/ui/anchors');
    const lines = ['a', 'b', 'c', 'd', 'e', 'f'];
    Object.defineProperty(lines, 'userAt', {
      value: { 0: 'the first thing', 4: 'fix the continuation bug' }, enumerable: false,
    });
    // Window [3,6): the newest message at row 4 is visible.
    assert.strictEqual(anchors.scrollAnchor(lines, 3, 3), null, 'nothing to anchor to');
    // Window [0,3): it has fallen off the bottom.
    const a = anchors.scrollAnchor(lines, 0, 3);
    assert.ok(a, 'the anchor appears');
    assert.strictEqual(a.row, 4, 'and names the row the feed recorded');
    assert.strictEqual(a.label, 'USER · fix the continuation bug');
  });

  await test('ANCHOR: a long prompt is shortened in the anchor ONLY', () => {
    const anchors = require('../../src/ui/anchors');
    const long = 'fix the continuation bug and then also check the resume path end to end please';
    const lines = ['x', 'y', 'z'];
    Object.defineProperty(lines, 'userAt', { value: { 2: long }, enumerable: false });
    const a = anchors.scrollAnchor(lines, 0, 1);
    assert.ok(a.label.length < long.length, 'the anchor is compact');
    assert.match(a.label, /…$/, 'and says it was shortened');
    assert.strictEqual(a.text, long, 'while the full message travels with it');
  });

  await test('ANCHOR: clicking it returns to the exact message, and reports honestly', () => {
    const mouse = require('../../src/ui/mouse');
    const s = new Screen({ out: fakeOut(90, 24) });
    s.enter();
    try {
      const turns = [];
      for (let i = 1; i <= 6; i++) {
        turns.push({
          userInput: i === 6 ? 'fix the continuation bug' : 'question ' + i,
          text: 'a',
          narration: [{ step: 0, text: 'Answer paragraph ' + i + ', long enough to push the view down.' }],
          actions: [{ name: 'edit_file', target: 'f' + i + '.js', ok: true }],
        });
      }
      s.state = { session: { turns }, transcript: [], liveActions: [], liveNarration: [] };
      s.draw();
      // AT THE BOTTOM the message is on screen, so there is no anchor.
      assert.strictEqual(s.rowMap.anchorRow, 0, 'no anchor while the message is visible');

      s.workspaceScroll = 0;
      s.stickToBottom = false;
      s.draw();
      assert.ok(s.rowMap.anchorRow > 0, 'scrolled away, the anchor is drawn');
      assert.ok(s.rowMap.anchorTarget >= 0, 'and knows which row it means');
      // AND IT IS NOT A SECOND PANEL: the anchor rides the header's rule, which
      // is row 2. Read before the click, because the click is what takes it away.
      assert.strictEqual(s.rowMap.anchorRow, 2, 'one row, shared with the rule');

      const ui = { enabled: true, screen: s, panel: { visible: false }, refresh() {}, app: { input: null } };
      const target = s.rowMap.anchorTarget;
      assert.strictEqual(mouse.handleMouse(ui, { kind: 'press', x: 8, y: s.rowMap.anchorRow }), true);
      assert.ok(target >= s.workspaceScroll, 'the message is now in view');
      // AND THE ANCHOR STANDS DOWN, because there is nothing left to reach.
      assert.strictEqual(s.rowMap.anchorRow, 0, 'it does not compete with the message itself');
    } finally { s.leave(); }
  });

  // ---------------------------------------------------------- the composer --

  await test('COMPOSER: still borderless, still grey, and no longer a strip', () => {
    const inputbox = require('../../src/ui/inputbox');
    const s = new Screen({ out: fakeOut(100, 30) });
    s.enter();
    try {
      s.inputText = 'fix the router';
      // `draw` records where it put the text rows, so the map has to exist.
      s.rowMap = { cols: 100 };
      const rows = inputbox.draw(s, { row: 20, cols: 100, textRows: s.geometry().textRows });
      const text = rows.join('');
      for (const glyph of ['┌', '┐', '└', '┘', '│', '─']) {
        assert.ok(!strip(text).includes(glyph), 'no box drawing in the composer: ' + glyph);
      }
      assert.strictEqual(s.geometry().textRows, 3, 'and it is three rows, not one');
    } finally { s.leave(); }
  });

  await test('COMPOSER: resize is safe at every width, and never loses the buffer', () => {
    const long = 'fix the continuation bug and then check the resume path from end to end';
    for (const cols of [40, 60, 80, 100, 120, 160]) {
      const s = new Screen({ out: fakeOut(cols, 30) });
      s.enter();
      try {
        s.inputText = long;
        s.state = {
          cwd: process.cwd(), session: { turns: [] }, model: 'm', provider: 'p', connection: {},
          transcript: [], liveActions: [], liveNarration: [], liveNotes: [], liveUser: null,
          extras: [], current: null,
        };
        s.draw();
        assert.strictEqual(s.inputText, long, 'the buffer is untouched at ' + cols);
        assert.ok(s.geometry().textRows >= 1, 'and the region never vanishes');
      } finally { s.leave(); }
    }
  });
};
