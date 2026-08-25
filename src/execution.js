'use strict';

/**
 * THE EXECUTION LAYER — which shell, which directory, and what actually failed.
 *
 * THE LOOP THIS EXISTS TO END. A command fails; the model cannot see WHY it
 * failed, so it changes something and tries again:
 *
 *     powershell: `cd src && node t.js`   →  fails
 *     cmd:        `cd src && node t.js`   →  fails
 *     bash:       `cd src && node t.js`   →  fails
 *     powershell: `cd src; node t.js`     →  fails
 *     ...
 *
 * Four requests, four full tool results, and the cause was in the first stderr
 * the whole time: PowerShell 5.1 has no `&&`, and it said so. The model was
 * guessing at a fact the machine already knew.
 *
 * Every piece of that is deterministic. Which shell ran the command is known
 * before it is spawned. Which directory it ran in is known. Whether stderr says
 * "not recognized as the name of a cmdlet" or "syntax error near unexpected
 * token" is a string comparison. So none of it belongs in a model's context
 * window twice.
 *
 * WHAT THIS OWNS:
 *
 *   · SHELL IDENTITY   which interpreter, resolved to a real executable
 *   · CWD              stated on every result, never inferred
 *   · CLASSIFICATION   what KIND of failure this was, from the exit code and
 *                      the shell's own words
 *   · THE FACT         the deterministic thing about that shell which explains
 *                      it — `&&` is not a PowerShell 5.1 separator, `2>/dev/null`
 *                      is not a Windows redirection
 *
 * WHAT IT DOES NOT OWN, deliberately: the COMMAND. Nothing here rewrites,
 * repairs, blocks or second-guesses what the model asked to run. V1 rewrote
 * commands and silently destroyed `cat x | head -20`. This layer reports; the
 * model decides. A classification is evidence, never an instruction.
 *
 * SILENCE ON SUCCESS. A command that worked gets no classification block, no
 * shell note and no advice. Every line here is paid for in a model's context,
 * and a layer that narrates its own correctness is a layer that gets ignored.
 */

const fs = require('fs');
const path = require('path');

/**
 * ONE WORD FOR ONE FACT. A command killed for exceeding its deadline is the
 * same event whether it was run in the foreground or as a background job, so
 * the word for it is imported from the module that already owned it rather than
 * spelled a second time here. Two definitions of `TIMED_OUT` would be two things
 * free to drift, which is the duplicate-vocabulary defect the guard exists to
 * catch — and it caught this one.
 */
const { STATE: JOB_STATE } = require('./jobs');

// --------------------------------------------------------- shell identity ---

/**
 * WHICH `bash` ON WINDOWS.
 *
 * `spawn('bash.exe')` takes whatever PATH offers first, and on a default
 * Windows install that is `C:\Windows\System32\bash.exe` — the WSL LAUNCHER,
 * not a shell. With no WSL distribution installed, every bash call dies with
 * `execvpe(/bin/bash) failed`, which is a failure the model cannot diagnose: it
 * asked for bash and got a launcher for an operating system that is not there.
 *
 * Choosing the INTERPRETER is not rewriting the COMMAND. Nothing here touches
 * the command string. It answers "which bash", preferring a real POSIX shell
 * over the WSL shim, and falls back to the plain name so a host whose PATH is
 * already correct behaves exactly as before.
 *
 * Resolved ONCE per process: it is a property of the machine, not of the call.
 */
let _bashPath;

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

function isWslShim(p) {
  // The launcher lives in System32 (or its 32-bit redirect). A genuine bash
  // never does.
  return /[\\/]system32[\\/]bash\.exe$/i.test(p) || /[\\/]syswow64[\\/]bash\.exe$/i.test(p);
}

function findBash() {
  if (_bashPath !== undefined) return _bashPath;
  if (process.platform !== 'win32') { _bashPath = '/bin/sh'; return _bashPath; }

  const candidates = [
    process.env.LAIN_BASH,                                    // an explicit override wins outright
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\msys64\\usr\\bin\\bash.exe',
    'C:\\cygwin64\\bin\\bash.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    if (exists(c)) { _bashPath = c; return _bashPath; }
  }

  // Nothing known found. Walk PATH ourselves so the WSL shim can be SKIPPED
  // rather than silently accepted, which is the whole failure.
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'bash.exe');
    if (isWslShim(p)) continue;
    if (exists(p)) { _bashPath = p; return _bashPath; }
  }

  // Genuinely no POSIX shell on this machine. Fall back to the plain name so
  // the error the model sees comes from the OS, not from a guess of ours.
  _bashPath = 'bash.exe';
  return _bashPath;
}

