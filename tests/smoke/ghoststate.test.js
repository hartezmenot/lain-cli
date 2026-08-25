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

/** The rows between the workspace and the input box — the status strip. */
function strip(out, which = -1) {
  const f = frames(out);
  const rows = rowsOf(f.at(which) || out);
  const at = rows.findIndex((l) => /^┌─ (INPUT|ANSWER)/.test(l));
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
    assert.ok(!/Is LMB a tap or a hold\?[\s\S]*│ >/.test(strip(r.out)),
      'and the question text is not glued above the input either');
    // THE ANSWER ITSELF IS STILL THERE — in Context, where the account lives.
    assert.match(last, /The user chose: hold/, 'what happened is not erased, only unglued');
  });

  await test('GHOST: the finished-call trail does not outlive the turn', async () => {
    const r = await runCli([], {
      cwd: tmpdir('ghost-'),
      env: tui,
      stdinSteps: [`do it${ENTER}`, ENTER],
      stepDelayMs: 1100,
      script: [
        { text: 'One.', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
        { text: 'Two.', tool_calls: [{ name: 'glob', input: { pattern: '*' } }] },
        { text: 'Done. FINISHED.' },
      ],
      timeoutMs: 60000,
    });
    const s = strip(r.out);
    assert.ok(!/✓ TOOL/.test(s),
      `completed calls are still glued above the input after the turn ended:\n${s}`);
    // AND THE RESTING ROW REMAINS. Clearing everything would answer "is it
    // working?" with silence, which is the opposite failure.
    assert.match(s, /LAIN\s+DONE/, 'the one row that describes NOW must stay');
  });

  await test('GHOST: while work IS in flight the trail is there — it is momentum', async () => {
    // The other half of the same rule. Removing it outright would make a long
    // turn look like a frozen screen, which is the failure the trail fixed.
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
    const inFlight = frames(r.out).filter((f) => /running sleep 3/.test(f));
    assert.ok(inFlight.length, 'the slow command must have been drawn at least once');
    const rows = rowsOf(inFlight[inFlight.length - 1]);
    const at = rows.findIndex((l) => /^┌─ INPUT/.test(l));
    const s = rows.slice(Math.max(0, at - 3), at).join('\n');
    assert.match(s, /✓ TOOL/, `the trail must show momentum while working:\n${s}`);
  });

  await test('GHOST: an idle session does not show the model as though it were thinking', async () => {
    //. AVAILABLE, SELECTED and ACTIVE are three different things, and the
    // header names the SELECTED model beside a state that says whether anything
    // is running. A resting session must read as resting.
    const r = await runCli([], {
      cwd: tmpdir('ghost-'),
      env: tui,
      stdinSteps: [`say hello${ENTER}`, ENTER],
      stepDelayMs: 1100,
      script: [{ text: 'Hello. FINISHED.' }],
      timeoutMs: 45000,
    });
    const last = finalFrame(r.out);
    assert.match(last, /○ READY/, 'the header must say plainly that nothing is running');
    assert.match(last, /mock-model/, 'while still naming the model that is selected');
    for (const live of [/THINKING/, /RECEIVING/, /● WORKING/]) {
      assert.ok(!live.test(last), `an idle session still shows ${live} on its last frame:\n${last}`);
    }
  });

  await test('GHOST: model selection is not left in the conversation all session', async () => {
    // "MODEL SELECTED: …" remaining after the model changed. Discovery and
    // selection are STATE, and state belongs in the header, not the transcript.
    const r = await runCli([], {
      cwd: tmpdir('ghost-'),
      env: tui,
      stdinSteps: [`do something${ENTER}`, ENTER],
      stepDelayMs: 1100,
      script: [{ text: 'Did it. FINISHED.' }],
      timeoutMs: 45000,
    });
    const last = finalFrame(r.out);
    assert.ok(!/MODEL SELECTED|models? available/i.test(last),
      `a model notice is still in the conversation at the end:\n${last}`);
  });
};
