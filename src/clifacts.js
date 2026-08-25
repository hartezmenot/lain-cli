'use strict';

/**
 * THE CLI, CONFIGURATION AND DATA CONTRACT — and where they contradict
 * themselves.
 *
 * Two different jobs, in one file because they read the same sources:
 *
 *   FACTS          what the commands and tools accept, what the configuration
 *                  defaults to, where the data actually lives
 *   CONTRADICTIONS where the DOCUMENTATION of those things disagrees with the
 *                  IMPLEMENTATION of them
 *
 * The second is the more valuable half, and it is the reason this reads
 * declared schemas rather than prose. A flag documented in a command's `args`
 * string that appears nowhere in the code behind it is not a small tidiness
 * problem: it is a documented affordance that silently does nothing, and
 * anybody who reads the documentation and uses it is worse off than somebody
 * who did not read it at all.
 *
 * EVERY CHECK RESOLVES TO A REAL FILE. A parameter is looked for in the module
 * that actually defines the tool, found by searching for the tool's own name —
 * not in a guess at which file that might be, and not across the whole tree,
 * which would make every check pass.
 */

const fs = require('fs');
const path = require('path');

const F = require('./facts');
const { AREA, REPR, VIA } = F;
const F2 = require('./findings');
const { CONFIDENCE } = F2;

/** How many flags or params one report will list before it summarises. */
const MAX_LISTED = 12;

// ------------------------------------------------------------- resolution ---

/** Read a source file, or '' — a check that cannot read cannot accuse. */
function read(abs) {
  try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; }
}

/**
 * WHICH FILE DEFINES THIS TOOL.
 *
 * Found by looking for the tool's own name as a schema `name:` literal. That is
 * the one string guaranteed to be in the defining module and nowhere else, so
 * this resolves precisely rather than matching any file that mentions the tool.
 */
function moduleDefining(toolsDir, toolName) {
  let entries;
  try { entries = fs.readdirSync(toolsDir); } catch { return null; }
  for (const e of entries) {
    if (!e.endsWith('.js')) continue;
    const abs = path.join(toolsDir, e);
    const src = read(abs);
    if (src.includes(`name: '${toolName}'`) || src.includes(`name: "${toolName}"`)) {
      return { abs, rel: `src/tools/${e}`, src };
    }
  }
  return null;
}

/**
 * EVERY PLACE A COMMAND'S BEHAVIOUR CAN LIVE.
 *
 * Three of them, and missing the third produced a false accusation on the first
 * run of this checker: it reported that `/brief` documents `--gone`, `--removed`
 * and `--present` while nothing reads them. All three are parsed — in
 * `briefcommand.js`, which REGISTERS the command from its own file. The `run`
 * closure there calls a local helper rather than requiring anything, so
 * following `require('./x')` out of the run body found nothing, and a checker
 * that cannot see the implementation concluded there was none.
 *
 * So the file that DEFINES the command is resolved the same way a tool's is:
 * by looking for the registration itself. A checker that accuses working code
 * is worse than no checker.
 */
