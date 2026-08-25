'use strict';

/**
 * `/help` — WHAT LAIN CAN BE TOLD TO DO, AND WHICH KEYS DO IT.
 *
 * Split out of commands.js, which had grown past the god-object guard. The seam
 * is the one routecommands.js, sessioncommands.js and workcommands.js already
 * draw, with one difference worth stating: this is not a family of commands, it
 * is a VIEW OF THE REGISTRY. It renders what commands.js knows, and knows
 * nothing itself.
 *
 * THE KEYS ARE HALF OF IT, and that half is why this grew. A key nobody is told
 * about is a key that does not exist — the newline key was implemented, worked,
 * and was undiscoverable until it was named here.
 *
 * THREE SPELLINGS FOR ONE THING, listed honestly: most terminals cannot report
 * Shift+Enter at all, so naming only that would be an instruction that fails on
 * half the machines it is read on.
 */

/**
 * Keys, and what they do. Not derived from anything, because a terminal binding
 * is not something the program can enumerate — but kept HERE, beside the
 * commands, so there is one place a person looks to find out how to drive LAIN.
 */
/** A literal newline. Written this way for the reason commands.js states: an
 * escape in a generated string is one more thing that can arrive mangled. */
const NL = String.fromCharCode(10);

const KEYS = [
  ['Shift+Enter, Alt+Enter', 'new line in the prompt — if your terminal reports it'],
  ['Ctrl+J', 'new line in the prompt — works in every terminal'],
  ['Enter', 'send the prompt'],
  ['Tab, Alt+1..7', 'switch pane'],
  ['↑ ↓', 'move within a multi-line prompt, then through history'],
  ['Esc', 'close a panel, or stop a retry wait'],
  ['drag in the prompt', 'select text — Shift+drag keeps the terminal own selection'],
  ['/mouse', 'if Shift+drag does not work in your terminal, turn capture off'],
  ['Ctrl+C', 'copy the selection; with nothing selected, stop the turn'],
  ['Ctrl+X, Ctrl+V', 'cut the selection, paste the clipboard'],
  ['Ctrl+C twice', 'leave'],
];

function register({ define, REGISTRY, C }) {
  /**
   * `/mouse` — GIVE THE TERMINAL ITS SELECTION BACK.
   *
   * ---- THE DEAD END THIS REMOVES ----------------------------------------
   *
   * LAIN turns on `?1002h` so the prompt gets a caret you can click and tabs you
   * can press. That takes the terminal's own drag-selection, and the standing
   * advice — hold Shift — is true in Windows Terminal, iTerm2 and GNOME Terminal
   * and false in the legacy Windows console and in several multiplexer setups.
   * For anyone on those, "Shift+drag" was not advice; it was a sentence in
   * `/help` describing something that does not happen, with no way to turn the
   * capture off and no way to copy.
   *
   * It is a PREFERENCE now, and the trade is stated rather than hidden: off, the
   * clickable caret and tabs go, and the terminal behaves exactly as it did
   * before LAIN started. Only the person looking at the screen can judge that.
   *
   * It lives beside `/help` because it belongs to the same subject — how you
   * drive this thing — and because the key list above is where somebody hunting
   * for it will actually look.
   */
  define('/mouse', {
    surface: true,
    args: '[on|off]',
    desc: 'Mouse capture on or off - off restores your terminal own text selection',
    run(app, ctx) {
      const w = (s) => app.render.write(s + NL);
      const input = app.input;
      if (!input || typeof input.enableMouse !== 'function') {
        w('');
        w(C.dim('  There is no terminal here to capture.'));
        w('');
        return;
      }
      const want = String((ctx.args && ctx.args[0]) || '').toLowerCase();
      const on = want === 'on' ? true : (want === 'off' ? false : !input.mouseCaptured());
      if (on) input.enableMouse(); else input.disableMouse();
      w('');
      w(C.bold('  Mouse capture ') + (on ? C.green('ON') : C.yellow('OFF')));
      w('');
      if (on) {
        w(C.dim('  The prompt has a clickable caret and the tabs respond to clicks.'));
        w(C.dim('  Your terminal own drag-selection is taken; Shift+drag usually still works.'));
        w(C.dim('  If it does not in your terminal, run /mouse off.'));
      } else {
        w(C.dim('  Your terminal own selection and copy work exactly as they always do.'));
        w(C.dim('  The clickable caret and clickable tabs are off until /mouse on.'));
        w(C.dim('  /copy still works, and copies what LAIN knows rather than the screen.'));
      }
      w('');
    },
  });

  define('/help', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    desc: 'Show commands',
    run(app) {
      const w = (s) => app.render.write(s);
      w('\n' + C.bold('Commands') + '\n');
      for (const c of REGISTRY.values()) {
        // A long argument list must not eat the gap before the description.
        // `/plan [show|step <text>|…|clear]The session-owned plan` ran the two
        // columns together into one unreadable line.
        const left = c.name + (c.args ? ' ' + c.args : '');
        if (left.length > 21) w('  ' + left + '\n' + ' '.repeat(24) + C.dim(c.desc) + '\n');
        else w('  ' + left.padEnd(22) + C.dim(c.desc) + '\n');
      }
      // THE KEYS, not only the commands. A key nobody is told about is a key that
      // does not exist, and the newline key is the one people reach for first.
      //
      // THREE SPELLINGS FOR ONE THING, and this list is honest about why: most
      // terminals cannot report Shift+Enter at all, so naming only that would be
      // an instruction that fails on half the machines it is read on.
      w('\n' + C.bold('Keys') + '\n');
      // The same two-column rule the command list above uses, for the same
      // reason: a name exactly as wide as the column ran straight into its
      // description — `Shift+Enter, Alt+Enternew line in the prompt`.
      for (const [keys, what] of KEYS) {
        if (keys.length > 21) w('  ' + keys + '\n' + ' '.repeat(24) + C.dim(what) + '\n');
        else w('  ' + keys.padEnd(22) + C.dim(what) + '\n');
      }
      w('\n' + C.dim('  Anything else is sent to the model. Multi-line input is never a command.') + '\n');
    },
  });
}

module.exports = { register, KEYS };
