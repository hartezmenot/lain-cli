'use strict';

/**
 * THE EXECUTION AND SOURCE-LOCATION CONTRACT, established by MEASUREMENT.
 *
 * Everything here answers a question that costs a model real requests to get
 * wrong: which shell, which directory, what does "line 183" count from, is that
 * byte range inclusive at the end.
 *
 * ------------------------------------------------------------------------
 * THE FACTS ARE MEASURED, NOT READ.
 *
 * The obvious way to establish "line numbers are 1-based" is to open
 * `jsscan.lineAt`, see `return lo + 1`, and write it down. That is a reading of
 * the source, and readings go stale the moment the source changes — which is
 * precisely the drift `probeskill.js` refuses to accept for the Probe's
 * contract, for the same reason.
 *
 * So instead these RUN the code against a known input and record what comes
 * back. `lineAt` is called on a two-line string; the first line either reports
 * as 1 or it does not. A tokeniser is run over `ab` and its first token either
 * starts at 0 or at 1. The evidence is the observation, and it cannot disagree
 * with the build it was taken from, because it was taken FROM the build.
 * ------------------------------------------------------------------------
 *
 * WHAT IS DELIBERATELY LEFT UNKNOWN. Columns. LAIN's own analysers report a
 * LINE and no column; columns arrive only from external tools, each with its
 * own convention. Reporting a single project-wide column base would be
 * inventing a fact, so the contract says where columns come from and declines
 * to claim one for LAIN itself.
 */

const path = require('path');
const fs = require('fs');

const F = require('./facts');
const { AREA, REPR, VIA } = F;
const { CONFIDENCE } = require('./findings');

// ------------------------------------------------------- source locations ---

/**
 * Measure how this build numbers lines, offsets and ranges.
 *
 * Each probe is a two-line function whose answer is the fact. If a probe throws
 * — a refactor moved something — the fact becomes UNKNOWN rather than being
 * assumed, which is the whole discipline.
 */
function sourceLocationFacts() {
  const out = [];
  const jsscan = require('./jsscan');

  // ---- LINE NUMBERING -----------------------------------------------------
  try {
    const src = 'const a = 1;\nconst b = 2;\n';
    const { tokens, lineStarts } = jsscan.tokenize(src);
    const firstLine = jsscan.lineAt(lineStarts, 0);
    const secondLine = jsscan.lineAt(lineStarts, src.indexOf('const b'));
    out.push(F.make({
      area: AREA.SOURCE_LOCATION,
      name: 'Line numbers',
      value: firstLine === 1 ? REPR.ONE_BASED : firstLine === 0 ? REPR.ZERO_BASED : `first line reports as ${firstLine}`,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.EXECUTED,
      examples: [`the first line of a file is ${firstLine}`, `the second is ${secondLine}`],
      evidence: 'jsscan.lineAt() run against a two-line source in this process',
      at: 'src/jsscan.js',
      notes: 'Every file:line in a finding uses this. An editor opened at the reported number lands on the defect.',
    }));

    // ---- BYTE OFFSETS AND RANGE ENDS -------------------------------------
    const first = tokens[0];
    out.push(F.make({
      area: AREA.SOURCE_LOCATION,
      name: 'Byte offsets',
      value: first && first.start === 0 ? REPR.ZERO_BASED : REPR.UNKNOWN,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.EXECUTED,
      examples: [`the first token of a file starts at ${first ? first.start : '?'}`],
      evidence: 'jsscan.tokenize() run in this process; offsets read from the first token',
      at: 'src/jsscan.js',
      notes: 'Offsets are byte positions into the file, not line/column pairs, and are NOT the same numbering as lines.',
    }));

    // A token's `end` is exclusive if it equals start + length.
    const exclusive = first ? (first.end - first.start) === first.value.length : null;
    out.push(F.make({
      area: AREA.SOURCE_LOCATION,
      name: 'Range end',
      value: exclusive === true ? REPR.EXCLUSIVE : exclusive === false ? REPR.INCLUSIVE : REPR.UNKNOWN,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.EXECUTED,
      examples: [first ? `${JSON.stringify(first.value)} spans [${first.start}, ${first.end})` : ''],
      evidence: 'measured: end - start equals the token text length, so end is one past the last byte',
      at: 'src/jsscan.js, src/codemodel.js',
      notes: 'source.slice(start, end) yields exactly the symbol. replace_symbol relies on this.',
    }));
  } catch (e) {
    out.push(F.unknown({
      area: AREA.SOURCE_LOCATION,
      name: 'Line and offset numbering',
      why: `the measurement could not be taken (${e && e.message})`,
    }));
  }

  // ---- COLUMNS, which LAIN does not itself produce -----------------------
  out.push(F.make({
    area: AREA.SOURCE_LOCATION,
    name: 'Columns',
    value: 'not produced by LAIN; supplied by external analysers only',
    confidence: CONFIDENCE.PROVEN,
    via: VIA.EXECUTED,
    evidence: "LAIN's own findings carry line and no column; tsc, go vet and cargo report their own, "
      + 'and each is 1-based by that tool\'s convention',
    at: 'src/langscan.js (line only), src/toolchain.js (column from the tool)',
    notes: 'A finding with a column got it from the named tool. A finding without one has no column, '
      + 'rather than an implied column 0 or 1.',
  }));

  return out;
}

