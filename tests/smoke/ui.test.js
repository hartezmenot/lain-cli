'use strict';

/**
 * REAL-BINARY UI SMOKE TESTS.
 *
 * A child process never receives a TTY, so `LAIN_FORCE_TUI=1` runs the real
 * draw path over a pipe. Only the isTTY check is bypassed — the layout, header,
 * views, panel and key handling are all production code. Everything asserted
 * here was drawn by the actual binary.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli, rowsOf, assertIncludes, assertNotIncludes } = require('../helpers');

const CONFIG = {
  connections: {
    omniroute: {
      provider: 'anthropic', via: 'bridge', baseUrl: 'http://localhost:20128/v1',
      models: ['claude-opus-5-low', 'claude-opus-5-medium', 'claude-opus-5-high', 'kimi-k3'],
    },
  },
};

function ws() {
  const cwd = tmpdir('lain-ui-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(CONFIG, null, 2), 'utf8');
  return { cwd, configDir };
}

/** Strip ANSI so assertions read the text the user sees. */
function plain(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\[[0-9;]*H/g, '\n');
}

const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' };

module.exports = async function () {
  await test('UI SMOKE: the four regions are drawn by the real binary', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdin: '/exit\n',
      script: [],
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);
    // ---- THE FOUR REGIONS, AS THEY ARE NOW DRAWN -------------------------
    //
    // The header was a framed box (`┌─ L A I N ─…┐`) over a numbered tab strip,
    // and the input was a labelled box. It is one dim row of metadata, a rule,
    // the conversation, one live activity row, and a grey input with no border.
    // Each of the four is asserted by the thing only it draws.
    assertIncludes(out, 'LAIN', 'the header wordmark');
    assertIncludes(out, path.basename(cwd), 'the project folder, on the header');
    assertIncludes(out, 'READY', 'the live activity row says nothing is running');
    assertIncludes(out, 'Ask LAIN', 'and the input says what it is for');
    // AND NO TAB STRIP UNDER IT.
    assertNotIncludes(out, '[1 activity]', 'there is one surface, so there is no strip');
  });

  await test('UI SMOKE: alternate screen is entered AND restored on exit', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], { cwd, configDir, env: tui, stdin: '/exit\n', script: [] });
    assertIncludes(r.stdout, '\x1b[?1049h', 'entered the alternate screen');
    assertIncludes(r.stdout, '\x1b[?1049l', 'restored the user terminal');
    assertIncludes(r.stdout, '\x1b[?25h', 'cursor restored');
  });

  await test('UI SMOKE: header shows model · connection · effort as separate fields', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdin: '/model claude-opus-5 omniroute\n/effort high\n/exit\n',
      script: [],
    });
    const out = plain(r.stdout);
    assertIncludes(out, 'Claude Opus 5');
    assertIncludes(out, 'omniroute');
    assertIncludes(out, 'high');
  });

  await test('UI SMOKE: progress reports COMPLETED work, not the current step', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir, env: tui,
      // Three steps, none finished: must read 0%, never 33%.
      stdin: 'build it\n/plan step a\n/plan step b\n/plan step c\n/plan\n/exit\n',
      script: [{ text: 'ok' }],
    });
    // WHERE progress is stated has moved twice. It was on the header AND on the
    // pinned TASK banner two rows below; the header's copy went first, and the
    // banner went with the panes. It is `/plan` now — asked for rather than
    // always drawn, because it changes when a step completes, which is minutes
    // apart.
    //
    // WHAT it states is unchanged, and that is the guarantee this test exists
    // for — with three steps and none finished, progress is 0%. Reporting
    // current/total would call work finished the moment it began, which is the
    // one thing a progress indicator must never do.
    const out = plain(r.stdout);
    assertIncludes(out, 'STEP 1/3', 'the step count is still on screen');
    assertIncludes(out, '0%');
    assertNotIncludes(out, '33%', 'current/total would wrongly show 33%');
  });

  await test('UI SMOKE: finishing a step advances progress', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdin: 'build it\n/plan step a\n/plan step b\n/plan done finished a\n/plan\n/exit\n',
      script: [{ text: 'ok' }],
    });
    // Same move, same guarantee: one of two steps done is 50%, and it is the
    // COMPLETED count that drives it.
    const out = plain(r.stdout);
    assertIncludes(out, 'STEP 2/2', 'the step count is still on screen');
    assertIncludes(out, '50%');
  });

  await test('UI SMOKE: what the panes showed is reachable, as commands', () => {
    // ------------------------------------------------------------------
    // THIS USED TO PRESS Alt+N AND CHECK THAT `context`, `plan`, `diff`,
    // `files` and `output` all appeared in the tab strip. There is no strip and
    // there are no panes.
    //
    // §12 of the subtraction: move visibility behind commands, do not delete
    // capability. So the property that replaces it is that every one of those
    // still has a door — asserted against the REGISTRY, which is the thing that
    // would actually be wrong if one had been lost.
    //
    // What each pane BECAME is tested where it lives: `/changes` in
    // tests/smoke/workspace.test.js, `/plan` beside it, `/token` in
    // tests/unit/outputcount.test.js, `/brief detail` in
    // tests/unit/contextpane.test.js.
    // ------------------------------------------------------------------
    const { REGISTRY } = require('../../src/commands');
    const doors = {
      context: '/brief',
      plan: '/plan',
      diff: '/changes',
      files: '/changes',
      output: '/jobs',
      memory: '/note',
      tokens: '/token',
    };
    for (const [pane, cmd] of Object.entries(doors)) {
      assert.ok(REGISTRY.has(cmd), `the ${pane} pane's content must still be reachable, as ${cmd}`);
    }
  });

  await test('UI SMOKE: /models opens the interaction panel, model-centric', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdin: '/models\n\x1b\n/exit\n',        // open, Esc to close, exit
      script: [],
    });
    const out = plain(r.stdout);
    assert.match(out, /models/i, 'panel title');
    assertIncludes(out, 'Claude Opus 5');
    assertIncludes(out, 'routes', 'route count, not raw provider ids');
    assertNotIncludes(out, 'claude-opus-5-low', 'effort variants stay collapsed');
    assertIncludes(out, '↑↓', 'navigation footer');
  });

  await test('UI SMOKE: bare /effort opens the panel with auto offered', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdin: '/model claude-opus-5 omniroute\n/effort\n\x1b\n/exit\n',
      script: [],
    });
    const out = plain(r.stdout);
    assert.match(out, /effort/i);
    assertIncludes(out, 'low');
    assertIncludes(out, 'auto', 'auto is always offered');
  });

  await test('UI SMOKE: /provider uses the interaction panel', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], { cwd, configDir, env: tui, stdin: '/provider status\n', script: [] });
    const out = plain(r.stdout);
    assert.match(out, /providers/i);
    assertIncludes(out, 'availability:');
    assertIncludes(out, 'readiness:');
    assertIncludes(out, 'credential:');
  });

  await test('UI SMOKE: /config uses the SAME panel', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], { cwd, configDir, env: tui, stdin: '/config\n', script: [] });
    const out = plain(r.stdout);
    assert.match(out, /config/i, 'the config panel titles itself');
    assertIncludes(out, 'effort');
  });

  await test('UI SMOKE: EOF with a panel open still exits cleanly and saves', async () => {
    // An open panel awaits a selection; end of input must cancel it rather than
    // leaving the loop blocked and the session unsaved.
    const { cwd, configDir } = ws();
    const r = await runCli([], { cwd, configDir, env: tui, stdin: '/models\n', script: [] });
    assert.strictEqual(r.code, 0, 'exited cleanly with a panel open at EOF');
    const saved = fs.readdirSync(path.join(configDir, 'sessions')).filter((f) => f.endsWith('.json'));
    assert.ok(saved.length >= 1, 'the session was still persisted');
  });

  await test('UI SMOKE: the panel shrinks the workspace but never the input', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdin: '/models\n\x1b\n/exit\n',
      script: [],
    });
    // The input box is drawn in every frame, including while the panel is
    // open. `\x1b[?25l` (hide-cursor) is the per-frame boundary now that a
    // redraw no longer opens with a full-screen clear.
    // ---- THE COMPOSER IS STILL THERE, AND IT IS NO LONGER A BOX ---------
    //
    // This looked for the input's own top border to prove the composer was drawn
    // behind an open panel. There are no box-drawing characters anywhere on the
    // surface now: the composer is a grey fill and the panel is a list. The
    // property is unchanged and is asserted by the thing that IS always drawn -
    // the placeholder, which says what the region is for.
    const frames = r.stdout.split('\x1b[?25l');
    // THE PANEL'S OWN TITLE ROW, found by splitting the frame into rows. A bare
    // /models/i also matches `mock-model` in the header, which is every frame ever
    // drawn; and an anchored regex cannot work on `plain(f)`, because a drawn frame
    // contains no newlines at all - the rows are cursor-addressed.
    // THE TITLE CARRIES A COUNT (`Models   5`), so the row is matched by its
    // START rather than by equality.
    const titled = (f) => rowsOf(f).some((row) => /^\s*Models\b/.test(row));
    const withPanel = frames.filter(titled);
    assert.ok(withPanel.length > 0, 'a frame contained the panel');
    // ---- FOUND BY THE CARET PARK, not by the placeholder ----------------
    //
    // `Ask LAIN…` is only drawn when the line is EMPTY, and a picker that accepts
    // typed filtering replaces the placeholder with its own answer label - so the
    // placeholder is not a reliable sign that the composer is there.
    //
    // `draw()` ends every frame by parking the cursor on the row being edited, so
    // the row it names IS the input's row by construction. That is the landmark,
    // and it is the same one smoke/renderstability.test.js uses.
    for (const f of withPanel) {
      const marks = [...String(f).matchAll(/\x1b\[(\d+);(\d+)H/g)];
      assert.ok(marks.length, 'the frame addressed nothing at all');
      const caret = Number(marks[marks.length - 1][1]);
      assert.ok(caret > 0, 'the caret is parked on the input row with the panel open');
      for (const glyph of ['┌', '┐', '└', '┘']) {
        assert.ok(!f.includes(glyph), `a box survived the panel rewrite: ${glyph}`);
      }
    }
  });

  await test('UI SMOKE: exit prints the REAL persisted session id and it resumes', async () => {
    const { cwd, configDir } = ws();
    const first = await runCli([], {
      cwd, configDir, env: tui,
      stdin: 'remember the parser rewrite\n/exit\n',
      script: [{ text: 'noted' }],
    });
    assertIncludes(plain(first.stdout), 'Session saved.');
    // Exit prints the SHORT token. It is not a display-only string: it must
    // resolve to the session actually written to disk.
    const token = (plain(first.stdout).match(/--resume ([a-z0-9]{4,})/) || [])[1];
    assert.ok(token, `a resume token was printed:\n${plain(first.stdout).slice(-400)}`);
    const saved = fs.readdirSync(path.join(configDir, 'sessions')).filter((f) => f.endsWith('.json'));
    const match = saved.filter((f) => f.slice(0, -5).endsWith(token));
    assert.strictEqual(match.length, 1, `the token names exactly one persisted session: ${saved.join(',')}`);
    const id = match[0].slice(0, -5);
    // And resuming BY THE TOKEN restores that session in a fresh process.
    const second = await runCli(['--resume', token], { cwd, configDir, env: tui, stdin: '/status\n/exit\n', script: [] });
    assertIncludes(plain(second.stdout), id, 'the full id of the resumed session');
    assertIncludes(plain(second.stdout), '(resumed)');
  });

  await test('UI SMOKE: paste stays ONE input with the TUI active', async () => {
    const { cwd, configDir } = ws();
    const spec = ['continue', 'resume', 'done', 'step 4', 'plan']
      .concat(Array.from({ length: 40 }, (_, i) => `line ${i}`)).join('\n');
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdin: `\x1b[200~${spec}\x1b[201~\n/exit\n`,
      script: [{ text: 'ONE_TURN' }],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    // Count TURNS, not screen occurrences: the TUI redraws the same reply into
    // every frame, so counting pixels would measure the renderer, not the paste.
    const sessDir = path.join(configDir, 'sessions');
    const f = fs.readdirSync(sessDir).find((x) => x.endsWith('.json'));
    const session = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
    assert.strictEqual(session.turns.length, 1, `exactly one turn ran, got ${session.turns.length}`);
    const user = session.messages.filter((m) => m.role === 'user' && !m._liveness);
    assert.strictEqual(user.length, 1, 'the 45-line paste was ONE user message');
    assert.ok(user[0].content.includes('line 39'), 'and it kept every line');
  });

  await test('UI SMOKE: renders correctly at 120x40, 80x24, 60x15 and 40x9', async () => {
    // COLUMNS/LINES are honoured when the stream reports no size, so these are
    // genuinely four different geometries rather than four runs at 80x24.
    const widths = [];
    for (const [cols, rows] of [[120, 40], [80, 24], [60, 15], [40, 9]]) {
      const { cwd, configDir } = ws();
      const r = await runCli([], {
        cwd, configDir,
        env: { LAIN_FORCE_TUI: '1', COLUMNS: String(cols), LINES: String(rows) },
        stdin: '/models\n\x1b\n/exit\n',
        script: [],
        timeoutMs: 30000,
      });
      assert.strictEqual(r.code, 0, `${cols}x${rows} exited cleanly`);
      assertNotIncludes(r.out, 'fatal:', `${cols}x${rows} no crash`);
      assertNotIncludes(r.out, 'internal error', `${cols}x${rows} no internal error`);
      assertNotIncludes(r.out, 'Assertion failed', `${cols}x${rows} no native assertion`);

      // Measure ONLY what the TUI drew: everything before the alternate screen
      // is restored. The farewell lines printed afterwards are ordinary linear
      // output and wrap normally, so including them would test the wrong thing.
      // OSC 0/2 names the WINDOW and occupies no cells, so it is removed before
      // anything is measured. Counting it as drawn width made a 42-character
      // title sequence look like a row overflowing a 40-column terminal — a
      // measurement bug in this test, not a layout fault in the screen.
      const drawn = r.stdout.split('\x1b[?1049l')[0].replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '');
      const segs = drawn.split(/\x1b\[[0-9]+;[0-9]+H/)
        .flatMap((x) => x.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n'));
      const maxSeg = Math.max(...segs.map((x) => x.length));
      assert.ok(maxSeg <= cols, `${cols}x${rows}: widest drawn segment ${maxSeg} exceeds ${cols}`);

      // ---- THE WIDTH PROBE MOVED WITH THE BORDER ----------------------
      //
      // It was the input box's bottom rule (`└───┘`), exactly the terminal's
      // width, which is what proved the layout adapted rather than drawing one
      // fixed size. The input has no border — it is a grey fill padded to the
      // full width — so the probe is the input's own row, which is also the one
      // region that is NEVER sacrificed and so is drawn at every size. The
      // header's rule would have done except at 40x9, where it is correctly the
      // first thing given up.
      const inputSeg = segs.find((x) => /Ask LAIN/.test(x));
      assert.ok(inputSeg, `${cols}x${rows}: the input region must always be identifiable`);
      widths.push(inputSeg.length);

      // Terminal restored, every time.
      assertIncludes(r.stdout, '\x1b[?1049l', `${cols}x${rows} restored the screen`);
      assertIncludes(r.stdout, '\x1b[?25h', `${cols}x${rows} restored the cursor`);
    }
    // The layout really did adapt rather than drawing one fixed width.
    assert.ok(new Set(widths).size > 1, `input box width adapted across sizes: ${widths.join(', ')}`);
    assert.ok(widths[0] > widths[widths.length - 1], 'wider terminal drew a wider box');
  });

  await test('UI SMOKE: a tiny terminal degrades without crashing', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir,
      env: { ...tui, COLUMNS: '40', LINES: '9' },
      stdin: '/models\n\x1b\n/exit\n',
      script: [],
    });
    assert.strictEqual(r.code, 0, 'survived a 40x9 terminal');
    assertNotIncludes(r.out, 'fatal:');
    assertNotIncludes(r.out, 'internal error');
  });

  await test('UI SMOKE: without a TTY the linear renderer is used, unchanged', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], { cwd, configDir, stdin: 'hi\n/exit\n', script: [{ text: 'plain hello' }] });
    assertIncludes(r.stdout, 'plain hello');
    assertNotIncludes(r.stdout, '\x1b[?1049h', 'no alternate screen on a pipe');
  });

  // ---- progress, where it is now asked for --------------------------------

  await test('UI SMOKE: `/plan` states the step, a bar and the percentage', async () => {
    const { cwd, configDir } = ws();
    // Five steps, two finished: `/plan` must read STEP 3/5 at 40%. It was the
    // PINNED TASK BANNER that said this — two rows above the feed, permanently
    // — and before that a nine-row block with `STEP 3 / 5` and `40% complete`
    // spelled out. The banner went with the panes; what it measured did not,
    // and this is where it is read now.
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdin: 'fix the auth flow\n/plan step inspect\n/plan step validate\n/plan step refresh\n'
        + '/plan step verify\n/plan step review\n/plan done inspected\n/plan done validated\n/plan\n/exit\n',
      script: [{ text: 'ok' }],
    });
    const out = plain(r.stdout);
    assertIncludes(out, 'fix the auth flow', 'the objective is on screen — in the conversation');
    assertIncludes(out, 'PLAN  2/5 done', 'the plainest statement of progress leads');
    assertIncludes(out, 'STEP 3/5', 'with the position');
    assertIncludes(out, '40%', 'and the percentage');
    assertIncludes(out, '█', 'a real progress bar is drawn');
    assertNotIncludes(out, 'STEP 5/5', 'the step number is the current step, not the count');
  });

  await test('UI SMOKE: progress stays visible on a small terminal (compact form)', async () => {
    const { cwd, configDir } = ws();
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '40', LINES: '9' },
      stdin: 'fix the auth flow\n/plan step a\n/plan step b\n/plan step c\n/plan step d\n/plan step e\n'
        + '/plan done a\n/plan done b\n/plan\n/exit\n',
      script: [{ text: 'ok' }],
    });
    assert.strictEqual(r.code, 0, 'survived 40x9');
    const out = plain(r.stdout);
    // The compact form keeps the whole progress state on one short line.
    assertIncludes(out, 'STEP 3/5', 'the step survives at 40x9');
    assertIncludes(out, '40%', 'and so does the percentage');
  });

  // ---- Ctrl+C: two-press exit ---------------------------------------------

  await test('UI SMOKE: a first Ctrl+C confirms before exit; a second exits cleanly', async () => {
    const { cwd, configDir } = ws();
    // Two Ctrl+C within the confirmation window. The first must NOT exit — it
    // arms a hint — and the second exits, restoring the terminal.
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdinSteps: ['\x03', '\x03'], stepDelayMs: 400,
      script: [{ text: 'ok' }], timeoutMs: 20000,
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(plain(r.stdout), 'Press Ctrl+C again to exit.', 'the first press armed a hint');
    assertIncludes(plain(r.stdout), 'Session saved.', 'the second press exited cleanly');
    assertIncludes(r.stdout, '\x1b[?1049l', 'the alternate screen was restored');
    assertIncludes(r.stdout, '\x1b[?25h', 'the cursor was restored');
    assert.ok(/--resume [a-z0-9]{3,}/.test(plain(r.stdout)), 'the resume command was printed');
  });

  await test('UI SMOKE: Ctrl+C while working cancels the work, and LAIN stays usable', async () => {
    const { cwd, configDir } = ws();
    // A slow command keeps the turn in flight so the interrupt lands mid-work.
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdinSteps: ['run the check\n', '\x03', '\x03', '\x03'], stepDelayMs: 1200,
      script: [
        { text: 'Running.', tool_calls: [{ name: 'run_cmd', input: { command: 'ping -n 10 127.0.0.1' } }] },
        { text: 'SECOND_STEP_SHOULD_NOT_RUN' },
      ],
      timeoutMs: 25000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);
    assertIncludes(out, 'interrupted', 'the first Ctrl+C cancelled the active work');
    assertNotIncludes(out, 'SECOND_STEP_SHOULD_NOT_RUN', 'the turn really stopped');
    assertIncludes(out, 'Session saved.', 'and a later Ctrl+C still exits cleanly');
  });
};
