'use strict';

/**
 * "LAIN HAS BEEN DOING THE SAME STUFF FOR TOO LONG" — ON THE REAL BINARY.
 *
 * The requirement, in the user's words: the MCQ shows, it "never stop or wait
 * the LLM", and "if it ever done doing that stuff the mcq hide itself and not
 * asking the question until the LLM run the same hard issues again".
 *
 * So the three things a person would check by watching it:
 *   it APPEARS while the loop is happening
 *   the work CARRIES ON REGARDLESS — every remaining step runs, nothing waits
 *   it is GONE by the end, without anybody having pressed anything
 *
 * And the thing they could not see by watching, which is why the old version
 * survived so long: what went into the conversation. A `role: 'user'` message
 * LAIN wrote itself is invisible on screen and indistinguishable, to the model,
 * from something the person typed.
 *
 * LIVE CLI VERIFIED: argv, REPL, session, turn loop, tool dispatch, filesystem
 * and the real draw path. The network call is the mock.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, frames, lastFrameRows } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const DOWN = '\x1b[B';
const ENTER = '\r';

/** A trusted project holding two files with different contents. */
function project() {
  const cwd = tmpdir('looping-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    trustedPaths: [{ path: cwd, level: 'TRUSTED' }],
  }));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'AAA\n');
  fs.writeFileSync(path.join(cwd, 'b.txt'), 'BBB\n');
  return { cwd, configDir };
}

const readA = { name: 'read_file', input: { path: 'a.txt' } };
const readB = { name: 'read_file', input: { path: 'b.txt' } };

