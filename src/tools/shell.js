'use strict';

/**
 * SHELL. Deliberately unrestricted.
 *
 * There is no command classifier standing between the model and the machine,
 * and no "is this command safe" heuristic. The model may run git, curl, npm,
 * pytest, Get-Process, a project's own scripts — anything the user's own shell
 * would run. LAIN's job is to execute it faithfully and report exactly what
 * happened.
 *
 * V1 additionally REWROTE the model's shell command into a different tool on
 * Windows (`cat x` -> read_file). That silently broke `cat x | head -20`, whose
 * whole pipeline became a filename. V2 does not touch the command string. If the
 * model wants a shell, it gets a shell.
 *
 * Three explicit tools rather than one `run_shell` with a mode flag, because the
 * model choosing PowerShell should be a different call from the model choosing
 * bash — not a parameter it can get wrong silently.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A RESTRICTION. Which interpreter ran the
 * command, which directory it ran in, and what KIND of failure came back are now
 * stated on the result by execution.js. None of that alters what runs. It ends
 * the loop where a model re-runs one command under three shells to discover a
 * fact the machine had before the first attempt — see execution.js.
 */

const { spawn } = require('child_process');
const { via, KIND } = require('./via');
const execution = require('../execution');
const attemptsMod = require('../attempts');

const MAX_OUTPUT = 100_000; // characters returned to the model

/**
 * HOW LONG A FOREGROUND COMMAND MAY RUN — was two minutes, and two minutes is
 * shorter than a great many ordinary commands.
 *
 * Reported from real use as work being cut off at 120s. A test suite, an
 * install, a build, a container pull: all of them routinely pass two minutes on
 * a real project, and every one of them was being KILLED and handed back as a
 * failure. The model then has to guess whether the command was wrong, and the
 * usual guess is to try it again.
 *
 * Ten minutes, and overridable per call with `timeout_ms` and per machine with
 * LAIN_SHELL_TIMEOUT_MS. It is still bounded, because a FOREGROUND command
 * holds the turn: something that runs longer than this is not a command to wait
 * on, it is a job — which is what `run_background` is for, and which the
 * timeout message now says. See execution.js CLASS.TIMED_OUT for that sentence
 * and why it had to exist.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.LAIN_SHELL_TIMEOUT_MS) || 600_000;

/**
 * SHELL IDENTITY LIVES IN execution.js — one definition, shared by the
 * foreground tools here, background jobs, and the environment summary in the
 * system prompt. These are re-exported rather than reimplemented so that every
 * caller resolves the same bash and spawns with the same prefix.
 */
const { findBash, isWslShim, shellPrefix } = execution;

/**
 * End a command AND whatever it started.
 *
 * `child.kill()` ends the shell; the thing the shell launched is a grandchild
 * that inherits the pipes and keeps running. On Windows `taskkill /T` walks the
 * tree; elsewhere the child leads its own process group, so one signal to the
 * negative pid reaches all of it. Both are best-effort by nature — a process
 * can always be unkillable — which is why the caller never waits on this.
 */
function killTree(child) {
  if (!child || child.killed || child.exitCode != null) { try { child.kill(); } catch { /* gone */ } return; }
  const pid = child.pid;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => { try { child.kill(); } catch { /* gone */ } });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { try { child.kill(); } catch { /* gone */ } }
}