/**
 * WHICH `powershell` — AND IT IS THE DIFFERENCE BETWEEN TWO LANGUAGES.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, reported as "the && for the terminal kinda broken" and
 * reproduced exactly:
 *
 *     run_powershell  echo one && echo two
 *     -> The token '&&' is not a valid statement separator in this version.
 *
 * `powershell.exe` is WINDOWS POWERSHELL 5.1 — the one that ships in the box,
 * frozen, and it has no `&&` and no `||`. Those arrived in PowerShell 7, which
 * installs alongside it as a DIFFERENT executable called `pwsh`. This machine
 * has 7.6.5 sitting on PATH; LAIN was spawning 5.1 by name and getting a PARSE
 * ERROR for a command that is valid in the shell the user actually has.
 *
 * It is not only `&&`. The same 5.1 rejects `||`, the ternary `? :`, null
 * coalescing `??`, and `-ErrorAction` behaviours 7 changed — so every failure
 * of this class reads to a model as "my command was wrong" when the command was
 * right and the interpreter was old.
 *
 * CHOOSING THE INTERPRETER IS NOT REWRITING THE COMMAND. Nothing here touches
 * the command string — no `&&` is translated into `;`, and no statement is
 * reordered. It answers "which powershell", prefers the modern one, and falls
 * back to the in-box shell so a machine without 7 behaves exactly as before.
 *
 * Resolved ONCE per process, like `findBash`, because it is a property of the
 * machine rather than of the call.
 */
let _pwshPath;

/**
 * IS THERE AN EXECUTABLE HERE — asked in the one way that works for `pwsh`.
 *
 * `fs.existsSync` RETURNS FALSE FOR PWSH ON THIS MACHINE, and that is not a
 * bug in Node. PowerShell 7 installs an APP EXECUTION ALIAS in
 * `%LOCALAPPDATA%\Microsoft\WindowsApps` — a zero-length reparse point that
 * `stat` cannot follow, so `existsSync` says no about a program that runs
 * perfectly. Walking PATH with `existsSync` therefore SKIPPED the very shell
 * this lookup exists to find, and the first attempt at this fix silently
 * resolved back to 5.1 while reporting success.
 *
 * `lstat` does not follow the link, and `access(X_OK)` answers the question
 * actually being asked — can this be executed — so the two together see the
 * alias. Same family of trap as `isWslShim`: on Windows the thing at a path is
 * not always the thing the path names.
 */
function executable(p) {
  if (!p) return false;
  try { if (fs.existsSync(p)) return true; } catch { /* fall through */ }
  try {
    fs.lstatSync(p);
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function findPowerShell() {
  if (_pwshPath !== undefined) return _pwshPath;
  const explicit = process.env.LAIN_POWERSHELL;
  if (explicit) { _pwshPath = explicit; return _pwshPath; }
  if (process.platform !== 'win32') { _pwshPath = 'pwsh'; return _pwshPath; }

  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (executable(c)) { _pwshPath = c; return _pwshPath; }

  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'pwsh.exe');
    if (executable(p)) { _pwshPath = p; return _pwshPath; }
  }

  // No PowerShell 7 on this machine. The in-box shell is a real shell and the
  // right answer here; what it is NOT is a shell with `&&`, and `annotate` says
  // so when a command trips over that. See CLASS.SHELL_SYNTAX.
  _pwshPath = 'powershell.exe';
  return _pwshPath;
}

/** Is the resolved PowerShell one that understands `&&`? Read by annotate. */
function powerShellIsLegacy() {
  // Bare name or full path — `powershell.exe` is 5.1 either way, and `pwsh` is
  // never 5.1. Anchored on the basename so a directory called `powershell`
  // somewhere in the path cannot decide this.
  return /^powershell\.exe$/i.test(path.basename(String(findPowerShell())));
}

/**
 * WHICH PROGRAM RUNS A COMMAND, and the arguments that precede it.
 *
 * ONE definition, because background jobs, foreground shell tools and the
 * environment summary all need to spawn the same three shells the same three
 * ways — and a second copy is free to disagree the day one of them gains a flag.
 *
 * @returns {[string, string[]]} the executable, and the args BEFORE the command
 */
