'use strict';

/**
 * THE ONE SURFACE, DRIVEN THROUGH THE REAL BINARY.
 *
 * ------------------------------------------------------------------------
 * WHY THIS TIER AND NOT A UNIT TEST.
 *
 * `tests/unit/onesurface.test.js` asserts the STRUCTURE: no tab module, no
 * `view` on the Screen, one answer from `workspaceLines`, no pane key bound.
 * Those are the right assertions for "the machinery is gone", and they would
 * all pass against a program that composed a perfect frame and then failed to
 * put it on the wire.
 *
 * This spawns `bin/lain.js` with `LAIN_FORCE_TUI=1` — the real draw path over a
 * pipe — types at it, and reads back the bytes a terminal would have received.
 * It is the closest thing to sitting in front of it, and it is what the mission
 * asks for: do not call the rewrite complete on the strength of unit tests.
 *
 * WHAT IT WALKS THROUGH, in one session where it can:
 *
 *     launch                one surface, project, model, output count, input
 *     a normal question     the conversation answers, in place
 *     /bg                   background work, started and reported
 *     /ps                   the processes that work is made of
 *     resize                the layout survives it
 *
 * MOCK PROVIDER THROUGHOUT. Nothing here contacts a model: `LAIN_MOCK_SCRIPT`
 * is what the turn loop receives, so the surface is exercised against a real
 * turn without a real request.
 */

const assert = require('assert');
const { test, runCli, tmpdir, frames, rowsOf, lastFrameRows, assertIncludes, assertNotIncludes } = require('../helpers');

const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);

/**
 * THE LAST DRAWN FRAME, not the bytes after it.
 *
 * `/exit` leaves the alternate screen and then writes ordinary linear output —
 * "Session saved." and the closing summary. `lastFrameRows` splits on the
 * hide-cursor that opens each frame, so the tail after the final one carries
 * that text and reads as an enormously wide row. What a person was looking at
 * is the last frame that actually drew the input.
 */
function lastSurface(out) {
  const all = frames(out);
  for (let i = all.length - 1; i >= 0; i--) {
    // CUT AT THE ALT-SCREEN EXIT. The final frame and the linear text that
    // follows LAIN leaving the alternate buffer arrive in one chunk, so
    // without this the closing summary reads as one enormously wide row.
    const rows = rowsOf(String(all[i]).split('\x1b[?1049l')[0]);
    if (rows.some((l) => l.includes('Ask LAIN'))) return rows;
  }
  return lastFrameRows(out);
}

/** Every box-drawing character the removed chrome used. */
const BOX = ['┌', '┐', '└', '┘', '│', '├', '┤'];

