'use strict';

/**
 * THE ATTEMPT LEDGER — what this command has already done, here, today.
 *
 * A model cannot see its own loop. Each tool result arrives on its own, the
 * failure looks fresh every time, and the fourth identical attempt reads exactly
 * like the first. The transcript holds the history, but reading four thousand
 * tokens back to notice "I have run this twice already" is precisely the work
 * that does not happen.
 *
 * So the harness keeps the count. This is a small, per-session record of every
 * command that has been executed, keyed by the command itself, holding which
 * shell ran it, in which directory, and how it was classified. When a command
 * that has failed before comes round again, the result carries what happened
 * last time.
 *
 * THE MEASUREMENT THAT MATTERS MOST is whether the CLASSIFICATION changed. Three
 * attempts at one command across three shells, all classified
 * COMMAND_NOT_FOUND, is proof that the shell was never the cause — the program
 * is not installed, and no fourth shell will find it. That is a conclusion the
 * machine can reach with a string comparison and a model reaches by spending a
 * request on it.
 *
 * IT NEVER REFUSES. Nothing here blocks a call, and nothing phrases itself as a
 * prohibition; repeating a command is often exactly right — after an install,
 * after an edit, after a service starts. The ledger reports what is on the
 * record and the model decides what that means, which is the same contract the
 * evidence ledger has.
 */

/** Enough to cover a long turn; old entries fall off the front. */
const MAX_COMMANDS = 60;
const MAX_ATTEMPTS_PER_COMMAND = 8;

/**
 * The key a command is remembered by.
 *
 * Whitespace is collapsed so that a re-typed command with different spacing is
 * recognised as the same command — which it is. Nothing else is normalised:
 * case matters on a POSIX filesystem, and quoting differences are real
 * differences.
 */
function keyOf(command) {
  return String(command == null ? '' : command).trim().replace(/\s+/g, ' ');
}

/** How long ago, in words a person and a model both read the same way. */
function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

class AttemptLog {
  constructor({ now = () => Date.now() } = {}) {
    /** @type {Map<string, Array<object>>} command → attempts, oldest first */
    this.byCommand = new Map();
    this._now = now;
  }

  /**
   * Put one finished execution on the record.
   *
   * Successes are recorded too, and that is not waste: "this exact command
   * succeeded four minutes ago in this directory" is the fact that makes a
   * re-run either redundant or deliberate, and only the record can tell them
   * apart.
   */
  record({ command, shell = '', cwd = '', classification = '', exitCode = null } = {}) {
    const key = keyOf(command);
    if (!key) return;
    let list = this.byCommand.get(key);
    if (!list) {
      list = [];
      this.byCommand.set(key, list);
      // Oldest command out first. A Map preserves insertion order, so the first
      // key is the least recently STARTED — good enough, and it cannot grow.
      if (this.byCommand.size > MAX_COMMANDS) {
        this.byCommand.delete(this.byCommand.keys().next().value);
      }
    }
    list.push({ shell, cwd, classification, exitCode, at: this._now() });
    if (list.length > MAX_ATTEMPTS_PER_COMMAND) list.shift();
  }

  /** Everything already known about this command, oldest first. */
  priorFor(command) {
    return this.byCommand.get(keyOf(command)) || [];
  }

  /**
   * WHAT THE RECORD SAYS about a command that has just failed again.
   *
   * `current` is THE ATTEMPT THAT JUST HAPPENED, and passing it in is the
   * difference between a useful note and a note that is always one attempt
   * behind. Asked without it, the third attempt — the first one under a second
   * shell — could only see two PowerShell failures and reported "nothing about
   * the failure changed", when the fact worth having was that the shell had
   * just been changed and the classification had not. The numbered list is
   * still history only; the conclusions are drawn over history PLUS now.
   *
   * @returns {string} '' when there is nothing on the record worth saying
   */
  note({ command, shell = '', cwd = '', current = null } = {}) {
    const prior = this.priorFor(command);
    if (!prior.length) return '';
    const past = prior.filter((a) => a.classification && a.classification !== 'OK');
    if (!past.length) {
      const ok = prior[prior.length - 1];
      return `[ALREADY RUN: this exact command SUCCEEDED ${ago(this._now() - ok.at)}`
        + `${ok.shell ? ` under ${ok.shell}` : ''}${ok.cwd && ok.cwd !== cwd ? ` in ${ok.cwd}` : ''}.]`;
    }

    const lines = [`ATTEMPT ${prior.length + 1} of this command. Previously:`];
    for (let i = 0; i < past.length; i++) {
      const a = past[i];
      const where = [a.shell ? `shell=${a.shell}` : null, a.cwd && a.cwd !== cwd ? `cwd=${a.cwd}` : null]
        .filter(Boolean).join(' ');
      lines.push(` ${i + 1}. ${a.classification}${a.exitCode != null ? ` (exit ${a.exitCode})` : ''}`
        + `${where ? ` — ${where}` : ''}, ${ago(this._now() - a.at)}`);
    }

    // ---- THE CONCLUSION THE HISTORY SUPPORTS ------------------------------
    //
    // Stated only when the record actually establishes it. Failures that all
    // read the same across two or more shells is not a hint — it is a
    // measurement, and it eliminates the shell as the cause outright.
    const all = current && current.classification && current.classification !== 'OK'
      ? [...past, { ...current, shell: current.shell || shell, cwd: current.cwd || cwd }]
      : past;
    const classes = new Set(all.map((a) => a.classification));
    const shells = new Set(all.map((a) => a.shell).filter(Boolean));
    if (classes.size === 1 && shells.size > 1) {
      lines.push(`All ${all.length} failed the same way (${[...classes][0]}) under ${shells.size} different shells, `
        + 'so the shell is not the difference.');
    } else if (classes.size === 1 && all.length > 1) {
      lines.push(`All ${all.length} failed the same way (${[...classes][0]}); nothing about the failure changed.`);
    }
    const dirs = new Set(all.map((a) => a.cwd).filter(Boolean));
    if (dirs.size > 1) lines.push(`It has been run from ${dirs.size} different directories.`);
    return `[${lines.join('\n ')}]`;
  }

  /** Everything on the record, newest command last. For reports and tests. */
  history() {
    const out = [];
    for (const [command, attempts] of this.byCommand) out.push({ command, attempts: [...attempts] });
    return out;
  }

  /**
   * The commands that failed more than once and never succeeded — the shape of
   * a loop, in one list. Used by the turn summary so a session that burned four
   * requests on one command says so.
   */
  loops() {
    const out = [];
    for (const [command, attempts] of this.byCommand) {
      const failed = attempts.filter((a) => a.classification && a.classification !== 'OK');
      if (failed.length < 2) continue;
      if (attempts.some((a) => a.classification === 'OK')) continue;
      out.push({
        command,
        attempts: failed.length,
        classifications: [...new Set(failed.map((a) => a.classification))],
        shells: [...new Set(failed.map((a) => a.shell).filter(Boolean))],
      });
    }
    return out;
  }
}

/**
 * The ledger for a session, created on first use.
 *
 * Hung off the session rather than held at module scope: two sessions in one
 * process must not share a command history, and module-level session state is
 * exactly what the architecture guard forbids.
 */
function forSession(session) {
  if (!session) return null;
  if (!session.attempts) session.attempts = new AttemptLog();
  return session.attempts;
}

module.exports = { AttemptLog, forSession, keyOf, MAX_COMMANDS, MAX_ATTEMPTS_PER_COMMAND };
