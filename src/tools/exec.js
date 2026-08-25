'use strict';

/**
 * PYTHON AND PROGRAMS — execution that is not "a shell command in disguise".
 *
 * `run_bash "python x.py"` works, and it is a lie about what happened. What
 * actually ran was a SHELL, which parsed the line, applied its own quoting
 * rules, and returned ITS exit code. The differences are not academic:
 *
 *   · a path with a space needs shell quoting that varies by shell, and gets
 *     it wrong differently on cmd, PowerShell and bash
 *   · `powershell -Command` flattens a non-zero exit to 1, so `sys.exit(3)`
 *     comes back as 3 from cmd and 1 from PowerShell — measured, on this
 *     machine, earlier in this session
 *   · the pid you get is the SHELL's, so nothing can be observed or killed
 *   · a missing interpreter reads as a shell error about a command not found,
 *     rather than "there is no Python here"
 *
 * So these spawn the program DIRECTLY — no shell, argv as an array, no quoting
 * to get wrong — and report what actually ran: the resolved binary, the real
 * pid, the true exit code, stdout and stderr kept apart.
 *
 * WHAT THIS IS NOT. It is not a sandbox and does not pretend to be: a program
 * run here can do anything the user can do, exactly like `run_bash`. The gain
 * is HONESTY and OBSERVABILITY, not containment.
 *
 * PYTHON IS NOT REQUIRED. Nothing in LAIN's editing path touches it. It is
 * here because OCR, image measurement and computer vision genuinely live in
 * Python, and a coding agent that cannot run the project's own scripts is
 * missing a limb. With no interpreter configured or found, `python_run` says
 * NOT CONFIGURED and names what to do — it never silently falls back to a
 * shell, which would put the confusion back.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const jobsMod = require('../jobs');

/** Enough output to diagnose; never unbounded. */
const MAX_OUTPUT = 200_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * WHICH PYTHON, and where it came from.
 *
 * The configured one wins, because a machine with three Pythons has one that
 * has the project's packages in it. `probe.python` is reused deliberately: the
 * user already told LAIN where a working 3.11 is, and asking twice for the same
 * fact is how two answers to one question come to exist.
 */
function findPython(cfg = {}) {
  const tried = [];
  const configured = (cfg.python && cfg.python.exe)
    || (cfg.probe && cfg.probe.python)
    || process.env.LAIN_PYTHON;
  if (configured) {
    tried.push(configured);
    if (exists(configured)) return { ok: true, exe: configured, source: 'config', tried };
  }
  for (const name of ['python3', 'python', 'py']) {
    tried.push(name);
    // A bare name resolves through PATH at spawn time; `where`/`which` here
    // would be a second resolution free to disagree with the first.
    if (onPath(name)) return { ok: true, exe: name, source: 'PATH', tried };
  }
  return {
    ok: false,
    tried,
    why: 'no Python was found. Set "python": { "exe": "<path>" } in the config, or put one on PATH.',
  };
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/** Is `name` runnable from PATH? Resolved once, the way spawn will resolve it. */
function onPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const d of dirs) {
    for (const e of exts) {
      if (exists(path.join(d, name + e))) return true;
    }
  }
  return false;
}

/**
 * Run a program directly and collect everything about it.
 *
 * stdout and stderr are kept APART, unlike the shell tools, because a Python
 * script's traceback is on stderr and its answer is on stdout — merging them is
 * how a model comes to parse an exception as a result.
 */
function execute(file, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal, input = null } = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve({ ok: false, interrupted: true, error: 'interrupted before it started' });
      return;
    }
    let child;
    try {
      child = spawn(file, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: `could not start ${file}: ${e.message}`, startFailed: true });
      return;
    }
    let out = '';
    let err = '';
    let truncated = false;
    const cap = (s, add) => {
      if (s.length >= MAX_OUTPUT) { truncated = true; return s; }
      const next = s + add;
      if (next.length > MAX_OUTPUT) { truncated = true; return next.slice(0, MAX_OUTPUT); }
      return next;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out = cap(out, d); });
    child.stderr.on('data', (d) => { err = cap(err, d); });

    const started = Date.now();
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ pid: child.pid, elapsedMs: Date.now() - started, stdout: out, stderr: err, truncated, ...r });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done({ ok: false, timedOut: true, exitCode: null, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    if (signal) {
      signal.addEventListener('abort', () => {
        try { child.kill(); } catch { /* already gone */ }
        done({ ok: false, interrupted: true, exitCode: null, error: 'interrupted by the user' });
      }, { once: true });
    }
    child.on('error', (e) => done({ ok: false, exitCode: null, error: e.message }));
    child.on('close', (code) => done({ ok: code === 0, exitCode: code }));

    if (input != null) { try { child.stdin.write(String(input)); } catch { /* closed */ } }
    try { child.stdin.end(); } catch { /* closed */ }
  });
}