function moduleBehind(srcDir, cmd, name) {
  let body = '';
  try { body = String(cmd.run); } catch { body = ''; }
  const out = [{ rel: null, src: body }];
  const seen = new Set();

  // 1. Whatever the run body explicitly requires.
  for (const m of body.matchAll(/require\('\.\/([\w-]+)'\)/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const src = read(path.join(srcDir, `${m[1]}.js`));
    if (src) out.push({ rel: `src/${m[1]}.js`, src });
  }

  // 2. The file that calls define() for this command — where a command
  //    registered from its own module keeps its parsing.
  let entries;
  try { entries = fs.readdirSync(srcDir); } catch { entries = []; }
  const needle = `define('${name}'`;
  const needleAlt = `define("${name}"`;
  for (const e of entries) {
    if (!e.endsWith('.js')) continue;
    const stem = e.slice(0, -3);
    if (seen.has(stem)) continue;
    const src = read(path.join(srcDir, e));
    if (!src.includes(needle) && !src.includes(needleAlt)) continue;
    seen.add(stem);
    out.push({ rel: `src/${e}`, src });
  }
  return out;
}

// ------------------------------------------------------------- CLI facts ----

/**
 * What the tool surface actually accepts.
 *
 * Read from the ADVERTISED schemas — the same objects sent to the model — so a
 * fact here cannot describe a parameter the model was never offered.
 */
function toolFacts() {
  const out = [];
  let schemas = [];
  try { schemas = require('./tools').schemas(); } catch { schemas = []; }
  if (!schemas.length) {
    return [F.unknown({ area: AREA.CLI, name: 'Tool surface', why: 'the tool registry could not be read' })];
  }

  out.push(F.make({
    area: AREA.CLI,
    name: 'Tools advertised',
    value: String(schemas.length),
    confidence: CONFIDENCE.PROVEN,
    via: VIA.SCHEMA,
    evidence: 'tools.schemas() — the same list sent to the model',
    at: 'src/tools/index.js',
  }));

  // ---- THE PARAMETERS THAT ARE ACTUALLY REQUIRED -------------------------
  //
  // A model that knows which arguments are mandatory does not discover it by
  // making a call that is refused.
  const required = schemas
    .map((s) => {
      const req = (s.parameters && s.parameters.required) || [];
      return req.length ? `${s.name}(${req.join(', ')})` : null;
    })
    .filter(Boolean);
  if (required.length) {
    out.push(F.make({
      area: AREA.CLI,
      name: 'Required arguments',
      value: `${required.length} tools have mandatory parameters`,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.SCHEMA,
      examples: required.slice(0, 4),
      evidence: 'the `required` array of each advertised schema',
      at: 'src/tools/index.js',
    }));
  }

  // ---- WHICH TOOLS WRITE ------------------------------------------------
  let mutating = [];
  try {
    const tools = require('./tools');
    mutating = tools.names().filter((n) => tools.isMutating(n));
  } catch { mutating = []; }
  if (mutating.length) {
    out.push(F.make({
      area: AREA.CLI,
      name: 'Tools that mutate',
      value: `${mutating.length} of ${schemas.length}`,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.SCHEMA,
      examples: [mutating.slice(0, 6).join(', ')],
      evidence: 'tools.isMutating() — the same flag /undo uses to decide what to capture',
      at: 'src/tools/index.js',
      notes: 'Every mutating call is snapshotted first, so /undo can restore it.',
    }));
  }
  return out;
}

/** The slash commands, and the flags they document. */
function commandFacts() {
  const out = [];
  let registry = null;
  try { registry = require('./commands').REGISTRY; } catch { registry = null; }
  if (!registry) {
    return [F.unknown({ area: AREA.CLI, name: 'Commands', why: 'the command registry could not be read' })];
  }
  out.push(F.make({
    area: AREA.CLI,
    name: 'Slash commands',
    value: String(registry.size),
    confidence: CONFIDENCE.PROVEN,
    via: VIA.SCHEMA,
    examples: [[...registry.keys()].slice(0, 8).join(' ')],
    evidence: 'commands.REGISTRY — the one dispatch table',
    at: 'src/commands.js',
  }));
  return out;
}

// --------------------------------------------------------- configuration ----

/** Where configuration comes from, and which source wins. */
function configFacts() {
  const out = [];
  let cfg = null;
  try { cfg = require('./config'); } catch { cfg = null; }
  if (!cfg) return [F.unknown({ area: AREA.CONFIGURATION, name: 'Configuration', why: 'config.js could not be read' })];

  try {
    out.push(F.make({
      area: AREA.CONFIGURATION,
      name: 'Config file',
      value: cfg.configFile(),
      confidence: CONFIDENCE.PROVEN,
      via: VIA.EXECUTED,
      evidence: 'config.configFile() called in this process',
      at: 'src/config.js',
    }));
  } catch { /* a config home that cannot be resolved is reported below */ }

  // ---- THE OVERRIDE THAT OUTRANKS THE FILE ------------------------------
  out.push(F.make({
    area: AREA.CONFIGURATION,
    name: 'Config home override',
    value: 'LAIN_CONFIG_DIR',
    confidence: CONFIDENCE.PROVEN,
    via: VIA.SOURCE,
    examples: [process.env.LAIN_CONFIG_DIR ? `currently set: ${process.env.LAIN_CONFIG_DIR}` : 'currently unset'],
    evidence: 'config.configDir() reads it before falling back to the home directory',
    at: 'src/config.js',
    notes: 'The environment variable wins over the default location.',
  }));

  const defaults = cfg.DEFAULTS || {};
  const keys = Object.keys(defaults);
  if (keys.length) {
    out.push(F.make({
      area: AREA.CONFIGURATION,
      name: 'Defaults',
      value: `${keys.length} settings`,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.SOURCE,
      examples: keys.slice(0, 6).map((k) => `${k}=${JSON.stringify(defaults[k])}`),
      evidence: 'config.DEFAULTS',
      at: 'src/config.js',
    }));
  }
  return out;
}

/**
 * Every LAIN_* environment variable the tree actually reads.
 *
 * Discovered by scanning for the read, not from a list somebody maintains — a
 * maintained list is a second source of truth that goes stale silently.
 */
function envFacts(root) {
  const found = new Set();
  const walkDir = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walkDir(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      for (const m of read(p).matchAll(/process\.env\.(LAIN_[A-Z0-9_]+)/g)) found.add(m[1]);
    }
  };
  walkDir(path.join(root, 'src'));
  if (!found.size) return [];
  const names = [...found].sort();
  return [F.make({
    area: AREA.ENVIRONMENT,
    name: 'Environment overrides',
    value: `${names.length} LAIN_* variables are read`,
    confidence: CONFIDENCE.PROVEN,
    via: VIA.SOURCE,
    examples: names.slice(0, MAX_LISTED),
    evidence: 'scanned src/ for process.env.LAIN_* reads',
    notes: names.length > MAX_LISTED ? `${names.length - MAX_LISTED} more not listed.` : null,
  })];
}

