'use strict';

/**
 * THE REPORTED FAILURE, ON THE REAL BINARY.
 *
 * "The real TUI can become effectively SEARCH / READ / SEARCH / READ while the
 * actual LLM conversational text is missing, buried, or not visible."
 *
 * That was reproduced by driving the binary through the real draw path with a
 * turn that makes thirty tool calls. The frame it produced contained ten rows
 * of `✓ search · .` / `✓ read · src/render.js`, a raw liveness warning, and
 * not one word of what the model or the user had said.
 *
 * These tests hold the fix at the level the user experiences it: what is
 * actually on the screen at the end of a working turn. They assert ORDER as
 * well as presence — a conversation that renders backwards is not a
 * conversation — and they assert on the drawn frame, not on any internal list,
 * because "it is in the session" is exactly what was true while the screen was
 * empty.
 *
 * LIVE CLI VERIFIED, never LIVE PROVIDER VERIFIED: the network call is the
 * mock, and everything else — argv, REPL, session, turn loop, tool dispatch,
 * filesystem, rendering — is the real thing.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, lastFrameRows, frames } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * The last drawn frame — what a person would be looking at.
 *
 * As one string for substring checks, and as ROWS for anything that counts
 * them. A drawn frame contains no newlines: the Screen positions every row with
 * `ESC[<row>;1H`, so splitting the stripped text on '\n' gives one enormous
 * line — and a row count taken that way is always zero. See helpers.rowsOf.
 */
function lastFrame(out) {
  return lastFrameRows(out).join('\n');
}

/** A project with enough files for a long investigation to be plausible. */
function project() {
  const dir = tmpdir('conv-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const f of ['dashboard.js', 'render.js', 'status.js', 'feed.js']) {
    fs.writeFileSync(path.join(dir, 'src', f), `// ${f}\n${'const x = 1;\n'.repeat(30)}`);
  }
  return dir;
}

/** A turn that searches and writes `n` times, saying something at `saidAt`. */
function flood(n, said = {}) {
  const steps = [];
  for (let i = 0; i < n; i++) {
    const file = ['dashboard.js', 'render.js', 'status.js', 'feed.js'][i % 4];
    steps.push({
      text: said[i] || '',
      // ---- HALF ROUTINE, HALF DURABLE --------------------------------
      //
      // A successful read or search is live state and leaves no row in the
      // conversation at all (ui/durable.js), so a flood made only of those can
      // no longer test the run COMPACTION this exists for. A WRITE persists, and a
      // turn that writes fourteen files is just as real a flood. Both halves are
      // then asserted: the writes are compacted, and the searches are simply gone.
      tool_calls: [i % 2
        // A NEW FILE EACH TIME. `write_file` refuses to overwrite a file this
        // session has not read, and refuses to shrink a substantial one without
        // `truncate` — both correct, and both would make these writes FAIL, which
        // is a different test (a failure is never compacted away).
        ? { name: 'write_file', input: { path: `src/gen/${file}-${i}.js`, content: `// pass ${i}` } }
        : { name: 'grep', input: { pattern: `token${i}`, path: '.' } }],
    });
  }
  return steps;
}

