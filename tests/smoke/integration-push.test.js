'use strict';

/**
 * THE NEW SURFACES, THROUGH THE REAL BINARY.
 *
 * Everything here spawns bin/lain.js and asserts on what a person would have
 * read. A unit test proves a function returns the right lines; only this proves
 * the lines reach a screen — which is exactly the class of defect that let
 * `turn.js` compute a liveness phase for the whole life of the project with
 * nothing wired to receive it.
 *
 * LIMITATION, STATED: LAIN_FORCE_TUI runs the real draw path over a PIPE. It is
 * the real geometry, the real key decoding and the real regions; it is not an
 * attached terminal, and nothing here should be read as proof of one.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes, firstTabMark } = require('../helpers');

const tui = (cols = 96, rows = 30) => ({ LAIN_FORCE_TUI: '1', COLUMNS: String(cols), LINES: String(rows) });
// OSC names the window and occupies no cells; it is removed before anything is
// measured or matched, or a title sequence reads as content on the screen.
const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
// Per-frame boundary is `\x1b[?25l` (hide-cursor, written once per draw() and
// nowhere else) now that a redraw no longer opens with a full-screen clear —
// see ui/layout.js's `L` helper for why.
const frames = (out) => String(out).split('\x1b[?25l').slice(1);

/** A small Python project with a real, findable defect in it. */
function probot() {
  const dir = tmpdir('probot-');
  fs.mkdirSync(path.join(dir, 'probot'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask\n');
  fs.writeFileSync(path.join(dir, 'probot', 'dashboard.py'),
    'def refresh():\n    try:\n        pull()\n    except Exception:\n        pass\n\n'
    + 'def render():\n    try:\n        draw()\n    except: pass\n');
  return dir;
}

module.exports = async function () {
  // ------------------------------------------------- project vs LAIN health --

  await test('PUSH: /health reports THE PROJECT, not LAIN runtime state', async () => {
    const r = await runCli([], { cwd: probot(), stdin: '/health\n/exit\n', script: [] });
    const out = plain(r.out);
    assertIncludes(out, 'PROJECT HEALTH —', 'the report must name the project it read');
    assertIncludes(out, 'CODE HEALTH', 'and grade the code');
    assertIncludes(out, 'silently dropped', 'the real defect in this tree must be found');
    assertIncludes(out, 'dashboard.py', 'and pointed at');
    assertIncludes(out, 'NEXT ACTION');
    // The thing that made the old /health wrong for this question.
    assert.ok(!/Context window|Isolation \(V2/.test(out),
      "LAIN's own runtime state must not be the answer to 'is my project healthy'");
  });

  await test('PUSH: /ready reports LAIN readiness, and never claims what is missing', async () => {
    // WAS `/rc`, WHICH NOW MEANS REMOTE CONTROL. The readiness report is the
    // same engine under a new name — see reportcommands.js.
    const r = await runCli([], { cwd: probot(), stdin: '/ready\n/exit\n', script: [] });
    const out = plain(r.out);
    assertIncludes(out, 'RC readiness');
    assertIncludes(out, 'Isolation', 'the separation from V1 and the orchestra is part of readiness');
    assertIncludes(out, 'MISSING', 'a gap must read as a gap');
    // The MCP bridge is a SEAM: with no bridge process configured it must read
    // NOT CONFIGURED however much code exists to talk to one.
    assertIncludes(out, 'NOT CONFIGURED', 'an unconfigured bridge must say so');
    assertIncludes(out, 'MCP bridge');
    assertIncludes(out, 'Desktop permission');
    assertIncludes(out, 'nothing is granted', 'and nothing may be permitted by default');
    // /dash now exists, so claiming it is missing would be the dishonest answer.
    assertIncludes(out, 'Remote dashboard');
    assertIncludes(out, '/dash — localhost by default');
    assert.ok(!/no remote control/.test(out), '/dash is implemented — /rc must report what is true now');
  });

  // ---------------------------------------------------------------- /copy ---

  await test('PUSH: /copy takes a named section, locally, without a turn', async () => {
    const r = await runCli([], {
      cwd: tmpdir('copy-'),
      stdin: 'summarise the plan\n/copy last\n/exit\n',
      script: [{ text: 'The retention window is now seven days.' }],
      timeoutMs: 30000,
    });
    const out = plain(r.out);
    // Either it reached a clipboard or it wrote a file — both are a real
    // answer, and "I could not" is not one of the two.
    assert.ok(/copied last|wrote \d+ line/.test(out), `/copy said nothing useful:\n${out.slice(-600)}`);
    assert.strictEqual(r.code, 0);
  });

  await test('PUSH: /copy with nothing to copy says so, and invents nothing', async () => {
    const r = await runCli([], { cwd: tmpdir('copy2-'), stdin: '/copy diff\n/exit\n', script: [] });
    assertIncludes(plain(r.out), 'nothing to copy yet');
  });

  await test('PUSH: /copy names what it could have meant when the name is wrong', async () => {
    const r = await runCli([], { cwd: tmpdir('copy3-'), stdin: '/copy wibble\n/exit\n', script: [] });
    const out = plain(r.out);
    assertIncludes(out, 'nothing called "wibble"');
    assertIncludes(out, 'troubleshoot', 'and lists the real ones');
  });

  // --------------------------------------------------------------- /steer ---

  await test('PUSH: /steer with no task running says so instead of pretending', async () => {
    const r = await runCli([], { cwd: tmpdir('steer-'), stdin: '/steer read the logs first\n/exit\n', script: [] });
    assertIncludes(plain(r.out), 'No active task to steer');
  });

  await test('PUSH: /steer during a turn is acknowledged and reaches the model', async () => {
    const r = await runCli([], {
      cwd: tmpdir('steer2-'), env: tui(),
      stdinSteps: ['audit the project\n', '/steer read the logs before editing\n'],
      stepDelayMs: 900,
      script: [
        { text: 'Starting.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 3' } }] },
        { text: 'Understood.' },
      ],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    assertIncludes(out, '⚑ STEER', 'the user must see it was accepted');
    assertIncludes(out, 'queued for the next model turn', 'and when it will land');
    assertIncludes(out, 'USER STEER delivered to the model', 'and that it actually landed');
    // It must not have started a second task or thrown the first one away.
    assertIncludes(out, 'audit the project', 'the original task survives a steer');
  });

  // -------------------------------------------------------- /troubleshoot ---

  await test('PUSH: /troubleshoot shows a REPORT, before and after the model runs', async () => {
    const r = await runCli([], {
      cwd: probot(),
      stdin: '/troubleshoot there are errors silently dropped in the dashboard\n/exit\n',
      script: [{
        text: 'Finding: the refresh handler swallows every exception.\n'
          + 'Likely cause: a bare except added to quieten a startup warning.\n'
          + 'Recommended fix: log the exception and re-raise anything unexpected.\n'
          + 'Verification: run the suite and check the log gains the line.',
      }],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'TROUBLESHOOT —', 'the workflow must be visible as a workflow');
    assertIncludes(out, 'PROBLEM');
    assertIncludes(out, 'EVIDENCE');
    assertIncludes(out, 'dashboard.py', 'found locally, before the model was asked anything');
    assertIncludes(out, 'scanned', 'and it says how much it looked at');
    assertIncludes(out, 'FINDING');
    assertIncludes(out, 'swallows every exception');
    assertIncludes(out, 'LIKELY CAUSE');
    assertIncludes(out, 'bare except');
    assertIncludes(out, 'RECOMMENDED FIX');
    assertIncludes(out, 'VERIFICATION');
  });

  await test('PUSH: a troubleshoot the model did not conclude says NOT STATED', async () => {
    const r = await runCli([], {
      cwd: probot(),
      stdin: '/troubleshoot the dashboard drops errors\n/exit\n',
      script: [{ text: 'I looked at a few files and I am not sure yet.' }],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'not stated', 'an absent conclusion must look absent, never be filled in');
    assertIncludes(out, 'WHAT THE MODEL SAID', 'and what it DID say is still shown');
  });

  // ----------------------------------------------------------- status strip --

  await test('PUSH: the LLM status strip is BELOW the workspace and ABOVE the input', async () => {
    const r = await runCli([], {
      cwd: tmpdir('strip-'), env: tui(),
      stdin: 'audit it\n',
      script: [{ text: 'Working.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 2' } }] }, { text: 'Done.' }],
      timeoutMs: 40000,
    });
    const busy = frames(r.out).map(plain).find((f) => /RUNNING\s+sleep 2/.test(f));
    assert.ok(busy, 'a frame must show the tool running');
    // The STRIP, not the header's one-word state — the header also says RUNNING,
    // and it is above the workspace where it belongs.
    const statusAt = busy.search(/RUNNING\s+sleep 2/);
    const inputAt = busy.indexOf('┌─ INPUT');
    const tabsAt = busy.indexOf(firstTabMark());
    assert.ok(tabsAt >= 0 && statusAt >= 0 && inputAt >= 0, 'all three regions must be on screen');
    assert.ok(statusAt > tabsAt, 'the status strip is below the workspace');
    assert.ok(statusAt < inputAt, 'and directly above the input, where the user is looking');
  });

  await test('PUSH: the status strip trails what the turn just did', async () => {
    const r = await runCli([], {
      cwd: tmpdir('trail-'), env: tui(120, 34),
      stdin: 'audit it\n',
      script: [
        { text: 'Looking.', tool_calls: [{ name: 'glob', input: { pattern: '*.js' } }] },
        { text: 'Now the slow bit.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 3' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 45000,
    });
    const f = frames(r.out).map(plain).find((x) => /RUNNING\s+sleep 3/.test(x) && /searching/.test(x));
    assert.ok(f, 'the completed call must still be readable beside the running one');
  });

  // ------------------------------------------------------------ rate limit --

  await test('PUSH: a rate limit says WHEN it ends, counts down, and keeps the task', async () => {
    const r = await runCli([], {
      cwd: tmpdir('rl-'), env: tui(),
      stdin: 'summarise the plan\n',
      // 429 with a Retry-After, then a real answer: the retry must resume the
      // SAME work rather than asking the user to send it again.
      script: [
        { error: { status: 429, retryAfter: 4, message: 'rate limited' } },
        { text: 'Here is the summary.' },
      ],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'RATE LIMITED', 'name what actually happened');
    assert.match(out, /retrying at \d\d:\d\d/, 'an absolute time, so the user can go and do something else');
    assert.match(out, /\d\d:\d\d remaining|00:0\d/, 'and a countdown while it waits');
    assertIncludes(out, 'Esc', 'with a way out of the wait');
    assertIncludes(out, 'the wait is over — resuming the task', 'and the resume is announced');
    assertIncludes(out, 'Here is the summary', 'the original task really did continue');
    assert.strictEqual(r.code, 0);
  });

  await test('PUSH: a long rate limit ASKS, and Esc actually leaves the wait it opens', async () => {
    // TWO BUGS, FOUND LIVE against a real rate-limited bridge, one hiding the
    // other:
    //
    // 1. `app.js`'s `submit(text, ...)` called
    //    `this.handleRateLimit(record, input)` — `input` does not exist in
    //    that scope, only `text` does — so EVERY rate limit long enough to
    //    ask about threw a bare `ReferenceError` the moment it happened,
    //    caught only by the top-level "internal error" handler in repl.js.
    //
    // 2. Fixing #1 exposed a second, worse bug behind it: choosing WAIT (or
    //    just pressing Esc, its documented default) opened a wait with NO WAY
    //    OUT. `waitForReset` (ui/index.js) listens on `this.app.abort.signal`
    //    — exactly as its own header comment says it should, "through the
    //    same abort signal everything else is cancelled by" — but `submit`'s
    //    `finally` nulls `this.abort` the instant the turn loop ends, which is
    //    BEFORE `handleRateLimit` is ever called. So there was no live signal
    //    to listen on, and neither Escape (which had no handler for this state
    //    at all — nothing in ui/keys.js ever read `waitingUntil`) nor Ctrl+C
    //    (whose `working` check also reads `app.abort`) could cancel it. The
    //    status strip said "Esc to stop waiting" the entire time it did
    //    nothing. Fixed by giving the wait its own live controller
    //    (`app.js`) and an actual Escape handler (`ui/keys.js`, `ui/index.js`
    //    `cancelWait`).
    //
    // Nothing here exercised this path before: the OTHER rate-limit tests in
    // this file use a short `retryAfter` (seconds), which the ordinary
    // bounded retry in turn.js handles silently and never reaches this branch
    // at all — see ratelimit.js's `ASK_ABOVE_MS` (90s).
    //
    // `retryAfter` is seconds and must stay at or under 3600 — see
    // `errors.js`'s `retryAfterMs`: anything past an hour is treated as a
    // misparsed absolute timestamp instead of a delta (a real past incident:
    // "a ~26-day wait in V1") and clamped to 0, which would silently fall
    // through to the ordinary bounded retry instead of reaching this branch —
    // exactly the mistake that hid bug #1 from every test until now.
    //
    // The FIRST Esc answers the question as WAIT (its documented default);
    // the SECOND is what this test actually exists to prove — that it now
    // leaves the wait it just opened, in test time rather than the real 300s.
    const r = await runCli([], {
      cwd: tmpdir('rlhrs-'), env: tui(),
      stdinSteps: ['summarise the plan\n', '\x1b', '\x1b', '/exit\n'],
      stepDelayMs: 1200,
      script: [{ error: { status: 429, retryAfter: 300, message: 'quota exhausted' } }],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    assertNotIncludes(out, 'internal error', 'a long rate limit must ask the user, never crash the session');
    assertIncludes(out, 'RATE LIMITED', 'the question must actually open');
    assertIncludes(out, 'Wait for the reset', 'the wait option must be offered');
    assertIncludes(out, 'Change model', 'the change-model option must be offered');
    assertIncludes(out, 'WAITING FOR LIMIT RESET', 'choosing WAIT must actually open the second wait');
    assertIncludes(out, 'stopped waiting', 'Esc must leave that wait, not just the question — never a hang with no way out');
    assert.strictEqual(r.code, 0, 'the session must exit cleanly, in test time, not real 300s');
  });

  await test('PUSH: Escape during the wait cancels it cleanly — never stuck in RETRYING', async () => {
    const r = await runCli([], {
      cwd: tmpdir('rl2-'), env: tui(),
      stdinSteps: ['summarise the plan\n', '\x1b', '/status\n'],
      stepDelayMs: 1200,
      script: [
        { error: { status: 429, retryAfter: 30, message: 'rate limited' } },
        { text: 'should not be reached before the cancel' },
      ],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'RETRY CANCELLED', 'the state must say what the user did');
    // And LAIN must still be usable: a command afterwards has to work.
    assertIncludes(out, 'config', '/status still answers after a cancelled retry');
    assert.strictEqual(r.code, 0, 'and the session ends cleanly');
    const frozen = frames(r.out).map(plain).pop() || '';
    assert.ok(!/RATE LIMITED/.test(frozen), `the last frame still showed the wait:\n${frozen.slice(-400)}`);
  });

  // -------------------------------------------------------- terminal title --

  await test('PUSH: the terminal title is the PROJECT, and it is not hardcoded', async () => {
    const dir = tmpdir('scalpbot-');
    const r = await runCli([], { cwd: dir, env: tui(), stdin: '/exit\n', script: [] });
    const titles = [...r.out.matchAll(/\x1b\]0;([^\x07]*)\x07/g)].map((m) => m[1]);
    assert.ok(titles.length, 'the real binary must actually emit the OSC sequence');
    const folder = path.basename(dir);
    assert.ok(titles.some((t) => t.includes(folder)), `the title must name the project: ${JSON.stringify(titles)}`);
    assert.ok(!titles.some((t) => /lain-v2/.test(t)), 'and must not be the tool own directory');
  });

  // --------------------------------------------------------- resize safety --

  await test('PUSH: with COLOUR ON, every row still fits at every size', async () => {
    // The reason the workspace was plain text: `.length` counts escape bytes as
    // cells, so one coloured row tore the right-hand border off the frame. This
    // is the guarantee that replaced that ban — measured with the visible-width
    // maths the drawing itself uses, through the real binary, at five sizes.
    const T = require('../../src/ui/text');
    for (const [cols, rows] of [[120, 40], [100, 30], [80, 24], [60, 15], [40, 9]]) {
      const r = await runCli([], {
        cwd: probot(),
        env: { ...tui(cols, rows), LAIN_FORCE_COLOR: '1', LAIN_NO_COLOR: '', NO_COLOR: '' },
        stdinSteps: ['fix the dropped errors\n', '\t', '\t', '\t', '\t', '\t', '\t', '/exit\n'],
        stepDelayMs: 400,
        script: [
          { text: 'Reading.', tool_calls: [{ name: 'read_file', input: { path: 'probot/dashboard.py' } }] },
          { text: 'The handler swallows everything.' },
        ],
        timeoutMs: 45000,
      });
      assert.strictEqual(r.code, 0, `${cols}x${rows}: LAIN must survive with colour on`);
      // `\x1b[K` (erase-to-end-of-line) ends every drawn row now — see ui/
      // layout.js's `L` helper — and carries zero visible width, same as the
      // OSC title sequence already stripped here; T.width does not know it
      // (its contract is colour vs plain content, and EOL is neither), so it
      // is removed from the raw stream before anything measures a row.
      const drawn = r.stdout.split('\x1b[?1049l')[0]
        .replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '')
        .replace(/\x1b\[K/g, '');
      let coloured = 0;
      for (const seg of drawn.split(/\x1b\[[0-9]+;[0-9]+H/).slice(1)) {
        for (const line of seg.split('\n')) {
          if (/\x1b\[[0-9;]*m/.test(line)) coloured += 1;
          assert.ok(T.width(line) <= cols,
            `${cols}x${rows}: a row was ${T.width(line)} visible cells — ${JSON.stringify(T.strip(line).slice(0, 120))}`);
        }
      }
      assert.ok(coloured > 20, `${cols}x${rows}: only ${coloured} coloured rows — colour is not actually reaching the screen`);
    }
  });

  await test('PUSH: every region fits at every required size, with no overflow', async () => {
    for (const [cols, rows] of [[120, 40], [100, 30], [80, 24], [60, 15], [40, 9]]) {
      const r = await runCli([], {
        cwd: probot(), env: tui(cols, rows),
        stdin: 'audit it\n', script: [{ text: 'ok' }], timeoutMs: 30000,
      });
      assert.strictEqual(r.code, 0, `${cols}x${rows}: LAIN must survive`);
      const last = frames(r.out).map(plain).filter(Boolean).pop() || '';
      // The screen is written as absolute cursor moves, so a row wider than the
      // terminal shows up as a drawn line longer than `cols`.
      for (const line of last.split(/\x1b\[\d+;1H/).slice(1)) {
        assert.ok(line.length <= cols, `${cols}x${rows}: a row was ${line.length} wide — ${JSON.stringify(line.slice(0, 120))}`);
      }
      assertIncludes(plain(r.out), '┌─ INPUT', `${cols}x${rows}: the input must always be identifiable`);
    }
  });
};