// ------------------------------------------------------------------- type ---

/**
 * IS TYPE CHECKING IN FORCE HERE AT ALL?
 *
 * The fact that decides how much a green build is worth. In a project with no
 * type checker, changing a field from an int to a bool breaks every consumer
 * and NOTHING catches it — not the parser, not the tests unless one happens to
 * cover that path. Somebody who does not know that reads a passing build as
 * evidence the change was safe.
 *
 * So it is stated, in both directions. The area existed in the model with
 * nothing emitting into it, which is a declared vocabulary word that means
 * nothing — exactly the kind of gap this whole layer is supposed to close.
 */
function typeFacts(root) {
  // `localBin` lives in toolchain.js, which already owns "where is this
  // project's own copy of a tool" — asking the same question a second way here
  // is how the two come to disagree about which tsc would actually run.
  const { localBin } = require('./toolchain');
  const { onPath } = require('./tools/exec');
  const hasConfig = (name) => { try { return fs.existsSync(path.join(root, name)); } catch { return false; } };
  const hasTs = hasConfig('tsconfig.json') || hasConfig('jsconfig.json');
  const tsc = hasTs ? (localBin(root, 'tsc') || (onPath('tsc') ? 'tsc' : null)) : null;

  if (hasTs && tsc) {
    return [F.make({
      area: AREA.TYPE,
      name: 'Type checking',
      value: 'TypeScript (tsc)',
      confidence: CONFIDENCE.PROVEN,
      via: VIA.MANIFEST,
      evidence: 'tsconfig.json is present and tsc is installed here',
      at: 'tsconfig.json',
      notes: 'A type error is caught before anything runs, so a contract change shows up at build time.',
    })];
  }
  if (hasTs && !tsc) {
    return [F.make({
      area: AREA.TYPE,
      name: 'Type checking',
      value: 'configured but NOT RUNNING',
      confidence: CONFIDENCE.PROVEN,
      via: VIA.MANIFEST,
      evidence: 'tsconfig.json is present; tsc was not found in node_modules/.bin or on PATH',
      at: 'tsconfig.json',
      notes: 'Types are declared and nothing is checking them. A build passing says nothing about them.',
    })];
  }
  return [F.make({
    area: AREA.TYPE,
    name: 'Type checking',
    value: 'none',
    confidence: CONFIDENCE.PROVEN,
    via: VIA.FILESYSTEM,
    evidence: 'no tsconfig.json or jsconfig.json in this project',
    counterExample: 'do not read a passing build as evidence that a type or shape change is safe',
    notes: 'A change from int to bool, object to array, or a renamed field is caught only by a test that '
      + 'happens to cover that path — or by nothing at all.',
  })];
}

// ---------------------------------------------------------------- testing ---

function testFacts(root) {
  const out = [];
  let env = null;
  try { env = require('./environment').detect(root); } catch { env = null; }
  if (env && env.testRunner) {
    out.push(F.make({
      area: AREA.TESTING,
      name: 'Test command',
      value: env.testRunner.command,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.MANIFEST,
      evidence: `declared in ${env.testRunner.from}`,
      at: env.testRunner.from,
    }));
  } else {
    out.push(F.unknown({
      area: AREA.TESTING,
      name: 'Test command',
      why: 'no manifest in this project declares one',
    }));
  }
  if (env && env.packageManager) {
    out.push(F.make({
      area: AREA.BUILD,
      name: 'Package manager',
      value: env.packageManager.manager,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.MANIFEST,
      evidence: `the lockfile ${env.packageManager.from} is that manager's artifact`,
      at: env.packageManager.from,
      notes: env.packageManager.missing
        ? 'NOT installed on this machine, though the lockfile says the project uses it.'
        : 'Running a different one would write a second, competing lockfile.',
    }));
  }
  return out;
}

// ------------------------------------------------------- contradictions -----