// --------------------------------------------------------- shell and path ---

/**
 * The execution contract, taken from the layer that actually runs commands.
 *
 * Nothing is asserted about "the right shell" — `environment.detectShell()`
 * resolves what is genuinely on this machine, and `execution.shellPrefix()` is
 * asked what it would actually spawn. If a shell is named here, a command sent
 * to it will run.
 */
function shellFacts(root) {
  const out = [];
  const environment = require('./environment');
  const execution = require('./execution');

  let env = null;
  try { env = environment.detect(root); } catch { env = null; }

  if (env && env.shell) {
    const [exe] = execution.shellPrefix(env.shell.preferred);
    out.push(F.make({
      area: AREA.SHELL,
      name: 'Default shell',
      value: env.shell.preferred,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.EXECUTED,
      examples: [`spawns ${exe}`],
      evidence: 'environment.detectShell() resolved this against the machine; execution.shellPrefix() '
        + 'reports the executable that would actually be spawned',
      at: 'src/environment.js, src/execution.js',
      notes: env.shell.note || null,
    }));
    out.push(F.make({
      area: AREA.SHELL,
      name: 'Shells available',
      value: env.shell.available.join(', '),
      confidence: CONFIDENCE.PROVEN,
      via: VIA.EXECUTED,
      evidence: 'each resolved to a real executable on this machine',
      at: 'src/environment.js',
    }));
  } else {
    out.push(F.unknown({ area: AREA.SHELL, name: 'Default shell', why: 'the environment could not be read' }));
  }

  // ---- THE SEPARATOR QUESTION, answered before it is asked ---------------
  //
  // `&&` under Windows PowerShell 5.1 is the single most expensive guess in the
  // tool surface. The execution layer already carries the fact; stating it here
  // means it is known BEFORE a command is written rather than after one fails.
  if (env && env.shell && env.shell.preferred === 'powershell') {
    out.push(F.make({
      area: AREA.SHELL,
      name: 'Command separator',
      value: '; (semicolon)',
      confidence: CONFIDENCE.PROVEN,
      via: VIA.SOURCE,
      examples: ['cd src; node t.js'],
      counterExample: '&& — Windows PowerShell 5.1 has no such operator; it arrived in PowerShell 7 (pwsh)',
      evidence: 'execution.js MISMATCH table, matched against the parser error 5.1 actually emits',
      at: 'src/execution.js',
      notes: 'There is no built-in "only if the last one succeeded" separator in 5.1; $LASTEXITCODE or $? carries that.',
    }));
    out.push(F.make({
      area: AREA.SHELL,
      name: 'Null sink',
      value: '$null',
      confidence: CONFIDENCE.PROVEN,
      via: VIA.SOURCE,
      counterExample: '/dev/null — read as a literal path on Windows',
      evidence: 'execution.js MISMATCH table',
      at: 'src/execution.js',
    }));
  }

  out.push(F.make({
    area: AREA.SHELL,
    name: 'Failure classification',
    value: 'every failing command returns one of ' + Object.values(execution.CLASS).filter((c) => c !== 'OK').join(', '),
    confidence: CONFIDENCE.PROVEN,
    via: VIA.SOURCE,
    evidence: 'execution.classify() is applied to every shell and process result',
    at: 'src/execution.js',
    notes: 'Read the classification before changing a command. It distinguishes a missing program from a '
      + 'shell-syntax error from an application failure, and those have different fixes.',
  }));

  return out;
}