/** The session this run wrote. */
function sessionOf(r) {
  const dir = path.join(r.configDir, 'sessions');
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

module.exports = async function () {
  await test('ADVISORY: it appears while looping, and the turn never waits for it', async () => {
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'investigate\n',
      script: [
        { text: 'Reading.', tool_calls: [readA] },
        { text: 'Again.', tool_calls: [readA] },
        { text: 'And again.', tool_calls: [readA] },
        { text: 'Once more.', tool_calls: [readA] },
        { text: 'ALL_STEPS_RAN.' },
      ],
      timeoutMs: 90000,
    });
    const drawn = frames(r.out).map(plain).join('\n');
    assert.match(drawn, /STILL GOING ROUND/, 'the advisory was raised while the loop was happening');
    assert.match(drawn, /read_file a\.txt/, 'and it names what is repeating');

    // NOTHING WAITED. The steps after the advisory ran and the turn reached its
    // closing message — which is the whole difference between an advisory and
    // the BLOCKED state this replaced.
    assert.match(plain(r.out), /ALL_STEPS_RAN/, 'the model kept working while it was showing');

    // AND IT DOES NOT OUTLIVE THE TURN. Its offers are about a turn in
    // progress — "stop the turn", "it lands at the next step". With the turn
    // over, both would do nothing, and a box offering actions that no longer
    // exist is the footer-that-lies bug in slow motion.
    const last = plain(lastFrameRows(r.out).join('\n'));
    assert.ok(!/STILL GOING ROUND/.test(last),
      `the advisory outlived the turn it was about:\n${last}`);
  });

  await test('ADVISORY: nothing is written to the model, in the user\'s voice or any other', async () => {
    const { cwd, configDir } = project();
    const r = await runCli(['-p', 'investigate'], {
      cwd, configDir,
      script: [
        { text: 'Reading.', tool_calls: [readA] },
        { text: 'Again.', tool_calls: [readA] },
        { text: 'And again.', tool_calls: [readA] },
        { text: 'Done looking.' },
      ],
    });
    const said = sessionOf(r).messages.filter((m) => m.role === 'user').map((m) => String(m.content));
    assert.deepStrictEqual(said, ['investigate'],
      `only the user speaks as the user; found ${JSON.stringify(said)}`);
    const all = JSON.stringify(sessionOf(r).messages);
    assert.ok(!/liveness/i.test(all), 'the old nudge text must not reach the conversation');
    assert.ok(!/_liveness/.test(all), 'nor the flag that marked LAIN writing as the user');
  });

  await test('ADVISORY: it HIDES ITSELF once the model moves on — nobody dismisses it', async () => {
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'investigate\n',
      script: [
        { text: 'Reading.', tool_calls: [readA] },
        { text: 'Again.', tool_calls: [readA] },
        { text: 'And again.', tool_calls: [readA] },
        // The model breaks its own loop. The condition is gone, so the
        // advisory about it must be gone too.
        { text: 'Trying something else.', tool_calls: [readB] },
        { text: 'MOVED_ON.' },
      ],
      timeoutMs: 90000,
    });
    const drawn = frames(r.out).map(plain).join('\n');
    assert.match(drawn, /STILL GOING ROUND/, 'it was raised at some point');
    const last = plain(lastFrameRows(r.out).join('\n'));
    assert.ok(!/STILL GOING ROUND/.test(last),
      `it retracted itself; the closing frame still showed it:\n${last}`);
    assert.match(plain(r.out), /MOVED_ON/);
  });

  await test('ADVISORY: a loop that never happens is never mentioned', async () => {
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'investigate\n',
      script: [
        { text: 'One.', tool_calls: [readA] },
        { text: 'Two.', tool_calls: [readB] },
        { text: 'FINE.' },
      ],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    assert.ok(!/STILL GOING ROUND/.test(out), 'two different reads are not a loop');
    assert.ok(!/\[looping\]/.test(out));
    assert.match(out, /FINE/);
  });

  await test('ADVISORY: with no screen it is one line, and the run stays non-interactive', async () => {
    // `-p` has nobody to press a letter. It must still be said, and it must
    // not turn a scripted run into one that waits for input.
    const { cwd, configDir } = project();
    const r = await runCli(['-p', 'investigate'], {
      cwd, configDir,
      script: [
        { text: 'Reading.', tool_calls: [readA] },
        { text: 'Again.', tool_calls: [readA] },
        { text: 'And again.', tool_calls: [readA] },
        { text: 'FINISHED_ANYWAY.' },
      ],
    });
    assert.strictEqual(r.code, 0, 'it exits cleanly rather than waiting for an answer');
    assert.match(plain(r.stdout), /\[looping\]/, 'the observation is on the record');
    assert.match(plain(r.stdout), /FINISHED_ANYWAY/, 'and the work finished');
  });

  await test('ADVISORY: it renders as a real choice list — highlight marker, no letter prefixes', async () => {
    // The mock finishes a whole scripted turn in well under a second — far
    // faster than a person reacts — so a test that stages Down/Enter with
    // real delays and then checks whether it interrupted a LATER step races
    // the turn itself (the advisory does not block, by design; see
    // looping.js) and is not reliable in either direction. What IS reliable
    // through the real binary is what actually got DRAWN: the panel opens
    // with the first choice already highlighted, in the format Up/Down/Enter
    // now navigate — no leftover `[L]`/`[S]`/`[X]` letters advertised.
    // Precise keyboard navigation (Down moving the highlight, Enter
    // resolving it, both standing down once the line has text) is pinned
    // exactly, deterministically, in tests/unit/looping.test.js.
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdin: 'investigate\n',
      script: [
        { text: 'Reading.', tool_calls: [readA] },
        { text: 'Again.', tool_calls: [readA] },
        { text: 'And again.', tool_calls: [readA] },
        { text: 'Once more.', tool_calls: [readA] },
        { text: 'ALL_STEPS_RAN.' },
      ],
      timeoutMs: 90000,
    });
    const drawn = frames(r.out).map(plain).join('\n');
    assert.match(drawn, /❯ let it run/, 'opens with the first real choice highlighted');
    assert.match(drawn, /say something/, 'and the other two choices listed below it');
    assert.match(drawn, /stop the turn/);
    assert.ok(!/\[L\]|\[S\]|\[X\]/.test(drawn), 'the letter shortcuts are gone, not just unused');
    assert.match(drawn, /↑↓ choose/, 'the footer describes arrow navigation now');
  });

  await test('ADVISORY: Enter on an empty line closes it — no leftover panel after choosing', async () => {
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      stdinSteps: ['investigate\r', '', DOWN + ENTER, '/status\r', '/exit\r'],
      stepDelayMs: 3000,
      script: [
        { text: 'Reading.', tool_calls: [readA] },
        { text: 'Again.', tool_calls: [readA] },
        { text: 'And again.', tool_calls: [readA] },
        { text: 'Once more.', tool_calls: [readA] },
        { text: 'ALL_STEPS_RAN.' },
      ],
      timeoutMs: 90000,
    });
    // `/status` after the choice opens a completely different panel — proof
    // that Enter actually resolved and closed the advisory rather than
    // leaving it stuck open underneath (see the panel.close() regression this
    // guards against: a panel left visible after close() blocks every other
    // panel from opening at all — ui/menus.js's showMenu checks `!panel.visible`).
    const last = plain(lastFrameRows(r.out).join('\n'));
    assert.ok(!/STILL GOING ROUND/.test(last), 'the advisory is not still showing at the end');
    assert.match(plain(r.out), /session\s+2\d{7}-/, '/status opened and rendered normally afterward');
  });

  await test('ADVISORY: Up/Down/Enter do nothing to it while the input line has text', async () => {
    const { cwd, configDir } = project();
    const r = await runCli([], {
      cwd, configDir,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
      // Typed text sits in the line while the advisory is up; Down/Enter must
      // move the CARET and then send the LINE, never touch the panel's choice.
      stdinSteps: ['investigate\r', '', 'a note' + DOWN + ENTER, '/exit\r'],
      stepDelayMs: 3000,
      script: [
        { text: 'Reading.', tool_calls: [readA] },
        { text: 'Again.', tool_calls: [readA] },
        { text: 'And again.', tool_calls: [readA] },
        { text: 'Once more.', tool_calls: [readA] },
        { text: 'ALL_STEPS_RAN.' },
      ],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    assert.match(out, /ALL_STEPS_RAN/, 'the turn ran to the end — nothing was stopped by a stray Down/Enter');
    assert.match(out, /a note/, 'and what was typed reached the transcript rather than being swallowed');
  });
};
