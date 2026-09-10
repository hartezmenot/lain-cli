'use strict';

/**
 * THE QUIET SURFACE, DRIVEN THROUGH THE REAL BINARY.
 *
 * ------------------------------------------------------------------------
 * WHY THIS TIER. The unit half (tests/unit/transcriptrule.test.js,
 * tests/unit/workclock.test.js) asserts the rules against the functions that
 * implement them, and every one of those would pass against a program that
 * composed a perfect frame and never put it on the wire. This spawns
 * `bin/lain.js` with `LAIN_FORCE_TUI=1` — the real draw path over a pipe — works
 * a real turn through it, and reads back the bytes a terminal would have
 * received.
 *
 * WHAT IT CHECKS, and each one was something a person actually saw go wrong:
 *
 *     a turn of routine work    leaves no execution log behind in the transcript
 *     the work clock            is on the row, in HH:MM:SS, counting one task
 *     the content frame         conversation and composer start on one column
 *     the composer              is two rows of grey with no outline on it
 *     a diagram                 survives the renderer with its shape intact
 *     resize                    all of the above, at five widths
 *
 * MOCK PROVIDER THROUGHOUT. `LAIN_MOCK_SCRIPT` is what the turn loop receives,
 * so a real turn runs without a real request.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, frames, rowsOf, lastFrameRows, assertIncludes, assertNotIncludes } = require('../helpers');

const NL = String.fromCharCode(10);

/** The last frame a person was actually looking at — see smoke/onesurface. */
function lastSurface(out) {
  const all = frames(out);
  for (let i = all.length - 1; i >= 0; i--) {
    const rows = rowsOf(String(all[i]).split('\x1b[?1049l')[0]);
    if (rows.some((l) => l.includes('Ask LAIN'))) return rows;
  }
  return lastFrameRows(out);
}

/** A workspace with two small python files to be busy about. */
function workspace(tag) {
  const cwd = tmpdir(tag);
  fs.writeFileSync(path.join(cwd, 'a.py'), 'print(1)' + NL, 'utf8');
  fs.writeFileSync(path.join(cwd, 'b.py'), 'print(2)' + NL, 'utf8');
  return cwd;
}

/** The script a turn of ordinary mechanics produces. */
const MECHANICS = [
  {
    text: 'Checking them now.',
    tool_calls: [
      { name: 'run_bash', input: { command: 'python -c "import ast"' } },
      { name: 'run_bash', input: { command: 'python -c "import json, tempfile"' } },
      { name: 'read_file', input: { path: 'a.py' } },
      { name: 'read_file', input: { path: 'b.py' } },
      { name: 'run_bash', input: { command: 'python -m py_compile a.py' } },
    ],
  },
  { text: 'All fine.' },
];

