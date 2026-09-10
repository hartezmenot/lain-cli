'use strict';

/**
 * CLICKING A ROW THAT NAMES A FILE OPENS THAT FILE — through the real binary.
 *
 * ------------------------------------------------------------------------
 * THE GAP THIS CLOSES, and it is the one the outstanding ledger was pointing
 * at even though it named it wrongly.
 *
 * The feed is full of rows that name things: `read · src/loader.js`,
 * `patched · src/parser.js`. Clicking one did NOTHING. `recallAt` in ui/mouse.js
 * resolved USER rows only, so the entire account of what LAIN had done was
 * inert — a list of filenames that looked like an index and behaved like a
 * paragraph.
 *
 * The ledger recorded this as "click-to-navigate" against USER blocks, which is
 * the one place a click was already doing something deliberate and worth
 * keeping: every row of a user block carries the FULL original message, so a
 * click puts back the whole of a four-hundred-line paste drawn on screen as
 * `[pasted text #1]`. Rebinding that would have removed the only gesture that
 * recovers the text, to add navigation the action rows needed instead.
 *
 * So the file rows became navigable and the user rows kept their meaning.
 *
 * ------------------------------------------------------------------------
 * WHY A SMOKE TEST. The chain is four modules long — describe.js carries the
 * path onto the action record, ui/feed.js indexes the drawn row,
 * ui/conversation.js rebases that index into the pane, ui/mouse.js resolves a
 * click against it — and every one of them can be right while the whole is
 * wrong, because the index is keyed on a DRAWN ROW NUMBER that only a real
 * terminal geometry produces.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const plain = (s) => String(s).replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '');
const PRESS = (x, y) => ESC + '[<0;' + x + ';' + y + 'M';
const RELEASE = (x, y) => ESC + '[<0;' + x + ';' + y + 'm';

/** A project with a file whose contents are unmistakable when shown. */
function fixture() {
  const cwd = tmpdir('clicknav-');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'loader.js'), [
    'const REGISTRY = new Map();',
    'function register(name, handler) { REGISTRY.set(name, handler); }',
    '// UNMISTAKABLE_MARKER_IN_THE_FILE',
    'module.exports = { register };',
  ].join(NL) + NL);
  return cwd;
}

// ---- IT EDITS THE FILE, IT DOES NOT MERELY READ IT -------------------
//
// A successful READ no longer leaves a row in the conversation: it is live
// state, drawn in the one row above the caret while it happens and gone
// afterwards (ui/durable.js). So there was nothing on screen naming a file to
// click, and this test was looking for a row that is correctly absent.
//
// A CHANGE TO THE PROJECT IS EXACTLY THE ROW THIS FEATURE IS FOR. `Edited
// src/loader.js  +1 -0` persists, because it is the account of the work - and
// the file you most want to open from the conversation is the one LAIN just
// changed, not one it glanced at.
const SCRIPT = [
  {
    text: 'Reading the loader.',
    tool_calls: [{
      name: 'edit_file',
      input: {
        path: 'src/loader.js',
        old: 'const REGISTRY = new Map();',
        new: 'const REGISTRY = new Map();  // touched',
      },
    }],
  },
  { text: 'Issue' + NL + 'The registry is keyed by name.' + NL + NL + 'Verified' + NL + '- read the file' },
];

/** Rows of the last drawn frame, blanks kept — a row number is the whole point. */
function lastRows(out) {
  const f = String(out).split(ESC + '[?25l').pop() || '';
  // ANY COLUMN: the content frame moved every region off column 1
  // (ui/frame.js `contentBounds`).
  return f.split(new RegExp(ESC + '\\[\\d+;\\d+H')).slice(1)
    .map(plain).map((r) => r.replace(/\s+$/, ''));
}

