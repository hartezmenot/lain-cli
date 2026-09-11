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
 *
 * `Tab, Alt+1..7  switch pane` USED TO BE THE FOURTH ROW, and it is gone with
 * the panes. A key list that names a binding which does nothing is worse than
 * a short key list: it sends somebody to press a key and conclude LAIN is
 * broken when it is doing exactly what it now means to do.
 */
const NL = String.fromCharCode(10);

const KEYS = [
  ['Shift+Enter, Alt+Enter', 'new line in the prompt — if your terminal reports it'],
  ['Ctrl+J', 'new line in the prompt — works in every terminal'],
  ['Enter', 'send the prompt'],
  ['↑ ↓', 'move within a multi-line prompt, then through history'],
  ['PgUp/PgDn, Home/End', 'scroll the conversation'],
  ['Alt+↑ Alt+↓', 'jump to the previous or next thing YOU said'],
  ['Esc', 'close a panel, or stop a retry wait'],
  ['drag in the prompt', 'select text — Shift+drag keeps the terminal own selection'],
  ['/mouse', 'if Shift+drag does not work in your terminal, turn capture off'],
  ['Ctrl+C', 'copy the selection; with nothing selected, stop the turn'],
  ['Ctrl+X, Ctrl+V', 'cut the selection, paste the clipboard'],
  ['Ctrl+C twice', 'leave'],
];

/**
 * WHICH COMMANDS COME FIRST, AND WHY THERE ARE GROUPS AT ALL.
 *
 * ------------------------------------------------------------------------
 * THE LIST WAS THE REGISTRY IN INSERTION ORDER — fifty-odd commands, `/config`
 * and `/copy` at the top because commands.js happens to define them first, and
 * `/bg` somewhere in the middle. That is a reference, not help. It was
 * survivable while the workspace had nine panes doing the obvious things; with
 * ONE surface, commands ARE the way to everything else, so the order they are
 * presented in is the discoverability of the whole program.
 *
 * FOUR GROUPS, IN THE ORDER SOMEBODY NEEDS THEM:
 *
 *   WORK        what you are doing right now, and running it beside you
 *   LOOK        what is true — the project, the changes, the evidence
 *   SESSION     the conversation itself, and what it is routed through
 *   ADVANCED    engineering diagnostics. Real, supported, and last.
 *
 * ANYTHING NOT NAMED HERE IS ADVANCED BY DEFAULT. A command added tomorrow
 * lands in the diagnostics group and stays out of the first screen until
 * somebody decides it belongs there — which is the right failure: an unlisted
 * command is still listed, just later.
 */
const GROUPS = [
  ['Working', [
    '/bg', '/ps', '/steer', '/plan', '/task', '/verify', '/cancel', '/answer', '/jobs',
  ]],
  ['Looking', [
    '/brief', '/changes', '/undo', '/note', '/tasks', '/artifacts', '/env', '/health', '/lain',
  ]],
  ['This session', [
    '/model', '/effort', '/provider', '/new', '/clear', '/compact', '/resume', '/sessions',
    '/token', '/status', '/help', '/exit',
  ]],
];

/** The group a command belongs to, or '' for the advanced tail. */
function groupOf(name) {
  for (const [label, names] of GROUPS) if (names.includes(name)) return label;
  return '';
}

