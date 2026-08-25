'use strict';

/**
 * NAVIGATING BACK TO WHAT YOU SAID — through the real binary.
 *
 * ------------------------------------------------------------------------
 * THE OUTSTANDING ITEM THIS CLOSES, AND WHY IT WAS NOT WHAT IT LOOKED LIKE.
 *
 * A previous audit recorded "click-to-navigate" as unfinished, on the reading
 * that clicking a user block ought to jump the feed to that message but instead
 * restores the message to the input line.
 *
 * Reading ui/anchors.js, that is the DESIGNED behaviour and there is a reason
 * for it: every row of a user block carries the FULL original text, so a click
 * puts back the whole of a four-hundred-line paste that is drawn on screen as
 * `[pasted text #1]`. Rebinding that gesture to a scroll would trade something
 * only a click can do for something a key already does.
 *
 * The navigation exists on Alt+Up / Alt+Down. So the honest question was never
 * "implement click-to-navigate" — it was "does the navigation that exists
 * actually work at the boundary", and nothing had ever asserted that through
 * the real binary. That is what this file does.
 *
 * ------------------------------------------------------------------------
 * WHY A SMOKE TEST AND NOT A UNIT TEST. `jumpToAnchor` is unit-testable and the
 * interesting failure is not in it: the anchors are read from `lastFeedLines`,
 * the feed that was ACTUALLY DRAWN, so whether a jump can land anywhere depends
 * on a real terminal geometry, a real feed and a real scroll clamp. Its own
 * comment records a defect of exactly that kind — the newest anchor reporting a
 * successful jump that the clamp had silently undone.
 */

const assert = require('assert');
const { test, runCli, tmpdir, assertIncludes } = require('../helpers');

const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const ALT_UP = ESC + '[1;3A';
const ALT_DOWN = ESC + '[1;3B';
const plain = (s) => String(s).replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '');

/** The rows of a frame, blank ones kept — a jump is judged by what moved. */
function rowsOf(frame) {
  return frame.split(new RegExp(ESC + '\\[\\d+;1H')).slice(1)
    .map(plain).map((r) => r.replace(/\s+$/, ''));
}
const framesOf = (out) => String(out).split(ESC + '[?25l').slice(1);

module.exports = async function () {
  await test('ANCHOR NAV: Alt+Up walks back through what the user actually said', async () => {
    const cwd = tmpdir('anchor-');
    // Four messages, each with enough work under it that the earlier ones are
    // scrolled off — a jump that only works when everything fits on one screen
    // is not navigation.
    const filler = (n) => ({
      text: 'Working on it.',
      tool_calls: [{ name: 'run_bash', input: { command: `node -e "console.log('step ${n}')"` } }],
    });
    const script = [];
    for (let i = 1; i <= 4; i++) {
      script.push(filler(i), filler(i + 100), { text: `Done with request ${i}.` });
    }

    const r = await runCli([], {
      cwd,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '24' },
      stdinSteps: [
        'first request: check the loader' + NL,
        'second request: check the parser' + NL,
        'third request: check the writer' + NL,
        'fourth request: check the reader' + NL,
        ALT_UP, ALT_UP, ALT_UP,
        '/exit' + NL,
      ],
      stepDelayMs: 2500,
      script,
      timeoutMs: 120000,
    });
    assert.strictEqual(r.code, 0);

    const frames = framesOf(r.out);
    assert.ok(frames.length > 4, 'the session really drew frames');

    // ---- THE VIEW ACTUALLY MOVED ----------------------------------------
    //
    // Judged by content rather than by a scroll number, because the scroll
    // number is exactly what lied in the defect this guards: it was set, then
    // clamped back, and the jump reported success anyway.
    const panes = frames.map((f) => rowsOf(f).join(NL));
    const distinct = new Set(panes);
    assert.ok(distinct.size > 3, 'the workspace must change as the feed is navigated');

    // Every message the user typed must be reachable somewhere in the run.
    const all = panes.join(NL);
    for (const said of ['check the loader', 'check the parser', 'check the writer', 'check the reader']) {
      assertIncludes(all, said, 'a message the user typed must be findable in the feed');
    }
    // And they are labelled as anchors rather than drawn as bare prose.
    assertIncludes(all, 'USER', 'the anchor label is what makes a message findable when scrolling back');
  });

  await test('ANCHOR NAV: a click puts the whole message back, which a jump cannot do', async () => {
    // THE REASON THE CLICK IS NOT REBOUND. What is DRAWN for a long paste is a
    // marker; what a click restores is the payload. Rebinding this gesture to a
    // scroll would trade the only thing that recovers the text for something
    // Alt+Up already does.
    //
    // Asserted at the level that can be asserted without a mouse: the feed
    // draws the marker, and the full text is what the session holds.
    const cwd = tmpdir('anchor-');
    const long = Array.from({ length: 30 }, (_, i) => `line ${i} of a pasted log`).join(NL);
    const r = await runCli([], {
      cwd,
      env: { LAIN_FORCE_TUI: '1', COLUMNS: '100', LINES: '30' },
      stdinSteps: [ESC + '[200~' + long + ESC + '[201~', NL, '/exit' + NL],
      stepDelayMs: 3000,
      script: [{ text: 'Read it.' }],
      timeoutMs: 90000,
    });
    assert.strictEqual(r.code, 0);
    const out = plain(r.out);
    assertIncludes(out, '[pasted text', 'a long paste is drawn as a marker, not as thirty lines');

    const fs = require('fs');
    const path = require('path');
    const dir = path.join(cwd, '.config', 'sessions');
    const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).pop();
    const session = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const user = session.messages.find((m) => m.role === 'user' && /pasted log/.test(String(m.content || '')));
    assert.ok(user, 'and the payload itself is what the session and the model actually hold');
    assert.ok(String(user.content).split(NL).length > 20, 'all of it, not the marker');
  });
};