module.exports = async function () {
  await test('CONVERSATION LIVE: thirty tool calls do not bury what was said', async () => {
    const script = flood(14, {
      0: 'I am tracing where the dashboard update stops.',
      13: 'The defect is a stale cache in status.js. Nothing else touches it.',
    });
    script.push({ text: 'That is the whole change.' });
    const r = await runCli([], {
      cwd: project(),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'find the dashboard bug\n',
      script,
      timeoutMs: 90000,
    });
    const frame = lastFrame(r.out);

    // THE THREE THINGS THAT WERE MISSING.
    //
    // THE USER'S WORDS ARE ON SCREEN — by whichever of the two routes owns
    // them. This asserted `❯ find the dashboard bug` specifically, which was
    // right when the FIRST message was drawn twice: once by the pinned TASK
    // banner and again as a user row, three rows apart. The duplicate is gone,
    // so the objective is now the banner's alone and the `❯` rows belong to
    // everything said after it. The requirement never changed — the user must
    // be visible in their own conversation — so it is asserted as itself
    // rather than as one particular rendering of it.
    assert.ok(/TASK\s+find the dashboard bug/.test(frame) || /❯ find the dashboard bug/.test(frame),
      `the user is a participant in their own conversation:\n${frame}`);
    assert.ok(!/(❯ find the dashboard bug[\s\S]*){2}/.test(frame),
      `the objective is drawn twice — the banner and a user row both have it:\n${frame}`);
    assertIncludes(frame, 'LAIN', 'and the model must be visible as a speaker');
    assertIncludes(frame, 'stale cache in status.js', 'the answer must survive the flood that produced it');

    // AND THE FLOOD ITSELF, COUNTED RATHER THAN SPELLED OUT.
    const rows = lastFrameRows(r.out).filter((l) => /[✓✗]/.test(l) && !/TOOL /.test(l));
    assert.ok(rows.length >= 1, `no call rows were drawn at all:\n${frame}`);
    assert.ok(rows.length <= 8, `${rows.length} call rows on one screen is the failure:\n${frame}`);
    assert.ok(/×\d/.test(frame), `a long run must be counted, not listed:\n${frame}`);
    // AND THE SEVEN SEARCHES LEFT NOTHING BEHIND AT ALL, which is the other
    // half of not burying the answer.
    assert.ok(!/search · /.test(frame),
      `a routine search must not take a row in the conversation:\n${frame}`);
  });

  await test('CONVERSATION LIVE: the order is USER, then LAIN, then what LAIN did', async () => {
    const r = await runCli([], {
      cwd: project(),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '40' },
      stdin: 'why is the dashboard stale\n',
      script: [
        // A WRITE, NOT A READ. A successful read leaves no row (ui/durable.js),
        // and this test is about the ORDER of the rows there are.
        { text: 'Looking at the renderer first.', tool_calls: [{ name: 'write_file', input: { path: 'src/gen/render-note.js', content: '// touched' } }] },
        { text: 'The cache is never invalidated.', tool_calls: [{ name: 'grep', input: { pattern: 'cache', path: '.' } }] },
        { text: 'That is the defect.' },
      ],
      timeoutMs: 60000,
    });
    const frame = lastFrame(r.out);
    const at = (needle) => {
      const i = frame.indexOf(needle);
      assert.ok(i >= 0, `missing from the frame: ${needle}\n${frame}`);
      return i;
    };
    assert.ok(at('why is the dashboard stale') < at('Looking at the renderer first.'),
      'the question comes before the answer');
    assert.ok(at('Looking at the renderer first.') < at('render-note.js'),
      'LAIN says what it is about to do, THEN does it');
    assert.ok(at('The cache is never invalidated.') < at('That is the defect.'),
      'and the conversation reads downward');
  });

  await test('CONVERSATION LIVE: hitting the step limit STOPS, truthfully and once', async () => {
    // THIS TEST HAS NOW BEEN WRITTEN THREE WAYS, and the middle one was wrong.
    //
    //   1. It asserted `MODEL INTERRUPTED` — untrue: nobody interrupted it.
    //   2. It asserted `CONTINUING … (n of 4 automatic carry-ons)`. LAIN
    //      manufactured up to four extra model turns, each carrying a synthetic
    //      "continue from where you stopped" prompt, each re-sending the whole
    //      conversation, each leaving that prompt permanently in the history.
    //      That is LAIN taking ownership of the model's reasoning loop to paper
    //      over its own execution bound.
    //   3. This one: it stops, ONCE, and says what actually happened.
    //
    // `maxSteps` bounds LAIN's EXECUTION. It is not a claim about the task and
    // not a licence to spend four more requests deciding that the model did not
    // mean to stop. The task stays ACTIVE and the next thing the user types
    // carries it on.
    //
    // A REAL CAP, THROUGH THE REAL CONFIG: `maxSteps` is a config key, not an
    // environment variable, so an env name nothing reads would have made this
    // pass for a reason it does not state.
    const cwd = project();
    const configDir = path.join(cwd, '.config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ maxSteps: 3 }), 'utf8');

    const r = await runCli([], {
      cwd,
      configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'audit everything\n',
      script: flood(12, { 0: 'Starting the audit.' }),
      timeoutMs: 120000,
    });
    // ACROSS THE WHOLE RUN, not the last frame: the announcement is made when
    // the turn ends and scrolls away as the next one works.
    const everything = plain(r.out);

    // IT SAYS WHAT HAPPENED. Not DONE — the task is not finished. Not FAILED —
    // nothing failed. Not INTERRUPTED — nobody interrupted it. LAIN reached its
    // own execution boundary, and that is the truthful thing to report.
    assert.match(everything, /STEP LIMIT/, `the ending must be named:\n${lastFrame(r.out)}`);

    // AND IT MANUFACTURED NOTHING. No extra turn, no synthetic prompt, no
    // budget being counted down in front of the user.
    assert.ok(!/CONTINUING/.test(everything), 'LAIN must not carry on by itself');
    assert.ok(!/automatic carry-ons/.test(everything), 'there is no continuation budget any more');
    assert.ok(!/Continue from exactly where you stopped/i.test(everything),
      'no synthetic continuation prompt may be injected into the conversation');

    // THE SCRIPT PROVES IT STOPPED ONCE. `flood(12)` offers twelve tool-calling
    // responses against a cap of three steps; a carry-on chain would have eaten
    // far more of them than one turn can.
    //
    // COUNTED AS DISTINCT ACTIONS, NOT AS OCCURRENCES — the same defect already
    // fixed once in autonomy.test.js, and it was here too. Matching `✓ Read`
    // across the whole byte stream counts REPAINTS: every redraw paints the
    // ACTIONS rows again, so a run that made exactly three calls (and printed
    // STEP LIMIT correctly) reported twenty across thirty-four frames. It
    // passed for as long as it did purely because the frame count happened to
    // stay low — a test reporting on the renderer's chattiness while claiming
    // to report on the step bound. Each action line names its own argument, so
    // distinct lines are distinct calls.
    //
    // ---- AND THE KEY HAS TO STOP AT THE END OF THE ACTION -----------------
    //
    // `[^\r\n]{1,60}` was the same mistake one level down. A DRAWN FRAME HAS NO
    // NEWLINES — every row is positioned with an escape — so the match ran
    // straight off the end of the action row and swallowed whatever was drawn
    // next on the stream. What is drawn next is the LIVE ACTIVITY POSITION,
    // whose subject materialises character by character, so one call could
    // produce a different key on every frame:
    //
    //     ✓ Searched for "token0"  searching    /
    //     ✓ Searched for "token0"  searching    /|
    //     ✓ Searched for "token0"  │ ✓ Read src/render.js  searching    /|=
    //
    // Five keys, one call — the Set counting the animation rather than the
    // calls, which is exactly what the note above says this test must not do.
    // It failed intermittently, because whether it happened depended on how
    // much the live row happened to move. Stopping at the gap that ends the row
    // makes the key the action and nothing else.
    const calls = new Set(everything.match(
      /✓ (?:[a-z_]+) · [^\s│][^│\r\n]*?(?=\s{2,}|│|$)/g) || []);
    assert.ok(calls.size <= 4,
      `${calls.size} calls (${[...calls].join(' | ')}) means the turn did not stop at its bound`);

    // AND THE TASK IS STILL OPEN, so the next thing typed continues it rather
    // than starting again. Stopping is not the same as being finished.
    assert.ok(!/TASK COMPLETE/.test(everything), 'a bounded turn completes nothing');
  });

  await test('CONVERSATION LIVE: a liveness warning is a quiet NOTE, not the loudest thing on screen', async () => {
    // Reading the same file over and over trips the liveness guard. Its warning
    // used to arrive as raw transcript printed BELOW the entire conversation.
    const script = [];
    for (let i = 0; i < 8; i++) {
      script.push({ text: i === 0 ? 'Checking the renderer.' : '', tool_calls: [{ name: 'read_file', input: { path: 'src/render.js' } }] });
    }
    const r = await runCli([], {
      cwd: project(),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'check the renderer\n',
      script,
      timeoutMs: 90000,
    });
    const frame = lastFrame(r.out);
    assertIncludes(frame, 'check the renderer', 'the user survives it');
    // Whatever the guard decided, the conversation must still be readable and
    // the machinery must not be sitting under all of it as unlabelled prose.
    const tail = lastFrameRows(r.out).slice(-14).join('\n');
    assert.ok(!/^\s*\[liveness\]/m.test(tail),
      `a raw notice is printed under the conversation:\n${tail}`);
    // AND IT IS STILL SAID, in the place that owns it.
    //
    // Without this the test had stopped being able to fail: `[liveness]` is a
    // string the program no longer emits anywhere, so the negative assertion
    // above passes on an empty screen, on a crash, and on a build where the
    // detection was deleted outright. The observation now goes to the panel as
    // an advisory, so that is what must be there.
    const drawn = frames(r.out).map(plain).join('\n');
    assert.match(drawn, /STILL\s+GOING\s+ROUND/i,
      'eight identical reads must still be reported — to the user, in the panel');
  });

  await test('CONVERSATION LIVE: model selection does not sit in Context all session', async () => {
    // "model X via Y — /models to change" is state, not conversation. Left in
    // the transcript it was the last thing on screen whenever the model went
    // quiet, which reads as "stuck at model selection".
    const r = await runCli([], {
      cwd: project(),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'fix the renderer\n',
      script: [
        { text: 'Reading it.', tool_calls: [{ name: 'read_file', input: { path: 'src/render.js' } }] },
        { text: 'Nothing to change.' },
      ],
      timeoutMs: 60000,
    });
    const frame = lastFrame(r.out);
    assert.ok(!/\/models to change/.test(frame),
      `model selection is still pinned in the conversation:\n${frame}`);
    assertIncludes(frame, 'Nothing to change.', 'while the actual answer is on screen');
  });

  await test('SCROLL LIVE: reading history mid-turn is not interrupted, and says what was missed', async () => {
    // The third viewport state, on the real binary: scroll up WHILE LAIN is
    // working, keep talking, and the view must stay where it was left while the
    // strip reports how many messages arrived behind it.
    const wait = (ms) => ({
      name: 'run_bash',
      input: { command: `node -e "const t=Date.now();while(Date.now()-t<${ms});"` },
    });
    const script = [];
    // A DIFFERENT FILE EACH TIME. Reading one file eight times trips the
    // liveness guard, the turn is blocked at step five, and the test would be
    // measuring the guard rather than the viewport.
    const files = ['dashboard.js', 'render.js', 'status.js', 'feed.js'];
    for (let i = 0; i < 8; i++) {
      script.push({
        text: `Line ${i}: LAIN is working through the tree.`,
        tool_calls: [{ name: 'read_file', input: { path: `src/${files[i % 4]}` } }],
      });
    }
    // The window in which the user scrolls up, then three things said after it.
    script.push({ text: 'Now running the slow check.', tool_calls: [wait(6000)] });
    script.push({ text: 'The check came back clean.', tool_calls: [{ name: 'read_file', input: { path: 'src/feed.js' } }] });
    script.push({ text: 'One more thing to confirm.', tool_calls: [{ name: 'read_file', input: { path: 'src/status.js' } }] });
    script.push({ text: 'That is the conclusion.' });

    const PAGEUP = '\x1b[5~';
    const r = await runCli([], {
      cwd: project(),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '96', LINES: '24' },
      // Paced so the two PageUps land inside the slow check.
      stdinSteps: ['walk the tree and summarise\n', '', '', '', PAGEUP, PAGEUP],
      stepDelayMs: 1200,
      script,
      timeoutMs: 90000,
    });
    const frame = lastFrame(r.out);
    assert.match(frame, /↓ \d+ new/, `no new-activity indicator after scrolling away:\n${frame}`);
    assert.match(frame, /↓ \d+ new · End/, 'and it must name the way back');
    // AND THE VIEW STAYED PUT. If new output had dragged the reader back down,
    // the last thing said would be on screen — that is the whole failure this
    // state exists to prevent.
    assert.ok(!frame.includes('That is the conclusion.'),
      `new output dragged the view back to the bottom:\n${frame}`);
  });
};