function shellPrefix(shell) {
  if (shell === 'powershell') {
    return [findPowerShell(), ['-NoProfile', '-NonInteractive', '-Command']];
  }
  if (shell === 'cmd') return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c']];
  if (shell === 'fish') return ['fish', ['-c']];
  return [findBash(), ['-c']];
}

/** The shells this layer can name, and the one word each is known by. */
const SHELLS = ['powershell', 'cmd', 'bash', 'fish'];

// --------------------------------------------------------- classification ---

/**
 * WHAT KIND OF FAILURE THIS WAS.
 *
 * These are the categories that change what to do next, and no finer. A model
 * that knows the difference between "this shell has no such operator" and "that
 * program is not installed" is not going to spend a turn discovering it, and
 * every additional category past that point is a distinction nobody acts on.
 */
const CLASS = {
  OK: 'OK',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  NO_SUCH_PATH: 'NO_SUCH_PATH',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SHELL_SYNTAX: 'SHELL_SYNTAX',
  SHELL_MISSING: 'SHELL_MISSING',
  TIMED_OUT: JOB_STATE.TIMED_OUT,
  INTERRUPTED: 'INTERRUPTED',
  /**
   * THE PROGRAM'S OWN SOURCE IS WRONG — a syntax, parse or compile error
   * reported by the interpreter or compiler about a FILE, not about the command
   * line. Separate from SHELL_SYNTAX because they point at different things and
   * the wrong one sends the model to the wrong place entirely.
   */
  SOURCE_ERROR: 'SOURCE_ERROR',
  /**
   * SOMETHING THE PROGRAM IMPORTS IS NOT INSTALLED. The source is fine and the
   * command is fine; the environment is short a package. Editing the file is
   * the wrong response, which is why this is not APPLICATION_ERROR.
   */
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
  APPLICATION_ERROR: 'APPLICATION_ERROR',
};

/**
 * WHAT THE PROGRAM SAID ABOUT ITSELF, checked BEFORE the shell's own words.
 *
 * THE DEFECT THIS EXISTS TO END. PowerShell's diagnostic list matches
 * `/Unexpected token/`, and that is exactly what Node prints for a JavaScript
 * syntax error:
 *
 *     node bad.js  ->  SyntaxError: Unexpected token ';'
 *
 * So a broken source FILE was classified SHELL_SYNTAX — "this shell does not
 * support that syntax" — and the model was told the shell was the problem. The
 * obvious next move from there is to try the same command under a different
 * shell, which is precisely the retry loop this whole file exists to prevent,
 * pointed at the wrong layer.
 *
 * The discriminator is not a cleverer regex, it is ORDER plus a fact: a shell
 * syntax error means the shell never ran anything, so if a program has produced
 * its own diagnostic — naming its own file, line or module — the command line
 * parsed fine and the shell is not the story.
 *
 * DELIBERATELY NOT FINER THAN THIS. A failing test, an assertion and an
 * ordinary runtime exception all mean "the code did not do what was wanted",
 * and all have the same next move: read the output. They stay
 * APPLICATION_ERROR. Only the two categories that redirect the work — fix the
 * FILE, or install the DEPENDENCY — are worth their own name.
 */
const SOURCE_SIGNS = [
  // A missing import/module, in the words each ecosystem uses for it.
  [/ModuleNotFoundError|ImportError: cannot import name|No module named/i, CLASS.DEPENDENCY_MISSING,
    'A module the program imports is not installed in the environment it ran in. Installing it, or activating the right environment, is the fix — the source is not wrong.'],
  [/Cannot find module|ERR_MODULE_NOT_FOUND|Module not found: Error: Can't resolve/i, CLASS.DEPENDENCY_MISSING,
    'A module this file requires cannot be resolved. Either it is not installed, or the specifier does not match a real path.'],
  [/\bno matching distribution found|could not find a version that satisfies/i, CLASS.DEPENDENCY_MISSING, null],
  // The program's own parse/compile failure, naming a file or a line.
  [/^\s*File "[^"]+", line \d+/m, CLASS.SOURCE_ERROR,
    'The interpreter rejected the FILE it was given, at the line it names. The command ran; the source is what is wrong.'],
  [/\b(?:SyntaxError|IndentationError|TabError)\b/, CLASS.SOURCE_ERROR,
    'The interpreter rejected the FILE it was given. The command line parsed fine — this is the program\'s own syntax, not the shell\'s.'],
  [/\berror\[E\d+\]|\berror TS\d+\b|\berror CS\d+\b/, CLASS.SOURCE_ERROR,
    'The compiler rejected the source. The diagnostic names the file and position.'],
  [/\b(?:cannot find symbol|expected ';'|unexpected end of input|parse error before)\b/i, CLASS.SOURCE_ERROR, null],
];

