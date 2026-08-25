'use strict';

/**
 * THE MIGRATION CONTRACT — and every way "migrate X to Y" gets read as "add Y".
 *
 * Each block below is a scenario the engine has to get right, and every one of
 * them is a real failure mode rather than a hypothetical:
 *
 *   button -> lever          the smallest replacement. Both exist afterwards
 *                            and nobody notices, because a leftover breaks
 *                            nothing.
 *   C++ -> Python            the target is written, the source stays, the tests
 *                            pass, and the report is truthful about the half it
 *                            describes.
 *   Agent B -> Vue           the scope is one component and the model migrates
 *                            all three, which passes every positive check ever
 *                            written and destroys two thirds of the request.
 *   A + B + C -> D           the three are deleted and a fourth is invented,
 *                            losing the responsibilities that were the point.
 *   enemies.json             translated into Python because it happened to be
 *                            in the folder the model was looking at.
 *
 * The tests assert on the CONTRACT rather than on prose, because the contract
 * is what the expensive model is given and what the verifier checks.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const M = require('../../src/migration');
const intent = require('../../src/migrationintent');
const map = require('../../src/migrationmap');
const brief = require('../../src/migrationbrief');
const structure = require('../../src/structure');
const tech = require('../../src/tech');

// ------------------------------------------------------------- fixtures ----

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

/** A C++ project with data and configuration beside it. */
function cppProject() {
  const root = tmpdir('mig-cpp-');
  write(root, 'src/scanner.cpp', 'void Scanner::initialize() { ready = true; }\n'
    + 'void Scanner::scan() { load("enemies.json"); }\nvoid Scanner::filter() { }\nint Scanner::result() { return n; }\n');
  write(root, 'src/memory.cpp', 'void Memory::open() { }\nvoid Memory::read() { }\nvoid Memory::close() { }\n');
  write(root, 'src/parser.cpp', 'void Parser::load_json() { }\nvoid Parser::parse() { }\n');
  write(root, 'data/enemies.json', '{"slime":{"hp":10}}\n');
  write(root, 'config/settings.json', '{"width":800}\n');
  return root;
}

/** Three agents, all React, each owning its own directory. */
function agentProject({ third = 'react' } = {}) {
  const root = tmpdir('mig-agents-');
  for (const name of ['agent-a', 'agent-b']) {
    write(root, `agents/${name}/index.jsx`, `import React from 'react';\nexport function ${name.replace('-', '')}() { return null; }\n`);
    write(root, `agents/${name}/agent.md`, `# ${name}\n\n## responsibility\nrenders things\n`);
  }
  if (third === 'react') {
    write(root, 'agents/agent-c/index.jsx', "import React from 'react';\nexport function agentc() { return null; }\n");
  } else {
    write(root, 'agents/agent-c/index.vue', '<script>\nexport default { name: "agentc" }\n</script>\n');
  }
  write(root, 'agents/agent-c/agent.md', '# agent-c\n\n## responsibility\nrenders things\n');
  write(root, 'shared/schema.json', '{"version":1}\n');
  return root;
}

/** Three agents with three DIFFERENT jobs, to be merged into one. */
function threeJobAgents() {
  const root = tmpdir('mig-merge-');
  write(root, 'agents/frontend/index.js', 'function renderPage() {}\nfunction bindEvents() {}\nmodule.exports = { renderPage, bindEvents };\n');
  write(root, 'agents/backend/index.js', 'function handleRequest() {}\nfunction persist() {}\nmodule.exports = { handleRequest, persist };\n');
  write(root, 'agents/testing/index.js', 'function runSuite() {}\nfunction report() {}\nmodule.exports = { runSuite, report };\n');
  return root;
}

/** Plan a migration with every question already settled, so nothing is open. */
function plan(root, request, extra = {}) {
  const d = intent.parse(request);
  Object.assign(d, extra);
  if (!d.dispositionHint) d.dispositionHint = 'REPLACE';
  return map.build(root, d, { intent: request });
}

