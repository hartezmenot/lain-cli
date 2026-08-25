'use strict';

/**
 * A RESIZE REFLOWS THE SCREEN, WITHOUT WAITING FOR ANYTHING TO HAPPEN.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS ASSERTED ON THE REAL `Screen` AND NOT THROUGH THE BINARY.
 *
 * The smoke tier drives bin/lain.js over a PIPE, and a pipe has no dimensions —
 * `LAIN_FORCE_TUI` makes the real draw path run there, but `out.columns` is
 * undefined and the size comes from the COLUMNS environment variable, which is
 * fixed for the life of the child. So a child process cannot be resized, and a
 * smoke test claiming to prove reflow would be proving nothing.
 *
 * What a resize actually IS, is two things: the terminal changes `out.columns`
 * and emits `resize`. Both are standard Node behaviour on a real TTY and
 * neither is LAIN's code. So this hands the real `Screen` an `out` that does
 * exactly that, and asserts on the bytes it writes — which is the whole of
 * LAIN's side of the contract.
 *
 * ------------------------------------------------------------------------
 * THE THREE CLAIMS, and they are separable:
 *
 *   IT REDRAWS AT ALL          a resize writes a frame with no new turn, no new
 *                              model response and no keystroke.
 *   IT REDRAWS AT THE NEW SIZE the frame is composed against the CURRENT width,
 *                              not the one that was in force when the content
 *                              was first drawn.
 *   IT CARRIES NOTHING STALE   going back to a width reproduces that width, so
 *                              nothing width-dependent was cached across.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { test } = require('../helpers');

const { Screen } = require('../../src/ui/layout');

const strip = (s) => String(s)
  .replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A terminal that can be resized, and remembers everything written to it. */
function fakeTerminal(cols, rows) {
  const out = new EventEmitter();
  out.isTTY = true;
  out.columns = cols;
  out.rows = rows;
  out.writes = [];
  out.write = (s) => { out.writes.push(String(s)); return true; };
  /** What a real terminal does: change the size, then say so. */
  out.resizeTo = (c, r) => { out.columns = c; out.rows = r; out.emit('resize'); };
  /** The frames written since the marker, as plain text. */
  out.since = (n) => out.writes.slice(n).map(strip).join('');
  return out;
}

const LONG_RUN = 'node bin/lain.js (start a Probe with /mcp probe, then run the task)';

/** A screen showing one turn whose summary carries a long command. */
function screenWith(out) {
  const s = new Screen({ out });
  s.enter();
  s.state = {
    // `narration` is what the feed draws — the per-step prose the model
    // actually said. `text` is the turn's closing record; a turn with prose but
    // an empty narration draws nothing, which is what made the first version of
    // this test assert against a blank pane.
    session: {
      turns: [{
        userInput: 'do it',
        text: `How to run: ${LONG_RUN}`,
        narration: [{ step: 0, text: `How to run: ${LONG_RUN}` }],
        actions: [],
      }],
    },
    transcript: [],
    liveActions: [],
    liveNarration: [],
  };
  return s;
}

module.exports = async function () {
  await test('REFLOW: a resize redraws with no new turn, no response and no keystroke', () => {
    const out = fakeTerminal(60, 30);
    const s = screenWith(out);
    s.draw();
    const mark = out.writes.length;

    // Nothing else happens. No submit, no model event, no key.
    out.resizeTo(140, 30);

    assert.ok(out.writes.length > mark, 'a resize wrote nothing — the screen is not live');
    assert.ok(strip(out.since(mark)).includes('bin/lain.js'),
      'the redraw did not carry the content');
    s.leave();
  });

  await test('REFLOW: the redraw is composed at the NEW width, not the old one', () => {
    const narrowOut = fakeTerminal(60, 30);
    const narrow = screenWith(narrowOut);
    narrow.draw();
    const atNarrow = strip(narrowOut.writes.join(''));

    const out = fakeTerminal(60, 30);
    const s = screenWith(out);
    s.draw();
    const mark = out.writes.length;
    out.resizeTo(140, 30);
    const afterResize = strip(out.since(mark));

    // The same content, drawn differently — which is what reflow means.
    assert.ok(afterResize.includes('bin/lain.js'), 'the command is still there');
    assert.notStrictEqual(afterResize.length, atNarrow.length,
      'the frame after the resize is byte-identical to the narrow one');
    // AND THE COMMAND IS WHOLE. This is the property the defect broke: at the
    // wider size the command must be readable in full, not still cut.
    const joined = afterResize.replace(/\s+/g, ' ');
    assert.ok(joined.includes('then run the task'),
      `the end of the command did not survive the resize:\n${joined.slice(0, 400)}`);
    s.leave();
  });

  await test('REFLOW: narrow → wide → narrow reproduces the narrow frame exactly', () => {
    const out = fakeTerminal(60, 30);
    const s = screenWith(out);

    s.draw();
    const first = strip(out.writes.join(''));

    out.resizeTo(140, 30);
    const wideMark = out.writes.length;
    out.resizeTo(60, 30);
    const back = strip(out.since(wideMark));

    // A frame composed at 60 the second time must contain what the first one
    // did. Compared on CONTENT rather than byte-for-byte: `_lastFrame` skips an
    // identical repaint, so the raw bytes legitimately differ in the cursor
    // parking, and asserting on those would pin an optimisation instead of a
    // property.
    for (const needle of ['bin/lain.js', 'then run the task']) {
      assert.ok(back.includes(needle) || back.replace(/\s+/g, ' ').includes(needle),
        `coming back to 60 columns lost ${JSON.stringify(needle)}`);
      assert.ok(first.replace(/\s+/g, ' ').includes(needle), 'sanity: it was there at first');
    }
    s.leave();
  });

  await test('REFLOW: the last-frame cache is dropped on resize, so it cannot suppress the redraw', () => {
    // `draw` writes nothing when the composed frame equals the one on screen.
    // That optimisation is correct and it is exactly what would eat a resize if
    // the cache were not cleared — the frame would compare equal to a frame
    // composed at a different size. Pinned because it is invisible when right.
    const out = fakeTerminal(60, 30);
    const s = screenWith(out);
    s.draw();
    s.draw();                                   // identical: writes almost nothing
    const mark = out.writes.length;
    s.draw();
    const idle = out.since(mark).length;

    const mark2 = out.writes.length;
    out.resizeTo(61, 30);                       // one column: still a real resize
    const resized = out.since(mark2).length;

    assert.ok(resized > idle,
      `a resize must write more than an idle redraw (${resized} vs ${idle})`);
    s.leave();
  });
};
