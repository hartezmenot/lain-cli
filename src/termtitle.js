'use strict';

/**
 * THE TERMINAL TAB TITLE.
 *
 * A terminal running LAIN is titled by the SHELL — "Windows PowerShell",
 * "pwsh", "bash" — which is the same string in every window, so a row of them
 * is unreadable the moment more than one project is open. This names the tab
 * after the WORK:
 *
 *   scalppbot
 *   ● scalppbot — fix the telegram signal toggle     (● = a turn is running)
 *
 * The PROJECT leads, not the product. A user with four terminals open wants to
 * know which project each one is; that none of them is Notepad is not news, and
 * a hardcoded "LAIN:" prefix on all four spends the readable part of a tab
 * saying the same word four times.
 *
 * MECHANICS. OSC 0 sets the icon name AND the window title, OSC 2 sets the
 * window title only. Both are sent, because terminals disagree about which one
 * a TAB reads — Windows Terminal follows OSC 0/2 on the active pane, most
 * xterm-alikes read OSC 2. The terminator is BEL rather than ST: it is the form
 * every terminal in circulation accepts. Neither sequence moves the cursor or
 * consumes a cell, so writing one mid-frame cannot disturb the drawn UI.
 *
 * This is a side effect on someone else's window, so it is written only to a
 * real TTY, never under a dumb TERM, and `restore()` hands the tab back on the
 * way out. Nothing here throws: a terminal that ignores the sequence prints
 * nothing, and a stdout that rejects the write is not worth ending a session
 * over.
 *
 * Ported from V1, which had this right. The behaviour is recovered; the
 * hardcoded product prefix is not.
 */

let installed = false;
let last = '';
let writer = null;

/** Let the terminal UI route OSC around its own stdout capture layer. */
function setWriter(fn = null) { writer = typeof fn === 'function' ? fn : null; }

function write(s) {
  const out = writer || ((text) => process.stdout.write(text));
  out(s);
}

function enabled() {
  // LAIN_FORCE_TUI runs the real draw path over a pipe so the suite can assert
  // on what the real binary actually emits. The title is part of that: without
  // this, the one thing a test could check about it was that a pure function
  // composed a string, which is not the same as the bytes reaching a terminal.
  if (!process.stdout || (!process.stdout.isTTY && process.env.LAIN_FORCE_TUI !== '1')) return false;
  if (process.env.LAIN_NO_TITLE) return false;
  if (String(process.env.TERM || '').toLowerCase() === 'dumb') return false;
  return true;
}

/** Collapse whitespace, drop control characters, clip to a tab's worth. */
function clean(s, max = 72) {
  const t = String(s == null ? '' : s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Compose the title from the parts that identify a session.
 *
 *   LAIN                     no project open
 *   LAIN — scalpbot          idle in a project
 *   ● LAIN — scalpbot        a turn is running
 *
 * THE PRODUCT NAME LEADS, at the user's explicit instruction. This module
 * originally argued the opposite — that four tabs all saying "LAIN" spends the
 * readable part of a tab on something the user already knows — and dropped the
 * prefix V1 had. Asked for twice, and it is their taskbar: what a row of tabs
 * should say is a preference, not a correctness question, and the person
 * looking at them gets to decide. The project still follows immediately, so the
 * distinguishing part survives the truncation every terminal does.
 */
function compose({ folder = '', topic = '', busy = false } = {}) {
  const name = clean(folder, 28);
  const head = name ? `LAIN — ${name}` : 'LAIN';
  const tail = topic ? ` — ${clean(topic, 40)}` : '';
  return (busy ? '● ' : '') + head + tail;
}

/** Write a title. Identical repeats are dropped — this runs on every redraw. */
function set(text) {
  const title = clean(text, 100);
  if (!title || title === last) return false;
  if (!enabled()) { last = title; return false; }
  try {
    write(`\x1b]0;${title}\x07\x1b]2;${title}\x07`);
    installed = true;
    last = title;
    return true;
  } catch { return false; }
}

/** compose + set. */
function update(parts) { return set(compose(parts)); }

/**
 * Hand the tab back.
 *
 * There is no reliable "restore the previous title" sequence — XTPOPTITLE is
 * not universal, and pushing a title we never popped leaks stack entries — so
 * the honest close is to clear ours and let the shell re-title on its next
 * prompt.
 */
function restore() {
  if (!installed) return false;
  try {
    write('\x1b]0;\x07\x1b]2;\x07');
    installed = false;
    last = '';
    return true;
  } catch { return false; }
}

module.exports = { set, update, compose, clean, restore, enabled, setWriter };
