'use strict';

/**
 * THE HALF NOBODY CHECKS, AND THE WAY BACK.
 *
 * Everything here is about the second claim in "replace X with Y". The first
 * claim has a natural test — the new code either works or it does not. The
 * second has none, because a leftover implementation breaks nothing, so these
 * are the tests that would have to fail for the failure to be caught at all.
 *
 * The most important test in this file is the one that DELIBERATELY LEAVES THE
 * OLD IMPLEMENTATION IN PLACE and asserts that verification refuses. A
 * verifier that passes there is worse than no verifier: it is a green light on
 * exactly the mistake it was built to catch.
 *
 * The activation tests use a REAL checkpoint (backups.js) into the runner's
 * isolated config home, and a real archive on disk. Nothing about the way back
 * is mocked, because "it can be restored" is a claim about the filesystem.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const M = require('../../src/migration');
const intent = require('../../src/migrationintent');
const map = require('../../src/migrationmap');
const check = require('../../src/migrationcheck');
const migrateTools = require('../../src/tools/migrate');

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

/** A C++ project with data beside it, and a plan to move it to Python. */
function planned({ request = 'Migrate src to Python', extra = {} } = {}) {
  const root = tmpdir('migv-');
  write(root, 'src/scanner.cpp', 'void Scanner::initialize() { }\nvoid Scanner::scan() { }\n');
  write(root, 'src/memory.cpp', 'void Memory::open() { }\nvoid Memory::close() { }\n');
  write(root, 'data/enemies.json', '{"slime":{"hp":10}}\n');
  const d = intent.parse(request);
  d.paths = ['src'];
  d.dispositionHint = 'REPLACE';
  Object.assign(d, extra);
  const r = map.build(root, d, { intent: request });
  return { root, contract: r.contract };
}

/** Write the Python side, so the positive half of the contract is satisfied. */
function buildTarget(root) {
  write(root, 'src/scanner.py', 'class Scanner:\n    def initialize(self):\n        pass\n    def scan(self):\n        pass\n');
  write(root, 'src/memory.py', 'class Memory:\n    def open(self):\n        pass\n    def close(self):\n        pass\n');
}