/**
 * THE SHELL'S OWN WORDS, per shell.
 *
 * Matched against what the interpreter actually printed, not guessed from the
 * exit code — a shell reports 1 for a parse error and 1 for a test suite with a
 * failing test, and those are not the same problem at all.
 *
 * `fact` is the DETERMINISTIC thing about this shell that explains the message.
 * It is the whole point of the table: it is knowledge the machine has and the
 * model would otherwise pay several requests to rediscover. It states how the
 * shell behaves. It never says what to run.
 */
const SIGNS = {
  powershell: [
    // ---- BOTH WORDINGS, BECAUSE THERE ARE TWO POWERSHELLS -------------
    //
    // Caught by tests/smoke/engineering.test.js the moment LAIN started
    // resolving pwsh 7, and it is the exact second-order cost of that change:
    //
    //   5.1   "is not recognized as THE NAME OF A cmdlet … or operable program"
    //   7.x   "is not recognized as A NAME OF A cmdlet … or executable program"
    //
    // One article and one adjective apart, and the old pattern matched only
    // 5.1 — so on a machine with PowerShell 7 a missing program came back as
    // APPLICATION_ERROR. That sends the model to debug a program that was never
    // found, which is the most expensive possible reading of a typo.
    [/is not recognized as (?:(?:the|a) name of )?a cmdlet|CommandNotFoundException/i, CLASS.COMMAND_NOT_FOUND,
      'PowerShell resolves a bare name against cmdlets, functions, aliases and PATH. A name it cannot find is not on any of them.'],
    [/The token '&&' is not a valid statement separator|token '\|\|' is not a valid/i, CLASS.SHELL_SYNTAX,
      'Windows PowerShell 5.1 has no && or || operator; they were added in PowerShell 7 (pwsh). In 5.1, `;` runs the next statement unconditionally, and there is no built-in "only if the last one succeeded" separator — $LASTEXITCODE or $? carries that.'],
    [/ParserError|Missing (?:closing|expression|argument)|Unexpected token|Unrecognized token/i, CLASS.SHELL_SYNTAX,
      'PowerShell parsed the line and rejected it before running anything, so nothing in the command executed.'],
    [/ItemNotFoundException|Cannot find path|because it does not exist/i, CLASS.NO_SUCH_PATH,
      'The path was resolved against the CWD reported above.'],
    [/UnauthorizedAccessException|Access to the path .* is denied|Access is denied/i, CLASS.PERMISSION_DENIED, null],
    [/A positional parameter cannot be found|Cannot bind parameter|Missing an argument for parameter/i, CLASS.SHELL_SYNTAX,
      'PowerShell binds arguments to named parameters. A POSIX-style flag such as -rf or /s is read as a parameter name, not as text passed to a program.'],
  ],
  cmd: [
    [/is not recognized as an internal or external command/i, CLASS.COMMAND_NOT_FOUND, null],
    [/The system cannot find the (?:path|file) specified/i, CLASS.NO_SUCH_PATH,
      'The path was resolved against the CWD reported above.'],
    [/Access is denied/i, CLASS.PERMISSION_DENIED, null],
    [/was unexpected at this time|The syntax of the command is incorrect/i, CLASS.SHELL_SYNTAX,
      'cmd.exe rejected the line. Its quoting rules are not PowerShell\'s and not bash\'s: single quotes are literal characters, and % has meaning.'],
  ],
  bash: [
    [/: command not found/i, CLASS.COMMAND_NOT_FOUND, null],
    // `bash: ./deploy.sh: No such file or directory` is the SHELL failing to
    // find the thing it was asked to run — a missing command. `ls: cannot
    // access '/s': No such file or directory` is a program reporting a missing
    // path, which is an entirely different problem with the same six words in
    // it. The shell name at the start of the line is what tells them apart, and
    // matching the words alone classified every missing path as a missing
    // command.
    // The shell names ITSELF by the path it was spawned from — Git Bash says
    // `/usr/bin/bash: line 1: …`, not `bash: …` — so the anchor has to allow a
    // directory in front of the name. Anchored on `bash` alone, this matched
    // nothing on the platform it was written on.
    [/^(?:\S*[\\/])?(?:bash|sh|fish|dash)(?:\.exe)?(?:: line \d+)?: [^\n]*: No such file or directory/im,
      CLASS.COMMAND_NOT_FOUND, null],
    [/syntax error near unexpected token|unexpected EOF while looking for matching|syntax error: unexpected end of file/i, CLASS.SHELL_SYNTAX,
      'bash parsed the line and rejected it before running anything.'],
    [/No such file or directory/i, CLASS.NO_SUCH_PATH,
      'The path was resolved against the CWD reported above.'],
    [/Permission denied/i, CLASS.PERMISSION_DENIED, null],
  ],
  fish: [
    [/Unknown command|command not found/i, CLASS.COMMAND_NOT_FOUND, null],
    [/Missing end to balance|Unexpected end of string/i, CLASS.SHELL_SYNTAX, null],
    [/No such file or directory/i, CLASS.NO_SUCH_PATH, null],
    [/Permission denied/i, CLASS.PERMISSION_DENIED, null],
  ],
};

