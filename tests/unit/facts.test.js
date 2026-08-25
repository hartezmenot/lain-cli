'use strict';

/**
 * THE OPERATIONAL CONTRACT — the facts a model must not have to rediscover.
 *
 * Every test here stands for a specific way a session gets burned: sending hex
 * to a field that wanted a decimal number, opening an editor at the wrong line
 * because nobody said what 183 counts from, writing `&&` into a shell that has
 * no such operator.
 *
 * TWO PROPERTIES MATTER MORE THAN THE INDIVIDUAL FACTS.
 *
 *   A fact that IS established must be stated, with its evidence.
 *   A fact that is NOT established must say UNKNOWN, and must never be filled
 *   in with the likely answer.
 *
 * The second is the one under real pressure: a plausible wrong fact is far
 * worse than an absent one, because an absent fact makes somebody look and a
 * wrong one makes them confidently not look.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const F = require('../../src/facts');
const contracts = require('../../src/contracts');
const clifacts = require('../../src/clifacts');
const probefacts = require('../../src/probefacts');
const datafacts = require('../../src/datafacts');
const F2 = require('../../src/findings');

const ROOT = path.join(__dirname, '..', '..');

/** Find one fact by name from a list. */
function byName(facts, name) {
  return facts.find((f) => f.name === name) || null;
}

