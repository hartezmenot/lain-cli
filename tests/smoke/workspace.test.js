'use strict';

/**
 * THE WORKSPACE, THROUGH THE REAL BINARY.
 *
 * These cover the things that were broken in a way no unit test could see: the
 * screen was structurally fine and told the user almost nothing. Each case
 * asserts on CONTENT a person would look for, not on a function's return value.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli, assertIncludes, assertNotIncludes } = require('../helpers');

const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' };
const CR = '\n';

/**
 * THE Alt+N THAT REACHES A PANE, ASKED OF ui/tabs.js RATHER THAN WRITTEN DOWN.
 *
 * These tests spelled out their own numbers — `\x1b3` for DIFF, `\x1b4` for
 * OUTPUT, `\x1b5` for FILES — which made each of them a private copy of the tab
 * order. When ACTIVITY was inserted at position 2 and AUDIT and HEALTH were
 * retired, every one of those numbers moved and the tests went on pressing the
 * old keys, opening the wrong pane and failing about a pane they never reached.
 *
 * The order has exactly one owner. Asking it cannot go stale; copying it
 * already did.
 */
const ALT = (view) => {
  const { VIEWS } = require('../../src/ui/tabs');
  const n = VIEWS.indexOf(view);
  assert.ok(n >= 0, `there is no "${view}" pane — ui/tabs.js lists ${VIEWS.join(', ')}`);
  return `\x1b${n + 1}`;
};
const ESC = '\x1b';
const CLEAR = '\x7f'.repeat(40);

// `\x1b[?25l` (hide-cursor) is the per-frame boundary, not `\x1b[2J`
// (erase-screen): a redraw no longer opens with a full clear — see
// ui/layout.js's `L` helper — but still opens with exactly one hide-cursor
// write, written nowhere else in the source.
function frames(out) {
  return String(out).split('\x1b[?25l').map((f) => f.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n'));
}
/** The last frame that matches — what the user was looking at. */
function lastFrameWith(out, re) {
  let best = '';
  for (const f of frames(out)) if (re.test(f)) best = f;
  return best;
}

function project() {
  const d = tmpdir('lain-ws-');
  fs.mkdirSync(path.join(d, 'src'));
  fs.mkdirSync(path.join(d, 'src', 'auth'));
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"demo","scripts":{"test":"echo ok"}}');
  fs.writeFileSync(path.join(d, 'src', 'auth', 'login.js'), 'function login(u,p){\n  return check(u,p);\n}\n');
  fs.writeFileSync(path.join(d, 'src', 'backend.js'), 'const x=1;\n');
  return d;
}

/** A task that reads, writes and runs something — the shape of real work. */
const workScript = [
  { text: 'Scanning the project.', tool_calls: [{ name: 'list_dir', input: { path: 'src' } }] },
  { text: 'Reading the login path.', tool_calls: [{ name: 'read_file', input: { path: 'src/auth/login.js' } }] },
  { text: 'Adding a guard clause.', tool_calls: [{ name: 'write_file', input: { path: 'src/auth/login.js', content: 'function login(u,p){\n  if(!u||!p) return false;\n  return check(u,p);\n}\n' } }] },
  { text: 'Running the test.', tool_calls: [{ name: 'run_cmd', input: { command: 'echo tests passed' } }] },
  { text: 'Done — guard added and verified.' },
];