/**
 * DOCUMENTED, BUT NOT IMPLEMENTED.
 *
 * For each advertised tool schema, every declared parameter is looked for in
 * the module that defines that tool. A parameter the model is told it may send,
 * which the code behind it never reads, is a documented affordance that does
 * nothing — and the model has no way to discover that except by using it and
 * getting a result that quietly ignored it.
 *
 * DELIBERATELY CONSERVATIVE. The whole module is searched, not just the `run`
 * function, because a parameter is often consumed by a helper beside it. That
 * under-reports — a parameter mentioned only in a comment counts as present —
 * and under-reporting is the correct direction: a false accusation here sends
 * somebody to read code that was fine.
 */
function schemaContradictions(root, { schemas: injected = null } = {}) {
  const out = [];
  const toolsDir = path.join(root, 'src', 'tools');
  if (!fs.existsSync(toolsDir)) return out;
  // Injectable so the checker can be tested against a KNOWN contradiction. A
  // detector only ever exercised on a clean tree is a detector that has been
  // shown to stay quiet, which is half of what it needs to do.
  let schemas = injected;
  if (!schemas) {
    try { schemas = require('./tools').schemas(); } catch { return out; }
  }

  for (const s of schemas) {
    const props = (s.parameters && s.parameters.properties) || {};
    const names = Object.keys(props);
    if (!names.length) continue;
    const mod = moduleDefining(toolsDir, s.name);
    if (!mod) continue;                       // cannot resolve it, so cannot accuse it
    const orphans = names.filter((n) => !mod.src.includes(n));
    if (!orphans.length) continue;
    out.push(F2.make({
      category: F2.CATEGORY.CONTRACT,
      severity: F2.SEVERITY.WARNING,
      confidence: F2.CONFIDENCE.PROVEN,
      source: F2.SOURCE.STATIC_ANALYSIS,
      file: mod.rel,
      symbol: s.name,
      actual: `documented: ${orphans.join(', ')}`,
      expected: 'read somewhere in the defining module',
      message: `${s.name} advertises ${orphans.length} parameter(s) that never appear in ${mod.rel}: `
        + `${orphans.join(', ')}.`,
      explanation: 'The schema is what the model is told it may send. A parameter named there and absent from '
        + 'the implementation is accepted and then ignored, which is indistinguishable from it having worked.',
      risk: 'A caller supplies the parameter, observes no error, and concludes it took effect.',
      evidence: `searched ${mod.rel} for each name declared in the advertised schema`,
    }));
  }
  return out;
}

/**
 * FLAGS A COMMAND DOCUMENTS AND DOES NOT READ.
 *
 * The `args` string is the command's own documentation, shown by `/help`. Each
 * `--flag` in it is looked for in the command's `run` source and in whichever
 * module that run delegates to.
 */
function commandContradictions(root, { registry: injected = null } = {}) {
  const out = [];
  let registry = injected;
  if (!registry) {
    try { registry = require('./commands').REGISTRY; } catch { return out; }
  }
  const srcDir = path.join(root, 'src');
  if (!fs.existsSync(srcDir)) return out;

  for (const [name, cmd] of registry) {
    const flags = [...String(cmd.args || '').matchAll(/--([a-z][\w-]*)/g)].map((m) => m[1]);
    if (!flags.length) continue;
    const sources = moduleBehind(srcDir, cmd, name);
    const haystack = sources.map((s) => s.src).join('\n');
    const orphans = [...new Set(flags)].filter((f) => !haystack.includes(f));
    if (!orphans.length) continue;
    out.push(F2.make({
      category: F2.CATEGORY.CONTRACT,
      severity: F2.SEVERITY.WARNING,
      confidence: F2.CONFIDENCE.PROVEN,
      source: F2.SOURCE.STATIC_ANALYSIS,
      file: (sources.find((s) => s.rel) || {}).rel || 'src/commands.js',
      symbol: name,
      actual: `documented: --${orphans.join(', --')}`,
      expected: 'parsed by the command',
      message: `${name} documents --${orphans.join(', --')} in its usage string, and nothing behind it reads `
        + `${orphans.length > 1 ? 'those names' : 'that name'}.`,
      explanation: 'The usage string is what /help shows. A flag advertised there and never parsed is accepted '
        + 'silently and does nothing.',
      evidence: "searched the command's run source and the module it delegates to",
    }));
  }
  return out;
}

/** Everything this module establishes: facts first, contradictions separately. */
function discover(root) {
  return {
    facts: [
      ...toolFacts(),
      ...commandFacts(),
      ...configFacts(),
      ...envFacts(root),
      ...typeFacts(root),
      ...testFacts(root),
    ],
    contradictions: [
      ...schemaContradictions(root),
      ...commandContradictions(root),
    ],
  };
}

module.exports = {
  discover, toolFacts, commandFacts, configFacts, envFacts, testFacts, typeFacts,
  schemaContradictions, commandContradictions, moduleDefining, moduleBehind,
};
