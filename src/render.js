'use strict';

/**
 * Terminal output. The ONLY module that writes to stdout during a turn.
 *
 * Colour is disabled when stdout is not a TTY or NO_COLOR is set, which is what
 * lets the smoke harness assert on plain text.
 */

// LAIN_FORCE_COLOR=1 turns colour on over a pipe, the same way LAIN_FORCE_TUI
// runs the real draw path there: it is how the suite asserts on the COLOURED
// output of the real binary instead of on a stand-in. NO_COLOR still wins, as
// the convention requires.
const useColor = () => (Boolean(process.stdout.isTTY) || process.env.LAIN_FORCE_COLOR === '1')
  && !process.env.NO_COLOR && process.env.LAIN_NO_COLOR !== '1';

// A CREDENTIAL MAY EXIST INSIDE LAIN AND MAY NOT BE DRAWN. `write` below is the
// only linear writer in the program, which is exactly why the filter lives
// there rather than at each of the dozens of callers. See src/redact.js.
const redact = require('./redact');

const MAX_TRANSCRIPT = 400;

/**
 * How many lines of ONE command's output the panel will hold.
 *
 * Bounded like everything else that a session can grow, and generous: the panel
 * scrolls, so this is the length of what can be scrolled THROUGH rather than
 * what fits on the screen. Only MACHINERY commands route here at all; anything
 * about the work keeps the transcript, so this never has to hold a report.
 */
const MAX_SURFACE_LINES = 200;

/**
 * Soft-wrap plain text to a width. `notice`/`providerFailure` build one long
 * sentence from interpolated, unbounded parts (a model count, a provider
 * message) — without this, that sentence is written as a single raw line and
 * overflows a narrow terminal instead of wrapping like everything else drawn
 * on screen.
 */
