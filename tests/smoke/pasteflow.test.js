'use strict';

/**
 * A PASTE IS SHOWN AS A MARKER AND SUBMITTED AS ITSELF.
 *
 * ------------------------------------------------------------------------
 * THE REGRESSION THIS GUARDS, stated as the data flow it must not break:
 *
 *     clipboard
 *        -> INPUT EDITOR            the full text lives here
 *        -> activity/context        shows `[pasted text #N]`
 *        -> ENTER
 *        -> SUBMIT                  the FULL ORIGINAL PAYLOAD
 *        -> model
 *
 * The marker is a DRAWING. It is not the message. Replacing the input buffer
 * with `[pasted text #1]`, or submitting the marker instead of the payload,
 * silently destroys what the user actually pasted — and it destroys it in the
 * one direction nobody checks, because the screen looks correct either way.
 *
 * ------------------------------------------------------------------------
 * EVERY CASE BELOW IS A DOOR THE PAYLOAD CAN BE LOST THROUGH, and they are
 * different doors: a paste alone, a paste that is then edited, two pastes in
 * one message, a paste with typing after it, and a paste with characters
 * deleted from it. A test of the first says nothing about the other four —
 * each one goes through a different part of the input editor.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes } = require('../helpers');

const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const START = ESC + '[200~';
const END = ESC + '[201~';
const plain = (s) => String(s).replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '');

/** A payload big enough to be compacted, with landmarks at both ends. */
function payload(tag, lines = 30) {
  const body = [];
  body.push('FIRST_LINE_' + tag);
  for (let i = 1; i < lines - 1; i++) body.push('line ' + i + ' of the ' + tag + ' payload with enough text to matter');
  body.push('LAST_LINE_' + tag);
  return body.join(NL);
}

/** Run one input sequence and return what the model was actually given. */
async function submitted(steps, { script = [{ text: 'Noted.' }] } = {}) {
  const cwd = tmpdir('pasteflow-');
  const configDir = path.join(cwd, 'cfg');
  const r = await runCli([], {
    cwd, configDir,
    env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '32' },
    stdinSteps: [...steps, '/exit' + NL],
    stepDelayMs: 2500,
    script,
    timeoutMs: 120000,
  });
  const dir = path.join(configDir, 'sessions');
  const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).pop();
  const session = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const user = (session.messages || []).filter((m) => m.role === 'user');
  return { r, session, user, out: plain(r.out), code: r.code };
}

