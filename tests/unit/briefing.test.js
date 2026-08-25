'use strict';

/**
 * THE ENGINEERING BRIEFING — findings, health axes, lifecycle, root causes.
 *
 * The properties under test here are the ones that make the briefing worth
 * trusting rather than merely long:
 *
 *   · a passing build cannot make the other axes pass
 *   · "nobody looked" can never be rounded up to "it is fine"
 *   · an id survives the report being regenerated
 *   · a finding that vanished because its analyser was skipped is NOT fixed
 *
 * The last one is the whole reason the lifecycle has two states instead of one.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const F = require('../../src/findings');
const survey = require('../../src/survey');
const rootcause = require('../../src/rootcause');
const briefing = require('../../src/briefing');
const briefcommand = require('../../src/briefcommand');
const langscan = require('../../src/langscan');
const toolchain = require('../../src/toolchain');

const { HEALTH } = survey;

/** A finding with the fields a test cares about and defaults elsewhere. */
function f(over = {}) {
  return F.make({
    category: F.CATEGORY.SYNTAX,
    severity: F.SEVERITY.ERROR,
    source: F.SOURCE.PARSER,
    message: 'something',
    ...over,
  });
}

function project(files) {
  const dir = tmpdir('lain-brief-');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

module.exports = async function () {
  // ------------------------------------------------------------ vocabulary --

  await test('FINDING: an id is keyed on the finding, NOT on its line', () => {
    // Adding an import at the top of a file shifts every line beneath it. If
    // ids moved with the lines, "fix ERROR #014" would rot on the first edit.
    const a = f({ file: 'src/a.js', line: 10, message: 'Unexpected token )' });
    const b = f({ file: 'src/a.js', line: 41, message: 'Unexpected token )' });
    assert.strictEqual(a.key, b.key);
  });

  await test('FINDING: numbers inside a message do not fork the identity', () => {
    const a = f({ file: 'src/a.js', message: 'expected 3 arguments, got 4' });
    const b = f({ file: 'src/a.js', message: 'expected 3 arguments, got 5' });
    assert.strictEqual(a.key, b.key, 'that is one recurring defect, not two');
  });

  await test('FINDING: different files with the same message are different findings', () => {
    assert.notStrictEqual(
      f({ file: 'src/a.js', message: 'x' }).key,
      f({ file: 'src/b.js', message: 'x' }).key,
    );
  });

  await test('FINDING: the label reads as what a person hunts for', () => {
    assert.strictEqual(f({ category: F.CATEGORY.MIGRATION_RESIDUE }).label, 'RESIDUE');
    assert.strictEqual(f({ category: F.CATEGORY.FRONTEND_LAYOUT }).label, 'UI');
    assert.strictEqual(f({ category: F.CATEGORY.TYPO }).label, 'TYPO');
    assert.strictEqual(f({ category: F.CATEGORY.SYNTAX, severity: F.SEVERITY.ERROR }).label, 'ERROR');
  });

  // ---------------------------------------------------------------- ledger --

  await test('LEDGER: the same finding keeps its id across runs', () => {
    const l = new F.FindingLedger();
    const one = l.record([f({ file: 'a.js', message: 'boom' })], new Set([F.SOURCE.PARSER]));
    const id = one.findings[0].id;
    const two = l.record([
      f({ file: 'a.js', line: 99, message: 'boom' }),
      f({ file: 'b.js', message: 'other' }),
    ], new Set([F.SOURCE.PARSER]));
    assert.strictEqual(two.findings[0].id, id, 'moving does not renumber');
    assert.notStrictEqual(two.findings[1].id, id);
  });

  await test('LEDGER: a finding that stopped being reported BY A TOOL THAT RAN is FIXED', () => {
    const l = new F.FindingLedger();
    l.record([f({ file: 'a.js', message: 'boom' })], new Set([F.SOURCE.PARSER]));
    const r = l.record([], new Set([F.SOURCE.PARSER]));
    assert.strictEqual(r.fixed.length, 1);
    assert.strictEqual(r.fixed[0].state, F.STATE.FIXED);
    assert.strictEqual(r.unobserved.length, 0);
  });

  await test('LEDGER: a finding whose analyser did NOT run is UNVERIFIED, never fixed', () => {
    // The honesty property the two states exist for. An analyser that was
    // skipped produces exactly as many findings as a clean one, and calling
    // that a fix is the report lying about the thing it exists to get right.
    const l = new F.FindingLedger();
    l.record([f({ source: F.SOURCE.RESIDUE_SCANNER, file: 'a.js', message: 'ENEMIES remains' })],
      new Set([F.SOURCE.RESIDUE_SCANNER]));
    const r = l.record([], new Set([F.SOURCE.PARSER]));   // residue scanner did not run
    assert.deepStrictEqual(r.fixed, []);
    assert.strictEqual(r.unobserved.length, 1);
    assert.strictEqual(r.unobserved[0].state, F.STATE.UNVERIFIED);
  });

  await test('LEDGER: the first run reports nothing as newly appeared', () => {
    const l = new F.FindingLedger();
    const r = l.record([f({ file: 'a.js', message: 'x' })], new Set([F.SOURCE.PARSER]));
    assert.deepStrictEqual(r.appeared, [], 'everything is new on run one; saying so is noise');
  });

  await test('LEDGER: two sessions never share an issue list', () => {
    const a = {};
    const b = {};
    F.forSession(a).record([f({ file: 'a.js', message: 'x' })], new Set());
    assert.strictEqual(F.forSession(b).runs, 0);
    assert.strictEqual(F.forSession(a), F.forSession(a));
  });

  // ------------------------------------------------------------- the axes ---

  await test('HEALTH: a passing build with engineering findings is DEGRADED, not healthy', () => {
    const h = survey.grade({
      findings: [f({ category: F.CATEGORY.MIGRATION_RESIDUE, severity: F.SEVERITY.ERROR })],
      ran: new Set([F.SOURCE.PARSER]),
      testRun: { ok: true },
      frontend: { state: HEALTH.UNVERIFIED },
      lastCommand: { ok: true },
    });
    assert.strictEqual(h.build, HEALTH.PASS);
    assert.strictEqual(h.test, HEALTH.PASS);
    assert.strictEqual(h.engineering, HEALTH.DEGRADED,
      'a compiler has no opinion on a leftover implementation');
  });

  await test('HEALTH: an axis nobody measured is UNVERIFIED and can never fall through to PASS', () => {
    const h = survey.grade({
      findings: [],
      ran: new Set(),
      testRun: null,
      frontend: { state: HEALTH.UNVERIFIED },
      lastCommand: null,
    });
    assert.strictEqual(h.build, HEALTH.UNVERIFIED);
    assert.strictEqual(h.test, HEALTH.UNVERIFIED);
    assert.strictEqual(h.runtime, HEALTH.UNVERIFIED);
    assert.strictEqual(h.frontend, HEALTH.UNVERIFIED);
  });

  await test('HEALTH: a syntax error fails BUILD, whatever else passed', () => {
    const h = survey.grade({
      findings: [f({ category: F.CATEGORY.SYNTAX, severity: F.SEVERITY.CRITICAL })],
      ran: new Set([F.SOURCE.PARSER]),
      testRun: { ok: true },
      frontend: { state: HEALTH.PASS },
      lastCommand: { ok: true },
    });
    assert.strictEqual(h.build, HEALTH.FAILED);
    assert.strictEqual(h.engineering, HEALTH.FAILED);
  });

  await test('HEALTH: CLEAN needs an empty list, and INFO rows do not degrade it', () => {
    const h = survey.grade({
      findings: [f({ severity: F.SEVERITY.INFO }), f({ severity: F.SEVERITY.UNVERIFIED })],
      ran: new Set([F.SOURCE.PARSER]),
      testRun: { ok: true },
      frontend: { state: HEALTH.PASS },
      lastCommand: { ok: true },
    });
    assert.strictEqual(h.engineering, HEALTH.CLEAN);
  });

  await test('HEALTH: the report SAYS that a build pass is not a health verdict', () => {
    const text = briefing.healthSection({
      health: {
        build: HEALTH.PASS, test: HEALTH.PASS, runtime: HEALTH.PASS,
        frontend: HEALTH.UNVERIFIED, engineering: HEALTH.DEGRADED,
      },
    });
    assert.match(text, /BUILD PASS DOES NOT MEAN THE PROJECT IS HEALTHY/);
    assert.match(text, /A PASSING SUITE DOES NOT MEAN THE FINDINGS ARE HARMLESS/);
    assert.match(text, /UNVERIFIED: FRONTEND/);
  });

  // --------------------------------------------------------- root causes ----

  await test('ROOT CAUSE: findings sharing a symbol group; unrelated ones do not', () => {
    const groups = rootcause.candidates([
      f({ category: F.CATEGORY.MIGRATION_RESIDUE, source: F.SOURCE.RESIDUE_SCANNER, file: 'src/a.js', symbol: 'ENEMIES', message: 'residue' }),
      f({ category: F.CATEGORY.TYPO, source: F.SOURCE.SYMBOL_GRAPH, file: 'src/b.js', symbol: 'ENEMIES', message: 'typo' }),
      f({ category: F.CATEGORY.LINT, source: F.SOURCE.LINTER, file: 'src/zzz.js', symbol: 'unrelated', message: 'lint' }),
    ]);
    assert.strictEqual(groups.length, 1, 'the unrelated finding must not be dragged in');
    assert.strictEqual(groups[0].members.length, 2);
    assert.match(groups[0].hypothesis, /migration/i);
  });

  await test('ROOT CAUSE: two sources naming one symbol is HIGH; one source is LOW', () => {
    const high = rootcause.confidenceOf([
      f({ source: F.SOURCE.RESIDUE_SCANNER, symbol: 'X' }), f({ source: F.SOURCE.TEST_RUNNER, symbol: 'X' }),
    ]);
    const low = rootcause.confidenceOf([
      f({ source: F.SOURCE.LINTER, file: 'a.js' }), f({ source: F.SOURCE.LINTER, file: 'a.js' }),
    ]);
    assert.strictEqual(high, 'HIGH');
    assert.strictEqual(low, 'LOW');
  });

  await test('ROOT CAUSE: an anchor shared by everything groups nothing', () => {
    // A config file every finding mentions would otherwise collapse the whole
    // report into one meaningless "root cause".
    const many = [];
    for (let i = 0; i < 12; i++) {
      many.push(f({ file: `src/f${i}.js`, message: `m${i}`, related: { files: ['src/config.js'] } }));
    }
    const groups = rootcause.candidates(many);
    assert.ok(groups.every((g) => g.members.length < many.length),
      'one universal anchor must not make one group of everything');
  });

  await test('ROOT CAUSE: informational and unverified rows are never grouped', () => {
    const groups = rootcause.candidates([
      f({ severity: F.SEVERITY.INFO, file: 'a.js' }),
      f({ severity: F.SEVERITY.UNVERIFIED, file: 'a.js' }),
    ]);
    assert.deepStrictEqual(groups, [], 'a shared cause of "nobody looked at either" is not a finding');
  });

  // ------------------------------------------------------------- language ---

  await test('LANGSCAN: a parse error is PROVEN, located, and named by its function', () => {
    const dir = project({
      'src/broken.js': "'use strict';\nfunction tally(rows) {\n  return rows.reduce((n, r) => n + r.count, 0;\n}\n",
    });
    return langscan.scanProject(dir).then((r) => {
      const hit = r.findings.find((x) => x.category === F.CATEGORY.SYNTAX);
      assert.ok(hit, 'the parse failure must be reported');
      assert.strictEqual(hit.confidence, F.CONFIDENCE.PROVEN);
      assert.strictEqual(hit.file, 'src/broken.js');
      assert.ok(hit.line, 'with a line');
      assert.ok(hit.explanation, 'and an explanation of what the parser was doing');
      assert.ok(hit.risk, 'and why it matters');
    });
  });

  await test('LANGSCAN: the enclosing SYMBOL is the function, not a variable on the line', () => {
    // "Tightest range wins" named `rows` for a defect on `const rows = …`,
    // which tells a reader nothing. The useful answer is the function.
    const dir = project({
      'src/users.js': "'use strict';\nfunction getUsers(db) { return db.all(); }\n"
        + 'function activeUsers(db) {\n  const rows = getUser(db);\n  return rows;\n}\n',
    });
    return langscan.scanProject(dir).then((r) => {
      const hit = r.findings.find((x) => x.category === F.CATEGORY.TYPO);
      assert.ok(hit, 'the typo must be found');
      assert.strictEqual(hit.symbol, 'activeUsers');
      assert.strictEqual(hit.actual, 'getUser');
      assert.strictEqual(hit.expected, 'getUsers');
      assert.strictEqual(hit.confidence, F.CONFIDENCE.INFERRED,
        'that the suggestion is what was MEANT is not proven, and must not claim to be');
    });
  });

  await test('LANGSCAN: a working project produces no findings at all', () => {
    const dir = project({
      'src/ok.js': "'use strict';\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n",
    });
    return langscan.scanProject(dir).then((r) => {
      assert.deepStrictEqual(r.findings, [], 'silence on correct code is the whole contract');
    });
  });

  await test('LANGSCAN: Python is not parsed one process per file', () => {
    // `diagnostics.checkFile` spawns an interpreter per .py file, which is
    // right after one edit and catastrophic across a tree. toolchain.js
    // compiles them all in one process instead.
    const src = fs.readFileSync(require.resolve('../../src/langscan'), 'utf8');
    const re = /const SOURCE_RE = [^\n]+/.exec(src);
    assert.ok(re, 'SOURCE_RE must exist');
    assert.ok(!/\bpy\b/.test(re[0]), `langscan must not walk .py files itself: ${re[0]}`);
  });

  // ------------------------------------------------------------- toolchain --

  await test('TOOLCHAIN: a language whose tool is MISSING becomes an UNVERIFIED finding', () => {
    // Never silence. A missing type checker on a TypeScript project means the
    // briefing has nothing to say about types, and a reader not told that will
    // read the silence as a clean bill of health.
    const dir = project({ 'tsconfig.json': '{}', 'src/a.ts': 'export const x: number = 1;\n' });
    return toolchain.analyze(dir, { languages: { ts: 1 } }).then((r) => {
      const un = r.findings.find((x) => x.category === F.CATEGORY.UNVERIFIED);
      assert.ok(un, 'a configured-but-absent tool must be reported');
      assert.match(un.message, /tsc did not run/);
      assert.match(un.risk, /not evidence of absence of defects/);
      assert.ok(r.skipped.some((s) => s.tool === 'tsc'));
    });
  });

  await test('TOOLCHAIN: a language the project does not contain is not mentioned', () => {
    const dir = project({ 'src/a.js': 'const x = 1;\n' });
    return toolchain.analyze(dir, { languages: { js: 1 } }).then((r) => {
      assert.deepStrictEqual(r.findings, [], 'a project with no Go must not be told about go vet');
      assert.deepStrictEqual(r.skipped, []);
    });
  });

  await test('TOOLCHAIN: Python is compiled for real, in ONE process, and clean files stay silent', async () => {
    // SELF-SKIPPING, like the live tier: a machine without Python is not a
    // machine with broken Python files.
    const { findPython } = require('../../src/tools/exec');
    if (!findPython().ok) return;
    const dir = project({
      'bad.py': 'def go():\n    x = (1, 2\n    return x\n',
      'fine.py': 'def ok():\n    return 1\n',
    });
    const r = await toolchain.analyze(dir, {
      languages: { py: 2 }, pythonFiles: survey.pythonFiles(dir), timeoutMs: 60_000,
    });
    const hits = r.findings.filter((x) => x.category === F.CATEGORY.SYNTAX);
    assert.strictEqual(hits.length, 1, 'exactly the broken file, and not the correct one');
    assert.strictEqual(hits[0].file, 'bad.py');
    assert.strictEqual(hits[0].confidence, F.CONFIDENCE.PROVEN);
    assert.ok(hits[0].line, 'with a line from the interpreter itself');
  });

  await test('TOOLCHAIN: go vet is run for real and its wrong-type finding is normalised', async () => {
    // The native-tool architecture, proved against an actual compiler
    // toolchain rather than against a string someone made up. Self-skipping.
    const { onPath } = require('../../src/tools/exec');
    if (!onPath('go')) return;
    const dir = project({
      'go.mod': 'module example.com/fixture\n\ngo 1.21\n',
      'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tname := "world"\n\tfmt.Printf("%d\\n", name)\n}\n',
    });
    const r = await toolchain.analyze(dir, { languages: { go: 1 }, timeoutMs: 120_000 });
    const hit = r.findings.find((x) => /wrong type/.test(x.message));
    if (!hit) return;                       // an older toolchain may not carry this check
    assert.strictEqual(hit.file, 'main.go');
    assert.ok(hit.line && hit.column, 'a native tool gives a line AND a column, and both must survive');
    assert.strictEqual(hit.source, F.SOURCE.STATIC_ANALYSIS);
  });

  // ---------------------------------------------------------- the briefing --

  await test('BRIEF: the whole report is produced, with every required section', async () => {
    const dir = project({
      'src/users.js': "'use strict';\nfunction getUsers(db) { return db.all(); }\n"
        + 'function activeUsers(db) {\n  return getUser(db);\n}\nmodule.exports = { getUsers, activeUsers };\n',
    });
    const out = await briefcommand.build({}, { root: dir, session: {} });
    for (const heading of ['PROJECT CONTEXT', 'ENVIRONMENT', 'GIT STATE', 'HEALTH — FIVE SEPARATE AXES',
      'FINDINGS', 'ROOT-CAUSE CANDIDATES', 'UNVERIFIED', 'KNOWN LIMITATIONS', 'REPAIR DIRECTIVE']) {
      assert.ok(out.text.includes(heading), `the briefing is missing the ${heading} section`);
    }
    assert.match(out.text, /TYPO #001/, 'findings carry stable ids');
    assert.match(out.text, /src\/users\.js:4/, 'and exact locations');
    assert.match(out.text, /Evidence:/, 'and name what saw them');
    assert.match(out.text, /Confidence:/, 'and how sure they are');
  });

  await test('BRIEF: it carries no ANSI escapes — it is meant to be copied and parsed', () => {
    const dir = project({ 'src/a.js': 'const x = 1;\nmodule.exports = { x };\n' });
    return briefcommand.build({}, { root: dir, session: {} }).then((out) => {
      // eslint-disable-next-line no-control-regex
      const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);
      assert.doesNotMatch(out.text, ANSI, 'colour inside the briefing is noise that can break a parse');
    });
  });

  await test('BRIEF: the repair directive is generated every time, identically', async () => {
    const dir = project({ 'src/a.js': 'const x = 1;\nmodule.exports = { x };\n' });
    const a = await briefcommand.build({}, { root: dir, session: {} });
    const b = await briefcommand.build({}, { root: dir, session: {} });
    const cut = (t) => t.slice(t.indexOf('REPAIR DIRECTIVE'));
    const norm = (t) => t.replace(/^Start with .*$/m, '').replace(/^The most severe .*$/m, '');
    assert.strictEqual(norm(cut(a.text)), norm(cut(b.text)));
    assert.match(cut(a.text), /Build success is one piece of evidence/);
    assert.match(cut(a.text), /Keep CHANGED separate from VERIFIED/);
  });

  await test('BRIEF: flags are read from the raw remainder, not from a word array', () => {
    // The dispatcher hands `args` over as an ARRAY and `rest` as the raw
    // string. Reading the array here stringified it to "--tests,--dead" and
    // matched no flag at all.
    const o = briefcommand.parseArgs('--tests --dead --gone=A,B --removed=src/x.js --present=C');
    assert.strictEqual(o.tests, true);
    assert.strictEqual(o.deadCode, true);
    assert.deepStrictEqual(o.residue.gone, ['A', 'B']);
    assert.deepStrictEqual(o.residue.removed, ['src/x.js']);
    assert.deepStrictEqual(o.residue.present, ['C']);
  });

  await test('BRIEF: no flags means no residue query and no expensive sweeps', () => {
    const o = briefcommand.parseArgs('');
    assert.strictEqual(o.residue, null);
    assert.strictEqual(o.deadCode, false);
    assert.strictEqual(o.tests, false);
  });

  await test('BRIEF: `/brief` does not collide with `/steer`, which means something else', () => {
    // `/steer` corrects work that is already running. define() throws on a
    // duplicate, so a second registration would take the binary down at
    // startup — and a user redirecting a task must never get a project audit.
    const { REGISTRY } = require('../../src/commands');
    assert.ok(REGISTRY.has('/steer'), '/steer must still exist and still mean what it meant');
    assert.ok(REGISTRY.has('/brief'));
    assert.notStrictEqual(REGISTRY.get('/steer').desc, REGISTRY.get('/brief').desc);
  });

  // -------------------------------------------------- scrollback reachability

  await test('SCROLL: a long conversation is reachable to its beginning, not capped at 60', () => {
    // THE BUG A USER HIT. The feed was trimmed to the last 60 entries with a
    // comment saying "the workspace scrolls for the rest" — it could not, because
    // scrollWorkspace bounds scrolling to the number of lines this returns. The
    // top of their own conversation was on disk and unreachable from the screen.
    const conversation = require('../../src/ui/conversation');
    const turns = [];
    for (let i = 0; i < 200; i++) {
      turns.push({
        turnId: `t${i}`,
        userInput: `question number ${i}`,
        text: `answer number ${i}`,
        actions: [],
        toolCalls: 0,
      });
    }
    const lines = conversation.activity({ session: { turns }, width: 100, transcript: [] });
    const body = lines.join('\n');
    assert.ok(body.includes('question number 0'),
      'the FIRST message must still be reachable in a 200-turn session');
    assert.ok(body.includes('question number 199'), 'and so must the last');
  });

  await test('SCROLL: the cap that does exist is stated, never silent', () => {
    // A silent cap is how somebody concludes their history is gone.
    const conversation = require('../../src/ui/conversation');
    assert.ok(conversation.MAX_TURNS_SHOWN >= 200,
      `a bound of ${conversation.MAX_TURNS_SHOWN} turns is reachable by a real session`);
    const turns = [];
    for (let i = 0; i < conversation.MAX_TURNS_SHOWN + 50; i++) {
      turns.push({ turnId: `t${i}`, userInput: `q${i}`, text: `a${i}`, actions: [], toolCalls: 0 });
    }
    const body = conversation.activity({ session: { turns }, width: 100, transcript: [] }).join('\n');
    assert.match(body, /earlier turn\(s\) not shown/,
      'when the bound IS hit the screen must say so and say where the rest is');
    assert.match(body, /saved session/, 'and where the rest actually lives');
  });

  await test('SCROLL: command output is not trimmed to 40 lines either', () => {
    const conversation = require('../../src/ui/conversation');
    const transcript = Array.from({ length: 300 }, (_, i) => `output line ${i}`);
    const body = conversation.activity({ session: { turns: [] }, width: 100, transcript }).join('\n');
    assert.ok(body.includes('output line 0'), 'the top of a long command output must be reachable');
  });

  await test('BRIEF: the tool and the command produce ONE briefing, from one builder', () => {
    // Two paths to one document would be two documents the day one gained a
    // section.
    const src = fs.readFileSync(require.resolve('../../src/tools/semantic'), 'utf8');
    assert.match(src, /briefcommand\.build/, 'the tool must call the command\'s builder');
  });
};