/** What a run reads like: the facts first, then what it printed. */
/**
 * WHICH MECHANISM ACTUALLY RAN — .
 *
 * "The model must know whether it is python, process, shell, browser or
 * probe/bridge, and the evidence must identify the actual execution path."
 * Without it, a program that failed and a shell that failed read identically,
 * and the difference decides the fix: a shell flattens an exit code, a direct
 * spawn does not, and only one of them expands a glob.
 */
// The stamp itself lives in via.js: shell.js and jobs.js say the same thing,
// and two of the three used to spell it their own way.
const { via, KIND } = require('./via');
const execution = require('../execution');
const attemptsMod = require('../attempts');
const { resolveCwd } = require('./shell');

function report(what, r, mechanism = '') {
  const head = r.timedOut ? `${what} TIMED OUT after ${Math.round(r.elapsedMs / 1000)}s`
    : r.interrupted ? `${what} was interrupted`
      : r.startFailed || r.exitCode === null ? `${what} could not run`
        : `${what} exited ${r.exitCode} after ${Math.round(r.elapsedMs / 1000)}s`;
  // THE MECHANISM GOES ON THE HEAD LINE, not after it.
  //
  // the design asks that a result identify HOW it ran — `[via python: …]`, `[via
  // process: spawned directly, no shell]` — and it did, on the second line. The
  // feed shows the FIRST line of a tool result, and the join below becomes a
  // newline the moment the program prints anything, so the stamp was visible
  // exactly when the program was silent and invisible in every ordinary case.
  // A label that disappears as soon as there is real output is not a label.
  const bits = [mechanism ? `${head} ${mechanism}` : head];
  if (r.pid) bits.push(`pid ${r.pid}`);
  if (r.error) bits.push(`reason: ${r.error}`);
  // KEPT APART. A traceback is not a result.
  if (r.stdout && r.stdout.trim()) bits.push(`\n--- stdout ---\n${r.stdout.trim()}`);
  if (r.stderr && r.stderr.trim()) bits.push(`\n--- stderr ---\n${r.stderr.trim()}`);
  if (!r.stdout && !r.stderr) bits.push('(it printed nothing)');
  if (r.truncated) bits.push('\n[output was truncated]');
  return bits.join(r.stdout || r.stderr ? '\n' : ' · ');
}

const tools = {};

tools.python_run = {
  mutates: true,
  schema: {
    name: 'python_run',
    description:
      'Run Python — a script file, or a short snippet. The interpreter is spawned DIRECTLY, not '
      + 'through a shell, so the exit code, the pid and stderr are the real ones and a path with a '
      + 'space needs no quoting. Use this for OCR, image measurement, computer vision, data work '
      + "and the project's own scripts. stdout and stderr come back separately: a traceback is not "
      + 'a result. For anything slow, use run_background instead so you can keep working.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'path to a .py file to run' },
        code: { type: 'string', description: 'a short snippet, instead of a file' },
        args: { type: 'array', items: { type: 'string' }, description: 'arguments passed to the script' },
        cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
        timeout_ms: { type: 'number', description: 'default 120000' },
      },
    },
  },
  async run(input, ctx) {
    const cfg = (ctx.app && ctx.app.cfg) || {};
    const py = findPython(cfg);
    if (!py.ok) {
      return { output: `PYTHON NOT CONFIGURED — ${py.why}\nLooked for: ${py.tried.join(', ')}`, isError: true };
    }
    const file = String(input.file || '').trim();
    const code = String(input.code || '');
    if (!file && !code) return { output: 'python_run needs a file or code', isError: true };
    const where = resolveCwd(ctx, input);
    if (where.error) return { output: where.error, isError: true };

    const extra = Array.isArray(input.args) ? input.args.map(String) : [];
    // `-I` isolates from the user's site-packages and PYTHONPATH for a snippet,
    // so a one-liner cannot be changed by whatever is installed globally. A
    // FILE is run without it: a project script is meant to see its own project.
    const argv = file ? [file, ...extra] : ['-I', '-c', code, ...extra];
    const r = await execute(py.exe, argv, {
      cwd: where.cwd, timeoutMs: Number(input.timeout_ms) || undefined, signal: ctx.signal,
    });
    const stamp = via(KIND.PYTHON, execution.contextLine({
      executable: py.exe, note: `found on ${py.source}`, cwd: where.cwd,
    }));
    const note = annotationFor(r, { command: `python ${argv.join(' ')}`, cwd: where.cwd, ctx });
    return {
      output: execution.leadWith(report(file || 'snippet', r, stamp), note.text),
      isError: !r.ok,
      exitCode: r.exitCode,
      meta: { python: py.exe, pid: r.pid, exitCode: r.exitCode, cwd: where.cwd, classification: note.verdict.class },
    };
  },
};