function project(files) {
  const dir = tmpdir('lain-facts-');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

module.exports = async function () {
  // ------------------------------------------------------------- the model --

  await test('FACT: UNKNOWN and UNVERIFIED travel together and cannot come apart', () => {
    // A fact cannot be UNKNOWN and confident, and cannot claim a value it did
    // not establish. Forcing the pair in the constructor means no discoverer
    // can produce that combination by accident.
    const f = F.make({ area: F.AREA.PROBE, name: 'x', value: F.REPR.UNKNOWN, confidence: F2.CONFIDENCE.PROVEN });
    assert.strictEqual(f.confidence, F2.CONFIDENCE.UNVERIFIED,
      'a confident UNKNOWN is a contradiction and must not be constructible');
  });

  await test('FACT: an unknown fact is rendered as loudly as a known one, and says why', () => {
    const f = F.unknown({ area: F.AREA.PROBE, name: 'Offset representation', why: 'it belongs to the Probe' });
    const line = F.line(f);
    assert.match(line, /UNKNOWN/);
    assert.match(line, /belongs to the Probe/, 'hiding the reason is how somebody guesses instead');
  });

  await test('FACT: a long name is not welded to its value', () => {
    const f = F.make({ area: F.AREA.PROBE, name: 'Target naming and authorization', value: 'x' });
    assert.match(F.line(f), /authorization: x/, 'there must be a space between the label and the value');
  });

  await test('LEDGER: ids are stable, and a value that CHANGES is reported', () => {
    // A convention answering differently is not a new fact — it is the same
    // one disagreeing with itself, which is either a real migration or an
    // unstable reading. Silently overwriting it hides both.
    const l = new F.FactLedger();
    const a = l.record([F.make({ area: F.AREA.SHELL, name: 'Default shell', value: 'powershell' })]);
    const id = a.facts[0].id;
    const b = l.record([F.make({ area: F.AREA.SHELL, name: 'Default shell', value: 'bash' })]);
    assert.strictEqual(b.facts[0].id, id, 'the same convention keeps its id');
    assert.strictEqual(b.changed.length, 1);
    assert.strictEqual(b.changed[0].was, 'powershell');
  });

  // --------------------------------------------- source location numbering --

  await test('CONTRACT: line numbering is MEASURED, not read off the source', () => {
    // Reading `return lo + 1` and writing down "1-based" is a reading, and
    // readings go stale. This runs the code and records what came back.
    const facts = contracts.sourceLocationFacts();
    const lines = byName(facts, 'Line numbers');
    assert.ok(lines, 'the fact must exist');
    assert.strictEqual(lines.value, F.REPR.ONE_BASED);
    assert.strictEqual(lines.via, F.VIA.EXECUTED, 'the evidence must be a measurement');
    assert.strictEqual(lines.confidence, F2.CONFIDENCE.PROVEN);
  });

  await test('CONTRACT: byte offsets are 0-based and ranges end exclusive', () => {
    // These three numbers are not the same numbering, and treating them as
    // interchangeable is how a symbol edit takes a neighbouring line with it.
    const facts = contracts.sourceLocationFacts();
    assert.strictEqual(byName(facts, 'Byte offsets').value, F.REPR.ZERO_BASED);
    assert.strictEqual(byName(facts, 'Range end').value, F.REPR.EXCLUSIVE);
  });

  await test('CONTRACT: columns are NOT claimed, because LAIN does not produce them', () => {
    // Inventing a project-wide column base would be a fact nobody measured.
    const col = byName(contracts.sourceLocationFacts(), 'Columns');
    assert.ok(col);
    assert.match(col.value, /external analysers/);
  });

  // ------------------------------------------------------------ the shell --

  await test('CONTRACT: the shell is resolved against the machine, not assumed', () => {
    const facts = contracts.shellFacts(ROOT);
    const shell = byName(facts, 'Default shell');
    assert.ok(shell);
    assert.strictEqual(shell.via, F.VIA.EXECUTED);
    assert.match(shell.examples.join(' '), /spawns /, 'it must name the executable that would actually run');
  });

  await test('CONTRACT: on PowerShell the separator fact carries the && counter-example', () => {
    // The single most expensive guess in the tool surface, answered BEFORE a
    // command is written rather than after one fails.
    if (process.platform !== 'win32') return;                 // self-skipping
    const sep = byName(contracts.shellFacts(ROOT), 'Command separator');
    if (!sep) return;                                          // a host whose default is bash
    assert.match(sep.value, /;/);
    assert.match(sep.counterExample, /&&/);
    assert.match(sep.counterExample, /PowerShell 7|pwsh/, 'it must say where && does exist');
  });

  await test('CONTRACT: changing directory is a parameter, proved from the advertised schema', () => {
    const cwd = byName(contracts.pathFacts(ROOT, ROOT), 'Changing directory');
    assert.ok(cwd);
    assert.strictEqual(cwd.value, 'pass cwd as a tool parameter');
    assert.match(cwd.counterExample, /cd /, 'the thing not to do must be named');
    assert.strictEqual(cwd.via, F.VIA.SCHEMA);
  });

  await test('CONTRACT: findings report forward-slashed relative paths on every platform', () => {
    const p = byName(contracts.pathFacts(ROOT, ROOT), 'Paths reported by findings');
    assert.match(p.value, /forward slashes/);
  });

  // ------------------------------------------------------------ the Probe --

  await test('PROBE: with no Probe connected the contract is UNKNOWN, not invented', () => {
    // The Probe's source is not in this tree. Writing its parameter list down
    // here is the drift defect probeskill.js already refuses.
    const facts = probefacts.discover(ROOT);
    const contract = byName(facts, 'Probe contract');
    if (!contract) return;                       // a Probe is connected in this process
    assert.strictEqual(contract.value, F.REPR.UNKNOWN);
    assert.match(contract.why, /\/mcp probe/, 'it must say how to get the answer');
  });

  await test('PROBE: PID is decimal and an address is a hex STRING — proved by JSON grammar', () => {
    // Not a recollection: `1234` is a JSON number and the JSON grammar has no
    // hexadecimal literal, so a PID sent as a number is necessarily decimal.
    // `"0x1abc"` is a quoted string. Different representation AND different
    // type, so the two can never be interchangeable.
    // THE PROBE TOOL IS ONLY ADVERTISED WHILE ONE IS CONNECTED, so a plain
    // call here would take the UNKNOWN branch and the PROVEN path — the one
    // that matters — would never be asserted. A connection is simulated so the
    // schema is offered; nothing is sent anywhere.
    const probeMod = require('../../src/probe');
    const realLive = probeMod.live;
    probeMod.live = () => ({ capabilities: [{ name: 'process.attach' }, { name: 'memory.read' }] });
    let facts;
    try { facts = probefacts.representationFacts(); } finally { probeMod.live = realLive; }
    const pid = byName(facts, 'PID');
    const addr = byName(facts, 'Memory address');
    assert.ok(pid && addr);
    assert.notStrictEqual(pid.value, F.REPR.UNKNOWN, 'with the schema advertised this must be established');
    assert.strictEqual(pid.confidence, F2.CONFIDENCE.PROVEN);
    assert.match(pid.evidence, /JSON number cannot be hexadecimal|cannot be hexadecimal/,
      'the proof is the JSON grammar, and must be stated as the evidence');
    assert.match(pid.value, /decimal/);
    assert.match(pid.counterExample, /0x/, 'the hex form must be named as the thing NOT to send');
    assert.match(addr.value, /hexadecimal/);
    assert.match(addr.examples.join(' '), /0x/);
    assert.notStrictEqual(pid.value, addr.value, 'a PID and an address are not the same representation');
  });

  await test('PROBE: what the Probe owns is UNKNOWN and names the call that answers it', () => {
    const facts = probefacts.representationFacts();
    const offset = byName(facts, 'Offset representation');
    assert.ok(offset);
    assert.strictEqual(offset.value, F.REPR.UNKNOWN);
    assert.match(offset.why, /capabilities/, 'the exact discovery call must be named');
    assert.match(offset.why, /do not generalise|not generalise/i,
      'it must say the PID and address facts do NOT extend to this');
  });

  // ------------------------------------------------------- contradictions --

  await test('CONTRADICTION: a documented tool parameter nothing reads is reported', () => {
    // The valuable half. A parameter the model is told it may send, which the
    // code never reads, is accepted and then ignored — indistinguishable from
    // having worked.
    const found = clifacts.schemaContradictions(ROOT, {
      schemas: [{
        name: 'apply_patch',                       // a real tool, so the module resolves
        parameters: { type: 'object', properties: { path: {}, expect: {}, totally_invented_param: {} } },
      }],
    });
    assert.strictEqual(found.length, 1, 'the invented parameter must be caught');
    assert.match(found[0].message, /totally_invented_param/);
    assert.strictEqual(found[0].category, F2.CATEGORY.CONTRACT);
    assert.strictEqual(found[0].confidence, F2.CONFIDENCE.PROVEN);
  });

  await test('CONTRADICTION: a command flag nothing parses is reported', () => {
    const registry = new Map([['/fake', { args: '[--never-parsed-flag]', run() { return null; } }]]);
    const found = clifacts.commandContradictions(ROOT, { registry });
    assert.strictEqual(found.length, 1);
    assert.match(found[0].message, /never-parsed-flag/);
  });

  await test('CONTRADICTION: this repository is clean, and the checker says so', () => {
    // A detector only ever exercised on a broken fixture has been shown to
    // fire. Silence on working code is the other half, and the harder one.
    const r = clifacts.discover(ROOT);
    assert.deepStrictEqual(r.contradictions.map((c) => c.message), [],
      'the checker accused working code');
  });

  await test('CONTRADICTION: a command registered from its own module is not falsely accused', () => {
    // The first run of this checker reported that /brief documents --gone,
    // --removed and --present while nothing reads them. All three are parsed,
    // in briefcommand.js, which REGISTERS the command from its own file — so
    // following require() out of the run body found nothing.
    const { REGISTRY } = require('../../src/commands');
    const brief = REGISTRY.get('/brief');
    assert.ok(brief, '/brief must exist');
    const sources = clifacts.moduleBehind(path.join(ROOT, 'src'), brief, '/brief');
    const haystack = sources.map((s) => s.src).join('\n');
    for (const flag of ['gone', 'removed', 'present']) {
      assert.ok(haystack.includes(flag), `${flag} must be found in the module that defines the command`);
    }
  });

  // ---------------------------------------------------------------- data ---

  await test('DATA: an embedded dataset beside a matching JSON file is reported', () => {
    // Two sources of truth. Both work, so no test fails, and the next edit
    // lands on whichever one the editor happened to open.
    const dir = project({
      'src/enemies.js': "'use strict';\nconst ENEMIES = { slime: { hp: 10 }, wolf: { hp: 30 }, "
        + 'bat: { hp: 6 }, drake: { hp: 90 } };\nmodule.exports = { ENEMIES };\n',
      'src/enemies.json': '{ "slime": { "hp": 10 }, "wolf": { "hp": 30 }, "bat": { "hp": 6 }, "drake": { "hp": 90 } }',
    });
    const r = datafacts.discover(dir);
    assert.strictEqual(r.findings.length, 1, 'the duplicate source of truth must be found');
    assert.match(r.findings[0].message, /ENEMIES/);
    assert.strictEqual(r.findings[0].confidence, F2.CONFIDENCE.INFERRED,
      'that the two hold the SAME data is inferred from their names, and must not claim to be proven');
  });

  await test('DATA: an ordinary literal with no matching JSON is left alone', () => {
    // Most object literals are configuration, defaults and vocabulary.
    // Flagging them would bury the one that matters.
    const dir = project({
      'src/colours.js': "'use strict';\nconst COLOURS = { red: 1, green: 2, blue: 3, black: 4 };\n"
        + 'module.exports = { COLOURS };\n',
      'src/enemies.json': '{ "slime": 1 }',
    });
    assert.deepStrictEqual(datafacts.discover(dir).findings, []);
  });

  await test('DATA: members are counted from tokens, so formatting does not matter', () => {
    // A line-based count scored a compact one-line table as ONE entry, and the
    // exact shape this exists to catch was missed entirely.
    assert.strictEqual(datafacts.topLevelMembers('{ slime: { hp: 10 }, wolf: { hp: 30 } }'), 2);
    assert.strictEqual(datafacts.topLevelMembers('{\n a: 1,\n b: 2,\n c: 3\n}'), 3);
    assert.strictEqual(datafacts.topLevelMembers('{ a: "x,y,z" }'), 1, 'a comma in a string is not a member');
    assert.strictEqual(datafacts.topLevelMembers('{}'), 0);
  });

  await test('DATA: this repository has no duplicate source of truth', () => {
    assert.deepStrictEqual(datafacts.discover(ROOT).findings.map((f) => f.message), []);
  });

  // ------------------------------------------------- facts are not findings --

  await test('SEPARATION: facts and findings stay apart all the way through', () => {
    // "The PID argument is decimal" is a FACT. "Something passed hex to --pid"
    // is a FINDING. Filing them together loses the difference between how the
    // project works and what is wrong with it.
    const r = clifacts.discover(ROOT);
    assert.ok(Array.isArray(r.facts) && Array.isArray(r.contradictions));
    for (const f of r.facts) assert.ok(f.area && 'value' in f, 'a fact has an area and a value');
    for (const c of r.contradictions) assert.ok(c.severity && c.category, 'a finding has a severity and a category');
  });
};
