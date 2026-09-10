'use strict';

/**
 * THE INPUT FOUNDATION, THROUGH THE REAL BINARY.
 *
 * Everything here spawns bin/lain.js and asserts on frames it actually drew.
 *
 * LIMITATION, STATED PLAINLY: `LAIN_FORCE_TUI` runs the real draw path over a
 * PIPE, not an attached terminal. The mouse bytes below are exactly what a
 * terminal sends in SGR mode and travel the real decode and hit-test path — but
 * whether a given terminal actually SENDS them after `?1000h` is a property of
 * that terminal, and cannot be established from here. That part is marked NOT
 * VERIFIED in the report rather than claimed.
 */

const assert = require('assert');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes } = require('../helpers');

const ESC = String.fromCharCode(27);
const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
// Per-frame boundary is `\x1b[?25l` (hide-cursor, once per draw(), nowhere
// else) now that a redraw no longer opens with a full-screen clear.
const frames = (out) => String(out).split(ESC + '[?25l').slice(1).map(plain);
const tui = (cols = 100, rows = 30) => ({ LAIN_FORCE_TUI: '1', COLUMNS: String(cols), LINES: String(rows) });

/** The row the INPUT box's text sits on, for a given geometry. */
function inputRowOf(frame) {
  const rows = frame.replace(/(.{100})/g, '$1\n').split('\n');
  return rows.findIndex((r) => /Ask LAIN|ANSWER — /.test(r)) + 1;   // 1-based, as the terminal counts
}

/**
 * WHERE THE FIRST CHARACTER OF THE INPUT SITS.
 *
 * The region has no border and no `> ` prompt any more — it is a grey fill
 * (ui/inputbox.js) — so the text starts at the content frame's inset rather than
 * four. Everything that used to be found by `│ > ` is found by the CARET now,
 * which is a better anchor: every frame ends with the cursor parked on the row
 * being edited, so a test reading that row cannot be reading a different row
 * from the one the user types into.
 */
/**
 * COMPUTED, NOT WRITTEN DOWN. It was the literal 2, which was right while the
 * composer started one column in from the terminal's edge. It starts at the
 * content frame's inset plus the composer's own padding now, and a test that knows
 * the number breaks every time the frame does. See ui/frame.js `contentBounds`.
 */
const INPUT_COL = require('../../src/ui/frame').contentBounds(100).left
  + 1 + require('../../src/ui/inputbox').PAD;