module.exports = async function () {
  // ===================================================== NEGATIVE VERIFICATION

  await test('NEGATIVE: a perfect target with the source still in place is NOT verified', () => {
    const { root, contract } = planned();
    buildTarget(root);
    const r = check.verify(root, contract);

    assert.ok(r.positiveOk, 'the Python side is complete, so the positive half must pass');
    assert.ok(!r.negativeOk, 'THE WHOLE POINT: the C++ is still there, so this must NOT verify');
    assert.ok(!r.ok, 'and the migration as a whole is not done');

    const stuck = r.negative.filter((n) => n.verdict === check.V.FAIL).map((n) => n.value);
    assert.ok(stuck.includes('src/scanner.cpp'), `scanner.cpp must be reported as still active, got: ${stuck.join(', ')}`);
    assert.ok(stuck.includes('src/memory.cpp'), 'memory.cpp too');

    const text = check.describe(r);
    assert.ok(/TARGET READY, MIGRATION NOT FINISHED/.test(text),
      'the wording must separate "the new thing works" from "the migration is done"');
    assert.ok(/MUST NOT REMAIN ACTIVE/.test(text));
  });

  await test('NEGATIVE: a caller still importing the old module fails verification', () => {
    const root = tmpdir('migv-imp-');
    write(root, 'src/loader.js', "const t = require('./table');\nmodule.exports = { t };\n");
    write(root, 'src/table.js', 'const TABLE = { slime: 1 };\nmodule.exports = TABLE;\n');
    write(root, 'data/table.json', '{"slime":1}\n');
    const d = intent.parse('Migrate src/table.js to JSON-backed data');
    d.paths = ['src/table.js'];
    d.targetName = 'python';
    d.dispositionHint = 'REPLACE';
    const { contract } = map.build(root, d, { intent: 'move the table into data' });

    // The target exists and the source is gone from disk — but the caller was
    // never updated, which is the state that fails at load rather than at test.
    write(root, 'src/table.py', 'TABLE = {}\n');
    fs.unlinkSync(path.join(root, 'src/table.js'));

    const r = check.verify(root, contract);
    const importFail = r.negative.find((n) => n.kind === 'no_importers' && n.verdict === check.V.FAIL);
    assert.ok(importFail, 'a surviving import of a deleted module must be a failure');
    assert.ok(/loader\.js/.test(importFail.detail), `it must name the caller, got: ${importFail.detail}`);
  });

  await test('NEGATIVE: a preserved resource that was quietly rewritten fails verification', () => {
    const { root, contract } = planned();
    buildTarget(root);
    // The model "helpfully" reformatted the data file on its way past.
    write(root, 'data/enemies.json', '{\n  "slime": {\n    "hp": 10\n  }\n}\n');
    const r = check.verify(root, contract);
    const bad = r.positive.find((p) => p.kind === 'unchanged' && p.verdict === check.V.FAIL);
    assert.ok(bad, 'a PRESERVE resource that changed must fail, even when the JSON still parses');
    assert.ok(/content changed/.test(bad.detail));
  });

  await test('NEGATIVE: migrating code that was explicitly KEPT is a failure, not thoroughness', () => {
    const root = tmpdir('migv-hybrid-');
    for (const n of ['agent-a', 'agent-b', 'agent-c']) {
      write(root, `agents/${n}/index.jsx`, `import React from 'react';\nexport function ${n.replace('-', '')}() {}\n`);
    }
    const d = intent.parse('Change agent-b from React to Vue');
    d.dispositionHint = 'REPLACE';
    const { contract } = map.build(root, d, { intent: 'Change agent-b from React to Vue' });

    write(root, 'agents/agent-b/index.vue', '<script>\nexport default { name: "agentb" }\n</script>\n');
    fs.unlinkSync(path.join(root, 'agents/agent-b/index.jsx'));
    const good = check.verify(root, contract);
    assert.ok(good.ok, `a correctly scoped migration must verify: ${check.describe(good)}`);

    // Now do what an over-eager model does: convert the other two as well.
    fs.unlinkSync(path.join(root, 'agents/agent-a/index.jsx'));
    write(root, 'agents/agent-a/index.vue', '<script>\nexport default {}\n</script>\n');
    const over = check.verify(root, contract);
    assert.ok(!over.ok, 'migrating a KEPT component must fail verification');
    const kept = over.positive.find((p) => p.value === 'agents/agent-a/index.jsx' && p.verdict === check.V.FAIL);
    assert.ok(kept, 'and the failure must name the component that should have been left alone');
    assert.ok(/must NOT have been migrated/.test(kept.why));
  });

  // ============================================== BACKUP, ACTIVATE, ROLL BACK

  await test('BACKUP: activation refuses while the target is unverified, and moves nothing', () => {
    const { root, contract } = planned();
    const r = check.activate(root, contract);
    assert.ok(!r.ok, 'nothing may be archived while required checks fail');
    assert.ok(/not verified yet/.test(r.why));
    assert.ok(fs.existsSync(path.join(root, 'src/scanner.cpp')), 'the source must still be exactly where it was');
    assert.deepStrictEqual(contract.archived, [], 'and nothing may be recorded as archived');
  });

  await test('BACKUP: activation checkpoints, archives out of the tree, and verifies the FINAL state', () => {
    const { root, contract } = planned();
    buildTarget(root);
    const r = check.activate(root, contract);
    assert.ok(r.ok, `activation should have succeeded: ${r.why || ''}`);
    assert.ok(r.checkpoint && r.checkpoint.id, 'a checkpoint must be taken BEFORE anything moves');

    assert.ok(!fs.existsSync(path.join(root, 'src/scanner.cpp')), 'the C++ must be out of the tree');
    assert.ok(fs.existsSync(path.join(root, 'src/scanner.py')), 'the Python must still be in it');
    assert.ok(fs.existsSync(path.join(root, 'data/enemies.json')), 'and the data must be untouched');

    // ARCHIVED, NOT DELETED. It is retrievable, and it is not in the project.
    const archived = path.join(check.archiveDir(contract.id), 'src/scanner.cpp');
    assert.ok(fs.existsSync(archived), `the source must be retrievable at ${archived}`);
    assert.ok(/Scanner::initialize/.test(fs.readFileSync(archived, 'utf8')), 'and it must be the real bytes');

    assert.ok(r.verification.ok, 'the final state must verify');
    assert.strictEqual(contract.stage, M.STAGE.COMPLETE);
  });

  await test('RECOVERY: a failed activation puts the old implementation back by itself', () => {
    const { root, contract } = planned();
    buildTarget(root);

    // A check the final state cannot satisfy, standing in for anything that
    // goes wrong once the source is out of the way. The contract, not the
    // harness, decides what "verified" means — so this is the real path.
    contract.verification.required.push({
      kind: 'file_exists', value: 'src/scanner_extra.py', why: 'a requirement the target does not meet',
    });
    const r = check.activate(root, contract, { force: true });

    assert.ok(!r.ok, 'activation must report failure');
    assert.ok(r.rolledBack, 'and must have rolled itself back');
    assert.ok(fs.existsSync(path.join(root, 'src/scanner.cpp')), 'the C++ implementation must be active again');
    assert.ok(fs.existsSync(path.join(root, 'src/memory.cpp')));
    assert.ok(/Scanner::initialize/.test(fs.readFileSync(path.join(root, 'src/scanner.cpp'), 'utf8')),
      'and it must be the original bytes, not an empty file');
    assert.strictEqual(contract.stage, M.STAGE.ROLLED_BACK);
    assert.deepStrictEqual(contract.archived, [], 'nothing is left recorded as archived after a rollback');
  });

  await test('RECOVERY: an explicit rollback restores the source and says what it did NOT remove', () => {
    const { root, contract } = planned();
    buildTarget(root);
    assert.ok(check.activate(root, contract).ok);
    assert.ok(!fs.existsSync(path.join(root, 'src/scanner.cpp')));

    const back = check.rollback(root, contract);
    assert.ok(back.restored.includes('src/scanner.cpp'), 'the source comes back');
    assert.ok(fs.existsSync(path.join(root, 'src/scanner.cpp')));
    // HONEST ABOUT WHAT IT DID NOT DO. The Python files were not written by
    // the archive step, so the archive step does not remove them, and pretending
    // otherwise would be the more dangerous of the two behaviours.
    assert.ok(back.targetsLeftInPlace.includes('src/scanner.py'),
      'a rollback must name the target files it deliberately left alone');
  });

  // ====================================== MERGE AND SPLIT, WHICH NAME NO FILE

  await test('MERGE: a responsibility dropped on the way into the merged agent FAILS', () => {
    // The failure a merge actually has: the three sources are deleted, a fourth
    // thing is written that resembles them, and one job quietly does not exist
    // any more. Nothing about "the new agent works" catches it.
    const root = tmpdir('migm-');
    write(root, 'agents/frontend/index.js', 'function renderPage() {}\nmodule.exports = { renderPage };\n');
    write(root, 'agents/backend/index.js', 'function handleRequest() {}\nmodule.exports = { handleRequest };\n');
    write(root, 'agents/testing/index.js', 'function runSuite() {}\nmodule.exports = { runSuite };\n');
    const d = intent.parse('Merge these three coding agents into one');
    d.projectWide = true;
    d.targetName = 'agent-d';
    d.dispositionHint = 'REPLACE';
    const { contract } = map.build(root, d, { intent: 'Merge these three coding agents into one' });

    // The merged agent, MISSING the testing responsibility.
    write(root, 'agents/merged/index.js', 'function renderPage() {}\nfunction handleRequest() {}\nmodule.exports = { renderPage, handleRequest };\n');
    for (const p of ['agents/frontend/index.js', 'agents/backend/index.js', 'agents/testing/index.js']) {
      fs.unlinkSync(path.join(root, p));
    }
    const bad = check.verify(root, contract);
    const dropped = bad.positive.find((r) => r.kind === 'responsibility' && r.value === 'runSuite');
    assert.ok(dropped, 'runSuite must be a required responsibility');
    assert.strictEqual(dropped.verdict, check.V.FAIL, `a dropped responsibility must fail: ${check.describe(bad)}`);

    // Add it, and the merge verifies — including the negative half, since all
    // three sources really are gone.
    write(root, 'agents/merged/index.js',
      'function renderPage() {}\nfunction handleRequest() {}\nfunction runSuite() {}\nmodule.exports = { renderPage, handleRequest, runSuite };\n');
    const good = check.verify(root, contract);
    assert.ok(good.ok, `the complete merge must verify:\n${check.describe(good)}`);
  });

  await test('MERGE: a same-language merge is not asked to erase its own language', () => {
    // `no ... file may remain in scope` and `symbol_gone` are right for C++ ->
    // Python and nonsense for JavaScript -> JavaScript: the merged agent is
    // JavaScript too, so those checks would refuse the thing being asked for.
    const root = tmpdir('migm2-');
    write(root, 'agents/a/index.js', 'function one() {}\nmodule.exports = { one };\n');
    write(root, 'agents/b/index.js', 'function two() {}\nmodule.exports = { two };\n');
    const d = intent.parse('Merge these agents into one');
    d.projectWide = true;
    d.dispositionHint = 'REPLACE';
    const { contract } = map.build(root, d, { intent: 'Merge these agents into one' });
    const kinds = contract.verification.negative.map((n) => n.kind);
    assert.ok(!kinds.includes('no_source_tech_in_scope'),
      'a merge within one language must not require that language to disappear');
    assert.ok(!kinds.includes('symbol_gone'),
      'and a carried-over name is the POINT of a merge, not a leftover');
    assert.ok(kinds.includes('file_inactive'), 'the source files must still be required to go');
  });

  await test('SPLIT: one component into several keeps every responsibility somewhere', () => {
    const root = tmpdir('migs-');
    write(root, 'agents/mono/index.js',
      'function renderPage() {}\nfunction handleRequest() {}\nfunction runSuite() {}\n'
      + 'module.exports = { renderPage, handleRequest, runSuite };\n');
    const d = intent.parse('Split agents/mono into three agents');
    d.paths = ['agents/mono'];
    d.dispositionHint = 'REPLACE';
    const { contract } = map.build(root, d, { intent: 'Split agents/mono into three agents' });

    const op = contract.operations.find((o) => o.type === M.OP.SPLIT);
    assert.ok(op, `a split must produce a SPLIT operation, got: ${contract.operations.map((o) => o.type).join(',')}`);
    assert.ok(op.sources.length, 'naming what is being divided');
    const carried = (op.structure.responsibilities || []).flatMap((g) => g.responsibilities);
    for (const r of ['renderPage', 'handleRequest', 'runSuite']) {
      assert.ok(carried.includes(r), `${r} must be listed as something that has to survive the split`);
    }
    assert.ok(M.validate(contract).ok, JSON.stringify(M.validate(contract).problems));

    // Divide it — but lose one job on the way.
    write(root, 'agents/ui/index.js', 'function renderPage() {}\nmodule.exports = { renderPage };\n');
    write(root, 'agents/api/index.js', 'function handleRequest() {}\nmodule.exports = { handleRequest };\n');
    fs.unlinkSync(path.join(root, 'agents/mono/index.js'));
    const bad = check.verify(root, contract);
    assert.ok(!bad.ok, 'a split that dropped a responsibility must not verify');
    const dropped = bad.positive.find((r) => r.value === 'runSuite');
    assert.strictEqual(dropped.verdict, check.V.FAIL, check.describe(bad));

    // Put the third part in and it is a real division.
    write(root, 'agents/test/index.js', 'function runSuite() {}\nmodule.exports = { runSuite };\n');
    const good = check.verify(root, contract);
    assert.ok(good.ok, `the complete split must verify:\n${check.describe(good)}`);
  });

  // ============================== THE MIGRATION FOLLOWS THE TASK ACROSS TURNS

  await test('CONTEXT: a migration in flight is carried into the working context', async () => {
    // WHY THIS IS WORTH TOKENS ON EVERY REQUEST. Half-way through, the project
    // really does contain two implementations of one thing, and that is the
    // intended state. A model that does not know a migration is running — after
    // a compaction, after /resume, or four turns later — reads the duplication
    // as a defect and "fixes" whichever half it happens to meet.
    const prompt = require('../../src/prompt');
    const { root, contract } = planned();
    M.note(contract, M.STAGE.BUILT, 'target written');
    M.save(contract);

    const session = { cwd: root, task: null, lifecycle: null, evidence: null, attempts: null };
    const out = prompt.workingContext({ session });
    assert.ok(/migration is in progress/i.test(out), `the migration must be carried: ${out}`);
    assert.ok(/src\/scanner\.cpp/.test(out), 'naming what has not been retired yet');
    assert.ok(/do not "tidy up"/i.test(out), 'and saying explicitly that the duplication is deliberate');
    assert.ok(out.length < 1800, `the block rides on every request: ${out.length} chars`);

    // AND IT STOPS once the migration is done — a finished migration is not
    // active state, it is history, and history does not belong on every request.
    M.note(contract, M.STAGE.COMPLETE, 'done');
    M.save(contract);
    assert.ok(!/migration is in progress/i.test(prompt.workingContext({ session })));
  });

  // ================================================= MCQ AND AMBIGUOUS INTENT

  await test('MCQ: an ambiguous scope is asked about, and is NOT decided by the machine', async () => {
    const root = tmpdir('migq-');
    for (const n of ['agent-a', 'agent-b', 'agent-c']) {
      write(root, `agents/${n}/index.jsx`, `import React from 'react';\nexport function ${n.replace('-', '')}() {}\n`);
    }
    const asked = [];
    const ctx = {
      cwd: root,
      ask: async (q) => { asked.push(q); return q.options[1]; },   // "agent-b"
    };
    const r = await migrateTools.tools.migration_plan.run({ request: 'Migrate the agents to Vue' }, ctx);

    assert.ok(asked.length >= 1, 'an unresolvable scope must produce a question');
    const scopeQ = asked[0];
    assert.ok(/which/i.test(scopeQ.question), `the first question must be about scope, got: ${scopeQ.question}`);
    for (const n of ['agent-a', 'agent-b', 'agent-c']) {
      assert.ok(scopeQ.options.includes(n), `the options must list ${n}`);
    }
    assert.ok(scopeQ.options.includes('All of them'), 'and must offer the project-wide reading as a CHOICE, not a default');

    // The answer became the contract's scope, not a note about a conversation.
    const contract = M.load(r.meta.migration);
    assert.deepStrictEqual(contract.scope.components, ['agent-b']);
    const replaced = contract.operations.filter((o) => o.type === M.OP.REPLACE).map((o) => o.source);
    assert.ok(replaced.every((p) => p.startsWith('agents/agent-b/')),
      `only the chosen agent may be migrated, got: ${replaced.join(', ')}`);
    assert.ok(contract.operations.some((o) => o.type === M.OP.KEEP && o.source.includes('agent-a')),
      'and the ones not chosen are KEPT explicitly');
  });

  await test('MCQ: a scope the request NAMED IN WORDS is never asked about', async () => {
    // ---- FOUND BY DRIVING THE HEADLINE SCENARIO END TO END ----------------
    //
    // "Change agent-b from React to Vue" names its own scope, in the sentence,
    // with no path in it. migrationmap resolved that correctly — and the tool
    // asked "which agent should be migrated?" anyway, because the question
    // layer was never told the scope was already settled. The first option was
    // agent-a, so one keystroke migrated a component the user had not
    // mentioned, in a request that could not have been clearer.
    const root = tmpdir('migq5-');
    for (const n of ['agent-a', 'agent-b', 'agent-c']) {
      write(root, `agents/${n}/index.jsx`, `import React from 'react';\nexport function ${n.replace('-', '')}Panel() {}\n`);
    }
    const asked = [];
    const ctx = { cwd: root, ask: async (q) => { asked.push(q); return q.options[0]; } };
    const r = await migrateTools.tools.migration_plan.run(
      { request: 'Change agent-b from React to Vue' }, ctx,
    );
    assert.ok(!asked.some((q) => /which agent/i.test(q.question)),
      `the request named agent-b: ${asked.map((q) => q.question).join(' | ')}`);

    const contract = M.load(r.meta.migration);
    assert.deepStrictEqual(contract.scope.components, ['agent-b']);
    const replaced = contract.operations.filter((o) => o.type === M.OP.REPLACE).map((o) => o.source);
    assert.deepStrictEqual(replaced, ['agents/agent-b/index.jsx'],
      'only the agent the user named may be replaced');
    const kept = contract.operations.filter((o) => o.type === M.OP.KEEP).map((o) => o.source).sort();
    assert.deepStrictEqual(kept, ['agents/agent-a/index.jsx', 'agents/agent-c/index.jsx']);
  });

  await test('MCQ: what happens to the old implementation is asked when the request did not say', async () => {
    const { root } = planned();
    const asked = [];
    const ctx = { cwd: root, ask: async (q) => { asked.push(q); return q.options[0]; } };
    await migrateTools.tools.migration_plan.run(
      { request: 'Migrate src to Python', scope: ['src'] }, ctx,
    );
    // Identified by its OPTIONS, not by its wording: the data question opens
    // with the same five words, and a test that cannot tell them apart would
    // pass whichever one was asked.
    const q = asked.find((x) => x.options.some((o) => /fallback/i.test(o)));
    assert.ok(q, `the fate of the existing implementation must be asked, got: ${asked.map((a) => a.question).join(' | ')}`);
    assert.ok(q.options.some((o) => /replace/i.test(o)), 'Replace it');
    assert.ok(q.options.some((o) => /fallback/i.test(o)), 'Keep it as a fallback');
    assert.ok(q.options.some((o) => /both/i.test(o)), 'Run both together');
    assert.ok(q.options.some((o) => /archive/i.test(o)), 'Archive it');
  });

  await test('MCQ: a question the request already answered is never asked', async () => {
    const { root } = planned();
    const asked = [];
    const ctx = { cwd: root, ask: async (q) => { asked.push(q); return q.options[0]; } };
    await migrateTools.tools.migration_plan.run(
      { request: 'Replace the C++ in src with Python and get rid of the old one', scope: ['src'] }, ctx,
    );
    assert.ok(!asked.some((q) => q.options.some((o) => /fallback/i.test(o))),
      'the user already said "get rid of the old one" — asking again says nobody was listening');
  });

  await test('MCQ: with no interactive surface, the questions are handed to the model instead of guessed', async () => {
    const root = tmpdir('migq2-');
    for (const n of ['agent-a', 'agent-b']) {
      write(root, `agents/${n}/index.jsx`, `import React from 'react';\nexport function x${n.length}() {}\n`);
    }
    const r = await migrateTools.tools.migration_plan.run({ request: 'Migrate the agents to Vue' }, { cwd: root });
    assert.ok(/AMBIGUOUS/.test(r.output), 'it must say the intent is unsettled rather than pick one');
    assert.ok(/ask_user/.test(r.output), 'and point at the tool that can settle it');
    assert.ok(/id: scope/.test(r.output), 'with the question id to answer it by');
    assert.ok(r.meta.open >= 1);
    assert.ok(!/REPLACEMENT MAP/.test(r.output), 'and must NOT produce a plan built on a guess');
  });

  await test('MCQ: answers supplied by the model settle the plan without asking anyone', async () => {
    const root = tmpdir('migq3-');
    for (const n of ['agent-a', 'agent-b']) {
      write(root, `agents/${n}/index.jsx`, `import React from 'react';\nexport function x${n.length}() {}\n`);
    }
    const asked = [];
    const ctx = { cwd: root, ask: async (q) => { asked.push(q); return q.options[0]; } };
    const r = await migrateTools.tools.migration_plan.run({
      request: 'Migrate the agents to Vue',
      answers: { scope: 'agent-b', old: 'Replace it — archive the old one once the new one is verified' },
    }, ctx);
    assert.strictEqual(asked.length, 0, 'an answer already in hand must not be asked for again');
    assert.ok(/REPLACEMENT MAP/.test(r.output));
    const contract = M.load(r.meta.migration);
    assert.deepStrictEqual(contract.scope.components, ['agent-b']);
  });

  // ============================================== THE TOOL SURFACE, END TO END

  await test('TOOLS: plan -> build -> verify -> activate -> verify, through the tools themselves', async () => {
    const { root } = planned();
    const ctx = { cwd: root, ask: async (q) => q.options[0] };

    const planned1 = await migrateTools.tools.migration_plan.run(
      { request: 'Migrate src from C++ to Python', scope: ['src'] }, ctx,
    );
    assert.ok(planned1.meta.valid, `the contract must be valid: ${planned1.output.slice(-500)}`);
    const id = planned1.meta.migration;

    const before = await migrateTools.tools.migration_verify.run({ id }, ctx);
    assert.ok(!before.meta.ok, 'nothing is built yet');

    buildTarget(root);
    const mid = await migrateTools.tools.migration_verify.run({ id }, ctx);
    assert.ok(mid.meta.positiveOk, 'the target is there');
    assert.ok(!mid.meta.negativeOk, 'and the source has not gone anywhere');
    assert.strictEqual(M.load(id).stage, M.STAGE.BUILT);

    const done = await migrateTools.tools.migration_activate.run({ id }, ctx);
    assert.ok(!done.isError, done.output);
    assert.ok(/MIGRATION COMPLETE/.test(done.output));

    const after = await migrateTools.tools.migration_verify.run({ id }, ctx);
    assert.ok(after.meta.ok, `the final state must verify:\n${after.output}`);
    assert.strictEqual(M.load(id).stage, M.STAGE.COMPLETE);
  });

  await test('TOOLS: verifying with no contract says so rather than inventing one', async () => {
    const root = tmpdir('migq4-');
    const saved = M.dir();
    assert.ok(saved, 'the manifest directory must resolve');
    const r = await migrateTools.tools.migration_verify.run({ id: 'no-such-migration' }, { cwd: root });
    assert.ok(r.isError);
    assert.ok(/migration_plan first/.test(r.output));
  });
};