module.exports = async function () {
  await test('PASTE: the FULL payload is submitted, and the marker is only drawn', async () => {
    const text = payload('ALPHA');
    const { code, user, out } = await submitted([START + text + END, CR]);
    assert.strictEqual(code, 0);

    const msg = user.find((m) => /FIRST_LINE_ALPHA/.test(String(m.content || '')));
    assert.ok(msg, `the payload must reach the model; user messages were:${NL}`
      + user.map((m) => String(m.content || '').slice(0, 80)).join(NL));

    // BOTH ENDS. A payload cut anywhere in the middle still contains its first
    // line, so checking the head alone would pass on a truncated message.
    assertIncludes(msg.content, 'FIRST_LINE_ALPHA');
    assertIncludes(msg.content, 'LAST_LINE_ALPHA', 'the END of the paste must survive too');
    assert.ok(String(msg.content).split(NL).length >= 25,
      `all of it, not a summary: got ${String(msg.content).split(NL).length} lines`);

    // AND THE MARKER IS NOT THE MESSAGE.
    assertNotIncludes(msg.content, '[pasted text',
      'the marker is a DRAWING — submitting it destroys what the user pasted');
    // But it IS what the screen shows.
    assertIncludes(out, '[pasted text', 'the activity view must stay compact');
    assertNotIncludes(out, 'line 14 of the ALPHA payload',
      'and must not draw the payload line by line');
  });

  await test('PASTE: typing AFTER a paste keeps both the payload and the typing', async () => {
    // The commonest real shape: paste a log, then say what to do about it.
    const text = payload('BRAVO');
    const { code, user } = await submitted([START + text + END, 'what is wrong here', CR]);
    assert.strictEqual(code, 0);
    const msg = user.find((m) => /FIRST_LINE_BRAVO/.test(String(m.content || '')));
    assert.ok(msg, 'the payload must survive typing after it');
    assertIncludes(msg.content, 'LAST_LINE_BRAVO');
    assertIncludes(msg.content, 'what is wrong here', 'and so must the words typed after it');
  });

  await test('PASTE: TWO pastes in one message both arrive whole', async () => {
    // Two payloads means two markers on screen and one message underneath, and
    // the numbering is the only thing that distinguishes them.
    const a = payload('CHARLIE', 20);
    const b = payload('DELTA', 20);
    const { code, user, out } = await submitted([START + a + END, START + b + END, CR]);
    assert.strictEqual(code, 0);
    const msg = user.find((m) => /FIRST_LINE_CHARLIE/.test(String(m.content || '')));
    assert.ok(msg, 'the first payload must survive a second paste');
    assertIncludes(msg.content, 'LAST_LINE_CHARLIE');
    assertIncludes(msg.content, 'FIRST_LINE_DELTA', 'and the second payload must be there too');
    assertIncludes(msg.content, 'LAST_LINE_DELTA');
    assert.ok(!/\[pasted text/.test(String(msg.content)), 'neither may be replaced by its marker');
    assertIncludes(out, '[pasted text', 'the screen still shows markers');
  });

  await test('PASTE: DELETING after a paste edits the payload, not the marker', async () => {
    // THE SHARPEST CASE. If the buffer holds a marker instead of the text, a
    // backspace deletes a character OF THE MARKER — and the message that goes
    // out is `[pasted text #` with the payload gone entirely. If the buffer
    // holds the text, a backspace removes the last character of the payload,
    // which is what the user meant.
    const text = payload('ECHO', 20);
    const BS = String.fromCharCode(127);
    const { code, user } = await submitted([START + text + END, BS + BS + BS, CR]);
    assert.strictEqual(code, 0);
    const msg = user.find((m) => /FIRST_LINE_ECHO/.test(String(m.content || '')));
    assert.ok(msg, 'the payload must still be there after editing it');
    assert.ok(!/\[pasted text/.test(String(msg.content)),
      'a backspace must never be editing the MARKER — that submits a broken marker and no payload');
    // ---- EXACTLY THREE CHARACTERS, OFF THE END OF THE PAYLOAD ---------
    //
    // MEASURED: 1011 chars pasted, 1008 delivered, ending `LAST_LINE_E`.
    // `ECHO` minus three is `E` — this assertion first said `EC`, which was
    // arithmetic and not behaviour, and the behaviour was right all along.
    //
    // This is the proof that the buffer holds the TEXT: had it held the marker,
    // a backspace would have eaten `[pasted text #1]` and the payload would
    // have gone out whole or not at all, never three characters shorter.
    assertIncludes(msg.content, 'LAST_LINE_E');
    assert.ok(!/LAST_LINE_ECH/.test(String(msg.content)),
      'the three deleted characters must really have come off the payload');
    assert.strictEqual(String(msg.content).length, text.length - 3,
      'exactly three characters, no more and no fewer');
  });

  await test('PASTE: a paste survives being carried into a RUNNING turn as a steer', async () => {
    // A paste typed while LAIN is working goes through the steer path, which is
    // a different door into the same session. The payload must survive it.
    const text = payload('FOXTROT', 20);
    const { code, session } = await submitted(
      ['start something long' + NL, START + text + END, CR],
      {
        script: [
          { text: 'Working.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "console.log(1)"' } }], delayMs: 2500 },
          { text: 'Done.' },
        ],
      },
    );
    assert.strictEqual(code, 0);
    const all = JSON.stringify(session.messages || []);
    assert.ok(/FIRST_LINE_FOXTROT/.test(all) && /LAST_LINE_FOXTROT/.test(all),
      'a payload pasted during a turn must reach the session whole, not as a marker');
  });
};
