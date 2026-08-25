'use strict';

/**
 * ESCAPE SEQUENCES — bytes in, one named thing out.
 *
 * Split out of input.js, which had grown past the god-object guard. The seam is
 * the cleanest one in that file: everything else there is stateful — a line
 * being edited, a caret, a paste in progress, a history — and THIS is a pure
 * function of a byte buffer. It touches no terminal and holds nothing.
 *
 * That purity is worth having on its own. Terminals disagree about almost every
 * sequence here, the disagreements are the entire difficulty, and being able to
 * assert `ESC[13;2u is a newline` without a TTY, a screen or a session is what
 * makes any of it verifiable.
 *
 * WHY `wait` EXISTS. An arrow key is three bytes and can arrive split across two
 * reads. Deciding immediately would turn every such split into a spurious
 * "Escape pressed" — which cancels whatever the user had open. So an incomplete
 * but still-possible prefix says `wait`, and the caller arms a short timer; a
 * real lone Escape is resolved when that fires, which is what a terminal does
 * too.
 *
 * @returns {object|null}
 *   { take, key }        a named key: 'up', 'home', 'alt-3', 'escape'
 *   { take, action }     'newline' or 'deleteWord'
 *   { take, mouse }      a decoded SGR mouse report
 *   { wait: true }       an incomplete prefix; read more before deciding
 *   null                 not a sequence this knows; the caller decides
 */

