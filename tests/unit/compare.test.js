'use strict';

/**
 * CAPABILITY COMPARISON.
 *
 * The failure mode this suite exists to prevent is a confident wrong answer.
 * A comparison that says "you already have this" when you do not hides a real
 * gap, and one that says "missing" about something you dropped on purpose
 * trains you to ignore the report. Both are worse than no report.
 *
 * So the properties asserted are: the probes are SYMMETRIC (the same set runs
 * over both sides, so neither is privileged), a deliberate exclusion is never
 * recommended, and "done differently" is distinguished from "gone".
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const compareMod = require('../../src/compare');
const { STATUS } = compareMod;

function tree(files) {
  const dir = tmpdir('cmp-');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return compareMod.scanDir(dir);
}

const rowOf = (result, id) => result.rows.find((r) => r.id === id);

module.exports = async function () {
  await test('CMP: a capability present on both sides is not reported as missing', async () => {
    const a = tree({ 'src/checkpoint.js': 'const crypto=1;' });
    const b = tree({ 'src/checkpoint.js': 'const crypto=2;' });
    const r = await compareMod.compare(a, b);
    assert.strictEqual(rowOf(r, 'checkpoint-undo').status, STATUS.IMPLEMENTED);
  });

  await test('CMP: a capability only the OTHER side has is MISSING', async () => {
    const a = tree({ 'src/staticcheck.js': 'x' });
    const b = tree({ 'src/other.js': 'x' });
    const r = await compareMod.compare(a, b);
    const row = rowOf(r, 'static-check');
    assert.strictEqual(row.status, STATUS.MISSING);
    assert.ok(r.missing.some((m) => m.id === 'static-check'));
    assert.match(row.plain, /HTML|site/i, 'a missing row must explain what it was FOR, in plain words');
  });

  await test('CMP: the probes are SYMMETRIC — swapping the trees swaps the answer', async () => {
    // If the probe set were written from one side's vocabulary it would find
    // capabilities on that side and miss them on the other. This is the check
    // that catches it.
    const withIt = { 'src/staticcheck.js': 'x' };
    const without = { 'src/other.js': 'x' };
    const fwd = await compareMod.compare(tree(withIt), tree(without));
    const rev = await compareMod.compare(tree(without), tree(withIt));
    assert.strictEqual(rowOf(fwd, 'static-check').left.present, true);
    assert.strictEqual(rowOf(fwd, 'static-check').right.present, false);
    assert.strictEqual(rowOf(rev, 'static-check').left.present, false);
    assert.strictEqual(rowOf(rev, 'static-check').right.present, true);
  });

  await test('CMP: something done DIFFERENTLY reads as REPLACED, not as a gap', async () => {
    // The old side has a stored dependency graph; this side has the live
    // dependents tool. That is not a missing capability and must not be offered
    // for migration as though it were.
    const a = tree({ 'src/fgm.js': 'graph' });
    const b = tree({ 'src/tools/search.js': 'tools.dependents = {};' });
    const r = await compareMod.compare(a, b);
    const row = rowOf(r, 'dependency-graph');
    assert.strictEqual(row.status, STATUS.REPLACED);
    assert.ok(!r.missing.some((m) => m.id === 'dependency-graph'), 'a replaced capability must not appear in the missing list');
    assert.match(row.why, /on demand|current tree/i, 'and it must say WHY the replacement is different');
  });

  await test('CMP: a deliberate exclusion is marked, and never recommended', async () => {
    const a = tree({ 'src/orchestra.js': 'x', 'src/relay.js': 'y', 'src/permissions.js': 'z' });
    const b = tree({ 'src/app.js': 'x' });
    const r = await compareMod.compare(a, b);
    for (const id of ['orchestra', 'permissions']) {
      const row = rowOf(r, id);
      assert.strictEqual(row.status, STATUS.EXCLUDED, `${id} must be excluded, not missing`);
      assert.strictEqual(row.recommend, 'DO NOT MIGRATE');
      assert.ok(row.why.length > 20, 'an exclusion must carry its reason');
    }
    assert.ok(!r.missing.some((m) => m.id === 'orchestra'));
  });

  await test('CMP: a path hit is not enough when the capability lives inside a shared file', async () => {
    // Every tree has a commands file. `/doctor` is a feature inside one, so the
    // content signal is what decides — otherwise every project would "have" it.
    const without = tree({ 'src/commands.js': "define('/help', {});" });
    const with_ = tree({ 'src/commands.js': "define('/doctor', {});" });
    const r = await compareMod.compare(without, with_);
    assert.strictEqual(rowOf(r, 'diagnostics').left.present, false);
    assert.strictEqual(rowOf(r, 'diagnostics').right.present, true);
  });

  await test('CMP: evidence is recorded — a finding names the files behind it', async () => {
    const a = tree({ 'src/fixledger.js': 'x', 'src/knowledge.js': 'y' });
    const b = tree({ 'src/app.js': 'x' });
    const r = await compareMod.compare(a, b);
    const row = rowOf(r, 'cross-run-learning');
    assert.ok(row.left.where.length, 'a claim about the other tree must point at where it looked');
    assert.ok(row.left.where.every((f) => /fixledger|knowledge/.test(f)));
  });

  // ------------------------------------------------------------- sources ---

  await test('CMP: a flattened-repository dump is understood as a project', async () => {
    const dump = [
      '================================================',
      'FILE: src/fgm.js',
      '================================================',
      'const graph = {};',
      '',
      '================================================',
      'FILE: src/checkpoint.js',
      '================================================',
      'const crypto = require("crypto");',
    ].join('\n');
    const t = compareMod.scanIngest(dump);
    assert.deepStrictEqual(t.files.sort(), ['src/checkpoint.js', 'src/fgm.js']);
    assert.match(t.read('src/fgm.js'), /const graph/);
  });

  await test('CMP: an unreadable source fails loudly rather than comparing nothing', async () => {
    await assert.rejects(() => compareMod.resolveSource('C:/definitely/not/here'), /no such folder/i);
    await assert.rejects(() => compareMod.resolveSource(''), /no comparison source/i);
  });

  await test('CMP: a GitHub URL is parsed without contacting anything until asked', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      if (/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) return { ok: true, json: async () => ({ default_branch: 'trunk' }) };
      if (/git\/trees\/trunk/.test(url)) return { ok: true, json: async () => ({ tree: [{ type: 'blob', path: 'src/fgm.js' }, { type: 'blob', path: 'node_modules/x.js' }] }) };
      return { ok: false, status: 404 };
    };
    const t = await compareMod.scanGitHub('https://github.com/acme/thing', { fetchImpl });
    assert.strictEqual(calls, 2, 'the whole file list must cost ONE listing request, not one per file');
    assert.deepStrictEqual(t.files, ['src/fgm.js'], 'generated directories are excluded from the comparison');
    assert.strictEqual(t.label, 'acme/thing@trunk');
  });

  await test('CMP: a GitHub failure says what went wrong, in words', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    await assert.rejects(
      () => compareMod.scanGitHub('https://github.com/acme/missing', { fetchImpl }),
      /404.*private or misspelled/i
    );
    await assert.rejects(() => compareMod.scanGitHub('https://example.com/x', { fetchImpl }), /not a GitHub repository/i);
  });

  // ----------------------------------------------------------- migration ---

  await test('CMP: a migration brief asks for the CAPABILITY and forbids copying', async () => {
    // The whole point : this codebase gets its own implementation.
    const a = tree({ 'src/fixledger.js': 'x' });
    const b = tree({ 'src/app.js': 'x' });
    const r = await compareMod.compare(a, b);
    const brief = compareMod.migrationBrief(rowOf(r, 'cross-run-learning'), 'the old version');
    assert.match(brief, /src\/fixledger\.js/, 'it must point at the old implementation to read');
    assert.match(brief, /do not copy the old code/i);
    assert.match(brief, /do not add a parallel system/i);
    assert.match(brief, /do not bring in an external service|new dependency/i);
    assert.match(brief, /own focused test/i);
  });

  // -------------------------------------------------------------- render ---

  await test('CMP: the grid is a grid — aligned, and it fits the terminal', async () => {
    const r = await compareMod.compare(tree({ 'src/fgm.js': 'x' }), tree({ 'src/app.js': 'x' }));
    for (const width of [72, 96, 120]) {
      const lines = compareMod.grid(r, width);
      const widths = new Set(lines.map((l) => [...l].length));
      assert.strictEqual(widths.size, 1, `rows are ragged at ${width}: ${[...widths].join(',')}`);
      assert.ok([...widths][0] <= Math.max(64, Math.min(width, 120)), 'the grid must not exceed the width it was given');
    }
  });

  await test('CMP: the plain-language findings avoid architecture vocabulary', async () => {
    const r = await compareMod.compare(tree({ 'src/staticcheck.js': 'x' }), tree({ 'src/app.js': 'x' }));
    const text = compareMod.findings(r).join('\n');
    assert.match(text, /Missing here/);
    for (const jargon of ['AST', 'invalidation semantics', 'idempotent', 'monad']) {
      assert.ok(!text.includes(jargon), `the summary should not need "${jargon}"`);
    }
  });
};