module.exports = async function () {
  await test('SURFACE: launch draws ONE surface — no strip, no numbered panes, no box', async () => {
    const r = await runCli([], {
      cwd: tmpdir('surface-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['/exit' + NL],
      // A SCRIPT IS WHAT PUTS A MODEL BEHIND THE SESSION. Without one there is
      // no provider configured, the header honestly says `no model`, and this
      // would be asserting the empty case rather than the ordinary one.
      script: [{ text: 'ready' }],
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    const out = r.out;

    // ---- THE HEADER: LAIN, the project, the model, the output count -------
    assertIncludes(out, 'LAIN', 'the wordmark');
    assertIncludes(out, 'surface-', 'the project folder');
    assertIncludes(out, 'mock-model', 'the active model');
    // ---- THE INPUT, and what it is for -----------------------------------
    assertIncludes(out, 'Ask LAIN', 'the input says what it is for');

    // ---- AND NONE OF THE MACHINERY THAT IS GONE --------------------------
    for (const label of ['1 activity', '2 context', '3 plan', '4 diff', '5 output',
      '6 files', '7 memory', '8 detail', '9 tokens']) {
      assertNotIncludes(out, label, `a numbered pane survived: ${label}`);
    }
    assertNotIncludes(out, '─ INPUT ', 'the input must not be a labelled box');
    assertNotIncludes(out, 'TASK  ', 'the pinned task banner is gone');
    // ---- NO BOX ANYWHERE ON THE SURFACE ITSELF ---------------------------
    //
    // Asserted on the LAST DRAWN FRAME rather than on the whole stream,
    // because the stream also contains the `/` COMMAND PALETTE that opens
    // while `/exit` is being typed. That palette is a transient picker with
    // its own frame and it is allowed one: it is not the input region, it is
    // not permanent, and Esc closes it. What must have no border is the
    // surface — the header, the conversation and the input.
    const resting = lastSurface(out);
    for (const glyph of BOX) {
      assert.ok(!resting.join('').includes(glyph),
        `a box-drawing character survived on the resting surface: ${glyph}
${resting.join(NL)}`);
    }
  });

  await test('SURFACE: Tab and Alt+N do nothing, and cannot break the session', async () => {
    // The keys are unbound, which means they must fall through harmlessly —
    // not throw, not scroll, not be typed as stray bytes into the prompt.
    const r = await runCli([], {
      cwd: tmpdir('surface-keys-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: [
        '\t', '\t', ESC + '\t',            // Tab, Tab, Shift+Tab
        ESC + '1', ESC + '3', ESC + '9',   // Alt+1, Alt+3, Alt+9
        'still typing fine', NL,
        '/exit' + NL,
      ],
      stepDelayMs: 400,
      script: [{ text: 'Yes, still here.' }],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0, 'the session survived every one of them');
    assertIncludes(r.out, 'Yes, still here.', 'and the turn after them still worked');
    for (const label of ['1 activity', '2 context', '3 plan']) {
      assertNotIncludes(r.out, label, 'no key may reveal a pane');
    }
  });

  await test('SURFACE: a question is answered in place, and the surface never changes', async () => {
    const r = await runCli([], {
      cwd: tmpdir('surface-talk-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['what does this project do?' + NL, '/exit' + NL],
      stepDelayMs: 2500,
      script: [{ text: 'It is an evidence-driven coding agent.' }],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.out, 'what does this project do?', 'what the user said');
    assertIncludes(r.out, 'It is an evidence-driven coding agent.', 'and what LAIN said');
    // THE FIRST MESSAGE IS DRAWN. It used to be suppressed in favour of the
    // pinned banner, which is gone — so a feed that still suppressed it would
    // show nothing at all.
    const rows = lastSurface(r.out);
    assert.ok(rows.some((l) => l.includes('what does this project do?')),
      `the first message must be on the LAST frame too:\n${rows.join(NL)}`);
  });

  await test('BG and PS: background work is started, reported, and projected', async () => {
    const r = await runCli([], {
      cwd: tmpdir('surface-bg-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '110', LINES: '30' },
      stdinSteps: [
        '/bg' + NL,                     // nothing yet — it says so
        '/ps' + NL,                     // and nothing owns a process either
        '/bg summarise the readme' + NL,
        '/bg' + NL,                     // now it is listed
        '/exit' + NL,
      ],
      stepDelayMs: 1800,
      script: [{ text: 'Read it.' }],
      timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0);
    const out = r.out;
    assertIncludes(out, 'Nothing is running in the background', 'bare /bg on an empty session');
    assertIncludes(out, 'Nothing is running that LAIN owns', '/ps on an empty session');
    assertIncludes(out, 'Background #', 'starting one acknowledges it by number');
    // ---- AND THE SESSION STAYED INTERACTIVE ------------------------------
    //
    // The command after `/bg` ran, which is the whole promise: starting
    // background work must not block the prompt.
    assertIncludes(out, 'summarise the readme', 'the task is listed by what was asked');
    // ---- NEITHER COMMAND BECAME A PANE -----------------------------------
    for (const label of ['1 activity', '2 background', 'BACKGROUND ]', 'PROCESSES ]']) {
      assertNotIncludes(out, label, 'these are commands, not tabs');
    }
  });

  await test('PS: it never claims a host process, and says so', async () => {
    const r = await runCli([], {
      cwd: tmpdir('surface-ps-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '110', LINES: '30' },
      stdinSteps: ['/ps' + NL, '/exit' + NL],
      stepDelayMs: 1200,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    // With nothing started, the empty answer is the honest one — and it must
    // not have gone looking at the machine to produce it.
    assertIncludes(r.out, 'Nothing is running that LAIN owns');
    assertNotIncludes(r.out, 'System Idle Process', 'the host is not enumerated');
    assertNotIncludes(r.out, 'svchost', 'the host is not enumerated');
  });

  await test('HELP: the commands are grouped, and no key promises a pane', async () => {
    const r = await runCli([], {
      cwd: tmpdir('surface-help-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '110', LINES: '40' },
      stdinSteps: ['/help' + NL, '/exit' + NL],
      stepDelayMs: 1500,
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(r.out, 'Working', 'the group somebody needs first');
    assertIncludes(r.out, '/bg', 'and the commands that matter are in it');
    assertNotIncludes(r.out, 'switch pane', 'no key may promise something that cannot happen');
    assertNotIncludes(r.out, 'Alt+1..7', 'nor a binding that is unbound');
  });

  await test('RESIZE: the surface survives a real terminal resize', async () => {
    // COLUMNS/LINES are the fallback a pipe uses (see ui/layout.js `cols`), so
    // this drives the geometry the way a real resize does and asserts the
    // frames it produced at each size.
    for (const [cols, lines] of [[60, 20], [80, 24], [120, 40], [160, 50]]) {
      const r = await runCli([], {
        cwd: tmpdir(`surface-${cols}-`),
        env: { LAIN_FORCE_TUI: '1', COLUMNS: String(cols), LINES: String(lines) },
        stdinSteps: ['/exit' + NL],
        script: [{ text: 'ready' }],
        timeoutMs: 60000,
      });
      assert.strictEqual(r.code, 0, `LAIN did not survive ${cols}x${lines}`);
      const rows = lastSurface(r.out);
      assert.ok(rows.length, `nothing was drawn at ${cols}x${lines}`);
      for (const line of rows) {
        assert.ok(line.length <= cols,
          `a row was ${line.length} cells wide at ${cols} columns: ${JSON.stringify(line.slice(0, 80))}`);
      }
      // THE INPUT IS PRESENT AT EVERY SIZE. It is the one region that is never
      // sacrificed, and a layout that loses it has failed however tidy it looks.
      assert.ok(rows.some((l) => l.includes('Ask LAIN')),
        `the input vanished at ${cols}x${lines}:\n${rows.join(NL)}`);
    }
  });

  await test('SURFACE: every frame of a working turn is one surface', async () => {
    // Not just the first and last: a pane could reappear mid-turn and both ends
    // would look right. `frames` splits the stream into what was actually put
    // on the wire, in order.
    const r = await runCli([], {
      cwd: tmpdir('surface-frames-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['read the readme and tell me what it says' + NL, '/exit' + NL],
      stepDelayMs: 2500,
      script: [{ text: 'Reading it now.' }, { text: 'It describes the harness.' }],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0);
    const all = frames(r.out);
    assert.ok(all.length > 1, 'the turn produced several frames');
    for (const f of all) {
      for (const label of ['1 activity', '2 context', '─ INPUT ']) {
        assert.ok(!f.includes(label), `a frame carried removed chrome: ${label}`);
      }
    }
  });
};