module.exports = async function () {
  // ---- the launch screen --------------------------------------------------

  await test('WS: launch shows the project, the route and what to type', async () => {
    const r = await runCli([], { cwd: project(), env: tui, script: [{ text: 'ok.' }], stdin: `/exit${CR}`, timeoutMs: 45000 });
    assert.strictEqual(r.code, 0);
    const f = lastFrameWith(r.out, /Type a task below/);
    assert.ok(f, 'the launch screen was drawn');
    assertIncludes(f, 'L   A   I   N', 'the wordmark');
    assertIncludes(f, 'Ready to work.', 'and that LAIN is ready');
    assertIncludes(f, 'Model', 'and what model is configured');
    assertIncludes(f, 'Connection', 'through what');
    assertIncludes(f, 'Effort', 'and at what effort');
    assert.ok(/\/\s+commands/.test(f), 'and how to reach the commands');
    assertNotIncludes(f, 'nothing yet', 'the old empty placeholder is gone');
  });

  await test('WS: housekeeping directories are not presented as the project', async () => {
    const r = await runCli([], { cwd: project(), env: tui, script: [{ text: 'ok.' }], stdin: `/exit${CR}`, timeoutMs: 45000 });
    const f = lastFrameWith(r.out, /Ready to work/);
    assert.ok(!/\.config|\.cfg|\.git/.test(f), 'no housekeeping directories on the start screen');
  });

  // ---- activity -----------------------------------------------------------

  await test('WS: activity shows the request, the narration and each call with its subject', async () => {
    // READ ON THE ACTIVITY PANE, which is the one this test is named for.
    //
    // It used to read whatever pane LAIN lands on. That was the transcript when
    // this was written; the conversation then moved to ACTIVITY and CONTEXT
    // became a briefing with only the TAIL of the feed beneath it (ui/split.js),
    // so the model's prose from the top of a multi-call turn is legitimately
    // above the fold there. The WHOLE account has one home and this is it —
    // asking the landing pane for it was the test's mistake, not the pane's.
    const r = await runCli([], {
      cwd: project(), env: tui, script: workScript,
      stdinSteps: [`fix the login bug${CR}`, ALT('activity'), `/exit${CR}`],
      stepDelayMs: 800, timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const f = lastFrameWith(r.out, /fix the login bug/);
    assertIncludes(f, 'fix the login bug', 'what was asked');
    assertIncludes(f, 'guard clause', 'what the model said');
    assert.ok(/Read src\/auth\/login\.js/.test(f), `human phrasing, not a verb column: ${f.slice(0, 700)}`);
    assert.ok(/Wrote src\/auth\/login\.js/.test(f), 'and the write');
    assert.ok(/Ran echo tests passed/.test(f), 'and the command that ran');
    assert.ok(!/\d+ms/.test(f), 'no per-call timings in the default view');
    // ---- NO ACCOUNTING ON THE CALL ROWS -----------------------------------
    //
    // The rule this was always making is about the ACTIVITY rows: a list of what
    // the model did is a narrative, and hanging a token count off every line
    // turns it into a ledger nobody reads. It was written as a whole-frame
    // assertion because at the time there was nowhere else a token count could
    // appear.
    //
    // There is now: the status strip above the input carries the session's
    // running cost, which is where "what is this costing" is asked and where the
    // duplicate progress bar used to be. So the rule is stated about the rows it
    // was always about, and the strip is asserted separately below.
    for (const row of f.split('\n')) {
      if (!/(Read|Wrote|Ran) /.test(row)) continue;
      assert.ok(!/[↑↓⚡]/.test(row), `no token counters on a call row: ${row.trim()}`);
    }
    assert.ok(/[↑↓]\s*\d/.test(f), 'the strip does carry the running cost, once, in its own row');
  });

  await test('WS: the screen says what is being worked on ONCE, and carries no diagnostics', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script: workScript,
      stdin: `fix the login bug${CR}/exit${CR}`, timeoutMs: 45000,
    });
    const f = lastFrameWith(r.out, /fix the login bug/);
    const head = f.split('\n').filter(Boolean).slice(0, 4).join(' | ');
    // THE TASK IS STILL NAMED, AND NOW ONLY ONCE.
    //
    // It used to be named in the HEADER and again in the TASK banner two rows
    // below it — the same sentence twice, in the part of the screen with the
    // least room to spare. The header's copy went; the banner keeps it, because
    // the banner also carries the progress. The guarantee is unchanged and the
    // duplication is now itself asserted against.
    assert.ok(/fix the login bug/.test(f), 'the screen must still name the task');
    assert.ok(!/fix the login bug/.test(head),
      `and the header must not repeat what the banner says: ${head}`);
    assert.ok(!/\d+ms|↑\d+|toolCalls|turn=/.test(head), `and nothing diagnostic: ${head}`);
  });

  await test('WS: the model never paints over the drawn regions', async () => {
    // Two writers on one terminal produced "┌───Done — added the guard.───┐".
    // In TTY mode stdout belongs to the Screen and nothing else may write to it.
    const r = await runCli([], {
      cwd: project(), env: tui, script: workScript,
      stdin: `fix the login bug${CR}/exit${CR}`, timeoutMs: 45000,
    });
    // A border may carry its region's LABEL — `┌─ ACTIVITY ─…┐`, `┌─ INPUT ─…┐`,
    // or the transient exit hint. Those are drawn BY the screen and are how the
    // regions are identified. What must never appear is anything else: the
    // defect this guards against was the model's prose landing in a border
    // because two writers shared the terminal.
    // What a border is ALLOWED to say: the region it labels, the view selector,
    // or the transient exit hint. Anything else in a border is the defect.
    const KNOWN = /^(?:L A I N|CONTEXT|ACTIVITY|PLAN|DIFF|FILES|OUTPUT|INPUT|COMMANDS|Press Ctrl\+C.*)$/;
    const isViewStrip = (t) => /^\[\d \w+\]/.test(t);
    const labelOf = (l) => l.replace(/^[┌└]─/, '').replace(/─+[┐┘]?$/, '').trim();
    const bad = frames(r.out)
      .flatMap((f) => f.split('\n'))
      .filter((l) => /^[┌└]─+[^─┐┘]/.test(l))
      .filter((l) => { const t = labelOf(l); return !KNOWN.test(t) && !isViewStrip(t); });
    assert.deepStrictEqual(bad, [], `text was drawn into a box border: ${bad.slice(0, 3).join(' / ')}`);
  });

  // ---- the change views ---------------------------------------------------

  await test('WS: diff opens ON the change, with line numbers, and FILES groups what happened', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script: workScript,
      // DIFF, then FILES. No Enter: the diff is the DEFAULT state of the pane
      // now, which is the point. FILES is where the grouping moved.
      stdinSteps: [`fix the login bug${CR}`, ALT('diff'), ALT('files'), `/exit${CR}`],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    // THE DIFF ITSELF, WITHOUT ASKING FOR IT.
    //
    // This used to open on a grouped LIST and need two more Enters to reach the
    // change — so the pane's default state contained no diff at all. The
    // grouping was not lost: it moved to FILES, which is the structural view,
    // and the second half of this test holds it there.
    // Matched on the DIVIDER, not merely on the filename: the FILES pane names
    // the same file, and a looser match would happily pass against it.
    const diff = lastFrameWith(r.out, /━━ src\/auth\/login\.js/);
    assertIncludes(diff, 'src/auth/login.js', 'the file is named on its divider');
    assert.ok(/\d+ \+ /.test(diff), `added lines are numbered: ${diff.slice(0, 500)}`);
    assertIncludes(diff, 'if(!u||!p) return false;', 'and the real change is shown unprompted');

    const files = lastFrameWith(r.out, /~ MODIFIED/);
    assertIncludes(files, 'src/auth/login.js', 'the changed file is listed under its group');
    assert.ok(/~ MODIFIED[\s\S]*src\/auth\/login\.js\s+\+\d+ -\d+/.test(files),
      `with its size: ${files.slice(0, 400)}`);
  });

  await test('WS: files shows the project tree with changed files marked', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script: workScript,
      // ui/tabs.js is the single list that says which number reaches FILES.
      stdin: `fix the login bug${CR}${ALT('files')}${CR}/exit${CR}`, timeoutMs: 45000,
    });
    const f = lastFrameWith(r.out, /PROJECT/);
    assertIncludes(f, 'src/', 'the tree is there before anything is opened');
    assertIncludes(f, 'backend.js', 'including files the task never touched');
    assert.ok(/[├└]─/.test(f), `drawn as a tree: ${f.slice(0, 600)}`);
    assert.ok(/login\.js\s*●/.test(f), `the changed file is marked: ${f.slice(0, 600)}`);
    assertIncludes(f, 'changed this session');
  });

  await test('WS: output carries the real command result', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script: workScript,
      stdin: `fix the login bug${CR}${ALT('output')}${CR}/exit${CR}`, timeoutMs: 45000,
    });
    const f = lastFrameWith(r.out, /echo tests passed/);
    assertIncludes(f, 'OUTPUT');
    assertIncludes(f, 'echo tests passed', 'the command');
    assertIncludes(f, 'tests passed', 'and its real stdout');
  });

  await test('WS: Alt+N really switches views — the tabs are not decoration', async () => {
    // ---- ASKED OF ui/tabs.js, NOT SPELLED OUT -----------------------------
    //
    // This named both the panes it expected and the numbers that reach them,
    // which made it a private copy of the tab order. When ACTIVITY was inserted
    // at position 2 the test went on asserting that Alt+4 opens OUTPUT — it
    // failed, and said nothing useful about why. Driving the numbers FROM the
    // one list means the assertion is the property that matters (the number
    // keys really move between panes) and cannot go stale when a pane moves.
    const VIEWS = require('../../src/ui/tabs').VIEWS;
    const want = ['plan', 'output', 'context'].filter((v) => VIEWS.includes(v));
    const keys = want.map((v) => `\x1b${VIEWS.indexOf(v) + 1}${CR}`).join('');
    const r = await runCli([], {
      cwd: project(), env: tui, script: workScript,
      stdin: `fix the login bug${CR}${keys}/exit${CR}`, timeoutMs: 45000,
    });
    const re = new RegExp(`\\[\\d (${VIEWS.join('|')})`);
    const seen = new Set();
    for (const f of frames(r.out)) {
      const m = re.exec(f);
      if (m) seen.add(m[1]);
    }
    for (const v of want) {
      assert.ok(seen.has(v), `Alt+${VIEWS.indexOf(v) + 1} did not open ${v}: ${[...seen].join(',')}`);
    }
  });

  await test('WS: Tab cycles views when nothing is typed', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script: [{ text: 'ok.' }],
      stdin: `\t\t/exit${CR}`, timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const seen = new Set();
    for (const f of frames(r.out)) {
      const m = /\[\d (context|plan|diff|files|output)/.exec(f);
      if (m) seen.add(m[1]);
    }
    assert.ok(seen.size >= 2, `Tab moved between views: ${[...seen].join(',')}`);
  });

  // ---- plan step navigation ------------------------------------------------

  await test('WS: plan-step expansion is reachable from the keyboard, not just display code', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script: [{ text: 'Starting.' }],
      // STAGED: the PLAN STEPS panel only has steps to show after /plan step
      // has run, and the PLAN pane must be open before Enter opens the panel.
      stdinSteps: [
        `build the parser${CR}`,
        `/plan step design the grammar${CR}`,
        `/plan step write the tokenizer${CR}`,
        ALT('plan'),
        CR,        // Enter on an empty input line -> open the PLAN STEPS panel
        CR,        // select the cursored (first) step
        `/exit${CR}`,
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const panel = lastFrameWith(r.out, /PLAN STEPS/);
    assertIncludes(panel, 'design the grammar', 'the panel lists the real steps');
    assertIncludes(panel, 'active', 'and their real status, not a fixed placeholder');
    const after = lastFrameWith(r.out, /design the grammar/);
    assertIncludes(after, 'Status', 'selecting a step expands it in the real plan view');
    assertIncludes(after, 'working', 'showing the step\'s real status');
  });

  // ---- command output has somewhere to go ---------------------------------

  await test('WS: command output appears in the workspace, not over it', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script: [{ text: 'ok.' }],
      stdin: `/status${CR}/exit${CR}`, timeoutMs: 45000,
    });
    const f = lastFrameWith(r.out, /session\s+\d/);
    assertIncludes(f, 'Status', '/status rendered inside the workspace');
    assertIncludes(f, 'messages');
    assertIncludes(f, '│ >', 'and the input row survived it');
  });

  // ---- /config actually edits ---------------------------------------------

  await test('WS: /config Enter changes a value and persists it', async () => {
    const cwd = project();
    const configDir = path.join(cwd, 'cfg');
    const DOWN = '\x1b[B';
    const r = await runCli([], {
      cwd, configDir, env: tui, script: [{ text: 'ok.' }],
      // STAGED: the panel must be open before the arrows can reach it.
      stdinSteps: [`/config${CR}`, `${DOWN}${DOWN}${DOWN}${DOWN}`, CR, ESC, `${CLEAR}/exit${CR}`],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert.strictEqual(saved.stream, false, 'the toggle was written to the config store');
    const f = lastFrameWith(r.out, /CONFIG/);
    assertIncludes(f, 'OFF', 'and the panel redrew with the new value');
  });

  await test('WS: a modal panel reports NEEDS USER, not WORKING', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script: [{ text: 'ok.' }],
      stdin: `/config${CR}${ESC}${CLEAR}/exit${CR}`, timeoutMs: 45000,
    });
    const f = lastFrameWith(r.out, /CONFIG/);
    assertIncludes(f, 'NEEDS USER', 'waiting on a person is not "working"');
  });
};
