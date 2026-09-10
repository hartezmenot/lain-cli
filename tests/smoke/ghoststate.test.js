'use strict';

/**
 * NO GHOST STATE — and, against real drawn frames.
 *
 * "Every transient UI element needs an explicit lifecycle: CREATED, VISIBLE,
 * UPDATED, CLEARED. When the owning state disappears, the UI must disappear
 * too. No ghost state. No duplicated state. No stale prompt."
 *
 * The examples in the design are all the same failure — something true a moment
 * ago, still on screen, being read as true now:
 *
 *     MODEL SELECTED: …   after the model changed
 *     PRESS 2             after the question disappeared
 *     WAITING…            after work resumed
 *
 * WHAT THIS FOUND, on the last frame of a finished session: the status strip
 * kept the trail of completed calls, so a session that had asked a question and
 * been answered still ended with `asking user Is LMB a tap or a hold?` glued
 * above the input — the design's second example exactly. The trail now belongs to
 * a turn in flight and ends when the turn does; the rows stay RESERVED so the
 * workspace does not jump three lines every time work stops.
 *
 * These read the LAST DRAWN FRAME, not the accumulated output. A ghost is by
 * definition something still on screen after its cause is gone, and only the
 * final frame can show that.
 */

const assert = require('assert');
const { test, tmpdir, runCli, frames, rowsOf } = require('../helpers');

const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '34' };
const ENTER = '\n';

/** The last frame LAIN actually drew, as rows. */
function finalFrame(out) {
  const f = frames(out);
  return rowsOf(f[f.length - 1] || out).join('\n');
}

/**
 * The rows between the conversation and the input — the LIVE ACTIVITY region.
 *
 * ------------------------------------------------------------------------
 * IT USED TO BE FOUND BY THE INPUT'S BORDER (`┌─ INPUT`), which is gone: the
 * input is a grey fill with no frame and no label (ui/inputbox.js). The
 * placeholder is the anchor now — it is the last row of every resting frame,
 * and it says what the region is for, which the border label never did.
 *
 * STILL THREE ROWS OF LOOKBACK, deliberately. The region is ONE row now, so
 * two of the three are always blank — and that is exactly the point of looking
 * at three: a trail growing back would show up here as rows that used to be
 * empty.
 */
function strip(out, which = -1) {
  const f = frames(out);
  const rows = rowsOf(f.at(which) || out);
  const at = rows.findIndex((l) => /Ask LAIN|ANSWER — /.test(l));
  return at <= 0 ? '' : rows.slice(Math.max(0, at - 3), at).join('\n');
}

