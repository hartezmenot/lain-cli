'use strict';

/**
 * THE MCQ INPUT SURFACE, through the REAL binary.
 *
 * THE FAILURE, observed in a live Probe investigation and then reproduced here
 * before a line was written: LAIN asked "level (please type a number)" with the
 * options 1-4, the user typed `2`, pressed Enter — and the session recorded
 * "The user chose: 1".
 *
 * Everything below drives `bin/lain.js` as a child process with
 * `LAIN_FORCE_TUI=1`, so the production draw path, the real input reader, the
 * real panel and the real turn loop are all in play. The keys are the byte
 * sequences a terminal actually sends. Only the network is a double.
 *
 * WHAT MUST BE TRUE, and each is a separate way this went wrong:
 *
 *   · a typed answer is the answer — never a different one, never none
 *   · the screen says where to type and what is accepted, at that moment
 *   · "Other" leads to a state you can actually type in
 *   · Escape gets out, and out of the free-text state means back to the choices
 *   · none of it is a second input system: it is the one line, with its history
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli, assertIncludes, assertNotIncludes, frames, rowsOf } = require('../helpers');

const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' };
const ENTER = '\n';
const ESC = '\x1b';
const DOWN = '\x1b[B';

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');

/** What the model's turn recorded as the answer, from the saved session. */
function chosenIn(configDir) {
  const dir = path.join(configDir, 'sessions');
  const f = fs.readdirSync(dir).find((x) => x.endsWith('.json'));
  const session = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const msg = session.messages.find((m) => m.role === 'tool' && /The user chose/.test(m.content || ''));
  return msg ? String(msg.content) : null;
}

function askRun({ question, options, keys, input = null, cwd = null }) {
  const dir = cwd || tmpdir('lain-mcq-');
  const configDir = path.join(dir, 'cfg');
  return runCli([], {
    cwd: dir,
    configDir,
    env: tui,
    stdinSteps: [`start${ENTER}`, ...keys, '/exit\n'],
    stepDelayMs: 700,
    script: [
      { text: 'Asking.', tool_calls: [{ name: 'ask_user', input: { question, options, input } }] },
      { text: 'Noted.' },
    ],
    timeoutMs: 60000,
  }).then((r) => ({ ...r, configDir }));
}