/** Exit codes that name a cause on their own, when the text did not. */
const BY_CODE = {
  127: [CLASS.COMMAND_NOT_FOUND, null],                 // POSIX: not found
  126: [CLASS.PERMISSION_DENIED, 'The file was found but is not executable.'],
  9009: [CLASS.COMMAND_NOT_FOUND, null],                // cmd.exe: not found
};

/**
 * A COMMAND WRITTEN FOR A DIFFERENT SHELL — checked only once it has FAILED.
 *
 * This is the `/s` versus `-s` versus `s` class the whole layer is aimed at, and
 * it is inspected AFTER the fact for a reason: a line containing `2>/dev/null`
 * is perfectly fine until it fails, and a checker that objects to working
 * commands is one the model learns to ignore. On a failure the cost is already
 * paid, so naming the mismatch is free.
 *
 * Each entry proves a MECHANICAL fact about the shell that ran, not a style
 * preference.
 */
const MISMATCH = [
  // ---- CONDITIONAL, BECAUSE THE ANSWER DEPENDS ON THE MACHINE -----------
  //
  // This used to be a flat sentence, and once LAIN started resolving pwsh 7
  // when it is installed (see findPowerShell) the flat sentence became a FALSE
  // one: on a 7.x host `&&` works, so a command that failed for some unrelated
  // reason would be handed an explanation blaming an operator that was fine.
  // A note is only worth printing when it is true of the shell that actually
  // ran, so this one asks.
  ['powershell', /(?:^|[\s;|(])&&(?:\s|$)/,
    (r, verdict) => {
      // TWO WAYS FOR THIS TO BE TRUE, and it must be true to be printed.
      //
      //   The PowerShell LAIN resolved IS 5.1, so `&&` cannot work here at all.
      //   The shell REPORTED a syntax error — whatever LAIN resolved, the thing
      //     that ran could not parse it, and the operator is what it choked on.
      //
      // Anything else on a pwsh 7 host is a command that failed for its own
      // reasons while happening to contain `&&`, and blaming the operator sends
      // the next turn somewhere there is nothing to find.
      if (!powerShellIsLegacy() && verdict !== CLASS.SHELL_SYNTAX) return null;
      return '`&&` in a PowerShell command. Windows PowerShell 5.1 does not have it; pwsh 7+ does'
        + (powerShellIsLegacy()
          ? ', and 5.1 is what is installed here — use `;`, or run this with run_cmd, where `&&` works.'
          : '.');
    }],
  ['powershell', /2>\s*\/dev\/null|>\s*\/dev\/null/,
    '`/dev/null` in a PowerShell command. On Windows the equivalent sink is `$null`, and `/dev/null` is read as a path.'],
  ['powershell', /\brm\s+-[rf]|\bls\s+-[la]|\bgrep\b|\bcat\b\s+[^|]*\|/,
    'A POSIX command in a PowerShell command line. PowerShell has aliases for some of them (ls, cat, rm) but NOT their flags — `rm -rf` binds `-rf` as a parameter name and fails.'],
  // NOTHING FOR `&&` UNDER cmd, deliberately: cmd.exe HAS it. A table entry
  // per operator per shell would be symmetrical and wrong — every line here
  // has to state a real mechanical difference, or the section becomes noise
  // that gets skipped, taking the true entries with it.
  ['cmd', /'[^']*'/,
    "Single quotes in a cmd.exe command line. cmd does not treat ' as a quote character — it is passed through literally."],
  ['cmd', /2>\s*\/dev\/null/,
    '`/dev/null` in a cmd command. The equivalent sink is `NUL`.'],
  // ONE OR TWO LETTERS, not three. `/s`, `/n`, `/q`, `/f` are Windows switches;
  // `/etc`, `/usr`, `/var`, `/tmp`, `/opt`, `/bin` are ordinary absolute paths
  // and are all exactly three. At {1,3} this told a failing `ls /etc` that it
  // had a Windows flag in it, which is a false statement about a correct
  // command — the precise thing that teaches a model to stop reading the
  // section.
  ['bash', /(?:^|\s)\/[a-zA-Z]{1,2}(?:\s|$)/,
    'A `/x` style flag in a bash command. bash reads a leading `/` as an absolute path, not as a switch — Windows programs take `/s`, POSIX ones take `-s`.'],
  ['bash', /\$env:|Get-\w+|Write-Host|\$null\b/,
    'PowerShell syntax in a bash command line.'],
];