function run(command, { shell, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
  return new Promise((resolve) => {
    // ALREADY CANCELLED. `addEventListener('abort')` never fires on a signal
    // that has already fired, so without this an interrupt arriving between the
    // model's tool call and the spawn started a process nobody was waiting for
    // and then waited for it anyway.
    if (signal && signal.aborted) {
      return resolve({ output: '[interrupted by the user]', isError: true, exitCode: null, interrupted: true });
    }
    const [file, prefix] = shellPrefix(shell);
    const args = [...prefix, command];

    let child;
    try {
      // `detached` on POSIX makes the child lead its own process group, which is
      // what lets one signal reach everything it started. It is NOT unref'd —
      // the child stays attached to this process's lifetime.
      child = spawn(file, args, { cwd, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      return resolve({
        output: `could not start ${shell} (${file}): ${e.message}`,
        isError: true, exitCode: null, startFailed: true, stderr: e.message,
      });
    }

    let out = '';
    // stderr is ALSO kept on its own, while the merged stream stays exactly as
    // it was for display. Classification reads stderr only: a shell reports its
    // parse errors there, and a test suite prints its failures to stdout, so
    // judging the merged stream would classify a failing test as a shell fault.
    let err = '';
    let truncated = false;
    const append = (buf) => {
      if (truncated) return;
      out += buf.toString('utf8');
      if (out.length > MAX_OUTPUT) { out = out.slice(0, MAX_OUTPUT); truncated = true; }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', (buf) => {
      append(buf);
      if (err.length < MAX_OUTPUT) err += buf.toString('utf8');
    });

    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

    /**
     * CTRL+C MUST LAND NOW.
     *
     * Two separate problems, both measured by pressing Ctrl+C during
     * `run_bash sleep 30` and watching the screen:
     *
     *   1. `child.kill()` kills the SHELL, not what the shell started. The
     *      grandchild inherits the pipes, so `close` does not fire until it
     *      finishes on its own — the screen sat on "Interrupting…" for the
     *      remaining 24 seconds. `killTree` ends the whole group.
     *   2. Even a clean kill is a race we do not need to win. The user has
     *      already said stop, so the result is settled HERE rather than waiting
     *      for the process to be reaped. A grandchild that somehow survives can
     *      no longer hold the interface hostage.
     */
    const onAbort = () => {
      killTree(child);
      finish({ output: '[interrupted by the user]', isError: true, exitCode: null, interrupted: true });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      // Naming the executable turns "bash failed" into something the model can
      // actually route around — it can see that the shell itself is missing and
      // reach for run_powershell or run_cmd instead of retrying the command.
      finish({
        output: `could not start ${shell} (${file}): ${e.message}`,
        isError: true, exitCode: null, startFailed: true, stderr: e.message,
      });
    });

    child.on('close', (code) => {
      const parts = [];
      // WHICH MECHANISM RAN THIS, AND WHERE. The vocabulary for the stamp lives
      // in via.js because three tools say it and two of them used to spell it
      // differently; the shell-and-directory detail comes from execution.js for
      // the same reason.
      parts.push(via(KIND.SHELL, execution.contextLine({ shell, cwd })));
      if (out) parts.push(truncated ? out + '\n[output truncated]' : out);
      if (timedOut) parts.push(`[timed out after ${Math.round(timeoutMs / 1000)}s]`);
      if (code !== 0 && code !== null) parts.push(`[exit ${code}]`);
      finish({
        output: parts.join('\n') || '[no output]',
        isError: code !== 0 || timedOut,
        exitCode: code,
        timedOut,
        stderr: err,
      });
    });
  });
}

const SHELLS = [
  ['run_bash', 'bash', 'Run a command with bash/sh.'],
  ['run_powershell', 'powershell', 'Run a command with PowerShell.'],
  ['run_cmd', 'cmd', 'Run a command with cmd.exe (Windows).'],
];

/**
 * WHERE DOES THIS RUN — asked once per call, answered explicitly.
 *
 * `cwd` is a parameter rather than something the model arranges with `cd`,
 * because `cd` inside a shell command changes the directory of a process that
 * exits one line later. A model that wants a command to run in `tests/` and
 * writes `cd tests && node run.js` has taken on the shell's separator rules, its
 * quoting and its error handling to express one fact the spawn already accepts
 * as an argument. The session's own directory is never mutated by this.
 */
function resolveCwd(ctx, input) {
  const base = ctx.cwd || process.cwd();
  const want = input && input.cwd ? String(input.cwd).trim() : '';
  if (!want) return { cwd: base };
  const path = require('path');
  const abs = path.isAbsolute(want) ? want : path.resolve(base, want);
  try {
    if (!require('fs').statSync(abs).isDirectory()) return { error: `cwd is not a directory: ${want}` };
  } catch { return { error: `no such directory for cwd: ${want} (resolved to ${abs})` }; }
  return { cwd: abs };
}

const tools = {};
for (const [name, shell, desc] of SHELLS) {
  tools[name] = {
    mutates: true, // a shell command can do anything; treat it as mutating
    schema: {
      name,
      description: `${desc} No command restrictions. Returns combined stdout+stderr, the exit code, and — `
        + 'when it fails — what KIND of failure it was and the fact about this shell that explains it. '
        + 'Pass `cwd` to run somewhere else instead of writing a `cd` into the command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'the command line to execute' },
          cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
          timeout_ms: {
            type: 'number',
            description: 'optional timeout in milliseconds. The default is generous; if the command is '
              + 'genuinely long-running, prefer run_background over raising this, so the turn is not held',
          },
        },
        required: ['command'],
      },
    },
    async run(input, ctx) {
      const command = String((input && input.command) || '').trim();
      if (!command) return { output: 'no command given', isError: true };
      const where = resolveCwd(ctx, input);
      if (where.error) return { output: where.error, isError: true };

      const r = await run(command, {
        shell,
        cwd: where.cwd,
        timeoutMs: Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
      });

      // An interrupt is the user's decision, not a failure of the command, and
      // annotating it would put a CLASSIFICATION on something nobody ran.
      if (r.interrupted) return r;

      const { text, verdict } = execution.annotate(
        { ...r, shell, cwd: where.cwd, command },
        { attempts: attemptsMod.forSession(ctx.session) },
      );
      // ---- THE ONE PLACE A REAL TEST RESULT EXISTS ------------------------
      //
      // "Is it done?" asked from a phone deserves an answer with evidence under
      // it, and the only evidence LAIN ever holds is a runner stating its own
      // counts. This is where that text is, so this is where it is reported —
      // to the runtime, which keeps it, so a SECOND window can see a result
      // this process observed.
      //
      // `seen` IS THE WHOLE GUARD. testing.counts sets it only when a real
      // summary line was parsed; a build log with the word "passed" in it, or a
      // command that is not a test run at all, sets nothing and reports nothing.
      // Inventing a `0 passed` for every shell command would be worse than
      // silence, because a screen would then show it.
      try { noteVerified(ctx, command, r.output); } catch { /* never fail a tool over telemetry */ }
      return {
        ...r,
        output: execution.leadWith(r.output, text),
        meta: { ...(r.meta || {}), shell, cwd: where.cwd, classification: verdict.class },
      };
    },
  };
}

/**
 * A TEST RUN THAT STATED ITS OWN NUMBERS, reported to the runtime.
 *
 * Extracted rather than inlined so it can be tested directly, and so the tool
 * path reads as one line. Reports NOTHING unless the runner actually printed a
 * summary — see `seen` in testing.js — because a fabricated zero on a status
 * screen is worse than a screen that says nothing was checked.
 */
function noteVerified(ctx, command, output) {
  const session = ctx && ctx.session;
  if (!session || !session.id) return false;
  const c = require('../testing').counts(output);
  if (!c || !c.seen) return false;
  require('../guardian').verified(session.id, {
    label: String(command).slice(0, 60),
    passed: c.passed,
    failed: c.failed,
    detail: c.skipped ? `${c.skipped} skipped` : '',
  });
  return true;
}

module.exports = { tools, run, findBash, isWslShim, shellPrefix, resolveCwd, noteVerified, MAX_OUTPUT };