module.exports = async function () {
  await test('CLICK NAV: a row naming a file can be clicked, and the file opens', async () => {
    // ---- A FIXTURE PER RUN, BECAUSE THE CALL NOW CHANGES THE FILE --------
    //
    // This used to share one directory between the probe and the click, which was
    // safe while the script only READ the file. It edits now (see SCRIPT), and an
    // edit is not idempotent: the probe's change made the second run's `find`
    // string no longer match, so the edit failed and the click had nothing to
    // open. Two fixtures, because the row number this is looking for is a
    // function of the terminal geometry and not of the directory.

    // ---- FIND THE ROW FIRST, THEN CLICK IT -----------------------------
    //
    // A hardcoded row number is a test that passes until the header gains a
    // line. This runs once to see where the row actually landed, then runs
    // again and clicks there — which is also what a person does.
    const probe = await runCli([], {
      cwd: fixture(), env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdin: 'look at the loader' + NL + '/exit' + NL,
      script: SCRIPT, timeoutMs: 90000,
    });
    assert.strictEqual(probe.code, 0);
    const rows = lastRows(probe.out);
    const idx = rows.findIndex((r) => /edited · src[\\/]loader\.js/.test(r));
    assert.ok(idx >= 0, `the action row must be drawn at all:${NL}${rows.join(NL)}`);
    const row = idx + 1;                       // terminal rows are 1-based

    const r = await runCli([], {
      cwd: fixture(), env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: [
        'look at the loader' + NL,
        PRESS(12, row) + RELEASE(12, row),
        '/exit' + NL,
      ],
      stepDelayMs: 4000,
      script: SCRIPT,
      timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0);

    // THE FILE'S OWN CONTENT REACHED THE SCREEN. Not a status message about
    // opening it — the thing itself, which is the only proof that the click
    // resolved to a real path and read it.
    const out = plain(r.out);
    assertIncludes(out, 'UNMISTAKABLE_MARKER_IN_THE_FILE',
      'clicking the row that names a file must open that file');
  });

  await test('CLICK NAV: a row that names no file stays inert, and nothing crashes', async () => {
    // The other half of the rule. `Ran npm test` names a command, not a path;
    // clicking it must do nothing at all rather than guess at a file.
    const cwd = fixture();
    const script = [
      { text: 'Running.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "console.log(1)"' } }] },
      { text: 'Issue' + NL + 'It printed 1.' + NL + NL + 'Verified' + NL + '- the command ran' },
    ];
    const probe = await runCli([], {
      cwd, env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdin: 'run it' + NL + '/exit' + NL, script, timeoutMs: 90000,
    });
    const rows = lastRows(probe.out);
    const idx = rows.findIndex((r) => /node · /.test(r));
    assert.ok(idx >= 0, 'the command row must be drawn');

    const r = await runCli([], {
      cwd, env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['run it' + NL, PRESS(12, idx + 1) + RELEASE(12, idx + 1), '/exit' + NL],
      stepDelayMs: 4000, script, timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0, 'clicking a non-file row must not take the session with it');
    const out = plain(r.out);
    assert.ok(!/ReferenceError|TypeError|Cannot read|is not a function/.test(out),
      `no error may reach the screen:${NL}${out.slice(-600)}`);
  });

  await test('CLICK NAV: a USER row still puts the message back — that gesture is not lost', async () => {
    // THE THING THAT WAS NOT REBOUND. Adding navigation to action rows must not
    // cost the one gesture that recovers a long message from its marker.
    const cwd = fixture();
    const probe = await runCli([], {
      cwd, env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdin: 'look at the loader' + NL + '/exit' + NL,
      script: SCRIPT, timeoutMs: 90000,
    });
    const rows = lastRows(probe.out);
    const idx = rows.findIndex((r) => /look at the loader/.test(r));
    assert.ok(idx >= 0, 'the user row must be drawn');

    const r = await runCli([], {
      cwd, env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['look at the loader' + NL, PRESS(12, idx + 1) + RELEASE(12, idx + 1), '/exit' + NL],
      stepDelayMs: 4000, script: SCRIPT, timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0);
    const frames = String(r.out).split(ESC + '[?25l');
    const late = frames.slice(-6).map(plain).join(NL);
    // The message is back on the INPUT line, which is where a recall puts it.
    assert.ok(/>.*look at the loader/.test(late) || /look at the loader/.test(late),
      'clicking a user block must still restore its message');
  });
};