module.exports = async function () {
  // ------------------------------------------------------- THE REGRESSION --

  await test('MCQ LIVE: typing 2 against the options 1-4 answers 2, not 1', async () => {
    const r = await askRun({
      question: 'level (please type a number)',
      options: ['1', '2', '3', '4'],
      keys: [`2${ENTER}`],
    });
    assert.strictEqual(r.code, 0);
    const chose = chosenIn(r.configDir);
    assert.ok(chose, `nothing was recorded as an answer:\n${plain(r.out).slice(-900)}`);
    assertIncludes(chose, 'The user chose: 2',
      'the user typed 2 — anything else here is a silently wrong answer');
  });

  await test('MCQ LIVE: the typed line does not leak out as a new task afterwards', async () => {
    // The other half of the same defect: the digit stayed in the input buffer
    // and was submitted as a prompt once the panel closed, so the transcript
    // grew a `❯ 2` task nobody asked for.
    const r = await askRun({
      question: 'level', options: ['1', '2', '3', '4'], keys: [`2${ENTER}`],
    });
    const out = plain(r.out);
    const strays = (out.match(/^\s*❯ 2\s*$/gm) || []).length;
    assert.strictEqual(strays, 0, `the answer was also submitted as a task:\n${out.slice(-900)}`);
  });

  // ------------------------------------------- WHAT THE SCREEN PROMISES ----

  await test('MCQ LIVE: the box you type into says it is the ANSWER, and what it takes', async () => {
    const r = await askRun({
      question: 'level (please type a number)',
      options: ['1', '2', '3', '4'],
      keys: [ESC, ENTER],
    });
    const out = plain(r.out);
    // The border of the input box — the one editable surface on the screen.
    assertIncludes(out, 'ANSWER — type a number 1-5',
      'a box labelled INPUT under a question is what made this unfindable');
    // And the panel footer names the same keys, from the same source.
    assertIncludes(out, 'type a number 1-5 · ↑↓ choose · Enter send');
  });

  await test('MCQ LIVE: numeric choices are NUMBERED rows, not lettered ones', async () => {
    const r = await askRun({ question: 'level', options: ['1', '2', '3', '4'], keys: [ESC, ENTER] });
    const out = plain(r.out);
    assertIncludes(out, '1.  1');
    assertIncludes(out, '4.  4');
    assertNotIncludes(out, '[A] 1', 'lettering a numeric list asks about its own labels');
  });

  await test("MCQ LIVE: the model's own reply instruction is not printed twice", async () => {
    // "level (please type a number)" beside "type a number 1-5" is two
    // instructions that can disagree — and the model's can be wrong about what
    // the surface accepts, which is exactly what the design forbids.
    const r = await askRun({
      question: 'level (please type a number)', options: ['1', '2'], keys: [ESC, ENTER],
    });
    const rows = rowsOf(frames(r.out).find((f) => /LAIN NEEDS YOUR INPUT/.test(f)) || '');
    const inPanel = rows.slice(rows.findIndex((l) => /LAIN NEEDS YOUR INPUT/.test(l)));
    const question = inPanel.find((l) => /level/.test(l));
    assert.ok(question, `the question must be drawn:\n${inPanel.join('\n')}`);
    assert.ok(!/please type a number/.test(question),
      `the panel prints its own accurate prompt instead:\n${question}`);
  });

  // --------------------------------------------------------------- OTHER… --

  await test('MCQ LIVE: Other leads to a text state, and what is typed there is the answer', async () => {
    const r = await askRun({
      question: 'Which frontend?',
      options: ['React', 'Svelte'],
      // C is "Other…" — the row askUser always appends.
      keys: [`C${ENTER}`, `Preact, actually${ENTER}`],
    });
    const out = plain(r.out);
    assertIncludes(out, 'YOUR ANSWER', 'picking Other must open a state you can type in');
    assertIncludes(out, 'ANSWER — type your answer', 'and the input border must say so');
    const chose = chosenIn(r.configDir);
    assertIncludes(chose, 'Preact, actually', `free text must come back verbatim:\n${out.slice(-800)}`);
  });

  await test('MCQ LIVE: an answer on no list at all is still taken', async () => {
    const r = await askRun({
      question: 'Which frontend?',
      options: ['React', 'Svelte'],
      keys: [`neither, use Preact${ENTER}`],
    });
    assertIncludes(chosenIn(r.configDir), 'neither, use Preact',
      'a list is an offer, not a cage');
  });

  await test('MCQ LIVE: Escape out of the text state goes BACK to the choices', async () => {
    const r = await askRun({
      question: 'Which frontend?',
      options: ['React', 'Svelte'],
      // Into Other…, straight back out, then answer the ORIGINAL question.
      keys: [`C${ENTER}`, ESC, `2${ENTER}`],
    });
    const out = plain(r.out);
    assertIncludes(out, 'YOUR ANSWER', 'it went into the text state');
    // …and came back out to a question that is still there and still answerable.
    assertIncludes(chosenIn(r.configDir), 'The user chose: Svelte',
      `Escape must not throw the question away:\n${out.slice(-900)}`);
  });

  await test('MCQ LIVE: Escape at the choices still dismisses without inventing an answer', async () => {
    const r = await askRun({ question: 'Which?', options: ['a', 'b'], keys: [ESC, ENTER] });
    assertIncludes(plain(r.out), 'dismissed the question');
  });

  // ---------------------------------------------------- THE FIVE KINDS ----
  //
  //: every question declares what it is asking for, and the three surfaces
  // that describe it — the rows, the footer, and the border of the box you type
  // into — are drawn from that one declaration. What is asserted here is that
  // they AGREE on a real screen, because the reported bug was a question that
  // said "type a number" over a surface that would not take one.

  await test('KIND LIVE: a NUMBER question offers a number line and takes a number', async () => {
    const r = await askRun({ question: 'What level is it?', options: [], input: 'number', keys: [`3${ENTER}`] });
    const out = plain(r.out);
    assertIncludes(out, 'ANSWER — type a number', 'the box says what it takes');
    assertIncludes(out, 'Type a number on the line above and press Enter.');
    assertNotIncludes(out, 'Other', 'a number question has no Other row to pick');
    assertIncludes(chosenIn(r.configDir), 'The user chose: 3');
  });

  await test('KIND LIVE: a NUMBER question refuses prose and stays open to be corrected', async () => {
    // Quietly accepting "about forty" is worse than refusing: the model acts on
    // it. The refusal has to be VISIBLE, or the keypress just did nothing.
    const r = await askRun({
      question: 'What level is it?', options: [], input: 'number',
      keys: [`about forty${ENTER}`, `40${ENTER}`],
    });
    const out = plain(r.out);
    assertIncludes(out, 'is not a number', 'the reason must be on screen');
    assertIncludes(chosenIn(r.configDir), 'The user chose: 40', 'and the correction is taken');
  });

  await test('KIND LIVE: a MULTI_SELECT shows marks and takes a typed list', async () => {
    const r = await askRun({
      question: 'Which checks?', options: ['unit', 'smoke', 'live'], input: 'multi', keys: [`1,3${ENTER}`],
    });
    const out = plain(r.out);
    assertIncludes(out, 'ANSWER — type 1-3, comma separated');
    assertIncludes(out, '[ ] 1.  unit', 'the rows show what is marked and what is not');
    assertIncludes(out, 'Space mark', 'and the footer names the key that marks them');
    assertIncludes(chosenIn(r.configDir), 'The user chose: unit, live');
  });

  await test('KIND LIVE: a CONFIRMATION is Y and N and takes either', async () => {
    const r = await askRun({ question: 'Overwrite it?', options: [], input: 'confirm', keys: [`y${ENTER}`] });
    const out = plain(r.out);
    assertIncludes(out, 'ANSWER — type Y or N');
    assertIncludes(out, 'Y.  Yes');
    assertIncludes(out, 'N.  No');
    assertIncludes(chosenIn(r.configDir), 'The user chose: Yes');
  });

  await test('KIND LIVE: a TEXT question opens straight into typing', async () => {
    const r = await askRun({
      question: 'What should it be called?', options: [], input: 'text', keys: [`the reel handler${ENTER}`],
    });
    const out = plain(r.out);
    assertIncludes(out, 'ANSWER — type your answer');
    assertNotIncludes(out, 'Other', 'free text is already what you are doing');
    assertIncludes(chosenIn(r.configDir), 'the reel handler');
  });

  // ------------------------------------------------------ ONE INPUT SYSTEM --

  await test('MCQ LIVE: the answer is in the input history, arrowable like any line', async () => {
    // The proof that it went through the ONE editor rather than a second
    // text-entry widget bolted to the panel.
    const r = await askRun({
      question: 'Which frontend?',
      options: ['React', 'Svelte'],
      keys: [`neither, use Preact${ENTER}`, '\x1b[A'],
    });
    const rows = lastRowsWithInput(r.out);
    assert.ok(rows.some((l) => /neither, use Preact/.test(l)),
      `↑ must recall the answer onto the line:\n${rows.join('\n')}`);
  });

  await test('MCQ LIVE: /copy takes the question as plain text, and the question survives it', async () => {
    // "Make the prompt copy/paste friendly". A drawn panel is box characters
    // and a cursor marker, so selecting it in the terminal gives you
    // `│ ❯ 2.  Chat-style … │`. `/copy` gives the text instead — and a slash
    // command typed at an open question must RUN rather than be swallowed as
    // the answer, which is exactly the moment you want it.
    const r = await askRun({
      question: 'Which frontend?',
      options: ['React', 'Svelte'],
      keys: [`/copy${ENTER}`, `2${ENTER}`],
    });
    const out = plain(r.out);
    assertIncludes(out, 'copied question', '/copy must run, not answer the question');
    assertIncludes(chosenIn(r.configDir), 'The user chose: Svelte',
      `and the question must still be there afterwards:\n${out.slice(-800)}`);
  });

  await test('MCQ LIVE: an empty Enter still means the highlighted row', async () => {
    // The arrows must keep working — the typed line is an addition, not a
    // replacement for choosing.
    const r = await askRun({
      question: 'Which frontend?', options: ['React', 'Svelte'], keys: [`${DOWN}${ENTER}`],
    });
    assertIncludes(chosenIn(r.configDir), 'The user chose: Svelte');
  });
};

/** The rows of the last frame that has anything on the input line. */
function lastRowsWithInput(out) {
  const fs2 = frames(out);
  for (let i = fs2.length - 1; i >= 0; i--) {
    const rows = rowsOf(fs2[i]);
    if (rows.some((l) => /│ > \S/.test(l))) return rows;
  }
  return rowsOf(fs2[fs2.length - 1] || out);
}