module.exports = async function () {
  // ================================================== THE BEHAVIOURAL RULE ==

  await test('MIGRATION: a contract that only CREATES the target is refused as additive', () => {
    // "Migrate X to Y" read as "add Y" is the entire reason this subsystem
    // exists, so it is not a warning — it is an invalid contract.
    const c = M.create({
      intent: 'migrate the scanner to Python',
      source: tech.resolve('cpp'),
      target: tech.resolve('python'),
      scope: { kind: M.SCOPE_KIND.PATHS, label: 'src', paths: ['src'], components: [], resolved: true },
      operations: [{ type: M.OP.KEEP, source: 'src/scanner.cpp' }],
      verification: { required: [{ kind: 'file_exists', value: 'src/scanner.py' }], negative: [] },
    });
    const v = M.validate(c);
    assert.ok(!v.ok, 'a contract that disposes of nothing must not validate');
    assert.ok(v.problems.some((p) => /ADDITIVE/.test(p)),
      `the refusal must name the failure, got: ${v.problems.join(' | ')}`);
  });

  await test('MIGRATION: a contract with no scope is refused, never widened to the project', () => {
    const c = M.create({
      intent: 'migrate to Vue',
      source: tech.resolve('react'),
      target: tech.resolve('vue'),
      operations: [{ type: M.OP.REPLACE, source: 'a.jsx', target: 'a.vue' }],
      verification: { required: [], negative: [{ kind: 'file_inactive', value: 'a.jsx' }] },
    });
    const v = M.validate(c);
    assert.ok(!v.ok);
    assert.ok(v.problems.some((p) => /NO SCOPE/.test(p)), v.problems.join(' | '));
    assert.notStrictEqual(c.scope.kind, M.SCOPE_KIND.PROJECT,
      'an unresolved scope must never default to the whole project');
  });

  await test('MIGRATION: disposing of something with no negative check is refused', () => {
    const c = M.create({
      intent: 'replace the loader',
      target: tech.resolve('python'),
      scope: { kind: M.SCOPE_KIND.PATHS, label: 'src', paths: ['src'], components: [], resolved: true },
      operations: [{ type: M.OP.REPLACE, source: 'src/a.cpp', target: 'src/a.py' }],
      verification: { required: [{ kind: 'file_exists', value: 'src/a.py' }], negative: [] },
    });
    const v = M.validate(c);
    assert.ok(!v.ok);
    assert.ok(v.problems.some((p) => /negative verification/.test(p)), v.problems.join(' | '));
  });

  // ================================================= THE SMALLEST CASE =====

  await test('MIGRATION: button -> lever is a REPLACE, not an addition', () => {
    const root = tmpdir('mig-ui-');
    write(root, 'ui/button.js', 'function Button() { return "button"; }\nmodule.exports = { Button };\n');
    const r = plan(root, 'Change the button into a lever', { paths: ['ui/button.js'], targetName: 'lever' });
    const ops = r.contract.operations.filter((o) => o.type === M.OP.REPLACE);
    assert.strictEqual(ops.length, 1, 'exactly one thing is being replaced');
    assert.strictEqual(ops[0].source, 'ui/button.js');
    const final = M.finalState(r.contract);
    assert.ok(final.inactive.includes('ui/button.js'),
      'the button must be listed as INACTIVE in the final state, or nothing will notice it survived');
    // And the negative half exists, which is what makes it a migration.
    assert.ok(r.contract.verification.negative.some((n) => n.kind === 'file_inactive' && n.value === 'ui/button.js'));
  });

  // ================================================= LANGUAGE MIGRATIONS ===

  await test('MIGRATION: C++ -> Python maps every source file and preserves the JSON', () => {
    const root = cppProject();
    const r = plan(root, 'Migrate this C++ implementation to Python');
    assert.ok(r.resolved, 'scope must resolve — there is only one place the C++ lives');

    const rows = M.replacementMap(r.contract);
    const byFrom = new Map(rows.map((x) => [x.from, x]));
    for (const [from, to] of [['src/scanner.cpp', 'src/scanner.py'], ['src/memory.cpp', 'src/memory.py'], ['src/parser.cpp', 'src/parser.py']]) {
      assert.ok(byFrom.has(from), `${from} is missing from the replacement map`);
      assert.strictEqual(byFrom.get(from).to, to);
      assert.strictEqual(byFrom.get(from).fate, M.OP.ARCHIVE, `${from} must be archived, not left alongside`);
    }
    // THE POINT OF SECTION 6: the data is NOT translated.
    for (const res of ['data/enemies.json', 'config/settings.json']) {
      const row = byFrom.get(res);
      assert.ok(row, `${res} must be classified explicitly, not left unmentioned`);
      assert.strictEqual(row.fate, M.DISPOSITION.PRESERVE, `${res} must be PRESERVED, not translated`);
    }
    // ONE ROW PER FILE. A file listed twice reads as two separate jobs.
    const froms = rows.map((x) => x.from);
    assert.strictEqual(new Set(froms).size, froms.length, `the map repeats a file: ${froms.join(', ')}`);
  });

  await test('MIGRATION: the structural translation carries RESPONSIBILITIES, not syntax', () => {
    const root = cppProject();
    const r = plan(root, 'Migrate this C++ implementation to Python');
    const scanner = r.shape.find((s) => s.from === 'src/scanner.cpp');
    assert.ok(scanner, 'the scanner must have a target structure before anything is written');
    assert.deepStrictEqual(
      scanner.responsibilities.filter((x) => x.startsWith('Scanner.')).sort(),
      ['Scanner.filter', 'Scanner.initialize', 'Scanner.result', 'Scanner.scan'],
      'every method of Scanner must survive the crossing',
    );
    // And the brief states them for the model to build against.
    const text = brief.render(r.contract);
    assert.ok(/STRUCTURE TO PRESERVE/.test(text));
    assert.ok(/Scanner\.initialize/.test(text));
    assert.ok(/RESPONSIBILITIES, not syntax/.test(text));
  });

  await test('MIGRATION: Python -> C++ works in the other direction, with no pair hard-coded', () => {
    const root = tmpdir('mig-py-');
    write(root, 'app/engine.py', 'class Engine:\n    def start(self):\n        pass\n    def stop(self):\n        pass\n');
    const r = plan(root, 'Migrate app to C++', { paths: ['app'] });
    const rows = M.replacementMap(r.contract);
    const row = rows.find((x) => x.from === 'app/engine.py');
    assert.ok(row, 'the Python file must be on the map');
    assert.strictEqual(row.to, 'app/engine.cpp');
    const shape = r.shape.find((s) => s.from === 'app/engine.py');
    assert.ok(shape.responsibilities.includes('Engine.start') && shape.responsibilities.includes('Engine.stop'));
  });

  await test('MIGRATION: Python -> Rust, a pair nothing in the program has ever seen together', () => {
    const root = tmpdir('mig-rs-');
    write(root, 'lib/parse.py', 'def tokenize(s):\n    pass\n\ndef parse(s):\n    pass\n');
    const r = plan(root, 'Port lib to Rust', { paths: ['lib'] });
    const row = M.replacementMap(r.contract).find((x) => x.from === 'lib/parse.py');
    assert.strictEqual(row.to, 'lib/parse.rs');
    assert.deepStrictEqual(r.shape[0].responsibilities.sort(), ['parse', 'tokenize']);
    // THE GENERIC CLAIM, asserted structurally: there is no cpp_to_python or
    // python_to_rust anywhere in the source. Migrations are ORDERED PAIRS of
    // rows in a table, never entries in one.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tech.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/_to_[a-z]/.test(src), 'tech.js must not contain a hard-coded technology pair');
  });

  // ================================================ FRAMEWORK MIGRATIONS ===

  await test('MIGRATION: React -> Vue and Vue -> React both resolve, in either direction', () => {
    const root = agentProject({ third: 'vue' });
    const toVue = plan(root, 'Change agent-a from React to Vue', { paths: ['agents/agent-a'] });
    const a = M.replacementMap(toVue.contract).find((x) => x.from === 'agents/agent-a/index.jsx');
    assert.ok(a, 'the React file must be on the map');
    assert.strictEqual(a.to, 'agents/agent-a/index.vue');

    const toReact = plan(root, 'Change agent-c from Vue to React', { paths: ['agents/agent-c'] });
    const c = M.replacementMap(toReact.contract).find((x) => x.from === 'agents/agent-c/index.vue');
    assert.ok(c, 'the Vue file must be on the map going the other way');
    assert.strictEqual(c.to, 'agents/agent-c/index.jsx');
  });

  await test('MIGRATION: a React file with a .js extension is still recognised, by its imports', () => {
    const root = tmpdir('mig-jsx-');
    write(root, 'web/App.js', "import React from 'react';\nexport function App() { return null; }\n");
    write(root, 'web/util.js', 'export function clamp(n) { return n; }\n');
    const r = plan(root, 'Migrate web from React to Vue', { paths: ['web'] });
    const froms = M.replacementMap(r.contract).filter((x) => x.fate === M.OP.ARCHIVE).map((x) => x.from);
    assert.ok(froms.includes('web/App.js'), 'a .js file that imports react belongs to React');
    assert.ok(!froms.includes('web/util.js'), 'a .js file that does not is not part of the framework migration');
  });

  // ============================================= SCOPED HYBRID MIGRATION ===

  await test('MIGRATION: Agent B -> Vue leaves Agent A and Agent C on React, and SAYS SO', () => {
    const root = agentProject();
    const r = plan(root, 'Change agent-b from React to Vue');

    assert.strictEqual(r.scope.kind, M.SCOPE_KIND.COMPONENT);
    assert.deepStrictEqual(r.scope.components, ['agent-b'],
      'the request names its own scope; it must not be read as the whole project');

    const replaced = r.contract.operations.filter((o) => o.type === M.OP.REPLACE).map((o) => o.source);
    assert.ok(replaced.every((p) => p.startsWith('agents/agent-b/')),
      `only Agent B may be replaced, got: ${replaced.join(', ')}`);

    // ---- AND THE OTHER TWO ARE ASSERTED, not merely omitted ------------
    const kept = r.contract.operations.filter((o) => o.type === M.OP.KEEP).map((o) => o.source);
    assert.ok(kept.includes('agents/agent-a/index.jsx'), `Agent A must be KEPT explicitly, got: ${kept.join(', ')}`);
    assert.ok(kept.includes('agents/agent-c/index.jsx'), 'Agent C must be KEPT explicitly');

    const final = M.finalState(r.contract);
    assert.ok(final.active.includes('agents/agent-a/index.jsx'), 'Agent A is ACTIVE React in the final state');
    assert.ok(final.active.includes('agents/agent-c/index.jsx'), 'Agent C is ACTIVE React in the final state');
    assert.ok(final.inactive.some((p) => p.startsWith('agents/agent-b/')), 'Agent B React is INACTIVE');
    assert.ok(final.active.includes('agents/agent-b/index.vue'), 'Agent B Vue is ACTIVE');

    // The brief has to say it in words, because the model reads the brief.
    const text = brief.render(r.contract);
    assert.ok(/KEEP —/.test(text), 'the brief must have a KEEP section');
    assert.ok(/deliberately not homogeneous/.test(text));
  });

  await test('MIGRATION: a heterogeneous project stays heterogeneous — three agents, three technologies', () => {
    const root = tmpdir('mig-hetero-');
    write(root, 'agents/alpha/main.py', 'def run():\n    pass\n');
    write(root, 'agents/beta/main.rs', 'pub fn run() {}\n');
    write(root, 'agents/gamma/main.cpp', 'int run() { return 0; }\n');
    const r = plan(root, 'Migrate agents/gamma to Python', { paths: ['agents/gamma'] });
    const kept = r.contract.operations.filter((o) => o.type === M.OP.KEEP).map((o) => o.source);
    // Only the SOURCE technology outside the scope is asserted as kept — Rust
    // and Python are not part of this migration in any direction.
    assert.ok(!kept.some((p) => p.includes('beta')), 'the Rust agent is not this migration business');
    const replaced = r.contract.operations.filter((o) => o.type === M.OP.REPLACE).map((o) => o.source);
    assert.deepStrictEqual(replaced, ['agents/gamma/main.cpp']);
  });

  // ==================================================== CONSOLIDATION ======

  await test('MIGRATION: A + B + C -> D carries every responsibility, and retires the three', () => {
    const root = threeJobAgents();
    const d = intent.parse('Merge these three coding agents into one');
    d.projectWide = true;
    d.targetName = 'agent-d';
    d.dispositionHint = 'REPLACE';
    const r = map.build(root, d, { intent: 'Merge these three coding agents into one' });

    const merge = r.contract.operations.find((o) => o.type === M.OP.MERGE || o.type === M.OP.CONSOLIDATE);
    assert.ok(merge, 'a merge request must produce a MERGE operation, not three replacements');

    const groups = merge.structure.responsibilities;
    const names = groups.map((g) => g.from).sort();
    assert.deepStrictEqual(names, ['backend', 'frontend', 'testing'],
      'all three sources must contribute, or the merge has lost one');
    const all = groups.flatMap((g) => g.responsibilities);
    for (const r0 of ['renderPage', 'handleRequest', 'runSuite']) {
      assert.ok(all.includes(r0), `${r0} must be carried into the merged agent, not invented away`);
    }
    const text = brief.render(r.contract);
    assert.ok(/contributes:/.test(text), 'the brief must show what each source contributes');
    assert.ok(/is not a merge/.test(text), 'and must say that deleting three and writing a fourth is not a merge');
  });

  // ======================================= STRUCTURE, ACROSS LANGUAGES =====

  await test('STRUCTURE: declarations are found in every language the engine claims', () => {
    const cases = [
      ['a.py', 'class A:\n    def go(self):\n        pass\n', ['A', 'A.go']],
      ['a.cpp', 'void A::go() { }\n', ['A.go']],
      ['a.rs', 'pub fn go() {}\n', ['go']],
      ['a.go', 'func Go() {}\n', ['Go']],
      ['a.rb', 'class A\n  def go\n  end\nend\n', ['A', 'A.go']],
      ['a.java', 'public class A {\n  public void go() {\n  }\n}\n', ['A', 'go']],
      ['a.ts', 'export class A {}\nexport function go() {}\n', ['A', 'go']],
      ['a.js', 'function go() {}\n', ['go']],
    ];
    for (const [file, src, wanted] of cases) {
      const resp = structure.responsibilities(structure.extract(src, file));
      for (const w of wanted) {
        assert.ok(resp.includes(w), `${file}: expected ${w} among [${resp.join(', ')}]`);
      }
    }
  });

  await test('STRUCTURE: a data file has no declarations and is never mistaken for code', () => {
    const s = structure.extract('{"a":1}', 'data.json');
    assert.strictEqual(s.data, true);
    assert.deepStrictEqual(s.units, []);
    assert.ok(structure.isData('config/settings.yaml'));
    assert.ok(!structure.isData('src/settings.py'));
  });

  // ============================================ THE MANIFEST AND ITS ROUND TRIP

  await test('MIGRATION: the manifest is machine-readable and survives a save/load round trip', () => {
    const root = cppProject();
    const r = plan(root, 'Migrate this C++ implementation to Python');
    const file = M.save(r.contract);
    assert.ok(fs.existsSync(file), 'the manifest must be written');

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(raw.migration, 'the manifest has one top-level key');
    for (const k of ['scope', 'operations', 'resources', 'replacement_map', 'verification', 'final_state']) {
      assert.ok(k in raw.migration, `the manifest must carry ${k}`);
    }
    assert.ok(raw.migration.final_state.inactive.includes('src/scanner.cpp'),
      'the final state must record what has to stop existing');

    const back = M.load(r.contract.id);
    assert.ok(back, 'it must load again');
    assert.strictEqual(back.id, r.contract.id);
    assert.strictEqual(back.operations.length, r.contract.operations.length);
    assert.deepStrictEqual(M.finalState(back).inactive.sort(), M.finalState(r.contract).inactive.sort());

    // AND IT LIVES OUTSIDE THE PROJECT. A manifest in the tree would be a file
    // the migration then has to classify, and the residue sweep would find the
    // old implementation's name written all over the migration's own paperwork.
    assert.ok(!file.startsWith(root), `the manifest must not be written into the project (${file})`);
  });

  // ==================================================== THE GENERATED BRIEF =

  await test('MIGRATION: the brief states the final invariant, not just the work', () => {
    const root = cppProject();
    const r = plan(root, 'Migrate this C++ implementation to Python');
    const text = brief.render(r.contract);
    assert.ok(/TASK TYPE: STRUCTURAL MIGRATION/.test(text));
    assert.ok(/REPLACEMENT MAP/.test(text));
    assert.ok(/NEGATIVE VERIFICATION/.test(text));
    assert.ok(/FINAL INVARIANT/.test(text));
    assert.ok(/ACTIVE\s+src\/scanner\.py/.test(text));
    assert.ok(/INACTIVE\s+src\/scanner\.cpp/.test(text));
    assert.ok(/PRESERVED\s+data\/enemies\.json/.test(text));
    assert.ok(/The final state is what was asked for/.test(text));
    // AND IT IS A PAGE, NOT A REPOSITORY. The whole economic argument for
    // planning locally is that this is what gets sent instead of the tree.
    assert.ok(text.length < 12000, `the brief is ${text.length} chars — it is meant to replace the repository, not join it`);
  });

  await test('MIGRATION: the mode classifier routes a migration away from IMPLEMENT', () => {
    const mode = require('../../src/mode');
    for (const s of ['Migrate this C++ implementation to Python', 'Change Agent B from React to Vue',
      'replace the webpack build with vite', 'merge these three coding agents into one']) {
      assert.strictEqual(mode.classify(s).mode, 'MIGRATE', `"${s}" must not be read as an ordinary change`);
    }
    // And an ordinary request is NOT dragged into the migration workflow.
    for (const s of ['add a login button', 'the login button is stuck on OFF', 'explain how the router works']) {
      assert.notStrictEqual(mode.classify(s).mode, 'MIGRATE', `"${s}" is not a migration`);
    }
    assert.ok(require('../../src/prompt').MODE_GUIDANCE.MIGRATE, 'MIGRATE must have guidance, or the mode does nothing');
  });
};