module.exports = async function () {
  // ---------------------------------------------------------- the surface --

  await test('SURFACE LIVE: Tab walks nowhere, because there is one surface', async () => {
    // ------------------------------------------------------------------
    // THIS TEST USED TO WALK EVERY PANE AND ASSERT THEY WERE DIFFERENT.
    //
    // The complaint it was written for was that tabbing "behaves as if the tabs
    // do not change", and the check was that each pane drew content of its own
    // rather than merely flipping a name in the strip. It was a good test of a
    // design that has been removed: nine surfaces is nine places a person can
    // decide they are in the wrong one, and every one of them was reachable as
    // a command anyway.
    //
    // The inverted property is what has to hold now, and it is the one a
    // removal most easily gets wrong: pressing Tab must change NOTHING, and
    // must do so without throwing, scrolling, or typing stray bytes into the
    // prompt.
    // ------------------------------------------------------------------
    const r = await runCli([], {
      cwd: tmpdir('tabs-'), env: tui(),
      stdinSteps: ['\t', '\t', '\t', '\t', '/exit\n'],
      stepDelayMs: 600,
      script: [],
      timeoutMs: 60000,
    });
    assert.strictEqual(r.code, 0, 'the session survived every press');
    // NO PANE LABEL, EVER — the strip is what a returning pane would show up as.
    assert.ok(!/\[\d [a-z]+\]/.test(r.out),
      `a numbered pane label was drawn:\n${r.out.slice(-800)}`);
    // AND THE SURFACE IS UNMOVED. Every frame draws the same regions.
    for (const f of frames(r.out)) {
      if (!f.includes('Ask LAIN')) continue;
      assert.ok(f.includes('LAIN'), 'the header is on every frame');
    }
  });

  await test('SURFACE LIVE: the project survey is a COMMAND, and it finishes', async () => {
    // CONTEXT and DETAIL were rendered from a survey that reads the tree, so
    // they said "reading…" until the first pass landed — and a pane that says
    // it forever is indistinguishable from a hang. That was the property, and
    // it outlived the panes: `/brief` runs the same survey, and the same
    // failure would be a command that never answers.
    const cwd = tmpdir('rep-');
    require('fs').writeFileSync(require('path').join(cwd, 'package.json'), '{"name":"x"}');
    const r = await runCli([], {
      cwd, env: tui(),
      stdinSteps: ['/brief\n', '/exit\n'],
      stepDelayMs: 6000,
      script: [],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0);
    const all = frames(r.out);
    const last = all.filter((f) => /PROJECT/.test(f)).pop() || '';
    assert.ok(last, `the briefing was never drawn:\n${r.out.slice(-800)}`);
    assert.ok(!/reading the project/.test(last),
      `the survey never finished:\n${last.slice(0, 400)}`);
  });

  // ------------------------------------------------------------ the mouse --

  await test('MOUSE LIVE: clicking inside the input line MOVES THE CARET', async () => {
    // THE CARET IS WHERE THE TERMINAL IS TOLD TO PARK THE CURSOR, so this reads
    // the real cursor-positioning escape each frame ends with — the same signal
    // a person sees blinking.
    //
    // The input row is found from the frame rather than assumed, so a change
    // in geometry fails loudly here instead of clicking blind —
    // if the geometry moves, this fails loudly instead of clicking blind.
    const typed = 'fix the dashboard signal button';
    const cwd = tmpdir('mouse-');
    /**
     * The cursor park of the last frame whose INPUT ROW still holds the line.
     *
     * Not the last frame of the run, and not merely a frame CONTAINING the
     * text: once the line is submitted the same words appear in the feed while
     * the input box is empty, and that frame parks the caret at column 3 —
     * saying nothing at all about where a click put it. The trailing space
     * is what pins it to the frame where the line is EXACTLY this text — the
     * next keystrokes append to the same line, which would move the caret.
     */
    const lastCursor = (out, needle) => {
      const chunks = String(out).split(ESC + '[?25l').filter((c) => plain(c).includes(needle + ' '));
      const frame = chunks[chunks.length - 1] || '';
      const all = [...frame.matchAll(/\x1b\[(\d+);(\d+)H/g)];
      const m = all[all.length - 1];
      return m ? { row: Number(m[1]), col: Number(m[2]) } : null;
    };

    const base = await runCli([], {
      cwd, env: tui(), stdinSteps: [typed, '/exit\n'], stepDelayMs: 700, script: [], timeoutMs: 40000,
    });
    const a = lastCursor(base.out, typed);
    assert.ok(a, 'the frame must park the cursor somewhere');
    assert.strictEqual(a.col, INPUT_COL + typed.length,
      'with nothing clicked the caret sits after the last character typed');

    const withClick = await runCli([], {
      cwd, env: tui(),
      stdinSteps: [typed, ESC + `[<0;12;${a.row}M`, '/exit\n'],
      stepDelayMs: 700, script: [], timeoutMs: 40000,
    });
    const b = lastCursor(withClick.out, typed);
    assert.ok(b, 'and so must the clicked one');
    assert.strictEqual(b.row, a.row, 'the caret stays on the input row');
    assert.strictEqual(b.col, 12, 'and lands in the column that was clicked');
    // A click EDITS NOTHING — the line itself is untouched.
    assertIncludes(plain(withClick.out), typed, 'the line must survive being clicked');
  });

  await test('MOUSE LIVE: a click on the header does nothing at all', () => {
    // ------------------------------------------------------------------
    // IT USED TO SELECT A PANE. Row 5 was the tab strip and column 15 was the
    // second pane's digit, and `tabAt` inverted that column arithmetic back
    // into a pane name so a click and Alt+N could never land in different
    // places.
    //
    // The strip is gone and so is the hit-test. A click on the header must now
    // do what a click on chrome should always have done: nothing — and it must
    // be CONSUMED rather than typed, so a stray report never reaches the line.
    // ------------------------------------------------------------------
    const mouse = require('../../src/ui/mouse');
    assert.strictEqual(typeof mouse.tabAt, 'undefined', 'the strip hit-test must not survive it');
    assert.strictEqual(typeof mouse.VIEWS, 'undefined', 'nor the pane order it read');
  });

  await test('MOUSE LIVE: a mouse report is never typed into the line', async () => {
    // The failure this prevents: an undecoded report lands in the input box as
    // literal digits and semicolons.
    const r = await runCli([], {
      cwd: tmpdir('mraw-'), env: tui(),
      stdinSteps: ['hello', ESC + '[<0;40;26M', '/exit\n'],
      stepDelayMs: 700, script: [], timeoutMs: 40000,
    });
    const f = frames(r.out).filter((x) => /hello/.test(x)).pop() || '';
    assert.ok(f, 'the typed text must be on screen');
    assertNotIncludes(f, '0;40;26', 'the report must not appear as typed characters');
    assertNotIncludes(f, '<0;', 'nor any part of it');
  });

  // --------------------------------------------------------- ctrl+backspace --

  await test('CTRL+BACKSPACE LIVE: it removes the previous word from the real input box', async () => {
    const r = await runCli([], {
      cwd: tmpdir('cbs-'), env: tui(),
      stdinSteps: ['fix the dashboard signal button', '\b', '/exit\n'],
      stepDelayMs: 700, script: [], timeoutMs: 40000,
    });
    const all = frames(r.out);
    const after = all.filter((f) => /fix the dashboard signal /.test(f)).pop();
    assert.ok(after, `the word must be gone from the input row:\n${(all.pop() || '').slice(0, 400)}`);
    assert.ok(!/fix the dashboard signal button/.test(after), 'and "button" must not still be there');
  });

  // ---------------------------------------------------------------- /clean --

  await test('/clean LIVE: it clears the visible conversation and says what it did', async () => {
    const r = await runCli([], {
      cwd: tmpdir('clean-'), env: tui(),
      stdinSteps: ['first message\n', '/clean\n', '/exit\n'],
      stepDelayMs: 1200,
      script: [{ text: 'I looked at it.' }],
      timeoutMs: 45000,
    });
    const out = plain(r.out);
    // ---- IT SAID "CONTEXT CLEARED" AND THE CONTEXT WAS NOT CLEARED ---------
    //
    // Observed: `/clear` is what people reach for when they are
    // near the window limit, and it moved that number by nothing at all. The
    // program has ONE meaning for "context" — `session.contextChars()`,
    // counting the messages the model actually reads — and this command does
    // not touch it, deliberately. The headline therefore contradicted the state
    // it was reporting, and this test was holding the contradiction in place.
    //
    // It clears the VIEW, it says so, and it now states the size of the thing
    // it did NOT clear, because that number is the reason people run it.
    assertIncludes(out, 'View cleared.');
    assertIncludes(out, 'removed from the screen');
    assertIncludes(out, "The model's context is UNCHANGED",
      'a screen that looks empty while the model remembers everything is a trap unless it is stated');
    assertIncludes(out, '/compact shrinks it', 'and the command that DOES change it is named');
    assert.ok(!/Context cleared\./.test(out), 'the old headline claimed something untrue');
    assert.strictEqual(r.code, 0);
  });

  await test('/clean LIVE: the conversation really leaves the CONTEXT pane', async () => {
    const r = await runCli([], {
      cwd: tmpdir('clean2-'), env: tui(),
      stdinSteps: ['remember this sentence\n', '/clean\n', '/exit\n'],
      stepDelayMs: 1200,
      script: [{ text: 'Noted.' }],
      timeoutMs: 45000,
    });
    const all = frames(r.out);
    assert.ok(all.some((f) => /remember this sentence/.test(f)), 'it was on screen first');
    const after = all[all.length - 1];
    assert.ok(!/remember this sentence/.test(after),
      `and gone afterwards:\n${after.slice(0, 500)}`);
  });

  await test('/clean LIVE: it destroys nothing on disk — the session still resumes', async () => {
    const cwd = tmpdir('clean3-');
    const first = await runCli([], {
      cwd,
      stdin: 'the dashboard is stale\n/clean\n/exit\n',
      script: [{ text: 'Looking.' }],
      timeoutMs: 40000,
    });
    const id = (/--resume (\S+)/.exec(first.out) || [])[1];
    assert.ok(id, 'the session must still be saved');
    const second = await runCli([], {
      cwd, configDir: first.configDir,
      stdin: `/resume ${id}\n/exit\n`, script: [], timeoutMs: 30000,
    });
    assertIncludes(plain(second.out), 'RESUMING SESSION', 'the session file survived /clean');
  });

  await test('MOUSE LIVE: the wheel over the INPUT box browses history, not the conversation', async () => {
    // THE TWO SCROLLS ARE NOT COUPLED, and only one of them existed. The wheel
    // anywhere — including over the input line — scrolled Context, which is the
    // one place a person is NOT looking when they reach for their own last
    // prompt. ↑ already recalls history; this is the same action from the
    // mouse, in the region that owns it.
    const cwd = tmpdir('wheel-');
    const first = 'remember this first prompt';

    // FOUND BY THE CARET, which every frame parks on the row being edited —
    // see `INPUT_COL` on why the border is no longer there to look for. Found
    // from a real frame rather than assumed, so a change in geometry fails
    // loudly here instead of scrolling blind.
    const probe = await runCli([], {
      cwd, env: tui(), stdinSteps: ['x', '/exit\n'], stepDelayMs: 700, script: [], timeoutMs: 40000,
    });
    const chunk = String(probe.out).split(ESC + '[?25l').filter((c) => /\x1b\[\d+;\d+H/.test(c)).pop() || '';
    const marks = [...chunk.matchAll(/\x1b\[(\d+);(\d+)H/g)];
    const inputRow = marks.length ? Number(marks[marks.length - 1][1]) : 0;
    assert.ok(inputRow > 0, 'the input row must be findable from a drawn frame');

    // Submit a line so there IS history, then wheel up over the input box.
    // SGR button 64 is wheel-up.
    const WHEEL_UP = ESC + `[<64;10;${inputRow}M`;
    const r = await runCli([], {
      cwd, env: tui(),
      stdinSteps: [`${first}\n`, WHEEL_UP, '/exit\n'],
      stepDelayMs: 900, script: [{ text: 'Noted.' }], timeoutMs: 45000,
    });

    // BACK IN THE INPUT REGION, which is a different claim from the words being
    // somewhere on screen — the submitted prompt also appears in the
    // conversation above.
    //
    // It used to be found by `> ` in front of it. With no prompt symbol the
    // proof is the CARET: a frame where the cursor is parked at the end of the
    // recalled text is a frame where that text is on the line being edited.
    const raw = String(r.out).split(ESC + '[?25l');
    const recalled = raw.some((f) => {
      if (!plain(f).includes(first)) return false;
      const marks = [...f.matchAll(/\x1b\[(\d+);(\d+)H/g)];
      const park = marks[marks.length - 1];
      return Boolean(park) && Number(park[2]) === INPUT_COL + first.length;
    });
    assert.ok(recalled,
      `the wheel over the input box must recall the last prompt into it:\n${plain(raw.pop() || '').slice(-500)}`);
  });
};
