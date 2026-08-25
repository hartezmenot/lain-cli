'use strict';

/**
 * THE EXECUTION LAYER — shell identity, failure classification, attempt history.
 *
 * These test the thing the layer exists for: that a failure comes back NAMED,
 * so a model does not spend three requests renaming it. The classifications are
 * asserted against the exact words the real shells print, captured from the
 * shells themselves rather than invented — a classifier tested only against
 * strings someone made up is a classifier tested against nothing.
 */

const assert = require('assert');
const { test } = require('../helpers');

const execution = require('../../src/execution');
const { AttemptLog } = require('../../src/attempts');
const { CLASS } = execution;

/** Shorthand: classify a failure with these words on stderr. */
function say(shell, stderr, { exitCode = 1, command = '' } = {}) {
  return execution.classify({ exitCode, stderr, shell, command });
}

module.exports = async function () {
  // ------------------------------------------------------ classification ----

  await test('EXEC: a command that worked is classified OK and annotated with nothing', () => {
    const v = execution.classify({ exitCode: 0, stderr: '', shell: 'bash' });
    assert.strictEqual(v.class, CLASS.OK);
    assert.strictEqual(execution.failureBlock(v, { exitCode: 0 }), '',
      'a successful command must cost no tokens at all');
  });

  await test('EXEC: PowerShell 5.1 rejecting && is SHELL_SYNTAX, and says why', () => {
    // THE EXACT TEXT PowerShell 5.1 prints, and the single most expensive
    // guess in the whole tool surface: the model tries cmd, then bash, then
    // removes the &&, and the shell had already explained itself in line one.
    const v = say('powershell',
      "At line:1 char:8\n+ echo a && echo b\nThe token '&&' is not a valid statement separator in this version.",
      { command: 'echo a && echo b' });
    assert.strictEqual(v.class, CLASS.SHELL_SYNTAX);
    assert.match(v.fact, /PowerShell 7|pwsh/, 'the fact must name the version that DOES have it');
    assert.match(v.mismatch, /&&/, 'and the command must be named as carrying it');
  });

  await test('EXEC: a TIMEOUT says what to do next, because the command was not the problem', () => {
    // ---- WHAT THIS COST BEFORE -----------------------------------------
    //
    // A timed-out command came back as `[timed out after 120s]` and a null
    // fact. Nothing in that distinguishes WRONG from SLOW, so the model's usual
    // move was to run the same command again and spend the same two minutes
    // discovering the same nothing. Both ways out — a larger `timeout_ms`, and
    // `run_background` — were undiscoverable from the failure itself.
    const v = execution.classify({ timedOut: true, shell: 'bash', command: 'npm test', exitCode: null });
    assert.strictEqual(v.class, CLASS.TIMED_OUT);
    assert.ok(v.fact, 'a timeout must not be reported with no explanation');
    assert.match(v.fact, /run_background/, 'the way out for genuinely long work must be named');
    assert.match(v.fact, /timeout_ms/, 'and the way out for something nearly finished');
    assert.match(v.fact, /says nothing about whether it would have succeeded/i,
      'and it must NOT be read as the command failing');
  });

  await test('EXEC: a missing program is COMMAND_NOT_FOUND in every shell dialect', () => {
    // ---- AND IN BOTH POWERSHELLS, which do not word it the same way ------
    //
    // Found by the smoke tier the moment LAIN started resolving pwsh 7:
    //   5.1  "...as THE NAME OF A cmdlet ... or OPERABLE program"
    //   7.x  "...as A NAME OF A cmdlet ... or EXECUTABLE program"
    // One article apart. The pattern matched only 5.1, so on a machine with
    // PowerShell 7 a typo came back as APPLICATION_ERROR — which sends the
    // model to debug a program that was never found.
    assert.strictEqual(
      say('powershell', "frobnicate : The term 'frobnicate' is not recognized as the name of a cmdlet, function, script file, or operable program.").class,
      CLASS.COMMAND_NOT_FOUND, 'Windows PowerShell 5.1');
    assert.strictEqual(
      say('powershell', "frobnicate: The term 'frobnicate' is not recognized as a name of a cmdlet, function, script file, or executable program.").class,
      CLASS.COMMAND_NOT_FOUND, 'PowerShell 7');
    assert.strictEqual(
      say('cmd', "'frobnicate' is not recognized as an internal or external command,\noperable program or batch file.").class,
      CLASS.COMMAND_NOT_FOUND);
    assert.strictEqual(
      say('bash', 'bash: frobnicate: command not found', { exitCode: 127 }).class,
      CLASS.COMMAND_NOT_FOUND);
  });

  await test('EXEC: a missing COMMAND and a missing PATH are told apart in bash', () => {
    // Six words that mean two entirely different problems. `bash: ./x.sh: No
    // such file or directory` is the shell failing to find what it was told to
    // run; `ls: cannot access '/s': No such file or directory` is a program
    // reporting a path. Matching the words alone called every missing path a
    // missing command.
    assert.strictEqual(
      say('bash', '/usr/bin/bash: line 1: ./deploy.sh: No such file or directory', { exitCode: 127 }).class,
      CLASS.COMMAND_NOT_FOUND);
    assert.strictEqual(
      say('bash', "ls: cannot access '/s': No such file or directory", { exitCode: 2 }).class,
      CLASS.NO_SUCH_PATH);
  });

  await test('EXEC: a program that ran and failed is APPLICATION_ERROR, not a shell fault', () => {
    // The distinction the whole table protects. A failing test suite must never
    // be reported as a shell problem, or the model goes looking for quoting.
    const v = say('bash', '', { exitCode: 1, command: 'npm test' });
    assert.strictEqual(v.class, CLASS.APPLICATION_ERROR);
    assert.strictEqual(v.fact, null, 'there is no shell fact to state — the shell worked');
  });

  await test('EXEC: a failing test suite is judged on stderr, not on words in its report', () => {
    // stdout is consulted ONLY when stderr is silent. A suite that prints
    // "Error: command not found" as part of a test NAME must not be classified
    // by it.
    const v = execution.classify({
      exitCode: 1, shell: 'bash',
      stderr: 'AssertionError: 3 !== 4',
      stdout: 'FAIL: handles command not found\n1 failed',
    });
    assert.strictEqual(v.class, CLASS.APPLICATION_ERROR);
  });

  await test('EXEC: a timeout and an interrupt are not failures of the command', () => {
    assert.strictEqual(execution.classify({ timedOut: true, exitCode: null }).class, CLASS.TIMED_OUT);
    assert.strictEqual(execution.classify({ interrupted: true, exitCode: null }).class, CLASS.INTERRUPTED);
  });

  await test('EXEC: TIMED_OUT is the SAME WORD the job state machine uses', () => {
    // One fact, one word. Two spellings of "the deadline passed" would be two
    // things free to drift, and the architecture guard says so.
    assert.strictEqual(CLASS.TIMED_OUT, require('../../src/jobs').STATE.TIMED_OUT);
  });

  await test('EXEC: the interpreter itself failing to start is SHELL_MISSING', () => {
    const v = execution.classify({ startFailed: true, shell: 'bash', exitCode: null });
    assert.strictEqual(v.class, CLASS.SHELL_MISSING);
    assert.ok(v.fact, 'it must say that the command never ran at all');
  });

  // ------------------------------------------------------ shell mismatch ----

  await test('EXEC: a /s style flag in a BASH command is named as the mismatch it is', () => {
    // The exact typo class this layer was built for: `/s`, `/n`, `-s` and `s`
    // are four different things, and only one of them is a switch in any given
    // shell. bash reads a leading slash as an absolute path.
    const v = say('bash', "ls: cannot access '/s': No such file or directory", { exitCode: 2, command: 'ls /s' });
    assert.match(v.mismatch, /leading `\/` as an absolute path|absolute path/);
  });

  await test('EXEC: an ordinary absolute path is NOT called a Windows flag', () => {
    // `/etc`, `/usr`, `/var`, `/tmp` are three letters, and at a three-letter
    // bound this told a failing `ls /etc` it had a Windows switch in it — a
    // false statement about a correct command, which is how a section stops
    // being read.
    for (const dir of ['/etc', '/usr', '/var', '/tmp', '/opt']) {
      const v = say('bash', 'No such file or directory', { exitCode: 2, command: `ls ${dir}/missing` });
      assert.strictEqual(v.mismatch, null, `${dir} was reported as a flag`);
    }
  });

  await test('EXEC: /dev/null in a PowerShell command is named, and $null given as the fact', () => {
    const v = say('powershell', 'Cannot find path', { command: 'node x.js 2>/dev/null' });
    assert.match(v.mismatch, /\$null/);
  });

  await test('EXEC: a mismatch is NEVER reported for a command that worked', () => {
    // The rule that keeps the channel worth reading. `2>/dev/null` inside a
    // string argument is perfectly legal; objecting to a working command is how
    // a diagnostic teaches a model to ignore it.
    const v = execution.classify({ exitCode: 0, shell: 'powershell', command: 'echo "a && b"' });
    assert.strictEqual(v.class, CLASS.OK);
    assert.strictEqual(v.mismatch, null);
  });

  // ------------------------------------------------------ attempt ledger ----

  await test('ATTEMPT: the first failure has no history, and says nothing', () => {
    const log = new AttemptLog();
    assert.strictEqual(log.note({ command: 'npm test', shell: 'bash', cwd: '/p' }), '');
  });

  await test('ATTEMPT: the same command again carries what happened last time', () => {
    const log = new AttemptLog();
    log.record({ command: 'npm test', shell: 'bash', cwd: '/p', classification: CLASS.COMMAND_NOT_FOUND, exitCode: 127 });
    const note = log.note({ command: 'npm test', shell: 'bash', cwd: '/p' });
    assert.match(note, /ATTEMPT 2/);
    assert.match(note, /COMMAND_NOT_FOUND/);
  });

  await test('ATTEMPT: the SAME failure under a DIFFERENT shell eliminates the shell, on the spot', () => {
    // This is the measurement the ledger exists to make. Asked without the
    // current attempt it was always one behind — the third attempt, the first
    // under a second shell, could only see two PowerShell failures.
    const log = new AttemptLog();
    log.record({ command: 'frob', shell: 'powershell', cwd: '/p', classification: CLASS.COMMAND_NOT_FOUND, exitCode: 1 });
    log.record({ command: 'frob', shell: 'powershell', cwd: '/p', classification: CLASS.COMMAND_NOT_FOUND, exitCode: 1 });
    const note = log.note({
      command: 'frob', shell: 'cmd', cwd: '/p',
      current: { shell: 'cmd', cwd: '/p', classification: CLASS.COMMAND_NOT_FOUND, exitCode: 1 },
    });
    assert.match(note, /2 different shells/);
    assert.match(note, /the shell is not the difference/);
  });

  await test('ATTEMPT: whitespace is not a different command', () => {
    const log = new AttemptLog();
    log.record({ command: 'npm  test', shell: 'bash', cwd: '/p', classification: CLASS.APPLICATION_ERROR, exitCode: 1 });
    assert.match(log.note({ command: 'npm test', shell: 'bash', cwd: '/p' }), /ATTEMPT 2/);
  });

  await test('ATTEMPT: re-running something that SUCCEEDED is reported as that, not as a loop', () => {
    const log = new AttemptLog();
    log.record({ command: 'npm test', shell: 'bash', cwd: '/p', classification: CLASS.OK, exitCode: 0 });
    const note = log.note({ command: 'npm test', shell: 'bash', cwd: '/p' });
    assert.match(note, /SUCCEEDED/);
    assert.doesNotMatch(note, /ATTEMPT/);
  });

  await test('ATTEMPT: the ledger never phrases itself as a prohibition', () => {
    // Repeating a command is often exactly right — after an install, after an
    // edit, after a service comes up. The ledger reports; it does not refuse.
    const src = require('fs').readFileSync(require.resolve('../../src/attempts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /do not run|you may not|refused|forbidden|not allowed/i);
  });

  await test('ATTEMPT: a loop is visible as a loop — same command, failing, never succeeding', () => {
    const log = new AttemptLog();
    for (const sh of ['powershell', 'cmd', 'bash']) {
      log.record({ command: 'frob', shell: sh, cwd: '/p', classification: CLASS.COMMAND_NOT_FOUND, exitCode: 1 });
    }
    log.record({ command: 'npm test', shell: 'bash', cwd: '/p', classification: CLASS.OK, exitCode: 0 });
    const loops = log.loops();
    assert.strictEqual(loops.length, 1, 'only the command that kept failing is a loop');
    assert.strictEqual(loops[0].command, 'frob');
    assert.strictEqual(loops[0].attempts, 3);
    assert.deepStrictEqual(loops[0].shells, ['powershell', 'cmd', 'bash']);
  });

  await test('ATTEMPT: a command that failed and then SUCCEEDED is not a loop', () => {
    const log = new AttemptLog();
    log.record({ command: 'npm test', shell: 'bash', cwd: '/p', classification: CLASS.APPLICATION_ERROR, exitCode: 1 });
    log.record({ command: 'npm test', shell: 'bash', cwd: '/p', classification: CLASS.APPLICATION_ERROR, exitCode: 1 });
    log.record({ command: 'npm test', shell: 'bash', cwd: '/p', classification: CLASS.OK, exitCode: 0 });
    assert.deepStrictEqual(log.loops(), [], 'that is a fix, not a loop');
  });

  await test('ATTEMPT: the ledger is bounded — a long session cannot grow it without limit', () => {
    const { MAX_COMMANDS, MAX_ATTEMPTS_PER_COMMAND } = require('../../src/attempts');
    const log = new AttemptLog();
    for (let i = 0; i < MAX_COMMANDS + 20; i++) {
      log.record({ command: `c${i}`, shell: 'bash', cwd: '/p', classification: CLASS.OK, exitCode: 0 });
    }
    assert.ok(log.byCommand.size <= MAX_COMMANDS, `${log.byCommand.size} commands retained`);
    for (let i = 0; i < MAX_ATTEMPTS_PER_COMMAND + 20; i++) {
      log.record({ command: 'same', shell: 'bash', cwd: '/p', classification: CLASS.OK, exitCode: 0 });
    }
    assert.ok(log.priorFor('same').length <= MAX_ATTEMPTS_PER_COMMAND);
  });

  await test('ATTEMPT: two sessions never share a command history', () => {
    const { forSession } = require('../../src/attempts');
    const a = {};
    const b = {};
    forSession(a).record({ command: 'x', shell: 'bash', cwd: '/p', classification: CLASS.OK, exitCode: 0 });
    assert.strictEqual(forSession(b).priorFor('x').length, 0);
    assert.strictEqual(forSession(a), forSession(a), 'and one session has exactly one ledger');
  });

  // ------------------------------------------------------------- the cwd ----

  await test('CWD: a command runs where it was told to, without a cd in the command', () => {
    const path = require('path');
    const { resolveCwd } = require('../../src/tools/shell');
    const root = path.resolve(__dirname, '..', '..');
    const r = resolveCwd({ cwd: root }, { cwd: 'src' });
    assert.strictEqual(r.cwd, path.join(root, 'src'));
    assert.strictEqual(r.error, undefined);
  });

  await test('CWD: a directory that is not there is refused BEFORE anything is spawned', () => {
    // The alternative is a shell error about a path, which reads exactly like
    // the command being wrong.
    const { resolveCwd } = require('../../src/tools/shell');
    const r = resolveCwd({ cwd: process.cwd() }, { cwd: 'definitely-not-here-9271' });
    assert.match(r.error, /no such directory/);
    assert.strictEqual(r.cwd, undefined);
  });

  await test('CWD: no cwd given means the session directory, and nothing is mutated', () => {
    const { resolveCwd } = require('../../src/tools/shell');
    const before = process.cwd();
    assert.strictEqual(resolveCwd({ cwd: '/session/dir' }, {}).cwd, '/session/dir');
    assert.strictEqual(process.cwd(), before, 'the process directory is never changed');
  });

  // -------------------------------------------------------- shell identity --

  await test('SHELL: identity has exactly ONE owner, and the tools re-export it', () => {
    // Background jobs, the foreground tools and the environment summary must
    // resolve the same bash and spawn with the same prefix.
    const shellTools = require('../../src/tools/shell');
    assert.strictEqual(shellTools.findBash, execution.findBash);
    assert.strictEqual(shellTools.shellPrefix, execution.shellPrefix);
  });

  await test('SHELL: every shell LAIN names resolves to an executable and a prefix', () => {
    for (const s of execution.SHELLS) {
      const [file, prefix] = execution.shellPrefix(s);
      assert.ok(file && typeof file === 'string', `${s} has no executable`);
      assert.ok(Array.isArray(prefix) && prefix.length, `${s} has no argument prefix`);
    }
  });

  // ------------------------------------------------------ which powershell --

  /**
   * THE DEFECT, reported as "the && for the terminal kinda broken".
   *
   *     run_powershell  echo one && echo two
   *     -> The token '&&' is not a valid statement separator in this version.
   *
   * `powershell.exe` is Windows PowerShell 5.1, which has no `&&` and no `||`.
   * PowerShell 7 does, and installs as a DIFFERENT executable, `pwsh`. LAIN
   * spawned 5.1 by name on a machine with 7.6 on PATH, so a valid command came
   * back as a PARSE ERROR — which reads to a model as "my command was wrong".
   */
  await test('SHELL: PowerShell resolves to pwsh 7 when the machine has one', () => {
    const chosen = execution.findPowerShell();
    assert.ok(chosen && typeof chosen === 'string', 'something must be chosen');
    // The two are mutually exclusive, and `powerShellIsLegacy` is what every
    // other decision reads — so the two answers have to agree.
    const legacy = execution.powerShellIsLegacy();
    assert.strictEqual(legacy, /^powershell\.exe$/i.test(require('path').basename(chosen)),
      `"${chosen}" and legacy=${legacy} disagree`);
    if (!legacy) assert.match(chosen, /pwsh/i, 'a non-legacy choice is pwsh');
  });

  await test('SHELL: the && advice is only given when && is actually the problem', () => {
    // ---- WHY THIS IS CONDITIONAL ---------------------------------------
    //
    // The note used to be a flat sentence. Once LAIN resolves pwsh 7 the flat
    // sentence is FALSE on a 7.x host: `&&` works there, so a command that
    // failed for an unrelated reason would be handed an explanation blaming an
    // operator that was fine. A wrong explanation is worse than none — it sends
    // the next turn somewhere there is nothing to find.
    const v = execution.classify({
      exitCode: 1, shell: 'powershell', command: 'node build.js && node test.js',
      stderr: 'Error: cannot find module ./build', output: 'Error: cannot find module ./build',
    });
    if (execution.powerShellIsLegacy()) {
      assert.match(String(v.mismatch), /does not have it/,
        'on 5.1 the operator really is the problem and must be named');
    } else {
      assert.strictEqual(v.mismatch, null,
        'on pwsh 7 `&&` is valid — blaming it for an unrelated failure is a false statement');
    }
  });

  await test('SHELL LIVE: && and || really run under the PowerShell LAIN chose', async () => {
    // The end of the chain: not "the right file was chosen" but "the operator
    // the user reported works". Skipped rather than failed on a machine with
    // only 5.1, because there `&&` genuinely does not exist and the honest
    // report is the mismatch note asserted above.
    if (execution.powerShellIsLegacy()) return;
    const shell = require('../../src/tools/shell');
    const r = await shell.run('echo one && echo two', { shell: 'powershell', cwd: process.cwd(), timeoutMs: 30000 });
    assert.strictEqual(r.exitCode, 0, `&& must run: ${String(r.output).slice(0, 300)}`);
    assert.match(String(r.output), /one[\s\S]*two/, 'both halves must have run, in order');
    const f = await shell.run('cmd /c exit 1 || echo fallback', { shell: 'powershell', cwd: process.cwd(), timeoutMs: 30000 });
    assert.match(String(f.output), /fallback/, '|| must run too — it is the same 7.0 feature');
  });
};