/**
 * Classify one finished execution.
 *
 * @param {object} r
 * @param {number|null} r.exitCode
 * @param {string} r.stderr    what the process wrote to stderr
 * @param {string} [r.stdout]  consulted only when stderr is empty — cmd.exe and
 *   several Windows programs report failures on stdout
 * @param {string} r.shell     which interpreter ran it, or '' for a direct spawn
 * @param {string} [r.command] the command line, for the mismatch check
 * @param {boolean} [r.timedOut] [r.interrupted] [r.startFailed]
 * @returns {{class: string, fact: string|null, mismatch: string|null}}
 */
function classify(r = {}) {
  if (r.interrupted) return { class: CLASS.INTERRUPTED, fact: null, mismatch: null };
  if (r.timedOut) {
    // ---- A TIMEOUT USED TO SAY NOTHING, and that is why it cost a turn ----
    //
    // The model got `[timed out after 120s]` and no more. Nothing in that says
    // whether the command was WRONG or merely SLOW, so the usual response was
    // to re-run it — and hit the same wall, having learned nothing and spent
    // another two minutes. The two ways out of it are a bigger `timeout_ms`
    // and `run_background`, and neither is discoverable from the failure.
    //
    // This is the one classification where the fact is not about the machine
    // but about what to do next, because the command itself is not the problem.
    return {
      class: CLASS.TIMED_OUT,
      fact: 'The command was still running when its time ran out and was killed, so this says nothing '
        + 'about whether it would have succeeded. If it is genuinely long-running, start it with '
        + 'run_background and follow it with job_status — a foreground command holds the whole turn. '
        + 'Raise `timeout_ms` instead only when you expect it to finish shortly after the limit.',
      mismatch: null,
    };
  }
  if (r.startFailed) {
    return {
      class: CLASS.SHELL_MISSING,
      fact: r.shell === 'bash' && process.platform === 'win32'
        ? 'This is Windows and no POSIX bash was resolvable. powershell and cmd are present on every Windows host.'
        : 'The interpreter itself could not be started, so the command never ran.',
      mismatch: null,
    };
  }
  const code = r.exitCode;
  if (code === 0) return { class: CLASS.OK, fact: null, mismatch: null };

  const shell = SHELLS.includes(r.shell) ? r.shell : (r.shell === 'sh' ? 'bash' : null);
  // stderr first, always. stdout is consulted only when stderr said nothing —
  // several Windows programs print their failure to stdout, and treating a
  // program's ordinary output as a diagnosis would misclassify a test run whose
  // report happens to contain the words "not found".
  const text = String(r.stderr || '').trim() || String(r.stdout || '').trim();

  let verdict = null;
  let fact = null;
  // THE PROGRAM IS ASKED FIRST. A diagnostic that names a file, a line or a
  // module came from something the shell successfully STARTED, so the shell's
  // own error list must not be allowed to claim it. See SOURCE_SIGNS.
  if (text) {
    for (const [re, klass, why] of SOURCE_SIGNS) {
      if (!re.test(text)) continue;
      verdict = klass;
      fact = why;
      break;
    }
  }
  if (!verdict && shell && text) {
    for (const [re, klass, why] of SIGNS[shell]) {
      if (!re.test(text)) continue;
      verdict = klass;
      fact = why;
      break;
    }
  }
  if (!verdict && BY_CODE[code]) [verdict, fact] = BY_CODE[code];
  if (!verdict) verdict = CLASS.APPLICATION_ERROR;

  // The mismatch note is attached to any failure, whatever the classification —
  // a bash command carrying `/s` can fail as NO_SUCH_PATH, and the reason it is
  // a path at all is exactly what needs saying.
  let mismatch = null;
  if (shell && r.command) {
    for (const [which, re, note] of MISMATCH) {
      if (which !== shell || !note || !re.test(String(r.command))) continue;
      // A note may be a sentence or a question about this machine. See the
      // PowerShell `&&` entry for why the second kind had to exist.
      const said = typeof note === 'function' ? note(r, verdict) : note;
      if (!said) continue;
      mismatch = said;
      break;
    }
  }
  return { class: verdict, fact, mismatch };
}