/** The sequences that are simply a named key. */
const NAMED = Object.freeze({
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\x1b[Z': 'shift-tab',

  // ---- KEYS THAT WERE BEING SWALLOWED -------------------------------------
  //
  // A well-formed but UNMAPPED CSI sequence is consumed rather than typed (see
  // the end of decodeEscape), which is right — nobody wants `[3~` appearing in
  // their prompt. The cost is that an unmapped key is not inert, it is SILENT:
  // pressing it does nothing and nothing says why. Every entry below was in
  // exactly that state, so the editor was missing ordinary editing keys with no
  // symptom other than "that key does nothing".

  // DELETE — forward delete. Backspace worked; this did not.
  '\x1b[3~': 'delete',
  // CTRL+DELETE — forward delete a whole WORD, the mirror of Ctrl+Backspace.
  '\x1b[3;5~': 'ctrl-delete',

  // HOME / END, THE OTHER SPELLINGS. `ESC[H`/`ESC[F` is xterm in normal mode;
  // application-cursor mode sends `ESC[1~`/`ESC[4~`, and the VT220 lineage
  // sends `ESC[7~`/`ESC[8~`. Three spellings, one key.
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
  '\x1b[7~': 'home',
  '\x1b[8~': 'end',

  // CTRL+HOME / CTRL+END — jump the WHOLE buffer, not just the current line
  // of a multi-line prompt. `;5` is Ctrl, the same modifier word movement uses.
  '\x1b[1;5H': 'ctrl-home',
  '\x1b[1;5F': 'ctrl-end',

  // WORD MOVEMENT. Ctrl+←/→ is how a long line is edited without holding an
  // arrow down. `;5` is Ctrl; `;3` is Alt, which is what macOS terminals send
  // for the same gesture.
  // ALT+↑ / ALT+↓ — jump the feed from one thing the user said to the next.
  // `;3` is Alt. Without these the sequence is a well-formed CSI with no name
  // and is CONSUMED silently, which is the worst of both: the key does nothing
  // and nothing says why. See ui/layout.js `jumpToAnchor`.
  '\x1b[1;3A': 'alt-up',
  '\x1b[1;3B': 'alt-down',

  '\x1b[1;5D': 'word-left',
  '\x1b[1;5C': 'word-right',
  '\x1b[1;3D': 'word-left',
  '\x1b[1;3C': 'word-right',
  '\x1bb': 'word-left',            // Alt+b — the readline spelling
  '\x1bf': 'word-right',           // Alt+f

  // SELECTION FROM THE KEYBOARD. `;2` is Shift. Without these, selecting text
  // required the mouse, so a terminal with reporting off — or anyone who would
  // rather not reach for it — could not select anything at all.
  '\x1b[1;2D': 'shift-left',
  '\x1b[1;2C': 'shift-right',
  '\x1b[1;2A': 'shift-up',
  '\x1b[1;2B': 'shift-down',
  '\x1b[1;2H': 'shift-home',
  '\x1b[1;2F': 'shift-end',
  '\x1b[1;6D': 'shift-word-left',  // Ctrl+Shift+←
  '\x1b[1;6C': 'shift-word-right',
});

/** True while the buffer could still become a longer sequence. */
const PARTIAL = /^\x1b(?:\[<?[0-9;]*)?$/;

function decodeEscape(buf) {
  const s = String(buf || '');
  if (s[0] !== '\x1b') return null;

  // A MOUSE REPORT FIRST. `ESC[<b;x;yM` carries a `<` that the CSI pattern
  // below does not admit, so without this the whole report fell through to
  // "unrecognised" and was swallowed one byte at a time — the coordinates
  // arriving as literal typed digits.
  const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
  if (mouse) {
    return {
      take: mouse[0].length,
      mouse: {
        button: Number(mouse[1]), x: Number(mouse[2]), y: Number(mouse[3]), final: mouse[4],
      },
    };
  }
  // A partial mouse report split across chunks. Waiting is right for the same
  // reason it is right for a split arrow key.
  if (PARTIAL.test(s)) return { wait: true };

  // ALT+BACKSPACE — one of the word-deletes a terminal may send.
  if (/^\x1b\x7f/.test(s)) return { take: 2, action: 'deleteWord' };

  // SHIFT+ENTER AND ALT+ENTER — a new line of prompt, not a submission.
  //
  // THREE SPELLINGS, because terminals genuinely disagree and there is no
  // portable one:
  //
  //   ESC[13;2u   the CSI-u / "modifyOtherKeys" report. Windows Terminal,
  //               kitty, foot and WezTerm send it once the protocol is on.
  //               `;2` is Shift; `;3`/`;5` are Alt and Ctrl, and all of them
  //               mean the same thing here — you asked for a break.
  //   ESC CR      Alt+Enter as "meta sends escape" — xterm, iTerm, VS Code.
  //   ESC LF      the same, on terminals that send LF for Enter.
  //
  // MOST TERMINALS SEND PLAIN CR FOR SHIFT+ENTER and cannot be made to say
  // otherwise, which is why Ctrl+J (a bare LF, handled by the caller) exists as
  // the fallback that always works.
  const soft = /^\x1b(?:\[13;[0-9]+u|[\r\n])/.exec(s);
  if (soft) return { take: soft[0].length, action: 'newline' };

  // ALT+DIGIT — ESC then the digit, which is what a terminal sends. The view
  // tabs were once bound to `ctrl-1`..`ctrl-5`, a key name no reader can
  // produce (Ctrl+letter maps \x01-\x1a and Ctrl+digit sends nothing at all),
  // so switching views was unreachable however it was documented.
  const alt = /^\x1b([1-9])/.exec(s);
  if (alt) return { take: 2, key: `alt-${alt[1]}` };

  const csi = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(s);
  if (!csi) {
    if (PARTIAL.test(s)) return { wait: true };
    return { take: 1, key: 'escape' };
  }
  const named = NAMED[csi[0]];
  // A recognised CSI sequence with no name is CONSUMED, not typed: rendering
  // `[200~` into the prompt as literal characters is worse than ignoring it.
  return named ? { take: csi[0].length, key: named } : { take: csi[0].length };
}

/**
 * What a decoded SGR report MEANS.
 *
 * BIT 32 IS THE MOTION FLAG. Under `?1002h` (button-event tracking) it is set
 * only while a button is held, so a report carrying it is a DRAG. It used to
 * be masked off and thrown away along with every release, which is why there
 * was no way to select anything with the mouse at all.
 *
 * `?1003h` would set it for every cell the pointer crosses whether or not
 * anything is pressed — that is the redraw storm the two modes are routinely
 * confused over, and only one of them is affordable.
 */
function mouseEvent({ button, x, y, final }) {
  const moving = (button & 32) !== 0;
  const b = button & ~32;
  const kind = b === 64 ? 'wheel-up'
    : b === 65 ? 'wheel-down'
      : moving ? 'drag'
        : final === 'm' ? 'release' : 'press';
  return { kind, button: b, x, y };
}

module.exports = { decodeEscape, mouseEvent, NAMED, PARTIAL };
