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

// ---- `ALT()` STOOD HERE ------------------------------------------------
//
// It asked ui/tabs.js which number reached which pane, so these tests could
// press Alt+N without keeping a private copy of the order. There are no panes
// and no numbers; what each of them reached is now a command.
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
      stdinSteps: [`fix the login bug${CR}`, `/exit${CR}`],
      stepDelayMs: 800, timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const f = lastFrameWith(r.out, /fix the login bug/);
    assertIncludes(f, 'fix the login bug', 'what was asked');
    assertIncludes(f, 'guard clause', 'what the model said');
    // ---- EACH CALL THAT LEAVES A RECORD, WITH ITS SUBJECT ---------------
    //
    // `verb · subject`, and the verb of a shell command is its program — `Ran` said
    // only that something ran, which every row on the screen shares (ui/phrasing.js).
    //
    // AND THE READ IS NOT HERE, which is the other half of the rule: a successful
    // read is live state, shown in the row above the caret while it happens and
    // gone afterwards (ui/durable.js). What persists is what CHANGED and the
    // verdict the turn ended on.
    assert.ok(/wrote · src\/auth\/login\.js/.test(f), `the write is the record: ${f.slice(0, 700)}`);
    assert.ok(/echo · tests passed/.test(f), 'and the command that ran');
    assert.ok(!/read · src\/auth\/login\.js/.test(f),
      'a routine read must not take a row in the conversation');
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
    // THE HEADER ROW ITSELF — the one carrying the model, which is the only
    // row of metadata there is. Taking "the first few rows" would now catch the
    // top of the conversation, which is exactly where the task SHOULD be.
    const head = f.split('\n').find((l) => /LAIN\s+\S+\s+mock-model/.test(l)) || '';
    // THE TASK IS STILL NAMED, AND NOW ONLY ONCE.
    //
    // It used to be named in the HEADER and again in the pinned TASK banner two
    // rows below it — the same sentence twice, in the part of the screen with
    // the least room to spare. Both are gone: the objective IS the first thing
    // the user said, so the CONVERSATION says it, once, and nothing else does.
    assert.ok(/fix the login bug/.test(f), 'the screen must still name the task');
    assert.ok(!/fix the login bug/.test(head),
      `the header carries metadata, not the task: ${head}`);
    const times = (f.match(/fix the login bug/g) || []).length;
    assert.strictEqual(times, 1, `the task is named ONCE, and was named ${times} times`);
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

  // ---- WHAT THE PANES BECAME ---------------------------------------------
  //
  // DIFF, FILES, OUTPUT and PLAN were four of the nine workspace panes, reached
  // with Alt+N and cycled with Tab. The tests below used to press those keys.
  //
  // §12 of the subtraction: move visibility behind commands, do not delete
  // capability. So the assertions did not go — they moved to the door each
  // pane's content is reached through now, and what they check is exactly what
  // they checked before: that the CONTENT is real, and that it is complete.
  //
  //     diff, files   `/changes`
  //     output        `/jobs <n>`, and the conversation itself
  //     plan          `/plan`
  //
  // Reaching them by command rather than by keystroke is also why these are
  // shorter: there is no navigation left to get wrong, so there is nothing to
  // assert about navigation.

  await test('WS: `/changes` opens ON the change, with line numbers and the real text', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script: workScript,
      stdinSteps: [`fix the login bug${CR}`, `/changes${CR}`, `/exit${CR}`],
      stepDelayMs: 2000,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    // THE DIFF ITSELF, WITHOUT ASKING TWICE FOR IT. The pane used to open on a
    // grouped LIST and need two more Enters to reach the change, so its default
    // state contained no diff at all. The command has no default state to get
    // wrong: it prints the change.
    //
    // Matched on the DIVIDER, not merely on the filename: the grouped list
    // names the same file, and a looser match would happily pass against it.
    const diff = lastFrameWith(r.out, /━━ src\/auth\/login\.js/);
    assertIncludes(diff, 'src/auth/login.js', 'the file is named on its divider');
    assert.ok(/\d+ \+ /.test(diff), `added lines are numbered: ${diff.slice(0, 500)}`);
    assertIncludes(diff, 'if(!u||!p) return false;', 'and the real change is shown unprompted');
    // AND THE GROUPING IS STILL THERE, above it — what FILES carried.
    assertIncludes(diff, 'MODIFIED', 'the change is grouped by what happened to the file');
  });

  await test('WS: the command result is in the conversation, where it happened', async () => {
    // The OUTPUT pane held real shell and test output with exit codes. The
    // conversation holds it now, in the order it happened, beside the prose
    // that asked for it — which is where somebody reading back looks for it.
    const r = await runCli([], {
      cwd: project(), env: tui, script: workScript,
      stdin: `fix the login bug${CR}/exit${CR}`, timeoutMs: 45000,
    });
    const f = lastFrameWith(r.out, /tests passed/);
    assertIncludes(f, 'tests passed', 'the real stdout of the command that ran');
  });

  await test('WS: `/plan` shows the steps, their status and the progress', async () => {
    // The PLAN pane's own content, reached by the command that owns plans.
    // `Enter` used to open a step picker over it; a plan you can read in full
    // does not need one.
    const r = await runCli([], {
      cwd: project(), env: tui, script: [{ text: 'Starting.' }],
      stdinSteps: [
        `build the parser${CR}`,
        `/plan step design the grammar${CR}`,
        `/plan step write the tokenizer${CR}`,
        `/plan${CR}`,
        `/exit${CR}`,
      ],
      stepDelayMs: 1500,
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const f = lastFrameWith(r.out, /design the grammar/);
    assertIncludes(f, 'PLAN', 'the pane\'s own heading, drawn by the command now');
    assertIncludes(f, 'design the grammar', 'the real steps');
    assertIncludes(f, 'write the tokenizer');
    // THEIR STATUS, as the view draws it: the active step is filled, the rest
    // are not. And the progress — which is COMPLETED work, so two steps with
    // the first merely STARTED is `STEP 1/2` at 0%, never 50%.
    assert.ok(/●/.test(f) && /○/.test(f), `the active step is marked: ${f.slice(0, 400)}`);
    assertIncludes(f, 'STEP 1/2', 'where in the plan');
    assert.ok(/\b0%/.test(f) && !/50%/.test(f),
      `progress is completed work, never the active index: ${f.slice(0, 400)}`);
  });

  await test('WS: Tab and Alt+N move nothing, because there is nothing to move to', async () => {
    // The keys are unbound. What must be true is that they are HARMLESS: not a
    // throw, not a scroll, not stray bytes typed into the prompt. The pane
    // labels they used to reveal must never appear.
    const r = await runCli([], {
      cwd: project(), env: tui, script: [{ text: 'ok.' }],
      stdin: `\t\t${ESC}2${ESC}4/exit${CR}`, timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0, 'the session survived every one of them');
    for (const label of ['1 activity', '2 context', '3 plan', '4 diff', '5 output']) {
      assertNotIncludes(r.out, label, `a key revealed a pane: ${label}`);
    }
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
    assertIncludes(f, 'Ask LAIN', 'and the input region survived it');
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
    const f = lastFrameWith(r.out, /CONFIG/i);
    assertIncludes(f, 'OFF', 'and the panel redrew with the new value');
  });

  await test('WS: a modal panel reports NEEDS USER, not WORKING', async () => {
    const r = await runCli([], {
      cwd: project(), env: tui, script: [{ text: 'ok.' }],
      stdin: `/config${CR}${ESC}${CLEAR}/exit${CR}`, timeoutMs: 45000,
    });
    // ------------------------------------------------------------------
    // `NEEDS USER` WAS A HEADER STATUS WORD, and the header no longer carries
    // one: what LAIN is doing has a single owner, the live row above the caret.
    //
    // The property this test exists for is untouched and is the important
    // half — LAIN MUST NOT CLAIM TO BE WORKING WHILE A PICKER IS OPEN. With an
    // open `/config` nothing is running, and the row says so.
    // ------------------------------------------------------------------
    const f = lastFrameWith(r.out, /CONFIG/i);
    assert.ok(!/\bWorking\b|\bThinking\b|\bReceiving\b/i.test(f),
      `a modal panel is LAIN waiting on a person, not LAIN working:
${f}`);
    // NO ACTOR COLUMN FOR LAIN'S OWN WORK — one identity is enough, and the header
    // already carries it (ui/status.js).
    assert.match(f, /\b(READY|DONE)\b/, 'and the live row says plainly that nothing is running');
  });
};