function register({ define, REGISTRY, C }) {

  /**
   * `/mouse` — GIVE THE TERMINAL ITS SELECTION BACK.
   *
   * ---- THE DEAD END THIS REMOVES ----------------------------------------
   *
   * LAIN turns on `?1002h` so the prompt gets a caret you can click, the feed
   * can be drag-selected, and a row naming a file can be opened. That takes the
   * terminal's own drag-selection, and the standing
   * advice — hold Shift — is true in Windows Terminal, iTerm2 and GNOME Terminal
   * and false in the legacy Windows console and in several multiplexer setups.
   * For anyone on those, "Shift+drag" was not advice; it was a sentence in
   * `/help` describing something that does not happen, with no way to turn the
   * capture off and no way to copy.
   *
   * It is a PREFERENCE now, and the trade is stated rather than hidden: off, the
   * clickable caret and the feed's click targets go, and the terminal behaves
   * exactly as it did before LAIN started. Only the person looking at the screen
   * can judge that.
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
      // ---- AND IT STICKS ------------------------------------------------
      //
      // The preference used to live only in the reader, so it was re-asserted
      // at every launch: a person who ran `/mouse off` to get their selection
      // back lost it again the next time they started LAIN, with nothing on
      // screen explaining why. A setting that does not survive the session is
      // not a setting.
      try {
        const config = require('./config');
        const cfg = config.load();
        if (cfg.mouse !== on) { cfg.mouse = on; config.save(cfg); }
      } catch { /* an unwritable config still leaves the change live this session */ }
      w('');
      w(C.bold('  Mouse capture ') + (on ? C.green('ON') : C.yellow('OFF')));
      w('');
      if (on) {
        w(C.dim('  The prompt has a clickable caret, the conversation can be selected and clicked,'));
        w(C.dim('  and the WHEEL scrolls the transcript.'));
        w(C.dim('  Your terminal own drag-selection is taken; Shift+drag usually still works.'));
        w(C.dim('  If it does not in your terminal, run /mouse off.'));
      } else {
        w(C.dim('  Your terminal own selection and copy work exactly as they always do.'));
        // ---- THE TRADE, STATED RATHER THAN DISCOVERED ---------------------
        //
        // The wheel arrives as a MOUSE REPORT (SGR buttons 64/65), so with
        // reporting off it does not arrive at all. There is no mode that
        // delivers wheel events and leaves the terminal its own drag-selection:
        // any tracking mode routes mouse input to the application. Saying so
        // here is the difference between a trade and a thing that seems broken.
        w(C.dim('  The wheel and the clickable caret are off; PgUp/PgDn scroll the transcript,'));
        w(C.dim('  and Alt+↑/Alt+↓ jump between your own messages. /mouse on for the wheel.'));
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
      /** One command as `  /name <args>    what it does`, wrapping if it must. */
      const row = (c) => {
        // A long argument list must not eat the gap before the description.
        // `/plan [show|step <text>|…|clear]The session-owned plan` ran the two
        // columns together into one unreadable line.
        const left = c.name + (c.args ? ' ' + c.args : '');
        if (left.length > 21) w('  ' + left + NL + ' '.repeat(24) + C.dim(c.desc) + NL);
        else w('  ' + left.padEnd(22) + C.dim(c.desc) + NL);
      };

      // ---- ONE SURFACE, SO THE COMMANDS ARE THE MAP --------------------
      //
      // LAIN has one screen: the conversation, what it is doing, and where you
      // type. Everything else — what changed, what is running, what proved it,
      // what this project is — is a command, and this is where they are found.
      w(NL + C.bold('Commands') + C.dim('  — type anything to work; these reach the rest') + NL);
      const listed = new Set();
      for (const [label, names] of GROUPS) {
        const found = names.map((n) => REGISTRY.get(n)).filter(Boolean);
        if (!found.length) continue;
        w(NL + C.bold('  ' + label) + NL);
        // IN THE ORDER THE GROUP NAMES THEM, not the registry's. The order is
        // the recommendation: `/bg` before `/jobs` because starting work comes
        // before inspecting it, `/brief` before `/changes` because orienting
        // comes before reviewing.
        for (const c of found) { row(c); listed.add(c.name); }
      }
      // ---- EVERYTHING ELSE, MARKED AS WHAT IT IS ------------------------
      //
      // Not hidden. A diagnostic nobody can find is a diagnostic that does not
      // exist, and this is the tool people debug the harness itself with. It is
      // simply LAST, and labelled, so the first screen is the program rather
      // than its instrumentation.
      // COMPATIBILITY ALIASES ARE NOT ADVERTISED — see commands.js `define`.
      const rest = [...REGISTRY.values()].filter((c) => !listed.has(c.name) && !c.hidden);
      if (rest.length) {
        w(NL + C.bold('  Advanced') + C.dim('  — diagnostics and machinery') + NL);
        for (const c of rest) row(c);
      }

      // THE KEYS, not only the commands. A key nobody is told about is a key that
      // does not exist, and the newline key is the one people reach for first.
      //
      // THREE SPELLINGS FOR ONE THING, and this list is honest about why: most
      // terminals cannot report Shift+Enter at all, so naming only that would be
      // an instruction that fails on half the machines it is read on.
      w(NL + C.bold('  Keys') + NL);
      // The same two-column rule the command list above uses, for the same
      // reason: a name exactly as wide as the column ran straight into its
      // description — `Shift+Enter, Alt+Enternew line in the prompt`.
      for (const [keys, what] of KEYS) {
        if (keys.length > 21) w('  ' + keys + NL + ' '.repeat(24) + C.dim(what) + NL);
        else w('  ' + keys.padEnd(22) + C.dim(what) + NL);
      }
      w(NL + C.dim('  Anything else is sent to the model. Multi-line input is never a command.') + NL);
      w(C.dim('  You never have to choose a workflow — describe the problem and LAIN routes it.') + NL);
    },
  });
}

module.exports = { register, KEYS, GROUPS, groupOf };