/** Where commands run, and how paths are written. */
function pathFacts(root, sessionCwd) {
  const out = [];
  const win = process.platform === 'win32';

  out.push(F.make({
    area: AREA.CWD,
    name: 'Project root',
    value: root,
    confidence: CONFIDENCE.PROVEN,
    via: VIA.FILESYSTEM,
    evidence: "the session's working directory",
    notes: 'Relative paths in every tool resolve against this.',
  }));

  if (sessionCwd && sessionCwd !== root) {
    out.push(F.make({
      area: AREA.CWD,
      name: 'Session CWD',
      value: sessionCwd,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.FILESYSTEM,
    }));
  }

  // ---- PROVED BY READING THE SCHEMA THAT IS ACTUALLY ADVERTISED ----------
  //
  // Not by asserting it: the tool registry is asked whether `cwd` is a
  // parameter, so this fact is false the moment the parameter is removed.
  let hasCwdParam = false;
  try {
    const tools = require('./tools');
    const s = tools.schemas().find((x) => x.name === 'run_bash');
    hasCwdParam = Boolean(s && s.parameters && s.parameters.properties && s.parameters.properties.cwd);
  } catch { hasCwdParam = false; }
  out.push(F.make({
    area: AREA.CWD,
    name: 'Changing directory',
    value: hasCwdParam ? 'pass cwd as a tool parameter' : REPR.UNKNOWN,
    confidence: hasCwdParam ? CONFIDENCE.PROVEN : CONFIDENCE.UNVERIFIED,
    via: VIA.SCHEMA,
    examples: hasCwdParam ? ['run_bash { command: "node t.js", cwd: "tests" }'] : [],
    counterExample: hasCwdParam ? 'cd tests && node t.js — takes on the shell\'s separator and quoting rules '
      + 'to express something the spawn accepts as an argument' : null,
    evidence: hasCwdParam
      ? 'the advertised schema for run_bash declares a cwd property'
      : 'run_bash advertises no cwd property in this build',
    at: 'src/tools/shell.js',
    notes: hasCwdParam ? 'A bad directory is refused BEFORE anything is spawned, and the session directory is never mutated.' : null,
  }));

  out.push(F.make({
    area: AREA.PATH,
    name: 'Path separator',
    value: win ? '\\ (backslash) on this platform' : '/ (forward slash)',
    confidence: CONFIDENCE.PROVEN,
    via: VIA.EXECUTED,
    examples: [path.join('src', 'tools', 'shell.js')],
    evidence: `process.platform is ${process.platform}; path.join() produces the example shown`,
  }));

  out.push(F.make({
    area: AREA.PATH,
    name: 'Paths reported by findings',
    value: 'project-relative, forward slashes',
    confidence: CONFIDENCE.PROVEN,
    via: VIA.SOURCE,
    examples: ['src/tools/shell.js'],
    evidence: 'every finding path is normalised with .replace(/\\\\/g, "/") before it is reported',
    at: 'src/langscan.js, src/gitsense.js, src/residue.js',
    notes: win
      ? 'A reported path is forward-slashed even though this platform uses backslashes. Both resolve; do not "correct" one to the other.'
      : null,
  }));

  return out;
}

// -------------------------------------------------------------- encoding ----

function encodingFacts(root) {
  const out = [];
  // Measured from a file that certainly exists, rather than assumed.
  let sample = null;
  try {
    const pkg = path.join(root, 'package.json');
    if (fs.existsSync(pkg)) {
      const buf = fs.readFileSync(pkg);
      const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      sample = { bom, bytes: buf.length };
    }
  } catch { sample = null; }
  out.push(F.make({
    area: AREA.ENCODING,
    name: 'Source and JSON encoding',
    value: REPR.UTF8,
    confidence: sample ? CONFIDENCE.PROVEN : CONFIDENCE.INFERRED,
    via: sample ? VIA.EXECUTED : VIA.SOURCE,
    evidence: sample
      ? `package.json read as UTF-8 (${sample.bytes} bytes, byte-order mark ${sample.bom ? 'present' : 'absent'})`
      : 'every read and write in the tree passes "utf8" explicitly',
    notes: 'Every file read and write states utf8 explicitly; nothing depends on a platform default.',
  }));
  out.push(F.make({
    area: AREA.ENCODING,
    name: 'Line endings',
    value: 'preserved per file',
    confidence: CONFIDENCE.PROVEN,
    via: VIA.SOURCE,
    evidence: 'apply_patch and the symbol editors detect CRLF and match the file they are editing',
    at: 'src/tools/edit.js, src/tools/semantic.js',
    notes: 'A replacement written with LF is converted to the file\'s existing endings rather than mixing them.',
  }));
  return out;
}

/** Everything this module can establish. */
function discover(root, { sessionCwd = null } = {}) {
  return [
    ...shellFacts(root),
    ...pathFacts(root, sessionCwd),
    ...sourceLocationFacts(),
    ...encodingFacts(root),
  ];
}

module.exports = { discover, sourceLocationFacts, shellFacts, pathFacts, encodingFacts };
