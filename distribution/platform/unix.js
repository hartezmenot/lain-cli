'use strict';

/**
 * LINUX AND macOS — the launcher and the shell profile.
 *
 * ------------------------------------------------------------------------
 * THERE IS NO PERSISTENT PATH ON UNIX. There is a shell that reads a file.
 *
 * Windows has a real place to put this — a user environment variable the OS
 * hands to every new process. Unix does not: PATH is assembled by whichever
 * shell starts, from whichever startup file that shell reads. So "persist a
 * PATH entry" means "append a line to the right file", and the whole difficulty
 * is which file.
 *
 * The choice below follows $SHELL, and falls back to `~/.profile` — which
 * bash, dash and sh all read for a login shell, and which is the least
 * surprising thing to have edited when somebody goes looking.
 *
 * ------------------------------------------------------------------------
 * A MARKED BLOCK, SO IT CAN BE FOUND AND REMOVED.
 *
 * The line is written between two markers. That is what makes the operation
 * idempotent (re-running the installer finds its own block instead of adding a
 * second one) and what makes uninstall possible without a text search that
 * could match something the user wrote themselves.
 *
 * NOTHING IS EVER REWRITTEN. The block is appended, or replaced in place; the
 * rest of the file is passed through byte for byte. A profile is a file people
 * have spent years on.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Spelled out so no shell transport can eat the escape. */
const NEWLINE = String.fromCharCode(10);

const BEGIN = '# >>> LAIN Harness >>>';
const END = '# <<< LAIN Harness <<<';

/**
 * WHICH FILE THIS SHELL ACTUALLY READS.
 *
 * zsh reads `.zshrc`; bash reads `.bashrc` for an interactive non-login shell
 * and `.bash_profile`/`.profile` for a login one. `.profile` is the common
 * denominator and the fallback, because a PATH entry that only some of a
 * person's shells can see is worse than one they were told to add by hand.
 */
function profileFile(homeDir = os.homedir(), shell = process.env.SHELL || '') {
  const name = path.basename(String(shell));
  if (name === 'zsh') return path.join(homeDir, '.zshrc');
  if (name === 'bash') {
    const rc = path.join(homeDir, '.bashrc');
    if (fs.existsSync(rc)) return rc;
    const bp = path.join(homeDir, '.bash_profile');
    if (fs.existsSync(bp)) return bp;
  }
  if (name === 'fish') return path.join(homeDir, '.config', 'fish', 'config.fish');
  return path.join(homeDir, '.profile');
}

function blockFor(dir, file) {
  const line = path.basename(String(file)) === 'config.fish'
    ? `fish_add_path "${dir}"`
    : `export PATH="${dir}:$PATH"`;
  return `${BEGIN}\n${line}\n${END}\n`;
}

/**
 * The PATH adapter pathenv.js drives.
 *
 * `get()` returns the PATH VALUE THIS BLOCK CONTRIBUTES, not the whole
 * environment — pathenv only ever asks "is my directory in there" and "append
 * mine". Reporting the live PATH here would make `set()` write the entire
 * merged environment into a profile, which is the Windows `setx` mistake in a
 * different costume.
 */
function envFor(homeDir = os.homedir(), shell = process.env.SHELL || '') {
  const file = profileFile(homeDir, shell);
  return {
    sep: ':',
    file,
    get() {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
      const from = text.indexOf(BEGIN);
      if (from < 0) return '';
      const to = text.indexOf(END, from);
      const block = text.slice(from, to < 0 ? undefined : to);
      const m = /(?:export PATH="|fish_add_path ")([^":]+)/.exec(block);
      return m ? m[1] : '';
    },
    set(value) {
      // pathenv hands back "<existing>:<new>"; only the LAST entry is ours to
      // write, and writing the whole string would drag the caller's other
      // entries into a file that has no business holding them.
      const dir = String(value).split(':').filter(Boolean).pop() || '';
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
      const from = text.indexOf(BEGIN);
      const endAt = from >= 0 ? text.indexOf(END, from) : -1;
      const stop = from < 0 ? -1 : (endAt < 0 ? text.length : endAt + END.length + 1);
      // ---- AN EMPTY VALUE MEANS UNSET, AND ON UNIX THAT MEANS REMOVE THE BLOCK
      //
      // `pathenv.remove` filters the entry out and hands back what is left —
      // which, since this adapter only ever holds ONE entry, is the empty
      // string. Writing that literally produced `export PATH=":$PATH"` and left
      // the block in the file, so the uninstaller reported success over a
      // profile that still had LAIN in it. Caught by the removal test on its
      // first run. The adapter owns how this platform STORES the entry, so it
      // owns how the entry is taken away.
      let next;
      if (!dir) {
        next = from >= 0 ? text.slice(0, from) + text.slice(stop) : text;
      } else if (from >= 0) {
        next = text.slice(0, from) + blockFor(dir, file) + text.slice(stop);
      } else {
        next = text + (text && !text.endsWith(NEWLINE) ? NEWLINE : '') + blockFor(dir, file);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next, 'utf8');
    },
    manual(dir) { return `echo 'export PATH="${dir}:$PATH"' >> ${file}`; },
  };
}

/** How Unix asks "where is this command?" */
function whichCommand(name) { return ['/bin/sh', ['-c', `command -v ${name}`]]; }

/**
 * ONE LAUNCHER, and `exec` rather than a plain call.
 *
 * `exec` replaces the shell process instead of leaving it waiting, so signals
 * reach node directly and the exit code is node's own. A wrapper that forks
 * swallows Ctrl+C, which for an interactive REPL is not a subtlety.
 */
function shims(target, nodeExe = 'node') {
  return {
    lain: [
      '#!/bin/sh',
      '# LAIN Harness launcher. Generated by distribution/install.js — edits are lost on reinstall.',
      `exec ${nodeExe === 'node' ? 'node' : `"${nodeExe}"`} "${target}" "$@"`,
      '',
    ].join('\n'),
  };
}

const executable = ['lain'];

function defaultBin(home) { return path.join(home, 'bin'); }

module.exports = { env: envFor(), envFor, shims, executable, defaultBin, whichCommand, profileFile, BEGIN, END, blockFor };