/**
 * The classification block for a DIRECT spawn.
 *
 * No shell ran, so there is no shell dialect to have got wrong and no mismatch
 * to report — which is exactly the value of spawning directly, and why the
 * annotation here is usually just the exit code with a name on it. It is worth
 * having anyway: `127` and `126` mean something specific, and a model that has
 * already run this program twice should be told so.
 */
function annotationFor(r, { command, cwd, ctx }) {
  if (r.interrupted) return { text: '', verdict: { class: execution.CLASS.INTERRUPTED } };
  return execution.annotate(
    {
      exitCode: r.exitCode,
      stderr: r.stderr,
      stdout: r.stdout,
      shell: '',
      command,
      cwd,
      timedOut: r.timedOut,
      startFailed: r.startFailed,
    },
    { attempts: attemptsMod.forSession(ctx.session) },
  );
}

tools.process_run = {
  mutates: true,
  schema: {
    name: 'process_run',
    description:
      'Run a program directly — an .exe, a binary, a tool — with its arguments as a LIST. No shell '
      + 'is involved, so nothing is re-parsed and a path with spaces needs no quoting, and the exit '
      + 'code and pid are the program\'s own rather than a shell\'s. Use this when you mean "run '
      + 'this program"; use run_bash when you mean "run this shell command" (pipes, redirection, '
      + '&&). For anything slow, use run_background instead.',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', description: 'path to the executable, or a name on PATH' },
        args: { type: 'array', items: { type: 'string' }, description: 'arguments, one per element — never one joined string' },
        cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
        timeout_ms: { type: 'number', description: 'default 120000' },
      },
      required: ['program'],
    },
  },
  async run(input, ctx) {
    const program = String(input.program || '').trim();
    if (!program) return { output: 'process_run needs a program', isError: true };
    // A missing program is said plainly, rather than arriving as a shell's
    // "not recognized as an internal or external command".
    if (!exists(program) && !onPath(program)) {
      return {
        output: `no such program: ${program}. It is not a path that exists and not on PATH.`
          + `\n[CLASSIFICATION: ${execution.CLASS.COMMAND_NOT_FOUND}]`,
        isError: true,
        meta: { classification: execution.CLASS.COMMAND_NOT_FOUND },
      };
    }
    const where = resolveCwd(ctx, input);
    if (where.error) return { output: where.error, isError: true };
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const r = await execute(program, args, {
      cwd: where.cwd, timeoutMs: Number(input.timeout_ms) || undefined, signal: ctx.signal,
    });
    const stamp = via(KIND.PROCESS, execution.contextLine({
      note: 'spawned directly, no shell', cwd: where.cwd,
    }));
    const note = annotationFor(r, { command: `${program} ${args.join(' ')}`, cwd: where.cwd, ctx });
    return {
      output: execution.leadWith(report(path.basename(program), r, stamp), note.text),
      isError: !r.ok,
      exitCode: r.exitCode,
      meta: { program, pid: r.pid, exitCode: r.exitCode, cwd: where.cwd, classification: note.verdict.class },
    };
  },
};

module.exports = { tools, findPython, execute, report, onPath, MAX_OUTPUT, DEFAULT_TIMEOUT_MS };