function wrapPlain(s, width) {
  const words = String(s).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const C = {
  dim: (s) => (useColor() ? `\x1b[2m${s}\x1b[0m` : s),
  /**
   * QUIETER THAN DIM — for work that is FINISHED and has become context.
   *
   * `dim` is already the weight of a tool call, so it cannot also be the weight
   * of an OLDER tool call: with one grey for both, thirty completed operations
   * arrive at exactly the visual force of the one happening now, and the eye has
   * nothing to follow down the pane. An explicit dark grey is a second step down
   * that `\x1b[2m` cannot express, because dim is a flag rather than a scale.
   *
   * 244 is legible on a dark terminal and clearly recedes from `dim`. A terminal
   * without 256 colours degrades it to the nearest grey it has, which is the
   * honest failure mode: quieter, or the same — never louder.
   */
  faint: (s) => (useColor() ? `\x1b[38;5;244m${s}\x1b[39m` : s),
  /**
   * A SUBTLE BACKGROUND, for a region that should read as a separate surface.
   *
   * A 256-colour grey rather than the 8-colour white background, which on most
   * terminals is a glaring block. Applied to a whole row INCLUDING its padding,
   * so a diff reads as a panel rather than as striped text — and the caller
   * writes the foreground INSIDE it, because an inner reset closes the
   * background too (see ui/paint.js on nesting).
   */
  onGray: (s) => (useColor() ? `\x1b[48;5;236m${s}\x1b[49m` : s),
  bold: (s) => (useColor() ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (useColor() ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (useColor() ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (useColor() ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s) => (useColor() ? `\x1b[36m${s}\x1b[0m` : s),
  blue: (s) => (useColor() ? `\x1b[34m${s}\x1b[0m` : s),
  // Reserved for the EXTERNAL model, so "who said this" is answerable at a
  // glance when two models are working on one problem. See ui/paint.js.
  magenta: (s) => (useColor() ? `\x1b[35m${s}\x1b[0m` : s),
  /**
   * CODE BEING WRITTEN RIGHT NOW — the third state a diff line can be in.
   *
   * Removed is red and added-and-settled is green. A line the editor is part
   * way through writing is neither yet, and painting it green claims it is
   * finished when it is not. Bright blue (SGR 94 — NOT the navy SGR 34 this
   * file's `blue` is, which ui/paint.js already rejected as illegible on a dark
   * terminal) belongs to exactly one meaning: THIS TEXT IS APPEARING.
   */
  brightBlue: (s) => (useColor() ? `\x1b[94m${s}\x1b[0m` : s),
  /**
   * STRUCK THROUGH — code being taken out, while it is still on screen.
   *
   * SGR 9, closed with SGR 29 rather than a full reset so it composes inside a
   * background (see `onGray`). A terminal that does not implement it simply
   * shows the text, which is why the RED carries the meaning and this only
   * reinforces it: a removal is red with a rule through it, and red alone is
   * still correct.
   */
  strike: (s) => (useColor() ? `\x1b[9m${s}\x1b[29m` : s),
  /**
   * THE DIFF SURFACE — a light ground the editor writes on.
   *
   * `onGray` (236) is the subtle panel used elsewhere. This is deliberately
   * lighter (240) and is applied to the WHOLE row including its padding, so the
   * diff reads as a separate surface inside the black terminal rather than as a
   * border drawn around more terminal. Closed with SGR 49 — background only —
   * so a foreground colour written inside it survives.
   */
  onSurface: (s) => (useColor()
    // AND IT SURVIVES A FOREGROUND COLOUR INSIDE IT. An inner `\x1b[0m` — which
    // is how every other function in this table closes — resets the BACKGROUND
    // too, so a row with one red word in it lost its surface from that word
    // onwards and the panel came apart down the middle. Every reset inside the
    // row re-opens the ground behind it. See ui/paint.js on nesting.
    ? `\x1b[48;5;240m${String(s).replace(/\x1b\[0m/g, '\x1b[0m\x1b[48;5;240m')}\x1b[49m`
    : s),
};

/**
 * ONE output owner, two strategies.
 *
 * When stdout is a TTY the Screen (src/ui/layout.js) draws the four-region UI.
 * When it is not — a pipe, a test, a log — the linear path below writes plain
 * text. Both consume the SAME pure view functions, so this is one renderer with
 * two output strategies rather than two renderers.
 *
 * The non-TTY path is why `lain -p ... | grep` still behaves like a normal
 * program, and why the whole test suite can assert on readable output.
 */
/** How much of a provider's own error text is worth printing. */
const MAX_PROVIDER_MESSAGE = 200;

function clipMessage(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  // THE SENTENCE A PERSON NEEDS IS INSIDE THE OBJECT, not at the front of it.
  // Clipping the tail off
  //
  //   413 Payload Too Large - {"error": {"message": "Chat history exceeds the
  //   800-message limit; compact the conversation and retry.","type":"payload…
  //
  // still spends the row on braces and field names. A provider that answers
  // in JSON almost always puts the readable part in `message`, so that is
  // what is shown, kept behind whatever preceded the object (the status).
  const body = s.indexOf("{");
  if (body > 0) {
    const said = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s.slice(body));
    if (said && said[1]) {
      const head = s.slice(0, body).replace(/[-–—:,]\s*$/, '').trim();
      const one = said[1].replace(/\\(.)/g, '$1').trim();
      return (head ? head + ' — ' : '') + one;
    }
  }
  return s.length > MAX_PROVIDER_MESSAGE ? s.slice(0, MAX_PROVIDER_MESSAGE) + '…' : s;
}

class Renderer {
  constructor(out = process.stdout) {
    this.out = out;
    this.atLineStart = true;
    this.screen = null;   // set by the App when a TTY UI is active
    /**
     * What commands printed while the TUI owned the screen.
     *
     * In TTY mode stdout belongs to the Screen: writing to it directly painted
     * `/status` tables and model prose straight over the drawn regions, which is
     * exactly the corruption you get from two writers and one terminal. So the
     * linear text is captured here instead and the ACTIVITY view renders it.
     * Bounded — a session cannot grow it without limit.
     */
    this.transcript = [];
    /**
     * ONE COMMAND'S OUTPUT, while it is being collected. Held here rather than
     * pushed straight into the panel so that re-drawing on every line is a
     * `replace` of one adapter instead of a stack of frames.
     */
    this._surfaceLines = [];
    this._surfaceTitle = '';
    this._surfaceOf = null;
    this._surfaceOn = false;
    this._surfaceBusy = false;
  }

  /** Attach the TTY screen. All region drawing then goes through it. */
  attachScreen(screen) { this.screen = screen; return screen; }
  get tui() { return Boolean(this.screen && this.screen.active); }

  /**
   * THE ONE LINEAR DOOR, and therefore the one place a credential is caught.
   *
   * Everything written outside the TUI goes through here — command output,
   * errors, the transcript, a provider's own words about a request it refused.
   * Redacting HERE rather than at each caller is what makes the promise
   * structural: a surface added tomorrow inherits it by writing through the
   * same door, and there is no list of places to remember. See src/redact.js.
   */
  write(s) {
    if (!s) return;
    const safe = redact.text(s);
    if (this.tui) return this.capture(safe);
    this.out.write(safe);
    this.atLineStart = safe.endsWith('\n');
  }

  /**
   * ---- THE TRANSIENT SURFACE ----------------------------------------------
   *
   * While one of these is open, everything written goes to the bottom surface
   * INSTEAD OF the transcript, and therefore never reaches Context.
   *
   * WHY THE ROUTING IS A MODE AND NOT A PER-CALL ARGUMENT. Command bodies write
   * through `render.write` in dozens of places, several of them inside helpers
   * shared with non-command code. Threading a destination through all of that
   * would put the decision in dozens of hands and guarantee that some of them
   * get it wrong. Here, one caller opens the surface, everything the command
   * says lands in it, and the caller closes it — the command bodies do not
   * change and cannot disagree.
   *
   * Off a TTY this does nothing at all: there is no surface on a pipe, and the
   * output goes where it always went.
   */
  openSurface(title, { busy = false } = {}) {
    if (!this.tui || !this.screen.panel) return false;
    // A QUESTION OUTRANKS A NOTICE, ALWAYS. If something is awaiting an answer
    // in the panel, a command's output does not get to replace it — that would
    // resolve somebody's `ask_user` with silence.
    //
    // BUT ANOTHER NOTICE IS NOT A QUESTION. The first version of this refused
    // whenever the panel was visible at all, which meant `/status` straight
    // after `/dash` was silently dropped: the second command found the first
    // command's panel still open and stood down for it. Only a frame with a
    // caller behind it is protected — and an ADVISORY has no caller either, so
    // "it has been doing the same thing for a while" never swallows the output
    // of a command the user ran in response to reading it.
    if (this.screen.panel.visible && !this.screen.panel.isPassive) return false;
    this._surfaceTitle = String(title || '').trim();
    // SAME SUBJECT, SAME BOX. Compaction speaks twice — what it did, then what
    // survived — and starting fresh on the second would clear the first line
    // before anyone read it. A DIFFERENT title is a different thing being shown.
    if (!this._surfaceOn || this._surfaceOf !== this._surfaceTitle) this._surfaceLines = [];
    this._surfaceOf = this._surfaceTitle;
    this._surfaceOn = true;
    this._surfaceBusy = Boolean(busy);
    this._paintSurface();
    return true;
  }

  /**
   * Put the collected lines into the panel — the SAME panel `/` and `/model`
   * open. `replace` rather than `open` once it is already up, so re-drawing on
   * each line does not churn the frame or orphan an awaiting caller.
   */
  _paintSurface() {
    const { outputAdapter } = require('./ui/adapters');
    const lines = this._surfaceLines.slice();
    if (this._surfaceBusy) lines.push('working…');
    const adapter = outputAdapter({ title: this._surfaceTitle, lines });
    if (this.screen.panel.visible) this.screen.panel.replace(adapter);
    else this.screen.panel.open(adapter);   // nobody awaits this; Esc closes it
    this.screen.draw();
  }

  /**
   * The command finished. THE PANEL STAYS OPEN — it is showing what was said,
   * and it closes on Esc like every other panel. Only the ROUTING stops, so the
   * next ordinary write goes back to the transcript.
   */
  doneSurface({ closeAfterMs = 0 } = {}) {
    if (!this._surfaceOn) return;
    this._surfaceOn = false;
    this._surfaceBusy = false;
    // A COMMAND THAT SAID NOTHING LEAVES NOTHING BEHIND. `/exit` and friends
    // produce no output, and an empty box with a title is a worse answer than
    // no box at all.
    const { KIND } = require('./ui/panel');
    const panel = this.screen && this.screen.panel;
    if (!this._surfaceLines.length && panel && panel.visible
        && panel.kind === KIND.OUTPUT) panel.close(null);

    // ---- A RECEIPT CLOSES ITSELF -------------------------------------------
    //
    // Most command output is something you READ — `/dash`, `/status` — and it
    // waits for Esc. A RECEIPT is different: "✓ Model selected — Claude Opus 5"
    // is confirming an action you just took deliberately, you have read it by
    // the time you have read it, and making you press Esc to clear your own
    // confirmation is a keystroke that buys nothing.
    //
    // GUARDED ON IDENTITY, not just on time. In two seconds the user may have
    // opened something else entirely; closing whatever happens to be there
    // would shut a question or another command's output. It closes only if the
    // frame it opened is still the frame on screen.
    if (closeAfterMs > 0 && panel && panel.visible && panel.kind === KIND.OUTPUT) {
      const mine = panel.frame;
      const t = setTimeout(() => {
        if (panel.visible && panel.frame === mine) {
          panel.close(null);
          if (this.screen) this.screen.draw();
        }
      }, closeAfterMs);
      // NEVER HOLDS THE PROCESS OPEN. A pending timer that keeps node alive
      // would make `/exit` hang for the length of a cosmetic animation.
      if (t.unref) t.unref();
    }
    if (this.screen) this.screen.draw();
  }

  /** True while writes are being routed to the panel. */
  get surfaceOpen() { return Boolean(this._surfaceOn); }

  /** Buffer a linear write for the TUI. ANSI is stripped so widths stay true. */
  capture(s) {
    const plain = String(s).replace(/\x1b\[[0-9;]*m/g, '');

    // ---- ROUTED TO THE SURFACE, NOT GLUED INTO CONTEXT ----------------------
    //
    // This is the whole of the fix for "/dash printed an IP address into the
    // conversation and it is still there an hour later". Blank lines are
    // dropped rather than kept: a command that starts with `\n` to separate
    // itself from a prompt is padding for a scrolling terminal, and the surface
    // is a box with a title rule that already does that job.
    if (this._surfaceOn && this.screen) {
      for (const line of plain.split('\n')) {
        if (line.trim()) this._surfaceLines.push(line);
      }
      if (this._surfaceLines.length > MAX_SURFACE_LINES) {
        this._surfaceLines.splice(0, this._surfaceLines.length - MAX_SURFACE_LINES);
      }
      this.atLineStart = true;
      this._lineDone = true;
      this._paintSurface();
      return;
    }

    const parts = plain.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && this.transcript.length && !this._lineDone) {
        this.transcript[this.transcript.length - 1] += parts[i];
      } else if (parts[i] !== '' || i < parts.length - 1) {
        this.transcript.push(parts[i]);
      }
    }
    this._lineDone = plain.endsWith('\n');
    if (this.transcript.length > MAX_TRANSCRIPT) {
      this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    }
    this.atLineStart = true;
    if (this.screen) this.screen.draw();
  }

  nl() { if (!this.atLineStart) this.write('\n'); }

  /**
   * Model prose, streamed as it arrives.
   *
   * Dropped in TUI mode: the ACTIVITY view already renders the turn's text from
   * the record, and streaming it to stdout as well would both duplicate it and
   * overwrite the screen.
   */
  text(chunk) { if (!this.tui) this.write(chunk); }

  toolStart(name, input) {
    if (this.tui) return;            // ACTIVITY shows the live call instead
    this.nl();
    const arg = summarizeInput(name, input);
    this.write(C.cyan(`  · ${name}`) + (arg ? C.dim(` ${arg}`) : '') + '\n');
  }

  toolResult(name, output, isError) {
    if (this.tui) return;            // ACTIVITY shows the outcome instead
    const text = String(output == null ? '' : output);
    const lines = text.split('\n');
    const shown = lines.slice(0, 8);
    const prefix = isError ? C.red('    ! ') : C.dim('    ');
    for (const l of shown) this.write(prefix + l.slice(0, 200) + '\n');
    if (lines.length > shown.length) {
      this.write(C.dim(`    … ${lines.length - shown.length} more line(s)\n`));
    }
  }

  /** Terminal width for wrapping, honouring COLUMNS the same way the Screen does. */
  get width() {
    return Math.max(20, (this.out.columns || Number(process.env.COLUMNS) || 80) - 2);
  }

  notice(level, message) {
    this.nl();
    const paint = level === 'error' ? C.red : level === 'warn' ? C.yellow : C.dim;
    for (const l of wrapPlain(message, this.width)) this.write(paint(`  ${l}`) + '\n');
  }

  /**
   * A PROVIDER'S OWN WORDS, CLIPPED TO ONE SENTENCE.
   *
   * Some answer a refusal with a whole JSON object, and it was printed whole:
   *
   *   Provider omniroute is not answering: 413 Payload Too Large - {"error":
   *   {"message": "Chat history exceeds the 800-message limit; compact the
   *   conversation and retry.","type":"payload_too_large","code":"chat_history
   *   _too_large","reason":"message_limit"}}
   *
   * — four wrapped lines of braces in which the one useful sentence is buried.
   * The classification is drawn separately by Context, in LAIN's own words
   * (see ui/status.failureRow); this is the provider speaking, and it gets one
   * line to do it in.
   */
  providerFailure(f) {
    this.nl();
    f = { ...f, message: clipMessage(f && f.message) };
    if (f.skipped) {
      // The breaker held: no socket was opened. Say so, and name the way out —
      // otherwise "nothing happened" is indistinguishable from a hang.
      for (const l of wrapPlain(`${f.connectionId || f.provider} is ${f.kind}: ${f.message}`, this.width)) {
        this.write(C.yellow(`  ${l}`) + '\n');
      }
      for (const l of wrapPlain(`No request was sent. ${f.hint || ''}`, this.width)) {
        this.write(C.dim(`  ${l}`) + '\n');
      }
    } else {
      for (const l of wrapPlain(`Provider ${f.provider} is not answering: ${f.message}`, this.width)) {
        this.write(C.yellow(`  ${l}`) + '\n');
      }
      for (const l of wrapPlain('Your session is intact. Try again, or switch provider. The prompt is yours.', this.width)) {
        this.write(C.dim(`  ${l}`) + '\n');
      }
    }
  }

  turnSummary(record) {
    if (this.tui) return;            // the header carries these numbers live
    this.nl();
    const bits = [];
    if (record.toolCalls) bits.push(`${record.toolCalls} tool call${record.toolCalls === 1 ? '' : 's'}`);
    if (record.mutations.length) bits.push(`${record.mutations.length} file${record.mutations.length === 1 ? '' : 's'} changed`);
    const u = record.usage;
    if (u.inputTokens || u.outputTokens) bits.push(`↑${u.inputTokens} ↓${u.outputTokens}`);
    if (record.stopReason && record.stopReason !== 'end') bits.push(`stopped: ${record.stopReason}`);
    if (bits.length) this.write(C.dim(`  ${bits.join(' · ')}`) + '\n');
  }
}

function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return String(input.command).replace(/\s+/g, ' ').slice(0, 120);
  if (input.path) {
    const range = input.offset ? `:${input.offset}${input.limit ? `-${input.offset + input.limit - 1}` : ''}` : '';
    return String(input.path) + range;
  }
  const keys = Object.keys(input);
  return keys.length ? `{${keys.slice(0, 3).join(', ')}}` : '';
}

module.exports = { Renderer, C, summarizeInput };