// -------------------------------------------------------------- reporting ---

/**
 * WHERE AND HOW THIS RAN — the two facts a model was previously left to
 * remember across a turn, and the two it most often got wrong.
 *
 * On every result, success included, because a correct command run in the wrong
 * directory is the failure that looks like a code defect.
 */
function contextLine({ shell = '', cwd = '', executable = '', note = '' } = {}) {
  const bits = [];
  if (shell) bits.push(shell);
  else if (executable) bits.push(executable);
  if (note) bits.push(note);
  if (cwd) bits.push(`cwd=${cwd}`);
  return bits.join(' · ');
}

/**
 * THE FAILURE BLOCK. Appended to a failing result and to nothing else.
 *
 * Compact by design: this is the part that is paid for repeatedly if a model
 * keeps failing, so it says what happened in as few lines as the facts allow.
 */
function failureBlock(verdict, { exitCode = null } = {}) {
  if (!verdict || verdict.class === CLASS.OK) return '';
  const lines = [`CLASSIFICATION: ${verdict.class}${exitCode != null ? ` (exit ${exitCode})` : ''}`];
  if (verdict.fact) lines.push(verdict.fact);
  if (verdict.mismatch) lines.push(`SHELL MISMATCH: ${verdict.mismatch}`);
  return `\n[${lines.join('\n ')}]`;
}

/**
 * The whole annotation for one finished execution: the failure block, plus
 * whatever the attempt ledger already knows about this exact command.
 *
 * Returns '' for a successful command with no history — the common case pays
 * nothing for any of this existing.
 */
function annotate(r, { attempts = null } = {}) {
  const verdict = classify(r);
  let out = failureBlock(verdict, { exitCode: r.exitCode });
  const entry = {
    command: r.command,
    shell: r.shell,
    cwd: r.cwd,
    classification: verdict.class,
    exitCode: r.exitCode,
  };
  if (attempts && verdict.class !== CLASS.OK) {
    // Asked BEFORE recording, so the numbered history is history — but with
    // this attempt handed over, so the conclusions cover what just happened.
    const prior = attempts.note({ command: r.command, shell: r.shell, cwd: r.cwd, current: entry });
    if (prior) out += `\n${prior}`;
  }
  if (attempts) attempts.record(entry);
  return { text: out, verdict };
}

/**
 * PUT THE ANNOTATION WHERE IT WILL ACTUALLY BE READ — directly under the
 * provenance line, ahead of whatever the command printed.
 *
 * FOUND BY DRIVING THE REAL BINARY, and it is the same lesson this project
 * already learned once about the `via` stamp: the feed shows the first lines of
 * a tool result and elides the rest. A PowerShell CommandNotFoundException is
 * eight lines of banner, so a classification appended at the END landed inside
 * `… 6 more line(s)` — present in the result, invisible on the screen, and
 * behind eight lines of noise for the model too.
 *
 * The head line is the `[via shell: … cwd=…]` stamp. The block goes after it
 * and before the output, so the two facts that identify the failure are the
 * two facts you see first.
 */
function leadWith(output, block) {
  if (!block) return output;
  const text = String(output == null ? '' : output);
  const nl = text.indexOf('\n');
  if (nl < 0) return `${text}${block}`;
  return `${text.slice(0, nl)}${block}${text.slice(nl)}`;
}

module.exports = {
  CLASS, SHELLS, SIGNS, MISMATCH, BY_CODE,
  classify, annotate, failureBlock, contextLine, leadWith,
  shellPrefix, findBash, isWslShim, findPowerShell, powerShellIsLegacy,
};