module.exports = async function () {
  await test('GHOST: an ANSWERED question is not still advertised when the turn ends', async () => {
    // The brief's "PRESS 2 remaining after the question disappeared", found on
    // a real frame: the strip's trail kept `asking user <the question>`.
    const r = await runCli([], {
      cwd: tmpdir('ghost-'),
      env: tui,
      stdinSteps: [`investigate it${ENTER}`, `2${ENTER}`, ENTER],
      stepDelayMs: 1100,
      script: [
        { text: 'Looking.', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
        {
          text: 'I need one detail.',
          tool_calls: [{ name: 'ask_user', input: { question: 'Is LMB a tap or a hold?', options: ['tap', 'hold'] } }],
        },
        { text: 'It is a hold. FINISHED.' },
      ],
      timeoutMs: 60000,
    });
    const last = finalFrame(r.out);
    assert.ok(!/asking user/.test(last),
      `a finished turn still advertises the question it asked:\n${last}`);
    // AND THE QUESTION IS NOT GLUED ABOVE THE INPUT EITHER. The live row is
    // the last thing before the caret now — the trail that used to sit between
    // them is gone — so an answered question appearing there would be
    // unmissable rather than merely wrong.
    assert.ok(!/asking user[\s\S]{0,200}Is LMB a tap or a hold/.test(strip(r.out)),
      'the answered question must not still be advertised beside the caret');
    // THE ANSWER ITSELF IS STILL THERE — in Context, where the account lives.
    assert.match(last, /The user chose: hold/, 'what happened is not erased, only unglued');
  });

  await test('GHOST: no finished-call trail outlives the turn — there is no trail', async () => {
    // ------------------------------------------------------------------
    // THE TRAIL IS GONE, AND THIS TEST OUTLIVED IT.
    //
    // The status region used to be three rows on a tall terminal: the live
    // state, plus the last two COMPLETED calls of the turn. This asserted that
    // those two rows cleared when the turn ended — because a question that had
    // been answered, still advertised at the bottom of the screen, is the ghost
    // state this whole file is named for.
    //
    // The region is ONE row now: current activity only, never event history.
    // The account of what already happened is the conversation above it, in
    // order, with its results — which is where it was always better read.
    //
    // So the assertion gets stronger rather than weaker: the trail must not
    // appear AT ALL, at any point in the session, not merely fail to outlive
    // the turn.
    // ------------------------------------------------------------------
    const r = await runCli([], {
      cwd: tmpdir('ghost-'),
      env: tui,
      stdinSteps: [`do it${ENTER}`, ENTER],
      stepDelayMs: 1100,
      script: [
        { text: 'One.', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
        {
          text: 'Two.',
          tool_calls: [
            { name: 'glob', input: { pattern: '*' } },
            // AND ONE CALL THAT CHANGES SOMETHING, so there is an account to be
            // the better copy OF. A successful list or search is live state and
            // leaves no row anywhere afterwards (ui/durable.js) - which is a
            // stronger form of "no trail", and is asserted as well below.
            { name: 'write_file', input: { path: 'gen/note.js', content: '// note' } },
          ],
        },
        { text: 'Done. FINISHED.' },
      ],
      timeoutMs: 60000,
    });
    const s = strip(r.out);
    assert.ok(!/✓ TOOL/.test(s),
      `a completed-call trail was drawn above the input:\n${s.slice(-1500)}`);
    // AND THE RESTING ROW REMAINS. Clearing everything would answer "is it
    // working?" with silence, which is the opposite failure.
    assert.match(s, /\b(DONE|Verifying|NOT VERIFIED)\b/,
      'the one row that describes NOW must stay');
    // THE CALLS THEMSELVES ARE STILL ON SCREEN — in the conversation, which is
    // what the trail was a worse second copy of. Asked of the WHOLE frame, not
    // of the three rows above the input: that is the point of the move.
    assert.match(finalFrame(r.out), /Wrote|gen[\/]note\.js/,
      'what LAIN DID is still visible, in the account above');
    // AND THE ROUTINE HALF LEAVES NOTHING AT ALL - not a trail above the input,
    // and not a row in the conversation either. The list and the search happened,
    // were shown while they happened, and are over.
    assert.ok(!/list · |find · /.test(finalFrame(r.out)),
      'a routine call must not leave a row behind anywhere');
  });

  await test('GHOST: while work IS in flight, ONE row says what is happening now', async () => {
    // The other half of the same rule, and the failure removing the trail
    // could have caused: a long turn that looks like a frozen screen.
    //
    // It used to be answered by the trail — two rows of momentum. One row
    // answers it better, because the row says what is happening THIS SECOND
    // rather than what happened a moment ago, and it is the row nearest the
    // caret.
    const r = await runCli([], {
      cwd: tmpdir('ghost-'),
      env: tui,
      stdinSteps: [`do it${ENTER}`, `/exit${ENTER}`],
      stepDelayMs: 4000,
      script: [
        { text: 'One.', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
        { text: 'Two.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 3' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 60000,
    });
    const inFlight = frames(r.out).filter((f) => /RUNNING/i.test(f) && /sleep 3/.test(f));
    assert.ok(inFlight.length,
      'the live row must name the slow command while it runs — otherwise the screen looks frozen');
    // AND IT IS ONE ROW, not a region that grew back. The live state appears
    // exactly once in the frame that shows it.
    const rows = rowsOf(inFlight[inFlight.length - 1]);
    const live = rows.filter((l) => /\bRunning\b/.test(l) && /sleep 3/.test(l));
    assert.strictEqual(live.length, 1, `one row, not a panel:\n${rows.join('\n')}`);
  });

  await test('GHOST: an idle session does not show the model as though it were thinking', async () => {
    // AVAILABLE, SELECTED and ACTIVE are three different things. The header
    // names the SELECTED model; whether anything is RUNNING is the live row,
    // one line above the caret — which is where that word moved when the
    // header's status word and its coloured dot were removed. A resting
    // session must read as resting from whichever of them says so.
    const r = await runCli([], {
      cwd: tmpdir('ghost-'),
      env: tui,
      stdinSteps: [`say hello${ENTER}`, ENTER],
      stepDelayMs: 1100,
      script: [{ text: 'Hello. FINISHED.' }],
      timeoutMs: 45000,
    });
    const last = finalFrame(r.out);
    assert.match(last, /\b(DONE|READY|Verifying|NOT VERIFIED)\b/,
      `the live row must say plainly that nothing is running:\n${last}`);
    assert.match(last, /mock-model/, 'while the header still names the model that is selected');
    for (const live of [/THINKING/i, /RECEIVING/i, /● WORKING/]) {
      assert.ok(!live.test(last), `an idle session still shows ${live} on its last frame:\n${last}`);
    }
  });
};
