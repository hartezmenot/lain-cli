'use strict';

/**
 * ask_user / MCQ and the completion screen, through the REAL binary.
 *
 * `LAIN_FORCE_TUI=1` runs the production draw path over a pipe (a child never
 * gets a TTY). Keys are delivered as the real escape sequences a terminal sends.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli, assertIncludes, assertNotIncludes } = require('../helpers');

const tui = { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' };
const DOWN = '\x1b[B';
const ENTER = '\n';

function plain(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');
}

module.exports = async function () {
  await test('ASK: ask_user is a registered tool the model can call', async () => {
    const r = await runCli([], { stdin: '/tools\n/exit\n', script: [] });
    assertIncludes(r.stdout, 'ask_user');
  });

  await test('ASK: the model asks, the panel renders the choices, the answer returns', async () => {
    const cwd = tmpdir('lain-ask-');
    const r = await runCli([], {
      cwd, env: tui,
      // Enter selects the first option ("Node.js") in the panel.
      stdin: `pick a backend${ENTER}${ENTER}/exit\n`,
      script: [
        { text: 'Asking.', tool_calls: [{ name: 'ask_user', input: { question: 'Which backend should be used?', options: ['Node.js', 'Python', 'Go'] } }] },
        { text: 'Understood.' },
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);
    // The panel is titled for what it is doing, and the choices are labelled:
    // `LAIN NEEDS YOUR INPUT` with `A.  Node.js`. WAS `[A] Node.js`, and before
    // that `1. Node.js` under `ASK LAIN` — the label is now something you can
    // TYPE (see ui/answer.js), so it has to read the same way for a letter and
    // for a number. The guarantee this test exists for is untouched: the model
    // asked, the panel rendered every choice, and the answer went back.
    assertIncludes(out, 'LAIN NEEDS YOUR INPUT', 'the panel rendered');
    assertIncludes(out, 'Which backend should be used?');
    assertIncludes(out, 'A.  Node.js');
    assertIncludes(out, 'C.  Go');
    assertIncludes(out, 'Other', 'free-text escape is always offered');
    // AND THE SCREEN SAYS HOW TO ANSWER IT, on the box you actually type into.
    assertIncludes(out, 'ANSWER — type A-D', 'the input border names what it takes');
  });

  await test('ASK: the chosen answer is returned to the model AND kept as evidence', async () => {
    const cwd = tmpdir('lain-ask-');
    const configDir = path.join(cwd, 'cfg');
    const r = await runCli([], {
      cwd, configDir, env: tui,
      // Staged like a real user: ask, wait for the panel, move, select, exit.
      stdinSteps: [`pick one${ENTER}`, `${DOWN}${ENTER}`, ENTER, '/exit\n'],
      script: [
        { text: 'Asking.', tool_calls: [{ name: 'ask_user', input: { question: 'Which?', options: ['Alpha', 'Beta'] } }] },
        { text: 'Noted.' },
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const sessDir = path.join(configDir, 'sessions');
    const f = fs.readdirSync(sessDir).find((x) => x.endsWith('.json'));
    const session = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
    const toolMsg = session.messages.find((m) => m.role === 'tool' && /The user chose/.test(m.content || ''));
    assert.ok(toolMsg, `the answer reached the model as a tool result:\n${JSON.stringify(session.messages.map((m) => m.role))}`);
    assertIncludes(toolMsg.content, 'The user chose:');
  });

  await test('ASK: answering does NOT start a new task, wipe the plan, or reset steps', async () => {
    const cwd = tmpdir('lain-ask-');
    const configDir = path.join(cwd, 'cfg');
    const r = await runCli([], {
      cwd, configDir, env: tui,
      stdin: `build the parser${ENTER}/plan step design it${ENTER}/plan step write it${ENTER}/plan done designed${ENTER}`
        + `keep going${ENTER}${ENTER}/plan${ENTER}/task${ENTER}/exit\n`,
      script: [
        { text: 'Starting.' },
        { text: 'Asking.', tool_calls: [{ name: 'ask_user', input: { question: 'Which parser style?', options: ['recursive descent', 'PEG'] } }] },
        { text: 'Noted.' },
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.stdout);
    assertIncludes(out, 'design it', 'the plan survived');
    assertIncludes(out, 'designed', 'the completed step note survived');
    assertIncludes(out, '1/2 done', 'completed steps were not reset');
    assertIncludes(out, 'build the parser', 'the objective is unchanged');
  });

  await test('ASK: without an interactive UI the tool says so instead of hanging', async () => {
    const cwd = tmpdir('lain-ask-');
    const r = await runCli(['-p', 'ask me'], {
      cwd,                       // no LAIN_FORCE_TUI -> linear renderer
      script: [
        { text: 'Asking.', tool_calls: [{ name: 'ask_user', input: { question: 'Which?', options: ['a', 'b'] } }] },
        { text: 'Proceeding on my own.' },
      ],
    });
    assert.strictEqual(r.code, 0, 'it did not hang');
    assertIncludes(r.stdout, 'No interactive UI');
    assertIncludes(r.stdout, 'Proceeding on my own.');
  });

  await test('ASK: Esc dismisses without inventing an answer', async () => {
    const cwd = tmpdir('lain-ask-');
    const r = await runCli([], {
      cwd, env: tui,
      stdin: `ask${ENTER}\x1b${ENTER}/exit\n`,
      script: [
        { text: 'Asking.', tool_calls: [{ name: 'ask_user', input: { question: 'Which?', options: ['a', 'b'] } }] },
        { text: 'Carrying on.' },
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(plain(r.stdout), 'dismissed the question');
  });

  // ---- completion ---------------------------------------------------------

  await test('COMPLETION: shown when every step is done AND the work was CHECKED', async () => {
    const cwd = tmpdir('lain-done-');
    const r = await runCli([], {
      cwd, env: tui,
      stdin: `build it${ENTER}/plan step only step${ENTER}/plan done built it${ENTER}/exit\n`,
      script: [
        { text: 'Writing.', tool_calls: [{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }] },
        // A CHECK, not just an edit. This script stopped at the write, and the
        // task completed on the strength of the edit alone — the "plan 100%
        // ends the task" defect, sitting in a test fixture.
        { text: 'Checking.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "1"' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assertIncludes(plain(r.stdout), 'TASK COMPLETE');
  });

  await test('COMPLETION: NOT shown when the plan is finished but the change was never checked', async () => {
    // The other half of the same rule, and the defect this batch exists to fix:
    // every box ticked, a file written, and nothing run to find out whether it
    // works. That is precisely the state where the work most needs to carry on,
    // and LAIN was calling it finished.
    const cwd = tmpdir('lain-done-');
    const r = await runCli([], {
      cwd, env: tui,
      stdin: `build it${ENTER}/plan step only step${ENTER}/plan done built it${ENTER}/exit\n`,
      script: [
        { text: 'Writing.', tool_calls: [{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }] },
        { text: 'All planned steps are complete.' },
      ],
      timeoutMs: 45000,
    });
    const out = plain(r.stdout);
    assertNotIncludes(out, 'TASK COMPLETE', 'an unverified change is not a finished task');
    assertIncludes(out, 'not complete', 'and LAIN must say why it is carrying on');
    assertIncludes(out, 'nothing has been run to check');
    assertIncludes(out, 'VERIFYING', 'the status must stay active, not fall back to READY');
  });

  await test('COMPLETION: NOT shown when the plan is finished but nothing was done', async () => {
    // The safeguard: a finished checklist with no evidence is not completion.
    const cwd = tmpdir('lain-done-');
    const r = await runCli([], {
      cwd, env: tui,
      stdin: `think about it${ENTER}/plan step only step${ENTER}/plan done nothing actually happened${ENTER}/exit\n`,
      script: [{ text: 'I considered it.' }],   // no tools, no files, no commands
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assertNotIncludes(plain(r.stdout), 'TASK COMPLETE');
  });

  await test('COMPLETION: never shown merely because the model stopped talking', async () => {
    const cwd = tmpdir('lain-done-');
    const r = await runCli([], {
      cwd, env: tui,
      stdin: `do something${ENTER}/exit\n`,
      script: [
        { text: 'Writing.', tool_calls: [{ name: 'write_file', input: { path: 'a.txt', content: 'x' } }] },
        { text: 'All finished! Everything is complete.' },   // a CLAIM, with no plan
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r.code, 0);
    assertNotIncludes(plain(r.stdout), 'TASK COMPLETE');
  });
};