module.exports = async function () {
  await test('QUIET: a turn of routine work leaves NO execution log in the transcript', async () => {
    const r = await runCli([], {
      cwd: workspace('quiet-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['check the python files' + NL, '/exit' + NL],
      stepDelayMs: 9000,
      script: MECHANICS,
      timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0);
    const screen = lastSurface(r.out).join(NL);

    // WHAT THE PERSON SAID AND WHAT LAIN ANSWERED — both on the screen.
    assertIncludes(screen, 'check the python files', 'the question survives');
    assertIncludes(screen, 'All fine', 'and the answer');

    // AND NONE OF THE MECHANICS. These five rows used to accumulate upward
    // through the transcript and stay there for the rest of the session.
    assertNotIncludes(screen, 'import ast', 'a mechanics command was left behind');
    assertNotIncludes(screen, 'import json', 'and another');
    assertNotIncludes(screen, 'Read a.py', 'and the reads');
    assertNotIncludes(screen, 'Read b.py');
    // NOR THE SHELL STAMP, which is addressed to the model and carried an
    // absolute temp path at the user.
    assertNotIncludes(screen, 'via shell', 'the interpreter stamp is not quoted at the user');

    // THE TURN'S STANDING VERDICT IS KEPT — the last command it ran clean.
    assertIncludes(screen, 'py_compile', 'the verdict the turn ended on survives');
  });

  await test('QUIET: the work clock is on the row, in HH:MM:SS, for the whole task', async () => {
    const r = await runCli([], {
      cwd: workspace('clock-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['check the python files' + NL, '/exit' + NL],
      stepDelayMs: 9000,
      script: MECHANICS,
      timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0);
    // ONE SHAPE, EVERYWHERE. Asserted over the whole capture rather than the
    // final frame, because the interesting frames are the ones mid-turn.
    assert.match(r.out, /\d\d:\d\d:\d\d/, 'the clock is drawn as HH:MM:SS');
    // AND THE PER-PHASE AGE IS GONE from the live row. The old figure restarted
    // at every read and write; a bare `12s` beside the status word is its shape.
    const rows = lastSurface(r.out);
    const live = rows.find((l) => /\bDONE\b|\bREADY\b/.test(l)) || '';
    assert.ok(!/\s\d+s(\s|$)/.test(live), 'no per-phase seconds survive: ' + JSON.stringify(live));
    // THE CLOCK IS ON THAT SAME ROW, which is what makes it the task's figure.
    assert.match(live, /\d\d:\d\d:\d\d/, 'the settled row carries the receipt: ' + JSON.stringify(live));
  });

  await test('QUIET: conversation and composer begin on the SAME column', async () => {
    const r = await runCli([], {
      cwd: workspace('frame-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '120', LINES: '30' },
      stdinSteps: ['check the python files' + NL, '/exit' + NL],
      stepDelayMs: 9000,
      script: MECHANICS,
      timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0);
    const rows = lastSurface(r.out);
    const composer = rows.find((l) => l.includes('Ask LAIN'));
    const said = rows.find((l) => l.includes('All fine'));
    assert.ok(composer && said, 'both regions were drawn');
    // ---- THE FRAME IS SHARED; THE COMPOSER PADS ONE CELL INSIDE IT -------
    //
    // This asserted EQUAL indents, which held while the feed carried its own
    // two-column indent and the composer padded by two. The frame owns the outer
    // margin now and the composer pads one cell inside its own grey fill (§5), so
    // the prompt sits exactly one column right of the prose — close enough to read
    // as the same column, and far enough that the fill has a visible edge.
    const indentOf = (l) => l.length - l.replace(/^ +/, '').length;
    const PAD = require('../../src/ui/inputbox').PAD;
    assert.strictEqual(indentOf(composer), indentOf(said) + PAD,
      'the composer pads inside the shared frame: ' + JSON.stringify([composer, said]));
    // AND THERE IS A RIGHT GUTTER — prose does not run to the physical edge.
    for (const row of rows) {
      if (!row.trim()) continue;
      // The header's rule is chrome and spans the full width on purpose.
      if (/^\u2500{4}/.test(row)) continue;
      assert.ok(row.replace(/\s+$/, '').length <= 120, 'nothing overflows the terminal');
    }
  });

  await test('QUIET: the composer is a borderless two-row region', async () => {
    const r = await runCli([], {
      cwd: workspace('composer-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['/exit' + NL],
      script: [{ text: 'ready' }],
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0);
    const rows = lastSurface(r.out);
    const at = rows.findIndex((l) => l.includes('Ask LAIN'));
    assert.ok(at >= 0, 'the composer was drawn');
    // NO OUTLINE ANYWHERE NEAR IT. The grey fill is the region.
    for (const i of [at - 1, at, at + 1]) {
      const row = rows[i] || '';
      for (const glyph of ['┌', '┐', '└', '┘', '│', '├', '┤']) {
        assert.ok(!row.includes(glyph), 'box drawing beside the composer: ' + JSON.stringify(row));
      }
    }
    // AND IT IS THE LAST THING ON THE SCREEN, with a row of air under the caret.
    assert.ok(at >= rows.length - 2, 'the composer is the bottom anchor');
  });

  await test('QUIET: a diagram survives the renderer with its shape intact', async () => {
    const figure = [
      'The shape:',
      '',
      '```',
      '      A',
      '      |',
      '      v',
      '      B ----> C',
      '```',
      '',
      'that is all.',
    ].join(NL);
    const r = await runCli([], {
      cwd: tmpdir('figure-'),
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: ['draw me the shape' + NL, '/exit' + NL],
      stepDelayMs: 6000,
      script: [{ text: figure }],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0);
    // EVERY ROW OF THE FIGURE, with its own spacing. Reflowed on whitespace this
    // comes apart into fragments, which is what §10 forbids.
    for (const row of ['      A', '      |', '      v', '      B ----> C']) {
      assertIncludes(r.out, row, 'the figure lost ' + JSON.stringify(row));
    }
  });

  await test('QUIET: all of it holds at 60, 80, 100, 120 and 160 columns', async () => {
    for (const cols of [60, 80, 100, 120, 160]) {
      const r = await runCli([], {
        cwd: workspace('w' + cols + '-'),
        env: { LAIN_FORCE_TUI: '1', COLUMNS: String(cols), LINES: '30' },
        stdinSteps: ['check the python files' + NL, '/exit' + NL],
        stepDelayMs: 8000,
        script: MECHANICS,
        timeoutMs: 120000,
      });
      assert.strictEqual(r.code, 0, 'it survived ' + cols + ' columns');
      const rows = lastSurface(r.out);
      const composer = rows.find((l) => l.includes('Ask LAIN'));
      assert.ok(composer, 'the composer is drawn at ' + cols);
      // NOTHING OVERFLOWS, at any width.
      for (const row of rows) {
        assert.ok(row.replace(/\s+$/, '').length <= cols,
          'a row overflowed at ' + cols + ': ' + JSON.stringify(row.slice(0, 80)));
      }
      // AND THE MECHANICS ARE STILL GONE — narrowing the terminal must not
      // change which rows the transcript keeps.
      assertNotIncludes(rows.join(NL), 'import ast', 'mechanics came back at ' + cols);
      // THE CONTENT FRAME STILL AGREES WITH ITSELF where there is room for one.
      const said = rows.find((l) => l.includes('All fine'));
      if (said && cols >= 48) {
        const indentOf = (l) => l.length - l.replace(/^ +/, '').length;
        const PAD = require('../../src/ui/inputbox').PAD;
        assert.strictEqual(indentOf(composer), indentOf(said) + PAD, 'aligned at ' + cols);
      }
    }
  });
};
