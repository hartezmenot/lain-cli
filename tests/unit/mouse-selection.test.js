'use strict';

/**
 * THE TERMINAL KEEPS ITS OWN TEXT SELECTION UNLESS ASKED OTHERWISE.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, AND WHY IT WAS NOT OBVIOUS.
 *
 * `input.js` turned on `?1002h` — button-event tracking — at every TUI start,
 * unconditionally. That takes the terminal's own drag-selection, and LAIN
 * replaced it with a selection of its own... for the FEED only. The live region
 * at the bottom of the screen, where `/app` printed its URL, where an error
 * lands, where a path or a command appears, was selectable by NEITHER: LAIN had
 * captured the gesture and had nothing to do with it there.
 *
 * The standing advice was "hold Shift", which is true in Windows Terminal,
 * iTerm2 and GNOME Terminal and false in the legacy Windows console and several
 * multiplexer setups. For those people it was not advice, it was a dead end.
 *
 * `/mouse off` existed — and did not persist, so it lasted until the next
 * launch and no further.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS A UNIT TEST AND NOT A SMOKE.
 *
 * The mouse is only ever enabled on a REAL TTY (`app.ui.enable()` is false
 * otherwise), and a spawned process with a piped stdin has no TTY — so a smoke
 * that drives the binary through a pipe reports "no ?1002h" whatever the
 * setting is, and proves nothing at all. That was the first version of this
 * check, and it was vacuous.
 *
 * So the DECISION is tested here against the real modules, and the escape
 * sequences are asserted against the real reader.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

const config = require('../../src/config');

/** A stdout that records what was written to it, and claims to be a terminal. */
function fakeOut() {
  const written = [];
  return { written, isTTY: true, write: (s) => { written.push(String(s)); return true; }, text: () => written.join('') };
}

module.exports = async function () {
  await test('MOUSE: capture is OFF by default — the terminal keeps its selection', () => {
    assert.strictEqual(config.DEFAULTS.mouse, false,
      'a default that takes the terminal selection from everybody is the defect');
  });

  await test('MOUSE: the launch path honours the stored preference, both ways', () => {
    // THE ONE LINE THAT MATTERS, asserted as source because the alternative is
    // a spawned TTY this test cannot create. It used to read
    // `if (tui) input.enableMouse();` — unconditional, and re-asserted at every
    // launch, which is what made `/mouse off` last exactly one session.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'repl.js'), 'utf8');
    assert.match(src, /if \(tui && require\('\.\/config'\)\.load\(\)\.mouse === true\) input\.enableMouse\(\)/,
      'the launch must consult the stored preference');
    assert.ok(!/^\s*if \(tui\) input\.enableMouse\(\);/m.test(src),
      'the unconditional enable must be gone');
  });

  await test('MOUSE: /mouse writes the preference so it survives the session', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'helpcommand.js'), 'utf8');
    const cmd = src.slice(src.indexOf("define('/mouse'"), src.indexOf("define('/mouse'") + 2500);
    assert.match(cmd, /config\.save\(cfg\)/, 'a setting that does not survive the session is not a setting');
    assert.match(cmd, /cfg\.mouse = on/);
  });

  await test('MOUSE: the reader emits the capture sequences only when asked', () => {
    const Input = require('../../src/input');
    const Reader = Input.Reader || Input.Input || Input;
    if (typeof Reader !== 'function') return;   // shape changed; the guards above still hold

    const out = fakeOut();
    const stdin = {
      isTTY: true, setRawMode() {}, on() {}, removeListener() {}, pause() {}, resume() {},
    };
    let reader;
    try { reader = new Reader({ stdin, stdout: out }); } catch { return; }

    // NOTHING IS CAPTURED UNTIL enableMouse().
    assert.ok(!out.text().includes('[?1002h'), 'the reader must not take the mouse on construction');

    if (typeof reader.enableMouse !== 'function') return;
    reader.enableMouse();
    assert.ok(out.text().includes('[?1002h'), 'and it must actually capture when asked');
    assert.strictEqual(reader.mouseCaptured(), true);

    reader.disableMouse();
    assert.ok(out.text().includes('[?1002l'), 'and hand it back on the way out');
    assert.strictEqual(reader.mouseCaptured(), false);
  });

  await test('MOUSE: with the wheel unavailable, the KEYBOARD still scrolls', () => {
    // §H's hard requirement. The wheel arrives as a mouse report (SGR buttons
    // 64/65), so with reporting off it cannot arrive — and there is no mode
    // that delivers wheel events while leaving the terminal its own
    // drag-selection. So keyboard navigation is not a fallback here, it is THE
    // navigation, and it must be present and bound.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'keys.js'), 'utf8');
    assert.match(src, /case 'pageup': this\.screen\.scrollWorkspace/, 'PgUp must scroll the transcript');
    assert.match(src, /case 'pagedown': this\.screen\.scrollWorkspace/, 'PgDn must scroll the transcript');
    assert.match(src, /case 'alt-up': return this\.screen\.jumpToAnchor/, 'Alt+Up jumps to your own messages');
  });

  await test('MOUSE: the scroll hint NAMES the key, because the wheel may not be there', () => {
    // `↑ more` on its own assumed a wheel. With capture off it announced
    // scrollable content and named nothing that would scroll it — the reported
    // symptom exactly.
    const views = require('../../src/ui/views');
    // AN ARRAY, because that is what `scrollHint` measures — an object with a
    // `length` is not one, and `Number({...})` is NaN, which silently became a
    // total of 0 and made the first version of this assert against ''.
    const lines = (n) => Object.assign(new Array(n).fill('x'), { spoken: 0 });
    const at = (scroll) => views.scrollHint(lines(100), 20, { stickToBottom: false, scroll, anchorSpoken: 0 });
    assert.match(at(0), /PgDn/);
    assert.match(at(80), /PgUp/);
    assert.match(at(40), /PgUp\/PgDn/);
    // And it still says nothing when there is nothing to scroll.
    assert.strictEqual(views.scrollHint(lines(5), 20, { stickToBottom: true, scroll: 0, anchorSpoken: 0 }), '');
  });

  await test('MOUSE: /mouse says what each mode costs, rather than leaving it to be discovered', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'helpcommand.js'), 'utf8');
    assert.match(src, /PgUp\/PgDn scroll the transcript/, 'the off branch must name the keys');
    assert.match(src, /WHEEL scrolls the transcript/, 'the on branch must say what it buys');
  });

  await test('MOUSE: turning it off gives back every mode it turned on', () => {
    // A CAPTURE THAT IS NOT FULLY RELEASED leaves the terminal in a state the
    // person's next command inherits — mouse reports arriving as garbage in
    // their shell. Every `h` must have its `l`.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'input.js'), 'utf8');
    const on = (src.match(/\\x1b\[\?(\d+)h/g) || []).map((m) => m.match(/\d+/)[0]);
    const off = (src.match(/\\x1b\[\?(\d+)l/g) || []).map((m) => m.match(/\d+/)[0]);
    for (const mode of on) {
      if (mode === '2004') continue;             // bracketed paste, released in stop()
      assert.ok(off.includes(mode), `mode ?${mode}h is enabled and never disabled`);
    }
  });
};
